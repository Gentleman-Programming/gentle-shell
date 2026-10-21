import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionWorktreeRegistry, clearSessionWorktreeMemo, memoizeWorktreeResolver, resolveSessionWorktree, resolveSessionWorktreeWithGit, SESSION_WORKTREE_ENTRY, nativeRootSpelling, toolWorktreePath, worktreeGitEnvironment } from "../lib/session-worktree-registry.ts";
import { sessionRepositoryAuthority } from "../lib/bounded-writer-admission.ts";

// All Git and session writes belong to unique fixtures, never the live clone.
function fixture(t: test.TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "session-worktrees-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const main = join(dir, "main");
	const linked = join(dir, "linked");
	const other = join(dir, "other");
	const empty = join(dir, "empty");
	mkdirSync(empty);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	Object.assign(env, { GIT_CONFIG_GLOBAL: join(empty, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" });
	writeFileSync(join(empty, "config"), "");
	const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, "-c", `core.hooksPath=${empty}`, "-c", "commit.gpgsign=false", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	git(dir, ["init", "--initial-branch=main", `--template=${empty}`, main]);
	git(main, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
	git(main, ["worktree", "add", "-b", "linked", linked]);
	git(dir, ["init", `--template=${empty}`, other]);
	mkdirSync(join(linked, "src"));
	writeFileSync(join(linked, "src", "file.ts"), "preexisting\n");
	const alias = join(dir, "alias");
	symlinkSync(linked, alias, "dir");
	return { dir, main, linked, other, alias };
}

function host(cwd: string, session = SessionManager.inMemory(cwd)) {
	const emitted: unknown[] = [];
	const pi = { appendEntry: (type: string, data: unknown) => { session.appendCustomEntry(type, data); }, events: { emit: (_name: string, data: unknown) => emitted.push(data) } };
	return { pi, session, emitted, registry: () => new SessionWorktreeRegistry(pi, session, cwd) };
}

test("canonical roots include cwd, dedupe aliases immediately and reject unrelated clones", (t) => {
	const f = fixture(t);
	const h = host(f.main);
	const registry = h.registry();
	registry.start();
	assert.deepEqual(registry.roots(), [f.main]);
	assert.equal(registry.register(join(f.alias, "src", "file.ts"), "tool:read"), f.linked);
	registry.register(f.linked, "explicit");
	assert.deepEqual(registry.roots(), [f.main, f.linked]);
	assert.equal(h.session.getEntries().length, 2);
	assert.throws(() => registry.register(f.other, "explicit"), /same Git clone/);
	// The refusal names the runnable exit for an independent repository (#1915).
	assert.throws(() => registry.register(f.other, "explicit"), /subagent_run with repository_root/);
	assert.throws(() => registry.register(join(f.dir, "missing"), "explicit"), /worktree/);
	assert.equal(resolveSessionWorktree(f.alias, f.main)?.root, f.linked);
});

test("a registry constructed before Git init adopts only its original cwd in the same session", (t) => {
	const f = fixture(t);
	const cwd = join(f.dir, "bootstrap");
	mkdirSync(cwd);
	const h = host(cwd);
	const registry = h.registry();
	const id = h.session.getSessionId();
	registry.start();
	assert.deepEqual(registry.roots(), []);
	assert.throws(() => registry.register(f.other, "explicit"), /same Git clone/);
	assert.throws(() => registry.register(cwd, "explicit"), /same Git clone/);
	execFileSync("git", ["init", "--quiet", `--template=${join(f.dir, "empty")}`, cwd], {
		env: { ...worktreeGitEnvironment(), GIT_CONFIG_GLOBAL: join(f.dir, "empty", "config"), GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe",
	});
	const poisoned = { GIT_DIR: join(f.other, ".git"), GIT_WORK_TREE: f.other, GIT_COMMON_DIR: join(f.other, ".git") };
	const previous = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
	try {
		Object.assign(process.env, poisoned);
		assert.equal(registry.register(cwd, "explicit"), cwd, "ambient Git routing cannot select authority");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
	registry.register(cwd, "subagent:spawn");
	assert.deepEqual(registry.roots(), [cwd]);
	assert.equal(h.session.getSessionId(), id);
	assert.equal(h.session.getEntries().length, 1, "adoption does not double append");
	assert.throws(() => registry.register(f.other, "explicit"), /same Git clone/);
});

test("malformed local metadata cannot adopt a foreign registration target", (t) => {
	const f = fixture(t);
	const cwd = join(f.dir, "broken-bootstrap");
	mkdirSync(cwd);
	writeFileSync(join(cwd, ".git"), "gitdir: absent-metadata\n");
	const h = host(cwd);
	const registry = h.registry();
	registry.start();
	assert.throws(() => registry.register(f.other, "explicit"), /same Git clone/);
	assert.throws(() => registry.register(cwd, "explicit"), /same Git clone/);
	assert.deepEqual(registry.roots(), []);
	assert.deepEqual(h.session.getEntries(), []);
});

for (const drift of ["root", "commonDir", "missing"] as const) {
	test(`established session authority rejects ${drift} drift without adopting it`, () => {
		const original = { root: "/session", commonDir: "/clone/git" };
		let current: typeof original | undefined = original;
		const entries: unknown[] = [];
		const registry = new SessionWorktreeRegistry({ appendEntry: (_type, data) => { entries.push(data); }, events: { emit() {} } },
			{ getSessionId: () => "bound", getEntries: () => [] }, "/session/subdir", (path) => path === "/session/subdir" ? current : original);
		registry.start();
		current = drift === "missing" ? undefined : { ...original, [drift]: "/foreign" };
		assert.throws(() => registry.register(original.root, "explicit"), /identity changed/);
		assert.deepEqual(registry.roots(), []);
		assert.equal(entries.length, 1);
		current = original;
		assert.equal(registry.validate(original.root), original.root, "a rejected refresh never overwrites authority");
	});
}

test("closed and replaced sessions cannot adopt bootstrap identity", () => {
	for (const closed of [false, true]) {
		let id = "original";
		let identity: { root: string; commonDir: string } | undefined;
		let resolutions = 0;
		const registry = new SessionWorktreeRegistry({ appendEntry() { assert.fail("inactive append"); }, events: { emit() {} } },
			{ getSessionId: () => id, getEntries: () => [] }, "/bound", () => { resolutions++; return identity; });
		identity = { root: "/bound", commonDir: "/bound/.git" };
		if (closed) registry.close(); else id = "replacement";
		assert.throws(() => registry.register("/bound", "explicit"), /inactive session/);
		assert.deepEqual(registry.roots(), []);
		assert.equal(resolutions, 1, "the inactive guard precedes refresh");
	}
});

test("restore reads the whole session tree, resumes the same id, and ignores new/fork/clone ids", (t) => {
	const f = fixture(t);
	const session = SessionManager.create(f.main, join(f.dir, "sessions"));
	const first = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
	// Pi persists entries after the first assistant message.
	session.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
	const h = host(f.main, session);
	h.registry().start();
	h.registry().register(f.linked, "explicit");
	session.branch(first);
	assert.deepEqual(h.registry().roots(), [f.main, f.linked], "off-branch registrations remain session-wide");
	const resumed = host(f.main, SessionManager.open(session.getSessionFile()!));
	assert.deepEqual(resumed.registry().roots(), [f.main, f.linked]);
	const forkPath = session.createBranchedSession(session.getEntries().at(-1)!.id)!;
	const fork = host(f.main, SessionManager.open(forkPath));
	fork.registry().start();
	assert.deepEqual(fork.registry().roots(), [f.main], "inherited custom entries carry the old id");
	const fresh = host(f.main);
	for (const entry of resumed.session.getEntries()) {
		if (entry.type === "custom") fresh.session.appendCustomEntry(entry.customType, entry.data);
	}
	fresh.registry().start();
	assert.deepEqual(fresh.registry().roots(), [f.main], "cloned entries cannot expand a new session registry");
});

test("durable append works without a shell listener and independent registries do not double append", (t) => {
	const f = fixture(t);
	const h = host(f.main);
	const shell = h.registry();
	shell.start();
	const agents = h.registry();
	agents.register(f.linked, "subagent:spawn");
	assert.deepEqual(shell.roots(), [f.main, f.linked]);
	shell.register(f.alias, "explicit");
	assert.equal(h.session.getEntries().filter((e) => e.type === "custom" && e.customType === SESSION_WORKTREE_ENTRY).length, 2);
	agents.close();
	assert.throws(() => agents.register(f.main, "explicit"), /inactive session/);
});

test("restoration validates entries and hides missing roots without deleting their registrations", (t) => {
	const f = fixture(t);
	const h = host(f.main);
	const registry = h.registry();
	registry.start();
	registry.register(f.linked, "explicit");
	h.session.appendCustomEntry(SESSION_WORKTREE_ENTRY, { sessionId: h.session.getSessionId(), root: f.other, evidence: "explicit" });
	h.session.appendCustomEntry(SESSION_WORKTREE_ENTRY, { sessionId: h.session.getSessionId(), root: 42 });
	rmSync(f.linked, { recursive: true });
	assert.deepEqual(registry.roots(), [f.main]);
	assert.ok(h.session.getEntries().some((entry) => entry.type === "custom" && (entry.data as { root?: string })?.root === f.linked));
});

test("Git child environment removes routing and config overrides without mutating its source", () => {
	const env = { PATH: "/tools", HOME: "/fixture", GIT_DIR: "/foreign/.git", GIT_WORK_TREE: "/foreign", GIT_INDEX_FILE: "/foreign/index", GIT_COMMON_DIR: "/foreign/common", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "/foreign", git_dir: "/windows-case-alias" };
	const before = { ...env };
	assert.deepEqual(worktreeGitEnvironment(env), { PATH: "/tools", HOME: "/fixture" });
	assert.deepEqual(env, before);
});

test("session startup identity lookup hides its direct Git children", (t) => {
	const f = fixture(t);
	const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
	const run = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options });
		return args.at(-1) === "--show-toplevel" ? `${f.main}\n` : `${join(f.main, ".git")}\n`;
	}) as typeof import("node:child_process").execFileSync;
	assert.equal(resolveSessionWorktreeWithGit(f.main, f.main, run)?.root, f.main);
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.equal(call.command, "git");
		assert.equal(call.options.shell, false);
		assert.equal(call.options.windowsHide, true);
	}
});

test("only standard path-bearing calls have registration candidates; shell and prose never do", () => {
	for (const name of ["read", "write", "edit", "grep", "find", "ls"]) assert.equal(toolWorktreePath(name, { path: "../linked/file" }), "../linked/file");
	for (const name of ["grep", "find", "ls"]) assert.equal(toolWorktreePath(name, {}), ".");
	for (const name of ["bash", "powershell", "custom", "subagent_run"]) assert.equal(toolWorktreePath(name, { path: "/linked", command: "cd /linked", task: "/linked" }), undefined);
	assert.equal(toolWorktreePath("read", { path: 42 }), undefined);
});

// C2 (odd/tasks/usage-click-and-changes-attribution.md): a repo nested inside
// another repo (the live session's ~/work/NaN-builders inside ~/work) must
// resolve to the INNER repo, never the outer one, because Git itself walks
// up from the file's own directory and stops at the first .git it finds.
function nestedFixture(t: test.TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "session-worktrees-nested-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const outer = join(dir, "work");
	const inner = join(outer, "NaN-builders");
	const empty = join(dir, "empty");
	mkdirSync(empty);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	Object.assign(env, { GIT_CONFIG_GLOBAL: join(empty, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" });
	writeFileSync(join(empty, "config"), "");
	const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, "-c", `core.hooksPath=${empty}`, "-c", "commit.gpgsign=false", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	// Outer repo: no commits, matching the live evidence's `~/work` exactly.
	git(dir, ["init", "--initial-branch=main", `--template=${empty}`, outer]);
	// Inner repo: its own .git, a real branch and a commit.
	git(dir, ["init", "--initial-branch=feature", `--template=${empty}`, inner]);
	git(inner, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
	mkdirSync(join(inner, "odd", "tasks"), { recursive: true });
	writeFileSync(join(inner, "odd", "tasks", "jpg-png-converter.md"), "converted\n");
	return { dir, outer, inner };
}

test("nearest-repository resolution: an inner repo's files never resolve to an outer ancestor repo", (t) => {
	const f = nestedFixture(t);
	const forFile = resolveSessionWorktree(join("NaN-builders", "odd", "tasks", "jpg-png-converter.md"), f.outer);
	assert.equal(forFile?.root, f.inner, "the file's own nearest repository must win, not the outer ~/work repo");
	// The inner repo's own root and files resolve to itself too, whether
	// addressed from the outer cwd or the inner cwd directly.
	const forRoot = resolveSessionWorktree("NaN-builders", f.outer);
	assert.equal(forRoot?.root, f.inner);
	const fromInnerCwd = resolveSessionWorktree(join("odd", "tasks", "jpg-png-converter.md"), f.inner);
	assert.equal(fromInnerCwd?.root, f.inner);
	// The outer repo is still resolvable for its own files.
	const outerFile = join(f.outer, "README.md");
	writeFileSync(outerFile, "outer\n");
	assert.equal(resolveSessionWorktree("README.md", f.outer)?.root, f.outer);
});

// S4 (odd/tasks/startup-home-repo-and-changes.md): every extension resolves the
// same (cwd, cwd) identity during startup. Count the real Git children through
// the public resolver, not through an injected seam.
function countGitSpawns(t: test.TestContext): () => number {
	let spawns = 0;
	const original = childProcess.execFileSync;
	childProcess.execFileSync = ((...args: Parameters<typeof original>) => { if (args[0] === "git") spawns++; return original(...args); }) as typeof original;
	syncBuiltinESMExports();
	t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
	return () => spawns;
}

test("repeated startup resolutions of one cwd share a single Git resolution", (t) => {
	const f = fixture(t);
	clearSessionWorktreeMemo();
	const spawns = countGitSpawns(t);
	const first = resolveSessionWorktree(f.main, f.main);
	for (let i = 0; i < 5; i++) assert.deepEqual(resolveSessionWorktree(f.main, f.main), first);
	assert.equal(spawns(), 2, "one resolution is two rev-parse children");
	clearSessionWorktreeMemo();
	resolveSessionWorktree(f.main, f.main);
	assert.equal(spawns(), 4, "explicit invalidation forces a fresh resolution");
});

test("memoized identity still observes removal, nested repositories and expiry", (t) => {
	const f = fixture(t);
	let now = 0;
	const resolver = memoizeWorktreeResolver(resolveSessionWorktreeWithGit, { ttlMs: 1000, now: () => now });
	const authority = sessionRepositoryAuthority(f.main, resolver);
	const nested = join(f.main, "nested");
	mkdirSync(nested);
	assert.equal(resolver(nested, f.main)?.root, f.main);
	execFileSync("git", ["init", "--quiet", nested], { env: worktreeGitEnvironment(), stdio: "pipe" });
	assert.equal(resolver(nested, f.main)?.root, realpathSync(nested), "a new nested .git below the cached root is observed");
	assert.equal(authority(), true);
	rmSync(join(f.main, ".git"), { recursive: true, force: true });
	assert.equal(resolver(f.main, f.main), undefined, "a removed clone is never served from the memo");
	assert.equal(authority(), false, "drift checks still see the removal");
	let calls = 0;
	const counted = memoizeWorktreeResolver((path, cwd) => { calls++; return resolveSessionWorktreeWithGit(path, cwd); }, { ttlMs: 1000, now: () => now });
	counted(f.other, f.other);
	counted(f.other, f.other);
	assert.equal(calls, 1);
	now = 1001;
	counted(f.other, f.other);
	assert.equal(calls, 2, "expired entries resolve again");
	counted(join(f.dir, "empty"), f.dir);
	counted(join(f.dir, "empty"), f.dir);
	assert.equal(calls, 4, "a missing repository is never memoized, so bootstrap is observed at once");
});

test("Windows root spelling accepts forward slashes as the native separator only (gentle-shell#2314)", () => {
	// Git prints C:/repo while realpath returns C:\\repo; both name the same root.
	assert.equal(nativeRootSpelling("C:/path/to/sibling-repo", "win32"), "C:\\path\\to\\sibling-repo");
	assert.equal(nativeRootSpelling("C:\\path\\to\\sibling-repo", "win32"), "C:\\path\\to\\sibling-repo");
	// Only separators change: dot segments and trailing separators stay non-canonical.
	assert.equal(nativeRootSpelling("C:/repo/.", "win32"), "C:\\repo\\.");
	assert.equal(nativeRootSpelling("C:/repo/", "win32"), "C:\\repo\\");
	// POSIX spelling is untouched; a backslash is an ordinary filename character there.
	assert.equal(nativeRootSpelling("/srv/repo", "linux"), "/srv/repo");
	assert.equal(nativeRootSpelling("/srv/re\\po", "darwin"), "/srv/re\\po");
});
