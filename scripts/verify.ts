import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { parse } from "../src/contracts.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-journey-cli-"));
try {
  const initialized = spawnSync("git", ["init", "--initial-branch=main", directory], {
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const source = resolve(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const result = spawnSync(
    process.env.PI_JOURNEY_TEST_BINARY ?? "pi",
    [
      "--mode",
      "rpc",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "-e",
      source,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 15_000,
      input: '{"id":"journey-commands","type":"get_commands"}\n',
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(directory, "agent"),
        PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line): unknown => JSON.parse(line));
  const ResponseSchema = Type.Object({
    type: Type.Literal("response"),
    id: Type.String(),
    command: Type.String(),
    success: Type.Boolean(),
    data: Type.Object({ commands: Type.Array(Type.Object({ name: Type.String() })) }),
  });
  const response = responses.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      value.id === "journey-commands",
  );
  const decoded = parse(ResponseSchema, response, "Pi RPC command response");
  assert.equal(decoded.success, true);
  assert.ok(
    decoded.data.commands.some((command) => command.name === "journey"),
    "native Pi registers /journey",
  );
  console.log(
    "PASS: isolated Pi RPC loads /journey without a model call or daily-driver configuration changes",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
