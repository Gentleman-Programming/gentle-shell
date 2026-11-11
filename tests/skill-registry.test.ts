import assert from "node:assert/strict";
import { execSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillRegistryExtension, { __testing, type ResolvedSkill } from "../extensions/skill-registry.ts";
const skillRegistry = skillRegistryExtension;

// Registered startup reads process.env directly; a suite launched from a
// delegated child must still exercise the parent paths (gentle-shell#1690).
delete process.env.GENTLE_PI_AGENTS_CHILD;

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
	assert.equal(__testing.shouldSkipSkillRegistryStartup(disabled, [], { GENTLE_PI_AGENTS_CHILD: "1" }), true);
	assert.equal(__testing.shouldSkipSkillRegistryStartup(disabled, [], { GENTLE_PI_AGENTS_CHILD: "0" }), false);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pi lists its loaded skills itself, so the effective block proves a retained
// capture through a same-name user-root copy the captured record outranks.
function isolatedHome(t: { after(fn: () => void): void }): string {
	const home = mkdtempSync(join(tmpdir(), "gentle-p2-home-"));
	const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
		if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
		rmSync(home, { recursive: true, force: true });
	});
	return home;
}

// os.homedir() reads USERPROFILE on Windows, so the helper must isolate both variables.
test("isolatedHome points HOME and USERPROFILE at the temporary home and restores both", async (t) => {
	const before = { home: process.env.HOME, profile: process.env.USERPROFILE };
	let home = "";
	await t.test("inside the fixture", (st) => {
		home = isolatedHome(st);
		assert.equal(process.env.HOME, home);
		assert.equal(process.env.USERPROFILE, home);
	});
	assert.equal(process.env.HOME, before.home);
	assert.equal(process.env.USERPROFILE, before.profile);
	assert.ok(!existsSync(home), "the temporary home is removed after the fixture");
});

// Positive control: without `read` or `bash` Pi lists nothing, so the retained capture becomes rows.
async function promptWithoutReaders(event: (event: unknown, ctx: unknown) => unknown, cwd: string): Promise<string> {
	const options = { selectedTools: ["grep"], appendSystemPrompt: "" };
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	return options.appendSystemPrompt;
}

function userShadow(home: string, name: string): string {
	const file = join(home, ".agents", "skills", `${name}-copy`, "SKILL.md");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: User-root copy.\n---\n`);
	return file;
}

test("toResolvedEntry maps exact file path and scope from sourceInfo", () => {
	const cwd = join(tmpdir(), `gentle-pi-resolved-${Date.now()}`);
	const projectPath = join(cwd, "skills", "go-testing", "SKILL.md");
	const projectEntry = __testing.toResolvedEntry(
		{
			name: "go-testing",
			description: "Trigger: Go tests.\nApply focused patterns.",
			filePath: projectPath,
			sourceInfo: { scope: "project" },
		} satisfies ResolvedSkill,
		cwd,
	);
	assert.ok(projectEntry);
	assert.equal(projectEntry.name, "go-testing");
	assert.equal(projectEntry.path, projectPath, "resolved path must be preserved exactly");
	assert.equal(projectEntry.description, "Trigger: Go tests. Apply focused patterns.");
	assert.equal(projectEntry.scope, "project");

	const userEntry = __testing.toResolvedEntry(
		{
			name: "docs",
			description: "Docs.",
			filePath: "/home/u/.pi/agent/skills/docs/SKILL.md",
			sourceInfo: { scope: "user" },
		} satisfies ResolvedSkill,
		cwd,
	);
	assert.ok(userEntry);
	assert.equal(userEntry.scope, "user");

	const temporaryEntry = __testing.toResolvedEntry(
		{
			name: "temp",
			description: "Temp.",
			filePath: "/run/pi/temp-skills/temp/SKILL.md",
			sourceInfo: { scope: "temporary" },
		} satisfies ResolvedSkill,
		cwd,
	);
	assert.ok(temporaryEntry);
	assert.equal(temporaryEntry.scope, "user", "temporary scope maps to the user label");

	const absentEntry = __testing.toResolvedEntry(
		{ name: "plain", description: "Plain.", filePath: "/anywhere/plain/SKILL.md" } satisfies ResolvedSkill,
		cwd,
	);
	assert.ok(absentEntry);
	assert.equal(absentEntry.scope, "user", "absent sourceInfo falls back to the user label");
});

test("toResolvedEntry appends package origin to the scope label", () => {
	const cwd = join(tmpdir(), `gentle-pi-resolved-package-${Date.now()}`);
	const packaged = __testing.toResolvedEntry(
		{
			name: "packaged",
			description: "Packaged.",
			filePath: "/pkg/skills/packaged/SKILL.md",
			sourceInfo: { scope: "user", origin: "package" },
		} satisfies ResolvedSkill,
		cwd,
	);
	assert.ok(packaged);
	assert.equal(packaged.scope, "user · package");

	const projectPackaged = __testing.toResolvedEntry(
		{
			name: "project-packaged",
			description: "Packaged.",
			filePath: "/pkg/skills/project-packaged/SKILL.md",
			sourceInfo: { scope: "project", origin: "package" },
		} satisfies ResolvedSkill,
		cwd,
	);
	assert.ok(projectPackaged);
	assert.equal(projectPackaged.scope, "project · package");

	const topLevel = __testing.toResolvedEntry(
		{
			name: "top",
			description: "Top.",
			filePath: "/pkg/skills/top/SKILL.md",
			sourceInfo: { scope: "user", origin: "top-level" },
		} satisfies ResolvedSkill,
		cwd,
	);
	assert.ok(topLevel);
	assert.equal(topLevel.scope, "user", "top-level origin must not append the package label");
});

test("toResolvedEntry returns undefined when model invocation is disabled", () => {
	assert.equal(
		__testing.toResolvedEntry(
			{
				name: "internal",
				description: "Internal.",
				filePath: "/skills/internal/SKILL.md",
				disableModelInvocation: true,
			} satisfies ResolvedSkill,
			"/repo",
		),
		undefined,
	);
});

test("toResolvedEntry returns undefined for excluded skill names", () => {
	assert.equal(
		__testing.toResolvedEntry(
			{
				name: "sdd-research",
				description: "Research.",
				filePath: "/skills/sdd-research/SKILL.md",
			} satisfies ResolvedSkill,
			"/repo",
		),
		undefined,
	);
	assert.equal(
		__testing.toResolvedEntry(
			{
				name: "_shared",
				description: "Shared.",
				filePath: "/skills/_shared/SKILL.md",
			} satisfies ResolvedSkill,
			"/repo",
		),
		undefined,
	);
});

test("mergeResolvedWithLoose gives resolved paths per-path authority", () => {
	const cwd = join(tmpdir(), `gentle-pi-merge-${Date.now()}`);
	const resolvedPath = join(tmpdir(), `gentle-pi-merge-pkg-${Date.now()}`, "skills", "dup", "SKILL.md");
	const otherPath = join(cwd, ".opencode", "skills", "other", "SKILL.md");
	const merged = __testing.mergeResolvedWithLoose(
		[{ name: "dup", path: resolvedPath, description: "resolved", scope: "user · package" }],
		[
			{ name: "dup", path: resolvedPath, description: "loose" },
			{ name: "other", path: otherPath, description: "loose-other" },
		],
		cwd,
	);

	assert.equal(merged.length, 2, "only the path-colliding loose entry is dropped");
	const dup = merged.find((entry) => entry.name === "dup");
	assert.ok(dup);
	assert.equal(dup.path, resolvedPath, "the exact resolved path must survive");
	assert.equal(dup.description, "resolved");
	assert.ok(merged.some((entry) => entry.name === "other"), "unrelated loose entries survive");
});

test("mergeResolvedWithLoose keeps project-over-user name precedence", () => {
	const cwd = join(tmpdir(), `gentle-pi-merge-precedence-${Date.now()}`);
	const packagePath = join(tmpdir(), `gentle-pi-merge-pkg2-${Date.now()}`, "skills", "dup", "SKILL.md");
	const projectPath = join(cwd, "skills", "dup", "SKILL.md");

	const looseProjectWins = __testing.mergeResolvedWithLoose(
		[{ name: "dup", path: packagePath, description: "resolved", scope: "user · package" }],
		[{ name: "dup", path: projectPath, description: "loose" }],
		cwd,
	);
	assert.equal(looseProjectWins.length, 1);
	assert.equal(looseProjectWins[0].path, projectPath, "loose project path beats resolved user/package path");

	const resolvedProjectPath = join(cwd, ".claude", "skills", "dup", "SKILL.md");
	const userPath = join(tmpdir(), `gentle-pi-merge-home-${Date.now()}`, ".pi", "agent", "skills", "dup", "SKILL.md");
	const resolvedWins = __testing.mergeResolvedWithLoose(
		[{ name: "dup", path: resolvedProjectPath, description: "resolved", scope: "project" }],
		[{ name: "dup", path: userPath, description: "loose" }],
		cwd,
	);
	assert.equal(resolvedWins.length, 1);
	assert.equal(resolvedWins[0].path, resolvedProjectPath, "resolved project path beats loose user path");
});

test("mergeResolvedWithLoose does not promote resolved user scope inside cwd", () => {
	const cwd = join(tmpdir(), `gentle-pi-resolved-user-cwd-${Date.now()}`);
	const resolvedPath = join(cwd, ".pi", "agent", "skills", "dup", "SKILL.md");
	const loosePath = join(cwd, "skills", "dup", "SKILL.md");
	const resolved = __testing.toResolvedEntry({
		name: "dup", description: "Pi user skill", filePath: resolvedPath,
		sourceInfo: { scope: "user" },
	}, cwd);
	assert.ok(resolved);
	assert.equal(resolved.scope, "user");
	const merged = __testing.mergeResolvedWithLoose(
		[resolved], [{ name: "dup", path: loosePath, description: "Loose project skill" }], cwd,
	);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].path, loosePath, "loose project beats Pi-resolved user even inside cwd");
});

test("mergeResolvedWithLoose honors resolved project scope outside cwd", () => {
	const cwd = join(tmpdir(), `gentle-pi-linked-workspace-${Date.now()}`);
	const linkedPath = join(tmpdir(), `gentle-pi-linked-source-${Date.now()}`, "skills", "dup", "SKILL.md");
	const loosePath = join(cwd, "skills", "dup", "SKILL.md");
	const resolved = __testing.toResolvedEntry({
		name: "dup", description: "Pi project skill", filePath: linkedPath,
		sourceInfo: { scope: "project" },
	}, cwd);
	assert.ok(resolved);
	const merged = __testing.mergeResolvedWithLoose(
		[resolved], [{ name: "dup", path: loosePath, description: "Loose cwd skill" }], cwd,
	);
	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0], resolved);
});

test("mergeResolvedWithLoose with empty resolved matches the loose-only result", () => {
	const cwd = join(tmpdir(), `gentle-pi-merge-empty-${Date.now()}`);
	const loose = [
		{ name: "zeta", path: join(cwd, "skills", "zeta", "SKILL.md"), description: "z" },
		{
			name: "alpha",
			path: join(tmpdir(), `gentle-pi-merge-empty-home-${Date.now()}`, "skills", "alpha", "SKILL.md"),
			description: "a-user",
		},
		{ name: "alpha", path: join(cwd, ".opencode", "skills", "alpha", "SKILL.md"), description: "a-project" },
	];

	assert.deepEqual(
		__testing.mergeResolvedWithLoose([], loose, cwd),
		__testing.dedupeBySkillName(loose, cwd),
	);
});

test("disk regeneration retains loose skill paths and byte-identical refreshes", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-regen-disk-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const skill = join(cwd, "skills", "loose-one", "SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, "---\nname: loose-one\ndescription: Loose skill.\n---\n");
	const first = await __testing.regenerateRegistry(cwd, false);
	assert.equal(first.regenerated, true);
	assert.equal(first.skillCount, 1);
	const path = join(cwd, ".atl", "skill-registry.md");
	assert.ok(readFileSync(path, "utf8").includes(skill));
	const before = statSync(path).mtimeMs;
	assert.equal((await __testing.regenerateRegistry(cwd, false)).reason, "cache-hit");
	assert.equal(statSync(path).mtimeMs, before);
});

test("regenerateRegistry carries a skill resolved from a non-default PI_CODING_AGENT_DIR", async () => {
	// Acceptance case from gentle-shell#369 (2026-09-27): with
	// PI_CODING_AGENT_DIR set to a non-default directory, Pi resolves user
	// skills from <agent-dir>/skills, which no loose scan root reaches. The
	// runtime mirror must be the only route into the registry.
	const cwd = join(tmpdir(), `gentle-pi-agentdir-cwd-${Date.now()}`);
	const isolatedHome = join(tmpdir(), `gentle-pi-agentdir-home-${Date.now()}`);
	const agentDir = join(tmpdir(), `gentle-pi-agentdir-root-${Date.now()}`);
	const skillPath = join(agentDir, "skills", "codegraph", "SKILL.md");
	mkdirSync(dirname(skillPath), { recursive: true });
	writeFileSync(skillPath, "---\nname: codegraph\ndescription: Trigger: agent-dir skill.\n---\n");

	const resolved: ResolvedSkill[] = [
		{
			name: "codegraph",
			description: "Trigger: agent-dir skill.",
			filePath: skillPath,
			sourceInfo: { scope: "user" },
		},
	];

	const previousHome = process.env.HOME;
	const previousProfile = process.env.USERPROFILE;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { pi, handlers } = fakeSkillRegistryPi();
		skillRegistry(pi);
		const options = { skills: resolved, appendSystemPrompt: "" };
		await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, { cwd, hasUI: false });
		assert.ok(!options.appendSystemPrompt.includes(skillPath), "Pi lists the custom agent-dir skill itself");
		await __testing.regenerateRegistry(cwd, false);
		const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
		assert.ok(!registry.includes(skillPath), "runtime-only paths are not stored on disk");

		// Counter-proof: with no resolved set, the isolated agent dir is
		// unreachable — no loose root scans it. If the skill still appeared, a
		// hardcoded agent-dir loose root would have been reintroduced.
		const bareCwd = join(tmpdir(), `gentle-pi-agentdir-bare-${Date.now()}`);
		const decoyPath = join(bareCwd, "skills", "decoy", "SKILL.md");
		mkdirSync(dirname(decoyPath), { recursive: true });
		writeFileSync(decoyPath, "---\nname: decoy\ndescription: Trigger: decoy.\n---\n");
		await __testing.regenerateRegistry(bareCwd, false);
		const bareRegistry = readFileSync(join(bareCwd, ".atl", "skill-registry.md"), "utf8");
		assert.match(
			bareRegistry,
			new RegExp(escapeRegExp(decoyPath)),
			"decoy loose skill proves the registry was written",
		);
		assert.doesNotMatch(
			bareRegistry,
			new RegExp(escapeRegExp(skillPath)),
			"no loose scan root may reach a non-default agent dir",
		);
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	}
});

test("regenerateRegistry never re-indexes a filtered Pi skill from a loose root", async (t) => {
	// A Pi-managed loose root (.pi/skills) still holds the SKILL.md of a skill
	// Pi filtered out at runtime; the loose scan must not resurrect it as an
	// active registry row.
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-suppressed-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const disabledPath = join(cwd, ".pi", "skills", "runtime-hidden", "SKILL.md");
	const livePath = join(cwd, ".pi", "skills", "loose-live", "SKILL.md");
	for (const [path, name, description] of [
		[disabledPath, "runtime-hidden", "Hidden by runtime disablement."],
		[livePath, "loose-live", "Loose live skill."],
	] as const) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n`);
	}

	const { pi, handlers } = fakeSkillRegistryPi();
	skillRegistry(pi);
	const options = { skills: [{ name: "runtime-hidden", description: "Hidden by runtime disablement.", filePath: disabledPath, disableModelInvocation: true }], appendSystemPrompt: "" };
	await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(options.appendSystemPrompt.includes(livePath));
	assert.ok(!options.appendSystemPrompt.includes(disabledPath), "disabled paths are suppressed from the session view");
	assert.equal((await __testing.regenerateRegistry(cwd, true, true)).regenerated, true);
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.ok(registry.includes(livePath) && registry.includes(disabledPath), "disk indexing is independent of session disablement");
});

test("renderRegistry describes disk-only authority rather than runtime counts", () => {
	const cwd = join(tmpdir(), "gentle-pi-render-disk");
	const entry = { name: "docs", path: join(cwd, "skills", "docs", "SKILL.md"), description: "Docs." };
	const rendered = __testing.renderRegistry(cwd, ["skills"], [entry]);
	assert.match(rendered, /excludes session-only runtime skills/);
	assert.doesNotMatch(rendered, /Pi-resolved runtime authority/);
});

function fakeSkillRegistryPi(getFlag: (name: string) => boolean = () => false) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag(_name: string, _registration: unknown) {},
		registerCommand(name: string, registration: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, registration);
		},
		getFlag,
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

test("registered event leaves Pi-listed project package skills out without publishing runtime rows", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-apply-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	isolatedHome(t);
	const skillPath = join(cwd, "custom", "applied", "SKILL.md");
	const { pi, handlers } = fakeSkillRegistryPi(); skillRegistry(pi);
	const options = { skills: [{ name: "applied", description: "Trigger: applied skill.", filePath: skillPath, sourceInfo: { scope: "project", origin: "package" } }], appendSystemPrompt: "" };
	await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, "");
	assert.equal(existsSync(join(cwd, ".atl", "skill-registry.md")), false);
});

test("Pi-listed global packages, project-local packages, and custom paths emit no rows", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-apply-matrix-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	isolatedHome(t);
	const globalPkgPath = join(cwd, "global", "node_modules", "pkg-a", "SKILL.md");
	const projectPkgPath = join(cwd, "node_modules", "pkg-b", "SKILL.md");
	const customPath = join(cwd, "custom-declared", "SKILL.md");
	const { pi, handlers } = fakeSkillRegistryPi(); skillRegistry(pi);
	const options = { skills: [
		{ name: "global-pkg", description: "Global", filePath: globalPkgPath, sourceInfo: { scope: "user", origin: "package" } },
		{ name: "project-pkg", description: "Project", filePath: projectPkgPath, sourceInfo: { scope: "project", origin: "package" } },
		{ name: "custom", description: "Custom", filePath: customPath, sourceInfo: { scope: "project", origin: "top-level" } },
	], appendSystemPrompt: "" };
	await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, "");
});

test("repeated registered runtime captures do not duplicate the effective prompt", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-apply-idempotent-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const { pi, handlers } = fakeSkillRegistryPi(); skillRegistry(pi);
	const options = { skills: [{ name: "idempotent", description: "Trigger: idempotent skill.", filePath: "/pkg/skills/idempotent/SKILL.md" }], appendSystemPrompt: "existing" };
	const event = handlers.get("before_agent_start")![0];
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	const before = options.appendSystemPrompt;
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, before);
});

test("registered event replaces the effective view when runtime skills change", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-apply-change-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	isolatedHome(t);
	const disk = (name: string) => {
		const file = join(cwd, "skills", name, "SKILL.md");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `---\nname: ${name}\ndescription: ${name}.\n---\n`);
		return file;
	};
	const first = disk("first"), second = disk("second");
	const { pi, handlers } = fakeSkillRegistryPi(); skillRegistry(pi);
	const options = { skills: [{ name: "first", description: "First", filePath: first }], appendSystemPrompt: "" };
	const event = handlers.get("before_agent_start")![0];
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(!options.appendSystemPrompt.includes(first) && options.appendSystemPrompt.includes(second));
	options.skills = [{ name: "second", description: "Second", filePath: second }];
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(options.appendSystemPrompt.includes(first) && !options.appendSystemPrompt.includes(second));
});

test("Pi-listed runtime duplicates emit no rows whatever their disabled state or order", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-resolved-order-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const shadow = userShadow(isolatedHome(t), "duplicate");
	const alpha = "/pkg/alpha/SKILL.md", beta = "/pkg/beta/SKILL.md";
	const first: ResolvedSkill[] = [
		{ name: "duplicate", description: "  Trigger:   first entry.  ", filePath: alpha },
		{ name: "duplicate", description: "Trigger: second entry.", filePath: beta },
	];
	const { pi, handlers } = fakeSkillRegistryPi(); skillRegistry(pi);
	const options = { skills: first, appendSystemPrompt: "" };
	const event = handlers.get("before_agent_start")![0];
	for (const skills of [first, [{ ...first[0], disableModelInvocation: true }, first[1]], [first[1], first[0]]]) {
		options.skills = skills;
		await event({ systemPromptOptions: options }, { cwd, hasUI: false });
		assert.equal(options.appendSystemPrompt, "", "the Pi-listed winner outranks the user-root copy");
	}
	options.skills = first.map((skill) => ({ ...skill, disableModelInvocation: true }));
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(options.appendSystemPrompt.includes(shadow), "with every Pi record disabled the disk copy is the winner");
});

test("before_agent_start rejects malformed batches and preserves prior resolved skills", async (t) => {
	const cwd = join(tmpdir(), `gentle-pi-wire-malformed-batch-${Date.now()}`);
	const skillPath = "/pkg/skills/valid-before-malformed/SKILL.md";
	const shadow = userShadow(isolatedHome(t), "valid");
	const { pi, handlers, commands } = fakeSkillRegistryPi();
	skillRegistryExtension(pi);
	const handler = handlers.get("before_agent_start")?.[0];
	const refresh = commands.get("skill-registry:refresh");
	assert.ok(handler);
	assert.ok(refresh);

	const options: { skills: unknown; appendSystemPrompt: string } = { skills: [{ name: "valid", description: "Valid runtime skill.", filePath: skillPath }], appendSystemPrompt: "" };
	await handler({ systemPromptOptions: options }, { cwd, hasUI: false });
	await refresh.handler("", { cwd, hasUI: false, ui: { notify() {} } });
	for (const skills of [
		[
			{ name: "replacement-scope", description: "Must not partially apply.", filePath: "/pkg/skills/replacement-scope/SKILL.md" },
			{
				name: "invalid-scope",
				description: "Invalid nested metadata.",
				filePath: "/pkg/skills/invalid-scope/SKILL.md",
				sourceInfo: { scope: 42 },
			},
		],
		[
			{ name: "replacement-origin", description: "Must not partially apply.", filePath: "/pkg/skills/replacement-origin/SKILL.md" },
			{
				name: "invalid-origin",
				description: "Invalid nested metadata.",
				filePath: "/pkg/skills/invalid-origin/SKILL.md",
				sourceInfo: { origin: "invalid" },
			},
		],
	]) {
		options.skills = skills;
		await handler({ systemPromptOptions: options }, { cwd, hasUI: false });
		assert.ok(!options.appendSystemPrompt.includes(shadow), "the retained capture still outranks its user-root copy");
		assert.ok(!options.appendSystemPrompt.includes(skillPath));
		assert.ok(!options.appendSystemPrompt.includes(skills[0].filePath));
		assert.ok((await promptWithoutReaders(handler, cwd)).includes(skillPath), "the capture is retained");
		await refresh.handler("", { cwd, hasUI: false, ui: { notify() {} } });
		const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
		assert.ok(!registry.includes(skillPath));
		assert.ok(!registry.includes(skills[0].filePath));
	}
});

test("watcher refresh retains captured runtime-resolved skills", { timeout: 5_000 }, async (t) => {
	const cwd = join(tmpdir(), `gentle-pi-watch-resolved-${Date.now()}`);
	const shadow = userShadow(isolatedHome(t), "retained");
	const looseSkillPath = join(cwd, "skills", "loose", "SKILL.md");
	const resolvedPath = "/pkg/skills/watcher-retained/SKILL.md";
	mkdirSync(dirname(looseSkillPath), { recursive: true });
	writeFileSync(looseSkillPath, "---\nname: loose\ndescription: Before watcher refresh.\n---\n");
	const { pi, handlers } = fakeSkillRegistryPi(); skillRegistry(pi);
	const options: { skills?: unknown; appendSystemPrompt: string } = { skills: [{ name: "retained", description: "Runtime authority.", filePath: resolvedPath }], appendSystemPrompt: "" };
	await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, { cwd, hasUI: false });
	await __testing.regenerateRegistry(cwd, false);

	let resolveRefresh: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const refreshed = new Promise<void>((resolve) => {
		resolveRefresh = resolve;
	});
	try {
		await __testing.startSkillRegistryWatcher(cwd, () => resolveRefresh?.());
		writeFileSync(looseSkillPath, "---\nname: loose\ndescription: After watcher refresh.\n---\n");
		await Promise.race([
			refreshed,
			new Promise<void>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("watcher did not refresh the registry")), 3_000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		__testing.closeSkillRegistryWatchers();
	}

	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.doesNotMatch(registry, new RegExp(escapeRegExp(resolvedPath)));
	options.skills = undefined;
	await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(!options.appendSystemPrompt.includes(resolvedPath) && !options.appendSystemPrompt.includes(shadow), "the retained capture still outranks its user-root copy");
	assert.match(options.appendSystemPrompt, /After watcher refresh/);
	assert.ok((await promptWithoutReaders(handlers.get("before_agent_start")![0], cwd)).includes(resolvedPath), "the capture is retained");
});

test("before_agent_start handler wires pi-resolved skills into the registry", async (t) => {
	// Happy path: the handler captures runtime-resolved skills for the session cwd.
	{
		const cwd = join(tmpdir(), `gentle-pi-wire-${Date.now()}`);
		const shadow = userShadow(isolatedHome(t), "wired-skill");
		const { pi, handlers } = fakeSkillRegistryPi();
		skillRegistryExtension(pi);
		const handler = handlers.get("before_agent_start")?.[0];
		assert.ok(handler, "default export must register a before_agent_start handler");

		const skillPath = join(
			tmpdir(),
			`gentle-pi-wire-pkg-${Date.now()}`,
			"skills",
			"wired-skill",
			"SKILL.md",
		);
		const options = { skills: [{ name: "wired-skill", description: "Trigger: wired skill. Runtime capture.", filePath: skillPath, sourceInfo: { scope: "project", origin: "package" } }], appendSystemPrompt: "" };
		await handler({ systemPromptOptions: options }, { cwd, hasUI: false });
		assert.equal(options.appendSystemPrompt, "", `the capture outranks ${shadow} and Pi lists ${skillPath}`);
		assert.ok((await promptWithoutReaders(handler, cwd)).includes(skillPath), "the capture is wired");
		assert.equal(existsSync(join(cwd, ".atl", "skill-registry.md")), false);
	}

	// The no-skill-registry opt-out must leave the registry untouched.
	{
		const cwd = join(tmpdir(), `gentle-pi-wire-skip-${Date.now()}`);
		const { pi, handlers } = fakeSkillRegistryPi((name) => name === "no-skill-registry");
		skillRegistryExtension(pi);
		const handler = handlers.get("before_agent_start")?.[0];
		assert.ok(handler);

		await handler(
			{ systemPromptOptions: { skills: [{ name: "skipped", description: "S.", filePath: "/pkg/skills/skipped/SKILL.md" }] } },
			{ cwd, hasUI: false },
		);
		assert.equal(
			existsSync(join(cwd, ".atl", "skill-registry.md")),
			false,
			"flagged opt-out must not write a registry",
		);
	}

	// A non-array skills payload must be ignored entirely.
	{
		const cwd = join(tmpdir(), `gentle-pi-wire-malformed-${Date.now()}`);
		const { pi, handlers } = fakeSkillRegistryPi();
		skillRegistryExtension(pi);
		const handler = handlers.get("before_agent_start")?.[0];
		assert.ok(handler);

		await handler(
			{ systemPromptOptions: { skills: "not-an-array" } },
			{ cwd, hasUI: false },
		);
		assert.equal(
			existsSync(join(cwd, ".atl", "skill-registry.md")),
			false,
			"non-array skills payload must not write a registry",
		);
	}
});

test("startup regeneration keeps the resolved set captured before it settles", async (t) => {
	// Startup regeneration is scheduled by session_start and lands later; a
	// capture that already arrived is newer authority and must survive it.
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-startup-authority-"));
	const packageRoot = mkdtempSync(join(tmpdir(), "gentle-pi-startup-authority-pkg-"));
	t.after(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(packageRoot, { recursive: true, force: true });
	});
	const loosePath = join(cwd, "skills", "loose", "SKILL.md");
	mkdirSync(dirname(loosePath), { recursive: true });
	writeFileSync(loosePath, "---\nname: loose\ndescription: Loose project skill.\n---\n");
	const resolvedPath = join(packageRoot, "skills", "runtime-authority", "SKILL.md");
	const shadow = userShadow(isolatedHome(t), "runtime-authority");

	const { pi, handlers } = fakeSkillRegistryPi();
	skillRegistryExtension(pi);
	const capture = handlers.get("before_agent_start")?.[0];
	const start = handlers.get("session_start")?.[0];
	assert.ok(capture, "default export must register a before_agent_start handler");
	assert.ok(start, "default export must register a session_start handler");
	const ctx = { cwd, hasUI: false };

	await capture(
		{
			systemPromptOptions: {
				skills: [
					{
						name: "runtime-authority",
						description: "Trigger: runtime authority. Captured before startup settles.",
						filePath: resolvedPath,
						sourceInfo: { scope: "project", origin: "package" },
					},
				],
			},
		},
		ctx,
	);
	await start(undefined, ctx);
	await __testing.startupSettled();

	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.doesNotMatch(registry, new RegExp(escapeRegExp(resolvedPath)));
	assert.match(registry, new RegExp(escapeRegExp(loosePath)));
	const options = { appendSystemPrompt: "" };
	await capture({ systemPromptOptions: options }, ctx);
	assert.ok(!options.appendSystemPrompt.includes(shadow), "startup must not drop the session capture");
	assert.ok((await promptWithoutReaders(capture, cwd)).includes(resolvedPath), "the capture is retained");
	assert.ok(!options.appendSystemPrompt.includes(resolvedPath));
	assert.ok(options.appendSystemPrompt.includes(loosePath));
});

test("manual /skill-registry:refresh keeps the captured resolved set", async (t) => {
	const cwd = join(tmpdir(), `gentle-pi-refresh-${Date.now()}`);
	const shadow = userShadow(isolatedHome(t), "refreshed");
	const skillPath = join(tmpdir(), `gentle-pi-refresh-pkg-${Date.now()}`, "skills", "refreshed", "SKILL.md");
	const { pi, handlers, commands } = fakeSkillRegistryPi();
	skillRegistryExtension(pi);
	const handler = handlers.get("before_agent_start")?.[0];
	assert.ok(handler);
	const refresh = commands.get("skill-registry:refresh");
	assert.ok(refresh, "default export must register skill-registry:refresh");

	await handler(
		{
			systemPromptOptions: {
				skills: [
				{
						name: "refreshed",
						description: "Trigger: refresh retention. Authority must survive a manual refresh.",
						filePath: skillPath,
						sourceInfo: { scope: "project", origin: "package" },
					},
				],
			},
		},
		{ cwd, hasUI: false },
	);
	assert.equal(existsSync(join(cwd, ".atl", "skill-registry.md")), false);

	// A forced manual refresh writes disk only without dropping the session capture.
	const notices: string[] = [];
	await refresh.handler("", { cwd, hasUI: true, ui: { notify: (text: string) => notices.push(text) } });
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.doesNotMatch(registry, new RegExp(escapeRegExp(skillPath)));
	const options = { appendSystemPrompt: "" };
	await handler({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, "", `the capture outranks ${shadow} and Pi lists ${skillPath}`);
	assert.ok((await promptWithoutReaders(handler, cwd)).includes(skillPath), "the capture is retained");
	assert.ok(notices.length > 0);
});

test("ensureAtlIgnored creates .atl/.gitignore with * and leaves root .gitignore untouched (#1387)", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), `gentle-pi-git-atl-${Date.now()}-`));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	// An empty index is sufficient; fixtures never need commits.
	execSync("git init", { cwd, stdio: "ignore" });

	const rootGitignore = join(cwd, ".gitignore");
	const atlGitignore = join(cwd, ".atl", ".gitignore");

	// Run ensureAtlIgnored
	await __testing.ensureAtlIgnored(cwd);

	// Root .gitignore must NOT be created
	assert.equal(existsSync(rootGitignore), false, "root .gitignore must not be created");

	// .atl/.gitignore must exist with * rule
	assert.equal(existsSync(atlGitignore), true, ".atl/.gitignore must exist");
	assert.equal(readFileSync(atlGitignore, "utf8").trim(), "*");

	// Write generated registry file inside .atl
	writeFileSync(join(cwd, ".atl", "skill-registry.md"), "## Skills\n");

	// Verify that git status reports no untracked files
	const status = execSync("git status --porcelain", { cwd, encoding: "utf8" });
	assert.equal(status.trim(), "", ".atl/ files must not appear in git status");

	// Idempotency: calling ensureAtlIgnored again does not duplicate or alter the rule
	await __testing.ensureAtlIgnored(cwd);
	assert.equal(readFileSync(atlGitignore, "utf8").trim(), "*");

	// Existing root .gitignore is preserved unmodified
	writeFileSync(rootGitignore, "node_modules/\n");
	await __testing.ensureAtlIgnored(cwd);
	assert.equal(readFileSync(rootGitignore, "utf8"), "node_modules/\n", "existing root .gitignore must remain untouched");

	// If .atl/.gitignore already has intermediate rules ending with a negation, ensure * is appended
	writeFileSync(atlGitignore, "*\n!*.md\n");
	await __testing.ensureAtlIgnored(cwd);
	const updatedRules = readFileSync(atlGitignore, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
	assert.equal(updatedRules.at(-1), "*", "final active ignore rule must be *");
});

// Keep runtime scans inside an isolated home, including the existing watcher tests.
const fixtureHome = mkdtempSync(join(tmpdir(), "gentle-pi-registry-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalGitCeiling = process.env.GIT_CEILING_DIRECTORIES;
const originalCodexHome = process.env.CODEX_HOME;
delete process.env.CODEX_HOME;
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
test.after(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalGitCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
	else process.env.GIT_CEILING_DIRECTORIES = originalGitCeiling;
	if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = originalCodexHome;
	rmSync(fixtureHome, { recursive: true, force: true });
});

function registeredRegistry(cwd: string, suppressed = false) {
	type Context = { cwd: string; hasUI: boolean; ui: { notify: (message: string, level?: string) => void } };
	const events = new Map<string, (event: unknown, ctx: Context) => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: Context) => Promise<void> }>();
	const notices: { message: string; level?: string }[] = [];
	skillRegistry({
		on: (name: string, handler: (event: unknown, ctx: Context) => Promise<void>) => events.set(name, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: Context) => Promise<void> }) => commands.set(name, command),
		registerFlag: () => undefined,
		getFlag: () => suppressed,
	} as unknown as ExtensionAPI);
	const ctx = { cwd, hasUI: true, ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } };
	return {
		notices,
		// Startup work runs after session_start returns; settle it for assertions.
		start: async () => { await events.get("session_start")!(undefined, ctx); await __testing.startupSettled(); },
		startOnly: () => events.get("session_start")!(undefined, ctx),
		refresh: () => commands.get("skill-registry:refresh")!.handler("", ctx),
		stop: () => events.get("session_shutdown")!(undefined, ctx),
	};
}

function registryFixture(git = true, nested = false) {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-protected-"));
	if (git) execSync("git init", { cwd: root, stdio: "ignore" });
	const cwd = nested ? join(root, "nested") : root;
	mkdirSync(join(cwd, ".atl"), { recursive: true });
	const skill = join(cwd, "skills", "local", "SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, "---\nname: local\ndescription: Initial skill.\n---\n");
	return { root, cwd, skill, registry: join(cwd, ".atl", "skill-registry.md"), ignore: join(cwd, ".atl", ".gitignore") };
}

for (const target of ["registry", "ignore"] as const) {
	test(`registered startup preserves tracked ${target} in nested cwd and explicit refresh remains intentional`, async (t) => {
		const fixture = registryFixture(true, true);
		writeFileSync(fixture[target], target === "registry" ? "Reviewed registry\n" : "!*.md\n");
		execSync(`git add -f nested/.atl/${target === "registry" ? "skill-registry.md" : ".gitignore"}`, { cwd: fixture.root, stdio: "ignore" });
		const before = readFileSync(fixture[target], "utf8");
		const runtime = registeredRegistry(fixture.cwd);
		t.after(() => runtime.stop());
		await runtime.start();
		assert.equal(readFileSync(fixture[target], "utf8"), before);
		assert.ok(runtime.notices.some(({ message, level }) => level === "warning" && message.includes(`.atl/${target === "registry" ? "skill-registry.md" : ".gitignore"}`) && message.includes("/skill-registry:refresh")));
		if (target === "registry") assert.ok(!runtime.notices.some(({ message }) => message.includes("refreshed")));
		await runtime.refresh();
		assert.notEqual(readFileSync(fixture[target], "utf8"), before);
		assert.ok(runtime.notices.some(({ message }) => message.includes(target === "registry" ? "written to .atl/skill-registry.md" : "unchanged in .atl/skill-registry.md")));
	});
}

test("registered watcher protects registry tracked after a cache hit", async (t) => {
	const fixture = registryFixture();
	const runtime = registeredRegistry(fixture.cwd);
	t.after(() => runtime.stop());
	await runtime.start();
	await runtime.start();
	const before = readFileSync(fixture.registry, "utf8");
	execSync("git add -f .atl/skill-registry.md", { cwd: fixture.root, stdio: "ignore" });
	runtime.notices.length = 0;
	writeFileSync(fixture.skill, "---\nname: local\ndescription: Changed skill.\n---\n");
	const deadline = Date.now() + 5000;
	while (runtime.notices.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(readFileSync(fixture.registry, "utf8"), before);
	assert.ok(runtime.notices.some(({ message, level }) => level === "warning" && message.includes("/skill-registry:refresh")));
	// The poll re-asks the same tracked-target state every interval: the
	// warning stays a one-shot per unchanged state instead of repeating.
	runtime.notices.length = 0;
	await new Promise((resolve) => setTimeout(resolve, 3000));
	assert.deepEqual(runtime.notices, []);
	assert.ok(!runtime.notices.some(({ message }) => message.includes("refreshed")));
});

for (const git of [true, false]) {
	test(`registered startup and watcher regenerate normally in ${git ? "untracked Git" : "non-Git"} fixtures`, async (t) => {
		const fixture = registryFixture(git);
		const runtime = registeredRegistry(fixture.cwd);
		t.after(() => runtime.stop());
		await runtime.start();
		assert.match(readFileSync(fixture.registry, "utf8"), /Initial skill/);
		assert.equal(readFileSync(fixture.ignore, "utf8"), "*\n");
		writeFileSync(fixture.skill, "---\nname: local\ndescription: Changed skill.\n---\n");
		const deadline = Date.now() + 5000;
		while (!readFileSync(fixture.registry, "utf8").includes("Changed skill") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.match(readFileSync(fixture.registry, "utf8"), /Changed skill/);
	});
}

test("automatic forced freshness and registered startup protect tracked cache without partial writes", async (t) => {
	const fixture = registryFixture();
	const runtime = registeredRegistry(fixture.cwd);
	t.after(async () => { await runtime.stop(); rmSync(fixture.root, { recursive: true, force: true }); });
	await __testing.regenerateRegistry(fixture.cwd, false);
	const cache = join(fixture.cwd, ".atl", ".skill-registry.cache.json");
	execSync("git add -f .atl/.skill-registry.cache.json", { cwd: fixture.root, stdio: "ignore" });
	const beforeCache = readFileSync(cache, "utf8");
	const beforeRegistry = readFileSync(fixture.registry, "utf8");
	writeFileSync(fixture.skill, "---\nname: local\ndescription: Changed skill.\n---\n");
	const result = await __testing.regenerateRegistry(fixture.cwd, true);
	assert.equal(result.regenerated, false);
	assert.match(result.warning ?? "", /\.atl\/\.skill-registry\.cache\.json/);
	assert.equal(readFileSync(cache, "utf8"), beforeCache);
	assert.equal(readFileSync(fixture.registry, "utf8"), beforeRegistry);
	await runtime.start();
	assert.equal(readFileSync(cache, "utf8"), beforeCache);
	assert.equal(readFileSync(fixture.registry, "utf8"), beforeRegistry);
	assert.ok(runtime.notices.some(({ message, level }) => level === "warning" && message.includes(".atl/.skill-registry.cache.json") && message.includes("/skill-registry:refresh")));
	await runtime.refresh();
	assert.match(readFileSync(fixture.registry, "utf8"), /Changed skill/);
	assert.notEqual(readFileSync(cache, "utf8"), beforeCache);
});

test("registered Git detection failure skips automatic writes and reports deliberate refresh", async (t) => {
	const fixture = registryFixture(false);
	writeFileSync(join(fixture.cwd, ".git"), "invalid gitfile\n");
	const runtime = registeredRegistry(fixture.cwd);
	t.after(() => runtime.stop());
	await runtime.start();
	assert.equal(existsSync(fixture.ignore), false);
	assert.equal(existsSync(fixture.registry), false);
	assert.ok(runtime.notices.some(({ message, level }) => level === "warning" && message.includes(".atl/.gitignore") && message.includes("/skill-registry:refresh")));
	assert.ok(!runtime.notices.some(({ message }) => message.includes("refreshed")));
	await runtime.refresh();
	assert.match(readFileSync(fixture.registry, "utf8"), /Initial skill/);
});

for (const nested of [false, true]) {
	test(`registered startup fails closed for broken Git redirect with nested=${nested}`, async (t) => {
		const fixture = registryFixture(false, nested);
		writeFileSync(join(fixture.root, ".git"), "gitdir: missing-git-directory\n");
		const runtime = registeredRegistry(fixture.cwd);
		t.after(() => runtime.stop());
		await runtime.start();
		for (const path of [fixture.ignore, fixture.registry, join(fixture.cwd, ".atl", ".skill-registry.cache.json")]) {
			assert.equal(existsSync(path), false, `automatic startup must not create ${path}`);
		}
		assert.ok(runtime.notices.some(({ message, level }) => level === "warning" && message.includes("Resolve Git detection")));
		assert.ok(!runtime.notices.some(({ message }) => message.includes("refreshed")));
	});
}

test("registered startup preserves tracked generated legacy source with accurate manual remedy", async (t) => {
	const fixture = registryFixture();
	const legacy = join(fixture.cwd, ".pi", "extensions", "skill-registry.ts");
	const source = 'Auto-generated by .pi/extensions/skill-registry.ts\nconst REGISTRY_REL_PATH = ".atl/skill-registry.md"\nfunction projectSkillDirs(cwd: string): string[]\nfunction regenerateRegistry(cwd: string, force: boolean)\n';
	mkdirSync(dirname(legacy), { recursive: true });
	writeFileSync(legacy, source);
	execSync("git add .pi/extensions/skill-registry.ts", { cwd: fixture.root, stdio: "ignore" });
	const runtime = registeredRegistry(fixture.cwd);
	t.after(() => runtime.stop());
	await runtime.start();
	assert.equal(readFileSync(legacy, "utf8"), source);
	assert.equal(existsSync(`${legacy}.disabled`), false);
	assert.ok(!runtime.notices.some(({ message }) => /quarantined/i.test(message)));
	const warning = runtime.notices.find(({ message, level }) => level === "warning" && message.includes(".pi/extensions/skill-registry.ts"))?.message ?? "";
	assert.match(warning, /manually.*tracked legacy extension/i);
	assert.doesNotMatch(warning, /\/skill-registry:refresh/);
	await runtime.refresh();
	assert.equal(readFileSync(legacy, "utf8"), source);
	assert.equal(existsSync(`${legacy}.disabled`), false);
});

for (const control of ["environment", "--no-skills", "-ns"]) {
	test(`registered ${control} suppression skips startup writes and watchers`, async (t) => {
		const fixture = registryFixture();
		const runtime = registeredRegistry(fixture.cwd);
		const previousEnv = process.env.GENTLE_PI_NO_SKILL_REGISTRY;
		const previousArgv = process.argv;
		if (control === "environment") process.env.GENTLE_PI_NO_SKILL_REGISTRY = "1";
		else process.argv = [...process.argv, control];
		t.after(() => {
			process.argv = previousArgv;
			if (previousEnv === undefined) delete process.env.GENTLE_PI_NO_SKILL_REGISTRY;
			else process.env.GENTLE_PI_NO_SKILL_REGISTRY = previousEnv;
			return runtime.stop();
		});
		await runtime.start();
		assert.equal(existsSync(fixture.registry), false);
		assert.equal(existsSync(fixture.ignore), false);
		assert.equal(__testing.activeWatcherCount(), 0);
		await runtime.refresh();
		assert.match(readFileSync(fixture.registry, "utf8"), /Initial skill/);
	});
}

// gentle-shell#1690: delegated rpc children have hasUI=true but must not write
// .atl/, rename the legacy registry or start a watcher in the shared cwd.
test("registered startup in a delegated child avoids writes, legacy rename and watchers", async (t) => {
	const fixture = registryFixture();
	const legacy = join(fixture.cwd, ".pi", "extensions", "skill-registry.ts");
	mkdirSync(dirname(legacy), { recursive: true });
	const source = 'Auto-generated by .pi/extensions/skill-registry.ts\nconst REGISTRY_REL_PATH = ".atl/skill-registry.md"\nfunction projectSkillDirs(cwd: string): string[]\nfunction regenerateRegistry(cwd: string, force: boolean)\n';
	writeFileSync(legacy, source);
	const previous = process.env.GENTLE_PI_AGENTS_CHILD;
	process.env.GENTLE_PI_AGENTS_CHILD = "1";
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previous;
	});
	const runtime = registeredRegistry(fixture.cwd);
	t.after(() => runtime.stop());
	await runtime.start();
	assert.equal(existsSync(fixture.registry), false);
	assert.equal(existsSync(fixture.ignore), false);
	assert.equal(readFileSync(legacy, "utf8"), source);
	assert.equal(existsSync(`${legacy}.disabled`), false);
	assert.equal(__testing.activeWatcherCount(), 0);
	assert.deepEqual(runtime.notices, []);
});

test("registered suppression avoids writes and watchers but permits explicit refresh", async (t) => {
	const fixture = registryFixture();
	const runtime = registeredRegistry(fixture.cwd, true);
	t.after(() => runtime.stop());
	await runtime.start();
	assert.equal(existsSync(fixture.registry), false);
	assert.equal(existsSync(fixture.ignore), false);
	assert.equal(__testing.activeWatcherCount(), 0);
	await runtime.refresh();
	assert.match(readFileSync(fixture.registry, "utf8"), /Initial skill/);
});

// S7 CR4: the delayed regeneration after a legacy quarantine belongs to the
// session that scheduled it; a shutdown before it fires cancels it.
test("registered startup skips the delayed quarantine regeneration after shutdown", async () => {
	const fixture = registryFixture();
	const legacy = join(fixture.cwd, ".pi", "extensions", "skill-registry.ts");
	mkdirSync(dirname(legacy), { recursive: true });
	writeFileSync(legacy, 'Auto-generated by .pi/extensions/skill-registry.ts\nconst REGISTRY_REL_PATH = ".atl/skill-registry.md"\nfunction projectSkillDirs(cwd: string): string[]\nfunction regenerateRegistry(cwd: string, force: boolean)\n');
	const runtime = registeredRegistry(fixture.cwd);
	await runtime.start();
	assert.equal(existsSync(`${legacy}.disabled`), true, "the legacy registry was quarantined");
	await runtime.stop();
	rmSync(fixture.registry);
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert.equal(existsSync(fixture.registry), false, "a shut-down session must not regenerate the registry");
});

// S4: regeneration must not hold Pi's serial session_start chain.
test("registered startup returns before regenerating and settles to the same output", async (t) => {
	const fixture = registryFixture();
	const runtime = registeredRegistry(fixture.cwd);
	t.after(() => runtime.stop());
	await runtime.startOnly();
	assert.equal(existsSync(fixture.registry), false, "session_start must not await regeneration");
	await __testing.startupSettled();
	assert.match(readFileSync(fixture.registry, "utf8"), /Initial skill/);
	assert.equal(readFileSync(fixture.ignore, "utf8"), "*\n");
	assert.ok(runtime.notices.some(({ message }) => message === "Skill registry refreshed (1 skills)"));
});

// S4: a Git lookup that never answers (a repository rooted at HOME) takes the
// existing fail-closed path instead of hanging.
test("automatic Git tracking check times out into the fail-closed path", { skip: process.platform === "win32" }, async (t) => {
	const fixture = registryFixture();
	const bin = mkdtempSync(join(tmpdir(), "gentle-pi-slow-git-"));
	writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 3\n", { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	const previousTimeout = __testing.setGitTimeoutMs(200);
	t.after(() => {
		process.env.PATH = previousPath;
		__testing.setGitTimeoutMs(previousTimeout);
		rmSync(bin, { recursive: true, force: true });
	});
	const started = Date.now();
	await assert.rejects(__testing.ensureAtlIgnored(fixture.cwd), /Cannot verify Git tracking/);
	assert.ok(Date.now() - started < 2000, "the lookup must stop at its timeout");
	assert.equal(existsSync(fixture.ignore), false);
});

// S2: a repository rooted at HOME makes every Git call scan the whole home.
// Startup skips the automatic Git work there; deliberate refresh still works.
test("registered startup skips Git work and watchers when the repository is rooted at HOME", async (t) => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-registry-git-home-")));
	execSync("git init", { cwd: home, stdio: "ignore" });
	const cwd = join(home, "project");
	const skill = join(cwd, "skills", "local", "SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, "---\nname: local\ndescription: Initial skill.\n---\n");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	const runtime = registeredRegistry(cwd);
	t.after(async () => {
		await runtime.stop();
		process.env.HOME = fixtureHome;
		process.env.USERPROFILE = fixtureHome;
		rmSync(home, { recursive: true, force: true });
	});
	await runtime.start();
	assert.equal(existsSync(join(cwd, ".atl", ".gitignore")), false);
	assert.equal(existsSync(join(cwd, ".atl", "skill-registry.md")), false);
	assert.equal(__testing.activeWatcherCount(), 0);
	assert.deepEqual(runtime.notices, []);
	await runtime.refresh();
	assert.match(readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8"), /Initial skill/);
});

// gentle-shell#373: permission failures must degrade truthfully. The registry
// refresh reports a typed unavailable result with the offending path and a
// safe next action, never a successful regeneration, and unexpected I/O keeps
// its own diagnostic.
test("isStorageUnavailableError classifies only storage faults", () => {
	for (const code of ["EACCES", "EPERM", "EROFS", "ENOTDIR", "EISDIR", "EEXIST"]) {
		assert.equal(__testing.isStorageUnavailableError({ code }), true, code);
	}
	for (const code of ["ENOENT", "EMFILE", "ELOOP", "ENOSPC"]) {
		assert.equal(__testing.isStorageUnavailableError({ code }), false, code);
	}
	assert.equal(__testing.isStorageUnavailableError(new Error("no code")), false);
	assert.equal(__testing.isStorageUnavailableError(null), false);
});

test("regenerateRegistry reports a typed unavailable result instead of throwing on EACCES", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-skill-373-eacces-"));
	t.after(() => {
		chmodSync(join(cwd, ".atl"), 0o755);
		rmSync(cwd, { recursive: true, force: true });
	});
	mkdirSync(join(cwd, "skills", "a"), { recursive: true });
	writeFileSync(join(cwd, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: A skill.\n---\nbody");
	const first = await __testing.regenerateRegistry(cwd, true);
	assert.equal(first.regenerated, true, "the happy path must succeed before the fault is injected");

	// A write of an existing registry file succeeds regardless of the
	// directory mode (the file owner owns the open), so the read-only case
	// must remove the managed files first: the fresh-install scenario where
	// storage is read-only and the write actually fails.
	rmSync(join(cwd, ".atl", "skill-registry.md"), { force: true });
	rmSync(join(cwd, ".atl", ".skill-registry.cache.json"), { force: true });
	chmodSync(join(cwd, ".atl"), 0o555);
	const result = await __testing.regenerateRegistry(cwd, true, true);
	assert.equal(result.regenerated, false, "a permission failure must never report success");
	assert.equal(result.reason, "storage-unavailable");
	assert.match(result.warning ?? "", /\.atl[/\\]skill-registry\.md/);
	assert.match(result.warning ?? "", /not writable/);
	assert.match(result.warning ?? "", /\/skill-registry:refresh/);
	assert.equal(existsSync(join(cwd, ".atl", "skill-registry.md")), false);

	chmodSync(join(cwd, ".atl"), 0o755);
	const recovered = await __testing.regenerateRegistry(cwd, true, true);
	assert.equal(recovered.regenerated, true, "the registry must regenerate once storage is writable again");
});

test("regenerateRegistry degrades truthfully when .atl is a regular file", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-skill-373-enotdir-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, ".atl"), "not a directory\n");
	const result = await __testing.regenerateRegistry(cwd, true, true);
	assert.equal(result.regenerated, false, "a non-directory .atl must never report success");
	assert.equal(result.reason, "storage-unavailable");
	assert.match(result.warning ?? "", /not writable/);
});

test("S5 roots, Codex override, UTF-8 order and Unicode whitespace follow the shared discovery contract", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-shared-roots-"));
	const home = mkdtempSync(join(tmpdir(), "gentle-shared-home-"));
	const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldCodex = process.env.CODEX_HOME;
	t.after(() => {
		if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
		if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
		if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
		rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
	});
	process.env.HOME = home; process.env.USERPROFILE = home;
	const codex = join(home, "codex-real"); mkdirSync(join(codex, "skills"), { recursive: true });
	process.env.CODEX_HOME = relative(process.cwd(), codex);
	const projectRoots = ["skills", ".opencode/skills", ".claude/skills", ".gemini/skills", ".trae/skills", ".cursor/skills", ".github/skills", ".codex/skills", ".qwen/skills", ".kiro/skills", ".openclaw/skills", ".pi/skills", ".agent/skills", ".agents/skills", ".atl/skills", ".hermes/skills"];
	assert.deepEqual(__testing.projectSkillDirs(cwd), projectRoots.map((root) => join(cwd, root)));
	const userRoots = [".pi/agent/skills", ".config/agents/skills", ".agents/skills", ".kimi-code/skills", ".kimi/skills", ".config/opencode/skills", ".config/kilo/skills", ".claude/skills", ".gemini/skills", ".gemini/config/skills", ".gemini/antigravity/skills", ".gemini/antigravity-desktop/skills", ".gemini/antigravity-cli/skills", ".cursor/skills", ".copilot/skills", "CODEX", ".codeium/windsurf/skills", ".qwen/skills", ".kiro/skills", ".openclaw/skills", ".hermes/skills", ".trae/skills"];
	assert.deepEqual(await __testing.userSkillDirs(), userRoots.map((root) => root === "CODEX" ? join(realpathSync(codex), "skills") : join(home, root)));
	const low = join(cwd, "skills", "one", "SKILL.md"), high = join(cwd, "skills", "two", "SKILL.md");
	mkdirSync(dirname(low), { recursive: true }); mkdirSync(dirname(high), { recursive: true });
	writeFileSync(low, "---\nname: \uE000\ndescription: alpha\u0085beta\n---\n");
	writeFileSync(high, "---\nname: \u{10000}\ndescription: gamma\uFEFFdelta\n---\n");
	const { pi, commands } = fakeSkillRegistryPi(); skillRegistry(pi);
	await commands.get("skill-registry:refresh")!.handler("", { cwd, hasUI: false, ui: { notify() {} } });
	const disk = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.ok(disk.indexOf("`\uE000`") < disk.indexOf("`\u{10000}`"), "names sort by UTF-8 bytes");
	assert.ok(disk.includes("alpha beta"), "NEL is Unicode White_Space");
	assert.ok(disk.includes("gamma\uFEFFdelta"), "BOM is not Unicode White_Space");
});

test("S5–S6 registered refresh publishes exact disk-only bytes and repairs the cache without rewriting equal bytes", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-shared-registry-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const skill = join(cwd, "skills", "local", "SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, '---\nname: local\ndescription: "Trigger: local | docs"\n---\n');
	const { pi, handlers, commands } = fakeSkillRegistryPi();
	skillRegistry(pi);
	const refresh = commands.get("skill-registry:refresh")!;
	const notices: string[] = [];
	const ctx = { cwd, hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
	await refresh.handler("", ctx); // A cold command has no runtime capture.
	const registryPath = join(cwd, ".atl", "skill-registry.md");
	const cachePath = join(cwd, ".atl", ".skill-registry.cache.json");
	const expected = [
		`# Skill Registry — ${cwd.split(/[\\/]/).at(-1)}`, "",
		"<!-- Shared disk skill registry; generated by Gentle Shell or Gentle AI. -->", "",
		"## Sources scanned", "", "- skills", "", "## Contract", "",
		"**Delegator use only.** This disk index is not a summary and excludes session-only runtime skills. Pi delegators use their effective session view; other delegators use these rows. Pass exact `SKILL.md` paths to subagents.", "",
		"`SKILL.md` remains the source of truth. Do not inject generated summaries or compact rules by default; pass paths so subagents load the full runtime contract and preserve author intent.", "",
		"## Skills", "", "| Skill | Trigger / description | Scope | Path |", "| --- | --- | --- | --- |",
		`| \`local\` | Trigger: local \\| docs | project | \`${skill}\` |`, "", "## Loading protocol", "",
		"1. Match task context and target files against the effective view's `Trigger / description` column.",
		"2. Pass only the matching `Path` values to the subagent under `## Skills to load before work`.",
		"3. Instruct the subagent to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.",
		"4. If no matching skill exists, proceed without project skill injection and report `skill_resolution: none`.", "",
	].join("\n");
	assert.equal(readFileSync(registryPath, "utf8"), expected);
	const { createHash } = await import("node:crypto");
	const hash = createHash("sha256").update(expected).digest("hex");
	assert.equal(readFileSync(cachePath, "utf8"), `{"schema":1,"registry_sha256":"${hash}"}\n`);
	const before = statSync(registryPath).mtimeMs;
	writeFileSync(cachePath, '{"fingerprint":"legacy"}');
	await refresh.handler("", ctx);
	assert.equal(readFileSync(cachePath, "utf8"), `{"schema":1,"registry_sha256":"${hash}"}\n`);
	assert.equal(statSync(registryPath).mtimeMs, before, "forced equality must not rewrite registry");
	const options = { skills: [{ name: "runtime", description: "Runtime only", filePath: join(cwd, "custom", "SKILL.md") }], appendSystemPrompt: "existing" };
	await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, ctx);
	assert.ok(options.appendSystemPrompt.includes(skill) && !options.appendSystemPrompt.includes("Runtime only"));
	assert.equal(readFileSync(registryPath, "utf8"), expected);
	assert.equal(statSync(registryPath).mtimeMs, before);
	assert.ok(notices.some((message) => message.includes(".atl/skill-registry.md")));
	await handlers.get("session_shutdown")![0](undefined, ctx);
});

test("S7 registered prompt replaces runtime batches, suppresses disabled winners, and retains raw same-name alternatives", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-effective-registry-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const winner = join(cwd, "skills", "winner", "SKILL.md");
	const alternate = join(cwd, ".claude", "skills", "alternate", "SKILL.md");
	for (const [path, description] of [[winner, "First disk candidate"], [alternate, "Alternate disk candidate"]]) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nname: duplicate\ndescription: ${description}\n---\n`);
	}
	// A disk copy of the runtime skill shows whether the runtime capture is current.
	const runtimeCopy = join(cwd, ".agents", "skills", "runtime-copy", "SKILL.md");
	mkdirSync(dirname(runtimeCopy), { recursive: true });
	writeFileSync(runtimeCopy, "---\nname: runtime\ndescription: Runtime disk copy\n---\n");
	const { pi, handlers, commands } = fakeSkillRegistryPi();
	skillRegistry(pi);
	const event = handlers.get("before_agent_start")![0];
	const ctx = { cwd, hasUI: false, ui: { notify() {} } };
	await commands.get("skill-registry:refresh")!.handler("", ctx);
	const registry = join(cwd, ".atl", "skill-registry.md");
	const original = readFileSync(registry, "utf8");
	const runtime = join(cwd, "custom", "runtime", "SKILL.md");
	const options: { skills?: unknown; appendSystemPrompt: string } = { skills: [{ name: "runtime", description: "Package runtime", filePath: runtime, sourceInfo: { scope: "project", origin: "package" } }], appendSystemPrompt: "other extension" };
	await event({ systemPromptOptions: options }, ctx);
	assert.ok(!options.appendSystemPrompt.includes(runtime) && !options.appendSystemPrompt.includes(runtimeCopy), "Pi lists the runtime winner");
	assert.ok(options.appendSystemPrompt.includes(winner));
	assert.equal(readFileSync(registry, "utf8"), original);
	options.skills = [{ name: "broken", description: "invalid", filePath: 2 }];
	await event({ systemPromptOptions: options }, ctx);
	assert.ok(!options.appendSystemPrompt.includes(runtimeCopy), "malformed capture preserves the last valid batch");
	assert.ok(!options.appendSystemPrompt.includes("broken"));
	options.skills = [{ name: "duplicate", description: "Disabled", filePath: winner, disableModelInvocation: true }];
	await event({ systemPromptOptions: options }, ctx);
	assert.ok(!options.appendSystemPrompt.includes(runtime) && options.appendSystemPrompt.includes(runtimeCopy), "replacement removes the old runtime capture");
	assert.ok(!options.appendSystemPrompt.includes(winner), "disabled resolved path is suppressed");
	assert.ok(options.appendSystemPrompt.includes(alternate), "same-name alternate survives suppression");
	options.skills = [];
	await event({ systemPromptOptions: options }, ctx);
	assert.ok(options.appendSystemPrompt.includes(winner), "empty valid capture restores independently eligible disk paths");
	assert.ok(!options.appendSystemPrompt.includes(alternate));
	assert.ok(options.appendSystemPrompt.startsWith("other extension"));
	await handlers.get("session_shutdown")![0](undefined, ctx);
});

test("S4–S7 disk edits update the next effective view while runtime remains session-local", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-effective-disk-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	isolatedHome(t);
	const skill = join(cwd, "skills", "disk", "SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	const one = "---\nname: disk\ndescription: first\n---\n";
	const two = "---\nname: disk\ndescription: other\n---\n";
	writeFileSync(skill, one);
	utimesSync(skill, 1_000_000_000, 1_000_000_000);
	const { pi, handlers, commands } = fakeSkillRegistryPi();
	skillRegistry(pi);
	const event = handlers.get("before_agent_start")![0];
	const ctx = { cwd, hasUI: false, ui: { notify() {} } };
	const runtime = join(cwd, "outside", "SKILL.md");
	const options: { skills?: unknown; appendSystemPrompt: string } = { skills: [{ name: "runtime", description: "Runtime retained", filePath: runtime }], appendSystemPrompt: "" };
	await commands.get("skill-registry:refresh")!.handler("", ctx);
	await event({ systemPromptOptions: options }, ctx);
	assert.match(options.appendSystemPrompt, /first/);
	writeFileSync(skill, two);
	utimesSync(skill, 1_000_000_000, 1_000_000_000);
	await commands.get("skill-registry:refresh")!.handler("", ctx);
	options.skills = undefined;
	await event({ systemPromptOptions: options }, ctx);
	assert.match(options.appendSystemPrompt, /other/);
	assert.doesNotMatch(options.appendSystemPrompt, /first/);
	assert.ok(!options.appendSystemPrompt.includes(runtime), "Pi lists the runtime skill");
	rmSync(skill);
	await commands.get("skill-registry:refresh")!.handler("", ctx);
	await event({ systemPromptOptions: options }, ctx);
	assert.ok(!options.appendSystemPrompt.includes(skill));
	assert.equal(options.appendSystemPrompt, "", "no on-disk-only rows remain");
	assert.ok(!readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8").includes(runtime));
	await handlers.get("session_shutdown")![0](undefined, ctx);
});

for (const [label, excluded] of [
	["direct sdd prefix", "sdd-hidden"],
	["nested sdd prefix", "category/sdd-hidden"],
	["direct shared name", "_shared"],
	["nested shared name", "category/_shared"],
	["direct registry name", "skill-registry"],
	["nested registry name", "category/skill-registry"],
	["excluded category", "sdd-category/child"],
] as const) {
	test(`S5 correction B1 excludes ${label} before reading its alias`, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "gentle-s5-excluded-"));
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		const create = (path: string, name: string, description: string) => {
			const file = join(cwd, "skills", path, "SKILL.md");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n`);
			return file;
		};
		const hidden = create(excluded, "safe-alias", "Must stay excluded");
		const winner = create("disabled", "duplicate", "Disk winner");
		const alternate = create("z-alternate", "duplicate", "Eligible alternate");
		const visible = create("visible", "visible", "Visible skill");
		const runtime = join(cwd, "custom", "runtime", "SKILL.md");
		const { pi, handlers, commands } = fakeSkillRegistryPi();
		skillRegistry(pi);
		const notices: string[] = [];
		const ctx = { cwd, hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
		await commands.get("skill-registry:refresh")!.handler("", ctx);
		const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
		assert.deepEqual(registry.split("\n").filter((line) => line.startsWith("| `")), [
			`| \`duplicate\` | Disk winner | project | \`${winner}\` |`,
			`| \`visible\` | Visible skill | project | \`${visible}\` |`,
		]);
		assert.ok(!registry.includes(hidden));
		assert.deepEqual(notices, ["Skill registry: 2 skill(s) written to .atl/skill-registry.md"]);
		const options = { skills: [
			{ name: "duplicate", description: "Disabled", filePath: winner, disableModelInvocation: true },
			{ name: "runtime", description: "Runtime skill", filePath: runtime, sourceInfo: { scope: "project", origin: "package" } },
		], appendSystemPrompt: "" };
		await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, ctx);
		assert.deepEqual(options.appendSystemPrompt.split("\n").filter((line) => line.startsWith("| `")), [
			`| \`duplicate\` | Eligible alternate | \`${alternate}\` |`,
			`| \`visible\` | Visible skill | \`${visible}\` |`,
		]);
		assert.ok(!options.appendSystemPrompt.includes(hidden));
		assert.equal(readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8"), registry);
		await handlers.get("session_shutdown")![0](undefined, ctx);
	});
}

test("S5 correction B1 preserves eligible direct symlinks and rejects excluded symlinks and categories", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-s5-links-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const roots = join(cwd, "skills"), targets = join(cwd, "targets");
	for (const [path, name] of [["allowed", "linked"], ["excluded", "excluded-alias"], ["category/child", "category-alias"]]) {
		mkdirSync(join(targets, path), { recursive: true });
		writeFileSync(join(targets, path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
	}
	mkdirSync(roots, { recursive: true });
	symlinkSync(join(targets, "allowed"), join(roots, "linked"), "dir");
	symlinkSync(join(targets, "excluded"), join(roots, "sdd-linked"), "dir");
	symlinkSync(join(targets, "category"), join(roots, "linked-category"), "dir");
	const { pi, commands } = fakeSkillRegistryPi();
	skillRegistry(pi);
	const notices: string[] = [];
	await commands.get("skill-registry:refresh")!.handler("", { cwd, hasUI: true, ui: { notify: (message: string) => notices.push(message) } });
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.deepEqual(registry.split("\n").filter((line) => line.startsWith("| `")), [
		`| \`linked\` | linked | project | \`${join(roots, "linked", "SKILL.md")}\` |`,
	]);
	assert.deepEqual(notices, ["Skill registry: 1 skill(s) written to .atl/skill-registry.md"]);
});

for (const [label, quote] of [["apostrophe", "'"], ["double quote", '"']] as const) {
	test(`S5 correction B3 preserves a single unmatched ${label} in the public view`, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "gentle-s5-quote-"));
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		const create = (dir: string, name: string, description: string) => {
			const file = join(cwd, "skills", dir, "SKILL.md");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n`);
			return file;
		};
		const literal = create("literal", quote, quote);
		const empty = create("empty", "''", "''");
		const paired = create("paired-dir", "'paired'", '"Paired description"');
		const expected = [
			`| \`${quote}\` | ${quote} | project | \`${literal}\` |`,
			`| \`empty\` | — | project | \`${empty}\` |`,
			`| \`paired\` | Paired description | project | \`${paired}\` |`,
		];
		const { pi, handlers, commands } = fakeSkillRegistryPi();
		skillRegistry(pi);
		const notices: string[] = [];
		const ctx = { cwd, hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
		await commands.get("skill-registry:refresh")!.handler("", ctx);
		const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
		assert.deepEqual(registry.split("\n").filter((line) => line.startsWith("| `")), expected);
		assert.deepEqual(notices, ["Skill registry: 3 skill(s) written to .atl/skill-registry.md"]);
		const options = { skills: [], appendSystemPrompt: "" };
		await handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, ctx);
		assert.deepEqual(options.appendSystemPrompt.split("\n").filter((line) => line.startsWith("| `")), expected.map((row) => row.replace(" | project | ", " | ")));
		assert.equal(readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8"), registry);
		await handlers.get("session_shutdown")![0](undefined, ctx);
	});
}

test("regenerateRegistry preserves the diagnostic for unexpected I/O errors", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-skill-373-eloop-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	symlinkSync(join(cwd, ".atl", "self"), join(cwd, ".atl"));
	await assert.rejects(
		__testing.regenerateRegistry(cwd, true, true),
		/ELOOP/,
		"unexpected I/O must keep its own diagnostic instead of a typed unavailable result",
	);
});

// cost-speed-painpoints S15 P2: Pi already lists its loaded skills in
// `<available_skills>`; the effective block carries only on-disk skills Pi did
// not load, so the parent's view is `<available_skills>` plus these rows.
const UNLISTED_HEADING = "## Effective session skills: on disk, not loaded by Pi; `<available_skills>` lists the rest";

async function unlistedFixture(t: { after(fn: () => void): void }) {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-p2-cwd-"));
	const home = isolatedHome(t);
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const create = (root: string, dir: string, name: string, description: string) => {
		const file = join(root, dir, "SKILL.md");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n`);
		return file;
	};
	const { pi, handlers } = fakeSkillRegistryPi(); skillRegistry(pi);
	return { cwd, home, create, event: handlers.get("before_agent_start")![0], shutdown: handlers.get("session_shutdown")![0] };
}

test("P2 a skill Pi loaded is not repeated in the effective block", async (t) => {
	const { cwd, create, event, shutdown } = await unlistedFixture(t);
	const loaded = create(join(cwd, "skills"), "loaded", "loaded", "Loaded by Pi.");
	const diskOnly = create(join(cwd, ".claude", "skills"), "disk-only", "disk-only", "Only on disk.");
	const packaged = "/pkg/skills/packaged/SKILL.md";
	const options = { skills: [
		{ name: "loaded", description: "Loaded by Pi.", filePath: loaded, sourceInfo: { scope: "project" as const } },
		{ name: "packaged", description: "Package skill.", filePath: packaged, sourceInfo: { scope: "user" as const, origin: "package" as const } },
	], appendSystemPrompt: "" };
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(!options.appendSystemPrompt.includes(loaded), "a Pi-loaded disk skill is not repeated");
	assert.ok(!options.appendSystemPrompt.includes(packaged), "a Pi-loaded package skill is not repeated");
	assert.ok(options.appendSystemPrompt.includes(diskOnly));
	await shutdown(undefined, { cwd, hasUI: false });
});

test("P2 a skill only on disk is listed with name, description and path and no scope column", async (t) => {
	const { cwd, home, create, event, shutdown } = await unlistedFixture(t);
	const loaded = create(join(cwd, "skills"), "loaded", "loaded", "Loaded by Pi.");
	const diskOnly = create(join(home, ".claude", "skills"), "other-agent", "other-agent", "Trigger: other agent | shared.");
	const options = { skills: [{ name: "loaded", description: "Loaded by Pi.", filePath: loaded }], appendSystemPrompt: "existing" };
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, [
		"existing", "",
		"<!-- gentle-pi effective skills begin -->",
		UNLISTED_HEADING,
		"| Skill | Trigger / description | Path |",
		"| --- | --- | --- |",
		`| \`other-agent\` | Trigger: other agent \\| shared. | \`${diskOnly}\` |`,
		"<!-- gentle-pi effective skills end -->",
	].join("\n"));
	await shutdown(undefined, { cwd, hasUI: false });
});

test("P2 no on-disk-only skills emits no effective block", async (t) => {
	const { cwd, create, event, shutdown } = await unlistedFixture(t);
	const loaded = create(join(cwd, "skills"), "loaded", "loaded", "Loaded by Pi.");
	const options = { skills: [{ name: "loaded", description: "Loaded by Pi.", filePath: loaded }, { name: "runtime", description: "Runtime.", filePath: "/pkg/runtime/SKILL.md" }], appendSystemPrompt: "existing" };
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, "existing");
	// A block emitted on an earlier turn is removed once every row is loaded by Pi.
	const later = create(join(cwd, ".agents", "skills"), "later", "later", "Later disk skill.");
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(options.appendSystemPrompt.includes(later));
	options.skills = [...options.skills, { name: "later", description: "Later disk skill.", filePath: later }];
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, "existing");
	await shutdown(undefined, { cwd, hasUI: false });
});

test("P2 effective rows are ordered by name and identical on the next turn", async (t) => {
	const { cwd, home, create, event, shutdown } = await unlistedFixture(t);
	const zeta = create(join(cwd, ".claude", "skills"), "zeta", "zeta", "Zeta.");
	const alpha = create(join(home, ".agents", "skills"), "alpha", "alpha", "Alpha.");
	const mid = create(join(cwd, "skills"), "mid", "mid", "Mid.");
	const loaded = create(join(cwd, "skills"), "beta", "beta", "Loaded.");
	const options = { skills: [{ name: "beta", description: "Loaded.", filePath: loaded }], appendSystemPrompt: "" };
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	const first = options.appendSystemPrompt;
	assert.deepEqual(first.split("\n").filter((line) => line.startsWith("| `")), [
		`| \`alpha\` | Alpha. | \`${alpha}\` |`,
		`| \`mid\` | Mid. | \`${mid}\` |`,
		`| \`zeta\` | Zeta. | \`${zeta}\` |`,
	]);
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, first);
	options.skills = [...options.skills];
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, first);
	await shutdown(undefined, { cwd, hasUI: false });
});

test("P2 the renamed registry skill stays out of the effective block while the disk index keeps CLI parity", async (t) => {
	const { cwd, home, create, event, shutdown } = await unlistedFixture(t);
	const renamed = create(join(home, ".claude", "skills"), "registry-copy", "gentle-ai-skill-registry", "Index skills.");
	const diskOnly = create(join(home, ".claude", "skills"), "other", "other", "Other agent skill.");
	const options = { skills: [], appendSystemPrompt: "" };
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.ok(options.appendSystemPrompt.includes(diskOnly));
	assert.ok(!options.appendSystemPrompt.includes(renamed), "the registry skill is never a selectable row");
	await __testing.regenerateRegistry(cwd, true, true);
	// The Gentle AI CLI writer excludes only `_shared` and `skill-registry`; equal inputs must give equal bytes.
	assert.ok(readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8").includes(renamed));
	await shutdown(undefined, { cwd, hasUI: false });
});

test("P2 the skill-registry skill names only existing references and no runtime internals", () => {
	const root = join(import.meta.dirname, "..");
	const skill = readFileSync(join(root, "skills", "skill-registry", "SKILL.md"), "utf8");
	const references = skill.slice(skill.indexOf("## References"));
	for (const [, path] of references.matchAll(/`([^`]+\.md)`/g)) assert.ok(existsSync(join(root, path)), `missing reference: ${path}`);
	assert.doesNotMatch(skill, /systemPromptOptions|pi\.skills|node_modules/);
	assert.match(skill, /`<available_skills>`/);
});

test("P2 Pi-loaded skills stay in the effective block when Pi renders no <available_skills>", async (t) => {
	const { cwd, event, shutdown } = await unlistedFixture(t);
	const packaged = "/pkg/skills/packaged/SKILL.md";
	const skills = [{ name: "packaged", description: "Package skill.", filePath: packaged, sourceInfo: { scope: "user" as const, origin: "package" as const } }];
	const without = { skills, selectedTools: ["grep", "find", "ls", "subagent_run"], appendSystemPrompt: "" };
	await event({ systemPromptOptions: without }, { cwd, hasUI: false });
	assert.ok(without.appendSystemPrompt.includes(packaged), "without read or bash Pi lists nothing, so the block carries the skill");
	assert.doesNotMatch(without.appendSystemPrompt, /lists the rest/);
	const withRead = { skills, selectedTools: ["read"], appendSystemPrompt: "" };
	await event({ systemPromptOptions: withRead }, { cwd, hasUI: false });
	assert.equal(withRead.appendSystemPrompt, "");
	const absent = { skills, appendSystemPrompt: "" };
	await event({ systemPromptOptions: absent }, { cwd, hasUI: false });
	assert.equal(absent.appendSystemPrompt, "", "an absent tool list is Pi's default, which includes read");
	await shutdown(undefined, { cwd, hasUI: false });
});

test("P2 a Pi-loaded symlinked skill and a disabled-only record emit no row", async (t) => {
	const { cwd, home, create, event, shutdown } = await unlistedFixture(t);
	const real = create(join(home, ".claude", "skills"), "linked", "linked", "Linked skill.");
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	symlinkSync(dirname(real), join(home, ".agents", "skills", "linked"), "dir");
	const viaLink = join(home, ".agents", "skills", "linked", "SKILL.md");
	const options = { skills: [
		{ name: "linked", description: "Linked skill.", filePath: viaLink },
		{ name: "hidden", description: "Disabled.", filePath: "/pkg/skills/hidden/SKILL.md", disableModelInvocation: true },
	], appendSystemPrompt: "" };
	await event({ systemPromptOptions: options }, { cwd, hasUI: false });
	assert.equal(options.appendSystemPrompt, "");
	await shutdown(undefined, { cwd, hasUI: false });
});

// gentle-shell#3020 regression coverage, ported from @Cobies' gentle-shell#3070
// onto the merged #3089 contract: the shared registry is disk-only and written
// only when its rendered bytes change, while each session's Pi-resolved skills
// stay session-local in its prompt. One shared `.atl/` is read by every Pi
// session in the cwd, so the decisive evidence has to come from genuinely
// separate processes. Each child imports the real extension and drives its
// public `before_agent_start` handler (a prompt) and the watcher-poll seam.
const registryExtensionUrl = pathToFileURL(
	join(import.meta.dirname, "..", "extensions", "skill-registry.ts"),
).href;

interface SharedCacheResult {
	regenerated: boolean;
	skillCount: number;
	reason: string;
	warning?: string;
}

interface SharedCacheOutcome {
	result: SharedCacheResult;
	// The effective block this process appended to its own prompt, if it prompted.
	prompt?: string;
}

interface ManagedFileSnapshot {
	bytes: string;
	ino: number;
	mtimeMs: number;
	size: number;
}

function managedFileSnapshot(path: string): ManagedFileSnapshot {
	const info = statSync(path);
	return { bytes: readFileSync(path, "utf8"), ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
}

function snapshotKey(snapshot: ManagedFileSnapshot | { bytes: string; ino: number; mtimeMs: number }): string {
	return JSON.stringify([snapshot.bytes, snapshot.ino, snapshot.mtimeMs]);
}

function sharedCacheFixture() {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-shared-cache-"));
	const cwd = join(root, "workspace");
	const skill = join(cwd, "skills", "loose", "SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, "---\nname: loose\ndescription: Shared cache loose skill.\n---\n");
	return {
		root,
		cwd,
		skill,
		home: join(root, "home"),
		cache: join(cwd, ".atl", ".skill-registry.cache.json"),
		registry: join(cwd, ".atl", "skill-registry.md"),
	};
}

// Child-side prelude shared by both process helpers: an isolated HOME, a fake
// Pi that records handlers, and a `prompt(resolved)` that fires the real
// `before_agent_start` with Pi listing nothing (`selectedTools: ["grep"]`), so
// the session's resolved rows must surface in its own effective block.
const sharedCacheChildPrelude = `
	import { join } from "node:path";
	delete process.env.GENTLE_PI_AGENTS_CHILD;
	process.env.HOME = join(process.env.GS_ROOT, "home");
	process.env.USERPROFILE = process.env.HOME;
	const { default: skillRegistry, __testing } = await import(process.env.GS_EXTENSION);
	const handlers = new Map();
	skillRegistry({
		on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerFlag() {},
		registerCommand() {},
		getFlag() { return false; },
	});
	const prompt = async (cwd, resolved) => {
		const options = { skills: resolved, selectedTools: ["grep"], appendSystemPrompt: "" };
		await handlers.get("before_agent_start")[0]({ systemPromptOptions: options }, { cwd, hasUI: false });
		return options.appendSystemPrompt;
	};
`;

function runSharedCacheProcess(root: string, cwd: string, resolved: ResolvedSkill[]): SharedCacheOutcome {
	// A session holding a resolved set prompts first (the real before_agent_start
	// path); every session then runs what a watcher poll does.
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		${sharedCacheChildPrelude}
		const cwd = ${JSON.stringify(cwd)};
		const resolved = ${JSON.stringify(resolved)};
		const promptText = resolved.length > 0 ? await prompt(cwd, resolved) : undefined;
		const result = await __testing.regenerateRegistry(cwd, false);
		console.log("RESULT " + JSON.stringify({ result, prompt: promptText }));
	`], {
		encoding: "utf8",
		timeout: 20_000,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: root, GS_ROOT: root, GS_EXTENSION: registryExtensionUrl },
	});
	assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
	assert.equal(child.status, 0, child.stderr);
	const line = child.stdout.split("\n").find((candidate) => candidate.startsWith("RESULT "));
	assert.ok(line, `child printed no result:\n${child.stdout}\n${child.stderr}`);
	return JSON.parse(line.slice("RESULT ".length)) as SharedCacheOutcome;
}

test("a process with no resolved skills cache-hits and preserves the published registry (#3020)", async (t) => {
	const fixture = sharedCacheFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const resolvedPath = join(fixture.root, "pkg", "skills", "prompted", "SKILL.md");
	const resolved: ResolvedSkill[] = [
		{
			name: "prompted",
			description: "Trigger: prompted session authority.",
			filePath: resolvedPath,
			sourceInfo: { scope: "project", origin: "package" },
		},
	];

	const published = runSharedCacheProcess(fixture.root, fixture.cwd, resolved);
	assert.equal(published.result.regenerated, true, "the first process must publish the shared registry");
	assert.equal(published.result.reason, "fingerprint-changed");
	assert.doesNotMatch(
		readFileSync(fixture.registry, "utf8"),
		new RegExp(escapeRegExp(resolvedPath)),
		"Pi-resolved rows are session-local and must never reach the shared registry",
	);
	assert.ok(published.prompt?.includes(resolvedPath), "the publishing session keeps its Pi-resolved rows in its own prompt");

	const registryBefore = managedFileSnapshot(fixture.registry);
	const cacheBefore = managedFileSnapshot(fixture.cache);
	await new Promise((resolve) => setTimeout(resolve, 25));

	const idle = runSharedCacheProcess(fixture.root, fixture.cwd, []);
	assert.equal(idle.result.regenerated, false, "a session with no resolved skills must not rewrite the shared registry");
	assert.equal(idle.result.reason, "cache-hit");
	assert.equal(idle.result.skillCount, 1, "the idle session still indexes the shared disk skill");
	assert.deepEqual(managedFileSnapshot(fixture.registry), registryBefore, "an idle poll must not rewrite the registry");
	assert.deepEqual(managedFileSnapshot(fixture.cache), cacheBefore, "an idle poll must not rewrite the cache");

	// The resolved session prompting again must not fight the idle one for the file.
	const peerPoll = runSharedCacheProcess(fixture.root, fixture.cwd, resolved);
	assert.equal(peerPoll.result.regenerated, false, "a prompted session must not republish the shared registry");
	assert.equal(peerPoll.result.reason, "cache-hit");
	assert.ok(peerPoll.prompt?.includes(resolvedPath));
	assert.deepEqual(managedFileSnapshot(fixture.registry), registryBefore, "a prompt plus poll must not rewrite the registry");
	assert.deepEqual(managedFileSnapshot(fixture.cache), cacheBefore, "a prompt plus poll must not rewrite the cache");

	// A real skill change still writes, exactly once, and stays disk-only.
	writeFileSync(fixture.skill, "---\nname: loose\ndescription: Changed loose skill.\n---\n");
	const filesChanged = runSharedCacheProcess(fixture.root, fixture.cwd, []);
	assert.equal(filesChanged.result.regenerated, true, "a skill byte change must still regenerate");
	const changedRegistry = readFileSync(fixture.registry, "utf8");
	assert.match(changedRegistry, /Changed loose skill/);
	assert.doesNotMatch(changedRegistry, new RegExp(escapeRegExp(resolvedPath)));
	const changedSnapshot = managedFileSnapshot(fixture.registry);

	const settled = runSharedCacheProcess(fixture.root, fixture.cwd, resolved);
	assert.equal(settled.result.regenerated, false, "the change must be bounded to one publish");
	assert.equal(settled.result.reason, "cache-hit");
	assert.deepEqual(managedFileSnapshot(fixture.registry), changedSnapshot);
});

const sharedCacheRoundsScript = `
	${sharedCacheChildPrelude}
	import fs from "node:fs";
	const root = process.env.GS_ROOT;
	const role = process.env.GS_ROLE;
	const peer = role === "a" ? "b" : "a";
	const cwd = join(root, "workspace");
	const cachePath = join(cwd, ".atl", ".skill-registry.cache.json");
	const registryPath = join(cwd, ".atl", "skill-registry.md");
	const logPath = join(root, "rounds-" + role + ".jsonl");
	const snapshot = (path) => {
		const info = fs.statSync(path);
		return { bytes: fs.readFileSync(path, "utf8"), ino: info.ino, mtimeMs: info.mtimeMs };
	};
	const waitFor = async (name) => {
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(join(root, name))) {
			if (Date.now() > deadline) throw new Error("timed out waiting for " + name);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	const resolved = JSON.parse(process.env.GS_RESOLVED);
	for (const round of [1, 2, 3]) {
		const promptText = await prompt(cwd, resolved);
		const result = await __testing.regenerateRegistry(cwd, false);
		fs.appendFileSync(logPath, JSON.stringify({
			role,
			round,
			result,
			prompt: promptText,
			cache: snapshot(cachePath),
			registry: snapshot(registryPath),
		}) + "\\n");
		fs.writeFileSync(join(root, "done-" + role + "-" + round), "");
		await waitFor("done-" + peer + "-" + round);
	}
	console.log("ROUNDS_DONE " + role);
`;

function runSharedCacheRounds(
	root: string,
	role: "a" | "b",
	resolved: ResolvedSkill[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", sharedCacheRoundsScript],
			{
				env: {
					...process.env,
					GIT_CEILING_DIRECTORIES: root,
					GS_ROOT: root,
					GS_ROLE: role,
					GS_RESOLVED: JSON.stringify(resolved),
					GS_EXTENSION: registryExtensionUrl,
				},
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

test("two processes with different resolved sets each publish once and then cache-hit (#3020)", { timeout: 30_000 }, async (t) => {
	const fixture = sharedCacheFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const resolvedPathFor = (role: "a" | "b") => join(fixture.root, "pkg", "skills", `session-${role}`, "SKILL.md");
	const resolvedFor = (role: "a" | "b"): ResolvedSkill[] => [
		{
			name: `session-${role}`,
			description: `Trigger: session ${role}.`,
			filePath: resolvedPathFor(role),
		},
	];

	const outcomes = await Promise.all([
		runSharedCacheRounds(fixture.root, "a", resolvedFor("a")),
		runSharedCacheRounds(fixture.root, "b", resolvedFor("b")),
	]);
	for (const outcome of outcomes) {
		assert.equal(outcome.status, 0, outcome.stderr);
		assert.match(outcome.stdout, /ROUNDS_DONE/);
	}

	type Snapshot = { bytes: string; ino: number; mtimeMs: number };
	type Round = { role: "a" | "b"; round: number; result: SharedCacheResult; prompt: string; cache: Snapshot; registry: Snapshot };
	const readRounds = (role: "a" | "b"): Round[] =>
		readFileSync(join(fixture.root, `rounds-${role}.jsonl`), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Round);
	const rounds = [...readRounds("a"), ...readRounds("b")];
	assert.equal(rounds.length, 6, "both processes must complete all three rounds");
	const firstRound = rounds.filter((entry) => entry.round === 1);
	const laterRounds = rounds.filter((entry) => entry.round > 1);
	assert.equal(firstRound.length, 2);
	assert.equal(laterRounds.length, 4);

	// Both sessions render the same disk-only bytes, so the first publication
	// is shared. Which process lands it (or whether both race identical bytes
	// in) is timing-dependent, so round 1 only bounds the count.
	const firstPublishes = firstRound.filter((entry) => entry.result.regenerated).length;
	assert.ok(firstPublishes >= 1 && firstPublishes <= 2, `round 1 must publish at most once per session, saw ${firstPublishes}`);
	for (const entry of firstRound.filter((candidate) => candidate.result.regenerated)) {
		assert.equal(entry.result.reason, "fingerprint-changed");
	}
	for (const entry of laterRounds) {
		assert.equal(entry.result.regenerated, false, `session ${entry.role} round ${entry.round} must be quiet`);
		assert.equal(entry.result.reason, "cache-hit");
	}
	assert.equal(
		rounds.filter((entry) => entry.result.regenerated).length,
		firstPublishes,
		"no session may publish again after the first round",
	);

	const steadyCaches = new Set(laterRounds.map((entry) => snapshotKey(entry.cache)));
	const steadyRegistries = new Set(laterRounds.map((entry) => snapshotKey(entry.registry)));
	assert.equal(steadyCaches.size, 1, "the shared cache must stop changing after the first publication");
	assert.equal(steadyRegistries.size, 1, "the shared registry must stop changing after the first publication");

	// Each session keeps its own resolved set in its own prompt, and the shared
	// file never carries either session's runtime-only rows.
	for (const entry of rounds) {
		const peer = entry.role === "a" ? "b" : "a";
		assert.ok(entry.prompt.includes(resolvedPathFor(entry.role)), `session ${entry.role} round ${entry.round} must see its own resolved row`);
		assert.ok(!entry.prompt.includes(resolvedPathFor(peer)), `session ${entry.role} must never see session ${peer}'s resolved row`);
	}
	const shared = readFileSync(fixture.registry, "utf8");
	for (const role of ["a", "b"] as const) {
		assert.doesNotMatch(shared, new RegExp(escapeRegExp(resolvedPathFor(role))), `session ${role}'s runtime row must stay out of the shared registry`);
	}
	assert.match(shared, new RegExp(escapeRegExp(fixture.skill)), "the shared registry still indexes the disk skill");
});
