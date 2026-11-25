import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { DESKTOP_RPC_WIDGET, JsonlDecoder, KeeperLink, ReplayRing, SERVE_SESSION_LIMITS, ServeSession, SessionLog, type ServeSessionLimits, type SessionLaunch, type StreamSink } from "../lib/serve-session.ts";
import { keeperEndpoint, SessionKeeper } from "../lib/serve-session-keeper.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));
const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

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

interface FakeOptions {
	now?: () => number;
	launch?: SessionLaunch;
	deviceLabel?: (id: string) => string | undefined;
}

/** A session as the server holds it, over a keeper running in this process (so both share the test's clock). */
async function startFake(limits: Partial<ServeSessionLimits> = {}, options: FakeOptions = {}): Promise<ServeSession> {
	const dir = mkdtempSync(join(tmpdir(), "gs-session-"));
	roots.push(dir);
	const keeper = new SessionKeeper({
		id: "ses_test",
		dir,
		token: "test-token",
		launch: options.launch ?? { command: process.execPath, args: [FAKE_PI], cwd: process.cwd(), env: process.env },
		limits,
	}, options.now ? { now: options.now } : {});
	await keeper.start();
	const { link, snapshot, ring } = await KeeperLink.connect(keeperEndpoint(dir, "ses_test"), "test-token", { timeoutMs: 5000, maxLineBytes: SERVE_SESSION_LIMITS.maxLineBytes });
	return new ServeSession({ snapshot, ring, link, limits, ...(options.now ? { now: options.now } : {}), ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}) });
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

test("SessionLog: host_tool_progress keeps a call tracked past the tracking window; without it the call is forgotten", () => {
	let clock = 0;
	const log = new SessionLog({ ringRecords: 100, ringBytes: 1024 * 1024, hostToolTrackMs: 11 * 60 * 1000 }, () => clock);
	let seq = 0;
	const call = (callId: string) => {
		const line = JSON.stringify({ kind: "event", event: "host_tool_call", data: { callId, provider: "phone", tool: "gentle_ui", args: {} } });
		const record = { type: "extension_ui_request", id: `w${seq}`, method: "setWidget", widgetKey: DESKTOP_RPC_WIDGET, widgetLines: [line] };
		seq += 1;
		log.push(seq, JSON.stringify(record), record);
	};
	call("kept");
	call("dropped");
	for (let beat = 0; beat < 3; beat += 1) {
		clock += 9 * 60 * 1000;
		log.progress("kept");
	}
	clock += 60_000;
	call("next");
	assert.equal(log.hostCall("kept")?.provider, "phone", "heartbeats keep the call's owner known");
	assert.equal(log.hostCall("dropped"), undefined, "a call without heartbeats is pruned after the window");
	log.progress("dropped");
	assert.equal(log.hostCall("dropped"), undefined, "progress never revives a forgotten call");
});

test("a session numbers every record, restores the caller's id and survives framing edge cases", async (t) => {
	const session = await startFake();
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
	const session = await startFake();
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
	const session = await startFake();
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

	assert.equal(await session.answerDialog({ type: "extension_ui_response", id: "dlg-1", value: "a" }), "accepted");
	assert.equal(await session.answerDialog({ type: "extension_ui_response", id: "dlg-1", value: "b" }), "answered");
	assert.equal(await session.answerDialog({ type: "extension_ui_response", id: "nope", value: "b" }), "unknown");
	await until(() => late.text.includes("fake_dialog_answer"), "answer echo");
	const echoes = frames(late.text).map((f) => f.data && JSON.parse(f.data)).filter((r) => r?.type === "fake_dialog_answer");
	assert.deepEqual(echoes.map((r) => r.value), ["a"], "the second answer never reached the child");
	assert.ok(late.text.includes('"serve_dialog_resolved"'));
	assert.equal(session.pendingDialogs().length, 0);
});

test("a dialog with a timeout stops being pending once it expires", async (t) => {
	let clock = 1_000;
	const session = await startFake({}, { now: () => clock });
	t.after(() => session.stop());
	await session.rpc({ type: "fake_dialog", timeout: 500 }, 5000);
	await until(() => session.pendingDialogs().length === 1, "dialog");
	clock += 501;
	assert.equal(session.pendingDialogs().length, 0);
	assert.equal(await session.answerDialog({ type: "extension_ui_response", id: "dlg-1", value: "a" }), "unknown");
});

test("a cursor older than the ring gets snapshot-required, then the live stream", async (t) => {
	const session = await startFake({ ringRecords: 5 });
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
	const session = await startFake({ clientBufferBytes: 1024, dropFlushMs: 20 });
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
	const session = await startFake();
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
	const session = await startFake();
	await session.rpc({ type: "get_state" }, 5000);
	await session.stop();
	assert.equal(session.state, "exited");
	await session.stop(); // idempotent
});

test("a command that cannot spawn exits the session instead of throwing", async () => {
	const session = await startFake({}, { launch: { command: "/nonexistent/serve-test-binary", args: [], cwd: process.cwd(), env: process.env } });
	await session.whenExited();
	assert.equal(session.state, "exited");
	const sink = new FakeSink();
	session.subscribe(sink, "dev", 0);
	assert.ok(sink.text.includes('"error":"spawn_failed"'));
});

// ---- host tools ---------------------------------------------------------------

function startHostFake(limits: Partial<ServeSessionLimits> = {}): Promise<ServeSession> {
	return startFake(limits, { deviceLabel: (id) => (id === "dev_phone" ? "Ismael's phone" : undefined) });
}

/** The host_tool_result the server sent for `callId` on a device's behalf, as the fake child echoed it. */
function serverAnswer(sink: FakeSink, callId: string): { callId: string; content: Array<{ type: string; text: string }>; isError: boolean } | undefined {
	for (const frame of frames(sink.text)) {
		if (!frame.data) continue;
		const record = JSON.parse(frame.data);
		if (record.method !== "setWidget") continue;
		const line = JSON.parse(record.widgetLines[0]);
		if (line.kind === "response" && line.data?.method === "host_tool_result" && line.data.params.callId === callId) return line.data.params;
	}
	return undefined;
}

test("a host tool call for a device with no open stream is answered at once with a not-connected error", async (t) => {
	const session = await startHostFake();
	t.after(() => session.stop());
	const watcher = new FakeSink();
	session.subscribe(watcher, "local");
	await session.rpc({ type: "fake_host_call", callId: "c1", provider: "dev_phone", tool: "phone_camera" }, 5000);
	await until(() => serverAnswer(watcher, "c1") !== undefined, "the server's answer");
	assert.deepEqual(serverAnswer(watcher, "c1"), { callId: "c1", content: [{ type: "text", text: "phone_camera runs in Ismael's phone, which isn't connected right now." }], isError: true });
	assert.deepEqual(session.pendingHostCalls(), []);
	await session.rpc({ type: "fake_host_call", callId: "c2", provider: "dev_unknown", tool: "x_tool" }, 5000);
	await until(() => serverAnswer(watcher, "c2") !== undefined, "the answer for an unnamed device");
	assert.equal(serverAnswer(watcher, "c2")!.content[0].text, "x_tool runs in dev_unknown, which isn't connected right now.");
});

test("a connected device's call waits; a reconnect within the grace gets it again; the last stream gone past the grace fails it", async (t) => {
	const session = await startHostFake({ hostToolGraceMs: 80 });
	t.after(() => session.stop());
	const watcher = new FakeSink();
	session.subscribe(watcher, "local");
	const phone = new FakeSink();
	session.subscribe(phone, "dev_phone");
	await session.rpc({ type: "fake_host_call", callId: "c1", provider: "dev_phone" }, 5000);
	await until(() => session.pendingHostCalls().length === 1, "the call is tracked");
	assert.ok(phone.text.includes('\\"callId\\":\\"c1\\"'), "the device sees the call live");
	assert.equal(session.hostCallProvider("c1"), "dev_phone");

	session.unsubscribe(phone);
	const back = new FakeSink();
	session.subscribe(back, "dev_phone"); // a fresh stream without a cursor: the waiting call is re-sent
	const resent = frames(back.text).filter((f) => f.event === "host_tool_call");
	assert.equal(resent.length, 1);
	assert.equal(JSON.parse(JSON.parse(resent[0].data!).widgetLines[0]).data.callId, "c1");
	const caughtUp = new FakeSink();
	session.subscribe(caughtUp, "dev_phone", 0); // the replay carries it: no duplicate
	assert.equal(frames(caughtUp.text).filter((f) => f.event === "host_tool_call").length, 0);
	const other = new FakeSink();
	session.subscribe(other, "dev_other");
	assert.equal(frames(other.text).filter((f) => f.event === "host_tool_call").length, 0, "only the provider's device gets the re-send");
	// The reconnect cancelled the grace timer; give it time to have fired if it had not.
	await new Promise((r) => setTimeout(r, 160));
	assert.equal(serverAnswer(watcher, "c1"), undefined, "a device back within the grace keeps its call");

	session.unsubscribe(back);
	session.unsubscribe(caughtUp);
	assert.equal(serverAnswer(watcher, "c1"), undefined, "nothing fails before the grace ends");
	await until(() => serverAnswer(watcher, "c1") !== undefined, "the call fails after the grace");
	assert.equal(serverAnswer(watcher, "c1")!.content[0].text, "phone_camera runs in Ismael's phone, which isn't connected right now.");
	assert.deepEqual(session.pendingHostCalls(), []);
});

test("a cancel or a settled result forgets a call; revoking the device fails its calls at once", async (t) => {
	const session = await startHostFake();
	t.after(() => session.stop());
	const watcher = new FakeSink();
	session.subscribe(watcher, "local");
	const phone = new FakeSink();
	session.subscribe(phone, "dev_phone");
	await session.rpc({ type: "fake_host_call", callId: "c1", provider: "dev_phone" }, 5000);
	await session.rpc({ type: "fake_host_call", callId: "c2", provider: "dev_phone" }, 5000);
	await session.rpc({ type: "fake_host_call", callId: "c3", provider: "dev_phone" }, 5000);
	await until(() => session.pendingHostCalls().length === 3, "three calls");
	await session.rpc({ type: "fake_host_cancel", callId: "c1" }, 5000);
	await until(() => session.pendingHostCalls().length === 2, "the cancel");
	session.hostCallSettled("c2");
	assert.deepEqual(session.pendingHostCalls().map((call) => call.callId), ["c3"]);
	session.dropDevice("dev_phone");
	assert.ok(phone.destroyed);
	await until(() => serverAnswer(watcher, "c3") !== undefined, "the revoked device's call fails");
	assert.equal(serverAnswer(watcher, "c1"), undefined);
	assert.equal(serverAnswer(watcher, "c2"), undefined);
});
