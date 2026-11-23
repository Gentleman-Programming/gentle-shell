import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/skill-registry.ts";

const repoRoot = join(import.meta.dirname, "..");

function readSkillName(dir: string): string | undefined {
	const source = readFileSync(join(repoRoot, "skills", dir, "SKILL.md"), "utf8");
	return __testing.parseFrontmatter(source).name;
}

const PREFIXED_NAMES: Record<string, string> = {
	"branch-pr": "drakonc-ai-branch-pr",
	"chained-pr": "drakonc-ai-chained-pr",
	"cognitive-doc-design": "drakonc-ai-cognitive-doc-design",
	"comment-writer": "drakonc-ai-comment-writer",
	"issue-creation": "drakonc-ai-issue-creation",
	"judgment-day": "drakonc-ai-judgment-day",
	"provider-defect-report": "drakonc-ai-provider-defect-report",
	"rdd-defect-workflow": "drakonc-ai-rdd-defect-workflow",
	"skill-creator": "drakonc-ai-skill-creator",
	"skill-improver": "drakonc-ai-skill-improver",
	"skill-registry": "drakonc-ai-skill-registry",
	"work-unit-commits": "drakonc-ai-work-unit-commits",
};

// drakonc-pi-owned skills that drakonc-ai does not install keep their own
// drakonc- namespace, so they need no drakonc-ai- prefix to avoid a collision.
const UNPREFIXED_DIRS = ["drakonc-ai", "design"];

for (const [dir, expectedName] of Object.entries(PREFIXED_NAMES)) {
	test(`skills/${dir}/SKILL.md frontmatter name is prefixed`, () => {
		assert.equal(readSkillName(dir), expectedName);
	});
}

test("technical reference documents legacy skill-name compatibility aliases", () => {
	const readme = readFileSync(join(repoRoot, "docs", "readme-reference.md"), "utf8");
	for (const [legacyName, prefixedName] of [
		["branch-pr", "drakonc-ai-branch-pr"],
		["judgment-day", "drakonc-ai-judgment-day"],
		["skill-creator", "drakonc-ai-skill-creator"],
	] as const) {
		assert.match(readme, new RegExp(`former package names such as[\\s\\S]*${legacyName}`));
		assert.match(readme, new RegExp(`runtime skill selection should use[\\s\\S]*${prefixedName}`));
	}
});

for (const dir of UNPREFIXED_DIRS) {
	test(`skills/${dir}/SKILL.md frontmatter name carries no drakonc-ai- prefix`, () => {
		const name = readSkillName(dir);
		assert.ok(name, `expected a name for ${dir}`);
		assert.ok(!name?.startsWith("drakonc-ai-"), `${dir} should not be prefixed, got ${name}`);
	});
}
