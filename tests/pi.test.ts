import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultConfig, makePlan, makeRun, type PlanInput, parse } from "../src/contracts.ts";
import journey from "../src/index.ts";
import { Journal } from "../src/journal.ts";
import { repository } from "./helpers.ts";

const digestSchema = Type.Object({ digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) });
const proposal = {
  goal: "Add an export",
  body: "CMO: absent. FMO: export it. Premortem: scope drift.",
  units: [{ title: "feat: export value", paths: ["src"], commitMessage: "feat: export value" }],
  checks: [
    { name: "check", argv: ["node", "--version"], effects: "Reads version", timeoutMs: 1_000 },
  ],
  delivery: "single",
} satisfies PlanInput;

// Records confirmations; the other methods Pi copies from a bound UI do nothing
function recordingUI() {
  const confirms: { title: string; message: string }[] = [];
  const quiet = [
    "notify",
    "setStatus",
    "setWorkingMessage",
    "setWorkingVisible",
    "setWorkingIndicator",
    "setHiddenThinkingLabel",
    "setWidget",
    "setFooter",
    "setHeader",
    "setTitle",
    "pasteToEditor",
    "setEditorText",
  ].map((name) => [name, () => {}]);
  const ui = {
    ...Object.fromEntries(quiet),
    confirm: async (title: string, message: string) => {
      confirms.push({ title, message });
      return false;
    },
  } as unknown as ExtensionUIContext;
  return { ui, confirms };
}

async function startSession(root: string, uiContext?: ExtensionUIContext) {
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, ".isolated"),
    extensionFactories: [journey],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    settingsManager: settings,
  });
  await loader.reload();
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({
    cwd: root,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    modelRuntime: await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }),
    tools: ["read", "journey_plan"],
  });
  await session.bindExtensions(uiContext ? { uiContext } : {});
  const runner = session.extensionRunner;
  assert.ok(runner);
  const plan = runner.getToolDefinition("journey_plan");
  const command = runner.getCommand("journey");
  assert.ok(plan && command);
  const record = async (input: PlanInput) => {
    const result = await plan.execute(
      "plan",
      input,
      undefined,
      undefined,
      runner.createToolContext("plan", undefined),
    );
    return { result, digest: parse(digestSchema, result.details, "receipt").digest };
  };
  const run = (args: string) => command.handler(args, runner.createCommandContext());
  const close = async () => {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  };
  return { session, manager, runner, record, run, close };
}

test("real Pi SDK leaves an idle session unrestricted and binds approval to the visible plan", async () => {
  const fixture = await repository();
  await mkdir(join(fixture.root, ".pi"));
  await writeFile(
    join(fixture.root, ".pi/extensions-malicious.ts"),
    "throw new Error('ambient code loaded')",
  );
  const { session, manager, runner, record, run, close } = await startSession(fixture.root);
  try {
    for (const name of ["write", "edit", "bash", "read"]) {
      const admitted = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId: `call-${name}`,
        input: {},
      });
      assert.equal(admitted?.block, undefined, name);
    }
    const shell = await runner.emitUserBash({
      type: "user_bash",
      command: "true",
      cwd: fixture.root,
      excludeFromContext: false,
    });
    assert.equal(shell?.result, undefined, "an idle session runs its own shell commands");
    const beforePlan = manager.appendCustomEntry("checkpoint", {});
    const planA = await record(proposal);
    assert.match(JSON.stringify(planA.result), /Plan recorded/);
    const leafA = manager.getLeafId();
    assert.ok(leafA);
    const planB = await record({ ...proposal, goal: "Another idea" });
    await session.navigateTree(leafA, { summarize: false });
    const journal = new Journal(fixture.root);
    await run(`implement ${"0".repeat(64)} --allow-checks`);
    assert.equal(journal.current(), null, "stale approval cannot create a run");
    await run("implement --allow-checks");
    assert.equal(journal.current(), null, "grant without a digest cannot create a run");
    await run(`implement ${planB.digest} --allow-checks`);
    assert.equal(
      journal.current(),
      null,
      "a proposal abandoned by tree navigation cannot be approved",
    );
    await session.navigateTree(beforePlan, { summarize: false });
    await run(`implement ${planA.digest} --allow-checks`);
    assert.equal(journal.current(), null, "navigating before any proposal clears approval");
    const retired = makeRun(makePlan(proposal, fixture.root), defaultConfig());
    await journal.acquire(retired.id);
    journal.write({ ...retired, checkpoint: "blocked" });
    await journal.release();
    await writeFile(join(fixture.root, "preserve"), "Human work");
    await run("retire");
    assert.equal(journal.current()?.checkpoint, "retired");
    assert.equal(await readFile(join(fixture.root, "preserve"), "utf8"), "Human work");
    assert.ok(journal.read(retired.id), "retirement retains the run history");
    const fresh = await record(proposal);
    await run(`implement ${fresh.digest} --allow-checks`);
    assert.notEqual(
      journal.current()?.id,
      retired.id,
      "a retired run can be replaced by a fresh approval",
    );
  } finally {
    await close();
    await fixture.cleanup();
  }
});

test("the approval dialog lists every writable path and commit message the plan records", async () => {
  const fixture = await repository();
  const { ui, confirms } = recordingUI();
  const { record, run, close } = await startSession(fixture.root, ui);
  try {
    const plan = await record({
      ...proposal,
      body: "Tidy the docs.",
      units: [
        { title: "Docs", paths: ["docs/guide.md"], commitMessage: "docs: tidy the guide" },
        { title: "Source", paths: ["src", "scripts/tool.ts"], commitMessage: "feat: widen scope" },
      ],
    });
    assert.match(JSON.stringify(plan.result), /scripts\/tool\.ts/);
    await run("implement");
    assert.equal(confirms.length, 1);
    for (const expected of [
      "docs/guide.md",
      "src",
      "scripts/tool.ts",
      "docs: tidy the guide",
      "feat: widen scope",
    ]) {
      assert.ok(confirms[0]?.message.includes(expected), expected);
    }
    assert.equal(new Journal(fixture.root).current(), null, "a declined dialog starts nothing");
  } finally {
    await close();
    await fixture.cleanup();
  }
});

test("tree navigation is cancelled while owned work cannot drain", async () => {
  const fixture = await repository();
  const { session, manager, record, run, close } = await startSession(fixture.root);
  const journal = new Journal(fixture.root);
  const ownerPath = join(journal.directory, "owner.json");
  let owner = "";
  try {
    const target = manager.appendCustomEntry("checkpoint", {});
    const plan = await record(proposal);
    await run(`implement ${plan.digest} --allow-checks`);
    const deadline = Date.now() + 10_000;
    while (journal.current()?.checkpoint !== "blocked" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(journal.current()?.checkpoint, "blocked", "preflight blocks without a model");
    owner = await readFile(ownerPath, "utf8");
    await writeFile(ownerPath, JSON.stringify({ ...JSON.parse(owner), nonce: "another owner" }));
    const leaf = manager.getLeafId();
    const navigation = await session.navigateTree(target, { summarize: false });
    assert.equal(navigation.cancelled, true);
    assert.ok(
      manager.getBranch().some((entry) => entry.id === leaf),
      "the session stays on its branch; only the drain failure report follows",
    );
  } finally {
    if (owner) await writeFile(ownerPath, owner);
    await run("stop");
    await close();
    await fixture.cleanup();
  }
});
