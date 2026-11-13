import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { filterChildSessionContextFiles } from "../lib/child-context-files.ts";

// Three loaded context files in Pi's order (root toward the working directory):
// a home file with every managed block, a project file with engram-protocol and
// agent-routing, and a nested package file with user text only. With Gentle
// Shell's orchestrator injected, the primary drops the orchestrator-only blocks,
// keeps remote-authorization, and keeps only the nearest engram-protocol copy.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function block(name: string, body: string): string {
	return `<!-- gentle-ai:${name} -->\n${body}\n<!-- /gentle-ai:${name} -->`;
}

const REMOTE_AUTHORIZATION = block("remote-authorization", "## Remote operation authorization\n\nNo remote without consent.");
const ENGRAM_HOME = block("engram-protocol", "## Engram HOME copy\n\nrule H.");
const ENGRAM_PROJECT = block("engram-protocol", "## Engram PROJECT copy\n\nrule P.");

const HOME_MD = [
	"# Home notes",
	"",
	"keep me 1",
	"",
	block("orchestrator", "## Teams\n\nCOORD"),
	"",
	block("sdd-orchestrator", `# SDD\n\n${block("sdd-model-assignments", "| a | b |")}`),
	"",
	ENGRAM_HOME,
	"",
	block("agent-routing", `## Routing\n\nrules\n\n${REMOTE_AUTHORIZATION}`),
	"",
	"## Tail",
	"keep me 2",
	"",
].join("\n");
const HOME_EXPECTED = ["# Home notes", "", "keep me 1", "", REMOTE_AUTHORIZATION, "", "## Tail", "keep me 2", ""].join("\n");

const PROJECT_MD = [
	"# Project",
	"",
	"proj text",
	"",
	ENGRAM_PROJECT,
	"",
	block("agent-routing", "## Implementation Routing\n\n### Receipt-driven development is user-owned\n\nx"),
	"",
].join("\n");
const PROJECT_EXPECTED = ["# Project", "", "proj text", "", ENGRAM_PROJECT, ""].join("\n");

const NESTED_MD = "# Package notes\n\nOnly user text here.\n";

let fixtureRoot: string | undefined;
let homeDir: string;
let projectDir: string;
let packageDir: string;
const fixtureEnvironment: NodeJS.ProcessEnv = {};
const previousEnvironment = new Map<string, string | undefined>();
before(async () => {
	const root = await mkdtemp(join(tmpdir(), "gentle-pi-three-context-files-"));
	fixtureRoot = root;
	homeDir = join(root, "home");
	projectDir = join(homeDir, "work", "proj");
	packageDir = join(projectDir, "pkg");
	await mkdir(packageDir, { recursive: true });
	Object.assign(fixtureEnvironment, {
		HOME: homeDir, USERPROFILE: homeDir,
		GENTLE_PI_CONFIG_HOME: join(root, "config"),
		GENTLE_PI_AGENT_HOME: join(root, "agents"),
		PI_CODING_AGENT_DIR: join(root, "pi"),
		XDG_CONFIG_HOME: join(root, "xdg"),
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

function beforeAgentStart(processEnv: NodeJS.ProcessEnv = {}): Handler {
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
		processEnv: { ...fixtureEnvironment, GENTLE_PI_AGENTS_CHILD: "0", ...processEnv, GENTLE_AI_TELEMETRY: "0" },
		resolveTelemetryTriggerBinary: () => join(fixtureRoot!, "never-executed"),
		telemetryTriggerSpawn: () => assert.fail("Context file fixtures must not spawn telemetry"),
	})(pi);
	return handlers.get("before_agent_start")!;
}

function ctx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => "three-context-files-session", getBranch: () => [] },
	} as unknown as ExtensionContext;
}

function startEvent(extra: Record<string, unknown> = {}) {
	const contextFiles = [
		{ path: join(homeDir, "AGENTS.md"), content: HOME_MD },
		{ path: join(projectDir, "AGENTS.md"), content: PROJECT_MD },
		{ path: join(packageDir, "AGENTS.md"), content: NESTED_MD },
	];
	const systemPromptOptions = { appendSystemPrompt: "", contextFiles };
	return { contextFiles, systemPromptOptions, event: { systemPrompt: "base", systemPromptOptions, ...extra } };
}

for (const mode of ["organic", "full-delegation"] as const) {
	test(`${mode}: three context files keep exactly the expected bytes`, async () => {
		const { contextFiles, systemPromptOptions, event } = startEvent();
		await beforeAgentStart({ GENTLE_PI_ORCHESTRATOR_MODE: mode })(event, ctx(packageDir));
		assert.match(systemPromptOptions.appendSystemPrompt, /el Gentleman Identity and Harness/);
		if (mode === "full-delegation") assert.match(systemPromptOptions.appendSystemPrompt, /COORDINATOR in full delegation mode/);
		else assert.doesNotMatch(systemPromptOptions.appendSystemPrompt, /COORDINATOR in full delegation mode/);
		assert.deepEqual(systemPromptOptions.contextFiles.map((file) => file.content), [HOME_EXPECTED, PROJECT_EXPECTED, NESTED_MD]);
		assert.deepEqual(contextFiles.map((file) => file.content), [HOME_MD, PROJECT_MD, NESTED_MD], "the loaded entries are never mutated");
		const filtered = systemPromptOptions.contextFiles;
		await beforeAgentStart({ GENTLE_PI_ORCHESTRATOR_MODE: mode })(event, ctx(packageDir));
		assert.equal(systemPromptOptions.contextFiles, filtered, "a second turn removes nothing more");
	});
}

test("child and named-agent starts leave the three context files untouched", async () => {
	const scenarios: Array<[Record<string, unknown>, NodeJS.ProcessEnv]> = [
		[{}, { GENTLE_PI_AGENTS_CHILD: "1" }],
		[{ agentName: "gentle-ai-worker" }, {}],
	];
	for (const [extra, processEnv] of scenarios) {
		const { contextFiles, systemPromptOptions, event } = startEvent(extra);
		await beforeAgentStart(processEnv)(event, ctx(packageDir));
		assert.equal(systemPromptOptions.contextFiles, contextFiles);
	}
});

test("hostile input never throws and a malformed nearer file does not cost the only valid copy", () => {
	assert.doesNotThrow(() => filterChildSessionContextFiles({ contextFiles: [{ path: 5 as unknown as string, content: null as unknown as string }] }, { cwd: "/x" }));
	assert.doesNotThrow(() => filterChildSessionContextFiles({ contextFiles: [{ path: "/a/AGENTS.md", content: ENGRAM_HOME }, { path: "/a/b/AGENTS.md", content: ENGRAM_PROJECT }] }, { cwd: "relative" }));
	const options = { contextFiles: [{ path: "/a/AGENTS.md", content: ENGRAM_HOME }, { path: "/a/b/AGENTS.md", content: "<!-- gentle-ai:engram-protocol -->\nunclosed\n" }] };
	filterChildSessionContextFiles(options, { cwd: "/a/b" });
	assert.equal(options.contextFiles[0].content, ENGRAM_HOME);
});

test("a nearer engram-protocol copy nested inside agent-routing is the one copy that survives", () => {
	const options = {
		contextFiles: [
			{ path: "/a/AGENTS.md", content: `${ENGRAM_HOME}\n` },
			{ path: "/a/b/AGENTS.md", content: `${block("agent-routing", `r\n${ENGRAM_PROJECT}`)}\n` },
		],
	};
	filterChildSessionContextFiles(options, { cwd: "/a/b" });
	const survivors = options.contextFiles.filter((file) => file.content.includes("<!-- gentle-ai:engram-protocol -->"));
	assert.equal(survivors.length, 1);
	assert.equal(survivors[0].path, "/a/b/AGENTS.md");
	assert.ok(survivors[0].content.includes(ENGRAM_PROJECT), "the surviving copy is the project's");
	assert.ok(!survivors[0].content.includes("gentle-ai:agent-routing -->"), "its enclosing agent-routing block is dropped");
});
