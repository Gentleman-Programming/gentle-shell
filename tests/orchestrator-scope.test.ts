import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestratorScopeCache, validRecordedScope } from "../lib/orchestrator-scope.ts";
import { PresencePublisher, listPresence, readDiscovery } from "../lib/orchestrator-presence.ts";
import { resolveSessionWorktree } from "../lib/session-worktree-registry.ts";

test("recorded host/owned child/registered scope correlates clones, isolates ambient Git and caches lifecycle", (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "orchestrator-scope-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const repo = join(base, "repo"), sibling = join(base, "sibling"), other = join(base, "other"), plain = join(base, "plain");
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) });
	for (const path of [repo, other, plain]) mkdirSync(path);
	for (const path of [repo, other]) { git(path, "init"); git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"); }
	git(repo, "worktree", "add", "-b", "sibling", sibling);
	const old = process.env.GIT_DIR;
	process.env.GIT_DIR = join(other, ".git");
	t.after(() => { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; });
	let calls = 0, now = 1;
	const cache = new OrchestratorScopeCache((path, cwd) => { calls++; return resolveSessionWorktree(path, cwd); }, () => now++);
	const tasks = [{ id: "child", cwd: sibling }, { id: "foreign", cwd: other }, { id: "plain", cwd: plain }];
	const first = cache.project(repo, tasks, [repo, sibling]);
	assert.equal(first.host.root, repo);
	assert.equal(first.host.cloneHash, first.tasks[0].repository.cloneHash);
	assert.notEqual(first.host.root, first.tasks[0].repository.root);
	assert.notEqual(first.host.cloneHash, first.tasks[1].repository.cloneHash);
	assert.equal(first.tasks[2].repository.root, null);
	assert.equal(first.host.source, "recorded-workspace/git");
	assert.doesNotMatch(JSON.stringify(first), /commonDir|\.git/);
	assert.deepEqual(first.registered.map(r => r.root), [repo, sibling]);
	const count = calls;
	assert.deepEqual(cache.project(repo, tasks, [repo, sibling]), first);
	assert.equal(calls, count, "token/heartbeat-equivalent projection does not probe Git");
	const admitted = cache.project(repo, [...tasks, { id: "new", cwd: repo }], [repo, sibling]);
	assert.ok(admitted.host.resolvedAt > first.host.resolvedAt);
	const completed = cache.project(repo, [], [repo]);
	assert.deepEqual(completed.tasks, []);
	assert.equal(completed.registered.length, 1);
	assert.equal(cache.project(other, [], []).host.root, other);
	cache.clear();
	assert.ok(cache.project(repo, tasks, [repo, sibling]).host.resolvedAt > admitted.host.resolvedAt);
	const bounded = cache.project(repo, Array.from({ length: 10 }, (_, i) => ({ id: String(i), cwd: repo })), Array.from({ length: 10 }, (_, i) => join(base, String(i))));
	assert.equal(bounded.tasks.length, 8);
	assert.equal(bounded.omittedTasks, 2);
	assert.equal(bounded.omittedRegistered, 2);
	assert.equal(bounded.complete, false);
	assert.equal(cache.project("/" + "x".repeat(600), [], []).host.root, null);
	let probes = 0;
	const unavailable = new OrchestratorScopeCache(() => { probes++; throw new Error("unavailable"); });
	const many = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), cwd: join(base, String(i)) }));
	const unknown = unavailable.project(repo, many, many.map(t => t.cwd));
	assert.equal(probes, 9, "deduplicated bounded resolution, including unknowns");
	assert.equal(unknown.omittedRegistered, 992);
	unavailable.project(repo, many, many.map(t => t.cwd));
	assert.equal(probes, 9);
	assert.equal(new OrchestratorScopeCache(() => ({ root: "/repo\nother", commonDir: "/clone" })).project(repo, [], []).host.root, null);
});

test("literal recorded roots never alias Unicode separators to another real repository", (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "scope-literal-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const ascii = join(base, "repo name"), nbsp = join(base, "repo\u00a0name"), letters = join(base, "répertoire");
	for (const path of [ascii, nbsp, letters]) {
		mkdirSync(path);
		execFileSync("git", ["-C", path, "init"], { stdio: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_"))) });
	}
	assert.notEqual(realpathSync(nbsp), realpathSync(ascii));
	assert.equal(resolveSessionWorktree(nbsp, nbsp)?.root, ascii, "shared spelling resolver normalizes NBSP; keep its global semantics");
	const cache = new OrchestratorScopeCache(resolveSessionWorktree, () => 7);
	const unknown = cache.project(nbsp, [{ id: "child", cwd: nbsp }], [nbsp]);
	assert.deepEqual(unknown.host, { root: null, cloneHash: null, resolvedAt: 7, source: "recorded-workspace/git" });
	assert.deepEqual(unknown.tasks[0].repository, unknown.host);
	assert.deepEqual(unknown.registered[0], unknown.host);
	for (const path of [ascii, letters]) {
		const known = cache.project(path, [], []);
		assert.equal(known.host.root, path);
		assert.match(known.host.cloneHash!, /^[a-f0-9]{64}$/);
		assert.equal(known.host.source, "recorded-workspace/git");
	}
	const separators = ["\u00a0", ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)), "\u202f", "\u205f", "\u3000"];
	for (const separator of separators) {
		const path = join(base, `repo${separator}name`);
		let probes = 0;
		const guarded = new OrchestratorScopeCache(() => { probes++; return { root: ascii, commonDir: "/clone" }; });
		assert.equal(guarded.project(path, [], []).host.cloneHash, null);
		assert.equal(probes, 0, "normalizing spellings must not reach the resolver");
		const output = new OrchestratorScopeCache(() => ({ root: path, commonDir: "/clone" })).project(ascii, [], []);
		assert.equal(output.host.root, null, "resolver output must pass the same literal-root guard");
		const malformed = structuredClone(cache.project(ascii, [], []));
		malformed.host.root = path;
		assert.equal(validRecordedScope(malformed), false);
	}
	const publisher = PresencePublisher.start({ profile: base, sessionId: "literal", label: "Literal", activity: [] });
	t.after(() => publisher.dispose());
	publisher.updateDiscovery({ sessionId: "literal", endpoint: "/fixture", createdAt: 1 }, { workspace: ascii, tasks: [], scope: cache.project(ascii, [], []) });
	const header = listPresence(base).entries[0];
	const sidecar = join(base, "gentle-agents", "presence", `${header.sessionHash}.${header.incarnation}.discovery.json`);
	const value = JSON.parse(readFileSync(sidecar, "utf8"));
	value.metadata.scope.host.root = nbsp;
	writeFileSync(sidecar, JSON.stringify(value));
	assert.equal(readDiscovery(base, header)?.scope, undefined);
	assert.equal(readDiscovery(base, header)?.workspace, ascii);
	assert.equal(listPresence(base).entries[0].sessionHash, header.sessionHash);
});
