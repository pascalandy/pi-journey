import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { waitFor } from "xstate";
import { defaultConfig, makePlan, makeRun, type Review, type Run } from "../src/contracts.ts";
import { Delivery } from "../src/delivery.ts";
import { Journal } from "../src/journal.ts";
import { hash, OwnedResources } from "../src/runner.ts";
import { createWorkflow } from "../src/workflow.ts";
import { repository } from "./helpers.ts";

for (const { deliveryMode, loseCreateResponse } of [
  { deliveryMode: "single", loseCreateResponse: false },
  { deliveryMode: "stack", loseCreateResponse: false },
  { deliveryMode: "single", loseCreateResponse: true },
] as const) {
  test(`full ${deliveryMode} pipeline publishes regular PRs${loseCreateResponse ? " after a lost creation response" : ""} and drains ownership`, async () => {
    const fixture = await repository();
    const originalPath = process.env.PATH;
    const resources = new OwnedResources();
    const journal = new Journal(fixture.root);
    let actor: ReturnType<typeof createWorkflow> | undefined;
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
      await writeFile(statePath, JSON.stringify({ prs: [], commands: [], loseCreateResponse }));
      const simulator = `#!${process.execPath}
import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);const file=${JSON.stringify(statePath)};const bare=${JSON.stringify(bare)};
const state=JSON.parse(fs.readFileSync(file,'utf8'));state.commands.push(args);
const option=(name)=>args[args.indexOf(name)+1];
const oid=(branch)=>execFileSync('git',['--git-dir',bare,'rev-parse','refs/heads/'+branch],{encoding:'utf8'}).trim();
const view=(pr)=>({...pr,headRefOid:oid(pr.headRefName),baseRefOid:oid(pr.baseRefName),state:'OPEN',isDraft:false,
mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'APPROVED',statusCheckRollup:[{__typename:'CheckRun',name:'verify',status:'COMPLETED',conclusion:'SUCCESS'}]});
let result={};
if(args[0]==='repo')result={nameWithOwner:'fixture/repository'};
else if(args[0]==='pr'&&args[1]==='list')result=state.prs.filter(pr=>pr.headRefName===option('--head')).map(pr=>({number:pr.number}));
else if(args[0]==='pr'&&args[1]==='create'){const number=state.prs.length+1;state.prs.push({number,url:'https://github.com/fixture/repository/pull/'+number,headRefName:option('--head'),baseRefName:option('--base')});result='created';}
else if(args[0]==='pr'&&args[1]==='view'){const pr=state.prs.find(pr=>pr.number===Number(args[2]));if(!pr)process.exit(1);result=view(pr);}
else if(args[0]==='api'&&args[1]==='graphql')result={data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]},reviews:{pageInfo:{hasPreviousPage:false},nodes:[]}}}}};
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
        requiredChecks: ["verify"],
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
      const record = makeRun(plan, config, { executeChecks: true, merge: false });
      const writes: number[] = [];
      const reviews: string[] = [];
      const review = (run: Run): Review => ({
        verdict: "pass",
        reviewedHead: run.units[run.unitIndex]?.head ?? "",
        summary: "Fixture source verified",
        findings: [],
      });
      const workers = {
        write: async (run: Run) => {
          writes.push(run.unitIndex);
          const path = `src/unit-${run.unitIndex}.ts`;
          const content = `export const unit${run.unitIndex} = ${run.unitIndex};\n`;
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
        audit: async (run: Run) => review(run),
        review: async (run: Run, head: string) => {
          reviews.push(head);
          return review(run);
        },
      };
      const delivery = new Delivery(fixture.root, journal, resources, workers, () => {});
      actor = createWorkflow({
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
        { timeout: 20_000 },
      );
      if (loseCreateResponse) {
        assert.equal(final.value, "blocked");
        const recovered = journal.current();
        assert.ok(recovered);
        assert.equal(recovered.operations.at(-1)?.state, "uncertain");
        resources.reset();
        actor.send({ type: "run.resumed", run: recovered, acceptRecoveredEdits: false });
        final = await waitFor(
          actor,
          (snapshot) => snapshot.matches("delivered") || snapshot.matches("blocked"),
          { timeout: 20_000 },
        );
      }
      assert.equal(final.value, "delivered", final.context.reason);
      assert.deepEqual(writes, [0, 1]);
      assert.equal(reviews.length, 2);
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
        remote.commands.some((args) => args[0] === "pr" && args[1] === "merge"),
        false,
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
