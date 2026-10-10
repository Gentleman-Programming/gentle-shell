import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, open, rmdir, unlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNotificationSound, type NotificationSound } from "./notification-policy.ts";
import type { PlaybackPermit } from "./notification-scheduler.ts";
import { NativePulseNotPermittedError, NativePulsePlayer } from "./notification-audio-native.ts";
import { NativeWindowsPlayer } from "./notification-audio-windows.ts";

const MAX_BYTES = 2 * 1024 * 1024;
/** User-facing duration ceiling for every accepted container; the play deadlines below add a 1 s margin. */
const MAX_DURATION_MS = 10000;
const PLAYBACK_TIMEOUT_MS = 11000;
const STDERR_LIMIT = 4096;
/** Strict RIFF PCM: unknown chunks allowed, with word padding; one fmt and one nonempty data. */
export function validateNotificationWav(bytes: Buffer): number {
	const invalid = () => { throw new TypeError("Invalid notification WAV"); };
	if (bytes.length < 44 || bytes.length > MAX_BYTES || bytes.toString("ascii", 0, 4) !== "RIFF"
		|| bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) return invalid();
	let offset = 12; let format: { rate: number; align: number } | undefined; let dataSize: number | undefined;
	while (offset < bytes.length) {
		if (offset + 8 > bytes.length) return invalid();
		const id = bytes.toString("ascii", offset, offset + 4); const size = bytes.readUInt32LE(offset + 4);
		const start = offset + 8; const end = start + size;
		if (end + (size % 2) > bytes.length) return invalid();
		if (id === "fmt ") {
			if (format || (size !== 16 && size !== 18) || bytes.readUInt16LE(start) !== 1
				|| (size === 18 && bytes.readUInt16LE(start + 16) !== 0)) return invalid();
			const channels = bytes.readUInt16LE(start + 2); const rate = bytes.readUInt32LE(start + 4);
			const bits = bytes.readUInt16LE(start + 14); const align = channels * bits / 8;
			if (channels < 1 || channels > 2 || rate < 8000 || rate > 192000 || ![8, 16, 24, 32].includes(bits)
				|| bytes.readUInt16LE(start + 12) !== align || bytes.readUInt32LE(start + 8) !== rate * align) return invalid();
			format = { rate, align };
		} else if (id === "data") {
			if (!format || dataSize !== undefined || size === 0) return invalid();
			dataSize = size;
		}
		offset = end + (size % 2);
	}
	if (!format || dataSize === undefined || dataSize % format.align !== 0) return invalid();
	const duration = dataSize / format.align / format.rate * 1000;
	if (duration > MAX_DURATION_MS) return invalid();
	return duration;
}

export type NotificationAudioFormat = "wav" | "ogg" | "flac";
/** Content detection only (magic bytes, never the extension). Unknown containers are refused
 *  so an unrecognized file can never reach the player as white noise. */
export function validateNotificationAudio(bytes: Buffer): { format: NotificationAudioFormat; durationMs: number } {
	let format: NotificationAudioFormat;
	let durationMs: number;
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
		format = "wav"; durationMs = validateNotificationWav(bytes);
	} else if (bytes.toString("ascii", 0, 4) === "fLaC") {
		format = "flac"; durationMs = validateNotificationFlac(bytes);
	} else if (bytes.toString("ascii", 0, 4) === "OggS") {
		format = "ogg"; durationMs = validateNotificationOgg(bytes);
	} else throw new TypeError("Unsupported notification audio format");
	// WAV already enforces this internally; the shared guard also bounds the decoded OGG/FLAC durations.
	if (durationMs > MAX_DURATION_MS) throw new TypeError("Notification audio exceeds 10 seconds");
	return { format, durationMs };
}
/** FLAC duration from STREAMINFO: the first metadata block must be STREAMINFO of exactly 34 bytes
 *  and total samples must be known, otherwise a duration limit cannot be verified. */
export function validateNotificationFlac(bytes: Buffer): number {
	const invalid = () => { throw new TypeError("Invalid notification FLAC"); };
	if (bytes.length < 42 || bytes.length > MAX_BYTES || bytes.toString("ascii", 0, 4) !== "fLaC") return invalid();
	const lastFlagAndType = bytes[4];
	const length = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
	if ((lastFlagAndType & 0x7f) !== 0 || length !== 34) return invalid();
	const s = 8;
	const sampleRate = (bytes[s + 10] << 12) | (bytes[s + 11] << 4) | (bytes[s + 12] >> 4);
	const channels = ((bytes[s + 12] >> 1) & 0x07) + 1;
	const bitsPerSample = (((bytes[s + 12] & 0x01) << 4) | (bytes[s + 13] >> 4)) + 1;
	const totalSamples = (bytes[s + 13] & 0x0f) * 2 ** 32 + bytes.readUInt32BE(s + 14);
	if (sampleRate < 8000 || sampleRate > 192000 || channels < 1 || channels > 2
		|| bitsPerSample < 4 || bitsPerSample > 32 || totalSamples <= 0) return invalid();
	return totalSamples / sampleRate * 1000;
}
/** OGG duration from the last page granule, without decoding: Vorbis uses the header sample rate,
 *  Opus is always 48 kHz and subtracts the header pre-skip. Only Vorbis/Opus are accepted. */
export function validateNotificationOgg(bytes: Buffer): number {
	const invalid = () => { throw new TypeError("Invalid notification OGG"); };
	if (bytes.length < 27 || bytes.length > MAX_BYTES) return invalid();
	let offset = 0; let first = true; let opus = false;
	let channels: number | undefined; let sampleRate: number | undefined; let preSkip = 0;
	let endGranule = 0; let foundGranule = false;
	while (offset < bytes.length) {
		if (offset + 27 > bytes.length) return invalid();
		if (bytes.toString("ascii", offset, offset + 4) !== "OggS" || bytes[offset + 4] !== 0) return invalid();
		const headerType = bytes[offset + 5];
		const low = bytes.readUInt32LE(offset + 6); const high = bytes.readInt32LE(offset + 10);
		const noGranule = high === -1 && low === 0xffffffff;
		const pageSegments = bytes[offset + 26];
		if (offset + 27 + pageSegments > bytes.length) return invalid();
		let bodySize = 0;
		for (let i = 0; i < pageSegments; i++) bodySize += bytes[offset + 27 + i];
		const bodyStart = offset + 27 + pageSegments; const next = bodyStart + bodySize;
		if (next > bytes.length) return invalid();
		if (first) {
			// The BOS page must carry the identification header for exactly one supported codec.
			if ((headerType & 0x02) === 0) return invalid();
			if (bodySize >= 7 && bytes[bodyStart] === 0x01 && bytes.toString("ascii", bodyStart + 1, bodyStart + 7) === "vorbis") {
				if (bodySize < 16) return invalid();
				channels = bytes[bodyStart + 11]; sampleRate = bytes.readUInt32LE(bodyStart + 12);
			} else if (bodySize >= 8 && bytes.toString("ascii", bodyStart, bodyStart + 8) === "OpusHead") {
				if (bodySize < 12) return invalid();
				channels = bytes[bodyStart + 9]; preSkip = bytes.readUInt16LE(bodyStart + 10);
				sampleRate = 48000; opus = true;
			} else return invalid();
			first = false;
		}
		if (!noGranule) { const value = high * 2 ** 32 + low; if (!foundGranule || value > endGranule) endGranule = value; foundGranule = true; }
		offset = next;
	}
	if (first || !foundGranule || channels === undefined || sampleRate === undefined || channels < 1 || channels > 2) return invalid();
	if (!opus && (sampleRate < 8000 || sampleRate > 192000)) return invalid();
	const durationMs = opus ? Math.max(0, endGranule - preSkip) / 48000 * 1000 : endGranule / sampleRate * 1000;
	if (!(durationMs > 0)) return invalid();
	return durationMs;
}
/** Canonical capability order; native WAV never removes the CLI OGG/FLAC capabilities. */
const CANONICAL_FORMATS: readonly NotificationAudioFormat[] = ["wav", "ogg", "flac"];
function formatsForExecutable(executable: string): readonly NotificationAudioFormat[] {
	const name = basename(executable);
	if (name === "paplay" || name === "pw-play") return ["wav", "ogg", "flac"];
	if (name === "aplay") return ["wav"];
	if (name === "afplay") return ["wav", "flac"];
	return [];
}
function canonicalFormats(formats: readonly NotificationAudioFormat[]): readonly NotificationAudioFormat[] {
	return CANONICAL_FORMATS.filter(format => formats.includes(format));
}

/**
 * Pure, IO-free default backend selection. Native Windows (`win32`) and the
 * derived WSL Windows-interop target (`linux` plus a valid interop env) take the
 * bounded Windows adapter; every other platform stays on the local Pulse bridge,
 * whose `supportsTarget()` is false on macOS so the legacy `/usr/bin/afplay` CLI
 * still owns playback. Construction performs no probe, access, spawn or read; a
 * caller may still inject `options.native` to override this choice entirely.
 */
export function createDefaultNotificationBackend(
	platform: string = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): NativeAudioBackend {
	const windows = new NativeWindowsPlayer({ platform, env });
	return windows.supportsTarget() ? windows : new NativePulsePlayer({ platform, env });
}

/** Typed seam over the owned native bridge (lazy: no IO until an explicit probe/play). */
export interface NativeAudioBackend {
	supportsTarget(): boolean;
	probe(signal?: AbortSignal): Promise<{ available: boolean; formats: readonly NotificationAudioFormat[] }>;
	getNativeFormats(): readonly NotificationAudioFormat[];
	play(snapshot: string, signal?: AbortSignal, gate?: (() => boolean) | { permit(): boolean }): Promise<void>;
}
interface DiscoveredSystem { executable: string; formats: readonly NotificationAudioFormat[]; }
interface Discovery { native: readonly NotificationAudioFormat[]; system?: DiscoveredSystem; }

export interface AudioIO {
	open(path: string, flags: number): Promise<{
		stat(): Promise<{ isFile(): boolean; size: number }>;
		read(buffer: Buffer): Promise<{ bytesRead: number }>;
		close(): Promise<void>;
	}>;
	mkdtemp(prefix: string): Promise<string>;
	chmod(path: string, mode: number): Promise<void>;
	writeFile(path: string, bytes: Buffer, options: { mode: number; flag: "wx" }): Promise<void>;
	unlink(path: string): Promise<void>;
	rmdir(path: string): Promise<void>;
}
export interface AudioChild extends EventEmitter {
	stderr: EventEmitter | null;
	kill(signal: "SIGKILL"): boolean;
}
export interface AudioOptions {
	platform?: string;
	io?: AudioIO;
	tempRoot?: string;
	builtinRoot?: string;
	native?: NativeAudioBackend;
	executableAvailable?(path: string): Promise<boolean>;
	spawn?(executable: string, args: string[], options: {
		shell: false; windowsHide: true; detached: false; stdio: ["ignore", "ignore", "pipe"];
	}): AudioChild;
	setTimeout?(fn: () => void, ms: number): ReturnType<typeof setTimeout> | number;
	clearTimeout?(timer: ReturnType<typeof setTimeout> | number): void;
}
const defaultIO: AudioIO = { open, mkdtemp, chmod, writeFile, unlink, rmdir };
/** Owner invokes only for enable/preview (or explicit availability UI). No import-time detection/IO.
 * Windows deliberately unavailable until a safe native adapter and manual evidence exist.
 * Source symlinks are rejected (O_NOFOLLOW); descriptor read is bounded, then validated bytes
 * are snapshotted into a private directory so subsequent source mutation cannot affect playback. */
export class NotificationPlayer {
	private readonly options: AudioOptions;
	private readonly io: AudioIO;
	private readonly native: NativeAudioBackend;
	private discovery?: Promise<Discovery>;
	constructor(options: AudioOptions = {}) {
		this.options = options;
		this.io = options.io ?? defaultIO;
		this.native = options.native ?? createDefaultNotificationBackend(options.platform);
	}
	async availability(): Promise<"available" | "unavailable"> {
		const discovered = await this.discover();
		return discovered.native.length > 0 || discovered.system ? "available" : "unavailable";
	}
	/** Aggregate, canonical capabilities: native WAV cannot shadow the CLI OGG/FLAC support. */
	async capabilities(): Promise<Set<NotificationAudioFormat>> {
		const discovered = await this.discover();
		const present = new Set<NotificationAudioFormat>([...discovered.native, ...(discovered.system?.formats ?? [])]);
		return new Set(CANONICAL_FORMATS.filter(format => present.has(format)));
	}
	/** Explicit discovery only: native probe once on Linux, then trusted absolute CLI candidates. */
	private discover(): Promise<Discovery> {
		return this.discovery ??= (async () => {
			const platform = this.options.platform ?? process.platform;
			let native: readonly NotificationAudioFormat[] = [];
			if (this.native.supportsTarget()) {
				try { const probed = await this.native.probe(); if (probed.available) native = canonicalFormats(probed.formats); }
				catch { native = []; }
			}
			const executable = await this.detectExecutable(platform);
			return { native, system: executable ? { executable, formats: formatsForExecutable(executable) } : undefined };
		})();
	}
	private async detectExecutable(platform: string): Promise<string | undefined> {
		const candidates = platform === "linux" ? ["/usr/bin/paplay", "/usr/bin/pw-play", "/usr/bin/aplay"]
			: platform === "darwin" ? ["/usr/bin/afplay"] : [];
		for (const path of candidates) {
			try {
				const available = this.options.executableAvailable ? await this.options.executableAvailable(path)
					: await access(path, constants.X_OK).then(() => true);
				if (available) return path;
			} catch { /* Missing/denied executable is a local availability result, not an agent failure. */ }
		}
		return undefined;
	}
	async play(sound: Exclude<NotificationSound, null>, signal: AbortSignal, permit: PlaybackPermit): Promise<void> {
		if (signal.aborted) return;
		const discovered = await this.discover();
		if (signal.aborted) return;
		// No usable backend: preserve the old behavior of no read, snapshot or spawn.
		if (discovered.native.length === 0 && !discovered.system) return;
		const flavor = (this.options.platform ?? process.platform) === "win32" ? "win32" : "posix";
		if (!isNotificationSound(sound, flavor)) throw new TypeError("Invalid notification sound");
		const source = sound.startsWith("file:") ? sound.slice(5)
			: join(this.options.builtinRoot ?? fileURLToPath(new URL("../assets/sounds/", import.meta.url)), `${sound.slice(8)}.wav`);
		const { bytes, format } = await this.readSource(source);
		if (signal.aborted) return;
		const useNative = format === "wav" && discovered.native.length > 0;
		const executable = !useNative && discovered.system?.formats.includes(format) ? discovered.system.executable : undefined;
		if (!useNative && !executable) throw new Error("Notification audio: no backend supports the format");
		const directory = await this.io.mkdtemp(join(this.options.tempRoot ?? tmpdir(), "gentle-notification-"));
		const snapshot = join(directory, `sound.${format}`);
		// Early returns below leave this inner function only; the cleanup verdict is decided after it.
		const playSnapshot = async (): Promise<void> => {
			await this.io.chmod(directory, 0o700);
			await this.io.writeFile(snapshot, bytes, { mode: 0o600, flag: "wx" });
			if (signal.aborted) return;
			if (useNative) {
				// The owned bridge calls the scheduler gate once synchronously before spawning; a false
				// permit resolves silently and any real native failure is never retried through the CLI.
				try { await this.native.play(snapshot, signal, () => permit.start()); }
				catch (error) { if (error instanceof NativePulseNotPermittedError) return; throw error; }
			} else {
				// No await between permit and spawn: scheduler TTL/generation owns the final start gate.
				if (!permit.start()) return;
				await this.run(executable!, snapshot, signal);
			}
		};
		let cleanupFailed = false;
		try { await playSnapshot(); } finally {
			// Cleanup failures never replace a playback error; they surface only when playback itself succeeded.
			try { await this.io.unlink(snapshot); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed = true;
			}
			try { await this.io.rmdir(directory); } catch { cleanupFailed = true; }
		}
		if (cleanupFailed) throw new Error("Audio snapshot cleanup failed");
	}
	private async readSource(source: string): Promise<{ bytes: Buffer; format: NotificationAudioFormat }> {
		const handle = await this.io.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_BYTES || stat.size < 44) throw new TypeError("Invalid notification file");
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			// One bounded descriptor read: short reads fail closed rather than accepting truncation.
			const { bytesRead } = await handle.read(buffer);
			if (bytesRead !== stat.size) throw new TypeError("Notification file changed or truncated");
			const bytes = Buffer.from(buffer.subarray(0, bytesRead));
			return { bytes, format: validateNotificationAudio(bytes).format };
		} finally { await handle.close(); }
	}
	private run(executable: string, snapshot: string, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = (this.options.spawn ?? spawn)(executable, [snapshot], {
				shell: false, windowsHide: true, detached: false, stdio: ["ignore", "ignore", "pipe"],
			});
			let failed = false; let timedOut = false; let killed = false; let stderr = Buffer.alloc(0);
			const capture = (chunk: Buffer | string) => {
				const remaining = STDERR_LIMIT - stderr.length;
				if (remaining > 0) stderr = Buffer.concat([stderr, Buffer.from(typeof chunk === "string" ? chunk.slice(0, remaining) : chunk.subarray(0, remaining)).subarray(0, remaining)]);
			};
			const kill = () => {
				if (!killed) {
					killed = true;
					try { child.kill("SIGKILL"); } catch { failed = true; } // Keep reservation until close even if OS denies kill.
				}
			};
			const error = () => { failed = true; }; // Node emits close after error even for failed spawn.
			child.stderr?.on("data", capture); child.on("error", error);
			const timer = (this.options.setTimeout ?? setTimeout)(() => { timedOut = true; kill(); }, PLAYBACK_TIMEOUT_MS);
			signal.addEventListener("abort", kill, { once: true });
			child.once("close", (code: number | null) => {
				(this.options.clearTimeout ?? clearTimeout)(timer);
				signal.removeEventListener("abort", kill); child.removeListener("error", error);
				child.stderr?.removeListener("data", capture);
				const detail = stderr.toString("utf8").trim(); stderr = Buffer.alloc(0);
				if (signal.aborted) resolve();
				else if (timedOut) reject(new Error("Audio playback timed out"));
				else if (failed || code !== 0) reject(new Error(detail ? `Audio process failed: ${detail}` : "Audio process failed"));
				else resolve();
			});
			if (signal.aborted) kill();
		});
	}
}
