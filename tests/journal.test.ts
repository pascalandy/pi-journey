import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseRun } from "../src/contracts.ts";
import { Journal } from "../src/journal.ts";
import { repository, run } from "./helpers.ts";

test("two coordinators cannot own the same repository and ownership releases after drain", async () => {
  const fixture = await repository();
  const first = new Journal(fixture.root);
  const second = new Journal(fixture.root);
  try {
    const record = run(fixture.root);
    await first.acquire(record.id);
    first.write(record);
    await assert.rejects(() => second.acquire(record.id), /owned/);
    assert.deepEqual(first.current(), record);
    await first.release();
    await second.acquire(record.id);
    second.checkpoint(record, "review");
    assert.equal(second.current()?.checkpoint, "review");
  } finally {
    await first.release();
    await second.release();
    await fixture.cleanup();
  }
});

test("a phase checkpoint preserves a prepared external intent from the durable journal", async () => {
  const fixture = await repository();
  const journal = new Journal(fixture.root);
  try {
    const record = run(fixture.root);
    await journal.acquire(record.id);
    journal.write(record);
    journal.write({
      ...record,
      operations: [
        {
          id: "publish-intent",
          kind: "pr",
          unit: 0,
          expectedHead: null,
          state: "prepared",
          detail: "",
        },
      ],
    });
    journal.checkpoint(record, "blocked");
    assert.equal(journal.current()?.operations[0]?.state, "prepared");
    assert.throws(
      () => parseRun({ ...record, grant: { ...record.grant, planDigest: "different" } }),
      /stale/,
    );
    assert.throws(() => parseRun({ ...record, unitIndex: 3 }), /inconsistent/);
  } finally {
    await journal.release();
    await fixture.cleanup();
  }
});

test("a missing active record cannot be mistaken for permission to start a new run", async () => {
  const fixture = await repository();
  const journal = new Journal(fixture.root);
  try {
    const record = run(fixture.root);
    await journal.acquire(record.id);
    journal.write(record);
    await unlink(join(journal.directory, "runs", `${record.id}.json`));
    assert.throws(() => journal.current(), /Active workflow record is missing/);
  } finally {
    await journal.release();
    await fixture.cleanup();
  }
});
