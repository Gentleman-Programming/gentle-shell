import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import createSkillRegistryExtension, { __testing } from "../extensions/skill-registry.ts";

function storageError(code: "EACCES" | "EPERM" | "EROFS" | "EIO", message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

function skillFixture(name: string): string {
	const cwd = join(tmpdir(), `gentle-pi-registry-${name}-${Date.now()}`);
	const skillPath = join(cwd, "skills", "docs", "SKILL.md");
	mkdirSync(dirname(skillPath), { recursive: true });
	writeFileSync(skillPath, "---\nname: docs\ndescription: Documentation.\n---\n");
	return cwd;
}

function extensionHarness() {
	const events = new Map<string, (event: unknown, ctx: any) => unknown>();
	const commands = new Map<string, { handler: (args: unknown, ctx: any) => unknown }>();
	createSkillRegistryExtension({
		getFlag: () => false,
		on(name: string, handler: (event: unknown, ctx: any) => unknown) {
			events.set(name, handler);
		},
		registerFlag() {},
		registerCommand(name: string, command: { handler: (args: unknown, ctx: any) => unknown }) {
			commands.set(name, command);
		},
	} as any);
	return { events, commands };
}

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

test("registry and cache storage restrictions never report successful regeneration", async (t) => {
	const cwd = skillFixture("restricted-writes");
	const atlDirectory = join(cwd, ".atl");
	const registryPath = join(cwd, ".atl", "skill-registry.md");
	const cachePath = join(cwd, ".atl", ".skill-registry.cache.json");
	t.after(() => __testing.resetStorage());

	__testing.setStorage({
		mkdir: async () => { throw storageError("EACCES", "directory denied"); },
	});
	const directoryFailure = await __testing.regenerateRegistry(cwd, true);
	assert.equal(directoryFailure.regenerated, false);
	assert.equal(directoryFailure.failure?.stage, "atl-directory");
	assert.equal(directoryFailure.failure?.path, atlDirectory);

	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === registryPath) throw storageError("EACCES", "registry denied");
			return writeFileAsync(path, data);
		},
	});
	const registryFailure = await __testing.regenerateRegistry(cwd, true);
	assert.equal(registryFailure.regenerated, false);
	assert.equal(registryFailure.failure?.stage, "registry");
	assert.equal(registryFailure.failure?.path, registryPath);
	assert.equal(registryFailure.failure?.code, "EACCES");
	assert.match(registryFailure.failure?.diagnostic ?? "", /registry denied/);

	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === cachePath) throw storageError("EROFS", "cache read-only");
			return writeFileAsync(path, data);
		},
	});
	const cacheFailure = await __testing.regenerateRegistry(cwd, true);
	assert.equal(cacheFailure.regenerated, false);
	assert.equal(cacheFailure.failure?.stage, "cache");
	assert.equal(cacheFailure.failure?.path, cachePath);
	assert.equal(cacheFailure.failure?.code, "EROFS");
	assert.match(cacheFailure.failure?.diagnostic ?? "", /cache read-only/);
});

test("gitignore storage restriction is distinct and does not block registry regeneration at startup", async (t) => {
	const cwd = skillFixture("gitignore-restriction");
	const gitignorePath = join(cwd, ".gitignore");
	const notifications: Array<{ message: string; level: string }> = [];
	t.after(() => {
		__testing.resetStorage();
		__testing.closeSkillRegistryWatchers();
	});
	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === gitignorePath) throw storageError("EPERM", "gitignore denied");
			return writeFileAsync(path, data);
		},
	});

	const { events } = extensionHarness();
	const startup = events.get("session_start");
	assert.ok(startup);
	await assert.doesNotReject(() => startup({}, {
		cwd,
		hasUI: true,
		ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
	}));

	assert.ok(readFileSync(join(cwd, ".atl", "skill-registry.md"), "utf8"));
	assert.ok((notifications.find(({ level }) => level === "warning")?.message ?? "").includes(gitignorePath));
	assert.match(notifications.find(({ level }) => level === "warning")?.message ?? "", /add \.atl\/ to \.gitignore manually/i);
	assert.match(notifications.find(({ level }) => level === "info")?.message ?? "", /refreshed/);
});

test("unexpected registry write failures preserve their original diagnostic", async (t) => {
	const cwd = skillFixture("unexpected-write");
	const registryPath = join(cwd, ".atl", "skill-registry.md");
	t.after(() => __testing.resetStorage());
	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === registryPath) throw storageError("EIO", "disk disconnected");
			return writeFileAsync(path, data);
		},
	});

	await assert.rejects(__testing.regenerateRegistry(cwd, true), (error: NodeJS.ErrnoException) => {
		assert.equal(error.code, "EIO");
		assert.match(error.message, /disk disconnected/);
		return true;
	});
});

test("a later writable forced refresh recovers after a storage restriction", async (t) => {
	const cwd = skillFixture("recovery");
	const registryPath = join(cwd, ".atl", "skill-registry.md");
	t.after(() => __testing.resetStorage());
	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === registryPath) throw storageError("EACCES", "registry denied");
			return writeFileAsync(path, data);
		},
	});
	assert.equal((await __testing.regenerateRegistry(cwd, true)).regenerated, false);

	__testing.resetStorage();
	const recovered = await __testing.regenerateRegistry(cwd, true);
	assert.equal(recovered.regenerated, true);
	assert.equal(recovered.reason, "forced");
});

test("manual refresh reports unavailable storage with the affected path and next action", async (t) => {
	const cwd = skillFixture("manual-notification");
	const cachePath = join(cwd, ".atl", ".skill-registry.cache.json");
	const notifications: Array<{ message: string; level: string }> = [];
	t.after(() => __testing.resetStorage());
	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === cachePath) throw storageError("EROFS", "cache read-only");
			return writeFileAsync(path, data);
		},
	});

	const { commands } = extensionHarness();
	const refresh = commands.get("skill-registry:refresh");
	assert.ok(refresh);
	await refresh.handler({}, {
		cwd,
		ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.level, "warning");
	assert.match(notifications[0]?.message ?? "", /unavailable/i);
	assert.match(notifications[0]?.message ?? "", new RegExp(cachePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(notifications[0]?.message ?? "", /repair permissions/i);
});

test("unexpected startup and delayed recovery failures propagate while watcher reports the original diagnostic", async (t) => {
	const cwd = skillFixture("async-unexpected");
	const legacyPath = join(cwd, ".pi", "extensions", "skill-registry.ts");
	const registryPath = join(cwd, ".atl", "skill-registry.md");
	mkdirSync(dirname(legacyPath), { recursive: true });
	writeFileSync(legacyPath, "Auto-generated by .pi/extensions/skill-registry.ts\nconst REGISTRY_REL_PATH = \".atl/skill-registry.md\"\nfunction projectSkillDirs(cwd: string): string[]\nfunction regenerateRegistry(cwd: string, force: boolean)\n");
	let registryWrites = 0;
	t.after(() => __testing.resetStorage());
	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === registryPath && ++registryWrites === 2) throw storageError("EIO", "async disk fault");
			return writeFileAsync(path, data);
		},
	});

	const { events } = extensionHarness();
	const startup = events.get("session_start");
	assert.ok(startup);
	await assert.rejects(() => startup({}, { cwd, hasUI: false }), /async disk fault/);
	const notifications: Array<{ message: string; level: string }> = [];
	__testing.setStorage({
		writeFile: async (path, data) => {
			if (path === registryPath) throw storageError("EIO", "async disk fault");
			return writeFileAsync(path, data);
		},
	});
	writeFileSync(join(cwd, "skills", "docs", "SKILL.md"), "---\nname: docs\ndescription: Changed documentation.\n---\n");
	await __testing.refreshRegistryFromWatcher(cwd, (message, level) => {
		notifications.push({ message, level });
	});
	assert.match(notifications[0]?.message ?? "", /async disk fault/);
	assert.equal(notifications[0]?.level, "warning");
});
