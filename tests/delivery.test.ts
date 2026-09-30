import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig, evidence, makePlan, makeRun, type Review } from "../src/contracts.ts";
import { acceptReview, Delivery, deliveryTargets } from "../src/delivery.ts";
import { fileHash, hash } from "../src/files.ts";
import { checksReady, type PullRequest, reviewersReady, type Threads } from "../src/github.ts";
import { Journal } from "../src/journal.ts";
import { OwnedResources } from "../src/runner.ts";
import { repository, run } from "./helpers.ts";

const head = "a".repeat(40);

test("review verdict cannot erase old unresolved findings or certify another head", () => {
  const record = run();
  const unit = record.units[0];
  assert.ok(unit);
  unit.head = head;
  const review: Review = {
    verdict: "findings",
    reviewedHead: head,
    summary: "Defect",
    findings: [
      {
        id: "R1",
        priority: 1,
        path: "src/file.ts",
        line: 1,
        detail: "Broken",
        disposition: "open",
        evidence: "",
      },
    ],
  };
  assert.equal(acceptReview(record, review, "review").kind, "repair");
  assert.equal(
    acceptReview(record, { ...review, verdict: "pass", findings: [] }, "review").kind,
    "repair",
  );
  assert.equal(
    acceptReview(record, { ...review, verdict: "pass", reviewedHead: "b".repeat(40) }, "review")
      .kind,
    "blocked",
  );
  assert.equal(
    acceptReview(
      record,
      {
        ...review,
        verdict: "pass",
        findings: review.findings.map((item) => ({
          ...item,
          disposition: "fixed",
          evidence: "src/file.ts:1 now uses the current value",
        })),
      },
      "review",
    ).kind,
    "passed",
  );
});

test("delivery selects only the final cumulative PR or every ordered stack layer", () => {
  const record = run();
  const unit = record.units[0];
  assert.ok(unit);
  record.units.push({ ...unit });
  assert.deepEqual(deliveryTargets(record), [1]);
  record.plan.delivery = "stack";
  assert.deepEqual(deliveryTargets(record), [0, 1]);
});

test("remote checks and named approvals must be successful at the current head", () => {
  const pr: PullRequest = {
    number: 1,
    url: "https://github.com/example/repo/pull/1",
    headRefOid: head,
    baseRefOid: "b".repeat(40),
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  };
  assert.equal(checksReady(pr, ["verify"]), true);
  assert.equal(checksReady(pr, ["missing"]), false);
  assert.equal(
    checksReady(
      { ...pr, statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "QUEUED" }] },
      ["verify"],
    ),
    false,
  );
  const threads: Threads = {
    autoMergeRequest: null,
    mergeQueueEntry: null,
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{ author: { login: "reviewer" }, state: "APPROVED", commit: { oid: head } }],
    },
  };
  assert.equal(reviewersReady(threads, head, ["reviewer"]), true);
  assert.equal(reviewersReady(threads, "b".repeat(40), ["reviewer"]), false);
});

test("checks certify a real committed tree and reject mutations created by the check", async () => {
  const fixture = await repository();
  const resources = new OwnedResources();
  const journal = new Journal(fixture.root);
  try {
    const record = run(fixture.root);
    const unit = record.units[0];
    assert.ok(unit);
    unit.head = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await journal.acquire(record.id);
    journal.write(record);
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected worker invocation");
    };
    const delivery = new Delivery(
      fixture.root,
      journal,
      resources,
      { write: unavailable, audit: unavailable, review: unavailable, preflight: unavailable },
      () => {},
    );
    assert.equal(
      (await delivery.execute("checks", record, new AbortController().signal)).kind,
      "passed",
    );
    record.plan.checks = [
      {
        name: "mutating",
        argv: [process.execPath, "-e", "require('node:fs').writeFileSync('surprise','x')"],
        effects: "Creates an untracked file",
        timeoutMs: 1_000,
      },
    ];
    // Direct stage invocation uses the journal's accepted plan, so install this new fixture before executing.
    const { makePlan } = await import("../src/contracts.ts");
    record.plan = makePlan(record.plan, fixture.root);
    record.grant.planDigest = record.plan.digest;
    journal.write(record);
    await assert.rejects(
      delivery.execute("checks", record, new AbortController().signal),
      /Committed tree changed/,
    );
    assert.equal(await fileHash(join(fixture.root, "surprise")), hash("x"));
  } finally {
    await resources.drain();
    await journal.release();
    await fixture.cleanup();
  }
});

test("coordinator commits attributable scoped edits and preserves unrelated files", async () => {
  const fixture = await repository();
  const resources = new OwnedResources();
  const journal = new Journal(fixture.root);
  try {
    const record = run(fixture.root);
    const unit = record.units[0];
    assert.ok(unit);
    execFileSync("git", ["-C", fixture.root, "checkout", "-b", unit.branch], { stdio: "ignore" });
    unit.baseHead = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await journal.acquire(record.id);
    await mkdir(join(fixture.root, "src"));
    await writeFile(join(fixture.root, "src/feature.ts"), "export const value = 1;\n");
    record.edits.push({
      unit: 0,
      path: "src/feature.ts",
      beforeHash: null,
      afterHash: hash("export const value = 1;\n"),
      state: "confirmed",
    });
    for (const path of ["src/café.ts", "src/back\\slash.ts", "src/line\nbreak.ts"]) {
      const content = "export const value = 2;\n";
      await writeFile(join(fixture.root, path), content);
      record.edits.push({
        unit: 0,
        path,
        beforeHash: null,
        afterHash: hash(content),
        state: "confirmed",
      });
    }
    journal.write(record);
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected worker invocation");
    };
    const delivery = new Delivery(
      fixture.root,
      journal,
      resources,
      { write: unavailable, audit: unavailable, review: unavailable, preflight: unavailable },
      () => {},
    );
    execFileSync("git", ["-C", fixture.root, "checkout", "main"], { stdio: "ignore" });
    await assert.rejects(
      delivery.execute("commit", record, new AbortController().signal),
      /Workflow branch changed/,
    );
    assert.equal(
      execFileSync("git", ["-C", fixture.root, "rev-parse", "main"], {
        encoding: "utf8",
      }).trim(),
      unit.baseHead,
    );
    assert.equal(
      await fileHash(join(fixture.root, "src/feature.ts")),
      hash("export const value = 1;\n"),
    );
    execFileSync("git", ["-C", fixture.root, "checkout", unit.branch], { stdio: "ignore" });
    const committed = await delivery.execute("commit", record, new AbortController().signal);
    assert.equal(committed.kind, "passed");
    const committedHead = committed.run.units[0]?.head;
    assert.ok(committedHead);
    assert.match(
      execFileSync("git", ["-C", fixture.root, "show", `${committedHead}:src/feature.ts`], {
        encoding: "utf8",
      }),
      /value = 1/,
    );
    assert.equal(committed.run.operations.at(-1)?.state, "confirmed");
    for (const path of ["src/café.ts", "src/back\\slash.ts", "src/line\nbreak.ts"]) {
      assert.equal(
        execFileSync("git", ["-C", fixture.root, "show", `${committedHead}:${path}`], {
          encoding: "utf8",
        }),
        "export const value = 2;\n",
      );
    }
    assert.equal(committed.run.units[0]?.checks, null);
    await writeFile(join(fixture.root, "unrelated"), "preserve me");
    await assert.rejects(
      delivery.execute("commit", committed.run, new AbortController().signal),
      /Unattributed/,
    );
    assert.equal(await fileHash(join(fixture.root, "unrelated")), hash("preserve me"));
    assert.equal(
      execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      committedHead,
    );
    unit.checks = evidence(committedHead, true, "fixture");
  } finally {
    await resources.drain();
    await journal.release();
    await fixture.cleanup();
  }
});

test("resuming a confirmed repair commit propagates it to existing descendants", async () => {
  const fixture = await repository();
  class InterruptedCommit extends OwnedResources {
    interrupted = false;
    override command(...args: Parameters<OwnedResources["command"]>) {
      if (!this.interrupted && args[0][0] === "git" && args[0][1] === "diff-tree") {
        this.interrupted = true;
        return Promise.resolve({ code: 1, stdout: "", stderr: "Stopped after commit receipt" });
      }
      return super.command(...args);
    }
  }
  const resources = new InterruptedCommit();
  const journal = new Journal(fixture.root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", fixture.root, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  try {
    const plan = makePlan(
      {
        ...run(fixture.root).plan,
        delivery: "stack",
        units: [0, 1].map((index) => ({
          title: `Unit ${index}`,
          paths: [`src/unit-${index}.ts`],
          commitMessage: `feat: unit ${index}`,
        })),
      },
      fixture.root,
    );
    const record = makeRun(plan, defaultConfig(), { executeChecks: true, merge: false });
    record.startHead = git("rev-parse", "HEAD");
    await mkdir(join(fixture.root, "src"));
    for (const [index, unit] of record.units.entries()) {
      unit.baseHead = git("rev-parse", "HEAD");
      git("checkout", "-b", unit.branch);
      await writeFile(
        join(fixture.root, `src/unit-${index}.ts`),
        `export const value = ${index};\n`,
      );
      git("add", ".");
      git("commit", "-m", `feat: initial unit ${index}`);
      unit.head = git("rev-parse", "HEAD");
      unit.checks = unit.secondPass = unit.review = evidence(unit.head, true, "Old evidence");
    }
    record.unitIndex = 0;
    record.repairRounds = 1;
    record.resumeStage = "commit";
    const first = record.units[0];
    assert.ok(first);
    git("checkout", first.branch);
    const content = "export const value = 42;\n";
    await writeFile(join(fixture.root, "src/unit-0.ts"), content);
    record.edits.push({
      unit: 0,
      path: "src/unit-0.ts",
      beforeHash: hash("export const value = 0;\n"),
      afterHash: hash(content),
      state: "confirmed",
    });
    await journal.acquire(record.id);
    journal.write(record);
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected worker invocation");
    };
    const delivery = new Delivery(
      fixture.root,
      journal,
      resources,
      { write: unavailable, audit: unavailable, review: unavailable, preflight: unavailable },
      () => {},
    );
    await assert.rejects(
      delivery.execute("commit", record, new AbortController().signal),
      /Stopped after commit receipt/,
    );
    const recovered = journal.current();
    assert.ok(recovered);
    assert.equal(recovered.operations.at(-1)?.state, "confirmed");
    const repairHead = recovered.units[0]?.head;
    const result = await delivery.execute("commit", recovered, new AbortController().signal);
    assert.equal(result.kind, "passed");
    const descendant = result.run.units[1];
    assert.ok(descendant);
    assert.equal(result.run.unitIndex, 0);
    assert.equal(
      result.run.units[0]?.head,
      repairHead,
      "recovery does not duplicate the repair commit",
    );
    assert.equal(descendant.baseHead, repairHead);
    assert.equal(git("show", `${descendant.branch}:src/unit-0.ts`), "export const value = 42;");
    assert.equal(git("show", `${descendant.branch}:src/unit-1.ts`), "export const value = 1;");
    assert.equal(descendant.checks, null);
    assert.equal(descendant.secondPass, null);
    assert.equal(descendant.review, null);
    assert.equal(result.run.operations.at(-1)?.unit, 1);
    git("checkout", descendant.branch);
    await writeFile(join(fixture.root, "external"), "Preserve unrelated descendant commit");
    git("add", "external");
    git("commit", "-m", "External descendant change");
    const externalHead = git("rev-parse", "HEAD");
    git("checkout", first.branch);
    await assert.rejects(
      delivery.execute("commit", result.run, new AbortController().signal),
      /Committed tree changed/,
    );
    assert.equal(git("rev-parse", descendant.branch), externalHead);
    assert.equal(
      git("show", `${descendant.branch}:external`),
      "Preserve unrelated descendant commit",
    );
  } finally {
    await resources.drain();
    await journal.release();
    await fixture.cleanup();
  }
});
