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

export interface NativePulseProbeResult { readonly available: boolean; readonly formats: readonly ("wav")[]; }
export interface NativePulseSpawnOptions {
	readonly shell: false;
	readonly windowsHide: true;
	readonly detached: false;
	readonly stdio: readonly ["ignore", "pipe", "pipe"];
	readonly env: NodeJS.ProcessEnv;
}
export interface NativePulseChild {
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
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

/** Distinct from other native failures so the owner can treat a false permit as "not started". */
export class NativePulseNotPermittedError extends Error {
	constructor() { super("Native pulse: playback not permitted"); this.name = "NativePulseNotPermittedError"; }
}

function unrefTimer(handle: ReturnType<typeof setTimeout> | number): void { (handle as { unref?: () => void }).unref?.(); }
function abortError(): Error { const error = new Error("Native pulse: aborted"); error.name = "AbortError"; return error; }
function defaultSpawn(executable: string, args: string[], options: NativePulseSpawnOptions): NativePulseChild {
	const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
	// SAFETY: Node's ChildProcess exposes stdout/stderr/once/kill compatible with the narrower NativePulseChild interface; the cast only bridges that structural narrowing.
	return spawn(executable, args, { ...options, stdio }) as unknown as NativePulseChild;
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
	private run(mode: "probe" | "play", snapshot: string | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
		return new Promise<RunResult>(resolve => {
			const args = [...FIXED_NODE_FLAGS, this.workerPath(), mode];
			if (snapshot !== undefined) args.push(snapshot);
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
		const result = await this.run("probe", undefined, signal, this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
		const parsed = result.aborted || result.timedOut ? { available: false, formats: [] as const } : this.parseProbe(result.stdout);
		this.formats = parsed.available ? ["wav"] : [];
		return parsed;
	}

	/** `gate` (permit or predicate) runs synchronously before spawn; false means no child at all. */
	async play(snapshot: string, signal?: AbortSignal, gate?: (() => boolean) | { permit(): boolean }): Promise<void> {
		if (!this.supportsTarget()) throw new Error("Native pulse: unsupported platform");
		if (signal?.aborted) throw abortError();
		const permitted = typeof gate === "function" ? gate() : gate?.permit();
		if (permitted === false) throw new NativePulseNotPermittedError();
		const result = await this.run("play", snapshot, signal, this.options.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS);
		if (result.aborted) throw abortError();
		const envelope = parseEnvelope(result.stdout);
		if (result.timedOut || !envelope || envelope.ok !== true || envelope.played !== true) throw new Error("Native pulse playback failed");
	}
}
