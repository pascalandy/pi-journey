import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  MutationQueue,
  runAdmission,
  scopeAllows,
  validateScope,
  writablePath,
} from "../src/policy.ts";
import { repository } from "./helpers.ts";

test("an active run admits investigation and rejects plan, write, and execution tools", () => {
  for (const name of ["read", "grep", "find", "ls"]) {
    assert.equal(runAdmission(name), undefined);
  }
  for (const name of ["journey_plan", "write", "edit", "bash", "codemode", "other"]) {
    assert.deepEqual(runAdmission(name), {
      block: true,
      reason: "An active run owns this repository; use /journey stop first",
    });
  }
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
    await assert.rejects(() => writablePath(fixture.root, ["."], ".PI/JOURNEY.JSON"), /scope/);
    await assert.rejects(() => writablePath(fixture.root, ["src"], "src/link/secret"), /scope/);
    await assert.rejects(() => writablePath(fixture.root, ["src"], "src/dangling"), /symlink/);
    await assert.rejects(() => writablePath(fixture.root, ["src"], "src/two"), /hard-linked/);
    assert.equal(await readFile(join(fixture.root, "other", "secret"), "utf8"), "preserve");
    assert.throws(() => validateScope(["src/../other"]), /relative/);
    assert.equal(scopeAllows(["./src"], "src/café.ts"), true);
    await assert.rejects(() => writablePath(fixture.root, ["src"], "src\\probe.ts"), /scope/);
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
