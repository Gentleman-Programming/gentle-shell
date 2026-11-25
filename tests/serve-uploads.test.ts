import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { cleanUploadName } from "../lib/serve-uploads.ts";
import { call, pairDevice } from "./serve-test-client.ts";

const ADMIN = "gsa_test-admin-token";
let root: string;
let serveDir: string;
let server: ServeServer;
let operator: { id: string; token: string };
let reader: { id: string; token: string };
let expired: string;
let fresh: string;

before(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-serve-uploads-")));
	serveDir = join(root, "serve");
	// One upload from 8 days ago and one from yesterday, for the sweep at start.
	expired = join(serveDir, "uploads", "dev_old", "aaaa");
	fresh = join(serveDir, "uploads", "dev_old", "bbbb");
	for (const [dir, days] of [[expired, 8], [fresh, 1]] as const) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "f.txt"), "x");
		const at = new Date(Date.now() - days * 24 * 60 * 60_000);
		utimesSync(dir, at, at);
	}
	const auth = new ServeAuth({ devicesFile: join(serveDir, "devices.json"), adminToken: ADMIN });
	server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth,
		version: "test",
		serveDir,
		launchSession: () => { throw new Error("no sessions here"); },
		uploadLimits: { bytes: 1024 },
	});
	operator = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"], "operator");
	reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader");
});
after(async () => {
	await server?.close();
	rmSync(root, { recursive: true, force: true });
});

test("cleanUploadName keeps the last component, drops control and reserved characters", () => {
	assert.equal(cleanUploadName("photo.png"), "photo.png");
	assert.equal(cleanUploadName("../../etc/passwd"), "passwd");
	assert.equal(cleanUploadName("C:\\Users\\me\\shot 1.png"), "shot 1.png");
	assert.equal(cleanUploadName("a\u0000b\nc?.txt"), "a_b_c_.txt");
	assert.equal(cleanUploadName(".."), "upload");
	assert.equal(cleanUploadName(""), "upload");
	assert.equal(cleanUploadName(null), "upload");
	assert.equal(cleanUploadName("dir/"), "upload");
	assert.ok(Buffer.byteLength(cleanUploadName("é".repeat(300)), "utf8") <= 200);
});

test("POST /api/uploads stores the body under the device's folder and answers its path", async () => {
	const sent = await call(server.url, "POST", `/api/uploads?name=${encodeURIComponent("../notes.md")}`, { token: operator.token, raw: "# hi\n" });
	assert.equal(sent.status, 201, JSON.stringify(sent.body));
	assert.equal(sent.body.name, "notes.md");
	assert.equal(sent.body.size, 5);
	assert.match(sent.body.sha256, /^[0-9a-f]{64}$/);
	assert.ok(Date.parse(sent.body.expiresAt) > Date.now() + 6 * 24 * 60 * 60_000);
	const path: string = sent.body.path;
	assert.equal(dirname(dirname(path)), join(serveDir, "uploads", operator.id));
	assert.match(path, /\/[0-9a-f]{16}\/notes\.md$/);
	assert.equal(readFileSync(path, "utf8"), "# hi\n");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);

	const again = await call(server.url, "POST", "/api/uploads?name=notes.md", { token: operator.token, raw: "two" });
	assert.notEqual(again.body.path, path, "every upload gets its own folder");

	const capabilities = (await call(server.url, "GET", "/api/server", { token: reader.token })).body.capabilities;
	assert.ok(capabilities.includes("uploads"));
});

test("uploads need sessions:operate, are bounded, and leave nothing behind when refused", async () => {
	assert.equal((await call(server.url, "POST", "/api/uploads?name=x", { token: reader.token, raw: "x" })).status, 403);
	assert.equal((await call(server.url, "POST", "/api/uploads?name=x", { raw: "x" })).status, 401);
	assert.equal((await call(server.url, "GET", "/api/uploads", { token: operator.token })).status, 405);
	const before = readdirSync(join(serveDir, "uploads", operator.id)).length;
	const big = await call(server.url, "POST", "/api/uploads?name=big.bin", { token: operator.token, raw: Buffer.alloc(2048) });
	assert.equal(big.status, 413);
	assert.equal(readdirSync(join(serveDir, "uploads", operator.id)).length, before);
});

test("uploads older than 7 days are removed", async () => {
	// The sweep at start runs in the background with nothing to await: poll for its effect.
	for (let i = 0; i < 50 && existsSync(expired); i += 1) await new Promise((r) => setTimeout(r, 20));
	assert.equal(existsSync(expired), false);
	assert.equal(existsSync(fresh), true);
});

test("a server without a serve folder takes no uploads", async () => {
	const auth = new ServeAuth({ devicesFile: join(root, "other", "devices.json"), adminToken: ADMIN });
	const bare = await startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", launchSession: () => { throw new Error("none"); } });
	try {
		assert.equal((await call(bare.url, "POST", "/api/uploads?name=x", { token: ADMIN, raw: "x" })).status, 501);
		assert.equal((await call(bare.url, "GET", "/api/server", { token: ADMIN })).body.capabilities.includes("uploads"), false);
	} finally {
		await bare.close();
	}
});
