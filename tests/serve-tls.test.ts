import assert from "node:assert/strict";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import test, { after } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { callOver as overSocket } from "./serve-test-client.ts";
import { discoveryReply } from "../lib/serve-discovery.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { certificateFingerprint, connectPinned, createSelfSignedCertificate, createServeListener, ipBytes, isLocalPeer, loadOrCreateServeTls, PAIR_PROOF, pairProof, pairProofKey,
	peekFingerprint, serveTlsFiles, verifyPairProof } from "../lib/serve-tls.ts";

const ADMIN = "gsa_tls-test-admin";
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function scratch(): string {
	const r = realpathSync(mkdtempSync(join(tmpdir(), "gentle-serve-tls-")));
	roots.push(r);
	return r;
}

function tlsIdentity(root: string) {
	return loadOrCreateServeTls(join(root, "serve"), { commonName: "gentle-shell serve test", dnsNames: ["localhost"], ips: ["127.0.0.1", "::1"] });
}

async function tlsServer(root: string, extra: Partial<Parameters<typeof startServeServer>[0]> = {}): Promise<{ server: ServeServer; auth: ServeAuth; fingerprint: string }> {
	const auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	const tls = tlsIdentity(root);
	const server = await startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", tls,
		launchSession: () => { throw new Error("no sessions in these tests"); }, ...extra });
	return { server, auth, fingerprint: tls.fingerprint };
}

test("the certificate: self-signed P-256, ten years, CA false, serverAuth, every name and address", () => {
	const made = createSelfSignedCertificate({ commonName: "gentle-shell serve box", dnsNames: ["localhost", "Box.local", "box"], ips: ["127.0.0.1", "::1", "192.168.1.20", "[fe80::1%en0]", "::ffff:10.0.0.5", "not-an-ip"] });
	const cert = new X509Certificate(made.der);
	assert.equal(cert.subject, "CN=gentle-shell serve box");
	assert.equal(cert.issuer, cert.subject, "self-issued");
	assert.ok(cert.verify(cert.publicKey), "self-signed with its own key");
	assert.equal(cert.publicKey.asymmetricKeyType, "ec");
	assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
	assert.equal(cert.ca, false);
	assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
	assert.equal(cert.subjectAltName, "DNS:localhost, DNS:box.local, DNS:box, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, IP Address:192.168.1.20, IP Address:FE80:0:0:0:0:0:0:1, IP Address:0:0:0:0:0:FFFF:A00:5");
	assert.equal(cert.checkHost("box.local"), "box.local");
	assert.equal(cert.checkIP("192.168.1.20"), "192.168.1.20");
	const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (365.25 * 24 * 3600_000);
	assert.ok(years > 9.99 && years < 10.01, String(years));
	assert.ok(Date.parse(cert.validFrom) < Date.now(), "valid from before now (clock skew)");
	assert.ok(!cert.serialNumber.startsWith("0") || cert.serialNumber.length > 1);
	assert.match(made.keyPem, /^-----BEGIN PRIVATE KEY-----\n/);
	assert.equal(new X509Certificate(made.certPem).fingerprint256, cert.fingerprint256, "the PEM is the same certificate");
	// The fingerprint is base64url SHA-256 of the DER: the colon-hex form Node prints, re-encoded.
	assert.equal(certificateFingerprint(made.der), Buffer.from(cert.fingerprint256.replace(/:/g, ""), "hex").toString("base64url"));
	// Validity past 2049 switches to GeneralizedTime.
	const late = new X509Certificate(createSelfSignedCertificate({ commonName: "late", dnsNames: [], ips: [], now: new Date("2045-06-01T00:00:00Z") }).der);
	assert.equal(new Date(late.validTo).getUTCFullYear(), 2055);
});

test("IP literals to SAN bytes", () => {
	assert.deepEqual(ipBytes("10.1.2.3"), Buffer.from([10, 1, 2, 3]));
	assert.equal(ipBytes("::1")?.toString("hex"), "00000000000000000000000000000001");
	assert.equal(ipBytes("2001:db8::8a2e:370:7334")?.toString("hex"), "20010db80000000000008a2e03707334");
	assert.equal(ipBytes("[fe80::1%en0]")?.toString("hex"), "fe800000000000000000000000000001");
	assert.equal(ipBytes("::ffff:192.168.1.1")?.toString("hex"), "00000000000000000000ffffc0a80101");
	assert.equal(ipBytes("box.local"), undefined);
});

test("made once in <home>/serve/tls, owner-only, and kept across runs; an unusable one is replaced", () => {
	const root = scratch();
	const first = tlsIdentity(root);
	assert.equal(first.created, true);
	const files = serveTlsFiles(join(root, "serve"));
	if (process.platform !== "win32") {
		assert.equal(statSync(files.dir).mode & 0o777, 0o700);
		assert.equal(statSync(files.key).mode & 0o777, 0o600);
		assert.equal(statSync(files.cert).mode & 0o777, 0o600);
	}
	const second = tlsIdentity(root);
	assert.equal(second.created, false);
	assert.equal(second.fingerprint, first.fingerprint, "the same certificate: paired devices keep their pin");
	// A key that does not match the certificate is not used.
	writeFileSync(files.key, createSelfSignedCertificate({ commonName: "other", dnsNames: [], ips: [] }).keyPem);
	const third = tlsIdentity(root);
	assert.equal(third.created, true);
	assert.notEqual(third.fingerprint, first.fingerprint);
	assert.equal(readFileSync(files.key, "utf8"), third.keyPem);
	// One near its end is replaced at start.
	assert.equal(loadOrCreateServeTls(join(root, "serve"), { commonName: "x", dnsNames: [], ips: [] }, () => Date.now() + 10 * 365.25 * 24 * 3600_000).created, true);
});

test("which peers may use plain HTTP: this machine only", () => {
	assert.equal(isLocalPeer({ remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }), true);
	assert.equal(isLocalPeer({ remoteAddress: "::ffff:127.0.0.1", localAddress: "::ffff:127.0.0.1" }), true);
	assert.equal(isLocalPeer({ remoteAddress: "::1", localAddress: "::1" }), true);
	assert.equal(isLocalPeer({ remoteAddress: "192.168.1.20", localAddress: "192.168.1.20" }), true, "this machine through its own LAN address");
	assert.equal(isLocalPeer({ remoteAddress: "::ffff:192.168.1.30", localAddress: "::ffff:192.168.1.20" }), false);
	assert.equal(isLocalPeer({ remoteAddress: undefined, localAddress: "192.168.1.20" }), false);
});

test("discovery replies carry tls and the fingerprint only when the server has one", () => {
	assert.deepEqual(JSON.parse(discoveryReply({ id: "srv_1", name: "box", port: 8787 }).toString()), { t: "gentle-shell/here", v: 1, id: "srv_1", n: "box", p: 8787 });
	assert.deepEqual(JSON.parse(discoveryReply({ id: "srv_1", name: "box", port: 8787, fingerprint: "F".repeat(43) }).toString()),
		{ t: "gentle-shell/here", v: 1, id: "srv_1", n: "box", p: 8787, tls: true, fp: "F".repeat(43) });
});

test("the pairing proof: scrypt key, HMAC over fingerprint and nonce, exact numbers", async () => {
	const fp = randomBytes(32);
	const nonce = randomBytes(16);
	// Normalization: case, separators and O/I/L are the same code.
	const key = await pairProofKey("abcd-efgh", fp);
	assert.deepEqual(key, await pairProofKey("ABCDEFGH", fp));
	assert.deepEqual(await pairProofKey("0111-2222", fp), await pairProofKey("oIl1-2222", fp));
	const proof = pairProof(key, fp, nonce).toString("base64url");
	assert.equal(await verifyPairProof({ code: "ABCD-EFGH", fingerprint: fp.toString("base64url"), nonce, proofs: ["junk", proof] }), true);
	assert.equal(await verifyPairProof({ code: "ABCD-EFGX", fingerprint: fp.toString("base64url"), nonce, proofs: [proof] }), false, "another code");
	assert.equal(await verifyPairProof({ code: "ABCD-EFGH", fingerprint: randomBytes(32).toString("base64url"), nonce, proofs: [proof] }), false, "another certificate");
	assert.equal(await verifyPairProof({ code: "ABCD-EFGH", fingerprint: fp.toString("base64url"), nonce: randomBytes(16), proofs: [proof] }), false, "another nonce");
	// A known-answer vector a client in another language can check itself against.
	const vectorFp = Buffer.alloc(32, 0x11);
	const vectorKey = await pairProofKey("7PH3-DM9V", vectorFp);
	assert.equal(vectorKey.length, PAIR_PROOF.keyBytes);
	assert.deepEqual(PAIR_PROOF, { salt: "gentle-shell/pair-proof/v1", N: 32768, r: 8, p: 1, keyBytes: 32, nonceMinBytes: 16, nonceMaxBytes: 64, perWindow: 20, windowMs: 60_000 });
	const vector = pairProof(vectorKey, vectorFp, Buffer.alloc(16, 0x22)).toString("base64url");
	assert.equal(vector, VECTOR_PROOF, `key ${vectorKey.toString("hex")}`);
});

/** key = scrypt("7PH3DM9V", "gentle-shell/pair-proof/v1" || 32×0x11) = 59ff303c…1c5255; proof = HMAC(key, 32×0x11 || 16×0x22); also in docs/serve.md. */
const VECTOR_PROOF = "fVUUvh7KIXU0NWi6IYymHsCbVNxnxvrPSpB9O0h_XKs";

test("HTTPS with a pinned fingerprint; plain HTTP stays for this machine; a different certificate fails the pin", async (t) => {
	const root = scratch();
	const { server, fingerprint } = await tlsServer(root);
	t.after(() => server.close());
	assert.equal(server.fingerprint, fingerprint);
	assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, "the local URL stays plain");
	const target = { host: "127.0.0.1", port: server.port };

	const identity = await overSocket(await connectPinned(target, fingerprint), "GET", "/.well-known/gentle-shell", { host: `127.0.0.1:${server.port}` });
	assert.equal(identity.status, 200);
	assert.equal(identity.body.tls, true);
	assert.equal(identity.body.fp, fingerprint);
	// The same port answers plain HTTP from this machine (the CLI, a local app).
	const plain = await fetch(`${server.url}/.well-known/gentle-shell`);
	assert.equal((await plain.json()).fp, fingerprint);
	// An admin token over TLS: /api/server names the certificate too.
	const info = await overSocket(await connectPinned(target, fingerprint), "GET", "/api/server", { host: `127.0.0.1:${server.port}`, token: ADMIN });
	assert.deepEqual(info.body.tls, { fingerprint });
	// Origin: this server's own, over either scheme.
	assert.equal((await overSocket(await connectPinned(target, fingerprint), "GET", "/.well-known/gentle-shell", { host: `127.0.0.1:${server.port}`, headers: { Origin: `https://127.0.0.1:${server.port}` } })).status, 200);
	assert.equal((await overSocket(await connectPinned(target, fingerprint), "GET", "/.well-known/gentle-shell", { host: `127.0.0.1:${server.port}`, headers: { Origin: "https://evil.example" } })).status, 403);
	// The Host check still applies over TLS.
	assert.equal((await overSocket(await connectPinned(target, fingerprint), "GET", "/.well-known/gentle-shell", { host: "evil.example" })).status, 421);

	// A man in the middle with its own certificate: the pinned client stops before sending a byte.
	const mitm = createSelfSignedCertificate({ commonName: "gentle-shell serve test", dnsNames: ["localhost"], ips: ["127.0.0.1"] });
	const seenByMitm: Buffer[] = [];
	const innerClosed = Promise.withResolvers<void>();
	const proxy = createTlsServer({ key: mitm.keyPem, cert: mitm.certPem }, (inner) => {
		inner.on("data", (chunk: Buffer) => seenByMitm.push(chunk));
		inner.on("error", () => inner.destroy());
		inner.on("close", () => innerClosed.resolve());
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	t.after(() => proxy.close());
	const proxyPort = (proxy.address() as { port: number }).port;
	await assert.rejects(connectPinned({ host: "127.0.0.1", port: proxyPort }, fingerprint), (error: Error & { code?: string; seen?: string }) => {
		assert.equal(error.code, "fingerprint_mismatch");
		assert.equal(error.seen, certificateFingerprint(mitm.der));
		return true;
	});
	await innerClosed.promise;
	assert.equal(Buffer.concat(seenByMitm).length, 0, "nothing was sent to the impostor");
});

test("a network peer that speaks plain HTTP is told to use HTTPS", async (t) => {
	const root = scratch();
	const tls = tlsIdentity(root);
	const listener = createServeListener({ tls, setup: (http) => http.on("request", (_req, res) => res.end("ok")) });
	await new Promise<void>((resolve) => listener.server.listen(0, "127.0.0.1", resolve));
	t.after(() => { listener.server.close(); listener.closeAllConnections(); });
	// Forge the peer address a remote client would have.
	const socketFromElsewhere = netConnect({ host: "127.0.0.1", port: (listener.server.address() as { port: number }).port });
	listener.server.prependOnceListener("connection", (socket: Socket) => {
		Object.defineProperty(socket, "remoteAddress", { value: "192.168.1.30" });
	});
	const answer = await new Promise<string>((resolve) => {
		let text = "";
		socketFromElsewhere.on("data", (c) => { text += c.toString(); });
		socketFromElsewhere.on("close", () => resolve(text));
		socketFromElsewhere.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
	});
	assert.match(answer, /^HTTP\/1\.1 400 Bad Request\r\n/);
	assert.match(answer, /"code":"tls_required"/);
});

test("pairing after discovery: the proof binds the code to the certificate seen; a man in the middle cannot pass it", async (t) => {
	const root = scratch();
	const { server, auth, fingerprint } = await tlsServer(root);
	t.after(() => server.close());
	const target = { host: "127.0.0.1", port: server.port };
	const host = `127.0.0.1:${server.port}`;
	const proofOf = async (via: { host: string; port: number }, nonce: Buffer) => {
		const seen = await peekFingerprint(via);
		const reply = await overSocket(seen.socket, "POST", "/api/pair/proof", { host, body: { nonce: nonce.toString("base64url") } });
		return { seen: seen.fingerprint, reply };
	};

	const none = await proofOf(target, randomBytes(16));
	assert.equal(none.reply.status, 200);
	assert.deepEqual(none.reply.body, { proofs: [] }, "no live code, no proof");

	const minted = auth.mintPairingCode();
	auth.mintPairingCode();
	const nonce = randomBytes(24);
	const direct = await proofOf(target, nonce);
	assert.equal(direct.seen, fingerprint);
	assert.equal(direct.reply.body.proofs.length, 2, "one proof per live code");
	assert.equal(await verifyPairProof({ code: minted.code, fingerprint: direct.seen, nonce, proofs: direct.reply.body.proofs }), true);
	assert.equal(await verifyPairProof({ code: "ZZZZ-ZZZZ", fingerprint: direct.seen, nonce, proofs: direct.reply.body.proofs }), false);

	// A man in the middle: terminates TLS with its own certificate and relays the HTTP to the real server.
	const mitm = createSelfSignedCertificate({ commonName: "evil", dnsNames: [], ips: ["127.0.0.1"] });
	const proxy = createTlsServer({ key: mitm.keyPem, cert: mitm.certPem }, async (inner) => {
		inner.on("error", () => inner.destroy());
		const outer = await connectPinned(target, fingerprint);
		inner.pipe(outer).pipe(inner);
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	t.after(() => proxy.close());
	const relayed = await proofOf({ host: "127.0.0.1", port: (proxy.address() as { port: number }).port }, nonce);
	assert.equal(relayed.reply.status, 200, "the real server answered through the proxy");
	assert.notEqual(relayed.seen, fingerprint);
	assert.equal(await verifyPairProof({ code: minted.code, fingerprint: relayed.seen, nonce, proofs: relayed.reply.body.proofs }), false,
		"the proofs name the real certificate, not the one the client saw: the client keeps its code");

	// Then the code goes to the pinned server, which pairs as before.
	const paired = await overSocket(await connectPinned(target, fingerprint), "POST", "/api/pair", { host, body: { code: minted.code, name: "phone" } });
	assert.equal(paired.status, 201);
	assert.match(paired.body.token, /^gss_/);
	const live = await proofOf(target, nonce);
	assert.equal(live.reply.body.proofs.length, 1, "the used code has no proof any more");

	// Nonces: 16-64 bytes of base64url.
	for (const bad of ["", "short", randomBytes(8).toString("base64url"), randomBytes(65).toString("base64url"), "not base64url!"]) {
		const reply = await overSocket(await connectPinned(target, fingerprint), "POST", "/api/pair/proof", { host, body: { nonce: bad } });
		assert.equal(reply.status, 400, bad);
		assert.equal(reply.body.error.code, "invalid_nonce");
	}
	assert.equal((await overSocket(await connectPinned(target, fingerprint), "GET", "/api/pair/proof", { host })).status, 405);
	// 20 proofs a minute across callers (this test used 4 of them so far).
	const codes: number[] = [];
	for (let i = 0; i < 17; i += 1) codes.push((await overSocket(await connectPinned(target, fingerprint), "POST", "/api/pair/proof", { host, body: { nonce: randomBytes(16).toString("base64url") } })).status);
	assert.deepEqual(codes.slice(0, 16), Array(16).fill(200));
	assert.equal(codes[16], 429);
});

test("a plain server has no proof to give", async (t) => {
	const root = scratch();
	const auth = new ServeAuth({ devicesFile: join(root, "devices.json"), adminToken: ADMIN });
	const server = await startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", launchSession: () => { throw new Error("none"); } });
	t.after(() => server.close());
	const reply = await fetch(`${server.url}/api/pair/proof`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: randomBytes(16).toString("base64url") }) });
	assert.equal(reply.status, 501);
	assert.equal(server.fingerprint, undefined);
	await assert.rejects(startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", relay: { url: "gsr://127.0.0.1:1" }, launchSession: () => { throw new Error("none"); } }), /a relay needs TLS/);
});

test("forwards speak TLS with the same certificate and link over https", async (t) => {
	const root = scratch();
	const page = createHttpServer((req, res) => res.end(`page ${req.url}`));
	await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
	t.after(() => page.close());
	const pagePort = (page.address() as { port: number }).port;
	const { server, fingerprint } = await tlsServer(root);
	t.after(() => server.close());
	const host = `127.0.0.1:${server.port}`;
	const opened = await overSocket(await connectPinned({ host: "127.0.0.1", port: server.port }, fingerprint), "POST", "/api/forwards", { host, token: ADMIN, body: { port: pagePort, path: "/hello" } });
	assert.equal(opened.status, 201, JSON.stringify(opened.body));
	const link = new URL(opened.body.url);
	assert.equal(link.protocol, "https:", "a link reached over TLS is https");
	const forwardTarget = { host: "127.0.0.1", port: Number(link.port) };
	const first = await overSocket(await connectPinned(forwardTarget, fingerprint), "GET", `${link.pathname}${link.search}`, { host: `127.0.0.1:${link.port}` });
	assert.equal(first.status, 303);
	const cookie = String(first.headers["set-cookie"]).split(";")[0];
	const shown = await overSocket(await connectPinned(forwardTarget, fingerprint), "GET", "/hello", { host: `127.0.0.1:${link.port}`, headers: { Cookie: cookie } });
	assert.equal(shown.status, 200);
	assert.equal(shown.body, "page /hello");
	// Over plain HTTP from this machine, the link is http.
	const local = await fetch(`${server.url}/api/forwards`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ port: pagePort }) });
	assert.match((await local.json()).url, /^http:\/\//);
});
