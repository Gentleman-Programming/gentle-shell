import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { visibleWidth } from "@earendil-works/pi-tui";
import { activitySummary, ActivityPublisher, createActivityColumns, metadataArgs, metadataTransport } from "../lib/herdr-activity.ts";

const tasks = [{ title: "Revisar integración Herdr", status: "in_progress" }];
const project = (title: string, columns = 30) => activitySummary([{ title, status: "in_progress" }], columns);

test("summary contains only the icon and sanitized active Todo title", () => {
	assert.equal(activitySummary(tasks, 30), "◐ Revisar integración Herdr");
	assert.equal(project("\x1b[31munsafe\x1b[0m\n\u202e title"), "◐ unsafe title");
	assert.equal(project("\x1b]8;;https://private\x07safe\x1b]8;;\x07"), "◐ safe");
	assert.equal(project("\x1b_private\x1b\\safe"), "◐ safe");
});

test("absent, completed, malformed or sanitized-empty active titles clear the summary", () => {
	for (const entries of [null, {}, [], [{ title: "pending", status: "pending" }],
		[{ title: "done", status: "completed" }], [{ title: 42, status: "in_progress" }],
		[{ title: "\x1b[31m\x1b[0m\n\u202e", status: "in_progress" }], [null]]) {
		assert.equal(activitySummary(entries), null);
	}
});

test("two rows preserve words and all fitting text; only the last row truncates", () => {
	assert.equal(project("one two three four", 12), "◐ one two\n  three four");
	const long = project("one two three four five six", 12)!;
	assert.equal(long, "◐ one two\n  three…");
	assert.equal(project("abcdefghijklmnop", 10), "◐ abcdefgh\n  ijklmnop");
	assert.equal(project("abcdefghijk", 3), "◐ a\n  …");
	assert.equal(project("abc", 2), "◐…");
});

test("Unicode uses display cells and keeps accents, CJK and emoji graphemes intact", () => {
	for (const title of ["café a\u0301 mañana", "漢字漢字漢字漢字", "👩🏽‍💻 👨‍👩‍👧‍👦 😀", "🇪🇸🇯🇵🇫🇷"]) {
		const text = project(title, 10)!;
		assert.ok(text.split("\n").length <= 2);
		for (const row of text.split("\n")) assert.ok(visibleWidth(row) <= 10, row);
		assert.equal(text.replace(/^◐ /, "").replace("\n  ", "").replace(/ /g, ""), title.replace(/ /g, ""));
	}
	assert.equal(project("👩🏽‍💻".repeat(10), 8), "◐ 👩🏽‍💻👩🏽‍💻👩🏽‍💻\n  👩🏽‍💻👩🏽‍💻…");
});

test("UTF-8 budget covers both tokens including prefixes and ellipsis", () => {
	for (const title of ["😀".repeat(500), "👩🏽‍💻".repeat(500), "a" + "\u0301".repeat(10000), "x".repeat(10000)]) {
		const text = project(title, 200)!;
		assert.ok(Buffer.byteLength(text.replace("\n", "")) <= 256);
		assert.ok(text.endsWith("…"));
		assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f\u202e]/);
		assert.ok(text.split("\n").length <= 2);
	}
});

test("publisher serializes latest-only updates, clear, refresh and transport failures", async () => {
	const calls: Array<{ summary: string | null; seq: number }> = [];
	const queue: Array<() => void> = [];
	let release: (() => void) | undefined;
	const publisher = new ActivityPublisher(async (summary, seq) => {
		calls.push({ summary, seq });
		if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
		if (summary === "fail") throw new Error("offline");
	}, (fn) => { queue.push(fn); return () => {}; });
	publisher.update("old"); publisher.update("first"); queue.shift()!();
	publisher.update("second"); publisher.update("latest");
	release!(); await new Promise(setImmediate);
	queue.shift()!(); await new Promise(setImmediate);
	assert.deepEqual(calls.map((call) => call.summary), ["first", "latest"]);
	publisher.update("latest"); assert.equal(queue.length, 0);
	publisher.update("latest", true); queue.shift()!(); await new Promise(setImmediate);
	publisher.update("fail"); queue.shift()!(); await new Promise(setImmediate);
	publisher.update(null); await new Promise(setImmediate);
	assert.equal(calls.at(-1)?.summary, null);
	assert.ok(calls.every((call, index) => index === 0 || call.seq > calls[index - 1]!.seq));
	publisher.close(); publisher.update("ignored"); assert.equal(queue.length, 0);
	await new Promise(setImmediate);
});

test("shutdown supersedes queued activity even while a send is in flight", async () => {
	const calls: Array<string | null> = [];
	const queue: Array<() => void> = [];
	let release!: () => void;
	const publisher = new ActivityPublisher(async (summary) => {
		calls.push(summary);
		if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
	}, (fn) => { queue.push(fn); return () => {}; });
	publisher.update("active"); queue.shift()!(); publisher.update("stale");
	publisher.close(); publisher.update("ignored"); release();
	await new Promise(setImmediate); queue.shift()!(); await new Promise(setImmediate);
	assert.deepEqual(calls, ["active", null]);
});

test("CLI transport uses only a bounded shell-free stub and tolerates offline failure", async (t) => {
	const calls: unknown[][] = [];
	const stub = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
		calls.push(args);
		(args[3] as (error: Error) => void)(new Error("offline"));
	});
	syncBuiltinESMExports();
	try {
		const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fake", HERDR_PANE_ID: "fake-pane" };
		await metadataTransport(env)("◐ long\n  title", 7);
		assert.equal(calls[0]?.[0], "herdr");
		assert.deepEqual(calls[0]?.[1], metadataArgs("fake-pane", "◐ long\n  title", 7));
		assert.deepEqual(calls[0]?.[2], { env, timeout: 1500, maxBuffer: 4096, windowsHide: true });
	} finally { stub.mock.restore(); syncBuiltinESMExports(); }
});

test("one metadata report sets or clears both tokens without changing semantic state", () => {
	const base = ["pane", "report-metadata", "pane", "--source", "gentle:activity", "--agent", "pi", "--seq", "42", "--ttl-ms", "30000"];
	assert.deepEqual(metadataArgs("pane", null, 42), [...base, "--clear-token", "summary", "--clear-token", "summary2"]);
	assert.deepEqual(metadataArgs("pane", "◐ long\n  title", 42), [...base, "--token", "summary=◐ long", "--token", "summary2=  title"]);
	assert.deepEqual(metadataArgs("pane", "◐ short", 42), [...base, "--token", "summary=◐ short", "--clear-token", "summary2"]);
});

test("geometry opens nonblocking and closes non-files without reading", (t) => {
	let flags: unknown;
	const stubs = [
		t.mock.method(fs, "openSync", (_path: string, mode: unknown) => { flags = mode; return 9; }),
		t.mock.method(fs, "fstatSync", () => ({ size: 0, isFile: () => false })),
		t.mock.method(fs, "readSync", () => { throw new Error("must not read a non-file"); }),
		t.mock.method(fs, "closeSync", () => {}),
	];
	syncBuiltinESMExports();
	try {
		assert.equal(createActivityColumns("/fake/herdr.sock")(), 24);
		assert.equal(stubs[2]!.mock.callCount(), 0);
		assert.deepEqual(stubs[3]!.mock.calls[0]!.arguments, [9]);
		assert.equal(stubs[3]!.mock.callCount(), 1);
		assert.equal(typeof flags, "number", "open must use numeric nonblocking flags");
		assert.equal(flags, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
	} finally { for (const stub of stubs) stub.mock.restore(); syncBuiltinESMExports(); }
});

test("geometry is cached, local/named, bounded and fail-safe without reading user data", (t) => {
	let now = 0;
	let body = '{"sidebar_width":35}';
	let grew = false;
	const paths: string[] = [];
	const stubs = [
		t.mock.method(fs, "openSync", (path: string) => { paths.push(path); return 9; }),
		t.mock.method(fs, "fstatSync", () => ({ size: grew ? 1 : Buffer.byteLength(body), isFile: () => true })),
		t.mock.method(fs, "readSync", (_fd: number, buffer: Buffer) => {
			assert.equal(buffer.length, 262145);
			return grew ? buffer.length : buffer.write(body);
		}),
		t.mock.method(fs, "closeSync", () => {}),
	];
	syncBuiltinESMExports();
	try {
		const columns = createActivityColumns("/fake/named/herdr.sock", () => now);
		assert.equal(columns(), 30); body = '{"sidebar_width":25}';
		assert.equal(columns(), 30); assert.equal(paths.length, 1);
		now = 5000; assert.equal(columns(), 20);
		assert.deepEqual(paths, ["/fake/named/session.json", "/fake/named/session.json"]);
		for (const invalid of ["{", "null", '{"sidebar_width":"35"}', '{"sidebar_width":-1}',
			'{"sidebar_width":35.5}', '{"sidebar_width":9999}', "x".repeat(262145)]) {
			body = invalid; now += 5000; assert.equal(columns(), 24);
		}
		assert.equal(stubs[2]!.mock.callCount(), paths.length - 1, "oversized fstat must skip read");
		grew = true; // Simulate a snapshot growing after fstat.
		now += 5000; assert.equal(columns(), 24);
		assert.equal(stubs[3]!.mock.callCount(), paths.length, "every opened descriptor closes");
		stubs[0]!.mock.mockImplementation(() => { throw new Error("missing"); });
		now += 5000; assert.equal(columns(), 24);
		const before = paths.length;
		assert.equal(createActivityColumns("relative.sock")(), 24);
		assert.equal(paths.length, before, "relative paths must not read arbitrary snapshots");
	} finally { for (const stub of stubs) stub.mock.restore(); syncBuiltinESMExports(); }
});
