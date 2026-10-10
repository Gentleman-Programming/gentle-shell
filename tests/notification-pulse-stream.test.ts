import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PulseClient } from "../lib/notification-pulse-client.ts";
import { boundedPulseTagReader, boundedPulseTagWriter } from "../lib/notification-pulse-protocol.ts";
import { parsePulseWav, playPulseWav } from "../lib/notification-pulse-stream.ts";

// --- independent golden encoders (deliberately NOT the production codec) ---
const taggedU32 = (value: number): Buffer => { const b = Buffer.alloc(5); b[0] = 0x4c; b.writeUInt32BE(value, 1); return b; };
const taggedString = (value: string): Buffer => Buffer.concat([Buffer.from([0x74]), Buffer.from(value, "utf8"), Buffer.from([0x00])]);
const boolFalse = (): Buffer => Buffer.from([0x30]);
const usec = (value: number): Buffer => { const b = Buffer.alloc(9); b[0] = 0x55; b.writeBigUInt64BE(BigInt(value), 1); return b; };
const sampleSpec = (format: number, channels: number, rate: number): Buffer => { const b = Buffer.alloc(7); b[0] = 0x61; b[1] = format; b[2] = channels; b.writeUInt32BE(rate, 3); return b; };
const channelMap = (channels: number): Buffer => Buffer.from([0x6d, channels, ...(channels === 1 ? [0] : [1, 2])]);
const reply = (command: number, tag: number, ...args: Buffer[]): Buffer => Buffer.concat([taggedU32(command), taggedU32(tag), ...args]);
const frame = (channel: number, payload: Buffer, flags = 0): Buffer => {
	const header = Buffer.alloc(20);
	header.writeUInt32BE(payload.length, 0); header.writeUInt32BE(channel, 4); header.writeUInt32BE(flags, 16);
	return Buffer.concat([header, payload]);
};
const requestPayload = (index: number, bytes: number): Buffer => reply(61, 0xffffffff, taggedU32(index), taggedU32(bytes));
const taggedValueAt = (payload: Buffer, at: number): number => payload.readUInt32BE(at + 1);
const commandOf = (payload: Buffer): number => taggedValueAt(payload, 0);
const tagOf = (payload: Buffer): number => taggedValueAt(payload, 5);

// --- valid WAV builder (content is what the 9a validator already accepts) ---
function wav(bits: number, channels: number, rate: number, frames: number): Buffer {
	const sampleBytes = bits / 8;
	const dataSize = frames * channels * sampleBytes;
	const b = Buffer.alloc(44 + dataSize, 0x11);
	b.write("RIFF", 0); b.writeUInt32LE(36 + dataSize, 4); b.write("WAVE", 8);
	b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
	b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
	b.writeUInt32LE(rate * channels * sampleBytes, 28);
	b.writeUInt16LE(channels * sampleBytes, 32); b.writeUInt16LE(bits, 34);
	b.write("data", 36); b.writeUInt32LE(dataSize, 40);
	return b;
}
interface PlayState { seen: number[]; pcm: Buffer[]; createPayload?: Buffer; streamIndex: number; drainSender?: () => void; }
interface FakeServer { readonly path: string; readonly state: PlayState; close(): Promise<void>; }
interface PlayScript {
	streamIndex?: number; missing?: number; requests?: number[]; earlyRequestBytes?: number;
	corruptSpec?: boolean; closeAfterFirstChunk?: boolean; errorOnDrain?: boolean; holdDrain?: boolean; unknownRequestIndex?: number;
}
async function startPlaybackServer(script: PlayScript): Promise<FakeServer> {
	const dir = await mkdtemp(join(tmpdir(), "pulse-stream-"));
	const path = join(dir, "native");
	const state: PlayState = { seen: [], pcm: [], streamIndex: script.streamIndex ?? 7 };
	const createReply = (tag: number, spec: { format: number; channels: number; rate: number }): Buffer => {
		const echoed = script.corruptSpec ? { format: spec.format === 0 ? 3 : 0, channels: spec.channels, rate: spec.rate } : spec;
		return reply(2, tag, taggedU32(state.streamIndex), taggedU32(state.streamIndex + 1), taggedU32(script.missing ?? 0),
			taggedU32(0xffffffff), taggedU32(0), taggedU32(0), taggedU32(0),
			sampleSpec(echoed.format, echoed.channels, echoed.rate), channelMap(spec.channels),
			taggedU32(0), taggedString("auto_null"), boolFalse(), usec(0));
	};
	const server: Server = createServer(socket => {
		let buffer = Buffer.alloc(0);
		const write = (value: Buffer) => { if (!socket.destroyed) socket.write(value); };
		const send = (payload: Buffer) => write(frame(0xffffffff, payload));
		socket.on("error", () => { /* client closed mid-write */ });
		socket.on("data", chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 20) break;
				const length = buffer.readUInt32BE(0);
				if (buffer.length < 20 + length) break;
				const payload = Buffer.from(buffer.subarray(20, 20 + length));
				const channel = buffer.readUInt32BE(4);
				buffer = buffer.subarray(20 + length);
				if (channel !== 0xffffffff) { state.pcm.push(payload); if (script.closeAfterFirstChunk) socket.destroy(); continue; }
				const command = commandOf(payload); const tag = tagOf(payload);
				state.seen.push(command);
				if (command === 8) { send(reply(2, tag, taggedU32(35))); continue; }
				if (command === 9) { send(reply(2, tag, taggedU32(0))); continue; }
				if (command === 4) { send(reply(2, tag)); continue; }
				if (command === 12) {
					if (script.errorOnDrain) { send(reply(0, tag, taggedU32(6))); continue; }
					if (script.holdDrain) { state.drainSender = () => send(reply(2, tag)); continue; }
					send(reply(2, tag)); continue;
				}
				if (command === 3) {
					state.createPayload = Buffer.from(payload);
					const spec = { format: payload[11]!, channels: payload[12]!, rate: payload.readUInt32BE(13) };
					let out = frame(0xffffffff, createReply(tag, spec));
					if (script.earlyRequestBytes) out = Buffer.concat([out, frame(0xffffffff, requestPayload(state.streamIndex, script.earlyRequestBytes))]);
					write(out);
					for (const bytes of script.requests ?? []) write(frame(0xffffffff, requestPayload(script.unknownRequestIndex ?? state.streamIndex, bytes)));
					continue;
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
	return { path, state, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}
function fakeClock() {
	let now = 0; let counter = 0;
	const jobs = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimeout: (fn: () => void, ms: number) => { const id = ++counter; jobs.set(id, { at: now + ms, fn }); return id; },
		clearTimeout: (id: number | NodeJS.Timeout) => { jobs.delete(id as number); },
		advance(ms: number) { now += ms; for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.fn(); } },
	};
}
const pcmOf = (bytes: Buffer[]): Buffer => Buffer.concat(bytes);
const dataOf = (bytes: Buffer): Buffer => { let offset = 12; for (;;) { const id = bytes.toString("ascii", offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); if (id === "data") return bytes.subarray(offset + 8, offset + 8 + size); offset += 8 + size + (size % 2); } };

test("parsePulseWav extracts PCM and maps 8/16/24/32-bit mono/stereo", () => {
	const cases: Array<[number, number, number]> = [[8, 1, 8000], [16, 2, 44100], [24, 1, 48000], [32, 2, 192000]];
	for (const [bits, channels, rate] of cases) {
		const bytes = wav(bits, channels, rate, 100);
		const pcm = parsePulseWav(bytes);
		assert.equal(pcm.sampleSpec.format, bits === 8 ? 0 : bits === 16 ? 3 : bits === 24 ? 9 : 7, `${bits}bit`);
		assert.equal(pcm.sampleSpec.channels, channels);
		assert.equal(pcm.sampleSpec.rate, rate);
		assert.equal(pcm.channelMap.length, channels);
		assert.equal(pcm.frameSize, channels * bits / 8);
		assert.deepEqual(pcm.data, dataOf(bytes));
		assert.ok(Object.isFrozen(pcm));
	}
});

test("parsePulseWav rejects invalid and oversized bytes while accepting the 10 s boundary without IO", () => {
	assert.throws(() => parsePulseWav(Buffer.alloc(8)));
	assert.throws(() => parsePulseWav(wav(16, 1, 8000, 100).subarray(0, 40)));
	assert.throws(() => parsePulseWav(wav(16, 3, 8000, 10)));
	assert.throws(() => parsePulseWav(wav(16, 1, 4000, 10)));
	assert.equal(parsePulseWav(wav(16, 1, 8000, 80000)).durationMs, 10000); // exact 10 s boundary
	assert.equal(parsePulseWav(wav(16, 1, 8000, 44640)).durationMs, 5580); // previously rejected 5.58 s
	assert.throws(() => parsePulseWav(wav(16, 1, 8000, 80001))); // just past 10 s
	assert.throws(() => parsePulseWav(wav(32, 2, 192000, 300000))); // > 2 MiB
});

test("playPulseWav rejects invalid bytes before opening a socket", async () => {
	const server = await startPlaybackServer({});
	try {
		await assert.rejects(playPulseWav(Buffer.alloc(8), undefined, { clientOptions: { socketPath: server.path, cookie: Buffer.alloc(256) } }));
		assert.deepEqual(server.state.seen, []);
		assert.deepEqual(server.state.pcm, []);
	} finally { await server.close(); }
});

test("golden CREATE v13 frame pins spec, default sink, flags, volume and proplist", async () => {
	const bytes = wav(16, 2, 44100, 100);
	const server = await startPlaybackServer({ missing: dataOf(bytes).length });
	try {
		await playPulseWav(bytes, undefined, { clientOptions: { socketPath: server.path, cookie: Buffer.alloc(256) } });
		const payload = server.state.createPayload!;
		assert.equal(commandOf(payload), 3);
		assert.equal(payload[10], 0x61); // sample_spec
		assert.equal(payload[11], 3); assert.equal(payload[12], 2); assert.equal(payload.readUInt32BE(13), 44100);
		assert.equal(payload[17], 0x6d); // channel_map
		assert.equal(payload[18], 2);
		const sinkIndexAt = 17 + 2 + 2;
		assert.equal(taggedValueAt(payload, sinkIndexAt), 0xffffffff);
		assert.equal(payload[sinkIndexAt + 5], 0x4e); // sink_name null
		const proplistAt = payload.indexOf(0x50, sinkIndexAt);
		assert.ok(payload.indexOf(Buffer.from("media.name\0", "latin1")) > proplistAt);
		assert.ok(payload.indexOf(Buffer.from("media.role\0", "latin1")) > proplistAt);
		assert.ok(payload.indexOf(Buffer.from("event\0", "latin1")) > proplistAt);
		// seven explicit false flags, muted false, adjust_latency false
		assert.ok(payload.subarray(sinkIndexAt).includes(boolFalse()));
		assert.deepEqual(pcmOf(server.state.pcm), dataOf(bytes));
		assert.deepEqual(server.state.seen.slice(-2), [12, 4]);
	} finally { await server.close(); }
});

test("initial missing plus later REQUEST drives aligned PCM and completes drain/delete", async () => {
	const bytes = wav(16, 1, 8000, 500); const data = dataOf(bytes);
	const server = await startPlaybackServer({ missing: 2, requests: [data.length - 2] });
	try {
		await playPulseWav(bytes, undefined, { clientOptions: { socketPath: server.path, cookie: Buffer.alloc(256) } });
		assert.deepEqual(pcmOf(server.state.pcm), data);
		for (const chunk of server.state.pcm) assert.equal(chunk.length % 2, 0);
		assert.deepEqual(server.state.seen.slice(-2), [12, 4]);
	} finally { await server.close(); }
});

test("early coalesced REQUEST right after the CREATE reply is queued and folded", async () => {
	const bytes = wav(16, 1, 8000, 200); const data = dataOf(bytes);
	const server = await startPlaybackServer({ missing: 2, earlyRequestBytes: data.length - 2 });
	try {
		await playPulseWav(bytes, undefined, { clientOptions: { socketPath: server.path, cookie: Buffer.alloc(256) } });
		assert.deepEqual(pcmOf(server.state.pcm), data);
	} finally { await server.close(); }
});

test("tiny unaligned requests accumulate until a whole frame and huge requests stay bounded", async () => {
	const bytes = wav(16, 1, 8000, 64); const data = dataOf(bytes);
	const server = await startPlaybackServer({ missing: 0, requests: [1, 1, 1, 0xffffffff] });
	try {
		await playPulseWav(bytes, undefined, { clientOptions: { socketPath: server.path, cookie: Buffer.alloc(256) } });
		assert.deepEqual(pcmOf(server.state.pcm), data);
		assert.ok(server.state.pcm.every(chunk => chunk.length <= 64 * 1024 && chunk.length % 2 === 0));
	} finally { await server.close(); }
});

test("mismatched spec and unknown-stream requests fail before/without PCM", async () => {
	const bytes = wav(16, 1, 8000, 100);
	const mismatch = await startPlaybackServer({ missing: dataOf(bytes).length, corruptSpec: true });
	try { await assert.rejects(playPulseWav(bytes, undefined, { clientOptions: { socketPath: mismatch.path, cookie: Buffer.alloc(256) } }), /Pulse stream/); }
	finally { await mismatch.close(); }

	const unknown = await startPlaybackServer({ missing: 0, requests: [100], unknownRequestIndex: 99 });
	try { await assert.rejects(playPulseWav(bytes, undefined, { clientOptions: { socketPath: unknown.path, cookie: Buffer.alloc(256) } }), /Pulse stream/); }
	finally { await unknown.close(); }
});

test("ERROR on drain and truncated PCM fail closed with best-effort cleanup", async () => {
	const bytes = wav(16, 1, 8000, 300);
	const errorServer = await startPlaybackServer({ missing: dataOf(bytes).length, errorOnDrain: true });
	try {
		await assert.rejects(playPulseWav(bytes, undefined, { clientOptions: { socketPath: errorServer.path, cookie: Buffer.alloc(256) } }), /Pulse client|Pulse stream/);
		assert.deepEqual(pcmOf(errorServer.state.pcm), dataOf(bytes)); // no extra PCM after the error
	} finally { await errorServer.close(); }

	const truncating = await startPlaybackServer({ missing: dataOf(bytes).length, closeAfterFirstChunk: true });
	try { await assert.rejects(playPulseWav(bytes, undefined, { clientOptions: { socketPath: truncating.path, cookie: Buffer.alloc(256) } }), /Pulse client|Pulse stream/); }
	finally { await truncating.close(); }
});

test("a stalled demand fails by the playback budget instead of hanging", async () => {
	const bytes = wav(16, 1, 8000, 100);
	const server = await startPlaybackServer({ missing: 2, requests: [] });
	try { await assert.rejects(playPulseWav(bytes, undefined, { clientOptions: { socketPath: server.path, cookie: Buffer.alloc(256) }, budgetMs: 120 }), /budget|Pulse/); }
	finally { await server.close(); }
});

test("DRAIN may exceed the 900 ms default via a bounded per-request deadline", async () => {
	const bytes = wav(16, 1, 8000, 100); const data = dataOf(bytes);
	const server = await startPlaybackServer({ missing: data.length, holdDrain: true });
	const clock = fakeClock();
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(256), requestTimeoutMs: 900, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		await client.connect();
		let settled = false;
		const playing = playPulseWav(bytes, undefined, { client, requestTimeoutMs: 6000 }).then(() => { settled = true; }, error => { settled = true; throw error; });
		for (let i = 0; i < 20 && !server.state.drainSender; i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.ok(server.state.drainSender, "drain reached");
		clock.advance(1200); // beyond the 900 ms default, within the 6000 ms override
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(settled, false);
		server.state.drainSender!();
		await playing;
		await client.close();
	} finally { await server.close(); }
});

test("default engine request deadline allows a full 10 s drain instead of the old 6 s", async () => {
	const bytes = wav(16, 1, 8000, 100); const data = dataOf(bytes);
	const server = await startPlaybackServer({ missing: data.length, holdDrain: true });
	const clock = fakeClock();
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(256), requestTimeoutMs: 900, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		await client.connect();
		let settled = false;
		const playing = playPulseWav(bytes, undefined, { client }).then(() => { settled = true; }, () => { settled = true; });
		for (let i = 0; i < 20 && !server.state.drainSender; i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.ok(server.state.drainSender, "drain reached");
		clock.advance(10000); // past the old 6000 ms deadline, still inside the 10 s duration
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(settled, false);
		clock.advance(1000); // now past the new 11000 ms deadline
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(settled, true);
		await playing;
		await client.close();
	} finally { await server.close(); }
});

test("abort during drain best-effort deletes and closes without extra PCM", async () => {
	const bytes = wav(16, 1, 8000, 100); const data = dataOf(bytes);
	const server = await startPlaybackServer({ missing: data.length, holdDrain: true });
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(256) });
		await client.connect();
		const controller = new AbortController();
		const playing = playPulseWav(bytes, controller.signal, { client });
		for (let i = 0; i < 20 && !server.state.drainSender; i++) await new Promise(resolve => setTimeout(resolve, 5));
		controller.abort();
		await assert.rejects(playing, /aborted|Pulse/);
		assert.deepEqual(pcmOf(server.state.pcm), data);
		assert.ok(server.state.seen.includes(4)); // best-effort DELETE while the link is still usable
		await client.close();
	} finally { await server.close(); }
});

test("sendDataFrame returns a promise for backpressure and closes asynchronously", async () => {
	const server = await startPlaybackServer({});
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(256) });
		await client.connect();
		assert.ok(client.sendDataFrame(5, Buffer.from([1, 2])) instanceof Promise);
		await client.sendDataFrame(5, Buffer.from([3, 4]));
		await client.close();
	} finally { await server.close(); }
});

test("more than 32 coalesced early REQUESTs fail closed before any PCM", async () => {
	type Listener = (command: number, reader: ReturnType<typeof boundedPulseTagReader>) => void;
	const listeners = new Set<Listener>();
	const requestReader = (index: number, bytes: number) => boundedPulseTagReader(boundedPulseTagWriter().u32(index).u32(bytes).finish());
	const createReply = boundedPulseTagWriter().u32(7).u32(8).u32(0).u32(0).u32(0).u32(0).u32(0)
		.sampleSpec({ format: 3, channels: 1, rate: 8000 }).channelMap([0]).u32(0).string(null).boolean(false).usec(0n).finish();
	const sent: Buffer[] = [];
	const client = {
		onEvent: (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		request: async (command: number) => {
			if (command === 3) for (let index = 0; index < 33; index++) for (const listener of listeners) listener(61, requestReader(7, 1));
			return boundedPulseTagReader(createReply);
		},
		sendDataFrame: async (_channel: number, payload: Uint8Array) => { sent.push(Buffer.from(payload)); },
		close: async () => {},
	} as unknown as PulseClient;
	await assert.rejects(playPulseWav(wav(16, 1, 8000, 64), undefined, { client }), /early|too many/);
	assert.deepEqual(sent, []);
});
