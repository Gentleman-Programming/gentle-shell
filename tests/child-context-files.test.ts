import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	filterChildContextFiles,
	filterChildSessionContextFiles,
	filterOrchestratorOnlyBlocks,
	ORCHESTRATOR_ONLY_MANAGED_BLOCKS,
	stripOrchestratorOnlyBlocks,
} from "../lib/child-context-files.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childContextExtension, { createChildContextExtension } from "../extensions/child-context.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

function block(name: string, body: string): string {
	return `<!-- gentle-ai:${name} -->\n${body}\n<!-- /gentle-ai:${name} -->`;
}

// Synthetic file shaped like a gentle-ai managed AGENTS.md: unmanaged project
// text, kept blocks, orchestrator-only blocks, the engram-protocol block, a
// nested kept block inside agent-routing, and a nested orchestrator-only block
// inside sdd-orchestrator.
const REALISTIC_AGENTS_MD = [
	"# Project conventions",
	"",
	"Run `pnpm test` before pushing.",
	"",
	block("codegraph-guidance", "## CodeGraph\n\nUse CodeGraph first."),
	"",
	block("sdd-orchestrator", [
		"<!-- section:model-capable -->",
		"# Orchestrator instructions",
		"You are a COORDINATOR.",
		"<!-- /section:model-capable -->",
		"",
		block("sdd-model-assignments", "| Phase | Model |\n|---|---|\n| sdd-apply | sonnet |"),
		"",
		"### Sub-agent launch pattern",
	].join("\n")),
	"",
	block("engram-protocol", "## Engram\n\nSave decisions."),
	"",
	block("agent-routing", [
		"## Implementation Routing",
		"",
		"Delegate on the 4-file rule.",
		"",
		block("remote-authorization", "## Remote operation authorization\n\nAsk before remote work."),
	].join("\n")),
	"",
	"## Local notes",
	"Keep lines short.",
	"",
].join("\n");

const EXPECTED_REALISTIC = [
	"# Project conventions",
	"",
	"Run `pnpm test` before pushing.",
	"",
	block("codegraph-guidance", "## CodeGraph\n\nUse CodeGraph first."),
	"",
	block("remote-authorization", "## Remote operation authorization\n\nAsk before remote work."),
	"",
	"## Local notes",
	"Keep lines short.",
	"",
].join("\n");

test("the orchestrator-only list names exactly the blocks bound to the orchestrator", () => {
	assert.deepEqual([...ORCHESTRATOR_ONLY_MANAGED_BLOCKS].sort(), ["agent-routing", "orchestrator", "sdd-model-assignments", "sdd-orchestrator"]);
});

for (const name of ORCHESTRATOR_ONLY_MANAGED_BLOCKS) {
	test(`removes the ${name} block and keeps the surrounding text`, () => {
		const input = `Before\n\n${block(name, "Orchestrator only\n\nMore text")}\n\nAfter\n`;
		assert.equal(stripOrchestratorOnlyBlocks(input), "Before\n\nAfter\n");
	});
}

test("filters a realistic managed AGENTS.md: nested kept blocks survive, nested listed blocks go with their parent", () => {
	const output = stripOrchestratorOnlyBlocks(REALISTIC_AGENTS_MD);
	assert.equal(output, EXPECTED_REALISTIC);
	assert.doesNotMatch(output, /COORDINATOR|sdd-model-assignments|Implementation Routing|4-file rule/);
	assert.doesNotMatch(output, /gentle-ai:engram-protocol/);
	assert.match(output, /<!-- gentle-ai:remote-authorization -->\n## Remote operation authorization/);
});

test("drops engram-protocol while codegraph-guidance and unknown managed blocks stay byte-for-byte", () => {
	const kept = [
		block("codegraph-guidance", "cg"),
		block("some-future-block", "future"),
		"",
	].join("\n");
	assert.equal(stripOrchestratorOnlyBlocks(kept), kept);
	const withEngram = [
		block("codegraph-guidance", "cg"),
		block("engram-protocol", "engram\n\n\n\nspacing kept"),
		block("some-future-block", "future"),
		"",
	].join("\n");
	assert.equal(stripOrchestratorOnlyBlocks(withEngram), kept);
});

test("unmanaged text before, between, and after removed blocks is preserved byte-for-byte", () => {
	const input = [
		"  leading indent\t",
		"",
		"",
		"double blank kept above",
		block("orchestrator", "gone"),
		"between   text  ",
		block("agent-routing", "gone"),
		"after\ttext",
	].join("\n");
	assert.equal(stripOrchestratorOnlyBlocks(input), "  leading indent\t\n\n\ndouble blank kept above\nbetween   text  \nafter\ttext");
});

test("collapses only blank lines left by a removal to at most one", () => {
	const input = `Intro\n\n\n${block("orchestrator", "x")}\n\n\n\nOutro\n\n\n\nTail\n`;
	assert.equal(stripOrchestratorOnlyBlocks(input), "Intro\n\n\nOutro\n\n\n\nTail\n");
	const leading = `${block("orchestrator", "x")}\n\n\nFirst line\n`;
	assert.equal(stripOrchestratorOnlyBlocks(leading), "First line\n");
	const trailing = `Last line\n\n${block("agent-routing", "x")}\n\n`;
	assert.equal(stripOrchestratorOnlyBlocks(trailing), "Last line\n");
});

test("non gentle-ai HTML comments are plain text", () => {
	const input = "<!-- section:model-capable -->\nkeep\n<!-- /section:model-capable -->\n<!-- orchestrator -->\n";
	assert.equal(stripOrchestratorOnlyBlocks(input), input);
});

test("markers mentioned inline or inside fenced code are plain text", () => {
	const input = [
		"Managed blocks start with `<!-- gentle-ai:orchestrator -->` in prose.",
		"```markdown",
		"<!-- gentle-ai:orchestrator -->",
		"example",
		"<!-- /gentle-ai:orchestrator -->",
		"```",
		"",
	].join("\n");
	assert.equal(stripOrchestratorOnlyBlocks(input), input);
});

test("unbalanced, mismatched, or duplicate-open markers leave the file unchanged", () => {
	const cases = [
		`${block("codegraph-guidance", "cg")}\n<!-- gentle-ai:orchestrator -->\nno close\n`,
		`<!-- /gentle-ai:orchestrator -->\n${block("agent-routing", "x")}\n`,
		`<!-- gentle-ai:orchestrator -->\nx\n<!-- /gentle-ai:agent-routing -->\n`,
		`<!-- gentle-ai:agent-routing -->\n<!-- gentle-ai:remote-authorization -->\nx\n<!-- /gentle-ai:agent-routing -->\n<!-- /gentle-ai:remote-authorization -->\n`,
		`<!-- gentle-ai:orchestrator -->\n<!-- gentle-ai:orchestrator -->\nx\n<!-- /gentle-ai:orchestrator -->\n`,
		`<!-- gentle-ai:orchestrator -->\n<!-- gentle-ai:orchestrator -->\nx\n<!-- /gentle-ai:orchestrator -->\n<!-- /gentle-ai:orchestrator -->\n`,
	];
	for (const input of cases) assert.equal(stripOrchestratorOnlyBlocks(input), input);
});

test("handles CRLF input and keeps CRLF line endings", () => {
	const input = REALISTIC_AGENTS_MD.replace(/\n/g, "\r\n");
	assert.equal(stripOrchestratorOnlyBlocks(input), EXPECTED_REALISTIC.replace(/\n/g, "\r\n"));
});

test("a file without managed markers is returned identical", () => {
	const input = "# Plain\n\nNo managed blocks here.\n<!-- a comment -->\n";
	assert.equal(stripOrchestratorOnlyBlocks(input), input);
	assert.equal(stripOrchestratorOnlyBlocks(""), "");
});

test("filterChildContextFiles returns filtered copies, never mutates inputs, and reports removals", () => {
	const files = Object.freeze([
		Object.freeze({ path: "/home/AGENTS.md", content: REALISTIC_AGENTS_MD }),
		Object.freeze({ path: "/repo/AGENTS.md", content: "# Plain\n" }),
		Object.freeze({ path: "/repo/sub/AGENTS.md", content: "<!-- gentle-ai:orchestrator -->\nunbalanced\n" }),
	]);
	const result = filterChildContextFiles(files);
	assert.notEqual(result.files, files);
	assert.equal(result.files.length, 3);
	assert.equal(result.files[0].path, "/home/AGENTS.md");
	assert.equal(result.files[0].content, EXPECTED_REALISTIC);
	assert.notEqual(result.files[0], files[0]);
	assert.equal(result.files[1].content, "# Plain\n");
	assert.equal(result.files[2].content, files[2].content);
	assert.equal(files[0].content, REALISTIC_AGENTS_MD);
	assert.equal(result.removedBlocks, 4, "sdd-orchestrator, its nested sdd-model-assignments, agent-routing, and engram-protocol");
	assert.equal(result.removedBytes, Buffer.byteLength(REALISTIC_AGENTS_MD) - Buffer.byteLength(EXPECTED_REALISTIC));
	assert.deepEqual(result.failSafePaths, ["/repo/sub/AGENTS.md"]);
});

test("filterChildSessionContextFiles replaces contextFiles on the same options object and tolerates bad input", () => {
	const original = [{ path: "/home/AGENTS.md", content: REALISTIC_AGENTS_MD }];
	const options: { contextFiles?: Array<{ path: string; content: string }> } = { contextFiles: original };
	filterChildSessionContextFiles(options);
	assert.notEqual(options.contextFiles, original);
	assert.equal(options.contextFiles?.[0].content, EXPECTED_REALISTIC);
	assert.equal(original[0].content, REALISTIC_AGENTS_MD, "input array entries are never mutated");

	const empty: { contextFiles?: Array<{ path: string; content: string }> } = {};
	filterChildSessionContextFiles(empty);
	assert.equal("contextFiles" in empty, false);
	assert.doesNotThrow(() => filterChildSessionContextFiles(undefined));
	assert.doesNotThrow(() => filterChildSessionContextFiles(null));

	const malformed = { contextFiles: [{ path: "/x", content: 42 }] as unknown as Array<{ path: string; content: string }> };
	const malformedFiles = malformed.contextFiles;
	assert.doesNotThrow(() => filterChildSessionContextFiles(malformed));
	assert.equal(malformed.contextFiles, malformedFiles, "on any error the original context files stay in place");
});

type BeforeAgentStart = (event: unknown, ctx: unknown) => unknown;

function childContextHandlers(env: NodeJS.ProcessEnv): { handlers: Map<string, BeforeAgentStart>; registered: string[] } {
	const handlers = new Map<string, BeforeAgentStart>();
	const registered: string[] = [];
	const pi = {
		on(name: string, handler: BeforeAgentStart) {
			registered.push(name);
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	createChildContextExtension(env)(pi);
	return { handlers, registered };
}

test("the child-context extension registers only before_agent_start", () => {
	assert.deepEqual(childContextHandlers({}).registered, ["before_agent_start"]);
	assert.equal(typeof childContextExtension, "function");
});

for (const scenario of ["child", "primary"] as const) {
	test(`the child-context extension ${scenario === "child" ? "filters" : "leaves"} context files on the shared options object for a ${scenario} session`, async () => {
		const { handlers } = childContextHandlers(scenario === "child" ? { GENTLE_PI_AGENTS_CHILD: "1" } : { GENTLE_PI_AGENTS_CHILD: "0" });
		const contextFiles = [
			{ path: "/home/AGENTS.md", content: REALISTIC_AGENTS_MD },
			{ path: "/repo/CLAUDE.md", content: "# Plain\n" },
		];
		const systemPromptOptions = { appendSystemPrompt: "", contextFiles };
		const event = { systemPrompt: "base", systemPromptOptions };
		const result = await handlers.get("before_agent_start")!(event, {});
		assert.equal(result, undefined, "the extension never returns a replacement system prompt");
		assert.equal(event.systemPromptOptions, systemPromptOptions, "the same options object stays in place");
		assert.equal(contextFiles[0].content, REALISTIC_AGENTS_MD, "the original entries are never mutated");
		if (scenario === "primary") {
			assert.equal(systemPromptOptions.contextFiles, contextFiles);
			return;
		}
		assert.notEqual(systemPromptOptions.contextFiles, contextFiles);
		assert.deepEqual(systemPromptOptions.contextFiles.map((file) => file.content), [EXPECTED_REALISTIC, "# Plain\n"]);
		// Idempotent: a second run over already-filtered content removes nothing.
		const filtered = systemPromptOptions.contextFiles;
		await handlers.get("before_agent_start")!(event, {});
		assert.equal(systemPromptOptions.contextFiles, filtered);
	});
}

// The engram-protocol block is dropped from every injected context file, at any
// depth: the file on disk keeps it for runtimes that read it as a workspace
// file, and gentle-engram injects its own protocol every turn.
const PROJECT_WITH_ENGRAM = `# Plain\n\n${block("engram-protocol", "project engram")}\n`;
const PROJECT_WITHOUT_ENGRAM = "# Plain\n";

async function runChildStart(env: NodeJS.ProcessEnv, project: string) {
	const { handlers } = childContextHandlers(env);
	const contextFiles = [
		{ path: "/work/AGENTS.md", content: REALISTIC_AGENTS_MD },
		{ path: "/work/repo/AGENTS.md", content: project },
	];
	const systemPromptOptions = { appendSystemPrompt: "", contextFiles };
	const event = { systemPrompt: "base", systemPromptOptions };
	const handler = handlers.get("before_agent_start")!;
	await handler(event, { cwd: "/work/repo" });
	return { contextFiles, systemPromptOptions, rerun: () => handler(event, { cwd: "/work/repo" }) };
}

test("a child drops the engram-protocol block from every loaded file, at any depth", async () => {
	const { contextFiles, systemPromptOptions, rerun } = await runChildStart({ GENTLE_PI_AGENTS_CHILD: "1" }, PROJECT_WITH_ENGRAM);
	assert.deepEqual(systemPromptOptions.contextFiles.map((file) => file.content), [EXPECTED_REALISTIC, PROJECT_WITHOUT_ENGRAM]);
	assert.match(systemPromptOptions.contextFiles[0].content, /<!-- gentle-ai:remote-authorization -->\n## Remote operation authorization/);
	assert.equal(contextFiles[0].content, REALISTIC_AGENTS_MD, "the loaded entries are never mutated");
	assert.equal(contextFiles[1].content, PROJECT_WITH_ENGRAM, "the loaded entries are never mutated");
	const filtered = systemPromptOptions.contextFiles;
	await rerun();
	assert.equal(systemPromptOptions.contextFiles, filtered, "a repeated turn removes nothing more");
});

test("a child with no engram-protocol block anywhere still loses nothing else", async () => {
	const { systemPromptOptions } = await runChildStart({ GENTLE_PI_AGENTS_CHILD: "1" }, PROJECT_WITHOUT_ENGRAM);
	assert.deepEqual(systemPromptOptions.contextFiles.map((file) => file.content), [EXPECTED_REALISTIC, PROJECT_WITHOUT_ENGRAM]);
});

test("filterChildContextFiles drops engram-protocol from files at the same level", () => {
	const result = filterChildContextFiles([
		{ path: "/work/repo/AGENTS.md", content: PROJECT_WITH_ENGRAM },
		{ path: "/work/repo/CLAUDE.md", content: PROJECT_WITH_ENGRAM },
	]);
	assert.deepEqual(result.files.map((file) => file.content), [PROJECT_WITHOUT_ENGRAM, PROJECT_WITHOUT_ENGRAM]);
	assert.equal(result.removedBlocks, 2);
});

test("outside a child session the child-context extension leaves context files untouched", async () => {
	const { contextFiles, systemPromptOptions } = await runChildStart({ GENTLE_PI_AGENTS_CHILD: "0" }, PROJECT_WITH_ENGRAM);
	assert.equal(systemPromptOptions.contextFiles, contextFiles);
	assert.deepEqual(systemPromptOptions.contextFiles.map((file) => file.content), [REALISTIC_AGENTS_MD, PROJECT_WITH_ENGRAM]);
});

test("the child-context extension never throws on missing or malformed options", async () => {
	const { handlers } = childContextHandlers({ GENTLE_PI_AGENTS_CHILD: "1" });
	const handler = handlers.get("before_agent_start")!;
	await assert.doesNotReject(async () => handler({}, {}));
	await assert.doesNotReject(async () => handler({ systemPromptOptions: null }, {}));
	const malformed = { systemPromptOptions: { contextFiles: [{ path: "/x", content: 42 }] } };
	const original = malformed.systemPromptOptions.contextFiles;
	await assert.doesNotReject(async () => handler(malformed, {}));
	assert.equal(malformed.systemPromptOptions.contextFiles, original);
});

// gentle-shell#3097: a block is dropped only when the prompt this session
// receives already carries its text. The premise "the block duplicates what we
// inject" is false for a user-authored policy block, and deleting it silently
// emptied `<project_instructions>` for a `~/AGENTS.md` wrapped end to end in an
// `orchestrator` block.
const POLICY_BODY = "# Orchestrator policy\n\nDelegate on the 4-file rule.\nNever push without consent.";
const POLICY_BLOCK = block("orchestrator", POLICY_BODY);
const INJECTED_PROMPT = [
	"el Gentleman Identity and Harness",
	"",
	"## Review status",
	"RD | 1 candidate",
	"",
	"## Harness rules",
	"Do the thing.",
].join("\n");
const REMOTE_AUTHORIZATION = block("remote-authorization", "## Remote operation authorization\n\nNo remote without consent.");

test("an orchestrator block whose text the injected prompt lacks keeps its user policy", () => {
	const input = `${POLICY_BLOCK}\n`;
	const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: INJECTED_PROMPT });
	assert.equal(result.content, input, "the block stays where it is, byte-for-byte");
	assert.equal(result.removedBlocks, 0);
	assert.deepEqual(result.removedBlockNames, []);
	assert.equal(result.failSafe, false);
	assert.deepEqual(result.blockNames, ["orchestrator"]);
	assert.match(result.content, /4-file rule/, "the user's policy survives");
});

test("a managed AGENTS.md that is one orchestrator block keeps its policy through the file filter", () => {
	const files = Object.freeze([Object.freeze({ path: "/home/AGENTS.md", content: `${POLICY_BLOCK}\n` })]);
	const result = filterChildContextFiles(files, { cwd: "/home", injectedPrompt: INJECTED_PROMPT });
	assert.equal(result.files[0].content, `${POLICY_BLOCK}\n`);
	assert.match(result.files[0].content, /4-file rule/);
	assert.equal(result.removedBlocks, 0);
	assert.equal(result.removedBytes, 0);
	assert.deepEqual(result.droppedBlocks, []);
});

test("a block whose text the injected prompt already carries is dropped and reported with its file", () => {
	// Same text, different whitespace: the comparison is on normalized text.
	const prompt = ["Header", "", "# Orchestrator policy", "", "Delegate on the 4-file rule.", "Never push without consent.", "", "Footer"].join("\n");
	const home = `# Notes\n\n${POLICY_BLOCK}\n\nTail\n`;
	const files = [
		{ path: "/home/AGENTS.md", content: home },
		{ path: "/repo/AGENTS.md", content: "# Plain\n" },
	];
	const result = filterChildContextFiles(files, { injectedPrompt: prompt });
	assert.equal(result.files[0].content, "# Notes\n\nTail\n");
	assert.equal(result.files[1].content, "# Plain\n");
	assert.equal(result.removedBlocks, 1);
	assert.equal(result.removedBytes, Buffer.byteLength(home) - Buffer.byteLength("# Notes\n\nTail\n"));
	assert.deepEqual(result.droppedBlocks, [{ path: "/home/AGENTS.md", blockNames: ["orchestrator"] }]);
});

test("filterChildSessionContextFiles forwards the injected prompt", () => {
	const policy = `${POLICY_BLOCK}\n`;
	const options: { contextFiles?: Array<{ path: string; content: string }> } = { contextFiles: [{ path: "/home/AGENTS.md", content: policy }] };
	const kept = filterChildSessionContextFiles(options, { injectedPrompt: INJECTED_PROMPT });
	assert.equal(options.contextFiles?.[0].content, policy, "nothing is dropped and nothing is replaced");
	assert.deepEqual(kept?.droppedBlocks, []);

	const duplicated: { contextFiles?: Array<{ path: string; content: string }> } = { contextFiles: [{ path: "/home/AGENTS.md", content: policy }] };
	const dropped = filterChildSessionContextFiles(duplicated, { injectedPrompt: `\n\n${POLICY_BODY}\n\n` });
	assert.equal(duplicated.contextFiles?.[0].content, "");
	assert.deepEqual(dropped?.droppedBlocks, [{ path: "/home/AGENTS.md", blockNames: ["orchestrator"] }]);
});

test("a block that only partly matches the injected prompt is kept", () => {
	const nearDuplicate = ["# Orchestrator policy", "", "Delegate on the 5-file rule.", "Never push without consent."].join("\n");
	const input = `Before\n\n${POLICY_BLOCK}\n\nAfter\n`;
	const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: nearDuplicate });
	assert.equal(result.content, input, "a near-duplicate fails open: keeping a duplicate is harmless");
	assert.equal(result.removedBlocks, 0);
	assert.deepEqual(result.removedBlockNames, []);
});

// Sharing a heading with the prompt is not duplication: the block's other
// line decides, so a user policy under a heading the prompt also uses stays.
test("a shared heading does not discard additional policy", () => {
	const content = `${block("orchestrator", "## Rules\nDo not leak secrets")}\n`;
	const result = filterOrchestratorOnlyBlocks(content, { injectedPrompt: "## Rules\nOther rules\n" });
	assert.equal(result.content, content);
	assert.equal(result.removedBlocks, 0);
	assert.deepEqual(result.removedBlockNames, []);
});

test("without an injected prompt the drop stays the name-based behaviour children rely on", () => {
	const input = `Before\n\n${block("orchestrator", "policy that no prompt carries")}\n\nAfter\n`;
	for (const options of [undefined, {}]) {
		const result = filterOrchestratorOnlyBlocks(input, options);
		assert.equal(result.content, "Before\n\nAfter\n");
		assert.equal(result.removedBlocks, 1);
		assert.deepEqual(result.removedBlockNames, ["orchestrator"]);
		assert.equal(result.failSafe, false);
	}
	assert.equal(stripOrchestratorOnlyBlocks(input), "Before\n\nAfter\n");
	const files = filterChildContextFiles([{ path: "/home/AGENTS.md", content: input }]);
	assert.equal(files.files[0].content, "Before\n\nAfter\n");
	assert.deepEqual(files.droppedBlocks, [{ path: "/home/AGENTS.md", blockNames: ["orchestrator"] }]);
});

test("malformed markers leave the file untouched even when the injected prompt carries the text", () => {
	const cases = [
		`${block("codegraph-guidance", "cg")}\n<!-- gentle-ai:orchestrator -->\n${POLICY_BODY}\nno close\n`,
		`<!-- /gentle-ai:orchestrator -->\n${POLICY_BLOCK}\n`,
		`<!-- gentle-ai:orchestrator -->\n${POLICY_BODY}\n<!-- /gentle-ai:agent-routing -->\n`,
		`${POLICY_BLOCK.replace("<!-- /gentle-ai:orchestrator -->", "")}<!-- gentle-ai:orchestrator -->\n${POLICY_BODY}\n<!-- /gentle-ai:orchestrator -->\n`,
	];
	for (const input of cases) {
		const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: POLICY_BODY });
		assert.equal(result.content, input);
		assert.equal(result.removedBlocks, 0);
		assert.equal(result.failSafe, true);
		assert.deepEqual(result.removedBlockNames, []);
	}
});

test("a dropped block still lifts the nested block the prompt does not duplicate", () => {
	const nested = block("agent-routing", `## Routing\n\nrules\n\n${REMOTE_AUTHORIZATION}`);
	const input = `Intro\n\n${nested}\n\nOutro\n`;
	const prompt = `\n\n## Routing\n\nrules\n\n${REMOTE_AUTHORIZATION}\n\n`;
	const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: prompt });
	assert.equal(result.content, `Intro\n\n${REMOTE_AUTHORIZATION}\n\nOutro\n`);
	assert.deepEqual(result.removedBlockNames, ["agent-routing"]);
});

test("the primary session keeps a policy-only orchestrator block the injected prompt lacks", async () => {
	const root = await mkdtemp(join(tmpdir(), "gentle-pi-managed-block-policy-"));
	const previous = new Map<string, string | undefined>();
	const home = join(root, "home");
	const cwd = join(home, "work", "project");
	await mkdir(cwd, { recursive: true });
	const fixtureEnvironment = {
		HOME: home, USERPROFILE: home,
		GENTLE_PI_CONFIG_HOME: join(root, "config"),
		GENTLE_PI_AGENT_HOME: join(root, "agents"),
		PI_CODING_AGENT_DIR: join(root, "pi"),
		XDG_CONFIG_HOME: join(root, "xdg"),
	};
	try {
		for (const [key, value] of Object.entries(fixtureEnvironment)) {
			previous.set(key, process.env[key]);
			process.env[key] = value;
		}
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(name, handler);
			},
			events: { emit() {} },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({
			nativeReviewCli: null,
			processEnv: { ...fixtureEnvironment, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" },
			resolveTelemetryTriggerBinary: () => join(root, "never-executed"),
			telemetryTriggerSpawn: () => assert.fail("the managed-block policy fixture must not spawn telemetry"),
		})(pi);
		const policy = `${POLICY_BLOCK}\n`;
		const contextFiles = [{ path: join(root, "AGENTS.md"), content: policy }];
		const systemPromptOptions = { appendSystemPrompt: "", contextFiles };
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify() {}, setWidget() {} },
			sessionManager: { getSessionId: () => "managed-block-policy", getBranch: () => [] },
		};
		await handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions }, ctx);
		assert.match(systemPromptOptions.appendSystemPrompt, /el Gentleman Identity and Harness/, "Gentle Shell's orchestrator is injected");
		assert.equal(systemPromptOptions.contextFiles[0].content, policy, "the user's orchestrator block survives the primary session");
		assert.match(systemPromptOptions.contextFiles[0].content, /4-file rule/);
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});

// The duplicate check compares line sets, not a normalized substring: a short
// block body that happens to occur inside a prompt line proves nothing about
// the prompt already carrying the block's policy.
test("ambiguous short prompt substring keeps user policy", () => {
	const content = "<!-- gentle-ai:orchestrator -->\ndo not\n<!-- /gentle-ai:orchestrator -->\n";
	const result = filterOrchestratorOnlyBlocks(content, { injectedPrompt: "Please do not delete things" });
	assert.equal(result.content, content);
	assert.deepEqual(result.removedBlockNames, []);
});

test("a multi-line block whose normalized lines all appear in the prompt is dropped in any order", () => {
	const body = ["alpha rule", "beta rule", "", "gamma rule"].join("\n");
	const input = `Intro\n\n${block("orchestrator", body)}\n\nOutro\n`;
	const prompt = ["Header", "", "gamma rule", "alpha   rule", "", "beta rule", "", "Footer"].join("\n");
	const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: prompt });
	assert.equal(result.content, "Intro\n\nOutro\n");
	assert.equal(result.removedBlocks, 1);
	assert.deepEqual(result.removedBlockNames, ["orchestrator"]);
});

test("a multi-line block with one line the prompt lacks is kept", () => {
	const body = ["alpha rule", "beta rule", "gamma rule"].join("\n");
	const input = `Before\n\n${block("orchestrator", body)}\n\nAfter\n`;
	const prompt = ["Header", "alpha rule", "beta rule", "a different gamma rule"].join("\n");
	const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: prompt });
	assert.equal(result.content, input, "one missing line means the block is not duplicated");
	assert.equal(result.removedBlocks, 0);
	assert.deepEqual(result.removedBlockNames, []);
});

// Intended boundary: the rule is line-based, not length-based, so a one-line
// body the prompt carries as its own line is a duplicate.
test("a one-line block the prompt carries as its own line is dropped", () => {
	const input = `Before\n\n${block("orchestrator", "Keep it short.")}\n\nAfter\n`;
	const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: "Header\nKeep it short.\nFooter" });
	assert.equal(result.content, "Before\n\nAfter\n");
	assert.deepEqual(result.removedBlockNames, ["orchestrator"]);
});

test("a block with no non-blank line is never treated as a duplicate", () => {
	const input = `Before\n\n<!-- gentle-ai:orchestrator -->\n\n   \n<!-- /gentle-ai:orchestrator -->\n\nAfter\n`;
	const result = filterOrchestratorOnlyBlocks(input, { injectedPrompt: "Before\n\nAfter" });
	assert.equal(result.content, input);
	assert.equal(result.removedBlocks, 0);
	assert.deepEqual(result.removedBlockNames, []);
});
