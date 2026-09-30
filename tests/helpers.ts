import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, makePlan, makeRun } from "../src/contracts.ts";

// A Git hook exports GIT_DIR and GIT_WORK_TREE; fixtures and the code under test
// would otherwise write to the repository that runs the hook
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

export async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-mode-workflow-test-"));
  execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Workflow test"]);
  execFileSync("git", ["-C", root, "config", "commit.gpgSign", "false"]);
  execFileSync("git", ["-C", root, "config", "core.hooksPath", "/dev/null"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "chore: initialize fixture"], {
    stdio: "ignore",
  });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function run(root = "/fixture") {
  const plan = makePlan(
    {
      goal: "Add a scoped feature",
      body: "CMO: missing feature. FMO: add it and verify it.",
      units: [{ title: "Feature", paths: ["src"], commitMessage: "feat: add the feature" }],
      checks: [
        { name: "check", argv: ["node", "--version"], effects: "Read version", timeoutMs: 1_000 },
      ],
      delivery: "single",
    },
    root,
  );
  return makeRun(plan, defaultConfig());
}
