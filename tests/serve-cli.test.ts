import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { helpText, parseLauncherArgs } from "../lib/gentle-shell-launcher.ts";
import { acquireServeLock, parseListen, parseServeArgs, readServerFile, serveFiles, sessionLaunch } from "../lib/serve-cli.ts";
import { isLoopbackHost } from "../lib/serve-server.ts";

const binPath = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function scratch(): string {
	const r = mkdtempSync(join(tmpdir(), "gentle-serve-cli-"));
	roots.push(r);
	return r;
}

test("serve is a launcher command that takes the home selectors ahead of it", () => {
	const plain = parseLauncherArgs(["serve", "--foreground"]);
	assert.equal(plain.command, "serve");
	assert.deepEqual(plain.commandArgs, ["--foreground"]);
	const home = parseLauncherArgs(["--home", "/tmp/h", "serve", "pair", "--scope", "admin"]);
	assert.equal(home.command, "serve");
	assert.equal(home.home, "/tmp/h");
	assert.deepEqual(home.commandArgs, ["pair", "--scope", "admin"]);
	assert.equal(parseLauncherArgs(["--", "serve"]).command, undefined);
	assert.deepEqual(parseLauncherArgs(["install", "serve"]).passthrough, ["install", "serve"]);
	assert.match(helpText(), /\n  serve +Run a per-user server/);
	assert.match(helpText(), /gentle-shell \[home selectors\] serve \[--listen <host>:<port>\]/);
});

test("parseServeArgs reads each subcommand and rejects what it does not know", () => {
	assert.deepEqual(parseServeArgs([]), { action: "start", host: "127.0.0.1", port: 0, foreground: false, json: false });
	assert.deepEqual(parseServeArgs(["--foreground", "--listen", "0.0.0.0:8787"]), { action: "start", host: "0.0.0.0", port: 8787, foreground: true, json: false });
	assert.deepEqual(parseServeArgs(["--listen=localhost:9000", "--json"]), { action: "start", host: "127.0.0.1", port: 9000, foreground: false, json: true });
	assert.deepEqual(parseServeArgs(["status", "--json"]), { action: "status", json: true });
	assert.deepEqual(parseServeArgs(["stop"]), { action: "stop" });
	assert.deepEqual(parseServeArgs(["pair"]), { action: "pair", scopes: ["sessions:read", "sessions:operate"], json: false });
	assert.deepEqual(parseServeArgs(["pair", "--scope", "sessions:read", "--scope=admin"]), { action: "pair", scopes: ["sessions:read", "admin"], json: false });
	assert.deepEqual(parseServeArgs(["devices", "--revoke", "dev_123"]), { action: "devices", revoke: "dev_123", json: false });
	assert.deepEqual(parseServeArgs(["--help"]), { action: "help" });
	assert.deepEqual(parseServeArgs(["stop", "--json"]), { error: 'unknown serve stop argument "--json"' });
	assert.deepEqual(parseServeArgs(["status", "--listen", "1:2"]), { error: 'unknown serve status argument "--listen"' });
	assert.deepEqual(parseServeArgs(["pair", "--scope", "root"]), { error: 'unknown scope "root" (expected sessions:read, sessions:operate, admin)' });
	assert.deepEqual(parseServeArgs(["devices", "--revoke", "../x"]), { error: "--revoke needs a device id" });
	assert.deepEqual(parseServeArgs(["--listen"]), { error: "--listen needs <host>:<port>" });
});

test("parseListen accepts host:port, [v6]:port, :port and a bare port", () => {
	assert.deepEqual(parseListen("127.0.0.1:0"), { host: "127.0.0.1", port: 0 });
	assert.deepEqual(parseListen("[::1]:8787"), { host: "::1", port: 8787 });
	assert.deepEqual(parseListen(":8787"), { host: "127.0.0.1", port: 8787 });
	assert.deepEqual(parseListen("8787"), { host: "127.0.0.1", port: 8787 });
	assert.deepEqual(parseListen("box.local:80"), { host: "box.local", port: 80 });
	assert.deepEqual(parseListen("1.2.3.4:70000"), { error: '--listen port must be 0-65535 (got "70000")' });
	assert.deepEqual(parseListen("nope"), { error: '--listen needs <host>:<port> (got "nope")' });
	assert.ok(isLoopbackHost("127.0.0.1") && isLoopbackHost("::1") && isLoopbackHost("[::1]") && isLoopbackHost("localhost"));
	assert.ok(!isLoopbackHost("0.0.0.0") && !isLoopbackHost("192.168.1.2"));
});

test("the lock admits one server per home and takes over a stale one", () => {
	const lock = join(scratch(), "server.lock");
	assert.deepEqual(acquireServeLock(lock), { acquired: true });
	// Another live process (this test's parent) asking for the same lock is refused.
	assert.deepEqual(acquireServeLock(lock, process.ppid), { heldBy: process.pid });
	writeFileSync(lock, "999999999\n");
	assert.deepEqual(acquireServeLock(lock), { acquired: true }, "a dead pid's lock is stale");
});

test("a session child is this launcher with the same home, in Pi RPC mode with the Desktop marker", () => {
	const launch = sessionLaunch({ homeFlags: ["--home", "/h"], launcher: "/pkg/bin/gentle-shell.mjs", nodePath: "/node", env: { PATH: "/bin" } }, { cwd: "/w", sessionId: "abc" });
	assert.deepEqual(launch.args, ["/pkg/bin/gentle-shell.mjs", "--home", "/h", "--mode", "rpc", "--session", "abc"]);
	assert.equal(launch.command, "/node");
	assert.equal(launch.cwd, "/w");
	assert.equal(launch.env.GENTLE_SHELL_INTERACTIVE_HOST, "1");
	assert.equal(launch.env.GENTLE_DESIGN_OPEN_BROWSER, "0");
	assert.equal(launch.env.PATH, "/bin");
});

function isolatedEnv(root: string): NodeJS.ProcessEnv {
	return { HOME: root, USERPROFILE: root, PATH: process.env.PATH, GENTLE_SHELL_NO_AUTO_SETUP: "1" };
}

function cli(root: string, args: string[]) {
	return spawnSync(process.execPath, [binPath, "--home", join(root, "agent"), "serve", ...args], { env: isolatedEnv(root), encoding: "utf8", timeout: 30_000 });
}

// `serve stop` waits for the server pid to go away. When that server is this
// test's own child it stays a zombie until this event loop reaps it, so the
// stop must not block the loop the way spawnSync does.
function cliAsync(root: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [binPath, "--home", join(root, "agent"), "serve", ...args], { env: isolatedEnv(root), stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", (d) => { stdout += d; });
	child.stderr.on("data", (d) => { stderr += d; });
	const done = Promise.withResolvers<{ status: number | null; stdout: string; stderr: string }>();
	child.once("close", (status) => done.resolve({ status, stdout, stderr }));
	return done.promise;
}

test("gentle-shell serve end to end: foreground, single instance, status, pair, devices, stop", { timeout: 60_000 }, async (t) => {
	const root = scratch();
	const home = join(root, "agent");
	const child = spawn(process.execPath, [binPath, "--home", home, "serve", "--foreground"], { env: isolatedEnv(root), stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	let stdout = "", stderr = "";
	child.stderr.on("data", (d) => { stderr += d; });
	const ready = Promise.withResolvers<string>();
	child.stdout.on("data", (d) => {
		stdout += d;
		const m = /Gentle Shell server: (http:\/\/127\.0\.0\.1:\d+) \(pid/.exec(stdout);
		if (m) ready.resolve(m[1]);
	});
	child.once("exit", () => ready.reject(new Error(`exited early: ${stderr}`)));
	const url = await ready.promise;

	const files = serveFiles(home);
	const server = readServerFile(files.server)!;
	assert.equal(server.url, url);
	assert.equal(server.pid, child.pid);
	assert.equal(server.protocol, 1);
	assert.match(server.adminToken, /^gsa_/);
	if (process.platform !== "win32") {
		assert.equal(statSync(files.server).mode & 0o777, 0o600);
		assert.equal(statSync(files.dir).mode & 0o777, 0o700);
	}
	assert.ok(existsSync(join(home, ".gentle-shell-home")), "a new home is bootstrapped like a first launch");

	const second = cli(root, ["--foreground"]);
	assert.equal(second.status, 1);
	assert.match(second.stderr, /already running \(pid \d+\) at http/);

	const status = cli(root, ["status", "--json"]);
	assert.equal(status.status, 0, status.stderr);
	assert.deepEqual({ ...JSON.parse(status.stdout), startedAt: undefined, version: undefined, serverId: undefined },
		{ running: true, url, pid: child.pid, protocol: 1, sessions: [], startedAt: undefined, version: undefined, serverId: undefined });

	const pair = cli(root, ["pair", "--json", "--scope", "sessions:read"]);
	assert.equal(pair.status, 0, pair.stderr);
	const minted = JSON.parse(pair.stdout);
	assert.deepEqual(minted.scopes, ["sessions:read"]);
	const human = cli(root, ["pair"]);
	assert.match(human.stdout, /^Pairing code: [0-9A-Z]{4}-[0-9A-Z]{4}\nServer: +http/);

	const redeemed = await fetch(`${url}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: minted.code, name: "test phone" }) });
	assert.equal(redeemed.status, 201);
	const device = await redeemed.json();
	const list = await fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${device.token}` } });
	assert.equal(list.status, 200);

	const devices = cli(root, ["devices", "--json"]);
	assert.deepEqual(JSON.parse(devices.stdout).devices.map((d: { id: string }) => d.id), [device.id]);
	const revoke = cli(root, ["devices", "--revoke", device.id]);
	assert.equal(revoke.status, 0, revoke.stderr);
	assert.equal((await fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${device.token}` } })).status, 401);

	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const stop = await cliAsync(root, ["stop"]);
	assert.equal(stop.status, 0, stop.stderr);
	assert.equal(stop.stdout, "Stopped.\n");
	assert.equal(await exited, 0);
	assert.ok(!existsSync(files.server) && !existsSync(files.lock), "the server file and lock are removed");
	const gone = cli(root, ["status"]);
	assert.equal(gone.status, 1);
	assert.equal(gone.stderr, "gentle-shell serve: not running\n");
	assert.equal(cli(root, ["stop"]).status, 0, "stopping a stopped server is not an error");

	// Without a server the devices file is still listable.
	const offline = cli(root, ["devices"]);
	assert.equal(offline.stdout, "No paired devices.\n");
	assert.ok(!readFileSync(files.devices, "utf8").includes(device.token));
});

test("gentle-shell serve starts a background daemon that serve stop ends", { timeout: 60_000 }, async () => {
	const root = scratch();
	const started = cli(root, ["--json"]);
	assert.equal(started.status, 0, started.stderr);
	const info = JSON.parse(started.stdout);
	assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);
	try {
		const again = cli(root, []);
		assert.equal(again.status, 1);
		assert.match(again.stderr, /already running/);
		assert.equal(cli(root, ["status"]).status, 0);
	} finally {
		const stop = cli(root, ["stop"]);
		assert.equal(stop.status, 0, stop.stderr);
	}
	assert.equal(cli(root, ["status"]).status, 1);
	assert.match(readFileSync(serveFiles(join(root, "agent")).log, "utf8"), /stopping/);
});

test("gentle-shell serve with a bad argument exits 2", () => {
	const result = cli(scratch(), ["--port", "1"]);
	assert.equal(result.status, 2);
	assert.equal(result.stderr, `gentle-shell serve: unknown serve argument "--port"\nRun 'gentle-shell serve --help' for usage.\n`);
});
