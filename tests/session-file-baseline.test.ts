import assert from "node:assert/strict";
import test from "node:test";

import {
	SessionFileBaseline,
	type BaselineKey,
	type FileState,
} from "../lib/session-file-baseline.ts";

const key = (relativePath = "notes.md"): BaselineKey => ({
	repositoryIdentity: "repo-765",
	worktreeRoot: "/workspace/issue-765",
	relativePath,
});

const available = (version: string): FileState => ({ kind: "available", version });

test("keeps distinct tuple keys separate when delimiter encoding would collide", () => {
	const baselines = new SessionFileBaseline();
	const firstKey: BaselineKey = {
		repositoryIdentity: "repo|worktree",
		worktreeRoot: "root",
		relativePath: "file",
	};
	const secondKey: BaselineKey = {
		repositoryIdentity: "repo",
		worktreeRoot: "worktree|root",
		relativePath: "file",
	};

	baselines.recordFirst(firstKey, { kind: "absent" });
	baselines.recordFirst(secondKey, available("version-two"));

	assert.equal(baselines.compare(firstKey, { kind: "absent" }), "same");
	assert.equal(baselines.compare(secondKey, available("version-two")), "same");
});

test("retains the first unavailable baseline and returns frozen snapshots", () => {
	const baselines = new SessionFileBaseline();
	const file = key();
	const first = baselines.recordFirst(file, { kind: "unavailable", reason: "not-ready" });
	const later = baselines.recordFirst(file, available("version-later"));

	assert.deepEqual(later, first);
	assert.equal(baselines.compare(file, available("version-later")), "unavailable");
	assert.throws(() => {
		(first.key as { relativePath: string }).relativePath = "other.md";
	}, TypeError);
	assert.throws(() => {
		(first.state as { reason: string }).reason = "changed";
	}, TypeError);
	assert.deepEqual(baselines.recordFirst(file, available("version-later")), {
		key: file,
		state: { kind: "unavailable", reason: "not-ready" },
	});
});

test("compares matching, changed, and restored available versions", () => {
	const baselines = new SessionFileBaseline();
	const file = key();

	baselines.recordFirst(file, available("version-one"));

	assert.equal(baselines.compare(file, available("version-one")), "same");
	assert.equal(baselines.compare(file, available("version-two")), "different");
	assert.equal(baselines.compare(file, available("version-one")), "same");
});

test("treats an absent baseline and an empty available version as different", () => {
	const baselines = new SessionFileBaseline();
	const file = key();

	baselines.recordFirst(file, { kind: "absent" });

	assert.equal(baselines.compare(file, { kind: "absent" }), "same");
	assert.equal(baselines.compare(file, available("")), "different");
});

test("does not rebase a valid baseline when the current state is unavailable", () => {
	const baselines = new SessionFileBaseline();
	const file = key();

	baselines.recordFirst(file, available("version-one"));

	assert.equal(baselines.compare(file, { kind: "unavailable", reason: "permission-denied" }), "unavailable");
	assert.equal(baselines.compare(file, available("version-one")), "same");
});

test("copies caller inputs and isolates separate baseline stores", () => {
	const firstStore = new SessionFileBaseline();
	const unrelatedStore = new SessionFileBaseline();
	const callerKey = {
		repositoryIdentity: "repo-765",
		worktreeRoot: "/workspace/issue-765",
		relativePath: "caller.md",
	};
	const callerState = { kind: "available" as const, version: "before-mutation" };

	firstStore.recordFirst(callerKey, callerState);
	callerKey.relativePath = "mutated.md";
	callerState.version = "after-mutation";

	assert.equal(firstStore.compare(key("caller.md"), available("before-mutation")), "same");
	assert.equal(firstStore.compare(callerKey, available("after-mutation")), "unavailable");
	assert.equal(unrelatedStore.compare(key("caller.md"), available("before-mutation")), "unavailable");
});
