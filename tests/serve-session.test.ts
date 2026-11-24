import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JsonlDecoder, ReplayRing, ServeSession, type ServeSessionLimits, type StreamSink } from "../lib/serve-session.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));

/** An SSE sink that records what it was sent; `backlog` simulates unsent bytes. */
class FakeSink implements StreamSink {
	chunks: string[] = [];
	ended = false;
	destroyed = false;
	backlog = 0;
	get writableLength(): number { return this.backlog; }
	get text(): string { return this.chunks.join(""); }
	write(chunk: string): boolean { this.chunks.push(chunk); return true; }
	end(chunk?: string): void { if (chunk) this.chunks.push(chunk); this.ended = true; }
	destroy(): void { this.destroyed = true; }
}

interface Frame { event?: string; id?: string; data?: string }

function frames(text: string): Frame[] {
	return text.split("\n\n").filter((block) => block.trim() && !block.startsWith(":") && !block.startsWith("retry:")).map((block) => {
		const frame: Frame = {};
		for (const line of block.split("\n")) {
			const colon = line.indexOf(": ");
			const key = line.slice(0, colon), value = line.slice(colon + 2);
			if (key === "event" || key === "id" || key === "data") frame[key] = value;
		}
		return frame;
	});
}

function startFake(limits: Partial<ServeSessionLimits> = {}, now?: () => number): ServeSession {
	return new ServeSession({ id: "ses_test", launch: { command: process.execPath, args: [FAKE_PI], cwd: process.cwd(), env: process.env }, limits, ...(now ? { now } : {}) });
}

// Polls a condition a real child process makes true; there is no event to await for it.
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

test("JsonlDecoder splits only on LF, strips CR, keeps U+2028/U+2029 and joins chunks", () => {
	const lines: string[] = [];
	let oversize = 0;
	const decoder = new JsonlDecoder((line) => lines.push(line), () => { oversize += 1; }, 64);
	decoder.push(Buffer.from('{"a":"x\u2028y\u2029z"}\r\n{"b":'));
	decoder.push(Buffer.from('1}\n\n{"c":2}'));
	assert.deepEqual(lines, ['{"a":"x\u2028y\u2029z"}', '{"b":1}']);
	decoder.end();
	assert.deepEqual(lines.at(-1), '{"c":2}');
	// A multi-byte character split across chunks still decodes whole.
	const euro = Buffer.from('{"e":"€"}\n');
	decoder.push(euro.subarray(0, 8));
	decoder.push(euro.subarray(8));
	assert.equal(lines.at(-1), '{"e":"€"}');
	assert.equal(oversize, 0);
});

test("JsonlDecoder drops an oversize record whole and resumes at the next LF", () => {
	const lines: string[] = [];
	let oversize = 0;
	const decoder = new JsonlDecoder((line) => lines.push(line), () => { oversize += 1; }, 16);
	decoder.push(Buffer.from(`${"x".repeat(10)}`));
	decoder.push(Buffer.from(`${"y".repeat(10)}\n{"ok":1}\n`));
	assert.equal(oversize, 1);
	assert.deepEqual(lines, ['{"ok":1}']);
});

test("ReplayRing evicts by count and bytes and answers snapshot-required outside its window", () => {
	const ring = new ReplayRing(3, 1000);
	for (let seq = 1; seq <= 5; seq += 1) ring.push({ seq, line: `r${seq}`, bytes: 10 });
	assert.equal(ring.length, 3);
	assert.equal(ring.oldest, 3);
	assert.deepEqual(ring.since(2, 5), { records: [3, 4, 5].map((seq) => ({ seq, line: `r${seq}`, bytes: 10 })) });
	assert.deepEqual(ring.since(4, 5), { records: [{ seq: 5, line: "r5", bytes: 10 }] });
	assert.deepEqual(ring.since(5, 5), { records: [] });
	assert.deepEqual(ring.since(1, 5), { snapshotRequired: true, oldest: 3 });
	assert.deepEqual(ring.since(9, 5), { snapshotRequired: true, oldest: 3 }, "a cursor from another lifetime");
	assert.deepEqual(ring.since(-1, 5), { snapshotRequired: true, oldest: 3 });

	const bytes = new ReplayRing(100, 25);
	for (let seq = 1; seq <= 4; seq += 1) bytes.push({ seq, line: "x", bytes: 10 });
	assert.equal(bytes.oldest, 3, "byte budget keeps the newest that fit");
	const huge = new ReplayRing(100, 5);
	huge.push({ seq: 1, line: "big", bytes: 50 });
	assert.equal(huge.length, 1, "the newest record is always kept");
	const empty = new ReplayRing(10, 100);
	assert.deepEqual(empty.since(0, 0), { records: [] });
});

test("a session numbers every record, restores the caller's id and survives framing edge cases", async (t) => {
	const session = startFake();
	t.after(() => session.stop());
	const outcome = await session.rpc({ type: "get_state", id: "mine" }, 5000);
	assert.ok("response" in outcome);
	assert.equal(outcome.response.id, "mine");
	assert.equal(outcome.response.command, "get_state");
	assert.equal(session.seq, 1);

	const noId = await session.rpc({ type: "get_state" }, 5000);
	assert.ok("response" in noId && !("id" in noId.response), "no id in, no id out");

	await session.rpc({ type: "fake_unicode" }, 5000);
	await session.rpc({ type: "fake_split" }, 5000);
	assert.equal(session.invalidRecords, 1, "a non-JSON stdout line is not forwarded");

	const sink = new FakeSink();
	session.subscribe(sink, "dev", 0);
	const replay = frames(sink.text);
	assert.equal(replay[0].event, "hello");
	const records = replay.filter((f) => f.id !== undefined);
	assert.deepEqual(records.map((f) => Number(f.id)), [1, 2, 3, 4, 5, 6]);
	assert.ok(records.some((f) => JSON.parse(f.data!).text === "a\u2028b\u2029c"));
	assert.ok(records.some((f) => JSON.parse(f.data!).split === true));
	assert.ok(records.every((f) => !JSON.parse(f.data!).id?.startsWith?.("x")));
});

test("rpc times out without losing the late response, and Desktop RPC is matched by requestId", async (t) => {
	const session = startFake();
	t.after(() => session.stop());
	const silent = await session.rpc({ type: "fake_silent" }, 50);
	assert.ok("timeout" in silent);
	const answer = await session.desktop("capabilities", { a: 1 }, 5000);
	assert.ok(answer && "answer" in answer);
	assert.equal(answer.answer.kind, "response");
	assert.deepEqual(answer.answer.data, { method: "capabilities", params: { a: 1 } });
	const refused = await session.desktop("refuse", {}, 5000);
	assert.ok(refused && "prompt" in refused && refused.prompt.success === false);
	assert.equal(await session.desktop("never", {}, 100), undefined);
});

test("pending dialogs replay to a late subscriber and only the first answer reaches the child", async (t) => {
	const session = startFake();
	t.after(() => session.stop());
	await session.rpc({ type: "fake_dialog" }, 5000);
	await until(() => session.pendingDialogs().length === 1, "dialog");

	const late = new FakeSink();
	session.subscribe(late, "dev"); // live only: no replay, but the open dialog
	const dialog = frames(late.text).find((f) => f.event === "dialog");
	assert.ok(dialog, late.text);
	assert.equal(JSON.parse(dialog.data!).id, "dlg-1");

	const caughtUp = new FakeSink();
	session.subscribe(caughtUp, "dev", 0); // the replay already carries it: no duplicate
	assert.equal(frames(caughtUp.text).filter((f) => f.event === "dialog").length, 0);

	assert.equal(session.answerDialog({ type: "extension_ui_response", id: "dlg-1", value: "a" }), "accepted");
	assert.equal(session.answerDialog({ type: "extension_ui_response", id: "dlg-1", value: "b" }), "answered");
	assert.equal(session.answerDialog({ type: "extension_ui_response", id: "nope", value: "b" }), "unknown");
	await until(() => late.text.includes("fake_dialog_answer"), "answer echo");
	const echoes = frames(late.text).map((f) => f.data && JSON.parse(f.data)).filter((r) => r?.type === "fake_dialog_answer");
	assert.deepEqual(echoes.map((r) => r.value), ["a"], "the second answer never reached the child");
	assert.ok(late.text.includes('"serve_dialog_resolved"'));
	assert.equal(session.pendingDialogs().length, 0);
});

test("a dialog with a timeout stops being pending once it expires", async (t) => {
	let clock = 1_000;
	const session = startFake({}, () => clock);
	t.after(() => session.stop());
	await session.rpc({ type: "fake_dialog", timeout: 500 }, 5000);
	await until(() => session.pendingDialogs().length === 1, "dialog");
	clock += 501;
	assert.equal(session.pendingDialogs().length, 0);
	assert.equal(session.answerDialog({ type: "extension_ui_response", id: "dlg-1", value: "a" }), "unknown");
});

test("a cursor older than the ring gets snapshot-required, then the live stream", async (t) => {
	const session = startFake({ ringRecords: 5 });
	t.after(() => session.stop());
	await session.rpc({ type: "fake_burst", count: 10 }, 5000);
	assert.equal(session.seq, 11);
	const sink = new FakeSink();
	session.subscribe(sink, "dev", 2);
	const got = frames(sink.text);
	assert.equal(got[1].event, "snapshot-required");
	assert.deepEqual(JSON.parse(got[1].data!), { after: 2, oldest: 7, seq: 11 });
	assert.equal(got.filter((f) => f.id).length, 0);
	await session.rpc({ type: "get_state" }, 5000);
	assert.ok(frames(sink.text).some((f) => f.id === "12"), "live records follow");

	const inWindow = new FakeSink();
	session.subscribe(inWindow, "dev", 9);
	assert.deepEqual(frames(inWindow.text).filter((f) => f.id).map((f) => f.id), ["10", "11", "12"]);
});

test("a slow subscriber is dropped with a resync marker and never stalls the others", async (t) => {
	const session = startFake({ clientBufferBytes: 1024, dropFlushMs: 20 });
	t.after(() => session.stop());
	const slow = new FakeSink();
	const fast = new FakeSink();
	session.subscribe(slow, "dev");
	session.subscribe(fast, "dev");
	slow.backlog = 4096; // the client stopped reading
	await session.rpc({ type: "fake_burst", count: 50, size: 200 }, 5000);
	assert.equal(session.subscriberCount, 1);
	assert.ok(slow.ended);
	const marker = frames(slow.text).find((f) => f.event === "resync");
	assert.ok(marker);
	assert.equal(JSON.parse(marker.data!).reason, "slow_client");
	await until(() => slow.destroyed, "forced close after the flush window");
	assert.equal(frames(fast.text).filter((f) => f.id).length, 51, "the reading client got everything");
});

test("revoking a device closes only its streams; the child's own exit is a record and ends every stream", async () => {
	const session = startFake();
	const a = new FakeSink(), b = new FakeSink();
	session.subscribe(a, "dev_a");
	session.subscribe(b, "dev_b");
	session.dropDevice("dev_a");
	assert.ok(a.destroyed);
	assert.equal(session.subscriberCount, 1);
	// The child exits without answering: the waiting command fails instead of hanging.
	await assert.rejects(session.rpc({ type: "fake_exit", code: 3 }, 5000), /exited/);
	await session.whenExited();
	assert.equal(session.state, "exited");
	assert.equal(session.exitCode, 3);
	assert.ok(b.ended);
	const last = frames(b.text).filter((f) => f.data).map((f) => JSON.parse(f.data!)).at(-1);
	assert.deepEqual(last, { type: "serve_session_exited", code: 3, signal: null });
	await assert.rejects(session.rpc({ type: "get_state" }, 1000), /exited/);
	const after = new FakeSink();
	session.subscribe(after, "dev_a", 0);
	assert.ok(after.ended, "an exited session replays and ends the stream");
	assert.ok(after.text.includes("serve_session_exited"));
});

test("stop closes stdin and terminates the child", async () => {
	const session = startFake();
	await session.rpc({ type: "get_state" }, 5000);
	await session.stop();
	assert.equal(session.state, "exited");
	await session.stop(); // idempotent
});

test("a command that cannot spawn exits the session instead of throwing", async () => {
	const session = new ServeSession({ id: "ses_bad", launch: { command: "/nonexistent/serve-test-binary", args: [], cwd: process.cwd(), env: process.env } });
	await session.whenExited();
	assert.equal(session.state, "exited");
	const sink = new FakeSink();
	session.subscribe(sink, "dev", 0);
	assert.ok(sink.text.includes('"error":"spawn_failed"'));
});
