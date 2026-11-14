import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { helpText, parseLauncherArgs } from "../lib/gentle-shell-launcher.ts";
import { desktopUsage, HERDR_APP_VERSION } from "../lib/gentle-shell-desktop.ts";

// `gentle-shell desktop` through the real bin with an isolated HOME and a fake
// herdr-app on PATH; nothing is downloaded and the real Herdr is never touched.

const binPath = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const packageRoot = dirname(dirname(binPath));

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gs-desktop-bin-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(home);
	mkdirSync(bin);
	writeFileSync(join(bin, "herdr-app"), "#!/bin/sh\ncase \"$1\" in --version) echo 'herdr-app 0.1.15';; status) exit 2;; esac\n", { mode: 0o755 });
	const env = { HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, GENTLE_SHELL_NO_AUTO_SETUP: "1" };
	const run = (args: string[]) => spawnSync(process.execPath, [binPath, ...args], { env, encoding: "utf8", input: "" });
	return { home, bin, run };
}

test("gentle-shell --help lists the desktop command", () => {
	assert.match(helpText(), /\n {7}gentle-shell desktop \[--yes\] \[--no-open\] \| --status \| --uninstall\n/);
	assert.match(helpText(), /\n {2}desktop {10}Install and open Gentle Shell Desktop: Herdr app \(pinned minimum\n/);
});

test("existing subcommands still parse and stay in the help unchanged", () => {
	for (const command of ["home", "upgrade", "self-uninstall", "memory"] as const) {
		const parsed = parseLauncherArgs([command, "--x"]);
		assert.equal(parsed.command, command);
		assert.deepEqual(parsed.commandArgs, ["--x"]);
	}
	assert.equal(parseLauncherArgs(["setup", "--dry-run"]).command, "setup");
	assert.deepEqual(parseLauncherArgs(["list"]).passthrough, ["list"]);
	assert.equal(parseLauncherArgs(["list"]).piSubcommand, "list");
	// `desktop` is ours only as argv[0]; a later token stays Pi's prompt.
	assert.deepEqual(parseLauncherArgs(["--", "desktop"]).passthrough, ["desktop"]);
	assert.deepEqual(parseLauncherArgs(["hello", "desktop"]).passthrough, ["hello", "desktop"]);
	for (const line of [
		"       gentle-shell upgrade [--channel release|main]",
		"       gentle-shell upgrade --rollback",
		"       gentle-shell memory migrate --confirm-quiescent",
		"       gentle-shell self-uninstall [--dry-run] [--yes] [--include-shared]",
		"  self-uninstall   Remove Gentle Shell: its own data, the isolated home and the gentle-pi",
	]) assert.ok(helpText().includes(`${line}\n`), line);
});

test("bin: desktop parses as a launcher command", () => {
	const parsed = parseLauncherArgs(["desktop", "--status"]);
	assert.equal(parsed.command, "desktop");
	assert.deepEqual(parsed.commandArgs, ["--status"]);
});

test("bin: gentle-shell desktop --help and --status run without Pi", (t) => {
	const f = fixture(t);
	const help = f.run(["desktop", "--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.equal(help.stdout, `${desktopUsage()}\n`);
	const status = f.run(["desktop", "--status"]);
	assert.equal(status.status, 0, status.stderr);
	const version = JSON.parse(String(spawnSync("cat", [join(packageRoot, "package.json")], { encoding: "utf8" }).stdout)).version;
	assert.ok(status.stdout.startsWith(`Gentle Shell Desktop\n  Gentle Shell: ${version}\n  Herdr app: 0.1.15 at ${join(f.bin, "herdr-app")} (needs ${HERDR_APP_VERSION} or newer)\n`), status.stdout);
	assert.ok(status.stdout.includes(`  Herdr home: ${join(f.home, ".config", "herdr-app")}\n`));
	assert.ok(status.stdout.endsWith("  Window: not running\n"));
});

test("bin: non-interactive gentle-shell desktop without --yes refuses and writes nothing", (t) => {
	const f = fixture(t);
	const result = f.run(["desktop"]);
	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("gentle-shell desktop: nothing was installed. Run it in an interactive terminal to confirm, or pass --yes.\n"));
	assert.equal(existsSync(join(f.home, ".config")), false);
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop")), false);
});
