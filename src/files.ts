import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { expectedUnitHead, type Run } from "./contracts.ts";
import type { Journal } from "./journal.ts";
import { approvedPaths, writablePath } from "./policy.ts";
import type { OwnedResources } from "./runner.ts";

export function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function fileHash(path: string): Promise<string | null> {
  try {
    return hash(await readFile(path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeOwnedFile(
  run: Run,
  journal: Journal,
  resources: OwnedResources,
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  journal.assertOwned(run.id);
  const repository = run.plan.repository;
  const paths = approvedPaths(run);
  const safe = await writablePath(repository, paths, path);
  const record = journal.read(run.id) ?? run;
  const rel = relative(repository, safe);
  const head = expectedUnitHead(record);
  if (!head) throw new Error("Owned write has no committed baseline");
  const git = async (...args: string[]) => {
    const result = await resources.command(["git", ...args], repository, signal);
    if (result.code !== 0) throw new Error("Cannot verify the owned write baseline");
    return result.stdout;
  };
  if (
    (await git("rev-parse", "HEAD")).trim() !== head ||
    (await git("branch", "--show-current")).trim() !== record.units[record.unitIndex]?.branch ||
    record.unitIndex !== run.unitIndex
  )
    throw new Error("Workflow branch or HEAD changed before owned write");
  const tracked = await git("--literal-pathspecs", "ls-tree", "-z", "--name-only", head, "--", rel);
  const baseline = tracked ? hash(await git("cat-file", "--filters", `${head}:${rel}`)) : null;
  const beforeHash = await fileHash(safe);
  const owned = record.edits.findLast((edit) => edit.path === rel && edit.state === "confirmed");
  if (beforeHash !== baseline && (!owned || beforeHash !== owned.afterHash)) {
    throw new Error(`External change at ${rel}; file preserved`);
  }
  const edit: Run["edits"][number] = {
    unit: run.unitIndex,
    path: rel,
    beforeHash,
    afterHash: hash(content),
    state: "prepared",
  };
  record.edits.push(edit);
  journal.write(record);
  signal.throwIfAborted();
  await mkdir(dirname(safe), { recursive: true });
  await writablePath(repository, paths, safe);
  if ((await fileHash(safe)) !== beforeHash)
    throw new Error(`External change during write at ${rel}; file preserved`);
  await writeFile(safe, content);
  edit.state = "confirmed";
  journal.write(record);
}
