import assert from "node:assert/strict";
import test from "node:test";
import {
	filterChildContextFiles,
	filterChildSessionContextFiles,
	ORCHESTRATOR_ONLY_MANAGED_BLOCKS,
	stripOrchestratorOnlyBlocks,
} from "../lib/child-context-files.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childContextExtension, { createChildContextExtension } from "../extensions/child-context.ts";

function block(name: string, body: string): string {
	return `<!-- gentle-ai:${name} -->\n${body}\n<!-- /gentle-ai:${name} -->`;
}

// Synthetic file shaped like a gentle-ai managed AGENTS.md: unmanaged project
// text, kept blocks, orchestrator-only blocks, a nested kept block inside
// agent-routing, and a nested orchestrator-only block inside sdd-orchestrator.
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
	block("engram-protocol", "## Engram\n\nSave decisions."),
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
	assert.match(output, /<!-- gentle-ai:remote-authorization -->\n## Remote operation authorization/);
});

test("keeps codegraph-guidance, engram-protocol, and unknown managed blocks byte-for-byte", () => {
	const input = [
		block("codegraph-guidance", "cg"),
		block("engram-protocol", "engram\n\n\n\nspacing kept"),
		block("some-future-block", "future"),
		"",
	].join("\n");
	assert.equal(stripOrchestratorOnlyBlocks(input), input);
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
	assert.equal(result.removedBlocks, 3, "sdd-orchestrator, its nested sdd-model-assignments, and agent-routing");
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
