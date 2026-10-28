/**
 * Minimal PulseAudio native-protocol v13 codec: tagstruct primitives plus the
 * 20-byte pstream frame descriptor. This is an original MIT (repo-licensed)
 * implementation derived only from the official protocol declaration; no
 * PulseAudio/LGPL implementation code is copied.
 *
 * Protocol reference (read-only, PulseAudio v17.0):
 *   PROTOCOL; src/pulsecore/native-common.h; src/pulsecore/tagstruct.[ch];
 *   src/pulsecore/pstream.[ch]; src/pulse/sample.h.
 *
 * Pure module: no sockets, no cookies, no clocks, no process, no backend IO.
 */
export const NATIVE_PROTOCOL_VERSION = 13;
export const CONTROL_CHANNEL = 0xffffffff;
export const MAX_CONTROL_PAYLOAD = 64 * 1024;
export const MAX_FRAMES_PER_PUSH = 32;
export const PULSE_FRAME_HEADER_SIZE = 20;

/** Command values are the C enum order of native-common.h (the enum is the wire value). */
export const PulseCommand = {
	ERROR: 0, TIMEOUT: 1, REPLY: 2, CREATE_PLAYBACK_STREAM: 3, DELETE_PLAYBACK_STREAM: 4,
	AUTH: 8, SET_CLIENT_NAME: 9, DRAIN_PLAYBACK_STREAM: 12, GET_SERVER_INFO: 20, REQUEST: 61,
} as const;
export type PulseCommand = (typeof PulseCommand)[keyof typeof PulseCommand];

/** Sample format values from sample.h. S24LE/S24BE are packed 24-bit; S24_32* are not. */
export const PulseSampleFormat = {
	U8: 0, ALAW: 1, ULAW: 2, S16LE: 3, S16BE: 4, FLOAT32LE: 5, FLOAT32BE: 6,
	S32LE: 7, S32BE: 8, S24LE: 9, S24BE: 10, S24_32LE: 11, S24_32BE: 12,
} as const;

export interface PulseSampleSpec { readonly format: number; readonly channels: number; readonly rate: number; }
export interface PulseFrame {
	readonly channel: number;
	readonly offset: bigint;
	readonly flags: number;
	readonly payload: Buffer;
}

const TAG_STRING = 0x74; // 't'
const TAG_STRING_NULL = 0x4e; // 'N'
const TAG_U32 = 0x4c; // 'L'
const TAG_U8 = 0x42; // 'B'
const TAG_ARBITRARY = 0x78; // 'x'
const TAG_BOOLEAN_TRUE = 0x31; // '1'
const TAG_BOOLEAN_FALSE = 0x30; // '0'
const TAG_USEC = 0x55; // 'U'
const TAG_SAMPLE_SPEC = 0x61; // 'a'
const TAG_CHANNEL_MAP = 0x6d; // 'm'
const TAG_CVOLUME = 0x76; // 'v'
const TAG_PROPLIST = 0x50; // 'P'
const NUL = Buffer.from([0]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Generic, data-free failure: never echoes field values or cookie/key contents. */
function fail(message: string): never { throw new Error(`Pulse protocol: ${message}`); }

function appendU32(target: Buffer, value: number, offset: number): void { target.writeUInt32BE(value, offset); }

/** Bounded chainable tagstruct writer. */
export class PulseTagWriter {
	private readonly chunks: Buffer[] = [];
	private size = 0;

	private append(chunk: Buffer): this {
		if (this.size + chunk.length > MAX_CONTROL_PAYLOAD) fail("tag payload too large");
		this.size += chunk.length;
		this.chunks.push(chunk);
		return this;
	}

	u32(value: number): this {
		if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail("u32 out of range");
		const head = Buffer.allocUnsafe(5);
		head[0] = TAG_U32;
		appendU32(head, value, 1);
		return this.append(head);
	}

	u8(value: number): this {
		if (!Number.isInteger(value) || value < 0 || value > 0xff) fail("u8 out of range");
		return this.append(Buffer.from([TAG_U8, value]));
	}

	string(value: string | null): this {
		if (value === null) return this.append(Buffer.from([TAG_STRING_NULL]));
		if (typeof value !== "string" || value.includes("\0")) fail("invalid string");
		return this.append(Buffer.concat([Buffer.from([TAG_STRING]), Buffer.from(value, "utf8"), NUL]));
	}

	arbitrary(value: Uint8Array): this {
		if (!(value instanceof Uint8Array) || value.length > MAX_CONTROL_PAYLOAD) fail("arbitrary out of range");
		const head = Buffer.allocUnsafe(5);
		head[0] = TAG_ARBITRARY;
		appendU32(head, value.length, 1);
		return this.append(head).append(Buffer.from(value.buffer, value.byteOffset, value.length));
	}

	boolean(value: boolean): this {
		if (typeof value !== "boolean") fail("invalid boolean");
		return this.append(Buffer.from([value ? TAG_BOOLEAN_TRUE : TAG_BOOLEAN_FALSE]));
	}

	usec(value: bigint): this {
		if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) fail("usec out of range");
		const head = Buffer.allocUnsafe(9);
		head[0] = TAG_USEC;
		head.writeBigUInt64BE(value, 1);
		return this.append(head);
	}

	sampleSpec(spec: PulseSampleSpec): this {
		if (!spec || !Number.isInteger(spec.format) || spec.format < 0 || spec.format > 0xff) fail("invalid sample format");
		if (!Number.isInteger(spec.channels) || spec.channels < 1 || spec.channels > 0xff) fail("invalid sample channels");
		if (!Number.isInteger(spec.rate) || spec.rate < 0 || spec.rate > 0xffffffff) fail("invalid sample rate");
		const body = Buffer.allocUnsafe(7);
		body[0] = TAG_SAMPLE_SPEC;
		body[1] = spec.format;
		body[2] = spec.channels;
		appendU32(body, spec.rate, 3);
		return this.append(body);
	}

	channelMap(positions: readonly number[]): this {
		if (!Array.isArray(positions) || positions.length < 1 || positions.length > 0xff
			|| !positions.every(position => Number.isInteger(position) && position >= 0 && position <= 0xff))
			fail("invalid channel map");
		return this.append(Buffer.from([TAG_CHANNEL_MAP, positions.length, ...positions]));
	}

	cvolume(volumes: readonly number[]): this {
		if (!Array.isArray(volumes) || volumes.length < 1 || volumes.length > 0xff
			|| !volumes.every(volume => Number.isInteger(volume) && volume >= 0 && volume <= 0xffffffff))
			fail("invalid cvolume");
		const body = Buffer.allocUnsafe(2 + volumes.length * 4);
		body[0] = TAG_CVOLUME;
		body[1] = volumes.length;
		volumes.forEach((volume, index) => appendU32(body, volume, 2 + index * 4));
		return this.append(body);
	}

	/** Every entry is `string` key + tagged `u32` length + arbitrary raw-length value; `'N'` ends it. */
	proplist(entries: Iterable<readonly [string, string | Uint8Array]>): this {
		const seen = new Set<string>();
		this.append(Buffer.from([TAG_PROPLIST]));
		for (const [key, value] of entries) {
			if (typeof key !== "string" || key.length === 0 || /[\x00-\x1f\x7f]/.test(key)) fail("invalid proplist key");
			if (seen.has(key)) fail("duplicate proplist key");
			seen.add(key);
			const bytes = typeof value === "string" ? Buffer.concat([Buffer.from(value, "utf8"), NUL]) : Buffer.from(value);
			if (bytes.length > MAX_CONTROL_PAYLOAD) fail("proplist value too large");
			this.string(key);
			this.u32(bytes.length);
			this.arbitrary(bytes);
		}
		return this.append(Buffer.from([TAG_STRING_NULL]));
	}

	finish(): Buffer { return Buffer.concat(this.chunks, this.size); }
}

export function boundedPulseTagWriter(): PulseTagWriter { return new PulseTagWriter(); }

/** Exact-range tagstruct reader; any exhaustion or tag mismatch throws a generic error. */
export class PulseTagReader {
	private readonly data: Buffer;
	private offset = 0;

	constructor(data: Buffer) { this.data = data; }

	private take(count: number): Buffer {
		if (!Number.isInteger(count) || count < 0 || this.offset + count > this.data.length) fail("read out of range");
		const slice = this.data.subarray(this.offset, this.offset + count);
		this.offset += count;
		return slice;
	}

	private expect(tag: number): void { if (this.take(1)[0] !== tag) fail("unexpected tag"); }

	u32(): number { this.expect(TAG_U32); return this.take(4).readUInt32BE(0); }
	u8(): number { this.expect(TAG_U8); return this.take(1)[0]!; }

	string(): string | null {
		const tag = this.take(1)[0];
		if (tag === TAG_STRING_NULL) return null;
		if (tag !== TAG_STRING) fail("unexpected tag");
		let end = this.offset;
		while (end < this.data.length && this.data[end] !== 0) end++;
		if (end >= this.data.length) fail("unterminated string");
		const bytes = Buffer.from(this.take(end - this.offset));
		this.take(1); // trailing NUL
		try { return utf8.decode(bytes); } catch { return fail("invalid UTF-8 string"); }
	}

	arbitrary(): Buffer {
		this.expect(TAG_ARBITRARY);
		const length = this.take(4).readUInt32BE(0);
		if (length > MAX_CONTROL_PAYLOAD) fail("arbitrary too large");
		return Buffer.from(this.take(length));
	}

	boolean(): boolean {
		const tag = this.take(1)[0];
		if (tag === TAG_BOOLEAN_TRUE) return true;
		if (tag === TAG_BOOLEAN_FALSE) return false;
		return fail("unexpected tag");
	}

	usec(): bigint { this.expect(TAG_USEC); return this.take(8).readBigUInt64BE(0); }

	sampleSpec(): PulseSampleSpec {
		this.expect(TAG_SAMPLE_SPEC);
		const body = this.take(6);
		return { format: body[0]!, channels: body[1]!, rate: body.readUInt32BE(2) };
	}

	channelMap(): number[] {
		this.expect(TAG_CHANNEL_MAP);
		const channels = this.take(1)[0]!;
		if (channels === 0) fail("invalid channel map");
		return [...this.take(channels)];
	}

	cvolume(): number[] {
		this.expect(TAG_CVOLUME);
		const channels = this.take(1)[0]!;
		if (channels === 0) fail("invalid cvolume");
		const body = this.take(channels * 4);
		return Array.from({ length: channels }, (_, index) => body.readUInt32BE(index * 4));
	}

	proplist(): Map<string, Buffer> {
		this.expect(TAG_PROPLIST);
		const entries = new Map<string, Buffer>();
		for (;;) {
			const key = this.string();
			if (key === null) break;
			const declared = this.u32();
			const value = this.arbitrary();
			if (value.length !== declared) fail("proplist length mismatch");
			if (entries.has(key)) fail("duplicate proplist key");
			entries.set(key, value);
		}
		return entries;
	}

	assertEOF(): void { if (this.offset !== this.data.length) fail("trailing bytes"); }
}

export function boundedPulseTagReader(data: Buffer): PulseTagReader { return new PulseTagReader(data); }

/** Control frames carry a tagged payload on channel 0xffffffff; PCM memblocks carry raw bytes. */
function validateDescriptor(channel: number, offset: bigint, flags: number): void {
	if (channel === CONTROL_CHANNEL) {
		if (offset !== 0n) fail("control frame offset must be zero");
		if (flags !== 0) fail("control frame flags must be zero");
		return;
	}
	if ((flags & 0xff000000) !== 0) fail("unsupported shared-memory frame flags");
	if ((flags & 0xff) > 2) fail("invalid seek mode");
}

export function encodePulseFrame(descriptor: { channel: number; offset: bigint; flags: number }, payload: Uint8Array): Buffer {
	const { channel, offset, flags } = descriptor;
	if (!Number.isInteger(channel) || channel < 0 || channel > 0xffffffff) fail("invalid channel");
	if (typeof offset !== "bigint" || offset < 0n || offset > 0xffffffffffffffffn) fail("invalid offset");
	if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) fail("invalid flags");
	if (!(payload instanceof Uint8Array) || payload.length < 1 || payload.length > MAX_CONTROL_PAYLOAD) fail("invalid frame payload");
	validateDescriptor(channel, offset, flags);
	const header = Buffer.allocUnsafe(PULSE_FRAME_HEADER_SIZE);
	appendU32(header, payload.length, 0);
	appendU32(header, channel, 4);
	appendU32(header, Number(offset >> 32n), 8);
	appendU32(header, Number(offset & 0xffffffffn), 12);
	appendU32(header, flags, 16);
	return Buffer.concat([header, Buffer.from(payload.buffer, payload.byteOffset, payload.length)]);
}

/** Incremental descriptor decoder: handles fragmented and coalesced frames, bounded per push. */
export class PulseFrameDecoder {
	private buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): PulseFrame[] {
		if (chunk.length > 0) this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)]);
		const frames: PulseFrame[] = [];
		for (;;) {
			if (this.buffer.length < PULSE_FRAME_HEADER_SIZE) break;
			const length = this.buffer.readUInt32BE(0);
			const channel = this.buffer.readUInt32BE(4);
			const offset = (BigInt(this.buffer.readUInt32BE(8)) << 32n) | BigInt(this.buffer.readUInt32BE(12));
			const flags = this.buffer.readUInt32BE(16);
			if (length < 1 || length > MAX_CONTROL_PAYLOAD) fail("invalid frame length");
			validateDescriptor(channel, offset, flags);
			if (this.buffer.length < PULSE_FRAME_HEADER_SIZE + length) break;
			const payload = Buffer.from(this.buffer.subarray(PULSE_FRAME_HEADER_SIZE, PULSE_FRAME_HEADER_SIZE + length));
			this.buffer = this.buffer.subarray(PULSE_FRAME_HEADER_SIZE + length);
			frames.push({ channel, offset, flags, payload });
			if (frames.length > MAX_FRAMES_PER_PUSH) fail("too many frames in one push");
		}
		if (this.buffer.length > PULSE_FRAME_HEADER_SIZE + MAX_CONTROL_PAYLOAD) fail("frame buffer too large");
		return frames;
	}
}

export function boundedPulseFrameDecoder(): PulseFrameDecoder { return new PulseFrameDecoder(); }
