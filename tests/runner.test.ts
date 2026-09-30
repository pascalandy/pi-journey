import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnedResources } from "../src/runner.ts";

test("commands preserve argv and report the actual exit code", async () => {
  const resources = new OwnedResources();
  const result = await resources.command(
    [
      process.execPath,
      "-e",
      "process.stdout.write(process.argv[1]); process.exitCode=7",
      "$(touch escaped); `id`",
    ],
    tmpdir(),
    new AbortController().signal,
  );
  assert.equal(result.code, 7);
  assert.equal(result.stdout, "$(touch escaped); `id`");
  await resources.drain();
});

test("drain cancels the complete child process group before returning", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "workflow-process-"));
  const marker = join(directory, "pid");
  const resources = new OwnedResources();
  const childProgram = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
  const program =
    `const {spawn}=require('node:child_process');const fs=require('node:fs');` +
    `const c=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'inherit'});` +
    `fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)`;
  const job = resources.command(
    [process.execPath, "-e", program, marker],
    directory,
    new AbortController().signal,
  );
  const outcome = assert.rejects(job, /cancelled/);
  try {
    let pid = 0;
    for (let attempt = 0; attempt < 100 && pid === 0; attempt++) {
      try {
        pid = Number(await readFile(marker, "utf8"));
      } catch {}
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid > 0, "grandchild started");
    await resources.drain();
    await outcome;
    // A reaped child is gone; on Linux a killed orphan may briefly remain a zombie.
    let alive = false;
    try {
      const status = await readFile(`/proc/${pid}/stat`, "utf8");
      alive = !status.includes(") Z ");
    } catch {}
    assert.equal(alive, false, "grandchild no longer executes");
  } finally {
    await resources.drain();
    await rm(directory, { recursive: true, force: true });
  }
});
