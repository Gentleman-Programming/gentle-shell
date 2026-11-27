// A tiny HTTP client for the `gentle-shell serve` tests: JSON or raw calls,
// SSE streams that collect their text, device pairing, and HTTPS over a pinned
// socket. Plus what keeps those tests from hanging a run: `test`, `before` and
// `after` with a default timeout, and the teardown of tests that start
// sessions: the session keepers (and their Pi) a test leaves running, and
// ending them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import nodeTest, { after as nodeAfter, before as nodeBefore } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ServeScope } from "../lib/serve-auth.ts";
import { keeperAlive, readKeeperRecords } from "../lib/serve-session-keeper.ts";

/**
 * Serve tests run servers, keepers and child processes and wait on their
 * streams: a wait that never ends fails the test after this long instead of
 * hanging the whole run (a test without a timeout waits forever). A test or
 * hook may still pass its own `timeout`.
 */
export const SERVE_TEST_TIMEOUT_MS = 60_000;

export function test(name: string, fn: nodeTest.TestFn): Promise<void>;
export function test(name: string, options: nodeTest.TestOptions, fn: nodeTest.TestFn): Promise<void>;
export function test(name: string, optionsOrFn: nodeTest.TestOptions | nodeTest.TestFn, fn?: nodeTest.TestFn): Promise<void> {
	const [options, body] = typeof optionsOrFn === "function" ? [{}, optionsOrFn] : [optionsOrFn, fn];
	return nodeTest(name, { timeout: SERVE_TEST_TIMEOUT_MS, ...options }, body);
}

export function before(fn: nodeTest.HookFn, options: nodeTest.HookOptions = {}): void {
	nodeBefore(fn, { timeout: SERVE_TEST_TIMEOUT_MS, ...options });
}

export function after(fn: nodeTest.HookFn, options: nodeTest.HookOptions = {}): void {
	nodeAfter(fn, { timeout: SERVE_TEST_TIMEOUT_MS, ...options });
}

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));

/** A process a test left running. */
export interface Leftover { pid: number; command: string }

interface ProcessRow extends Leftover { ppid: number }

function processTable(): ProcessRow[] {
	return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").flatMap((line) => {
		const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : [];
	});
}

/**
 * What a test's serve folders left running: the live keepers their session
 * records (`<serve dir>/sessions`) name, the keepers and fake Pis this process
 * started itself (a server without a serve folder keeps its records in a
 * private temp folder; a keeper run in-process starts its fake Pi here), and
 * the Pi each keeper runs, plus every process whose command line names one of
 * `roots` (a server daemon, or a fake Pi started with `--home <root>/agent`).
 * A keeper is matched by its recorded pid or its parent, and its entry point,
 * so a reused pid is never taken for one. Windows has no `ps`: there only
 * recorded keepers of running sessions that are alive count.
 */
function serveLeftovers(sessionDirs: readonly string[], roots: readonly string[] = []): Leftover[] {
	const records = sessionDirs.flatMap((dir) => readKeeperRecords(dir));
	if (process.platform === "win32") {
		return records.filter((record) => record.state === "running" && keeperAlive(record.keeperPid)).map((record) => ({ pid: record.keeperPid, command: `session keeper ${record.id}` }));
	}
	const recorded = new Set(records.map((record) => record.keeperPid));
	const table = processTable();
	const keepers = new Set(table.filter((row) => (recorded.has(row.pid) || row.ppid === process.pid) && row.command.includes("serve-session-keeper-main")).map((row) => row.pid));
	return table
		.filter((row) => row.pid !== process.pid && (keepers.has(row.pid) || keepers.has(row.ppid) || (row.ppid === process.pid && row.command.includes(FAKE_PI)) || roots.some((root) => row.command.includes(root))))
		.map(({ pid, command }) => ({ pid, command }));
}

/**
 * The guard that ends a suite: what `serveLeftovers` still finds once the
 * processes on their way out had `graceMs` to go (a keeper exits just after
 * its server has seen its session end).
 */
export async function remainingServeLeftovers(sessionDirs: readonly string[], roots: readonly string[] = [], graceMs = 5000): Promise<Leftover[]> {
	const deadline = Date.now() + graceMs;
	let leftovers = serveLeftovers(sessionDirs, roots);
	while (leftovers.length > 0 && Date.now() < deadline) {
		await sleep(50);
		leftovers = serveLeftovers(sessionDirs, roots);
	}
	return leftovers;
}

/**
 * The teardown of tests that start sessions: kills what `serveLeftovers` finds
 * and waits until it is gone, so no keeper outlives the run (a keeper with no
 * server stops its session only after a day). Returns what it ended.
 */
export async function endServeLeftovers(sessionDirs: readonly string[], roots: readonly string[] = []): Promise<Leftover[]> {
	const leftovers = serveLeftovers(sessionDirs, roots);
	for (const { pid } of leftovers) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
	const deadline = Date.now() + 5000;
	while (leftovers.some(({ pid }) => keeperAlive(pid)) && Date.now() < deadline) await sleep(20);
	return leftovers;
}

export interface Reply { status: number; body: any; headers: IncomingMessage["headers"]; bytes: Buffer }

export function call(base: string, method: string, path: string, options: { token?: string; body?: unknown; raw?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Reply> {
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
	const req = httpRequest(`${base}${path}`, {
		method,
		agent: false,
		headers: {
			...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
			...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			...options.headers,
		},
	}, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			const bytes = Buffer.concat(chunks);
			let body: unknown = bytes.toString("utf8");
			try { body = JSON.parse(body as string); } catch { /* not JSON */ }
			resolve({ status: res.statusCode ?? 0, body, headers: res.headers, bytes });
		});
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}

/** An open SSE stream; `text` grows as events arrive. */
export interface Stream { status: number; text: string; closed: Promise<void>; waitFor(what: string | RegExp): Promise<void>; close(): void }

export function stream(base: string, path: string, token?: string, headers: Record<string, string> = {}): Promise<Stream> {
	const { promise, resolve, reject } = Promise.withResolvers<Stream>();
	const req = httpRequest(`${base}${path}`, { agent: false, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
		const closed = Promise.withResolvers<void>();
		const waiters: Array<{ what: string | RegExp; done: () => void }> = [];
		const has = (what: string | RegExp) => (typeof what === "string" ? s.text.includes(what) : what.test(s.text));
		const s: Stream = {
			status: res.statusCode ?? 0,
			text: "",
			closed: closed.promise,
			waitFor(what) {
				if (has(what)) return Promise.resolve();
				const w = Promise.withResolvers<void>();
				waiters.push({ what, done: w.resolve });
				return w.promise;
			},
			close: () => req.destroy(),
		};
		res.on("data", (c: Buffer) => {
			s.text += c.toString("utf8");
			for (const w of [...waiters]) if (has(w.what)) { waiters.splice(waiters.indexOf(w), 1); w.done(); }
		});
		res.on("close", () => closed.resolve());
		resolve(s);
	});
	req.on("error", (error) => { if (!(error as NodeJS.ErrnoException).code?.startsWith("ECONNRESET")) reject(error); });
	req.end();
	return promise;
}

export async function pairDevice(base: string, admin: string, scopes: ServeScope[], name = "device"): Promise<{ id: string; token: string }> {
	const code = await call(base, "POST", "/api/pairing-codes", { token: admin, body: { scopes } });
	assert.equal(code.status, 201);
	const paired = await call(base, "POST", "/api/pair", { body: { code: code.body.code, name } });
	assert.equal(paired.status, 201, JSON.stringify(paired.body));
	return { id: paired.body.id, token: paired.body.token };
}

/** One HTTPS request over a connection that is already open and pinned (directly, or through a relay). */
export function callOver(socket: Socket, method: string, path: string, options: { token?: string; body?: unknown; host?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
	// The Host header as given (host:port included): the request options would bracket a host holding a colon.
	const req = httpsRequest({ createConnection: () => socket, method, path, headers: {
		Host: options.host ?? "127.0.0.1",
		...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
		...(payload === undefined ? {} : { "Content-Type": "application/json" }),
		...options.headers,
	} }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			const bytes = Buffer.concat(chunks);
			let body: unknown = bytes.toString("utf8");
			try { body = JSON.parse(body as string); } catch { /* not JSON */ }
			resolve({ status: res.statusCode ?? 0, body, headers: res.headers, bytes });
		});
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}
