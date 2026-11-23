import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import shell, { backgroundChangeRefreshesSettled, shellUntrackedLines } from "../extensions/gentle-shell.ts";
import { createIdleChanges } from "../lib/shell-idle-changes.ts";

const quiet = 250;
const oneScan = ["worktree", "rev-parse", "diff", "status"];
const changed = "✎ 1 file · +2 −1 · hello.ts";
const theme = { fg: (_color: string, value: string) => value };
const tui = { requestRender() {} };
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
type Row = { render(width: number): string[] };
type Widget = (host: typeof tui, colors: typeof theme) => Row;

function fixture(t: TestContext, deferredCounts = false, budget = 2, statusFails = (_attempt: number) => false) {
	const config = mkdtempSync(join(tmpdir(), "gentle-changes-idle-"));
	t.after(() => rmSync(config, { recursive: true, force: true }));
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	let entries: unknown[];
	const calls: string[] = [], lookups: string[][] = [];
	let now = 0, statuses = 0;
	let gate: Promise<void> | undefined;
	const timers = new Map<() => void, { at: number; unrefed: boolean }>();
	const pi = {
		on: (key: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(key, [...(handlers.get(key) ?? []), fn]),
		events: { on: () => () => {}, emit() {} },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerCommand() {}, registerTool() {}, registerShortcut() {}, registerMessageRenderer() {}, getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	shell(pi, { GENTLE_PI_CONFIG_HOME: config }, {
		devBinary: () => undefined, resolveWorktree: (path, cwd) => {
			lookups.push([path, cwd]);
			return { root: "/repo", commonDir: "/repo/.git" };
		}, rootExists: () => true,
		gitRunner: () => async ([cmd]) => {
			calls.push(cmd);
			if (cmd === "worktree") await gate;
			if (cmd === "status" && statusFails(++statuses)) return { code: 1, stdout: "", timedOut: true };
			return { code: 0, stdout: cmd === "worktree" ? "worktree /repo\0branch refs/heads/main\0\0" : cmd === "status" ? (deferredCounts ? "?? a\0?? b\0?? c\0" : " M hello.ts\0") : cmd === "diff" ? "2\t1\thello.ts\n" : "" };
		},
		...(deferredCounts ? { changesLineCache: () => shellUntrackedLines({
			lstat: async () => ({ isFile: () => true, size: 2, mtimeMs: 1 }), read: async () => Buffer.from("x\n"),
		}, budget) } : {}),
		now: () => now,
		scheduleChangesIdle: (tick: () => void, delay: number) => {
			const timer = { at: now + delay, unrefed: false };
			timers.set(tick, timer);
			return { cancel: () => { timers.delete(tick); }, unref: () => { timer.unrefed = true; } };
		},
	});
	const advance = (ms: number) => {
		now += ms;
		for (const [tick, timer] of [...timers]) if (timer.at <= now && timers.delete(tick)) tick();
	};
	function session(id: string) {
		const sessionEntries: unknown[] = [];
		const widgets = new Map<string, Widget>();
		let footerFactory: (host: typeof tui, colors: typeof theme, data: typeof footerData) => Row;
		let terminalInput: ((data: string) => unknown) | undefined;
		let idle = true;
		// The gentle-shell.test.ts fakeContext shape: the real footer reads
		// context usage, session cwd and name, even before Git has run.
		const ctx = {
			hasUI: true, mode: "tui", cwd: "/repo", isIdle: () => idle, hasPendingMessages: () => false,
			getContextUsage: () => ({ tokens: 0, contextWindow: 272_000, percent: 0 }),
			sessionManager: { getCwd: () => "/repo", getSessionName: () => undefined, getSessionId: () => id, getEntries: () => sessionEntries },
			ui: { theme, setFooter: (factory: typeof footerFactory) => { footerFactory = factory; }, getEditorComponent: () => ({}), setWorkingVisible() {},
				setWidget: (key: string, value: Widget | undefined) => value === undefined ? widgets.delete(key) : widgets.set(key, value),
				onTerminalInput: (listener: typeof terminalInput) => { terminalInput = listener; return () => { terminalInput = undefined; }; } },
		} as unknown as ExtensionContext;
		const fire = async (key: string) => { entries = sessionEntries; for (const fn of handlers.get(key) ?? []) await fn({}, ctx); };
		const widget = () => widgets.get("gentle-shell-changes")?.(tui, theme).render(160)[0]?.replace(/\s+\/gentle:changes$/, "");
		return { fire, footer: () => footerFactory(tui, theme, footerData), widget, setIdle: (next: boolean) => { idle = next; },
			input: () => terminalInput?.("x"), observing: () => Boolean(terminalInput) };
	}
	return { session, calls, lookups, timers, advance, holdGit: () => { const held = Promise.withResolvers<void>(); gate = held.promise; return held.resolve; } };
}

test("session_start finishes with only existing worktree identity lookups, even when inventory Git would block", async (t) => {
	const f = fixture(t);
	const s = f.session("startup");
	t.after(() => s.fire("session_shutdown"));
	const release = f.holdGit();
	try {
		const started = s.fire("session_start");
		assert.equal(await Promise.race([started.then(() => "started"), new Promise((resolve) => setImmediate(resolve, "blocked"))]), "started");
		assert.deepEqual(f.lookups, Array.from({ length: 4 }, () => ["/repo", "/repo"]));
		assert.deepEqual(f.calls, []);
		assert.equal(f.timers.size, 0);
		assert.equal(s.widget(), undefined);
	} finally { release(); }
});

test("after first paint the first quiet, idle shell loads Changes exactly once", async (t) => {
	const f = fixture(t);
	const s = f.session("paint");
	t.after(() => s.fire("session_shutdown"));
	await s.fire("session_start");
	const footer = s.footer();
	f.advance(4 * quiet);
	assert.deepEqual(f.calls, [], "creating the footer is not a paint");
	assert.equal(s.widget(), undefined);
	footer.render(160);
	assert.deepEqual(f.calls, [], "the first paint itself does not run Git");
	s.setIdle(false);
	f.advance(quiet);
	assert.deepEqual(f.calls, [], "the shell must also be idle");
	s.setIdle(true);
	f.advance(quiet - 1);
	assert.deepEqual(f.calls, []);
	f.advance(1);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), changed);
	footer.render(160);
	f.advance(4 * quiet);
	assert.equal(f.timers.size, 0);
	assert.deepEqual(f.calls, oneScan);
});

test("typing restarts the quiet period and a turn start cancels the pending startup scan; agent_end still refreshes", async (t) => {
	const f = fixture(t);
	const s = f.session("turn");
	t.after(() => s.fire("session_shutdown"));
	await s.fire("session_start");
	s.footer().render(160);
	assert.equal(f.timers.size, 1);
	f.advance(quiet - 1);
	assert.equal(s.input(), undefined, "watching keys does not consume them");
	f.advance(quiet - 1);
	assert.deepEqual(f.calls, [], "a keystroke restarts the full quiet delay");
	await s.fire("agent_start");
	assert.equal(f.timers.size, 0);
	f.advance(4 * quiet);
	assert.deepEqual(f.calls, []);
	assert.equal(s.widget(), undefined);
	await s.fire("agent_end");
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), changed);
	f.advance(4 * quiet);
	assert.deepEqual(f.calls, oneScan);
});

test("session replacement and shutdown cancel unrefed scans and remove their input observers", async (t) => {
	const f = fixture(t);
	const old = f.session("old");
	await old.fire("session_start");
	const oldFooter = old.footer();
	oldFooter.render(160);
	assert.deepEqual([...f.timers.values()].map(({ unrefed }) => unrefed), [true]);
	assert.equal(old.observing(), true);
	const next = f.session("next");
	await next.fire("session_start");
	assert.equal(f.timers.size, 0);
	assert.equal(old.observing(), false);
	oldFooter.render(160);
	f.advance(4 * quiet);
	assert.deepEqual(f.calls, []);
	assert.equal(old.widget(), undefined);
	next.footer().render(160);
	assert.deepEqual([...f.timers.values()].map(({ unrefed }) => unrefed), [true]);
	assert.equal(next.observing(), true);
	await next.fire("session_shutdown");
	assert.equal(f.timers.size, 0);
	assert.equal(next.observing(), false);
	f.advance(4 * quiet);
	assert.deepEqual(f.calls, []);
	assert.equal(next.widget(), undefined);
});

const backoff = [1_000, 3_000, 10_000];

async function startFailingIdle(t: TestContext, fails: (attempt: number) => boolean, deferredCounts = false) {
	const f = fixture(t, deferredCounts, 2, fails);
	const s = f.session("retry");
	await s.fire("session_start");
	s.footer().render(160);
	f.advance(quiet);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), undefined);
	return { f, s };
}

const scans = (count: number) => Array.from({ length: count }, () => oneScan).flat();

test("a failed first idle scan recovers on its first retry without an agent turn", async (t) => {
	const { f, s } = await startFailingIdle(t, (attempt) => attempt === 1);
	t.after(() => s.fire("session_shutdown"));
	assert.deepEqual([...f.timers.values()].map(({ unrefed }) => unrefed), [true]);
	f.advance(backoff[0] - 1);
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), undefined);
	f.advance(1);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(2));
	assert.equal(s.widget(), changed);
	assert.equal(f.timers.size, 0);
	assert.equal(s.observing(), false);
});

test("a repeatedly failing root stops after bounded idle retries; turn end can still refresh", async (t) => {
	let failing = true;
	const { f, s } = await startFailingIdle(t, () => failing);
	t.after(() => s.fire("session_shutdown"));
	for (const [index, delay] of backoff.entries()) {
		f.advance(delay - 1);
		assert.deepEqual(f.calls, scans(index + 1));
		f.advance(1);
		await backgroundChangeRefreshesSettled();
		assert.deepEqual(f.calls, scans(index + 2));
		assert.equal(s.widget(), undefined);
	}
	assert.equal(f.timers.size, 0);
	assert.equal(s.observing(), false);
	f.advance(60_000);
	assert.deepEqual(f.calls, scans(4));
	failing = false;
	await s.fire("agent_end");
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(5));
	assert.equal(s.widget(), changed);
	assert.equal(f.timers.size, 0);
});

test("a turn start cancels a waiting failure retry", async (t) => {
	const { f, s } = await startFailingIdle(t, () => true);
	t.after(() => s.fire("session_shutdown"));
	assert.equal(f.timers.size, 1);
	f.advance(backoff[0] - 1);
	await s.fire("agent_start");
	assert.equal(f.timers.size, 0);
	assert.equal(s.observing(), false);
	f.advance(60_000);
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), undefined);
	await s.fire("agent_end");
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(2), "a turn end still runs its ordinary refresh");
	assert.equal(f.timers.size, 0, "a failed ordinary refresh does not start an idle retry chain");
});

test("shutdown cancels a waiting failure retry", async (t) => {
	const { f, s } = await startFailingIdle(t, () => true);
	assert.equal(f.timers.size, 1);
	await s.fire("session_shutdown");
	assert.equal(f.timers.size, 0);
	assert.equal(s.observing(), false);
	f.advance(60_000);
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), undefined);
});

test("typing postpones a waiting failure retry without consuming it or the key", async (t) => {
	const { f, s } = await startFailingIdle(t, (attempt) => attempt === 1);
	t.after(() => s.fire("session_shutdown"));
	assert.equal(s.observing(), true);
	f.advance(backoff[0] - 1);
	assert.equal(s.input(), undefined);
	f.advance(backoff[0] - 1);
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), undefined);
	f.advance(1);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(2));
	assert.equal(s.widget(), changed);
	assert.equal(f.timers.size, 0);
});

test("a successful retry resets backoff for a later failed idle count continuation", async (t) => {
	const { f, s } = await startFailingIdle(t, (attempt) => attempt === 1 || attempt === 3, true);
	t.after(() => s.fire("session_shutdown"));
	f.advance(backoff[0]);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(2));
	assert.equal(s.widget(), "✎ 3 files · +1 −0 · partial counts · a · b · c");
	f.advance(quiet);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(3));
	f.advance(backoff[0] - 1);
	assert.deepEqual(f.calls, scans(3));
	f.advance(1);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(4));
	assert.equal(s.widget(), "✎ 3 files · +2 −0 · partial counts · a · b · c");
	f.advance(quiet);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, scans(5));
	assert.equal(s.widget(), "✎ 3 files · +3 −0 · a · b · c");
	assert.equal(f.timers.size, 0);
});

test("pending counts resume after typing and a turn, coalesce in-flight scans, and stop at complete counts", async (t) => {
	const f = fixture(t, true);
	const s = f.session("counts");
	t.after(() => s.fire("session_shutdown"));
	await s.fire("session_start");
	s.footer().render(160);
	f.advance(quiet);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, oneScan);
	assert.equal(s.widget(), "✎ 3 files · +1 −0 · partial counts · a · b · c");
	f.advance(quiet - 1);
	s.input();
	f.advance(quiet - 1);
	assert.deepEqual(f.calls, oneScan);
	const release = f.holdGit();
	try {
		f.advance(1);
		assert.deepEqual(f.calls, [...oneScan, "worktree"]);
		s.setIdle(false);
		await s.fire("agent_start");
		await s.fire("agent_end");
		f.advance(4 * quiet);
		assert.deepEqual(f.calls, [...oneScan, "worktree"], "turn-end refresh shares the in-flight scan");
	} finally { release(); }
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, [...oneScan, ...oneScan]);
	assert.equal(s.widget(), "✎ 3 files · +2 −0 · partial counts · a · b · c");
	f.advance(quiet);
	assert.deepEqual(f.calls, [...oneScan, ...oneScan], "post-run work is still busy");
	s.setIdle(true);
	f.advance(quiet);
	await backgroundChangeRefreshesSettled();
	assert.deepEqual(f.calls, [...oneScan, ...oneScan, ...oneScan]);
	assert.equal(s.widget(), "✎ 3 files · +3 −0 · a · b · c");
	f.advance(4 * quiet);
	assert.equal(f.timers.size, 0);
	assert.deepEqual(f.calls, [...oneScan, ...oneScan, ...oneScan]);
});

// Counts that stay pending without progress (here: a budget no file fits in)
// must not keep the shell scanning forever while idle.
test("idle continuation stops after a pass that made no progress", async (t) => {
	const f = fixture(t, true, 1);
	const s = f.session("stuck");
	t.after(() => s.fire("session_shutdown"));
	await s.fire("session_start");
	s.footer().render(160);
	for (let tick = 0; tick < 12; tick++) {
		f.advance(quiet);
		await backgroundChangeRefreshesSettled();
	}
	assert.equal(f.calls.filter((cmd) => cmd === "status").length, 2, "the first pass, then one pass that confirms nothing moved");
	assert.equal(f.timers.size, 0, "no idle timer is left armed");
});

test("unchanged pending counts do not keep the idle scan armed forever", () => {
	const ticks = new Set<() => void>();
	let scans = 0;
	const idle = createIdleChanges({
		isIdle: () => true,
		refresh() {
			scans++;
			idle.scanStarted();
			idle.scanFinished(3, {});
		},
		observeInput: () => undefined,
		schedule(tick) {
			ticks.add(tick);
			return { cancel: () => { ticks.delete(tick); }, unref() {} };
		},
	});
	const advance = () => { for (const tick of [...ticks]) if (ticks.delete(tick)) tick(); };
	idle.started();
	idle.firstPaint();
	for (let i = 0; i < 60; i++) advance();
	const before = scans;
	for (let i = 0; i < 60; i++) advance();
	assert.equal(before, 2, "the first pass and the one that saw no progress");
	assert.equal(scans, before);
	assert.equal(ticks.size, 0);
	idle.dispose();
});

// Found by the independent verify: once the failure retries run out, counts
// that still progress on a healthy root must keep continuing while idle.
test("pending counts keep progressing after the failure retries run out", () => {
	const ticks = new Set<() => void>();
	let scans = 0, pending = 10;
	const idle = createIdleChanges({
		isIdle: () => true,
		refresh() {
			scans++;
			const turn = idle.scanStarted();
			pending = Math.max(0, pending - 1);
			idle.scanFinished(pending, {}, 1, turn);
		},
		observeInput: () => undefined,
		schedule(tick) {
			ticks.add(tick);
			return { cancel: () => { ticks.delete(tick); }, unref() {} };
		},
	});
	const advance = () => { for (const tick of [...ticks]) if (ticks.delete(tick)) tick(); };
	idle.started();
	idle.firstPaint();
	for (let i = 0; i < 40; i++) advance();
	assert.equal(pending, 0, "every count finished");
	assert.equal(scans, 10);
	assert.equal(ticks.size, 0, "nothing stays armed once counts are complete");
	idle.dispose();
});

test("progressing line counts outlive the idle failure retry budget", () => {
	const ticks = new Set<() => void>();
	let pending = 6;
	const idle = createIdleChanges({
		isIdle: () => true,
		refresh() {
			const turn = idle.scanStarted();
			pending = Math.max(0, pending - 1);
			idle.scanFinished(pending, {}, 1, turn);
		},
		observeInput: () => undefined,
		schedule(tick) {
			ticks.add(tick);
			return { cancel: () => { ticks.delete(tick); }, unref() {} };
		},
	});
	idle.started();
	idle.firstPaint();
	for (let i = 0; i < 12 && ticks.size; i++) {
		for (const tick of [...ticks]) if (ticks.delete(tick)) tick();
	}
	assert.equal(pending, 0);
	assert.equal(ticks.size, 0);
	idle.dispose();
});

// A pending count that moves without going down (a file rewritten while it is
// counted) must not keep the idle continuation alive: it continues only while
// the count reaches a new low.
test("idle continuation stops when pending counts oscillate without a new low", () => {
	const ticks = new Set<() => void>();
	const counts = [5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6];
	let scans = 0;
	const idle = createIdleChanges({
		isIdle: () => true,
		refresh() {
			const turn = idle.scanStarted();
			idle.scanFinished(counts[Math.min(scans++, counts.length - 1)], {}, 0, turn);
		},
		observeInput: () => undefined,
		schedule(tick) {
			ticks.add(tick);
			return { cancel: () => { ticks.delete(tick); }, unref() {} };
		},
	});
	idle.started();
	idle.firstPaint();
	for (let i = 0; i < 40 && ticks.size; i++) for (const tick of [...ticks]) if (ticks.delete(tick)) tick();
	assert.equal(scans, 2, "the first pass, then the one that did not reach a new low");
	assert.equal(ticks.size, 0);
	idle.dispose();
});

// Found by the independent verify: a root that keeps failing must not turn an
// unchanged pending count into endless 250 ms idle rescans.
test("unchanged pending counts next to a failing root stop once the retries run out", () => {
	const ticks = new Set<() => void>();
	let scans = 0;
	const idle = createIdleChanges({
		isIdle: () => true,
		refresh() {
			scans++;
			const turn = idle.scanStarted();
			idle.scanFinished(5, {}, 1, turn);
		},
		observeInput: () => undefined,
		schedule(tick) {
			ticks.add(tick);
			return { cancel: () => { ticks.delete(tick); }, unref() {} };
		},
	});
	idle.started();
	idle.firstPaint();
	for (let i = 0; i < 40 && ticks.size; i++) for (const tick of [...ticks]) if (ticks.delete(tick)) tick();
	assert.ok(scans <= 5, `the first pass, the three retries, at most one pass without progress (saw ${scans})`);
	assert.equal(ticks.size, 0);
	idle.dispose();
});

test("oscillating pending counts next to a failing root stop once the retries run out", () => {
	const ticks = new Set<() => void>();
	let scans = 0;
	const idle = createIdleChanges({
		isIdle: () => true,
		refresh() {
			const turn = idle.scanStarted();
			idle.scanFinished(scans++ % 2 ? 6 : 5, {}, 1, turn);
		},
		observeInput: () => undefined,
		schedule(tick) {
			ticks.add(tick);
			return { cancel: () => { ticks.delete(tick); }, unref() {} };
		},
	});
	idle.started();
	idle.firstPaint();
	for (let i = 0; i < 60 && ticks.size; i++) for (const tick of [...ticks]) if (ticks.delete(tick)) tick();
	assert.ok(scans <= 6, `bounded (saw ${scans})`);
	assert.equal(ticks.size, 0);
	idle.dispose();
});
