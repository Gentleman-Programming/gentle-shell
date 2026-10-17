import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

// gentle-ai#2196: inspect must not advertise a review.start whose candidate-view
// materialization is already known to fail. START verifies cheap non-mutating
// invariants (candidate owner parent privacy, symlink capability for trees that
// track symlinks); inspect runs the same read-only checks before a ready
// advertisement leaves the controller, with the typed codes START would emit.

function git(cwd: string, ...arguments_: string[]): string {
	return execFileSync("git", [...arguments_], { cwd, encoding: "utf8" }).trim();
}

function fixtureRepository(tracksSymlink: boolean): { root: string; candidateTree: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "inspect-preflight-")));
	git(root, "init", "--quiet", "-b", "main");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	if (tracksSymlink) symlinkSync("tracked.txt", join(root, "link"));
	git(root, "add", "-A");
	execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--quiet", "-m", "base"], { cwd: root, encoding: "utf8" });
	return { root, candidateTree: git(root, "rev-parse", "HEAD^{tree}") };
}

function readyNative(candidateTree: string): NativeReviewCli {
	return {
		reviewMode: async () => ({ operation: "status", status: { effective: "on", source: "global", global: "on", cloneLocal: "" } }),
		targetStatus: async () => ({
			action: "start",
			applicability: "unrelated",
			targetIdentity: `sha256:${"a".repeat(64)}`,
			projection: { projection: "workspace", baseTree: candidateTree, initialReviewTree: candidateTree, currentCandidateTree: candidateTree, paths: [] },
			raw: { schema: "gentle-ai.review-integration.status/v7", action: "start", reason_code: "fresh_target_ready" },
			nextTransition: { kind: "execute", execute: { operation: "review.start", arguments: [] } },
		}),
	} as unknown as NativeReviewCli;
}

const inspect = (root: string, native: NativeReviewCli) =>
	__testing.executeReviewControllerOperation({ operation: "inspect" }, root, native, undefined, null) as Promise<Record<string, unknown>>;

const posix = process.platform !== "win32";

for (const quota of [{ name: "plain", untrackedScope: undefined }] as const) {
	test(`inspect withholds a ready START advertisement when the candidate owner parent is not private (${quota.name}, gentle-ai#2196)`, { skip: posix ? false : "POSIX privacy modes are unavailable on Windows" }, async t => {
		const { root } = fixtureRepository(false);
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const views = join(root, ".git", "gentle-ai", "candidate-views");
		mkdirSync(views, { recursive: true, mode: 0o700 });
		chmodSync(views, 0o777);
		const result = await inspect(root, readyNative(git(root, "rev-parse", "HEAD^{tree}")));
		assert.equal(result.status, "blocked");
		assert.equal(result.outcome, "candidate-view-preflight-blocked");
		assert.equal((result.diagnostics as { code?: string }).code, "candidate-owner-parent-privacy");
		assert.equal(result.mutation_performed, false);
		assert.equal(result.lineage_created, false);
	});
}

test("inspect withholds a ready START advertisement when the frozen tree tracks symlinks this process cannot create (gentle-ai#2196)", { skip: posix ? false : "fixture needs a tracked symlink" }, async t => {
	const { root, candidateTree } = fixtureRepository(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	__testing.setCandidateViewSymlinkProbeForTesting(() => { throw new Error("EPERM (probe)"); });
	t.after(() => __testing.setCandidateViewSymlinkProbeForTesting(undefined));
	const result = await inspect(root, readyNative(candidateTree));
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "candidate-view-preflight-blocked");
	assert.equal((result.diagnostics as { code?: string }).code, "symlink-materialization-failed");
	assert.match(String((result.diagnostics as { message?: string }).message), /enable symlink capability out of band before retrying START/);
});

test("a frozen tree without symlinks never consults the symlink capability probe (gentle-ai#2196)", async t => {
	const { root, candidateTree } = fixtureRepository(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let probed = 0;
	__testing.setCandidateViewSymlinkProbeForTesting(() => { probed++; throw new Error("EPERM (probe)"); });
	t.after(() => __testing.setCandidateViewSymlinkProbeForTesting(undefined));
	const result = await inspect(root, readyNative(candidateTree));
	assert.equal(probed, 0, "no symlink entries in the frozen tree means no capability probe");
	assert.equal(result.status, "ready", "a healthy candidate keeps its advertisement");
});

test("a healthy worktree keeps the ready START advertisement (gentle-ai#2196)", { skip: posix ? false : "real symlink probe depends on runner capability" }, async t => {
	const { root, candidateTree } = fixtureRepository(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const result = await inspect(root, readyNative(candidateTree));
	assert.equal(result.status, "ready");
	assert.equal(result.outcome, undefined);
});

test("the symlink capability probe samples the filesystem that will hold the candidate view, never tmpdir (gentle-ai#2196)", { skip: posix ? false : "fixture needs a tracked symlink" }, async t => {
	const { root, candidateTree } = fixtureRepository(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let probeRoot: string | undefined;
	__testing.setCandidateViewSymlinkProbeForTesting((directory: string) => {
		probeRoot = directory;
	});
	t.after(() => __testing.setCandidateViewSymlinkProbeForTesting(undefined));
	const result = await inspect(root, readyNative(candidateTree));
	assert.equal(result.status, "ready");
	assert.ok(probeRoot !== undefined, "a symlink-tracking frozen tree consults the capability probe");
	assert.ok(probeRoot!.startsWith(join(root, ".git")), `probe must run inside the candidate-view filesystem, saw: ${probeRoot}`);
});

test("inspect withholds the ready START advertisement when the symlink capability stays unconfirmed (gentle-ai#2196)", { skip: posix ? false : "fixture needs a tracked symlink" }, async t => {
	const { root, candidateTree } = fixtureRepository(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	__testing.setCandidateViewSymlinkProbeForTesting(() => {
		throw new __testing.CandidateViewSymlinkProbeUnavailableError("no existing ancestor could host the probe");
	});
	t.after(() => __testing.setCandidateViewSymlinkProbeForTesting(undefined));
	const result = await inspect(root, readyNative(candidateTree));
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "candidate-view-preflight-blocked");
	assert.equal((result.diagnostics as { code?: string }).code, "symlink-capability-unconfirmed");
	assert.equal(result.mutation_performed, false);
	assert.equal(result.lineage_created, false);
});

test("an incomplete symlink scan never claims a symlink-free tree and keeps the advertisement; START owns unreadable trees (gentle-ai#2196)", async t => {
	const { root } = fixtureRepository(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let probed = 0;
	__testing.setCandidateViewSymlinkProbeForTesting(() => {
		probed++;
	});
	t.after(() => __testing.setCandidateViewSymlinkProbeForTesting(undefined));
	const result = await inspect(root, readyNative("f".repeat(40)));
	assert.equal(result.status, "ready", "an unconfirmed scan withholds no advertisement");
	assert.equal(probed, 0, "an unconfirmed scan never consults the capability probe");
});
