import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeAuth } from "../lib/serve-auth.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { after, before, call, pairDevice, test } from "./serve-test-client.ts";

const ADMIN = "gsa_test-admin-token";
let root: string;
let server: ServeServer;
let engram: Server;
let engramPort: number;

function listen(s: Server): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
	return promise;
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), "gentle-serve-services-"));
	// A stand-in for Engram: /health answers, every other path echoes.
	engram = createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end(req.url === "/health" ? "ok" : `engram ${req.url}`);
	});
	engramPort = await listen(engram);
	const auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth,
		version: "test",
		launchSession: () => { throw new Error("no sessions here"); },
		env: { ENGRAM_URL: `http://user:secret@127.0.0.1:${engramPort}/` },
	});
});
after(async () => {
	await server?.close();
	engram?.close();
	engram?.closeAllConnections();
	rmSync(root, { recursive: true, force: true });
});

test("GET /api/services lists Engram when it answers /health, without the URL's credentials", async () => {
	const reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader");
	const listed = await call(server.url, "GET", "/api/services", { token: reader.token });
	assert.equal(listed.status, 200, JSON.stringify(listed.body));
	assert.deepEqual(listed.body.services, [{ id: "engram", name: "Engram", url: `http://127.0.0.1:${engramPort}`, port: engramPort, available: true, forwardable: true, via: "forwards" }]);
	assert.equal((await call(server.url, "GET", "/api/services")).status, 401);
	const caps = (await call(server.url, "GET", "/api/server", { token: reader.token })).body.capabilities;
	assert.ok(caps.includes("server-forwards") && caps.includes("services"));
});

test("an Engram that does not answer is listed as unavailable; a remote one is not forwardable", async () => {
	for (const [url, forwardable] of [["http://127.0.0.1:1", true], ["http://192.0.2.1:7437", false]] as const) {
		const auth = new ServeAuth({ devicesFile: join(root, `other-${forwardable}`, "devices.json"), adminToken: ADMIN });
		const other = await startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", launchSession: () => { throw new Error("none"); }, env: { ENGRAM_URL: url } });
		try {
			const [entry] = (await call(other.url, "GET", "/api/services", { token: ADMIN })).body.services;
			assert.equal(entry.available, false);
			assert.equal(entry.forwardable, forwardable);
		} finally {
			await other.close();
		}
	}
});

test("server-level forwards: open, reuse, list, reach, close; per device; closed on revoke", async () => {
	const phone = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"], "phone");
	const laptop = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"], "laptop");
	const reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader2");
	assert.equal((await call(server.url, "POST", "/api/forwards", { token: reader.token, body: { port: engramPort } })).status, 403);
	assert.equal((await call(server.url, "POST", "/api/forwards", { token: phone.token, body: { port: server.port } })).body.error.code, "invalid_port");
	assert.equal((await call(server.url, "POST", "/api/forwards", { token: phone.token, body: { port: engramPort, path: "//evil" } })).body.error.code, "invalid_path");

	const opened = await call(server.url, "POST", "/api/forwards", { token: phone.token, body: { port: engramPort, path: "/ui" } });
	assert.equal(opened.status, 201, JSON.stringify(opened.body));
	assert.equal(opened.body.sessionId, null);
	assert.equal(opened.body.kind, "server");
	assert.equal(opened.body.port, engramPort);
	assert.match(opened.body.url, new RegExp(`^http://127\\.0\\.0\\.1:${opened.body.listenPort}/ui\\?gs_ticket=`));
	const again = await call(server.url, "POST", "/api/forwards", { token: phone.token, body: { port: engramPort } });
	assert.equal(again.status, 200);
	assert.equal(again.body.id, opened.body.id);

	// The link works like a session forward's: ticket, redirect with a cookie, then the page.
	const first = await call(opened.body.url, "GET", "");
	assert.equal(first.status, 303);
	const cookie = String(first.headers["set-cookie"]).split(";")[0];
	const page = await call(`http://127.0.0.1:${opened.body.listenPort}`, "GET", "/ui", { headers: { Cookie: cookie } });
	assert.equal(page.status, 200);
	assert.equal(page.body, "engram /ui");

	const listed = await call(server.url, "GET", "/api/forwards", { token: phone.token });
	assert.deepEqual(listed.body.forwards.map((f: { id: string }) => f.id), [opened.body.id]);
	assert.deepEqual((await call(server.url, "GET", "/api/forwards", { token: laptop.token })).body.forwards, []);
	assert.equal((await call(server.url, "GET", "/api/forwards", { token: ADMIN })).body.forwards.length, 1, "an admin sees every device's");
	assert.equal((await call(server.url, "DELETE", `/api/forwards/${opened.body.id}`, { token: laptop.token })).status, 404, "only the owner closes it");

	const laptopForward = await call(server.url, "POST", "/api/forwards", { token: laptop.token, body: { port: engramPort } });
	assert.notEqual(laptopForward.body.id, opened.body.id, "another device gets its own");
	assert.equal((await call(server.url, "DELETE", `/api/forwards/${opened.body.id}`, { token: phone.token })).body.closed, opened.body.id);
	assert.deepEqual((await call(server.url, "GET", "/api/forwards", { token: phone.token })).body.forwards, []);

	assert.equal((await call(server.url, "DELETE", `/api/devices/${laptop.id}`, { token: ADMIN })).status, 200);
	assert.deepEqual((await call(server.url, "GET", "/api/forwards", { token: ADMIN })).body.forwards, [], "revoking the device closed its forward");
	assert.equal((await call(server.url, "PUT", "/api/forwards", { token: phone.token })).status, 405);
});
