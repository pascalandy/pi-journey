import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultConfig, makePlan, makeRun, type PlanInput, parse } from "../src/contracts.ts";
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
  const manager = SessionManager.inMemory(fixture.root);
  const { session } = await createAgentSession({
    cwd: fixture.root,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
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
    } satisfies PlanInput;
    const beforePlan = manager.appendCustomEntry("checkpoint", {});
    const result = await plan.execute(
      "plan",
      proposal,
      undefined,
      undefined,
      runner.createToolContext("plan", undefined),
    );
    assert.match(JSON.stringify(result), /Plan recorded/);
    const leafA = manager.getLeafId();
    assert.ok(leafA);
    const digestSchema = Type.Object({ digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) });
    const digestA = parse(digestSchema, result.details, "receipt").digest;
    const resultB = await plan.execute(
      "plan-b",
      { ...proposal, goal: "Another idea" },
      undefined,
      undefined,
      runner.createToolContext("plan-b", undefined),
    );
    const digestB = parse(digestSchema, resultB.details, "receipt").digest;
    await session.navigateTree(leafA, { summarize: false });
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
    await command.handler(`implement ${digestB} --allow-checks`, runner.createCommandContext());
    assert.equal(
      new Journal(fixture.root).current(),
      null,
      "a proposal abandoned by tree navigation cannot be approved",
    );
    await session.navigateTree(beforePlan, { summarize: false });
    await command.handler(`implement ${digestA} --allow-checks`, runner.createCommandContext());
    assert.equal(
      new Journal(fixture.root).current(),
      null,
      "navigating before any proposal clears approval",
    );
    const retired = makeRun(makePlan(proposal, fixture.root), defaultConfig(), {
      executeChecks: true,
      merge: false,
    });
    const store = new Journal(fixture.root);
    await store.acquire(retired.id);
    store.write({ ...retired, checkpoint: "blocked" });
    await store.release();
    await writeFile(join(fixture.root, "preserve"), "Human work");
    await command.handler("retire", runner.createCommandContext());
    assert.equal(store.current()?.checkpoint, "retired");
    assert.equal(await readFile(join(fixture.root, "preserve"), "utf8"), "Human work");
    assert.ok(store.read(retired.id), "retirement retains the run history");
    const fresh = await plan.execute(
      "fresh-plan",
      proposal,
      undefined,
      undefined,
      runner.createToolContext("fresh-plan", undefined),
    );
    const freshDigest = parse(digestSchema, fresh.details, "receipt").digest;
    await command.handler(`implement ${freshDigest} --allow-checks`, runner.createCommandContext());
    assert.notEqual(
      store.current()?.id,
      retired.id,
      "a retired run can be replaced by a fresh approval",
    );
    await command.handler("plan", runner.createCommandContext());
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
