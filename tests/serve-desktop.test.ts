// `POST /api/desktop` and `GET /api/desktop/events`: Desktop RPC without a
// session of the client's own, answered by serve's hidden control session (a
// fake Pi here: no model, no turn).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { startServeServer, type ServeServer, type ServeServerOptions } from "../lib/serve-server.ts";
import { keeperAlive, type KeeperRecord } from "../lib/serve-session-keeper.ts";
import { call, pairDevice, stream } from "./serve-test-client.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));
const ADMIN = "gsa_test-admin-token";
const roots: string[] = [];
const keepers = new Set<number>();
after(() => {
	for (const pid of keepers) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
	roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function serveDir(): string {
	const root = mkdtempSync(join(tmpdir(), "gs-desk-"));
	roots.push(root);
	return join(root, "serve");
}

function serve(dir: string, launches: Array<{ cwd: string }> = [], extra: Partial<ServeServerOptions> = {}): Promise<ServeServer> {
	return startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth: new ServeAuth({ devicesFile: join(dir, "devices.json"), adminToken: ADMIN }),
		version: "test",
		serveDir: dir,
		launchSession: (input) => {
			launches.push(input);
			return { command: process.execPath, args: [FAKE_PI], cwd: input.cwd, env: { ...process.env, GENTLE_SHELL_INTERACTIVE_HOST: "1" } };
		},
		limits: { rpcTimeoutMs: 3000 },
		...extra,
	});
}

/** The control session's id and keeper record, as serve keeps them beside the other keepers. */
function controlOf(dir: string): { id: string; record: KeeperRecord } | undefined {
	const file = join(dir, "sessions", "control");
	if (!existsSync(file)) return undefined;
	const id = readFileSync(file, "utf8").trim();
	const record = JSON.parse(readFileSync(join(dir, "sessions", `${id}.json`), "utf8")) as KeeperRecord;
	keepers.add(record.keeperPid);
	return { id, record };
}

async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** The `id:`/`data:` records of an SSE text. */
function records(text: string): Array<{ seq: number; record: Record<string, any> }> {
	const out: Array<{ seq: number; record: Record<string, any> }> = [];
	for (const block of text.split("\n\n")) {
		const id = /^id: (\d+)$/m.exec(block);
		const data = /^data: (.*)$/m.exec(block);
		if (id && data) out.push({ seq: Number(id[1]), record: JSON.parse(data[1]) });
	}
	return out;
}

const eventName = (record: Record<string, any>) => JSON.parse(record.widgetLines[0]).event as string;

test("the control session starts on first use in the server's home, answers Desktop RPC, and is hidden from the session list", { timeout: 30_000 }, async () => {
	const dir = serveDir();
	const launches: Array<{ cwd: string }> = [];
	const server = await serve(dir, launches);
	try {
		const info = await call(server.url, "GET", "/api/server", { token: ADMIN });
		assert.ok(info.body.capabilities.includes("desktop"));
		assert.equal(launches.length, 0, "nothing starts before a client uses it");
		assert.equal(controlOf(dir), undefined);

		const answer = await call(server.url, "POST", "/api/desktop", { token: ADMIN, body: { method: "get_config", params: { store: "pi_settings" } } });
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		assert.equal(answer.body.kind, "response");
		assert.equal(answer.body.ok, true);
		assert.deepEqual(answer.body.data, { method: "get_config", params: { store: "pi_settings" } });
		assert.deepEqual(launches.map((l) => l.cwd), [homedir()], "one session, in the server user's home folder");
		const control = controlOf(dir)!;
		assert.ok(control, "serve names its control session beside the keepers");

		// A second request reuses it.
		assert.equal((await call(server.url, "POST", "/api/desktop", { token: ADMIN, body: { method: "capabilities" } })).status, 200);
		assert.equal(launches.length, 1);

		const listed = await call(server.url, "GET", "/api/sessions", { token: ADMIN });
		assert.deepEqual(listed.body.sessions, [], "never in the list");
		const byId = await call(server.url, "GET", `/api/sessions/${control.id}`, { token: ADMIN });
		assert.equal(byId.status, 404, "nor reachable as a session");
		assert.equal((await call(server.url, "POST", `/api/sessions/${control.id}/rpc`, { token: ADMIN, body: { type: "prompt", message: "hi" } })).status, 404, "no model turn through it");
		const admin = await call(server.url, "GET", "/api/sessions?includeControl=1", { token: ADMIN });
		assert.equal(admin.body.sessions.length, 1);
		assert.equal(admin.body.sessions[0].id, control.id);
		assert.equal(admin.body.sessions[0].control, true);
		const device = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"]);
		const notAdmin = await call(server.url, "GET", "/api/sessions?includeControl=1", { token: device.token });
		assert.deepEqual(notAdmin.body.sessions, [], "only an admin sees it");
	} finally {
		await server.close({ endSessions: true });
	}
	assert.equal(controlOf(dir), undefined, "stopping it with the server forgets it");
});

test("scopes per method as /desktop; host tool methods and bad requests are refused before the session starts", { timeout: 30_000 }, async () => {
	const dir = serveDir();
	const launches: Array<{ cwd: string }> = [];
	const server = await serve(dir, launches);
	try {
		const reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader");
		const operator = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"], "operator");
		assert.equal((await call(server.url, "POST", "/api/desktop", { body: { method: "capabilities" } })).status, 401);
		for (const method of ["set_host_tools", "host_tool_result", "host_tool_progress", "host_message", "set_host_context", "set_host_activity"]) {
			const refused = await call(server.url, "POST", "/api/desktop", { token: operator.token, body: { method, params: {} } });
			assert.equal(refused.status, 400, method);
			assert.equal(refused.body.error.code, "use_session_desktop", method);
		}
		assert.equal((await call(server.url, "POST", "/api/desktop", { token: operator.token, body: { method: "Bad Method" } })).status, 400);
		assert.equal((await call(server.url, "POST", "/api/desktop", { token: operator.token, body: { method: "get_config", params: [] } })).status, 400);
		for (const method of ["login_start", "set_config", "install_package", "set_api_key"]) {
			const refused = await call(server.url, "POST", "/api/desktop", { token: reader.token, body: { method, params: {} } });
			assert.equal(refused.status, 403, method);
		}
		assert.equal((await call(server.url, "GET", "/api/desktop", { token: operator.token })).status, 405);
		assert.equal(launches.length, 0, "no refused request starts the control session");

		for (const method of ["capabilities", "get_auth_status", "list_available_models", "list_packages", "get_config"]) {
			const read = await call(server.url, "POST", "/api/desktop", { token: reader.token, body: { method } });
			assert.equal(read.status, 200, method);
		}
		const write = await call(server.url, "POST", "/api/desktop", { token: operator.token, body: { method: "set_config", params: { store: "pi_settings", data: {} } } });
		assert.equal(write.status, 200);
		assert.equal(launches.length, 1);
	} finally {
		await server.close({ endSessions: true });
	}
});

test("GET /api/desktop/events carries only the control session's Desktop events, resumes by seq and takes a desktop ticket", { timeout: 30_000 }, async () => {
	const dir = serveDir();
	const server = await serve(dir);
	try {
		const device = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"]);
		// Opening the stream starts the session too.
		const events = await stream(server.url, "/api/desktop/events", device.token);
		assert.equal(events.status, 200);
		await events.waitFor("event: hello");
		const login = await call(server.url, "POST", "/api/desktop", { token: device.token, body: { method: "login_start", params: { provider: "anthropic" } } });
		assert.equal(login.status, 200);
		await events.waitFor('\\"event\\":\\"login_prompt\\"');
		const install = await call(server.url, "POST", "/api/desktop", { token: device.token, body: { method: "install_package", params: { source: "npm:pi-btw" } } });
		assert.equal(install.status, 200);
		await events.waitFor('\\"event\\":\\"package_finished\\"');
		const seen = records(events.text);
		assert.deepEqual(seen.map((r) => eventName(r.record)), ["login_prompt", "package_progress", "package_finished"], "events only: no Pi response, no Desktop answer");
		assert.ok(seen.every((r, i) => i === 0 || r.seq > seen[i - 1]!.seq), "the session's own seq, increasing");
		events.close();

		// Resuming after the first event replays exactly the rest.
		const resumed = await stream(server.url, `/api/desktop/events?after=${seen[0]!.seq}`, device.token);
		await resumed.waitFor('\\"event\\":\\"package_finished\\"');
		assert.deepEqual(records(resumed.text).map((r) => eventName(r.record)), ["package_progress", "package_finished"]);
		resumed.close();
		const ahead = await stream(server.url, "/api/desktop/events?after=999999", device.token);
		await ahead.waitFor("event: snapshot-required");
		ahead.close();
		assert.equal((await call(server.url, "GET", "/api/desktop/events?after=x", { token: device.token })).status, 400);

		// EventSource-style: a single-use ticket bound to this stream.
		const minted = await call(server.url, "POST", "/api/tickets", { token: device.token, body: { stream: "desktop" } });
		assert.equal(minted.status, 201);
		const ticketed = await stream(server.url, `/api/desktop/events?ticket=${minted.body.ticket}&after=0`);
		assert.equal(ticketed.status, 200);
		await ticketed.waitFor('\\"event\\":\\"package_finished\\"');
		ticketed.close();
		assert.equal((await call(server.url, "GET", `/api/desktop/events?ticket=${minted.body.ticket}`)).status, 401, "single use");
		assert.equal((await call(server.url, "POST", "/api/tickets", { token: device.token, body: { stream: "other" } })).status, 400);
		assert.equal((await call(server.url, "GET", "/api/desktop/events")).status, 401);
	} finally {
		await server.close({ endSessions: true });
	}
});

test("the control session stops when idle, not while a stream is open, and starts again on the next use", { timeout: 30_000 }, async () => {
	const dir = serveDir();
	const launches: Array<{ cwd: string }> = [];
	const server = await serve(dir, launches, { limits: { rpcTimeoutMs: 3000, controlIdleMs: 300 } });
	try {
		const events = await stream(server.url, "/api/desktop/events", ADMIN);
		await events.waitFor("event: hello");
		const first = controlOf(dir)!;
		assert.equal((await call(server.url, "POST", "/api/desktop", { token: ADMIN, body: { method: "capabilities" } })).status, 200);
		// Twice the idle time on the real clock: the keeper is another process, so its staying alive is all there is to observe.
		await new Promise((r) => setTimeout(r, 700));
		assert.ok(keeperAlive(first.record.keeperPid), "an open stream keeps it");
		assert.equal(launches.length, 1);
		events.close();
		await until(() => !keeperAlive(first.record.keeperPid), "the idle control session to stop");
		await until(() => controlOf(dir) === undefined, "serve to forget it");
		assert.equal(existsSync(join(dir, "sessions", `${first.id}.json`)), false, "its record goes with it");

		assert.equal((await call(server.url, "POST", "/api/desktop", { token: ADMIN, body: { method: "capabilities" } })).status, 200);
		const second = controlOf(dir)!;
		assert.notEqual(second.id, first.id, "a new one on the next use");
		assert.equal(launches.length, 2);
	} finally {
		await server.close({ endSessions: true });
	}
});

test("the control session survives a server restart and stays hidden", { timeout: 30_000 }, async () => {
	const dir = serveDir();
	const launches: Array<{ cwd: string }> = [];
	const first = await serve(dir, launches);
	assert.equal((await call(first.url, "POST", "/api/desktop", { token: ADMIN, body: { method: "capabilities" } })).status, 200);
	const control = controlOf(dir)!;
	await first.close();
	assert.ok(keeperAlive(control.record.keeperPid), "its keeper outlives the server");

	const second = await serve(dir, launches);
	try {
		assert.deepEqual((await call(second.url, "GET", "/api/sessions", { token: ADMIN })).body.sessions, [], "reattached, still hidden");
		const admin = await call(second.url, "GET", "/api/sessions?includeControl=1", { token: ADMIN });
		assert.equal(admin.body.sessions[0]?.id, control.id, "the same session");
		assert.equal((await call(second.url, "POST", "/api/desktop", { token: ADMIN, body: { method: "get_auth_status" } })).status, 200);
		assert.equal(launches.length, 1, "taken back, not started again");
	} finally {
		await second.close({ endSessions: true });
	}
	await until(() => !keeperAlive(control.record.keeperPid), "the keeper to end with its session");
	assert.equal(controlOf(dir), undefined);
});
