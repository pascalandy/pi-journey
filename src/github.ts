import { type Static, Type } from "typebox";
import { parse } from "./contracts.ts";
import type { OwnedResources } from "./runner.ts";

export const PullRequestSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  url: Type.String(),
  headRefOid: Type.String(),
  baseRefName: Type.String(),
  state: Type.String(),
});

export type PullRequest = Static<typeof PullRequestSchema>;

export class GitHub {
  private readonly resources: OwnedResources;
  private readonly repository: string;
  private nameWithOwner = "";
  constructor(resources: OwnedResources, repository: string) {
    this.resources = resources;
    this.repository = repository;
  }

  async command(args: string[], signal: AbortSignal): Promise<string> {
    if (args[0] === "pr") {
      if (!this.nameWithOwner) throw new Error("GitHub identity has not been bound");
      args = [...args, "--repo", this.nameWithOwner];
    }
    const result = await this.resources.command(["gh", ...args], this.repository, signal);
    if (result.code !== 0) throw new Error(`GitHub command failed: ${result.stderr.slice(-4000)}`);
    return result.stdout.trim();
  }

  async identity(signal: AbortSignal): Promise<string> {
    const origin = await this.resources.command(
      ["git", "config", "--get", "remote.origin.url"],
      this.repository,
      signal,
    );
    if (origin.code !== 0) throw new Error("Cannot bind GitHub origin");
    const value: unknown = JSON.parse(
      await this.command(["repo", "view", origin.stdout.trim(), "--json", "nameWithOwner"], signal),
    );
    this.nameWithOwner = parse(
      Type.Object({ nameWithOwner: Type.String({ pattern: "^[^/]+/[^/]+$" }) }),
      value,
      "GitHub repository",
    ).nameWithOwner;
    return this.nameWithOwner;
  }

  async view(number: number, signal: AbortSignal): Promise<PullRequest> {
    const fields = Object.keys(PullRequestSchema.properties).join(",");
    return parse(
      PullRequestSchema,
      JSON.parse(await this.command(["pr", "view", String(number), "--json", fields], signal)),
      "PR state",
    );
  }

  async find(branch: string, signal: AbortSignal): Promise<number | null> {
    const values = parse(
      Type.Array(Type.Object({ number: Type.Integer() })),
      JSON.parse(
        await this.command(
          ["pr", "list", "--head", branch, "--state", "all", "--json", "number"],
          signal,
        ),
      ),
      "PR lookup",
    );
    if (values.length > 1) throw new Error("Multiple PRs exist for the journey branch");
    return values[0]?.number ?? null;
  }
}
