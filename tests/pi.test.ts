import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import modeWorkflow from "../src/index.ts";
import { PLANNING_FOOTER } from "../src/policy.ts";
import { repository } from "./helpers.ts";

test("real Pi SDK registers the extension and enforces Planning across tool and shell routes", async () => {
  const fixture = await repository();
  await mkdir(join(fixture.root, ".pi"));
  await writeFile(
    join(fixture.root, ".pi/extensions-malicious.ts"),
    "throw new Error('ambient code loaded')",
  );
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: fixture.root,
    agentDir: join(fixture.root, ".isolated"),
    extensionFactories: [modeWorkflow],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    settingsManager: settings,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.root,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(fixture.root),
    modelRuntime: await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }),
    tools: ["read", "workflow_plan"],
  });
  try {
    await session.bindExtensions({});
    const runner = session.extensionRunner;
    assert.ok(runner);
    for (const name of ["write", "edit", "bash", "codemode", "mcp__arbitrary", "unknown"]) {
      const denied = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId: `call-${name}`,
        input: {},
      });
      assert.equal(denied?.block, true, name);
    }
    const read = await runner.emitToolCall({
      type: "tool_call",
      toolName: "read",
      toolCallId: "read",
      input: { path: "README.md" },
    });
    assert.equal(read?.block, undefined);
    const shell = await runner.emitUserBash({
      type: "user_bash",
      command: "touch forbidden",
      cwd: fixture.root,
      excludeFromContext: false,
    });
    assert.equal(shell?.result?.exitCode, 1);
    assert.equal(runner.getToolDefinition("workflow_plan")?.name, "workflow_plan");
    const plan = runner.getToolDefinition("workflow_plan");
    assert.ok(plan);
    const proposal = {
      goal: "Add an export",
      body: "CMO: absent. FMO: export it. Premortem: scope drift.",
      units: [{ title: "feat: export value", paths: ["src"], commitMessage: "feat: export value" }],
      checks: [
        { name: "check", argv: ["node", "--version"], effects: "Reads version", timeoutMs: 1_000 },
      ],
      delivery: "single",
    };
    const result = await plan.execute(
      "plan",
      proposal,
      undefined,
      undefined,
      runner.createToolContext("plan", undefined),
    );
    assert.match(JSON.stringify(result), /Plan recorded/);
    const command = runner.getCommand("workflow");
    assert.ok(command);
    await command.handler(
      `implement ${"0".repeat(64)} --allow-checks`,
      runner.createCommandContext(),
    );
    const { Journal } = await import("../src/journal.ts");
    assert.equal(new Journal(fixture.root).current(), null, "stale approval cannot create a run");
    await command.handler("implement --allow-checks", runner.createCommandContext());
    assert.equal(
      new Journal(fixture.root).current(),
      null,
      "grant without a digest cannot create a run",
    );
    const footer = await runner.emitMessageEnd({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The recommended plan" }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    assert.ok(footer?.role === "assistant");
    assert.deepEqual(footer.content, [
      { type: "text", text: `The recommended plan\n\n${PLANNING_FOOTER}` },
    ]);
  } finally {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await fixture.cleanup();
  }
});
