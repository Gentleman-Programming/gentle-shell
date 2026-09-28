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
	"branch-pr": "gentle-ai-branch-pr",
	"chained-pr": "gentle-ai-chained-pr",
	"cognitive-doc-design": "gentle-ai-cognitive-doc-design",
	"comment-writer": "gentle-ai-comment-writer",
	"issue-creation": "gentle-ai-issue-creation",
	"judgment-day": "gentle-ai-judgment-day",
	"rdd-defect-workflow": "gentle-ai-rdd-defect-workflow",
	"skill-creator": "gentle-ai-skill-creator",
	"skill-improver": "gentle-ai-skill-improver",
	"skill-registry": "gentle-ai-skill-registry",
	"work-unit-commits": "gentle-ai-work-unit-commits",
};

const UNPREFIXED_DIRS = ["gentle-ai"];

for (const [dir, expectedName] of Object.entries(PREFIXED_NAMES)) {
	test(`skills/${dir}/SKILL.md frontmatter name is prefixed`, () => {
		assert.equal(readSkillName(dir), expectedName);
	});
}

test("technical reference documents legacy skill-name compatibility aliases", () => {
	const readme = readFileSync(join(repoRoot, "docs", "readme-reference.md"), "utf8");
	for (const [legacyName, prefixedName] of [
		["branch-pr", "gentle-ai-branch-pr"],
		["judgment-day", "gentle-ai-judgment-day"],
		["skill-creator", "gentle-ai-skill-creator"],
	] as const) {
		assert.match(readme, new RegExp(`former package names such as[\\s\\S]*${legacyName}`));
		assert.match(readme, new RegExp(`runtime skill selection should use[\\s\\S]*${prefixedName}`));
	}
});

for (const dir of UNPREFIXED_DIRS) {
	test(`skills/${dir}/SKILL.md frontmatter name carries no gentle-ai- prefix`, () => {
		const name = readSkillName(dir);
		assert.ok(name, `expected a name for ${dir}`);
		assert.ok(!name?.startsWith("gentle-ai-"), `${dir} should not be prefixed, got ${name}`);
	});
}
