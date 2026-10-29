import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// Pain-point iteration S10 (C7): blind reviewers flagged tool artifacts in every
// Gentle Shell delivery. Orchestrators told writers to create a scratch
// directory in the repository root and point TMPDIR at it, so test state and
// tool caches entered the diff. Test scratch now lives outside the worktree by
// default. These are instruction-delivery contracts, not proof of model adherence.

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const worker = read("assets/agents/gentle-ai-worker.md");
const writer = read("assets/orchestrator-writer.md");
const verifier = read("assets/agents/gentle-ai-verify.md");

function section(text: string, heading: string): string {
	const start = text.indexOf(`\n## ${heading}\n`);
	assert.ok(start >= 0, `missing section: ${heading}`);
	const end = text.indexOf("\n## ", start + heading.length + 4);
	return text.slice(start, end < 0 ? undefined : end);
}

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

test("S10: the worker keeps test scratch outside the worktree and checks git status before returning", () => {
	const discipline = section(worker, "Test discipline");
	containsAll(discipline, [
		"Test scratch lives outside the worktree",
		"`mktemp -d`",
		"never point `TMPDIR` or a cache directory into the repository",
		"use an excluded path that the test removes before it ends",
		"Never leave tool caches or scratch paths in the change",
	], "worker test discipline");
	const finish = discipline.split("\n").find((line) => line.includes("`git status --short`"));
	assert.ok(finish, "worker finish checks must run `git status --short`");
	containsAll(finish, ["Before returning", "no tool cache or scratch path", "`risks`"], "worker finish check");
});

test("S10: writer handoffs never place test scratch inside the repository", () => {
	const line = writer.split("\n").find((entry) => entry.includes("Test scratch"));
	assert.ok(line, "orchestrator-writer.md must state where writers put test scratch");
	containsAll(line, [
		"outside the worktree",
		"`mktemp -d`",
		"never in the repository",
		"`TMPDIR`",
		"excluded path",
	], "writer handoff scratch rule");
});

test("S10: no shipped guidance points test temp state into the repository", () => {
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(md|ts)$/.test(entry.name) && /TMPDIR=\$(PWD|\(pwd\))|\.test-tmp|\.atl\/test-tmp/.test(readFileSync(path, "utf8"))) {
				offenders.push(relative(ROOT, path));
			}
		}
	};
	for (const dir of ["assets", "extensions", "docs"]) walk(join(ROOT, dir));
	assert.deepEqual(offenders, []);
});

// S10 follow-up (user, 2026-10-14: "lo de los temporales tambien hacemos limpieza luego?"):
// scratch outside the worktree was never removed; verifier scratch copies piled up
// in the system temp directory. The verifier removes only the exact directory its
// own `mktemp -d` printed; the worker, which may not delete, has tests clean up in
// teardown and names any leftover outside directory so the parent removes it.
test("S10: scratch outside the worktree is removed after use", () => {
	// Independent verification of C7 found child safety blocks `rm -rf` in every
	// subagent (lib/destructive-command-guard.ts), so a verifier told to delete its
	// own scratch always failed and nobody removed it. Subagents now report exact
	// scratch paths and the parent, where deletion is only confirmed, removes them.
	containsAll(
		verifier,
		["list every scratch directory you created by exact path in your result so the parent removes it", "never delete it yourself"],
		"gentle-ai-verify scratch report",
	);
	assert.ok(!/\brm\s+-r/.test(verifier), "gentle-ai-verify must not instruct a deletion child safety blocks");
	containsAll(
		section(worker, "Test discipline"),
		[
			"Tests delete the temp directories they create in teardown",
			"name any scratch directory you created outside the worktree in `risks` so the parent removes it",
		],
		"worker scratch cleanup",
	);
	// Session scratch and artifact ledger: the runtime owns the parent session's
	// TMPDIR (subagent TMPDIRs nest under it) and records clones and worktrees,
	// so the writer rule points at the command instead of a model cleanup step.
	containsAll(writer, ["The runtime owns session scratch", "`/gentle:scratch` lists or cleans recorded clones and worktrees"], "writer runtime-owned cleanup");
	// The verifier's mktemp copy lives in its own TMPDIR, which the runner removes.
	const verification = read("assets/orchestrator-verification.md");
	containsAll(verification, ["the runtime removes each subagent's own TMPDIR, which holds that copy"], "verification runtime cleanup");
	assert.ok(!verification.includes("the parent removes the scratch paths the verifier reports"), "the parent no longer removes verifier scratch");
});
