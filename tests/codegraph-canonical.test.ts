import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalRoot, foldRoot, unfoldRoot } from "../lib/codegraph-canonical.ts";

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
