import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nodeTest from "node:test";
import type { TestContext } from "node:test";
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

const fixture = resolve("tests/fixtures/agents-session-transport-process.mjs");
const CONTROL_BYTES = 16_384;
const WAIT_MS = 2_000;

type Reply = { requestId: string; ok: boolean; result?: Record<string, unknown>; error?: string };
type Callback = { event: "callback"; requestId: string; pid: number; id: string; senderSessionId: string; message: string };
type Pending = { timer: ReturnType<typeof setTimeout>; settled: boolean; resolve: (reply: Reply) => void; reject: (error: Error) => void };
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type SpawnedProcess = EventEmitter & {
	pid?: number | undefined;
	stdin: (NodeJS.WritableStream & EventEmitter) | null;
	stdout: (NodeJS.ReadableStream & EventEmitter) | null;
	stderr: (NodeJS.ReadableStream & EventEmitter) | null;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals): boolean;
};
type SpawnProcess = (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => SpawnedProcess;
const defaultSpawn: SpawnProcess = (command, args, options) => spawn(command, args, options);

class MemoryProcess extends EventEmitter implements SpawnedProcess {
	pid = undefined;
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	kill(): boolean {
		this.exitCode = 0;
		this.emit("exit", 0, null);
		this.emit("close", 0, null);
		return true;
	}
}

const memorySpawn: SpawnProcess = () => new MemoryProcess();

const bounded = async <T>(label: string, operation: Promise<T>) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), WAIT_MS); })]); }
	finally { if (timer) clearTimeout(timer); }
};

function child(agentHome: string, spawnProcess: SpawnProcess = defaultSpawn) {
	const process = spawnProcess(globalThis.process.execPath, ["--experimental-strip-types", fixture], {
		env: { GENTLE_AGENT_HOME: agentHome }, stdio: ["pipe", "pipe", "pipe"],
	});
	const replies = new Map<string, Pending>();
	const callbacks: Callback[] = [];
	const termination: { term?: boolean; kill?: boolean } = {};
	let sequence = 0, exited = false, closed = false, spawnFailed = false, readerClosed = false;
	let resolveExit!: (exit: Exit) => void, exitResolved = false;
	const exitedPromise = new Promise<Exit>((resolve) => { resolveExit = resolve; });
	const settleExit = (exit: Exit) => { if (!exitResolved) { exitResolved = true; resolveExit(exit); } };
	const terminal = () => exited || closed || spawnFailed || process.exitCode !== null || process.signalCode !== null;
	const failure = () => new Error(spawnFailed ? "child spawn failed" : "child exited before response");
	const settle = (pending: Pending, error?: Error, reply?: Reply) => {
		if (pending.settled) return;
		pending.settled = true;
		clearTimeout(pending.timer);
		for (const [requestId, current] of replies) if (current === pending) replies.delete(requestId);
		if (error) pending.reject(error); else pending.resolve(reply!);
	};
	const rejectAll = (error: Error) => { for (const pending of [...replies.values()]) settle(pending, error); };
	let partial = Buffer.alloc(0);
	const closeReader = () => {
		if (readerClosed) return;
		readerClosed = true;
		partial = Buffer.alloc(0);
		process.stdout?.off("data", onOutput);
		process.stdout?.off("error", onReaderError);
		process.stderr?.pause();
	};
	const onReaderError = () => rejectAll(new Error("child output failed"));
	const receive = (bytes: Buffer) => {
		let message: Reply | Callback;
		try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Reply | Callback; }
		catch { rejectAll(new Error("child output frame invalid")); return; }
		if ("event" in message) {
			if (callbacks.length === 64) { rejectAll(new Error("child event queue exceeds bound")); closeReader(); return; }
			callbacks.push(message);
		} else {
			const pending = replies.get(message.requestId);
			if (pending) settle(pending, undefined, message);
		}
	};
	const onOutput = (chunk: Buffer) => {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
			const fragment = chunk.subarray(start, end);
			if (partial.length + fragment.length > CONTROL_BYTES) { rejectAll(new Error("child output frame exceeds bound")); closeReader(); return; }
			if (newline < 0) { partial = Buffer.concat([partial, fragment]); return; }
			receive(partial.length ? Buffer.concat([partial, fragment]) : fragment);
			partial = Buffer.alloc(0);
			start = newline + 1;
		}
	};
	process.stdout!.on("data", onOutput);
	process.stdout!.on("error", onReaderError);
	process.stdin!.on("error", (error) => rejectAll(error));
	process.stderr!.resume();
	process.once("error", (error) => { spawnFailed = true; rejectAll(error); closeReader(); settleExit({ code: null, signal: null }); });
	process.once("exit", (code, signal) => { exited = true; rejectAll(failure()); closeReader(); settleExit({ code, signal }); });
	process.once("close", (code, signal) => { closed = true; rejectAll(failure()); closeReader(); settleExit({ code, signal }); });
	const command = (operation: string, values: Record<string, unknown> = {}) => {
		if (terminal()) return Promise.reject(failure());
		const requestId = `request-${++sequence}`, frame = JSON.stringify({ requestId, operation, ...values });
		assert.ok(Buffer.byteLength(frame) <= CONTROL_BYTES, "fixture control frame must stay bounded");
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const pending: Pending = { settled: false, timer: undefined as never, resolve: (reply) => reply.ok ? resolve(reply.result!) : reject(new Error(`fixture ${operation} failed: ${reply.error}`)), reject };
			pending.timer = setTimeout(() => settle(pending, new Error(`timed out waiting for ${operation}`)), WAIT_MS);
			replies.set(requestId, pending);
			try { process.stdin!.write(`${frame}\n`, (error) => { if (error) settle(pending, error); }); }
			catch (error) { settle(pending, error instanceof Error ? error : new Error("child input failed")); }
		});
	};
	const callback = (id: string) => bounded(`callback ${id}`, new Promise<Callback>((resolve, reject) => {
		const found = () => callbacks.find((event) => event.requestId === id);
		const existing = found();
		if (existing) { resolve(existing); return; }
		const interval = setInterval(() => { const event = found(); if (event) { clearInterval(interval); clearTimeout(timeout); resolve(event); } }, 5);
		const timeout = setTimeout(() => { clearInterval(interval); reject(new Error(`callback ${id} was not observed`)); }, WAIT_MS);
	}));
	const terminate = async () => {
		if (terminal()) return;
		await command("shutdown").catch(() => {});
		if (terminal()) return;
		process.stdin!.end();
		await bounded("child graceful exit", exitedPromise);
	};
	return { process, command, callback, terminate, exited: terminal, exitedPromise, pendingCount: () => replies.size, raw: (frame: string) => process.stdin!.write(frame), termination };
}

test("stdin EPIPE rejects the pending command without escaping the transport helper", async (t: TestContext) => {
	const owned = child("fixture", memorySpawn);
	const expected = Object.assign(new Error("fixture EPIPE"), { code: "EPIPE" });
	const pending = owned.command("pending");
	const observed = pending.then(() => undefined, (error) => error);
	let primary: unknown;
	try {
		assert.doesNotThrow(() => owned.process.stdin!.emit("error", expected), "stdin EPIPE must be handled by the transport helper");
		assert.strictEqual(await bounded("EPIPE command rejection", observed), expected, "the pending command receives the stdin error instance");
		assert.equal(owned.pendingCount(), 0, "stdin failure drains pending commands");
	} catch (error) {
		primary = error;
	} finally {
		const lateErrors: Error[] = [];
		const onStdinError = (error: Error) => { lateErrors.push(error); };
		owned.process.stdin!.on("error", onStdinError);
		try {
			owned.process.stdin!.end();
			owned.process.emit("exit", 1, null);
			owned.process.emit("close", 1, null);
			await bounded("memory transport command settlement", observed);
			await bounded("memory transport pending drain", (async () => {
				while (owned.pendingCount() !== 0) await new Promise((resolve) => setImmediate(resolve));
			})());
			assert.deepEqual(lateErrors, [], "cleanup must not emit an additional stdin error");
		} catch (error) {
			if (primary === undefined) primary = error;
			else t.diagnostic(`EPIPE cleanup secondary failure: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			owned.process.stdin!.off("error", onStdinError);
		}
	}
	if (primary !== undefined) throw primary;
});

async function ensureStopped(owned: ReturnType<typeof child>) {
	if (owned.exited()) return;
	try { await owned.terminate(); return; } catch {}
	const signal = (name: "SIGTERM" | "SIGKILL") => {
		if (owned.exited()) return true;
		let delivered = false;
		try { delivered = owned.process.kill(name); } catch {}
		if (name === "SIGTERM") owned.termination.term = delivered; else owned.termination.kill = delivered;
		if (!delivered && !owned.exited()) throw new Error(`owned child ${name} was not delivered`);
		return delivered;
	};
	signal("SIGTERM");
	try { await bounded("child TERM exit", owned.exitedPromise); return; } catch {}
	signal("SIGKILL");
	await bounded("child KILL exit", owned.exitedPromise);
}

const absent = async (path: string) => assert.rejects(lstat(path));
async function withChild(run: (owned: ReturnType<typeof child>) => Promise<void>) {
	const agentHome = await mkdtemp(join(tmpdir(), "ga-x-")), owned = child(agentHome);
	try { await run(owned); } finally { await ensureStopped(owned); await rm(agentHome, { recursive: true, force: true }); }
}

test("independent Node children exchange transport notifications and clean only their own activations", async () => {
	const agentHome = await mkdtemp(join(tmpdir(), "ga-x-"));
	assert.ok(Buffer.byteLength(agentHome) <= 100, "fresh test agentHome must be a short Unix path");
	const children: ReturnType<typeof child>[] = [];
	try {
		const alpha = child(agentHome), beta = child(agentHome);
		children.push(alpha, beta);
		const alphaRecord = await alpha.command("start", { sessionId: "alpha" });
		const betaRecord = await beta.command("start", { sessionId: "beta" });
		assert.notEqual(alpha.process.pid, beta.process.pid, "children must be independent processes");
		assert.deepEqual(await alpha.command("send", { recipientSessionId: "beta", id: "alpha-to-beta", message: "from alpha" }), { id: "alpha-to-beta", accepted: true });
		assert.deepEqual(await beta.command("send", { recipientSessionId: "alpha", id: "beta-to-alpha", message: "from beta" }), { id: "beta-to-alpha", accepted: true });
		assert.deepEqual(await beta.callback("alpha-to-beta"), { event: "callback", requestId: "alpha-to-beta", pid: beta.process.pid, id: "alpha-to-beta", senderSessionId: "alpha", message: "from alpha" });
		assert.deepEqual(await alpha.callback("beta-to-alpha"), { event: "callback", requestId: "beta-to-alpha", pid: alpha.process.pid, id: "beta-to-alpha", senderSessionId: "beta", message: "from beta" });
		const betaStopped = await beta.command("stop");
		await absent(betaStopped.presencePath as string); await absent(betaStopped.endpoint as string);
		const newerAlpha = await beta.command("start", { sessionId: "alpha" });
		const alphaStopped = await alpha.command("stop");
		await absent(alphaStopped.presencePath as string); await absent(alphaStopped.endpoint as string);
		assert.deepEqual(await beta.command("resolve", { sessionId: "alpha" }), newerAlpha, "old owner shutdown must preserve newer same-session activation");
		const betaFinal = await beta.command("stop");
		await absent(betaFinal.presencePath as string); await absent(betaFinal.endpoint as string);
		assert.ok(alphaRecord.endpoint && betaRecord.endpoint, "child start evidence includes exact owned endpoints");
	} finally { await Promise.all(children.map(ensureStopped)); await rm(agentHome, { recursive: true, force: true }); }
});

test("clears pending commands on timeout, late reply, and child exit", () => withChild(async (owned) => {
	await assert.rejects(owned.command("delay", { delayMs: WAIT_MS + 100 }), /timed out waiting for delay/);
	assert.equal(owned.pendingCount(), 0, "timed-out commands must not retain reply entries");
	assert.deepEqual(await owned.command("delay", { delayMs: 0 }), { delayed: true }, "late replies must not block later commands");
	assert.equal(owned.pendingCount(), 0, "late replies must not recreate a pending entry");
	await assert.rejects(owned.command("exit"), /child exited before response/);
	assert.equal(owned.pendingCount(), 0, "child exit must reject and clear every pending request");
}));

test("rejects oversized unterminated fixture control input before unbounded buffering", () => withChild(async (owned) => {
	owned.raw("x".repeat(CONTROL_BYTES + 1));
	assert.deepEqual(await bounded("oversized fixture exit", owned.exitedPromise), { code: 2, signal: null });
}));

test("records retained-child TERM fallback only before observed exit", () => withChild(async (owned) => {
	await owned.command("block-shutdown");
	await ensureStopped(owned);
	assert.equal(owned.termination.term, true, "retained child received the recorded TERM fallback");
	assert.equal(owned.exited(), true, "fallback waits for the retained child exit");
}));
