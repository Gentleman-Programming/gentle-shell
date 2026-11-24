import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
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

/** One measured foldRoot call from the worker scenario: the statSync calls the module
 * made while answering it, and the fold key it returned. */
interface FoldPhase {
	name: string;
	stats: number;
	result: string;
}

/** Runs the case-fold memo scenario in a worker thread, measuring every foldRoot call by
 * the statSync calls it costs. The worker's module registry is fresh, so the module under
 * test links only after a counting wrapper is installed on require("node:fs"), and its
 * named-import binding — a link-time snapshot — captures the wrapper. That is the only
 * runner-portable seam: bun:test mock.module exists only under bun, node:test ships no
 * module mock, and patching the exports object after the module has linked is invisible
 * to it on both runners. */
async function foldMemoPhases(t: test.TestContext): Promise<FoldPhase[]> {
	const canonicalUrl = new URL("../lib/codegraph-canonical.ts", import.meta.url).href;
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gentle-codegraph-canonical-fold-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const repo = join(base, "Repo");
	const aside = join(base, "moved-aside");
	mkdirSync(repo);
	const workerSource = [
		"const { parentPort, workerData } = require('node:worker_threads');",
		"const fs = require('node:fs');",
		"let stats = 0;",
		"const previous = fs.statSync;",
		"fs.statSync = (...args) => { stats += 1; return previous(...args); };",
		"(async () => {",
		"	const { foldRoot, resetCanonicalMemo } = await import(" + JSON.stringify(canonicalUrl) + ");",
		"	const measure = (name) => {",
		"		const before = stats;",
		"		const result = foldRoot(workerData.repo, 'win32');",
		"		return { name, stats: stats - before, result };",
		"	};",
		"	const phases = [measure('recorded')];",
		"	phases.push(measure('unchanged'));",
		"	fs.renameSync(workerData.repo, workerData.aside);",
		"	fs.mkdirSync(workerData.repo);",
		"	phases.push(measure('replaced'));",
		"	resetCanonicalMemo();",
		"	phases.push(measure('fresh'));",
		"	phases.push(measure('served'));",
		"	parentPort.postMessage(phases);",
		"})().catch((error) => parentPort.postMessage({ error: String((error && error.stack) || error) }));",
	].join("\n");
	return await new Promise<FoldPhase[]>((resolve, reject) => {
		const worker = new Worker(workerSource, { eval: true, workerData: { repo, aside }, stdout: true, stderr: true });
		const timer = setTimeout(() => {
			void worker.terminate();
			reject(new Error("the fold-memo worker did not report its phases within 10s"));
		}, 10000);
		worker.on("message", (message: unknown) => {
			clearTimeout(timer);
			void worker.terminate().then(() => {
				if (!Array.isArray(message)) {
					reject(new Error("the fold-memo worker failed: " + JSON.stringify(message)));
					return;
				}
				resolve(message as FoldPhase[]);
			});
		});
		worker.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

test("the win32 case-fold memo revalidates the decision when the directory is replaced", async (t) => {
	const phases = await foldMemoPhases(t);
	const byName = new Map(phases.map((phase): [string, FoldPhase] => [phase.name, phase]));
	const recorded = byName.get("recorded");
	const unchanged = byName.get("unchanged");
	const replaced = byName.get("replaced");
	const fresh = byName.get("fresh");
	const served = byName.get("served");
	assert.ok(recorded !== undefined && unchanged !== undefined && replaced !== undefined && fresh !== undefined && served !== undefined, "the worker scenario reports every phase");
	assert.ok(recorded.stats >= 1, "the first call probes the tree and records the decision");
	// The control: an unchanged directory serves its recorded decision, revalidated by
	// exactly one stat — a blind cache would answer with zero, a re-probe with many.
	assert.equal(unchanged.stats, 1, "a memo hit revalidates with exactly one stat instead of answering blindly");
	assert.equal(unchanged.result, recorded.result, "an unchanged directory keeps serving its recorded decision");
	// The checkout is moved aside and recreated at the exact spelling, so the cached key
	// stats to a different directory than the one the decision was recorded from: the
	// identity mismatch must force a re-probe. A cache that never revalidates answers
	// with zero stats — this is the assertion that catches it, under node and bun alike.
	assert.ok(replaced.stats >= 1, "the replaced directory's changed identity forces the cached decision to be re-probed");
	assert.ok(fresh.stats >= 1, "the lookup after a memo reset actually probes the tree");
	assert.equal(replaced.result, fresh.result, "the revalidated cache matches a fresh lookup after the replacement");
	// The refreshed entry anchors to the new directory and serves like the first one did.
	assert.equal(served.stats, 1, "the refreshed entry revalidates with one stat instead of re-probing the tree");
	assert.equal(served.result, replaced.result, "the next caller keeps seeing the revalidated decision");
});
