import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import { canonicalRepoPath } from "./policy.ts";

const text = Type.String({ minLength: 1, maxLength: 200_000 });
const sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const uuid = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
const closed = { additionalProperties: false };

export const CheckSchema = Type.Object(
  {
    name: text,
    argv: Type.Array(Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" }), {
      minItems: 1,
      maxItems: 40,
    }),
    effects: text,
    timeoutMs: Type.Integer({ minimum: 1_000, maximum: 900_000 }),
  },
  closed,
);

export const PlanInputSchema = Type.Object(
  {
    goal: text,
    body: text,
    units: Type.Array(
      Type.Object(
        {
          title: text,
          paths: Type.Array(text, { minItems: 1, maxItems: 50 }),
          commitMessage: Type.String({ minLength: 1, maxLength: 200 }),
        },
        closed,
      ),
      { minItems: 1, maxItems: 12 },
    ),
    checks: Type.Array(CheckSchema, { minItems: 1, maxItems: 20 }),
    delivery: Type.Union([Type.Literal("single"), Type.Literal("stack")]),
  },
  closed,
);

export const PlanSchema = Type.Object(
  { ...PlanInputSchema.properties, id: uuid, digest: text, repository: text },
  closed,
);

export const ConfigSchema = Type.Object(
  {
    baseBranch: text,
    secondPassSkill: text,
    retrospectiveSkill: text,
    reviewerBinary: text,
    workerTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    reviewerTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    maxRepairRounds: Type.Integer({ minimum: 0, maximum: 10 }),
    pollIntervalMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    monitorTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    requiredChecks: Type.Array(text, { maxItems: 30 }),
    requiredReviewers: Type.Array(text, { maxItems: 30 }),
  },
  closed,
);

export const FindingSchema = Type.Object(
  {
    id: text,
    priority: Type.Integer({ minimum: 0, maximum: 3 }),
    path: text,
    line: Type.Integer({ minimum: 1 }),
    detail: text,
    disposition: Type.Union([
      Type.Literal("open"),
      Type.Literal("fixed"),
      Type.Literal("dismissed"),
    ]),
    evidence: Type.String({ maxLength: 200_000 }),
  },
  closed,
);

export const ReviewSchema = Type.Object(
  {
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("findings"), Type.Literal("blocked")]),
    reviewedHead: sha,
    summary: text,
    findings: Type.Array(FindingSchema, { maxItems: 100 }),
  },
  closed,
);

export const WorkerResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("complete"), summary: text }, closed),
  Type.Object({ kind: Type.Literal("blocked"), reason: text }, closed),
]);

export const StageSchema = Type.Union([
  Type.Literal("preflight"),
  Type.Literal("work"),
  Type.Literal("commit"),
  Type.Literal("checks"),
  Type.Literal("secondPass"),
  Type.Literal("review"),
  Type.Literal("repair"),
  Type.Literal("publish"),
  Type.Literal("monitor"),
  Type.Literal("merge"),
  Type.Literal("prepare"),
  Type.Literal("retrospective"),
]);

export const EvidenceSchema = Type.Object(
  {
    head: sha,
    passed: Type.Boolean(),
    detail: text,
    at: Type.String(),
  },
  closed,
);

export const UnitSchema = Type.Object(
  {
    branch: text,
    baseBranch: text,
    baseHead: Type.Union([sha, Type.Null()]),
    head: Type.Union([sha, Type.Null()]),
    checks: Type.Union([EvidenceSchema, Type.Null()]),
    secondPass: Type.Union([EvidenceSchema, Type.Null()]),
    review: Type.Union([EvidenceSchema, Type.Null()]),
    pr: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    url: Type.Union([text, Type.Null()]),
    merged: Type.Boolean(),
  },
  closed,
);

export const OperationSchema = Type.Object(
  {
    id: text,
    kind: Type.Union([
      Type.Literal("branch"),
      Type.Literal("commit"),
      Type.Literal("push"),
      Type.Literal("pr"),
      Type.Literal("retarget"),
      Type.Literal("merge"),
      Type.Literal("resolve"),
    ]),
    unit: Type.Integer({ minimum: 0 }),
    expectedHead: Type.Union([sha, Type.Null()]),
    state: Type.Union([
      Type.Literal("prepared"),
      Type.Literal("confirmed"),
      Type.Literal("uncertain"),
    ]),
    detail: Type.String(),
  },
  closed,
);

export const RunSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: uuid,
    plan: PlanSchema,
    config: ConfigSchema,
    grant: Type.Object(
      {
        planDigest: text,
        executeChecks: Type.Boolean(),
        publish: Type.Boolean(),
        merge: Type.Boolean(),
      },
      closed,
    ),
    startHead: Type.Union([sha, Type.Null()]),
    remoteIdentity: Type.Union([text, Type.Null()]),
    originUrl: Type.Union([text, Type.Null()]),
    units: Type.Array(UnitSchema, { minItems: 1, maxItems: 12 }),
    unitIndex: Type.Integer({ minimum: 0 }),
    repairRounds: Type.Integer({ minimum: 0 }),
    repairReason: Type.String(),
    findings: Type.Array(FindingSchema),
    operations: Type.Array(OperationSchema),
    edits: Type.Array(
      Type.Object(
        {
          unit: Type.Integer({ minimum: 0 }),
          path: text,
          beforeHash: Type.Union([text, Type.Null()]),
          afterHash: text,
          state: Type.Union([Type.Literal("prepared"), Type.Literal("confirmed")]),
        },
        closed,
      ),
    ),
    checkpoint: Type.String(),
    resumeStage: StageSchema,
    acceptRecoveredEdits: Type.Boolean(),
    summary: Type.String(),
  },
  closed,
);

export type PlanInput = Static<typeof PlanInputSchema>;
export type Plan = Static<typeof PlanSchema>;
export type Config = Static<typeof ConfigSchema>;
export type Run = Static<typeof RunSchema>;
export type Finding = Static<typeof FindingSchema>;
export type Review = Static<typeof ReviewSchema>;
export type WorkerResult = Static<typeof WorkerResultSchema>;
export type Stage = Static<typeof StageSchema>;

export type StepResult =
  | { kind: "passed"; run: Run; next?: Exclude<Stage, "preflight"> }
  | { kind: "repair"; run: Run; reason: string }
  | { kind: "blocked"; run: Run; reason: string };

export function parse<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (!Check(schema, value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function defaultConfig(): Config {
  return {
    baseBranch: "main",
    secondPassSkill: join(homedir(), ".codex/skills/2nd-pass/SKILL.md"),
    retrospectiveSkill: join(homedir(), ".codex/skills/pa-retro/SKILL.md"),
    reviewerBinary: "codex",
    workerTimeoutMs: 900_000,
    reviewerTimeoutMs: 900_000,
    maxRepairRounds: 3,
    pollIntervalMs: 10_000,
    monitorTimeoutMs: 900_000,
    requiredChecks: [],
    requiredReviewers: [],
  };
}

export function makePlan(input: PlanInput, repository: string): Plan {
  const normalized = {
    goal: input.goal,
    body: input.body,
    units: input.units.map((unit) => ({
      title: unit.title,
      paths: unit.paths.map(canonicalRepoPath),
      commitMessage: unit.commitMessage,
    })),
    checks: input.checks.map((check) => ({
      name: check.name,
      argv: check.argv,
      effects: check.effects,
      timeoutMs: check.timeoutMs,
    })),
    delivery: input.delivery,
  };
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return { ...normalized, repository, id: randomUUID(), digest };
}

export function makeRun(
  plan: Plan,
  config: Config,
  grant: { executeChecks: boolean; merge: boolean },
): Run {
  const id = randomUUID();
  return {
    version: 1,
    id,
    plan,
    config,
    grant: { ...grant, publish: true, planDigest: plan.digest },
    startHead: null,
    remoteIdentity: null,
    originUrl: null,
    units: plan.units.map((_unit, index) => ({
      branch: `workflow/${id.slice(0, 8)}${plan.delivery === "stack" ? `/${index + 1}` : ""}`,
      baseBranch:
        plan.delivery === "stack" && index > 0
          ? `workflow/${id.slice(0, 8)}/${index}`
          : config.baseBranch,
      baseHead: null,
      head: null,
      checks: null,
      secondPass: null,
      review: null,
      pr: null,
      url: null,
      merged: false,
    })),
    unitIndex: 0,
    repairRounds: 0,
    repairReason: "",
    findings: [],
    operations: [],
    edits: [],
    checkpoint: "preflight",
    resumeStage: "work",
    acceptRecoveredEdits: false,
    summary: "",
  };
}

export function parseRun(value: unknown): Run {
  const run = parse(RunSchema, value, "workflow record");
  if (run.units.length !== run.plan.units.length || run.unitIndex >= run.units.length) {
    throw new Error("Workflow record has inconsistent units");
  }
  if (run.grant.planDigest !== run.plan.digest) throw new Error("Workflow approval is stale");
  if (makePlan(run.plan, run.plan.repository).digest !== run.plan.digest) {
    throw new Error("Accepted plan content changed");
  }
  if (
    run.operations.some((operation) => operation.unit >= run.units.length) ||
    run.edits.some((edit) => edit.unit >= run.units.length)
  ) {
    throw new Error("Workflow record has an invalid operation unit");
  }
  for (const [index, unit] of run.units.entries()) {
    const expected = `workflow/${run.id.slice(0, 8)}${run.plan.delivery === "stack" ? `/${index + 1}` : ""}`;
    if (unit.branch !== expected) throw new Error("Workflow branch identity changed");
  }
  return run;
}

export function evidence(head: string, passed: boolean, detail: string) {
  return { head, passed, detail, at: new Date().toISOString() };
}

export function expectedUnitHead(run: Run): string | null {
  const unit = run.units[run.unitIndex];
  if (!unit) throw new Error("Workflow unit is absent");
  return run.plan.delivery === "single" && run.unitIndex > 0 && unit.head === null
    ? (run.units[run.unitIndex - 1]?.head ?? null)
    : (unit.head ?? unit.baseHead ?? run.startHead);
}

export function isCurrentEvidence(unit: Static<typeof UnitSchema>): boolean {
  return (
    unit.head !== null &&
    [unit.checks, unit.secondPass, unit.review].every(
      (item) => item?.passed && item.head === unit.head,
    )
  );
}
