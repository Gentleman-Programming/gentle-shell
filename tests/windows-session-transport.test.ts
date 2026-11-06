import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import test from "node:test";
import { FIXED_WINDOWS_POWERSHELL, WindowsActiveSessionClient, WindowsActiveSessionListener, WindowsSessionPresenceRegistry, WindowsSessionTransportHost, parseWindowsHostFrame, parseWindowsHostNotification } from "../lib/windows-session-transport.ts";
import type { PresenceRecord } from "../lib/agents-session-transport.ts";

class FakeTransportChild extends EventEmitter {
	stdin = Object.assign(new EventEmitter(), { writable: true, endCalls: 0, write: (line: string, callback: (error?: Error) => void) => { this.lines.push(line); callback(); return true; }, end: () => { this.stdin.endCalls++; } });
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	lines: string[] = [];
	killCalls = 0;
	kill() { this.killCalls++; this.emit("close", 1, null); return true; }
}

const testEndpoint = "\\\\.\\pipe\\gentle-pi-0123456789abcdef0123456789abcdef";
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const notificationWire = (id: string, message = "ok") => Buffer.from(JSON.stringify({ version: 1, kind: "notification", id, senderSessionId: "sender", recipientSessionId: "recipient", message }) + "\n").toString("base64");
const notificationEvent = (wire: string, connectionId = "connection-1") => JSON.stringify({ event: "notification", connectionId, generation: 1, wire });

async function createListeningFakeHost(callback: () => Promise<boolean>) {
	const child = new FakeTransportChild();
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never, callback });
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	const starting = host.start();
	emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
	await starting;
	const listening = host.listen("recipient", 1);
	emit(`{"requestId":"listen-2","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":1}}`);
	await listening;
	return { child, host, emit };
}

test("Windows listener readiness returns only after helper-owned publication without a stale publish RPC", async () => {
	const child = new FakeTransportChild();
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
	const Registry = WindowsSessionPresenceRegistry as unknown as { new(host: WindowsSessionTransportHost): WindowsSessionPresenceRegistry };
	const registry = new Registry(host);
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	const ready = host.start();
	emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
	await ready;
	let settled = false;
	const starting = registry.startListener("recipient").then((record) => { settled = true; return record; }, (error: unknown) => { settled = true; throw error; });
	try {
		emit(`{"requestId":"listen-2","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":1}}`);
		await nextTurn();
		assert.equal(settled, true, "a successful listen reply must already own its publication");
		assert.deepEqual(await starting, { version: 1, sessionId: "recipient", endpoint: testEndpoint, createdAt: 1 });
		assert.equal(child.lines.filter((line) => line.includes('"operation":"publish"')).length, 0, "listener startup must not re-publish a record after helper readiness");
	} finally {
		child.emit("exit", 1, null);
		await starting.catch(() => {});
	}
});

test("Windows bridge accepts only bounded protocol frames and uses the fixed PS5.1 executable", () => {
	assert.equal(FIXED_WINDOWS_POWERSHELL, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.deepEqual(parseWindowsHostFrame('{"requestId":"r1","ok":true,"result":{"state":"partial"}}'), { requestId: "r1", ok: true, result: { state: "partial" } });
	for (const frame of ["", "{", '{"requestId":"r1","ok":true,"error":"unsafe"}', '{"requestId":"r1","ok":true,"result":{"path":"C:\\\\private"}}', "x".repeat(16_385)]) {
		assert.throws(() => parseWindowsHostFrame(frame), /invalid Windows transport frame/);
	}
});

test("Windows startup markers are monotonic and never satisfy start readiness", async () => {
	const child = new FakeTransportChild();
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
	const starting = host.start();
	child.stdout.emit("data", Buffer.from('{"event":"startup-marker","marker":"script-entered"}\n'));
	assert.equal(host.lastStartupMarker, "script-entered");
	child.stdout.emit("data", Buffer.from('{"event":"startup-marker","marker":"native-ready"}\n'));
	assert.equal(host.lastStartupMarker, "native-ready");
	let settled = false;
	void starting.then(() => { settled = true; }, () => { settled = true; });
	await nextTurn();
	assert.equal(settled, false, "markers are not RPC replies or readiness");
	child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
	await starting;
	child.emit("exit", 1, null);
});

test("Windows host bounds default startup separately from ordinary RPCs without resetting for markers", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const deadline of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_001]) assert.throws(() => new WindowsSessionTransportHost({ rpcDeadlineMs: deadline }), /invalid Windows transport deadline/);
	for (const deadline of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 30_001]) assert.throws(() => new WindowsSessionTransportHost({ startupDeadlineMs: deadline }), /invalid Windows transport startup deadline/);

	const startupChild = new FakeTransportChild();
	const startupHost = new WindowsSessionTransportHost({ spawnProcess: () => startupChild as never });
	let defaultStartupSettled = false;
	const starting = startupHost.start();
	void starting.then(() => { defaultStartupSettled = true; }, () => { defaultStartupSettled = true; });
	t.mock.timers.tick(2_000);
	// This test mocks only setTimeout, so the real setImmediate turn drains the
	// attached rejection reaction before checking the 2s boundary.
	await nextTurn();
	assert.equal(defaultStartupSettled, false, "the default start handshake remains pending beyond the default RPC deadline");
	t.mock.timers.tick(28_000);
	await assert.rejects(starting, /Windows transport request timed out/);
	const startupClosing = startupHost.close();
	startupChild.stdout.emit("data", Buffer.from('{"requestId":"shutdown-2","ok":true,"result":{"state":"partial"}}\n'));
	startupChild.emit("close", 0, null);
	await startupClosing;

	const ordinaryChild = new FakeTransportChild();
	const ordinaryHost = new WindowsSessionTransportHost({ spawnProcess: () => ordinaryChild as never });
	const ordinaryStarting = ordinaryHost.start();
	ordinaryChild.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
	await ordinaryStarting;
	const ordinary = ordinaryHost.request("list", {});
	t.mock.timers.tick(2_000);
	await assert.rejects(ordinary, /Windows transport request timed out/);
	const ordinaryClosing = ordinaryHost.close();
	ordinaryChild.stdout.emit("data", Buffer.from('{"requestId":"shutdown-3","ok":true,"result":{"state":"partial"}}\n'));
	ordinaryChild.emit("close", 0, null);
	await ordinaryClosing;

	const markerChild = new FakeTransportChild();
	const markerHost = new WindowsSessionTransportHost({ spawnProcess: () => markerChild as never, startupDeadlineMs: 10 });
	const markerStarting = markerHost.start();
	t.mock.timers.tick(5);
	markerChild.stdout.emit("data", Buffer.from('{"event":"startup-marker","marker":"script-entered"}\n{"event":"startup-marker","marker":"native-ready"}\n'));
	t.mock.timers.tick(5);
	await assert.rejects(markerStarting, /Windows transport request timed out/);
	const markerClosing = markerHost.close();
	markerChild.stdout.emit("data", Buffer.from('{"requestId":"shutdown-2","ok":true,"result":{"state":"partial"}}\n'));
	markerChild.emit("close", 0, null);
	await markerClosing;
});

test("Windows startup marker transport rejects unknown, duplicate, and regressive frames", async () => {
	for (const frames of [
		['{"event":"startup-marker","marker":"native-ready"}'],
		['{"event":"startup-marker","marker":"script-entered"}', '{"event":"startup-marker","marker":"script-entered"}'],
		['{"event":"startup-marker","marker":"script-entered"}', '{"event":"startup-marker","marker":"unknown"}'],
		['{"event":"startup-marker","marker":"script-entered","extra":true}'],
	]) {
		const child = new FakeTransportChild();
		const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
		const starting = host.start();
		for (const frame of frames) child.stdout.emit("data", Buffer.from(`${frame}\n`));
		await assert.rejects(starting, /Windows transport host unavailable/);
		assert.equal(child.killCalls, 1, "invalid marker input must close the owned child");
	}
});

test("Windows bridge admits bounded public presence results while rejecting private metadata", () => {
	const endpoint = "\\\\.\\pipe\\gentle-pi-0123456789abcdef0123456789abcdef";
	assert.deepEqual(parseWindowsHostFrame(`{"requestId":"record-1","ok":true,"result":{"version":1,"sessionId":"session-a","endpoint":"${endpoint.replaceAll("\\", "\\\\")}","createdAt":1}}`), {
		requestId: "record-1", ok: true, result: { version: 1, sessionId: "session-a", endpoint, createdAt: 1 },
	});
	assert.deepEqual(parseWindowsHostFrame(`{"requestId":"list-2","ok":true,"result":{"records":[{"version":1,"sessionId":"session-a","endpoint":"${endpoint.replaceAll("\\", "\\\\")}","createdAt":1}]}}`), {
		requestId: "list-2", ok: true, result: { records: [{ version: 1, sessionId: "session-a", endpoint, createdAt: 1 }] },
	});
	assert.throws(() => parseWindowsHostFrame(`{"requestId":"record-1","ok":true,"result":{"version":1,"sessionId":"session-a","endpoint":"${endpoint.replaceAll("\\", "\\\\")}","createdAt":1,"path":"C:\\\\private"}}`), /invalid Windows transport frame/);
});

test("Windows bridge rejects list elements with extra or malformed public fields", () => {
	const endpoint = "\\\\.\\pipe\\gentle-pi-0123456789abcdef0123456789abcdef".replaceAll("\\", "\\\\");
	for (const record of [
		`{"version":1,"sessionId":"session-a","endpoint":"${endpoint}","createdAt":1,"extra":true}`,
		`{"version":1,"sessionId":"session-a","endpoint":"${endpoint}","createdAt":true}`,
	]) assert.throws(() => parseWindowsHostFrame(`{"requestId":"list-1","ok":true,"result":{"records":[${record}]}}`), /invalid Windows transport frame/);
});

test("Windows bridge decodes a bounded base64 notification event before semantic acknowledgement", () => {
	const wire = Buffer.from('{"version":1,"kind":"notification","id":"message-1","senderSessionId":"peer","recipientSessionId":"self","message":"hello"}\n').toString("base64");
	assert.deepEqual(parseWindowsHostNotification(`{"event":"notification","connectionId":"c1","generation":1,"wire":"${wire}"}`), {
		event: "notification", connectionId: "c1", generation: 1,
		frame: { version: 1, kind: "notification", id: "message-1", senderSessionId: "peer", recipientSessionId: "self", message: "hello" },
	});
	for (const invalid of [
		'{"event":"notification","connectionId":"c1","generation":1,"wire":"not-base64"}',
		'{"event":"notification","connectionId":"c1","generation":0,"wire":"eA=="}',
		'{"event":"notification","connectionId":"c1","generation":1,"wire":"eA==","path":"private"}',
	]) assert.throws(() => parseWindowsHostNotification(invalid), /invalid Windows transport frame/);
});

test("Windows bridge correlates callback acknowledgement and rejects pending RPCs when its host exits", async () => {
	class FakeChild extends EventEmitter {
		stdin = Object.assign(new EventEmitter(), { writable: true, write: (line: string, callback: (error?: Error) => void) => { this.lines.push(line); callback(); return true; }, end: () => {} });
		stdout = new EventEmitter();
		stderr = new EventEmitter();
		exitCode: number | null = null;
		signalCode: NodeJS.Signals | null = null;
		lines: string[] = [];
		kill() { return true; }
	}
	const child = new FakeChild();
	const host = new WindowsSessionTransportHost({
		runtimeScript: "C:\\runtime\\windows-session-transport.ps1",
		spawnProcess: () => child as never,
		callback: async (notification) => {
			assert.equal(notification.id, "message-1");
			return true;
		},
	});
	const ready = host.start();
	child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
	await ready;
	const endpoint = "\\\\.\\pipe\\gentle-pi-0123456789abcdef0123456789abcdef";
	const listening = host.listen("self", 1);
	child.stdout.emit("data", Buffer.from(`{"requestId":"listen-2","ok":true,"result":{"version":1,"sessionId":"self","endpoint":"${endpoint.replaceAll("\\", "\\\\")}","createdAt":1}}\n`));
	await listening;
	const unsupported = host.request("list", {});
	child.stdout.emit("data", Buffer.from('{"requestId":"list-3","ok":false,"error":"invalid"}\n'));
	await assert.rejects(unsupported, /Windows transport request unavailable/);
	const pending = host.request("list", {});
	const wire = Buffer.from('{"version":1,"kind":"notification","id":"message-1","senderSessionId":"peer","recipientSessionId":"self","message":"hello"}\n').toString("base64");
	child.stdout.emit("data", Buffer.from(`{"event":"notification","connectionId":"c1","generation":1,"wire":"${wire}"}\n`));
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(child.lines.at(-1) ?? "", /"operation":"ack"/);
	child.emit("exit", 1, null);
	await assert.rejects(pending, /Windows transport host exited/);
});

test("Windows bridge keeps ACK capacity separate from ordinary RPCs and suppresses stale generations", async () => {
	class FakeChild extends EventEmitter {
		stdin = Object.assign(new EventEmitter(), { writable: true, write: (line: string, callback: (error?: Error) => void) => { this.lines.push(line); callback(); return true; }, end: () => {} });
		stdout = new EventEmitter(); stderr = new EventEmitter(); exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; lines: string[] = [];
		kill() { return true; }
	}
	const child = new FakeChild();
	let callbacks = 0;
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never, callback: async () => { callbacks++; return true; } });
	const endpoint = "\\\\.\\pipe\\gentle-pi-0123456789abcdef0123456789abcdef";
	const emit = (value: string) => child.stdout.emit("data", Buffer.from(`${value}\n`));
	const starting = host.start();
	emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
	await starting;
	const listening = host.listen("recipient", 1);
	emit(`{"requestId":"listen-2","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${endpoint.replaceAll("\\", "\\\\")}","createdAt":1}}`);
	await listening;
	const ordinary = Array.from({ length: 8 }, () => host.request("list", {}));
	const wire = Buffer.from('{"version":1,"kind":"notification","id":"ack-capacity-1","senderSessionId":"sender","recipientSessionId":"recipient","message":"ok"}\n').toString("base64");
	emit(`{"event":"notification","connectionId":"known-1","generation":1,"wire":"${wire}"}`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(callbacks, 1);
	assert.equal(child.lines.filter((line) => line.includes('"operation":"ack"')).length, 1, "ACK must bypass full ordinary RPC capacity");
	emit(`{"event":"notification","connectionId":"stale-1","generation":2,"wire":"${wire}"}`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(callbacks, 1, "a stale helper generation must not reach the callback");
	assert.equal(child.lines.filter((line) => line.includes('"operation":"ack"')).length, 1, "a stale helper generation must not receive an ACK");
	child.emit("exit", 1, null);
	await Promise.all(ordinary.map((request) => assert.rejects(request, /Windows transport host exited/)));
});

test("Windows listener reserves a skipped local epoch and accepts the next early notification", async () => {
	const child = new FakeTransportChild();
	let callbacks = 0;
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never, callback: async () => { callbacks++; return true; } });
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	const starting = host.start();
	emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
	await starting;
	const saturated = Array.from({ length: 8 }, () => host.request("list", {}));
	await assert.rejects(host.listen("recipient", 1), /Windows transport request unavailable/);
	for (let index = 0; index < 8; index++) emit(`{"requestId":"list-${index + 2}","ok":true,"result":{"records":[]}}`);
	await Promise.all(saturated);
	const listening = host.listen("recipient", 2);
	assert.match(child.lines.at(-1) ?? "", /"operation":"listen".*"generation":2/);
	emit(`{"event":"notification","connectionId":"early-1","generation":2,"wire":"${notificationWire("early-1")}"}`);
	emit(`{"requestId":"listen-10","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":2}}`);
	await listening;
	await nextTurn();
	assert.equal(callbacks, 1, "the first accepted helper generation must receive an early notification and ACK");
	assert.equal(child.lines.filter((line) => line.includes('"operation":"ack"')).length, 1);
	child.emit("exit", 1, null);
});

test("Windows listener reserves a fresh epoch after helper busy or invalid rejection", async () => {
	for (const rejection of ["busy", "invalid"] as const) {
		const child = new FakeTransportChild();
		const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
		const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
		const starting = host.start();
		emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
		await starting;
		const rejected = host.listen("recipient", 1);
		emit(`{"requestId":"listen-2","ok":false,"error":"${rejection}"}`);
		await assert.rejects(rejected, /Windows transport request unavailable/);
		const recovered = host.listen("recipient", 2);
		assert.match(child.lines.at(-1) ?? "", /"operation":"listen".*"generation":2/);
		emit(`{"requestId":"listen-3","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":2}}`);
		await recovered;
		child.emit("exit", 1, null);
	}
});

test("Windows listener ignores a late failed epoch while a replacement is pending and ACKs only that replacement", async () => {
	const child = new FakeTransportChild();
	let callbacks = 0;
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never, callback: async () => { callbacks++; return true; } });
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	const ready = host.start(); emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}'); await ready;
	const failed = host.listen("recipient", 1);
	emit('{"requestId":"listen-2","ok":false,"error":"unavailable"}');
	await assert.rejects(failed, /Windows transport request unavailable/);
	emit('{"event":"listener-failed","generation":1,"error":"unavailable"}');
	const replacement = host.listen("recipient", 2);
	assert.match(child.lines.at(-1) ?? "", /"generation":2/);
	emit(`{"event":"notification","connectionId":"old-1","generation":1,"wire":"${notificationWire("old-1")}"}`);
	emit('{"event":"listener-failed","generation":1,"error":"unavailable"}');
	emit(`{"event":"notification","connectionId":"new-1","generation":2,"wire":"${notificationWire("new-1")}"}`);
	emit(`{"requestId":"listen-3","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":2}}`);
	await replacement; await nextTurn();
	assert.equal(callbacks, 1, "only the pending replacement epoch may deliver or ACK");
	assert.equal(child.lines.filter((line) => line.includes('"operation":"ack"') && line.includes('"generation":2')).length, 1);
	child.emit("exit", 1, null);
});

test("Windows client aborts during resolve, pre-connect, connect, and ACK without a late write or revived result", async () => {
	const record = Object.freeze({ version: 1 as const, sessionId: "recipient", endpoint: testEndpoint, createdAt: 1 });
	for (const stage of ["resolve", "beforeConnect", "connect", "ack"] as const) {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const socket = new Socket();
		socket.on("error", () => {});
		let writes = 0;
		(socket as unknown as { write: () => boolean }).write = () => { writes++; return true; };
		const registry = { resolve: async () => { if (stage === "resolve") await gate; return record; } } as unknown as WindowsSessionPresenceRegistry;
		const client = new WindowsActiveSessionClient(registry, "sender", { connect: () => socket });
		const controller = new AbortController();
		const pending = client.sendNotification("recipient", "cancel", {
			signal: controller.signal,
			beforeConnect: stage === "beforeConnect" ? async () => { await gate; return true; } : undefined,
		});
		if (stage === "resolve" || stage === "beforeConnect") { controller.abort(); release(); }
		else {
			await nextTurn();
			if (stage === "connect") controller.abort();
			else { socket.emit("connect"); await nextTurn(); controller.abort(); }
		}
		await assert.rejects(pending, (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "aborted");
		socket.emit("connect"); socket.emit("end"); socket.emit("error", new Error("late"));
		assert.equal(writes, stage === "ack" ? 1 : 0, `${stage} abort never permits a late write`);
		assert.equal(client.pendingCount, 0);
	}
});

test("Windows client rejects abort while resolve or beforeConnect remains gated", async () => {
	const record = Object.freeze({ version: 1 as const, sessionId: "recipient", endpoint: testEndpoint, createdAt: 1 });
	for (const phase of ["resolve", "beforeConnect"] as const) {
		let release!: () => void, entered!: () => void, connects = 0;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
		const registry = { resolve: async () => { if (phase === "resolve") { entered(); await gate; } return record; } } as unknown as WindowsSessionPresenceRegistry;
		const client = new WindowsActiveSessionClient(registry, "sender", { connect: () => { connects++; return new Socket(); } });
		const controller = new AbortController();
		const pending = client.sendNotification("recipient", "gated", { signal: controller.signal, beforeConnect: phase === "beforeConnect" ? async () => { entered(); await gate; return true; } : undefined });
		await enteredGate;
		controller.abort();
		await assert.rejects(pending, (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "aborted");
		assert.equal(client.pendingCount, 0, "abort settles before the gate opens");
		assert.equal(connects, 0);
		release(); await nextTurn();
		assert.equal(connects, 0, "a released continuation cannot create a socket");
	}
});

test("Windows client tears down only its owned listeners through registration, write, and registration-error races", async () => {
	class FakeSocket extends EventEmitter {
		writes = 0; destroys = 0; onWrite?: () => void;
		write() { this.writes++; this.onWrite?.(); return true; }
		destroy() { this.destroys++; return this; }
	}
	const record = Object.freeze({ version: 1 as const, sessionId: "recipient", endpoint: testEndpoint, createdAt: 1 });
	for (const mode of ["registration", "write", "throw", "laterThrow"] as const) {
		const socket = new FakeSocket(), controller = new AbortController();
		const timers = new Set<() => void>();
		const scheduler = { setTimeout: (callback: () => void) => (timers.add(callback), callback), clearTimeout: (callback: () => void) => { timers.delete(callback); } };
		const externalData = () => {}, externalError = () => {};
		socket.on("data", externalData); socket.on("error", externalError);
		const originalOnce = socket.once.bind(socket) as (event: string, listener: (...args: unknown[]) => void) => FakeSocket;
		if (mode === "registration") socket.once = ((event: string, listener: (...args: unknown[]) => void) => { const value = originalOnce(event, listener); if (event === "connect") controller.abort(); return value; }) as typeof socket.once;
		if (mode === "throw") socket.once = (() => { throw new Error("registration failed"); }) as typeof socket.once;
		if (mode === "laterThrow") socket.once = ((event: string, listener: (...args: unknown[]) => void) => { const value = originalOnce(event, listener); if (event === "end") throw new Error("later registration failed"); return value; }) as typeof socket.once;
		if (mode === "write") socket.onWrite = () => controller.abort();
		const registry = { resolve: async () => record } as unknown as WindowsSessionPresenceRegistry;
		const client = new WindowsActiveSessionClient(registry, "sender", { connect: () => socket as never, scheduler });
		const pending = client.sendNotification("recipient", "race", { signal: controller.signal });
		if (mode === "write") { await nextTurn(); socket.emit("connect"); }
		await assert.rejects(pending, (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === ((mode === "throw" || mode === "laterThrow") ? "io_error" : "aborted"));
		assert.equal(client.pendingCount, 0);
		assert.equal(timers.size, 0, "settlement leaves no timer");
		assert.equal(socket.listenerCount("connect"), 0, `${mode} removes its owned connect listener`);
		assert.equal(socket.listenerCount("data"), 1, `${mode} preserves external data listeners`);
		assert.equal(socket.listenerCount("end"), 0, `${mode} removes its owned end listener`);
		assert.equal(socket.listenerCount("close"), 0, `${mode} removes its owned close listener`);
		assert.equal(socket.listenerCount("error"), 1, `${mode} preserves external error listeners`);
		socket.emit("error", new Error("late"));
		assert.equal(socket.writes, mode === "write" ? 1 : 0);
	}
});

test("Windows listener registers its callback before listen and cancels a start/close race", async () => {
	const record = Object.freeze({ version: 1 as const, sessionId: "recipient", endpoint: "\\\\.\\pipe\\gentle-pi-0123456789abcdef0123456789abcdef", createdAt: 1 });
	let registered: unknown;
	let releaseStart!: () => void;
	const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
	let stopped: PresenceRecord | undefined;
	const registry = {
		setNotification(callback: unknown) { registered = callback; },
		clearNotification() {},
		setListenerFailure() {},
		clearListenerFailure() {},
		async startListener() { assert.ok(registered, "callback must be registered before listen"); await startGate; return record; },
		async stopListener(value: PresenceRecord) { stopped = value; },
		async close() {},
	} as unknown as WindowsSessionPresenceRegistry;
	const listener = new WindowsActiveSessionListener(registry, "recipient", async () => {});
	const starting = listener.start();
	await listener.close();
	releaseStart();
	await assert.rejects(starting, /listener is closed/);
	assert.deepEqual(stopped, record);
	assert.equal(listener.status, "closed");
});

test("Windows bridge isolates a malformed helper wire event and continues with the next valid notification", async () => {
	class FakeChild extends EventEmitter {
		stdin = Object.assign(new EventEmitter(), { writable: true, write: (line: string, callback: (error?: Error) => void) => { this.lines.push(line); callback(); return true; }, end: () => {} });
		stdout = new EventEmitter(); stderr = new EventEmitter(); exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; lines: string[] = []; killCalls = 0;
		kill() { this.killCalls++; this.emit("close", 1, null); return true; }
	}
	const child = new FakeChild();
	let callbacks = 0;
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never, callback: async () => { callbacks++; return true; } });
	const endpoint = "\\\\.\\pipe\\gentle-pi-0123456789abcdef0123456789abcdef";
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	const starting = host.start(); emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}'); await starting;
	const listening = host.listen("recipient", 1); emit(`{"requestId":"listen-2","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${endpoint.replaceAll("\\", "\\\\")}","createdAt":1}}`); await listening;
	emit('{"event":"notification","connectionId":"bad-1","generation":1,"wire":"eA=="}');
	const wire = Buffer.from('{"version":1,"kind":"notification","id":"after-bad-1","senderSessionId":"sender","recipientSessionId":"recipient","message":"ok"}\n').toString("base64");
	emit(`{"event":"notification","connectionId":"good-1","generation":1,"wire":"${wire}"}`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(callbacks, 1);
	assert.equal(child.lines.filter((line) => line.includes('"operation":"ack"')).length, 1);
	emit("{");
	await host.close();
	assert.equal(child.killCalls, 1, "close must settle an already-aborted owned child");
	});

test("Windows bridge buffers private base64 control events per line without stopping its shared helper", async () => {
	for (const fragmented of [false, true]) {
		let callbacks = 0;
		const { child, emit } = await createListeningFakeHost(async () => { callbacks++; return true; });
		const malformed = notificationEvent(Buffer.alloc(65_536, 0x78).toString("base64"), `bad-${fragmented}`);
		if (fragmented) {
			const split = Math.floor(malformed.length / 2);
			child.stdout.emit("data", Buffer.from(malformed.slice(0, split)));
			child.stdout.emit("data", Buffer.from(`${malformed.slice(split)}\n`));
		} else emit(malformed);
		emit(notificationEvent(notificationWire(`after-malformed-${fragmented}`), `good-${fragmented}`));
		await nextTurn();
		assert.equal(callbacks, 1, "a malformed client wire must be isolated to its connection");
		assert.equal(child.killCalls, 0, "a valid helper envelope must keep the shared helper alive");
		child.emit("exit", 1, null);
	}
});

test("Windows bridge accepts batched bounded private events beyond the public control-frame aggregate cap", async () => {
	let callbacks = 0;
	const { child } = await createListeningFakeHost(async () => { callbacks++; return true; });
	const batch = `${notificationEvent(notificationWire("batch-1", "x".repeat(4_000)), "batch-connection-1")}\n${notificationEvent(notificationWire("batch-2", "x".repeat(4_000)), "batch-connection-2")}\n${notificationEvent(notificationWire("batch-3", "x".repeat(4_000)), "batch-connection-3")}\n`;
	assert.ok(Buffer.byteLength(batch) > 16_384);
	child.stdout.emit("data", Buffer.from(batch));
	await nextTurn();
	assert.equal(callbacks, 3);
	assert.equal(child.killCalls, 0);
	child.emit("exit", 1, null);
});

test("Windows bridge fail-closes oversized and malformed helper control frames", async () => {
	for (const line of ["x".repeat(90_000), '{"event":"notification","connectionId":"c1","generation":1,"wire":"not-base64"}', '{"event":"notification","connectionId":"c1","generation":1,"wire":"eA==","extra":true}', '{"event":"listener-failed","generation":1,"error":"C:\\\\private"}']) {
		const { child, emit } = await createListeningFakeHost(async () => true);
		if (line.startsWith("x")) child.stdout.emit("data", Buffer.from(line)); else emit(line);
		assert.equal(child.killCalls, 1, "invalid helper control input must close its owned child");
	}
});

function createListenerBridge() {
	const child = new FakeTransportChild();
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
	const Registry = WindowsSessionPresenceRegistry as unknown as { new(host: WindowsSessionTransportHost): WindowsSessionPresenceRegistry };
	const registry = new Registry(host);
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	return { child, host, registry, emit };
}

async function startBridgeListener(bridge: ReturnType<typeof createListenerBridge>, listener: WindowsActiveSessionListener, requestId: string, createdAt: number) {
	const starting = listener.start();
	bridge.emit(`{"requestId":"${requestId}","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":${createdAt}}}`);
	await starting;
}

test("Windows listener invalidates only its current native generation and clears activation state", async () => {
	const bridge = createListenerBridge();
	const ready = bridge.host.start();
	bridge.emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
	await ready;
	const listener = new WindowsActiveSessionListener(bridge.registry, "recipient", async () => {});
	await startBridgeListener(bridge, listener, "listen-2", 1);
	assert.equal(listener.status, "active");
	assert.ok(listener.record);
	const pendingAck = bridge.host.request("ack", { connectionId: "connection-1", generation: 1, id: "ack-1", accepted: true });
	const ackRejected = assert.rejects(pendingAck, /listener failed/);
	bridge.emit('{"event":"listener-failed","generation":1,"error":"unavailable"}');
	await ackRejected;
	await nextTurn();
	assert.equal(listener.status, "idle");
	assert.equal(listener.record, undefined);
	assert.deepEqual(listener.failure, { code: "io_error", message: "listener failed" });

	await startBridgeListener(bridge, listener, "listen-4", 2);
	bridge.emit('{"event":"listener-failed","generation":1,"error":"unavailable"}');
	await nextTurn();
	assert.equal(listener.status, "active", "a stale failure cannot invalidate a replacement listener");
	assert.equal(listener.record?.createdAt, 2);
	bridge.child.emit("exit", 1, null);
});

test("Windows listener failure during a listen reply race cannot reactivate it", async () => {
	const bridge = createListenerBridge();
	const ready = bridge.host.start();
	bridge.emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
	await ready;
	const listener = new WindowsActiveSessionListener(bridge.registry, "recipient", async () => {});
	const starting = listener.start();
	const rejected = assert.rejects(starting, /listener failed/);
	bridge.emit('{"event":"listener-failed","generation":1,"error":"unavailable"}');
	bridge.emit(`{"requestId":"listen-2","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":1}}`);
	await nextTurn();
	bridge.emit('{"requestId":"stop-listener-3","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}');
	await rejected;
	assert.equal(listener.status, "idle");
	assert.equal(listener.record, undefined);
	bridge.child.emit("exit", 1, null);
});

test("Windows listener stop revokes a matching pending epoch before its late listen reply", async () => {
	const child = new FakeTransportChild();
	let callbacks = 0, failures = 0;
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never, callback: async () => { callbacks++; return true; } });
	host.setListenerFailure(() => { failures++; });
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	const ready = host.start(); emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}'); await ready;
	const record = Object.freeze({ version: 1 as const, sessionId: "recipient", endpoint: testEndpoint, createdAt: 1 });
	const pending = host.listen("recipient", 1);
	const unrelated = host.stopListener(Object.freeze({ ...record, sessionId: "other" }));
	emit('{"requestId":"stop-listener-3","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}');
	await unrelated;
	emit(`{"event":"notification","connectionId":"unrelated-1","generation":1,"wire":"${notificationWire("unrelated-1")}"}`);
	await nextTurn();
	assert.equal(callbacks, 1, "a different identity cannot revoke the pending listener");
	const stopping = host.stopListener(record);
	emit(`{"event":"notification","connectionId":"stopped-1","generation":1,"wire":"${notificationWire("stopped-1")}"}`);
	emit('{"event":"listener-failed","generation":1,"error":"unavailable"}');
	emit('{"requestId":"stop-listener-5","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}');
	await stopping;
	emit(`{"requestId":"listen-2","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":1}}`);
	await assert.rejects(pending, /Windows transport listener failed/);
	await nextTurn();
	assert.equal(callbacks, 1, "the revoked pending epoch cannot notify");
	assert.equal(failures, 0, "the revoked pending epoch cannot fail the current listener");
	const fresh = host.listen("recipient", 2);
	assert.match(child.lines.at(-1) ?? "", /"operation":"listen".*"generation":2/);
	emit(`{"requestId":"listen-6","ok":true,"result":{"version":1,"sessionId":"recipient","endpoint":"${testEndpoint.replaceAll("\\", "\\\\")}","createdAt":2}}`);
	await fresh;
	emit(`{"event":"notification","connectionId":"fresh-1","generation":2,"wire":"${notificationWire("fresh-1")}"}`);
	await nextTurn();
	assert.equal(callbacks, 2, "the fresh reserved epoch remains usable");
	child.emit("exit", 1, null);
});

test("Windows helper exit fails a pending listener once before its listen reply", async () => {
	const child = new FakeTransportChild();
	let failures = 0;
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
	host.setListenerFailure(() => { failures++; });
	const emit = (line: string) => child.stdout.emit("data", Buffer.from(`${line}\n`));
	const ready = host.start(); emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}'); await ready;
	const pending = host.listen("recipient", 1);
	child.emit("exit", 1, null);
	await assert.rejects(pending, /Windows transport host exited/);
	assert.equal(failures, 1, "unexpected helper exit must report the owned pending generation once");
	child.emit("close", 1, null);
});

test("Windows listener propagates unexpected helper exit or abort while normal close remains idempotent", async () => {
	for (const failure of ["exit", "abort"] as const) {
		const bridge = createListenerBridge();
		const ready = bridge.host.start();
		bridge.emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
		await ready;
		const listener = new WindowsActiveSessionListener(bridge.registry, "recipient", async () => {});
		await startBridgeListener(bridge, listener, "listen-2", 1);
		if (failure === "exit") bridge.child.emit("exit", 1, null);
		else bridge.child.stdout.emit("error", new Error("stdout failed"));
		assert.equal(listener.status, "idle");
		assert.equal(listener.record, undefined);
		assert.deepEqual(listener.failure, { code: "io_error", message: "listener failed" });
		await listener.close();
		await listener.close();
		assert.equal(listener.status, "closed");
	}
});

test("Windows listener maps a shared host generation to its replacement object without settling its current ACK for an old failure", async () => {
	const bridge = createListenerBridge();
	const ready = bridge.host.start();
	bridge.emit('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}');
	await ready;
	const first = new WindowsActiveSessionListener(bridge.registry, "recipient", async () => {});
	await startBridgeListener(bridge, first, "listen-2", 1);
	const stopping = bridge.registry.stopListener(first.record!);
	bridge.emit('{"requestId":"stop-listener-3","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}');
	await stopping;
	const second = new WindowsActiveSessionListener(bridge.registry, "recipient", async () => {});
	await startBridgeListener(bridge, second, "listen-4", 2);
	const pendingAck = bridge.host.request("ack", { connectionId: "replacement-1", generation: 2, id: "replacement-ack-1", accepted: true });
	let ackSettled = false;
	void pendingAck.then(() => { ackSettled = true; }, () => { ackSettled = true; });
	bridge.emit('{"event":"listener-failed","generation":1,"error":"unavailable"}');
	await nextTurn();
	assert.equal(second.status, "active");
	assert.equal(ackSettled, false, "an old host failure must not settle the replacement ACK");
	const ackRejected = assert.rejects(pendingAck, /listener failed/);
	bridge.emit('{"event":"listener-failed","generation":2,"error":"unavailable"}');
	await ackRejected;
	assert.equal(second.status, "idle");
	assert.equal(second.record, undefined);
	bridge.child.emit("close", 0, null);
});

class CleanupFakeChild extends EventEmitter {
	readonly stdin = Object.assign(new EventEmitter(), { writable: true, endCalls: 0, write: (_line: string, callback: (error?: Error) => void) => { callback(); return true; }, end: () => { this.stdin.endCalls++; } });
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killCalls = 0;
	closeObserved = false;
	private readonly closeOnKill: boolean;
	constructor(closeOnKill: boolean) {
		super();
		this.closeOnKill = closeOnKill;
		this.on("close", () => { this.closeObserved = true; });
	}
	kill() {
		this.killCalls++;
		if (this.closeOnKill) this.emit("close", 1, null);
		return true;
	}
}

test("Windows host abort releases its owned child before close and bounds a missing child close", async () => {
	for (const closeOnKill of [true, false]) {
		const child = new CleanupFakeChild(closeOnKill);
		const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
		const ready = host.start();
		child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
		await ready;
		child.stdout.emit("error", new Error("stdout failed"));
		assert.equal(child.killCalls, 1, "abort must immediately terminate its owned child");
		assert.equal(child.stdin.endCalls, 1, "abort must close owned input");
		if (closeOnKill) {
			await host.close();
			assert.equal(child.closeObserved, true);
		} else await assert.rejects(host.close(), /did not close/);
	}
});

test("Windows host disposes only owned lifecycle listeners and retains late error guards until actual close", async () => {
	const external = () => {};
	for (const closeOnKill of [true, false]) {
		const child = new CleanupFakeChild(closeOnKill);
		child.on("error", external); child.on("close", external);
		child.stdin.on("error", external); child.stdout.on("data", external); child.stdout.on("error", external); child.stderr.on("error", external);
		const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
		const ready = host.start();
		child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
		await ready;
		child.stdout.emit("error", new Error("stdout failed"));
		if (closeOnKill) {
			await host.close();
			assert.equal(child.listenerCount("error"), 1);
			assert.equal(child.listenerCount("close"), 2, "fixture and external close listeners remain");
			assert.equal(child.stdin.listenerCount("error"), 1);
			assert.equal(child.stdout.listenerCount("data"), 1);
			assert.equal(child.stdout.listenerCount("error"), 1);
			assert.equal(child.stderr.listenerCount("error"), 1);
		} else {
			await assert.rejects(host.close(), /did not close/);
			assert.equal(child.listenerCount("error"), 2, "late child error sink remains until close");
			assert.equal(child.listenerCount("close"), 3, "fixture, external, and owned close listeners remain until close");
			assert.equal(child.stdin.listenerCount("error"), 2);
			assert.equal(child.stdout.listenerCount("data"), 1, "normal stdout data listener is disposed at timeout");
			assert.equal(child.stdout.listenerCount("error"), 2);
			assert.equal(child.stderr.listenerCount("error"), 2);
			assert.doesNotThrow(() => { child.emit("error", new Error("late child")); child.stdin.emit("error", new Error("late stdin")); child.stdout.emit("error", new Error("late stdout")); child.stderr.emit("error", new Error("late stderr")); });
			child.emit("close", 1, null);
			assert.equal(child.listenerCount("error"), 1);
			assert.equal(child.listenerCount("close"), 2);
			assert.equal(child.stdin.listenerCount("error"), 1);
			assert.equal(child.stdout.listenerCount("data"), 1);
			assert.equal(child.stdout.listenerCount("error"), 1);
			assert.equal(child.stderr.listenerCount("error"), 1);
		}
	}
});

test("Windows host cleanup handoff removes guards when child close reenters late-guard installation", async () => {
	const child = new CleanupFakeChild(false);
	let armed = false;
	let closedDuringGuardInstall = false;
	child.on("newListener", (event: string) => {
		if (armed && !closedDuringGuardInstall && event === "error") {
			closedDuringGuardInstall = true;
			child.emit("close", 1, null);
		}
	});
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
	const ready = host.start();
	child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
	await ready;
	armed = true;
	child.stdout.emit("error", new Error("stdout failed"));
	await host.close();
	assert.equal(closedDuringGuardInstall, true);
	assert.equal(child.listenerCount("error"), 0, "no child guard may be installed after its close");
	assert.equal(child.stdin.listenerCount("error"), 0);
	assert.equal(child.stdout.listenerCount("error"), 0);
	assert.equal(child.stderr.listenerCount("error"), 0);
	assert.equal(child.listenerCount("close"), 1, "only the fixture close observer remains");
});

test("Windows host late guards prevent unhandled errors without external error listeners until actual close", async () => {
	const child = new CleanupFakeChild(false);
	const host = new WindowsSessionTransportHost({ spawnProcess: () => child as never });
	const ready = host.start();
	child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
	await ready;
	child.stdout.emit("error", new Error("stdout failed"));
	await assert.rejects(host.close(), /did not close/);
	assert.doesNotThrow(() => { child.emit("error", new Error("late child")); child.stdin.emit("error", new Error("late stdin")); child.stdout.emit("error", new Error("late stdout")); child.stderr.emit("error", new Error("late stderr")); });
	child.emit("close", 1, null);
	assert.equal(child.listenerCount("error"), 0);
	assert.equal(child.stdin.listenerCount("error"), 0);
	assert.equal(child.stdout.listenerCount("error"), 0);
	assert.equal(child.stderr.listenerCount("error"), 0);
});
