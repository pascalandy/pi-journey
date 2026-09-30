import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
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
import {
  appendPlanningFooter,
  PLANNING_TOOLS,
  planningAdmission,
  validateScope,
} from "./policy.ts";
import { OwnedResources, Workers } from "./runner.ts";
import { createWorkflow } from "./workflow.ts";

const planningPrompt = readFileSync(
  fileURLToPath(new URL("../prompts/planning.md", import.meta.url)),
  "utf8",
);

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
  const planning = () => actor === undefined || actor.getSnapshot().matches("planning");
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
    actor.send({ type: "planning.requested" });
    const stopped = await waitFor(
      actor,
      (snapshot) => snapshot.matches("planning") || snapshot.matches("stopFailed"),
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
        ctx.ui.setStatus(
          "mode-workflow",
          `${state === "planning" ? "Planning" : "Implementation"} | ${state}`,
        );
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
    if (prior && prior.checkpoint !== "delivered")
      coordinator.send({ type: "run.recovered", run: prior });
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "workflow-plan") {
        pending = parse(PlanSchema, entry.data, "session plan");
        if (pending.repository !== repository) pending = undefined;
      }
    }
    pi.setActiveTools(PLANNING_TOOLS);
  }

  async function implement(
    ctx: ExtensionContext,
    digest: string | undefined,
    allowChecks: boolean,
    merge: boolean,
  ): Promise<void> {
    if (!actor || !journal || !resources)
      throw new Error("Workflow is unavailable in this directory");
    const coordinator = actor;
    const store = journal;
    const owned = resources;
    const epoch = approvalEpoch;
    if (!ctx.isIdle()) throw new Error("Wait for the Planning response to finish before switching");
    if (!planning() && !actor.getSnapshot().matches("delivered"))
      throw new Error("Stop or resume the existing run first");
    const proposal = pending;
    if (!proposal || proposal.repository !== repository)
      throw new Error("Finish alignment and record a workflow_plan first");
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
          `Trusted checks and Git hooks can execute repository code beyond scoped file tools.\n` +
          `${proposal.checks.map((check) => `${check.name}: ${JSON.stringify(check.argv)}\nEffects: ${check.effects}`).join("\n")}\n\n` +
          `Publish ${proposal.delivery === "stack" ? "a linear PR stack" : "a regular PR"}. ${merge ? "Auto-merge is authorized for this run." : "Leave PRs unmerged."}`,
      );
      if (!accepted) return;
    }
    if (pending?.digest !== proposal.digest || approvalEpoch !== epoch)
      throw new Error("Plan changed while approval was open");
    const prior = store.current();
    if (prior && prior.checkpoint !== "delivered")
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
    const run = makeRun(proposal, config, { executeChecks: true, merge });
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
      "Record the complete aligned CMO/FMO/premortem plan, ordered units, scoped paths and named checks. This never approves implementation.",
    parameters: PlanInputSchema,
    execute: async (_id, input) => {
      if (!planning() || !repository) throw new Error("Plans can only be recorded in Planning");
      const proposal = parse(PlanInputSchema, input, "plan proposal");
      if (
        !["CMO", "FMO", "Premortem"].every((section) =>
          proposal.body.toLowerCase().includes(section.toLowerCase()),
        )
      ) {
        throw new Error("The plan must include CMO, FMO and Premortem");
      }
      for (const unit of proposal.units) validateScope(unit.paths);
      pending = makePlan(proposal, repository);
      pi.appendEntry("workflow-plan", pending);
      return {
        content: [
          {
            type: "text",
            text:
              `Plan recorded. Digest ${pending.digest}. The operator can press Ctrl+Alt+M or use ` +
              `/workflow implement ${pending.digest} --allow-checks. No implementation was authorized.`,
          },
        ],
        details: { digest: pending.digest },
      };
    },
  });

  pi.registerCommand("workflow", {
    description:
      "plan | status | implement <digest> --allow-checks [--merge] | resume [--accept-edits]",
    handler: async (args, ctx) =>
      lockControl(async () => {
        const [command = "status", ...flags] = args.trim().split(/\s+/);
        if (command === "plan") {
          if (flags.length) throw new Error("plan takes no arguments");
          await stop();
        } else if (command === "status" || command === "") {
          const snapshot = actor?.getSnapshot();
          report(
            `Mode: ${planning() ? "Planning" : "Implementation"}\nPhase: ${String(snapshot?.value ?? "unavailable")}\n` +
              `Plan digest: ${pending?.digest ?? "none"}\n${snapshot?.context.reason ?? ""}`,
          );
        } else if (command === "implement") {
          const digest = flags.find((flag) => !flag.startsWith("--"));
          if (
            flags.some((flag) => flag !== digest && !["--allow-checks", "--merge"].includes(flag))
          )
            throw new Error("Unknown implement argument");
          if (flags.includes("--allow-checks") && !digest)
            throw new Error("Explicit check approval requires the full plan digest");
          await implement(ctx, digest, flags.includes("--allow-checks"), flags.includes("--merge"));
        } else if (command === "resume") {
          if (flags.some((flag) => flag !== "--accept-edits"))
            throw new Error("Unknown resume argument");
          if (!actor || !journal || !resources || !ctx.isIdle())
            throw new Error("No idle coordinator is available");
          if (!planning() && !actor.getSnapshot().matches("blocked"))
            throw new Error("Stop the active run before resuming");
          const run = journal.current();
          if (!run || run.checkpoint === "delivered") throw new Error("No unfinished run exists");
          resources.reset();
          await journal.acquire(run.id);
          if (planning()) actor.send({ type: "run.recovered", run });
          actor.send({
            type: "run.resumed",
            run,
            acceptRecoveredEdits: flags.includes("--accept-edits"),
          });
        } else throw new Error("Unknown workflow command");
      }),
  });
  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Switch between Planning and Implementation",
    handler: (ctx) =>
      lockControl(async () => {
        if (planning()) await implement(ctx, undefined, false, false);
        else await stop();
      }),
  });
  pi.on("session_start", async (_event, ctx) => {
    try {
      await initialize(ctx);
    } catch (error) {
      report(error instanceof Error ? error.message : "Workflow initialization failed");
    }
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${
      planning()
        ? planningPrompt +
          "\nAfter alignment is complete, call workflow_plan with the recommended plan and explicit paths/checks. " +
          "Only the operator's /workflow command or shortcut can approve implementation."
        : "You are the read-only conversation conductor. Implementation belongs to the owned workflow worker. " +
          "Report workflow status and investigate when asked. Do not claim completion without recorded evidence."
    }`,
  }));
  pi.on("tool_call", (event) => {
    if (event.toolName === "workflow_plan" && !planning())
      return { block: true, reason: "Implementation cannot replace the accepted plan" };
    return planningAdmission(event.toolName);
  });
  pi.on("user_bash", () => ({
    result: {
      output:
        "Workflow mode disables conversation shell execution. Checks run only through approved orchestration.",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  }));
  pi.on("message_end", (event) => {
    if (
      !planning() ||
      event.message.role !== "assistant" ||
      event.message.content.some((part) => part.type === "toolCall")
    )
      return;
    const content = [...event.message.content];
    const last = content.findLastIndex((part) => part.type === "text");
    const text = content[last];
    if (text?.type === "text") content[last] = { ...text, text: appendPlanningFooter(text.text) };
    else content.push({ type: "text", text: appendPlanningFooter("") });
    return { message: { ...event.message, content } };
  });
  pi.on("session_before_switch", () => stop());
  pi.on("session_before_fork", () => stop());
  pi.on("session_shutdown", () => stop());
}
