import assert from "node:assert/strict";
import test from "node:test";
import { TASK_EVENT, TASK_STATUS, TaskStore, type TaskRecord, type TaskStatus } from "../lib/agents-protocol.ts";
import {
	ACTIVITY_SCHEMA,
	ACTIVITY_WIDGET_KEY,
	createRpcActivityPublisher,
	encodeActivityLines,
	projectRpcActivity,
	type RpcActivity,
	type RpcTask,
} from "../lib/agents-rpc-publisher.ts";

// gentle-agents RPC publisher: a pure projection of TaskStore state into the
// bounded JSON payload an interactive RPC host receives through setWidget,
// plus the store-driven, coalesced publisher that pushes it.

function task(id: string, parentSessionId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id,
		agent: "worker",
		mode: "task",
		prompt: "p",
		label: "p",
		cwd: "/r",
		parentSessionId,
		status: TASK_STATUS.RUNNING,
		createdAt: 1000,
		startedAt: 1000,
		endedAt: null,
		model: "gpt",
		thinking: undefined,
		sessionPath: "/sessions/child.jsonl",
		error: null,
		result: null,
		lastStep: "working",
		lastActivityAt: 1000,
		turns: 0,
		toolCalls: 0,
		tokens: 0,
		cost: 0,
		...overrides,
	};
}

/** Build one already-projected `RpcTask` fixture directly, bypassing `projectRpcActivity`, so `encodeActivityLines` shrink-stage tests control exact sizes. */
function rpcTask(id: string, status: TaskStatus, endedAt: number | null, opts: { items?: number; itemTextLen?: number; labelLen?: number } = {}): RpcTask {
	const { items = 1, itemTextLen = 20, labelLen = 4 } = opts;
	return {
		summary: {
			id,
			agent: "a",
			label: "l".repeat(labelLen),
			prompt: "p",
			status,
			createdAt: 1,
			startedAt: 1,
			endedAt,
			lastStep: "s",
			lastActivityAt: 1,
			turns: 0,
			toolCalls: 0,
			error: null,
		},
		thread: {
			version: 1,
			dropped: 0,
			items: Array.from({ length: items }, (_v, index) => ({ kind: "note" as const, text: `${"n".repeat(itemTextLen)}${index}` })),
		},
	};
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

test("projectRpcActivity whitelists task fields and orders running, waiting, queued, then finished by endedAt desc", () => {
	const store = new TaskStore();
	store.add(task("running-1", "s1", { status: TASK_STATUS.RUNNING, agent: "explore", label: "Explore X", prompt: "short prompt", turns: 2, toolCalls: 1, createdAt: 1, lastActivityAt: 5 }));
	store.add(task("waiting-1", "s1", { status: TASK_STATUS.WAITING, createdAt: 2, lastActivityAt: 6 }));
	store.add(task("queued-1", "s1", { status: TASK_STATUS.QUEUED, createdAt: 3, startedAt: null, lastActivityAt: 3 }));
	store.add(task("finished-old", "s1", { status: TASK_STATUS.COMPLETED, createdAt: 4, endedAt: 100, lastActivityAt: 100 }));
	store.add(task("finished-new", "s1", { status: TASK_STATUS.FAILED, createdAt: 5, endedAt: 200, lastActivityAt: 200, error: "boom" }));

	const activity = projectRpcActivity(store);

	assert.equal(activity.schema, ACTIVITY_SCHEMA);
	assert.deepEqual(activity.summary, store.summary());
	assert.deepEqual(activity.tasks.map((entry) => entry.summary.id), ["running-1", "waiting-1", "queued-1", "finished-new", "finished-old"]);

	const runningSummary = activity.tasks[0]!.summary;
	assert.deepEqual(
		Object.keys(runningSummary).sort(),
		["id", "agent", "label", "prompt", "status", "createdAt", "startedAt", "endedAt", "lastStep", "lastActivityAt", "turns", "toolCalls", "error"].sort(),
		"only the whitelisted fields are projected: cwd, parentSessionId, mode, model, thinking, sessionPath, result, tokens, and cost never leak",
	);
	assert.equal(runningSummary.agent, "explore");
	assert.equal(runningSummary.label, "Explore X");
	assert.equal(runningSummary.prompt, "short prompt");
	assert.equal(activity.tasks[4]!.summary.error, null);
	assert.equal(activity.tasks[3]!.summary.error, "boom");
});

test("projectRpcActivity truncates the prompt, tool args, and tool output to their bounds", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1", { prompt: "x".repeat(250) }));
	store.apply("t1", { type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: { note: "y".repeat(600) } }, 1);
	store.apply("t1", { type: TASK_EVENT.TOOL_END, callId: "c1", output: "z".repeat(600), isError: false }, 2);

	const activity = projectRpcActivity(store);
	const summary = activity.tasks[0]!.summary;
	assert.equal(summary.prompt.length, 200);
	assert.ok(summary.prompt.endsWith("…"));

	const toolItem = activity.tasks[0]!.thread.items.at(-1) as { kind: string; name: string; args: string; running: boolean; isError: boolean; output: string };
	assert.equal(toolItem.kind, "tool");
	assert.equal(toolItem.name, "bash");
	assert.equal(toolItem.running, false);
	assert.equal(toolItem.isError, false);
	assert.ok(toolItem.args.length <= 500 && toolItem.args.endsWith("…"));
	assert.ok(toolItem.output.length <= 500 && toolItem.output.endsWith("…"));
	assert.match(toolItem.args, /^\{"note":"y+…$/);
});

test("projectRpcActivity keeps only the last N thread items per task (default 40)", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	for (let index = 0; index < 50; index += 1) store.apply("t1", { type: TASK_EVENT.NOTE, text: `note-${index}` }, index);

	const activity = projectRpcActivity(store);
	const items = activity.tasks[0]!.thread.items as { text: string }[];
	assert.equal(items.length, 40);
	assert.equal(items[0]!.text, "note-10");
	assert.equal(items.at(-1)!.text, "note-49");
});

test("projectRpcActivity truncates text, thinking, and note item text to 2000 characters", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "a".repeat(3000) }, 1);
	store.apply("t1", { type: TASK_EVENT.THINKING, text: "b".repeat(3000) }, 2);
	store.apply("t1", { type: TASK_EVENT.NOTE, text: "c".repeat(3000) }, 3);

	const activity = projectRpcActivity(store);
	const items = activity.tasks[0]!.thread.items as { kind: string; text: string }[];

	assert.equal(items.length, 3);
	for (const item of items) {
		assert.ok(item.text.length <= 2000, `${item.kind} item must be bounded to 2000 characters`);
		assert.ok(item.text.endsWith("…"), `${item.kind} item must carry the truncation marker`);
	}
});

test("projectRpcActivity truncates a synthetic 1 MiB text item to 2000 characters", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "x".repeat(1024 * 1024) }, 1);

	const activity = projectRpcActivity(store);
	const item = activity.tasks[0]!.thread.items[0] as { text: string };

	assert.equal(item.text.length, 2000);
	assert.ok(item.text.endsWith("…"));
});

test("projectRpcActivity truncates the summary error, label, and lastStep fields to 500 characters", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1", { label: "l".repeat(600) }));
	store.apply("t1", { type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: "e".repeat(600) }, 1);

	const activity = projectRpcActivity(store);
	const summary = activity.tasks[0]!.summary;

	assert.ok(summary.label.length <= 500 && summary.label.endsWith("…"));
	assert.ok(summary.lastStep.length <= 500 && summary.lastStep.endsWith("…"));
	assert.ok(summary.error !== null && summary.error.length <= 500 && summary.error.endsWith("…"));
});

test("projectRpcActivity honors a custom maxThreadItems override", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	for (let index = 0; index < 5; index += 1) store.apply("t1", { type: TASK_EVENT.NOTE, text: `n${index}` }, index);

	const activity = projectRpcActivity(store, { maxThreadItems: 2 });
	assert.deepEqual((activity.tasks[0]!.thread.items as { text: string }[]).map((item) => item.text), ["n3", "n4"]);
});

// Regression for the desktop app's Helpers tab showing helpers from every
// session: `TaskStore` restores finished tasks of every session from disk at
// startup, so an RPC push scoped to `opts.parentSessionId` must project only
// the current session's tasks, and its `summary` counts must match.
test("projectRpcActivity with parentSessionId keeps only that session's tasks and computes the summary from them", () => {
	const store = new TaskStore();
	store.add(task("mine-running", "s1", { status: TASK_STATUS.RUNNING }));
	store.add(task("mine-finished", "s1", { status: TASK_STATUS.COMPLETED, endedAt: 100 }));
	store.add(task("other-running", "s2", { status: TASK_STATUS.RUNNING }));
	store.add(task("other-finished", "s2", { status: TASK_STATUS.COMPLETED, endedAt: 200 }));

	const activity = projectRpcActivity(store, { parentSessionId: "s1" });

	assert.deepEqual(
		activity.tasks.map((entry) => entry.summary.id).sort(),
		["mine-finished", "mine-running"],
		"only the requested session's tasks are projected",
	);
	assert.deepEqual(activity.summary, store.summary("s1"), "summary counts are scoped to the same session filter, not the whole store");
	assert.notDeepEqual(activity.summary, store.summary(), "an unfiltered summary would have counted the other session's tasks too");
});

// Tasks restored on demand (e.g. opening an older task from another session
// in the overlay) can land in the shared store without ever being live in
// the current session; the RPC projection must still exclude them by id.
test("projectRpcActivity with parentSessionId excludes a task from another session even when it is the only one in the store", () => {
	const store = new TaskStore();
	store.add(task("not-mine", "other-session"));

	const activity = projectRpcActivity(store, { parentSessionId: "current-session" });

	assert.deepEqual(activity.tasks, []);
	assert.deepEqual(activity.summary, { running: 0, queued: 0, waiting: 0, finished: 0 });
});

test("encodeActivityLines returns the activity untouched as a single line when it already fits", () => {
	const activity: RpcActivity = { schema: ACTIVITY_SCHEMA, summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] };

	const lines = encodeActivityLines(activity);

	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]!), activity);
});

test("encodeActivityLines halves thread items per task when only halving can help", () => {
	const activity: RpcActivity = {
		schema: ACTIVITY_SCHEMA,
		summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
		tasks: [rpcTask("r1", TASK_STATUS.RUNNING, null, { items: 16, itemTextLen: 50 })],
	};
	const maxBytes = Math.floor(byteLength(JSON.stringify(activity)) / 2);

	const [line] = encodeActivityLines(activity, maxBytes);
	const shrunk = JSON.parse(line!) as RpcActivity;

	assert.equal(shrunk.tasks.length, 1);
	assert.ok(shrunk.tasks[0]!.thread.items.length < 16, "items must have been halved down");
	assert.ok(shrunk.tasks[0]!.thread.items.length >= 1, "halving never removes the last item on a running task");
});

test("encodeActivityLines drops a finished task's thread items before dropping the task itself", () => {
	const activity: RpcActivity = {
		schema: ACTIVITY_SCHEMA,
		summary: { running: 1, queued: 0, waiting: 0, finished: 1 },
		tasks: [rpcTask("r1", TASK_STATUS.RUNNING, null, { items: 1, itemTextLen: 10 }), rpcTask("f1", TASK_STATUS.COMPLETED, 100, { items: 1, itemTextLen: 5000 })],
	};
	const full = byteLength(JSON.stringify(activity));
	const maxBytes = full - 4000; // enough slack that only emptying f1's thread is needed

	const [line] = encodeActivityLines(activity, maxBytes);
	const shrunk = JSON.parse(line!) as RpcActivity;

	const finishedTask = shrunk.tasks.find((entry) => entry.summary.id === "f1")!;
	assert.deepEqual(finishedTask.thread.items, [], "the finished task's thread is emptied, not the task itself");
	assert.ok(shrunk.tasks.some((entry) => entry.summary.id === "r1"), "the running task is untouched");
});

test("encodeActivityLines drops whole finished tasks, oldest first, once emptying threads is not enough", () => {
	const activity: RpcActivity = {
		schema: ACTIVITY_SCHEMA,
		summary: { running: 1, queued: 0, waiting: 0, finished: 2 },
		tasks: [
			rpcTask("r1", TASK_STATUS.RUNNING, null, { items: 1, itemTextLen: 10 }),
			rpcTask("f-new", TASK_STATUS.COMPLETED, 200, { items: 1, itemTextLen: 10, labelLen: 3000 }),
			rpcTask("f-old", TASK_STATUS.COMPLETED, 100, { items: 1, itemTextLen: 10, labelLen: 3000 }),
		],
	};
	const emptiedThreads: RpcActivity = { ...activity, tasks: activity.tasks.map((entry) => (entry.summary.status === TASK_STATUS.COMPLETED ? { ...entry, thread: { ...entry.thread, items: [] } } : entry)) };
	const maxBytes = byteLength(JSON.stringify(emptiedThreads)) - 1000; // still too big with both finished threads emptied

	const [line] = encodeActivityLines(activity, maxBytes);
	const shrunk = JSON.parse(line!) as RpcActivity;

	assert.ok(!shrunk.tasks.some((entry) => entry.summary.id === "f-old"), "the oldest finished task must be dropped first");
	assert.ok(shrunk.tasks.some((entry) => entry.summary.id === "f-new"), "the more recently finished task survives longer");
	assert.ok(shrunk.tasks.some((entry) => entry.summary.id === "r1"), "the running task must never be dropped");
});

test("encodeActivityLines empties every remaining active task's thread as a last resort, emitting a summary-only payload", () => {
	const activity: RpcActivity = {
		schema: ACTIVITY_SCHEMA,
		summary: { running: 2, queued: 0, waiting: 0, finished: 0 },
		tasks: [
			rpcTask("r1", TASK_STATUS.RUNNING, null, { items: 1, itemTextLen: 2000 }),
			rpcTask("r2", TASK_STATUS.RUNNING, null, { items: 1, itemTextLen: 2000 }),
		],
	};
	// No finished tasks to drop, and both running tasks are already down to
	// one item each; only emptying every thread can still shrink this.
	const maxBytes = byteLength(JSON.stringify(activity)) - 1000;

	const [line] = encodeActivityLines(activity, maxBytes);
	const shrunk = JSON.parse(line!) as RpcActivity;

	assert.equal(shrunk.tasks.length, 2, "no active task's summary is ever dropped");
	for (const entry of shrunk.tasks) assert.deepEqual(entry.thread.items, [], "every task's thread is emptied, summary-only");
});

test("encodeActivityLines never throws even when nothing left can be dropped to fit", () => {
	const activity: RpcActivity = {
		schema: ACTIVITY_SCHEMA,
		summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
		tasks: [rpcTask("r1", TASK_STATUS.RUNNING, null, { items: 3, itemTextLen: 50 })],
	};

	const lines = encodeActivityLines(activity, 1);

	assert.equal(lines.length, 1);
	assert.doesNotThrow(() => JSON.parse(lines[0]!));
});

function fakeScheduler() {
	const pending: Array<{ id: number; fn: () => void }> = [];
	let nextId = 0;
	return {
		schedule: (fn: () => void, _ms: number) => {
			const id = nextId++;
			pending.push({ id, fn });
			return () => {
				const index = pending.findIndex((entry) => entry.id === id);
				if (index !== -1) pending.splice(index, 1);
			};
		},
		pendingCount: () => pending.length,
		flushAll: () => {
			const due = pending.splice(0, pending.length);
			for (const entry of due) entry.fn();
		},
	};
}

test("createRpcActivityPublisher coalesces multiple task changes into one flush per window", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	const scheduler = fakeScheduler();
	const calls: string[][] = [];
	const publisher = createRpcActivityPublisher({ store, ui: { setWidget: (key, lines) => { assert.equal(key, ACTIVITY_WIDGET_KEY); calls.push(lines); } }, schedule: scheduler.schedule });

	publisher.start();
	assert.equal(scheduler.pendingCount(), 1, "start schedules exactly one coalescing flush");
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "hello" }, 1);
	store.apply("t1", { type: TASK_EVENT.TEXT, text: " world" }, 2);
	assert.equal(scheduler.pendingCount(), 1, "further changes inside the coalescing window do not add timers");
	assert.equal(calls.length, 0, "nothing is published before the coalescing timer fires");

	scheduler.flushAll();

	assert.equal(calls.length, 1);
	const activity = JSON.parse(calls[0]![0]!) as RpcActivity;
	assert.equal(activity.schema, ACTIVITY_SCHEMA);
	assert.equal(activity.tasks[0]!.summary.id, "t1");
});

test("createRpcActivityPublisher tracks a task created after start through the summary subscription", () => {
	const store = new TaskStore();
	const scheduler = fakeScheduler();
	const calls: string[][] = [];
	const publisher = createRpcActivityPublisher({ store, ui: { setWidget: (_key, lines) => calls.push(lines) }, schedule: scheduler.schedule });

	publisher.start();
	scheduler.flushAll();
	calls.length = 0;

	store.add(task("late-task", "s1"));
	assert.equal(scheduler.pendingCount(), 1, "adding a task schedules a coalesced flush");
	scheduler.flushAll();
	calls.length = 0;

	store.apply("late-task", { type: TASK_EVENT.TEXT, text: "streamed" }, 1);
	assert.equal(scheduler.pendingCount(), 1, "the new task's own thread changes must also be tracked");
	scheduler.flushAll();

	const activity = JSON.parse(calls[0]![0]!) as RpcActivity;
	assert.deepEqual((activity.tasks[0]!.thread.items as { text: string }[]).map((item) => item.text), ["streamed"]);
});

test("createRpcActivityPublisher stop unsubscribes everything and publishes exactly one final frame", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	const scheduler = fakeScheduler();
	const calls: string[][] = [];
	const publisher = createRpcActivityPublisher({ store, ui: { setWidget: (_key, lines) => calls.push(lines) }, schedule: scheduler.schedule });
	publisher.start();
	scheduler.flushAll();
	calls.length = 0;

	publisher.stop();

	assert.equal(calls.length, 1, "stop publishes exactly one final frame");
	assert.equal(scheduler.pendingCount(), 0, "stop cancels any pending coalescing timer");

	store.apply("t1", { type: TASK_EVENT.TEXT, text: "after stop" }, 10);
	assert.equal(scheduler.pendingCount(), 0, "task subscriptions are torn down by stop");
	assert.equal(calls.length, 1, "no further frame is published after stop");
});

// `parentSessionId` is a value captured at construction, not a live getter.
// Honoring a mid-process session switch (a resumed/new/forked session) is
// the caller's job: stop the old publisher and construct a new one scoped
// to the new session id, exactly as `extensions/gentle-agents.ts` does on
// every `session_start`. This locks in that only the newly scoped publisher
// ever sees the other session's tasks.
test("createRpcActivityPublisher recreated with a new parentSessionId after a session switch publishes only the new session's tasks", () => {
	const store = new TaskStore();
	store.add(task("session-a-task", "session-a"));
	const scheduler = fakeScheduler();
	const calls: string[][] = [];
	const ui = { setWidget: (_key: string, lines: string[]) => calls.push(lines) };

	const first = createRpcActivityPublisher({ store, ui, schedule: scheduler.schedule, parentSessionId: "session-a" });
	first.start();
	scheduler.flushAll();
	const firstActivity = JSON.parse(calls.at(-1)![0]!) as RpcActivity;
	assert.deepEqual(firstActivity.tasks.map((entry) => entry.summary.id), ["session-a-task"]);

	first.stop();
	calls.length = 0;
	store.add(task("session-b-task", "session-b"));

	const second = createRpcActivityPublisher({ store, ui, schedule: scheduler.schedule, parentSessionId: "session-b" });
	second.start();
	scheduler.flushAll();

	const secondActivity = JSON.parse(calls.at(-1)![0]!) as RpcActivity;
	assert.deepEqual(secondActivity.tasks.map((entry) => entry.summary.id), ["session-b-task"], "the publisher scoped to the new session must never carry the old session's task");
});

test("createRpcActivityPublisher flush publishes immediately and cancels a pending coalescing timer", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	const scheduler = fakeScheduler();
	const calls: string[][] = [];
	const publisher = createRpcActivityPublisher({ store, ui: { setWidget: (_key, lines) => calls.push(lines) }, schedule: scheduler.schedule });
	publisher.start();
	scheduler.flushAll();
	calls.length = 0;

	store.apply("t1", { type: TASK_EVENT.TEXT, text: "pending" }, 1);
	assert.equal(scheduler.pendingCount(), 1);

	publisher.flush();

	assert.equal(calls.length, 1);
	assert.equal(scheduler.pendingCount(), 0, "flush cancels the timer it preempted");
});

test("createRpcActivityPublisher swallows setWidget errors through an injectable onError", () => {
	const store = new TaskStore();
	store.add(task("t1", "s1"));
	const scheduler = fakeScheduler();
	const errors: unknown[] = [];
	const publisher = createRpcActivityPublisher({
		store,
		ui: { setWidget: () => { throw new Error("boom"); } },
		schedule: scheduler.schedule,
		onError: (error) => errors.push(error),
	});

	assert.doesNotThrow(() => {
		publisher.start();
		scheduler.flushAll();
	});
	assert.equal(errors.length, 1);
	assert.match(String((errors[0] as Error).message), /boom/);
	assert.doesNotThrow(() => publisher.stop());
});
