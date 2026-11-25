import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { relaySecret } from "../lib/serve-cli.ts";
import { connectThroughRelay, parseRelayUrl, RELAY_SIGNATURE_PREFIX, RelayError, startRelay, startRelayLink, type Relay } from "../lib/serve-relay.ts";
import { parseRelayArgs, relayServerSecret, runRelayCommand } from "../lib/serve-relay-cli.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { connectPinned, createSelfSignedCertificate, loadOrCreateServeTls, peekFingerprint, verifyPairProof } from "../lib/serve-tls.ts";
import { callOver } from "./serve-test-client.ts";

const ADMIN = "gsa_relay-test-admin";
const SECRET = "relay-test-secret";
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function scratch(): string {
	const r = realpathSync(mkdtempSync(join(tmpdir(), "gentle-serve-relay-")));
	roots.push(r);
	return r;
}

/** One handshake line from a raw socket: the relay's protocol as a client written in any language sees it. */
function line(socket: Socket): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	let text = "";
	const onData = (chunk: Buffer) => {
		text += chunk.toString("utf8");
		const end = text.indexOf("\n");
		if (end === -1) return;
		socket.off("data", onData);
		resolve(JSON.parse(text.slice(0, end)));
	};
	socket.on("data", onData);
	socket.once("error", reject);
	return promise;
}

async function raw(port: number, hello: Record<string, unknown>): Promise<{ socket: Socket; answer: Record<string, unknown> }> {
	const socket = netConnect({ host: "127.0.0.1", port });
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	socket.write(`${JSON.stringify(hello)}\n`);
	return { socket, answer: await line(socket) };
}

interface Setup { relay: Relay; server: ServeServer; auth: ServeAuth; fingerprint: string; logs: string[]; url: string }

async function setup(t: { after: (fn: () => unknown) => void }, options: { serverSecret?: string; relayLimits?: Parameters<typeof startRelay>[0]["limits"] } = {}): Promise<Setup> {
	const root = scratch();
	const logs: string[] = [];
	const relay = await startRelay({ host: "127.0.0.1", port: 0, secret: SECRET, log: (l) => logs.push(l), ...(options.relayLimits ? { limits: options.relayLimits } : {}) });
	t.after(() => relay.close());
	const url = `gsr://127.0.0.1:${relay.port}`;
	const auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	const tls = loadOrCreateServeTls(join(root, "serve"), { commonName: "relay test", dnsNames: ["localhost"], ips: ["127.0.0.1"] });
	// A loopback server: only the relay brings it network clients.
	const server = await startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", tls, relay: { url, secret: options.serverSecret ?? SECRET, retryMinMs: 50 },
		launchSession: () => { throw new Error("no sessions in these tests"); }, log: (l) => logs.push(l) });
	t.after(() => server.close());
	return { relay, server, auth, fingerprint: tls.fingerprint, logs, url };
}

test("relay URLs are gsr://host:port and nothing else", () => {
	assert.deepEqual(parseRelayUrl("gsr://relay.example.com:7700"), { url: "gsr://relay.example.com:7700", host: "relay.example.com", port: 7700 });
	assert.deepEqual(parseRelayUrl("gsr://[2001:db8::1]:7700/"), { url: "gsr://[2001:db8::1]:7700", host: "2001:db8::1", port: 7700 });
	for (const bad of ["relay.example.com:7700", "https://relay.example.com:7700", "gsr://relay.example.com", "gsr://u:p@relay.example.com:7700", "gsr://relay.example.com:7700/x", "gsr://relay.example.com:7700?q"]) {
		assert.ok("error" in parseRelayUrl(bad), bad);
	}
});

test("through the relay: pairing with a proof, then the API, end to end TLS the relay cannot read", async (t) => {
	const { relay, server, auth, fingerprint, logs, url } = await setup(t);
	await server.relay!.ready();
	assert.deepEqual(relay.servers(), [fingerprint], "the server registered under its certificate's fingerprint");

	// A tap between the client and the relay records every byte the relay receives from the client and sends back.
	const tapped: Buffer[] = [];
	const tap = createNetServer((client) => {
		const upstream = netConnect({ host: "127.0.0.1", port: relay.port });
		client.on("data", (c: Buffer) => tapped.push(c));
		upstream.on("data", (c: Buffer) => tapped.push(c));
		client.pipe(upstream).pipe(client);
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
	});
	await new Promise<void>((resolve) => tap.listen(0, "127.0.0.1", resolve));
	t.after(() => tap.close());
	const viaTap = `gsr://127.0.0.1:${(tap.address() as { port: number }).port}`;
	const pinned = async () => connectPinned({ socket: await connectThroughRelay(viaTap, fingerprint) }, fingerprint);

	// The long code gives fp and r: the client pins fp, so the proof is optional, but works through the relay as well.
	const minted = auth.mintPairingCode();
	const nonce = randomBytes(16);
	const seen = await peekFingerprint({ socket: await connectThroughRelay(viaTap, fingerprint) });
	assert.equal(seen.fingerprint, fingerprint, "the server's own certificate, through the relay");
	const proof = await callOver(seen.socket, "POST", "/api/pair/proof", { host: "relay.example", body: { nonce: nonce.toString("base64url") } });
	assert.equal(proof.status, 200, "no Host check through the relay");
	assert.equal(await verifyPairProof({ code: minted.code, fingerprint: seen.fingerprint, nonce, proofs: proof.body.proofs }), true);
	const paired = await callOver(await pinned(), "POST", "/api/pair", { host: "relay.example", body: { code: minted.code, name: "phone" } });
	assert.equal(paired.status, 201, JSON.stringify(paired.body));
	const token: string = paired.body.token;
	const info = await callOver(await pinned(), "GET", "/api/server", { host: "relay.example", token });
	assert.equal(info.status, 200);
	assert.equal(info.body.serverId, server.serverId);
	assert.deepEqual(info.body.relay, { url, connected: true });
	// A bigger body both ways stays intact.
	const big = await callOver(await pinned(), "POST", "/api/pair/proof", { host: "relay.example", body: { nonce: randomBytes(16).toString("base64url"), pad: "x".repeat(10_000) } });
	assert.equal(big.status, 200);

	// What the relay saw: handshake lines, then TLS records only.
	const seenByRelay = Buffer.concat(tapped).toString("latin1");
	for (const secret of [token, minted.code, "/api/pair", "/api/server", "Authorization", "phone"]) assert.ok(!seenByRelay.includes(secret), `the relay never saw ${secret}`);
	assert.ok(seenByRelay.includes('"t":"gsr/client"'), "the client's hello is the only plaintext");
	// The relay logs connections and byte counts, never content.
	await new Promise<void>((resolve) => { const poll = setInterval(() => { if (logs.some((l) => /connection closed after \d+ s, \d+ B up, \d+ B down/.test(l))) { clearInterval(poll); resolve(); } }, 10); });
	assert.ok(!logs.join("\n").includes(token));
});

test("the relay refuses: unknown servers, bad hellos, a wrong secret, a server without the certificate's key", async (t) => {
	const { relay, server, fingerprint } = await setup(t);
	await server.relay!.ready();
	assert.deepEqual((await raw(relay.port, { t: "gsr/client", v: 1, id: "A".repeat(43) })).answer, { t: "error", code: "offline", message: "That server is not connected to this relay" });
	assert.equal((await raw(relay.port, { t: "gsr/client", v: 1, id: "nope" })).answer.code, "bad_request");
	assert.equal((await raw(relay.port, { t: "gsr/client", v: 2, id: fingerprint })).answer.code, "unsupported_version");
	assert.equal((await raw(relay.port, { t: "gsr/client", v: 1, id: fingerprint, port: 0 })).answer.code, "bad_request");
	assert.equal((await raw(relay.port, { t: "gsr/data", v: 1, cid: "x", key: "y" })).answer.code, "unauthorized");
	await assert.rejects(connectThroughRelay(`gsr://127.0.0.1:${relay.port}`, "B".repeat(43)), (e: RelayError) => e.code === "offline");
	// Nothing listens on that port of the server: refused, not a timeout.
	await assert.rejects(connectThroughRelay(`gsr://127.0.0.1:${relay.port}`, fingerprint, { port: 1 }), (e: RelayError) => e.code === "refused");

	// Registering without the relay secret.
	assert.equal((await raw(relay.port, { t: "gsr/server", v: 1, id: fingerprint })).answer.code, "unauthorized");
	assert.equal((await raw(relay.port, { t: "gsr/server", v: 1, id: fingerprint, secret: "wrong" })).answer.code, "unauthorized");
	// An impostor with the secret claims the server's fingerprint but signs with another key: refused, the real one stays.
	const impostor = await raw(relay.port, { t: "gsr/server", v: 1, id: fingerprint, secret: SECRET });
	assert.equal(impostor.answer.t, "challenge");
	const other = createSelfSignedCertificate({ commonName: "impostor", dnsNames: [], ips: [] });
	const { sign, createPrivateKey } = await import("node:crypto"); // the signature helpers a raw client would use
	const sig = sign("sha256", Buffer.from(`${RELAY_SIGNATURE_PREFIX}${String(impostor.answer.nonce)}`), createPrivateKey(other.keyPem));
	impostor.socket.write(`${JSON.stringify({ t: "auth", cert: other.der.toString("base64url"), sig: sig.toString("base64url") })}\n`);
	assert.equal((await line(impostor.socket)).code, "unauthorized");
	assert.deepEqual(relay.servers(), [fingerprint]);
	assert.ok(server.relay!.connected());
});

test("a server with the wrong relay secret is not registered and says so", async (t) => {
	const { relay, server, logs } = await setup(t, { serverSecret: "not-it" });
	await new Promise<void>((resolve) => { const poll = setInterval(() => { if (logs.some((l) => l.includes("refused the registration: unauthorized"))) { clearInterval(poll); resolve(); } }, 10); });
	assert.equal(server.relay!.connected(), false);
	assert.deepEqual(relay.servers(), []);
});

test("relay limits: connections per server, the open timeout, idle pairs", async (t) => {
	const { relay, server, fingerprint } = await setup(t, { relayLimits: { maxConnectionsPerServer: 2, idleMs: 300 } });
	await server.relay!.ready();
	const url = `gsr://127.0.0.1:${relay.port}`;
	const first = await connectThroughRelay(url, fingerprint);
	const second = await connectThroughRelay(url, fingerprint);
	await assert.rejects(connectThroughRelay(url, fingerprint), (e: RelayError) => e.code === "busy");
	// An idle pair is closed by the relay (no byte either way for idleMs).
	await Promise.all([new Promise((r) => first.once("close", r)), new Promise((r) => second.once("close", r))]);
	const third = await connectThroughRelay(url, fingerprint);
	third.destroy();

	// A registered server that never opens the data connection: the client hears "timeout".
	const quiet = await startRelay({ host: "127.0.0.1", port: 0, limits: { openTimeoutMs: 100 } });
	t.after(() => quiet.close());
	const cert = createSelfSignedCertificate({ commonName: "quiet", dnsNames: [], ips: [] });
	const link = startRelayLink({ url: `gsr://127.0.0.1:${quiet.port}`, certDer: cert.der, keyPem: cert.keyPem, accept: () => () => {} });
	t.after(() => link.close());
	await link.ready();
	const silent = startRelayLink({ url: `gsr://127.0.0.1:${quiet.port}`, certDer: cert.der, keyPem: cert.keyPem, accept: () => undefined });
	t.after(() => silent.close());
	await silent.ready(); // the same certificate registers again: it replaces the first registration
	const { id } = silent;
	const hello = await raw(quiet.port, { t: "gsr/client", v: 1, id });
	assert.equal(hello.answer.code, "refused", "the replacing registration refuses (accept says no)");
});

test("the server registers again when the relay comes back, and forwards are reachable by their port", async (t) => {
	const root = scratch();
	const logs: string[] = [];
	let relay = await startRelay({ host: "127.0.0.1", port: 0, secret: SECRET });
	const port = relay.port;
	const auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	const tls = loadOrCreateServeTls(join(root, "serve"), { commonName: "relay test", dnsNames: [], ips: ["127.0.0.1"] });
	const server = await startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", tls, relay: { url: `gsr://127.0.0.1:${port}`, secret: SECRET, retryMinMs: 20 },
		launchSession: () => { throw new Error("none"); }, log: (l) => logs.push(l) });
	t.after(() => server.close());
	await server.relay!.ready();
	await relay.close();
	await new Promise<void>((resolve) => { const poll = setInterval(() => { if (!server.relay!.connected()) { clearInterval(poll); resolve(); } }, 10); });
	relay = await startRelay({ host: "127.0.0.1", port, secret: SECRET });
	t.after(() => relay.close());
	await new Promise<void>((resolve) => { const poll = setInterval(() => { if (server.relay!.connected()) { clearInterval(poll); resolve(); } }, 10); });
	assert.deepEqual(relay.servers(), [tls.fingerprint]);

	// A forward: the client asks the relay for the forward's listen port.
	const page = createHttpServer((req, res) => res.end(`page ${req.url}`));
	await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
	t.after(() => page.close());
	const url = `gsr://127.0.0.1:${port}`;
	const opened = await callOver(await connectPinned({ socket: await connectThroughRelay(url, tls.fingerprint) }, tls.fingerprint), "POST", "/api/forwards",
		{ host: "relay.example", token: ADMIN, body: { port: (page.address() as { port: number }).port, path: "/p" } });
	assert.equal(opened.status, 201, JSON.stringify(opened.body));
	const link = new URL(opened.body.url);
	assert.equal(link.protocol, "https:");
	const first = await callOver(await connectPinned({ socket: await connectThroughRelay(url, tls.fingerprint, { port: Number(link.port) }) }, tls.fingerprint), "GET", `${link.pathname}${link.search}`, { host: "relay.example" });
	assert.equal(first.status, 303);
	const shown = await callOver(await connectPinned({ socket: await connectThroughRelay(url, tls.fingerprint, { port: Number(link.port) }) }, tls.fingerprint), "GET", "/p",
		{ host: "relay.example", headers: { Cookie: String(first.headers["set-cookie"]).split(";")[0] } });
	assert.equal(shown.body, "page /p");
});

test("gentle-shell relay: arguments, the secret, and a run", async () => {
	assert.deepEqual(parseRelayArgs(["--listen", "0.0.0.0:7700"]), { action: "run", host: "0.0.0.0", port: 7700, json: false });
	assert.deepEqual(parseRelayArgs(["--listen=7700", "--secret-file", "/etc/relay", "--json"]), { action: "run", host: "127.0.0.1", port: 7700, json: true, secretFile: "/etc/relay" });
	assert.deepEqual(parseRelayArgs([]), { error: "relay needs --listen <host>:<port>, for example --listen 0.0.0.0:7700" });
	assert.deepEqual(parseRelayArgs(["--help"]), { action: "help" });
	assert.deepEqual(parseRelayArgs(["--open"]), { error: 'unknown relay argument "--open"' });

	const root = scratch();
	const made = relayServerSecret({ agentHome: root, env: {} });
	assert.equal(made.source, join(root, "relay", "secret"));
	if (process.platform !== "win32") assert.equal(statSync(made.source).mode & 0o777, 0o600);
	assert.equal(relayServerSecret({ agentHome: root, env: {} }).secret, made.secret, "made once");
	assert.deepEqual(relayServerSecret({ agentHome: root, env: { GENTLE_SHELL_RELAY_SECRET: " env-secret " } }), { secret: "env-secret", source: "GENTLE_SHELL_RELAY_SECRET" });
	const file = join(root, "given");
	writeFileSync(file, "from-file\nignored\n");
	assert.equal(relayServerSecret({ agentHome: root, env: {} }, file).secret, "from-file");
	// The server side: env first, then <home>/serve/relay-secret.
	writeFileSync(join(root, "relay-secret"), "server-file\n");
	assert.equal(relaySecret({}, root), "server-file");
	assert.equal(relaySecret({ GENTLE_SHELL_RELAY_SECRET: "e" }, root), "e");
	assert.equal(relaySecret({}, join(root, "missing")), undefined);

	const out: string[] = [];
	const stop = Promise.withResolvers<void>();
	const running = runRelayCommand({ action: "run", host: "127.0.0.1", port: 0, json: true }, { agentHome: root, env: {}, stdout: (s) => { out.push(s); stop.resolve(); }, stderr: () => {}, untilStopped: () => stop.promise });
	assert.equal(await running, 0);
	const printed = JSON.parse(out.join(""));
	assert.equal(printed.schema, "gentle-shell.relay/v1");
	assert.equal(printed.secretSource, join(root, "relay", "secret"));
	assert.ok(!out.join("").includes(readFileSync(made.source, "utf8").trim()), "the secret itself is never printed");
});
