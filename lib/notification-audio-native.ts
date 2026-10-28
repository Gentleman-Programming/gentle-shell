/**
 * Bridge to the owned native PulseAudio worker. Original MIT (repo-licensed).
 *
 * Design contract: this module performs no IO on import or construction. It has
 * no module-level import of the stream, audio, context, config-owner or
 * extension graph (an `audio -> bridge` import is fine; the reverse is not). The
 * only execution surface is an explicit `probe()`/`play()` that spawns the owned
 * worker as a Node child with fixed literal flags and a scrubbed environment.
 * Linux only; macOS/Windows never spawn. No real audio, no real Pulse stream
 * beyond the worker's own fake-test sockets; there is no physical-playback claim.
 *
 * Playback persistence: plays share ONE long-lived `serve` worker per bridge
 * instance (line-delimited JSON over stdin, one bounded envelope per play).
 * A crashed worker is replaced by a fresh spawn on the next play; abort,
 * timeout, a malformed serve line and `dispose()` all SIGKILL it once and
 * settle only on `close`. Requests are serialized through the worker with a
 * bounded pending queue. Teardown is the owner's `dispose()` (session shutdown),
 * plus the worker's own stdin-EOF exit when the owner process dies.
 */
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

export const NATIVE_PULSE_SCHEMA = "gentle.audio.pulse/v1";
export const NATIVE_PULSE_WORKER_URL = new URL("./notification-pulse-worker.ts", import.meta.url);
const FIXED_NODE_FLAGS = ["--experimental-strip-types", "--max-old-space-size=32"] as const;
const MAX_STDOUT = 1024;
const MAX_STDERR = 4096;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;
/** 10 s maximum validated duration plus a 1 s termination margin; must outlive every accepted sound. */
const DEFAULT_PLAY_TIMEOUT_MS = 11000;
/** Bounded pending plays per serve worker (1 active + queue), mirroring the repo's small caps. */
const MAX_PENDING_PLAYS = 8;

export interface NativePulseProbeResult { readonly available: boolean; readonly formats: readonly ("wav")[]; }
export interface NativePulseSpawnOptions {
	readonly shell: false;
	readonly windowsHide: true;
	readonly detached: false;
	readonly stdio: readonly ("ignore" | "pipe")[];
	readonly env: NodeJS.ProcessEnv;
}
export interface NativePulseChild {
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	stdin: { write(chunk: string): boolean } | null;
	kill(signal: string): boolean;
	once(event: string, listener: (...args: unknown[]) => void): EventEmitter;
}
export interface NativePulseOptions {
	platform?: string;
	spawn?: (executable: string, args: string[], options: NativePulseSpawnOptions) => NativePulseChild;
	workerPath?: string;
	env?: NodeJS.ProcessEnv;
	probeTimeoutMs?: number;
	playTimeoutMs?: number;
	setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> | number;
	clearTimeout?: (handle: ReturnType<typeof setTimeout> | number) => void;
}

interface Envelope { schema?: unknown; ok?: unknown; available?: unknown; formats?: unknown; played?: unknown; }
interface RunResult { readonly stdout: string; readonly stderr: string; readonly aborted: boolean; readonly timedOut: boolean; }
/** One queued/active play through the persistent serve worker. */
interface ServeRequest {
	readonly snapshot: string;
	readonly signal: AbortSignal | undefined;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout> | number;
	onAbort?: () => void;
	aborted: boolean;
	timedOut: boolean;
	settled: boolean;
}
interface ServeWorker {
	readonly child: NativePulseChild;
	line: string;
	active?: ServeRequest;
	readonly queued: ServeRequest[];
	dead: boolean;
}

/** Distinct from other native failures so the owner can treat a false permit as "not started". */
export class NativePulseNotPermittedError extends Error {
	constructor() { super("Native pulse: playback not permitted"); this.name = "NativePulseNotPermittedError"; }
}

function unrefTimer(handle: ReturnType<typeof setTimeout> | number): void { (handle as { unref?: () => void }).unref?.(); }
function abortError(): Error { const error = new Error("Native pulse: aborted"); error.name = "AbortError"; return error; }
function defaultSpawn(executable: string, args: string[], options: NativePulseSpawnOptions): NativePulseChild {
	// SAFETY: Node's ChildProcess exposes stdout/stderr/stdin/once/kill compatible with the narrower NativePulseChild interface; the cast only bridges that structural narrowing.
	return spawn(executable, args, { ...options, stdio: [...options.stdio] }) as unknown as NativePulseChild;
}
function parseEnvelope(stdout: string): Envelope | undefined {
	const text = stdout.trim();
	if (text.length === 0 || text.includes("\n")) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as Envelope;
		return record.schema === NATIVE_PULSE_SCHEMA ? record : undefined;
	} catch { return undefined; }
}

export class NativePulsePlayer {
	private readonly options: NativePulseOptions;
	private readonly setTimer: NonNullable<NativePulseOptions["setTimeout"]>;
	private readonly clearTimer: NonNullable<NativePulseOptions["clearTimeout"]>;
	private formats: readonly ("wav")[] = [];
	private worker?: ServeWorker;

	constructor(options: NativePulseOptions = {}) {
		this.options = { ...options };
		this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	supportsTarget(): boolean { return (this.options.platform ?? process.platform) === "linux"; }
	getNativeFormats(): readonly ("wav")[] { return this.formats; }

	private workerPath(): string { return this.options.workerPath ?? fileURLToPath(NATIVE_PULSE_WORKER_URL); }

	/**
	 * Child env is an allowlist: only Pulse Unix/runtime/localization vars survive;
	 * API keys, cloud credentials, debug overlays, NODE_OPTIONS/NODE_PATH and PATH
	 * are dropped. process.execPath and the snapshot are absolute and TCP is denied,
	 * so no PATH resolution is needed.
	 */
	private childEnv(): NodeJS.ProcessEnv {
		const source = this.options.env ?? process.env;
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "PULSE_SERVER", "PULSE_COOKIE", "LANG", "LC_ALL", "LC_CTYPE"])
			if (source[key] !== undefined) env[key] = source[key];
		env.NODE_NO_WARNINGS = "1";
		env.GENTLE_PI_AGENTS_CHILD = "1";
		return env;
	}

	/** Spawns synchronously; resolves ONLY on the child `close` event (never exit/error/kill). */
	private run(signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
		return new Promise<RunResult>(resolve => {
			const args = [...FIXED_NODE_FLAGS, this.workerPath(), "probe"];
			const child = (this.options.spawn ?? defaultSpawn)(process.execPath, args, {
				shell: false, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"], env: this.childEnv(),
			});
			let stdout = ""; let stderr = ""; let killed = false; let aborted = false; let timedOut = false;
			const kill = () => { if (!killed) { killed = true; try { child.kill("SIGKILL"); } catch { /* keep waiting for close */ } } };
			const cleanup = () => { this.clearTimer(timer); signal?.removeEventListener("abort", onAbort); child.stdout?.removeListener("data", onStdout); child.stderr?.removeListener("data", onStderr); };
			const onStdout = (chunk: unknown) => { stdout += String(chunk); if (stdout.length > MAX_STDOUT) kill(); };
			const onStderr = (chunk: unknown) => { if (stderr.length < MAX_STDERR) stderr += String(chunk).slice(0, MAX_STDERR - stderr.length); };
			const onAbort = () => { aborted = true; kill(); };
			const timer = this.setTimer(() => { timedOut = true; kill(); }, timeoutMs);
			unrefTimer(timer);
			child.stdout?.on("data", onStdout);
			child.stderr?.on("data", onStderr);
			signal?.addEventListener("abort", onAbort, { once: true });
			child.once("close", () => { cleanup(); resolve({ stdout, stderr, aborted, timedOut }); });
			child.once("error", () => { /* Node emits close after spawn errors; keep waiting */ });
			if (signal?.aborted) onAbort();
		});
	}

	private parseProbe(stdout: string): NativePulseProbeResult {
		const envelope = parseEnvelope(stdout);
		if (!envelope || envelope.ok !== true || typeof envelope.available !== "boolean" || !Array.isArray(envelope.formats))
			return { available: false, formats: [] };
		const hasWav = envelope.formats.some(value => value === "wav");
		return envelope.available && hasWav ? { available: true, formats: ["wav"] } : { available: false, formats: [] };
	}

	/** Offline/malformed/unsupported probe resolves unavailable; it never throws private IPC. */
	async probe(signal?: AbortSignal): Promise<NativePulseProbeResult> {
		if (!this.supportsTarget() || signal?.aborted) { this.formats = []; return { available: false, formats: [] }; }
		const result = await this.run(signal, this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
		const parsed = result.aborted || result.timedOut ? { available: false, formats: [] as const } : this.parseProbe(result.stdout);
		this.formats = parsed.available ? ["wav"] : [];
		return parsed;
	}

	/** Spawns or reuses the persistent `serve` worker. A dead worker is replaced by a fresh spawn. */
	private ensureWorker(): ServeWorker {
		if (this.worker && !this.worker.dead) return this.worker;
		const child = (this.options.spawn ?? defaultSpawn)(process.execPath, [...FIXED_NODE_FLAGS, this.workerPath(), "serve"], {
			shell: false, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"], env: this.childEnv(),
		});
		const worker: ServeWorker = { child, line: "", queued: [], dead: false };
		this.worker = worker;
		child.stdout?.on("data", chunk => this.onServeStdout(worker, chunk));
		child.stderr?.on("data", () => { /* drained: a full stderr pipe must never stall the worker */ });
		child.once("close", () => this.closeWorker(worker));
		child.once("error", () => { /* Node emits close after spawn errors; keep waiting */ });
		return worker;
	}

	private armGuards(request: ServeRequest): void {
		const timer = this.setTimer(() => { request.timedOut = true; this.killWorker(); },
			this.options.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS);
		unrefTimer(timer);
		request.timer = timer;
		request.onAbort = () => { request.aborted = true; this.killWorker(); };
		request.signal?.addEventListener("abort", request.onAbort, { once: true });
		if (request.signal?.aborted) request.onAbort();
	}

	private settleSuccess(request: ServeRequest): void {
		if (request.settled) return;
		request.settled = true;
		if (request.timer !== undefined) this.clearTimer(request.timer);
		if (request.onAbort) request.signal?.removeEventListener("abort", request.onAbort);
		request.resolve();
	}

	/** Private failure: aborted requests reject with the abort error, everything else with the generic one. */
	private settleFailure(request: ServeRequest): void {
		if (request.settled) return;
		request.settled = true;
		if (request.timer !== undefined) this.clearTimer(request.timer);
		if (request.onAbort) request.signal?.removeEventListener("abort", request.onAbort);
		request.reject(request.aborted ? abortError() : new Error("Native pulse playback failed"));
	}

	/** SIGKILL once; the pending plays settle on the child `close` event (never exit/error/kill). */
	private killWorker(): void {
		const worker = this.worker;
		if (!worker || worker.dead) return;
		worker.dead = true;
		try { worker.child.kill("SIGKILL"); } catch { /* close still settles every pending play */ }
	}

	private closeWorker(worker: ServeWorker): void {
		worker.dead = true;
		if (this.worker === worker) this.worker = undefined;
		for (const request of [worker.active, ...worker.queued]) if (request) this.settleFailure(request);
		worker.active = undefined;
		worker.queued.length = 0;
	}

	private dispatch(worker: ServeWorker, request: ServeRequest): void {
		if (worker.dead) { this.settleFailure(request); return; }
		worker.active = request;
		const stdin = worker.child.stdin;
		if (!stdin) { this.killWorker(); return; }
		try { stdin.write(`${JSON.stringify({ schema: NATIVE_PULSE_SCHEMA, op: "play", path: request.snapshot })}\n`); }
		catch { this.killWorker(); }
	}

	private onServeStdout(worker: ServeWorker, chunk: unknown): void {
		worker.line += String(chunk);
		for (;;) {
			const index = worker.line.indexOf("\n");
			if (index === -1) break;
			const line = worker.line.slice(0, index);
			worker.line = worker.line.slice(index + 1);
			const envelope = parseEnvelope(line);
			if (!envelope) { this.killWorker(); return; } // Protocol violation: `close` settles every pending play.
			const request = worker.active;
			worker.active = undefined;
			if (envelope.ok === true && envelope.played === true) { if (request) this.settleSuccess(request); }
			else if (request) this.settleFailure(request); // A private ok:false leaves the worker serviceable.
			const next = worker.queued.shift();
			if (next) this.dispatch(worker, next);
		}
		if (worker.line.length > MAX_STDOUT) this.killWorker(); // Unterminated envelope line over the bound.
	}

	/** `gate` (permit or predicate) runs synchronously before any spawn/write; false means no child at all.
	 *  Plays serialize through one persistent worker; extras wait in a bounded queue. */
	async play(snapshot: string, signal?: AbortSignal, gate?: (() => boolean) | { permit(): boolean }): Promise<void> {
		if (!this.supportsTarget()) throw new Error("Native pulse: unsupported platform");
		if (signal?.aborted) throw abortError();
		const permitted = typeof gate === "function" ? gate() : gate?.permit();
		if (permitted === false) throw new NativePulseNotPermittedError();
		return new Promise<void>((resolve, reject) => {
			const worker = this.ensureWorker();
			const request: ServeRequest = { snapshot, signal, resolve, reject, aborted: false, timedOut: false, settled: false };
			if (worker.active) {
				if (worker.queued.length >= MAX_PENDING_PLAYS) { reject(new Error("Native pulse: too many pending plays")); return; }
				this.armGuards(request);
				worker.queued.push(request);
				return;
			}
			this.armGuards(request);
			this.dispatch(worker, request);
		});
	}

	/** Owner teardown: SIGKILL the persistent worker once and settle every pending play. */
	dispose(): void {
		const worker = this.worker;
		this.worker = undefined;
		if (!worker) return;
		worker.dead = true;
		try { worker.child.kill("SIGKILL"); } catch { /* the child is already gone */ }
		for (const request of [worker.active, ...worker.queued]) if (request) this.settleFailure(request);
		worker.active = undefined;
		worker.queued.length = 0;
	}
}
