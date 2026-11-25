import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// `codemode` is the only route that lets a child batch independent tool calls in
// one model turn and filter their output before it reaches its context, so every
// packaged agent that discovers, verifies, or implements declares it. The
// read-only review actors keep their narrow, deny-all allowlist: a script there
// would widen the sandbox of the lane whose job is to judge, not to act.
const ROOT = join(import.meta.dirname, "..");
const AGENTS_DIR = join(ROOT, "assets", "agents");

/** Agents whose unit of work is discovery, verification, or implementation. */
const CODEMODE_AGENTS = [
	"gentle-ai-explore.md",
	"gentle-ai-verify.md",
	"gentle-ai-worker.md",
	"jd-fix-agent.md",
] as const;

/** Adversarial read-only reviewers: they report findings and never act. */
const REVIEW_ACTOR_AGENTS = [
	"jd-judge-a.md",
	"jd-judge-b.md",
	"review-risk.md",
	"review-reliability.md",
	"review-resilience.md",
	"review-readability.md",
] as const;

const CODEMODE_TOOL = "codemode";

function readDeclaredTools(file: string): string[] {
	const text = readFileSync(join(AGENTS_DIR, file), "utf8");
	const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(frontmatter, `${file} must have YAML frontmatter`);
	const lines = frontmatter.split("\n");
	const toolsIndex = lines.findIndex((line) => line === "tools:");
	assert.notEqual(toolsIndex, -1, `${file} must declare tools as a YAML list`);
	const tools: string[] = [];
	for (const line of lines.slice(toolsIndex + 1)) {
		if (!line.startsWith("  - ")) break;
		tools.push(line.slice(4).trim().replace(/^['"]|['"]$/g, ""));
	}
	return tools;
}

test("packaged discovery, verification, and implementation agents declare codemode", () => {
	for (const file of CODEMODE_AGENTS) {
		const tools = readDeclaredTools(file);
		assert.ok(
			tools.includes(CODEMODE_TOOL),
			`${file} must declare ${CODEMODE_TOOL} so its child can batch tool calls in one turn`,
		);
	}
});

test("packaged read-only review actors keep a codemode-free allowlist", () => {
	for (const file of REVIEW_ACTOR_AGENTS) {
		const tools = readDeclaredTools(file);
		assert.ok(
			!tools.includes(CODEMODE_TOOL),
			`${file} is a read-only review actor: ${CODEMODE_TOOL} must not widen its deny-all allowlist`,
		);
	}
});

test("every packaged agent is classified for codemode", () => {
	const classified = new Set<string>([...CODEMODE_AGENTS, ...REVIEW_ACTOR_AGENTS]);
	const packaged = readdirSync(AGENTS_DIR).filter((entry) => entry.endsWith(".md"));
	assert.ok(packaged.length > 0, "gentle-pi must ship packaged agents");
	for (const file of packaged) {
		assert.ok(
			classified.has(file),
			`${file} is not classified for ${CODEMODE_TOOL}: add it to CODEMODE_AGENTS or REVIEW_ACTOR_AGENTS`,
		);
	}
});
