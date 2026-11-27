import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { helpText, parseLauncherArgs, parseTowerArgs } from "../lib/gentle-shell-launcher.ts";
import { runTower } from "../lib/tower-open.ts";
import { encodeQr, renderQrTerminal } from "../lib/tower-qr.ts";
import { type TowerServer } from "../lib/tower-server.ts";

const binPath = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const packageRoot = dirname(dirname(binPath));
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function scratch(): string {
	const r = mkdtempSync(join(tmpdir(), "gentle-shell-tower-"));
	roots.push(r);
	return r;
}

test("parseLauncherArgs recognises tower as argv[0] and hands over its arguments", () => {
	for (const argv of [["tower"], ["tower", "--no-open"], ["tower", "--port", "4242"]]) {
		const parsed = parseLauncherArgs(argv);
		assert.equal(parsed.command, "tower");
		assert.deepEqual(parsed.commandArgs, argv.slice(1));
		assert.deepEqual(parsed.passthrough, []);
		assert.equal(parsed.error, undefined);
	}
	// After `--` it is a prompt for pi, not the command.
	assert.deepEqual(parseLauncherArgs(["--", "tower"]).passthrough, ["tower"]);
	assert.equal(parseLauncherArgs(["--", "tower"]).command, undefined);
});

test("parseTowerArgs reads --no-open and --port", () => {
	assert.deepEqual(parseTowerArgs([]), { open: true });
	assert.deepEqual(parseTowerArgs(["--no-open"]), { open: false });
	assert.deepEqual(parseTowerArgs(["--port", "4242"]), { open: true, port: 4242 });
	assert.deepEqual(parseTowerArgs(["--port=4242", "--no-open"]), { open: false, port: 4242 });
	assert.deepEqual(parseTowerArgs(["--port", "65535"]), { open: true, port: 65535 });
	assert.deepEqual(parseTowerArgs(["--port", "1"]), { open: true, port: 1 });
});

test("parseTowerArgs rejects a bad port and unknown arguments with a clear error", () => {
	for (const bad of ["abc", "0", "65536", "-1", "42.5", "", "4242x"]) {
		assert.deepEqual(parseTowerArgs(["--port", bad]), { open: true, error: `--port needs a whole number from 1 to 65535 (got "${bad}")` });
	}
	assert.deepEqual(parseTowerArgs(["--port"]), { open: true, error: "--port needs a whole number from 1 to 65535" });
	assert.deepEqual(parseTowerArgs(["--host", "0.0.0.0"]), { open: true, error: 'unknown tower argument "--host"' });
});

test("parseTowerArgs reads --json alone and with the other options", () => {
	assert.deepEqual(parseTowerArgs(["--json"]), { open: true, json: true });
	assert.deepEqual(parseTowerArgs(["--no-open", "--json", "--port=4242"]), { open: false, port: 4242, json: true });
	assert.deepEqual(parseTowerArgs(["--json=yes"]), { open: true, error: 'unknown tower argument "--json=yes"' });
});

test("parseTowerArgs reads --lan alone and with the other options", () => {
	assert.deepEqual(parseTowerArgs(["--lan"]), { open: true, lan: true });
	assert.deepEqual(parseTowerArgs(["--no-open", "--lan", "--port=4242", "--json"]), { open: false, port: 4242, json: true, lan: true });
	assert.deepEqual(parseTowerArgs(["--lan=yes"]), { open: true, error: 'unknown tower argument "--lan=yes"' });
});

test("help text lists gentle-shell tower and its options", () => {
	const text = helpText();
	assert.ok(text.includes("       gentle-shell tower [--no-open] [--port <n>] [--json] [--lan]"));
	assert.match(text, /\n  tower +Open the Gentle Tower/);
	assert.match(text, /--port <n> fixes the port \(127\.0\.0\.1 only,\n\s+unless --lan\)/);
	assert.match(text, /--lan also binds every network interface, to open the view from a\n\s+phone on the same network/);
	assert.ok(text.includes("one URL per address, a QR code and a warning"));
	assert.ok(text.includes("--port then fixes the port on every interface"));
});

test("existing subcommands still parse as before", () => {
	const upgrade = parseLauncherArgs(["upgrade", "--channel", "main"]);
	assert.equal(upgrade.command, "upgrade");
	assert.deepEqual(upgrade.commandArgs, ["--channel", "main"]);
	const setup = parseLauncherArgs(["--isolated", "setup", "--dry-run"]);
	assert.equal(setup.command, "setup");
	assert.equal(setup.isolated, true);
	assert.deepEqual(setup.commandArgs, ["--dry-run"]);
	assert.deepEqual(parseLauncherArgs(["--link", "tower"]).passthrough, ["tower"]);
});

function isolatedEnv(root: string): NodeJS.ProcessEnv {
	return { HOME: root, USERPROFILE: root, PATH: process.env.PATH, GENTLE_TOWER_HOME: join(root, "hub"), GENTLE_SHELL_NO_AUTO_SETUP: "1" };
}

test("gentle-shell tower --port with a bad value fails with exit 2 and the error on stderr", () => {
	const result = spawnSync(process.execPath, [binPath, "tower", "--port", "abc"], { env: isolatedEnv(scratch()), encoding: "utf8", timeout: 20000 });
	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, `gentle-shell tower: --port needs a whole number from 1 to 65535 (got "abc")\nRun 'gentle-shell --help' for usage.\n`);
});

// S7: the exact warning line every --lan report prints.
const LAN_WARNING = "LAN mode: anyone on this network who opens the URL can read and drive your sessions; traffic is not encrypted. Use it only on a trusted home network.";
const QR_BLOCKS = /[\u2580\u2584\u2588]/;

function builtWeb(root: string): string {
	const web = join(root, "web");
	mkdirSync(web, { recursive: true });
	writeFileSync(join(web, "index.html"), "<title>Gentle Tower</title>");
	return web;
}

function towerEnv(root: string): NodeJS.ProcessEnv {
	return { GENTLE_TOWER_HOME: join(root, "hub"), GENTLE_SHELL_NO_AUTO_SETUP: "1" };
}

// A fixed interface list, given before the tower starts: the report must name
// exactly these addresses, whatever the OS says by the time it is asserted.
const LAN_NIC: NetworkInterfaceInfo = { address: "192.168.0.2", netmask: "255.255.255.0", mac: "00:00:00:00:00:00", internal: false, cidr: null, family: "IPv4" };
const LAN_INTERFACES: NodeJS.Dict<readonly NetworkInterfaceInfo[]> = { en0: [LAN_NIC] };

const lanUrl = (server: TowerServer) => `http://192.168.0.2:${server.port}/${new URL(server.url).pathname.replaceAll("/", "")}/`;

test("runTower --lan --json prints one line adding lan, urls and the warning", async () => {
	const root = scratch();
	const out: string[] = [], err: string[] = [], opened: string[] = [];
	let server: TowerServer | undefined;
	const code = await runTower({ env: towerEnv(root), open: false, lan: true, json: true, webDir: builtWeb(root), presenceDirs: [], interfaces: LAN_INTERFACES,
		stdout: (s) => out.push(s), stderr: (s) => err.push(s), openUrl: (u) => opened.push(u),
		untilStopped: async (s) => { server = s; } });
	assert.equal(code, 0);
	assert.ok(server);
	assert.deepEqual(err, []);
	assert.deepEqual(opened, []);
	const text = out.join("");
	assert.ok(text.endsWith("\n") && !text.slice(0, -1).includes("\n"), "exactly one JSON line");
	assert.ok(!QR_BLOCKS.test(text), "no QR in JSON mode");
	const parsed = JSON.parse(text) as Record<string, unknown>;
	assert.deepEqual(Object.keys(parsed), ["schema", "url", "host", "port", "lan", "urls", "warning"]);
	assert.equal(parsed.schema, "gentle-shell.tower/v1");
	assert.equal(parsed.url, server.url);
	assert.equal(parsed.host, "0.0.0.0");
	assert.equal(parsed.port, server.port);
	assert.equal(parsed.lan, true);
	assert.equal(parsed.warning, LAN_WARNING);
	assert.deepEqual(parsed.urls, [server.url, lanUrl(server)]);
});

test("runTower --lan prints every LAN URL, the QR of the first and the warning", async () => {
	const root = scratch();
	const out: string[] = [], err: string[] = [], opened: string[] = [];
	let server: TowerServer | undefined;
	const code = await runTower({ env: towerEnv(root), open: true, lan: true, webDir: builtWeb(root), presenceDirs: [], interfaces: LAN_INTERFACES,
		stdout: (s) => out.push(s), stderr: (s) => err.push(s), openUrl: (u) => opened.push(u),
		untilStopped: async (s) => {
			server = s;
			assert.equal(s.host, "0.0.0.0");
			assert.equal(s.lan, true);
		} });
	assert.equal(code, 0);
	assert.ok(server);
	assert.deepEqual(err, []);
	// The browser still opens the loopback URL, exactly as today.
	assert.deepEqual(opened, [server.url]);
	const lanUrls = [lanUrl(server)];
	assert.deepEqual(server.urls, [server.url, ...lanUrls]);
	const lines = [`Gentle Tower: ${server.url}`, ...lanUrls.map((u) => `  ${u}`)];
	for (const line of renderQrTerminal(encodeQr(lanUrls[0]))) lines.push(`  ${line}`);
	lines.push(LAN_WARNING, "Press Ctrl+C to stop.");
	assert.equal(out.join(""), `${lines.join("\n")}\n`);
	assert.ok(QR_BLOCKS.test(out.join("")), "the QR of the first LAN address is printed");
});

const built = existsSync(join(packageRoot, "web", "tower", "dist", "index.html"));
test("gentle-shell tower --no-open serves until SIGINT, then exits 0", { skip: built ? false : "web/tower/dist is not built" }, async (t) => {
	const child = spawn(process.execPath, [binPath, "tower", "--no-open"], { env: isolatedEnv(scratch()), stdio: ["ignore", "pipe", "pipe"] });
	// A failed assertion must not leave the server running and the test file hanging.
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	let stdout = "", stderr = "";
	child.stderr.on("data", (d) => { stderr += d; });
	const url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no URL; stderr: ${stderr}`)); }, 20000);
		child.stdout.on("data", (d) => {
			stdout += d;
			const m = /Gentle Tower: (\S+)\n/.exec(stdout);
			if (m) { clearTimeout(timer); resolve(m[1]); }
		});
	});
	assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32,}\/$/);
	assert.equal((await fetch(url)).status, 200);
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	child.kill("SIGINT");
	// Windows cannot deliver SIGINT to another process: kill() terminates it (exit code null),
	// so there only the stop itself is checked; POSIX checks the clean exit 0.
	const code = await exited;
	if (process.platform !== "win32") assert.equal(code, 0);
	assert.equal(stderr, "");
	assert.equal(stdout, `Gentle Tower: ${url}\nPress Ctrl+C to stop.\n`);
	await assert.rejects(fetch(url));
});
