import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { startServeServer, type ServeServer, type ServeServerOptions } from "../lib/serve-server.ts";
import { KeeperLink, SERVE_SESSION_LIMITS } from "../lib/serve-session.ts";
import { keeperAlive, keeperEndpoint, type KeeperRecord } from "../lib/serve-session-keeper.ts";
import { call, endServeLeftovers, pairDevice, serveLeftovers, stream, type Stream } from "./serve-test-client.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));
const ADMIN = "gsa_test-admin-token";
const roots: string[] = [];
const sessionDirs = () => roots.map((root) => join(root, "serve", "sessions"));
after(async () => {
	// A failed test must not leave keepers (and their fake Pi) behind.
	await endServeLeftovers(sessionDirs(), roots);
	roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function home(): { serveDir: string; project: string } {
	const root = mkdtempSync(join(tmpdir(), "gs-keep-"));
	roots.push(root);
	return { serveDir: join(root, "serve"), project: realpathSync(mkdtempSync(join(root, "p-"))) };
}

function serve(serveDir: string, extra: Partial<ServeServerOptions> = {}): Promise<ServeServer> {
	return startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth: new ServeAuth({ devicesFile: join(serveDir, "devices.json"), adminToken: ADMIN }),
		version: "test",
		serveDir,
		launchSession: (input) => ({ command: process.execPath, args: [FAKE_PI], cwd: input.cwd, env: { ...process.env, GENTLE_SHELL_INTERACTIVE_HOST: "1" } }),
		limits: { rpcTimeoutMs: 3000 },
		...extra,
	});
}

function record(serveDir: string, id: string): KeeperRecord {
	return JSON.parse(readFileSync(join(serveDir, "sessions", `${id}.json`), "utf8")) as KeeperRecord;
}

async function startSession(server: ServeServer, serveDir: string, project: string, token = ADMIN): Promise<string> {
	const created = await call(server.url, "POST", "/api/sessions", { token, body: { cwd: project } });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	return created.body.session.id;
}

// Polls a condition another process makes true; there is no event to await for it.
async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** The `id:`/`data:` records of an SSE text, in order. */
function records(text: string): Array<{ seq: number; record: Record<string, unknown> }> {
	const out: Array<{ seq: number; record: Record<string, unknown> }> = [];
	for (const block of text.split("\n\n")) {
		const id = /^id: (\d+)$/m.exec(block);
		const data = /^data: (.*)$/m.exec(block);
		if (id && data) out.push({ seq: Number(id[1]), record: JSON.parse(data[1]) });
	}
	return out;
}

test("a session survives a server restart mid-stream: same id, seq continues, nothing lost within the ring", { timeout: 30_000 }, async () => {
	const { serveDir, project } = home();
	const first = await serve(serveDir);
	const id = await startSession(first, serveDir, project);
	const before = await stream(first.url, `/api/sessions/${id}/events?after=0`, ADMIN);
	assert.equal((await call(first.url, "POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_trickle", count: 40, everyMs: 15 } })).status, 200);
	await before.waitFor('"tick":5');
	await first.close();
	await before.closed;
	const seen = records(before.text);
	const last = seen.at(-1)!.seq;
	assert.ok(seen.every((r, i) => r.seq === i + 1), "the first server delivered every record in order");

	// Pi keeps going while no server runs; its keeper holds the records.
	const keeper = record(serveDir, id);
	assert.equal(keeper.state, "running");
	assert.ok(keeperAlive(keeper.keeperPid));
	if (process.platform !== "win32") {
		assert.equal(statSync(join(serveDir, "sessions")).mode & 0o777, 0o700);
		assert.equal(statSync(join(serveDir, "sessions", `${id}.json`)).mode & 0o777, 0o600);
		assert.equal(statSync(keeperEndpoint(join(serveDir, "sessions"), id)).mode & 0o777, 0o600);
	}

	const second = await serve(serveDir);
	try {
		const listed = await call(second.url, "GET", "/api/sessions", { token: ADMIN });
		const session = listed.body.sessions.find((s: { id: string }) => s.id === id);
		assert.equal(session.state, "running", "the same id, still running");
		assert.ok(session.seq >= last);
		const info = await call(second.url, "GET", "/api/server", { token: ADMIN });
		assert.ok(info.body.capabilities.includes("persistent-sessions"));

		const resumed = await stream(second.url, `/api/sessions/${id}/events?after=${last}`, ADMIN);
		await resumed.waitFor('"tick":39');
		const rest = records(resumed.text);
		assert.ok(!resumed.text.includes("snapshot-required"));
		assert.deepEqual(rest.map((r) => r.seq), rest.map((_, i) => last + 1 + i), "seq continues where the client left off, without a gap");
		const ticks = [...seen, ...rest].map((r) => r.record.tick).filter((tick) => tick !== undefined);
		assert.deepEqual(ticks, Array.from({ length: 40 }, (_, i) => i), "every record reached the client exactly once");

		// The session still takes commands, under the seq the keeper keeps.
		const state = await call(second.url, "POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "get_state", id: "mine" } });
		assert.equal(state.status, 200);
		assert.equal(state.body.id, "mine");
		await resumed.waitFor('"command":"get_state"');
		resumed.close();
	} finally {
		await second.close({ endSessions: true });
	}
	await until(() => !keeperAlive(keeper.keeperPid), "the keeper to end with its session");
	assert.equal(record(serveDir, id).state, "exited", "the record stays for the listing");
});

test("a pending dialog, an open host tool call and the last active device survive a restart", { timeout: 30_000 }, async () => {
	const { serveDir, project } = home();
	const limits = { sessionLimits: { hostToolReattachGraceMs: 400 } };
	const first = await serve(serveDir, limits);
	const phone = await pairDevice(first.url, ADMIN, ["sessions:read", "sessions:operate"], "phone");
	const id = await startSession(first, serveDir, project, phone.token);
	const phoneStream = await stream(first.url, `/api/sessions/${id}/events`, phone.token);
	const tools = await call(first.url, "POST", `/api/sessions/${id}/desktop`, { token: phone.token, body: { method: "set_host_tools", params: { tools: [{ name: "phone_camera" }] } } });
	assert.equal(tools.status, 200, JSON.stringify(tools.body));
	assert.equal((await call(first.url, "POST", `/api/sessions/${id}/rpc`, { token: phone.token, body: { type: "fake_dialog" } })).status, 200);
	assert.equal((await call(first.url, "POST", `/api/sessions/${id}/rpc`, { token: phone.token, body: { type: "fake_host_call", callId: "c1", provider: phone.id } })).status, 200);
	await phoneStream.waitFor('\\"callId\\":\\"c1\\"');
	await first.close();

	const second = await serve(serveDir, limits);
	let back: Stream | undefined;
	try {
		const view = (await call(second.url, "GET", `/api/sessions/${id}`, { token: ADMIN })).body.session;
		assert.equal(view.pendingDialogs, 1);
		assert.equal(view.lastActiveDevice, phone.id, "the last active device is kept with the keeper");
		// The phone comes back within the grace: a fresh stream gets the dialog and its call again.
		back = await stream(second.url, `/api/sessions/${id}/events`, phone.token);
		await back.waitFor("event: dialog");
		await back.waitFor("event: host_tool_call");
		const answered = await call(second.url, "POST", `/api/sessions/${id}/rpc`, { token: phone.token, body: { type: "extension_ui_response", id: "dlg-1", value: "a" } });
		assert.equal(answered.status, 202, JSON.stringify(answered.body));
		await back.waitFor('"type":"fake_dialog_answer"');
		await back.waitFor('"type":"serve_dialog_resolved"');
		const again = await call(second.url, "POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "extension_ui_response", id: "dlg-1", value: "b" } });
		assert.equal(again.status, 409);
		const result = await call(second.url, "POST", `/api/sessions/${id}/desktop`, { token: phone.token, body: { method: "host_tool_result", params: { callId: "c1", content: [{ type: "text", text: "ok" }] } } });
		assert.equal(result.status, 200);

		// A call the phone owes when no phone comes back is answered for it once the grace ends.
		assert.equal((await call(second.url, "POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_host_call", callId: "c2", provider: phone.id } })).status, 200);
		await back.waitFor('\\"callId\\":\\"c2\\"');
		back.close();
	} finally {
		await second.close();
	}
	const third = await serve(serveDir, limits);
	try {
		const watcher = await stream(third.url, `/api/sessions/${id}/events`, ADMIN);
		await watcher.waitFor("phone_camera runs in phone, which isn't connected right now.");
		watcher.close();
	} finally {
		await third.close({ endSessions: true });
	}
});

test("keeper cleanup: a deleted session, a session that ended while no server ran, an orphan and a lost keeper", { timeout: 30_000 }, async () => {
	const { serveDir, project } = home();
	const sessionsDir = join(serveDir, "sessions");
	const options = { keeperLimits: { lingerMs: 150, orphanMs: 600 } };
	let server = await serve(serveDir, options);

	// DELETE stops Pi and its keeper and forgets the session.
	const deleted = await startSession(server, serveDir, project);
	const deletedPid = record(serveDir, deleted).keeperPid;
	assert.equal((await call(server.url, "DELETE", `/api/sessions/${deleted}`, { token: ADMIN })).status, 200);
	await until(() => !keeperAlive(deletedPid), "the deleted session's keeper to end");
	assert.ok(!existsSync(join(sessionsDir, `${deleted}.json`)));
	if (process.platform !== "win32") assert.ok(!existsSync(keeperEndpoint(sessionsDir, deleted)));

	// Pi exits while no server runs: the keeper records it and ends; the next server lists it.
	const ended = await startSession(server, serveDir, project);
	assert.equal((await call(server.url, "POST", `/api/sessions/${ended}/rpc`, { token: ADMIN, body: { type: "fake_exit", code: 4, afterMs: 300 } })).status, 200);
	// No server comes back to the other one for longer than the orphan limit: it stops its session.
	const orphan = await startSession(server, serveDir, project);
	// The keeper of a third one is killed: the server sees the session lost.
	const lost = await startSession(server, serveDir, project);
	const lostStream = await stream(server.url, `/api/sessions/${lost}/events`, ADMIN);
	process.kill(record(serveDir, lost).keeperPid, "SIGKILL");
	await lostStream.closed;
	assert.ok(lostStream.text.includes('"error":"keeper_lost"'));
	assert.equal((await call(server.url, "GET", `/api/sessions/${lost}`, { token: ADMIN })).body.session.state, "exited");
	await server.close();

	const endedPid = record(serveDir, ended).keeperPid;
	const orphanPid = record(serveDir, orphan).keeperPid;
	await until(() => !keeperAlive(endedPid), "the ended session's keeper to finish");
	assert.equal(record(serveDir, ended).state, "exited");
	assert.equal(record(serveDir, ended).exitCode, 4);
	await until(() => !keeperAlive(orphanPid), "the orphan keeper to stop its session");
	assert.equal(record(serveDir, orphan).state, "exited");

	server = await serve(serveDir, options);
	try {
		const listed = (await call(server.url, "GET", "/api/sessions", { token: ADMIN })).body.sessions as Array<{ id: string; state: string; exitCode: number | null }>;
		const byId = new Map(listed.map((s) => [s.id, s]));
		assert.equal(byId.get(ended)?.state, "exited");
		assert.equal(byId.get(ended)?.exitCode, 4);
		assert.equal(byId.get(orphan)?.state, "exited");
		assert.equal(byId.get(lost)?.state, "exited");
		assert.equal(record(serveDir, lost).error, "keeper_lost", "a keeper that died is recorded as lost");
		assert.equal(byId.has(deleted), false);
		// An ended session has no ring left: a client's cursor gets snapshot-required.
		const late = await stream(server.url, `/api/sessions/${ended}/events?after=1`, ADMIN);
		await late.closed;
		assert.ok(late.text.includes("event: snapshot-required"));
	} finally {
		await server.close();
	}
});

test("a server collects the end of a session that exited moments before it started", { timeout: 30_000 }, async () => {
	const { serveDir, project } = home();
	const first = await serve(serveDir);
	const id = await startSession(first, serveDir, project);
	assert.equal((await call(first.url, "POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_exit", code: 2, afterMs: 200 } })).status, 200);
	await first.close();
	await until(() => record(serveDir, id).state === "exited", "the session to exit");
	const keeperPid = record(serveDir, id).keeperPid;
	assert.ok(keeperAlive(keeperPid), "its keeper waits for a server");

	const second = await serve(serveDir);
	try {
		const replay = await stream(second.url, `/api/sessions/${id}/events?after=0`, ADMIN);
		await replay.closed;
		const last = records(replay.text).at(-1)!.record;
		assert.deepEqual(last, { type: "serve_session_exited", code: 2, signal: null }, "the exit record reached the new server");
		await until(() => !keeperAlive(keeperPid), "the keeper to end once collected");
	} finally {
		await second.close();
	}
});

test("a keeper answers only a server holding its token", { timeout: 30_000 }, async () => {
	const { serveDir, project } = home();
	const server = await serve(serveDir);
	try {
		const id = await startSession(server, serveDir, project);
		await assert.rejects(KeeperLink.connect(keeperEndpoint(join(serveDir, "sessions"), id), "not-the-token", { timeoutMs: 3000, maxLineBytes: SERVE_SESSION_LIMITS.maxLineBytes }), /keeper/);
		// The real server stays attached.
		assert.equal((await call(server.url, "POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "get_state" } })).status, 200);
	} finally {
		await server.close({ endSessions: true });
	}
});

test("no session keeper or fake Pi outlives the tests above", () => {
	assert.deepEqual(serveLeftovers(sessionDirs(), roots), []);
});
