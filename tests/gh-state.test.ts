import assert from "node:assert/strict";
import test from "node:test";
import { GhStore, GH_TTL_MS, ghCounts, ghDigest, type GhDeps } from "../lib/gh-state.ts";
import type { GithubRepo, IssueSummary, PullRequestSummary } from "../lib/gh-client.ts";

// The store owns everything the pane shows that is not a keyboard event: what
// was fetched, when, whether it failed, and the version the rail memo reads so
// a cached frame cannot outlive the data it was painted from.

const REPO: GithubRepo = { host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" };

function pull(number: number): PullRequestSummary {
	return {
		number,
		title: `pr ${number}`,
		author: "someone",
		isDraft: false,
		headRefName: `feat/${number}`,
		updatedAt: "2026-11-10T09:00:00Z",
		labels: [],
		commentCount: 0,
		reviewDecision: null,
	};
}

function issue(number: number): IssueSummary {
	return { number, title: `issue ${number}`, author: "someone", labels: [], commentCount: 0, updatedAt: "2026-11-10T09:00:00Z" };
}

interface Harness {
	deps: GhDeps;
	changes: number;
	calls: { prs: number; issues: number };
	setRepo(repo: GithubRepo | null): void;
	advance(ms: number): void;
}

function harness(overrides: Partial<GhDeps> = {}): Harness {
	const state = { now: 1_000_000, repo: REPO as GithubRepo | null, changes: 0, calls: { prs: 0, issues: 0 } };
	const deps: GhDeps = {
		now: () => state.now,
		resolveRepo: () => state.repo,
		loadPullRequests: async () => {
			state.calls.prs += 1;
			return [pull(1), pull(2)];
		},
		loadIssues: async () => {
			state.calls.issues += 1;
			return [issue(10)];
		},
		onChange: () => {
			state.changes += 1;
		},
		...overrides,
	};
	return {
		deps,
		get changes() {
			return state.changes;
		},
		calls: state.calls,
		setRepo(repo) {
			state.repo = repo;
		},
		advance(ms) {
			state.now += ms;
		},
	};
}

test("a fresh store is idle, empty, and already knows its repository", () => {
	const { deps } = harness();
	const store = new GhStore(deps);
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "idle");
	assert.deepEqual(snapshot.repo, REPO);
	assert.deepEqual(snapshot.pullRequests, []);
	assert.deepEqual(snapshot.issues, []);
	assert.equal(snapshot.version, 0);
	assert.equal(snapshot.error, null);
});

test("refresh loads once and repaints through onChange", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "ready");
	assert.deepEqual(snapshot.pullRequests.map((p) => p.number), [1, 2]);
	assert.deepEqual(snapshot.issues.map((i) => i.number), [10]);
	assert.equal(snapshot.version, 1);
	assert.equal(snapshot.loadedAt, 1_000_000);
	assert.ok(h.changes > 0, "the pane must be told to repaint");
});

test("a second refresh inside the TTL reuses the data instead of calling gh again", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	h.advance(GH_TTL_MS - 1);
	await store.refresh();
	assert.equal(h.calls.prs, 1);
	assert.equal(h.calls.issues, 1);
	assert.equal(store.snapshot().version, 1);
});

test("the TTL expiring makes the next refresh a real fetch", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	h.advance(GH_TTL_MS);
	await store.refresh();
	assert.equal(h.calls.prs, 2);
	assert.equal(store.snapshot().version, 2);
});

test("a forced refresh ignores the TTL, which is what r does", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	await store.refresh(true);
	assert.equal(h.calls.prs, 2);
	assert.equal(store.snapshot().version, 2);
});

test("concurrent refreshes share one in-flight fetch", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
	assert.equal(h.calls.prs, 1);
});

test("a failure keeps the last good rows and reports the reason", async () => {
	let fail = false;
	const h = harness({
		loadPullRequests: async () => {
			if (fail) throw new Error("gh: not authenticated");
			return [pull(1)];
		},
	});
	const store = new GhStore(h.deps);
	await store.refresh();
	fail = true;
	h.advance(GH_TTL_MS);
	await store.refresh();
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "error");
	assert.match(String(snapshot.error), /not authenticated/);
	assert.deepEqual(snapshot.pullRequests.map((p) => p.number), [1], "a failed refresh must not blank the pane");
	assert.equal(snapshot.version, 2, "the error is a visible change");
});

test("no GitHub remote is an error the pane can explain, not a crash", async () => {
	const h = harness();
	h.setRepo(null);
	const store = new GhStore(h.deps);
	await store.refresh();
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "error");
	assert.equal(snapshot.repo, null);
	assert.match(String(snapshot.error), /remote/i);
	assert.equal(h.calls.prs, 0, "nothing to ask gh about");
});

test("a non-GitHub host is refused instead of being asked of gh", async () => {
	const h = harness();
	h.setRepo({ host: "gitlab.com", owner: "acme", name: "widget" });
	const store = new GhStore(h.deps);
	await store.refresh();
	assert.equal(store.snapshot().status, "error");
	assert.match(String(store.snapshot().error), /github\.com/);
	assert.equal(h.calls.prs, 0);
});

test("a disposed store stops loading and stops repainting", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	store.dispose();
	const changesAfterDispose = h.changes;
	await store.refresh(true);
	assert.equal(h.calls.prs, 0);
	assert.equal(h.changes, changesAfterDispose);
});

test("ghCounts is what the rail header prints", () => {
	const { deps } = harness();
	const store = new GhStore(deps);
	assert.deepEqual(ghCounts(store.snapshot()), { pullRequests: 0, issues: 0 });
});

test("ghDigest changes when the data changes and when the TTL bucket rolls", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	const before = ghDigest(store.snapshot(), 1_000_000);
	await store.refresh();
	const afterLoad = ghDigest(store.snapshot(), 1_000_000);
	assert.notEqual(afterLoad, before, "new data must break the rail memo");

	const sameBucket = ghDigest(store.snapshot(), 1_000_000 + GH_TTL_MS - 1);
	assert.equal(sameBucket, afterLoad, "one paint inside the bucket must stay cached");

	const nextBucket = ghDigest(store.snapshot(), 1_000_000 + GH_TTL_MS);
	assert.notEqual(nextBucket, afterLoad, "a rolled bucket must re-validate once");
});
