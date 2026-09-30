import { spawn } from "node:child_process";

let started = false;
let stopping = false;

function killGroup(signal: NodeJS.Signals): void {
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

process.on("disconnect", () => killGroup("SIGKILL"));
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  killGroup("SIGTERM");
  setTimeout(() => killGroup("SIGKILL"), 2_000);
});
process.on("message", (message: unknown) => {
  if (started) return;
  started = true;
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "start" ||
    !("argv" in message) ||
    !Array.isArray(message.argv) ||
    !message.argv.every((value: unknown) => typeof value === "string") ||
    !("cwd" in message) ||
    typeof message.cwd !== "string" ||
    !("stdin" in message) ||
    (message.stdin !== null && typeof message.stdin !== "string")
  ) {
    throw new Error("Invalid owned process start");
  }
  const input = { argv: message.argv, cwd: message.cwd, stdin: message.stdin };
  const [binary, ...args] = input.argv;
  if (!binary) throw new Error("Missing executable");
  const child = spawn(binary, args, {
    cwd: input.cwd,
    shell: false,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input.stdin ?? undefined);
  child.on("error", (error) => process.stderr.write(`${error.message}\n`));
  child.on("close", (code) => {
    if (!process.connected) {
      killGroup("SIGKILL");
      return;
    }
    process.send?.({ type: "result", code: code ?? 127 }, () => killGroup("SIGKILL"));
  });
});
