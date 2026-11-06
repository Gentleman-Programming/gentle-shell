import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_REQUEST_TIMEOUT_MS, MAX_PENDING_REQUESTS, PULSE_COOKIE_BYTES,
	PulseClient, PulseCookieError, loadPulseCookie, resolvePulseCookiePath, resolvePulseSocketPath,
} from "../lib/notification-pulse-client.ts";

// --- independent golden encoders (deliberately NOT the production codec) ---
const taggedU32 = (value: number): Buffer => { const b = Buffer.alloc(5); b[0] = 0x4c; b.writeUInt32BE(value, 1); return b; };
const taggedString = (value: string): Buffer => Buffer.concat([Buffer.from([0x74]), Buffer.from(value, "utf8"), Buffer.from([0x00])]);
const nullString = (): Buffer => Buffer.from([0x4e]);
const sampleSpec = (format: number, channels: number, rate: number): Buffer => { const b = Buffer.alloc(7); b[0] = 0x61; b[1] = format; b[2] = channels; b.writeUInt32BE(rate, 3); return b; };
const reply = (command: number, tag: number, ...args: Buffer[]): Buffer => Buffer.concat([taggedU32(command), taggedU32(tag), ...args]);
const frame = (channel: number, flags: number, payload: Buffer, offset = 0n): Buffer => {
	const header = Buffer.alloc(20);
	header.writeUInt32BE(payload.length, 0); header.writeUInt32BE(channel, 4);
	header.writeUInt32BE(Number(offset >> 32n), 8); header.writeUInt32BE(Number(offset & 0xffffffffn), 12); header.writeUInt32BE(flags, 16);
	return Buffer.concat([header, payload]);
};
const taggedValueAt = (payload: Buffer, at: number): number => payload.readUInt32BE(at + 1);
const commandOf = (payload: Buffer): number => taggedValueAt(payload, 0);
const tagOf = (payload: Buffer): number => taggedValueAt(payload, 5);

interface FakeFrame { readonly channel: number; readonly payload: Buffer; }
interface FakeServer {
	readonly path: string;
	readonly frames: FakeFrame[];
	close(): Promise<void>;
}
async function startFakeServer(handler: (frame: FakeFrame, send: (payload: Buffer) => void, socket: Socket) => void): Promise<FakeServer> {
	const dir = await mkdtemp(join(tmpdir(), "pulse-client-"));
	const path = join(dir, "native");
	const frames: FakeFrame[] = [];
	const server: Server = createServer(connection => {
		let buffer = Buffer.alloc(0);
		connection.on("data", chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 20) break;
				const length = buffer.readUInt32BE(0);
				if (buffer.length < 20 + length) break;
				const payload = Buffer.from(buffer.subarray(20, 20 + length));
				const channel = buffer.readUInt32BE(4);
				buffer = buffer.subarray(20 + length);
				frames.push({ channel, payload });
				handler({ channel, payload }, replyPayload => connection.write(frame(0xffffffff, 0, replyPayload)), connection);
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
	return { path, frames, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}
/** Answers AUTH (8), SET_CLIENT_NAME (9) and GET_SERVER_INFO (20) with golden bytes. */
function probeHandler(defaultSink: string | null, seen: number[]) {
	return (request: FakeFrame, send: (payload: Buffer) => void) => {
		const command = commandOf(request.payload); const tag = tagOf(request.payload);
		seen.push(command);
		if (command === 8) send(reply(2, tag, taggedU32(0x80000023))); // server 35 with a high flag bit
		else if (command === 9) send(reply(2, tag, taggedU32(0)));
		else if (command === 20) send(reply(2, tag, taggedString("pulseaudio"), taggedString("17.0"), taggedString("user"), taggedString("host"),
			sampleSpec(3, 2, 44100), defaultSink === null ? nullString() : taggedString(defaultSink), nullString(), taggedU32(0x12345678)));
	};
}

test("socket resolution accepts unix/absolute forms and denies network, URL, list and control paths", () => {
	assert.equal(resolvePulseSocketPath({ PULSE_SERVER: "unix:/tmp/pulse.sock" }), "/tmp/pulse.sock");
	assert.equal(resolvePulseSocketPath({ PULSE_SERVER: "/run/user/9/pulse/native" }), "/run/user/9/pulse/native");
	assert.equal(resolvePulseSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/pulse/native");
	assert.equal(resolvePulseSocketPath({}, 1000), "/run/user/1000/pulse/native");
	for (const bad of ["tcp:host:4713", "tcp6:[::1]:4713", "http://x/native", "{unix:/a,unix:/b}", "unix:relative/path", "~/.pulse/native", "unix:/a,b", "unix:/a\u0000b", "unix:/a\nb", "unix:/a/../b"])
		assert.throws(() => resolvePulseSocketPath({ PULSE_SERVER: bad }), /Pulse client/, bad);
});

test("cookie path resolution is absolute-literal only and never scans directories", () => {
	assert.equal(resolvePulseCookiePath({ PULSE_COOKIE: "/tmp/cookie" }), "/tmp/cookie");
	assert.equal(resolvePulseCookiePath({ XDG_CONFIG_HOME: "/cfg" }), "/cfg/pulse/cookie");
	assert.equal(resolvePulseCookiePath({ HOME: "/home/u" }), "/home/u/.config/pulse/cookie");
	assert.equal(resolvePulseCookiePath({}), undefined);
	for (const bad of ["relative", "http://x/cookie", "/a\u0000b", "/a/../b"])
		assert.throws(() => resolvePulseCookiePath({ PULSE_COOKIE: bad }), /Pulse client/, bad);
});

test("cookie loading returns 256 zero bytes for a missing file and creates nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pulse-cookie-"));
	const path = join(dir, "cookie");
	const bytes = await loadPulseCookie(path);
	assert.equal(bytes.length, PULSE_COOKIE_BYTES);
	assert.ok(bytes.every(byte => byte === 0));
	await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	assert.equal((await loadPulseCookie(undefined)).length, PULSE_COOKIE_BYTES);
	await rm(dir, { recursive: true, force: true });
});

test("cookie loading reads an existing 256-byte private file and fails closed on symlinks/size/type", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pulse-cookie-"));
	const path = join(dir, "cookie");
	await writeFile(path, Buffer.alloc(PULSE_COOKIE_BYTES, 0xab), { mode: 0o400 });
	assert.ok((await loadPulseCookie(path)).every(byte => byte === 0xab));
	const link = join(dir, "link");
	await symlink(path, link);
	await assert.rejects(loadPulseCookie(link), PulseCookieError);
	const short = join(dir, "short");
	await writeFile(short, Buffer.alloc(PULSE_COOKIE_BYTES - 1));
	await assert.rejects(loadPulseCookie(short), PulseCookieError);
	await assert.rejects(loadPulseCookie(dir), PulseCookieError);
	await rm(dir, { recursive: true, force: true });
});

test("requests are lazy and stay offline until connect", () => {
	const client = new PulseClient({ socketPath: "/nonexistent/pulse", cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
	assert.ok(client instanceof PulseClient);
	void assert.rejects(client.request(20, Buffer.alloc(0)));
});

test("probe authenticates, reads server info, reports wav only with a sink and closes", async () => {
	const seen: number[] = [];
	const server = await startFakeServer(probeHandler("auto_null", seen));
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		const result = await client.probe();
		assert.deepEqual(result, { available: true, formats: ["wav"] });
		assert.deepEqual(seen, [8, 9, 20]);
		assert.ok(server.frames.every(entry => entry.channel === 0xffffffff));
		assert.ok(server.frames.every(entry => commandOf(entry.payload) !== 61));

		const auth = server.frames.find(entry => commandOf(entry.payload) === 8)!;
		assert.equal(auth.payload.length, 276);
		assert.equal(taggedValueAt(auth.payload, 10), 13); // protocol version
		assert.equal(auth.payload[15], 0x78); // arbitrary tag
		assert.equal(auth.payload.readUInt32BE(16), PULSE_COOKIE_BYTES); // raw length, not 'L'
		assert.ok(auth.payload.subarray(20).every(byte => byte === 0));

		const name = server.frames.find(entry => commandOf(entry.payload) === 9)!;
		for (const needle of ["tapplication.name\0", "tapplication.type\0", "gentle-shell\0"])
			assert.ok(name.payload.includes(Buffer.from(needle, "latin1")), needle);
	} finally { await server.close(); }
});

test("probe reports unavailable when the server has no default sink", async () => {
	const seen: number[] = [];
	const server = await startFakeServer(probeHandler(null, seen));
	try {
		const result = await new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) }).probe();
		assert.deepEqual(result, { available: false, formats: [] });
	} finally { await server.close(); }
});

test("auth strips the high version bits and rejects servers below v13", async () => {
	const server = await startFakeServer((request, send) => {
		const command = commandOf(request.payload); const tag = tagOf(request.payload);
		if (command === 8) send(reply(2, tag, taggedU32(0x80000023)));
		else if (command === 9) send(reply(2, tag, taggedU32(0)));
	});
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		assert.equal(await client.authenticate(Buffer.alloc(PULSE_COOKIE_BYTES)), 35);
		await client.close();
	} finally { await server.close(); }

	const old = await startFakeServer((request, send) => { if (commandOf(request.payload) === 8) send(reply(2, tagOf(request.payload), taggedU32(12))); });
	try {
		const client = new PulseClient({ socketPath: old.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		await assert.rejects(client.authenticate(Buffer.alloc(PULSE_COOKIE_BYTES)), /version/);
		await client.close();
	} finally { await old.close(); }
});

test("delayed replies reject and close the connection", async () => {
	const server = await startFakeServer(request => {
		if (commandOf(request.payload) === 8) { /* never answer */ }
	});
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES), requestTimeoutMs: 120 });
		await client.connect();
		const pending = client.request(8, taggedU32(13));
		await assert.rejects(pending, /timed out/);
		await client.close();
	} finally { await server.close(); }
});

test("ERROR command rejects the matching tag and fails the connection closed", async () => {
	const server = await startFakeServer((request, send) => {
		if (commandOf(request.payload) === 20) send(reply(0, tagOf(request.payload), taggedU32(6))); // PA_ERR_ACCESS
	});
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		await assert.rejects(client.request(20, Buffer.alloc(0)), /error/);
		await assert.rejects(client.request(20, Buffer.alloc(0)), /closed|error/);
		await client.close();
	} finally { await server.close(); }
});

test("unknown server commands and unmatched reply tags fail closed", async () => {
	const unknown = await startFakeServer((_request, send) => send(reply(200, 1)));
	try {
		const client = new PulseClient({ socketPath: unknown.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		await assert.rejects(client.request(20, Buffer.alloc(0)), /Pulse client/);
		await client.close();
	} finally { await unknown.close(); }

	const unmatched = await startFakeServer((_request, send) => send(reply(2, 4242, taggedU32(0))));
	try {
		const client = new PulseClient({ socketPath: unmatched.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		await assert.rejects(client.request(20, Buffer.alloc(0)), /Pulse client/);
		await client.close();
	} finally { await unmatched.close(); }
});

test("unsolicited REQUEST is delivered while benign events are ignored and replies still resolve", async () => {
	const server = await startFakeServer((request, send) => {
		const command = commandOf(request.payload); const tag = tagOf(request.payload);
		if (command === 20) {
			send(reply(61, 0xffffffff, taggedU32(0), taggedU32(4096))); // REQUEST
			send(reply(63, 0xffffffff, taggedU32(0))); // UNDERFLOW, benign
			send(reply(2, tag, taggedU32(0)));
		}
	});
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		const events: number[] = [];
		const off = client.onEvent((command: number) => events.push(command));
		await client.connect();
		await client.request(20, Buffer.alloc(0));
		off();
		assert.deepEqual(events, [61]);
		await client.close();
	} finally { await server.close(); }
});

test("close and abort reject every pending request without unhandled rejections", async () => {
	const server = await startFakeServer(() => { /* never answer */ });
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		const first = client.request(20, Buffer.alloc(0)).then(() => "resolved", () => "rejected");
		const controller = new AbortController();
		const second = client.request(20, Buffer.alloc(0), controller.signal).then(() => "resolved", (error: Error) => error.message);
		controller.abort();
		assert.match(await second, /aborted/);
		const third = client.request(20, Buffer.alloc(0)).then(() => "resolved", () => "rejected");
		await client.close();
		assert.deepEqual(await Promise.all([first, third]), ["rejected", "rejected"]);
		await client.close();
	} finally { await server.close(); }
});

test("pending tag budget is bounded", async () => {
	const server = await startFakeServer(() => { /* never answer */ });
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES), requestTimeoutMs: 5000 });
		await client.connect();
		const pending = Array.from({ length: MAX_PENDING_REQUESTS }, () => client.request(20, Buffer.alloc(0)).then(() => "resolved", () => "rejected"));
		await assert.rejects(client.request(20, Buffer.alloc(0)), /pending/);
		await client.close();
		assert.ok((await Promise.all(pending)).every(entry => entry === "rejected"));
	} finally { await server.close(); }
});

test("delayed replies meet the bounded deadline and fragmented/coalesced frames survive", async () => {
	const server = await startFakeServer((request, send, socket) => {
		if (commandOf(request.payload) !== 20) return;
		const payload = reply(2, tagOf(request.payload), taggedU32(0));
		socket.write(frame(0xffffffff, 0, payload).subarray(0, 12));
		setTimeout(() => socket.write(frame(0xffffffff, 0, payload).subarray(12)), 10);
	});
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES), requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
		await client.connect();
		assert.ok(await client.request(20, Buffer.alloc(0)));
		await client.close();
	} finally { await server.close(); }

	const late = await startFakeServer(() => { /* never answer */ });
	try {
		const client = new PulseClient({ socketPath: late.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES), requestTimeoutMs: 60 });
		await client.connect();
		await assert.rejects(client.request(20, Buffer.alloc(0)), /timed out/);
		await client.close();
	} finally { await late.close(); }
});

test("SHM-flagged frames and truncated transports fail closed", async () => {
	const shm = await startFakeServer((request, send, socket) => {
		if (commandOf(request.payload) === 20) socket.write(frame(3, 0x80000000, Buffer.from([1])));
	});
	try {
		const client = new PulseClient({ socketPath: shm.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		await assert.rejects(client.request(20, Buffer.alloc(0)), /Pulse client/);
		await client.close();
	} finally { await shm.close(); }

	const truncated = await startFakeServer((_request, _send, socket) => socket.destroy());
	try {
		const client = new PulseClient({ socketPath: truncated.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		await assert.rejects(client.request(20, Buffer.alloc(0)), /Pulse client/);
		await client.close();
	} finally { await truncated.close(); }
});

test("probe surfaces a generic failure (no secrets) and still closes when auth fails", async () => {
	const server = await startFakeServer((request, send) => { if (commandOf(request.payload) === 8) send(reply(0, tagOf(request.payload), taggedU32(6))); });
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await assert.rejects(client.probe(), (error: Error) => /Pulse client/.test(error.message) && !/\u0000/.test(error.message));
	} finally { await server.close(); }
});

test("sendDataFrame writes a raw memblock frame reserved for N2", async () => {
	const server = await startFakeServer(() => { /* no reply needed */ });
	try {
		const client = new PulseClient({ socketPath: server.path, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) });
		await client.connect();
		client.sendDataFrame(4, Buffer.from([1, 2, 3]));
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.ok(server.frames.some(entry => entry.channel === 4 && entry.payload.equals(Buffer.from([1, 2, 3]))));
		await client.close();
	} finally { await server.close(); }
});

test("connect follows a symlinked socket path (WSLg style) without rewriting it", async () => {
	const seen: number[] = [];
	const server = await startFakeServer(probeHandler("auto_null", seen));
	const dir = await mkdtemp(join(tmpdir(), "pulse-link-"));
	const link = join(dir, "native");
	await symlink(server.path, link);
	try {
		const result = await new PulseClient({ socketPath: link, cookie: Buffer.alloc(PULSE_COOKIE_BYTES) }).probe();
		assert.equal(result.available, true);
		assert.ok(await lstat(link).then(value => value.isSymbolicLink()));
	} finally { await rm(dir, { recursive: true, force: true }); await server.close(); }
});

test("probe uses a zero cookie from a missing cookie path and never creates it", async () => {
	const seen: number[] = [];
	const server = await startFakeServer(probeHandler("auto_null", seen));
	const dir = await mkdtemp(join(tmpdir(), "pulse-cookie-missing-"));
	const cookiePath = join(dir, "cookie");
	try {
		const result = await new PulseClient({ socketPath: server.path, cookiePath }).probe();
		assert.deepEqual(result, { available: true, formats: ["wav"] });
		const auth = server.frames.find(entry => commandOf(entry.payload) === 8)!;
		assert.ok(auth.payload.subarray(20).every(byte => byte === 0));
		await assert.rejects(stat(cookiePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	} finally { await rm(dir, { recursive: true, force: true }); await server.close(); }
});
