import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
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

test("unfoldRoot: a missing tail keeps the nearest resolvable parent instead of throwing", (t) => {
	const base = realpathSync(dir(t, "missing-tail"));
	const missing = join(base, "missing");
	assert.equal(unfoldRoot(missing), missing, "a resolvable parent plus the given tail");
	assert.equal(unfoldRoot(join(missing, "deeper")), join(missing, "deeper"), "every missing level walks up to the same base");
});

test("canonicalRoot on POSIX equals realpath: lock tokens never re-key", (t) => {
	if (process.platform === "win32") return;
	const real = realpathSync(dir(t, "posix"));
	assert.equal(canonicalRoot(real), real);
	assert.equal(canonicalRoot(`${real}/`), real);
});

test("foldRoot keeps case-distinct directories apart on a case-sensitive tree", (t) => {
	const base = realpathSync(dir(t, "case"));
	const repo = join(base, "Repo");
	mkdirSync(repo);
	const sibling = join(base, "repo");
	let siblingCreated = true;
	try {
		mkdirSync(sibling);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		siblingCreated = false;
	}
	if (!siblingCreated) {
		assert.equal(canonicalRoot(repo, "win32"), realpathSync(repo).toLowerCase(), "a case-insensitive tree still folds every spelling of one directory to one key");
		assert.equal(canonicalRoot(join(base, "REPO"), "win32"), canonicalRoot(repo, "win32"), "a differently-cased spelling of one directory shares its key");
		return;
	}
	assert.notEqual(canonicalRoot(repo, "win32"), canonicalRoot(sibling, "win32"), "two checkouts differing only by case keep distinct keys");
});

test("the win32 case-fold memo revalidates the decision when the directory is replaced", async (t) => {
	const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
	let stats = 0;
	let statCounting = false;
	try {
		const bunTest = (await import("bun:test" as string)) as {
			mock: { module: (specifier: string, factory: () => unknown) => void };
		};
		const previous = fs.statSync;
		bunTest.mock.module("node:fs", () => ({
			...fs,
			statSync: (...args: Parameters<typeof previous>) => {
				stats += 1;
				return previous(...args);
			},
		}));
		statCounting = true;
		t.after(() => {
			bunTest.mock.module("node:fs", () => fs);
		});
	} catch {
		// bun:test is absent under the node runner, so stat counting is skipped there; the
		// fresh-lookup equality below still pins the contract on every runner.
	}
	const base = realpathSync(dir(t, "replaced"));
	const repo = join(base, "Repo");
	mkdirSync(repo);
	const recorded = foldRoot(repo, "win32");

	stats = 0;
	assert.equal(foldRoot(repo, "win32"), recorded, "an unchanged directory keeps serving its recorded decision");
	if (statCounting) assert.equal(stats, 1, "a memo hit revalidates with exactly one stat instead of answering blindly");

	// The checkout is removed and recreated, so the spelling now stats to a different directory
	// than the one the decision was recorded from.
	rmSync(repo, { recursive: true, force: true });
	mkdirSync(join(base, "repo"));
	stats = 0;
	const refreshed = foldRoot(repo, "win32");
	if (statCounting) assert.ok(stats > 0, "the replaced directory's changed identity forces the cached decision to be re-probed");
	resetCanonicalMemo();
	assert.equal(foldRoot(repo, "win32"), refreshed, "the cached lookup matches a fresh lookup after the replacement");

	stats = 0;
	assert.equal(foldRoot(repo, "win32"), refreshed, "the refreshed decision serves the next caller");
	if (statCounting) assert.equal(stats, 1, "the refreshed entry revalidates with one stat instead of re-probing the tree");
});
