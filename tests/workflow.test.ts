import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "xstate";
import type { StepResult } from "../src/contracts.ts";
import { createWorkflow } from "../src/workflow.ts";
import { run } from "./helpers.ts";

test("a run does not start until an operator event approves it", async () => {
  const stages: string[] = [];
  const actor = createWorkflow({
    execute: async (stage, current) => {
      stages.push(stage);
      return { kind: "passed", run: current };
    },
    drain: async () => {},
    save: () => {},
  }).start();
  assert.equal(actor.getSnapshot().value, "planning");
  assert.deepEqual(stages, []);
  actor.send({ type: "implementation.requested", run: run() });
  await waitFor(actor, (snapshot) => snapshot.matches("delivered"));
  assert.deepEqual(stages, [
    "preflight",
    "work",
    "commit",
    "checks",
    "secondPass",
    "review",
    "publish",
    "monitor",
    "merge",
    "retrospective",
  ]);
  actor.stop();
});

test("returning to Planning cancels work and waits for resource drainage", async () => {
  const signals: AbortSignal[] = [];
  const work = Promise.withResolvers<void>();
  const drain = Promise.withResolvers<void>();
  const stages: string[] = [];
  const actor = createWorkflow({
    execute: async (stage, current, signal) => {
      stages.push(stage);
      if (stage === "work") {
        signals.push(signal);
        await work.promise;
      }
      return { kind: "passed", run: current };
    },
    drain: async () => drain.promise,
    save: () => {},
  }).start();
  actor.send({ type: "implementation.requested", run: run() });
  await waitFor(actor, (snapshot) => snapshot.matches("work"));
  actor.send({ type: "planning.requested" });
  assert.equal(actor.getSnapshot().value, "stopping");
  assert.equal(signals[0]?.aborted, true);
  work.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actor.getSnapshot().value, "stopping");
  drain.resolve();
  await waitFor(actor, (snapshot) => snapshot.matches("planning"));
  assert.deepEqual(stages, ["preflight", "work"]);
  actor.stop();
});

test("the machine bounds repair cycles even when a worker keeps requesting repair", async () => {
  const current = run();
  current.config.maxRepairRounds = 1;
  let repairs = 0;
  const actor = createWorkflow({
    execute: async (stage, value): Promise<StepResult> => {
      if (stage === "checks") return { kind: "repair", run: value, reason: "check failed" };
      if (stage === "repair") repairs++;
      return { kind: "passed", run: value };
    },
    drain: async () => {},
    save: () => {},
  }).start();
  actor.send({ type: "implementation.requested", run: current });
  await waitFor(actor, (snapshot) => snapshot.matches("blocked"));
  assert.equal(repairs, 1);
  assert.equal(actor.getSnapshot().context.reason, "Repair budget exhausted");
  actor.stop();
});

test("recovered runs remain blocked until an explicit resume event", async () => {
  let executed = 0;
  const actor = createWorkflow({
    execute: async (_stage, value) => {
      executed++;
      return { kind: "blocked", run: value, reason: "Missing capability" };
    },
    drain: async () => {},
    save: () => {},
  }).start();
  actor.send({ type: "run.recovered", run: run() });
  assert.equal(actor.getSnapshot().value, "blocked");
  assert.equal(executed, 0);
  actor.send({ type: "run.resumed", acceptRecoveredEdits: false });
  await waitFor(
    actor,
    (snapshot) => snapshot.matches("blocked") && snapshot.context.reason === "Missing capability",
  );
  assert.equal(executed, 1);
  actor.stop();
});
