import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalRoot, foldRoot, resetCanonicalMemo, unfoldRoot } from "../lib/codegraph-canonical.ts";

/** A backslash without a backslash literal: keeps this file clear of escape-transport mangling. */
const BS = String.fromCharCode(92);

function dir(t: test.TestContext, name: string): string {
	const cwd = mkdtempSync(join(tmpdir(), `gentle-codegraph-canonical-${name}-`));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

test("foldRoot: win32 lowercases and strips every trailing separator except a bare drive root", () => {
	assert.equal(foldRoot(["C:", "Proj", "Src", "", ""].join(BS), "win32"), ["c:", "proj", "src"].join(BS));
	assert.equal(foldRoot(`C:${BS}`, "win32"), `c:${BS}`, "a bare drive root keeps its separator");
	assert.equal(foldRoot("C:/", "win32"), "c:/", "either separator spelling of a drive root survives");
	assert.equal(foldRoot("/srv/Repo/", "linux"), "/srv/Repo/", "off Windows nothing is folded");
});

test("canonicalRoot: one directory in any spelling is one key", (t) => {
	const cwd = dir(t, "key");
	const real = realpathSync(cwd);
	assert.equal(canonicalRoot(cwd, "win32"), canonicalRoot(`${real}//`, "win32"), "trailing separators fold away");
	assert.equal(canonicalRoot(real, "win32"), canonicalRoot(cwd, "win32"), "a symlinked spelling folds to the same key");
	assert.equal(canonicalRoot(real, "darwin"), canonicalRoot(`${real}//`, "darwin"), "resolve collapses separators before the real path");
});

test("unfoldRoot: a missing tail keeps the nearest resolvable parent instead of throwing", () => {
	const base = realpathSync(tmpdir());
	const missing = join(base, "gentle-codegraph-canonical-missing-tail");
	assert.equal(unfoldRoot(missing), missing, "a resolvable parent plus the given tail");
	assert.equal(unfoldRoot(join(missing, "deeper")), join(missing, "deeper"), "every missing level walks up to the same base");
});

test("canonicalRoot on POSIX equals realpath: lock tokens never re-key", (t) => {
	if (process.platform === "win32") return;
	const real = realpathSync(dir(t, "posix"));
	assert.equal(canonicalRoot(real), real);
	assert.equal(canonicalRoot(`${real}/`), real);
});

test("the win32 fold remembers one unfold per spelling for the process lifetime", (t) => {
	const base = dir(t, "memo");
	const first = join(base, "first");
	const second = join(base, "second");
	mkdirSync(first);
	mkdirSync(second);
	const link = join(base, "link");
	symlinkSync(first, link);
	const firstKey = canonicalRoot(first, "win32");
	assert.equal(canonicalRoot(link, "win32"), firstKey, "a symlinked spelling folds to its target's key");
	rmSync(link);
	symlinkSync(second, link);
	assert.equal(canonicalRoot(link, "win32"), firstKey, "the process-lifetime memo keeps the first unfold");
	assert.equal(canonicalRoot(`${link}//`, "win32"), firstKey, "a separator spelling resolves to the same memo entry");
	resetCanonicalMemo();
	assert.equal(canonicalRoot(link, "win32"), canonicalRoot(second, "win32"), "after the reset the new target is read fresh");
});

test("off Windows every call reads the filesystem and leaves the memo untouched", (t) => {
	const base = dir(t, "passthrough");
	const first = join(base, "first");
	const second = join(base, "second");
	mkdirSync(first);
	mkdirSync(second);
	const link = join(base, "link");
	symlinkSync(first, link);
	const firstKey = canonicalRoot(link, "win32");
	rmSync(link);
	symlinkSync(second, link);
	assert.equal(canonicalRoot(link, "darwin"), canonicalRoot(second, "darwin"), "off Windows the flipped symlink is read fresh");
	assert.equal(canonicalRoot(link, "win32"), firstKey, "the fresh off-Windows read neither used nor changed the memo");
	resetCanonicalMemo();
	assert.equal(canonicalRoot(link, "darwin"), canonicalRoot(second, "darwin"), "unchanged after a memo reset it never touched");
});

test("the default platform never memoizes on a POSIX host", (t) => {
	if (process.platform === "win32") return;
	const base = dir(t, "default");
	const first = join(base, "first");
	const second = join(base, "second");
	mkdirSync(first);
	mkdirSync(second);
	const link = join(base, "link");
	symlinkSync(first, link);
	assert.equal(unfoldRoot(link), realpathSync(first), "the default call resolves the link");
	rmSync(link);
	symlinkSync(second, link);
	assert.equal(unfoldRoot(link), realpathSync(second), "the default call chain reads the flip fresh, memo or not");
});
