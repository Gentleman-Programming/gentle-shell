import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTROL_CHANNEL, MAX_CONTROL_PAYLOAD, MAX_FRAMES_PER_PUSH, NATIVE_PROTOCOL_VERSION, PulseCommand,
	boundedPulseFrameDecoder, boundedPulseTagReader, boundedPulseTagWriter, encodePulseFrame,
} from "../lib/notification-pulse-protocol.ts";

/** Hex literal with optional spaces, so the golden vectors read like the wire. */
const hex = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ""), "hex");

test("protocol constants pin the v13 wire subset without extra commands", () => {
	assert.equal(NATIVE_PROTOCOL_VERSION, 13);
	assert.equal(CONTROL_CHANNEL, 0xffffffff);
	assert.deepEqual(PulseCommand, {
		ERROR: 0, TIMEOUT: 1, REPLY: 2, CREATE_PLAYBACK_STREAM: 3, DELETE_PLAYBACK_STREAM: 4,
		AUTH: 8, SET_CLIENT_NAME: 9, DRAIN_PLAYBACK_STREAM: 12, GET_SERVER_INFO: 20, REQUEST: 61,
	});
	assert.equal(MAX_CONTROL_PAYLOAD, 64 * 1024);
	assert.equal(MAX_FRAMES_PER_PUSH, 32);
});

test("golden AUTH setup: tagged u32 version then raw-length arbitrary cookie", () => {
	const out = boundedPulseTagWriter().u32(NATIVE_PROTOCOL_VERSION).arbitrary(Buffer.alloc(256)).finish();
	const expected = Buffer.concat([hex("4c 00 00 00 0d"), Buffer.from([0x78]), hex("00 00 01 00"), Buffer.alloc(256)]);
	assert.deepEqual(out, expected);
	assert.equal(out.length, 266);
	// The cookie carries its own raw big-endian u32 length ('x'), never a tagged 'L' length.
	assert.equal(out[5], 0x78);
	assert.notEqual(out[5], 0x4c);
});

test("golden proplist carries two equal lengths: tagged 'L' then raw 'x'", () => {
	const out = boundedPulseTagWriter().proplist([["application.name", "gentle-shell"]]).finish();
	const expected = Buffer.concat([
		hex("50"), // 'P'
		Buffer.from("tapplication.name\0", "latin1"),
		hex("4c 00 00 00 0d"), // tagged u32 value length
		hex("78 00 00 00 0d"), // raw arbitrary value length, same value
		Buffer.from("gentle-shell\0", "latin1"),
		hex("4e"), // 'N'
	]);
	assert.deepEqual(out, expected);
});

test("nullable strings encode 'N' for null and 't'+NUL for empty", () => {
	assert.deepEqual(boundedPulseTagWriter().string(null).finish(), Buffer.from([0x4e]));
	assert.deepEqual(boundedPulseTagWriter().string("").finish(), Buffer.from([0x74, 0x00]));
});

test("golden sample_spec encodings match the verified sample.h values", () => {
	const cases: Array<[number, number, number, string]> = [
		[0, 1, 8000, "61 00 01 00 00 1f 40"], // U8
		[3, 2, 44100, "61 03 02 00 00 ac 44"], // S16LE
		[9, 1, 48000, "61 09 01 00 00 bb 80"], // S24LE packed, not S24_32LE
		[7, 2, 192000, "61 07 02 00 02 ee 00"], // S32LE
	];
	for (const [format, channels, rate, expected] of cases)
		assert.deepEqual(boundedPulseTagWriter().sampleSpec({ format, channels, rate }).finish(), hex(expected), `${format}/${channels}/${rate}`);
});

test("golden channel_map, cvolume, usec, boolean and u8 primitives", () => {
	assert.deepEqual(boundedPulseTagWriter().channelMap([0, 1]).finish(), hex("6d 02 00 01"));
	assert.deepEqual(boundedPulseTagWriter().cvolume([0x00010000]).finish(), hex("76 01 00 01 00 00"));
	assert.deepEqual(boundedPulseTagWriter().usec(0x0102030405060708n).finish(), hex("55 01 02 03 04 05 06 07 08"));
	assert.deepEqual(boundedPulseTagWriter().boolean(true).finish(), Buffer.from([0x31]));
	assert.deepEqual(boundedPulseTagWriter().boolean(false).finish(), Buffer.from([0x30]));
	assert.deepEqual(boundedPulseTagWriter().u8(0x5a).finish(), hex("42 5a"));
});

test("reader decodes every primitive back and assertEOF rejects trailing bytes", () => {
	const buffer = boundedPulseTagWriter().u32(13).u8(7).string("x").string(null).arbitrary(Buffer.from([1, 2]))
		.boolean(true).usec(5n).sampleSpec({ format: 3, channels: 1, rate: 8000 }).channelMap([0])
		.cvolume([0x10000]).proplist([["k", Buffer.from([9])]]).finish();
	const reader = boundedPulseTagReader(buffer);
	assert.equal(reader.u32(), 13);
	assert.equal(reader.u8(), 7);
	assert.equal(reader.string(), "x");
	assert.equal(reader.string(), null);
	assert.deepEqual(reader.arbitrary(), Buffer.from([1, 2]));
	assert.equal(reader.boolean(), true);
	assert.equal(reader.usec(), 5n);
	assert.deepEqual(reader.sampleSpec(), { format: 3, channels: 1, rate: 8000 });
	assert.deepEqual(reader.channelMap(), [0]);
	assert.deepEqual(reader.cvolume(), [0x10000]);
	assert.deepEqual(reader.proplist(), new Map([["k", Buffer.from([9])]]));
	reader.assertEOF();
	const trailing = boundedPulseTagReader(hex("31 00"));
	assert.equal(trailing.boolean(), true);
	assert.throws(() => trailing.assertEOF());
});

test("reader fails closed on truncated tags, values and bad UTF-8", () => {
	assert.throws(() => boundedPulseTagReader(hex("4c 00 00 00")).u32());
	assert.throws(() => boundedPulseTagReader(hex("78 00 00")).arbitrary());
	assert.throws(() => boundedPulseTagReader(Buffer.from([0x62])).boolean()); // 'b' is not a valid boolean tag
	assert.throws(() => boundedPulseTagReader(hex("74 ff 00")).string());
	assert.throws(() => boundedPulseTagReader(Buffer.alloc(0)).u8());
});

test("reader rejects a proplist whose declared length differs from the arbitrary length", () => {
	const bytes = Buffer.concat([
		hex("50"),
		Buffer.from("tkey\0", "latin1"),
		hex("4c 00 00 00 05"),
		hex("78 00 00 00 03"),
		Buffer.from("abc", "latin1"),
		hex("4e"),
	]);
	assert.throws(() => boundedPulseTagReader(bytes).proplist());
});

test("writer rejects overflow, embedded NUL, control keys, duplicates and oversize", () => {
	const writer = () => boundedPulseTagWriter();
	assert.throws(() => writer().u32(-1));
	assert.throws(() => writer().u32(0x1_0000_0000));
	assert.throws(() => writer().u32(1.5));
	assert.throws(() => writer().u8(256));
	assert.throws(() => writer().usec(-1n));
	assert.throws(() => writer().usec(1n << 64n));
	assert.throws(() => writer().boolean("yes" as unknown as boolean));
	assert.throws(() => writer().string("a\0b"));
	assert.throws(() => writer().proplist([["", "x"]]));
	assert.throws(() => writer().proplist([["a\0b", "x"]]));
	assert.throws(() => writer().proplist([["a\nb", "x"]]));
	assert.throws(() => writer().proplist([["k", "a"], ["k", "b"]]));
	assert.throws(() => writer().arbitrary(Buffer.alloc(MAX_CONTROL_PAYLOAD)));
});

test("golden control frame pins the 20-byte descriptor", () => {
	const payload = hex("4c 00 00 00 0d");
	const frame = encodePulseFrame({ channel: CONTROL_CHANNEL, offset: 0n, flags: 0 }, payload);
	assert.deepEqual(frame, Buffer.concat([hex("00 00 00 05 ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00"), payload]));
});

test("decoder reassembles fragmented headers and payloads across pushes", () => {
	const payload = Buffer.from("hello");
	const wire = encodePulseFrame({ channel: 3, offset: 0n, flags: 0 }, payload);
	const decoder = boundedPulseFrameDecoder();
	const frames: ReturnType<typeof decoder.push> = [];
	for (const byte of wire) frames.push(...decoder.push(Buffer.from([byte])));
	assert.equal(frames.length, 1);
	assert.equal(frames[0]!.channel, 3);
	assert.equal(frames[0]!.offset, 0n);
	assert.equal(frames[0]!.flags, 0);
	assert.deepEqual(frames[0]!.payload, payload);
});

test("decoder splits coalesced frames and preserves order", () => {
	const first = encodePulseFrame({ channel: CONTROL_CHANNEL, offset: 0n, flags: 0 }, Buffer.from([1]));
	const second = encodePulseFrame({ channel: 5, offset: 0n, flags: 0 }, Buffer.from([2, 3]));
	const frames = boundedPulseFrameDecoder().push(Buffer.concat([first, second]));
	assert.equal(frames.length, 2);
	assert.equal(frames[0]!.channel, CONTROL_CHANNEL);
	assert.equal(frames[1]!.channel, 5);
	assert.deepEqual(frames[1]!.payload, Buffer.from([2, 3]));
});

test("decoder fails closed on invalid lengths, SHM flags and control offsets", () => {
	const decoder = () => boundedPulseFrameDecoder();
	assert.throws(() => decoder().push(hex("00 01 00 01 ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00"))); // > 64 KiB
	assert.throws(() => decoder().push(hex("00 00 00 00 ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00"))); // zero length
	assert.throws(() => decoder().push(hex("00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 80 00 00 00"))); // SHM flag
	assert.throws(() => decoder().push(hex("00 00 00 01 ff ff ff ff 00 00 00 00 00 00 00 01 00 00 00 00"))); // control offset != 0
	assert.throws(() => encodePulseFrame({ channel: CONTROL_CHANNEL, offset: 1n, flags: 0 }, Buffer.from([1])));
});

test("decoder bounds frames per call and does not buffer beyond one frame budget", () => {
	const many = Buffer.concat(Array.from({ length: MAX_FRAMES_PER_PUSH + 1 }, () =>
		encodePulseFrame({ channel: CONTROL_CHANNEL, offset: 0n, flags: 0 }, Buffer.from([1]))));
	assert.throws(() => boundedPulseFrameDecoder().push(many));
});

test("decoder accepts arbitrary fragmentation boundaries", () => {
	const wire = Buffer.concat([
		encodePulseFrame({ channel: CONTROL_CHANNEL, offset: 0n, flags: 0 }, hex("4c 00 00 00 0d")),
		encodePulseFrame({ channel: 7, offset: 0n, flags: 0 }, Buffer.alloc(5, 0xaa)),
	]);
	for (let size = 1; size <= wire.length; size += 3) {
		const decoder = boundedPulseFrameDecoder();
		const frames: ReturnType<typeof decoder.push> = [];
		for (let offset = 0; offset < wire.length; offset += size) frames.push(...decoder.push(wire.subarray(offset, offset + size)));
		assert.equal(frames.length, 2);
		assert.deepEqual(frames[0]!.payload, hex("4c 00 00 00 0d"));
		assert.deepEqual(frames[1]!.payload, Buffer.alloc(5, 0xaa));
	}
});

test("memblock frames keep a nonzero offset with an accepted seek mode", () => {
	const wire = encodePulseFrame({ channel: 9, offset: 0x1_0000_0002n, flags: 1 }, Buffer.from([1, 2, 3]));
	const frames = boundedPulseFrameDecoder().push(wire);
	assert.equal(frames.length, 1);
	assert.equal(frames[0]!.channel, 9);
	assert.equal(frames[0]!.offset, 0x1_0000_0002n);
	assert.equal(frames[0]!.flags, 1);
	assert.deepEqual(frames[0]!.payload, Buffer.from([1, 2, 3]));
	const badSeek = Buffer.from(wire);
	badSeek.writeUInt32BE(3, 16);
	assert.throws(() => boundedPulseFrameDecoder().push(badSeek));
});

test("proplist binary values are preserved byte-for-byte without an added NUL", () => {
	const value = Buffer.from([0x00, 0x7f, 0xff]);
	const entries = boundedPulseTagReader(boundedPulseTagWriter().proplist([["k", value]]).finish()).proplist();
	assert.deepEqual(entries.get("k"), value);
});

test("frame encoder rejects oversized payloads and invalid channels", () => {
	assert.throws(() => encodePulseFrame({ channel: 0, offset: 0n, flags: 0 }, Buffer.alloc(MAX_CONTROL_PAYLOAD + 1)));
	assert.throws(() => encodePulseFrame({ channel: 0, offset: 0n, flags: 0 }, Buffer.alloc(0)));
	assert.throws(() => encodePulseFrame({ channel: -1, offset: 0n, flags: 0 }, Buffer.from([1])));
	const empty = boundedPulseFrameDecoder().push(Buffer.alloc(0));
	assert.deepEqual(empty, []);
});
