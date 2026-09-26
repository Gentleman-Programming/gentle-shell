import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore, type TaskThread } from "../lib/agents-protocol.ts";
import { AgentsView } from "../lib/agents-view.ts";

// Regression suite for #1011: every presence poll re-reads remote activity from
// disk, so thread items arrive as fresh objects even when nothing changed.
// refreshPresence must reuse the prior ThreadItem object when the sanitized new
// item is deeply equal at the same position (WeakMap render cache hit), while
// changed items keep a new identity so cached renderings cannot go stale.

interface FixtureSummary {
	id: string;
	agent: string;
	label: string;
	status: string;
	model: string;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	lastActivityAt: number;
}

type FixtureItem = Record<string, unknown>;
type FixtureTask = { summary: FixtureSummary; thread: { version: number; dropped: number; items: FixtureItem[] } };
type FixtureSession = { sessionId: string; incarnation: string };

function summary(id: string): FixtureSummary {
	return { id, agent: "worker", label: `task ${id}`, status: "running", model: "test-model", createdAt: 1000, startedAt: 1000, endedAt: null, lastActivityAt: 1000 };
}

function sampleItems(): FixtureItem[] {
	return [
		{ kind: "text", text: "alpha" },
		{ kind: "tool", callId: "c1", name: "grep", output: "matches", running: false, isError: false },
		{ kind: "note", text: "note" },
	];
}

// Writes the presence pair directly (same shape projectActivity publishes) so
// tests control content and timing without the publisher's coalescing debounce.
function publish(profile: string, session: FixtureSession, tasks: FixtureTask[]): void {
	const root = join(profile, "gentle-agents", "presence");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const sessionHash = createHash("sha256").update(session.sessionId).digest("hex");
	const bytes = Buffer.from(JSON.stringify({ schema: 1, sessionHash, incarnation: session.incarnation, generation: 1, activity: { tasks } }), "utf8");
	const header = { schema: 1, sessionHash, incarnation: session.incarnation, label: "peer", heartbeat: Date.now(), generation: 1, counts: { running: tasks.length, queued: 0, waiting: 0, finished: 0 }, digest: createHash("sha256").update(bytes).digest("hex"), unavailable: null };
	// Header last: readers validate activity bytes against the header digest.
	writeFileSync(join(root, `${sessionHash}.${session.incarnation}.activity.json`), bytes);
	writeFileSync(join(root, `${sessionHash}.${session.incarnation}.header.json`), JSON.stringify(header));
}

function taskKey(session: FixtureSession, summaryId: string): string {
	const sessionHash = createHash("sha256").update(session.sessionId).digest("hex");
	return `peer:${sessionHash}:${session.incarnation}:${summaryId}`;
}

function harness(profile: string): { view: AgentsView; remoteThreads(): Map<string, TaskThread> } {
	const view = new AgentsView({
		theme: { fg: (_color, text) => text },
		rows: 10,
		store: new TaskStore(),
		sessionId: "local",
		now: () => 61_000,
		onCancel: () => {},
		onOpen: () => {},
		onClose: () => {},
		requestRender: () => {},
		presence: { profile },
	});
	return { view, remoteThreads: () => (view as unknown as { remoteThreads: Map<string, TaskThread> }).remoteThreads };
}

async function withPresenceFixture(run: (profile: string) => Promise<void>): Promise<void> {
	const profile = mkdtempSync(join(tmpdir(), "agents-view-identity-"));
	try {
		await run(profile);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(probe: () => T | undefined, description: string, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
		await sleep(5);
	}
}

// The view replaces its remoteThreads map on every applied poll, so map
// identity is a reliable witness that a subsequent poll has been applied.
function nextApplication(h: ReturnType<typeof harness>, appliedOnce: Map<string, TaskThread>, key: string): Promise<TaskThread> {
	return until(() => {
		const map = h.remoteThreads();
		return map === appliedOnce ? undefined : map.get(key);
	}, "a subsequent presence poll");
}

test("unchanged remote thread items keep object identity across presence polls", async () => {
	await withPresenceFixture(async (profile) => {
		const session = { sessionId: "peer session", incarnation: randomUUID() };
		publish(profile, session, [{ summary: summary("t1"), thread: { version: 1, dropped: 0, items: sampleItems() } }]);
		const h = harness(profile);
		try {
			const first = await until(() => h.remoteThreads().get(taskKey(session, "t1")), "the first presence poll");
			const firstItems = [...first.items];
			const appliedOnce = h.remoteThreads();
			// Same files on disk: the second poll still re-parses them, which is
			// exactly the unchanged-content case that must reuse prior identities.
			const second = await nextApplication(h, appliedOnce, taskKey(session, "t1"));
			assert.notEqual(second, first, "the thread container is still rebuilt per poll");
			assert.equal(second.items.length, firstItems.length);
			second.items.forEach((item, index) => assert.equal(item, firstItems[index],
				`unchanged item ${index} (kind ${String((firstItems[index] as { kind?: string }).kind)}) must reuse the prior object identity`));
		} finally {
			h.view.dispose();
		}
	});
});

test("a changed remote item takes a new identity while unchanged siblings keep theirs", async () => {
	await withPresenceFixture(async (profile) => {
		const session = { sessionId: "peer session", incarnation: randomUUID() };
		publish(profile, session, [{ summary: summary("t1"), thread: { version: 1, dropped: 0, items: sampleItems() } }]);
		const h = harness(profile);
		try {
			const first = await until(() => h.remoteThreads().get(taskKey(session, "t1")), "the first presence poll");
			const firstItems = [...first.items];
			const appliedOnce = h.remoteThreads();
			const [, tool, note] = sampleItems();
			publish(profile, session, [{ summary: summary("t1"), thread: { version: 1, dropped: 0, items: [{ kind: "text", text: "alpha changed" }, tool, note] } }]);
			const second = await nextApplication(h, appliedOnce, taskKey(session, "t1"));
			assert.notEqual(second.items[0], firstItems[0], "a changed item must yield a new object identity");
			assert.equal(second.items[1], firstItems[1], "the unchanged tool sibling must reuse the prior identity");
			assert.equal(second.items[2], firstItems[2], "the unchanged note sibling must reuse the prior identity");
		} finally {
			h.view.dispose();
		}
	});
});

test("tool items compare after args sanitization, so unchanged tools are reused with an empty args record", async () => {
	await withPresenceFixture(async (profile) => {
		const session = { sessionId: "peer session", incarnation: randomUUID() };
		publish(profile, session, [{ summary: summary("t1"), thread: { version: 1, dropped: 0, items: [sampleItems()[1]] } }]);
		const h = harness(profile);
		try {
			const first = await until(() => h.remoteThreads().get(taskKey(session, "t1")), "the first presence poll");
			const appliedOnce = h.remoteThreads();
			publish(profile, session, [{ summary: summary("t1"), thread: { version: 1, dropped: 0, items: [sampleItems()[1]] } }]);
			const second = await nextApplication(h, appliedOnce, taskKey(session, "t1"));
			assert.equal(second.items[0], first.items[0], "an unchanged tool item must reuse the prior sanitized object");
			assert.deepEqual((second.items[0] as { args?: unknown }).args, {}, "the stored tool item keeps the sanitized args record");
		} finally {
			h.view.dispose();
		}
	});
});
