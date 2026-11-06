/**
 * PulseAudio native-protocol v13 local client: Unix transport, AUTH (zero
 * cookie fallback for trusted local peer credentials), SET_CLIENT_NAME and a
 * read-only GET_SERVER_INFO capability probe. Original MIT (repo-licensed)
 * implementation derived from the official protocol declaration only; no
 * PulseAudio/LGPL implementation code is copied.
 *
 * Reference (read-only, PulseAudio v17.0): PROTOCOL, src/pulsecore/native-common.h,
 * src/pulsecore/protocol-native.c, src/pulse/context.c. See
 * odd/tasks/native-audio-backend.md for the verified wire tables.
 *
 * Lazy by construction: import and construction perform no IO. Only an explicit
 * connect()/probe() opens the Unix socket. No stream creation, no samples, no
 * ancillary FDs/SHM, no TCP, no cookies logged or written.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { userInfo } from "node:os";
import {
	CONTROL_CHANNEL, MAX_CONTROL_PAYLOAD, NATIVE_PROTOCOL_VERSION, PulseCommand, PulseTagWriter,
	boundedPulseFrameDecoder, boundedPulseTagReader, boundedPulseTagWriter, encodePulseFrame,
	type PulseFrame, type PulseTagReader,
} from "./notification-pulse-protocol.ts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 900;
/** Cap for one control request/DRAIN: 10 s maximum validated duration plus a 1 s termination margin. */
export const MAX_REQUEST_TIMEOUT_MS = 11000;
export const MAX_PENDING_REQUESTS = 32;
export const PULSE_COOKIE_BYTES = 256;

/** Server-to-client notifications that are safe to ignore silently. */
const BENIGN_EVENTS = new Set<number>([62, 63, 64, 65, 76, 77, 78, 79, 86, 94, 95]);

export class PulseCookieError extends Error {
	constructor() { super("Pulse client: invalid cookie"); this.name = "PulseCookieError"; }
}

function abortError(): Error { const error = new Error("Pulse client: aborted"); error.name = "AbortError"; return error; }
function unrefTimer(handle: ReturnType<typeof setTimeout> | number): void { (handle as { unref?: () => void }).unref?.(); }

/** Absolute literal only: no URLs, TCP, lists, CWD/`~`/env expansion, spaces, commas, NUL or control chars. */
function hasControlOrSeparator(value: string): boolean {
	for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code <= 0x1f || code === 0x7f) return true; }
	return /[\s,~$%]/.test(value);
}
function literalAbsolutePath(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/") || hasControlOrSeparator(value)
		|| value.split("/").some(segment => segment === "." || segment === ".."))
		throw new Error("Pulse client: invalid path");
	return value;
}

function currentUid(): number {
	try { return userInfo().uid; } catch { throw new Error("Pulse client: no user id"); }
}

export function resolvePulseSocketPath(env: NodeJS.ProcessEnv = {}, uid?: number): string {
	const server = env.PULSE_SERVER;
	if (server !== undefined && server !== "") {
		if (!server.startsWith("unix:") && !server.startsWith("/")) throw new Error("Pulse client: unsupported server address");
		return literalAbsolutePath(server.startsWith("unix:") ? server.slice(5) : server);
	}
	const runtime = env.XDG_RUNTIME_DIR;
	if (runtime) return literalAbsolutePath(`${runtime}/pulse/native`);
	return `/run/user/${uid ?? currentUid()}/pulse/native`;
}

export function resolvePulseCookiePath(env: NodeJS.ProcessEnv = {}): string | undefined {
	const cookie = env.PULSE_COOKIE;
	if (cookie) return literalAbsolutePath(cookie);
	const configHome = env.XDG_CONFIG_HOME;
	if (configHome) return `${literalAbsolutePath(configHome)}/pulse/cookie`;
	const home = env.HOME;
	if (home) return `${home}/.config/pulse/cookie`;
	return undefined;
}

/** Missing file (ENOENT only) yields a zero cookie; every other failure is a cookie error. */
export async function loadPulseCookie(path: string | undefined, signal?: AbortSignal): Promise<Buffer> {
	if (signal?.aborted) throw abortError();
	if (!path) return Buffer.alloc(PULSE_COOKIE_BYTES);
	let handle: FileHandle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(PULSE_COOKIE_BYTES);
		throw new PulseCookieError();
	}
	try {
		if (signal?.aborted) throw abortError();
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size !== PULSE_COOKIE_BYTES) throw new PulseCookieError();
		const buffer = Buffer.alloc(PULSE_COOKIE_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, PULSE_COOKIE_BYTES + 1, 0);
		if (signal?.aborted) throw abortError();
		if (bytesRead !== PULSE_COOKIE_BYTES) throw new PulseCookieError();
		return Buffer.from(buffer.subarray(0, PULSE_COOKIE_BYTES));
	} finally {
		await handle.close().catch(() => { /* close failure must not mask the outcome */ });
	}
}

export interface PulseClientOptions {
	env?: NodeJS.ProcessEnv;
	uid?: number;
	socketPath?: string;
	cookiePath?: string | null;
	cookie?: Buffer;
	connectTimeoutMs?: number;
	requestTimeoutMs?: number;
	setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> | number;
	clearTimeout?: (handle: ReturnType<typeof setTimeout> | number) => void;
}
export interface PulseProbeResult { readonly available: boolean; readonly formats: readonly ("wav")[]; }
export interface PulseServerInfo {
	readonly name: string;
	readonly version: string;
	readonly defaultSink: string | null;
	readonly defaultSource: string | null;
	readonly cookie: number;
}
interface PendingRequest { resolve(reader: PulseTagReader): void; reject(error: Error): void; cleanup(): void; }

export class PulseClient {
	private readonly options: PulseClientOptions;
	private readonly decoder = boundedPulseFrameDecoder();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly listeners = new Set<(command: number, reader: PulseTagReader) => void>();
	private socket?: Socket;
	private tagCounter = 0;
	private failed?: Error;
	private closed = false;
	private closing = false;
	private negotiatedVersion?: number;
	private info?: PulseServerInfo;
	private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> | number;
	private readonly clearTimer: (handle: ReturnType<typeof setTimeout> | number) => void;
	private readonly sendWaiters = new Set<(error: Error) => void>();

	constructor(options: PulseClientOptions = {}) {
		this.options = { ...options };
		this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	get protocolVersion(): number | undefined { return this.negotiatedVersion; }
	get serverDetails(): PulseServerInfo | undefined { return this.info; }

	/** Private callback registry; no EventEmitter, no global listeners. */
	onEvent(listener: (command: number, reader: PulseTagReader) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.socket) throw new Error("Pulse client: already connected");
		if (signal?.aborted) throw abortError();
		const path = this.options.socketPath ? literalAbsolutePath(this.options.socketPath)
			: resolvePulseSocketPath(this.options.env ?? {}, this.options.uid);
		const socket = netConnect({ path });
		this.socket = socket;
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const cleanup = () => { this.clearTimer(timer); socket.off("connect", onConnect); socket.off("error", onError); signal?.removeEventListener("abort", onAbort); };
				const onConnect = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
				const onError = () => { if (!settled) { settled = true; cleanup(); reject(new Error("Pulse client: connection failed")); } };
				const onAbort = () => { if (!settled) { settled = true; cleanup(); socket.destroy(); reject(abortError()); } };
				const timer = this.setTimer(() => { if (!settled) { settled = true; cleanup(); socket.destroy(); reject(new Error("Pulse client: connection timed out")); } }, this.options.connectTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
				unrefTimer(timer);
				socket.once("connect", onConnect); socket.once("error", onError);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
			});
		} catch (error) {
			this.socket = undefined; this.failed = error as Error; socket.destroy(); throw error;
		}
		socket.setNoDelay(true);
		socket.on("data", chunk => this.handleData(chunk));
		socket.on("error", () => this.fail(new Error("Pulse client: connection error")));
		socket.on("close", () => this.fail(new Error("Pulse client: connection closed")));
	}

	private handleData(chunk: Buffer): void {
		try { for (const frame of this.decoder.push(chunk)) this.dispatch(frame); }
		catch { this.fail(new Error("Pulse client: protocol error")); }
	}

	private take(tag: number): PendingRequest | undefined {
		const pending = this.pending.get(tag);
		if (!pending) return undefined;
		this.pending.delete(tag);
		pending.cleanup();
		return pending;
	}

	private dispatch(frame: PulseFrame): void {
		if (frame.channel !== CONTROL_CHANNEL) { this.fail(new Error("Pulse client: unexpected frame channel")); return; }
		let command: number; let tag: number; let reader: PulseTagReader;
		try { const parsed = boundedPulseTagReader(frame.payload); command = parsed.u32(); tag = parsed.u32(); reader = parsed; }
		catch { this.fail(new Error("Pulse client: malformed reply")); return; }
		if (command === PulseCommand.REPLY) {
			const pending = this.take(tag);
			if (!pending) { this.fail(new Error("Pulse client: unmatched reply")); return; }
			pending.resolve(reader); return;
		}
		if (command === PulseCommand.ERROR || command === PulseCommand.TIMEOUT) {
			const pending = this.take(tag);
			this.fail(new Error("Pulse client: server error"));
			pending?.reject(new Error("Pulse client: server error")); return;
		}
		if (command === PulseCommand.REQUEST) {
			for (const listener of this.listeners) { try { listener(command, reader); } catch { /* listener failures never break the transport */ } }
			return;
		}
		if (BENIGN_EVENTS.has(command)) return;
		this.fail(new Error("Pulse client: unexpected command"));
	}

	private fail(error: Error): void {
		if (this.failed) return;
		this.failed = error;
		const pendings = [...this.pending.values()];
		this.pending.clear();
		for (const pending of pendings) { pending.cleanup(); pending.reject(error); }
		this.listeners.clear();
		const waiters = [...this.sendWaiters];
		this.sendWaiters.clear();
		for (const rejectWaiter of waiters) rejectWaiter(error);
		if (this.socket && !this.closing && !this.socket.destroyed) this.socket.destroy();
	}

	request(command: number, args: Buffer | PulseTagWriter, signal?: AbortSignal, timeoutMs?: number): Promise<PulseTagReader> {
		if (this.failed) return Promise.reject(this.failed);
		if (!this.socket || this.closing || this.closed) return Promise.reject(new Error("Pulse client: not connected"));
		if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("Pulse client: too many pending requests"));
		if (!Number.isInteger(command) || command < 0 || command > 0xffffffff) return Promise.reject(new Error("Pulse client: invalid command"));
		const tag = (this.tagCounter = (this.tagCounter + 1) >>> 0);
		const argsBuffer = args instanceof PulseTagWriter ? args.finish() : args;
		const prefix = boundedPulseTagWriter().u32(command).u32(tag).finish();
		if (prefix.length + argsBuffer.length > MAX_CONTROL_PAYLOAD) return Promise.reject(new Error("Pulse client: request too large"));
		const payload = Buffer.concat([prefix, argsBuffer]);
		const socket = this.socket;
		return new Promise<PulseTagReader>((resolve, reject) => {
			if (signal?.aborted) { reject(abortError()); return; }
			let timer: ReturnType<typeof setTimeout> | number;
			const onAbort = () => { const pending = this.take(tag); pending?.reject(abortError()); };
			const pending: PendingRequest = {
				resolve, reject,
				cleanup: () => { this.clearTimer(timer); signal?.removeEventListener("abort", onAbort); },
			};
			const bounded = Math.min(timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);
			timer = this.setTimer(() => {
				const active = this.take(tag);
				if (active) { active.reject(new Error("Pulse client: request timed out")); this.fail(new Error("Pulse client: request timed out")); }
			}, bounded);
			unrefTimer(timer);
			this.pending.set(tag, pending);
			signal?.addEventListener("abort", onAbort, { once: true });
			try { socket.write(encodePulseFrame({ channel: CONTROL_CHANNEL, offset: 0n, flags: 0 }, payload)); }
			catch { this.take(tag)?.reject(new Error("Pulse client: write failed")); }
		});
	}

	/** Reserved for N2 PCM writes; resolves once queued/drained or rejects on timeout/abort/close. */
	sendDataFrame(channel: number, payload: Uint8Array, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
		if (this.failed) return Promise.reject(this.failed);
		if (!this.socket || this.closing || this.closed) return Promise.reject(new Error("Pulse client: not connected"));
		let encoded: Buffer;
		try { encoded = encodePulseFrame({ channel, offset: 0n, flags: 0 }, payload); }
		catch (error) { return Promise.reject(error as Error); }
		const socket = this.socket;
		if (socket.write(encoded)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const bounded = Math.min(timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);
			const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(); };
			const onDrain = () => finish();
			const onAbort = () => finish(abortError());
			const waiter = (error: Error) => finish(error);
			const timer = this.setTimer(() => finish(new Error("Pulse client: send timed out")), bounded);
			unrefTimer(timer);
			const cleanup = () => { this.clearTimer(timer); socket.off("drain", onDrain); this.sendWaiters.delete(waiter); signal?.removeEventListener("abort", onAbort); };
			this.sendWaiters.add(waiter);
			socket.once("drain", onDrain);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	/** AUTH v13 with the given 256-byte cookie (zero bytes when no cookie exists), then SET_CLIENT_NAME. */
	async authenticate(cookie: Buffer, options: { name?: string; type?: string } = {}, signal?: AbortSignal): Promise<number> {
		if (!Buffer.isBuffer(cookie) || cookie.length !== PULSE_COOKIE_BYTES) throw new Error("Pulse client: invalid cookie length");
		const reply = await this.request(PulseCommand.AUTH, boundedPulseTagWriter().u32(NATIVE_PROTOCOL_VERSION).arbitrary(cookie), signal);
		const version = reply.u32() & 0xffff;
		if (version < NATIVE_PROTOCOL_VERSION) throw new Error("Pulse client: unsupported server version");
		reply.assertEOF();
		this.negotiatedVersion = version;
		const properties = boundedPulseTagWriter().proplist([
			["application.name", options.name ?? "gentle-shell"],
			["application.type", options.type ?? "notification"],
		]);
		const named = await this.request(PulseCommand.SET_CLIENT_NAME, properties, signal);
		named.u32(); // client_index
		named.assertEOF();
		return version;
	}

	/** v13 GET_SERVER_INFO: no channel_map at the negotiated version. `user`/`host` are discarded, never logged. */
	async serverInfo(signal?: AbortSignal): Promise<PulseServerInfo> {
		const reply = await this.request(PulseCommand.GET_SERVER_INFO, Buffer.alloc(0), signal);
		const name = this.requiredString(reply);
		const version = this.requiredString(reply);
		reply.string();
		reply.string();
		reply.sampleSpec();
		const defaultSink = reply.string();
		const defaultSource = reply.string();
		const cookie = reply.u32();
		reply.assertEOF();
		this.info = { name, version, defaultSink, defaultSource, cookie };
		return this.info;
	}

	private requiredString(reader: PulseTagReader): string {
		const value = reader.string();
		if (value === null) throw new Error("Pulse client: missing server field");
		return value;
	}

	private async loadCookie(signal?: AbortSignal): Promise<Buffer> {
		if (this.options.cookie) return this.options.cookie;
		const path = this.options.cookiePath === null ? undefined : (this.options.cookiePath ?? resolvePulseCookiePath(this.options.env ?? {}));
		return loadPulseCookie(path, signal);
	}

	/** Read-only capability probe: no stream, no samples, no activation, no UI. */
	async probe(signal?: AbortSignal): Promise<PulseProbeResult> {
		try {
			await this.connect(signal);
			const cookie = this.options.cookie ?? await this.loadCookie(signal);
			await this.authenticate(cookie, {}, signal);
			const info = await this.serverInfo(signal);
			const available = typeof info.defaultSink === "string" && info.defaultSink.length > 0;
			return { available, formats: available ? (["wav"] as const) : ([] as const) };
		} finally {
			await this.close();
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true; this.closing = true;
		const pendings = [...this.pending.values()];
		this.pending.clear();
		for (const pending of pendings) { pending.cleanup(); pending.reject(new Error("Pulse client: closed")); }
		this.listeners.clear();
		const waiters = [...this.sendWaiters];
		this.sendWaiters.clear();
		for (const rejectWaiter of waiters) rejectWaiter(new Error("Pulse client: closed"));
		this.failed ??= new Error("Pulse client: closed");
		const socket = this.socket;
		this.socket = undefined;
		if (!socket || socket.destroyed) return;
		await new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.destroy(); });
	}
}
