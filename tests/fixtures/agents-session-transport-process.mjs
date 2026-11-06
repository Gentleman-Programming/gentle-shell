import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ActiveSessionClient, ActiveSessionClientError, ActiveSessionListener, SessionPresenceRegistry } from "../../lib/agents-session-transport.ts";

const agentHome = process.env.GENTLE_AGENT_HOME;
const CONTROL_BYTES = 16_384;
if (!agentHome) throw new Error("GENTLE_AGENT_HOME is required");

await mkdir(join(agentHome, "gentle-agents"), { recursive: true, mode: 0o755 });
const registry = await SessionPresenceRegistry.create(agentHome);
let listener;
let client;
let blockShutdown = false;
let blocker;
let closed = false;
let input = Buffer.alloc(0);

const record = (value) => ({ ...value, presencePath: registry.presencePath(value) });
const controlLine = (value) => {
	const line = JSON.stringify(value);
	if (Buffer.byteLength(line) > CONTROL_BYTES) throw new Error("control frame exceeds bound");
	return `${line}\n`;
};
const emit = (value) => { process.stdout.write(controlLine(value)); };
const flush = (value) => new Promise((resolveFlush, rejectFlush) => {
	process.stdout.write(controlLine(value), (error) => error ? rejectFlush(error) : resolveFlush());
});
const stop = async () => {
	const current = listener?.record;
	client?.close();
	client = undefined;
	if (blocker) clearInterval(blocker);
	blocker = undefined;
	if (listener) await listener.close();
	listener = undefined;
	return current ? record(current) : {};
};
const reply = (requestId, ok, result, error) => emit({ requestId, ok, ...(ok ? { result } : { error }) });
const fatal = () => {
	if (closed) return;
	closed = true;
	input = Buffer.alloc(0);
	process.stdin.off("data", onData);
	void stop().finally(() => process.exit(2));
};

async function handle(line) {
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(line); }
	catch { fatal(); return; }
	let command;
	try {
		command = JSON.parse(text);
		if (!command || typeof command !== "object" || typeof command.requestId !== "string" || typeof command.operation !== "string") throw new Error("invalid control frame");
		let result;
		if (command.operation === "start") {
			await stop();
			listener = new ActiveSessionListener(registry, command.sessionId, async (notification) => {
				emit({ event: "callback", requestId: notification.id, pid: process.pid, ...notification });
			});
			await listener.start();
			client = new ActiveSessionClient(registry, command.sessionId);
			result = record(listener.record);
		} else if (command.operation === "send") {
			if (!client) throw new Error("listener is not active");
			result = await client.sendNotification(command.recipientSessionId, command.message, { id: command.id });
		} else if (command.operation === "resolve") result = record(await registry.resolve(command.sessionId));
		else if (command.operation === "stop") result = await stop();
		else if (command.operation === "delay") {
			if (!Number.isInteger(command.delayMs) || command.delayMs < 0 || command.delayMs > 2_500) throw new Error("invalid test delay");
			await new Promise((resolveDelay) => setTimeout(resolveDelay, command.delayMs));
			result = { delayed: true };
		} else if (command.operation === "exit") process.exit(23);
		else if (command.operation === "block-shutdown") {
			blockShutdown = true;
			blocker ??= setInterval(() => {}, 1_000);
			result = { armed: true };
		}
		else if (command.operation === "shutdown") {
			if (blockShutdown) return;
			result = await stop();
			await flush({ requestId: command.requestId, ok: true, result });
			process.exit(0);
		} else throw new Error("unknown operation");
		reply(command.requestId, true, result);
	} catch (error) {
		const message = error instanceof ActiveSessionClientError ? error.code : "fixture_error";
		reply(typeof command?.requestId === "string" ? command.requestId : "invalid", false, undefined, message);
	}
}

let queue = Promise.resolve();
function onData(chunk) {
	let start = 0;
	while (start < chunk.length) {
		const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
		const fragment = chunk.subarray(start, end);
		if (input.length + fragment.length > CONTROL_BYTES) { fatal(); return; }
		if (newline < 0) { input = Buffer.concat([input, fragment]); return; }
		const line = input.length ? Buffer.concat([input, fragment]) : fragment;
		input = Buffer.alloc(0);
		queue = queue.then(() => handle(line)).catch(fatal);
		start = newline + 1;
	}
}

process.stdin.on("data", onData);
process.stdin.on("error", fatal);
