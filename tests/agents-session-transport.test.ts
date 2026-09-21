import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nodeTest, { type TestContext } from "node:test";
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
import { ActiveSessionClient, ActiveSessionClientError, ActiveSessionListener, FrameDecoder, MAX_FRAME_BYTES, SessionPresenceError, SessionPresenceRegistry, TransportProtocolError, encodeAckFrame, encodeNotificationFrame, isSafeRuntimeParent, type PresenceRecord, type ReceivedNotification } from "../lib/agents-session-transport.ts";

async function registry(t: TestContext, beforeCandidateOpen?: () => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "g-"));
	await chmod(home, 0o755);
	await mkdir(join(home, "gentle-agents"), { mode: 0o755 });
	t.after(() => rm(home, { recursive: true, force: true }));
	return SessionPresenceRegistry.create(home, beforeCandidateOpen);
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;
const boundedSubprocess = (command: string, args: string[], timeoutMs: number) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }>((resolveChild, rejectChild) => {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "", timedOut = false;
	const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
	child.once("error", (error) => { clearTimeout(timer); rejectChild(error); });
	child.once("close", (code, signal) => { clearTimeout(timer); resolveChild({ code, signal, stdout, stderr, timedOut }); });
});
const rejected = async (operation: Promise<unknown>, code: string, unsafe = "") => {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof SessionPresenceError);
		assert.equal(error.code, code);
		assert.equal(unsafe ? error.message.includes(unsafe) : false, false);
		return true;
	});
};

test("preserves both shared parent modes while creating private transport directories", async (t) => {
	const transport = await registry(t);
	assert.equal(await mode(transport.paths.root), 0o700);
	assert.equal(await mode(transport.paths.presence), 0o700);
	assert.equal(await mode(transport.paths.sockets), 0o700);
	assert.equal(await mode(join(transport.paths.root, "..", "..")), 0o755, "agentHome remains host-owned");
	assert.equal(await mode(join(transport.paths.root, "..")), 0o755, "gentle-agents remains host-owned");
});

test("accepts only private-owned or sticky world-writable runtime parents", () => {
	const current = process.getuid!(), foreign = current === 1 ? 2 : 1;
	const parent = (mode: number, uid: number, directory = true, symlink = false) => ({ mode, uid, isDirectory: () => directory, isSymbolicLink: () => symlink });
	assert.equal(isSafeRuntimeParent(parent(0o700, current)), true, "private owned parent is safe");
	assert.equal(isSafeRuntimeParent(parent(0o777, current)), false, "non-sticky world-writable owned parent is unsafe");
	assert.equal(isSafeRuntimeParent(parent(0o770, current)), false, "group-writable owned parent is unsafe");
	assert.equal(isSafeRuntimeParent(parent(0o1777, current)), true, "current-user sticky parent is safe");
	assert.equal(isSafeRuntimeParent(parent(0o1777, 0)), true, "root-owned sticky parent is safe");
	assert.equal(isSafeRuntimeParent(parent(0o1777, foreign)), false, "foreign-owned sticky parent is unsafe");
	assert.equal(isSafeRuntimeParent(parent(0o755, foreign)), false, "foreign read-only parent is rejected conservatively");
	assert.equal(isSafeRuntimeParent(parent(0o1777, foreign, true, true)), false, "symlinked parent is unsafe");
	assert.equal(isSafeRuntimeParent(parent(0o1777, foreign, false)), false, "non-directory parent is unsafe");
});

test("binds deep ASCII and Unicode profiles to isolated bounded socket paths", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "g-deep-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const profile = async (name: string) => {
		const home = join(base, ...Array.from({ length: 4 }, () => name.repeat(32)));
		await mkdir(join(home, "gentle-agents"), { recursive: true, mode: 0o755 });
		return SessionPresenceRegistry.create(home);
	};
	const ascii = await profile("ascii-"), unicode = await profile("é-");
	const asciiRecord = await ascii.record("ascii"), unicodeRecord = await unicode.record("unicode");
	for (const record of [asciiRecord, unicodeRecord]) assert.ok(Buffer.byteLength(record.endpoint) <= 100, "socket endpoint stays within the conservative Unix limit");
	assert.notEqual(ascii.paths.sockets, unicode.paths.sockets, "profile hash isolates runtime socket partitions");
	assert.equal(ascii.paths.presence.includes(base), true, "presence records remain in the private profile transport directory");
	assert.equal(asciiRecord.endpoint.includes(base), false, "socket endpoint is independent of the profile path");
	const instance = new ActiveSessionListener(unicode, "unicode", async () => {});
	await instance.start();
	assert.equal((await lstat(instance.record!.endpoint)).isSocket(), true, "the bounded Unicode-profile endpoint is usable");
	await instance.close();
});

test("publishes immutable v1 activations with private modes and exact discovery", async (t) => {
	const transport = await registry(t);
	const record = await transport.record("123e4567-e89b-12d3-a456-426614174000", 1);
	assert.deepEqual(Reflect.ownKeys(record), ["version", "sessionId", "endpoint", "createdAt"]);
	assert.equal(record.version, 1);
	await transport.publish(record);
	await rejected(transport.publish(record), "busy");
	assert.deepEqual((await readdir(transport.paths.presence)).filter((name) => name.startsWith(".")), []);
	assert.deepEqual(await transport.resolve(record.sessionId), record);
	assert.equal(await mode(transport.paths.root), 0o700);
	assert.equal(await mode(transport.paths.presence), 0o700);
	assert.equal(await mode(transport.paths.sockets), 0o700);
	assert.equal(await mode(transport.presencePath(record)), 0o600);
	assert.equal(record.endpoint.startsWith(`${transport.paths.sockets}/`), true);
});

test("lists only advertised peer IDs without mutating the private registry", async (t) => {
	let candidateOpens = 0;
	const transport = await registry(t, async () => { candidateOpens += 1; });
	const snapshot = async () => {
		const entries = await readdir(transport.paths.presence);
		const files = await Promise.all(entries.map(async (name) => {
			const path = join(transport.paths.presence, name), stat = await lstat(path);
			return [name, stat.mode & 0o777, createHash("sha256").update(await readFile(path)).digest("hex")];
		}));
		return JSON.stringify({ root: await mode(transport.paths.root), presence: await mode(transport.paths.presence), sockets: await mode(transport.paths.sockets), files: files.sort() });
	};
	assert.deepEqual(await transport.list("self"), []);
	const self = await raw(t, transport, "self");
	assert.deepEqual(await transport.list(self.sessionId), [], "the one active record is excluded when it belongs to this host");
	assert.deepEqual(await transport.list(), [{ sessionId: "self", reachability: "unknown" }], "one peer exposes only its public ID and unknown reachability");
	const alphaOld = await raw(t, transport, "alpha");
	const alphaNew = await raw(t, transport, "alpha");
	const missing = await transport.record("missing", 10); await transport.publish(missing);
	const malformed = await transport.record("malformed", 11); await writeFile(transport.presencePath(malformed), "{");
	const symlinked = await transport.record("symlinked", 12); await symlink("missing", symlinked.endpoint); await transport.publish(symlinked);
	const before = await snapshot();
	assert.deepEqual(await transport.list(self.sessionId), [
		{ sessionId: "alpha", reachability: "unknown" },
	]);
	assert.equal(candidateOpens, 8, "listing reads candidate records but never connects or repairs them");
	assert.equal(await snapshot(), before, "listing leaves presence files, directory modes, and socket entries unchanged");
	assert.equal(alphaNew.createdAt >= alphaOld.createdAt, true);
	for (let index = 0; index < 65; index++) await transport.publish(await transport.record(`overflow-${index}`, index));
	await rejected(transport.list(), "busy");
});

test("keeps same-session activations distinct and old cleanup preserves the newest", async (t) => {
	const transport = await registry(t);
	const old = await transport.record("same-session", 1);
	const newest = await transport.record("same-session", 2);
	await transport.publish(old);
	await transport.publish(newest);
	assert.equal((await readdir(transport.paths.presence)).length, 2);
	assert.deepEqual(await transport.resolve(old.sessionId), newest, "stale activation remains until later liveness cleanup");
	const concurrent = await transport.record("same-session", 3);
	await Promise.all([transport.publish(concurrent), ...Array.from({ length: 12 }, () => transport.removeOwn(old))]);
	assert.deepEqual(await transport.resolve(old.sessionId), concurrent);
	await transport.removeOwn(newest);
	assert.deepEqual(await transport.resolve(old.sessionId), concurrent);
	await transport.removeOwn(concurrent);
	await transport.removeOwn(concurrent);
	await rejected(transport.resolve(old.sessionId), "not_found");
});

test("breaks equal activation timestamps deterministically by capability token", async (t) => {
	const transport = await registry(t);
	const first = await transport.record("tie", 3);
	const second = await transport.record("tie", 3);
	await Promise.all([transport.publish(first), transport.publish(second)]);
	assert.deepEqual(await transport.resolve("tie"), first.endpoint > second.endpoint ? first : second);
});

test("isolates two sessions and bounds registry discovery at 65 entries", async (t) => {
	const transport = await registry(t);
	const left = await transport.record("left", 1);
	const right = await transport.record("right", 2);
	await Promise.all([transport.publish(left), transport.publish(right)]);
	assert.deepEqual(await transport.resolve("left"), left);
	assert.deepEqual(await transport.resolve("right"), right);
	for (let index = 0; index < 65; index++) await transport.publish(await transport.record("capped", index));
	await rejected(transport.resolve("capped"), "busy");
});

test("rejects unsafe IDs, v1 schema violations, prototypes, and content-leaking errors", async (t) => {
	const transport = await registry(t);
	for (const id of ["", "/absolute", "a/b", "line\nbreak", "x".repeat(129)]) await rejected(transport.record(id), "invalid_session", id);
	const record = await transport.record("schema", 1);
	const values: unknown[] = [
		{ ...record, version: 2 }, { sessionId: record.sessionId, endpoint: record.endpoint, createdAt: 1 },
		Object.assign(Object.create({ inherited: true }), record),
	];
	const nullRecord = Object.assign(Object.create(null), record) as PresenceRecord;
	await transport.publish(nullRecord);
	await transport.removeOwn(nullRecord);
	const symbol = { ...record } as Record<PropertyKey, unknown>;
	symbol[Symbol("extra")] = true;
	Object.defineProperty(symbol, "hidden", { value: true });
	values.push(symbol);
	for (const value of values) await rejected(transport.publish(value as PresenceRecord), "invalid_presence");
	await rejected(transport.publish({ ...record, endpoint: join(transport.paths.root, "forged.sock") }), "unsafe_path", "forged.sock");
});

test("continues past malformed matching activations in either entry order", async (t) => {
	for (const malformedFirst of [true, false]) {
		const transport = await registry(t);
		const old = await transport.record("mixed", 1);
		const newest = await transport.record("mixed", 2);
		const malformed = await transport.record("mixed", 3);
		if (malformedFirst) await writeFile(transport.presencePath(malformed), "{");
		await transport.publish(old);
		await transport.publish(newest);
		if (!malformedFirst) await writeFile(transport.presencePath(malformed), "{");
		assert.deepEqual(await transport.resolve("mixed"), newest);
	}
});

test("continues past a matching activation that vanishes after directory enumeration", async (t) => {
	let vanished = "";
	const transport = await registry(t, async () => { await rm(vanished, { force: true }); });
	const valid = await transport.record("vanishing", 1);
	const missing = await transport.record("vanishing", 2);
	vanished = transport.presencePath(missing);
	await transport.publish(valid);
	await transport.publish(missing);
	assert.deepEqual(await transport.resolve("vanishing"), valid);
});

test("maps hook exceptions to a fixed I/O error even with a valid activation", async (t) => {
	for (const error of [new SessionPresenceError("invalid_presence", "SECRET/PATH"), new Error("OTHER/SECRET")]) {
		const transport = await registry(t, async () => { throw error; });
		const valid = await transport.record("hook-error", 1);
		await transport.publish(valid);
		await rejected(transport.resolve("hook-error"), "io_error", "SECRET");
	}
});

test("retains a fixed candidate error when no valid activation exists", async (t) => {
	const transport = await registry(t);
	const malformed = await transport.record("broken", 1);
	await writeFile(transport.presencePath(malformed), "{");
	await rejected(transport.resolve("broken"), "invalid_presence", malformed.endpoint);
});

test("retains unsafe-path priority over malformed candidates independent of entry order", async (t) => {
	for (const malformedFirst of [true, false]) {
		const transport = await registry(t);
		const malformed = await transport.record("priority", 1);
		const unsafe = await transport.record("priority", 2);
		if (malformedFirst) await writeFile(transport.presencePath(malformed), "{");
		await symlink("missing", transport.presencePath(unsafe));
		if (!malformedFirst) await writeFile(transport.presencePath(malformed), "{");
		await rejected(transport.resolve("priority"), "unsafe_path");
	}
});

test("descriptor reads reject symlinks, malformed or oversized candidates, and fixed errors", async (t) => {
	const transport = await registry(t);
	const record = await transport.record("recipient", 1);
	const file = transport.presencePath(record);
	for (const text of ["{", JSON.stringify({ ...record, extra: true }), JSON.stringify({ ...record, sessionId: "other" }), "x".repeat(8193)]) {
		await writeFile(file, text, { mode: 0o600 });
		await rejected(transport.resolve(record.sessionId), "invalid_presence");
		await rm(file, { force: true });
	}
	await symlink("missing", file);
	await rejected(transport.resolve(record.sessionId), "unsafe_path");
});

test("a matching FIFO cannot block presence discovery", async (t) => {
	const transport = await registry(t);
	const record = await transport.record("fifo");
	const fifo = transport.presencePath(record);
	const created = await boundedSubprocess("mkfifo", [fifo], 1000);
	assert.equal(created.timedOut, false, `mkfifo timed out: ${created.stderr}`);
	assert.equal(created.code, 0, `mkfifo failed: ${created.stderr}`);
	const moduleUrl = new URL("../lib/agents-session-transport.ts", import.meta.url).href;
	const script = `import { SessionPresenceRegistry } from ${JSON.stringify(moduleUrl)};\nconst registry = await SessionPresenceRegistry.create(${JSON.stringify(join(transport.paths.root, "..", ".."))});\ntry { await registry.resolve("fifo"); console.log("resolved"); } catch (error) { console.log(\`rejected:\${error.code}\`); }`;
	const child = await boundedSubprocess(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], 1000);
	assert.equal(child.timedOut, false, `presence discovery blocked: ${child.stderr}`);
	assert.equal(child.signal, null, `presence discovery was killed: ${child.stderr}`);
	assert.equal(child.code, 0, `presence discovery failed: ${child.stderr}`);
	assert.match(child.stdout, /^rejected:invalid_presence\s*$/);
});

test("rejects a symlinked dedicated transport directory", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "g-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await symlink("missing", join(home, "gentle-agents"));
	await rejected(SessionPresenceRegistry.create(home), "unsafe_path");
});

const protocolRejected = (operation: () => unknown, code: string) => assert.throws(operation, (error: unknown) => error instanceof TransportProtocolError && error.code === code);
const notification = (message = "hello") => ({ version: 1 as const, kind: "notification" as const, id: "message-1", senderSessionId: "sender", recipientSessionId: "recipient", message });
const decode = (bytes: Buffer, split = bytes.length) => {
	const decoder = new FrameDecoder();
	decoder.push(bytes.subarray(0, split));
	decoder.push(bytes.subarray(split));
	return decoder.finish();
};

test("encodes and incrementally decodes every notification and ack split boundary", () => {
	const frame = notification();
	const bytes = encodeNotificationFrame(frame);
	for (let split = 0; split <= bytes.length; split++) assert.deepEqual(decode(bytes, split), frame);
	const ack = { version: 1 as const, kind: "ack" as const, id: frame.id, accepted: false, error: "rejected" as const };
	const encodedAck = encodeAckFrame(ack);
	for (let split = 0; split <= encodedAck.length; split++) assert.deepEqual(decode(encodedAck, split), ack);
	const accepted = { version: 1 as const, kind: "ack" as const, id: frame.id, accepted: true };
	assert.deepEqual(decode(encodeAckFrame(accepted)), accepted);
});

test("enforces payload and bounded escaped raw-frame limits", () => {
	for (const message of ["a".repeat(8192), "é".repeat(4096), "\0".repeat(8192)]) assert.deepEqual(decode(encodeNotificationFrame(notification(message))), notification(message));
	protocolRejected(() => encodeNotificationFrame(notification("a".repeat(8193))), "invalid_frame");
	const decoder = new FrameDecoder();
	protocolRejected(() => decoder.push(Buffer.alloc(MAX_FRAME_BYTES + 1)), "oversized");
});

test("rejects malformed, trailing, incomplete, invalid UTF8, and terminal protocol input", () => {
	for (const [value, code] of [[Buffer.from("{\n"), "invalid_frame"], [Buffer.from("{}\n"), "invalid_frame"], [Buffer.from(`${JSON.stringify(notification())}\nextra`), "trailing_frame"], [Buffer.from(`${JSON.stringify(notification())}\n{}\n`), "trailing_frame"], [Buffer.from([0xff, 10]), "invalid_utf8"]] as const) {
		const decoder = new FrameDecoder();
		protocolRejected(() => decoder.push(value), code);
	}
	const incomplete = new FrameDecoder();
	incomplete.push(Buffer.from(JSON.stringify(notification())));
	protocolRejected(() => incomplete.finish(), "malformed");
	const complete = new FrameDecoder();
	complete.push(encodeNotificationFrame(notification()));
	complete.finish();
	protocolRejected(() => complete.finish(), "trailing_frame");
	protocolRejected(() => complete.push(Buffer.from("x")), "trailing_frame");
});

test("rejects strict programmatic fields and ack conditional violations", () => {
	const bad: unknown[] = [{ ...notification(), version: 2 }, { ...notification(), kind: "unknown" }, { ...notification(), extra: true }, { ...notification(), id: 3 }, Object.assign(Object.create({ inherited: true }), notification())];
	const symbol = { ...notification() } as Record<PropertyKey, unknown>;
	symbol[Symbol("x")] = true;
	Object.defineProperty(symbol, "hidden", { value: true });
	bad.push(symbol);
	for (const value of bad) protocolRejected(() => encodeNotificationFrame(value as never), "invalid_frame");
	for (const ack of [{ version: 1, kind: "ack", id: "message-1", accepted: true, error: "rejected" }, { version: 1, kind: "ack", id: "message-1", accepted: false }, { version: 1, kind: "ack", id: "message-1", accepted: false, error: "forged" }]) protocolRejected(() => encodeAckFrame(ack as never), "invalid_frame");
});

async function listener(t: TestContext, callback: (value: ReceivedNotification) => Promise<void> = async (_value: ReceivedNotification) => {}, options?: object) {
	const instance = new ActiveSessionListener(await registry(t), "recipient", callback, options as never);
	assert.equal(instance.record, undefined);
	await instance.start();
	return instance;
}

async function request(path: string, frame: Buffer) {
	const socket = createConnection(path), chunks: Buffer[] = [];
	socket.on("data", (chunk) => chunks.push(chunk));
	await once(socket, "connect");
	socket.write(frame.subarray(0, 3));
	socket.write(frame.subarray(3));
	await once(socket, "end");
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
}

const wait = async <T>(label: string, operation: Promise<T>) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1000); })]);
	} finally { if (timer) clearTimeout(timer); }
};
const poll = async (label: string, condition: () => boolean) => {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
};
const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
	return { promise, resolve, reject };
};
const fakeScheduler = () => {
	let next = 0;
	const tasks = new Map<number, () => void>();
	const delays: number[] = [];
	return {
		scheduler: { setTimeout: (task: () => void, delay: number) => { const handle = next++; delays.push(delay); tasks.set(handle, task); return handle; }, clearTimeout: (handle: number) => tasks.delete(handle) },
		get size() { return tasks.size; },
		get delays() { return delays; },
		runAll() { for (const [handle, task] of [...tasks]) { tasks.delete(handle); task(); } },
	};
};

test("listens before publishing presence and acknowledges one valid chunked notification", async (t) => {
	const received: unknown[] = [];
	const instance = await listener(t, async (value) => { received.push(value); });
	assert.ok(instance.record);
	assert.deepEqual(await instance.registry.resolve("recipient"), instance.record);
	assert.equal(await mode(instance.record.endpoint), 0o600);
	const frame = { ...notification("ready"), recipientSessionId: "recipient" };
	assert.deepEqual(await request(instance.record.endpoint, encodeNotificationFrame(frame)), { version: 1, kind: "ack", id: frame.id, accepted: true });
	assert.deepEqual(received, [{ id: frame.id, senderSessionId: frame.senderSessionId, message: frame.message }]);
	await instance.close();
});

test("rejects malformed or foreign notifications without invoking the callback", async (t) => {
	let calls = 0;
	const instance = await listener(t, async () => { calls++; });
	const foreign = { ...notification(), recipientSessionId: "other" };
	assert.equal((await request(instance.record!.endpoint, encodeNotificationFrame(foreign))).accepted, false);
	assert.equal(await request(instance.record!.endpoint, Buffer.from("{\n")), undefined);
	assert.equal(calls, 0);
	await instance.close();
});

test("caps held partial connections and rejects callback failures", async (t) => {
	const instance = await listener(t, async () => { throw new Error("no"); });
	t.after(() => instance.close());
	const held = await Promise.all(Array.from({ length: 8 }, async () => { const socket = createConnection(instance.record!.endpoint); await once(socket, "connect"); return socket; }));
	await poll("held connections", () => instance.activeConnections === 8);
	assert.equal(instance.activeConnections, 8);
	const ninth = createConnection(instance.record!.endpoint);
	await once(ninth, "close");
	assert.equal(instance.activeConnections, 8);
	await Promise.all(held.map(async (socket) => { socket.destroy(); await once(socket, "close"); }));
	const reply = await request(instance.record!.endpoint, encodeNotificationFrame({ ...notification(), recipientSessionId: "recipient" }));
	assert.equal(reply.accepted, false);
	await instance.close();
});

test("accepts during publication and becomes active only after presence succeeds", async (t) => {
	const transport = await registry(t);
	let callbackStarted!: () => void, release: (() => void) | undefined, socket: ReturnType<typeof createConnection> | undefined;
	let instance: ActiveSessionListener | undefined;
	const callbackReady = new Promise<void>((resolve) => { callbackStarted = resolve; });
	const callbackRelease = new Promise<void>((resolve) => { release = resolve; });
	t.after(async () => {
		release?.();
		socket?.destroy();
		if (instance) await wait("listener close", instance.close());
	});
	instance = new ActiveSessionListener(transport, "recipient", async () => { callbackStarted(); await callbackRelease; });
	const original = transport.publish.bind(transport);
	(transport as unknown as { publish: (record: PresenceRecord) => Promise<void> }).publish = async (record) => {
		socket = createConnection(record.endpoint);
		const chunks: Buffer[] = [];
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("error", () => {});
		await wait("publication connection", once(socket, "connect"));
		socket.end(encodeNotificationFrame({ ...notification(), recipientSessionId: "recipient" }));
		const outcome = await wait("publication callback", Promise.race([callbackReady.then(() => "callback"), once(socket, "close").then(() => "closed")]));
		assert.equal(outcome, "callback");
		assert.equal(instance!.status, "accepting");
		assert.equal(instance!.activeConnections, 1);
		release!();
		await wait("publication response", once(socket, "end"));
		assert.equal(JSON.parse(Buffer.concat(chunks).toString()).accepted, true);
		await original(record);
	};
	await wait("listener start", instance.start());
	assert.equal(instance.status, "active");
});

test("rolls back publication failures without listener residue", async (t) => {
	const transport = await registry(t);
	let attempted: PresenceRecord | undefined;
	const failed = new ActiveSessionListener(transport, "failed", async () => {});
	t.after(async () => { await wait("failed listener close", failed.close()); });
	(transport as unknown as { publish: (record: PresenceRecord) => Promise<void> }).publish = async (record) => { attempted = record; throw new Error("fail"); };
	await wait("failed listener start", assert.rejects(failed.start()));
	assert.ok(attempted);
	assert.equal(failed.status, "idle");
	assert.equal(failed.record, undefined);
	assert.equal(failed.activeConnections, 0);
	await assert.rejects(lstat(attempted.endpoint));
});

test("contains runtime server errors in one fixed cleanup", async (t) => {
	const instance = await listener(t);
	t.after(async () => { await wait("failed listener close", instance.close()); });
	const endpoint = instance.record!.endpoint;
	const controlled = instance as unknown as { server: { close: (callback?: () => void) => unknown; emit: (event: string, error: unknown) => boolean; on: (event: string, listener: () => void) => unknown } };
	const close = controlled.server.close.bind(controlled.server);
	let closes = 0;
	controlled.server.close = (callback) => { closes++; return close(callback); };
	controlled.server.on("error", () => {});
	controlled.server.emit("error", new Error("SECRET server error"));
	controlled.server.emit("error", new Error("SECOND error"));
	await poll("listener failure", () => Boolean(instance.failure));
	await wait("server cleanup", instance.closed);
	assert.equal(instance.failure?.code, "io_error");
	assert.equal(instance.failure?.message, "listener failed");
	assert.equal(instance.status, "failed");
	assert.equal(closes, 1);
	assert.equal(instance.activeConnections, 0);
	await assert.rejects(lstat(endpoint));
	await rejected(instance.registry.resolve("recipient"), "not_found");
});

const clientRejected = (operation: Promise<unknown>, code: string) => assert.rejects(operation, (error: unknown) => error instanceof ActiveSessionClientError && error.code === code);
async function raw(t: TestContext, transport: SessionPresenceRegistry, id: string, reply?: Buffer | null, createdAt?: number) {
	const record = await transport.record(id, createdAt), server = createServer((socket) => { socket.on("error", () => {}); socket.on("data", () => { if (reply !== null) socket.end(reply); }); });
	await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(record.endpoint, resolveListen); });
	await transport.publish(record);
	t.after(async () => { await transport.removeOwn(record); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); });
	return record;
}

test("client delivers one exact notification from its fixed active sender", async (t) => {
	const transport = await registry(t), received: unknown[] = [];
	const sender = new ActiveSessionListener(transport, "sender", async () => {}), recipient = new ActiveSessionListener(transport, "recipient", async (value) => { received.push(value); });
	t.after(() => Promise.all([sender.close(), recipient.close()]));
	await Promise.all([sender.start(), recipient.start()]);
	const client = new ActiveSessionClient(transport, "sender");
	assert.deepEqual(await wait("client accepted", client.sendNotification("recipient", "exact", { id: "outbound-1" })), { id: "outbound-1", accepted: true });
	assert.deepEqual(received, [{ id: "outbound-1", senderSessionId: "sender", message: "exact" }]);
	await clientRejected(client.sendNotification("sender", "self"), "self");
});

test("client pins a selected activation and never connects to its replacement", async (t) => {
	const transport = await registry(t);
	const old = await raw(t, transport, "recipient", undefined, 1);
	const replacement = await raw(t, transport, "recipient", undefined, 2);
	let connects = 0;
	const client = new ActiveSessionClient(transport, "sender", {
		connect: (endpoint) => {
			connects += 1;
			return createConnection(endpoint);
		},
	});
	await clientRejected(client.sendNotification("recipient", "selected", { expectedActivation: old } as never), "stale");
	assert.equal(connects, 0, "a changed registry activation is rejected before opening a socket");
	await clientRejected(client.sendNotification("recipient", "host changed", { expectedActivation: replacement, beforeConnect: () => false }), "stale");
	assert.equal(connects, 0, "a stale host guard is checked after resolution and before connecting");
	assert.deepEqual(await transport.resolve("recipient"), replacement, "the replacement remains intact for a later explicit send");
});

test("client bounds admission and aborts or closes each pending send once", async (t) => {
	const transport = await registry(t), record = await raw(t, transport, "held", null);
	const client = new ActiveSessionClient(transport, "sender"), pre = new AbortController(); pre.abort();
	await clientRejected(client.sendNotification("missing", "x"), "not_found");
	await clientRejected(client.sendNotification("held", "x", { signal: pre.signal }), "aborted");
	const pending = Array.from({ length: 8 }, (_, index) => client.sendNotification(record.sessionId, "x", { id: `held-${index}` }));
	await poll("client admission", () => client.pendingCount === 8);
	await clientRejected(client.sendNotification(record.sessionId, "x"), "busy");
	client.close();
	await Promise.all(pending.map((operation) => clientRejected(operation, "closed")));
	assert.equal(client.pendingCount, 0); assert.equal(client.closed, true);
	await clientRejected(client.sendNotification(record.sessionId, "x"), "closed");
});

test("client enforces bounded deadlines, aborts awaiting ack, and rejects hostile replies", async (t) => {
	const transport = await registry(t), record = await transport.record("seam"); await transport.publish(record);
	t.after(() => transport.removeOwn(record));
	const clock = fakeScheduler(), socket = new Socket(); (socket as unknown as { write: () => boolean }).write = () => true;
	const timeout = new ActiveSessionClient(transport, "sender", { scheduler: clock.scheduler, connect: () => socket, connectDeadlineMs: 1, ackDeadlineMs: 1 });
	const connecting = timeout.sendNotification("seam", "x"); await poll("connect timer", () => clock.size === 1); clock.runAll(); await clientRejected(connecting, "connect_timeout");
	const ackSocket = new Socket(); (ackSocket as unknown as { write: () => boolean }).write = () => true;
	const awaiting = new ActiveSessionClient(transport, "sender", { scheduler: clock.scheduler, connect: () => ackSocket, connectDeadlineMs: 1, ackDeadlineMs: 1 });
	const ack = awaiting.sendNotification("seam", "x"); await poll("ack connect", () => clock.size === 1); ackSocket.emit("connect"); await poll("ack timer", () => clock.size === 1); clock.runAll(); await clientRejected(ack, "ack_timeout");
	const abortSocket = new Socket(); (abortSocket as unknown as { write: () => boolean }).write = () => true;
	const abort = new AbortController(), aborting = new ActiveSessionClient(transport, "sender", { connect: () => abortSocket });
	const aborted = aborting.sendNotification("seam", "x", { signal: abort.signal }); await poll("abort socket", () => abortSocket.listenerCount("error") > 0); abortSocket.emit("connect"); abort.abort(); await clientRejected(aborted, "aborted"); abortSocket.emit("error", new Error("late"));
	for (const [id, reply, code] of [["wrong", encodeAckFrame({ version: 1, kind: "ack", id: "other", accepted: true }), "invalid_ack"], ["malformed", Buffer.from("{\n"), "invalid_ack"], ["trailing", Buffer.concat([encodeAckFrame({ version: 1, kind: "ack", id: "trailing", accepted: true }), Buffer.from("x")]), "invalid_ack"], ["drop", undefined, "invalid_ack"], ["negative", encodeAckFrame({ version: 1, kind: "ack", id: "negative", accepted: false, error: "rejected" }), "remote_rejected"]] as const) {
		await raw(t, transport, id, reply); await clientRejected(new ActiveSessionClient(transport, "sender").sendNotification(id, "x", { id }), code);
	}
});

test("client removes only definitively stale presence and leaves timeout or replacement records", async (t) => {
	const transport = await registry(t), stale = await transport.record("stale", 1); await transport.publish(stale);
	await clientRejected(new ActiveSessionClient(transport, "sender").sendNotification("stale", "x"), "io_error"); await rejected(transport.resolve("stale"), "not_found");
	const old = await transport.record("replaced", 1), newer = await transport.record("replaced", 2); await transport.publish(old);
	const socket = new Socket(), client = new ActiveSessionClient(transport, "sender", { connect: () => socket }), resolve = transport.resolve.bind(transport);
	(transport as unknown as { resolve: () => Promise<PresenceRecord> }).resolve = async () => old;
	const replacing = client.sendNotification("replaced", "x"); await poll("replacement connect", () => socket.listenerCount("error") > 0); await transport.publish(newer); socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
	await clientRejected(replacing, "io_error"); (transport as unknown as { resolve: typeof resolve }).resolve = resolve; assert.deepEqual(await transport.resolve("replaced"), newer);
	const held = await raw(t, transport, "timeout", null), clock = fakeScheduler();
	const timed = new ActiveSessionClient(transport, "sender", { scheduler: clock.scheduler, ackDeadlineMs: 1 }).sendNotification("timeout", "x"); await poll("timeout timer", () => clock.delays.length === 2); clock.runAll(); await clientRejected(timed, "ack_timeout"); assert.deepEqual(await transport.resolve(held.sessionId), held);
});

test("client serializes definitive stale cleanup before its result", async (t) => {
	const transport = await registry(t), record = await transport.record("stale-race"); await transport.publish(record);
	const gate = deferred<void>(), clock = fakeScheduler(), socket = new Socket(); let removals = 0, settled = false;
	(transport as unknown as { removeOwn: () => Promise<void> }).removeOwn = async () => { removals++; await gate.promise; };
	const pending = new ActiveSessionClient(transport, "sender", { scheduler: clock.scheduler, connect: () => socket }).sendNotification("stale-race", "x").finally(() => { settled = true; });
	await poll("stale listener", () => socket.listenerCount("error") > 0 && clock.size === 1);
	socket.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })); socket.emit("error", Object.assign(new Error("again"), { code: "ECONNREFUSED" }));
	assert.equal(removals, 1); assert.equal(clock.size, 0); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, false);
	gate.resolve(); await clientRejected(pending, "io_error");
});

test("client ignores coded stale errors after abort or close", async (t) => {
	const transport = await registry(t), record = await transport.record("late-stale"); await transport.publish(record);
	let removals = 0; (transport as unknown as { removeOwn: () => Promise<void> }).removeOwn = async () => { removals++; };
	for (const action of ["abort", "close"] as const) {
		const socket = new Socket(), controller = new AbortController(), client = new ActiveSessionClient(transport, "sender", { connect: () => socket });
		const pending = client.sendNotification("late-stale", "x", { signal: controller.signal }); await poll(`${action} listener`, () => socket.listenerCount("error") > 0);
		if (action === "abort") controller.abort(); else client.close(); await clientRejected(pending, action === "abort" ? "aborted" : "closed"); socket.emit("error", Object.assign(new Error("late"), { code: "ENOENT" }));
	}
	assert.equal(removals, 0);
});

test("settles partial EOF, socket error, and listener close without leaking admission", async (t) => {
	let calls = 0;
	const instance = await listener(t, async () => { calls++; });
	const clients: ReturnType<typeof createConnection>[] = [];
	t.after(async () => {
		for (const socket of clients) socket.destroy();
		await wait("listener close", instance.close());
	});
	const partial = createConnection(instance.record!.endpoint);
	clients.push(partial);
	partial.on("error", () => {});
	await wait("partial connection", once(partial, "connect"));
	partial.end(Buffer.from('{"version":1'));
	await wait("partial close", once(partial, "close"));
	assert.equal(instance.activeConnections, 0);
	const errored = createConnection(instance.record!.endpoint);
	clients.push(errored);
	errored.on("error", () => {});
	await wait("error connection", once(errored, "connect"));
	const serverSocket = [...instance.sockets][0];
	serverSocket.destroy(new Error("socket failure"));
	await wait("error close", once(errored, "close"));
	assert.equal(instance.activeConnections, 0);
	const held = await Promise.all(Array.from({ length: 2 }, async () => {
		const socket = createConnection(instance.record!.endpoint);
		clients.push(socket);
		socket.on("error", () => {});
		await wait("held connection", once(socket, "connect"));
		return socket;
	}));
	await poll("held connections", () => instance.activeConnections === 2);
	const heldCloses = held.map((socket) => wait("held close", once(socket, "close")));
	await wait("listener close", instance.close());
	await Promise.all(heldCloses);
	assert.equal(instance.activeConnections, 0);
	assert.equal(calls, 0);
});

test("bounds callback deadlines and ignores late settlement", async (t) => {
	const clock = fakeScheduler(), pending = new Map<string, ReturnType<typeof deferred<void>>>(), unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const instance = await listener(t, async (value) => {
		assert.equal(Object.isFrozen(value), true);
		const next = deferred();
		pending.set(value.id, next);
		await next.promise;
	}, { callbackDeadlineMs: 1, scheduler: clock.scheduler });
	t.after(() => instance.close());
	const replies = ["late-resolve", "late-reject"].map((id) => request(instance.record!.endpoint, encodeNotificationFrame({ ...notification(), id, recipientSessionId: "recipient" })));
	await poll("callbacks", () => pending.size === 2);
	assert.deepEqual(clock.delays, [1, 1]);
	clock.runAll();
	assert.deepEqual(await Promise.all(replies.map((reply) => wait("timeout reply", reply))), [
		{ version: 1, kind: "ack", id: "late-resolve", accepted: false, error: "timeout" },
		{ version: 1, kind: "ack", id: "late-reject", accepted: false, error: "timeout" },
	]);
	pending.get("late-resolve")!.resolve();
	pending.get("late-reject")!.reject(new Error("late"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(instance.activeConnections, 0);
	assert.deepEqual(unhandled, []);
	for (const deadline of [0, 2001, 1.5]) assert.throws(() => new ActiveSessionListener(instance.registry, "recipient", async () => {}, { callbackDeadlineMs: deadline } as never));
});

test("rejects active close and concurrent duplicates without a second callback", async (t) => {
	let calls = 0;
	const gate = deferred(), instance = await listener(t, async () => { calls++; await gate.promise; });
	t.after(() => instance.close());
	const frame = encodeNotificationFrame({ ...notification(), id: "duplicate", recipientSessionId: "recipient" });
	const first = request(instance.record!.endpoint, frame);
	await poll("first callback", () => instance.activeConnections === 1);
	assert.deepEqual(await wait("duplicate reply", request(instance.record!.endpoint, frame)), { version: 1, kind: "ack", id: "duplicate", accepted: false, error: "duplicate" });
	assert.equal(calls, 1);
	assert.equal(instance.activeConnections, 1);
	await instance.close();
	assert.equal(await wait("closed request", first), undefined);
	assert.equal(instance.activeConnections, 0);
	gate.resolve();
});

test("retains rejected and timed-out IDs and evicts only the oldest of 64", async (t) => {
	let calls = 0;
	const clock = fakeScheduler(), timeout = deferred();
	const instance = await listener(t, async (value) => { calls++; if (value.id === "reject") throw new Error("no"); if (value.id === "timeout") await timeout.promise; }, { callbackDeadlineMs: 1, scheduler: clock.scheduler });
	t.after(() => instance.close());
	for (const id of ["reject", "timeout"]) {
		const reply = request(instance.record!.endpoint, encodeNotificationFrame({ ...notification(), id, recipientSessionId: "recipient" }));
		if (id === "timeout") { await poll("timeout callback", () => clock.size === 1); clock.runAll(); assert.equal((await reply).error, "timeout"); } else assert.equal((await reply).error, "rejected");
		assert.equal((await request(instance.record!.endpoint, encodeNotificationFrame({ ...notification(), id, recipientSessionId: "recipient" }))).error, "duplicate");
	}
	const lru = await listener(t, async () => { calls++; });
	t.after(() => lru.close());
	for (let id = 0; id < 65; id++) assert.equal((await request(lru.record!.endpoint, encodeNotificationFrame({ ...notification(), id: `evict-${id}`, recipientSessionId: "recipient" }))).accepted, true);
	assert.equal((await request(lru.record!.endpoint, encodeNotificationFrame({ ...notification(), id: "evict-1", recipientSessionId: "recipient" }))).error, "duplicate");
	assert.equal((await request(lru.record!.endpoint, encodeNotificationFrame({ ...notification(), id: "evict-0", recipientSessionId: "recipient" }))).accepted, true);
	assert.equal(calls, 68);
});

type EndpointStat = Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "uid">;
const sameEndpointIdentity = (left: EndpointStat | undefined, right: EndpointStat | undefined) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid);
const endpointCleanupDiagnostic = (kind: "socket" | "file" | "symlink", original: EndpointStat, replacement: EndpointStat | undefined, after: EndpointStat | undefined, endpointAbsentBeforeReplacement: boolean) => JSON.stringify({
	kind,
	originalIdentityEqualsReplacement: sameEndpointIdentity(original, replacement),
	endpointAbsentBeforeReplacement,
	replacementSurvived: after !== undefined,
	afterIdentityMatchesReplacement: sameEndpointIdentity(after, replacement),
});
async function preservesReplacementEndpoint(t: TestContext, kind: "socket" | "file" | "symlink") {
	let replacement: ReturnType<typeof createServer> | undefined;
	let endpoint = "", replacementStat: Awaited<ReturnType<typeof lstat>> | undefined;
	let endpointAbsentBeforeReplacement = false, closeFailed = false;
	const instance = await listener(t, async () => {}, { beforeEndpointCleanup: async () => {
		try { await lstat(endpoint); } catch (error) { endpointAbsentBeforeReplacement = (error as NodeJS.ErrnoException).code === "ENOENT"; }
		if (kind === "socket") {
			const candidate = createServer();
			try {
				await new Promise<void>((resolve, reject) => { candidate.once("error", reject); candidate.listen(endpoint, resolve); });
				candidate.unref();
				replacement = candidate;
				replacementStat = await lstat(endpoint);
			} catch { /* diagnostics below retain only fixed fields */ }
		} else {
			try {
				if (kind === "file") await writeFile(endpoint, "replacement"); else await symlink("replacement", endpoint);
				replacementStat = await lstat(endpoint);
			} catch { /* diagnostics below retain only fixed fields */ }
		}
	} });
	endpoint = instance.record!.endpoint;
	const original = await lstat(endpoint);
	try { await instance.close(); } catch { closeFailed = true; }
	let after: Awaited<ReturnType<typeof lstat>> | undefined;
	try { after = await lstat(endpoint); } catch { /* replacementSurvived remains false */ }
	t.diagnostic(endpointCleanupDiagnostic(kind, original, replacementStat, after, endpointAbsentBeforeReplacement));
	try {
		assert.equal(closeFailed, false);
		assert.equal(original.isSocket(), true, "the listener's original endpoint is a socket");
		assert.ok(replacementStat, "the cleanup seam created a replacement");
		assert.ok(after, "the replacement survives listener cleanup");
		assert.equal(kind === "socket" ? after.isSocket() : kind === "file" ? after.isFile() : after.isSymbolicLink(), true);
		await rejected(instance.registry.resolve("recipient"), "not_found");
	} finally {
		if (replacement) await new Promise<void>((resolve) => replacement!.close(() => resolve()));
	}
}

test("preserves a replacement socket endpoint through listener cleanup", (t) => preservesReplacementEndpoint(t, "socket"));
test("preserves a replacement file endpoint through listener cleanup", (t) => preservesReplacementEndpoint(t, "file"));
test("preserves a replacement symlink endpoint through listener cleanup", (t) => preservesReplacementEndpoint(t, "symlink"));
test("removes an untouched own socket endpoint", async (t) => {
	const instance = await listener(t);
	const endpoint = instance.record!.endpoint;
	await instance.close();
	await assert.rejects(lstat(endpoint));
	await rejected(instance.registry.resolve("recipient"), "not_found");
});

test("waits for an invalidated delayed startup before closing", async (t) => {
	const transport = await registry(t), candidate = await transport.record("recipient"), gate = deferred<PresenceRecord>();
	let records = 0, closed = false;
	(transport as unknown as { record: (sessionID: string) => Promise<PresenceRecord> }).record = async () => { records++; return gate.promise; };
	const instance = new ActiveSessionListener(transport, "recipient", async () => {});
	const start = instance.start(), closing = instance.close().then(() => { closed = true; });
	t.after(async () => { gate.resolve(candidate); await Promise.allSettled([start, closing]); await instance.close(); });
	await poll("delayed record", () => records === 1);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(closed, false);
	gate.resolve(candidate);
	await assert.rejects(wait("invalidated start", start), (error: unknown) => error instanceof SessionPresenceError && error.code === "io_error");
	await wait("delayed close", closing);
	assert.equal(instance.status, "closed");
	assert.equal(instance.record, undefined);
	await assert.rejects(lstat(candidate.endpoint));
	await rejected(transport.resolve("recipient"), "not_found");
});

test("rolls back a delayed publish after a runtime server failure", async (t) => {
	const transport = await registry(t), gate = deferred<void>();
	const publish = transport.publish.bind(transport);
	let attempted: PresenceRecord | undefined, publishes = 0;
	(transport as unknown as { publish: (record: PresenceRecord) => Promise<void> }).publish = async (record) => { attempted = record; publishes++; await gate.promise; await publish(record); };
	const instance = new ActiveSessionListener(transport, "recipient", async () => {});
	const start = instance.start();
	t.after(async () => { gate.resolve(); await Promise.allSettled([start]); await instance.close(); });
	await poll("delayed publish", () => Boolean(attempted));
	const controlled = instance as unknown as { server: { emit: (event: string, error: unknown) => boolean } };
	controlled.server.emit("error", new Error("server failed"));
	await poll("startup failure", () => Boolean(instance.failure));
	gate.resolve();
	await assert.rejects(wait("failed delayed publish", start), (error: unknown) => error instanceof SessionPresenceError && error.code === "io_error");
	await wait("failed cleanup", instance.closed);
	assert.equal(publishes, 1);
	assert.equal(instance.status, "failed");
	assert.equal(instance.record, undefined);
	await assert.rejects(lstat(attempted!.endpoint));
	await rejected(transport.resolve("recipient"), "not_found");
});

test("shares concurrent starts through one record, listen, and publish", async (t) => {
	const transport = await registry(t);
	const record = transport.record.bind(transport), publish = transport.publish.bind(transport);
	let records = 0, publishes = 0;
	(transport as unknown as { record: (sessionID: string) => Promise<PresenceRecord> }).record = async (sessionID) => { records++; return record(sessionID); };
	(transport as unknown as { publish: (value: PresenceRecord) => Promise<void> }).publish = async (value) => { publishes++; await publish(value); };
	const instance = new ActiveSessionListener(transport, "recipient", async () => {});
	t.after(() => instance.close());
	await wait("concurrent starts", Promise.all([instance.start(), instance.start()]));
	assert.equal(records, 1);
	assert.equal(publishes, 1);
	assert.equal(instance.status, "active");
	const endpoint = instance.record!.endpoint;
	await instance.close();
	await assert.rejects(lstat(endpoint));
	await rejected(transport.resolve("recipient"), "not_found");
});

test("shares concurrent close through delayed final cleanup", async (t) => {
	const gate = deferred<void>();
	let cleanupCalls = 0, firstDone = false, secondDone = false;
	const instance = await listener(t, async () => {}, { beforeEndpointCleanup: async () => { cleanupCalls++; await gate.promise; } });
	const held = createConnection(instance.record!.endpoint);
	held.on("error", () => {});
	await wait("held connection", once(held, "connect"));
	t.after(async () => { gate.resolve(); held.destroy(); await instance.close(); });
	const endpoint = instance.record!.endpoint;
	const first = instance.close().then(() => { firstDone = true; });
	const second = instance.close().then(() => { secondDone = true; });
	await poll("delayed cleanup", () => cleanupCalls === 1);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(firstDone, false);
	assert.equal(secondDone, false);
	assert.equal(instance.activeConnections, 0);
	gate.resolve();
	await Promise.all([wait("first close", first), wait("second close", second)]);
	assert.equal(cleanupCalls, 1);
	assert.equal(instance.status, "closed");
	await assert.rejects(lstat(endpoint));
	await rejected(instance.registry.resolve("recipient"), "not_found");
});
