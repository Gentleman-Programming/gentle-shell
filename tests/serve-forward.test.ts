import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { ServeAuth, type ServeScope } from "../lib/serve-auth.ts";
import { ForwardManager, splitTicket, stripForwardCookies } from "../lib/serve-forward.ts";
import { allowedHosts, startServeServer, type ServeServer } from "../lib/serve-server.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));
const ADMIN = "gsa_test-admin-token";
const TOWER_TOKEN = "tower-token-123";
let root: string;
let server: ServeServer;
let auth: ServeAuth;
let project: string;
let page: Server;
let pagePort: number;
let towerPage: Server;
let towerStarts = 0;
let towerCloses = 0;
/** What the page saw last: the request as it reached the target. */
let seen: { method?: string; url?: string; headers?: IncomingMessage["headers"]; body?: string } = {};
let releaseStream: () => void = () => {};

function listen(s: Server): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
	return promise;
}

/** The page on the server's loopback: echoes requests, streams SSE, redirects, sets cookies, and echoes WebSocket bytes. */
function startPage(): Server {
	const s = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
			if (req.url === "/sse") {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.write("data: first\n\n");
				releaseStream = () => res.end("data: last\n\n");
				return;
			}
			if (req.url === "/redirect") {
				res.writeHead(302, { Location: `http://127.0.0.1:${pagePort}/landed?x=1` });
				return res.end();
			}
			if (req.url === "/cookies") {
				res.writeHead(200, { "Set-Cookie": ["app=1; Path=/", "gs_fwd_fwd_spoof=1; Path=/"] });
				return res.end("ok");
			}
			res.writeHead(200, { "Content-Type": "text/html", "X-Page": "yes" });
			res.end(`<h1>page ${req.url}</h1>`);
		});
	});
	s.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
		seen = { method: req.method, url: req.url, headers: req.headers };
		const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		if (head.length) socket.write(head);
		socket.pipe(socket);
	});
	return s;
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), "gentle-serve-forward-"));
	project = realpathSync(mkdtempSync(join(root, "project-")));
	page = startPage();
	pagePort = await listen(page);
	// A stand-in for Gentle Tower: its token is the first path segment and only its own origin may post.
	towerPage = createServer((req, res) => {
		const origin = req.headers.origin;
		const port = (towerPage.address() as { port: number }).port;
		if (origin && origin !== `http://127.0.0.1:${port}`) { res.writeHead(403); return res.end("bad origin"); }
		if (!req.url?.startsWith(`/${TOWER_TOKEN}/`)) { res.writeHead(403); return res.end("no token"); }
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(`tower ${req.method} ${req.url}`);
	});
	auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth,
		version: "test",
		launchSession: (input) => ({ command: process.execPath, args: [FAKE_PI], cwd: input.cwd, env: { ...process.env } }),
		startTower: async () => {
			towerStarts += 1;
			const port = await listen(towerPage);
			const close = () => {
				towerCloses += 1;
				const closed = Promise.withResolvers<void>();
				towerPage.close(() => closed.resolve());
				towerPage.closeAllConnections();
				return closed.promise;
			};
			return { port, path: `/${TOWER_TOKEN}/`, close };
		},
	});
});
after(async () => {
	await server?.close();
	page?.close();
	page?.closeAllConnections();
	rmSync(root, { recursive: true, force: true });
});

interface Reply { status: number; body: any; headers: IncomingMessage["headers"]; text: string }

function http(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const req = httpRequest(url, { method: options.method ?? "GET", headers: options.headers, agent: false }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			let body: unknown = text;
			try { body = JSON.parse(text); } catch { /* not JSON */ }
			resolve({ status: res.statusCode ?? 0, body, headers: res.headers, text });
		});
	});
	req.on("error", reject);
	req.end(options.body);
	return promise;
}

const api = (method: string, path: string, token: string, body?: unknown) => http(`${server.url}${path}`, {
	method,
	headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function pairDevice(scopes: ServeScope[], name = "device"): Promise<{ id: string; token: string }> {
	const code = await api("POST", "/api/pairing-codes", ADMIN, { scopes });
	const paired = await http(`${server.url}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.body.code, name }) });
	assert.equal(paired.status, 201);
	return { id: paired.body.id, token: paired.body.token };
}

async function startSession(token = ADMIN): Promise<string> {
	const started = await api("POST", "/api/sessions", token, { cwd: project });
	assert.equal(started.status, 201, JSON.stringify(started.body));
	return started.body.session.id;
}

/** Opens a forward link as a browser would: the ticket redirect, then the page with the cookie. */
async function openLink(url: string): Promise<{ cookie: string; origin: string; first: Reply; page: Reply }> {
	const first = await http(url);
	assert.equal(first.status, 303, first.text);
	const setCookie = first.headers["set-cookie"]?.[0] ?? "";
	assert.match(setCookie, /^gs_fwd_fwd_[0-9a-f]{16}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
	const cookie = setCookie.split(";")[0];
	const origin = new URL(url).origin;
	const landed = await http(`${origin}${first.headers.location}`, { headers: { Cookie: cookie } });
	return { cookie, origin, first, page: landed };
}

function closedPort(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ host: "127.0.0.1", port });
	socket.once("connect", () => { socket.destroy(); resolve(false); });
	socket.once("error", () => resolve(true));
	return promise;
}

test("helpers: the ticket leaves the request target and forward cookies leave the Cookie header", () => {
	assert.deepEqual(splitTicket("/a?gs_ticket=T"), { path: "/a", ticket: "T" });
	assert.deepEqual(splitTicket("/a?x=1&gs_ticket=T&y=2"), { path: "/a?x=1&y=2", ticket: "T" });
	assert.deepEqual(splitTicket("/a?x=1"), { path: "/a?x=1" });
	assert.equal(stripForwardCookies("a=1; gs_fwd_fwd_1=s; b=2"), "a=1; b=2");
	assert.equal(stripForwardCookies("gs_fwd_fwd_1=s"), undefined);
	assert.equal(stripForwardCookies(undefined), undefined);
});

test("creating a forward: operate scope, a valid port and path, a running session; the same device and port reuse it", async () => {
	const id = await startSession();
	const reader = await pairDevice(["sessions:read"], "reader");
	const refused = await api("POST", `/api/sessions/${id}/forwards`, reader.token, { port: pagePort });
	assert.equal(refused.status, 403);
	assert.equal((await api("POST", `/api/sessions/${id}/forwards`, "nope", { port: pagePort })).status, 401);
	for (const port of [0, 65536, "80", 1.5, null]) {
		const bad = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port });
		assert.equal(bad.status, 400, String(port));
		assert.equal(bad.body.error.code, "invalid_port");
	}
	assert.equal((await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: server.port })).body.error.code, "invalid_port", "never the server itself");
	for (const path of ["x", "//evil.example/", "/a b", "/\n"]) {
		assert.equal((await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort, path })).body.error.code, "invalid_path", path);
	}
	assert.equal((await api("POST", "/api/sessions/ses_missing/forwards", ADMIN, { port: pagePort })).status, 404);

	const created = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort, path: "/app?x=1#top" });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	assert.deepEqual(Object.keys(created.body), ["id", "port", "listenPort", "sessionId", "kind", "createdAt", "lastUsedAt", "url", "expiresAt"]);
	assert.equal(created.body.kind, "session");
	assert.match(created.body.id, /^fwd_[0-9a-f]{16}$/);
	assert.equal(created.body.port, pagePort);
	assert.equal(created.body.sessionId, id);
	assert.notEqual(created.body.listenPort, pagePort);
	assert.match(created.body.url, new RegExp(`^http://127\\.0\\.0\\.1:${created.body.listenPort}/app\\?x=1&gs_ticket=[A-Za-z0-9_-]{32}#top$`));
	assert.ok(Date.parse(created.body.expiresAt) - Date.now() <= 60_000);
	assert.equal((await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: created.body.listenPort })).body.error.code, "invalid_port", "never a forward");

	const again = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort });
	assert.equal(again.status, 200, "reused");
	assert.equal(again.body.id, created.body.id);
	assert.notEqual(new URL(again.body.url).searchParams.get("gs_ticket"), new URL(created.body.url).searchParams.get("gs_ticket"), "a fresh ticket");

	const list = await api("GET", `/api/sessions/${id}/forwards`, reader.token);
	assert.deepEqual(list.body, { forwards: [] }, "a device lists its own forwards");
	const own = await api("GET", `/api/sessions/${id}/forwards`, ADMIN);
	assert.equal(own.body.forwards.length, 1);
	assert.equal(own.body.forwards[0].url, undefined, "a listing carries no ticket");
	assert.equal((await api("DELETE", `/api/sessions/${id}/forwards/${created.body.id}`, reader.token)).status, 403);
	await api("DELETE", `/api/sessions/${id}`, ADMIN);
});

test("the ticket opens the page once and leaves a per-forward cookie; the target never sees ticket or cookie", async () => {
	const id = await startSession();
	const created = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort, path: "/app?x=1" });
	const { cookie, origin, first, page: landed } = await openLink(created.body.url);
	assert.equal(first.headers.location, "/app?x=1", "the same URL without the ticket");
	assert.equal(first.headers["cache-control"], "no-store");
	assert.equal(landed.status, 200);
	assert.equal(landed.text, "<h1>page /app?x=1</h1>");
	assert.equal(landed.headers["x-page"], "yes");
	assert.equal(landed.headers["access-control-allow-origin"], undefined, "no CORS added");
	assert.equal(seen.url, "/app?x=1");
	assert.equal(seen.headers?.cookie, undefined, "the forward's cookie is stripped");
	assert.equal(seen.headers?.host, `127.0.0.1:${pagePort}`, "Host is the page's own");

	assert.equal((await http(created.body.url)).status, 401, "single use");
	assert.equal((await http(`${origin}/app`)).status, 401, "no cookie, no page");
	assert.equal((await http(`${origin}/app`, { headers: { Cookie: `${cookie.split("=")[0]}=forged` } })).status, 401);
	// Other cookies of the host go through; every forward's own is stripped.
	await http(`${origin}/other`, { headers: { Cookie: `theme=dark; ${cookie}; gs_fwd_fwd_0000000000000000=x` } });
	assert.equal(seen.headers?.cookie, "theme=dark");
	// A used ticket with a valid cookie (a reload of the link) just drops the ticket.
	const reload = await http(created.body.url, { headers: { Cookie: cookie } });
	assert.equal(reload.status, 303);
	assert.equal(reload.headers["set-cookie"], undefined);
	await api("DELETE", `/api/sessions/${id}`, ADMIN);
});

test("cookies are per forward: one forward's cookie does not open another, and tickets are bound to their forward", async () => {
	const id = await startSession();
	const phone = await pairDevice(["sessions:read", "sessions:operate"], "phone");
	const mine = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort });
	const theirs = await api("POST", `/api/sessions/${id}/forwards`, phone.token, { port: pagePort });
	assert.equal(theirs.status, 201, "another device gets its own forward");
	assert.notEqual(theirs.body.listenPort, mine.body.listenPort);
	const a = await openLink(mine.body.url);
	const theirOrigin = `http://127.0.0.1:${theirs.body.listenPort}`;
	assert.equal((await http(`${theirOrigin}/`, { headers: { Cookie: a.cookie } })).status, 401, "a cookie names its forward");
	const renamed = a.cookie.replace(mine.body.id, theirs.body.id);
	assert.equal((await http(`${theirOrigin}/`, { headers: { Cookie: renamed } })).status, 401, "nor does its secret open another");
	const ticket = new URL(theirs.body.url).searchParams.get("gs_ticket");
	assert.equal((await http(`${a.origin}/?gs_ticket=${ticket}`)).status, 401, "a ticket opens only its forward");
	await api("DELETE", `/api/sessions/${id}`, ADMIN);
});

test("Host and Origin are checked like the main server's", async () => {
	const id = await startSession();
	const created = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort });
	const { cookie, origin } = await openLink(created.body.url);
	const port = created.body.listenPort;
	const rebound = await http(`${origin}/`, { headers: { Cookie: cookie, Host: `evil.example:${port}` } });
	assert.equal(rebound.status, 421);
	assert.equal((await http(`${origin}/`, { headers: { Cookie: cookie, Host: `127.0.0.1:${port + 1}` } })).status, 421);
	assert.equal((await http(`${origin}/`, { headers: { Cookie: cookie, Host: `localhost:${port}` } })).status, 200, "loopback names on a loopback bind");
	assert.equal((await http(`${origin}/`, { headers: { Cookie: cookie, Origin: "http://127.0.0.1:1" } })).status, 403, "another port is another page");
	assert.equal((await http(`${origin}/`, { headers: { Cookie: cookie, Origin: "null" } })).status, 403);
	const own = await http(`${origin}/post`, { method: "POST", headers: { Cookie: cookie, Origin: origin, Referer: `${origin}/from`, "Content-Type": "text/plain" }, body: "hello" });
	assert.equal(own.status, 200);
	assert.equal(seen.method, "POST");
	assert.equal(seen.body, "hello", "the body streams through");
	assert.equal(seen.headers?.origin, `http://127.0.0.1:${pagePort}`, "its own origin reads as the page's");
	assert.equal(seen.headers?.referer, `http://127.0.0.1:${pagePort}/from`);
	await api("DELETE", `/api/sessions/${id}`, ADMIN);
});

test("HTTP proxy: loopback redirects point back at the forward, forward cookies cannot be set, SSE streams unbuffered, a dead page is 502", async () => {
	const id = await startSession();
	const created = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort });
	const { cookie, origin } = await openLink(created.body.url);
	const redirected = await http(`${origin}/redirect`, { headers: { Cookie: cookie } });
	assert.equal(redirected.status, 302);
	assert.equal(redirected.headers.location, `${origin}/landed?x=1`);
	const cookies = await http(`${origin}/cookies`, { headers: { Cookie: cookie } });
	assert.deepEqual(cookies.headers["set-cookie"], ["app=1; Path=/"]);

	// The first event arrives while the page still holds the stream open.
	const first = Promise.withResolvers<string>();
	const done = Promise.withResolvers<string>();
	const req = httpRequest(`${origin}/sse`, { headers: { Cookie: cookie }, agent: false }, (res) => {
		assert.equal(res.headers["content-type"], "text/event-stream");
		let text = "";
		res.on("data", (c: Buffer) => { text += c.toString("utf8"); if (text.includes("first")) first.resolve(text); });
		res.on("end", () => done.resolve(text));
	});
	req.end();
	assert.equal(await first.promise, "data: first\n\n");
	releaseStream();
	assert.equal(await done.promise, "data: first\n\ndata: last\n\n");

	const dead = createServer();
	const deadPort = await listen(dead);
	await new Promise<void>((r) => dead.close(() => r()));
	const gone = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: deadPort });
	const link = await http(gone.body.url);
	const failed = await http(`http://127.0.0.1:${gone.body.listenPort}/`, { headers: { Cookie: link.headers["set-cookie"]![0].split(";")[0] } });
	assert.equal(failed.status, 502);
	await api("DELETE", `/api/sessions/${id}`, ADMIN);
});

test("WebSocket upgrades are piped both ways and need the cookie", async () => {
	const id = await startSession();
	const created = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort });
	const { cookie, origin } = await openLink(created.body.url);
	const port = created.body.listenPort;
	const upgrade = (headers: string) => {
		const { promise, resolve } = Promise.withResolvers<{ socket: Socket; head: string }>();
		const socket = connect({ host: "127.0.0.1", port });
		let text = "";
		const onData = (c: Buffer) => {
			text += c.toString("latin1");
			const end = text.indexOf("\r\n\r\n");
			if (end !== -1) { socket.off("data", onData); resolve({ socket, head: text.slice(0, end) }); }
		};
		socket.on("data", onData);
		socket.write(`GET /ws?x=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`);
		return promise;
	};
	const refused = await upgrade("");
	assert.match(refused.head, /^HTTP\/1\.1 401 /);
	refused.socket.destroy();
	const foreign = await upgrade(`Cookie: ${cookie}\r\nOrigin: http://evil.example\r\n`);
	assert.match(foreign.head, /^HTTP\/1\.1 403 /);
	foreign.socket.destroy();

	const { socket, head } = await upgrade(`Cookie: ${cookie}\r\nOrigin: ${origin}\r\n`);
	assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/);
	assert.match(head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
	assert.equal(seen.url, "/ws?x=1");
	assert.equal(seen.headers?.cookie, undefined);
	assert.equal(seen.headers?.origin, `http://127.0.0.1:${pagePort}`);
	assert.equal(seen.headers?.host, `127.0.0.1:${pagePort}`);
	const echoed = Promise.withResolvers<string>();
	let got = "";
	socket.on("data", (c: Buffer) => { got += c.toString("latin1"); if (got.length >= 6) echoed.resolve(got); });
	socket.write(Buffer.from("\x81\x04ping", "latin1"));
	assert.equal(await echoed.promise, "\x81\x04ping");

	// Ending the session closes the forward, open WebSockets included.
	const closed = Promise.withResolvers<void>();
	socket.on("close", () => closed.resolve());
	await api("DELETE", `/api/sessions/${id}`, ADMIN);
	await closed.promise;
	assert.ok(await closedPort(port), "the listener is gone");
	assert.deepEqual((await api("GET", "/api/sessions", ADMIN)).status, 200);
});

test("forwards close when their device is revoked or they are deleted", async () => {
	const id = await startSession();
	const laptop = await pairDevice(["sessions:read", "sessions:operate"], "laptop");
	const created = await api("POST", `/api/sessions/${id}/forwards`, laptop.token, { port: pagePort });
	assert.equal(created.status, 201);
	const { cookie, origin } = await openLink(created.body.url);
	assert.equal((await http(`${origin}/`, { headers: { Cookie: cookie } })).status, 200);
	assert.equal((await api("DELETE", `/api/devices/${laptop.id}`, ADMIN)).status, 200);
	assert.ok(await closedPort(created.body.listenPort), "revoked: closed at once");
	assert.deepEqual((await api("GET", `/api/sessions/${id}/forwards`, ADMIN)).body.forwards.filter((f: { id: string }) => f.id === created.body.id), []);

	const mine = await api("POST", `/api/sessions/${id}/forwards`, ADMIN, { port: pagePort });
	assert.equal((await api("DELETE", `/api/sessions/${id}/forwards/fwd_0000000000000000`, ADMIN)).status, 404);
	const deleted = await api("DELETE", `/api/sessions/${id}/forwards/${mine.body.id}`, ADMIN);
	assert.deepEqual(deleted.body, { closed: mine.body.id });
	assert.ok(await closedPort(mine.body.listenPort));
	await api("DELETE", `/api/sessions/${id}`, ADMIN);
});

test("Gentle Tower: started once on request, forwarded with its token path, stopped by DELETE", async () => {
	const reader = await pairDevice(["sessions:read"], "tower-reader");
	assert.equal((await api("POST", "/api/tower", reader.token)).status, 403, "Tower acts on sessions: operate scope");
	assert.deepEqual((await api("GET", "/api/tower", reader.token)).body, { running: false });
	const opened = await api("POST", "/api/tower", ADMIN);
	assert.equal(opened.status, 201, JSON.stringify(opened.body));
	assert.equal(opened.body.started, true);
	assert.equal(opened.body.sessionId, null);
	assert.match(opened.body.url, new RegExp(`^http://127\\.0\\.0\\.1:${opened.body.listenPort}/${TOWER_TOKEN}/\\?gs_ticket=`));
	const { cookie, origin, page: landed } = await openLink(opened.body.url);
	assert.equal(landed.text, `tower GET /${TOWER_TOKEN}/`);
	// Tower refuses any Origin but its own; the forward's own reads as Tower's.
	const posted = await http(`${origin}/${TOWER_TOKEN}/api/action`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: "{}" });
	assert.equal(posted.text, `tower POST /${TOWER_TOKEN}/api/action`);

	const again = await api("POST", "/api/tower", ADMIN);
	assert.equal(again.status, 200);
	assert.equal(again.body.started, false);
	assert.equal(again.body.id, opened.body.id);
	assert.equal(towerStarts, 1);
	assert.equal((await api("GET", "/api/tower", reader.token)).body.running, true);

	assert.equal((await api("DELETE", "/api/tower", reader.token)).status, 403);
	assert.deepEqual((await api("DELETE", "/api/tower", ADMIN)).body, { stopped: true });
	assert.equal(towerCloses, 1);
	assert.ok(await closedPort(opened.body.listenPort), "its forwards close with it");
	assert.deepEqual((await api("DELETE", "/api/tower", ADMIN)).body, { stopped: false });
});

test("forward manager: tickets expire, idle forwards close, connections are bounded, the port range is used", async () => {
	let clock = 1_000_000;
	const manager = new ForwardManager({
		bindHost: "127.0.0.1",
		hostCheck: (port) => allowedHosts("127.0.0.1", port),
		now: () => clock,
		limits: { maxConnections: 1, idleMs: 1000, sweepMs: 20 },
	});
	try {
		// The idle sweep runs on a real (short) interval: it is the manager's own timer, not one the test can drive.
		const { forward } = await manager.open({ deviceId: "dev_a", sessionId: "ses_a", kind: "session", port: pagePort });
		const expired = manager.mintTicket(forward.id);
		clock += 60_001;
		const late = await http(manager.urlFor(forward.id, "127.0.0.1", "/", expired.ticket));
		assert.equal(late.status, 401, "a ticket lives 60 s");
		const fresh = manager.mintTicket(forward.id);
		const link = await http(manager.urlFor(forward.id, "127.0.0.1", "/", fresh.ticket));
		assert.equal(link.status, 303);

		// One connection held open: the next one is refused at accept.
		const held = connect({ host: "127.0.0.1", port: forward.listenPort });
		await new Promise((r) => held.once("connect", r));
		await new Promise((r) => setTimeout(r, 50));
		const second = await new Promise<string>((resolve) => {
			const s = connect({ host: "127.0.0.1", port: forward.listenPort });
			s.on("error", () => resolve("error"));
			s.on("close", () => resolve("closed"));
			s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${forward.listenPort}\r\n\r\n`);
		});
		assert.ok(second === "closed" || second === "error");
		// Open connections keep it; idle and unconnected, it closes.
		clock += 2000;
		await new Promise((r) => setTimeout(r, 80));
		assert.ok(manager.get(forward.id), "an open connection is use");
		held.destroy();
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(manager.get(forward.id), undefined, "idle past the limit");
		assert.ok(await closedPort(forward.listenPort));

		const ranged = new ForwardManager({ bindHost: "127.0.0.1", hostCheck: (port) => allowedHosts("127.0.0.1", port), portRange: { from: forward.listenPort, to: forward.listenPort } });
		const blocker = createServer();
		await new Promise<void>((r) => blocker.listen(forward.listenPort, "127.0.0.1", () => r()));
		await assert.rejects(ranged.open({ deviceId: "dev_a", sessionId: null, kind: "tower", port: pagePort }), /in use/);
		blocker.close();
		const inRange = await ranged.open({ deviceId: "dev_a", sessionId: null, kind: "tower", port: pagePort });
		assert.equal(inRange.forward.listenPort, forward.listenPort);
		ranged.closeAll();
	} finally {
		manager.closeAll();
	}
});
