import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Run } from "../src/contracts.ts";
import { writeOwnedFile } from "../src/files.ts";
import { Journal } from "../src/journal.ts";
import { OwnedResources } from "../src/runner.ts";
import { repository, run } from "./helpers.ts";

test("owned writes preserve external edits and accept only committed or owned preimages", async () => {
  const fixture = await repository();
  let racePreparedWrite = false;
  const journal = new (class extends Journal {
    override write(record: Run) {
      super.write(record);
      if (racePreparedWrite && record.edits.at(-1)?.state === "prepared") {
        racePreparedWrite = false;
        writeFileSync(join(fixture.root, "src/value.ts"), "Human during prepared write\n");
      }
    }
  })(fixture.root);
  const resources = new OwnedResources();
  try {
    const record = run(fixture.root);
    const unit = record.units[0];
    assert.ok(unit);
    execFileSync("git", ["-C", fixture.root, "checkout", "-b", unit.branch], { stdio: "ignore" });
    await mkdir(join(fixture.root, "src"));
    const path = join(fixture.root, "src/value.ts");
    await writeFile(path, "Committed content\n");
    execFileSync("git", ["-C", fixture.root, "add", "src/value.ts"]);
    execFileSync("git", ["-C", fixture.root, "commit", "-m", "Add baseline"], { stdio: "ignore" });
    unit.head = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await journal.acquire(record.id);
    journal.write(record);
    const signal = new AbortController().signal;
    await writeFile(path, "Human content\n");
    await assert.rejects(
      writeOwnedFile(record, journal, resources, "src/value.ts", "Replacement\n", signal),
      /External change/,
    );
    assert.equal(await readFile(path, "utf8"), "Human content\n");
    assert.deepEqual(journal.current()?.edits, []);
    await writeFile(path, "Committed content\n");
    await writeOwnedFile(record, journal, resources, "src/value.ts", "First owned edit\n", signal);
    await writeOwnedFile(record, journal, resources, "src/value.ts", "Second owned edit\n", signal);
    assert.equal(await readFile(path, "utf8"), "Second owned edit\n");
    racePreparedWrite = true;
    await assert.rejects(
      writeOwnedFile(record, journal, resources, "src/value.ts", "Third edit\n", signal),
      /External change during write/,
    );
    assert.equal(await readFile(path, "utf8"), "Human during prepared write\n");
    const untracked = join(fixture.root, "src/new.ts");
    await writeFile(untracked, "Human untracked content\n");
    await assert.rejects(
      writeOwnedFile(record, journal, resources, "src/new.ts", "Replacement\n", signal),
      /External change/,
    );
    assert.equal(await readFile(untracked, "utf8"), "Human untracked content\n");
  } finally {
    await resources.drain();
    await journal.release();
    await fixture.cleanup();
  }
});
