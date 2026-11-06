import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import {
	createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
	getDocsPath, getExamplesPath, getReadmePath, loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import gentleAgents from "../extensions/gentle-agents.ts";
import { __testing } from "../extensions/gentle-ai.ts";
import { BACKGROUND_SUBAGENTS_FILE, BACKGROUND_SUBAGENTS_SCHEMA } from "../lib/background-subagents-policy.ts";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";

const root = join(import.meta.dirname, "..");
const assets = join(root, "assets");
const fixture = mkdtempSync(join(tmpdir(), "prompt-budget-"));
const policyDirectory = join(fixture, ".pi", "gentle-ai");
mkdirSync(policyDirectory, { recursive: true });
writeFileSync(join(policyDirectory, BACKGROUND_SUBAGENTS_FILE), JSON.stringify({ schema: BACKGROUND_SUBAGENTS_SCHEMA, policy: "off" }));
after(() => rmSync(fixture, { recursive: true, force: true }));
const core = __testing.renderOrchestratorPrompt(assets).replaceAll(assets, "/fixture/assets");

type Declaration = { name: string; description: string; parameters: unknown; promptSnippet?: string; promptGuidelines?: string[] };
const tools = new Map<string, Declaration>();
const pi = {
	on() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
	events: { on() {}, emit() {} },
	registerTool(tool: Declaration) { tools.set(tool.name, tool); },
};
gentleAgents(pi as never, { GENTLE_PI_CONFIG_HOME: fixture }, { home: fixture, agentHome: fixture });
const names = ["orchestrator_session_id", "orchestrator_list", "subagent_run"];
const selected = names.map(name => {
	const tool = tools.get(name);
	assert.ok(tool, `missing registered tool ${name}`);
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
});
const declarationBytes = Buffer.byteLength(JSON.stringify(selected), "utf8");

function withoutDescriptions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutDescriptions);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
			.map(([key, entry]) => [key, withoutDescriptions(entry)]));
	}
	return value;
}

test("rendered orchestrator core and selected declarations fit the byte budget", t => {
	const prompt = Buffer.byteLength(core, "utf8");
	const total = prompt + declarationBytes;
	t.diagnostic(`rendered core ${prompt} B + declarations ${declarationBytes} B = ${total} B`);
	assert.ok(total <= 16600, `rendered core ${prompt} B + declarations ${declarationBytes} B = ${total} B`);
});

// Pi 1.4 does not export its pure system assembler from the package root.
// Deliberately use its installed internal module for this test; a missing or
// changed seam must fail rather than silently falling back to a proxy.
test("fixed primary host system assembly fits the byte budget", async t => {
	const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const assembler = await import(pathToFileURL(join(dist, "core", "system-prompt.js")).href);
	assert.equal(typeof assembler.buildSystemPrompt, "function", "Pi system assembler unavailable");
	const activeTools = ["read", "bash", "edit", "write", ...names];
	const harness = __testing.buildGentlePrompt("gentleman", fixture, activeTools, undefined, "tui");
	assert.match(harness, /Background subagent policy: off/);
	assert.match(harness, /Receipt-driven development: unknown \(native status unavailable\)/);
	const review = __testing.readMirroredReviewContractFragment();
	assert.ok(review, "verified mirrored review fragment must be present");
	const { skills, diagnostics } = loadSkillsFromDir({ dir: join(root, "skills", "work-unit-commits"), source: "fixture" });
	assert.equal(diagnostics.length, 0);
	assert.equal(skills.length, 1);
	const builtins = [createReadToolDefinition(fixture), createBashToolDefinition(fixture), createEditToolDefinition(fixture), createWriteToolDefinition(fixture)];
	const registered = [...builtins, ...names.map(name => tools.get(name)!)];
	const toolSnippets = Object.fromEntries(registered.filter(tool => tool.promptSnippet).map(tool => [tool.name, tool.promptSnippet]));
	const toolGuidelines = Object.fromEntries(registered.filter(tool => tool.promptGuidelines).map(tool => [tool.name, tool.promptGuidelines]));
	const options = { appendSystemPrompt: "" };
	appendSystemPromptOnce(options, `\n\n${harness}`);
	appendSystemPromptOnce(options, `\n\n${review}`);
	const system: string = assembler.buildSystemPrompt({
		cwd: fixture, selectedTools: activeTools, toolSnippets, toolGuidelines,
		...options, skills,
	});
	for (const [label, fragment] of [["harness", harness], ["review contract", review]]) {
		assert.equal(system.split(fragment.replace(/^\n+/, "")).length - 1, 1, `complete ${label} must appear exactly once`);
	}
	const replacements: Array<[string, string]> = [
		[getReadmePath(), "/fixture/pi/README.md"], [getDocsPath(), "/fixture/pi/docs"],
		[getExamplesPath(), "/fixture/pi/examples"], [assets, "/fixture/assets"],
		[join(root, "skills"), "/fixture/skills"], [fixture, "/fixture/cwd"],
		[dirname(dist), "/fixture/pi"],
	];
	let normalized = system;
	for (const [path, replacement] of replacements) {
		normalized = normalized.replaceAll(path, replacement).replaceAll(path.replaceAll("\\", "/"), replacement);
	}
	const bytes = Buffer.byteLength(normalized, "utf8");
	t.diagnostic(`assembled system ${bytes} B; selected declarations ${declarationBytes} B`);
	assert.ok(bytes <= 40000, `assembled system: ${bytes} B`);
});

test("fixed harness is independent of ambient background policy", () => {
	const previous = process.env.GENTLE_PI_BACKGROUND_SUBAGENTS;
	const activeTools = ["read", "bash", "edit", "write", ...names];
	const rendered: string[] = [];
	try {
		for (const policy of ["off", "on"]) {
			process.env.GENTLE_PI_BACKGROUND_SUBAGENTS = policy;
			const harness = __testing.buildGentlePrompt("gentleman", fixture, activeTools, undefined, "tui");
			assert.match(harness, /Background subagent policy: off/);
			rendered.push(harness);
		}
		assert.equal(rendered[0], rendered[1]);
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_BACKGROUND_SUBAGENTS;
		else process.env.GENTLE_PI_BACKGROUND_SUBAGENTS = previous;
	}
});

const schemaDigests: Record<string, string> = {
	orchestrator_session_id: "5fb49381808a8dc1146d89409ba6237380b62c871282a99104770b24902589e0",
	orchestrator_list: "fe50d306a023bfaf20fddeb8696a3e62b84534b02efb6d699f9991b129a709fa",
	subagent_run: "02e15acc80fde692b0e7ceab434c248b733f33783b176606119969952cd16036",
};
for (const tool of selected) {
	test(`${tool.name} schema retains its non-description contract`, () => {
		const digest = createHash("sha256").update(JSON.stringify(withoutDescriptions(tool.parameters))).digest("hex");
		assert.equal(digest, schemaDigests[tool.name]);
	});
}
