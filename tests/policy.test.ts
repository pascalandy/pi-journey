import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendPlanningFooter,
  MutationQueue,
  planningAdmission,
  validateScope,
  writablePath,
} from "../src/policy.ts";
import { repository } from "./helpers.ts";

test("Planning admits investigation and rejects unknown, nested-execution, and write capabilities", () => {
  for (const name of ["read", "grep", "find", "ls", "workflow_plan"]) {
    assert.equal(planningAdmission(name), undefined);
  }
  for (const name of ["write", "edit", "bash", "powershell", "codemode", "tool_search", "other"]) {
    assert.deepEqual(planningAdmission(name), {
      block: true,
      reason: "Planning permits investigation and plan recording only",
    });
  }
});

test("Planning final text has exactly one literal required footer", () => {
  assert.equal(appendPlanningFooter("A plan.\n"), "A plan.\n\n— We are in the Planning Phase");
  assert.equal(
    appendPlanningFooter("A plan.\n\n— We are in the Planning Phase\n"),
    "A plan.\n\n— We are in the Planning Phase",
  );
});

test("scoped writes reject repository escape, metadata, symlink escape, and hard links", async () => {
  const fixture = await repository();
  try {
    await mkdir(join(fixture.root, "src"));
    await mkdir(join(fixture.root, "other"));
    await writeFile(join(fixture.root, "other", "secret"), "preserve");
    await symlink(join(fixture.root, "other"), join(fixture.root, "src", "link"));
    await symlink(join(fixture.root, "other", "missing"), join(fixture.root, "src", "dangling"));
    await writeFile(join(fixture.root, "src", "one"), "original");
    await link(join(fixture.root, "src", "one"), join(fixture.root, "src", "two"));
    assert.equal(
      await writablePath(fixture.root, ["src"], "src/new/nested.ts"),
      join(fixture.root, "src", "new", "nested.ts"),
    );
    await assert.rejects(() => writablePath(fixture.root, ["."], "../outside"), /scope/);
    await assert.rejects(() => writablePath(fixture.root, ["."], ".git/config"), /scope/);
    await assert.rejects(() => writablePath(fixture.root, ["."], ".GIT/config"), /scope/);
    await assert.rejects(
      () => writablePath(fixture.root, ["."], ".PI/MODE-WORKFLOW.JSON"),
      /scope/,
    );
    await assert.rejects(() => writablePath(fixture.root, ["src"], "src/link/secret"), /scope/);
    await assert.rejects(() => writablePath(fixture.root, ["src"], "src/dangling"), /symlink/);
    await assert.rejects(() => writablePath(fixture.root, ["src"], "src/two"), /hard-linked/);
    assert.equal(await readFile(join(fixture.root, "other", "secret"), "utf8"), "preserve");
    assert.throws(() => validateScope(["src/../other"]), /relative/);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent file mutations serialize the whole read-modify-write operation", async () => {
  const fixture = await repository();
  try {
    const file = join(fixture.root, "counter");
    await writeFile(file, "0");
    const queue = new MutationQueue();
    const signal = new AbortController().signal;
    const increment = () =>
      queue.run(signal, async () => {
        const value = Number(await readFile(file, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await writeFile(file, String(value + 1));
      });
    await Promise.all([increment(), increment()]);
    await queue.drain();
    assert.equal(await readFile(file, "utf8"), "2");
  } finally {
    await fixture.cleanup();
  }
});
