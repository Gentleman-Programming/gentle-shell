import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const agents = join(process.cwd(), "assets", "agents");
const roles: Record<string, string[]> = {
	"gentle-ai-explore.md": ["read", "grep", "find", "codegraph"],
	"gentle-ai-worker.md": ["read", "grep", "find", "edit", "write", "bash", "mem_save"],
	"gentle-ai-verify.md": ["read", "grep", "find", "bash"],
	"gentle-ai-security.md": ["read", "grep", "find", "edit", "write", "bash", "mem_save"],
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

test("generic ODD agents declare exact role tool allowlists without child delegation", () => {
	for (const [file, expected] of Object.entries(roles)) {
		assert.ok(existsSync(join(agents, file)), `${file} must exist`);
		assert.deepEqual(tools(file), expected);
		assert.ok(tools(file).every(tool => !tool.startsWith("subagent_")));
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
});

test("ODD security agent is confined to test files and static rules and hands production fixes to worker", () => {
	const security = readFileSync(join(agents, "gentle-ai-security.md"), "utf8");
	assert.match(security, /Sec-TDD/);
	assert.match(security, /Allowed edit surfaces/i);
	assert.match(security, /Never edit production code/i);
	assert.match(security, /worker/i);
});

test("ODD security agent prompts for separate document only on severe verified vulnerabilities without blocking remediation", () => {
	const security = readFileSync(join(agents, "gentle-ai-security.md"), "utf8");
	assert.match(security, /(?:CRITICAL|HIGH)/);
	assert.match(security, /vulnerability document|standalone vulnerability/i);
	assert.match(security, /opt-in|user decision|consent|prompt the user|ask the user/i);
	assert.match(security, /never (?:be )?generated automatically|not (?:be )?generated automatically/i);
	assert.match(security, /declin(?:e|ing).*not block(?:ing)? (?:remediation|test)/i);
	assert.match(security, /(?:MEDIUM|LOW|INFO).*not prompt/i);
	assert.match(security, /document_request/);
});

test("retired Pi adversarial role agents are not packaged", () => {
	for (const retired of ["review-refuter.md", "review-validator.md"]) {
		assert.equal(existsSync(join(agents, retired)), false);
	}
});
