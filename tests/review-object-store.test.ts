import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewEventV1 } from "../lib/review-graph-schema.ts";
import { ReviewGraphObjectStoreV1, ReviewObjectStoreError, type ReviewObjectStoreFaultPoint } from "../lib/review-object-store.ts";

const hash = "a".repeat(64);

function temporaryRoot(): string {
	return mkdtempSync(join(tmpdir(), "gentle-review-object-"));
}

function genesis() {
	return createReviewEventV1({ lineage_id: "lineage-a", sequence: 0, predecessor_event_id: null, kind: "lineage-created", payload: {}, reduced_state_hash: hash });
}

test("repository factory resolves the graph object path beneath the exact common directory", () => {
	const parent = temporaryRoot();
	const repository = join(parent, "repository");
	try {
		mkdirSync(repository);
		execFileSync("git", ["init", "-b", "main"], { cwd: repository });
		writeFileSync(join(repository, "README.md"), "foundation\n");
		execFileSync("git", ["add", "README.md"], { cwd: repository });
		execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "foundation"], { cwd: repository });
		const store = ReviewGraphObjectStoreV1.forRepository(repository);
		const commonDirectory = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repository, encoding: "utf8" }).trim();
		assert.equal(store.root, join(commonDirectory, "gentle-ai", "reviews", "graph-v1"));
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("immutable event installation is idempotent and rejects conflicting bytes", () => {
	const root = temporaryRoot();
	try {
		const store = new ReviewGraphObjectStoreV1(root, hash, "b".repeat(64));
		const event = genesis();
		store.installEvent(event);
		store.installEvent(event);
		assert.throws(() => store.installCanonicalEventBytes(event.event_id, new TextEncoder().encode("{}")), ReviewObjectStoreError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CURRENT only selects a root after a two-slot quorum and preserves old-or-new authority", () => {
	const root = temporaryRoot();
	try {
		const store = new ReviewGraphObjectStoreV1(root, hash, "b".repeat(64));
		const first = store.installRootSet({ schema: "gentle-ai.review-root-set/v1", repository_id: hash, authority_id: "b".repeat(64), generation: 0, predecessor_root_set_id: null, lineages: [] });
		assert.throws(() => store.readCurrent(), /quorum/i);
		store.publishRootSet(first);
		assert.equal(store.readCurrent().root_set_id, first.root_set_id);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("root publication exposes the old quorum when a fault occurs before the second new slot", () => {
	const root = temporaryRoot();
	try {
		let fired = false;
		let armed = false;
		const store = new ReviewGraphObjectStoreV1(root, hash, "b".repeat(64), {
			faultInjector(point: ReviewObjectStoreFaultPoint) {
				if (armed && point === "before-current-slot-1-replace" && !fired) {
					fired = true;
					throw new Error("injected quorum fault");
				}
			},
		});
		const first = store.installRootSet({ schema: "gentle-ai.review-root-set/v1", repository_id: hash, authority_id: "b".repeat(64), generation: 0, predecessor_root_set_id: null, lineages: [] });
		store.publishRootSet(first);
		armed = true;
		const second = store.installRootSet({ schema: "gentle-ai.review-root-set/v1", repository_id: hash, authority_id: "b".repeat(64), generation: 1, predecessor_root_set_id: first.root_set_id, lineages: [] });
		assert.throws(() => store.publishRootSet(second), /injected quorum fault/);
		assert.equal(store.readCurrent().root_set_id, first.root_set_id);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("root successors must name the current root", () => {
	const root = temporaryRoot();
	try {
		const store = new ReviewGraphObjectStoreV1(root, hash, "b".repeat(64));
		const first = store.installRootSet({ schema: "gentle-ai.review-root-set/v1", repository_id: hash, authority_id: "b".repeat(64), generation: 0, predecessor_root_set_id: null, lineages: [] });
		store.publishRootSet(first);
		const fork = store.installRootSet({ schema: "gentle-ai.review-root-set/v1", repository_id: hash, authority_id: "b".repeat(64), generation: 1, predecessor_root_set_id: "c".repeat(64), lineages: [] });
		assert.throws(() => store.publishRootSet(fork), /predecessor|descendant/i);
		assert.equal(store.readCurrent().root_set_id, first.root_set_id);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
