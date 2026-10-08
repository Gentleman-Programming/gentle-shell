import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativePulsePlayer, NATIVE_PULSE_SCHEMA, type NativePulseOptions, type NativePulseSpawnOptions } from "../lib/notification-audio-native.ts";

// --- independent golden encoders (deliberately NOT the production codec) ---
const taggedU32 = (value: number): Buffer => { const b = Buffer.alloc(5); b[0] = 0x4c; b.writeUInt32BE(value, 1); return b; };
const taggedString = (value: string): Buffer => Buffer.concat([Buffer.from([0x74]), Buffer.from(value, "utf8"), Buffer.from([0x00])]);
const nullString = (): Buffer => Buffer.from([0x4e]);
const boolFalse = (): Buffer => Buffer.from([0x30]);
const usec = (value: number): Buffer => { const b = Buffer.alloc(9); b[0] = 0x55; b.writeBigUInt64BE(BigInt(value), 1); return b; };
const sampleSpec = (format: number, channels: number, rate: number): Buffer => { const b = Buffer.alloc(7); b[0] = 0x61; b[1] = format; b[2] = channels; b.writeUInt32BE(rate, 3); return b; };
const channelMap = (channels: number): Buffer => Buffer.from([0x6d, channels, ...(channels === 1 ? [0] : [1, 2])]);
const reply = (command: number, tag: number, ...args: Buffer[]): Buffer => Buffer.concat([taggedU32(command), taggedU32(tag), ...args]);
const frame = (channel: number, payload: Buffer): Buffer => { const header = Buffer.alloc(20); header.writeUInt32BE(payload.length, 0); header.writeUInt32BE(channel, 4); return Buffer.concat([header, payload]); };
const taggedValueAt = (payload: Buffer, at: number): number => payload.readUInt32BE(at + 1);

function wav(bits: number, channels: number, rate: number, frames: number): Buffer {
	const sampleBytes = bits / 8; const dataSize = frames * channels * sampleBytes;
	const b = Buffer.alloc(44 + dataSize, 0x11);
	b.write("RIFF", 0); b.writeUInt32LE(36 + dataSize, 4); b.write("WAVE", 8);
	b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
	b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * sampleBytes, 28);
	b.writeUInt16LE(channels * sampleBytes, 32); b.writeUInt16LE(bits, 34);
	b.write("data", 36); b.writeUInt32LE(dataSize, 40);
	return b;
}
function dataOf(bytes: Buffer): Buffer { let offset = 12; for (;;) { const id = bytes.toString("ascii", offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); if (id === "data") return bytes.subarray(offset + 8, offset + 8 + size); offset += 8 + size + (size % 2); } }

interface FakeServer { readonly path: string; readonly seen: number[]; readonly pcm: Buffer[]; close(): Promise<void>; }
async function startFakeServer(): Promise<FakeServer> {
	const dir = mkdtempSync(join(tmpdir(), "native-pulse-"));
	const path = join(dir, "native");
	const seen: number[] = []; const pcm: Buffer[] = [];
	const server: Server = createServer(socket => {
		let buffer = Buffer.alloc(0);
		const write = (value: Buffer) => { if (!socket.destroyed) socket.write(value); };
		const send = (payload: Buffer) => write(frame(0xffffffff, payload));
		socket.on("error", () => { /* child closed */ });
		socket.on("data", chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 20) break;
				const length = buffer.readUInt32BE(0);
				if (buffer.length < 20 + length) break;
				const payload = Buffer.from(buffer.subarray(20, 20 + length));
				const channel = buffer.readUInt32BE(4);
				buffer = buffer.subarray(20 + length);
				if (channel !== 0xffffffff) { pcm.push(payload); continue; }
				const command = taggedValueAt(payload, 0); const tag = taggedValueAt(payload, 5);
				seen.push(command);
				if (command === 8) { send(reply(2, tag, taggedU32(35))); continue; }
				if (command === 9) { send(reply(2, tag, taggedU32(0))); continue; }
				if (command === 20) { send(reply(2, tag, taggedString("pulseaudio"), taggedString("17.0"), taggedString("user"), taggedString("host"), sampleSpec(3, 1, 8000), taggedString("auto_null"), nullString(), taggedU32(1))); continue; }
				if (command === 3) {
					const spec = { format: payload[11]!, channels: payload[12]!, rate: payload.readUInt32BE(13) };
					const dataLength = 0; // worker sends initial missing = 0 then requests; keep it simple
					write(frame(0xffffffff, reply(2, tag, taggedU32(7), taggedU32(8), taggedU32(dataLength), taggedU32(0xffffffff), taggedU32(0), taggedU32(0), taggedU32(0), sampleSpec(spec.format, spec.channels, spec.rate), channelMap(spec.channels), taggedU32(0), taggedString("auto_null"), boolFalse(), usec(0))));
					write(frame(0xffffffff, reply(61, 0xffffffff, taggedU32(7), taggedU32(64 * 1024))));
					continue;
				}
				if (command === 12) { send(reply(2, tag)); continue; }
				if (command === 4) { send(reply(2, tag)); continue; }
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
	return { path, seen, pcm, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}

class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly kills: string[] = [];
	kill(signal: string): boolean { this.kills.push(signal); return true; }
}
function recorder(platform = "linux", overrides: Partial<NativePulseOptions> = {}) {
	const spawned: Array<{ executable: string; args: string[]; options: NativePulseSpawnOptions }> = [];
	const children: FakeChild[] = [];
	const player = new NativePulsePlayer({
		platform,
		spawn: (executable, args, options) => { spawned.push({ executable, args, options }); const child = new FakeChild(); children.push(child); return child; },
		env: { PULSE_SERVER: "unix:/tmp/x", NODE_OPTIONS: "--inspect", DEBUG: "*", HOME: "/home/u" },
		...overrides,
	});
	return { player, spawned, children };
}
const okProbe = () => JSON.stringify({ schema: NATIVE_PULSE_SCHEMA, ok: true, available: true, formats: ["wav"] });

test("bridge is lazy and spawns owned Node with fixed flags, scrubbed env and Linux only", async () => {
	const { player, spawned, children } = recorder();
	assert.deepEqual(spawned, []);
	const probing = player.probe();
	assert.equal(spawned.length, 1);
	const [call] = spawned;
	assert.equal(call.executable, process.execPath);
	assert.equal(call.args[0], "--experimental-strip-types");
	assert.equal(call.args[1], "--max-old-space-size=32");
	assert.match(call.args[2]!, /notification-pulse-worker\.ts$/);
	assert.equal(call.args[3], "probe");
	assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
	assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.options.detached, false);
	const env = call.options.env as NodeJS.ProcessEnv;
	assert.equal(env.NODE_NO_WARNINGS, "1"); assert.equal(env.GENTLE_PI_AGENTS_CHILD, "1");
	assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.DEBUG, undefined); assert.equal(env.PULSE_SERVER, "unix:/tmp/x");
	assert.deepEqual(player.getNativeFormats(), []); // default unavailable until a real probe
	children[0]!.stdout.emit("data", okProbe());
	children[0]!.emit("close");
	assert.deepEqual(await probing, { available: true, formats: ["wav"] });
	assert.deepEqual(player.getNativeFormats(), ["wav"]);
});

test("abort before spawn performs no work and unsupported platforms never spawn", async () => {
	const { player, spawned } = recorder();
	const controller = new AbortController(); controller.abort();
	assert.deepEqual(await player.probe(controller.signal), { available: false, formats: [] });
	assert.equal(spawned.length, 0);
	for (const platform of ["darwin", "win32"]) {
		const other = recorder(platform);
		assert.equal(other.player.supportsTarget(), false);
		assert.deepEqual(await other.player.probe(), { available: false, formats: [] });
		await assert.rejects(other.player.play("/tmp/s.wav"), /Native pulse|unsupported/);
		assert.equal(other.spawned.length, 0);
	}
});

test("play gate false prevents spawning and no async runs after it", async () => {
	const { player, spawned } = recorder();
	await assert.rejects(player.play("/tmp/s.wav", undefined, () => false), /permit/);
	assert.equal(spawned.length, 0);
	const { player: second, spawned: secondSpawned, children } = recorder();
	const playing = second.play("/tmp/s.wav", undefined, { permit: () => true });
	assert.equal(secondSpawned.length, 1);
	children[0]!.stdout.emit("data", JSON.stringify({ schema: NATIVE_PULSE_SCHEMA, ok: true, played: true }));
	children[0]!.emit("close");
	await playing;
});

test("malformed, oversize and error output fail privately and kill at most once", async () => {
	const malformed = recorder();
	const malformedProbe = malformed.player.probe();
	malformed.children[0]!.stdout.emit("data", "not json");
	malformed.children[0]!.emit("close");
	assert.deepEqual(await malformedProbe, { available: false, formats: [] });
	assert.equal(malformed.player.getNativeFormats().length, 0);

	const oversize = recorder();
	const oversizeProbe = oversize.player.probe();
	oversize.children[0]!.stdout.emit("data", "x".repeat(2048));
	assert.equal(oversize.children[0]!.kills.length, 1);
	assert.equal(oversize.children[0]!.kills[0], "SIGKILL");
	oversize.children[0]!.emit("close");
	assert.deepEqual(await oversizeProbe, { available: false, formats: [] });

	const failure = recorder();
	const playing = failure.player.play("/private/snapshot.wav");
	failure.children[0]!.stdout.emit("data", JSON.stringify({ schema: NATIVE_PULSE_SCHEMA, ok: false }));
	failure.children[0]!.emit("close");
	await assert.rejects(playing, (error: Error) => /Native pulse/.test(error.message) && !/snapshot|cookie|\/private/.test(error.message));
});

test("timeout and abort SIGKILL once and settle only on close", async () => {
	const timed = recorder("linux", { probeTimeoutMs: 15 });
	const probing = timed.player.probe();
	await new Promise(resolve => setTimeout(resolve, 45));
	assert.deepEqual(timed.children[0]!.kills, ["SIGKILL"]);
	let settled = false; void probing.then(() => { settled = true; });
	timed.children[0]!.emit("exit", 0);
	timed.children[0]!.emit("error", new Error("spawn failed")); // Node emits close after error
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(settled, false);
	timed.children[0]!.emit("close");
	assert.deepEqual(await probing, { available: false, formats: [] });

	const aborted = recorder();
	const controller = new AbortController();
	const playing = aborted.player.play("/tmp/s.wav", controller.signal);
	controller.abort();
	assert.deepEqual(aborted.children[0]!.kills, ["SIGKILL"]);
	aborted.children[0]!.emit("close");
	await assert.rejects(playing, /aborted|Native pulse/);
});

test("default play deadline is 11000 ms and outlives the accepted 10 s maximum", async () => {
	let scheduledMs = 0; let fire: (() => void) | undefined;
	const { player, children } = recorder("linux", {
		setTimeout: (callback, ms) => { scheduledMs = ms; fire = callback; return 1; },
		clearTimeout: () => {},
	});
	const playing = player.play("/tmp/s.wav", undefined, () => true);
	assert.equal(children.length, 1);
	assert.equal(scheduledMs, 11000);
	assert.ok(scheduledMs > 10000, "the native bridge must outlive the accepted 10 s file");
	assert.deepEqual(children[0]!.kills, []);
	fire!();
	assert.deepEqual(children[0]!.kills, ["SIGKILL"]);
	children[0]!.emit("close");
	await assert.rejects(playing, /Native pulse/);
});

test("probe never throws for offline/malformed IPC while play rejects and cleans", async () => {
	const { player, children } = recorder();
	const probing = player.probe();
	children[0]!.stdout.emit("data", JSON.stringify({ schema: "wrong", ok: true, available: true, formats: ["wav"] }));
	children[0]!.emit("close");
	assert.deepEqual(await probing, { available: false, formats: [] });
	const { player: playPlayer, children: playChildren } = recorder();
	const playing = playPlayer.play("/tmp/s.wav");
	playChildren[0]!.stdout.emit("data", JSON.stringify({ schema: "wrong", ok: true, played: true }));
	playChildren[0]!.emit("close");
	await assert.rejects(playing, /Native pulse/);
});

test("bridge and worker import no SDK, UI, or addon surface", () => {
	for (const path of ["lib/notification-audio-native.ts", "lib/notification-pulse-worker.ts"]) {
		const source = readFileSync(join(process.cwd(), path), "utf8");
		assert.doesNotMatch(source, /@earendil-works/, path);
		assert.doesNotMatch(source, /from\s+["'][^"']*extensions\//, path);
		assert.doesNotMatch(source, /native\/|\.node["']/, path);
	}
});

test("child environment is an allowlist: Pulse vars kept, credentials and debug dropped", async () => {
	const captured: NodeJS.ProcessEnv[] = [];
	const player = new NativePulsePlayer({
		platform: "linux",
		spawn: (_executable, _args, options) => { captured.push(options.env); return new FakeChild(); },
		env: { PULSE_SERVER: "unix:/s", PULSE_COOKIE: "/c", XDG_RUNTIME_DIR: "/r", XDG_CONFIG_HOME: "/cfg", HOME: "/h", LANG: "C",
			OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y", NODE_OPTIONS: "--inspect", NODE_PATH: "/n", DEBUG: "*", PATH: "/bin" },
	});
	void player.probe();
	const env = captured[0]!;
	assert.equal(env.PULSE_SERVER, "unix:/s"); assert.equal(env.PULSE_COOKIE, "/c");
	assert.equal(env.XDG_RUNTIME_DIR, "/r"); assert.equal(env.XDG_CONFIG_HOME, "/cfg"); assert.equal(env.HOME, "/h"); assert.equal(env.LANG, "C");
	for (const drop of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "NODE_PATH", "DEBUG", "PATH"])
		assert.equal(env[drop], undefined, drop);
	assert.equal(env.NODE_NO_WARNINGS, "1"); assert.equal(env.GENTLE_PI_AGENTS_CHILD, "1");
});

test("real worker probe against a fake Unix socket authenticates without CREATE", async () => {
	const server = await startFakeServer();
	try {
		const player = new NativePulsePlayer({ env: { ...process.env, PULSE_SERVER: `unix:${server.path}` }, probeTimeoutMs: 8000 });
		const result = await player.probe();
		assert.deepEqual(result, { available: true, formats: ["wav"] });
		assert.deepEqual(server.seen, [8, 9, 20]);
		assert.ok(!server.seen.includes(3), "probe must not create a stream");
	} finally { await server.close(); }
});

test("real worker plays a fake PCM snapshot to a fake socket with no OS audio", async () => {
	const bytes = wav(16, 1, 8000, 800);
	const dir = mkdtempSync(join(tmpdir(), "native-pulse-snap-"));
	const snapshot = join(dir, "sound.wav");
	writeFileSync(snapshot, bytes, { mode: 0o400 });
	const server = await startFakeServer();
	try {
		const player = new NativePulsePlayer({ env: { ...process.env, PULSE_SERVER: `unix:${server.path}` }, playTimeoutMs: 8000 });
		await player.play(snapshot);
		assert.deepEqual(Buffer.concat(server.pcm), dataOf(bytes));
		assert.ok(server.seen.includes(3) && server.seen.includes(12) && server.seen.includes(4));
		assert.ok(existsSync(snapshot), "the bridge/worker must not delete the snapshot; the owner does");
	} finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real worker rejects invalid WAV before opening the socket", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-pulse-bad-"));
	const snapshot = join(dir, "sound.wav");
	writeFileSync(snapshot, Buffer.alloc(64, 0x00), { mode: 0o400 });
	const server = await startFakeServer();
	try {
		const player = new NativePulsePlayer({ env: { ...process.env, PULSE_SERVER: `unix:${server.path}` }, playTimeoutMs: 8000 });
		await assert.rejects(player.play(snapshot), /Native pulse/);
		assert.deepEqual(server.seen, []);
	} finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
