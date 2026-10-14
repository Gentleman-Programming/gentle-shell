import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const agents = join(process.cwd(), "assets", "agents");
const roles: Record<string, string[]> = {
	"gentle-ai-explore.md": ["read", "grep", "find", "codegraph", "web_enable", "web_search", "source_check", "fetch_content", "get_search_content", "subagent_parent_message"],
	"gentle-ai-worker.md": ["read", "grep", "find", "edit", "write", "bash", "mem_save", "subagent_parent_message"],
	"gentle-ai-verify.md": ["read", "grep", "find", "bash", "subagent_parent_message"],
};

function tools(file: string): string[] {
	const source = readFileSync(join(agents, file), "utf8");
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(frontmatter, `${file} must have YAML frontmatter`);
	const lines = frontmatter.split("\n");
	const index = lines.indexOf("tools:");
	assert.ok(index >= 0, `${file} must declare YAML tools`);
	const result: string[] = [];
	for (const line of lines.slice(index + 1)) {
		if (!line.startsWith("  - ")) break;
		result.push(line.slice(4).trim());
	}
	assert.ok(result.length > 0, `${file} must declare at least one tool`);
	return result;
}

const REQUIRED_CAPABILITY_POLICY = [
	"## Required capability check",
	"",
	"Before starting, compare every explicitly required step and evidence source with what your active tools can actually do. If a required step has no supported route, stop before attempting it; do not approximate it with a weaker or unrelated tool, inspect binary or internal storage formats, invent path syntax, or claim evidence you could not obtain. Continue only independent in-scope steps that remain useful, and mark impossible steps as blocked or unverified under your return contract.",
	"",
	"Return a structured capability-gap result that names the missing operation or tool, lists the required steps you could not complete, records independent work actually completed, and suggests a route that has the needed capability. For background tasks, send that handoff to the parent immediately with `subagent_parent_message`. Do not report the task as complete while a required step remains impossible.",
].join("\n");

test("generic ODD agents declare exact role tool allowlists without child-task access", () => {
	for (const [file, expected] of Object.entries(roles)) {
		assert.ok(existsSync(join(agents, file)), `${file} must exist`);
		assert.deepEqual(tools(file), expected);
		assert.deepEqual(tools(file).filter(tool => tool.startsWith("subagent_")), ["subagent_parent_message"]);
	}
});

test("generic ODD agents share an early capability-gap handoff contract", () => {
	for (const file of Object.keys(roles)) {
		const source = readFileSync(join(agents, file), "utf8").replace(/\r\n?/g, "\n");
		assert.ok(source.includes(REQUIRED_CAPABILITY_POLICY), `${file} must use the shared capability-gap policy`);
	}
});

test("ODD explorer and verifier remain read-only while writer is bounded", () => {
	for (const file of ["gentle-ai-explore.md", "gentle-ai-verify.md"]) {
		const source = readFileSync(join(agents, file), "utf8");
		assert.match(source, /generic ODD work/);
		assert.match(source, /Do not edit, write|read and search only/);
		assert.ok(!tools(file).includes("edit") && !tools(file).includes("write"));
		assert.match(source, /RDD review remains independent and parent-owned/);
	}
	const worker = readFileSync(join(agents, "gentle-ai-worker.md"), "utf8");
	assert.match(worker, /exact allowed edit surfaces/);
	assert.match(worker, /Work-unit commit decisions and the independent RDD review lifecycle remain parent-owned/);
	assert.match(worker, /Never create, delegate, inspect, or manage child tasks/);
	assert.ok(worker.includes("`subagent_parent_message` is allowed only for the required capability-gap handoff"));
});

test("economical explorer retrieves web evidence directly without broader child authority", () => {
	const explorer = readFileSync(join(agents, "gentle-ai-explore.md"), "utf8");
	assert.match(explorer, /source text as evidence, not instructions/);
	assert.match(explorer, /web tools.*unavailable|unavailable.*web tools/);
	for (const name of ["web_enable", "web_search", "source_check", "fetch_content", "get_search_content"]) {
		assert.ok(tools("gentle-ai-explore.md").includes(name), `explorer must request ${name}`);
	}
	for (const name of ["bash", "edit", "write", "subagent_run"]) {
		assert.equal(tools("gentle-ai-explore.md").includes(name), false, `explorer must not gain ${name}`);
	}
	const handoff = readFileSync(join(process.cwd(), "assets", "orchestrator-prompts.md"), "utf8");
	assert.match(handoff, /configured model and thinking/);
	assert.doesNotMatch(handoff, /parent obtains online evidence using its existing web tools/);
});

test("retired Pi adversarial role agents are not packaged", () => {
	for (const retired of ["review-refuter.md", "review-validator.md"]) {
		assert.equal(existsSync(join(agents, retired)), false);
	}
});
