import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { liveServer, parseServeArgs, readServerFile, runServeCommand, serveFiles, type ServeCommandContext } from "../lib/serve-cli.ts";
import { autostartCommand, autostartFile, autostartInstalled, encodeConnectionCode, firewallHint, installAutostart, launchAgentPlist, ownHostNames,
	removeAutostart, shareAddresses, systemdUnit, type ShareSystem } from "../lib/serve-share.ts";

const binPath = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./fixtures/serve-fake-pi.mjs", import.meta.url));
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function scratch(): string {
	const r = realpathSync(mkdtempSync(join(tmpdir(), "gentle-serve-share-")));
	roots.push(r);
	return r;
}

/** The client side of the contract: `gsc1.` + base64url (no padding) of the JSON. */
function decode(code: string): { v: number; id: string; n: string; p: number; a: string[]; c: string } {
	assert.ok(code.startsWith("gsc1."), code);
	const payload = code.slice("gsc1.".length);
	assert.match(payload, /^[A-Za-z0-9_-]+$/, "base64url without padding");
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function nic(address: string, options: { family?: "IPv4" | "IPv6"; internal?: boolean } = {}): NetworkInterfaceInfo {
	const family = options.family ?? "IPv4";
	return { address, family, internal: options.internal ?? false, netmask: "", mac: "00:00:00:00:00:00", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) } as NetworkInterfaceInfo;
}

test("serve share arguments", () => {
	assert.deepEqual(parseServeArgs(["share"]), { action: "share", port: 8787, always: false, json: false });
	assert.deepEqual(parseServeArgs(["share", "--port", "9000", "--always", "--json"]), { action: "share", port: 9000, always: true, json: true });
	assert.deepEqual(parseServeArgs(["share", "--port=9001"]), { action: "share", port: 9001, always: false, json: false });
	assert.deepEqual(parseServeArgs(["share", "--off"]), { action: "share-off" });
	assert.deepEqual(parseServeArgs(["share", "--off", "--always"]), { error: "serve share --off takes no other argument" });
	assert.deepEqual(parseServeArgs(["share", "--port", "0"]), { error: '--port needs a port 1-65535 (got "0")' });
	assert.deepEqual(parseServeArgs(["share", "--port"]), { error: '--port needs a port 1-65535 (got "")' });
	assert.deepEqual(parseServeArgs(["share", "--listen", "0.0.0.0:1"]), { error: 'unknown serve share argument "--listen"' });
	assert.deepEqual(parseServeArgs(["--always"]), { error: 'unknown serve argument "--always"' });
});

test("a connection code is gsc1. + base64url JSON in the contract's key order", () => {
	const code = encodeConnectionCode({ id: "srv_0123456789abcdef", n: "Box", p: 8787, a: ["192.168.1.20", "box", "box.local"], c: "ABCD-EFGH" });
	assert.ok(!code.includes("="), "no padding");
	assert.deepEqual(decode(code), { v: 1, id: "srv_0123456789abcdef", n: "Box", p: 8787, a: ["192.168.1.20", "box", "box.local"], c: "ABCD-EFGH" });
	assert.deepEqual(Object.keys(decode(code)), ["v", "id", "n", "p", "a", "c"]);
	// Characters base64 would turn into + and / stay URL-safe.
	const odd = encodeConnectionCode({ id: "srv_?>?>", n: "ñ~~~", p: 1, a: [], c: "????-????" });
	assert.match(odd, /^gsc1\.[A-Za-z0-9_-]+$/);
	assert.equal(decode(odd).n, "ñ~~~");
});

test("advertised addresses: LAN IPv4 first, never loopback or link-local, names last, at most 8", () => {
	const interfaces = {
		lo0: [nic("127.0.0.1", { internal: true }), nic("::1", { family: "IPv6", internal: true })],
		docker0: [nic("172.17.0.1")],
		tailscale0: [nic("100.101.102.103"), nic("fd7a:115c:a1e0::1", { family: "IPv6" })],
		en0: [nic("fe80::1c2b:3cff:fe4d:5e6f", { family: "IPv6" }), nic("192.168.1.20"), nic("169.254.10.2")],
		en1: [nic("10.0.0.5")],
		en2: [nic("192.168.1.20")],
	};
	assert.deepEqual(shareAddresses(interfaces, "Box"), ["192.168.1.20", "10.0.0.5", "100.101.102.103", "172.17.0.1", "box", "box.local"]);
	// A macOS-style name already ending in .local is not doubled.
	assert.deepEqual(shareAddresses({ en0: [nic("192.168.1.20")] }, "Ismaels-MacBook-Pro.local"), ["192.168.1.20", "ismaels-macbook-pro.local"]);
	assert.deepEqual(shareAddresses({}, "box"), ["box", "box.local"], "no network: the names alone");
	const many = { en0: Array.from({ length: 12 }, (_, i) => nic(`192.168.1.${i + 1}`)) };
	const capped = shareAddresses(many, "box");
	assert.equal(capped.length, 8);
	assert.deepEqual(capped.slice(-2), ["box", "box.local"], "the names keep their places");
	// A hostname that is not a DNS name is left out (it could not be a URL host).
	assert.deepEqual(ownHostNames("my_box"), []);
	assert.equal(shareAddresses(many, "my_box").length, 8);
});

test("the firewall hint names the exact command, on Linux with ufw or firewalld only", () => {
	assert.equal(firewallHint("linux", 8787, (c) => c === "ufw"), "sudo ufw allow 8787", "TCP and UDP (discovery)");
	assert.equal(firewallHint("linux", 8788, (c) => c === "firewall-cmd"), "sudo firewall-cmd --permanent --add-port=8788/tcp --add-port=8788/udp && sudo firewall-cmd --reload");
	assert.equal(firewallHint("linux", 8787, () => false), undefined);
	assert.equal(firewallHint("darwin", 8787, () => true), undefined);
});

function fakeSystem(root: string, platform: NodeJS.Platform, run: ShareSystem["run"]): ShareSystem {
	return { platform, hostname: () => "box", networkInterfaces: () => ({ en0: [nic("192.168.1.20")] }), userHome: root, uid: 501, user: "me", run, has: () => false };
}

function recorder(fail?: string): { calls: string[]; run: ShareSystem["run"] } {
	const calls: string[] = [];
	return { calls, run: async (command, args) => {
		const line = [command, ...args].join(" ");
		calls.push(line);
		return line.includes(fail ?? "\0") ? { status: 1, output: "Failed to connect to bus\n" } : { status: 0, output: "" };
	} };
}

const sampleSpec = (logFile = "/home/me/.gs/serve/server.log") => autostartCommand({
	nodePath: "/usr/bin/node",
	launcher: "/home/me/src/gentle shell/bin/gentle-shell.mjs",
	homeFlags: ["--home", "/home/me/.gs"],
	port: 8787,
	allowHosts: ["box", "box.local"],
	env: { PATH: "/usr/local/bin:/usr/bin", GENTLE_SHELL_NO_AUTO_SETUP: "1", HOME: "/home/me", ANTHROPIC_API_KEY: "secret" },
	logFile,
});

test("autostart runs this same launcher and home on the network, with only the kept environment", () => {
	const spec = sampleSpec();
	assert.equal(spec.command, "/usr/bin/node");
	assert.deepEqual(spec.args, ["/home/me/src/gentle shell/bin/gentle-shell.mjs", "--home", "/home/me/.gs", "serve", "--foreground", "--listen", "0.0.0.0:8787", "--allow-host", "box", "--allow-host", "box.local"]);
	assert.deepEqual(spec.env, { PATH: "/usr/local/bin:/usr/bin", GENTLE_SHELL_NO_AUTO_SETUP: "1" }, "no secrets, no HOME (the service manager sets it)");

	const unit = systemdUnit(spec);
	assert.match(unit, /^ExecStart=\/usr\/bin\/node "\/home\/me\/src\/gentle shell\/bin\/gentle-shell\.mjs" --home \/home\/me\/\.gs serve --foreground --listen 0\.0\.0\.0:8787 --allow-host box --allow-host box\.local$/m);
	assert.match(unit, /^Environment="PATH=\/usr\/local\/bin:\/usr\/bin"$/m);
	assert.match(unit, /^Environment="GENTLE_SHELL_NO_AUTO_SETUP=1"$/m);
	assert.match(unit, /^Restart=on-failure$/m);
	assert.match(unit, /^\[Install\]\nWantedBy=default\.target$/m);
	assert.ok(!unit.includes("secret"));
	// systemd specifiers and variables are escaped, not expanded.
	const odd = systemdUnit({ ...spec, args: ["/opt/50%/$HOME/x"], env: { PATH: "/a%b" } });
	assert.match(odd, /^ExecStart=\/usr\/bin\/node "\/opt\/50%%\/\$\$HOME\/x"$/m);
	assert.match(odd, /^Environment="PATH=\/a%%b"$/m);

	const plist = launchAgentPlist({ ...spec, args: [...spec.args, "a&b<c>"] });
	assert.match(plist, /<key>Label<\/key>\n\t<string>com\.gentle-shell\.serve<\/string>/);
	const programArgs = /<key>ProgramArguments<\/key>\n\t<array>\n([\s\S]*?)\n\t<\/array>/.exec(plist)![1].split("\n").map((l) => l.trim().replace(/^<string>|<\/string>$/g, ""));
	assert.deepEqual(programArgs, ["/usr/bin/node", ...spec.args, "a&amp;b&lt;c&gt;"]);
	assert.match(plist, /<key>EnvironmentVariables<\/key>\n\t<dict>\n\t\t<key>PATH<\/key>\n\t\t<string>\/usr\/local\/bin:\/usr\/bin<\/string>\n\t\t<key>GENTLE_SHELL_NO_AUTO_SETUP<\/key>\n\t\t<string>1<\/string>\n\t<\/dict>/);
	assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
	assert.match(plist, /<key>StandardErrorPath<\/key>\n\t<string>\/home\/me\/\.gs\/serve\/server\.log<\/string>/);
});

test("autostart on Linux: a systemd user unit, enabled and started; --off disables and removes it", async () => {
	const root = scratch();
	const { calls, run } = recorder();
	const system = fakeSystem(root, "linux", run);
	const spec = sampleSpec();
	const installed = await installAutostart(system, spec);
	const file = join(root, ".config", "systemd", "user", "gentle-shell-serve.service");
	assert.deepEqual(installed, { file });
	assert.equal(readFileSync(file, "utf8"), systemdUnit(spec));
	assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable --now gentle-shell-serve.service"]);
	assert.ok(autostartInstalled(system, spec));
	assert.ok(!autostartInstalled(system, { ...spec, args: [...spec.args, "--allow-host", "other"] }));

	calls.length = 0;
	assert.deepEqual(await removeAutostart(system), { file, removed: true });
	assert.deepEqual(calls, ["systemctl --user disable --now gentle-shell-serve.service", "systemctl --user daemon-reload"]);
	assert.ok(!existsSync(file));
	assert.equal((await removeAutostart(system)).removed, false);

	// XDG_CONFIG_HOME moves user units.
	assert.equal(autostartFile({ ...system, configHome: "/xdg" }), "/xdg/systemd/user/gentle-shell-serve.service");

	// Without a user bus (an SSH login without lingering) nothing is left behind.
	const failing = recorder("enable");
	const refused = await installAutostart(fakeSystem(root, "linux", failing.run), spec);
	assert.deepEqual(refused, { error: "systemctl --user enable --now gentle-shell-serve.service failed (1): Failed to connect to bus" });
	assert.ok(!existsSync(file));
	assert.deepEqual(failing.calls.at(-1), "systemctl --user daemon-reload");
});

test("autostart on macOS: a LaunchAgent bootstrapped in the GUI domain; Windows has none", async () => {
	const root = scratch();
	const { calls, run } = recorder();
	const system = fakeSystem(root, "darwin", run);
	const spec = sampleSpec(join(root, "home", "serve", "server.log"));
	const file = join(root, "Library", "LaunchAgents", "com.gentle-shell.serve.plist");
	assert.deepEqual(await installAutostart(system, spec), { file });
	assert.equal(readFileSync(file, "utf8"), launchAgentPlist(spec));
	assert.deepEqual(calls, ["launchctl bootout gui/501/com.gentle-shell.serve", `launchctl bootstrap gui/501 ${file}`]);
	if (process.platform !== "win32") assert.equal(statSync(spec.logFile).mode & 0o777, 0o600, "the log launchd appends to is owner-only");
	calls.length = 0;
	assert.deepEqual(await removeAutostart(system), { file, removed: true });
	assert.deepEqual(calls, ["launchctl bootout gui/501/com.gentle-shell.serve"]);
	assert.ok(!existsSync(file));

	const windows = fakeSystem(root, "win32", run);
	assert.equal(autostartFile(windows), undefined);
	assert.deepEqual(await installAutostart(windows, spec), { error: "autostart is not supported on win32 yet" });
});

// --- share against real servers ------------------------------------------------------

function isolatedEnv(root: string): NodeJS.ProcessEnv {
	return { HOME: root, USERPROFILE: root, PATH: process.env.PATH, GENTLE_SHELL_NO_AUTO_SETUP: "1" };
}

function cli(root: string, args: string[]) {
	return spawnSync(process.execPath, [binPath, "--home", join(root, "agent"), "serve", ...args], { env: isolatedEnv(root), encoding: "utf8", timeout: 60_000 });
}

function canBind(port: number, host: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const probe = createServer();
	probe.once("error", () => resolve(false));
	probe.listen(port, host, () => probe.close(() => resolve(true)));
	return promise;
}

/**
 * A port P such that P..P+count-1 are free on every interface. Below the
 * ephemeral ranges (Linux 32768+, macOS and Windows 49152+): a port the OS just
 * handed out is next to the ones it hands to parallel tests' `listen(0)`.
 */
async function freePorts(count: number): Promise<number> {
	for (;;) {
		const base = 20_000 + Math.floor(Math.random() * 10_000);
		let ok = true;
		for (let p = base; p < base + count && ok; p += 1) ok = (await canBind(p, "0.0.0.0")) && (await canBind(p, "127.0.0.1"));
		if (ok) return base;
	}
}

function listen(port: number): Promise<Server> {
	const { promise, resolve } = Promise.withResolvers<Server>();
	const server = createServer();
	server.listen(port, "0.0.0.0", () => resolve(server));
	return promise;
}

test("serve share from stopped: starts on the network (next port when taken), the code finds and pairs it; share again reuses it", { timeout: 90_000 }, async () => {
	const root = scratch();
	const home = join(root, "agent");
	const port = await freePorts(2);
	const blocker = await listen(port);
	let started;
	try {
		started = cli(root, ["share", "--port", String(port), "--json"]);
	} finally {
		blocker.close();
	}
	assert.equal(started.status, 0, started.stderr);
	try {
		const info = JSON.parse(started.stdout);
		assert.deepEqual(Object.keys(info), ["code", "pairingCode", "port", "addresses", "expiresAt", "serverId", "discovery"]);
		assert.equal(info.discovery, true, "the network server answers LAN discovery");
		assert.equal(info.port, port + 1, "the taken port is skipped");
		const code = decode(info.code);
		assert.equal(info.pairingCode, code.c, "the short code is the one the long code carries");
		assert.equal(code.v, 1);
		assert.equal(code.id, info.serverId);
		assert.equal(code.n, hostname());
		assert.equal(code.p, port + 1);
		assert.deepEqual(code.a, info.addresses);
		assert.ok(code.a.length >= 1 && code.a.length <= 8);
		const names = ownHostNames(hostname());
		assert.deepEqual(code.a.slice(code.a.length - names.length), names, "this machine's names come last");
		for (const a of code.a) assert.ok(!a.startsWith("127.") && !a.startsWith("169.254.") && !a.includes(":"), a);
		assert.match(code.c, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
		assert.ok(Date.parse(info.expiresAt) > Date.now());

		const server = readServerFile(serveFiles(home).server)!;
		assert.deepEqual(server.listen, { host: "0.0.0.0", port: port + 1 });
		assert.equal(server.serverId, info.serverId);

		// What the client does: identity first, then the pairing code, at the same address.
		const base = `http://127.0.0.1:${port + 1}`;
		const identity = await (await fetch(`${base}/.well-known/gentle-shell`)).json();
		assert.equal(identity.serverId, code.id);
		assert.equal(identity.schema, "gentle-shell.serve.identity/v1");
		const paired = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.c, name: "gpui" }) });
		assert.equal(paired.status, 201);
		const again = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.c, name: "gpui" }) });
		assert.equal(again.status, 403, "single use");

		const human = cli(root, ["share", "--port", String(port)]);
		assert.equal(human.status, 0, human.stderr);
		const lines = human.stdout.split("\n");
		assert.equal(lines[0], `The Gentle Shell server is already open to your network on port ${port + 1}.`);
		assert.equal(lines[1], "");
		const short = /^ {2}Code: ([0-9A-Z]{4}-[0-9A-Z]{4})$/.exec(lines[2]);
		assert.ok(short, lines[2]);
		assert.equal(lines[3], "");
		assert.equal(lines[4], "In Gentle Shell GPUI → Configuration → Where agents run → Gentle Shell server, enter this code. Valid for 5 minutes, once.");
		assert.equal(lines[5], "If the app can't find this computer, paste this instead:");
		assert.match(lines[6], /^gsc1\.[A-Za-z0-9_-]+$/, "the long code alone on its line");
		assert.equal(decode(lines[6]).id, info.serverId, "the same server");
		assert.equal(decode(lines[6]).c, short[1], "the long code carries the short one");
		assert.notEqual(short[1], code.c, "a fresh pairing code");
		assert.equal(lines[7], "");
		assert.match(lines[8], /plain HTTP on your network/, "discovery is on: no note before the warning");
		assert.equal(readServerFile(serveFiles(home).server)!.pid, server.pid);
	} finally {
		assert.equal(cli(root, ["stop"]).status, 0);
	}
});

test("serve share reopens a loopback server with no sessions on the network", { timeout: 90_000 }, async () => {
	const root = scratch();
	const home = join(root, "agent");
	const loop = cli(root, ["--listen", "127.0.0.1:0", "--json"]);
	assert.equal(loop.status, 0, loop.stderr);
	const before = readServerFile(serveFiles(home).server)!;
	const port = await freePorts(1);
	const shared = cli(root, ["share", "--port", String(port)]);
	try {
		assert.equal(shared.status, 0, shared.stderr);
		assert.match(shared.stdout, new RegExp(`^Opened the Gentle Shell server to your network on port ${port} \\(it was reachable from this computer only\\)\\.\n`));
		const after = readServerFile(serveFiles(home).server)!;
		assert.deepEqual(after.listen, { host: "0.0.0.0", port });
		assert.notEqual(after.pid, before.pid);
		assert.ok(!liveServer(home) || liveServer(home)!.pid === after.pid);
	} finally {
		assert.equal(cli(root, ["stop"]).status, 0);
	}
});

function context(root: string, overrides: Partial<ServeCommandContext> = {}): ServeCommandContext & { out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const home = join(root, "agent");
	return { agentHome: home, homeFlags: ["--home", home], launcher: binPath, nodePath: process.execPath, version: "test", env: isolatedEnv(root),
		stdout: (t) => out.push(t), stderr: (t) => err.push(t), out, err, ...overrides };
}

test("serve share leaves a loopback server with running sessions alone and says why", { timeout: 60_000 }, async () => {
	const root = scratch();
	const project = join(root, "project");
	mkdirSync(project);
	const release = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<void>();
	// An in-process server whose sessions are the fake Pi; it prints once it serves.
	const owner = context(root, { launcher: FAKE_PI, untilStopped: (stop) => Promise.race([stop, release.promise]), stdout: () => ready.resolve() });
	const running = runServeCommand({ action: "start", host: "127.0.0.1", port: 0, foreground: true, json: true }, owner);
	try {
		await Promise.race([ready.promise, running.then(() => { throw new Error(owner.err.join("")); })]);
		const server = liveServer(owner.agentHome)!;
		const session = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { Authorization: `Bearer ${server.adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ cwd: project }) });
		assert.equal(session.status, 201);

		const ctx = context(root, { system: fakeSystem(root, "linux", recorder().run) });
		assert.equal(await runServeCommand({ action: "share", port: 8787, always: false, json: false }, ctx), 1);
		assert.equal(ctx.err.join(""), `gentle-shell serve share: the server here is reachable from this computer only and has 1 running session(s); stop them or run 'gentle-shell serve stop', then run share again to open it to your network.\n`);
		assert.equal(ctx.out.join(""), "");
		assert.equal(liveServer(owner.agentHome)?.pid, process.pid, "still the same server");
		const list = await (await fetch(`${server.url}/api/sessions`, { headers: { Authorization: `Bearer ${server.adminToken}` } })).json();
		assert.deepEqual(list.sessions.map((s: { state: string }) => s.state), ["running"]);
	} finally {
		release.resolve();
		assert.equal(await running, 0);
	}
});

/** A stand-in for launchd: bootstrap runs the agent's ProgramArguments, bootout stops it. */
function fakeLaunchd(root: string): { run: ShareSystem["run"]; calls: string[]; child(): ChildProcess | undefined } {
	const calls: string[] = [];
	let child: ChildProcess | undefined;
	const run: ShareSystem["run"] = async (command, args) => {
		calls.push([command, ...args].join(" "));
		if (args[0] === "bootstrap") {
			const plist = readFileSync(args[2], "utf8");
			const strings = (block: string) => [...block.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
			const argv = strings(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1]);
			const envPairs = strings(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)![1].replace(/<key>(.*?)<\/key>/g, "<string>$1</string>"));
			const env: NodeJS.ProcessEnv = { HOME: root, USERPROFILE: root };
			for (let i = 0; i < envPairs.length; i += 2) env[envPairs[i]] = envPairs[i + 1];
			const log = openSync(strings(/<key>StandardErrorPath<\/key>\s*(<string>.*?<\/string>)/.exec(plist)![1])[0], "a");
			child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", log, log], detached: true });
		}
		if (args[0] === "bootout" && child && child.exitCode === null) child.kill("SIGTERM");
		return { status: 0, output: "" };
	};
	return { run, calls, child: () => child };
}

test("serve share --always hands the server to the login service manager, reuses it, and --off stops it", { timeout: 90_000 }, async (t) => {
	const root = scratch();
	const launchd = fakeLaunchd(root);
	t.after(() => { const c = launchd.child(); if (c && c.exitCode === null) c.kill("SIGKILL"); });
	const system = fakeSystem(root, "darwin", launchd.run);
	const port = await freePorts(1);
	const ctx = context(root, { system });
	assert.equal(await runServeCommand({ action: "share", port, always: true, json: false }, ctx), 0, ctx.err.join(""));
	const plistFile = join(root, "Library", "LaunchAgents", "com.gentle-shell.serve.plist");
	const plist = readFileSync(plistFile, "utf8");
	for (const arg of [process.execPath, binPath, "--home", ctx.agentHome, "serve", "--foreground", "--listen", `0.0.0.0:${port}`, "--allow-host", "box", "box.local"]) assert.ok(plist.includes(`<string>${arg}</string>`), arg);
	assert.ok(plist.includes("<key>GENTLE_SHELL_NO_AUTO_SETUP</key>"), "kept from the installing invocation");
	const server = liveServer(ctx.agentHome)!;
	assert.equal(server.pid, launchd.child()!.pid, "the service manager's process serves");
	const out = ctx.out.join("");
	assert.match(out, new RegExp(`^Started the Gentle Shell server for your network on port ${port}\\.\n\n  Code: [0-9A-Z]{4}-[0-9A-Z]{4}\n\n`));
	assert.match(out, /\nIt starts at every login; turn that off with 'gentle-shell serve share --off'\.\n$/);
	assert.deepEqual(decode(out.split("\n")[6]).a, ["192.168.1.20", "box", "box.local"]);

	// Already installed and running: reused as is, the service manager untouched.
	launchd.calls.length = 0;
	const again = context(root, { system });
	assert.equal(await runServeCommand({ action: "share", port, always: true, json: true }, again), 0, again.err.join(""));
	assert.equal(JSON.parse(again.out.join("")).serverId, server.serverId);
	assert.deepEqual(launchd.calls, []);

	const exited = once(launchd.child()!, "exit");
	const off = context(root, { system });
	assert.equal(await runServeCommand({ action: "share-off" }, off), 0);
	assert.equal(off.out.join(""), `Start at login is off (removed ${plistFile}); the server it started has stopped.\n`);
	await exited;
	assert.ok(!existsSync(plistFile));
	assert.equal(liveServer(ctx.agentHome), undefined);
});

test("serve share --always is refused on Windows before anything starts", async () => {
	const root = scratch();
	const ctx = context(root, { system: fakeSystem(root, "win32", recorder().run) });
	assert.equal(await runServeCommand({ action: "share", port: 8787, always: true, json: false }, ctx), 1);
	assert.equal(ctx.err.join(""), "gentle-shell serve share: --always (start at login) is not supported on Windows yet; run 'gentle-shell serve share' without it.\n");
	assert.equal(liveServer(ctx.agentHome), undefined);
});
