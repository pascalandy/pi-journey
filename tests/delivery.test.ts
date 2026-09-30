import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { evidence, makePlan, type Review, type Run } from "../src/contracts.ts";
import { acceptReview, Delivery, deliveryTargets } from "../src/delivery.ts";
import { fileHash, hash, writeOwnedFile } from "../src/files.ts";
import { Journal } from "../src/journal.ts";
import { OwnedResources } from "../src/runner.ts";
import { repository, run } from "./helpers.ts";

const head = "a".repeat(40);

for (const interruption of ["before-write", "after-write", "consecutive"] as const) {
  test(`recovery admits only attributable content after ${interruption} interruption`, async () => {
    const fixture = await repository();
    let crash: "prepared" | "confirmed" | undefined;
    const journal = new (class extends Journal {
      override write(record: Run) {
        const state = record.edits.at(-1)?.state;
        if (crash === "confirmed" && state === crash) {
          crash = undefined;
          throw new Error("Interrupted before confirmation");
        }
        super.write(record);
        if (crash === "prepared" && state === crash) {
          crash = undefined;
          throw new Error("Interrupted before file write");
        }
      }
    })(fixture.root);
    const resources = new (class extends OwnedResources {
      override command(...args: Parameters<OwnedResources["command"]>) {
        if (args[0][0] === "gh") {
          assert.deepEqual(args[0], [
            "gh",
            "repo",
            "view",
            "https://github.com/fixture/repository.git",
            "--json",
            "nameWithOwner",
          ]);
          return Promise.resolve({
            code: 0,
            stdout: '{"nameWithOwner":"fixture/repository"}',
            stderr: "",
          });
        }
        return super.command(...args);
      }
    })();
    try {
      const record = run(fixture.root);
      const unit = record.units[0];
      assert.ok(unit);
      execFileSync("git", ["-C", fixture.root, "checkout", "-b", unit.branch], { stdio: "ignore" });
      execFileSync("git", [
        "-C",
        fixture.root,
        "remote",
        "add",
        "origin",
        "https://github.com/fixture/repository.git",
      ]);
      record.startHead = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      unit.baseHead = record.startHead;
      record.acceptRecoveredEdits = true;
      await journal.acquire(record.id);
      journal.write(record);
      const signal = new AbortController().signal;
      const path = "src/value.ts";
      const write = (content: string) =>
        writeOwnedFile(record, journal, resources, path, content, signal);
      await write("Owned B\n");
      crash = interruption === "before-write" ? "prepared" : "confirmed";
      await assert.rejects(write("Owned C\n"), /Interrupted before/);
      if (interruption === "consecutive") {
        crash = "prepared";
        await assert.rejects(write("Owned D\n"), /Interrupted before file write/);
      }
      const content = interruption === "before-write" ? "Owned B\n" : "Owned C\n";
      assert.equal(await readFile(join(fixture.root, path), "utf8"), content);
      const unavailable = async (): Promise<never> => {
        throw new Error("Unexpected worker invocation");
      };
      const delivery = new Delivery(
        fixture.root,
        journal,
        resources,
        {
          preflight: async () => {},
          write: unavailable,
          audit: unavailable,
          review: unavailable,
        },
        () => {},
      );
      const result = await delivery.execute("preflight", record, signal);
      assert.equal(result.kind, "passed");
      assert.equal(await readFile(join(fixture.root, path), "utf8"), content);
      if (interruption === "consecutive") {
        await writeFile(join(fixture.root, path), "Owned B\n");
        await assert.rejects(
          delivery.execute("preflight", record, signal),
          /Unattributed repository change/,
        );
        await assert.rejects(write("Replacement\n"), /External change/);
        assert.equal(await readFile(join(fixture.root, path), "utf8"), "Owned B\n");
        await writeFile(join(fixture.root, path), content);
      }
      await write("Recovered\n");
      assert.equal(await readFile(join(fixture.root, path), "utf8"), "Recovered\n");
    } finally {
      await resources.drain();
      await journal.release();
      await fixture.cleanup();
    }
  });
}

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
    record.plan = makePlan(
      {
        ...record.plan,
        units: record.plan.units.map((unit) => ({
          ...unit,
          paths: [...unit.paths, " leading.ts"],
        })),
      },
      fixture.root,
    );
    await writeFile(join(fixture.root, "src/feature.ts"), "export const value = 1;\n");
    record.edits.push({
      unit: 0,
      path: "src/feature.ts",
      beforeHash: null,
      afterHash: hash("export const value = 1;\n"),
      state: "confirmed",
    });
    for (const path of [" leading.ts", "src/café.ts", "src/back\\slash.ts", "src/line\nbreak.ts"]) {
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
      /Journey branch changed/,
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
    for (const path of [" leading.ts", "src/café.ts", "src/back\\slash.ts", "src/line\nbreak.ts"]) {
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
