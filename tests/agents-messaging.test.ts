import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { CHILD_MESSAGE_MAX_BYTES, ChildMessenger, parseChildFrame } from "../lib/agents-messaging.ts";

test("notification and query frames admit only bounded exact schemas", () => {
	assert.deepEqual(parseChildFrame({ id: "n1", kind: "notification", message: "💡\nready" }).frame, { id: "n1", kind: "notification", message: "💡\nready" });
	assert.deepEqual(parseChildFrame({ id: "q1", kind: "query", message: "💡\nready" }).frame, { id: "q1", kind: "query", message: "💡\nready" });
	for (const frame of [
		{ id: "n1", kind: "notification", message: "ready", sender: "forged" },
		{ id: "n1", kind: "query", message: "wrong grammar" },
		{ id: "q1", kind: "notification", message: "wrong grammar" },
		{ id: "q0", kind: "query", message: "leading zero" },
		{ id: `q${"1".repeat(1_000)}`, kind: "query", message: "unbounded correlation" },
		{ id: "q9007199254740992", kind: "query", message: "unsafe correlation" },
		{ id: "q1", kind: "query", message: "\uD800" },
		{ id: "q1", kind: "query", message: "💡".repeat(Math.floor(CHILD_MESSAGE_MAX_BYTES / 4) + 1) },
		{ id: 3, kind: "notification", message: "ready" },
	]) assert.ok(parseChildFrame(frame).error, `reject ${JSON.stringify(frame).slice(0, 80)}`);
});

test("child notification admissions require an exact acknowledgement and clean up", async () => {
	const listeners = new Map<string, Array<(value: Record<string, unknown>) => void>>();
	const frames: Array<Record<string, unknown>> = [];
	const timers: Array<() => void> = [];
	const endpoint = { send: (frame: Record<string, unknown>) => { frames.push(frame); return true; }, on: (event: string, listener: (value: Record<string, unknown>) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]) };
	const messenger = new ChildMessenger(endpoint, (fn) => { timers.push(fn); return () => {}; });
	const pending = messenger.notify("wait");
	let settled = false;
	void pending.then(() => { settled = true; });
	for (const listener of listeners.get("message") ?? []) listener({ id: "n1", kind: "ack", accepted: true, sender: "forged" });
	for (const listener of listeners.get("message") ?? []) listener({ id: "n1", kind: "ack", accepted: false, error: "x".repeat(257) });
	for (const listener of listeners.get("message") ?? []) listener({ id: "n1", kind: "ack", accepted: true, error: "x".repeat(8 * 1024 + 1) });
	await Promise.resolve();
	assert.equal(settled, false, "malformed acknowledgements cannot settle a pending notification");
	assert.deepEqual(frames, [{ id: "n1", kind: "notification", message: "wait" }]);
	for (const listener of listeners.get("message") ?? []) listener({ id: "n1", kind: "ack", accepted: true });
	await pending;
	const timedOut = messenger.notify("timeout");
	timers.at(-1)!();
	await assert.rejects(timedOut, /timed out/);
	const inflight = Array.from({ length: 8 }, (_, index) => messenger.notify(`pending ${index}`));
	await assert.rejects(messenger.notify("over capacity"), /too many/);
	for (const listener of listeners.get("disconnect") ?? []) listener({});
	assert.ok((await Promise.allSettled(inflight)).every((result) => result.status === "rejected"));
	const afterDisconnect = messenger.notify("after disconnect");
	void afterDisconnect.catch(() => {});
	await Promise.resolve();
	assert.equal(frames.length, 10, "a disconnected messenger cannot send another notification");
});

test("callback failures clear pending work but a closed messenger cannot retry", async () => {
	const listeners = new Map<string, Array<(value: Record<string, unknown>) => void>>();
	const callbacks: Array<(error: Error | null) => void> = [];
	const timers: Array<{ cancelled: boolean }> = [];
	const endpoint = { send: (_frame: Record<string, unknown>, callback?: (error: Error | null) => void) => { callbacks.push(callback!); return true; }, on: (event: string, listener: (value: Record<string, unknown>) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]) };
	const messenger = new ChildMessenger(endpoint, () => {
		const timer = { cancelled: false };
		timers.push(timer);
		return () => { timer.cancelled = true; };
	});
	const failed = messenger.notify("first");
	callbacks[0](new Error("send failed"));
	await assert.rejects(failed, /send failed/);
	const retry = messenger.notify("retry");
	for (const listener of listeners.get("message") ?? []) listener({ id: "n2", kind: "ack", accepted: true });
	await retry;
	messenger.close();
	assert.ok(timers.every((timer) => timer.cancelled), "settled and closed work cancels every timer");
	const afterClose = messenger.notify("after close");
	void afterClose.catch(() => {});
	await Promise.resolve();
	assert.equal(callbacks.length, 2, "a closed messenger cannot retry through its endpoint");
	const exhausted = new ChildMessenger(endpoint, () => () => {});
	(exhausted as unknown as { nextId: number }).nextId = Number.MAX_SAFE_INTEGER;
	await assert.rejects(exhausted.notify("overflow"), /correlation exhausted/);
});

test("a real Node IPC child exchanges a notification acknowledgement without stdout framing", async () => {
	const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "agents-messaging-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	const messages: unknown[] = [];
	let output = "";
	const closed = once(child, "close");
	child.on("message", (message) => messages.push(message));
	child.stdout.on("data", (chunk) => { output += chunk; });
	await once(child, "message");
	assert.deepEqual(messages, [{ id: "n1", kind: "notification", message: "fixture ready" }]);
	child.send({ id: "n1", kind: "ack", accepted: true });
	const [code] = await closed;
	assert.equal(code, 0);
	assert.equal(output, '{"accepted":true}\n');
});
