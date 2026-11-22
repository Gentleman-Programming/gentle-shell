import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDesktopFeedExtension } from "../extensions/gentle-desktop-feed.ts";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import {
	buildDesktopFeedSnapshot,
	DESKTOP_FEED_URGENT_MS,
	DESKTOP_FEED_DEBOUNCE_MS,
	type DesktopFeedInput,
	type DesktopFeedSnapshot,
	type DesktopFeedTimers,
} from "../lib/desktop-feed.ts";
import { createDesktopFeedStore } from "../lib/desktop-feed-store.ts";
import {
	DESKTOP_SESSION_EVENT,
	DESKTOP_SESSION_SECTIONS,
	DESKTOP_SESSION_SERVICE_CHANNEL,
	desktopSessionRootLabel,
	INVALID_SESSION_PARAMS,
	isDesktopSessionServiceShape,
	parseSessionSnapshotParams,
	projectDesktopSessionSections,
	SESSION_UNAVAILABLE,
} from "../lib/desktop-rpc-session.ts";
import { DesktopSessionBridge } from "../lib/desktop-session-service.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter } from "../lib/desktop-rpc.ts";
import { REVIEW_SIDEBAR_EVENT } from "../lib/review-sidebar-state.ts";
import { changesModel, type ChangedFile } from "../lib/shell-changes.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// Owner discovery waits up to 100 ms for a responder; let it settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const GENTLE_ENV = { PI_PROGRAM_STATUS_APP: "gentle-shell", [INTERACTIVE_HOST_ENV]: "1" };

// ---- Fixtures ----

function fixtureInput(overrides: Partial<DesktopFeedInput> = {}): DesktopFeedInput {
	const files: ChangedFile[] = [
		{ path: "lib/a.ts", added: 3, deleted: 1, status: "modified" },
		{ path: "docs/new.md", added: 10, deleted: 0, status: "untracked" },
	];
	const model = changesModel(files);
	return {
		now: Date.UTC(2026, 10, 14, 12, 0, 0),
		identity: { sessionId: "sess-1", sessionFile: "/agent/sessions/--w--/s.jsonl", sessionName: "Feed", cwd: "/home/dev/work/gentle-shell", realCwd: "/private/home/dev/work/gentle-shell", pid: 100, ppid: 99, ancestors: [98, 1], mode: "rpc", agentDir: "/agent", env: {} },
		branch: "feat/x",
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
		thinkingLevel: "high",
		subscription: true,
		profile: { name: "work", tier: "fast" },
		context: { percent: 42, tokens: 84_000, contextWindow: 200_000 },
		usage: undefined,
		permission: { mode: "normal" },
		todo: { tasks: [{ id: 1, title: "Write tests", status: "in_progress" }], nextId: 2, updatedTurn: 1 },
		changes: { model, worktrees: [{ root: "/home/dev/work/gentle-shell", branch: "feat/x", model }] },
		agents: [],
		jobs: [{ id: "j1", label: "npm test", status: "running", startedAt: Date.UTC(2026, 10, 14, 11, 59, 0) }],
		review: undefined,
		stats: { cost: 1.25, input: 100, output: 50, cacheRead: 300, cacheWrite: 10, turns: 4, toolCalls: 7, toolErrors: 1, spanMs: 60_000, cacheHitRate: 0.75, models: [] },
		activity: { working: false, blocked: 0, blockedLabel: undefined, streaming: false, phase: undefined },
		pendingQuestion: undefined,
		...overrides,
	};
}

function fakeTimers() {
	const pending = new Map<number, { fn: () => void; ms: number }>();
	let next = 0;
	const timers: DesktopFeedTimers = {
		set(fn, ms) { next += 1; pending.set(next, { fn, ms }); return next; },
		clear(handle) { pending.delete(handle as number); },
	};
	return {
		timers,
		delays: () => [...pending.values()].map((entry) => entry.ms),
		run() { const entries = [...pending.values()]; pending.clear(); for (const entry of entries) entry.fn(); },
	};
}

type Handler = (event: any, ctx: any) => unknown;

function fakeBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, fn: (data: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(fn);
			listeners.set(name, set);
			return () => { set.delete(fn); };
		},
		emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
	};
}

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const bus = fakeBus();
	const pi = {
		on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
		events: bus,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown, ctx: unknown) => { for (const fn of handlers.get(name) ?? []) fn(event, ctx); };
	return { pi, bus, commands, fire };
}

function fakeCtx() {
	const entries: unknown[] = [];
	const widgets: Array<{ key: string; lines: string[] }> = [];
	return {
		cwd: "/home/dev/work/gentle-shell", mode: "rpc", hasUI: true,
		isIdle: () => true,
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } },
		widgets,
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/agent/sessions/--w--/2026_sess-1.jsonl",
			getSessionName: () => undefined,
			getCwd: () => "/home/dev/work/gentle-shell",
			getBranch: () => entries,
			getEntries: () => entries,
		},
	};
}

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

/** The real desktop RPC extension, with or without the real feed extension, on one fake pi. */
async function rpcHarness(t: test.TestContext, withFeed: boolean) {
	interactiveHost(t);
	const harness = fakePi();
	desktopRpc(harness.pi);
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-rpc-session-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const clock = fakeTimers();
	if (withFeed) {
		createDesktopFeedExtension({
			env: GENTLE_ENV,
			agentDir,
			now: () => Date.UTC(2026, 10, 14, 12, 0, 0),
			timers: clock.timers,
			git: () => async () => ({ stdout: "", code: 128 }),
			parentOf: async (pid) => (pid === process.ppid ? 4242 : undefined),
			profile: () => ({ name: "work", tier: "fast" }),
			realpath: (path) => `/private${path}`,
			sweep: () => {},
			actionWatch: () => () => {},
			store: (dir, sessionId) => createDesktopFeedStore(dir, sessionId),
		})(harness.pi);
	}
	const ctx = fakeCtx();
	t.after(() => harness.fire("session_shutdown", { reason: "quit" }, ctx));
	harness.fire("session_start", { reason: "startup" }, ctx);
	await settle();
	clock.run();
	await settle();
	clock.run();
	await settle();
	const lines = () => ctx.widgets.filter((widget) => widget.key === "gentle-desktop-rpc").map((widget) => widget.lines[0]!);
	let requests = 0;
	return {
		...harness, ctx, clock, lines,
		async invoke(method: string, params: Record<string, unknown> = {}) {
			requests += 1;
			const before = lines().length;
			await harness.commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: `r${requests}`, method, params }), ctx);
			return lines().slice(before).map((line) => JSON.parse(line));
		},
	};
}

const ABSOLUTE = ["/home/dev", "/private", "/agent", "sess-1.jsonl", "4242"];

// ---- Pure contract: params ----

test("S2: get_snapshot params without sections stay the legacy read; bad sections are invalid_request", () => {
	assert.deepEqual(parseSessionSnapshotParams({}), { legacy: true });
	assert.deepEqual(parseSessionSnapshotParams({ other: 1 }), { legacy: true }, "unrelated params keep today's (ignored) behavior");
	assert.deepEqual(parseSessionSnapshotParams({ sections: ["todo", "changes"] }), { sections: ["todo", "changes"] });
	assert.deepEqual(parseSessionSnapshotParams({ sections: [...DESKTOP_SESSION_SECTIONS] }), { sections: [...DESKTOP_SESSION_SECTIONS] });
	for (const params of [
		{ sections: ["todo", "identity"] },
		{ sections: ["nope"] },
		{ sections: "todo" },
		{ sections: [] },
		{ sections: ["todo", "todo"] },
		{ sections: [1] },
		{ sections: ["todo"], extra: true },
		{ sections: null },
	]) {
		assert.deepEqual(parseSessionSnapshotParams(params as Record<string, unknown>), { error: INVALID_SESSION_PARAMS }, JSON.stringify(params));
	}
	assert.deepEqual(INVALID_SESSION_PARAMS.code, "invalid_request");
	assert.deepEqual(SESSION_UNAVAILABLE.code, "session_unavailable");
	assert.deepEqual([...DESKTOP_SESSION_SECTIONS], ["project", "model", "context", "cost", "usage", "profiles", "permission", "todo", "changes", "agents", "jobs", "review", "stats", "activity", "pendingQuestion", "commands"]);
});

// ---- Pure contract: field discipline ----

test("S4: the projection drops identity and every absolute path; cwd becomes a basename, roots become opaque labels", () => {
	const snapshot = buildDesktopFeedSnapshot(fixtureInput());
	const sections = projectDesktopSessionSections(snapshot, DESKTOP_SESSION_SECTIONS);
	assert.deepEqual(Object.keys(sections), [...DESKTOP_SESSION_SECTIONS]);
	assert.deepEqual(sections.project, { name: "gentle-shell", branch: "feat/x", dirty: 2 });
	const label = desktopSessionRootLabel("/home/dev/work/gentle-shell");
	assert.match(label, /^root-[0-9a-f]{12}$/);
	assert.deepEqual(sections.changes, {
		files: snapshot.changes!.files.map((file) => ({ path: file.path, root: label, status: file.status, added: file.added, deleted: file.deleted })),
		summary: { files: 2, added: 13, deleted: 1 },
		worktrees: [{ root: label, branch: "feat/x", files: 2 }],
		truncated: false,
	});
	// Untouched sections are the feed's own shapes.
	assert.deepEqual(sections.todo, snapshot.todo);
	assert.deepEqual(sections.jobs, snapshot.jobs);
	assert.deepEqual(sections.commands, snapshot.commands);
	const wire = JSON.stringify(sections);
	for (const needle of [...ABSOLUTE, "identity", "pid", "ancestors", "agentDir", "sessionFile", "realCwd"]) {
		assert.equal(wire.includes(needle), false, needle);
	}
	// Only the requested sections, in the canonical order.
	assert.deepEqual(Object.keys(projectDesktopSessionSections(snapshot, ["todo", "project"])), ["project", "todo"]);
});

test("S4: files of several worktrees become paths relative to their own opaque root", () => {
	const one = changesModel([{ path: "a.ts", added: 1, deleted: 0, status: "modified" }]);
	const two = changesModel([{ path: "b.ts", added: 2, deleted: 0, status: "modified" }]);
	const combined = changesModel([
		{ path: "/repo/a.ts", added: 1, deleted: 0, status: "modified" },
		{ path: "/repo-wt/feature/b.ts", added: 2, deleted: 0, status: "modified" },
		{ path: "/elsewhere/c.ts", added: 0, deleted: 0, status: "deleted" },
	]);
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({ changes: { model: combined, worktrees: [{ root: "/repo", branch: "main", model: one }, { root: "/repo-wt/feature", branch: "feature", model: two }] } }));
	const { changes } = projectDesktopSessionSections(snapshot, ["changes"]) as { changes: DesktopFeedSnapshot["changes"] };
	assert.deepEqual(changes!.files.map((file) => [file.path, (file as unknown as { root: string | null }).root]).sort(), [
		["a.ts", desktopSessionRootLabel("/repo")],
		["b.ts", desktopSessionRootLabel("/repo-wt/feature")],
		["c.ts", null],
	]);
	assert.deepEqual(changes!.worktrees.map((tree) => tree.root), [desktopSessionRootLabel("/repo"), desktopSessionRootLabel("/repo-wt/feature")]);
	assert.equal(JSON.stringify(changes).includes("/repo"), false);
	assert.equal(JSON.stringify(changes).includes("elsewhere"), false);
});

test("S5: the discovery adapter shape is checked before use", () => {
	assert.equal(isDesktopSessionServiceShape(undefined), false);
	assert.equal(isDesktopSessionServiceShape({ schema: "other", read() {}, observe() {}, dispose() {} }), false);
	assert.equal(isDesktopSessionServiceShape({ schema: "gentle-pi.desktop-session-service/v1", read() {}, observe() {} }), false);
	assert.equal(isDesktopSessionServiceShape({ schema: "gentle-pi.desktop-session-service/v1", read() {}, observe() {}, dispose() {} }), true);
	assert.equal(DESKTOP_SESSION_SERVICE_CHANNEL, "gentle:desktop:session-service");
});

// ---- Through the real extensions ----

test("S2: get_snapshot without sections is byte-identical with and without the feed", async (t) => {
	const without = await rpcHarness(t, false);
	const withFeed = await rpcHarness(t, true);
	const legacyWithout = await without.invoke("get_snapshot");
	const legacyWith = await withFeed.invoke("get_snapshot");
	assert.equal(legacyWith.length, 1);
	// `sequence` counts delivered events: with the feed, its start-up flushes may
	// already have published session_snapshot events. Everything else is identical.
	const events = withFeed.lines().filter((line) => JSON.parse(line).kind === "event").length;
	assert.equal(legacyWith[0].data.sequence, events);
	assert.deepEqual(legacyWith, [{ ...legacyWithout[0], data: { ...legacyWithout[0].data, sequence: events } }]);
	assert.equal("session" in legacyWith[0].data.state, false);
	// Unrelated params keep today's behavior too.
	const otherWith = await withFeed.invoke("get_snapshot", { other: true });
	const otherWithout = await without.invoke("get_snapshot", { other: true });
	assert.deepEqual(otherWith, [{ ...otherWithout[0], data: { ...otherWithout[0].data, sequence: events } }]);
});

test("S1/S2/S4/S5: get_snapshot with sections reads the live feed projection; reads emit no event", async (t) => {
	const app = await rpcHarness(t, true);
	const legacy = (await app.invoke("get_snapshot"))[0];
	const out = await app.invoke("get_snapshot", { sections: ["todo", "project", "activity", "changes"] });
	assert.equal(out.length, 1, "a read publishes its response and no event");
	assert.equal(out[0].kind, "response");
	assert.equal(out[0].ok, true);
	const data = out[0].data;
	assert.equal(data.schema, DESKTOP_RPC_SCHEMA);
	assert.equal(data.sequence, legacy.data.sequence);
	assert.deepEqual(data.state.config, legacy.data.state.config, "state.config is unchanged");
	assert.deepEqual(Object.keys(data.state.session), ["project", "todo", "changes", "activity"]);
	assert.deepEqual(data.state.session.project, { name: "gentle-shell", branch: null, dirty: 0 });
	assert.deepEqual(data.state.session.todo, { items: [], progress: { done: 0, total: 0, open: 0 }, current: null, truncated: false });
	assert.equal(data.state.session.activity.state, "idle");
	const wire = JSON.stringify(data.state.session);
	for (const needle of [...ABSOLUTE, "identity", "ancestors"]) assert.equal(wire.includes(needle), false, needle);

	// Every section can be requested at once.
	const all = await app.invoke("get_snapshot", { sections: [...DESKTOP_SESSION_SECTIONS] });
	assert.deepEqual(Object.keys(all[0].data.state.session), [...DESKTOP_SESSION_SECTIONS]);
	for (const needle of ABSOLUTE) assert.equal(JSON.stringify(all[0].data.state.session).includes(needle), false, needle);
});

test("S2: unknown section names are invalid_request, with or without the feed", async (t) => {
	for (const withFeed of [true, false]) {
		const app = await rpcHarness(t, withFeed);
		const out = await app.invoke("get_snapshot", { sections: ["todo", "identity"] });
		assert.equal(out.length, 1);
		assert.deepEqual(out[0].error, INVALID_SESSION_PARAMS);
		assert.equal(out[0].ok, false);
	}
});

test("S5/S6: without the feed, sections answer session_unavailable and capabilities omit session_snapshot", async (t) => {
	const app = await rpcHarness(t, false);
	const out = await app.invoke("get_snapshot", { sections: ["todo"] });
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].error, SESSION_UNAVAILABLE);
	const capabilities = (await app.invoke("capabilities"))[0].data;
	assert.equal(capabilities.events.includes(DESKTOP_SESSION_EVENT), false);
	assert.deepEqual(capabilities.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
	assert.deepEqual((await app.invoke("get_snapshot"))[0].data.state, (await app.invoke("get_snapshot", { other: 1 }))[0].data.state);
});

test("S6: with the feed wired, capabilities advertise session_snapshot", async (t) => {
	const app = await rpcHarness(t, true);
	const capabilities = (await app.invoke("capabilities"))[0].data;
	assert.deepEqual(capabilities.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed", DESKTOP_SESSION_EVENT]);
	assert.equal(capabilities.methods.includes("get_snapshot"), true);
});

test("S3: session_snapshot carries only changed sections, on the feed's routine and urgent tiers", async (t) => {
	const app = await rpcHarness(t, true);
	const before = app.lines().length;

	// Routine change (review sidebar): waits for the routine debounce.
	app.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "sess-1", snapshot: { state: "in_review", scope: "a.ts +1 file" } });
	assert.equal(app.lines().length, before, "nothing is emitted before the feed's tier fires");
	assert.deepEqual(app.clock.delays(), [DESKTOP_FEED_DEBOUNCE_MS]);
	app.clock.run();
	const routine = app.lines().slice(before).map((line) => JSON.parse(line));
	assert.equal(routine.length, 1);
	assert.equal(routine[0].kind, "event");
	assert.equal(routine[0].event, DESKTOP_SESSION_EVENT);
	assert.deepEqual(routine[0].data, { sections: { review: { state: "in_review", label: routine[0].data.sections.review.label, scope: "a.ts +1 file" } } });

	// The same content again: the feed flushes nothing new, so no event.
	app.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "sess-1", snapshot: { state: "in_review", scope: "a.ts +1 file" } });
	app.clock.run();
	assert.equal(app.lines().length, before + 1, "unchanged content emits no event");

	// Urgent change (an extension dialog opens): the urgent tier.
	app.fire("ui_prompt_start", { title: "Pick one", kind: "select" }, app.ctx);
	assert.deepEqual(app.clock.delays(), [DESKTOP_FEED_URGENT_MS]);
	app.clock.run();
	const urgent = JSON.parse(app.lines().at(-1)!);
	assert.equal(urgent.event, DESKTOP_SESSION_EVENT);
	assert.deepEqual(Object.keys(urgent.data.sections), ["pendingQuestion"]);
	assert.equal(urgent.data.sections.pendingQuestion.question, "Pick one");
	assert.equal(urgent.seq, routine[0].seq + 1, "events share the router's sequence");
	for (const needle of ABSOLUTE) assert.equal(app.lines().slice(before).join("\n").includes(needle), false, needle);
});

// ---- Bridge lifecycle ----

test("S5: the bridge drops a superseded session and answers unavailable when the owner has no live session", async () => {
	let snapshot: DesktopFeedSnapshot | undefined = buildDesktopFeedSnapshot(fixtureInput());
	const observers = new Set<(value: DesktopFeedSnapshot) => void>();
	let disposed = 0;
	const service = {
		schema: "gentle-pi.desktop-session-service/v1" as const,
		read: () => snapshot,
		observe: (fn: (value: DesktopFeedSnapshot) => void) => { observers.add(fn); return () => observers.delete(fn); },
		dispose: () => { disposed += 1; },
	};
	const bridge = new DesktopSessionBridge({} as ExtensionAPI, { discover: async () => service });
	assert.equal(bridge.wired, false);
	assert.equal(bridge.snapshot({}), undefined, "no sections: the router keeps its legacy read");
	assert.deepEqual(await bridge.snapshot({ sections: ["todo"] }), { ok: false, error: SESSION_UNAVAILABLE }, "no bound session yet");
	bridge.attach({ sessionManager: { getSessionId: () => "sess-1" } } as unknown as ExtensionContext);
	const events: Array<Record<string, unknown>> = [];
	bridge.wire((_event, data) => events.push(data));
	await bridge.start();
	assert.equal(bridge.wired, true);
	assert.deepEqual(await bridge.snapshot({ sections: ["todo"] }), { ok: true, data: { todo: snapshot.todo } });
	// An unchanged notification emits nothing; a changed one only its section.
	for (const fn of observers) fn(snapshot);
	assert.equal(events.length, 0);
	const next = buildDesktopFeedSnapshot(fixtureInput({ permission: { mode: "yolo" } }));
	for (const fn of observers) fn(next);
	assert.deepEqual(events, [{ sections: { permission: next.permission } }]);
	// Jobs elapsed time moves every flush and is not a change.
	const later = buildDesktopFeedSnapshot(fixtureInput({ permission: { mode: "yolo" }, now: Date.UTC(2026, 10, 14, 12, 0, 5) }));
	for (const fn of observers) fn(later);
	assert.equal(events.length, 1);

	snapshot = undefined;
	assert.deepEqual(await bridge.snapshot({ sections: ["todo"] }), { ok: false, error: SESSION_UNAVAILABLE });
	bridge.reset();
	assert.equal(bridge.wired, false);
	assert.equal(disposed, 1);
	assert.equal(observers.size, 0);
	for (const fn of [...observers]) fn(next);
	assert.equal(events.length, 1);
});

test("S2: the router keeps get_snapshot byte-identical when no session reader is supplied", () => {
	const lines: string[] = [];
	const router = new DesktopRpcRouter(undefined, undefined, () => ({ config: { stores: [] } }));
	router.start((line) => lines.push(line));
	router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "a", method: "get_snapshot", params: { sections: ["todo"] } }));
	assert.deepEqual(JSON.parse(lines[0]!).data, { schema: DESKTOP_RPC_SCHEMA, sequence: 0, state: { config: { stores: [] } } });
});

// ---- Path edge cases (verifier correction batch) ----

test("S4: a filesystem or drive root cwd has no project name", () => {
	for (const cwd of ["/", "C:\\", "D:/", "c:"]) {
		const snapshot = buildDesktopFeedSnapshot(fixtureInput({ identity: { ...fixtureInput().identity, cwd } }));
		assert.equal((projectDesktopSessionSections(snapshot, ["project"]).project as { name: string | null }).name, null, cwd);
	}
});

test("S4: Windows roots match case- and separator-insensitively; POSIX roots stay case-sensitive", () => {
	const one = changesModel([{ path: "x", added: 1, deleted: 0, status: "modified" }]);
	const combined = changesModel([
		{ path: "c:/repo/App/src/x.ts", added: 1, deleted: 0, status: "modified" },
		{ path: "C:\\REPO\\app\\lib\\y.ts", added: 1, deleted: 0, status: "modified" },
		{ path: "/Srv/Repo/z.ts", added: 1, deleted: 0, status: "modified" },
		{ path: "/srv/repo/w.ts", added: 1, deleted: 0, status: "modified" },
	]);
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({ changes: { model: combined, worktrees: [{ root: "C:\\Repo\\App", branch: "a", model: one }, { root: "/srv/repo", branch: "b", model: one }] } }));
	const { changes } = projectDesktopSessionSections(snapshot, ["changes"]) as { changes: { files: Array<{ path: string; root: string | null }> } };
	const windows = desktopSessionRootLabel("C:\\Repo\\App");
	const posix = desktopSessionRootLabel("/srv/repo");
	assert.deepEqual(changes.files.map((file) => [file.path, file.root]).sort(), [
		["lib/y.ts", windows],
		["src/x.ts", windows],
		["w.ts", posix],
		["z.ts", null],
	]);
});

test("S4: a worktree root of / or a bare drive never relativizes paths and has no label", () => {
	for (const root of ["/", "C:\\", "d:/"]) {
		const one = changesModel([{ path: "x", added: 1, deleted: 0, status: "modified" }]);
		const combined = changesModel([
			{ path: "/etc/hosts", added: 1, deleted: 0, status: "modified" },
			{ path: "C:\\Windows\\win.ini", added: 1, deleted: 0, status: "modified" },
			{ path: "etc/relative.ts", added: 1, deleted: 0, status: "modified" },
		]);
		const snapshot = buildDesktopFeedSnapshot(fixtureInput({ changes: { model: combined, worktrees: [{ root, branch: "b", model: one }] } }));
		const { changes } = projectDesktopSessionSections(snapshot, ["changes"]) as { changes: { files: Array<{ path: string; root: string | null }>; worktrees: Array<{ root: string | null }> } };
		assert.deepEqual(changes.files.map((file) => [file.path, file.root]).sort(), [["hosts", null], ["relative.ts", null], ["win.ini", null]], root);
		assert.deepEqual(changes.worktrees.map((tree) => tree.root), [null], root);
	}
});

// ---- Verifier probes (regression tests) ----

const PROBE_WIN_CWD = "C:\\Users\\devel\\My Projects\\gentle-shell";
function probeInput(overrides: Record<string, unknown> = {}): DesktopFeedInput {
	const model = changesModel([{ path: "lib/a.ts", added: 3, deleted: 1, status: "modified" }]);
	return {
		now: Date.UTC(2026, 10, 14, 12, 0, 0),
		identity: { sessionId: "sess-1", sessionFile: "C:\\Users\\devel\\.pi\\agent\\sessions\\s.jsonl", sessionName: "Feed", cwd: PROBE_WIN_CWD, realCwd: "\\\\?\\C:\\Users\\devel\\My Projects\\gentle-shell", pid: 100, ppid: 99, ancestors: [98, 1], mode: "rpc", agentDir: "C:\\Users\\devel\\.pi\\agent", env: { USERNAME: "devel", HOME: "C:\\Users\\devel" } },
		branch: "feat/x",
		model: { id: "m", provider: "anthropic", reasoning: true },
		thinkingLevel: "high", subscription: true,
		profile: { name: "work", tier: "fast" },
		context: { percent: 42, tokens: 84_000, contextWindow: 200_000 },
		usage: undefined,
		permission: { mode: "normal" },
		todo: { tasks: [{ id: 1, title: "Write tests", status: "in_progress" }], nextId: 2, updatedTurn: 1 },
		changes: { model, worktrees: [{ root: PROBE_WIN_CWD, branch: "feat/x", model }] },
		agents: [],
		jobs: [{ id: "j1", label: "npm test", status: "running", startedAt: Date.UTC(2026, 10, 14, 11, 59, 0) }],
		review: undefined,
		stats: { cost: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, toolCalls: 1, toolErrors: 0, spanMs: 1, cacheHitRate: null, models: [] },
		activity: { working: false, blocked: 0, blockedLabel: undefined, streaming: false, phase: undefined },
		pendingQuestion: undefined,
		...overrides,
	} as DesktopFeedInput;
}
const PROBE_NEEDLES = ["\\devel", "devel\\", "/devel", "Users", "C:", "D:", "\\\\", "server", "My Projects", ".pi", "s.jsonl", "/home", "/srv", "4242", "ancestors", "identity", "agentDir", "realCwd", "sessionFile"];

test("S4 probe: Windows/UNC/POSIX/spaces paths in structural fields never reach the wire", () => {
	const roots = [PROBE_WIN_CWD, "D:\\wt\\feature branch", "\\\\server\\share\\repo", "/srv/home/dev/repo"];
	const combined = changesModel([
		{ path: `${PROBE_WIN_CWD}\\lib\\a.ts`, added: 1, deleted: 0, status: "modified" },
		{ path: "D:/wt/feature branch/b.ts", added: 1, deleted: 0, status: "modified" },
		{ path: "\\\\server\\share\\repo\\c.ts", added: 1, deleted: 0, status: "modified" },
		{ path: "/srv/home/dev/repo/d.ts", added: 1, deleted: 0, status: "modified" },
		{ path: "C:\\Users\\devel\\Desktop\\outside.txt", added: 1, deleted: 0, status: "modified" },
		{ path: "c:\\users\\devel\\my projects\\gentle-shell\\casemismatch.ts", added: 1, deleted: 0, status: "modified" },
	]);
	const one = changesModel([{ path: "x", added: 1, deleted: 0, status: "modified" }]);
	const snap = buildDesktopFeedSnapshot(probeInput({ changes: { model: combined, worktrees: roots.map((root) => ({ root, branch: "b", model: one })) } }));
	const sections = projectDesktopSessionSections(snap, DESKTOP_SESSION_SECTIONS);
	const wire = JSON.stringify(sections);
	for (const needle of PROBE_NEEDLES) assert.equal(wire.includes(needle), false, `${needle} in ${wire}`);
	assert.deepEqual((sections.project as any).name, "gentle-shell");
	const paths = (sections.changes as any).files.map((f: any) => [f.path, f.root]);
	assert.deepEqual(paths.map((p: any) => p[0]).sort(), ["b.ts", "c.ts", "casemismatch.ts", "d.ts", "lib/a.ts", "outside.txt"]);
});

test("S4 probe: project name of a filesystem root", () => {
	for (const [cwd, want] of [["/", null], ["C:\\", null], ["\\\\server\\share\\", "share"]] as const) {
		const snap = buildDesktopFeedSnapshot(probeInput({ identity: { ...probeInput().identity, cwd } }));
		const p = projectDesktopSessionSections(snap, ["project"]).project as any;
		assert.equal(p.name, want, `cwd ${cwd} -> ${JSON.stringify(p.name)}`);
	}
});

function probeService(initial: DesktopFeedSnapshot) {
	let current = initial;
	const observers = new Set<(s: DesktopFeedSnapshot) => void>();
	return {
		set(value: DesktopFeedSnapshot) { current = value; },
		observers,
		service: {
			schema: "gentle-pi.desktop-session-service/v1" as const,
			read: () => current,
			observe: (fn: (s: DesktopFeedSnapshot) => void) => { observers.add(fn); return () => observers.delete(fn); },
			dispose: () => {},
		},
	};
}

test("S3 probe: no event for updatedAt/elapsed-only changes; a late publish captured before reset is dropped", async () => {
	const first = buildDesktopFeedSnapshot(probeInput());
	const fake = probeService(first);
	const bridge = new DesktopSessionBridge({} as ExtensionAPI, { discover: async () => fake.service });
	bridge.attach({} as ExtensionContext);
	const events: any[] = [];
	bridge.wire((name, data) => events.push({ name, data }));
	await bridge.start();
	const captured = [...fake.observers];
	for (const fn of captured) fn(buildDesktopFeedSnapshot(probeInput({ now: Date.UTC(2026, 10, 14, 12, 0, 30) })));
	assert.equal(events.length, 0, "elapsed/updatedAt only");
	const changed = buildDesktopFeedSnapshot(probeInput({ todo: { tasks: [{ id: 1, title: "Write tests", status: "completed" }], nextId: 2, updatedTurn: 2 } }));
	for (const fn of captured) fn(changed);
	assert.deepEqual(events.map((e) => Object.keys(e.data.sections)), [["todo"]]);
	bridge.reset();
	const late = buildDesktopFeedSnapshot(probeInput({ permission: { mode: "yolo" } }));
	for (const fn of captured) fn(late);
	assert.equal(events.length, 1, "late publish after reset dropped");
	// Re-wired session with a fresh emitter: still nothing from the stale observer.
	bridge.attach({} as ExtensionContext);
	bridge.wire((name, data) => events.push({ name, data }));
	for (const fn of captured) fn(late);
	assert.equal(events.length, 1, "stale observer after re-wire dropped");
});

test("S2 probe: invalid sections answer invalid_request before any owner discovery", async () => {
	let discovered = 0;
	const bridge = new DesktopSessionBridge({} as ExtensionAPI, { discover: async () => { discovered += 1; return undefined; } });
	bridge.attach({} as ExtensionContext);
	for (const params of [{ sections: [] }, { sections: ["todo", "todo"] }, { sections: ["bogus"] }, { sections: ["todo"], x: 1 }, { sections: "todo" }, { sections: [null] }, { sections: ["Todo"] }, { sections: ["__proto__"] }, { sections: Array(17).fill("todo") }]) {
		const out = await bridge.snapshot(params as Record<string, unknown>);
		assert.deepEqual(out, { ok: false, error: { code: "invalid_request", message: "Invalid session snapshot sections" } }, JSON.stringify(params));
	}
	assert.equal(discovered, 0);
});

function probeCtx(sessionId = "sess-1") {
	const widgets: any[] = [];
	return {
		cwd: PROBE_WIN_CWD, mode: "rpc", hasUI: true, isIdle: () => true,
		model: { id: "m", provider: "anthropic", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } }, widgets,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "C:\\Users\\devel\\.pi\\agent\\sessions\\s.jsonl", getSessionName: () => undefined, getCwd: () => PROBE_WIN_CWD, getBranch: () => [], getEntries: () => [] },
	};
}

async function probeHarness(t: test.TestContext) {
	interactiveHost(t);
	const h = fakePi();
	desktopRpc(h.pi);
	const agentDir = mkdtempSync(join(tmpdir(), "vprobe-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const c = fakeTimers();
	createDesktopFeedExtension({ env: GENTLE_ENV, agentDir, now: () => Date.UTC(2026, 10, 14, 12, 0, 0), timers: c.timers, git: () => async () => ({ stdout: "", code: 128 }), parentOf: async () => undefined, profile: () => ({ name: "work", tier: "fast" }), realpath: (p) => p, sweep: () => {}, actionWatch: () => () => {}, store: (d, id) => createDesktopFeedStore(d, id) })(h.pi);
	const ctx = probeCtx();
	t.after(() => h.fire("session_shutdown", { reason: "quit" }, ctx));
	h.fire("session_start", { reason: "startup" }, ctx);
	await settle(); c.run(); await settle(); c.run(); await settle();
	const lines = () => ctx.widgets.filter((w: any) => w.key === "gentle-desktop-rpc").map((w: any) => w.lines[0] as string);
	let i = 0;
	return { ...h, ctx, c, lines, async invoke(method: string, params: Record<string, unknown> = {}) { i += 1; const before = lines().length; await h.commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: `r${i}`, method, params }), ctx); return lines().slice(before); } };
}

test("S3 probe: with the feed, every event's seq is contiguous and get_snapshot.sequence equals delivered events; wire has no path", async (t) => {
	const app = await probeHarness(t);
	app.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "sess-1", snapshot: { state: "in_review", scope: "a.ts" } });
	app.c.run();
	await app.invoke("list_jobs");
	app.fire("ui_prompt_start", { title: "Pick C:\\Users\\devel\\x?", kind: "select" }, app.ctx);
	app.c.run();
	app.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "sess-1", snapshot: { state: "closed", scope: "a.ts" } });
	app.c.run();
	const snap = JSON.parse((await app.invoke("get_snapshot"))[0]!);
	const all = app.lines().map((l) => JSON.parse(l));
	const seqs = all.filter((l: any) => l.kind === "event").map((l: any) => l.seq);
	assert.ok(seqs.length >= 3, `events ${seqs}`);
	assert.deepEqual(seqs, seqs.map((_: unknown, i: number) => i + 1));
	assert.equal(snap.data.sequence, seqs.length);
	const full = JSON.parse((await app.invoke("get_snapshot", { sections: [...DESKTOP_SESSION_SECTIONS] }))[0]!);
	const wire = JSON.stringify(full.data.state.session) + all.filter((l: any) => l.event === "session_snapshot").map((l: any) => JSON.stringify(l)).join("");
	// Free text (the prompt title) is shown as written: strip it before checking structural fields.
	const structural = wire.replaceAll("Pick C:\\\\Users\\\\devel\\\\x?", "");
	for (const needle of ["\\devel", "devel\\", "Users", "My Projects", ".pi", "s.jsonl"]) assert.equal(structural.includes(needle), false, needle);
	assert.equal(full.data.state.session.project.name, "gentle-shell");
});

test("S3 probe: session switch disposes the old owner; the new session's events still flow and the old one's do not", async (t) => {
	const app = await probeHarness(t);
	const ctx2 = probeCtx("sess-2"); (ctx2 as any).widgets = app.ctx.widgets; (ctx2 as any).ui = app.ctx.ui;
	app.fire("session_shutdown", { reason: "new" }, app.ctx);
	app.fire("session_start", { reason: "new" }, ctx2);
	await settle(); app.c.run(); await settle(); app.c.run(); await settle();
	const before = app.lines().length;
	app.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "sess-1", snapshot: { state: "in_review", scope: "old.ts" } });
	app.c.run();
	assert.equal(app.lines().slice(before).some((l) => l.includes("old.ts")), false);
	app.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "sess-2", snapshot: { state: "in_review", scope: "new.ts" } });
	app.c.run();
	const after = app.lines().slice(before).map((l) => JSON.parse(l));
	assert.equal(after.filter((l: any) => l.event === "session_snapshot" && JSON.stringify(l).includes("new.ts")).length, 1);
	app.fire("session_shutdown", { reason: "quit" }, ctx2);
});
