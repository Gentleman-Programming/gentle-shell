import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// isPiManagedInstall gates the POSTINSTALL entry point only (scripts/install-gentle-ai.mjs):
// it decides whether the running gentle-pi package sits under a directory
// pattern Pi's own package manager creates (npm-backed or git-backed), so an
// `npm install -g gentle-pi`, a plain development git checkout, or an npx
// cache directory never writes to the user's global Pi settings. It is
// deliberately unrelated to installTuiModeSetting's own ownership check
// (which compares the package location against one specific resolved agent
// home) and to installIsolatedTuiModeSetting (gentle-shell's own bootstrap of
// a directory it just created), covered in the other two test files.

const helperUrl = new URL("../scripts/install-tui-mode-setting.mjs", import.meta.url);
const { isPiManagedInstall } = await import(helperUrl.href);

test("isPiManagedInstall recognizes the user-scope npm-managed layout", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".pi", "agent", "npm", "node_modules", "gentle-pi")), true);
});

test("isPiManagedInstall recognizes the project-scope npm-managed layout", () => {
	assert.equal(isPiManagedInstall(join("/repo", ".pi", "npm", "node_modules", "gentle-pi")), true);
});

test("isPiManagedInstall recognizes Pi's git-managed layout", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".pi", "agent", "git", "github.com", "Gentleman-Programming", "gentle-pi")), true);
});

test("isPiManagedInstall rejects a global npm -g install", () => {
	assert.equal(isPiManagedInstall("/usr/local/lib/node_modules/gentle-pi"), false);
});

test("isPiManagedInstall rejects a plain development git checkout", () => {
	assert.equal(isPiManagedInstall("/Users/alan/work/gentle-pi"), false);
});

test("isPiManagedInstall rejects an npx cache directory", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".npm", "_npx", "abc123", "node_modules", "gentle-pi")), false);
});

test("isPiManagedInstall rejects a pnpm content-addressable store", () => {
	assert.equal(isPiManagedInstall(join("/home/alan", ".pnpm", "gentle-pi@1.0.0", "node_modules", "gentle-pi")), false);
});

test("isPiManagedInstall resolves a relative path before checking", () => {
	const cwd = process.cwd();
	try {
		process.chdir(join("/tmp"));
		assert.equal(isPiManagedInstall(join(".", "npm", "node_modules", "gentle-pi")), true);
	} finally {
		process.chdir(cwd);
	}
});

// --- postinstall entry integration --------------------------------------------

function fixture(t: test.TestContext, packageSegments: readonly string[]) {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "agent");
	const packageRoot = join(home, ...packageSegments);
	const scripts = join(packageRoot, "scripts");
	mkdirSync(scripts, { recursive: true });
	copyFileSync(helperUrl, join(scripts, "install-tui-mode-setting.mjs"));
	copyFileSync(new URL("../scripts/install-gentle-ai.mjs", import.meta.url), join(scripts, "install-gentle-ai.mjs"));
	writeFileSync(
		join(scripts, "gentle-ai-installer.mjs"),
		'export const INSTALLER_VERSION = "test"; export async function installGentleAi() { return { installed: true, binaryPath: "fixture" }; }',
	);
	const settings = join(home, "settings.json");
	const env = { ...process.env, GENTLE_PI_AGENT_HOME: home, GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "0" };
	return { root, home, packageRoot, scripts, settings, env };
}

test("postinstall skips the global settings write outside a pi-managed install", (t) => {
	const f = fixture(t, ["node_modules", "gentle-pi"]);
	const result = spawnSync(process.execPath, [join(f.scripts, "install-gentle-ai.mjs")], { encoding: "utf8", env: f.env });
	assert.equal(result.status, 0, result.stderr);
	assert.match(`${result.stdout}${result.stderr}`, /skip/i);
	assert.equal(existsSync(f.settings), false);
});

test("postinstall still writes fullscreen for a pi-managed npm install", (t) => {
	const f = fixture(t, ["npm", "node_modules", "gentle-pi"]);
	const result = spawnSync(process.execPath, [join(f.scripts, "install-gentle-ai.mjs")], { encoding: "utf8", env: f.env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).tuiMode, "fullscreen");
});

test("postinstall still writes fullscreen for a pi-managed git install", (t) => {
	const f = fixture(t, ["git", "github.com", "Gentleman-Programming", "gentle-pi"]);
	const result = spawnSync(process.execPath, [join(f.scripts, "install-gentle-ai.mjs")], { encoding: "utf8", env: f.env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).tuiMode, "fullscreen");
});
