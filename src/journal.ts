import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { parse, parseRun, type Run, StageSchema } from "./contracts.ts";

const OwnerSchema = Type.Object(
  {
    pid: Type.Integer({ minimum: 1 }),
    host: Type.String(),
    nonce: Type.String(),
    runId: Type.String(),
    released: Type.Boolean(),
  },
  { additionalProperties: false },
);
const PointerSchema = Type.Object(
  { id: Type.String({ pattern: "^[a-f0-9-]{36}$" }) },
  { additionalProperties: false },
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function atomic(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export class Journal {
  readonly directory: string;
  private readonly repository: string;
  private releaseLock: (() => Promise<void>) | null = null;
  private owner: ReturnType<typeof this.readOwner> = null;
  private compromised: Error | null = null;
  private readonly onLost: (error: Error) => void;

  constructor(repository: string, onLost: (error: Error) => void = () => {}) {
    this.onLost = onLost;
    this.repository = realpathSync(repository);
    const gitDirectory = execFileSync(
      "git",
      ["-C", repository, "rev-parse", "--absolute-git-dir"],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    ).trim();
    this.directory = resolve(gitDirectory, "pi-mode-workflow");
  }

  get owned(): boolean {
    return this.releaseLock !== null && this.compromised === null;
  }

  private ownerPath(): string {
    return join(this.directory, "owner.json");
  }

  private readOwner() {
    const path = this.ownerPath();
    if (!existsSync(path) || readFileSync(path, "utf8") === "") return null;
    return parse(OwnerSchema, JSON.parse(readFileSync(path, "utf8")), "repository owner");
  }

  async acquire(runId: string): Promise<void> {
    if (this.owned) {
      if (this.owner?.runId !== runId) throw new Error("This coordinator already owns another run");
      return;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink())
      throw new Error("Journal directory is a symlink");
    mkdirSync(join(this.directory, "runs"), { recursive: true, mode: 0o700 });
    if (!existsSync(this.ownerPath()))
      writeFileSync(this.ownerPath(), "", { flag: "wx", mode: 0o600 });
    if (!lstatSync(this.ownerPath()).isFile() || lstatSync(this.ownerPath()).isSymbolicLink()) {
      throw new Error("Repository owner record is not a regular file");
    }
    const prior = this.readOwner();
    if (prior !== null && !prior.released && (prior.host !== hostname() || alive(prior.pid))) {
      throw new Error(`Repository is owned by run ${prior.runId} in process ${prior.pid}`);
    }
    this.compromised = null;
    this.releaseLock = await lockfile.lock(this.ownerPath(), {
      realpath: false,
      retries: 0,
      stale: 30_000,
      update: 10_000,
      onCompromised: (error) => {
        this.compromised = error;
        this.onLost(error);
      },
    });
    this.owner = {
      pid: process.pid,
      host: hostname(),
      nonce: randomUUID(),
      runId,
      released: false,
    };
    atomic(this.ownerPath(), this.owner);
  }

  assertOwned(runId: string): void {
    if (!this.owned || this.owner?.runId !== runId)
      throw new Error("Repository ownership is absent");
    const current = this.readOwner();
    if (current?.nonce !== this.owner.nonce || current.released) {
      throw new Error("Repository ownership changed");
    }
  }

  write(run: Run): void {
    this.assertOwned(run.id);
    parseRun(run);
    if (run.plan.repository !== this.repository)
      throw new Error("Workflow repository identity changed");
    atomic(join(this.directory, "runs", `${run.id}.json`), run);
    atomic(join(this.directory, "active.json"), { id: run.id });
  }

  checkpoint(run: Run, phase: string): void {
    if (!this.owned || this.owner?.runId !== run.id) return;
    const latest = this.read(run.id) ?? run;
    this.write({
      ...latest,
      checkpoint: phase,
      resumeStage: [
        "work",
        "commit",
        "checks",
        "secondPass",
        "review",
        "repair",
        "publish",
        "retrospective",
      ].includes(phase)
        ? parse(StageSchema, phase, "resume stage")
        : latest.resumeStage,
      repairRounds: run.repairRounds,
      repairReason: run.repairReason,
      acceptRecoveredEdits: run.acceptRecoveredEdits,
    });
  }

  read(id: string): Run | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run identity");
    const path = join(this.directory, "runs", `${id}.json`);
    if (!existsSync(path)) return null;
    const run = parseRun(JSON.parse(readFileSync(path, "utf8")));
    if (run.id !== id || run.plan.repository !== this.repository) {
      throw new Error("Workflow journal identity changed");
    }
    return run;
  }

  current(): Run | null {
    const path = join(this.directory, "active.json");
    if (!existsSync(path)) return null;
    const pointer = parse(
      PointerSchema,
      JSON.parse(readFileSync(path, "utf8")),
      "active run pointer",
    );
    const run = this.read(pointer.id);
    if (run === null)
      throw new Error(
        "Active workflow record is missing; reconcile it before starting another run",
      );
    return run;
  }

  async release(): Promise<void> {
    const release = this.releaseLock;
    if (release === null) return;
    const owner = this.readOwner();
    if (this.owner !== null && owner?.nonce === this.owner.nonce) {
      atomic(this.ownerPath(), { ...owner, released: true });
    }
    await release();
    this.releaseLock = null;
    this.owner = null;
  }
}
