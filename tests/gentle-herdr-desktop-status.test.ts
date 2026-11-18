import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrDesktopStatusExtension } from "../extensions/gentle-herdr-desktop-status.ts";
import { NOTIFICATION_ATTENTION_EVENT } from "../lib/notification-events.ts";

const TASKS = "gentle-pi:herdr-desktop:tasks";
const TASKS_REQUEST = "gentle-pi:herdr-desktop:tasks-request";
const TASK_FINISHED = "gentle-pi:herdr-desktop:task-finished";
const CONSULT = "gentle-pi:herdr-desktop:consult";
const SEND = "gentle-pi:herdr-desktop:send";
const INBOUND = "gentle-pi:herdr-desktop:inbound";
const TODO = "gentle-pi:todo:progress";
const JOBS = "gentle-ai:jobs-sidebar";
const JOBS_REPLAY = "gentle-pi:herdr-desktop:jobs";
const JOB_SETTLED = "gentle-pi:herdr-desktop:job-settled";
const clear = (id: string) => `\x1b]7501;state=clear:id=${id}\x1b\\`;
const msg = (value: string) => Buffer.from(value).toString("base64");
const record = (id: string, fields: string) => `\x1b]7501;${fields}:id=${id}\x1b\\`;
const todoEntry = (tasks: unknown[]) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { gentleTodo: { tasks, nextId: 3, updatedTurn: 1 } } } });
const task = (id: number, title: string, status: string) => ({ id, title, status });

type Handler = (event: any, ctx: ExtensionContext) => void;
function harness(env: NodeJS.ProcessEnv = { HC_TERMINAL_ID: "terminal", PI_PROGRAM_STATUS_APP: "gentle-shell" }) {
	const handlers = new Map<string, Handler>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const events: Array<{ name: string; data: unknown }> = [];
	const writes: string[] = [];
	let now = 1000;
	let nextTimer = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	let failingWrites = 0;
	const terminal = { write(data: string) {
		assert.equal(this, terminal);
		if (failingWrites > 0) { failingWrites--; throw new Error("write failed"); }
		writes.push(data);
	}, setProgramStatus() { throw new Error("root status must not be touched"); } };
	const pi = {
		on(name: string, fn: Handler) { handlers.set(name, fn); },
		events: {
			on(name: string, fn: (data: unknown) => void) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
			emit(name: string, data: unknown) { events.push({ name, data }); for (const fn of listeners.get(name) ?? []) fn(data); },
		},
	} as unknown as ExtensionAPI;
	createHerdrDesktopStatusExtension({ env, now: () => now, schedule(fn, ms) {
		const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return () => { timers.delete(id); };
	} })(pi);
	const context = (sessionId = "s1", mode = "tui", hasUI = true) => {
		let branch: unknown[] = [];
		let percent: unknown;
		let usageThrows = false;
		let usageReads = 0;
		let widget: { render(width: number): string[]; dispose?(): void } | undefined;
		const ctx = { mode, hasUI, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
			getContextUsage() { usageReads++; if (usageThrows) throw new Error("usage unavailable"); return percent === undefined ? undefined : { percent }; },
			ui: { setWidget(_key: string, factory: ((tui: unknown) => typeof widget) | undefined) {
				widget?.dispose?.(); widget = factory?.({ terminal });
			} },
		} as unknown as ExtensionContext;
		return { ctx, branch(value: unknown[]) { branch = value; }, widget: () => widget,
			usage(value: unknown) { percent = value; usageThrows = false; }, throwUsage() { usageThrows = true; }, usageReads: () => usageReads };
	};
	const current = context();
	return { ...current, context, writes, terminal, events, pi,
		fire(name: string, event: unknown = {}, ctx = current.ctx) { handlers.get(name)?.(event, ctx); },
		emit(name: string, data: unknown) { pi.events.emit(name, data); },
		advance(ms: number) { now += ms; for (;;) { const due = [...timers].find(([, timer]) => timer.at <= now); if (!due) break; timers.delete(due[0]); due[1].fn(); } },
		pendingTimers: () => timers.size,
		failNextWrites(count: number) { failingWrites = count; },
		listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
	};
}

test("S3 gates on terminal, launcher, child marker and interactive UI without touching root", () => {
	for (const [env, mode, hasUI] of [
		[{}, "tui", true], [{ HC_TERMINAL_ID: "", PI_PROGRAM_STATUS_APP: "gentle-shell" }, "tui", true],
		[{ HC_TERMINAL_ID: "t", PI_PROGRAM_STATUS_APP: "pi" }, "tui", true],
		[{ HC_TERMINAL_ID: "t", PI_PROGRAM_STATUS_APP: "gentle-shell", GENTLE_PI_AGENTS_CHILD: "1" }, "tui", true],
		[{ HC_TERMINAL_ID: "t", PI_PROGRAM_STATUS_APP: "gentle-shell", GENTLE_PI_AGENTS_CHILD: "0" }, "tui", true],
		[{ HC_TERMINAL_ID: "t", PI_PROGRAM_STATUS_APP: "gentle-shell", GENTLE_PI_AGENTS_CHILD: "" }, "tui", true],
		[{ HC_TERMINAL_ID: "t", PI_PROGRAM_STATUS_APP: "gentle-shell" }, "rpc", true],
		[{ HC_TERMINAL_ID: "t", PI_PROGRAM_STATUS_APP: "gentle-shell" }, "tui", false],
	] as const) {
		const h = harness(env); const c = h.context("s1", mode, hasUI);
		c.usage(52); c.branch([todoEntry([task(1, "Work", "in_progress")])]); h.fire("session_start", {}, c.ctx);
		h.emit(TODO, { sessionId: "s1", done: 0, total: 1, current: "Work" });
		h.emit(NOTIFICATION_ATTENTION_EVENT, { active: true, label: "Choose" });
		h.emit(NOTIFICATION_ATTENTION_EVENT, { active: false });
		for (const event of ["turn_start", "tool_execution_start", "turn_end", "session_compact", "model_select", "session_tree", "agent_settled", "session_shutdown"]) h.fire(event, {}, c.ctx);
		assert.deepEqual(h.writes, []); assert.equal(c.widget(), undefined); assert.equal(c.usageReads(), 0);
	}
});

test("S2 ignores attention events without subscribing or writing a decision or root record", () => {
	const h = harness(); h.usage(42); h.branch([todoEntry([task(1, "Work", "in_progress")])]); h.fire("session_start");
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", explicitLabel: "Job", startedAt: 1 }] } });
	const existing = [record("todo", "state=working:progress=0:title=V29yaw=="), record("bg/j", "state=working:title=Sm9i")];
	assert.equal(h.listenerCount(NOTIFICATION_ATTENTION_EVENT), 0);
	for (const event of [{ active: true, label: "Choose" }, { active: true }, { active: false }, null]) h.emit(NOTIFICATION_ATTENTION_EVENT, event);
	assert.deepEqual(h.writes, existing);
	h.fire("session_shutdown");
	assert.deepEqual(h.writes, [...existing, clear("todo"), clear("bg/j")]);
});

test("S12 never publishes a ctx record: known context usage alone leaves no activity", () => {
	const h = harness(); h.usage(42); h.fire("session_start");
	for (const [event, percent] of [["turn_start", 20], ["tool_execution_start", 30], ["turn_end", 40],
		["model_select", 50], ["session_tree", 60], ["session_compact", 70], ["agent_settled", 80]] as const) {
		h.usage(percent); h.fire(event);
	}
	assert.deepEqual(h.writes, []);
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", explicitLabel: "Job", startedAt: 1 }] } });
	assert.deepEqual(h.writes, [record("bg/j", "state=working:title=Sm9i")]);
	h.usage(90); h.fire("turn_end");
	assert.deepEqual(h.writes, [record("bg/j", "state=working:title=Sm9i")]);
	h.fire("session_shutdown");
	assert.deepEqual(h.writes, [record("bg/j", "state=working:title=Sm9i"), clear("bg/j")]);
});

test("S4 replays and updates todo, handles branch navigation and ignores failed or malformed updates", () => {
	const h = harness(); h.branch([todoEntry([task(1, "Done", "done"), task(2, "Work", "in_progress")])]);
	h.fire("session_start");
	assert.deepEqual(h.widget()?.render(80), []);
	assert.deepEqual(h.writes, [record("todo", "state=working:progress=50:title=V29yaw==")]);
	h.emit(TODO, { sessionId: "foreign", done: 0, total: 1, current: "wrong" });
	h.emit(TODO, { sessionId: "s1", done: -1, total: 1, current: "wrong" });
	h.fire("tool_execution_end", { toolName: "todo", isError: true, result: { details: { gentleTodo: { tasks: [] } } } });
	h.fire("tool_execution_end", { toolName: "todo", result: { details: { gentleTodo: { tasks: [{ title: 3 }] } } } });
	assert.equal(h.writes.length, 1);
	h.emit(TODO, { sessionId: "s1", done: 1, total: 3, current: "Next" });
	h.fire("tool_execution_end", { toolName: "todo", result: { details: { gentleTodo: { tasks: [task(1, "Done", "done"), task(2, "Finish", "in_progress")] } } } });
	h.branch([todoEntry([task(1, "Done", "done")])]); h.fire("session_tree");
	assert.deepEqual(h.writes.slice(1), [record("todo", "state=working:progress=33:title=TmV4dA=="), record("todo", "state=working:progress=50:title=RmluaXNo"), clear("todo")]);
	h.fire("session_shutdown");
});

test("S11 task OSC titles use explicit labels, not local prompt labels, for working and errors", () => {
	const h = harness(); h.fire("session_start");
	const unlabeled = { id: "a", agent: "explore", label: "Private prompt sentence", status: "running" };
	const labeled = { id: "b", agent: "explore", label: "Local label", explicitLabel: "Inspect files", status: "running" };
	h.emit(TASKS, { sessionId: "s1", tasks: [unlabeled, labeled] });
	h.emit(TASK_FINISHED, { sessionId: "s1", task: { ...unlabeled, status: "failed" } });
	h.emit(TASK_FINISHED, { sessionId: "s1", task: { ...labeled, status: "timed_out" } });
	h.emit(TASK_FINISHED, { sessionId: "s1", task: { ...unlabeled, id: "c", status: "failed" } });
	assert.deepEqual(h.writes, [
		record("subagents/a", `state=working:title=${msg("explore")}`),
		record("subagents/b", `state=working:title=${msg("Inspect files")}`),
		record("subagents/a", `state=error:title=${msg("explore")}:msg=${msg("failed")}`),
		record("subagents/b", `state=error:title=${msg("Inspect files")}:msg=${msg("timed out")}`),
		record("subagents/c", `state=error:title=${msg("explore")}:msg=${msg("failed")}`),
	]);
	h.fire("session_shutdown");
});

for (const source of [JOBS, JOBS_REPLAY]) for (const kind of ["command", "monitor", undefined] as const) {
	test(`S12 ${source} ${kind ?? "legacy"} job titles never use command labels`, () => {
		const h = harness(); h.fire("session_start");
		const title = kind === "monitor" ? "monitor" : "background job";
		const job = { id: "j", label: "run --argument private", startedAt: 1000, ...(kind ? { kind } : {}) };
		h.emit(source, { sessionId: "s1", snapshot: { jobs: [job] } });
		h.emit(source, { sessionId: "s1", snapshot: { jobs: [{ ...job, status: "exited", exitCode: 7 }] } });
		h.emit(source, { sessionId: "s1", snapshot: { jobs: [{ ...job, id: "direct", status: "failed", endedAt: 1000 }] } });
		assert.deepEqual(h.writes, [record("bg/j", `state=working:title=${msg(title)}`),
			record("bg/j", `state=error:title=${msg(title)}:msg=${msg("exited 7")}`),
			record("bg/direct", `state=error:title=${msg(title)}:msg=${msg("failed")}`)]);
		h.fire("session_shutdown");
	});
}

test("S12 labeled jobs retain their explicit title in live and replay records", () => {
	for (const source of [JOBS, JOBS_REPLAY]) {
		const h = harness(); h.fire("session_start");
		const job = { id: "j", label: "Local display", explicitLabel: "Build", kind: "command", startedAt: 1000 };
		h.emit(source, { sessionId: "s1", snapshot: { jobs: [job] } });
		h.emit(source, { sessionId: "s1", snapshot: { jobs: [{ ...job, status: "failed" }] } });
		assert.deepEqual(h.writes, [record("bg/j", `state=working:title=${msg("Build")}`), record("bg/j", `state=error:title=${msg("Build")}:msg=${msg("failed")}`)]);
		h.fire("session_shutdown");
	}
});

test("S15 job errors prefer failed metadata, then matching retained metadata, never local commands", () => {
	for (const source of [JOBS, JOBS_REPLAY]) {
		for (const scenario of ["override", "unwritten", "removed", "monitor", "new-start", "direct"] as const) {
			const h = harness(); h.fire("session_start");
			const prior = { id: "j", label: "private shell command", explicitLabel: "Original", kind: "command", startedAt: 1 };
			const working = record("bg/j", `state=working:title=${msg(scenario === "monitor" ? "monitor" : "Original")}`);
			if (scenario !== "direct") {
				if (scenario === "unwritten" || scenario === "monitor") h.failNextWrites(1);
				h.emit(source, { sessionId: "s1", snapshot: { jobs: [scenario === "monitor" ? { ...prior, explicitLabel: undefined, kind: "monitor" } : prior] } });
			}
			if (scenario === "removed") h.emit(source, { sessionId: "s1", snapshot: { jobs: [] } });
			const failed = { id: "j", label: "private shell command", startedAt: scenario === "new-start" ? 2 : 1, status: "failed", ...(scenario === "override" || scenario === "direct" ? { explicitLabel: "Final" } : {}) };
			h.emit(source, { sessionId: "s1", snapshot: { jobs: [failed] } });
			const title = scenario === "override" || scenario === "direct" ? "Final" : scenario === "new-start" ? "background job" : scenario === "monitor" ? "monitor" : "Original";
			const prefix = scenario === "direct" || scenario === "unwritten" || scenario === "monitor" ? [] : scenario === "removed" ? [working, clear("bg/j")] : [working];
			assert.deepEqual(h.writes, [...prefix, record("bg/j", `state=error:title=${msg(title)}:msg=${msg("failed")}`)], `${source}: ${scenario}`);
			h.fire("session_shutdown");
		}
	}
});

test("S15 task errors prefer failed metadata, then current-session retained metadata, never local prompts", () => {
	for (const scenario of ["override", "unwritten", "removed", "direct", "replacement"] as const) {
		const h = harness(); h.fire("session_start");
		const prior = { id: "t", agent: "explore", label: "private prompt", explicitLabel: "Original", status: "running" };
		const working = record("subagents/t", `state=working:title=${msg("Original")}`);
		if (scenario !== "direct") {
			if (scenario === "unwritten") h.failNextWrites(1);
			h.emit(TASKS, { sessionId: "s1", tasks: [prior] });
		}
		if (scenario === "removed") h.emit(TASKS, { sessionId: "s1", tasks: [] });
		let sessionId = "s1";
		let ctx = h.ctx;
		if (scenario === "replacement") {
			const other = h.context("s2"); sessionId = "s2"; ctx = other.ctx;
			h.failNextWrites(2); h.fire("session_start", {}, ctx);
		}
		const failed = { id: "t", agent: "explore", label: "private prompt", status: "failed", ...(scenario === "override" || scenario === "direct" ? { explicitLabel: "Final" } : {}) };
		h.emit(TASK_FINISHED, { sessionId, task: failed });
		const title = scenario === "override" || scenario === "direct" ? "Final" : scenario === "replacement" ? "explore" : "Original";
		const prefix = scenario === "direct" || scenario === "unwritten" ? [] : scenario === "removed" ? [working, clear("subagents/t")] : [working];
		assert.deepEqual(h.writes, [...prefix, record("subagents/t", `state=error:title=${msg(title)}:msg=${msg("failed")}`)], scenario);
		h.fire("session_shutdown", {}, ctx);
	}
});

test("S4 job errors retain id and title for 60 seconds; success, stopped and unknown exits clear", () => {
	const h = harness(); h.fire("session_start");
	const jobs = ["a", "b", "c", "d", "e"].map(id => ({ id, label: id.toUpperCase(), explicitLabel: id.toUpperCase(), startedAt: 1 }));
	h.emit(JOBS, { sessionId: "foreign", snapshot: { jobs } });
	h.emit(JOBS_REPLAY, { sessionId: "s1", snapshot: { jobs } });
	const working = jobs.map(job => record(`bg/${job.id}`, `state=working:title=${msg(job.label)}`));
	assert.deepEqual(h.writes, working);
	const finished = [
		{ ...jobs[0], status: "exited", exitCode: 7 }, { ...jobs[1], status: "failed" },
		{ ...jobs[2], status: "exited", exitCode: 0 }, { ...jobs[3], status: "stopped" },
		{ ...jobs[4], status: "exited", exitCode: null },
	];
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: finished } });
	const errors = [clear("bg/c"), clear("bg/d"), clear("bg/e"),
		record("bg/a", `state=error:title=${msg("A")}:msg=${msg("exited 7")}`),
		record("bg/b", `state=error:title=${msg("B")}:msg=${msg("failed")}`)];
	assert.deepEqual(h.writes, [...working, ...errors]);
	assert.equal(h.pendingTimers(), 1);
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [] } });
	h.advance(59999); h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: finished } });
	assert.deepEqual(h.writes, [...working, ...errors]);
	h.advance(1);
	assert.deepEqual(h.writes, [...working, ...errors, clear("bg/a"), clear("bg/b")]);
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: finished } });
	assert.deepEqual(h.writes, [...working, ...errors, clear("bg/a"), clear("bg/b")]);
	assert.equal(h.pendingTimers(), 0);
	h.fire("session_shutdown");
});

test("S19 settled edges publish all four failures even when the sidebar retains only three", () => {
	const h = harness(); h.fire("session_start");
	const jobs = [
		{ id: "a", label: "private command a", explicitLabel: "Compile", kind: "command", startedAt: 1000 },
		{ id: "b", label: "private command b", explicitLabel: "Previous", kind: "monitor", startedAt: 1001 },
		{ id: "c", label: "private command c", kind: "monitor", startedAt: 1002 },
		{ id: "d", label: "private command d", kind: "command", startedAt: 1003 },
	];
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs } });
	const working = ["Compile", "Previous", "monitor", "background job"].map((title, i) =>
		record(`bg/${jobs[i]!.id}`, `state=working:title=${msg(title)}`));
	assert.deepEqual(h.writes, working);
	const outcomes = [
		{ id: "a", startedAt: 1000, status: "failed", endedAt: 1000 },
		{ id: "b", startedAt: 1001, status: "exited", endedAt: 1001, exitCode: 2, explicitLabel: "Final build", kind: "monitor" },
		{ id: "c", startedAt: 1002, status: "failed", endedAt: 1002 },
		{ id: "d", startedAt: 1003, status: "exited", endedAt: 1003, exitCode: -3, kind: "command" },
	];
	// The failed rows carry local labels, but only explicit provenance is safe.
	const finished = outcomes.slice(1).map((outcome, index) => ({ ...jobs[index + 1], ...outcome }));
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: finished } });
	const snapshotWrites = [clear("bg/a"),
		record("bg/b", `state=error:title=${msg("Final build")}:msg=${msg("exited 2")}`),
		record("bg/c", `state=error:title=${msg("monitor")}:msg=${msg("failed")}`),
		record("bg/d", `state=error:title=${msg("background job")}:msg=${msg("exited -3")}`)];
	assert.deepEqual(h.writes, [...working, ...snapshotWrites]);
	for (const job of outcomes) h.emit(JOB_SETTLED, { sessionId: "s1", job });
	const missing = record("bg/a", `state=error:title=${msg("Compile")}:msg=${msg("failed")}`);
	assert.deepEqual(h.writes, [...working, ...snapshotWrites, missing]);
	for (const id of ["a", "b", "c", "d"]) assert.equal(h.writes.filter(write => write.includes(`state=error:`) && write.endsWith(`:id=bg/${id}\x1b\\`)).length, 1);
	assert.equal(h.pendingTimers(), 1);
	h.advance(59999); assert.deepEqual(h.writes, [...working, ...snapshotWrites, missing]);
	h.advance(1);
	assert.deepEqual(h.writes.slice(-4), [clear("bg/b"), clear("bg/c"), clear("bg/d"), clear("bg/a")]);
	assert.equal(h.pendingTimers(), 0); h.fire("session_shutdown");
});

test("S19 settled success and stop clear stale running rows, and foreign events do nothing", () => {
	const h = harness(); h.fire("session_start");
	const jobs = ["success", "stopped", "foreign"].map(id => ({ id, label: `private ${id}`, explicitLabel: id, kind: "command", startedAt: 1000 }));
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs } });
	const working = jobs.map(job => record(`bg/${job.id}`, `state=working:title=${msg(job.explicitLabel)}`));
	const outcomes = [
		{ id: "success", kind: "command", startedAt: 1000, status: "exited", endedAt: 1000, exitCode: 0 },
		{ id: "stopped", kind: "command", startedAt: 1000, status: "stopped", endedAt: 1000, exitCode: 9 },
	];
	h.emit(JOB_SETTLED, { sessionId: "other", job: { ...outcomes[0], id: "foreign", exitCode: 9 } });
	assert.deepEqual(h.writes, working); assert.equal(h.pendingTimers(), 0);
	for (const job of outcomes) h.emit(JOB_SETTLED, { sessionId: "s1", job });
	assert.deepEqual(h.writes, [...working, clear("bg/success"), clear("bg/stopped")]);
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [...outcomes.map((outcome, i) => ({ ...jobs[i], ...outcome })), jobs[2]] } });
	for (const job of outcomes) h.emit(JOB_SETTLED, { sessionId: "s1", job });
	assert.deepEqual(h.writes, [...working, clear("bg/success"), clear("bg/stopped")]);
	assert.equal(h.pendingTimers(), 0); h.fire("session_shutdown");
	assert.equal(h.writes.at(-1), clear("bg/foreign"));
});

test("S19 event-first failures dedupe against snapshots and respect the session-start boundary", () => {
	const h = harness(); h.fire("session_start");
	const running = { id: "j", label: "private shell command", explicitLabel: "Original", kind: "command", startedAt: 1000 };
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [running] } });
	const working = record("bg/j", `state=working:title=${msg("Original")}`);
	const edge = { id: "j", explicitLabel: "Override", kind: "command", startedAt: 1000, status: "exited", endedAt: 1000, exitCode: 7 };
	h.emit(JOB_SETTLED, { sessionId: "s1", job: edge });
	const error = record("bg/j", `state=error:title=${msg("Override")}:msg=${msg("exited 7")}`);
	assert.deepEqual(h.writes, [working, error]);
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ ...running, ...edge }] } });
	h.emit(JOB_SETTLED, { sessionId: "s1", job: edge });
	h.emit(JOB_SETTLED, { sessionId: "s1", job: { id: "old", kind: "command", startedAt: 10, status: "failed", endedAt: 999 } });
	assert.deepEqual(h.writes, [working, error]); assert.equal(h.pendingTimers(), 1);
	h.advance(60000);
	assert.deepEqual(h.writes, [working, error, clear("bg/j")]);
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ ...running, ...edge }] } });
	h.emit(JOB_SETTLED, { sessionId: "s1", job: edge });
	assert.deepEqual(h.writes, [working, error, clear("bg/j")]); assert.equal(h.pendingTimers(), 0);
	h.fire("session_shutdown");
});

test("S19 settled titles use explicit or same-identity metadata and never local command labels", () => {
	for (const scenario of [
		{ prior: { explicitLabel: "Retained", kind: "command", startedAt: 1 }, edge: { startedAt: 1 }, title: "Retained" },
		{ prior: { kind: "monitor", startedAt: 1 }, edge: { startedAt: 1 }, title: "monitor" },
		{ prior: undefined, edge: { kind: "monitor", startedAt: 1 }, title: "monitor" },
		{ prior: undefined, edge: { kind: "command", startedAt: 1 }, title: "background job" },
		{ prior: { explicitLabel: "Old", kind: "monitor", startedAt: 1 }, edge: { startedAt: 2 }, title: "background job", remove: true },
		{ prior: { explicitLabel: "Old", kind: "command", startedAt: 1 }, edge: { explicitLabel: "New", startedAt: 1 }, title: "New" },
		{ prior: { explicitLabel: "Retained", kind: "command", startedAt: 1 }, edge: { explicitLabel: "\x00", startedAt: 1 }, title: "Retained" },
	] as const) {
		const h = harness(); h.fire("session_start");
		if (scenario.prior) h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "private shell command", ...scenario.prior }] } });
		if ("remove" in scenario) h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [] } });
		const before = [...h.writes];
		h.emit(JOB_SETTLED, { sessionId: "s1", job: { id: "j", label: "private shell command", status: "failed", endedAt: 1000, ...scenario.edge } });
		assert.deepEqual(h.writes, [...before, record("bg/j", `state=error:title=${msg(scenario.title)}:msg=${msg("failed")}`)]);
		h.fire("session_shutdown");
	}
});

test("S19 malformed settled events cannot change records or timers", () => {
	const h = harness(); h.fire("session_start");
	const job = { id: "j", kind: "command", startedAt: 1000, status: "failed", endedAt: 1000 };
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ ...job, status: undefined, label: "private", explicitLabel: "Running" }] } });
	const before = [...h.writes];
	for (const patch of [{ id: "" }, { startedAt: NaN }, { status: "running" }, { status: undefined },
		{ explicitLabel: 42 }, { endedAt: NaN }, { exitCode: "7" }]) h.emit(JOB_SETTLED, { sessionId: "s1", job: { ...job, ...patch } });
	h.emit(JOB_SETTLED, { sessionId: "s1", job: null });
	assert.deepEqual(h.writes, before); assert.equal(h.pendingTimers(), 0);
	h.fire("session_shutdown");
});

test("S4 subagent failure and timeout override live records without a clear, then expire; cancellation clears", () => {
	const h = harness(); h.fire("session_start");
	const tasks = [
		{ id: "a", agent: "Agent", label: "Label", explicitLabel: "Label", status: "waiting", pendingQuery: true },
		{ id: "b", agent: "Fallback", label: "", status: "running" },
		{ id: "c", agent: "Done", status: "running" }, { id: "d", agent: "Cancel", status: "queued" },
	];
	h.emit(TASKS, { sessionId: "s1", tasks });
	const working = [record("subagents/a", `state=blocked:kind=question:title=${msg("Label")}:msg=${msg("question for parent")}`),
		record("subagents/b", `state=working:title=${msg("Fallback")}`), record("subagents/c", `state=working:title=${msg("Done")}`),
		record("subagents/d", `state=working:title=${msg("Cancel")}`)];
	assert.deepEqual(h.writes, working);
	h.emit(TASK_FINISHED, { sessionId: "foreign", task: { ...tasks[0], status: "failed" } });
	h.emit(TASK_FINISHED, { sessionId: "s1", task: { ...tasks[0], status: "failed" } });
	h.emit(TASK_FINISHED, { sessionId: "s1", task: { ...tasks[1], status: "timed_out" } });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ ...tasks[2], status: "completed" }, { ...tasks[3], status: "cancelled" }] });
	const finished = [record("subagents/a", `state=error:title=${msg("Label")}:msg=${msg("failed")}`),
		record("subagents/b", `state=error:title=${msg("Fallback")}:msg=${msg("timed out")}`), clear("subagents/c"), clear("subagents/d")];
	assert.deepEqual(h.writes, [...working, ...finished]);
	h.advance(59999); assert.deepEqual(h.writes, [...working, ...finished]);
	h.advance(1);
	assert.deepEqual(h.writes, [...working, ...finished, clear("subagents/a"), clear("subagents/b")]);
	assert.equal(h.pendingTimers(), 0); h.fire("session_shutdown");
});

test("S4 error and send timers coexist and shutdown or replacement clears errors once", () => {
	for (const replacement of [false, true]) {
		const h = harness(); h.fire("session_start");
		h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", explicitLabel: "Job", startedAt: 1 }] } });
		h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", explicitLabel: "Job", startedAt: 1, status: "failed" }] } });
		h.emit(SEND, { sessionId: "s1", target: "peer" }); h.advance(5000);
		const expected = [record("bg/j", `state=working:title=${msg("Job")}`), record("bg/j", `state=error:title=${msg("Job")}:msg=${msg("failed")}`),
			record("sent/peer", `state=idle:msg=${msg("sent to peer")}`), clear("sent/peer")];
		assert.deepEqual(h.writes, expected); assert.equal(h.pendingTimers(), 1);
		if (replacement) { const other = h.context("s2"); h.fire("session_start", {}, other.ctx); h.fire("session_shutdown", {}, other.ctx); }
		else h.fire("session_shutdown");
		assert.deepEqual(h.writes, [...expected, clear("bg/j")]); assert.equal(h.pendingTimers(), 0);
		h.advance(60000); assert.deepEqual(h.writes, [...expected, clear("bg/j")]);
	}
});

test("S4 replacement does not revive a failure from an earlier session's finished-job tail", () => {
	const h = harness(); h.fire("session_start");
	const running = { id: "j", label: "Job", explicitLabel: "Job", startedAt: 1 };
	const finished = { ...running, status: "failed", endedAt: 1000 };
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [running] } });
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [finished] } });
	const expected = [record("bg/j", `state=working:title=${msg("Job")}`), record("bg/j", `state=error:title=${msg("Job")}:msg=${msg("failed")}`)];
	assert.deepEqual(h.writes, expected);
	h.advance(1);
	const replacement = h.context("s1"); h.fire("session_start", {}, replacement.ctx);
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [finished] } });
	assert.deepEqual(h.writes, [...expected, clear("bg/j")]);
	assert.equal(h.pendingTimers(), 0); h.fire("session_shutdown", {}, replacement.ctx);
});

test("S3 long subagent identifiers hash into the 64-byte id limit", () => {
	const h = harness(); h.fire("session_start");
	const id = "a".repeat(55), safe = `h-${createHash("sha256").update(id).digest("hex").slice(0, 52)}`;
	h.emit(TASKS, { sessionId: "s1", tasks: [{ id, agent: "A", status: "running" }] });
	assert.deepEqual(h.writes, [record(`subagents/${safe}`, `state=working:title=${msg("A")}`)]);
	h.fire("session_shutdown");
	assert.deepEqual(h.writes, [record(`subagents/${safe}`, `state=working:title=${msg("A")}`), clear(`subagents/${safe}`)]);
});

test("S6 task labels, waiting and pending queries project, malformed and foreign snapshots do not erase", () => {
	const h = harness(); h.fire("session_start");
	assert.deepEqual(h.events.filter(e => e.name === TASKS_REQUEST).map(e => e.data), [{ sessionId: "s1" }]);
	const tasks = [{ id: "t1", agent: "Agent", label: "Label", explicitLabel: "Label", status: "queued", pendingQuery: false }];
	h.emit(TASKS, { sessionId: "s1", tasks });
	h.emit(TASKS, { sessionId: "foreign", tasks: [] });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ ...tasks[0], pendingQuery: "yes" }] });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ ...tasks[0], status: "running", pendingQuery: true }] });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ ...tasks[0], status: "waiting" }] });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ ...tasks[0], status: "running", label: "", explicitLabel: "", pendingQuery: false }] });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ ...tasks[0], status: "completed" }] });
	assert.deepEqual(h.writes, [record("subagents/t1", "state=working:title=TGFiZWw="),
		record("subagents/t1", `state=blocked:kind=question:title=TGFiZWw=:msg=${msg("question for parent")}`),
		record("subagents/t1", `state=blocked:kind=question:title=TGFiZWw=:msg=${msg("waiting for user")}`),
		record("subagents/t1", "state=working:title=QWdlbnQ="), clear("subagents/t1")]);
	h.fire("session_shutdown");
});

test("S14 incoming peer records retain each unanswered message, sanitize IDs and clear only handled peers", () => {
	const h = harness(); h.fire("session_start");
	const inbound = (peer: string, id: string, phase: string, peerName?: string, sessionId = "s1") =>
		h.emit(INBOUND, { sessionId, peer, id, phase, ...(peerName === undefined ? {} : { peerName }) });
	inbound("peer", "one", "received", "Alice");
	assert.deepEqual(h.writes, [record("ask/peer", `state=blocked:kind=question:title=${msg("Alice")}:msg=${msg("question from Alice")}`)]);
	inbound("peer", "two", "received", "Alice");
	inbound("peer", "one", "handled");
	assert.equal(h.writes.length, 1, "an older handled message must not clear a newer one");
	inbound("a/b", "one", "received");
	assert.match(h.writes[1], /^\x1b\]7501;state=blocked:kind=question:title=YS9i:msg=cXVlc3Rpb24gZnJvbSBhL2I=:id=ask\/h-[a-f0-9]{56}\x1b\\$/);
	inbound("a_b", "one", "received");
	assert.equal(h.writes[2], record("ask/a_b", `state=blocked:kind=question:title=${msg("a_b")}:msg=${msg("question from a_b")}`));
	inbound("peer", "two", "handled", undefined, "foreign");
	inbound("other", "two", "handled");
	assert.equal(h.writes.length, 3);
	inbound("peer", "two", "handled");
	assert.equal(h.writes.at(-1), clear("ask/peer"));
	inbound("a_b", "one", "handled");
	assert.equal(h.writes.at(-1), clear("ask/a_b"));
	h.fire("session_shutdown");
	assert.match(h.writes.at(-1)!, /^\x1b\]7501;state=clear:id=ask\/h-[a-f0-9]{56}\x1b\\$/);
});

test("S14 incoming peer events reject malformed data and clear on session replacement", () => {
	const h = harness(); h.fire("session_start");
	const base = { sessionId: "s1", peer: "peer", id: "one", phase: "received" };
	for (const patch of [{ peer: "" }, { peer: 1 }, { id: "" }, { id: null }, { phase: "other" }, { peerName: 42 }, { sessionId: "foreign" }]) h.emit(INBOUND, { ...base, ...patch });
	assert.deepEqual(h.writes, []);
	h.emit(INBOUND, base);
	assert.equal(h.writes[0], record("ask/peer", `state=blocked:kind=question:title=${msg("peer")}:msg=${msg("question from peer")}`));
	const other = h.context("s2"); h.fire("session_start", {}, other.ctx);
	assert.equal(h.writes.at(-1), clear("ask/peer"));
	h.emit(INBOUND, base); h.emit(INBOUND, { ...base, sessionId: "s2", phase: "handled" });
	assert.equal(h.writes.length, 2);
	h.fire("session_shutdown", {}, other.ctx);
});

test("S7 concurrent consults remain working until the final success or failure settlement", () => {
	const h = harness(); h.fire("session_start");
	h.emit(CONSULT, { sessionId: "s1", target: "peer", callId: "a", phase: "start" });
	h.emit(CONSULT, { sessionId: "s1", target: "peer", callId: "b", phase: "start" });
	h.emit(CONSULT, { sessionId: "s1", target: "peer", callId: "a", phase: "settle" });
	assert.deepEqual(h.writes, [record("wait/peer", "state=working:msg=Y29uc3VsdGluZyBwZWVy")]);
	h.emit(CONSULT, { sessionId: "s1", target: "peer", callId: "b", phase: "settle" });
	assert.deepEqual(h.writes, [record("wait/peer", "state=working:msg=Y29uc3VsdGluZyBwZWVy"), clear("wait/peer")]);
	h.fire("session_shutdown");
});

test("S8 accepted sends expire independently, refresh their TTL and cancel timers on shutdown", () => {
	const h = harness(); h.fire("session_start");
	h.emit(SEND, { sessionId: "s1", target: "peer" }); h.advance(1000);
	h.emit(SEND, { sessionId: "s1", target: "other" }); h.advance(2000);
	h.emit(SEND, { sessionId: "s1", target: "peer" }); h.advance(3000);
	assert.deepEqual(h.writes, [record("sent/peer", "state=idle:msg=c2VudCB0byBwZWVy"), record("sent/other", "state=idle:msg=c2VudCB0byBvdGhlcg=="), clear("sent/other")]);
	h.advance(1999); assert.equal(h.writes.length, 3); h.advance(1);
	assert.equal(h.writes.at(-1), clear("sent/peer")); assert.equal(h.pendingTimers(), 0);
	h.emit(SEND, { sessionId: "s1", target: "peer" }); assert.equal(h.pendingTimers(), 1);
	h.fire("session_shutdown"); assert.equal(h.writes.at(-1), clear("sent/peer")); assert.equal(h.pendingTimers(), 0);
	const count = h.writes.length; h.advance(6000); assert.equal(h.writes.length, count);
});

test("dynamic IDs cannot create hierarchy or alias distinct targets, while messages retain the original target", () => {
	const h = harness(); h.fire("session_start");
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "a/b", label: "Job", startedAt: 1 }] } });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ id: "a/b", agent: "A", status: "running" }] });
	h.emit(CONSULT, { sessionId: "s1", target: "a/b", callId: "a", phase: "start" });
	h.emit(CONSULT, { sessionId: "s1", target: "a_b", callId: "b", phase: "start" });
	h.emit(SEND, { sessionId: "s1", target: "a/b" });
	assert.equal(h.writes.length, 5);
	for (const write of h.writes) assert.match(write, /:id=(?:bg|subagents|wait|sent)\/[A-Za-z0-9_.-]+\x1b\\$/);
	assert.ok(h.writes[2].includes(`:msg=${msg("consulting a/b")}:`));
	assert.ok(h.writes[4].includes(`:msg=${msg("sent to a/b")}:`));
	assert.notEqual(h.writes[2].split(":id=")[1], h.writes[3].split(":id=")[1]);
	h.fire("session_shutdown");
});

test("malformed events are ignored without changing published state or timers", () => {
	const h = harness(); h.fire("session_start");
	h.emit(SEND, { sessionId: "s1", target: "peer" });
	h.emit(CONSULT, { sessionId: "s1", target: "peer", callId: "one", phase: "start" });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ id: "t", agent: "Agent", status: "running" }] });
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", startedAt: 1 }] } });
	const before = [...h.writes]; const pending = h.pendingTimers();
	for (const [name, data] of [[SEND, null], [SEND, { sessionId: "s1", target: 42 }], [SEND, { sessionId: "foreign", target: "peer" }],
		[CONSULT, { sessionId: "s1", target: "peer", callId: "one", phase: "invalid" }],
		[CONSULT, { sessionId: "s1", target: "other", callId: "one", phase: "settle" }],
		[TASKS, { sessionId: "s1", tasks: [null] }], [TASKS, { sessionId: "s1", tasks: Array(1) }],
		[JOBS, { sessionId: "s1", snapshot: null }], [JOBS, { sessionId: "s1", snapshot: { jobs: Array(1) } }]]) h.emit(name as string, data);
	assert.deepEqual(h.writes, before); assert.equal(h.pendingTimers(), pending);
	h.fire("session_shutdown");
});

test("replacement clears every published record and ignores stale events and shutdown", () => {
	const h = harness(); h.branch([todoEntry([task(1, "Work", "in_progress")])]); h.fire("session_start");
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", startedAt: 1 }] } });
	h.emit(TASKS, { sessionId: "s1", tasks: [{ id: "t", agent: "Agent", status: "running" }] });
	h.emit(CONSULT, { sessionId: "s1", target: "peer", callId: "one", phase: "start" });
	h.emit(SEND, { sessionId: "s1", target: "peer" });
	const other = h.context("s2"); h.fire("session_start", {}, other.ctx);
	assert.deepEqual(h.writes.slice(-5), [clear("todo"), clear("bg/j"), clear("subagents/t"), clear("wait/peer"), clear("sent/peer")]);
	h.emit(TODO, { sessionId: "s1", done: 0, total: 1, current: "old" });
	h.emit(TODO, { sessionId: "s2", done: 0, total: 1, current: "new" });
	h.fire("session_shutdown", {}, h.ctx); assert.equal(h.writes.at(-1), record("todo", "state=working:progress=0:title=bmV3"));
	h.fire("session_shutdown", {}, other.ctx); assert.equal(h.writes.at(-1), clear("todo"));
	assert.equal(h.pendingTimers(), 0);
});

test("S9 retries an expiry clear that failed once until the terminal accepts it", () => {
	const h = harness(); h.fire("session_start");
	h.emit(SEND, { sessionId: "s1", target: "peer" });
	assert.deepEqual(h.writes, [record("sent/peer", `state=idle:msg=${msg("sent to peer")}`)]);
	h.failNextWrites(1); h.advance(5000);
	assert.equal(h.writes.length, 1);
	assert.equal(h.pendingTimers(), 1);
	h.advance(1000);
	assert.deepEqual(h.writes, [record("sent/peer", `state=idle:msg=${msg("sent to peer")}`), clear("sent/peer")]);
	assert.equal(h.pendingTimers(), 0);
});

test("S9 hands clears that failed during replacement to the next session without removing its own records", () => {
	const h = harness(); h.branch([todoEntry([task(1, "Work", "in_progress")])]); h.fire("session_start");
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", explicitLabel: "Job", startedAt: 1 }] } });
	const published = [record("todo", "state=working:progress=0:title=V29yaw=="), record("bg/j", "state=working:title=Sm9i")];
	assert.deepEqual(h.writes, published);
	const other = h.context("s2"); other.branch([todoEntry([task(1, "Next", "in_progress")])]);
	h.failNextWrites(1); h.fire("session_start", {}, other.ctx);
	assert.deepEqual(h.writes, [...published, clear("bg/j"), record("todo", `state=working:progress=0:title=${msg("Next")}`)]);
	h.fire("session_shutdown", {}, other.ctx);
	assert.equal(h.writes.at(-1), clear("todo"));
	const third = h.context("s3"); h.fire("session_start", {}, third.ctx);
	assert.equal(h.writes.at(-1), clear("todo"));
	assert.equal(h.writes.filter(write => write === clear("bg/j")).length, 1);
});


test("S9 retries a failed write after WRITE_RETRY_MS even while a longer TTL timer is armed", () => {
	const h = harness(); h.fire("session_start");
	h.emit(JOBS, { sessionId: "s1", snapshot: { jobs: [{ id: "j", label: "Job", startedAt: 1, status: "failed", endedAt: 2000 }] } });
	const n = h.writes.length;
	h.failNextWrites(1); h.emit(TODO, { sessionId: "s1", done: 0, total: 2, current: "X" });
	assert.equal(h.writes.length, n);
	h.advance(1000);
	assert.deepEqual(h.writes.slice(n), [record("todo", `state=working:progress=0:title=${msg("X")}`)]);
	assert.equal(h.pendingTimers(), 1);
});
