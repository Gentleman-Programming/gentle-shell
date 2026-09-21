import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillRegistryExtension, { __testing, type ResolvedSkill } from "../extensions/skill-registry.ts";

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

test("findSkillFiles scans one skill directory level only", async () => {
	const root = join(tmpdir(), `gentle-pi-shallow-${Date.now()}`);
	const skillPath = join(root, "docs", "SKILL.md");
	const nestedSkillPath = join(root, "fixtures", "nested", "SKILL.md");
	mkdirSync(dirname(skillPath), { recursive: true });
	mkdirSync(dirname(nestedSkillPath), { recursive: true });
	writeFileSync(skillPath, "---\nname: docs\ndescription: Docs.\n---\n");
	writeFileSync(nestedSkillPath, "---\nname: nested\ndescription: Nested fixture.\n---\n");

	assert.deepEqual(await __testing.findSkillFiles(root), [skillPath]);
});

test("findSkillFiles follows symlinked skill directories", async (t) => {
	const root = join(tmpdir(), `gentle-pi-symlink-root-${Date.now()}`);
	const realSkillDir = join(tmpdir(), `gentle-pi-symlink-target-${Date.now()}`);
	const linkedSkillDir = join(root, "linked");
	const skillPath = join(linkedSkillDir, "SKILL.md");
	mkdirSync(root, { recursive: true });
	mkdirSync(realSkillDir, { recursive: true });
	writeFileSync(join(realSkillDir, "SKILL.md"), "---\nname: linked\ndescription: Linked skill.\n---\n");
	try {
		symlinkSync(realSkillDir, linkedSkillDir, "dir");
	} catch (error) {
		t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	assert.deepEqual(await __testing.findSkillFiles(root), [skillPath]);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

test("regenerateRegistry merges pi-resolved skills with the loose scan", async () => {
	const cwd = join(tmpdir(), `gentle-pi-regen-resolved-${Date.now()}`);
	const looseSkillPath = join(cwd, "skills", "loose-one", "SKILL.md");
	mkdirSync(dirname(looseSkillPath), { recursive: true });
	writeFileSync(looseSkillPath, "---\nname: loose-one\ndescription: Loose skill.\n---\n");

	const pkgRoot = join(tmpdir(), `gentle-pi-regen-pkg-${Date.now()}`);
	const resolvedSkillPath = join(pkgRoot, "skills", "resolved-one", "SKILL.md");
	const resolved: ResolvedSkill[] = [
		{
			name: "resolved-one",
			description: "Trigger: resolved skill. Runtime authority.",
			filePath: resolvedSkillPath,
			sourceInfo: { scope: "project", origin: "package" },
		},
	];

	const first = await __testing.regenerateRegistry(cwd, false, resolved);
	assert.equal(first.regenerated, true, "first regeneration writes the registry");
	assert.equal(first.reason, "fingerprint-changed");
	assert.ok(
		first.skillCount >= 2,
		"merged count must include the resolved skill and the loose skill (host user skills may add more)",
	);

	const registryPath = join(cwd, ".atl", "skill-registry.md");
	const registry = readFileSync(registryPath, "utf8");
	assert.match(registry, new RegExp(escapeRegExp(resolvedSkillPath)));
	assert.match(registry, new RegExp(escapeRegExp(looseSkillPath)));
	assert.match(registry, /project · package/);
	assert.match(
		registry,
		/Pi-resolved runtime authority \(before_agent_start\.systemPromptOptions\.skills\): 1 skill\(s\)/,
	);

	const second = await __testing.regenerateRegistry(cwd, false, resolved);
	assert.equal(second.regenerated, false, "identical resolved set must be a cache hit");
	assert.equal(second.reason, "cache-hit");

	const changed: ResolvedSkill[] = [
		...resolved,
		{
			name: "resolved-two",
			description: "Second resolved skill.",
			filePath: join(pkgRoot, "skills", "resolved-two", "SKILL.md"),
			sourceInfo: { scope: "user" },
		},
	];
	const third = await __testing.regenerateRegistry(cwd, false, changed);
	assert.equal(third.regenerated, true, "changed resolved set must regenerate");
	assert.equal(third.reason, "fingerprint-changed");
	const updated = readFileSync(registryPath, "utf8");
	assert.match(updated, /resolved-two/);
	assert.match(
		updated,
		/Pi-resolved runtime authority \(before_agent_start\.systemPromptOptions\.skills\): 2 skill\(s\)/,
	);
});

test("renderRegistry emits the pi-resolved authority bullet only when resolved entries exist", () => {
	const cwd = join(tmpdir(), `gentle-pi-render-resolved-${Date.now()}`);
	const entry = { name: "docs", path: join(cwd, "skills", "docs", "SKILL.md"), description: "Docs." };

	const withResolved = __testing.renderRegistry(cwd, ["skills"], [entry], 1);
	const sourcesIndex = withResolved.indexOf("## Sources scanned");
	const bulletText = "- Pi-resolved runtime authority (before_agent_start.systemPromptOptions.skills): 1 skill(s)";
	const bulletIndex = withResolved.indexOf(bulletText);
	assert.ok(bulletIndex > sourcesIndex, "authority bullet must live in the sources section");
	assert.ok(
		withResolved.indexOf("- skills") > bulletIndex,
		"authority bullet must be the first source bullet",
	);

	const withoutResolved = __testing.renderRegistry(cwd, ["skills"], [entry], 0);
	assert.doesNotMatch(withoutResolved, /Pi-resolved runtime authority/);
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

test("applyResolvedSkillsUpdate writes the registry from pi-resolved skills", async () => {
	const cwd = join(tmpdir(), `gentle-pi-apply-${Date.now()}`);
	const skillPath = join(tmpdir(), `gentle-pi-apply-pkg-${Date.now()}`, "skills", "applied", "SKILL.md");

	const result = await __testing.applyResolvedSkillsUpdate(cwd, [
		{
			name: "applied",
			description: "Trigger: applied skill. Runtime capture.",
			filePath: skillPath,
			sourceInfo: { scope: "project", origin: "package" },
		},
	] satisfies ResolvedSkill[]);

	assert.equal(result.regenerated, true, "first applied update must write the registry");
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.match(registry, new RegExp(escapeRegExp(skillPath)));
	assert.match(registry, /project · package/);
	assert.match(
		registry,
		/Pi-resolved runtime authority \(before_agent_start\.systemPromptOptions\.skills\): 1 skill\(s\)/,
	);
});

test("resolved set spans global packages, project-local packages, and custom paths", async () => {
	// Issue #369 acceptance: global and project-local npm packages plus custom
	// package-declared paths must all be represented by their exact SKILL.md path.
	const cwd = join(tmpdir(), `gentle-pi-apply-matrix-${Date.now()}`);
	const globalPkgPath = join("/", "usr", "lib", "node_modules", "@scope", "pkg-a", "skills", "global-pkg-skill", "SKILL.md");
	const projectPkgPath = join(cwd, "node_modules", "pkg-b", "skills", "project-pkg-skill", "SKILL.md");
	const customPath = join(cwd, "custom-declared", "skills", "custom-path-skill", "SKILL.md");

	const result = await __testing.applyResolvedSkillsUpdate(cwd, [
		{
			name: "global-pkg-skill",
			description: "Trigger: global npm package skill.",
			filePath: globalPkgPath,
			sourceInfo: { scope: "user", origin: "package" },
		},
		{
			name: "project-pkg-skill",
			description: "Trigger: project-local npm package skill.",
			filePath: projectPkgPath,
			sourceInfo: { scope: "project", origin: "package" },
		},
		{
			name: "custom-path-skill",
			description: "Trigger: custom package-declared path skill.",
			filePath: customPath,
			sourceInfo: { scope: "project", origin: "top-level" },
		},
	] satisfies ResolvedSkill[]);

	assert.equal(result.regenerated, true);
	// The loose scan merges this host's real user skill dirs, so the count is a
	// lower bound; the exact-path assertions below carry the acceptance weight.
	assert.ok(result.skillCount >= 3, `expected >= 3 skills, got ${result.skillCount}`);
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	for (const path of [globalPkgPath, projectPkgPath, customPath]) {
		assert.match(registry, new RegExp(escapeRegExp(path)));
	}
	assert.match(registry, /user · package/);
	assert.match(registry, /project · package/);
	assert.match(
		registry,
		/Pi-resolved runtime authority \(before_agent_start\.systemPromptOptions\.skills\): 3 skill\(s\)/,
	);
});

test("applyResolvedSkillsUpdate is idempotent for an unchanged resolved set", async () => {
	const cwd = join(tmpdir(), `gentle-pi-apply-idempotent-${Date.now()}`);
	const resolved: ResolvedSkill[] = [
		{
			name: "idempotent",
			description: "Trigger: idempotent skill.",
			filePath: "/pkg/skills/idempotent/SKILL.md",
			sourceInfo: { scope: "user", origin: "package" },
		},
	];

	await __testing.applyResolvedSkillsUpdate(cwd, resolved);
	const registryPath = join(cwd, ".atl", "skill-registry.md");
	const before = statSync(registryPath);
	await new Promise((resolve) => setTimeout(resolve, 25));

	const second = await __testing.applyResolvedSkillsUpdate(cwd, resolved);
	assert.equal(second.regenerated, false, "identical resolved set must be a cache hit");
	assert.equal(second.reason, "cache-hit");
	assert.equal(
		statSync(registryPath).mtimeMs,
		before.mtimeMs,
		"cache hit must not rewrite the registry file",
	);
});

test("applyResolvedSkillsUpdate regenerates when the resolved set changes", async () => {
	const cwd = join(tmpdir(), `gentle-pi-apply-change-${Date.now()}`);
	const firstPath = "/pkg/skills/change-one/SKILL.md";
	await __testing.applyResolvedSkillsUpdate(cwd, [
		{ name: "change-one", description: "First.", filePath: firstPath } satisfies ResolvedSkill,
	]);

	const secondPath = "/pkg/skills/change-two/SKILL.md";
	const changed = await __testing.applyResolvedSkillsUpdate(cwd, [
		{ name: "change-one", description: "First.", filePath: firstPath } satisfies ResolvedSkill,
		{ name: "change-two", description: "Second.", filePath: secondPath } satisfies ResolvedSkill,
	]);

	assert.equal(changed.regenerated, true, "changed resolved set must regenerate");
	assert.equal(changed.reason, "fingerprint-changed");
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.match(registry, new RegExp(escapeRegExp(secondPath)));
});

test("before_agent_start handler wires pi-resolved skills into the registry", async () => {
	// Happy path: the handler captures runtime-resolved skills for the session cwd.
	{
		const cwd = join(tmpdir(), `gentle-pi-wire-${Date.now()}`);
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
		await handler(
			{
				systemPromptOptions: {
					skills: [
						{
							name: "wired-skill",
							description: "Trigger: wired skill. Runtime capture.",
							filePath: skillPath,
							sourceInfo: { scope: "project", origin: "package" },
						},
					],
				},
			},
			{ cwd, hasUI: false },
		);

		const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
		assert.match(registry, new RegExp(escapeRegExp(skillPath)));
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

test("manual /skill-registry:refresh keeps the captured resolved set", async () => {
	const cwd = join(tmpdir(), `gentle-pi-refresh-${Date.now()}`);
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
	assert.ok(existsSync(join(cwd, ".atl", "skill-registry.md")));

	// A forced manual refresh must not drop the runtime-resolved authority.
	const notices: string[] = [];
	await refresh.handler("", { cwd, hasUI: true, ui: { notify: (text: string) => notices.push(text) } });
	const registry = readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8");
	assert.match(
		registry,
		new RegExp(escapeRegExp(skillPath)),
		"forced refresh must retain pi-resolved skills",
	);
	assert.ok(notices.length > 0);
});
