import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("test fixtures ignore the GIT_DIR a Git hook exports", async () => {
  const sentinel = await mkdtemp(join(tmpdir(), "hermetic-sentinel-"));
  try {
    execFileSync("git", ["init", "--quiet", sentinel]);
    const gitDir = join(sentinel, ".git");
    const config = await readFile(join(gitDir, "config"), "utf8");
    const helpers = new URL("./helpers.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `const { repository } = await import(${JSON.stringify(helpers)}); await (await repository()).cleanup();`,
      ],
      { encoding: "utf8", env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: sentinel } },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(join(gitDir, "config"), "utf8"), config);
    assert.equal(
      execFileSync("git", ["--git-dir", gitDir, "rev-list", "--all"], { encoding: "utf8" }),
      "",
    );
  } finally {
    await rm(sentinel, { recursive: true, force: true });
  }
});
