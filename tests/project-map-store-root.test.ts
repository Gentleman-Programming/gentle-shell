import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES } from "../lib/project-map-store-schema.ts";
import { ensureProjectMapStoreRoot, resolveProjectMapStoreRoot } from "../lib/project-map-store-root.ts";
import { resolveCanonicalGitRepositoryIdentitySync } from "../lib/review-session-standing-permission.ts";

function fixture(t: test.TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-map-store-root-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const main = join(dir, "main");
	const linked = join(dir, "linked");
	const other = join(dir, "other");
	const empty = join(dir, "empty");
	mkdirSync(empty);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	Object.assign(env, { GIT_CONFIG_GLOBAL: join(empty, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" });
	writeFileSync(join(empty, "config"), "");
	const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, "-c", `core.hooksPath=${empty}`, "-c", "commit.gpgsign=false", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	git(dir, ["init", "--initial-branch=main", `--template=${empty}`, main]);
	git(main, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
	git(main, ["worktree", "add", "-b", "linked", linked]);
	git(dir, ["init", `--template=${empty}`, other]);
	return { dir, main, linked, other };
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((diagnostic) => diagnostic.code);
}

test("linked worktrees resolve one common store root and repository identity", (t) => {
	const f = fixture(t);
	const main = resolveProjectMapStoreRoot(f.main);
	const linked = resolveProjectMapStoreRoot(f.linked);
	assert.deepEqual(main.diagnostics, []);
	assert.deepEqual(linked.diagnostics, []);
	assert.equal(main.root, linked.root);
	assert.equal(main.repositoryId, linked.repositoryId);
	assert.ok(main.root);
	assert.ok(main.commonDir);
	assert.equal(relative(main.commonDir, main.root).startsWith(".."), false);
	assert.notEqual(main.root, join(f.main, "gentle-ai", "project-map"));
});

test("derives the store identity from the canonical common directory", (t) => {
	const f = fixture(t);
	const gitEnvironment = Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GIT_"));
	try {
		for (const key of Object.keys(process.env)) {
			if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
		}
		const expectedIdentity = resolveCanonicalGitRepositoryIdentitySync(f.main);
		const expectedRoot = resolveProjectMapStoreRoot(f.main).root;
		process.env.GIT_DIR = join(f.other, ".git");
		const resolved = resolveProjectMapStoreRoot(f.main);
		assert.deepEqual(resolved.diagnostics, []);
		assert.equal(resolved.root, expectedRoot);
		assert.equal(resolved.repositoryId, expectedIdentity);
	} finally {
		for (const key of Object.keys(process.env)) {
			if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
		}
		Object.assign(process.env, Object.fromEntries(gitEnvironment));
	}
});

test("an unrelated repository resolves a distinct root and identity", (t) => {
	const f = fixture(t);
	const sibling = resolveProjectMapStoreRoot(f.main);
	const unrelated = resolveProjectMapStoreRoot(f.other);
	assert.deepEqual(unrelated.diagnostics, []);
	assert.notEqual(unrelated.root, sibling.root);
	assert.notEqual(unrelated.repositoryId, sibling.repositoryId);
});

test("refuses a cwd outside a Git repository without throwing", (t) => {
	const f = fixture(t);
	let result: ReturnType<typeof resolveProjectMapStoreRoot> | undefined;
	assert.doesNotThrow(() => { result = resolveProjectMapStoreRoot(f.dir); });
	assert.deepEqual(codes(result as ReturnType<typeof resolveProjectMapStoreRoot>), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.equal(result?.root, null);
});

test("refuses an escaping or symlinked store path without throwing", (t) => {
	const f = fixture(t);
	const initial = resolveProjectMapStoreRoot(f.main);
	assert.ok(initial.commonDir);
	const redirect = join(f.dir, "redirect");
	mkdirSync(redirect);
	symlinkSync(redirect, join(initial.commonDir, "gentle-ai"), "dir");
	const result = resolveProjectMapStoreRoot(f.main);
	assert.deepEqual(codes(result), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.equal(result.root, null);
});

test("creates a restrictive store root and refuses a world-readable pre-existing root", (t) => {
	const f = fixture(t);
	const created = ensureProjectMapStoreRoot(f.main);
	assert.deepEqual(created.diagnostics, []);
	assert.ok(created.root);
	assert.equal(lstatSync(created.root).mode & 0o077, 0);
	chmodSync(created.root, 0o755);
	const insecure = ensureProjectMapStoreRoot(f.main);
	assert.deepEqual(codes(insecure), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.equal(insecure.root, null);
});

test("root boundaries never throw on malformed input", () => {
	for (const value of [undefined, null, 1, [], Object.create(null)]) {
		assert.doesNotThrow(() => resolveProjectMapStoreRoot(value as string));
		assert.doesNotThrow(() => ensureProjectMapStoreRoot(value as string));
	}
});
