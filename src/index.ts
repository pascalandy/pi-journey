import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { waitFor } from "xstate";
import {
  ConfigSchema,
  defaultConfig,
  makePlan,
  makeRun,
  type Plan,
  PlanInputSchema,
  PlanSchema,
  parse,
} from "./contracts.ts";
import { Delivery } from "./delivery.ts";
import { Journal } from "./journal.ts";
import { runAdmission, validateScope } from "./policy.ts";
import { OwnedResources, Workers } from "./runner.ts";
import { createWorkflow } from "./workflow.ts";

export default function modeWorkflow(pi: ExtensionAPI): void {
  let actor: ReturnType<typeof createWorkflow> | undefined;
  let journal: Journal | undefined;
  let resources: OwnedResources | undefined;
  let repository = "";
  let pending: Plan | undefined;
  let context: ExtensionContext | undefined;
  let control = Promise.resolve();
  let approvalEpoch = 0;

  const report = (text: string) =>
    pi.sendMessage(
      {
        customType: "workflow-status",
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
  const lockControl = (operation: () => Promise<void>) => {
    const job = control.then(operation);
    control = job.catch((error: unknown) => {
      report(error instanceof Error ? error.message : "Workflow command failed");
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
    const coordinator = createWorkflow({
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
        ctx.ui.setStatus("mode-workflow", state === "idle" ? undefined : `Workflow | ${state}`);
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
    const prior = store.current();
    if (prior && !["delivered", "retired"].includes(prior.checkpoint))
      coordinator.send({ type: "run.recovered", run: prior });
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "workflow-plan-cleared")
        pending = undefined;
      if (entry.type === "custom" && entry.customType === "workflow-plan") {
        pending = parse(PlanSchema, entry.data, "session plan");
        if (pending.repository !== repository) pending = undefined;
      }
    }
  }

  async function implement(
    ctx: ExtensionContext,
    digest: string | undefined,
    allowChecks: boolean,
  ): Promise<void> {
    if (!actor || !journal || !resources)
      throw new Error("Workflow is unavailable in this directory");
    const coordinator = actor;
    const store = journal;
    const owned = resources;
    const epoch = approvalEpoch;
    if (!ctx.isIdle()) throw new Error("Wait for the current response to finish");
    if (!idle() && !actor.getSnapshot().matches("delivered"))
      throw new Error("Stop or resume the existing run first");
    const proposal = pending;
    if (!proposal || proposal.repository !== repository)
      throw new Error("Record a plan with workflow_plan first");
    if (digest && digest !== proposal.digest)
      throw new Error("Plan approval digest does not match the current proposal");
    if (!allowChecks) {
      if (!ctx.hasUI)
        throw new Error(
          `Use /workflow implement ${proposal.digest} --allow-checks after reviewing the plan`,
        );
      const accepted = await ctx.ui.confirm(
        "Implement the accepted plan?",
        `${proposal.goal}\nDigest: ${proposal.digest}\n\n${proposal.body}\n\n` +
          `Trusted checks, Git hooks and checkout filters can execute repository code beyond scoped file tools.\n` +
          `${proposal.checks.map((check) => `${check.name}: ${JSON.stringify(check.argv)}\nEffects: ${check.effects}`).join("\n")}\n\n` +
          `Publish ${proposal.delivery === "stack" ? "a linear PR stack" : "a regular PR"} and leave it unmerged.`,
      );
      if (!accepted) return;
    }
    if (pending?.digest !== proposal.digest || approvalEpoch !== epoch)
      throw new Error("Plan changed while approval was open");
    const prior = store.current();
    if (prior && !["delivered", "retired"].includes(prior.checkpoint))
      throw new Error("An unfinished run exists; use /workflow resume");
    const configurationPath = join(repository, ".pi", "mode-workflow.json");
    let overrides: unknown = {};
    try {
      overrides = JSON.parse(readFileSync(configurationPath, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const config = {
      ...defaultConfig(),
      ...parse(Type.Partial(ConfigSchema), overrides, "workflow configuration"),
    };
    const run = makeRun(proposal, config);
    owned.reset();
    await store.acquire(run.id);
    if (approvalEpoch !== epoch) {
      await store.release();
      throw new Error("Approval was revoked by a session transition");
    }
    store.write(run);
    coordinator.send({ type: "implementation.requested", run });
  }

  pi.registerTool({
    name: "workflow_plan",
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
      pi.appendEntry("workflow-plan", pending);
      return {
        content: [
          {
            type: "text",
            text:
              `Plan recorded. Digest ${pending.digest}. The operator can review it with /workflow implement ` +
              `or approve it with /workflow implement ${pending.digest} --allow-checks. No implementation was authorized.`,
          },
        ],
        details: { digest: pending.digest },
      };
    },
  });

  pi.registerCommand("workflow", {
    description:
      "stop | status | implement [<digest> --allow-checks] | resume [--accept-edits] | retire",
    handler: async (args, ctx) =>
      lockControl(async () => {
        const [command = "status", ...flags] = args.trim().split(/\s+/);
        if (command === "stop") {
          if (flags.length) throw new Error("stop takes no arguments");
          await stop();
        } else if (command === "status" || command === "") {
          const snapshot = actor?.getSnapshot();
          report(
            `Phase: ${String(snapshot?.value ?? "unavailable")}\n` +
              `Plan digest: ${pending?.digest ?? "none"}\n${snapshot?.context.reason ?? ""}`,
          );
        } else if (command === "implement") {
          const digest = flags.find((flag) => !flag.startsWith("--"));
          if (flags.some((flag) => flag !== digest && flag !== "--allow-checks"))
            throw new Error("Unknown implement argument");
          if (flags.includes("--allow-checks") && !digest)
            throw new Error("Explicit check approval requires the full plan digest");
          await implement(ctx, digest, flags.includes("--allow-checks"));
        } else if (command === "retire") {
          if (flags.length) throw new Error("retire takes no arguments");
          if (!actor || !journal || !resources || !ctx.isIdle())
            throw new Error("No idle coordinator is available");
          const run = journal.current();
          if (!run || ["delivered", "retired"].includes(run.checkpoint))
            throw new Error("No unfinished run exists");
          await stop();
          await journal.acquire(run.id);
          try {
            journal.write({ ...(journal.read(run.id) ?? run), checkpoint: "retired" });
          } finally {
            await journal.release();
          }
          pending = undefined;
          pi.appendEntry("workflow-plan-cleared", { reason: "run-retired", runId: run.id });
          actor.send({ type: "run.retired" });
          report(
            "Run retired after confirmed drain. Files, branches, PRs and history are preserved. Return to the current base and record a new plan before approval.",
          );
        } else if (command === "resume") {
          if (flags.some((flag) => flag !== "--accept-edits"))
            throw new Error("Unknown resume argument");
          if (!actor || !journal || !resources || !ctx.isIdle())
            throw new Error("No idle coordinator is available");
          if (!idle() && !actor.getSnapshot().matches("blocked"))
            throw new Error("Stop the active run before resuming");
          const run = journal.current();
          if (!run || ["delivered", "retired"].includes(run.checkpoint))
            throw new Error("No unfinished run exists");
          resources.reset();
          await journal.acquire(run.id);
          if (idle()) actor.send({ type: "run.recovered", run });
          actor.send({
            type: "run.resumed",
            run,
            acceptRecoveredEdits: flags.includes("--accept-edits"),
          });
        } else throw new Error("Unknown workflow command");
      }),
  });
  pi.on("session_start", async (_event, ctx) => {
    try {
      await initialize(ctx);
    } catch (error) {
      report(error instanceof Error ? error.message : "Workflow initialization failed");
    }
  });
  pi.on("before_agent_start", (event) =>
    active()
      ? {
          systemPrompt:
            `${event.systemPrompt}\n\nA workflow run owns this repository. You are its read-only conductor: ` +
            "report status and investigate when asked. Do not claim completion without recorded evidence.",
        }
      : undefined,
  );
  pi.on("tool_call", (event) => (active() ? runAdmission(event.toolName) : undefined));
  pi.on("user_bash", () =>
    active()
      ? {
          result: {
            output: "An active run owns this repository; use /workflow stop first.",
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        }
      : undefined,
  );
  pi.on("session_before_switch", () => stop());
  pi.on("session_before_fork", () => stop());
  pi.on("session_before_tree", () => stop());
  pi.on("session_tree", async (_event, ctx) => {
    await initialize(ctx);
  });
  pi.on("session_shutdown", () => stop());
}
