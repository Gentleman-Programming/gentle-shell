import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { __testing } from "../extensions/skill-registry.ts";

test("project skill dirs include supported workspace roots", () => {
	const cwd = "/repo";
	const dirs = __testing.projectSkillDirs(cwd);
	for (const want of [
		"skills",
		".opencode/skills",
		".claude/skills",
		".gemini/skills",
		".trae/skills",
		".cursor/skills",
		".github/skills",
		".codex/skills",
		".qwen/skills",
		".kiro/skills",
		".openclaw/skills",
		".pi/skills",
		".agent/skills",
		".agents/skills",
		".atl/skills",
	]) {
		assert.ok(dirs.includes(join(cwd, want)), `missing ${want}`);
	}
});

test("registry renders indexed skill paths instead of compact rules", () => {
	const cwd = join(tmpdir(), `gentle-pi-render-${Date.now()}`);
	const skillPath = join(cwd, "skills", "go-testing", "SKILL.md");
	const registry = __testing.renderRegistry(cwd, ["skills"], [
		{
			name: "go-testing",
			path: skillPath,
			description: "Trigger: Go tests. Apply focused testing patterns.",
		},
	]);

	assert.match(registry, /## Skills/);
	assert.match(registry, /\| Skill \| Trigger \/ description \| Scope \| Path \|/);
	assert.match(registry, /## Loading protocol/);
	assert.match(registry, /\| `go-testing` \| Trigger: Go tests\. Apply focused testing patterns\. \| project \|/);
	assert.match(registry, new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(registry, /Selected skills and compact rules/);
	assert.doesNotMatch(registry, /Project Standards \(auto-resolved\)/);
	assert.doesNotMatch(registry, /Rules:/);
});

test("frontmatter parser accepts CRLF line endings", () => {
	const parsed = __testing.parseFrontmatter("---\r\nname: windows-skill\r\ndescription: >\r\n  Trigger: Windows-authored skills.\r\n  Preserve frontmatter metadata.\r\n---\r\n\r\n## Body\r\n");

	assert.equal(parsed.name, "windows-skill");
	assert.equal(
		parsed.description,
		"Trigger: Windows-authored skills. Preserve frontmatter metadata.",
	);
	assert.match(parsed.body, /## Body/);
});

test("frontmatter parser keeps full multiline descriptions", () => {
	const parsed = __testing.parseFrontmatter(`---
name: ai-sdk-5
description: >
  Trigger: AI chat features, Vercel AI SDK 5, streaming UI.
  Use AI SDK 5 patterns and avoid v4 APIs.
license: Apache-2.0
---

## Hard Rules

- Do not copy this rule.
`);

	assert.equal(parsed.name, "ai-sdk-5");
	assert.equal(
		parsed.description,
		"Trigger: AI chat features, Vercel AI SDK 5, streaming UI. Use AI SDK 5 patterns and avoid v4 APIs.",
	);
});

test("description normalization preserves trigger and collapses whitespace", () => {
	assert.equal(
		__testing.normalizeSkillDescription("Trigger: PR feedback, issue replies.\nUse maintainer voice."),
		"Trigger: PR feedback, issue replies. Use maintainer voice.",
	);
});

test("project-scoped duplicate wins over user duplicate", () => {
	const cwd = join(tmpdir(), `gentle-pi-registry-${Date.now()}`);
	const projectPath = join(cwd, ".opencode/skills/dup/SKILL.md");
	const userPath = join(cwd + "-home", ".config/opencode/skills/dup/SKILL.md");
	const entries = [
		{ name: "dup", path: userPath, description: "user" },
		{ name: "dup", path: projectPath, description: "project" },
	];

	const [chosen] = __testing.dedupeBySkillName(entries, cwd);
	assert.equal(chosen.path, projectPath);
});

test("uniqueExistingDirs normalizes duplicates and ignores missing roots", async () => {
	const root = join(tmpdir(), `gentle-pi-existing-${Date.now()}`);
	const existing = join(root, "skills");
	mkdirSync(existing, { recursive: true });

	assert.deepEqual(
		await __testing.uniqueExistingDirs([existing, join(root, "skills/"), join(root, "missing")]),
		[existing],
	);
});

test("findSkillFiles scans flat skills and category-nested skills without descending further", async () => {
	const root = join(tmpdir(), `gentle-pi-shallow-${Date.now()}`);
	const skillPath = join(root, "docs", "SKILL.md");
	const nestedSkillPath = join(root, "fixtures", "nested", "SKILL.md");
	const deeperSkillPath = join(root, "fixtures", "nested", "deeper", "SKILL.md");
	mkdirSync(dirname(skillPath), { recursive: true });
	mkdirSync(dirname(nestedSkillPath), { recursive: true });
	mkdirSync(dirname(deeperSkillPath), { recursive: true });
	writeFileSync(skillPath, "---\nname: docs\ndescription: Docs.\n---\n");
	writeFileSync(nestedSkillPath, "---\nname: nested\ndescription: Nested fixture.\n---\n");
	writeFileSync(deeperSkillPath, "---\nname: deeper\ndescription: Deeper fixture.\n---\n");

	assert.deepEqual(await __testing.findSkillFiles(root), [skillPath, nestedSkillPath]);
});

test("findSkillFiles keeps direct skills ahead of alphabetically earlier nested collisions", async () => {
	const cwd = join(tmpdir(), `gentle-pi-precedence-${Date.now()}`);
	const directSkillPath = join(cwd, "skills", "zeta", "SKILL.md");
	const nestedSkillPath = join(cwd, "skills", "alpha", "duplicate", "SKILL.md");
	mkdirSync(dirname(directSkillPath), { recursive: true });
	mkdirSync(dirname(nestedSkillPath), { recursive: true });
	writeFileSync(directSkillPath, "---\nname: duplicate\ndescription: Direct skill.\n---\n");
	writeFileSync(nestedSkillPath, "---\nname: duplicate\ndescription: Nested skill.\n---\n");

	await __testing.regenerateRegistry(cwd, true);
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.match(registry, new RegExp(directSkillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(registry, new RegExp(nestedSkillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("findSkillFiles does not descend into excluded categories", async () => {
	const root = join(tmpdir(), `gentle-pi-excluded-category-${Date.now()}`);
	for (const category of ["_shared", "skill-registry", "sdd-fixtures"]) {
		const nestedSkillPath = join(root, category, "hidden", "SKILL.md");
		mkdirSync(dirname(nestedSkillPath), { recursive: true });
		writeFileSync(nestedSkillPath, "---\nname: hidden\ndescription: Hidden skill.\n---\n");
	}

	assert.deepEqual(await __testing.findSkillFiles(root), []);
});

test("findSkillFiles follows direct symlinked skills but not symlinked categories", async (t) => {
	const root = join(tmpdir(), `gentle-pi-symlink-root-${Date.now()}`);
	const realSkillDir = join(tmpdir(), `gentle-pi-symlink-target-${Date.now()}`);
	const categoryTarget = join(tmpdir(), `gentle-pi-symlink-category-${Date.now()}`);
	const linkedSkillDir = join(root, "linked");
	const skillPath = join(linkedSkillDir, "SKILL.md");
	mkdirSync(root, { recursive: true });
	mkdirSync(realSkillDir, { recursive: true });
	mkdirSync(join(categoryTarget, "nested"), { recursive: true });
	writeFileSync(join(realSkillDir, "SKILL.md"), "---\nname: linked\ndescription: Linked skill.\n---\n");
	writeFileSync(join(categoryTarget, "nested", "SKILL.md"), "---\nname: nested\ndescription: Nested skill.\n---\n");
	try {
		symlinkSync(realSkillDir, linkedSkillDir, "dir");
		symlinkSync(categoryTarget, join(root, "category"), "dir");
	} catch (error) {
		t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	assert.deepEqual(await __testing.findSkillFiles(root), [skillPath]);
});

test("only missing skill-file errors allow category scanning", () => {
	assert.equal(__testing.isMissingSkillFileError({ code: "ENOENT" }), true);
	assert.equal(__testing.isMissingSkillFileError({ code: "ENOTDIR" }), true);
	assert.equal(__testing.isMissingSkillFileError({ code: "EACCES" }), false);
});

test("skill registry watchers close on shutdown", async () => {
	const root = join(tmpdir(), `gentle-pi-watchers-${Date.now()}`);
	const skillPath = join(root, "skills", "docs", "SKILL.md");
	mkdirSync(dirname(skillPath), { recursive: true });
	writeFileSync(skillPath, "---\nname: docs\ndescription: Docs.\n---\n");

	await __testing.startSkillRegistryWatcher(root, () => undefined);
	const attempted = __testing.activeWatcherCount();
	__testing.closeSkillRegistryWatchers();
	assert.equal(__testing.activeWatcherCount(), 0);

	await __testing.startSkillRegistryWatcher(root, () => undefined);
	assert.equal(
		__testing.activeWatcherCount(),
		attempted,
		"shutdown must clear watched cwd state so a later session can re-watch",
	);
	__testing.closeSkillRegistryWatchers();
});

test("startup skip honors no skill registry controls", () => {
	const enabled = { getFlag: () => true };
	const disabled = { getFlag: () => false };

	assert.equal(__testing.shouldSkipSkillRegistryStartup(enabled, [], {}), true);
	assert.equal(__testing.shouldSkipSkillRegistryStartup(disabled, ["--no-skills"], {}), true);
	assert.equal(__testing.shouldSkipSkillRegistryStartup(disabled, ["-ns"], {}), true);
	assert.equal(
		__testing.shouldSkipSkillRegistryStartup(disabled, [], { GENTLE_PI_NO_SKILL_REGISTRY: "1" }),
		true,
	);
	assert.equal(__testing.shouldSkipSkillRegistryStartup(disabled, [], {}), false);
});

test("duplicate extension load is skipped only across different sources", () => {
	const state = {};

	assert.equal(
		__testing.shouldSkipDuplicateExtensionLoad("file:///repo/extensions/skill-registry.ts?first", "/workspace", state),
		false,
	);
	assert.equal(
		__testing.shouldSkipDuplicateExtensionLoad("file:///repo/extensions/skill-registry.ts?second", "/workspace", state),
		false,
	);
	assert.equal(
		__testing.shouldSkipDuplicateExtensionLoad("file:///home/.pi/node_modules/gentle-pi/extensions/skill-registry.ts", "/workspace", state),
		true,
	);
});

test("project-local skill registry extension wins over installed package copy", () => {
	const cwd = join(tmpdir(), `gentle-pi-local-extension-${Date.now()}`);
	const localExtension = join(cwd, "extensions", "skill-registry.ts");
	mkdirSync(dirname(localExtension), { recursive: true });
	writeFileSync(localExtension, "");

	assert.equal(
		__testing.shouldSkipDuplicateExtensionLoad(
			"file:///home/.pi/agent/npm/node_modules/gentle-pi/extensions/skill-registry.ts",
			cwd,
			{},
		),
		true,
	);
	assert.equal(
		__testing.shouldSkipDuplicateExtensionLoad(pathToFileURL(localExtension).href, cwd, {}),
		false,
	);
});

test("scope and markdown cells are represented in registry", () => {
	const cwd = join(tmpdir(), `gentle-pi-scope-${Date.now()}`);
	const projectPath = join(cwd, "skills", "docs", "SKILL.md");
	const userPath = join(tmpdir(), `gentle-pi-home-${Date.now()}`, ".claude", "skills", "docs", "SKILL.md");
	const registry = __testing.renderRegistry(cwd, ["skills"], [
		{ name: "project-docs", path: projectPath, description: "Docs | guides" },
		{ name: "user-docs", path: userPath, description: "" },
	]);

	assert.match(registry, /\| `project-docs` \| Docs \\\| guides \| project \|/);
	assert.match(registry, /\| `user-docs` \| — \| user \|/);
});

test("generated registry file indexes skill path and omits body rules", async () => {
	const cwd = join(tmpdir(), `gentle-pi-regenerate-${Date.now()}`);
	const skillPath = join(cwd, "skills", "go-testing", "SKILL.md");
	mkdirSync(dirname(skillPath), { recursive: true });
	writeFileSync(
		skillPath,
		`---
name: go-testing
description: "Trigger: Go tests. Apply focused Go testing patterns."
---

## Hard Rules

- Run focused tests before broad tests.
`,
	);

	const dirs = await __testing.uniqueExistingDirs(__testing.projectSkillDirs(cwd));
	assert.ok(dirs.includes(join(cwd, "skills")));

	const registry = __testing.renderRegistry(cwd, ["skills"], [
		{
			name: "go-testing",
			path: skillPath,
			description: "Trigger: Go tests. Apply focused Go testing patterns.",
		},
	]);
	assert.match(registry, /go-testing/);
	assert.match(registry, /Trigger: Go tests\. Apply focused Go testing patterns\./);
	assert.match(registry, new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(registry, /Run focused tests before broad tests/);
});

test("orchestrator documents path injection protocol", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "assets", "orchestrator.md"), "utf8");
	assert.match(source, /## Skills to load before work/);
	assert.match(source, /paths-injected/);
	assert.doesNotMatch(source, /Use matching compact rules based on code context and task intent/);
});

test("non-forced regeneration invalidates cache when skill bytes change but path, size, and mtime are restored", async () => {
	const cwd = join(tmpdir(), `gentle-pi-fingerprint-${Date.now()}`);
	const skillPath = join(cwd, "skills", "alpha", "SKILL.md");
	mkdirSync(dirname(skillPath), { recursive: true });

	const contentV1 =
		'---\nname: alpha\ndescription: "Trigger: alpha skill. Variant one. Body A."\n---\n\n## Rules\n\n- Rule A.\n';
	const contentV2 =
		'---\nname: alpha\ndescription: "Trigger: alpha skill. Variant two. Body B."\n---\n\n## Rules\n\n- Rule B.\n';
	assert.equal(
		Buffer.byteLength(contentV1),
		Buffer.byteLength(contentV2),
		"test fixtures must have identical byte length",
	);

	const fixedMtimeSeconds = 1_000_000_000;
	writeFileSync(skillPath, contentV1);
	utimesSync(skillPath, fixedMtimeSeconds, fixedMtimeSeconds);
	const beforeStat = statSync(skillPath);
	const beforeMtimeMs = beforeStat.mtimeMs;
	const beforeSize = beforeStat.size;

	const first = await __testing.regenerateRegistry(cwd, false);
	assert.equal(first.regenerated, true, "initial non-forced regeneration writes the registry");
	assert.equal(first.reason, "fingerprint-changed");

	const registryPath = join(cwd, ".atl", "skill-registry.md");
	const firstRegistry = readFileSync(registryPath, "utf8");
	assert.match(firstRegistry, /Variant one\. Body A\./);

	writeFileSync(skillPath, contentV2);
	utimesSync(skillPath, fixedMtimeSeconds, fixedMtimeSeconds);
	const midStat = statSync(skillPath);
	assert.equal(midStat.size, beforeSize, "byte size must be unchanged after rewrite");
	assert.equal(midStat.mtimeMs, beforeMtimeMs, "mtime must be restored exactly");

	const second = await __testing.regenerateRegistry(cwd, false);
	assert.equal(
		second.regenerated,
		true,
		"non-forced regeneration must invalidate cache when content bytes changed",
	);
	assert.equal(second.reason, "fingerprint-changed");

	const secondRegistry = readFileSync(registryPath, "utf8");
	assert.match(secondRegistry, /Variant two\. Body B\./);
	assert.doesNotMatch(secondRegistry, /Variant one\. Body A\./);
});
