import assert from "node:assert/strict";
import test from "node:test";
import {
	createEventBatcher, MONITOR_FLOOD_LINES, MONITOR_FLOOD_WINDOW_MS, MONITOR_LINES_PER_NOTICE, mergeMonitorBatches,
} from "../lib/background-monitor.ts";

// The batcher turns a monitor's stdout lines into bounded notices. It owns no
// timers: the caller flushes MONITOR_BATCH_MS after a line opens a batch.

test("the first line of a batch asks the caller to schedule a flush; later lines join it", () => {
	const batcher = createEventBatcher();
	assert.deepEqual(batcher.pushLine("check lint: pass", 0), { opensBatch: true, flood: false });
	assert.deepEqual(batcher.pushLine("check test: fail", 50), { opensBatch: false, flood: false });
	assert.deepEqual(batcher.flush(), { lines: ["check lint: pass", "check test: fail"], omitted: 0 });
	assert.equal(batcher.flush(), undefined, "an empty batch is never delivered");
	assert.equal(batcher.pushLine("check e2e: pass", 300).opensBatch, true, "after a flush the next line opens a new batch");
	assert.equal(batcher.total(), 3);
});

test("a batch keeps at most MONITOR_LINES_PER_NOTICE lines and counts the rest", () => {
	const batcher = createEventBatcher();
	for (let i = 0; i < MONITOR_LINES_PER_NOTICE + 7; i++) batcher.pushLine(`line ${i}`, i);
	const batch = batcher.flush()!;
	assert.equal(batch.lines.length, MONITOR_LINES_PER_NOTICE);
	assert.equal(batch.lines[0], "line 0");
	assert.equal(batch.omitted, 7);
	assert.equal(batcher.total(), MONITOR_LINES_PER_NOTICE + 7);
});

test("more than MONITOR_FLOOD_LINES lines within the flood window is a flood; a slower stream is not", () => {
	const slow = createEventBatcher();
	const spacing = Math.ceil(MONITOR_FLOOD_WINDOW_MS / MONITOR_FLOOD_LINES) + 1;
	for (let i = 0; i < MONITOR_FLOOD_LINES * 3; i++) assert.equal(slow.pushLine("tick", i * spacing).flood, false);
	const fast = createEventBatcher();
	for (let i = 0; i < MONITOR_FLOOD_LINES; i++) assert.equal(fast.pushLine("spam", i).flood, false);
	assert.equal(fast.pushLine("spam", MONITOR_FLOOD_LINES).flood, true);
});

test("blank lines are not events", () => {
	const batcher = createEventBatcher();
	assert.deepEqual(batcher.pushLine("   ", 0), { opensBatch: false, flood: false });
	assert.equal(batcher.total(), 0);
	assert.equal(batcher.flush(), undefined);
});

test("pending batches for one monitor coalesce within the same line bound", () => {
	assert.deepEqual(mergeMonitorBatches({ lines: ["a", "b"], omitted: 1 }, { lines: ["c"], omitted: 2 }), { lines: ["a", "b", "c"], omitted: 3 });
	const full = { lines: Array.from({ length: MONITOR_LINES_PER_NOTICE }, (_, i) => `x${i}`), omitted: 0 };
	assert.deepEqual(mergeMonitorBatches(full, { lines: ["late", "later"], omitted: 4 }), { lines: full.lines, omitted: 6 });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobRegistry, type JobExecOperations, type JobRecord } from "../lib/background-jobs.ts";
import { createMonitorController, MONITOR_BATCH_MS, type MonitorNotice } from "../lib/background-monitor.ts";

// A fake clock and scheduler drive the controller; a fake shell feeds lines.
function monitorHarness() {
	const dir = mkdtempSync(join(tmpdir(), "gentle-monitor-test-"));
	let clock = 0;
	const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
	const schedule = (fn: () => void, ms: number) => {
		const timer = { at: clock + ms, fn, live: true };
		timers.push(timer);
		return () => { timer.live = false; };
	};
	const advance = (ms: number) => {
		clock += ms;
		for (const timer of timers.filter((entry) => entry.live && entry.at <= clock)) { timer.live = false; timer.fn(); }
	};
	const runs: Array<{ onData(data: Buffer): void; signal?: AbortSignal; exit(code: number): void }> = [];
	const operations: JobExecOperations = {
		exec: (_command, _cwd, options) => new Promise((done, fail) => {
			options.signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
			runs.push({ onData: options.onData, signal: options.signal, exit: (code) => done({ exitCode: code }) });
		}),
	};
	const settled: JobRecord[] = [];
	let notifySettled!: () => void;
	const completion = new Promise<void>((resolve) => { notifySettled = resolve; });
	const registry = createJobRegistry({ outputDir: () => dir, now: () => clock, shell: () => ({ operations }), onSettled: (job) => { settled.push(job); notifySettled(); } });
	const notices: MonitorNotice[] = [];
	const controller = createMonitorController({ registry, schedule, now: () => clock, deliver: (notice) => notices.push(notice) });
	const line = (text: string) => runs.at(-1)!.onData(Buffer.from(`${text}\n`));
	return { controller, registry, runs, notices, settled, completion, advance, line, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("a monitor delivers lines within one batch window as one events notice, and keeps running", () => {
	const h = monitorHarness();
	try {
		const job = h.controller.start({ command: "gh run watch", cwd: "/repo", ownerSessionId: "s1", label: "CI", timeoutSeconds: 600 });
		assert.equal(job.kind, "monitor");
		h.line("lint: pass");
		h.advance(50);
		h.line("unit: fail");
		assert.equal(h.notices.length, 0, "nothing is delivered before the batch window closes");
		h.advance(MONITOR_BATCH_MS);
		assert.deepEqual(h.notices, [{ job, kind: "events", batch: { lines: ["lint: pass", "unit: fail"], omitted: 0 } }]);
		assert.equal(job.status, "running");
		assert.equal(job.events, 2);
	} finally { h.controller.cancelAll(); h.cleanup(); }
});

test("the mandatory timeout stops a monitor after delivering its pending lines", () => {
	const h = monitorHarness();
	try {
		const job = h.controller.start({ command: "tail -f log", cwd: "/repo", ownerSessionId: "s1", timeoutSeconds: 30 });
		h.advance(29_900);
		h.line("ERROR one");
		h.advance(100);
		assert.deepEqual(h.notices.map((notice) => notice.kind), ["events", "stopped"]);
		assert.deepEqual(h.notices[1], { job, kind: "stopped", reason: "timeout" });
		assert.equal(job.status, "stopped");
		assert.equal(h.runs[0]!.signal?.aborted, true);
	} finally { h.controller.cancelAll(); h.cleanup(); }
});

test("a flooding monitor is stopped and reported once; later lines are ignored", () => {
	const h = monitorHarness();
	try {
		const job = h.controller.start({ command: "yes", cwd: "/repo", ownerSessionId: "s1", timeoutSeconds: 600 });
		for (let i = 0; i < 200; i++) h.line(`spam ${i}`);
		const kinds = h.notices.map((notice) => notice.kind);
		assert.deepEqual(kinds, ["events", "stopped"]);
		assert.deepEqual(h.notices[1], { job, kind: "stopped", reason: "flood" });
		assert.equal(job.status, "stopped");
		h.advance(MONITOR_BATCH_MS * 10);
		assert.equal(h.notices.length, 2, "a stopped monitor delivers nothing more");
	} finally { h.controller.cancelAll(); h.cleanup(); }
});

test("finish flushes pending lines before the exit notice; cancel drops timers without notices", async () => {
	const h = monitorHarness();
	try {
		const job = h.controller.start({ command: "watch", cwd: "/repo", ownerSessionId: "s1", timeoutSeconds: 60 });
		h.line("last check: pass");
		h.runs[0]!.exit(0);
		await h.completion;
		assert.equal(h.settled[0], job);
		h.controller.finish(job);
		assert.deepEqual(h.notices.map((notice) => notice.kind), ["events"]);
		h.advance(120_000);
		assert.equal(h.notices.length, 1, "a finished monitor has no timeout left");

		const other = h.controller.start({ command: "watch", cwd: "/repo", ownerSessionId: "s1", timeoutSeconds: 60 });
		h.line("pending");
		h.controller.cancel(other.id);
		h.advance(120_000);
		assert.equal(h.notices.length, 1, "a cancelled monitor delivers nothing more");
	} finally { h.controller.cancelAll(); h.cleanup(); }
});

test("timeout_seconds is mandatory and capped at 30 minutes", () => {
	const h = monitorHarness();
	try {
		for (const timeoutSeconds of [0, -1, 1801, Number.NaN, 1.5]) {
			assert.throws(() => h.controller.start({ command: "x", cwd: "/repo", ownerSessionId: "s1", timeoutSeconds }), /timeout_seconds must be a whole number from 1 to 1800/);
		}
		assert.equal(h.runs.length, 0, "an invalid monitor never starts a process");
	} finally { h.controller.cancelAll(); h.cleanup(); }
});

test("a timeout that fires after the command already exited reports nothing; the exit wins", async () => {
	const h = monitorHarness();
	try {
		const job = h.controller.start({ command: "watch", cwd: "/repo", ownerSessionId: "s1", timeoutSeconds: 1 });
		h.advance(900);
		h.line("last line");
		h.runs[0]!.exit(0);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(job.status, "exited", "the exit is recorded before its log closes");
		h.advance(100);
		assert.deepEqual(h.notices, [], "no stopped notice for a monitor that ended on its own");
		await h.completion;
		assert.equal(h.settled[0], job);
		h.controller.finish(job);
		assert.deepEqual(h.notices, [{ job, kind: "events", batch: { lines: ["last line"], omitted: 0 } }], "its pending line still arrives");
	} finally { h.controller.cancelAll(); h.cleanup(); }
});

test("stopped notices name the timeout or flood limit and where the full output is", async () => {
	const { monitorStoppedText } = await import("../lib/background-jobs-tools.ts");
	const h = monitorHarness();
	try {
		const job = h.controller.start({ command: "tail -f log", cwd: "/repo", ownerSessionId: "s1", label: "log", timeoutSeconds: 30 });
		h.advance(30_000);
		const timeout = monitorStoppedText(job, "timeout");
		assert.match(timeout, /reached its 30s timeout after 0 events/);
		assert.ok(timeout.includes(`Full output: ${job.outputPath}`));
		const flood = monitorStoppedText(job, "flood");
		assert.ok(flood.includes(`Full output: ${job.outputPath}`));
	} finally { h.controller.cancelAll(); h.cleanup(); }
});
