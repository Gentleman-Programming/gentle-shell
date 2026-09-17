import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const assetsAgentsDir = join(repoRoot, "assets", "agents");
const GENERIC_ROLE_TOOLS: Record<string, string[]> = {
	"gentle-ai-explore.md": ["read", "grep", "find", "codegraph"],
	"gentle-ai-worker.md": ["read", "grep", "find", "edit", "write", "bash", "mem_save"],
	"gentle-ai-verify.md": ["read", "grep", "find", "bash"],
};

function readFrontmatter(path: string): string {
	const text = readFileSync(path, "utf8");
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, `${path} must have YAML frontmatter`);
	return match[1];
}

function readTools(path: string): string[] {
	const frontmatter = readFrontmatter(path);
	const lines = frontmatter.split("\n");
	const toolsIndex = lines.findIndex((line) => line === "tools:");
	assert.notEqual(toolsIndex, -1, `${path} must declare tools as a YAML array`);

	const scalarTools = lines.find((line) => /^tools:\s+/.test(line));
	assert.equal(scalarTools, undefined, `${path} must not declare scalar comma-separated tools`);

	const tools: string[] = [];
	for (const line of lines.slice(toolsIndex + 1)) {
		if (!line.startsWith("  - ")) break;
		tools.push(line.slice(4).trim());
	}
	assert.ok(tools.length > 0, `${path} must declare at least one tool`);
	return tools;
}

function assertGenericRoleBody(fileName: string, source: string): void {
	assert.match(source, /generic non-SDD work/);
	assert.match(source, /Do not (?:fix findings, delegate to child agents|delegate to child agents, commit)/);
	assert.match(source, /Do not (?:edit, write|edit, write, or fix findings)/);
	assert.match(source, /compressed (?:handoff|evidence handoff)/);
	assert.match(source, /supporting (?:paths|evidence)/);
	assert.match(source, /Do not use SDD phase protocols or review lenses\./);

	if (fileName === "gentle-ai-explore.md") {
		assert.match(source, /sole permitted mutation/);
		assert.match(source, /all tracked files, source files, and other project content remain read-only/);
		assert.match(source, /CodeGraph reports that it is unavailable or fails/);
		assert.match(source, /Do not use that fallback before CodeGraph is unavailable or fails/);
	}

	if (fileName === "gentle-ai-verify.md") {
		assert.match(source, /execute only exact test, build, or lint commands explicitly authorized by the parent/);
		assert.match(source, /only outputs the parent explicitly identified as expected/);
		assert.match(source, /unexpected mutation as a blocker/);
		assert.match(source, /report it, but do not clean it up or fix it/);
	}
}

const requiredToolsByAgent: Record<string, string[]> = {
	"sdd-apply.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save", "mem_update"],
	"sdd-archive.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-design.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-explore.md": ["read", "grep", "find", "edit", "write", "mem_save"],
	"sdd-init.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save", "mem_update"],
	"sdd-onboard.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save", "mem_update"],
	"sdd-proposal.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-research.md": [ "fetch_content", "web_search", "source_check", "get_search_content"],
	"sdd-spec.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-status.md": ["read", "grep", "find", "bash", "mem_search", "mem_get_observation"],
	"sdd-tasks.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-verify.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save"],
};

test("SDD package agents declare role-appropriate tools as YAML arrays", () => {
	for (const [fileName, requiredTools] of Object.entries(requiredToolsByAgent)) {
		const path = join(assetsAgentsDir, fileName);
		assert.ok(existsSync(path), `${fileName} must exist`);
		const tools = readTools(path);
		for (const tool of requiredTools) {
			assert.ok(tools.includes(tool), `${fileName} must include ${tool}`);
		}
		for (const tool of tools) {
			assert.ok(!tool.startsWith("subagent_"), `${fileName} must not allow child subagent tool ${tool}`);
		}
	}
});

test("artifact-producing SDD agents can persist OpenSpec files while status remains read-only", () => {
	for (const fileName of Object.keys(requiredToolsByAgent).filter(
		(fileName) => !["sdd-status.md", "sdd-research.md"].includes(fileName),
	)) {
		const tools = readTools(join(assetsAgentsDir, fileName));
		assert.ok(tools.includes("edit"), `${fileName} must include edit`);
		assert.ok(tools.includes("write"), `${fileName} must include write`);
	}

	assert.deepEqual(readTools(join(assetsAgentsDir, "sdd-research.md")), requiredToolsByAgent["sdd-research.md"]);
	const statusTools = readTools(join(assetsAgentsDir, "sdd-status.md"));
	assert.ok(!statusTools.includes("edit"), "sdd-status.md must remain read-only");
	assert.ok(!statusTools.includes("write"), "sdd-status.md must remain read-only");
});

test("research instructions require executed evidence rather than blanket denial", () => {
	const source = readFileSync(join(assetsAgentsDir, "sdd-research.md"), "utf8");
	assert.doesNotMatch(source, /documentation=\[\]; open-web=\[\]/);
	assert.match(source, /Actually call approved tools/);
	assert.match(source, /claim maps to source IDs/);
	assert.match(source, /partial or unavailable research is not a failed proposal gate/);
	assert.ok(!readTools(join(assetsAgentsDir, "sdd-research.md")).includes("bash"));
});

test("project does not ship local SDD agent overrides", () => {
	for (const relativeDir of [join(".pi", "agents"), join(".pi", "subagents")]) {
		const dir = join(repoRoot, relativeDir);
		if (!existsSync(dir)) continue;
		const overrides = readdirSync(dir).filter((entry) => /^sdd-.*\.md$/i.test(entry));
		assert.deepEqual(overrides, [], `${relativeDir} must not shadow package SDD agents`);
	}
});

test("generic non-SDD agents declare exact role tool allowlists", () => {
	for (const [fileName, expectedTools] of Object.entries(GENERIC_ROLE_TOOLS)) {
		const path = join(assetsAgentsDir, fileName);
		assert.ok(existsSync(path), `${fileName} must exist`);
		assert.deepEqual(readTools(path), expectedTools);
		if (fileName !== "gentle-ai-worker.md") {
			assertGenericRoleBody(fileName, readFileSync(path, "utf8"));
		}
	}
});

test("optional verification retains practical evidence without retired attestation admission", () => {
	const agent = readFileSync(join(assetsAgentsDir, "sdd-verify.md"), "utf8");
	const chain = readFileSync(join(repoRoot, "assets/chains/sdd-verify.chain.md"), "utf8");
	for (const source of [agent, chain]) {
		assert.doesNotMatch(source, /sdd-verify-validate|gentle-ai\.verify-result\/v1/);
		assert.match(source, /commands/);
		assert.match(source, /blockers/);
	}
	assert.match(agent, /strict TDD compliance/);
	assert.match(agent, /exit codes/);
	assert.match(agent, /never fabricate PASS/);
	assert.match(chain, /does not make verification mandatory/);
});

test("the retired Pi adversarial role agents are not packaged", () => {
	// gentle-pi#311 P5: the refuter and targeted validator verdicts execute
	// through Go-owned pi processes via provider-rendered self-contained
	// vectors; no Pi agent definition may reintroduce a Pi-authored verdict.
	for (const retired of ["review-refuter.md", "review-validator.md"]) {
		assert.ok(!existsSync(join(assetsAgentsDir, retired)), `${retired} must stay deleted`);
	}
});
