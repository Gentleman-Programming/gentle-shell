import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { helpText, parseLauncherArgs, parseTowerArgs } from "../lib/gentle-shell-launcher.ts";

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

test("help text lists gentle-shell tower and its options", () => {
	const text = helpText();
	assert.ok(text.includes("       gentle-shell tower [--no-open] [--port <n>] [--json]"));
	assert.match(text, /\n  tower +Open the Gentle Tower/);
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
