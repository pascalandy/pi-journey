import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PLANNING_FOOTER = "— We are in the Planning Phase";
export const PLANNING_TOOLS = ["read", "grep", "find", "ls", "workflow_plan"];

export function planningAdmission(name: string): { block: true; reason: string } | undefined {
  if (PLANNING_TOOLS.includes(name)) return undefined;
  return { block: true, reason: "Planning permits investigation and plan recording only" };
}

export function appendPlanningFooter(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(PLANNING_FOOTER) ? trimmed : `${trimmed}\n\n${PLANNING_FOOTER}`;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function metadata(path: string): boolean {
  return path.split(sep).includes(".git") || path === ".pi/mode-workflow.json";
}

export function scopeAllows(paths: readonly string[], path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (
    isAbsolute(path) ||
    normalized.split("/").some((part) => part === ".." || part === ".git") ||
    normalized === ".pi/mode-workflow.json"
  ) {
    return false;
  }
  return paths.some((scope) => {
    const prefix = scope.replaceAll("\\", "/").replace(/\/+$/, "");
    return prefix === "." || normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export function validateScope(paths: readonly string[]): void {
  if (
    paths.some(
      (path) =>
        !path ||
        isAbsolute(path) ||
        path
          .replaceAll("\\", "/")
          .split("/")
          .some((part) => part === ".." || part === ".git"),
    )
  ) {
    throw new Error("Writable scope must contain repository-relative paths");
  }
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
