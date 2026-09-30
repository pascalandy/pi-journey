import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { Run } from "./contracts.ts";

export function approvedPaths(run: Run): string[] {
  return run.plan.delivery === "single" && run.units.every((unit) => unit.head !== null)
    ? run.plan.units.flatMap((unit) => unit.paths)
    : (run.plan.units[run.unitIndex]?.paths ?? []);
}

const READ_TOOLS = ["read", "grep", "find", "ls"];

export function runAdmission(name: string): { block: true; reason: string } | undefined {
  if (READ_TOOLS.includes(name)) return undefined;
  return { block: true, reason: "An active run owns this repository; use /journey stop first" };
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function metadata(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.split(sep).includes(".git") || normalized === ".pi/journey.json";
}

export function canonicalRepoPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("Writable scope must contain repository-relative paths");
  }
  const normalized = posix.normalize(path).replace(/\/+$/, "") || ".";
  if (metadata(normalized)) throw new Error("Writable scope cannot include repository metadata");
  return normalized;
}

export function scopeAllows(paths: readonly string[], path: string): boolean {
  try {
    const normalized = canonicalRepoPath(path);
    return paths.some((scope) => {
      const prefix = canonicalRepoPath(scope);
      return prefix === "." || normalized === prefix || normalized.startsWith(`${prefix}/`);
    });
  } catch {
    return false;
  }
}

export function validateScope(paths: readonly string[]): void {
  for (const path of paths) canonicalRepoPath(path);
}

export async function writablePath(
  repository: string,
  paths: readonly string[],
  requested: string,
): Promise<string> {
  const root = await realpath(repository);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (!inside(root, target) || metadata(rel) || !scopeAllows(paths, rel)) {
    throw new Error("Write is outside the approved repository scope");
  }
  let ancestor = target;
  let tail = "";
  for (;;) {
    try {
      const canonical = await realpath(ancestor);
      const resolved = resolve(canonical, tail);
      const canonicalRelative = relative(root, resolved);
      if (
        !inside(root, resolved) ||
        metadata(canonicalRelative) ||
        !scopeAllows(paths, canonicalRelative)
      ) {
        throw new Error("Write follows a path outside the approved scope");
      }
      try {
        const stat = await lstat(resolved);
        if (stat.isFile() && stat.nlink > 1)
          throw new Error("Writing hard-linked files is unsupported");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return target;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        if ((await lstat(ancestor)).isSymbolicLink())
          throw new Error("Write follows a dangling symlink outside canonical scope");
      } catch (statError) {
        if (!(statError instanceof Error && "code" in statError && statError.code === "ENOENT"))
          throw statError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      tail = relative(parent, target);
      ancestor = parent;
    }
  }
}

export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      signal.throwIfAborted();
      return operation();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
