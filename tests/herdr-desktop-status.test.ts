import assert from "node:assert/strict";
import test from "node:test";
import { activeTodoTitle } from "../lib/herdr-activity.ts";
import {
	SEND_TTL_MS, diffRecords, encodeClear, encodeRecord, projectAll, projectJobs,
	projectSends, projectSubagents, projectTodo, projectWaits, type DesktopRecord,
} from "../lib/herdr-desktop-status.ts";

const empty = new Map<string, DesktopRecord>();
const records = (...items: Array<[string, DesktopRecord]>) => new Map<string, DesktopRecord>(items);

test("OSC records use the fixed state, kind, progress, title, msg, id order", () => {
	assert.equal(encodeRecord("sub/t1", { state: "blocked", kind: "permission", progress: 51, title: "Hi", msg: "ok" }),
		"\x1b]7501;state=blocked:kind=permission:progress=51:title=SGk=:msg=b2s=:id=sub/t1\x1b\\");
	assert.equal(encodeRecord("todo", { state: "working", kind: "question", progress: 0, title: "Hi" }),
		"\x1b]7501;state=working:progress=0:title=SGk=:id=todo\x1b\\");
	for (const state of ["idle", "working", "done", "error"]) {
		assert.equal(encodeRecord("a", { state, kind: "auth" }), `\x1b]7501;state=${state}:id=a\x1b\\`);
	}
	for (const kind of ["permission", "question", "auth"]) {
		assert.equal(encodeRecord("a", { state: "blocked", kind }), `\x1b]7501;state=blocked:kind=${kind}:id=a\x1b\\`);
	}
	assert.equal(encodeRecord("a", { state: "blocked", kind: "bad" }), "\x1b]7501;state=blocked:id=a\x1b\\");
	assert.equal(encodeClear("sub/t1"), "\x1b]7501;state=clear:id=sub/t1\x1b\\");
});

test("other records retain rounded working/blocked progress and omit it for idle, done and error", () => {
	for (const [progress, expected] of [[-42, 0], [0, 0], [49.6, 50], [100, 100], [200, 100]]) {
		for (const state of ["working", "blocked"]) {
			assert.equal(encodeRecord("p", { state, progress }), `\x1b]7501;state=${state}:progress=${expected}:id=p\x1b\\`);
		}
	}
	for (const state of ["idle", "done", "error"]) {
		assert.equal(encodeRecord("p", { state, progress: 25 }), `\x1b]7501;state=${state}:id=p\x1b\\`);
	}
	for (const progress of [NaN, Infinity, -Infinity, "10", null]) {
		assert.equal(encodeRecord("p", { state: "working", progress }), "\x1b]7501;state=working:id=p\x1b\\");
	}
});

test("S12 projectAll never publishes ctx, even when context usage is known", () => {
	const todo = { done: 1, total: 2, current: "One" };
	for (const context of [0, 25.5, 100, undefined, null, NaN]) {
		assert.equal(projectAll({ context }).has("ctx"), false);
		assert.deepEqual(projectAll({ todo, context }), projectTodo(todo));
	}
});

test("S2 projectAll ignores the obsolete decision input without changing other sources", () => {
	const inputs = { todo: { done: 1, total: 2, current: "One" }, context: 25.5 };
	const before = projectAll(inputs);
	assert.deepEqual(before, records(["todo", { state: "working", title: "One", progress: 50 }]));
	assert.deepEqual(projectAll({ ...inputs, decision: { active: true, label: "Choose" } }), before);
});

test("control characters become spaces, text is trimmed and empty fields are omitted", () => {
	assert.equal(encodeRecord("a", { state: "working", title: " \x00Hi\nthere\x7f ", msg: " ok\x9fgo " }),
		"\x1b]7501;state=working:title=SGkgdGhlcmU=:msg=b2sgZ28=:id=a\x1b\\");
	assert.equal(encodeRecord("a", { state: "idle", title: " \n\x1b\x7f ", msg: "\x00" }),
		"\x1b]7501;state=idle:id=a\x1b\\");
});

test("each UTF-8 field truncates at a scalar boundary within 512 bytes", () => {
	const title = "ñ".repeat(254) + "😀";
	const msg = "a".repeat(511);
	assert.equal(Buffer.byteLength(title), 512);
	assert.equal(encodeRecord("a", { state: "working", title: `${title}z`, msg: `${msg}ñ` }),
		`\x1b]7501;state=working:title=${Buffer.from(title).toString("base64")}:msg=${Buffer.from(msg).toString("base64")}:id=a\x1b\\`);
	const emoji = "😀".repeat(127);
	assert.equal(encodeRecord("a", { state: "idle", title: `${emoji}ñ😀` }),
		`\x1b]7501;state=idle:title=${Buffer.from(`${emoji}ñ`).toString("base64")}:id=a\x1b\\`);
});

test("IDs reject invalid characters, empty segments, and lengths over 64 without changing identity", () => {
	const valid = "A/_b./-x";
	assert.equal(encodeClear(valid), `\x1b]7501;state=clear:id=${valid}\x1b\\`);
	assert.equal(encodeRecord("x".repeat(64), { state: "idle" }), `\x1b]7501;state=idle:id=${"x".repeat(64)}\x1b\\`);
	for (const id of ["", "/a", "a/", "a//b", "a:b", "a b", "ñ", "a\x1b", "x".repeat(65), null, 42]) {
		assert.equal(encodeRecord(id, { state: "idle" }), undefined);
		assert.equal(encodeClear(id), undefined);
	}
	for (const record of [null, {}, { state: "clear" }, { state: "bad" }, { state: 1 }]) {
		assert.equal(encodeRecord("a", record), undefined);
	}
});

test("diff clears removed IDs first, then resends changed/new full records in map order", () => {
	const before = records(["bg/old", { state: "working", title: "Old" }],
		["todo", { state: "working", title: "One", progress: 20, msg: "old" }],
		["sub/same", { state: "blocked", kind: "question", title: "Ask" }],
		["wait/old", { state: "working" }]);
	const after = records(["todo", { state: "working", title: "One", progress: 40 }],
		["sub/same", { title: "Ask", kind: "question", state: "blocked" }],
		["sent/peer", { state: "idle", msg: "sent to peer" }]);
	assert.deepEqual(diffRecords(before, after), [
		"\x1b]7501;state=clear:id=bg/old\x1b\\",
		"\x1b]7501;state=clear:id=wait/old\x1b\\",
		"\x1b]7501;state=working:progress=40:title=T25l:id=todo\x1b\\",
		"\x1b]7501;state=idle:msg=c2VudCB0byBwZWVy:id=sent/peer\x1b\\",
	]);
	assert.deepEqual(diffRecords(after, new Map(after)), []);
	assert.deepEqual(diffRecords(after, empty), [
		"\x1b]7501;state=clear:id=todo\x1b\\",
		"\x1b]7501;state=clear:id=sub/same\x1b\\",
		"\x1b]7501;state=clear:id=sent/peer\x1b\\",
	]);
});

test("invalid next records clear a formerly valid record rather than retaining stale state", () => {
	const before = records(["todo", { state: "working" }]);
	const after = new Map([["todo", { state: "broken" }]]) as unknown as Map<string, DesktopRecord>;
	assert.deepEqual(diffRecords(before, after), ["\x1b]7501;state=clear:id=todo\x1b\\"]);
});

test("todo projects sanitized active title and rounded progress", () => {
	const todo = projectTodo({ done: 1, total: 3, current: "\x1b[31munsafe\x1b[0m\n\u202e title" });
	assert.deepEqual(todo, records(["todo", { state: "working", title: "unsafe title", progress: 33 }]));
	assert.deepEqual(diffRecords(empty, todo), ["\x1b]7501;state=working:progress=33:title=dW5zYWZlIHRpdGxl:id=todo\x1b\\"]);
	assert.equal(projectTodo({ done: 2, total: 3, current: "Work" }).get("todo")?.progress, 67);
	assert.equal(projectTodo({ done: 0, total: 1, current: "Work" }).get("todo")?.progress, 0);
});

test("todo title matches activeTodoTitle for terminal escapes, bidi controls, graphemes and clipped input", () => {
	for (const title of ["\x1b]8;;https://private\x07safe\x1b]8;;\x07", "\x1b_private\x1b\\safe",
		"👩🏽‍💻\u061c ok", "abc\u200b\u200e\u202e   xyz", "x".repeat(4095) + "😀tail"]) {
		assert.equal(projectTodo({ done: 0, total: 1, current: title }).get("todo")?.title,
			activeTodoTitle([{ status: "in_progress", title }]));
	}
});

test("todo fails closed for missing current, invalid counts and sanitized-empty text", () => {
	for (const value of [null, {}, { done: 0, total: 0, current: "work" },
		{ done: -1, total: 1, current: "work" }, { done: 2, total: 1, current: "work" },
		{ done: 0.5, total: 1, current: "work" }, { done: 0, total: Infinity, current: "work" },
		{ done: 0, total: 1, current: null }, { done: 0, total: 1, current: 42 },
		{ done: 0, total: 1, current: "\x1b[31m\x1b[0m\n\u202e" }]) {
		assert.deepEqual(projectTodo(value), empty);
	}
});

test("jobs project only running snapshot entries; finished tails are absent", () => {
	const snapshot = { jobs: [
		{ id: "j1", label: "Job", explicitLabel: "Job", startedAt: 1 },
		{ id: "j2", label: "done", startedAt: 2, status: "exited", endedAt: 3, exitCode: 0 },
		{ id: "j3", label: "stopped", startedAt: 2, status: "stopped" },
		{ id: "j4", label: "failed", startedAt: 2, status: "failed", exitCode: null },
		{ id: "j5", label: "Second", explicitLabel: "Second", startedAt: 2 },
	] };
	const projected = projectJobs(snapshot);
	assert.deepEqual(projected, records(["bg/j1", { state: "working", title: "Job" }], ["bg/j5", { state: "working", title: "Second" }]));
	assert.deepEqual(diffRecords(empty, projected), [
		"\x1b]7501;state=working:title=Sm9i:id=bg/j1\x1b\\",
		"\x1b]7501;state=working:title=U2Vjb25k:id=bg/j5\x1b\\",
	]);
});

test("S16 control-only explicit job and task labels use safe fallback titles after encoder cleanup", () => {
	for (const label of ["\x00", " \x1b\x7f\x9f "]) {
		const jobs = projectJobs({ jobs: [
			{ id: "job", label: "private command", explicitLabel: label, startedAt: 1 },
			{ id: "monitor", label: "private command", explicitLabel: label, kind: "monitor", startedAt: 1 },
		] });
		const tasks = projectSubagents([{ id: "task", agent: "explore", label: "private prompt", explicitLabel: label, status: "running" }]);
		assert.equal(encodeRecord("bg/job", jobs.get("bg/job")), "\x1b]7501;state=working:title=YmFja2dyb3VuZCBqb2I=:id=bg/job\x1b\\");
		assert.equal(encodeRecord("bg/monitor", jobs.get("bg/monitor")), "\x1b]7501;state=working:title=bW9uaXRvcg==:id=bg/monitor\x1b\\");
		assert.equal(encodeRecord("subagents/task", tasks.get("subagents/task")), "\x1b]7501;state=working:title=ZXhwbG9yZQ==:id=subagents/task\x1b\\");
	}
	const job = projectJobs({ jobs: [{ id: "job", label: "private command", explicitLabel: "Safe\x00title", startedAt: 1 }] });
	const tasks = projectSubagents([{ id: "task", agent: "explore", label: "private prompt", explicitLabel: "Safe\x00title", status: "running" }]);
	assert.equal(encodeRecord("bg/job", job.get("bg/job")), "\x1b]7501;state=working:title=U2FmZSB0aXRsZQ==:id=bg/job\x1b\\");
	assert.equal(encodeRecord("subagents/task", tasks.get("subagents/task")), "\x1b]7501;state=working:title=U2FmZSB0aXRsZQ==:id=subagents/task\x1b\\");
});

test("jobs reject malformed snapshots and never emit invalid IDs", () => {
	for (const value of [null, {}, { jobs: null }, { jobs: [{}] }, { jobs: [{ id: "a", label: "x" }] },
		{ jobs: [{ id: "a", label: "x", startedAt: NaN }] },
		{ jobs: [{ id: "a", label: "x", startedAt: 0, status: "running" }] },
		{ jobs: [{ id: "a", label: "x", startedAt: 0 }, null] }]) {
		assert.deepEqual(projectJobs(value), empty);
	}
	assert.deepEqual(projectJobs({ jobs: [{ id: "bad:id", label: "bad", startedAt: 0 }, { id: "ok", label: "Job", explicitLabel: "Job", startedAt: 0 }] }),
		records(["bg/ok", { state: "working", title: "Job" }]));
});

test("subagent statuses and pending queries project, with label fallback and terminal precedence", () => {
	const input = [
		{ id: "q", agent: "agent", label: "Queue", explicitLabel: "Queue", status: "queued" },
		{ id: "r", agent: "Runner", status: "running" },
		{ id: "w", agent: "agent", label: "Ask", explicitLabel: "Ask", status: "waiting" },
		{ id: "p", agent: "agent", label: "Query", explicitLabel: "Query", status: "running", pendingQuery: true },
		{ id: "t", agent: "agent", status: "queued", pendingQuery: true },
		{ id: "both", agent: "agent", label: "Both", explicitLabel: "Both", status: "waiting", pendingQuery: true },
		...(["completed", "failed", "cancelled", "timed_out"] as const).map((status) => ({ id: status, agent: "agent", status, pendingQuery: true })),
	];
	const projected = projectSubagents(input);
	assert.deepEqual(projected, records(
		["subagents/q", { state: "working", title: "Queue" }], ["subagents/r", { state: "working", title: "Runner" }],
		["subagents/w", { state: "blocked", kind: "question", title: "Ask", msg: "waiting for user" }],
		["subagents/p", { state: "blocked", kind: "question", title: "Query", msg: "question for parent" }],
		["subagents/t", { state: "blocked", kind: "question", title: "agent", msg: "question for parent" }],
		["subagents/both", { state: "blocked", kind: "question", title: "Both", msg: "question for parent" }],
	));
	assert.equal(encodeRecord("subagents/w", projected.get("subagents/w")), "\x1b]7501;state=blocked:kind=question:title=QXNr:msg=d2FpdGluZyBmb3IgdXNlcg==:id=subagents/w\x1b\\");
	assert.equal(encodeRecord("subagents/p", projected.get("subagents/p")), "\x1b]7501;state=blocked:kind=question:title=UXVlcnk=:msg=cXVlc3Rpb24gZm9yIHBhcmVudA==:id=subagents/p\x1b\\");
	assert.equal(projectSubagents([{ id: "x", agent: "fallback", label: " ", status: "running", pendingQuery: false }]).get("subagents/x")?.title, "fallback");
});

test("subagent projection fails closed on malformed entries and skips invalid IDs", () => {
	for (const value of [null, {}, [null], [{ id: "x", agent: "a", status: "other" }],
		[{ id: "x", status: "running" }], [{ id: "x", agent: "a", status: "running", label: 3 }],
		[{ id: "x", agent: "a", status: "running", pendingQuery: "true" }]]) {
		assert.deepEqual(projectSubagents(value), empty);
	}
	assert.deepEqual(projectSubagents([{ id: "x:y", agent: "a", status: "running" }, { id: "ok", agent: "a", status: "running" }]),
		records(["subagents/ok", { state: "working", title: "a" }]));
});

test("wait records use working state, exact target message and valid IDs", () => {
	const waits = projectWaits(["peer", "other", "peer", "bad:id"]);
	assert.deepEqual(waits, records(["wait/peer", { state: "working", msg: "consulting peer" }],
		["wait/other", { state: "working", msg: "consulting other" }]));
	assert.equal(encodeRecord("wait/peer", waits.get("wait/peer")),
		"\x1b]7501;state=working:msg=Y29uc3VsdGluZyBwZWVy:id=wait/peer\x1b\\");
	for (const input of [null, {}, "peer", ["ok", null], [, "peer"]]) assert.deepEqual(projectWaits(input), empty);
});

test("send TTL retains 4999ms and clears exactly at 5000ms", () => {
	assert.equal(SEND_TTL_MS, 5000);
	const input = [{ target: "peer", at: 1000 }, { target: "bad:id", at: 1000 }];
	const visible = projectSends(input, 5999);
	assert.deepEqual(visible, records(["sent/peer", { state: "idle", msg: "sent to peer" }]));
	assert.equal(encodeRecord("sent/peer", visible.get("sent/peer")),
		"\x1b]7501;state=idle:msg=c2VudCB0byBwZWVy:id=sent/peer\x1b\\");
	const expired = projectSends(input, 6000);
	assert.deepEqual(expired, empty);
	assert.deepEqual(diffRecords(visible, expired), ["\x1b]7501;state=clear:id=sent/peer\x1b\\"]);
});

test("sends reject malformed entries and clocks, and preserve a newer send for the same target", () => {
	for (const [input, now] of [[null, 1], [{}, 1], [[{ target: "peer" }], 1],
		[[{ target: "peer", at: NaN }], 1], [[{ target: "peer", at: 0 }], NaN],
		[[{ target: "peer", at: 0 }, null], 1]]) {
		assert.deepEqual(projectSends(input, now), empty);
	}
	assert.deepEqual(projectSends([{ target: "p", at: 0 }, { target: "p", at: 4999 }], 5000),
		records(["sent/p", { state: "idle", msg: "sent to p" }]));
});

test("projectAll merges independent sources in todo, jobs, subagents, waits, sends order", () => {
	const all = projectAll({
		todo: { done: 1, total: 2, current: "One" },
		jobs: { jobs: [{ id: "j", label: "Job", explicitLabel: "Job", startedAt: 1 }] },
		subagents: [{ id: "s", agent: "Ask", status: "waiting" }],
		waits: ["peer"], sends: [{ target: "peer", at: 1 }], now: 2,
	});
	assert.deepEqual([...all.keys()], ["todo", "bg/j", "subagents/s", "wait/peer", "sent/peer"]);
	assert.deepEqual(diffRecords(empty, all), [
		"\x1b]7501;state=working:progress=50:title=T25l:id=todo\x1b\\",
		"\x1b]7501;state=working:title=Sm9i:id=bg/j\x1b\\",
		"\x1b]7501;state=blocked:kind=question:title=QXNr:msg=d2FpdGluZyBmb3IgdXNlcg==:id=subagents/s\x1b\\",
		"\x1b]7501;state=working:msg=Y29uc3VsdGluZyBwZWVy:id=wait/peer\x1b\\",
		"\x1b]7501;state=idle:msg=c2VudCB0byBwZWVy:id=sent/peer\x1b\\",
	]);
	assert.deepEqual(projectAll(null), empty);
	assert.deepEqual(projectAll({ jobs: null, waits: ["peer"] }), records(["wait/peer", { state: "working", msg: "consulting peer" }]));
});

test("all projections fail closed without throwing even when malformed property access throws", () => {
	const hostile = new Proxy({}, { get: () => { throw new Error("malformed"); } });
	for (const result of [projectTodo(hostile), projectJobs(hostile), projectSubagents([hostile]),
		projectWaits([hostile]), projectSends([hostile], 0), projectAll(hostile)]) {
		assert.deepEqual(result, empty);
	}
});

test("S12 snapshots without provenance or with an unknown kind still validate and never publish label text", async () => {
	const { isJobsSidebarSnapshot } = await import("../lib/jobs-sidebar-state.ts");
	const legacy = { jobs: [{ id: "j1", label: "rm -rf SECRET", startedAt: 1 }] };
	const unknownKind = { jobs: [{ id: "j1", label: "rm -rf SECRET", kind: "other", startedAt: 1 }] };
	for (const snapshot of [legacy, unknownKind]) {
		assert.equal(isJobsSidebarSnapshot(snapshot), true);
		assert.deepEqual([...projectJobs(snapshot)], [["bg/j1", { state: "working", title: "background job" }]]);
	}
	assert.deepEqual([...projectJobs({ jobs: [{ id: "j1", label: "c", explicitLabel: " \t", kind: "monitor", startedAt: 1 }] })], [["bg/j1", { state: "working", title: "monitor" }]]);
});
