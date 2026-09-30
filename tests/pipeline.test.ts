import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { waitFor } from "xstate";
import { defaultConfig, makePlan, makeRun, type Review, type Run } from "../src/contracts.ts";
import { Delivery } from "../src/delivery.ts";
import { hash } from "../src/files.ts";
import { Journal } from "../src/journal.ts";
import { createJourney } from "../src/journey.ts";
import { OwnedResources } from "../src/runner.ts";
import { repository } from "./helpers.ts";

const scenarios: readonly {
  deliveryMode: "single" | "stack";
  loseCreateResponse?: boolean;
  reviewDefect?: boolean;
  persistentDefect?: boolean;
  missingBranch?: boolean;
  missingNextBranch?: boolean;
  recoveryChange?: "head" | "remote";
}[] = [
  { deliveryMode: "single" },
  { deliveryMode: "stack" },
  { deliveryMode: "single", loseCreateResponse: true },
  { deliveryMode: "single", reviewDefect: true },
  { deliveryMode: "single", missingBranch: true },
  { deliveryMode: "single", recoveryChange: "head" },
  { deliveryMode: "single", recoveryChange: "remote" },
  { deliveryMode: "stack", missingNextBranch: true },
  { deliveryMode: "single", reviewDefect: true, persistentDefect: true },
];
for (const {
  deliveryMode,
  loseCreateResponse = false,
  reviewDefect = false,
  persistentDefect = false,
  missingBranch = false,
  missingNextBranch = false,
  recoveryChange,
} of scenarios) {
  test(`full ${deliveryMode}, lost create=${loseCreateResponse}, repair=${reviewDefect}, exhausted=${persistentDefect}, missing branch=${missingBranch || missingNextBranch}, changed=${recoveryChange}`, async () => {
    const fixture = await repository();
    const originalPath = process.env.PATH;
    class InterruptedBranch extends OwnedResources {
      interrupted = false;
      override command(...args: Parameters<OwnedResources["command"]>) {
        if (
          (missingBranch || (missingNextBranch && journal.current()?.unitIndex === 1)) &&
          !this.interrupted &&
          args[0][0] === "git" &&
          args[0][1] === "checkout" &&
          args[0][2] === "-b"
        ) {
          this.interrupted = true;
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "Interrupted before branch creation",
          });
        }
        return super.command(...args);
      }
    }
    const resources = new InterruptedBranch();
    const journal = new Journal(fixture.root);
    let actor: ReturnType<typeof createJourney> | undefined;
    const bare = join(journal.directory, "fixture-remote.git");
    const statePath = join(journal.directory, "github-state.json");
    try {
      await mkdir(journal.directory, { recursive: true });
      execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
      execFileSync("git", [
        "-C",
        fixture.root,
        "config",
        `url.${bare}.insteadOf`,
        "https://github.com/fixture/repository.git",
      ]);
      execFileSync("git", [
        "-C",
        fixture.root,
        "remote",
        "add",
        "origin",
        "https://github.com/fixture/repository.git",
      ]);
      execFileSync("git", ["-C", fixture.root, "push", "origin", "main"], { stdio: "ignore" });
      const bin = join(journal.directory, "bin");
      await mkdir(bin);
      const ghPath = join(bin, "gh");
      await writeFile(
        statePath,
        JSON.stringify({
          prs: [],
          commands: [],
          loseCreateResponse,
        }),
      );
      const simulator = `#!${process.execPath}
import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);const file=${JSON.stringify(statePath)};const bare=${JSON.stringify(bare)};
const state=JSON.parse(fs.readFileSync(file,'utf8'));state.commands.push(args);
const option=(name)=>args[args.indexOf(name)+1];
const oid=(branch)=>execFileSync('git',['--git-dir',bare,'rev-parse','refs/heads/'+branch],{encoding:'utf8'}).trim();
const view=(pr)=>({...pr,headRefOid:oid(pr.headRefName)});
let result={};
if(args[0]==='repo')result={nameWithOwner:args[2].replace('https://github.com/','').replace(/\\.git$/,'')};
else if(args[0]==='pr'&&args[1]==='list')result=state.prs.filter(pr=>pr.headRefName===option('--head')).map(pr=>({number:pr.number}));
else if(args[0]==='pr'&&args[1]==='create'){const number=state.prs.length+1;state.prs.push({number,url:'https://github.com/fixture/repository/pull/'+number,headRefName:option('--head'),baseRefName:option('--base')});result='created';}
else if(args[0]==='pr'&&args[1]==='view'){const pr=state.prs.find(pr=>pr.number===Number(args[2]));if(!pr)process.exit(1);result=view(pr);}
else {process.stderr.write('Unsupported simulator operation '+JSON.stringify(args));process.exit(2);}
if(args[0]==='pr'&&args[1]==='create'&&state.loseCreateResponse){state.loseCreateResponse=false;fs.writeFileSync(file,JSON.stringify(state));process.stderr.write('Server accepted PR; response was lost');process.exit(1);}
fs.writeFileSync(file,JSON.stringify(state));process.stdout.write(typeof result==='string'?result:JSON.stringify(result));
`;
      await writeFile(ghPath, simulator);
      await chmod(ghPath, 0o700);
      process.env.PATH = `${bin}:${originalPath}`;
      const skill = join(journal.directory, "fixture-skill.md");
      await writeFile(skill, "Review source and report evidence");
      const config = {
        ...defaultConfig(),
        secondPassSkill: skill,
        retrospectiveSkill: skill,
        ...(persistentDefect ? { maxRepairRounds: 1 } : {}),
      };
      const plan = makePlan(
        {
          goal: "Add two independent exports",
          body: "CMO: exports are absent. FMO: add each export. Premortem: scope drift.",
          units: [0, 1].map((index) => ({
            title: `feat: add export ${index}`,
            paths: [`src/unit-${index}.ts`],
            commitMessage: `feat: add export ${index}`,
          })),
          checks: [
            {
              name: "verify",
              argv: [process.execPath, "--version"],
              effects: "Reads version",
              timeoutMs: 1_000,
            },
          ],
          delivery: deliveryMode,
        },
        fixture.root,
      );
      const record = makeRun(plan, config);
      const originalBase = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"], {
        encoding: "utf8",
      }).trim();
      const writes: number[] = [];
      let writeAttempts = 0;
      const reviews: string[] = [];
      const review = (run: Run): Review => ({
        verdict: "pass",
        reviewedHead: run.units[run.unitIndex]?.head ?? "",
        summary: "Fixture source verified",
        findings: [],
      });
      const workers = {
        preflight: async () => {},
        write: async (run: Run) => {
          writeAttempts++;
          if (recoveryChange)
            return { kind: "blocked" as const, reason: "Pause before first file write" };
          writes.push(run.unitIndex);
          const path = `src/unit-${run.unitIndex}.ts`;
          const content = `export const unit${run.unitIndex} = ${run.repairRounds > 0 ? (persistentDefect ? 43 : 42) : run.unitIndex};\n`;
          await mkdir(dirname(join(fixture.root, path)), { recursive: true });
          await writeFile(join(fixture.root, path), content);
          const latest = journal.read(run.id);
          assert.ok(latest);
          latest.edits.push({
            unit: run.unitIndex,
            path,
            beforeHash: null,
            afterHash: hash(content),
            state: "confirmed",
          });
          journal.write(latest);
          return { kind: "complete" as const, summary: "Export added" };
        },
        audit: async (run: Run, task: string) => {
          if (task.startsWith("Read-only retrospective"))
            assert.equal(
              execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], {
                encoding: "utf8",
              }).trim(),
              run.units.at(-1)?.head,
            );
          return review(run);
        },
        review: async (run: Run, head: string) => {
          reviews.push(head);
          if (reviewDefect && run.unitIndex === 0) {
            const fixed = run.repairRounds > 0 && !persistentDefect;
            if (fixed)
              assert.equal(
                await readFile(join(fixture.root, "src/unit-0.ts"), "utf8"),
                "export const unit0 = 42;\n",
              );
            return {
              ...review(run),
              verdict: fixed ? ("pass" as const) : ("findings" as const),
              findings: [
                {
                  id: "R1",
                  priority: 1,
                  path: "src/unit-0.ts",
                  line: 1,
                  detail: "Expected 42",
                  disposition: fixed ? ("fixed" as const) : ("open" as const),
                  evidence: fixed ? "src/unit-0.ts now exports 42" : "",
                },
              ],
            };
          }
          return review(run);
        },
      };
      const delivery = new Delivery(fixture.root, journal, resources, workers, () => {});
      actor = createJourney({
        execute: (stage, run, signal) => delivery.execute(stage, run, signal),
        save: (run, phase) => journal.checkpoint(run, phase),
        drain: async (outcome) => {
          await resources.drain();
          const latest = journal.current();
          if (latest) journal.write({ ...latest, checkpoint: outcome });
          await journal.release();
        },
      });
      await journal.acquire(record.id);
      journal.write(record);
      actor.start();
      actor.send({ type: "implementation.requested", run: record });
      let final = await waitFor(
        actor,
        (snapshot) => snapshot.matches("delivered") || snapshot.matches("blocked"),
        { timeout: 90_000 },
      );
      if (persistentDefect) {
        assert.equal(final.value, "blocked");
        assert.equal(final.context.reason, "Repair budget exhausted");
        assert.equal(writeAttempts, 2);
        const recovered = journal.current();
        assert.ok(recovered);
        assert.equal(recovered.resumeStage, "review");
        resources.reset();
        actor.send({ type: "run.resumed", run: recovered, acceptRecoveredEdits: false });
        final = await waitFor(actor, (snapshot) => snapshot.matches("blocked"), {
          timeout: 90_000,
        });
        assert.equal(final.context.reason, "Repair budget exhausted");
        assert.equal(writeAttempts, 2, "resume does not admit another repair writer");
        assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).prs, []);
        return;
      }
      if (recoveryChange) {
        assert.equal(final.value, "blocked");
        if (recoveryChange === "head") {
          await writeFile(join(fixture.root, "unrelated"), "Unapproved committed content");
          execFileSync("git", ["-C", fixture.root, "add", "unrelated"]);
          execFileSync("git", ["-C", fixture.root, "commit", "-m", "unrelated external commit"], {
            stdio: "ignore",
          });
        } else
          execFileSync("git", [
            "-C",
            fixture.root,
            "remote",
            "set-url",
            "origin",
            "https://github.com/other/repository.git",
          ]);
        const recovered = journal.current();
        assert.ok(recovered);
        resources.reset();
        actor.send({ type: "run.resumed", run: recovered, acceptRecoveredEdits: false });
        final = await waitFor(actor, (snapshot) => snapshot.matches("blocked"), {
          timeout: 90_000,
        });
        assert.match(
          final.context.reason,
          recoveryChange === "head"
            ? /HEAD changed outside recorded operations/
            : /remote repository identity changed/,
        );
        assert.equal(writeAttempts, 1, "recovery cannot admit another writer");
        const remote = JSON.parse(await readFile(statePath, "utf8"));
        assert.deepEqual(remote.prs, []);
        if (recoveryChange === "head")
          assert.equal(
            await readFile(join(fixture.root, "unrelated"), "utf8"),
            "Unapproved committed content",
          );
        return;
      }
      if (loseCreateResponse || missingBranch || missingNextBranch) {
        assert.equal(final.value, "blocked");
        const recovered = journal.current();
        assert.ok(recovered);
        assert.equal(recovered.operations.at(-1)?.state, "uncertain");
        if (missingNextBranch) assert.equal(recovered.resumeStage, "work");
        resources.reset();
        actor.send({ type: "run.resumed", run: recovered, acceptRecoveredEdits: false });
        final = await waitFor(
          actor,
          (snapshot) => snapshot.matches("delivered") || snapshot.matches("blocked"),
          { timeout: 90_000 },
        );
      }
      assert.equal(final.value, "delivered", final.context.reason);
      assert.deepEqual(writes, reviewDefect ? [0, 0, 1] : [0, 1]);
      assert.equal(reviews.length, reviewDefect ? 3 : 2);
      assert.equal(journal.owned, false);
      const saved = journal.current();
      assert.ok(saved);
      assert.equal(saved.checkpoint, "delivered");
      assert.ok(saved.operations.every((operation) => operation.state === "confirmed"));
      const remote: {
        prs: { number: number; baseRefName: string; headRefName: string }[];
        commands: string[][];
      } = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(remote.prs.length, deliveryMode === "single" ? 1 : 2);
      assert.equal(
        remote.commands.filter((args) => args[0] === "pr" && args[1] === "create").length,
        remote.prs.length,
      );
      assert.equal(remote.prs[0]?.baseRefName, "main");
      if (deliveryMode === "stack")
        assert.equal(remote.prs[1]?.baseRefName, saved.units[0]?.branch);
      assert.equal(
        execFileSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).trim(),
        originalBase,
        "delivery leaves the base branch unmerged",
      );
      for (const pr of remote.prs) {
        const tree = execFileSync(
          "git",
          ["--git-dir", bare, "ls-tree", "-r", "--name-only", pr.headRefName],
          { encoding: "utf8" },
        );
        assert.ok(tree.includes("src/unit-0.ts"));
        if (pr === remote.prs.at(-1)) assert.ok(tree.includes("src/unit-1.ts"));
      }
    } finally {
      process.env.PATH = originalPath;
      actor?.stop();
      await resources.drain();
      await journal.release();
      await fixture.cleanup();
    }
  });
}
