import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { ServeAuth, type ServeScope } from "../lib/serve-auth.ts";
import { allowedHosts, carriesHostToolRequest, desktopMethodScope, rpcCommandScope, startServeServer, type ServeServer } from "../lib/serve-server.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));
const ADMIN = "gsa_test-admin-token";
const roots: string[] = [];
let server: ServeServer;
let auth: ServeAuth;
let project: string;
let stopRequests = 0;
const launches: Array<{ cwd: string; sessionId?: string }> = [];

before(async () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-serve-server-"));
	roots.push(root);
	project = realpathSync(mkdtempSync(join(root, "project-")));
	auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth,
		version: "test",
		launchSession: (input) => {
			launches.push(input);
			return { command: process.execPath, args: [FAKE_PI, ...(input.sessionId ? ["--session", input.sessionId] : [])], cwd: input.cwd, env: { ...process.env, GENTLE_SHELL_INTERACTIVE_HOST: "1" } };
		},
		onStopRequested: () => { stopRequests += 1; },
		limits: { rpcTimeoutMs: 2000, maxSessions: 3 },
	});
});
after(async () => {
	await server?.close();
	roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

interface Reply { status: number; body: any; headers: IncomingMessage["headers"] }

function call(method: string, path: string, options: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
	const req = httpRequest(`${server.url}${path}`, {
		method,
		headers: {
			...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
			...(payload === undefined ? {} : { "Content-Type": "application/json" }),
			...options.headers,
		},
	}, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			let body: unknown = text;
			try { body = JSON.parse(text); } catch { /* not JSON */ }
			resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
		});
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}

/** An open SSE stream; `text` grows as events arrive. */
interface Stream { status: number; text: string; closed: Promise<void>; waitFor(what: string): Promise<void>; close(): void }

function stream(path: string, token?: string): Promise<Stream> {
	const { promise, resolve, reject } = Promise.withResolvers<Stream>();
	const req = httpRequest(`${server.url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
		const closed = Promise.withResolvers<void>();
		const waiters: Array<{ what: string; done: () => void }> = [];
		const s: Stream = {
			status: res.statusCode ?? 0,
			text: "",
			closed: closed.promise,
			waitFor(what) {
				if (s.text.includes(what)) return Promise.resolve();
				const w = Promise.withResolvers<void>();
				waiters.push({ what, done: w.resolve });
				return w.promise;
			},
			close: () => req.destroy(),
		};
		res.on("data", (c: Buffer) => {
			s.text += c.toString("utf8");
			for (const w of [...waiters]) if (s.text.includes(w.what)) { waiters.splice(waiters.indexOf(w), 1); w.done(); }
		});
		res.on("close", () => closed.resolve());
		resolve(s);
	});
	req.on("error", (error) => { if (!(error as NodeJS.ErrnoException).code?.startsWith("ECONNRESET")) reject(error); });
	req.end();
	return promise;
}

async function pairDevice(scopes: ServeScope[], name = "device"): Promise<{ id: string; token: string }> {
	const code = await call("POST", "/api/pairing-codes", { token: ADMIN, body: { scopes } });
	assert.equal(code.status, 201);
	const paired = await call("POST", "/api/pair", { body: { code: code.body.code, name } });
	assert.equal(paired.status, 201, JSON.stringify(paired.body));
	assert.deepEqual(paired.body.scopes, scopes);
	return { id: paired.body.id, token: paired.body.token };
}

async function startSession(token = ADMIN): Promise<string> {
	const started = await call("POST", "/api/sessions", { token, body: { cwd: project } });
	assert.equal(started.status, 201, JSON.stringify(started.body));
	return started.body.session.id;
}

test("scope tables: reads need sessions:read, everything else operates", () => {
	assert.equal(rpcCommandScope("get_state"), "sessions:read");
	assert.equal(rpcCommandScope("get_messages"), "sessions:read");
	assert.equal(rpcCommandScope("prompt"), "sessions:operate");
	assert.equal(rpcCommandScope("bash"), "sessions:operate");
	assert.equal(desktopMethodScope("capabilities"), "sessions:read");
	assert.equal(desktopMethodScope("get_snapshot"), "sessions:read");
	assert.equal(desktopMethodScope("list_jobs"), "sessions:read");
	assert.equal(desktopMethodScope("set_permission_mode"), "sessions:operate");
	assert.equal(desktopMethodScope("apply_profile"), "sessions:operate");
});

test("Host header allowlist follows the listen address", () => {
	const loop = allowedHosts("127.0.0.1", 4000);
	assert.ok(loop("127.0.0.1:4000") && loop("localhost:4000") && loop("[::1]:4000"));
	assert.ok(!loop("evil.example:4000") && !loop("127.0.0.1:4001") && !loop("192.168.1.2:4000"));
	const lan = allowedHosts("192.168.1.2", 4000);
	assert.ok(lan("192.168.1.2:4000"));
	assert.ok(!lan("127.0.0.1:4000") && !lan("rebind.example:4000"));
	const any = allowedHosts("0.0.0.0", 4000);
	assert.ok(any("10.0.0.7:4000") && any("127.0.0.1:4000") && any("[fe80::1]:4000"));
	assert.ok(!any("rebind.example:4000") && !any("10.0.0.7:4001"));
	// A tailnet MagicDNS name is another DNS name: refused unless the operator allowed it.
	assert.ok(!any("box.tail1234.ts.net:4000"));
	const tailnet = allowedHosts("0.0.0.0", 4000, ["box.tail1234.ts.net"]);
	assert.ok(tailnet("box.tail1234.ts.net:4000") && tailnet("BOX.tail1234.ts.net:4000") && tailnet("10.0.0.7:4000"));
	assert.ok(!tailnet("box.tail1234.ts.net:4001") && !tailnet("other.tail1234.ts.net:4000"));
});

test("requests with a foreign Origin or an unexpected Host are refused before auth", async () => {
	const origin = await call("GET", "/api/server", { token: ADMIN, headers: { Origin: "http://evil.example" } });
	assert.equal(origin.status, 403);
	assert.equal(origin.body.error.code, "forbidden_origin");
	const same = await call("GET", "/api/server", { token: ADMIN, headers: { Origin: server.url } });
	assert.equal(same.status, 200);
	const host = await call("GET", "/api/server", { token: ADMIN, headers: { Host: "rebind.example" } });
	assert.equal(host.status, 421);
	const pair = await call("POST", "/api/pair", { body: { code: "XXXX-XXXX" }, headers: { Origin: "http://evil.example" } });
	assert.equal(pair.status, 403, "a page elsewhere cannot even try a code");
});

test("GET /.well-known/gentle-shell names the server without a token, and Host/Origin rules still apply", async () => {
	const identity = await call("GET", "/.well-known/gentle-shell");
	assert.equal(identity.status, 200);
	assert.deepEqual(identity.body, { schema: "gentle-shell.serve.identity/v1", serverId: server.serverId, name: hostname(), protocol: 1, version: "test", tls: false });
	assert.equal(identity.headers["cache-control"], "no-store");
	assert.ok(!JSON.stringify(identity.body).includes("gsa_"), "no admin token, code or device in it");
	// A token changes nothing: the answer is the same public identity.
	assert.deepEqual((await call("GET", "/.well-known/gentle-shell", { token: ADMIN })).body, identity.body);
	assert.equal((await call("POST", "/.well-known/gentle-shell")).status, 405);
	assert.equal((await call("GET", "/.well-known/gentle-shell", { headers: { Host: "rebind.example" } })).status, 421);
	assert.equal((await call("GET", "/.well-known/gentle-shell", { headers: { Origin: "http://evil.example" } })).status, 403);
});

test("security headers, no token, a bad token and unknown routes", async () => {
	const none = await call("GET", "/api/sessions");
	assert.equal(none.status, 401);
	assert.equal(none.headers["cache-control"], "no-store");
	assert.match(String(none.headers["content-security-policy"]), /default-src 'none'/);
	assert.equal(none.headers["access-control-allow-origin"], undefined);
	assert.equal((await call("GET", "/api/sessions", { token: "gss_nope" })).status, 401);
	assert.equal((await call("GET", "/nope", { token: ADMIN })).status, 404);
	const info = await call("GET", "/api/server", { token: ADMIN });
	assert.equal(info.body.schema, "gentle-shell.serve/v1");
	assert.equal(info.body.protocol, 1);
	assert.equal(info.body.serverId, server.serverId);
	assert.deepEqual(info.body.device.scopes, ["sessions:read", "sessions:operate", "terminal", "admin"]);
	assert.equal(info.body.home, homedir(), "a token that may start sessions learns the default folder");
	const reader = await pairDevice(["sessions:read"], "info-reader");
	assert.equal((await call("GET", "/api/server", { token: reader.token })).body.home, undefined, "a reader does not");
});

test("bodies are bounded and must be one JSON object", async () => {
	const big = await call("POST", "/api/pairing-codes", { token: ADMIN, raw: JSON.stringify({ pad: "x".repeat(40_000) }) });
	assert.equal(big.status, 413);
	const bad = await call("POST", "/api/pairing-codes", { token: ADMIN, raw: "[1,2]" });
	assert.equal(bad.status, 400);
	const scopes = await call("POST", "/api/pairing-codes", { token: ADMIN, body: { scopes: ["root"] } });
	assert.equal(scopes.status, 400);
});

test("per-endpoint scopes: a read-only device reads, a session device operates, only admin pairs", async () => {
	const reader = await pairDevice(["sessions:read"], "reader");
	const operator = await pairDevice(["sessions:read", "sessions:operate"], "operator");
	const id = await startSession(operator.token);

	assert.equal((await call("POST", "/api/sessions", { token: reader.token, body: { cwd: project } })).status, 403);
	const list = await call("GET", "/api/sessions", { token: reader.token });
	assert.equal(list.status, 200);
	const seen = list.body.sessions.find((s: any) => s.id === id);
	assert.equal(seen.cwd, undefined, "a read-only token sees the folder name, not the path");
	assert.equal(seen.name, project.split(/[\\/]/).at(-1));
	const full = await call("GET", `/api/sessions/${id}`, { token: operator.token });
	assert.equal(full.body.session.cwd, project);

	assert.equal((await call("POST", `/api/sessions/${id}/rpc`, { token: reader.token, body: { type: "get_state" } })).status, 200);
	const prompt = await call("POST", `/api/sessions/${id}/rpc`, { token: reader.token, body: { type: "prompt", message: "hi" } });
	assert.equal(prompt.status, 403);
	assert.equal((await call("POST", `/api/sessions/${id}/desktop`, { token: reader.token, body: { method: "get_snapshot" } })).status, 200);
	assert.equal((await call("POST", `/api/sessions/${id}/desktop`, { token: reader.token, body: { method: "set_permission_mode", params: { mode: "yolo" } } })).status, 403);
	assert.equal((await call("POST", `/api/sessions/${id}/desktop`, { token: operator.token, body: { method: "set_permission_mode", params: { mode: "normal" } } })).status, 200);
	assert.equal((await call("DELETE", `/api/sessions/${id}`, { token: reader.token })).status, 403);

	for (const token of [reader.token, operator.token]) {
		assert.equal((await call("POST", "/api/pairing-codes", { token, body: {} })).status, 403);
		assert.equal((await call("GET", "/api/devices", { token })).status, 403);
		assert.equal((await call("DELETE", `/api/devices/${reader.id}`, { token })).status, 403);
		assert.equal((await call("POST", "/api/server/stop", { token })).status, 403);
	}
	const devices = await call("GET", "/api/devices", { token: ADMIN });
	assert.ok(devices.body.devices.some((d: any) => d.id === reader.id && d.lastUsedAt));
	assert.ok(devices.body.devices.every((d: any) => !("tokenHash" in d) && !("token" in d)));
	assert.equal((await call("DELETE", `/api/sessions/${id}`, { token: operator.token })).status, 200);
});

test("session lifecycle: start, Pi RPC, Desktop RPC, SSE replay, stop", async () => {
	const started = await call("POST", "/api/sessions", { token: ADMIN, body: { cwd: project, sessionId: "abc-123" } });
	assert.equal(started.status, 201);
	const id = started.body.session.id;
	assert.equal(started.body.session.state, "running");
	assert.deepEqual(launches.at(-1), { cwd: project, sessionId: "abc-123" });

	const state = await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "get_state", id: "client-1" } });
	assert.equal(state.status, 200);
	assert.equal(state.body.id, "client-1");
	assert.equal(state.body.data.interactiveHost, "1");
	assert.deepEqual(state.body.data.args, ["--session", "abc-123"]);

	const caps = await call("POST", `/api/sessions/${id}/desktop`, { token: ADMIN, body: { method: "capabilities", params: {} } });
	assert.equal(caps.status, 200);
	assert.equal(caps.body.kind, "response");
	assert.equal(caps.body.data.method, "capabilities");

	const refused = await call("POST", `/api/sessions/${id}/desktop`, { token: ADMIN, body: { method: "refuse" } });
	assert.equal(refused.status, 502);
	const slow = await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_silent" } });
	assert.equal(slow.status, 202);
	assert.equal(slow.body.pending, true);

	const events = await stream(`/api/sessions/${id}/events?after=0`, ADMIN);
	assert.equal(events.status, 200);
	await events.waitFor('"command":"get_state"');
	assert.match(events.text, /event: hello\n/);
	assert.match(events.text, /id: 1\ndata: \{/);
	await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_burst", count: 2 } });
	await events.waitFor('"n":1');

	const resumed = await stream(`/api/sessions/${id}/events`, ADMIN);
	resumed.close();
	const lastId = Number([...events.text.matchAll(/^id: (\d+)$/gm)].at(-1)![1]);
	const gap = await stream(`/api/sessions/${id}/events?after=${lastId - 1}`, ADMIN);
	await gap.waitFor(`id: ${lastId}\n`);
	gap.close();
	const invalid = await call("GET", `/api/sessions/${id}/events?after=x`, { token: ADMIN });
	assert.equal(invalid.status, 400);

	const stopped = await call("DELETE", `/api/sessions/${id}`, { token: ADMIN });
	assert.equal(stopped.status, 200);
	assert.equal(stopped.body.session.state, "exited");
	await events.closed;
	assert.match(events.text, /serve_session_exited/);
	assert.equal((await call("GET", `/api/sessions/${id}`, { token: ADMIN })).status, 404);
});

test("sessions need an existing absolute folder and a plain Pi session id; the count is bounded", async () => {
	for (const cwd of ["relative/path", join(project, "missing"), 42]) {
		assert.equal((await call("POST", "/api/sessions", { token: ADMIN, body: { cwd } })).status, 400);
	}
	assert.equal((await call("POST", "/api/sessions", { token: ADMIN, body: { cwd: project, sessionId: "../../etc" } })).status, 400);
	const ids = [await startSession(), await startSession(), await startSession()];
	const fourth = await call("POST", "/api/sessions", { token: ADMIN, body: { cwd: project } });
	assert.equal(fourth.status, 429);
	for (const id of ids) await call("DELETE", `/api/sessions/${id}`, { token: ADMIN });
});

test("dialogs: a late subscriber gets the pending dialog, the first answer wins", async () => {
	const id = await startSession();
	await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_dialog" } });
	const late = await stream(`/api/sessions/${id}/events`, ADMIN);
	await late.waitFor("event: dialog\n");
	assert.match(late.text, /"id":"dlg-1"/);
	const first = await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "extension_ui_response", id: "dlg-1", value: "a" } });
	assert.equal(first.status, 202);
	const second = await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "extension_ui_response", id: "dlg-1", value: "b" } });
	assert.equal(second.status, 409);
	const unknown = await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "extension_ui_response", id: "zzz", value: "b" } });
	assert.equal(unknown.status, 404);
	await late.waitFor('"type":"fake_dialog_answer"');
	await late.waitFor('"type":"serve_dialog_resolved"');
	late.close();
	await call("DELETE", `/api/sessions/${id}`, { token: ADMIN });
});

test("stream tickets: EventSource-style access with ?ticket=, single use, bound to the session", async () => {
	const reader = await pairDevice(["sessions:read"], "browser");
	const id = await startSession();
	const other = await startSession();
	const minted = await call("POST", "/api/tickets", { token: reader.token, body: { sessionId: id } });
	assert.equal(minted.status, 201);
	assert.match(minted.body.ticket, /^[A-Za-z0-9_-]{32}$/);
	assert.equal((await call("GET", `/api/sessions/${other}/events?ticket=${minted.body.ticket}`)).status, 401, "another session spends it");
	const again = await call("POST", "/api/tickets", { token: reader.token, body: { sessionId: id } });
	const opened = await stream(`/api/sessions/${id}/events?ticket=${again.body.ticket}`);
	assert.equal(opened.status, 200);
	await opened.waitFor("event: hello");
	opened.close();
	assert.equal((await call("GET", `/api/sessions/${id}/events?ticket=${again.body.ticket}`)).status, 401, "single use");
	assert.equal((await call("GET", `/api/sessions/${id}/rpc?ticket=${again.body.ticket}`)).status, 405);
	assert.equal((await call("POST", "/api/tickets", { token: reader.token, body: { sessionId: "ses_missing" } })).status, 404);
	assert.equal((await call("POST", "/api/tickets", { body: { sessionId: id } })).status, 401);
	await call("DELETE", `/api/sessions/${id}`, { token: ADMIN });
	await call("DELETE", `/api/sessions/${other}`, { token: ADMIN });
});

test("revoking a device closes its open streams at once and its token stops working", async () => {
	const phone = await pairDevice(["sessions:read", "sessions:operate"], "phone");
	const id = await startSession();
	const open = await stream(`/api/sessions/${id}/events`, phone.token);
	await open.waitFor("event: hello");
	const mine = await stream(`/api/sessions/${id}/events`, ADMIN);
	await mine.waitFor("event: hello");
	const revoked = await call("DELETE", `/api/devices/${phone.id}`, { token: ADMIN });
	assert.equal(revoked.status, 200);
	await open.closed;
	assert.equal((await call("GET", "/api/sessions", { token: phone.token })).status, 401);
	await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "get_state" } });
	await mine.waitFor('"command":"get_state"');
	mine.close();
	assert.equal((await call("DELETE", `/api/devices/${phone.id}`, { token: ADMIN })).status, 404);
	await call("DELETE", `/api/sessions/${id}`, { token: ADMIN });
});

test("pairing over HTTP is single use and admin can stop the server", async () => {
	const code = await call("POST", "/api/pairing-codes", { token: ADMIN, body: {} });
	assert.equal((await call("POST", "/api/pair", { body: { code: code.body.code, name: "a" } })).status, 201);
	const reused = await call("POST", "/api/pair", { body: { code: code.body.code, name: "b" } });
	assert.equal(reused.status, 403);
	assert.equal(reused.body.error.code, "invalid_code");
	assert.equal((await call("GET", "/api/pair")).status, 405);
	const stop = await call("POST", "/api/server/stop", { token: ADMIN });
	assert.equal(stop.status, 202);
	await new Promise((r) => setImmediate(r));
	assert.equal(stopRequests, 1);
});

test("only /desktop carries host tool requests: a /gentle:desktop prompt naming them through /rpc is refused", () => {
	const prompt = (method: string) => `/gentle:desktop ${JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", requestId: "r", method, params: {} })}`;
	for (const method of ["set_host_tools", "host_tool_result", "host_tool_progress", "host_message", "set_host_context"]) {
		assert.equal(carriesHostToolRequest(prompt(method)), true, method);
		assert.equal(desktopMethodScope(method), "sessions:operate", method);
	}
	assert.equal(carriesHostToolRequest(prompt("capabilities")), false);
	assert.equal(carriesHostToolRequest("/gentle:desktop not json"), false, "the session refuses what it cannot parse anyway");
	assert.equal(carriesHostToolRequest("set_host_tools"), false);
});

test("host tools over HTTP: the provider is the calling device, only that device answers its calls, an offline device is answered for", async () => {
	const phone = await pairDevice(["sessions:read", "sessions:operate"], "phone");
	const laptop = await pairDevice(["sessions:read", "sessions:operate"], "laptop");
	const reader = await pairDevice(["sessions:read"], "watcher");
	const id = await startSession(phone.token);
	const desktop = (token: string, method: string, params: Record<string, unknown>) =>
		call("POST", `/api/sessions/${id}/desktop`, { token, body: { schema: "gentle-shell.desktop-rpc/v1", requestId: "client-own", method, params } });

	const registered = await desktop(phone.token, "set_host_tools", { provider: laptop.id, tools: [] });
	assert.equal(registered.status, 200);
	assert.equal(registered.body.data.params.provider, phone.id, "the server overwrites the provider with the calling device");
	assert.equal((await desktop(reader.token, "set_host_tools", { provider: "x", tools: [] })).status, 403, "registering tools operates");
	const context = await desktop(phone.token, "set_host_context", { provider: laptop.id, content: "Simulators: iPhone 16" });
	assert.equal(context.status, 200);
	assert.equal(context.body.data.params.provider, phone.id, "host context is always the calling device's");
	assert.equal((await desktop(reader.token, "set_host_context", { provider: "x", content: "" })).status, 403, "setting host context operates");
	const message = await desktop(phone.token, "host_message", { customType: "host.genui.event", content: "clicked", display: true, deliver: "auto", details: { pad: "d".repeat(200 * 1024) } });
	assert.equal(message.status, 200, "a host message's details may exceed the usual Desktop cap");
	assert.equal(message.body.data.params.customType, "host.genui.event");
	assert.equal((await desktop(reader.token, "host_message", { customType: "host.x", content: "", display: false, deliver: "auto" })).status, 403, "sending host messages operates");
	for (const method of ["set_host_tools", "host_tool_result", "host_tool_progress", "host_message", "set_host_context"]) {
		const message = `/gentle:desktop ${JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", requestId: "r", method, params: { provider: laptop.id, tools: [] } })}`;
		const refused = await call("POST", `/api/sessions/${id}/rpc`, { token: phone.token, body: { type: "prompt", message } });
		assert.equal(refused.status, 400, method);
		assert.equal(refused.body.error.code, "use_desktop_endpoint");
	}
	const other = await call("POST", `/api/sessions/${id}/rpc`, { token: phone.token, body: { type: "prompt", message: `/gentle:desktop ${JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", requestId: "r", method: "capabilities", params: {} })}` } });
	assert.equal(other.status, 200, "other Desktop requests still go through /rpc");

	const phoneStream = await stream(`/api/sessions/${id}/events`, phone.token);
	await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_host_call", callId: "call-1", provider: phone.id } });
	await phoneStream.waitFor('\\"callId\\":\\"call-1\\"');
	const stolen = await desktop(laptop.token, "host_tool_result", { callId: "call-1", content: [{ type: "text", text: "not mine" }] });
	assert.equal(stolen.status, 403);
	assert.equal(stolen.body.error.code, "forbidden");
	const big = "x".repeat(1024 * 1024);
	const stolenBeat = await desktop(laptop.token, "host_tool_progress", { callId: "call-1" });
	assert.equal(stolenBeat.status, 403, "only the provider keeps its call alive");
	assert.equal(stolenBeat.body.error.code, "forbidden");
	await desktop(laptop.token, "host_message", { customType: "host.x", content: "hi", display: false, deliver: "auto" });
	assert.equal((await call("GET", `/api/sessions/${id}`, { token: phone.token })).body.session.lastActiveDevice, laptop.id);
	const beat = await desktop(phone.token, "host_tool_progress", { callId: "call-1", message: "waiting for review" });
	assert.equal(beat.status, 200);
	assert.equal(beat.body.data.method, "host_tool_progress");
	assert.equal((await call("GET", `/api/sessions/${id}`, { token: phone.token })).body.session.lastActiveDevice, laptop.id, "a heartbeat is not activity");
	assert.equal((await desktop(phone.token, "host_tool_progress", { callId: "call-1", pad: "x".repeat(100 * 1024) })).status, 413, "a heartbeat keeps the usual Desktop cap");
	const answered = await desktop(phone.token, "host_tool_result", { callId: "call-1", content: [{ type: "text", text: big }] });
	assert.equal(answered.status, 200, "a host tool result may be far larger than other Desktop requests");
	assert.equal(answered.body.data.params.content[0].text.length, big.length);
	assert.equal((await desktop(phone.token, "get_snapshot", { pad: "x".repeat(100 * 1024) })).status, 413, "every other method keeps its cap");

	// The laptop registered nothing and has no stream: its call is answered for it at once, by name.
	await call("POST", `/api/sessions/${id}/rpc`, { token: ADMIN, body: { type: "fake_host_call", callId: "call-2", provider: laptop.id, tool: "laptop_clip" } });
	await phoneStream.waitFor("laptop_clip runs in laptop, which isn't connected right now.");
	phoneStream.close();
	assert.equal((await call("DELETE", `/api/sessions/${id}`, { token: phone.token })).status, 200);
});

test("several devices may provide one host tool: the session learns which are connected, most recently active first", async () => {
	const phone = await pairDevice(["sessions:read", "sessions:operate"], "phone");
	const laptop = await pairDevice(["sessions:read", "sessions:operate"], "laptop");
	const id = await startSession(phone.token);
	const desktop = (token: string, method: string, params: Record<string, unknown>) =>
		call("POST", `/api/sessions/${id}/desktop`, { token, body: { method, params } });
	// What the fake child echoes for a set_host_activity the server sent, as it appears inside the stream's widget record.
	const activity = (providers: string[]) => JSON.stringify(JSON.stringify({ method: "set_host_activity", params: { providers } })).slice(1, -1);
	const tools = [{ name: "device_screenshot", label: "Screenshot", description: "Takes a screenshot.", parameters: { type: "object" } }];

	const phoneStream = await stream(`/api/sessions/${id}/events`, phone.token);
	const laptopStream = await stream(`/api/sessions/${id}/events`, laptop.token);
	assert.equal((await call("GET", `/api/sessions/${id}`, { token: phone.token })).body.session.lastActiveDevice, phone.id, "starting the session drove it");
	await desktop(phone.token, "set_host_tools", { tools });
	await laptopStream.waitFor(activity([phone.id]));
	await desktop(laptop.token, "set_host_tools", { tools });
	await laptopStream.waitFor(activity([laptop.id, phone.id]));
	assert.equal((await call("POST", `/api/sessions/${id}/rpc`, { token: phone.token, body: { type: "prompt", message: "take a screenshot" } })).status, 200);
	await laptopStream.waitFor(activity([phone.id, laptop.id]));
	const view = await call("GET", `/api/sessions/${id}`, { token: laptop.token });
	assert.equal(view.body.session.lastActiveDevice, phone.id, "the last device that drove the session");
	assert.equal((await call("POST", `/api/sessions/${id}/rpc`, { token: laptop.token, body: { type: "get_state" } })).status, 200);
	assert.equal((await call("GET", `/api/sessions/${id}`, { token: laptop.token })).body.session.lastActiveDevice, phone.id, "a read is not activity");

	phoneStream.close();
	await laptopStream.waitFor(activity([laptop.id]));

	const forged = await desktop(laptop.token, "set_host_activity", { providers: [laptop.id] });
	assert.equal(forged.status, 403, "only the server reports activity");
	const viaRpc = `/gentle:desktop ${JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", requestId: "r", method: "set_host_activity", params: { providers: [] } })}`;
	assert.equal((await call("POST", `/api/sessions/${id}/rpc`, { token: laptop.token, body: { type: "prompt", message: viaRpc } })).body.error.code, "use_desktop_endpoint");
	laptopStream.close();
	assert.equal((await call("DELETE", `/api/sessions/${id}`, { token: phone.token })).status, 200);
});
