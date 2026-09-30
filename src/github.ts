import { type Static, Type } from "typebox";
import { parse } from "./contracts.ts";
import type { OwnedResources } from "./runner.ts";

const string = Type.String();
const CheckSchema = Type.Object({
  __typename: string,
  name: Type.Optional(string),
  context: Type.Optional(string),
  status: Type.Optional(string),
  state: Type.Optional(string),
  conclusion: Type.Optional(string),
});
export const PullRequestSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  url: string,
  headRefOid: string,
  baseRefOid: string,
  headRefName: string,
  baseRefName: string,
  state: string,
  isDraft: Type.Boolean(),
  mergeable: string,
  mergeStateStatus: string,
  reviewDecision: Type.Union([string, Type.Null()]),
  statusCheckRollup: Type.Union([Type.Array(CheckSchema), Type.Null()]),
});
const ThreadsSchema = Type.Object({
  data: Type.Object({
    repository: Type.Object({
      pullRequest: Type.Object({
        autoMergeRequest: Type.Union([Type.Object({ enabledAt: string }), Type.Null()]),
        mergeQueueEntry: Type.Union([Type.Object({ id: string }), Type.Null()]),
        reviewThreads: Type.Object({
          pageInfo: Type.Object({ hasNextPage: Type.Boolean() }),
          nodes: Type.Array(
            Type.Object({
              id: string,
              isResolved: Type.Boolean(),
              path: string,
              line: Type.Union([Type.Integer(), Type.Null()]),
              comments: Type.Object({
                nodes: Type.Array(Type.Object({ body: string, url: string })),
              }),
            }),
          ),
        }),
        reviews: Type.Object({
          pageInfo: Type.Object({ hasPreviousPage: Type.Boolean() }),
          nodes: Type.Array(
            Type.Object({
              author: Type.Union([Type.Object({ login: string }), Type.Null()]),
              state: string,
              commit: Type.Union([Type.Object({ oid: string }), Type.Null()]),
            }),
          ),
        }),
      }),
    }),
  }),
});

export type PullRequest = Static<typeof PullRequestSchema>;
export type Threads = Static<typeof ThreadsSchema>["data"]["repository"]["pullRequest"];

export function checksReady(pr: PullRequest, required: readonly string[]): boolean {
  const checks = pr.statusCheckRollup ?? [];
  return (
    required.every((name) =>
      checks.some(
        (check) =>
          (check.name ?? check.context) === name &&
          (check.__typename === "CheckRun"
            ? check.status === "COMPLETED" && check.conclusion === "SUCCESS"
            : check.state === "SUCCESS"),
      ),
    ) &&
    checks.every((check) =>
      check.__typename === "CheckRun"
        ? check.status === "COMPLETED" &&
          ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion ?? "")
        : check.state === "SUCCESS",
    )
  );
}

export function reviewersReady(
  threads: Threads,
  head: string,
  required: readonly string[],
): boolean {
  return (
    required.every((login) => {
      const latest = threads.reviews.nodes
        .filter((review) => review.author?.login === login)
        .at(-1);
      return latest?.state === "APPROVED" && latest.commit?.oid === head;
    }) &&
    !threads.reviews.nodes.some(
      (review, index, all) =>
        review.state === "CHANGES_REQUESTED" &&
        !all
          .slice(index + 1)
          .some(
            (later) =>
              later.author?.login === review.author?.login &&
              ["APPROVED", "DISMISSED"].includes(later.state),
          ),
    )
  );
}

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
    if (values.length > 1) throw new Error("Multiple PRs exist for the workflow branch");
    return values[0]?.number ?? null;
  }

  async threads(identity: string, number: number, signal: AbortSignal): Promise<Threads> {
    const [owner, name] = identity.split("/");
    if (!owner || !name) throw new Error("Invalid GitHub identity");
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){autoMergeRequest{enabledAt} mergeQueueEntry{id} reviewThreads(first:100){pageInfo{hasNextPage}nodes{
        id isResolved path line comments(first:1){nodes{body url}}}}
        reviews(last:100){pageInfo{hasPreviousPage}nodes{author{login}state commit{oid}}}}}}`;
    const response = parse(
      ThreadsSchema,
      JSON.parse(
        await this.command(
          [
            "api",
            "graphql",
            "-f",
            `query=${query}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${number}`,
          ],
          signal,
        ),
      ),
      "review threads",
    ).data.repository.pullRequest;
    if (response.reviewThreads.pageInfo.hasNextPage || response.reviews.pageInfo.hasPreviousPage) {
      throw new Error(
        "Review history exceeds the supported page; explicit reconciliation is required",
      );
    }
    return response;
  }

  async protectedChecks(identity: string, base: string, signal: AbortSignal): Promise<string[]> {
    const policy = parse(
      Type.Object({
        required_status_checks: Type.Union([
          Type.Object({
            strict: Type.Boolean(),
            contexts: Type.Array(string),
            checks: Type.Array(Type.Object({ context: string })),
          }),
          Type.Null(),
        ]),
        required_pull_request_reviews: Type.Union([
          Type.Object({
            required_approving_review_count: Type.Integer(),
            dismiss_stale_reviews: Type.Boolean(),
          }),
          Type.Null(),
        ]),
        enforce_admins: Type.Object({ enabled: Type.Boolean() }),
      }),
      JSON.parse(
        await this.command(
          ["api", `repos/${identity}/branches/${encodeURIComponent(base)}/protection`],
          signal,
        ),
      ),
      "server merge protection",
    );
    if (
      !policy.required_status_checks?.strict ||
      !policy.required_pull_request_reviews?.dismiss_stale_reviews ||
      policy.required_pull_request_reviews.required_approving_review_count < 1 ||
      !policy.enforce_admins.enabled
    ) {
      throw new Error(
        "Auto-merge requires strict protected checks, stale-review dismissal, approvals, and no admin bypass",
      );
    }
    const checks = [
      ...new Set([
        ...policy.required_status_checks.contexts,
        ...policy.required_status_checks.checks.map((check) => check.context),
      ]),
    ];
    if (checks.length === 0) throw new Error("Auto-merge requires server-enforced checks");
    return checks;
  }

  async resolveThread(id: string, signal: AbortSignal): Promise<void> {
    const query =
      "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
    const response = parse(
      Type.Object({
        data: Type.Object({
          resolveReviewThread: Type.Object({
            thread: Type.Object({ id: string, isResolved: Type.Boolean() }),
          }),
        }),
      }),
      JSON.parse(
        await this.command(["api", "graphql", "-f", `query=${query}`, "-f", `id=${id}`], signal),
      ),
      "thread resolution",
    );
    if (
      response.data.resolveReviewThread.thread.id !== id ||
      !response.data.resolveReviewThread.thread.isResolved
    ) {
      throw new Error("Thread resolution was not confirmed");
    }
  }
}
