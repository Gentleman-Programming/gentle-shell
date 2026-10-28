import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { downloadGentleAiAsset } from "../scripts/gentle-ai-installer.mjs";
import { proxyTlsOptions, resolveProxyForTarget } from "../scripts/gentle-ai-proxy.mjs";

const TARGET = "https://release-assets.example.invalid/asset.tar.gz";

function pendingRequest() {
	const pending = new EventEmitter() as EventEmitter & { destroy(error?: Error): void; setTimeout(): void };
	pending.destroy = (error) => queueMicrotask(() => pending.emit("error", error));
	pending.setTimeout = () => undefined;
	return pending;
}

// A proxy that answers CONNECT with the given status and records the request
// head it received. A string sends an incomplete response before closing;
// null leaves the connection silent. No TLS origin is needed.
async function startProxyStub(status: number | string | null) {
	const sockets: Socket[] = [];
	const closed: Promise<void>[] = [];
	let head = "";
	let first: Buffer = Buffer.alloc(0);
	const server = createServer((socket) => {
		sockets.push(socket);
		closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
		socket.on("data", (chunk) => {
			if (first.length === 0) first = chunk;
			if (head === "") head += chunk.toString("latin1");
		});
		if (status === null) return;
		socket.write(typeof status === "string" ? status : `HTTP/1.1 ${status} ${status === 200 ? "Connection Established" : "Proxy Authentication Required"}\r\n\r\n`);
		if (status !== 200) socket.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		port,
		connections: () => sockets.length,
		waitForClose: () => Promise.all(closed),
		head: () => head,
		firstBytes: () => first,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

// A proxy that records what it is sent and then hangs up, so a channel that
// expects a TLS handshake can be observed before anything replies.
async function startSilentProxy() {
	const sockets: Socket[] = [];
	let first: Buffer = Buffer.alloc(0);
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.on("data", (chunk) => {
			if (first.length === 0) first = chunk;
			socket.destroy();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		port,
		firstBytes: () => first,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("the proxy is read from the environment the way every other HTTP client reads it", () => {
	assert.equal(resolveProxyForTarget(TARGET, {}), undefined);
	assert.equal(resolveProxyForTarget(TARGET, { HTTPS_PROXY: "http://proxy.invalid:3128" })?.href, "http://proxy.invalid:3128/");
	assert.equal(resolveProxyForTarget(TARGET, { https_proxy: "http://proxy.invalid:3128" })?.href, "http://proxy.invalid:3128/");
	// HTTP_PROXY is the fallback for an https target, and the only answer for an http one.
	assert.equal(resolveProxyForTarget(TARGET, { HTTP_PROXY: "http://proxy.invalid:3128" })?.href, "http://proxy.invalid:3128/");
	assert.equal(resolveProxyForTarget("http://example.invalid/asset", { HTTP_PROXY: "http://proxy.invalid:3128" })?.href, "http://proxy.invalid:3128/");
	// HTTPS_PROXY wins over HTTP_PROXY for an https target.
	assert.equal(resolveProxyForTarget(TARGET, { HTTPS_PROXY: "http://secure.invalid:3128", HTTP_PROXY: "http://plain.invalid:3128" })?.href, "http://secure.invalid:3128/");
	// A value without a scheme is a host:port pair, not a URL with a strange scheme.
	assert.equal(resolveProxyForTarget(TARGET, { HTTPS_PROXY: "proxy.invalid:3128" })?.href, "http://proxy.invalid:3128/");
	// Credentials survive, because a proxy that needs them is a normal proxy.
	assert.equal(resolveProxyForTarget(TARGET, { HTTPS_PROXY: "http://user:pass@proxy.invalid:3128" })?.username, "user");
	// An unusable value is ignored rather than allowed to break a direct install.
	assert.equal(resolveProxyForTarget(TARGET, { HTTPS_PROXY: "socks5://proxy.invalid:1080" }), undefined);
	assert.equal(resolveProxyForTarget(TARGET, { HTTPS_PROXY: "   " }), undefined);
});

test("NO_PROXY keeps the listed hosts off the proxy", () => {
	const proxy = { HTTPS_PROXY: "http://proxy.invalid:3128" };
	assert.equal(resolveProxyForTarget(TARGET, { ...proxy, NO_PROXY: "release-assets.example.invalid" }), undefined);
	assert.equal(resolveProxyForTarget(TARGET, { ...proxy, no_proxy: "release-assets.example.invalid" }), undefined);
	// A leading dot covers the domain and its subdomains.
	assert.equal(resolveProxyForTarget(TARGET, { ...proxy, NO_PROXY: ".example.invalid" }), undefined);
	assert.equal(resolveProxyForTarget(TARGET, { ...proxy, NO_PROXY: "*.example.invalid" }), undefined);
	// A bare domain is an exact match, so it does not silently cover the world.
	assert.notEqual(resolveProxyForTarget(TARGET, { ...proxy, NO_PROXY: "example.invalid" }), undefined);
	// Every host bypasses on a wildcard.
	assert.equal(resolveProxyForTarget(TARGET, { ...proxy, NO_PROXY: "*" }), undefined);
	// A listed port is part of the match.
	assert.equal(resolveProxyForTarget(TARGET, { ...proxy, NO_PROXY: "release-assets.example.invalid:443" }), undefined);
	assert.notEqual(resolveProxyForTarget(TARGET, { ...proxy, NO_PROXY: "release-assets.example.invalid:8443" }), undefined);
});

test("an IPv6 proxy address reaches the proxy instead of failing to resolve", { timeout: 15_000 }, async (t) => {
	// URL.hostname keeps the brackets of an IPv6 literal, and a socket address
	// does not accept them, so the tunnel has to strip them before connecting.
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.on("data", () => socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
	});
	// A host without IPv6 has no loopback address to bind, so there is
	// nothing to assert there. Every other error is a real failure.
	let bound = false;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "::1", port: 0 }, () => { bound = true; resolve(); });
	}).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EADDRNOTAVAIL") throw error;
	});
	if (!bound) {
		t.skip("IPv6 loopback is unavailable on this host");
		return;
	}
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-ipv6-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// The proxy answered, so the failure has to be the refusal and not a
	// lookup that never reached the address.
	await assert.rejects(
		() => downloadGentleAiAsset(TARGET, join(directory, "asset"), 1024, 0, { env: { HTTPS_PROXY: `http://[::1]:${port}` }, maxAttempts: 1, headerTimeoutMs: 1500 }),
		/proxy refused the tunnel with status 407/,
	);
});

test("malformed percent-encoded proxy credentials are ignored", () => {
	for (const credentials of ["user%:pass", "user:pass%GG", "user:%C3%28", ":pass%"]) {
		const env = { HTTPS_PROXY: `http://${credentials}@proxy.invalid:3128` };
		assert.equal(resolveProxyForTarget(TARGET, env), undefined);
		assert.equal(resolveProxyForTarget(TARGET, { ...env, HTTP_PROXY: "http://fallback.invalid:3128" })?.hostname, "fallback.invalid");
	}
});

for (const [name, response, protocol] of [
	["silent", null, "http"],
	["early-closed", "", "http"],
	["truncated", "HTTP/1.1 200 Connection Established\r\n", "http"],
	["silent TLS", null, "https"],
] as const) {
	test(`${name} proxy rejects within the CONNECT deadline`, { timeout: 3000 }, async (t) => {
		const proxy = await startProxyStub(response);
		t.after(() => proxy.close());
		const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-incomplete-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("CONNECT did not settle within one second")), 1000); });
		try {
			await assert.rejects(Promise.race([
				downloadGentleAiAsset(TARGET, join(directory, "asset"), 1024, 0, { env: { HTTPS_PROXY: `${protocol}://localhost:${proxy.port}` }, maxAttempts: 1, headerTimeoutMs: 50 }),
				deadline,
			]), { code: response === null ? "GENTLE_AI_DOWNLOAD_TIMEOUT" : "ECONNRESET" });
			await Promise.race([proxy.waitForClose(), deadline]);
			assert.equal(proxy.connections(), 1);
		} finally {
			clearTimeout(timer);
		}
	});
}

test("an HTTPS proxy on an IP address is checked against the address and not sent as a server name", { timeout: 15_000 }, async (t) => {
	// An IP address cannot be a server name, and a modern Node refuses the
	// handshake outright when it is given one. The address goes in as the host
	// instead, which is the name the certificate is checked against.
	const proxy = await startProxyStub(407);
	t.after(() => proxy.close());
	const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-ip-host-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// The stub speaks plain TCP, so the TLS handshake against it fails. What
	// matters here is that the failure arrives as a rejected download and not
	// as an exception that escapes the tunnel and takes the install down.
	const failures: unknown[] = [];
	const onUncaught = (error: unknown) => { failures.push(error); };
	process.on("uncaughtException", onUncaught);
	try {
		await assert.rejects(
			() => downloadGentleAiAsset(TARGET, join(directory, "asset"), 1024, 0, { env: { HTTPS_PROXY: `https://127.0.0.1:${proxy.port}` }, maxAttempts: 1, headerTimeoutMs: 1500 }),
			(error: NodeJS.ErrnoException) => error.code !== "ERR_INVALID_ARG_VALUE",
		);
	} finally {
		process.off("uncaughtException", onUncaught);
	}
	assert.deepEqual(failures, [], "no exception escaped the tunnel");
	// The address is the name the certificate is verified against, and no
	// server name is sent with it.
	assert.deepEqual(proxyTlsOptions(new URL("https://127.0.0.1:3128")), { host: "127.0.0.1" });
	assert.deepEqual(proxyTlsOptions(new URL("https://[::1]:3128")), { host: "::1" });
	// A hostname keeps its server name, so the proxy is still reached by name.
	assert.deepEqual(proxyTlsOptions(new URL("https://proxy.invalid:3128")), { servername: "proxy.invalid" });
});

test("the release download carries a tunnel only when the environment names a proxy", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-wiring-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const seen: Array<Record<string, unknown>> = [];
	const request = (_url: URL, options: unknown, callback: (response: PassThrough & { statusCode?: number; headers: Record<string, string> }) => void) => {
		seen.push(options as Record<string, unknown>);
		const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
		queueMicrotask(() => { callback(response); response.end(); });
		return pendingRequest();
	};
	await downloadGentleAiAsset(TARGET, join(directory, "direct"), 1024, 0, { request, env: {}, maxAttempts: 1 });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].agent, undefined, "a direct download carries no agent");
	await downloadGentleAiAsset(TARGET, join(directory, "proxied"), 1024, 0, { request, env: { HTTPS_PROXY: "http://proxy.invalid:3128" }, maxAttempts: 1 });
	assert.equal(seen.length, 2);
	assert.ok(seen[1].agent, "a proxied download carries the tunnel that reaches the proxy");
});

test("the tunnel asks the proxy to CONNECT to the origin host", async (t) => {
	const proxy = await startProxyStub(200);
	t.after(() => proxy.close());
	const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-tunnel-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(() => downloadGentleAiAsset(TARGET, join(directory, "asset"), 1024, 0, { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }, maxAttempts: 1, headerTimeoutMs: 1500 }));
	assert.match(proxy.head(), /^CONNECT release-assets\.example\.invalid:443 HTTP\/1\.1\r\nHost: release-assets\.example\.invalid:443\r\n/);
});

test("a proxy that refuses the tunnel fails with the status it returned", async (t) => {
	const proxy = await startProxyStub(407);
	t.after(() => proxy.close());
	const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-refused-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(
		() => downloadGentleAiAsset(TARGET, join(directory, "asset"), 1024, 0, { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }, maxAttempts: 1, headerTimeoutMs: 1500 }),
		/proxy refused the tunnel with status 407/,
	);
});

test("a proxy that is briefly overloaded is retried like any other transient failure", async (t) => {
	const proxy = await startProxyStub(503);
	t.after(() => proxy.close());
	const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-transient-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(
		() => downloadGentleAiAsset(TARGET, join(directory, "asset"), 1024, 0, { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }, maxAttempts: 2, retryDelayMs: 0, headerTimeoutMs: 1500 }),
		/proxy refused the tunnel with status 503/,
	);
	assert.equal(proxy.connections(), 2, "a transient refusal opens a second connection");
});

test("a proxy reached over TLS is spoken to over TLS, not in the clear", { timeout: 15_000 }, async (t) => {
	const proxy = await startSilentProxy();
	t.after(() => proxy.close());
	const directory = await mkdtemp(join(tmpdir(), "gentle-pi-proxy-tls-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(() => downloadGentleAiAsset(TARGET, join(directory, "asset"), 1024, 0, { env: { HTTPS_PROXY: `https://localhost:${proxy.port}` }, maxAttempts: 1, headerTimeoutMs: 1500 }));
	// A TLS ClientHello starts with the handshake content type and a version,
	// where the plaintext CONNECT request would start with its own verb.
	assert.equal(proxy.firstBytes()[0], 0x16, "the first byte to the proxy is a TLS handshake");
	assert.equal(proxy.firstBytes()[1], 0x03, "the first byte to the proxy is a TLS handshake");
});
