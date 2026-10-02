import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const agents = join(process.cwd(), "assets", "agents");
const roles: Record<string, string[]> = {
	"gentle-ai-explore.md": ["read", "grep", "find", "codegraph"],
	"gentle-ai-worker.md": ["read", "grep", "find", "edit", "write", "bash", "mem_save"],
	"gentle-ai-verify.md": ["read", "grep", "find", "bash"],
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

test("retired Pi adversarial role agents are not packaged", () => {
	for (const retired of ["review-refuter.md", "review-validator.md"]) {
		assert.equal(existsSync(join(agents, retired)), false);
	}
});
