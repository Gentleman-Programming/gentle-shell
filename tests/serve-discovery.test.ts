import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ServeAuth } from "../lib/serve-auth.ts";
import { DISCOVERY_MAX_DATAGRAM, DiscoveryRateLimiter, isDiscoveryQuery, startDiscoveryResponder } from "../lib/serve-discovery.ts";
import { startServeServer } from "../lib/serve-server.ts";
import { test } from "./serve-test-client.ts";

const QUERY = Buffer.from(JSON.stringify({ t: "gentle-shell/discover", v: 1 }));

interface Client {
	socket: Socket;
	replies: Buffer[];
	/** The next reply (matching `match`, when given). */
	nextReply(match?: (reply: Buffer) => boolean): Promise<Buffer>;
}

async function client(): Promise<Client> {
	const socket = createSocket("udp4");
	const replies: Buffer[] = [];
	const waiters: Array<{ match: (reply: Buffer) => boolean; resolve: (reply: Buffer) => void }> = [];
	socket.on("message", (m) => {
		replies.push(m);
		for (const w of waiters.splice(0)) {
			if (w.match(m)) w.resolve(m);
			else waiters.push(w);
		}
	});
	const bound = Promise.withResolvers<void>();
	socket.bind(0, "127.0.0.1", () => bound.resolve());
	await bound.promise;
	return {
		socket,
		replies,
		nextReply: (match = () => true) => {
			const { promise, resolve } = Promise.withResolvers<Buffer>();
			waiters.push({ match, resolve });
			return promise;
		},
	};
}

/** A UDP socket bound exclusively on 0.0.0.0:`port`; rejects when the port is taken. */
async function udpBind(port: number): Promise<Socket> {
	const socket = createSocket("udp4");
	const bound = Promise.withResolvers<Socket>();
	socket.once("error", bound.reject);
	socket.bind({ port, address: "0.0.0.0", exclusive: true }, () => bound.resolve(socket));
	return bound.promise;
}

function send(socket: Socket, datagram: Buffer, port: number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.send(datagram, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
	return promise;
}

test("a discovery query is exactly the documented JSON; junk and oversize datagrams are not", () => {
	assert.equal(isDiscoveryQuery(QUERY), true);
	assert.equal(isDiscoveryQuery(Buffer.from('{"t":"gentle-shell/discover","v":1,"x":2}')), true, "extra keys are ignored");
	for (const junk of ["", "hello", "null", "[]", '{"t":"gentle-shell/discover"}', '{"t":"gentle-shell/discover","v":2}', '{"t":"gentle-shell/discover","v":"1"}', '{"t":"gentle-shell/here","v":1}']) {
		assert.equal(isDiscoveryQuery(Buffer.from(junk)), false, junk);
	}
	const padded = Buffer.from(JSON.stringify({ t: "gentle-shell/discover", v: 1, pad: "x".repeat(DISCOVERY_MAX_DATAGRAM) }));
	assert.ok(padded.length > DISCOVERY_MAX_DATAGRAM);
	assert.equal(isDiscoveryQuery(padded), false);
});

test("the rate limiter caps replies per source and overall in each one-second window", () => {
	const limiter = new DiscoveryRateLimiter({ globalPerSecond: 5, perSourcePerSecond: 2 });
	assert.deepEqual([1, 2, 3].map(() => limiter.allow("a", 0)), [true, true, false]);
	assert.deepEqual([1, 2, 3].map(() => limiter.allow("b", 10)), [true, true, false]);
	assert.equal(limiter.allow("c", 20), true);
	assert.equal(limiter.allow("d", 30), false, "the global cap");
	assert.equal(limiter.allow("a", 1000), true, "a new window");
});

test("the responder answers a query by unicast with id, name and HTTP port, and ignores junk", async () => {
	// The clock is read once per valid query: the 1st at 0, the 2nd-7th at 5000, then 7000.
	let queries = 0;
	let now = 0;
	const clock = () => { queries += 1; now = queries === 1 ? 0 : queries <= 7 ? 5_000 : 7_000; return now; };
	const responder = await startDiscoveryResponder({ port: 0, serverId: "srv_test", httpPort: 8787, name: () => `box${now}`, now: clock });
	const { socket, replies, nextReply } = await client();
	try {
		await send(socket, Buffer.from("hello"), responder.port);
		await send(socket, Buffer.from('{"t":"gentle-shell/here","v":1}'), responder.port);
		await send(socket, Buffer.concat([QUERY, Buffer.alloc(DISCOVERY_MAX_DATAGRAM)]), responder.port);
		const answered = nextReply();
		await send(socket, QUERY, responder.port);
		// One socket over loopback is processed in order: the junk before it got nothing.
		assert.deepEqual(JSON.parse((await answered).toString("utf8")), { t: "gentle-shell/here", v: 1, id: "srv_test", n: "box0", p: 8787 });
		assert.equal(replies.length, 1);

		// Rate limit: 4 per source per second. Queries 2-7 share one window and query 8 starts the next; the
		// name carries the window, so the reply to query 8 marks the end (one socket is processed in order).
		replies.length = 0;
		for (let i = 0; i < 6; i += 1) await send(socket, QUERY, responder.port);
		const marker = nextReply((m) => JSON.parse(m.toString("utf8")).n === "box7000");
		await send(socket, QUERY, responder.port);
		await marker;
		assert.equal(replies.filter((m) => JSON.parse(m.toString("utf8")).n === "box5000").length, 4);
		assert.equal(replies.length, 5, "the 5th and 6th queries of the window got nothing");
	} finally {
		socket.close();
		await responder.close();
	}
});

test("a network server answers discovery on its HTTP port; a loopback server does not listen for it", async () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-serve-discovery-"));
	const launchSession = () => { throw new Error("no sessions"); };
	const lan = await startServeServer({ host: "0.0.0.0", port: 0, auth: new ServeAuth({ devicesFile: join(root, "lan.json"), adminToken: "gsa_a" }), version: "test", launchSession });
	const loop = await startServeServer({ host: "127.0.0.1", port: 0, auth: new ServeAuth({ devicesFile: join(root, "loop.json"), adminToken: "gsa_b" }), version: "test", launchSession });
	const { socket, replies, nextReply } = await client();
	try {
		assert.equal(lan.discovery, true);
		assert.equal(loop.discovery, false);
		const answered = nextReply();
		await send(socket, QUERY, lan.port);
		const reply = JSON.parse((await answered).toString("utf8"));
		assert.deepEqual(reply, { t: "gentle-shell/here", v: 1, id: lan.serverId, n: hostname(), p: lan.port });
		assert.equal(replies.length, 1);
		const identity = await (await fetch(`http://127.0.0.1:${reply.p}/.well-known/gentle-shell`)).json();
		assert.equal(identity.serverId, reply.id);

		// Nothing holds UDP on the loopback server's port.
		(await udpBind(loop.port)).close();
	} finally {
		socket.close();
		await lan.close();
		await loop.close();
		rmSync(root, { recursive: true, force: true });
	}
	// Closed with the server: the UDP port is free again.
	(await udpBind(lan.port)).close();
});

test("a taken UDP port leaves the network server running without discovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-serve-discovery-"));
	const holder = await udpBind(0);
	const port = holder.address().port;
	const logs: string[] = [];
	let server;
	try {
		server = await startServeServer({ host: "0.0.0.0", port, auth: new ServeAuth({ devicesFile: join(root, "d.json"), adminToken: "gsa_c" }), version: "test",
			launchSession: () => { throw new Error("no sessions"); }, log: (l) => logs.push(l) });
		assert.equal(server.discovery, false);
		assert.ok(logs.some((l) => l.startsWith(`discovery off: could not bind UDP 0.0.0.0:${port}`)), logs.join("\n"));
		assert.equal((await fetch(`${server.url}/.well-known/gentle-shell`)).status, 200);
	} finally {
		holder.close();
		await server?.close();
		rmSync(root, { recursive: true, force: true });
	}
});
