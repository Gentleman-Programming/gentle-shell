import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeAuth } from "../lib/serve-auth.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { call, test } from "./serve-test-client.ts";

const ADMIN = "gsa_test-admin-token";

async function run(serveDir: string, check: (server: ServeServer) => Promise<void>): Promise<void> {
	const server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth: new ServeAuth({ devicesFile: join(serveDir, "devices.json"), adminToken: ADMIN }),
		version: "test",
		serveDir,
		launchSession: () => { throw new Error("no sessions here"); },
	});
	try {
		await check(server);
	} finally {
		await server.close();
	}
}

test("the server id is minted once per home and kept across runs", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-serve-id-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const serveDir = join(root, "serve");
	const ids: string[] = [];
	for (let i = 0; i < 2; i += 1) {
		await run(serveDir, async (server) => {
			const identity = await call(server.url, "GET", "/.well-known/gentle-shell");
			const info = await call(server.url, "GET", "/api/server", { token: ADMIN });
			assert.equal(identity.body.serverId, server.serverId);
			assert.equal(info.body.serverId, server.serverId);
			ids.push(server.serverId);
		});
	}
	assert.match(ids[0], /^srv_[0-9a-f]{16}$/);
	assert.equal(ids[1], ids[0], "a restart keeps the id");
	const file = join(serveDir, "server-id");
	assert.equal(readFileSync(file, "utf8").trim(), ids[0]);
	if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

	writeFileSync(file, "not an id\n");
	await run(serveDir, async (server) => {
		assert.match(server.serverId, /^srv_[0-9a-f]{16}$/);
		assert.notEqual(server.serverId, ids[0], "a malformed file is replaced");
		assert.equal(readFileSync(file, "utf8").trim(), server.serverId);
	});
});
