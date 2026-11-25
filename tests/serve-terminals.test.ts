import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ServeAuth } from "../lib/serve-auth.ts";
import { startServeServer, type ServeServer, type ServeServerOptions } from "../lib/serve-server.ts";
import { HostConnection, termHostAsset, termHostTransport, type TermHostEndpoint } from "../lib/serve-terminals.ts";
import { call, pairDevice, stream } from "./serve-test-client.ts";

const FAKE_HOST = fileURLToPath(new URL("./fixtures/serve-fake-term-host.mjs", import.meta.url));
const ADMIN = "gsa_test-admin-token";
// Unix socket paths are short (104 bytes on macOS): a short root.
const root = realpathSync(mkdtempSync(process.platform === "win32" ? join(process.env.TEMP ?? ".", "gst-") : "/tmp/gst-"));
const serveDir = join(root, "serve");
const project = join(root, "project");
// Echoes its input back, so a test sees a round trip through the terminal.
const ECHO = [process.execPath, "-e", "process.stdout.write('ready\\n'); process.stdin.on('data', (d) => process.stdout.write('echo:' + d))"];
let server: ServeServer;
let auth: ServeAuth;
let phone: { id: string; token: string };

const options = (env: NodeJS.ProcessEnv): ServeServerOptions => ({
	host: "127.0.0.1",
	port: 0,
	auth,
	version: "test",
	serveDir,
	env,
	launchSession: () => { throw new Error("no sessions here"); },
});

async function shutdownHost(endpoint: TermHostEndpoint): Promise<void> {
	const conn = await HostConnection.open(endpoint, 1000).catch(() => undefined);
	if (!conn) return;
	await conn.request("shutdown", {}, 2000).catch(() => undefined);
	conn.close();
}

before(async () => {
	mkdirSync(project);
	auth = new ServeAuth({ devicesFile: join(serveDir, "devices.json"), adminToken: ADMIN });
	server = await startServeServer(options({ PATH: process.env.PATH, GENTLE_TERM_HOST: FAKE_HOST }));
	phone = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate", "terminal"], "phone");
});
after(async () => {
	await server?.close();
	await shutdownHost({ path: join(serveDir, "term.sock") });
	rmSync(root, { recursive: true, force: true });
});

const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

/** The `data` of every SSE event of one type, parsed. */
function events(text: string, type: string): any[] {
	return text.split("\n\n").filter((block) => block.split("\n").includes(`event: ${type}`))
		.map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
}

async function openTerm(token = phone.token): Promise<string> {
	const opened = await call(server.url, "POST", "/api/terminals", { token, body: { cwd: project, cols: 80, rows: 24, argv: ECHO } });
	assert.equal(opened.status, 201, JSON.stringify(opened.body));
	return opened.body.terminal.id;
}

test("the terminal scope is in the default pairing scopes and gates the endpoints", async () => {
	const code = await call(server.url, "POST", "/api/pairing-codes", { token: ADMIN, body: {} });
	assert.deepEqual(code.body.scopes, ["sessions:read", "sessions:operate", "terminal"]);
	const noTerminal = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"], "no-terminal");
	assert.equal((await call(server.url, "GET", "/api/terminals", { token: noTerminal.token })).status, 403);
	assert.equal((await call(server.url, "POST", "/api/terminals", { token: noTerminal.token, body: { cwd: project, cols: 80, rows: 24 } })).status, 403);
	assert.equal((await call(server.url, "GET", "/api/terminals")).status, 401);
	const info = await call(server.url, "GET", "/api/server", { token: phone.token });
	assert.ok(info.body.capabilities.includes("terminals"));
});

test("open starts the host on first use, detached, with its socket and state folder under serve/", async () => {
	const id = await openTerm();
	assert.match(id, /^t_[0-9a-f]+$/);
	const recorded = JSON.parse(readFileSync(join(serveDir, "term", "argv.json"), "utf8"));
	assert.deepEqual(recorded, ["--socket", join(serveDir, "term.sock"), "--state-dir", join(serveDir, "term")]);
	assert.equal(statSync(join(serveDir, "term")).mode & 0o777, 0o700);
	const listed = await call(server.url, "GET", "/api/terminals", { token: phone.token });
	const entry = listed.body.terminals.find((t: { id: string }) => t.id === id);
	assert.equal(entry.owner, phone.id);
	assert.equal(entry.cwd, project);
	assert.deepEqual(entry.argv, ECHO);
	assert.equal(entry.alive, true);
	assert.equal(entry.cols, 80);
	const host = await call(server.url, "GET", "/api/term-host", { token: phone.token });
	assert.equal(host.body.running, true);
	assert.equal(host.body.version, "fake");
	assert.equal(host.body.transport, "unix");
	assert.equal(host.body.asset, termHostAsset());
	assert.equal(host.body.path, undefined, "the binary's path only for an admin");
	assert.equal((await call(server.url, "GET", "/api/term-host", { token: ADMIN })).body.path, FAKE_HOST);
});

test("stream: attached first, then output; input round-trips; resize is announced; resume and snapshot", async () => {
	const id = await openTerm();
	const live = await stream(server.url, `/api/terminals/${id}/stream`, phone.token);
	assert.equal(live.status, 200);
	await live.waitFor("event: attached");
	assert.ok(live.text.indexOf("event: attached") < Math.max(0, live.text.indexOf("event: output")) || !live.text.includes("event: output"));
	await live.waitFor(/event: output|"snapshot"/);
	const input = await call(server.url, "POST", `/api/terminals/${id}/input`, { token: phone.token, body: { data: Buffer.from("hi\n").toString("base64") } });
	assert.equal(input.status, 200, JSON.stringify(input.body));
	await live.waitFor(/event: output\ndata: [^\n]*"data":"ZWNobzpoaQo="/);
	const outputs = events(live.text, "output");
	const last = outputs.at(-1);
	assert.equal(decode(last.data), "echo:hi\n");
	assert.equal(last.offset, "ready\necho:hi\n".length);
	assert.match(live.text, new RegExp(`id: ${last.offset}\nevent: output`));

	assert.equal((await call(server.url, "POST", `/api/terminals/${id}/resize`, { token: phone.token, body: { cols: 100, rows: 30 } })).status, 200);
	await live.waitFor("event: resized");
	assert.deepEqual(events(live.text, "resized")[0], { cols: 100, rows: 30 });
	live.close();

	// From an offset inside the ring: no snapshot, the missed bytes as output.
	const resumed = await stream(server.url, `/api/terminals/${id}/stream?from=6`, phone.token);
	await resumed.waitFor("event: output");
	assert.deepEqual(events(resumed.text, "attached")[0], { offset: 6 });
	assert.equal(decode(events(resumed.text, "output")[0].data), "echo:hi\n");
	resumed.close();
	// Last-Event-ID works as `from`, as EventSource sends it.
	const viaHeader = await stream(server.url, `/api/terminals/${id}/stream`, phone.token, { "Last-Event-ID": "6" });
	await viaHeader.waitFor("event: attached");
	assert.deepEqual(events(viaHeader.text, "attached")[0], { offset: 6 });
	viaHeader.close();
	// Without `from`: a snapshot and the current end.
	const fresh = await stream(server.url, `/api/terminals/${id}/stream`, phone.token);
	await fresh.waitFor("event: attached");
	const attached = events(fresh.text, "attached")[0];
	assert.equal(attached.offset, 14);
	assert.equal(decode(attached.snapshot), "ready\necho:hi\n");
	fresh.close();

	assert.equal((await call(server.url, "GET", `/api/terminals/${id}/stream?from=x`, { token: phone.token })).body.error.code, "invalid_from");
	assert.equal((await call(server.url, "POST", `/api/terminals/${id}/input`, { token: phone.token, body: { data: "!!" } })).body.error.code, "invalid_data");
	assert.equal((await call(server.url, "POST", `/api/terminals/${id}/resize`, { token: phone.token, body: { cols: 0, rows: 30 } })).body.error.code, "invalid_cols");
	assert.equal((await call(server.url, "POST", "/api/terminals", { token: phone.token, body: { cwd: "relative", cols: 80, rows: 24 } })).body.error.code, "invalid_cwd");
	assert.equal((await call(server.url, "POST", "/api/terminals", { token: phone.token, body: { cwd: project, cols: 80, rows: 501 } })).body.error.code, "invalid_rows");
});

test("the stream ends with exit when the program ends; DELETE closes and forgets", async () => {
	const opened = await call(server.url, "POST", "/api/terminals", { token: phone.token, body: { cwd: project, cols: 80, rows: 24, argv: [process.execPath, "-e", "setTimeout(() => process.exit(3), 300)"] } });
	const id = opened.body.terminal.id;
	const live = await stream(server.url, `/api/terminals/${id}/stream`, phone.token);
	await live.closed;
	assert.deepEqual(events(live.text, "exit")[0], { code: 3 });
	const exited = (await call(server.url, "GET", "/api/terminals", { token: phone.token })).body.terminals.find((t: { id: string }) => t.id === id);
	assert.equal(exited.alive, false);
	assert.equal(exited.exitCode, 3);
	assert.equal((await call(server.url, "POST", `/api/terminals/${id}/input`, { token: phone.token, body: { data: "eA==" } })).status, 409);
	assert.equal((await call(server.url, "DELETE", `/api/terminals/${id}`, { token: phone.token })).body.closed, id);

	const running = await openTerm();
	assert.equal((await call(server.url, "DELETE", `/api/terminals/${running}`, { token: phone.token })).status, 200);
	const ids = (await call(server.url, "GET", "/api/terminals", { token: phone.token })).body.terminals.map((t: { id: string }) => t.id);
	assert.equal(ids.includes(id) || ids.includes(running), false);
	assert.equal((await call(server.url, "DELETE", `/api/terminals/${running}`, { token: phone.token })).status, 404);
});

test("terminals belong to the device that opened them; an admin sees all; revoking closes them", async () => {
	const laptop = await pairDevice(server.url, ADMIN, ["terminal"], "laptop");
	const id = await openTerm(laptop.token);
	assert.equal((await call(server.url, "POST", `/api/terminals/${id}/input`, { token: phone.token, body: { data: "eA==" } })).status, 404);
	assert.equal((await call(server.url, "GET", `/api/terminals/${id}/stream`, { token: phone.token })).status, 404);
	const phoneSees = (await call(server.url, "GET", "/api/terminals", { token: phone.token })).body.terminals.map((t: { id: string }) => t.id);
	assert.equal(phoneSees.includes(id), false);
	const adminSees = (await call(server.url, "GET", "/api/terminals", { token: ADMIN })).body.terminals.find((t: { id: string }) => t.id === id);
	assert.equal(adminSees.owner, laptop.id);

	const live = await stream(server.url, `/api/terminals/${id}/stream`, laptop.token);
	await live.waitFor("event: attached");
	assert.equal((await call(server.url, "DELETE", `/api/devices/${laptop.id}`, { token: ADMIN })).status, 200);
	await live.closed;
	for (let i = 0; i < 50; i += 1) {
		// Closing runs in the background after the revoke answers: poll for its effect.
		const left = (await call(server.url, "GET", "/api/terminals", { token: ADMIN })).body.terminals.some((t: { id: string }) => t.id === id);
		if (!left) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal((await call(server.url, "GET", "/api/terminals", { token: ADMIN })).body.terminals.some((t: { id: string }) => t.id === id), false);
});

test("a device paired again takes its earlier pairing's place: its terminals, then that device is revoked", async () => {
	const before = await pairDevice(server.url, ADMIN, ["terminal"], "tablet");
	const id = await openTerm(before.token);
	const live = await stream(server.url, `/api/terminals/${id}/stream`, before.token);
	await live.waitFor("event: attached");
	const again = await pairDevice(server.url, ADMIN, ["terminal"], "tablet");
	assert.equal((await call(server.url, "POST", "/api/devices/self/replace", { token: again.token, body: { token: "gss_nobody" } })).status, 404);
	assert.equal((await call(server.url, "POST", "/api/devices/self/replace", { token: again.token, body: { token: again.token } })).status, 400);
	const replaced = await call(server.url, "POST", "/api/devices/self/replace", { token: again.token, body: { token: before.token } });
	assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
	assert.equal(replaced.body.replaced, before.id);
	await live.closed;
	assert.equal((await call(server.url, "GET", "/api/terminals", { token: before.token })).status, 401);
	// Still running, now the new pairing's.
	const mine = (await call(server.url, "GET", "/api/terminals", { token: again.token })).body.terminals.find((t: { id: string }) => t.id === id);
	assert.ok(mine, "the terminal is the new pairing's");
	assert.equal(mine.owner, again.id);
	assert.equal(JSON.parse(readFileSync(join(serveDir, "terminals.json"), "utf8")).owners[id], again.id);
	const reattached = await stream(server.url, `/api/terminals/${id}/stream`, again.token);
	await reattached.waitFor("event: attached");
	reattached.close();
	assert.equal((await call(server.url, "DELETE", `/api/terminals/${id}`, { token: again.token })).status, 200);
});

test("terminals and their owners survive a serve restart; the host keeps running", async () => {
	const id = await openTerm();
	const pid = (await call(server.url, "GET", "/api/term-host", { token: phone.token })).body.pid;
	await server.close();
	server = await startServeServer(options({ PATH: process.env.PATH, GENTLE_TERM_HOST: FAKE_HOST }));
	const after = await call(server.url, "GET", "/api/terminals", { token: phone.token });
	const entry = after.body.terminals.find((t: { id: string }) => t.id === id);
	assert.ok(entry, "still listed for its owner");
	assert.equal(entry.owner, phone.id);
	assert.equal((await call(server.url, "GET", "/api/term-host", { token: phone.token })).body.pid, pid, "the same host");
	const owners = JSON.parse(readFileSync(join(serveDir, "terminals.json"), "utf8"));
	assert.equal(owners.owners[id], phone.id);
	assert.equal(statSync(join(serveDir, "terminals.json")).mode & 0o777, 0o600);
});

test("without a host binary: no terminals capability and 501; PUT /api/term-host installs one", async () => {
	const otherRoot = realpathSync(mkdtempSync(join(dirname(root), "gst-")));
	const otherServe = join(otherRoot, "serve");
	const otherAuth = new ServeAuth({ devicesFile: join(otherServe, "devices.json"), adminToken: ADMIN });
	// Only node on PATH: the fake host's `#!/usr/bin/env node` still runs, and nothing named gentle-term-host is found.
	const bare = await startServeServer({ ...options({ PATH: dirname(process.execPath) }), auth: otherAuth, serveDir: otherServe });
	try {
		const operator = await pairDevice(bare.url, ADMIN, ["sessions:read", "sessions:operate", "terminal"], "op");
		assert.equal((await call(bare.url, "GET", "/api/server", { token: operator.token })).body.capabilities.includes("terminals"), false);
		const missing = await call(bare.url, "POST", "/api/terminals", { token: operator.token, body: { cwd: project, cols: 80, rows: 24 } });
		assert.equal(missing.status, 501);
		assert.equal(missing.body.error.code, "term_host_missing");
		assert.equal((await call(bare.url, "GET", "/api/term-host", { token: operator.token })).body.available, false);

		const bytes = readFileSync(FAKE_HOST);
		const sha = createHash("sha256").update(bytes).digest("hex");
		assert.equal((await call(bare.url, "PUT", "/api/term-host", { token: operator.token, raw: bytes, headers: { "x-sha256": sha } })).status, 403, "admin only");
		assert.equal((await call(bare.url, "PUT", "/api/term-host", { token: ADMIN, raw: bytes })).body.error.code, "invalid_sha256");
		assert.equal((await call(bare.url, "PUT", "/api/term-host", { token: ADMIN, raw: bytes, headers: { "x-sha256": "0".repeat(64) } })).body.error.code, "sha256_mismatch");
		assert.equal(existsSync(join(otherServe, "bin", "gentle-term-host")), false);
		const installed = await call(bare.url, "PUT", "/api/term-host", { token: ADMIN, raw: bytes, headers: { "x-sha256": sha } });
		assert.equal(installed.status, 201, JSON.stringify(installed.body));
		assert.equal(installed.body.path, join(otherServe, "bin", "gentle-term-host"));
		assert.equal(installed.body.active, true);
		assert.equal(statSync(installed.body.path).mode & 0o777, 0o755);

		assert.ok((await call(bare.url, "GET", "/api/server", { token: operator.token })).body.capabilities.includes("terminals"));
		const opened = await call(bare.url, "POST", "/api/terminals", { token: operator.token, body: { cwd: project, cols: 80, rows: 24, argv: ECHO } });
		assert.equal(opened.status, 201, JSON.stringify(opened.body));
	} finally {
		await bare.close();
		await shutdownHost({ path: join(otherServe, "term.sock") });
		rmSync(otherRoot, { recursive: true, force: true });
	}
});

test("the transport and the release asset follow the server's system", () => {
	assert.equal(termHostTransport({}, "linux"), "unix");
	assert.equal(termHostTransport({ GENTLE_TERM_HOST_TRANSPORT: "tcp" }, "darwin"), "tcp");
	assert.equal(termHostTransport({}, "win32"), "tcp");
	assert.equal(termHostAsset("linux", "x64"), "gentle-term-host-linux-x64");
	assert.equal(termHostAsset("linux", "arm64"), "gentle-term-host-linux-arm64");
	assert.equal(termHostAsset("darwin", "arm64"), "gentle-term-host-macos-arm64");
	assert.equal(termHostAsset("darwin", "x64"), "gentle-term-host-macos-x64");
	assert.equal(termHostAsset("win32", "x64"), "gentle-term-host-windows-x64.exe");
	assert.equal(termHostAsset("win32", "arm64"), null);
	assert.equal(termHostAsset("freebsd", "x64"), null);
});

test("over TCP (Windows' transport): a port file with a token, the host reused across restarts and replaced once it died", async () => {
	const tcpRoot = realpathSync(mkdtempSync(join(dirname(root), "gst-")));
	const tcpServe = join(tcpRoot, "serve");
	const tcpAuth = new ServeAuth({ devicesFile: join(tcpServe, "devices.json"), adminToken: ADMIN });
	const start = () => startServeServer({ ...options({ PATH: process.env.PATH, GENTLE_TERM_HOST: FAKE_HOST, GENTLE_TERM_HOST_TRANSPORT: "tcp" }), auth: tcpAuth, serveDir: tcpServe });
	const portFile = join(tcpServe, "term", "term-host.json");
	const written = () => JSON.parse(readFileSync(portFile, "utf8")) as { port: number; token: string; pid: number };
	let tcpServer = await start();
	try {
		const device = await pairDevice(tcpServer.url, ADMIN, ["terminal"], "tcp");
		const opened = await call(tcpServer.url, "POST", "/api/terminals", { token: device.token, body: { cwd: project, cols: 80, rows: 24, argv: ECHO } });
		assert.equal(opened.status, 201, JSON.stringify(opened.body));
		const id = opened.body.terminal.id;
		assert.deepEqual(JSON.parse(readFileSync(join(tcpServe, "term", "argv.json"), "utf8")), ["--tcp", "--state-dir", join(tcpServe, "term")]);
		assert.equal(existsSync(join(tcpServe, "term.sock")), false);
		const first = written();
		assert.equal(statSync(portFile).mode & 0o777, 0o600);
		const refused = await HostConnection.open({ port: first.port, token: "not-the-token" }, 2000).then(() => undefined, (error: unknown) => error);
		assert.equal((refused as { code?: string } | undefined)?.code, "unauthorized");

		const live = await stream(tcpServer.url, `/api/terminals/${id}/stream`, device.token);
		await live.waitFor("event: attached");
		assert.equal((await call(tcpServer.url, "POST", `/api/terminals/${id}/input`, { token: device.token, body: { data: Buffer.from("hi\n").toString("base64") } })).status, 200);
		await live.waitFor(/"data":"ZWNobzpoaQo="/);
		live.close();
		const status = (await call(tcpServer.url, "GET", "/api/term-host", { token: device.token })).body;
		assert.equal(status.transport, "tcp");
		assert.equal(status.running, true);
		assert.equal(status.pid, first.pid);

		// A restarted serve finds the same host through the port file.
		await tcpServer.close();
		tcpServer = await start();
		assert.equal((await call(tcpServer.url, "GET", "/api/term-host", { token: device.token })).body.pid, first.pid);

		// A host that died leaves its port file: nothing answers there, so serve starts another.
		process.kill(first.pid, "SIGKILL");
		// Another process's exit has no event to await here: poll until it's gone.
		for (let i = 0; i < 100; i += 1) {
			try { process.kill(first.pid, 0); } catch { break; }
			await sleep(20);
		}
		assert.equal((await call(tcpServer.url, "GET", "/api/terminals", { token: device.token })).status, 200);
		const second = written();
		assert.notEqual(second.pid, first.pid);
		assert.notEqual(second.token, first.token);
		assert.equal((await call(tcpServer.url, "GET", "/api/term-host", { token: device.token })).body.pid, second.pid);
	} finally {
		await tcpServer.close();
		const left = existsSync(portFile) ? written() : undefined;
		if (left) await shutdownHost({ port: left.port, token: left.token });
		rmSync(tcpRoot, { recursive: true, force: true });
	}
});
