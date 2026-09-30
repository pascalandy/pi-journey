import { assign, createActor, type DoneActorEvent, fromPromise, setup } from "xstate";
import type { Run, Stage, StepResult } from "./contracts.ts";

export interface WorkflowPorts {
  execute(stage: Stage, run: Run, signal: AbortSignal): Promise<StepResult>;
  drain(outcome: "planning" | "delivered"): Promise<void>;
  save(run: Run, state: string): void;
}

interface Context {
  run: Run | null;
  reason: string;
}

type Event =
  | { type: "implementation.requested"; run: Run }
  | { type: "planning.requested" }
  | { type: "run.recovered"; run: Run }
  | { type: "run.retired" }
  | { type: "run.resumed"; acceptRecoveredEdits: boolean; run?: Run }
  | { type: "ownership.lost"; reason: string };

export function workflowMachine(ports: WorkflowPorts) {
  const configured = setup({
    types: {
      context: {} as Context,
      events: {} as Event,
    },
    actors: {
      step: fromPromise<StepResult, { stage: Stage; run: Run }>(async ({ input, signal }) =>
        ports.execute(input.stage, input.run, signal),
      ),
      drain: fromPromise<void, "planning" | "delivered">(async ({ input }) => ports.drain(input)),
    },
    actions: {
      accept: assign(({ event }) =>
        event.type === "implementation.requested" || event.type === "run.recovered"
          ? {
              run: event.run,
              reason: event.type === "run.recovered" ? "Recovered run needs explicit resume" : "",
            }
          : {},
      ),
      resume: assign(({ context, event }) => ({
        run:
          context.run !== null && event.type === "run.resumed"
            ? { ...(event.run ?? context.run), acceptRecoveredEdits: event.acceptRecoveredEdits }
            : context.run,
        reason: "",
      })),
      applyResult: assign((_args, result: StepResult) => ({
        run: {
          ...result.run,
          repairReason: result.kind === "repair" ? result.reason : result.run.repairReason,
          repairRounds: result.run.repairRounds + (result.kind === "repair" ? 1 : 0),
        },
        reason: result.kind === "blocked" ? result.reason : "",
      })),
      recordError: assign((_args, error: unknown) => ({
        reason: error instanceof Error ? error.message : "Workflow operation failed",
      })),
      checkpoint: ({ context }, stage: string) => {
        if (context.run !== null) ports.save(context.run, stage);
      },
      exhaustBudget: assign((_args, result: StepResult) => ({
        run: result.run,
        reason: "Repair budget exhausted",
      })),
    },
  });

  const resultAction = {
    type: "applyResult" as const,
    params: ({ event }: { event: DoneActorEvent<StepResult> }) => event.output,
  };
  const step = (stage: Stage, target: string) =>
    configured.createStateConfig({
      entry: { type: "checkpoint", params: stage },
      invoke: {
        src: "step" as const,
        input: ({ context }: { context: Context }) => {
          if (context.run === null) throw new Error("Implementation has no accepted run");
          return { stage, run: context.run };
        },
        onDone: [
          {
            guard: ({ event }: { event: { output: StepResult } }) =>
              event.output.kind === "repair" &&
              event.output.run.repairRounds >= event.output.run.config.maxRepairRounds,
            target: "blocked",
            actions: {
              type: "exhaustBudget",
              params: ({ event }: { event: DoneActorEvent<StepResult> }) => event.output,
            },
          },
          {
            guard: ({ event }: { event: { output: StepResult } }) =>
              event.output.kind === "blocked",
            target: "blocked",
            actions: resultAction,
          },
          {
            guard: ({ event }: { event: { output: StepResult } }) => event.output.kind === "repair",
            target: "repair",
            actions: resultAction,
          },
          ...(
            [
              "work",
              "commit",
              "checks",
              "secondPass",
              "review",
              "repair",
              "publish",
              "monitor",
              "merge",
              "prepare",
              "retrospective",
            ] as const
          ).map((next) => ({
            guard: ({ event }: { event: { output: StepResult } }) =>
              event.output.kind === "passed" && event.output.next === next,
            target: next,
            actions: resultAction,
          })),
          {
            target,
            actions: resultAction,
          },
        ],
        onError: {
          target: "blocked",
          actions: {
            type: "recordError",
            params: ({ event }: { event: { error: unknown } }) => event.error,
          },
        },
      },
    });

  return configured.createMachine({
    id: "modeWorkflow",
    initial: "planning",
    context: { run: null, reason: "" },
    on: {
      "planning.requested": { target: ".stopping" },
      "ownership.lost": {
        target: ".stopping",
        actions: assign(({ event }) => ({ reason: event.reason })),
      },
    },
    states: {
      planning: {
        on: {
          "run.retired": { actions: assign({ run: null, reason: "" }) },
          "implementation.requested": { target: "preflight", actions: "accept" },
          "run.recovered": { target: "blocked", actions: "accept" },
        },
      },
      preflight: step("preflight", "work"),
      work: step("work", "commit"),
      commit: step("commit", "checks"),
      checks: step("checks", "secondPass"),
      secondPass: step("secondPass", "review"),
      review: step("review", "publish"),
      repair: step("repair", "commit"),
      publish: step("publish", "monitor"),
      monitor: step("monitor", "merge"),
      merge: step("merge", "retrospective"),
      prepare: step("prepare", "checks"),
      retrospective: step("retrospective", "finalizing"),
      blocked: {
        entry: ({ context }) => {
          if (context.run !== null) ports.save(context.run, "blocked");
        },
        on: { "run.resumed": { target: "preflight", actions: "resume" } },
      },
      stopping: {
        invoke: {
          src: "drain",
          input: "planning",
          onDone: { target: "planning" },
          onError: {
            target: "stopFailed",
            actions: assign(({ event }) => ({
              reason:
                event.error instanceof Error ? event.error.message : "Owned work did not drain",
            })),
          },
        },
      },
      stopFailed: {},
      finalizing: {
        invoke: {
          src: "drain",
          input: "delivered",
          onDone: { target: "delivered" },
          onError: {
            target: "stopFailed",
            actions: assign(({ event }) => ({
              reason:
                event.error instanceof Error ? event.error.message : "Finalization did not drain",
            })),
          },
        },
      },
      delivered: {
        entry: ({ context }) => {
          if (context.run !== null) ports.save(context.run, "delivered");
        },
        on: { "implementation.requested": { target: "preflight", actions: "accept" } },
      },
    },
  });
}

export function createWorkflow(ports: WorkflowPorts) {
  return createActor(workflowMachine(ports));
}
