import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { parseServeArgs, readServerFile, runServeCommand, SERVE_RESTART_EXIT, serveFiles, setupLaunch, supervisedServe, upgradeLaunch } from "../lib/serve-cli.ts";
import { desktopMethodScope, startServeServer, type ServeServer, type ServeServerOptions } from "../lib/serve-server.ts";
import { keeperAlive, type KeeperRecord } from "../lib/serve-session-keeper.ts";
import { upgradeLines } from "../lib/serve-upgrade.ts";
import { call, endServeLeftovers, pairDevice, serveLeftovers, stream } from "./serve-test-client.ts";

// `POST /api/upgrade`: the server runs the upgrade command (a fake one here:
// no npm, no network), streams its output to admin clients, and on success
// restarts on the new version while its sessions keep running.

const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const ADMIN = "gsa_test-admin-token";
const roots: string[] = [];
// Sessions of in-process servers keep their records in `<root>/serve`, the CLI's in `<root>/agent/serve`.
const sessionDirs = () => roots.flatMap((root) => [join(root, "serve", "sessions"), join(serveFiles(join(root, "agent")).dir, "sessions")]);
after(async () => {
	// A failed test must not leave a keeper, its fake Pi, or a restarted server behind.
	await endServeLeftovers(sessionDirs(), roots);
	roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function scratch(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gs-upg-")));
	roots.push(root);
	return root;
}

/** A stand-in for `gentle-shell upgrade`: colored progress, then success, or a failure on stderr, or a wait. */
function fakeUpgrade(root: string): string {
	const script = join(root, "fake-upgrade.mjs");
	writeFileSync(script, [
		"const args = process.argv.slice(2);",
		"process.stdout.write('\\u001b[1mChecking the release channel\\u001b[0m\\n');",
		"process.stdout.write('args ' + JSON.stringify(args) + '\\n');",
		"if (args.includes('fail')) { process.stderr.write('npm ERR! network\\ngentle-shell upgrade: could not reach the registry\\n'); process.exit(1); }",
		"if (args.includes('wait')) { process.stdin.resume(); setTimeout(() => { process.stdout.write('Upgraded Gentle Shell to 9.9.9\\n'); }, 300); }",
		"else process.stdout.write('Upgraded Gentle Shell to 9.9.9\\n');",
	].join("\n"));
	return script;
}

function serve(root: string, upgrade: ServeServerOptions["upgrade"], version = "1.0.0"): Promise<ServeServer> {
	const serveDir = join(root, "serve");
	return startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth: new ServeAuth({ devicesFile: join(serveDir, "devices.json"), adminToken: ADMIN }),
		version,
		serveDir,
		launchSession: (input) => ({ command: process.execPath, args: [FAKE_PI], cwd: input.cwd, env: { ...process.env, GENTLE_SHELL_INTERACTIVE_HOST: "1" } }),
		limits: { rpcTimeoutMs: 3000 },
		...(upgrade === undefined ? {} : { upgrade }),
	});
}

function events(text: string): Array<{ event: string; data: Record<string, unknown> }> {
	return text.split("\n\n").flatMap((block) => {
		const event = /^event: (.+)$/m.exec(block);
		const data = /^data: (.*)$/m.exec(block);
		return event && data ? [{ event: event[1]!, data: JSON.parse(data[1]!) }] : [];
	});
}

test("an admin upgrades the server: lines, finished, then a restart that keeps the sessions running", { timeout: 30_000 }, async () => {
	const root = scratch();
	const script = fakeUpgrade(root);
	const restarted = Promise.withResolvers<void>();
	const channels: Array<string | undefined> = [];
	const upgrade: ServeServerOptions["upgrade"] = {
		launch: (channel) => {
			channels.push(channel);
			return { command: process.execPath, args: [script, ...(channel === "main" ? ["wait"] : [])], cwd: root, env: process.env };
		},
		installedVersion: () => "9.9.9",
		onUpgraded: () => restarted.resolve(),
	};
	const first = await serve(root, upgrade);
	let second: ServeServer | undefined;
	try {
		const info = await call(first.url, "GET", "/api/server", { token: ADMIN });
		assert.ok(info.body.capabilities.includes("upgrade"));
		const created = await call(first.url, "POST", "/api/sessions", { token: ADMIN, body: { cwd: realpathSync(root) } });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		const sessionId = created.body.session.id;
		const record = JSON.parse(readFileSync(join(root, "serve", "sessions", `${sessionId}.json`), "utf8")) as KeeperRecord;

		// Only an admin token; a known channel only.
		const device = await pairDevice(first.url, ADMIN, ["sessions:read", "sessions:operate", "terminal"]);
		assert.equal((await call(first.url, "POST", "/api/upgrade", { token: device.token, body: {} })).status, 403);
		const bad = await call(first.url, "POST", "/api/upgrade", { token: ADMIN, body: { channel: "nightly" } });
		assert.deepEqual([bad.status, bad.body.error.code], [400, "invalid_request"]);

		const started = await call(first.url, "POST", "/api/upgrade", { token: ADMIN, body: { channel: "main" } });
		assert.equal(started.status, 202);
		assert.match(started.body.jobId, /^upg_[0-9a-f]{16}$/);
		const busy = await call(first.url, "POST", "/api/upgrade", { token: ADMIN, body: {} });
		assert.deepEqual([busy.status, busy.body.error.code], [409, "upgrade_running"]);
		assert.equal((await call(first.url, "GET", `/api/upgrade/${started.body.jobId}/stream`, { token: device.token })).status, 403);

		const live = await stream(first.url, `/api/upgrade/${started.body.jobId}/stream`, ADMIN);
		assert.equal(live.status, 200);
		await live.closed;
		assert.deepEqual(events(live.text), [
			{ event: "line", data: { line: "Checking the release channel" } },
			{ event: "line", data: { line: 'args ["wait"]' } },
			{ event: "line", data: { line: "Upgraded Gentle Shell to 9.9.9" } },
			{ event: "finished", data: { ok: true, version: "9.9.9" } },
		]);
		assert.deepEqual(channels, ["main"]);
		// A late stream replays the job and its end.
		const late = await stream(first.url, `/api/upgrade/${started.body.jobId}/stream`, ADMIN);
		await late.closed;
		assert.deepEqual(events(late.text).at(-1), { event: "finished", data: { ok: true, version: "9.9.9" } });
		assert.equal((await call(first.url, "GET", "/api/upgrade/upg_0000000000000000/stream", { token: ADMIN })).status, 404);

		// The owner restarts: this server closes, keeping its sessions, and the upgraded one reattaches them.
		await restarted.promise;
		await first.close();
		assert.ok(keeperAlive(record.keeperPid), "the session's keeper outlives the server");
		second = await serve(root, upgrade, "9.9.9");
		const after = await call(second.url, "GET", "/api/server", { token: ADMIN });
		assert.equal(after.body.version, "9.9.9");
		assert.equal(after.body.serverId, info.body.serverId, "the same server identity");
		const listed = await call(second.url, "GET", "/api/sessions", { token: ADMIN });
		assert.equal(listed.body.sessions.find((s: { id: string }) => s.id === sessionId)?.state, "running", "the same session, still running");
		const state = await call(second.url, "POST", `/api/sessions/${sessionId}/rpc`, { token: ADMIN, body: { type: "get_state" } });
		assert.equal(state.status, 200);
	} finally {
		await first.close().catch(() => undefined);
		await second?.close({ endSessions: true });
	}
});

test("a failed upgrade reports the command's last word and does not restart; another may start", { timeout: 30_000 }, async () => {
	const root = scratch();
	const script = fakeUpgrade(root);
	let upgraded = 0;
	const server = await serve(root, {
		launch: () => ({ command: process.execPath, args: [script, "fail"], cwd: root, env: process.env }),
		onUpgraded: () => { upgraded += 1; },
		limits: { restartDelayMs: 0 },
	});
	try {
		const { body: { jobId } } = await call(server.url, "POST", "/api/upgrade", { token: ADMIN });
		const live = await stream(server.url, `/api/upgrade/${jobId}/stream`, ADMIN);
		await live.closed;
		assert.deepEqual(events(live.text).at(-1), { event: "finished", data: { ok: false, error: "gentle-shell upgrade: could not reach the registry" } });
		assert.equal(upgraded, 0);
		assert.equal((await call(server.url, "POST", "/api/upgrade", { token: ADMIN })).status, 202, "a finished upgrade does not block the next");
	} finally {
		await server.close({ endSessions: true });
	}
});

test("a server without an upgrade command has no upgrade capability and answers 501", { timeout: 30_000 }, async () => {
	const root = scratch();
	const server = await serve(root, undefined);
	try {
		assert.equal((await call(server.url, "GET", "/api/server", { token: ADMIN })).body.capabilities.includes("upgrade"), false);
		assert.equal((await call(server.url, "POST", "/api/upgrade", { token: ADMIN })).status, 501);
	} finally {
		await server.close({ endSessions: true });
	}
});

/** A stand-in for `gentle-shell setup`: progress, then success, or a failure on stderr; `wait` holds it open. */
function fakeSetup(root: string): string {
	const script = join(root, "fake-setup.mjs");
	writeFileSync(script, [
		"const args = process.argv.slice(2);",
		"process.stdout.write('\\u001b[1mInstalling companion packages\\u001b[0m\\n');",
		"if (args.includes('fail')) { process.stderr.write('gentle-shell setup: npm install failed\\n'); process.exit(1); }",
		"if (args.includes('wait')) { process.stdin.resume(); setTimeout(() => { process.stdout.write('Setup complete\\n'); process.exit(0); }, 400); }",
		"else process.stdout.write('Setup complete\\n');",
	].join("\n"));
	return script;
}

test("an admin runs setup on the server: lines, finished, no restart; one job at a time with the upgrade", { timeout: 30_000 }, async () => {
	const root = scratch();
	const setup = fakeSetup(root);
	const upgradeScript = fakeUpgrade(root);
	let upgraded = 0;
	let mode = "wait";
	const server = await serve(root, {
		launch: () => ({ command: process.execPath, args: [upgradeScript, "wait"], cwd: root, env: process.env }),
		onUpgraded: () => { upgraded += 1; },
		setup: () => ({ command: process.execPath, args: [setup, mode], cwd: root, env: process.env }),
		limits: { restartDelayMs: 0 },
	});
	try {
		const info = (await call(server.url, "GET", "/api/server", { token: ADMIN })).body;
		assert.ok(info.capabilities.includes("setup"));
		// Config files are reached through Desktop RPC config stores, never by path: only the user's home is named.
		assert.deepEqual(["agentHome" in info, "paths" in info, typeof info.home], [false, false, "string"]);
		const device = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"]);
		assert.equal((await call(server.url, "POST", "/api/setup", { token: device.token, body: {} })).status, 403);
		assert.equal((await call(server.url, "POST", "/api/setup", { token: ADMIN, body: { force: true } })).status, 400);
		const started = await call(server.url, "POST", "/api/setup", { token: ADMIN, body: {} });
		assert.equal(started.status, 202);
		assert.match(started.body.jobId, /^setup_[0-9a-f]{16}$/);
		const busy = await call(server.url, "POST", "/api/upgrade", { token: ADMIN, body: {} });
		assert.deepEqual([busy.status, busy.body.error.code], [409, "setup_running"]);
		assert.deepEqual((await call(server.url, "POST", "/api/setup", { token: ADMIN })).body.error.code, "setup_running");
		assert.equal((await call(server.url, "GET", `/api/setup/${started.body.jobId}/stream`, { token: device.token })).status, 403);
		const live = await stream(server.url, `/api/setup/${started.body.jobId}/stream`, ADMIN);
		await live.closed;
		assert.deepEqual(events(live.text), [
			{ event: "line", data: { line: "Installing companion packages" } },
			{ event: "line", data: { line: "Setup complete" } },
			{ event: "finished", data: { ok: true } },
		]);
		assert.equal((await call(server.url, "GET", "/api/setup/setup_0000000000000000/stream", { token: ADMIN })).status, 404);
		assert.equal(upgraded, 0, "setup never restarts the server");
		mode = "fail";
		const failed = await call(server.url, "POST", "/api/setup", { token: ADMIN });
		assert.equal(failed.status, 202, "a finished setup does not block the next");
		const failure = await stream(server.url, `/api/setup/${failed.body.jobId}/stream`, ADMIN);
		await failure.closed;
		assert.deepEqual(events(failure.text).at(-1), { event: "finished", data: { ok: false, error: "gentle-shell setup: npm install failed" } });
		const upgrading = await call(server.url, "POST", "/api/upgrade", { token: ADMIN });
		assert.equal(upgrading.status, 202);
		assert.deepEqual((await call(server.url, "POST", "/api/setup", { token: ADMIN })).body.error.code, "upgrade_running");
		assert.equal((await call(server.url, "GET", `/api/setup/${upgrading.body.jobId}/stream`, { token: ADMIN })).status, 404, "an upgrade's id is not a setup stream");
	} finally {
		await server.close({ endSessions: true });
	}
});

test("a server without a setup command has no setup capability and answers 501", { timeout: 30_000 }, async () => {
	const root = scratch();
	const server = await serve(root, { launch: () => ({ command: process.execPath, args: ["-e", ""], cwd: root, env: process.env }), onUpgraded: () => {} });
	try {
		assert.equal((await call(server.url, "GET", "/api/server", { token: ADMIN })).body.capabilities.includes("setup"), false);
		assert.equal((await call(server.url, "POST", "/api/setup", { token: ADMIN })).status, 501);
	} finally {
		await server.close({ endSessions: true });
	}
});

test("the CLI's upgrade is this launcher's `upgrade`, and a service manager restarts a supervised server", () => {
	const launch = upgradeLaunch({ launcher: "/pkg/bin/gentle-shell.mjs", nodePath: "/node", env: { PATH: "/bin", GENTLE_SHELL_INTERACTIVE_HOST: "1" } }, "main");
	assert.equal(launch.command, "/node");
	assert.deepEqual(launch.args, ["/pkg/bin/gentle-shell.mjs", "upgrade", "--channel", "main"]);
	assert.equal(launch.env.GENTLE_SHELL_INTERACTIVE_HOST, undefined);
	assert.equal(launch.env.NO_COLOR, "1");
	assert.deepEqual(upgradeLaunch({ launcher: "/l", nodePath: "/n", env: {} }, undefined).args, ["/l", "upgrade"]);
	const setup = setupLaunch({ launcher: "/l", nodePath: "/n", homeFlags: ["--home", "/srv/agent"], env: { GENTLE_SHELL_INTERACTIVE_HOST: "1" } });
	assert.deepEqual(setup.args, ["/l", "--home", "/srv/agent", "setup"], "the server's own home");
	assert.equal(setup.env.GENTLE_SHELL_INTERACTIVE_HOST, undefined);
	assert.equal(supervisedServe({ SYSTEMD_EXEC_PID: "4242" }, 4242), true);
	assert.equal(supervisedServe({ SYSTEMD_EXEC_PID: "1" }, 4242), false, "an inherited variable from another unit's process");
	assert.equal(supervisedServe({ XPC_SERVICE_NAME: "com.gentle-shell.serve" }), true);
	assert.equal(supervisedServe({ XPC_SERVICE_NAME: "com.apple.Terminal" }), false);
	assert.deepEqual(upgradeLines("\u001b[32mok\u001b[0m\r\n\n\u0007x"), ["ok", "x"]);
	// Desktop RPC through `/desktop`: sign-in, keys and package jobs operate; the package list reads.
	for (const method of ["login_start", "login_complete", "login_cancel", "set_api_key", "remove_credentials", "install_package", "remove_package"]) assert.equal(desktopMethodScope(method), "sessions:operate");
	assert.equal(desktopMethodScope("list_packages"), "sessions:read");
});

function isolatedEnv(root: string): NodeJS.ProcessEnv {
	return { HOME: root, USERPROFILE: root, PATH: process.env.PATH, GENTLE_SHELL_NO_AUTO_SETUP: "1" };
}

test("gentle-shell serve restarts itself after an upgrade: the next server takes the same address and identity", { timeout: 60_000 }, async () => {
	const root = scratch();
	const home = join(root, "agent");
	const script = fakeUpgrade(root);
	const files = serveFiles(home);
	const args = parseServeArgs(["--foreground"]);
	assert.ok(!("error" in args));
	let output = "";
	const ctx = {
		agentHome: home,
		homeFlags: ["--home", home],
		launcher: BIN,
		nodePath: process.execPath,
		version: "1.0.0",
		env: isolatedEnv(root),
		stdout: (text: string) => { output += text; },
		stderr: (text: string) => { output += text; },
		untilStopped: (stopRequested: Promise<void>) => stopRequested,
		upgradeCommand: () => ({ command: process.execPath, args: [script], cwd: root, env: process.env }),
	};
	const running = runServeCommand(args, ctx);
	const deadline = Date.now() + 15_000;
	while (readServerFile(files.server)?.pid !== process.pid) {
		if (Date.now() > deadline) throw new Error(`the server did not start: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const before = readServerFile(files.server)!;
	const started = await call(before.url, "POST", "/api/upgrade", { token: before.adminToken });
	assert.equal(started.status, 202);
	assert.equal(await running, 0, output);
	assert.match(output, /restarted on the upgraded version as pid (\d+)/);
	const pid = Number(/as pid (\d+)/.exec(output)![1]);

	let next = readServerFile(files.server);
	while (next?.pid !== pid) {
		if (Date.now() > deadline + 15_000) throw new Error(`the restarted server did not come up: ${readFileSync(files.log, "utf8")}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		next = readServerFile(files.server);
	}
	assert.equal(next.url, before.url, "the same address");
	assert.equal(next.serverId, before.serverId, "the same identity");
	const info = await call(next.url, "GET", "/api/server", { token: next.adminToken });
	assert.equal(info.status, 200);
	assert.equal(info.body.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "the installed version answers");
	// The restarted server is this test's child: stopping it must not block the loop that reaps it.
	const stopper = spawn(process.execPath, [BIN, "--home", home, "serve", "stop"], { env: isolatedEnv(root), stdio: ["ignore", "ignore", "pipe"] });
	let stopErr = "";
	stopper.stderr.on("data", (chunk) => { stopErr += chunk; });
	const { promise: stopped, resolve: stopDone } = Promise.withResolvers<number | null>();
	stopper.once("close", stopDone);
	assert.equal(await stopped, 0, stopErr);
});

test("under a service manager the upgraded server exits for the manager to restart it", { timeout: 60_000 }, async () => {
	const root = scratch();
	const home = join(root, "agent");
	const script = fakeUpgrade(root);
	const files = serveFiles(home);
	const args = parseServeArgs(["--foreground"]);
	assert.ok(!("error" in args));
	let output = "";
	const running = runServeCommand(args, {
		agentHome: home,
		homeFlags: ["--home", home],
		launcher: BIN,
		nodePath: process.execPath,
		version: "1.0.0",
		env: { ...isolatedEnv(root), XPC_SERVICE_NAME: "com.gentle-shell.serve" },
		stdout: (text) => { output += text; },
		stderr: (text) => { output += text; },
		untilStopped: (stopRequested) => stopRequested,
		upgradeCommand: () => ({ command: process.execPath, args: [script], cwd: root, env: process.env }),
	});
	const deadline = Date.now() + 15_000;
	while (readServerFile(files.server)?.pid !== process.pid) {
		if (Date.now() > deadline) throw new Error(`the server did not start: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const server = readServerFile(files.server)!;
	assert.equal((await call(server.url, "POST", "/api/upgrade", { token: server.adminToken })).status, 202);
	assert.equal(await running, SERVE_RESTART_EXIT);
	assert.match(output, /the service manager starts the upgraded server/);
	assert.equal(readServerFile(files.server), undefined, "no server left behind for the manager's one to find");
});

test("no server, session keeper, or fake Pi outlives the tests above", () => {
	assert.deepEqual(serveLeftovers(sessionDirs(), roots), []);
});
