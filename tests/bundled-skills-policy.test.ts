import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ALL_BUNDLED_SKILLS,
	DEFAULT_ENABLED_BUNDLED_SKILLS,
	filterBundledSystemPromptSkills,
	resolveBundledSkillsPolicy,
	writeBundledSkillsPolicy,
} from "../lib/bundled-skills-policy.ts";

test("bundled skills exclude the 8 heavy/meta skills by default while keeping the 7 core ones", (t) => {
	const home = mkdtempSync(join(tmpdir(), "bundled-skills-default-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));

	const resolved = resolveBundledSkillsPolicy({ gentlePiConfigHome: home });
	assert.deepEqual(resolved.enabled, [...DEFAULT_ENABLED_BUNDLED_SKILLS]);
	for (const excluded of [
		"design",
		"gentle-ui-design",
		"issue-creation",
		"rdd-defect-workflow",
		"skill-creator",
		"skill-improver",
		"skill-registry",
		"tui-design",
	]) {
		assert.equal(resolved.enabled.includes(excluded as never), false, `${excluded} should be excluded by default`);
	}
	assert.equal(ALL_BUNDLED_SKILLS.length, 15);
});

test("filterBundledSystemPromptSkills keeps enabled bundled skills and non-bundled skills", (t) => {
	const home = mkdtempSync(join(tmpdir(), "bundled-skills-filter-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const bundledRoot = "/pkg/gentle-pi/skills";

	const options = {
		skills: [
			{ name: "gentle-ai-branch-pr", filePath: `${bundledRoot}/branch-pr/SKILL.md` },
			{ name: "gentle-design", filePath: `${bundledRoot}/design/SKILL.md` },
			{ name: "gentle-ai-skill-creator", filePath: `${bundledRoot}/skill-creator/SKILL.md` },
			{ name: "custom-project-skill", filePath: "/project/.pi/skills/custom/SKILL.md" },
		],
	};

	filterBundledSystemPromptSkills(options, bundledRoot, { gentlePiConfigHome: home });
	assert.deepEqual(
		options.skills.map((s) => s.name),
		["gentle-ai-branch-pr", "custom-project-skill"],
	);

	writeBundledSkillsPolicy(["design"], { gentlePiConfigHome: home });
	const reenabled = {
		skills: [
			{ name: "gentle-ai-branch-pr", filePath: `${bundledRoot}/branch-pr/SKILL.md` },
			{ name: "gentle-design", filePath: `${bundledRoot}/design/SKILL.md` },
		],
	};
	filterBundledSystemPromptSkills(reenabled, bundledRoot, { gentlePiConfigHome: home });
	assert.deepEqual(
		reenabled.skills.map((s) => s.name),
		["gentle-design"],
	);
});
