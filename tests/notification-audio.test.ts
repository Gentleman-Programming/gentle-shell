import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { NotificationPlayer, createDefaultNotificationBackend, validateNotificationAudio, validateNotificationFlac, validateNotificationOgg, validateNotificationWav, type AudioIO } from "../lib/notification-audio.ts";
import type { NativeAudioBackend } from "../lib/notification-audio.ts";
import { NativePulsePlayer } from "../lib/notification-audio-native.ts";
import { FIXED_WINDOWS_POWERSHELL_EXE, NATIVE_WINDOWS_SCHEMA, NativeWindowsPlayer } from "../lib/notification-audio-windows.ts";
import { NotificationScheduler } from "../lib/notification-scheduler.ts";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../lib/notification-policy.ts";

function wav(samples = 800) {
	const b = Buffer.alloc(44 + samples * 2);
	b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
	b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
	b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(samples * 2, 40); return b;
}
/** Minimal Ogg page (27-byte header + lacing table); bodies stay < 255 bytes so one lacing value suffices.
 *  CRC is deliberately written as zero: the validator never verifies it. */
function oggPage(headerType: number, granule: number | "none", body: Buffer, seqno = 0): Buffer {
	const segments = body.length === 0 ? 0 : Math.ceil(body.length / 255);
	const table = Buffer.alloc(segments);
	let remaining = body.length;
	for (let i = 0; i < segments; i++) { table[i] = Math.min(255, remaining); remaining -= table[i]!; }
	const head = Buffer.alloc(27);
	head.write("OggS", 0); head[4] = 0; head[5] = headerType;
	if (granule === "none") { head.writeUInt32LE(0xffffffff, 6); head.writeUInt32LE(0xffffffff, 10); }
	else { head.writeUInt32LE(granule >>> 0, 6); head.writeUInt32LE(Math.floor(granule / 2 ** 32), 10); }
	head.writeUInt32LE(0, 14); head.writeUInt32LE(seqno, 18); head.writeUInt32LE(0, 22); head[26] = segments;
	return Buffer.concat([head, table, body]);
}
function vorbisId(channels = 1, sampleRate = 8000): Buffer {
	const b = Buffer.alloc(30); b[0] = 0x01; b.write("vorbis", 1); b[11] = channels; b.writeUInt32LE(sampleRate, 12); b[29] = 0x01; return b;
}
function opusHead(channels = 1, preSkip = 312): Buffer {
	const b = Buffer.alloc(19); b.write("OpusHead", 0); b[8] = 1; b[9] = channels;
	b.writeUInt16LE(preSkip, 10); b.writeUInt32LE(48000, 12); b[18] = 0; return b;
}
/** One identification page (BOS) plus a final granule page; default granule encodes exactly 1000 ms. */
function oggVorbis(sampleRate = 8000, granule = sampleRate): Buffer {
	return Buffer.concat([oggPage(0x02, 0, vorbisId(1, sampleRate), 0), oggPage(0x00, granule, Buffer.alloc(0), 1)]);
}
function oggOpus(preSkip = 312, granule = preSkip + 48000): Buffer {
	return Buffer.concat([oggPage(0x02, 0, opusHead(1, preSkip), 0), oggPage(0x00, granule, Buffer.alloc(0), 1)]);
}
/** Minimal FLAC: 4-byte magic + one last STREAMINFO block (34 bytes) + `extra` opaque trailing bytes.
 *  sampleRate is 20 bits, channels-1 3 bits, bitsPerSample-1 5 bits and totalSamples 36 bits. */
function flac(sampleRate = 8000, totalSamples = 8000, extra = 4): Buffer {
	const b = Buffer.alloc(42 + extra);
	b.write("fLaC", 0); b[4] = 0x80; b[7] = 34;
	const s = 8;
	b[s + 10] = (sampleRate >> 12) & 0xff; b[s + 11] = (sampleRate >> 4) & 0xff;
	b[s + 12] = (sampleRate & 0x0f) << 4; // low rate nibble; channels-1 = 0; bps high bit = 0
	b[s + 13] = 0xf0 | ((totalSamples / 2 ** 32) & 0x0f); // bps-1 low nibble (16 bps) + totalSamples bits 35..32
	b.writeUInt32BE(totalSamples >>> 0, s + 14);
	return b;
}
class Child extends EventEmitter {
	stderr = new EventEmitter(); kills: string[] = [];
	kill(signal: string) { this.kills.push(signal); return true; }
}
interface FakeNative {
	readonly backend: NativeAudioBackend;
	readonly snapshots: string[];
	readonly gates: Array<(() => boolean) | { permit(): boolean } | undefined>;
	probes(): number;
}
/** Injected native backend; records probes/plays and calls the gate exactly once like the real bridge. */
function nativeFake(options: { available?: boolean; formats?: readonly ("wav")[]; fail?: boolean; supported?: boolean } = {}): FakeNative {
	const snapshots: string[] = [];
	const gates: Array<(() => boolean) | { permit(): boolean } | undefined> = [];
	let probes = 0;
	const backend: NativeAudioBackend = {
		supportsTarget: () => options.supported ?? true,
		probe: async () => { probes++; return { available: options.available ?? false, formats: options.available ? (options.formats ?? (["wav"] as const)) : [] }; },
		getNativeFormats: () => (options.available ? (options.formats ?? (["wav"] as const)) : []),
		play: async (snapshot, _signal, gate) => {
			gates.push(gate);
			const permitted = typeof gate === "function" ? gate() : gate?.permit();
			if (permitted === false) return;
			snapshots.push(snapshot);
			if (options.fail) throw new Error("native playback failed");
		},
	};
	return { backend, snapshots, gates, probes: () => probes };
}
const unavailableNative = (): NativeAudioBackend => nativeFake({ available: false }).backend;
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(platform = "linux", native: NativeAudioBackend = unavailableNative()) {
	const child = new Child(); const calls: Array<{ executable: string; args: string[]; options: unknown }> = [];
	const probes: string[] = []; const cleaned: string[] = []; const writes: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	let bytes: Buffer = wav(); let regular = true; let size = bytes.length; let available = true;
	let detect: (() => Promise<boolean>) | undefined; let availablePaths: string[] | undefined;
	let spawnError = false; let writeError = false; let cleanupError = false; let rmdirError = false;
	let duringRead: (() => void) | undefined;
	let timeout: (() => void) | undefined; let timeoutMs = 0; let cleared = 0;
	const io: AudioIO = {
		open: async (_path, flags) => {
			assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK);
			return { stat: async () => ({ isFile: () => regular, size }),
				read: async buffer => { duringRead?.(); bytes.copy(buffer); return { bytesRead: bytes.length }; }, close: async () => {} };
		},
		mkdtemp: async () => "/private/audio ; literal", chmod: async (_path, mode) => { assert.equal(mode, 0o700); },
		writeFile: async (path, data, options) => { if (writeError) throw Error("write"); writes.push({ path, bytes: data, mode: options.mode }); },
		unlink: async path => { cleaned.push(path); if (cleanupError) throw Error("cleanup"); },
		rmdir: async path => { cleaned.push(path); if (rmdirError) throw Error("rmdir"); },
	};
	const player = new NotificationPlayer({ platform, io, tempRoot: "/private", builtinRoot: "/builtins", native,
		executableAvailable: async path => { probes.push(path); return availablePaths ? availablePaths.includes(path) : (detect ? detect() : available); },
		spawn: (executable, args, options) => { if (spawnError) throw Error("spawn"); calls.push({ executable, args, options }); return child; },
		setTimeout: (fn, ms) => { timeout = fn; timeoutMs = ms; return 1; }, clearTimeout: () => { cleared++; },
	});
	const signal = new AbortController(); let permits = 0;
	const play = (allow = true) => player.play("file:/input/a ; &(b).wav", signal.signal, { start: () => { permits++; return allow; } });
	return { player, child, calls, probes, cleaned, writes, signal, play, timeout: () => timeout!(), timeoutMs: () => timeoutMs, cleared: () => cleared,
		permits: () => permits, setAvailable: (v: boolean) => { available = v; }, setDetect: (v: () => Promise<boolean>) => { detect = v; },
		setAvailablePaths: (paths: string[]) => { availablePaths = paths; },
		setBytes: (v: Buffer) => { bytes = v; size = v.length; }, setRegular: () => { regular = false; },
		setSize: (v: number) => { size = v; }, failSpawn: () => { spawnError = true; }, failWrite: () => { writeError = true; },
		failCleanup: () => { cleanupError = true; }, failRmdir: () => { rmdirError = true; }, onRead: (fn: () => void) => { duringRead = fn; } };
}

test("WAV content and coherent PCM limits, not filename extension", () => {
	assert.equal(validateNotificationWav(wav()), 100);
	assert.equal(validateNotificationWav(wav(80000)), 10000);
	const mutations = [
		(b: Buffer) => b.write("NOPE"), (b: Buffer) => b.write("MP3!", 8),
		(b: Buffer) => b.writeUInt32LE(1, 4), (b: Buffer) => b.writeUInt16LE(3, 20),
		(b: Buffer) => b.writeUInt16LE(0, 22), (b: Buffer) => b.writeUInt32LE(0, 24),
		(b: Buffer) => b.writeUInt32LE(1, 28), (b: Buffer) => b.writeUInt16LE(1, 32),
		(b: Buffer) => b.writeUInt16LE(7, 34), (b: Buffer) => b.writeUInt32LE(0xffffffff, 40),
		(b: Buffer) => b.writeUInt32LE(1, 40), (b: Buffer) => b.writeUInt32LE(0, 40),
	];
	for (const mutate of mutations) { const b = wav(); mutate(b); assert.throws(() => validateNotificationWav(b)); }
	for (const b of [wav().subarray(0, 43), wav(80001), Buffer.alloc(2 * 1024 * 1024 + 1)]) assert.throws(() => validateNotificationWav(b));
});

test("10 s is the exact validated boundary for WAV/OGG/FLAC and the old 5.58 s file is now accepted", () => {
	// Exact 10 s is accepted for every current container (WAV PCM duration is also enforced internally).
	assert.equal(validateNotificationWav(wav(80000)), 10000);
	assert.deepEqual(validateNotificationAudio(oggVorbis(8000, 80000)), { format: "ogg", durationMs: 10000 });
	assert.deepEqual(validateNotificationAudio(oggOpus(312, 312 + 48000 * 10)), { format: "ogg", durationMs: 10000 });
	assert.deepEqual(validateNotificationAudio(flac(8000, 80000)), { format: "flac", durationMs: 10000 });
	// The previously rejected 5.58 s equivalent now validates for each container, without cropping.
	assert.equal(validateNotificationWav(wav(44640)), 5580);
	assert.deepEqual(validateNotificationAudio(oggVorbis(8000, 44640)), { format: "ogg", durationMs: 5580 });
	assert.deepEqual(validateNotificationAudio(flac(8000, 44640)), { format: "flac", durationMs: 5580 });
	// One representable unit past 10 s is rejected; the 2 MiB ceiling stays independent.
	assert.throws(() => validateNotificationWav(wav(80001)), /Invalid notification WAV/);
	for (const long of [oggVorbis(8000, 80001), oggOpus(312, 312 + 48000 * 10 + 1), flac(8000, 80001)])
		assert.throws(() => validateNotificationAudio(long), /exceeds 10 seconds|Invalid notification/);
	const huge = Buffer.alloc(2 * 1024 * 1024 + 1); huge.write("RIFF"); huge.write("WAVE", 8);
	assert.throws(() => validateNotificationWav(huge), /Invalid notification WAV/);
});

test("RIFF chunk padding, duplicates and bounds are validated", () => {
	const original = wav(); const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 42, 0]);
	const extended = Buffer.concat([original.subarray(0, 36), junk, original.subarray(36)]);
	extended.writeUInt32LE(extended.length - 8, 4); assert.equal(validateNotificationWav(extended), 100);
	for (const extra of [original.subarray(12, 36), original.subarray(36), Buffer.from([1, 2, 3])]) {
		const b = Buffer.concat([original, extra]); b.writeUInt32LE(b.length - 8, 4);
		assert.throws(() => validateNotificationWav(b));
	}
});

test("content detection accepts WAV, OGG Vorbis/Opus and FLAC with decoded durations", () => {
	assert.deepEqual(validateNotificationAudio(wav()), { format: "wav", durationMs: 100 });
	assert.deepEqual(validateNotificationAudio(oggVorbis(8000, 4000)), { format: "ogg", durationMs: 500 });
	assert.deepEqual(validateNotificationAudio(oggOpus(312, 312 + 24000)), { format: "ogg", durationMs: 500 });
	assert.deepEqual(validateNotificationAudio(flac(8000, 4000)), { format: "flac", durationMs: 500 });
	// Minimal FLAC without trailing bytes: 4 magic + 4 block header + 34 STREAMINFO is already sufficient.
	assert.equal(validateNotificationFlac(flac().subarray(0, 42)), 1000);
	assert.equal(validateNotificationOgg(oggVorbis()), 1000);
});

test("content detection rejects other containers, unknown Ogg codecs, malformed pages and over-limit audio", () => {
	for (const other of [Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00"), Buffer.from("\x00\x00\x00\x18ftypmp42"), Buffer.alloc(0), Buffer.from("Ogg")])
		assert.throws(() => validateNotificationAudio(other), /Unsupported notification audio format/);
	const unsupported = Buffer.concat([oggPage(0x02, 0, Buffer.from("Xcodec!!", "ascii"), 0), oggPage(0x00, 1000, Buffer.alloc(0), 1)]);
	assert.throws(() => validateNotificationAudio(unsupported), /Invalid notification OGG/);
	// Duration is decoded per format and then rejected by the shared 10 s guard.
	for (const long of [flac(8000, 8000 * 11), oggVorbis(8000, 8000 * 11), oggOpus(312, 312 + 48000 * 11)])
		assert.throws(() => validateNotificationAudio(long), /exceeds 10 seconds|Invalid notification/);
	// Size is bounded for every container, even before parsing.
	const hugeOgg = Buffer.alloc(2 * 1024 * 1024 + 1); hugeOgg.write("OggS", 0);
	const hugeFlac = Buffer.alloc(2 * 1024 * 1024 + 1); hugeFlac.write("fLaC", 0);
	assert.throws(() => validateNotificationAudio(hugeOgg), /Invalid notification OGG/);
	assert.throws(() => validateNotificationAudio(hugeFlac), /Invalid notification FLAC/);
	// FLAC requires the first block to be STREAMINFO of exactly 34 bytes.
	const notStreaminfo = flac(); notStreaminfo[4] = 0x80 | 0x04; assert.throws(() => validateNotificationFlac(notStreaminfo), /Invalid notification FLAC/);
	const wrongLength = flac(); wrongLength[7] = 33; assert.throws(() => validateNotificationFlac(wrongLength), /Invalid notification FLAC/);
	const unknownSamples = flac(8000, 0); assert.throws(() => validateNotificationFlac(unknownSamples), /Invalid notification FLAC/);
});

test("Ogg pages are walked with bounds: non-BOS first page, bad version, unsupported codec and truncation fail closed", () => {
	const nonBos = Buffer.concat([oggPage(0x00, 0, vorbisId(), 0), oggPage(0x00, 1000, Buffer.alloc(0), 1)]);
	assert.throws(() => validateNotificationOgg(nonBos), /Invalid notification OGG/);
	const badVersion = oggVorbis(); badVersion[4] = 1; assert.throws(() => validateNotificationOgg(badVersion), /Invalid notification OGG/);
	const badMagic = oggVorbis(); badMagic.write("XggS", 0); assert.throws(() => validateNotificationOgg(badMagic), /Invalid notification OGG/);
	const badChannels = Buffer.concat([oggPage(0x02, 0, vorbisId(3), 0), oggPage(0x00, 1000, Buffer.alloc(0), 1)]);
	assert.throws(() => validateNotificationOgg(badChannels), /Invalid notification OGG/);
	const badRate = Buffer.concat([oggPage(0x02, 0, vorbisId(1, 4000), 0), oggPage(0x00, 1000, Buffer.alloc(0), 1)]);
	assert.throws(() => validateNotificationOgg(badRate), /Invalid notification OGG/);
	assert.throws(() => validateNotificationOgg(oggVorbis().subarray(0, 40)), /Invalid notification OGG/);
	assert.throws(() => validateNotificationOgg(Buffer.concat([oggVorbis(), Buffer.from([1, 2, 3])])), /Invalid notification OGG/);
});

test("player capabilities map trusted executables to their real formats without starting playback", async () => {
	const pick = (platform: string, match?: string) => new NotificationPlayer({ platform, native: unavailableNative(),
		executableAvailable: async path => match === undefined ? true : path === match });
	assert.deepEqual([...(await pick("linux", "/usr/bin/paplay").capabilities())], ["wav", "ogg", "flac"]);
	assert.deepEqual([...(await pick("linux", "/usr/bin/pw-play").capabilities())], ["wav", "ogg", "flac"]);
	assert.deepEqual([...(await pick("linux", "/usr/bin/aplay").capabilities())], ["wav"]);
	assert.deepEqual([...(await pick("darwin", "/usr/bin/afplay").capabilities())], ["wav", "flac"]);
	assert.deepEqual([...(await pick("win32", "/usr/bin/paplay").capabilities())], []);
	assert.deepEqual([...(await pick("linux", "").capabilities())], []);
	// Capabilities reuse the cached lazy detection: no second probe sequence.
	const cached = pick("linux", "/usr/bin/aplay");
	assert.equal(await cached.availability(), "available");
	assert.deepEqual([...(await cached.capabilities())], ["wav"]);
});

test("detection lazy, cached, trusted absolute candidates only; absence and Windows silent", async () => {
	const f = fixture(); assert.deepEqual(f.probes, []); f.setAvailable(false);
	await f.play(); await f.play(); assert.equal(f.calls.length, 0); assert.equal(f.permits(), 0);
	assert.deepEqual(f.probes, ["/usr/bin/paplay", "/usr/bin/pw-play", "/usr/bin/aplay"]);
	assert.equal(await f.player.availability(), "unavailable");
	const win = fixture("win32"); await win.play(); assert.deepEqual(win.probes, []); assert.equal(win.calls.length, 0);
	const mac = fixture("darwin"); assert.equal(await mac.player.availability(), "available"); assert.deepEqual(mac.probes, ["/usr/bin/afplay"]);
	const denied = fixture(); denied.setDetect(async () => { throw Error("denied"); }); await denied.play(); assert.equal(denied.calls.length, 0);
});

test("private snapshot, literal argv, no shell/detach; settle only after close and cleanup", async () => {
	const f = fixture(); let done = false; const p = f.play().then(() => { done = true; }); await tick();
	assert.equal(f.permits(), 1); assert.equal(done, false); assert.equal(f.calls.length, 1);
	assert.deepEqual(f.calls[0], { executable: "/usr/bin/paplay", args: ["/private/audio ; literal/sound.wav"],
		options: { shell: false, windowsHide: true, detached: false, stdio: ["ignore", "ignore", "pipe"] } });
	assert.equal(f.writes[0].mode, 0o600); assert.deepEqual(f.writes[0].bytes, wav());
	f.child.emit("exit", 0); await tick(); assert.equal(done, false);
	f.child.emit("close", 0); await p; assert.equal(done, true); assert.equal(f.cleaned.length, 2); assert.equal(f.cleared(), 1);
});

test("snapshot extension follows the detected format and OGG/FLAC bytes reach the same secure flow", async () => {
	for (const [bytes, extension] of [[oggVorbis(), "ogg"], [flac(), "flac"]] as const) {
		const f = fixture(); f.setBytes(bytes); let done = false;
		const p = f.play().then(() => { done = true; }); await tick();
		assert.equal(f.permits(), 1); assert.equal(done, false);
		assert.equal(f.calls[0]!.args[0], `/private/audio ; literal/sound.${extension}`);
		assert.equal(f.writes[0]!.mode, 0o600); assert.deepEqual(f.writes[0]!.bytes, bytes);
		f.child.emit("close", 0); await p; assert.equal(done, true); assert.equal(f.cleaned.length, 2);
	}
	// An unknown container never allocates a snapshot or spawns a player.
	const unknown = fixture(); unknown.setBytes(Buffer.concat([Buffer.from("\x00\x00\x00\x18ftypmp42"), Buffer.alloc(40)]));
	await assert.rejects(unknown.play(), /Unsupported notification audio format/);
	assert.equal(unknown.calls.length, 0); assert.equal(unknown.writes.length, 0);
});

test("abort before/during detection, validation and late false permit never spawn", async () => {
	const before = fixture(); before.signal.abort(); await before.play(); assert.deepEqual(before.probes, []);
	const during = fixture(); let resolve!: (v: boolean) => void;
	during.setDetect(() => new Promise(r => { resolve = r; })); const p = during.play(); await tick();
	during.signal.abort(); resolve(true); await p; assert.equal(during.calls.length, 0); assert.equal(during.permits(), 0);
	const validation = fixture(); validation.onRead(() => validation.signal.abort()); await validation.play(); assert.equal(validation.calls.length, 0);
	const late = fixture(); await late.play(false); assert.equal(late.calls.length, 0); assert.equal(late.cleaned.length, 2);
});

test("abort and timeout kill but keep reservation until close; bounded stderr and failure cleanup", async () => {
	for (const cancel of ["abort", "timeout"]) {
		const f = fixture(); let done = false; const p = f.play().then(() => { done = true; }, () => { done = true; }); await tick();
		f.child.stderr.emit("data", Buffer.alloc(100000, 65));
		if (cancel === "abort") f.signal.abort(); else f.timeout();
		assert.deepEqual(f.child.kills, ["SIGKILL"]); await tick(); assert.equal(done, false); assert.equal(f.cleaned.length, 0);
		f.child.emit("close", null); await p; assert.equal(f.cleaned.length, 2); assert.equal(f.child.stderr.listenerCount("data"), 0);
	}
	const failed = fixture(); const p = failed.play(); await tick(); failed.child.emit("error", Error("secret stderr"));
	await tick(); assert.equal(failed.cleaned.length, 0); failed.child.emit("close", -1);
	await assert.rejects(p, /Audio process failed/); assert.equal(failed.cleaned.length, 2);
	const nonzero = fixture(); const exit = nonzero.play(); await tick(); nonzero.child.emit("close", 1); await assert.rejects(exit, /Audio process failed/);
});

test("filesystem failures and synchronous spawn failure always clean snapshot", async () => {
	for (const setup of [(f: ReturnType<typeof fixture>) => f.setRegular(),
		(f: ReturnType<typeof fixture>) => f.setSize(2 * 1024 * 1024 + 1),
		(f: ReturnType<typeof fixture>) => f.setBytes(wav().subarray(0, 20)),
		(f: ReturnType<typeof fixture>) => f.setSize(wav().length + 2)]) {
		const f = fixture(); setup(f); await assert.rejects(f.play()); assert.equal(f.calls.length, 0);
	}
	for (const fail of ["write", "spawn"]) {
		const f = fixture(); if (fail === "write") f.failWrite(); else f.failSpawn();
		await assert.rejects(f.play()); assert.equal(f.cleaned.length, 2);
	}
	const cleanup = fixture(); cleanup.failCleanup(); const p = cleanup.play(); await tick(); cleanup.child.emit("close", 0);
	await assert.rejects(p, /cleanup/); assert.equal(cleanup.cleaned.length, 2);
	for (const sound of ["file:https://example.org/a.wav", "file:relative.wav", "builtin:other"]) {
		const f = fixture(); await assert.rejects(f.player.play(sound as "file:relative.wav", f.signal.signal, { start: () => true })); assert.equal(f.calls.length, 0);
	}
});

test("cleanup failures never mask playback errors and surface on every exit path", async () => {
	const breaks = [(f: ReturnType<typeof fixture>) => f.failCleanup(), (f: ReturnType<typeof fixture>) => f.failRmdir()];
	for (const breakCleanup of breaks) {
		// Successful playback: the cleanup failure is the only error.
		const ok = fixture(); breakCleanup(ok); const p = ok.play(); await tick(); ok.child.emit("close", 0);
		await assert.rejects(p, /Audio snapshot cleanup failed/); assert.equal(ok.cleaned.length, 2);
		// Failed playback: the process error wins over the cleanup error.
		const bad = fixture(); breakCleanup(bad); const q = bad.play(); await tick(); bad.child.emit("close", 3);
		await assert.rejects(q, /Audio process failed/); assert.equal(bad.cleaned.length, 2);
		// Denied permit returns early, yet the cleanup failure still surfaces.
		const denied = fixture(); breakCleanup(denied);
		await assert.rejects(denied.play(false), /Audio snapshot cleanup failed/); assert.equal(denied.calls.length, 0);
	}
});

test("process failure message carries bounded stderr", async () => {
	const f = fixture(); const p = f.play(); await tick();
	f.child.stderr.emit("data", Buffer.from("ALSA lib: no such device\n")); f.child.emit("close", 1);
	await assert.rejects(p, /Audio process failed: ALSA lib: no such device/);
});

test("scheduler reservation does not overlap aborted child still awaiting close", async () => {
	const f = fixture(); const s = new NotificationScheduler({ now: () => 0, setTimeout: () => 1, clearTimeout: () => {},
		player: (sound, signal, permit) => f.player.play(sound, signal, permit) });
	assert.equal(s.preview("builtin:success"), true); await tick();
	s.configure(structuredClone(DEFAULT_NOTIFICATION_SETTINGS), true);
	assert.equal(s.preview("builtin:error"), false); assert.equal(f.calls.length, 1);
	f.child.emit("close", null); await tick(); assert.equal(f.cleaned.length, 2);
	assert.equal(s.preview("builtin:error"), true); await tick(); assert.equal(f.calls.length, 2);
	f.child.emit("close", 0); await tick(); s.dispose();
});

test("all original builtin WAV assets pass the same validator", async () => {
	for (const id of ["success", "error", "attention"]) {
		const bytes = await readFile(new URL(`../assets/sounds/${id}.wav`, import.meta.url));
		assert.ok(validateNotificationWav(bytes) > 0);
		assert.equal(validateNotificationAudio(bytes).format, "wav");
	}
});

test("native WAV backend is preferred and never spawns the CLI", async () => {
	const native = nativeFake({ available: true, formats: ["wav"] });
	const f = fixture("linux", native.backend);
	await f.play();
	assert.equal(native.snapshots.length, 1);
	assert.match(native.snapshots[0]!, /sound\.wav$/);
	assert.equal(f.calls.length, 0);
	assert.equal(f.cleaned.length, 2);
	assert.equal(native.probes(), 1);
});

test("native unavailable falls back to the trusted CLI for WAV", async () => {
	const f = fixture("linux", unavailableNative());
	let done = false; const p = f.play().then(() => { done = true; }); await tick();
	assert.equal(f.calls.length, 1); assert.equal(done, false);
	f.child.emit("close", 0); await p; assert.equal(done, true);
});

test("capabilities union native WAV with legacy CLI OGG/FLAC", async () => {
	const native = nativeFake({ available: true, formats: ["wav"] });
	const f = fixture("linux", native.backend);
	assert.deepEqual([...(await f.player.capabilities())], ["wav", "ogg", "flac"]);
	assert.equal(await f.player.availability(), "available");
	assert.equal(native.probes(), 1);
});

test("OGG/FLAC route to the CLI by validated content, never the native WAV backend", async () => {
	const native = nativeFake({ available: true, formats: ["wav"] });
	const f = fixture("linux", native.backend);
	f.setBytes(oggVorbis());
	let done = false; const p = f.play().then(() => { done = true; }); await tick();
	assert.equal(native.snapshots.length, 0);
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0]!.args[0], "/private/audio ; literal/sound.ogg");
	f.child.emit("close", 0); await p; assert.equal(done, true);
});

test("a format no backend supports is rejected before snapshot or spawn", async () => {
	const f = fixture("linux", unavailableNative());
	f.setAvailablePaths(["/usr/bin/aplay"]); // WAV only
	f.setBytes(flac());
	await assert.rejects(f.play(), /no backend|Unsupported/);
	assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.cleaned.length, 0);
});

test("a native play error never retries the CLI", async () => {
	const native = nativeFake({ available: true, formats: ["wav"], fail: true });
	const f = fixture("linux", native.backend);
	await assert.rejects(f.play(), /native playback failed/);
	assert.equal(native.snapshots.length, 1);
	assert.equal(f.calls.length, 0);
	assert.equal(f.cleaned.length, 2);
});

test("default CLI play deadline is 11 s, one second past the accepted 10 s maximum", async () => {
	const f = fixture(); let done = false;
	const p = f.play().then(() => { done = true; }); await tick();
	assert.equal(f.calls.length, 1);
	assert.equal(f.timeoutMs(), 11000);
	assert.ok(f.timeoutMs() > 10000, "the CLI deadline must outlive the accepted 10 s file");
	assert.equal(done, false);
	f.child.emit("close", 0); await p; assert.equal(done, true);
});

test("native gate false starts once, spawns nothing and preserves cleanup", async () => {
	const native = nativeFake({ available: true, formats: ["wav"] });
	const f = fixture("linux", native.backend);
	await f.play(false);
	assert.equal(f.permits(), 1);
	assert.equal(native.gates.length, 1);
	assert.equal(native.snapshots.length, 0);
	assert.equal(f.calls.length, 0);
	assert.equal(f.cleaned.length, 2);
});

test("abort before discovery performs no probe, read or play", async () => {
	const native = nativeFake({ available: true, formats: ["wav"] });
	const f = fixture("linux", native.backend);
	f.signal.abort();
	await f.play();
	assert.equal(native.probes(), 0);
	assert.equal(native.snapshots.length, 0);
	assert.equal(f.writes.length, 0);
	assert.equal(f.calls.length, 0);
});

/** The default factory must select a prepared target from platform/env alone, with no probe or spawn. */
test("default factory selects the prepared target purely and lazily without probing", () => {
	const wslEnv = { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/4242_interop" };
	const win = createDefaultNotificationBackend("win32", {});
	assert.ok(win instanceof NativeWindowsPlayer);
	assert.ok(!(win instanceof NativePulsePlayer));
	assert.equal(win.supportsTarget(), true);
	assert.deepEqual(win.getNativeFormats(), []);
	const wsl = createDefaultNotificationBackend("linux", wslEnv);
	assert.ok(wsl instanceof NativeWindowsPlayer);
	assert.ok(!(wsl instanceof NativePulsePlayer));
	assert.equal(wsl.supportsTarget(), true);
	assert.deepEqual(wsl.getNativeFormats(), []);
	const linux = createDefaultNotificationBackend("linux", {});
	assert.ok(linux instanceof NativePulsePlayer);
	assert.ok(!(linux instanceof NativeWindowsPlayer));
	assert.equal(linux.supportsTarget(), true);
	assert.deepEqual(linux.getNativeFormats(), []);
	// A WSL-looking env is not enough: a non-/mnt-c interop path, a bad distro name
	// or a missing half must stay on the local Pulse class, never the Windows host.
	const denied: Array<Record<string, string>> = [
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/tmp/4242_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "4242_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/../4242_interop" },
		{ WSL_DISTRO_NAME: "bad:name", WSL_INTEROP: "/run/WSL/4242_interop" },
		{ WSL_INTEROP: "/run/WSL/4242_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu" },
	];
	for (const env of denied) {
		const backend = createDefaultNotificationBackend("linux", env);
		assert.ok(backend instanceof NativePulsePlayer, JSON.stringify(env));
		assert.ok(!(backend instanceof NativeWindowsPlayer), JSON.stringify(env));
		assert.deepEqual(backend.getNativeFormats(), []);
	}
	// macOS has no owned native yet: even with WSL-like env it stays on the local class
	// (supportsTarget false) so the legacy /usr/bin/afplay path owns playback.
	const mac = createDefaultNotificationBackend("darwin", wslEnv);
	assert.ok(mac instanceof NativePulsePlayer);
	assert.equal(mac.supportsTarget(), false);
});

const WINDOWS_PROBE_ENVELOPE = JSON.stringify({ schema: NATIVE_WINDOWS_SCHEMA, ok: true, available: true, formats: ["wav"] });
const WINDOWS_PLAY_ENVELOPE = JSON.stringify({ schema: NATIVE_WINDOWS_SCHEMA, ok: true, played: true });
class WindowsChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly kills: string[] = [];
	kill(signal: string): boolean { this.kills.push(signal); return true; }
}
/** Real Windows adapter with fully injected IO: no child process, no filesystem, no PowerShell. */
function windowsNativePlayer() {
	const children: WindowsChild[] = [];
	const spawned: Array<{ executable: string; args: string[]; options: unknown }> = [];
	const native = new NativeWindowsPlayer({
		platform: "win32",
		env: { TEMP: "C:\\Temp" },
		executableAvailable: async () => true,
		spawn: (executable, args, options) => { spawned.push({ executable, args, options }); const child = new WindowsChild(); children.push(child); return child; },
		setTimeout: () => 1, clearTimeout: () => {},
	});
	return { native, children, spawned };
}

test("win32 native route plays a custom Windows WAV through the fake PowerShell host", async () => {
	const { native, children, spawned } = windowsNativePlayer();
	const cleaned: string[] = []; const writes: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	const bytes = wav();
	const io: AudioIO = {
		open: async (_path, flags) => {
			assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK);
			return { stat: async () => ({ isFile: () => true, size: bytes.length }),
				read: async buffer => { bytes.copy(buffer); return { bytesRead: bytes.length }; }, close: async () => {} };
		},
		mkdtemp: async () => "C:\\Temp\\gentle-notification-1", chmod: async () => {},
		writeFile: async (path, data, options) => { writes.push({ path, bytes: data, mode: options.mode }); },
		unlink: async path => { cleaned.push(path); }, rmdir: async path => { cleaned.push(path); },
	};
	let cliSpawns = 0;
	const player = new NotificationPlayer({ platform: "win32", io, tempRoot: "C:\\Temp", builtinRoot: "C:\\builtins", native,
		executableAvailable: async () => false, spawn: () => { cliSpawns++; throw new Error("no CLI on win32"); },
		setTimeout: () => 1, clearTimeout: () => {} });
	const availability = player.availability();
	await tick();
	assert.equal(children.length, 1);
	children[0]!.stdout.emit("data", WINDOWS_PROBE_ENVELOPE);
	children[0]!.emit("close", 0);
	assert.equal(await availability, "available");
	assert.deepEqual([...(await player.capabilities())], ["wav"]);
	let permits = 0;
	const playing = player.play("file:C:\\audio.wav", new AbortController().signal, { start: () => { permits++; return true; } });
	await tick();
	assert.equal(children.length, 2);
	assert.equal(permits, 1);
	const call = spawned[1]!;
	assert.equal(call.executable, FIXED_WINDOWS_POWERSHELL_EXE);
	assert.deepEqual(call.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	const script = Buffer.from(call.args[4]!, "base64").toString("utf16le");
	const embedded = script.match(/FromBase64String\('([^']*)'\)/)?.[1];
	assert.equal(Buffer.from(embedded!, "base64").toString("utf8"), "C:\\Temp\\gentle-notification-1/sound.wav");
	assert.ok(!script.includes("C:\\audio.wav"));
	children[1]!.stdout.emit("data", WINDOWS_PLAY_ENVELOPE);
	children[1]!.emit("close", 0);
	await playing;
	// The snapshot carries the validated WAV bytes; no Unix I/O and no CLI fallback ran.
	assert.deepEqual(writes[0]!.bytes, wav());
	assert.equal(writes[0]!.mode, 0o600);
	assert.equal(cleaned.length, 2);
	assert.equal(cliSpawns, 0);
});

test("macOS keeps the trusted afplay CLI for WAV and FLAC, never the Windows host", async () => {
	for (const [bytes, extension] of [[wav(), "wav"], [flac(), "flac"]] as const) {
		const backend = createDefaultNotificationBackend("darwin", { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop" });
		const f = fixture("darwin", backend);
		f.setBytes(bytes);
		let done = false; const p = f.play().then(() => { done = true; }); await tick();
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0]!.executable, "/usr/bin/afplay");
		assert.equal(f.calls[0]!.args[0], `/private/audio ; literal/sound.${extension}`);
		f.child.emit("close", 0); await p; assert.equal(done, true);
	}
});
