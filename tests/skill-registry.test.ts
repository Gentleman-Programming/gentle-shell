import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillRegistry, { __testing } from "../extensions/skill-registry.ts";

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
		start: () => events.get("session_start")!(undefined, ctx),
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
		assert.ok(runtime.notices.some(({ message }) => message.includes("written to .atl/skill-registry.md")));
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

test("automatic forced freshness protects tracked cache without partial registry writes", async () => {
	const fixture = registryFixture();
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
