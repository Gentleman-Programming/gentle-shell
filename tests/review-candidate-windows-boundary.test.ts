import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { assertCandidateOwnerParent, removeCandidateOwner } from "../lib/review-candidate-view-owner.ts";

function fixture(t: test.TestContext) {
	const parent = realpathSync(tmpdir());
	const scratch = mkdtempSync(join(parent, "rdd-acl-ñ'漢-"));
	const repo = join(scratch, "repo"); mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q", "-b", "main"); git("config", "core.autocrlf", "false");
	writeFileSync(join(repo, "tracked.txt"), "base\n"); git("add", ".");
	git("-c", "user.name=ACL Boundary Lab", "-c", "user.email=acl@example.invalid", "commit", "-qm", "fixture");
	const registry = new CandidateViewRegistry();
	const view = registry.create({ contributorRoot: repo });
	const marker = `${view.root}.owner.json`;
	const owner = JSON.parse(readFileSync(marker, "utf8"));
	const commonDir = join(repo, ".git");
	t.after(() => {
		registry.cleanupAll();
		assert.equal(dirname(scratch), parent); assert.ok(scratch.startsWith(join(parent, "rdd-acl-ñ'漢-")));
		assert.equal(realpathSync(scratch), scratch);
		rmSync(scratch, { recursive: true, force: true });
	});
	const icacls = (path: string, ...args: string[]) => execFileSync(realpathSync.native("\\\\?\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe"), [path, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	const releaseOwnedLock = (token: string | undefined) => {
		const lock = `${view.root}.reaper-lock`;
		if (existsSync(lock)) { assert.ok(token); assert.equal(readFileSync(lock, "utf8"), token); unlinkSync(lock); }
	};
	return { repo, commonDir, registry, view, marker, owner, git, icacls, releaseOwnedLock };
}

test("real Windows ACL batches handle Unicode paths and re-read a changed ancestor DACL", { skip: process.platform !== "win32" }, t => {
	const f = fixture(t);
	assert.doesNotThrow(() => f.view.verify());
	const parent = dirname(f.view.root);
	try {
		f.icacls(parent, "/grant", "*S-1-1-0:(OI)(CI)F");
		assert.throws(() => assertCandidateOwnerParent(f.commonDir));
		assert.throws(() => f.view.verify());
	} finally { f.icacls(parent, "/remove:g", "*S-1-1-0"); }
	assert.doesNotThrow(() => f.view.verify());
});

test("real Windows cleanup observes DACL changes made by the Git callback before further actions", { skip: process.platform !== "win32" }, t => {
	const f = fixture(t);
	const parent = dirname(f.view.root);
	let changed = false; let writable = 0; let removals = 0; let lockToken: string | undefined;
	try {
		assert.throws(() => removeCandidateOwner(f.owner, args => {
			if (args[0] === "worktree" && args[1] === "remove") removals++;
			const output = f.git(...args);
			if (!changed && args[0] === "worktree" && args[1] === "list") {
				lockToken = readFileSync(`${f.view.root}.reaper-lock`, "utf8");
				f.icacls(parent, "/grant", "*S-1-1-0:(OI)(CI)F"); changed = true;
			}
			return output;
		}, () => { writable++; }));
		assert.equal(changed, true); assert.equal(writable, 0); assert.equal(removals, 0);
		assert.ok(existsSync(f.view.root)); assert.ok(existsSync(f.marker));
	} finally {
		if (changed) f.icacls(parent, "/remove:g", "*S-1-1-0");
		f.releaseOwnedLock(lockToken);
	}
});

test("real Windows cleanup rechecks marker and lock after makeWritable without deleting replacements", { skip: process.platform !== "win32" }, t => {
	const f = fixture(t);
	for (const change of ["marker", "lock"]) {
		let removals = 0; let token: string | undefined;
		const original = readFileSync(f.marker, "utf8");
		try {
			assert.throws(() => removeCandidateOwner(f.owner, args => {
				if (args[0] === "worktree" && args[1] === "remove") removals++;
				return f.git(...args);
			}, () => {
				token = readFileSync(`${f.view.root}.reaper-lock`, "utf8");
				if (change === "marker") writeFileSync(f.marker, JSON.stringify({ ...f.owner, token: randomUUID() }));
				else f.icacls(`${f.view.root}.reaper-lock`, "/grant", "*S-1-1-0:F");
			}));
			assert.equal(removals, 0); assert.ok(existsSync(f.view.root)); assert.ok(existsSync(f.marker));
			if (change === "marker") assert.notEqual(readFileSync(f.marker, "utf8"), original);
			else assert.ok(existsSync(`${f.view.root}.reaper-lock`));
		} finally {
			if (change === "marker") writeFileSync(f.marker, original);
			else if (token !== undefined) f.icacls(`${f.view.root}.reaper-lock`, "/remove:g", "*S-1-1-0");
			f.releaseOwnedLock(token);
		}
	}
});

test("real Windows cleanup preserves the worktree after Git failure and parent replacement", { skip: process.platform !== "win32" }, t => {
	const f = fixture(t);
	assert.throws(() => removeCandidateOwner(f.owner, args => {
		if (args[0] === "worktree" && args[1] === "remove") throw new Error("controlled Git failure");
		return f.git(...args);
	}, () => {}), /controlled Git failure/);
	assert.ok(existsSync(f.view.root)); assert.ok(existsSync(f.marker));
	const parent = dirname(f.view.root); const saved = `${parent}.saved`;
	const expectedParent = join(f.commonDir, "gentle-ai", "candidate-views");
	let replacementLockToken: string | undefined;
	let replacementRemovals = 0;
	try {
		assert.throws(() => removeCandidateOwner(f.owner, args => {
			if (args[0] === "worktree" && args[1] === "remove") replacementRemovals++;
			return f.git(...args);
		}, () => {
			assert.equal(realpathSync(parent), expectedParent);
			assert.equal(dirname(saved), join(f.commonDir, "gentle-ai"));
			assert.equal(existsSync(saved), false);
			replacementLockToken = readFileSync(`${f.view.root}.reaper-lock`, "utf8");
			renameSync(parent, saved); mkdirSync(parent);
		}));
		assert.ok(existsSync(saved));
		assert.equal(replacementRemovals, 0);
	} finally {
		if (existsSync(saved)) {
			assert.equal(realpathSync(parent), expectedParent);
			assert.equal(realpathSync(saved), saved);
			rmdirSync(parent); renameSync(saved, parent);
		}
	}
	const lock = `${f.view.root}.reaper-lock`;
	if (existsSync(lock)) f.releaseOwnedLock(replacementLockToken);
	assert.ok(existsSync(f.view.root)); assert.ok(existsSync(f.marker));
});
