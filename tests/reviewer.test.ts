import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "../src/journal.ts";
import { OwnedResources, Workers } from "../src/runner.ts";
import { repository, run } from "./helpers.ts";

for (const outcome of ["pass", "model", "empty", "malformed", "stale"] as const) {
  test(`independent reviewer process protocol handles ${outcome}`, async () => {
    const fixture = await repository();
    const resources = new OwnedResources();
    try {
      const journal = new Journal(fixture.root);
      await mkdir(journal.directory, { recursive: true });
      const head = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const executable = join(journal.directory, "reviewer.mjs");
      const result = {
        verdict: "pass",
        reviewedHead: outcome === "stale" ? "0".repeat(40) : head,
        summary: "Source inspected",
        findings: [],
      };
      await writeFile(
        executable,
        `#!${process.execPath}
import assert from 'node:assert/strict';import fs from 'node:fs';
const argv=process.argv.slice(2);assert.equal(argv[argv.indexOf('--sandbox')+1],'read-only');assert.equal(argv[argv.indexOf('-m')+1],'gpt-6-astra');
process.stderr.write(${JSON.stringify(`model: ${outcome === "model" ? "another-model" : "gpt-6-astra"}\nsandbox: read-only\napproval: never\nreasoning effort: high\n`)});
fs.writeFileSync(argv[argv.indexOf('-o')+1],${JSON.stringify(outcome === "empty" ? "" : outcome === "malformed" ? "{}" : JSON.stringify(result))});
`,
      );
      await chmod(executable, 0o700);
      const record = run(fixture.root);
      record.config.reviewerBinary = executable;
      const worker = new Workers(fixture.root, journal, resources, () => {
        throw new Error("Review must not use the writer model");
      });
      let displayed: string[] = [];
      const review = worker.review(record, head, head, new AbortController().signal, (argv) => {
        displayed = argv;
      });
      if (outcome === "pass") assert.deepEqual(await review, result);
      else
        await assert.rejects(
          review,
          outcome === "model"
            ? /runtime metadata/
            : outcome === "malformed"
              ? /Invalid independent review/
              : outcome === "stale"
                ? /another commit/
                : /Unexpected end/,
        );
      assert.ok(displayed.includes("--sandbox"));
      assert.ok(displayed.includes("read-only"));
    } finally {
      await resources.drain();
      await fixture.cleanup();
    }
  });
}
