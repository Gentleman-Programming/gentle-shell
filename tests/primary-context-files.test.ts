import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { ORCHESTRATOR_ONLY_MANAGED_BLOCKS } from "../lib/child-context-files.ts";

// The primary session loads ancestor context files such as a gentle-ai
// managed ~/AGENTS.md, whose orchestrator-only blocks carry a second
// orchestrator policy next to the one Gentle Shell injects. Whenever Gentle
// Shell's own orchestrator prompt is injected, the primary drops the same
// blocks a delegated child drops (gentle-shell#1587) plus the engram-protocol
// memory block, which gentle-engram injects itself. Everything else stays.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function block(name: string, body: string): string {
	return `<!-- gentle-ai:${name} -->\n${body}\n<!-- /gentle-ai:${name} -->`;
}

const REMOTE_AUTHORIZATION = block("remote-authorization", "## Remote operation authorization\n\nAsk before remote work.");
const ENGRAM_PROTOCOL = block("engram-protocol", "## Engram\n\nSave decisions.");

const MANAGED_AGENTS_MD = [
	"# My own notes",
	"",
	"Prefer small commits.",
	"",
	block("orchestrator", "## Agent Teams Lite\n\nYou are a COORDINATOR."),
	"",
	block("sdd-orchestrator", [
		"# SDD orchestrator",
		"",
		block("sdd-model-assignments", "| Phase | Model |\n|---|---|\n| sdd-apply | sonnet |"),
	].join("\n")),
	"",
	ENGRAM_PROTOCOL,
	"",
	block("agent-routing", [
		"## Implementation Routing",
		"",
		"Delegate on the 4-file rule.",
		"",
		REMOTE_AUTHORIZATION,
	].join("\n")),
	"",
	"## Closing notes",
	"Keep lines short.",
	"",
].join("\n");

const EXPECTED_PRIMARY = [
	"# My own notes",
	"",
	"Prefer small commits.",
	"",
	REMOTE_AUTHORIZATION,
	"",
	"## Closing notes",
	"Keep lines short.",
	"",
].join("\n");

// A project file that carries only its own engram-protocol block.
const PROJECT_AGENTS_MD = `# Repo rules\n\nRun the tests.\n\n${ENGRAM_PROTOCOL}\n`;
const PROJECT_AGENTS_MD_FILTERED = "# Repo rules\n\nRun the tests.\n";

let fixtureCwd: string;
let fixtureRoot: string | undefined;
const fixtureEnvironment: NodeJS.ProcessEnv = {};
const previousEnvironment = new Map<string, string | undefined>();
before(async () => {
	const root = await mkdtemp(join(tmpdir(), "gentle-pi-primary-context-"));
	fixtureRoot = root;
	fixtureCwd = join(root, "project");
	const home = join(root, "home");
	for (const directory of [fixtureCwd, home]) await mkdir(directory);
	Object.assign(fixtureEnvironment, {
		HOME: home, USERPROFILE: home,
		GENTLE_PI_CONFIG_HOME: join(home, "config"),
		GENTLE_PI_AGENT_HOME: join(home, "agents"),
		PI_CODING_AGENT_DIR: join(home, "pi"),
		XDG_CONFIG_HOME: join(home, "xdg"),
	});
	for (const [key, value] of Object.entries(fixtureEnvironment)) {
		previousEnvironment.set(key, process.env[key]);
		process.env[key] = value;
	}
});
after(async () => {
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
});

function beforeAgentStart(options: { processEnv?: NodeJS.ProcessEnv } = {}): Handler {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { ...fixtureEnvironment, GENTLE_PI_AGENTS_CHILD: "0", ...options.processEnv, GENTLE_AI_TELEMETRY: "0" },
		resolveTelemetryTriggerBinary: () => join(fixtureCwd, "never-executed"),
		telemetryTriggerSpawn: () => assert.fail("Primary context fixtures must not spawn telemetry"),
	})(pi);
	return handlers.get("before_agent_start")!;
}

function ctx(): ExtensionContext {
	return {
		cwd: fixtureCwd,
		hasUI: true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => "primary-context-session", getBranch: () => [] },
	} as unknown as ExtensionContext;
}

// Pi's order: files from the root toward the working directory, nearest last.
// The home file sits in an ancestor of the project directory (the cwd).
function startEvent(options: { extra?: Record<string, unknown>; home?: string; project?: string } = {}) {
	const contextFiles = [
		{ path: join(fixtureRoot!, "AGENTS.md"), content: options.home ?? MANAGED_AGENTS_MD },
		{ path: join(fixtureCwd, "AGENTS.md"), content: options.project ?? PROJECT_AGENTS_MD },
	];
	const systemPromptOptions = { appendSystemPrompt: "", contextFiles };
	return { contextFiles, systemPromptOptions, event: { systemPrompt: "base", systemPromptOptions, ...options.extra } };
}

const ORCHESTRATOR_HEADING = /el Gentleman Identity and Harness/;

for (const name of ORCHESTRATOR_ONLY_MANAGED_BLOCKS) {
	test(`the primary drops the ${name} block while Gentle Shell's orchestrator is injected`, async () => {
		const home = `Before\n\n${block(name, "Orchestrator only\n\nMore text")}\n\nAfter\n`;
		const { systemPromptOptions, event } = startEvent({ home });
		await beforeAgentStart()(event, ctx());
		assert.match(systemPromptOptions.appendSystemPrompt, ORCHESTRATOR_HEADING, "Gentle Shell's orchestrator is active");
		assert.equal(systemPromptOptions.contextFiles[0].content, "Before\n\nAfter\n");
	});
}

test("the primary filters a managed AGENTS.md on the same options object without mutating the loaded entries", async () => {
	const { contextFiles, systemPromptOptions, event } = startEvent({ project: "# Repo rules\n" });
	const result = await beforeAgentStart()(event, ctx());
	assert.equal(result, undefined, "the handler never returns a replacement system prompt");
	assert.match(systemPromptOptions.appendSystemPrompt, ORCHESTRATOR_HEADING);
	assert.equal(event.systemPromptOptions, systemPromptOptions, "the same options object stays in place");
	assert.notEqual(systemPromptOptions.contextFiles, contextFiles, "filtered copies replace contextFiles");
	assert.equal(contextFiles[0].content, MANAGED_AGENTS_MD, "the original entries are never mutated");
	assert.deepEqual(systemPromptOptions.contextFiles.map((file) => file.path), contextFiles.map((file) => file.path));
	assert.equal(systemPromptOptions.contextFiles[0].content, EXPECTED_PRIMARY, "the engram-protocol block is dropped");
	assert.doesNotMatch(systemPromptOptions.contextFiles[0].content, /COORDINATOR|SDD orchestrator|sdd-apply|Implementation Routing|4-file rule|engram-protocol/);
});

test("with engram-protocol in two loaded files the primary drops both copies", async () => {
	const { contextFiles, systemPromptOptions, event } = startEvent();
	await beforeAgentStart()(event, ctx());
	assert.equal(systemPromptOptions.contextFiles[0].content, EXPECTED_PRIMARY, "the home copy goes");
	assert.equal(systemPromptOptions.contextFiles[1].content, PROJECT_AGENTS_MD_FILTERED, "the project copy goes too");
	assert.equal(contextFiles[1].content, PROJECT_AGENTS_MD, "the loaded entry is never mutated on disk");
});

test("the nested remote-authorization block survives in the primary although its enclosing agent-routing block is dropped", async () => {
	const { systemPromptOptions, event } = startEvent();
	await beforeAgentStart()(event, ctx());
	const home = systemPromptOptions.contextFiles[0].content;
	assert.ok(!home.includes("gentle-ai:agent-routing -->"), "the enclosing agent-routing block is dropped");
	assert.ok(home.includes(REMOTE_AUTHORIZATION), "remote-authorization stays byte-for-byte");
});

test("two engram-protocol copies at the same level, or off the working-directory chain, are all dropped", async () => {
	for (const paths of [
		[join(fixtureCwd, "AGENTS.md"), join(fixtureCwd, "CLAUDE.md")],
		[join(fixtureRoot!, "elsewhere", "AGENTS.md"), join(fixtureCwd, "AGENTS.md")],
		["relative/AGENTS.md", join(fixtureCwd, "AGENTS.md")],
	]) {
		const { contextFiles, systemPromptOptions, event } = startEvent({ home: PROJECT_AGENTS_MD });
		contextFiles[0].path = paths[0];
		contextFiles[1].path = paths[1];
		await beforeAgentStart()(event, ctx());
		assert.deepEqual(systemPromptOptions.contextFiles.map((file) => file.content), [PROJECT_AGENTS_MD_FILTERED, PROJECT_AGENTS_MD_FILTERED], `both copies go for ${paths[0]}`);
		assert.deepEqual(contextFiles.map((file) => file.content), [PROJECT_AGENTS_MD, PROJECT_AGENTS_MD], "the loaded entries stay untouched");
	}
});

test("user-authored text outside managed markers stays byte-for-byte in the primary", async () => {
	const { systemPromptOptions, event } = startEvent();
	await beforeAgentStart()(event, ctx());
	const home = systemPromptOptions.contextFiles[0].content;
	assert.ok(home.startsWith("# My own notes\n\nPrefer small commits.\n\n"));
	assert.ok(home.endsWith("\n\n## Closing notes\nKeep lines short.\n"));
	assert.ok(systemPromptOptions.contextFiles[1].content.startsWith("# Repo rules\n\nRun the tests.\n"));
});

test("a second primary turn over already-filtered context files removes nothing more", async () => {
	const handler = beforeAgentStart();
	const { contextFiles, systemPromptOptions, event } = startEvent();
	await handler(event, ctx());
	const filtered = systemPromptOptions.contextFiles;
	assert.notEqual(filtered, contextFiles, "the first turn filtered");
	await handler(event, ctx());
	assert.equal(systemPromptOptions.contextFiles, filtered);
	assert.equal(filtered[1].content, PROJECT_AGENTS_MD_FILTERED, "the already-filtered copy is never touched again");
});

for (const scenario of ["child", "named-agent"] as const) {
	test(`a ${scenario} start, where Gentle Shell's orchestrator is not injected, leaves context files untouched`, async () => {
		const { contextFiles, systemPromptOptions, event } = startEvent({
			extra: scenario === "named-agent" ? { agentName: "gentle-ai-worker" } : {},
		});
		await beforeAgentStart({ processEnv: scenario === "child" ? { GENTLE_PI_AGENTS_CHILD: "1" } : {} })(event, ctx());
		assert.doesNotMatch(systemPromptOptions.appendSystemPrompt, ORCHESTRATOR_HEADING);
		assert.equal(systemPromptOptions.contextFiles, contextFiles);
		assert.equal(systemPromptOptions.contextFiles[0].content, MANAGED_AGENTS_MD);
		assert.equal(systemPromptOptions.contextFiles[1].content, PROJECT_AGENTS_MD);
	});
}

test("malformed managed markers leave the primary context file unchanged", async () => {
	const unbalanced = `<!-- gentle-ai:orchestrator -->\nno close\n${ENGRAM_PROTOCOL}\n`;
	const { systemPromptOptions, event } = startEvent({ home: unbalanced });
	await beforeAgentStart()(event, ctx());
	assert.equal(systemPromptOptions.contextFiles[0].content, unbalanced);
});
