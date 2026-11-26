import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDesktopFeedExtension, type DesktopFeedOptions } from "../extensions/gentle-desktop-feed.ts";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import {
	buildDesktopFeedSnapshot,
	createDesktopFeedScheduler,
	DESKTOP_FEED_BUILTIN_COMMANDS,
	DESKTOP_FEED_LIMITS,
	DESKTOP_FEED_SCHEMA,
	type DesktopFeedInput,
	type DesktopFeedSnapshot,
	type DesktopFeedTimers,
} from "../lib/desktop-feed.ts";
import { createDesktopFeedStore, desktopFeedFile } from "../lib/desktop-feed-store.ts";
import { createParentOf, createUntrackedLineCounter, parseProcessTable, processAncestors, psParentOf } from "../lib/desktop-feed-sources.ts";
import { SESSION_WORKTREE_ENTRY } from "../lib/session-worktree-registry.ts";
import { changesModel, type ChangedFile } from "../lib/shell-changes.ts";
import { DESKTOP_JOBS_SERVICE_CHANNEL, DESKTOP_JOBS_SERVICE_SCHEMA, type DesktopJobEntry } from "../lib/desktop-rpc-jobs.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import { REVIEW_SIDEBAR_EVENT } from "../lib/review-sidebar-state.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// Owner discovery waits up to 100 ms for a responder; let it settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const GENTLE_ENV = { PI_PROGRAM_STATUS_APP: "gentle-shell", HERDR_ENV: "1", HERDR_PANE_ID: "t7" };

// ---- Fixtures ----

function fixtureInput(overrides: Partial<DesktopFeedInput> = {}): DesktopFeedInput {
	const files: ChangedFile[] = [
		{ path: "lib/a.ts", added: 3, deleted: 1, status: "modified" },
		{ path: "docs/new.md", added: 10, deleted: 0, status: "untracked" },
	];
	const model = changesModel(files);
	return {
		now: Date.UTC(2026, 10, 14, 12, 0, 0),
		identity: { sessionId: "sess-1", sessionFile: "/agent/sessions/--w--/s.jsonl", sessionName: "Feed", cwd: "/w", realCwd: "/private/w", pid: 100, ppid: 99, ancestors: [98, 1, -3], mode: "tui", agentDir: "/agent", env: { HERDR_ENV: "1", HERDR_PANE_ID: "t7" } },
		branch: "feat/x",
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
		thinkingLevel: "high",
		subscription: true,
		profile: { name: "work (session)", tier: "fast" },
		context: { percent: 42, tokens: 84_000, contextWindow: 200_000 },
		usage: { provider: "anthropic", status: "ok", fetchedAt: 5, plan: "max", limits: [{ name: "all", limitReached: false, windows: [{ label: "5h", usedPercent: 30, windowSeconds: 18_000, resetAt: 9 }, { label: "7d", usedPercent: 12, windowSeconds: 604_800, resetAt: null }] }] },
		permission: { mode: "yolo", defaultMode: "normal", detail: "destructive confirmations remain" },
		todo: { tasks: [{ id: 1, title: "Write tests", status: "done" }, { id: 2, title: "Build feed", status: "in_progress", note: "T4" }, { id: 3, title: "Old idea", status: "dropped" }], nextId: 4, updatedTurn: 2 },
		changes: { model, worktrees: [{ root: "/w", branch: "feat/x", model }] },
		agents: [
			{ id: "a1", agent: "gentle-writer", status: "running", model: "sonnet", lastStep: "writing", thinking: "medium", usage: { total: 1000, cost: 0.5 } },
			{ id: "a2", agent: "gentle-verifier", status: "completed", model: "haiku", lastStep: "completed", usage: { total: 200, cost: 0.1 } },
		],
		jobs: [
			{ id: "j1", label: "npm test", status: "running", startedAt: Date.UTC(2026, 10, 14, 11, 59, 0) },
			{ id: "j2", label: "build", status: "exited", startedAt: Date.UTC(2026, 10, 14, 11, 50, 0), endedAt: Date.UTC(2026, 10, 14, 11, 55, 0), exitCode: 0 },
		],
		review: { state: "in_review", scope: "a.ts +1 file" },
		stats: { cost: 1.25, input: 100, output: 50, cacheRead: 300, cacheWrite: 10, turns: 4, toolCalls: 7, toolErrors: 1, spanMs: 60_000, cacheHitRate: 0.75, models: [{ model: "claude-opus-5-5", turns: 4, tokens: 460, cost: 1.25 }] },
		activity: { working: true, blocked: 0, blockedLabel: undefined, streaming: true, phase: "implementing" },
		pendingQuestion: undefined,
		...overrides,
	};
}

function fakeTimers() {
	const pending = new Map<number, () => void>();
	let next = 0;
	const timers: DesktopFeedTimers = {
		set(fn) { next += 1; pending.set(next, fn); return next; },
		clear(handle) { pending.delete(handle as number); },
	};
	return {
		timers,
		get armed() { return pending.size; },
		run() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
	};
}

type Handler = (event: any, ctx: any) => unknown;

function fakeBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		listeners,
		on(name: string, fn: (data: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(fn);
			listeners.set(name, set);
			return () => { set.delete(fn); };
		},
		emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
	};
}

function fakePi(bus = fakeBus()) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = {
		on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
		events: bus,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown, ctx: unknown) => { for (const fn of handlers.get(name) ?? []) fn(event, ctx); };
	return { pi, bus, handlers, commands, fire };
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
	const entries: unknown[] = [
		{ type: "message", timestamp: "2026-11-14T11:00:00.000Z", message: { role: "assistant", model: "anthropic/claude-opus-5-5", usage: { input: 10, output: 5, cost: { total: 0.25 } } } },
	];
	const widgets: Array<{ key: string; lines: string[] }> = [];
	return {
		cwd: "/w", mode: "tui", hasUI: true,
		isIdle: () => true,
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } },
		widgets,
		entries,
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/agent/sessions/--w--/2026_sess-1.jsonl",
			getSessionName: () => undefined,
			getCwd: () => "/w",
			getBranch: () => entries,
			getEntries: () => entries,
		},
		...overrides,
	};
}

function feedHarness(t: test.TestContext, options: Partial<DesktopFeedOptions> = {}, env: NodeJS.ProcessEnv = GENTLE_ENV) {
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-feed-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const clock = fakeTimers();
	const harness = fakePi();
	const writes: unknown[] = [];
	let removed = 0;
	createDesktopFeedExtension({
		env,
		agentDir,
		now: () => Date.UTC(2026, 10, 14, 12, 0, 0),
		timers: clock.timers,
		git: () => async () => ({ stdout: "", code: 128 }),
		parentOf: async () => undefined,
		profile: () => ({ name: "work (session)", tier: "fast" }),
		persona: () => undefined,
		realpath: (path) => `/private${path}`,
		sweep: () => {},
		store: (dir, sessionId) => {
			const real = createDesktopFeedStore(dir, sessionId);
			return { path: real.path, write(value) { writes.push(value); return real.write(value); }, remove() { removed += 1; real.remove(); } };
		},
		...options,
	})(harness.pi);
	const ctx = fakeCtx();
	const file = desktopFeedFile(agentDir, "sess-1");
	return {
		...harness, ctx, clock, agentDir, file, writes,
		get removed() { return removed; },
		read: () => JSON.parse(readFileSync(file, "utf8")) as DesktopFeedSnapshot,
		start: async (context: unknown = ctx) => { harness.fire("session_start", { reason: "startup" }, context); await settle(); clock.run(); await settle(); clock.run(); },
	};
}

// ---- Schema shape ----

test("S2: the snapshot carries every TUI field in the v1 schema shape", () => {
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({
		pendingQuestion: undefined,
	}));
	assert.deepEqual(snapshot, {
		schema: DESKTOP_FEED_SCHEMA,
		updatedAt: "2026-11-14T12:00:00.000Z",
		identity: { sessionId: "sess-1", sessionFile: "/agent/sessions/--w--/s.jsonl", sessionName: "Feed", cwd: "/w", realCwd: "/private/w", pid: 100, ppid: 99, ancestors: [98, 1], mode: "tui", agentDir: "/agent", herdr: { paneId: "t7", env: true } },
		project: { cwd: "/w", branch: "feat/x", dirty: 2 },
		model: { id: "claude-opus-5-5", provider: "anthropic", effort: "high", profile: { name: "work (session)", tier: "fast" } },
		persona: null,
		context: { percent: 42, tokens: 84_000, window: 200_000 },
		cost: { total: 1.25, subscription: true },
		usage: {
			provider: "anthropic", status: "ok", plan: "max", fetchedAt: 5, note: null, limits: [{ name: "all", limitReached: false, windows: [{ label: "5h", usedPercent: 30, windowSeconds: 18_000, resetAt: 9 }, { label: "7d", usedPercent: 12, windowSeconds: 604_800, resetAt: null }] }],
			// S12: every provider of the usage panel; without a scope, the session's own.
			providers: [{ provider: "anthropic", status: "ok", plan: "max", fetchedAt: 5, note: null, limits: [{ name: "all", limitReached: false, windows: [{ label: "5h", usedPercent: 30, windowSeconds: 18_000, resetAt: 9 }, { label: "7d", usedPercent: 12, windowSeconds: 604_800, resetAt: null }] }] }],
		},
		profiles: null,
		permission: { mode: "yolo", defaultMode: "normal", yolo: true, detail: "destructive confirmations remain" },
		statuses: null,
		integrations: null,
		todo: {
			items: [{ id: 1, title: "Write tests", state: "done", note: null }, { id: 2, title: "Build feed", state: "in_progress", note: "T4" }, { id: 3, title: "Old idea", state: "dropped", note: null }],
			progress: { done: 1, total: 3, open: 1 },
			current: "Build feed",
			truncated: false,
		},
		changes: {
			files: [{ path: "docs/new.md", status: "untracked", added: 10, deleted: 0 }, { path: "lib/a.ts", status: "modified", added: 3, deleted: 1 }],
			summary: { files: 2, added: 13, deleted: 1 },
			worktrees: [{ root: "/w", branch: "feat/x", files: 2 }],
			truncated: false,
		},
		agents: {
			items: [
				{ id: "a1", name: "gentle-writer", role: null, state: "running", step: "writing", model: "sonnet", thinking: "medium", spend: { tokens: 1000, cost: 0.5 } },
				{ id: "a2", name: "gentle-verifier", role: null, state: "completed", step: "completed", model: "haiku", thinking: null, spend: { tokens: 200, cost: 0.1 } },
			],
			active: 1,
			spend: { runs: 2, tokens: 1200, cost: 0.6 },
		},
		jobs: {
			running: [{ id: "j1", label: "npm test", startedAt: Date.UTC(2026, 10, 14, 11, 59, 0), elapsedMs: 60_000 }],
			recent: [{ id: "j2", label: "build", status: "exited", startedAt: Date.UTC(2026, 10, 14, 11, 50, 0), endedAt: Date.UTC(2026, 10, 14, 11, 55, 0), exitCode: 0, elapsedMs: 300_000 }],
		},
		review: { state: "in_review", label: "Review in progress", scope: "a.ts +1 file" },
		stats: { turns: 4, toolCalls: 7, toolErrors: 1, cost: 1.25, input: 100, output: 50, cacheRead: 300, cacheWrite: 10, cacheHitRate: 0.75, durationMs: 60_000, models: [{ model: "claude-opus-5-5", turns: 4, tokens: 460, cost: 1.25 }] },
		activity: { state: "working", streaming: true, phase: "implementing", phaseLabel: "implementing…", blockedLabel: null, agents: 1, jobs: 1, label: "Working · 1 agent · 1 job" },
		pendingQuestion: null,
		commands: { items: DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => ({ ...command, source: "builtin" })), truncated: false },
	});
});

test("S2: unknown sources stay null instead of guessed values", () => {
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({ branch: undefined, model: undefined, context: undefined, usage: undefined, permission: undefined, changes: undefined, agents: undefined, jobs: undefined, review: undefined, identity: { ...fixtureInput().identity, env: {} } }));
	assert.equal(snapshot.project.branch, null);
	assert.equal(snapshot.project.dirty, null);
	assert.deepEqual(snapshot.model, { id: null, provider: null, effort: null, profile: { name: "work (session)", tier: "fast" } });
	for (const key of ["context", "usage", "permission", "changes", "agents", "jobs", "review", "persona", "statuses", "integrations"] as const) assert.equal(snapshot[key], null, key);
	assert.equal(snapshot.identity.herdr, null);
	assert.equal(buildDesktopFeedSnapshot(fixtureInput({ activity: { working: true, blocked: 2, blockedLabel: "Choice awaiting input", streaming: false, phase: undefined } })).activity.state, "blocked");
});

test("should publish the persona the input carries", () => {
	assert.equal(buildDesktopFeedSnapshot(fixtureInput({ persona: "neutral" })).persona, "neutral");
	assert.equal(buildDesktopFeedSnapshot(fixtureInput({ persona: "gentleman" })).persona, "gentleman");
	assert.equal(buildDesktopFeedSnapshot(fixtureInput()).persona, null);
});

test("should publish the persona the extension resolves for the session cwd", async (t) => {
	const seen: string[] = [];
	const h = feedHarness(t, { persona: (cwd) => { seen.push(cwd); return "neutral"; } });
	await h.start();
	assert.equal(h.read().persona, "neutral");
	assert.ok(seen.includes("/w"));
});

test("should publish the persona resolved from the project file, then the global one, with the default resolver", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-feed-persona-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const project = join(root, "project");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(join(project, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(configHome, "persona.json"), JSON.stringify({ mode: "neutral" }));
	const env = { ...GENTLE_ENV, GENTLE_PI_CONFIG_HOME: configHome };

	const fromGlobal = feedHarness(t, { persona: undefined }, env);
	await fromGlobal.start(fakeCtx({ cwd: project }));
	assert.equal(fromGlobal.read().persona, "neutral");

	writeFileSync(join(project, ".pi", "gentle-ai", "persona.json"), JSON.stringify({ mode: "gentleman" }));
	const fromProject = feedHarness(t, { persona: undefined }, env);
	await fromProject.start(fakeCtx({ cwd: project }));
	assert.equal(fromProject.read().persona, "gentleman");
});

test("should keep the persona null when resolving it throws", async (t) => {
	const h = feedHarness(t, { persona: () => { throw new Error("unreadable"); } });
	await h.start();
	assert.equal(h.read().persona, null);
});

test("S3: the snapshot names its agent dir as an absolute path, bundled, Pi extension or custom home", () => {
	for (const dir of ["/Users/me/.gentle-shell/agent", "/Users/me/.pi/agent", "/srv/custom-home"]) {
		assert.equal(buildDesktopFeedSnapshot(fixtureInput({ identity: { ...fixtureInput().identity, agentDir: dir } })).identity.agentDir, dir);
	}
	const relative = buildDesktopFeedSnapshot(fixtureInput({ identity: { ...fixtureInput().identity, agentDir: "rel/agent" } })).identity.agentDir;
	assert.equal(relative, join(process.cwd(), "rel", "agent"));
});

// ---- Process ancestry (how a Herdr terminal finds its session) ----

// agent 33128 <- launch.mjs 44120 <- terminal shell 44712 <- 30320 <- 38628 (no parent).
const WINDOWS_TABLE = "33128,44120\r\n44120,44712\r\n44712,30320\r\n30320,38628\r\n38628,0\r\n";

test("should parse the pid,ppid lines of a Windows process table and ignore other output", () => {
	const table = parseProcessTable(`${WINDOWS_TABLE}warning: something\r\n\r\nabc,def\r\n`);
	assert.equal(table.size, 5);
	assert.equal(table.get(33128), 44120);
	assert.equal(table.get(38628), 0);
});

test("should walk the Windows process table up to the terminal shell with one read per walk", async () => {
	let reads = 0;
	const read = async () => { reads += 1; return WINDOWS_TABLE; };
	assert.deepEqual(await processAncestors(44120, 8, createParentOf("win32", read)), [44712, 30320, 38628]);
	assert.equal(reads, 1);
	assert.deepEqual(await processAncestors(44120, 8, createParentOf("win32", read)), [44712, 30320, 38628]);
	assert.equal(reads, 2, "a new walk reads the table again");
});

test("should publish no ancestors when the Windows process table cannot be read", async () => {
	assert.deepEqual(await processAncestors(44120, 8, createParentOf("win32", async () => undefined)), []);
	assert.deepEqual(await processAncestors(44120, 8, createParentOf("win32", async () => { throw new Error("no powershell"); })), []);
	assert.deepEqual(await processAncestors(44120, 8, createParentOf("win32", () => { throw new Error("spawn failed"); })), []);
});

test("should stop at a Windows parent that is not a real process", async () => {
	assert.deepEqual(await processAncestors(10, 8, createParentOf("win32", async () => "10,20\r\n20,1\r\n")), [20]);
	assert.deepEqual(await processAncestors(20, 8, createParentOf("win32", async () => "20,0\r\n")), []);
	assert.deepEqual(await processAncestors(99, 8, createParentOf("win32", async () => WINDOWS_TABLE)), []);
});

test("should keep asking ps per hop outside Windows and never read a process table", async () => {
	let reads = 0;
	const parentOf = createParentOf("linux", async () => { reads += 1; return WINDOWS_TABLE; });
	assert.equal(parentOf, psParentOf);
	await processAncestors(process.ppid, 8, parentOf);
	assert.equal(reads, 0);
});

// ---- Bounds ----

test("S2: arrays and long strings are capped", () => {
	const files: ChangedFile[] = Array.from({ length: 250 }, (_, i) => ({ path: `f${i}.ts`, added: 1, deleted: 0, status: "modified" as const }));
	const model = changesModel(files);
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({
		changes: { model, worktrees: [] },
		todo: { tasks: Array.from({ length: 150 }, (_, i) => ({ id: i + 1, title: "x".repeat(2000), status: "pending" as const })), nextId: 151, updatedTurn: 1 },
		jobs: Array.from({ length: 80 }, (_, i): DesktopJobEntry => ({ id: `j${i}`, label: "job", status: "running", startedAt: 0 })),
		agents: Array.from({ length: 80 }, (_, i) => ({ id: `a${i}`, agent: "w", status: "running" as const, model: "m", lastStep: "running" as const, usage: { total: 1, cost: 1 } })),
	}));
	assert.equal(snapshot.changes!.files.length, DESKTOP_FEED_LIMITS.changes);
	assert.deepEqual(snapshot.changes!.summary, { files: 250, added: 250, deleted: 0 });
	assert.equal(snapshot.changes!.truncated, true);
	assert.equal(snapshot.todo.items.length, DESKTOP_FEED_LIMITS.todo);
	assert.equal(snapshot.todo.truncated, true);
	assert.equal(snapshot.todo.progress.total, 150);
	assert.equal(snapshot.todo.items[0]!.title.length, DESKTOP_FEED_LIMITS.text);
	assert.ok(snapshot.todo.items[0]!.title.endsWith("…"));
	assert.equal(snapshot.jobs!.running.length, DESKTOP_FEED_LIMITS.jobs);
	assert.equal(snapshot.agents!.items.length, DESKTOP_FEED_LIMITS.agents);
	assert.deepEqual(snapshot.agents!.spend, { runs: 80, tokens: 80, cost: 80 });
	assert.ok(JSON.stringify(snapshot).length < 256 * 1024);
});

// ---- Untracked files (the artboard's "A  path  +64 −0") ----

test("S8: untracked text files carry their line count; binary, oversized and over-budget files carry none", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-feed-untracked-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "notes.md"), "a\nb\nc\n");
	writeFileSync(join(root, "tail.txt"), "x\ny");
	writeFileSync(join(root, "empty.txt"), "");
	writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x0a]));
	writeFileSync(join(root, "big.log"), "line\n".repeat(10));
	writeFileSync(join(root, "late.md"), "one\n");
	const counter = createUntrackedLineCounter({ bytes: 32, files: 6 });
	const count = counter.forRoot(root);
	assert.equal(await count("notes.md"), 3);
	assert.equal(await count("tail.txt"), 2);
	assert.equal(await count("empty.txt"), 0);
	assert.equal(await count("logo.png"), 0);
	assert.equal(await count("big.log"), 0);
	assert.equal(await count("missing.md"), 0);
	assert.equal(await count("late.md"), 0, "past the per-scan file budget nothing is read");
	assert.deepEqual([...counter.uncounted()].sort(), ["big.log", "late.md", "logo.png", "missing.md"].map((name) => join(root, name)).sort());
	// A later scan that can count a file again clears its mark.
	writeFileSync(join(root, "logo.png"), "now text\n");
	assert.equal(await counter.forRoot(root)("logo.png"), 1);
	assert.equal(counter.uncounted().has(join(root, "logo.png")), false);
});

test("S8: an uncounted untracked file is published without counts", () => {
	const files: ChangedFile[] = [
		{ path: "assets/logo.png", added: 0, deleted: 0, status: "untracked" },
		{ path: "docs/new.md", added: 10, deleted: 0, status: "untracked" },
	];
	const model = changesModel(files);
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({ changes: { model, worktrees: [{ root: "/w", branch: "feat/x", model }], uncounted: new Set(["/w/assets/logo.png"]) } }));
	assert.deepEqual(snapshot.changes!.files, [
		{ path: "assets/logo.png", status: "untracked", added: null, deleted: null },
		{ path: "docs/new.md", status: "untracked", added: 10, deleted: 0 },
	]);
	assert.deepEqual(snapshot.changes!.summary, { files: 2, added: 10, deleted: 0 });
});

test("S8: the extension counts the lines of a session's untracked files", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-feed-root-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "main.js"), "1\n2\n3\n4\n");
	writeFileSync(join(root, "mark.png"), Buffer.from([0, 1, 2]));
	const git = () => async (args: string[]) => {
		const cmd = args.join(" ");
		if (cmd.startsWith("worktree list")) return { stdout: `worktree ${root}\0branch refs/heads/feat/x\0\0`, code: 0 };
		if (cmd.startsWith("symbolic-ref")) return { stdout: "feat/x\n", code: 0 };
		if (cmd.startsWith("rev-parse")) return { stdout: "abc\n", code: 0 };
		if (cmd.startsWith("diff --numstat")) return { stdout: "", code: 0 };
		if (cmd.startsWith("status")) return { stdout: "?? main.js\0?? mark.png\0", code: 0 };
		return { stdout: "", code: 1 };
	};
	const h = feedHarness(t, { git, rootExists: () => true });
	const ctx = fakeCtx({ cwd: root });
	(ctx.entries as unknown[]).push({ type: "custom", customType: SESSION_WORKTREE_ENTRY, data: { sessionId: "sess-1", root } });
	await h.start(ctx);
	await settle();
	h.clock.run();
	assert.deepEqual(h.read().changes!.files, [
		{ path: "main.js", status: "untracked", added: 4, deleted: 0 },
		{ path: "mark.png", status: "untracked", added: null, deleted: null },
	]);
	assert.deepEqual(h.read().changes!.summary, { files: 2, added: 4, deleted: 0 });
});

// ---- Store and debounce ----

test("S2: the store replaces the file atomically with a private file and leaves no temp file", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-feed-store-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const store = createDesktopFeedStore(agentDir, "sess-1");
	assert.equal(store.path, join(agentDir, "desktop", "sessions", "sess-1.json"));
	assert.equal(store.write({ n: 1 }), true);
	assert.equal(store.write({ n: 2 }), true);
	assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")), { n: 2 });
	assert.deepEqual(readdirSync(join(agentDir, "desktop", "sessions")), ["sess-1.json"]);
	if (process.platform !== "win32") {
		assert.equal(statSync(store.path).mode & 0o777, 0o600);
		assert.equal(statSync(join(agentDir, "desktop", "sessions")).mode & 0o777, 0o700);
	}
	// An id that could escape the folder is hashed into a plain file name.
	assert.match(desktopFeedFile(agentDir, "../evil"), /sessions[\\/][0-9a-f]{64}\.json$/);
	store.remove();
	assert.equal(existsSync(store.path), false);
});

test("S2: a burst of changes coalesces into one debounced write", () => {
	const clock = fakeTimers();
	let flushes = 0;
	const scheduler = createDesktopFeedScheduler(() => { flushes += 1; }, clock.timers);
	for (let i = 0; i < 5; i++) scheduler.schedule();
	assert.equal(clock.armed, 1);
	assert.equal(flushes, 0);
	clock.run();
	assert.equal(flushes, 1);
	assert.equal(clock.armed, 0);
	scheduler.schedule();
	scheduler.cancel();
	clock.run();
	assert.equal(flushes, 1);
});

test("S2: the extension writes once per burst and never rewrites an unchanged snapshot", async (t) => {
	const h = feedHarness(t);
	await h.start();
	const first = h.read();
	assert.equal(first.schema, DESKTOP_FEED_SCHEMA);
	assert.equal(first.identity.sessionFile, "/agent/sessions/--w--/2026_sess-1.jsonl");
	assert.equal(first.identity.realCwd, "/private/w");
	assert.equal(first.identity.pid, process.pid);
	assert.deepEqual(first.identity.herdr, { paneId: "t7", env: true });
	assert.equal(first.identity.agentDir, h.agentDir, "the snapshot names the agent dir it was written under");
	assert.deepEqual(first.model.profile, { name: "work (session)", tier: "fast" });
	assert.equal(first.cost.total, 0.25);
	assert.equal(first.stats.turns, 1);
	const writes = h.writes.length;
	for (let i = 0; i < 4; i++) h.fire("message_end", { message: { role: "user" } }, h.ctx);
	assert.equal(h.clock.armed, 1);
	h.clock.run();
	assert.equal(h.writes.length, writes, "an unchanged snapshot is not rewritten");
	h.fire("agent_start", {}, h.ctx);
	h.fire("message_start", { message: { role: "assistant" } }, h.ctx);
	h.fire("tool_execution_start", { toolCallId: "c1", toolName: "read", args: {} }, h.ctx);
	h.clock.run();
	assert.equal(h.writes.length, writes + 1);
	assert.deepEqual(h.read().activity, { state: "working", streaming: true, phase: null, phaseLabel: null, blockedLabel: null, agents: 0, jobs: 0, label: "Working" });
	assert.equal(h.clock.armed, 0, "nothing stays armed while nothing changes");
});

test("S2: todo, review and attention events reach the snapshot", async (t) => {
	const h = feedHarness(t);
	await h.start();
	h.fire("tool_execution_end", { toolCallId: "t1", toolName: "todo", isError: false, result: { details: { gentleTodo: { tasks: [{ id: 1, title: "Ship", status: "in_progress" }], nextId: 2, updatedTurn: 1 } } } }, h.ctx);
	h.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "sess-1", snapshot: { state: "consent", scope: "a.ts" } });
	h.bus.emit(REVIEW_SIDEBAR_EVENT, { sessionId: "other", snapshot: { state: "closed", scope: "b.ts" } });
	h.clock.run();
	const snapshot = h.read();
	assert.deepEqual(snapshot.todo.items, [{ id: 1, title: "Ship", state: "in_progress", note: null }]);
	assert.equal(snapshot.todo.current, "Ship");
	assert.deepEqual(snapshot.review, { state: "consent", label: "Needs your consent", scope: "a.ts" });
});

// ---- Pending question ----

test("S2/S5: an open ask_user_choice appears with its toolCallId and clears when it ends", async (t) => {
	const h = feedHarness(t);
	await h.start();
	h.fire("tool_execution_start", { toolCallId: "call-9", toolName: "ask_user_choice", args: { question: "Which layout?", options: [{ label: "A", description: "Inspector", value: "secret-token-a" }, { label: "B", description: "Rail", value: "secret-token-b" }], allowCustomResponse: true } }, h.ctx);
	h.bus.emit("herdr:blocked", { active: true, label: "Choice awaiting input" });
	h.clock.run();
	const open = h.read();
	assert.deepEqual(open.pendingQuestion, {
		kind: "choice", tool: "ask_user_choice", toolCallId: "call-9", question: "Which layout?", header: null,
		options: [{ label: "A", description: "Inspector" }, { label: "B", description: "Rail" }], multi: false, custom: true,
		questions: [{ question: "Which layout?", header: null, options: [{ label: "A", description: "Inspector" }, { label: "B", description: "Rail" }], multi: false, custom: true }],
		promptKind: null, terminalOnly: false, openedAt: "2026-11-14T12:00:00.000Z",
	});
	assert.equal(open.activity.state, "blocked");
	assert.equal(open.activity.blockedLabel, "Choice awaiting input");
	assert.ok(!readFileSync(h.file, "utf8").includes("secret-token"), "opaque answer tokens never reach the snapshot");
	h.bus.emit("herdr:blocked", { active: false });
	h.fire("tool_execution_end", { toolCallId: "call-9", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	h.clock.run();
	assert.equal(h.read().pendingQuestion, null);
	assert.equal(h.read().activity.state, "idle");
});

test("S2/S5: questionnaires, extension dialogs and content-free consent prompts are reported", async (t) => {
	const h = feedHarness(t);
	await h.start();
	h.fire("tool_execution_start", { toolCallId: "q1", toolName: "ask_user_question", args: { questions: [{ question: "Pick tabs", header: "Tabs", multiSelect: true, options: [{ label: "Todo", description: "list" }, { label: "Jobs", description: "queue" }] }, { question: "Theme?", header: "Theme", options: [{ label: "Rose", description: "" }, { label: "Dark", description: "d" }] }] } }, h.ctx);
	h.clock.run();
	const questionnaire = h.read().pendingQuestion!;
	assert.equal(questionnaire.kind, "questionnaire");
	assert.equal(questionnaire.toolCallId, "q1");
	assert.equal(questionnaire.question, "Pick tabs");
	assert.equal(questionnaire.multi, true);
	assert.equal(questionnaire.custom, true);
	assert.equal(questionnaire.terminalOnly, true, "several questions are answered in the terminal");
	assert.deepEqual(questionnaire.questions.map((q) => [q.question, q.header, q.multi, q.options.length]), [["Pick tabs", "Tabs", true, 2], ["Theme?", "Theme", false, 2]]);
	h.fire("tool_execution_end", { toolCallId: "q1", toolName: "ask_user_question", isError: false, result: {} }, h.ctx);
	h.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Allow review?" }, h.ctx);
	h.clock.run();
	assert.deepEqual({ ...h.read().pendingQuestion!, questions: undefined }, { kind: "prompt", tool: null, toolCallId: null, question: "Allow review?", header: null, options: [], multi: false, custom: false, questions: undefined, promptKind: "confirm", terminalOnly: true, openedAt: "2026-11-14T12:00:00.000Z" });
	h.fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" }, h.ctx);
	h.bus.emit("herdr:blocked", { active: true, label: "Review authorization awaiting input" });
	h.clock.run();
	assert.equal(h.read().pendingQuestion!.kind, "consent");
	assert.equal(h.read().pendingQuestion!.terminalOnly, true);
	assert.equal(h.read().pendingQuestion!.question, "Review authorization awaiting input");
	h.bus.emit("herdr:blocked", { active: false });
	h.clock.run();
	assert.equal(h.read().pendingQuestion, null);
});

// ---- Commands (T10, S9: the desktop palette and the composer's "/" menu) ----

test("S9: the snapshot lists the session's slash commands: pi's built-ins first, then its own, bounded", () => {
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({
		commands: [
			{ name: "gentle:status", description: "Show the Gentle status", source: "extension" },
			{ name: "gentle:desktop", description: "Desktop RPC", source: "extension" },
			{ name: "review", description: "x".repeat(900), source: "prompt" },
			{ name: "skill:odd", description: undefined, source: "skill" },
			{ name: "bad\u0007name", description: "control characters", source: "extension" },
			{ name: "", description: "nameless", source: "extension" },
		],
	}));
	const items = snapshot.commands.items;
	assert.deepEqual(items.slice(0, DESKTOP_FEED_BUILTIN_COMMANDS.length).map((item) => item.source), DESKTOP_FEED_BUILTIN_COMMANDS.map(() => "builtin"));
	assert.deepEqual(items.slice(DESKTOP_FEED_BUILTIN_COMMANDS.length), [
		{ name: "gentle:status", description: "Show the Gentle status", args: null, terminal: true, rpc: true, source: "extension" },
		{ name: "review", description: `${"x".repeat(DESKTOP_FEED_LIMITS.commandText - 1)}…`, args: null, terminal: false, rpc: true, source: "prompt" },
		{ name: "skill:odd", description: null, args: null, terminal: false, rpc: true, source: "skill" },
		{ name: "badname", description: "control characters", args: null, terminal: true, rpc: false, source: "extension" },
	], "the desktop RPC channel and nameless entries are left out; prompts and skills answer in the chat");
	assert.equal(snapshot.commands.truncated, false);
	const many = buildDesktopFeedSnapshot(fixtureInput({ commands: Array.from({ length: 400 }, (_, i) => ({ name: `c${i}`, description: "d", source: "extension" as const })) }));
	assert.equal(many.commands.items.length, DESKTOP_FEED_LIMITS.commands);
	assert.equal(many.commands.truncated, true);
});

test("S4: `terminal` keeps its Herdr meaning for every command after `rpc` is added", () => {
	// Herdr (gentle-chat, gentle-palette) types every command into the TUI and reads `terminal`
	// to decide whether to show the Terminal afterwards: these values must not move.
	const builtinTerminal: Record<string, boolean> = {
		new: false, resume: true, fork: true, clone: false, tree: true, compact: true, name: false, export: true,
		session: true, copy: false, model: true, thinking: true, "scoped-models": true, settings: true, hotkeys: true,
		reload: true, import: true, share: true, changelog: true, trust: true, login: true, logout: true, bug: true,
	};
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({
		commands: [
			{ name: "gentle:status", description: "declared", source: "extension" },
			{ name: "gentle:panel", description: "TUI sheet", source: "extension" },
			{ name: "third-party:thing", description: "undeclared", source: "extension" },
			{ name: "review", description: "template", source: "prompt" },
			{ name: "skill:odd", description: "skill", source: "skill" },
		],
	}));
	const terminal = Object.fromEntries(snapshot.commands.items.map((item) => [item.name, item.terminal]));
	assert.deepEqual(terminal, { ...builtinTerminal, "gentle:status": true, "gentle:panel": true, "third-party:thing": true, review: false, "skill:odd": false });
});

test("S4: `rpc` is true only for declared commands; undeclared extension commands stay false", () => {
	const snapshot = buildDesktopFeedSnapshot(fixtureInput({
		commands: [
			{ name: "gentle:status", description: "notify only", source: "extension" },
			{ name: "gentle:persona", description: "select + notify", source: "extension" },
			{ name: "gentle:panel", description: "ui.custom sheet", source: "extension" },
			{ name: "gentle:customize", description: "refuses outside the TUI", source: "extension" },
			{ name: "gentle:guide", description: "TUI only", source: "extension" },
			{ name: "third-party:thing", description: "undeclared", source: "extension" },
			{ name: "gentle:status:2", description: "a renamed duplicate is not the declared command", source: "extension" },
			{ name: "review", description: "template", source: "prompt" },
			{ name: "skill:odd", description: "skill", source: "skill" },
		],
	}));
	const rpc = Object.fromEntries(snapshot.commands.items.filter((item) => item.source !== "builtin").map((item) => [item.name, item.rpc]));
	assert.deepEqual(rpc, {
		"gentle:status": true, "gentle:persona": true,
		"gentle:panel": false, "gentle:customize": false, "gentle:guide": false, "third-party:thing": false, "gentle:status:2": false,
		review: true, "skill:odd": true,
	});
	for (const item of snapshot.commands.items) assert.equal(typeof item.rpc, "boolean", item.name);
});

test("S4: built-ins carry `rpc` only where Pi's RPC protocol has a matching command", () => {
	const rpc = Object.fromEntries(DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => [command.name, command.rpc]));
	assert.deepEqual(Object.entries(rpc).filter(([, value]) => value).map(([name]) => name).sort(),
		["clone", "compact", "copy", "export", "fork", "model", "name", "new", "session", "thinking"]);
	const items = buildDesktopFeedSnapshot(fixtureInput()).commands.items;
	assert.deepEqual(items, DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => ({ ...command, source: "builtin" })));
});

test("S9: session operations are listed with the screen they open", () => {
	const byName = new Map(DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => [command.name, command]));
	for (const name of ["new", "resume", "fork", "clone", "compact", "name", "export", "tree", "session"]) assert.ok(byName.has(name), name);
	assert.equal(byName.get("resume")!.terminal, true, "an interactive picker shows the Terminal");
	assert.equal(byName.get("fork")!.terminal, true);
	assert.equal(byName.get("new")!.terminal, false, "a new session shows in the chat");
	assert.equal(byName.get("name")!.args, "<name>");
	assert.equal(byName.has("quit"), false, "quitting the session is typed, never one click away");
});

test("S9: every listed built-in is one pi really has", async () => {
	// pi keeps the list out of its exports: read it next to the package entry.
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const { BUILTIN_SLASH_COMMANDS } = await import(pathToFileURL(join(dirname(entry), "core", "slash-commands.js")).href) as { BUILTIN_SLASH_COMMANDS: Array<{ name: string }> };
	const real = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	assert.deepEqual(DESKTOP_FEED_BUILTIN_COMMANDS.filter((command) => !real.has(command.name)).map((command) => command.name), []);
});

test("S9: the extension publishes pi's command registry and keeps working without one", async (t) => {
	const h = feedHarness(t);
	(h.pi as unknown as { getCommands: () => unknown[] }).getCommands = () => [
		{ name: "gentle:changes", description: "Open the changes panel", source: "extension", sourceInfo: { path: "/secret/ext.ts" } },
	];
	await h.start();
	const extension = h.read().commands.items.filter((item) => item.source !== "builtin");
	assert.deepEqual(extension, [{ name: "gentle:changes", description: "Open the changes panel", args: null, terminal: true, rpc: false, source: "extension" }]);
	assert.ok(!readFileSync(h.file, "utf8").includes("/secret/ext.ts"), "source paths never reach the snapshot");
	const bare = feedHarness(t);
	await bare.start();
	assert.equal(bare.read().commands.items.length, DESKTOP_FEED_BUILTIN_COMMANDS.length);
});

// ---- Lifecycle ----

test("S2: shutdown removes the snapshot, cancels the pending write and ignores late events", async (t) => {
	const h = feedHarness(t);
	await h.start();
	assert.ok(existsSync(h.file));
	h.fire("agent_start", {}, h.ctx);
	assert.equal(h.clock.armed, 1);
	h.fire("session_shutdown", { reason: "quit" }, h.ctx);
	assert.equal(h.removed, 1);
	assert.equal(existsSync(h.file), false);
	assert.equal(h.clock.armed, 0);
	const writes = h.writes.length;
	h.fire("agent_start", {}, h.ctx);
	h.bus.emit("herdr:blocked", { active: true, label: "x" });
	h.clock.run();
	assert.equal(h.writes.length, writes);
	assert.equal(existsSync(h.file), false);
});

test("S2: children, plain Pi and print sessions publish nothing", async (t) => {
	for (const [env, mode] of [[{ ...GENTLE_ENV, GENTLE_PI_AGENTS_CHILD: "1" }, "tui"], [{}, "tui"], [GENTLE_ENV, "print"], [GENTLE_ENV, "rpc"]] as const) {
		const h = feedHarness(t, {}, env);
		await h.start(fakeCtx({ mode }));
		assert.deepEqual(h.writes, [], `${JSON.stringify(env)} ${mode}`);
		assert.equal(existsSync(h.file), false);
	}
});

// ---- Existing desktop RPC behaviour is unchanged ----

/** Channel lines other than the feed's session_snapshot events, without the shared event counter. */
function withoutSessionSnapshots(lines: Array<string | undefined>): unknown[] {
	return lines
		.map((line) => JSON.parse(line!) as Record<string, unknown>)
		.filter((line) => line.event !== "session_snapshot")
		.map(({ seq: _seq, ...line }) => line);
}

test("S2: desktop RPC jobs answers and events are byte-identical with the feed loaded", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => { if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV]; else process.env[INTERACTIVE_HOST_ENV] = previous; });
	const run = async (withFeed: boolean) => {
		const harness = fakePi();
		let jobs: DesktopJobEntry[] = [{ id: "j1", label: "npm test", status: "running", startedAt: 1 }];
		const observers = new Set<(sessionId: string) => void>();
		// A minimal jobs owner speaking the existing owner-service contract.
		harness.bus.on(DESKTOP_JOBS_SERVICE_CHANNEL, (payload) => {
			const request = payload as { respond(service: unknown): void };
			const mine = new Set<(sessionId: string) => void>();
			request.respond({
				schema: DESKTOP_JOBS_SERVICE_SCHEMA,
				read: () => ({ sessionId: "sess-1", jobs }),
				cancel: () => ({ kind: "not_found" }),
				observe: (fn: (sessionId: string) => void) => { mine.add(fn); observers.add(fn); return () => { mine.delete(fn); observers.delete(fn); }; },
				dispose: () => { for (const fn of mine) observers.delete(fn); },
			});
		});
		desktopRpc(harness.pi);
		const agentDir = mkdtempSync(join(tmpdir(), "desktop-feed-rpc-"));
		t.after(() => rmSync(agentDir, { recursive: true, force: true }));
		const clock = fakeTimers();
		if (withFeed) createDesktopFeedExtension({ env: { ...GENTLE_ENV, [INTERACTIVE_HOST_ENV]: "1" }, agentDir, timers: clock.timers, git: () => async () => ({ stdout: "", code: 128 }), parentOf: async () => undefined, profile: () => ({ name: undefined, tier: undefined }), sweep: () => {} })(harness.pi);
		const ctx = fakeCtx({ mode: "rpc" });
		harness.fire("session_start", { reason: "startup" }, ctx);
		await settle();
		await harness.commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "r1", method: "list_jobs", params: {} }), ctx);
		jobs = [...jobs, { id: "j2", label: "build", status: "exited", startedAt: 2, endedAt: 3, exitCode: 0 }];
		for (const fn of [...observers]) fn("sess-1");
		await settle();
		clock.run();
		await settle();
		clock.run();
		const feed = withFeed ? JSON.parse(readFileSync(desktopFeedFile(agentDir, "sess-1"), "utf8")) as DesktopFeedSnapshot : undefined;
		return { lines: ctx.widgets.filter((widget) => widget.key === "gentle-desktop-rpc").map((widget) => widget.lines[0]), feed };
	};
	const without = await run(false);
	const withFeed = await run(true);
	// #3319: the feed also publishes its own session_snapshot events on the
	// channel; every other line is unchanged, in the same order.
	assert.deepEqual(withoutSessionSnapshots(withFeed.lines), withoutSessionSnapshots(without.lines));
	assert.equal(without.lines.length, 2, "one list_jobs answer and one jobs_update event");
	assert.deepEqual(withFeed.feed!.jobs, {
		running: [{ id: "j1", label: "npm test", startedAt: 1, elapsedMs: withFeed.feed!.jobs!.running[0]!.elapsedMs }],
		recent: [{ id: "j2", label: "build", status: "exited", startedAt: 2, endedAt: 3, exitCode: 0, elapsedMs: 1 }],
	});
});
