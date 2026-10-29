/**
 * Standalone Windows WAV playback adapter. Original MIT (repo-licensed).
 *
 * Design contract: construction and import perform no IO. The only execution
 * surface is an explicit `probe()`/`play()` that spawns the fixed system
 * PowerShell host with a fixed, trusted `-EncodedCommand` script and a scrubbed
 * environment. The snapshot path is never interpolated into the command: it is
 * base64-encoded and decoded inside the script, so no snapshot byte can become
 * command text. Native Windows and the derived WSL Windows-interop target only;
 * plain macOS/Linux never spawn. It is now the default native route: the pure,
 * IO-free `createDefaultNotificationBackend` selects it for `win32` and for a
 * `linux` process with a valid WSL interop env (P3), and a validated WSL
 * snapshot is mapped to the derived `\\wsl.localhost\<distro>\...` UNC. No
 * physical playback is claimed here.
 *
 * P2 (implemented): `supportsTarget()` also accepts the WSL Windows-interop
 * target (Linux platform + a valid `WSL_DISTRO_NAME` + `/run/WSL/*_interop`).
 * The fixed host is `/mnt/c/.../powershell.exe`, never resolved through `PATH`,
 * `SystemRoot` or a runtime WSL path translation; a non-`/mnt/c` mount fails closed.
 * `play()` maps the validated POSIX snapshot to the single derived
 * `\\wsl.localhost\<distro>\...` UNC form; an externally supplied UNC path is
 * never admitted and `isWindowsAbsolutePath()` still rejects every UNC path.
 */
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { NativePulseNotPermittedError } from "./notification-audio-native.ts";

export const NATIVE_WINDOWS_SCHEMA = "gentle.audio.windows/v1";
/**
 * Trusted, frozen PowerShell executable. This literal intentionally duplicates
 * `FIXED_WINDOWS_POWERSHELL` in `lib/windows-session-transport.ts`: importing
 * that module would drag the agents-session-transport/SDK graph into the audio
 * path. It is a trust anchor, never derived from `SystemRoot`, `windir`, `PATH`
 * or config, so a hostile environment cannot redirect the executable.
 */
export const FIXED_WINDOWS_POWERSHELL_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
/** P1 supports only the default system root; a non-default root fails closed. */
const FIXED_WINDOWS_ROOT = "C:\\Windows";
/**
 * Trusted WSL interop host: the fixed Windows PowerShell reached through the
 * default `/mnt/c` automount. Like the native literal it is a trust anchor, never
 * derived from `PATH`, an injected executable or a runtime WSL path translation. A
 * non-`/mnt/c` mount or a custom Windows root is not reachable here and fails
 * closed at the `probe()` access check (documented P2 limitation).
 */
export const WSL_WINDOWS_POWERSHELL_EXE = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
/** Fixed UNC host that maps a WSL distro filesystem into the Windows namespace. */
export const WSL_UNC_HOST = "wsl.localhost";
const WSL_INTEROP_PREFIX = "/run/WSL/";
const WSL_INTEROP_SUFFIX = "_interop";
/** Characters Windows forbids in a UNC share/distro component. */
const RESERVED_COMPONENT = /[<>:"/\\|?*]/;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
const FIXED_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"] as const;
/** Windows runtime vars only; PATH, NODE_OPTIONS/NODE_PATH, debug and credentials are dropped. */
const WINDOWS_ENV_ALLOWLIST = ["TEMP", "TMP", "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH"] as const;
const MAX_STDOUT = 1024;
const MAX_STDERR = 4096;
const MAX_SNAPSHOT_PATH = 4096;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;
/** 10 s maximum validated duration plus a 1 s termination margin; must outlive every accepted sound. */
const DEFAULT_PLAY_TIMEOUT_MS = 11000;

/** A fixed probe script: it only proves the .NET SoundPlayer type is loadable and prints one line. */
const PROBE_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"try {",
	"  $type = [System.Media.SoundPlayer]",
	"  if ($null -eq $type) { throw 'unavailable' }",
	`  [Console]::Out.WriteLine('{"schema":"${NATIVE_WINDOWS_SCHEMA}","ok":true,"available":true,"formats":["wav"]}')`,
	"} catch {",
	`  [Console]::Out.WriteLine('{"schema":"${NATIVE_WINDOWS_SCHEMA}","ok":false,"available":false,"formats":[]}')`,
	"}",
].join("\n");

/**
 * A fixed play script whose only dynamic value is a base64 string literal,
 * decoded at runtime. The decoded path is never command text. The snapshot is
 * read into a bounded byte buffer, the file handle is released before playback,
 * and the bytes are played through a `MemoryStream`-backed `SoundPlayer`.
 * Forcing the memory constructor is deliberate: the file-URI
 * `SoundPlayer(string)` path reaches a WinMM `PlaySound(fileName)` branch that
 * can report success without audible output, while the memory constructor drives
 * the documented in-memory branch. Every failure prints the same schema-valid
 * `played:false` line; no raw path byte enters the command.
 */
function playScript(encodedPath: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"$file = $null",
		"$memory = $null",
		"$player = $null",
		"try {",
		`  $bytes = [Convert]::FromBase64String('${encodedPath}')`,
		"  $path = [Text.Encoding]::UTF8.GetString($bytes)",
		"  $file = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
		"  $count = $file.Length",
		"  if ($count -lt 44 -or $count -gt 2097152) { throw 'snapshot size' }",
		"  $raw = [byte[]]::new([int]$count)",
		"  $read = 0",
		"  while ($read -lt $count) {",
		"    $step = $file.Read($raw, $read, $count - $read)",
		"    if ($step -le 0) { throw 'snapshot short read' }",
		"    $read += $step",
		"  }",
		"  if ($file.ReadByte() -ne -1) { throw 'snapshot grew' }",
		"  $file.Close()",
		"  $file = $null",
		"  $memory = [IO.MemoryStream]::new($raw)",
		"  $player = [System.Media.SoundPlayer]::new($memory)",
		"  $player.Load()",
		"  $player.PlaySync()",
		`  [Console]::Out.WriteLine('{"schema":"${NATIVE_WINDOWS_SCHEMA}","ok":true,"played":true}')`,
		"} catch {",
		`  [Console]::Out.WriteLine('{"schema":"${NATIVE_WINDOWS_SCHEMA}","ok":false,"played":false}')`,
		"} finally {",
		"  if ($null -ne $player) { $player.Dispose() }",
		"  if ($null -ne $memory) { $memory.Dispose() }",
		"  if ($null -ne $file) { $file.Dispose() }",
		"}",
	].join("\n");
}

export interface NativeWindowsProbeResult { readonly available: boolean; readonly formats: readonly ("wav")[]; }
export interface NativeWindowsSpawnOptions {
	readonly shell: false;
	readonly windowsHide: true;
	readonly detached: false;
	readonly stdio: readonly ["ignore", "pipe", "pipe"];
	readonly env: NodeJS.ProcessEnv;
}
export interface NativeWindowsChild {
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	kill(signal: string): boolean;
	once(event: string, listener: (...args: unknown[]) => void): EventEmitter;
}
export interface NativeWindowsOptions {
	platform?: string;
	spawn?: (executable: string, args: string[], options: NativeWindowsSpawnOptions) => NativeWindowsChild;
	env?: NodeJS.ProcessEnv;
	executableAvailable?(path: string): Promise<boolean>;
	probeTimeoutMs?: number;
	playTimeoutMs?: number;
	setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> | number;
	clearTimeout?: (handle: ReturnType<typeof setTimeout> | number) => void;
}

interface Envelope { schema?: unknown; ok?: unknown; available?: unknown; formats?: unknown; played?: unknown; }
interface RunResult { readonly stdout: string; readonly stderr: string; readonly aborted: boolean; readonly timedOut: boolean; readonly code: number | null; readonly overflowed: boolean; }
/** The native Windows host or the derived WSL Windows-interop host; nothing else is supported. */
type ResolvedTarget = { readonly kind: "win32" } | { readonly kind: "wsl"; readonly distro: string };

/** Normalize a stream chunk to bytes so the byte cap and the unicode-safe decode stay exact. */
function toBuffer(chunk: unknown): Buffer {
	if (Buffer.isBuffer(chunk)) return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	return Buffer.from(String(chunk), "utf8");
}

function unrefTimer(handle: ReturnType<typeof setTimeout> | number): void { (handle as { unref?: () => void }).unref?.(); }
function abortError(): Error { const error = new Error("Native Windows: aborted"); error.name = "AbortError"; return error; }
function privateFailure(): Error { return new Error("Native Windows: playback failed"); }
function defaultSpawn(executable: string, args: string[], options: NativeWindowsSpawnOptions): NativeWindowsChild {
	const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
	// SAFETY: Node's ChildProcess exposes stdout/stderr/once/kill compatible with the narrower NativeWindowsChild interface; the cast only bridges that structural narrowing.
	return spawn(executable, args, { ...options, stdio }) as unknown as NativeWindowsChild;
}
function parseEnvelope(stdout: string): Envelope | undefined {
	const text = stdout.trim();
	if (text.length === 0 || text.includes("\n")) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as Envelope;
		return record.schema === NATIVE_WINDOWS_SCHEMA ? record : undefined;
	} catch { return undefined; }
}

/**
 * A distro/UNC component may be Unicode and contain spaces, but never the
 * reserved set, control bytes or the `.`/`..` traversal names.
 */
function isValidUncComponent(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
	if (value === "." || value === "..") return false;
	return !CONTROL_BYTES.test(value) && !RESERVED_COMPONENT.test(value);
}

/** `/run/WSL/<id>_interop`, absolute and traversal-free; the real path is never logged. */
function isSafeWslInteropPath(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith(WSL_INTEROP_PREFIX) || !value.endsWith(WSL_INTEROP_SUFFIX)) return false;
	if (value.length > MAX_SNAPSHOT_PATH) return false;
	if (CONTROL_BYTES.test(value) || /[\s\\:]/.test(value)) return false;
	if (value.includes("//")) return false;
	for (const segment of value.split("/")) if (segment === "." || segment === "..") return false;
	return true;
}

/** Pure WSL Windows-interop detection: a valid distro name plus the interop socket path. No IO. */
export function isWslTarget(env: NodeJS.ProcessEnv): boolean {
	return isValidUncComponent(env.WSL_DISTRO_NAME) && isSafeWslInteropPath(env.WSL_INTEROP);
}

/**
 * A WSL snapshot must be a POSIX-absolute, privately owned path. Control bytes,
 * backslashes, colons (drive/alternate-stream/URI), ambiguous `//` and `.`/`..`
 * traversal segments are denied so the later UNC mapping cannot cross the distro
 * share or smuggle in a Windows drive path.
 */
export function isWslPosixAbsolutePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_SNAPSHOT_PATH) return false;
	if (!value.startsWith("/")) return false;
	if (CONTROL_BYTES.test(value) || /[\\:]/.test(value)) return false;
	if (value.includes("//")) return false;
	for (const segment of value.split("/")) if (segment === "." || segment === "..") return false;
	return true;
}

/**
 * Pure mapping to the single derived UNC form `\\wsl.localhost\<distro>\...`.
 * The caller supplies a validated POSIX snapshot, never an externally provided
 * UNC path, and the distro name is re-validated as a UNC component.
 */
export function toWslUncPath(distro: unknown, posixPath: unknown): string | undefined {
	if (!isValidUncComponent(distro) || !isWslPosixAbsolutePath(posixPath)) return undefined;
	const unc = `\\\\${WSL_UNC_HOST}\\${distro}\\${posixPath.slice(1).split("/").join("\\")}`;
	return unc.length <= MAX_SNAPSHOT_PATH ? unc : undefined;
}

/**
 * Only a drive-absolute Windows path reaches the native script. URI schemes,
 * drive-relative paths, control bytes, alternate data streams and every UNC
 * share are denied; WSL snapshots are POSIX paths mapped by `toWslUncPath`.
 */
export function isWindowsAbsolutePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_SNAPSHOT_PATH) return false;
	if (/[\u0000-\u001f\u007f]/.test(value)) return false;
	if (value.startsWith("\\\\") || value.startsWith("//")) return false;
	if (!/^[A-Za-z]:\\/.test(value)) return false;
	if (value.indexOf(":", 2) !== -1) return false; // no URI scheme and no alternate data stream
	return true;
}

/**
 * Structural equivalent of the routing module's `NativeAudioBackend` (kept local
 * to avoid an `audio -> windows` import cycle). It reuses the shared
 * `NativePulseNotPermittedError` so the outer owner can treat a false permit as
 * "not started" exactly like the Linux bridge.
 */
export class NativeWindowsPlayer {
	private readonly options: NativeWindowsOptions;
	private readonly setTimer: NonNullable<NativeWindowsOptions["setTimeout"]>;
	private readonly clearTimer: NonNullable<NativeWindowsOptions["clearTimeout"]>;
	private formats: readonly ("wav")[] = [];

	constructor(options: NativeWindowsOptions = {}) {
		this.options = { ...options };
		this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	supportsTarget(): boolean { return this.resolveTarget() !== undefined; }
	getNativeFormats(): readonly ("wav")[] { return this.formats; }

	/** Pure, IO-free target resolution from the injected platform/env. */
	private resolveTarget(): ResolvedTarget | undefined {
		const platform = this.options.platform ?? process.platform;
		if (platform === "win32") return { kind: "win32" };
		const source = this.options.env ?? process.env;
		if (platform === "linux" && isWslTarget(source)) return { kind: "wsl", distro: source.WSL_DISTRO_NAME! };
		return undefined;
	}

	/** Fixed trust anchor per target: the native literal or the fixed `/mnt/c` interop literal. */
	private executablePath(target: ResolvedTarget): string {
		return target.kind === "wsl" ? WSL_WINDOWS_POWERSHELL_EXE : FIXED_WINDOWS_POWERSHELL_EXE;
	}

	/**
	 * Child env is a fixed allowlist: only Windows runtime/localization vars
	 * survive, `SystemRoot`/`windir` are forced to the trusted default root, and
	 * PATH, NODE_OPTIONS/NODE_PATH, debug overlays and every credential are
	 * dropped. The WSL interop target adds only `WSL_INTEROP`/`WSL_DISTRO_NAME`,
	 * which a scrubbed child needs so the Windows process can reach `/init`. No
	 * snapshot travels through the environment, so no `WSLENV` entry is needed or
	 * preserved.
	 */
	private childEnv(target: ResolvedTarget): NodeJS.ProcessEnv {
		const source = this.options.env ?? process.env;
		const env: NodeJS.ProcessEnv = {};
		for (const key of WINDOWS_ENV_ALLOWLIST)
			if (source[key] !== undefined) env[key] = source[key];
		env.SystemRoot = FIXED_WINDOWS_ROOT;
		env.windir = FIXED_WINDOWS_ROOT;
		if (target.kind === "wsl") {
			env.WSL_INTEROP = source.WSL_INTEROP;
			env.WSL_DISTRO_NAME = source.WSL_DISTRO_NAME;
		}
		return env;
	}

	/** Spawns synchronously; resolves ONLY on the child `close` event (never exit/error/kill). */
	private run(mode: "probe" | "play", target: ResolvedTarget, snapshot: string | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
		return new Promise<RunResult>((resolve, reject) => {
			const script = mode === "probe" ? PROBE_SCRIPT : playScript(Buffer.from(snapshot!, "utf8").toString("base64"));
			const args = [...FIXED_FLAGS, Buffer.from(script, "utf16le").toString("base64")];
			let child: NativeWindowsChild;
			try {
				child = (this.options.spawn ?? defaultSpawn)(this.executablePath(target), args, {
					shell: false, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"], env: this.childEnv(target),
				});
			} catch { reject(privateFailure()); return; }
			let stdoutChunks: Buffer[] = []; let stderrChunks: Buffer[] = [];
			let stdoutBytes = 0; let stderrBytes = 0; let overflowed = false;
			let killed = false; let aborted = false; let timedOut = false;
			const kill = () => { if (!killed) { killed = true; try { child.kill("SIGKILL"); } catch { /* keep waiting for close */ } } };
			const cleanup = () => { this.clearTimer(timer); signal?.removeEventListener("abort", onAbort); child.stdout?.removeListener("data", onStdout); child.stderr?.removeListener("data", onStderr); };
			// Bounded byte buffers: cut each chunk before storing, mark overflow stickily and kill once.
			const onStdout = (chunk: unknown) => {
				const buffer = toBuffer(chunk);
				const remaining = MAX_STDOUT - stdoutBytes;
				if (remaining > 0) { const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer; stdoutChunks.push(slice); stdoutBytes += slice.length; }
				if (buffer.length > remaining) overflowed = true;
				if (overflowed) kill();
			};
			const onStderr = (chunk: unknown) => {
				const buffer = toBuffer(chunk);
				const remaining = MAX_STDERR - stderrBytes;
				if (remaining > 0) { const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer; stderrChunks.push(slice); stderrBytes += slice.length; }
			};
			const onAbort = () => { aborted = true; kill(); };
			const timer = this.setTimer(() => { timedOut = true; kill(); }, timeoutMs);
			unrefTimer(timer);
			child.stdout?.on("data", onStdout);
			child.stderr?.on("data", onStderr);
			signal?.addEventListener("abort", onAbort, { once: true });
			child.once("close", (...closeArgs: unknown[]) => {
				cleanup();
				const code = typeof closeArgs[0] === "number" ? closeArgs[0] : null;
				resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), aborted, timedOut, code, overflowed });
			});
			child.once("error", () => { /* Node emits close after spawn errors; keep waiting */ });
			if (signal?.aborted) onAbort();
		});
	}

	private parseProbe(stdout: string): NativeWindowsProbeResult {
		const envelope = parseEnvelope(stdout);
		if (!envelope || envelope.ok !== true || typeof envelope.available !== "boolean" || !Array.isArray(envelope.formats))
			return { available: false, formats: [] };
		const hasWav = envelope.formats.some(value => value === "wav");
		return envelope.available && hasWav ? { available: true, formats: ["wav"] } : { available: false, formats: [] };
	}

	/** Explicit, read-only availability check: fixed host access, then one fixed probe script. Never throws. */
	async probe(signal?: AbortSignal): Promise<NativeWindowsProbeResult> {
		const target = this.resolveTarget();
		if (target === undefined || signal?.aborted) { this.formats = []; return { available: false, formats: [] }; }
		const executable = this.executablePath(target);
		let available = false;
		try {
			available = this.options.executableAvailable ? await this.options.executableAvailable(executable)
				: await access(executable, constants.X_OK).then(() => true);
		} catch { available = false; }
		if (!available || signal?.aborted) { this.formats = []; return { available: false, formats: [] }; }
		let result: RunResult;
		try { result = await this.run("probe", target, undefined, signal, this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS); }
		catch { this.formats = []; return { available: false, formats: [] }; }
		const parsed = result.aborted || result.timedOut || result.overflowed || result.code !== 0
			? { available: false, formats: [] as const }
			: this.parseProbe(result.stdout);
		this.formats = parsed.available ? ["wav"] : [];
		return parsed;
	}

	/** `gate` (permit or predicate) runs synchronously before spawn; false means no child at all. */
	async play(snapshot: string, signal?: AbortSignal, gate?: (() => boolean) | { permit(): boolean }): Promise<void> {
		const target = this.resolveTarget();
		if (target === undefined) throw new Error("Native Windows: unsupported platform");
		if (signal?.aborted) throw abortError();
		// Pure conversion/validation before the gate: posix -> derived UNC for WSL, drive-absolute for native.
		const prepared = target.kind === "wsl"
			? toWslUncPath(target.distro, snapshot)
			: (isWindowsAbsolutePath(snapshot) ? snapshot : undefined);
		if (prepared === undefined) throw new Error("Native Windows: invalid snapshot");
		const permitted = typeof gate === "function" ? gate() : gate?.permit();
		if (permitted === false) throw new NativePulseNotPermittedError();
		let result: RunResult;
		try { result = await this.run("play", target, prepared, signal, this.options.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS); }
		catch { throw privateFailure(); }
		if (result.aborted) throw abortError();
		if (result.overflowed || result.timedOut || result.code !== 0) throw privateFailure();
		const envelope = parseEnvelope(result.stdout);
		if (!envelope || envelope.ok !== true || envelope.played !== true) throw privateFailure();
	}
}
