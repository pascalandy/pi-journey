import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { waitFor } from "xstate";
import {
  ConfigSchema,
  defaultConfig,
  describeScope,
  makePlan,
  makeRun,
  type Plan,
  PlanInputSchema,
  PlanSchema,
  parse,
} from "./contracts.ts";
import { Delivery } from "./delivery.ts";
import { Journal } from "./journal.ts";
import { createJourney } from "./journey.ts";
import { runAdmission, validateScope } from "./policy.ts";
import { OwnedResources, Workers } from "./runner.ts";

const PLAN_TOOL = "journey_plan";
const DIGEST = /^[a-f0-9]{64}$/;

function draftRequest(source: string): string {
  return (
    `Draft a Pi Journey implementation plan from ${source ? `this source: ${source}` : "our conversation so far"}. ` +
    `Call ${PLAN_TOOL} once with the goal, the agreed plan as the body, ordered verifiable units ` +
    "(each with a title, the exact repository-relative paths it may write, and a Conventional Commits message), " +
    'the project\'s own verification command as the check (for example ["just", "check"]) with its effects and timeout, ' +
    'and "single" delivery for one PR or "stack" for dependent PRs. Do not edit files. ' +
    "If something essential is unclear, ask me instead of calling the tool."
  );
}

export default function journey(pi: ExtensionAPI): void {
  let actor: ReturnType<typeof createJourney> | undefined;
  let journal: Journal | undefined;
  let resources: OwnedResources | undefined;
  let repository = "";
  let pending: Plan | undefined;
  let context: ExtensionContext | undefined;
  let control = Promise.resolve();
  let approvalEpoch = 0;
  // Set while /journey implement waits for the Pi agent to record a plan
  let drafting: { shown: string | undefined } | undefined;

  const report = (text: string) =>
    pi.sendMessage(
      {
        customType: "journey-status",
        content: text,
        display: true,
        details: {},
      },
      { triggerTurn: false },
    );
  const idle = () => actor === undefined || actor.getSnapshot().matches("idle");
  const active = () =>
    actor !== undefined &&
    !(["idle", "blocked", "delivered"] as const).some((state) =>
      actor?.getSnapshot().matches(state),
    );
  const setDrafting = (next: typeof drafting) => {
    drafting = next;
    const others = pi.getActiveTools().filter((name) => name !== PLAN_TOOL);
    pi.setActiveTools(drafting ? [...others, PLAN_TOOL] : others);
    if (idle()) context?.ui.setStatus("journey", drafting ? "Journey | drafting plan" : undefined);
  };
  const lockControl = (operation: () => Promise<void>) => {
    const job = control.then(operation);
    control = job.catch((error: unknown) => {
      report(error instanceof Error ? error.message : "Journey command failed");
    });
    return control;
  };

  async function stop(): Promise<void> {
    approvalEpoch++;
    if (!actor) return;
    actor.send({ type: "stop.requested" });
    const stopped = await waitFor(
      actor,
      (snapshot) => snapshot.matches("idle") || snapshot.matches("stopFailed"),
      { timeout: 60_000 },
    );
    if (stopped.matches("stopFailed")) throw new Error(stopped.context.reason);
  }

  async function initialize(ctx: ExtensionContext): Promise<void> {
    context = ctx;
    if (actor) {
      await stop();
      actor.stop();
    }
    actor = undefined;
    journal = undefined;
    resources = undefined;
    pending = undefined;
    setDrafting(undefined);
    repository = realpathSync(ctx.cwd);
    const owned = new OwnedResources();
    const store = new Journal(repository, (error) =>
      actor?.send({ type: "ownership.lost", reason: error.message }),
    );
    const workers = new Workers(repository, store, owned, () => {
      const model = context?.model;
      if (!model) throw new Error("Select an available Pi worker model before implementing");
      return model;
    });
    const delivery = new Delivery(repository, store, owned, workers, (argv) =>
      report(
        `Independent read-only review command\n\n\`\`\`sh\n${argv
          .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
          .join(" ")}\n\`\`\``,
      ),
    );
    journal = store;
    resources = owned;
    const coordinator = createJourney({
      execute: (stage, run, signal) => delivery.execute(stage, run, signal),
      save: (run, state) => store.checkpoint(run, state),
      drain: async (outcome) => {
        await owned.drain();
        const active = store.current();
        if (active && store.owned) store.write({ ...active, checkpoint: outcome });
        await store.release();
      },
    });
    actor = coordinator;
    let previous = "";
    coordinator.subscribe({
      next: (snapshot) => {
        const state = String(snapshot.value);
        ctx.ui.setStatus("journey", state === "idle" ? undefined : `Journey | ${state}`);
        if (state !== previous && ["blocked", "stopFailed", "delivered"].includes(state)) {
          const latest = store.current() ?? snapshot.context.run;
          report(
            `${state}: ${snapshot.context.reason || latest?.summary || ""}\n` +
              (latest?.units.flatMap((unit) => (unit.url ? [unit.url] : [])).join("\n") ?? ""),
          );
        }
        previous = state;
      },
      error: (error) => report(error instanceof Error ? error.message : "Coordinator failed"),
    });
    coordinator.start();
    const prior = store.unfinished();
    if (prior) coordinator.send({ type: "run.recovered", run: prior });
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "journey-plan-cleared")
        pending = undefined;
      if (entry.type === "custom" && entry.customType === "journey-plan") {
        pending = parse(PlanSchema, entry.data, "session plan");
        if (pending.repository !== repository) pending = undefined;
      }
    }
  }

  // A new run needs an idle Pi agent, no running stage, and no unfinished run
  function assertReadyForRun(ctx: ExtensionContext): void {
    if (!ctx.isIdle()) throw new Error("Wait for the current response to finish");
    if (!idle() && !actor?.getSnapshot().matches("delivered"))
      throw new Error("Stop or resume the existing run first");
    if (journal?.unfinished()) throw new Error("An unfinished run exists; use /journey resume");
  }

  async function implement(
    ctx: ExtensionContext,
    digest: string | undefined,
    allowChecks: boolean,
  ): Promise<void> {
    if (!actor || !journal || !resources)
      throw new Error("Pi Journey is unavailable in this directory");
    const coordinator = actor;
    const store = journal;
    const owned = resources;
    const epoch = approvalEpoch;
    assertReadyForRun(ctx);
    const proposal = pending;
    if (!proposal || proposal.repository !== repository)
      throw new Error("Record a plan with journey_plan first");
    if (digest && digest !== proposal.digest)
      throw new Error("Plan approval digest does not match the current proposal");
    if (!allowChecks) {
      if (!ctx.hasUI)
        throw new Error(
          `Use /journey implement ${proposal.digest} --allow-checks after reviewing the plan`,
        );
      const accepted = await ctx.ui.confirm(
        "Implement the accepted plan?",
        `${proposal.goal}\nDigest: ${proposal.digest}\n\n${proposal.body}\n\n` +
          `Units and writable scope:\n${describeScope(proposal)}\n\n` +
          `Trusted checks, Git hooks and checkout filters can execute repository code beyond scoped file tools.\n` +
          `${proposal.checks.map((check) => `${check.name}: ${JSON.stringify(check.argv)}\nEffects: ${check.effects}`).join("\n")}\n\n` +
          `Publish ${proposal.delivery === "stack" ? "a linear PR stack" : "a regular PR"} and leave it unmerged.`,
      );
      if (!accepted) return;
    }
    if (pending?.digest !== proposal.digest || approvalEpoch !== epoch)
      throw new Error("Plan changed while approval was open");
    if (store.unfinished()) throw new Error("An unfinished run exists; use /journey resume");
    const configurationPath = join(repository, ".pi", "journey.json");
    let overrides: unknown = {};
    try {
      overrides = JSON.parse(readFileSync(configurationPath, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const config = {
      ...defaultConfig(),
      ...parse(Type.Partial(ConfigSchema), overrides, "journey configuration"),
    };
    const run = makeRun(proposal, config);
    owned.reset();
    await store.acquire(run.id);
    if (approvalEpoch !== epoch) {
      await store.release();
      throw new Error("Approval was revoked by a session transition");
    }
    store.write(run);
    setDrafting(undefined);
    coordinator.send({ type: "implementation.requested", run });
  }

  function requestDraft(ctx: ExtensionContext, source: string): void {
    assertReadyForRun(ctx);
    setDrafting({ shown: pending?.id });
    pi.sendUserMessage(draftRequest(source));
  }

  const controls = (ctx: ExtensionCommandContext) => {
    if (!actor || !journal || !resources || !ctx.isIdle())
      throw new Error("No idle coordinator is available");
    return { actor, journal, resources };
  };
  // Modes start work; controls steer a run. The picker and completions read this table
  const commands: Record<
    string,
    {
      description: string;
      offered: () => boolean;
      run: (flags: string[], ctx: ExtensionCommandContext) => Promise<void>;
    }
  > = {
    implement: {
      description: "Draft a plan from this conversation or an issue, then deliver reviewed PRs",
      offered: () => true,
      run: async (flags, ctx) => {
        const [first = "", ...rest] = flags;
        const allowChecks = flags.includes("--allow-checks");
        if (DIGEST.test(first)) {
          if (rest.some((flag) => flag !== "--allow-checks"))
            throw new Error("Unknown implement argument");
          await implement(ctx, first, allowChecks);
        } else if (allowChecks) {
          throw new Error("Explicit check approval requires the full plan digest");
        } else requestDraft(ctx, flags.join(" "));
      },
    },
    ping: {
      description: "Placeholder mode: the Pi agent answers ping",
      offered: () => true,
      run: async (flags, ctx) => {
        if (flags.length) throw new Error("ping takes no arguments");
        if (!ctx.isIdle()) throw new Error("Wait for the current response to finish");
        pi.sendUserMessage("ping");
      },
    },
    status: {
      description: "Show the run phase, the recorded plan digest, and any blocker",
      offered: () => true,
      run: async () => {
        const snapshot = actor?.getSnapshot();
        report(
          `Phase: ${drafting && idle() ? "drafting plan" : String(snapshot?.value ?? "unavailable")}\n` +
            `Plan digest: ${pending?.digest ?? "none"}\n${snapshot?.context.reason ?? ""}`,
        );
      },
    },
    stop: {
      description: "Stop drafting or cancel owned work, then release the repository",
      offered: () => drafting !== undefined || !idle(),
      run: async (flags) => {
        if (flags.length) throw new Error("stop takes no arguments");
        setDrafting(undefined);
        await stop();
      },
    },
    resume: {
      description:
        "Reconcile the unfinished run and continue it; --accept-edits accepts recovered edits",
      offered: () => !active() && journal?.unfinished() != null,
      run: async (flags, ctx) => {
        if (flags.some((flag) => flag !== "--accept-edits"))
          throw new Error("Unknown resume argument");
        const { actor, journal, resources } = controls(ctx);
        if (!idle() && !actor.getSnapshot().matches("blocked"))
          throw new Error("Stop the active run before resuming");
        const run = journal.unfinished();
        if (!run) throw new Error("No unfinished run exists");
        resources.reset();
        await journal.acquire(run.id);
        if (idle()) actor.send({ type: "run.recovered", run });
        actor.send({
          type: "run.resumed",
          run,
          acceptRecoveredEdits: flags.includes("--accept-edits"),
        });
      },
    },
    retire: {
      description: "Drain and retire the unfinished run, keeping its files, branches, and PRs",
      offered: () => !active() && journal?.unfinished() != null,
      run: async (flags, ctx) => {
        if (flags.length) throw new Error("retire takes no arguments");
        const { actor, journal } = controls(ctx);
        const run = journal.unfinished();
        if (!run) throw new Error("No unfinished run exists");
        await stop();
        await journal.acquire(run.id);
        try {
          journal.write({ ...(journal.read(run.id) ?? run), checkpoint: "retired" });
        } finally {
          await journal.release();
        }
        pending = undefined;
        pi.appendEntry("journey-plan-cleared", { reason: "run-retired", runId: run.id });
        actor.send({ type: "run.retired" });
        report(
          "Run retired after confirmed drain. Files, branches, PRs and history are preserved. Return to the current base and record a new plan before approval.",
        );
      },
    },
  };

  pi.registerTool({
    name: "journey_plan",
    label: "Record plan",
    description:
      "Record the implementation plan: goal, body, ordered units with writable paths and commit messages, named checks, and delivery. Recording never approves implementation.",
    parameters: PlanInputSchema,
    execute: async (_id, input) => {
      if (active() || !repository)
        throw new Error("A plan cannot be recorded during an active run");
      const proposal = parse(PlanInputSchema, input, "plan proposal");
      for (const unit of proposal.units) validateScope(unit.paths);
      pending = makePlan(proposal, repository);
      pi.appendEntry("journey-plan", pending);
      return {
        content: [
          {
            type: "text",
            text:
              `Plan recorded. Digest ${pending.digest}.\n\n${describeScope(pending)}\n\n` +
              `The operator reviews it in the approval dialog, with /journey implement ${pending.digest}, ` +
              `or approves it with /journey implement ${pending.digest} --allow-checks. No implementation was authorized.`,
          },
        ],
        details: { digest: pending.digest },
      };
    },
  });

  pi.registerCommand("journey", {
    description: "Pick a mode (implement, ping) or steer a run (status, stop, resume, retire)",
    getArgumentCompletions: (prefix) =>
      prefix.includes(" ")
        ? null
        : Object.entries(commands)
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, entry]) => ({ value: name, label: name, description: entry.description })),
    handler: async (args, ctx) =>
      lockControl(async () => {
        let [name = "", ...flags] = args.trim().split(/\s+/).filter(Boolean);
        if (!name) {
          const offered = Object.entries(commands).filter(([, entry]) => entry.offered());
          if (!ctx.hasUI) {
            report(`Usage: /journey <${offered.map(([option]) => option).join(" | ")}>`);
            return;
          }
          const choice = await ctx.ui.select(
            "Pi Journey",
            offered.map(([option, entry]) => `${option}: ${entry.description}`),
          );
          if (!choice) return;
          name = choice.slice(0, choice.indexOf(":"));
          flags = [];
        }
        const entry = Object.hasOwn(commands, name) ? commands[name] : undefined;
        if (!entry) throw new Error(`Unknown journey command: ${name}`);
        await entry.run(flags, ctx);
      }),
  });
  pi.on("session_start", async (_event, ctx) => {
    try {
      await initialize(ctx);
    } catch (error) {
      report(error instanceof Error ? error.message : "Pi Journey initialization failed");
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    const plan = pending;
    if (!drafting || !plan || drafting.shown === plan.id) return;
    drafting.shown = plan.id;
    void lockControl(() => implement(ctx, plan.digest, false));
  });
  pi.on("before_agent_start", (event) =>
    active()
      ? {
          systemPrompt:
            `${event.systemPrompt}\n\nA journey run owns this repository. You are its read-only conductor: ` +
            "report status and investigate when asked. Do not claim completion without recorded evidence.",
        }
      : undefined,
  );
  pi.on("tool_call", (event) => (active() ? runAdmission(event.toolName) : undefined));
  pi.on("user_bash", () =>
    active()
      ? {
          result: {
            output: "An active run owns this repository; use /journey stop first.",
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        }
      : undefined,
  );
  // Pi ignores a throwing handler, so only an explicit cancel keeps undrained work in place
  const guardNavigation = async () => {
    try {
      await stop();
    } catch (error) {
      report(error instanceof Error ? error.message : "Owned work did not drain");
      return { cancel: true };
    }
    return undefined;
  };
  pi.on("session_before_switch", guardNavigation);
  pi.on("session_before_fork", guardNavigation);
  pi.on("session_before_tree", guardNavigation);
  pi.on("session_tree", async (_event, ctx) => {
    await initialize(ctx);
  });
  pi.on("session_shutdown", () => stop());
}
