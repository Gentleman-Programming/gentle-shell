import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const helperUrl = new URL("../scripts/install-tui-mode-setting.mjs", import.meta.url);
const { installTuiModeSetting } = await import(helperUrl.href);

function fixture(t: { after(fn: () => void): void }, packagePath: readonly string[] = ["npm", "node_modules", "gentle-pi"]) {
	const root = mkdtempSync(join(tmpdir(), "gentle-tui-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "agent");
	const packageRoot = join(home, ...packagePath);
	mkdirSync(packageRoot, { recursive: true });
	const settings = join(home, "settings.json");
	const env = { GENTLE_PI_AGENT_HOME: home, PI_CODING_AGENT_DIR: join(root, "other-agent") };
	return { root, home, packageRoot, settings, env, options: { packageRoot, env, home: root } };
}

function link(target: string, path: string, directory = false) {
	symlinkSync(target, path, directory ? "junction" : "file");
}

for (const [name, packagePath] of [
	["npm", ["npm", "node_modules", "gentle-pi"]],
	["Pi Git", ["git", "github.com", "Gentleman-Programming", "gentle-pi"]],
] as const) {
	test(`recognized global ${name} installation persists fullscreen and preserves other settings`, async (t) => {
		const f = fixture(t, packagePath);
		writeFileSync(f.settings, JSON.stringify({ tuiMode: "regular", theme: "rose", nested: { enabled: false } }));
		assert.deepEqual(await installTuiModeSetting(f.options), { changed: true, recognized: true });
		assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")), { tuiMode: "fullscreen", theme: "rose", nested: { enabled: false } });
	});
}

for (const initial of [undefined, '{ "tuiMode": "regular", "packages": ["npm:example"] }']) {
	test(`creates or resets fullscreen: ${initial ?? "missing"}`, async (t) => {
		const f = fixture(t);
		if (initial) writeFileSync(f.settings, initial);
		assert.equal((await installTuiModeSetting(f.options)).changed, true);
		assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).tuiMode, "fullscreen");
		writeFileSync(f.settings, '{ "tuiMode": "regular", "theme": "custom" }');
		await installTuiModeSetting(f.options);
		assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).theme, "custom");
		assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).tuiMode, "fullscreen");
	});
}

test("already fullscreen preserves bytes and inode", async (t) => {
	const f = fixture(t);
	const text = '\uFEFF{ "tuiMode" : "fullscreen", "other": [1, null] }\n';
	writeFileSync(f.settings, text);
	const before = lstatSync(f.settings);
	assert.equal((await installTuiModeSetting(f.options)).changed, false);
	assert.equal(readFileSync(f.settings, "utf8"), text);
	assert.equal(lstatSync(f.settings).ino, before.ino);
	assert.deepEqual(readdirSync(f.home).sort(), ["npm", "settings.json"]);
});

for (const name of ["GENTLE_PI_AGENT_HOME", "PI_CODING_AGENT_DIR", "default"]) {
	test(`agent-home precedence: ${name}`, async (t) => {
		const f = fixture(t);
		const home = name === "default" ? join(f.root, ".pi", "agent") : f.home;
		const packageRoot = join(home, "npm", "node_modules", "gentle-pi");
		mkdirSync(packageRoot, { recursive: true });
		const env = name === "default" ? {} : name === "PI_CODING_AGENT_DIR" ? { PI_CODING_AGENT_DIR: home } : f.env;
		await installTuiModeSetting({ packageRoot, env, home: f.root });
		assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).tuiMode, "fullscreen");
		assert.equal(existsSync(join(f.env.PI_CODING_AGENT_DIR, "settings.json")), false);
	});
}

for (const relative of [
	"project/.pi/npm/node_modules/gentle-pi",
	"project/.pi/git/github.com/Gentleman-Programming/gentle-pi",
	"consumer/node_modules/gentle-pi",
	"checkout",
	"agent/git/github.com/gentle-pi",
	"temporary/npm/node_modules/gentle-pi",
	"store/.pnpm/gentle-pi/node_modules/gentle-pi",
]) {
	test(`unowned install is untouched: ${relative}`, async (t) => {
		const f = fixture(t);
		const packageRoot = join(f.root, relative);
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(f.settings, '{"tuiMode":"regular"}');
		assert.deepEqual(await installTuiModeSetting({ ...f.options, packageRoot }), { changed: false, recognized: false });
		assert.equal(readFileSync(f.settings, "utf8"), '{"tuiMode":"regular"}');
		assert.equal(existsSync(join(f.root, "project", ".pi", "settings.json")), false);
	});
}

for (const packagePath of [
	["git", "gitlab.com", "Gentleman-Programming", "gentle-pi"],
	["git", "github.com", "Other-Organization", "gentle-pi"],
	["git", "github.com", "Gentleman-Programming", "other-pi"],
]) {
	test(`unowned global Pi Git install is untouched: ${packagePath.join("/")}`, async (t) => {
		const f = fixture(t);
		const packageRoot = join(f.home, ...packagePath);
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(f.settings, '{"tuiMode":"regular"}');
		assert.deepEqual(await installTuiModeSetting({ ...f.options, packageRoot }), { changed: false, recognized: false });
		assert.equal(readFileSync(f.settings, "utf8"), '{"tuiMode":"regular"}');
	});
}

test("missing configured agent home is a no-op", async (t) => {
	const f = fixture(t);
	assert.equal((await installTuiModeSetting({ ...f.options, env: { GENTLE_PI_AGENT_HOME: join(f.root, "absent") } })).recognized, false);
});

for (const [name, packagePath] of [
	["npm", ["npm", "node_modules", "gentle-pi"]],
	["Pi Git", ["git", "github.com", "Gentleman-Programming", "gentle-pi"]],
] as const) {
	test(`global ${name} package symlink into a store is not ownership`, async (t) => {
		const f = fixture(t);
		const home = join(f.root, "linked-agent");
		const packageRoot = join(home, ...packagePath);
		mkdirSync(join(packageRoot, ".."), { recursive: true });
		link(f.packageRoot, packageRoot, true);
		assert.equal((await installTuiModeSetting({ packageRoot, env: { GENTLE_PI_AGENT_HOME: home }, home: f.root })).recognized, false);
		assert.equal(existsSync(join(home, "settings.json")), false);
	});
}

test("canonical agent-home alias is supported", async (t) => {
	const f = fixture(t);
	const alias = join(f.root, "alias");
	link(f.home, alias, true);
	await installTuiModeSetting({ ...f.options, env: { GENTLE_PI_AGENT_HOME: alias } });
	assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).tuiMode, "fullscreen");
});

for (const text of ["{broken", "[]", "null", "false", "42", '"string"', ""]) {
	test(`invalid settings remain unchanged: ${text}`, async (t) => {
		const f = fixture(t);
		writeFileSync(f.settings, text);
		await assert.rejects(installTuiModeSetting(f.options));
		assert.equal(readFileSync(f.settings, "utf8"), text);
		assert.deepEqual(readdirSync(f.home).sort(), ["npm", "settings.json"]);
	});
}

for (const kind of ["directory", "symlink", "dangling"]) {
	test(`rejects nonregular settings: ${kind}`, async (t) => {
		const f = fixture(t);
		const target = join(f.root, "target.json");
		if (kind === "directory") mkdirSync(f.settings);
		else {
			if (kind === "symlink") writeFileSync(target, "{}");
			link(target, f.settings);
		}
		await assert.rejects(installTuiModeSetting(f.options), /regular/);
		assert.equal(kind === "directory" ? lstatSync(f.settings).isDirectory() : lstatSync(f.settings).isSymbolicLink(), true);
		if (kind === "symlink") assert.equal(readFileSync(target, "utf8"), "{}");
		assert.equal(existsSync(`${f.settings}.lock`), false);
	});
}

test("preserves existing permissions and creates private new settings", { skip: process.platform === "win32" }, async (t) => {
	const f = fixture(t);
	await installTuiModeSetting(f.options);
	assert.equal(lstatSync(f.settings).mode & 0o777, 0o600);
	writeFileSync(f.settings, "{}");
	chmodSync(f.settings, 0o640);
	await installTuiModeSetting(f.options);
	assert.equal(lstatSync(f.settings).mode & 0o777, 0o640);
});

test("cooperative concurrent installers serialize without artifacts", async (t) => {
	const f = fixture(t);
	const results = await Promise.all(Array.from({ length: 6 }, () => installTuiModeSetting(f.options)));
	assert.equal(results.filter((result) => result.changed).length, 1);
	assert.deepEqual(readdirSync(f.home).sort(), ["npm", "settings.json"]);
});

test("Pi proper-lockfile contention is bounded and never steals the lock", async (t) => {
	const f = fixture(t);
	writeFileSync(f.settings, '{"theme":"kept"}');
	const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const lockfile = piRequire("proper-lockfile");
	const release = lockfile.lockSync(f.settings, { realpath: false });
	try {
		await assert.rejects(installTuiModeSetting(f.options), /lock is busy/);
		assert.equal(readFileSync(f.settings, "utf8"), '{"theme":"kept"}');
		assert.equal(existsSync(`${f.settings}.lock`), true);
	} finally { release(); }
	await installTuiModeSetting(f.options);
	assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).theme, "kept");
});

test("Pi's later packages-only save retains persisted fullscreen", async (t) => {
	const f = fixture(t);
	writeFileSync(f.settings, '{"tuiMode":"regular"}');
	const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const manager = SettingsManager.create(f.root, f.home);
	await installTuiModeSetting(f.options);
	manager.setPackages(["npm:gentle-pi"]);
	await manager.flush();
	assert.deepEqual(manager.drainErrors(), []);
	assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")), { tuiMode: "fullscreen", packages: ["npm:gentle-pi"] });
	manager.setTuiMode("regular");
	await manager.flush();
	assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).tuiMode, "regular");
});

for (const [name, packagePath] of [
	["npm", ["npm", "node_modules", "gentle-pi"]],
	["Pi Git", ["git", "github.com", "Gentleman-Programming", "gentle-pi"]],
] as const) {
	test(`symlinked ${name} ancestor cannot grant settings ownership`, async (t) => {
		const f = fixture(t);
		const home = join(f.root, "unsafe-agent");
		mkdirSync(home);
		mkdirSync(join(f.home, ...packagePath), { recursive: true });
		link(join(f.home, packagePath[0]), join(home, packagePath[0]), true);
		const result = await installTuiModeSetting({ packageRoot: join(home, ...packagePath), env: { GENTLE_PI_AGENT_HOME: home }, home: f.root });
		assert.equal(result.recognized, false);
		assert.equal(existsSync(join(home, "settings.json")), false);
		assert.equal(existsSync(f.settings), false);
	});
}

test("waiting installer rereads another cooperative writer's settings", async (t) => {
	const f = fixture(t);
	writeFileSync(f.settings, "{}");
	const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const release = piRequire("proper-lockfile").lockSync(f.settings, { realpath: false });
	const installing = installTuiModeSetting(f.options);
	writeFileSync(f.settings, '{"theme":"concurrent"}');
	release();
	await installing;
	assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")), { theme: "concurrent", tuiMode: "fullscreen" });
});

for (const fault of ["write", "rename", "concurrent-change"]) {
	test(`atomic update preserves original or concurrent settings on ${fault}`, (t) => {
		const f = fixture(t);
		const original = '{"theme":"original"}';
		writeFileSync(f.settings, original);
		// Isolate built-in fault injection in a child; no production test hooks.
		const code = `
			import fs from 'node:fs';
			import { syncBuiltinESMExports } from 'node:module';
			const originalWrite = fs.writeFileSync;
			const originalSync = fs.fsyncSync;
			const fault = ${JSON.stringify(fault)};
			if (fault === 'write') fs.writeFileSync = () => { throw new Error('injected write failure'); };
			if (fault === 'rename') fs.renameSync = () => { throw new Error('injected rename failure'); };
			if (fault === 'concurrent-change') fs.fsyncSync = (fd) => {
				originalSync(fd);
				originalWrite(${JSON.stringify(f.settings)}, '{"theme":"concurrent"}');
			};
			syncBuiltinESMExports();
			const { installTuiModeSetting } = await import(${JSON.stringify(helperUrl.href)});
			try { await installTuiModeSetting(${JSON.stringify(f.options)}); process.exitCode = 2; }
			catch (error) { console.error(error.message); process.exitCode = 1; }
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", env: { ...process.env, ...f.env } });
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, fault === "concurrent-change" ? /changed concurrently/ : /injected/);
		assert.equal(readFileSync(f.settings, "utf8"), fault === "concurrent-change" ? '{"theme":"concurrent"}' : original);
		assert.deepEqual(readdirSync(f.home).sort(), ["npm", "settings.json"]);
	});
}

type PostinstallRoute = "skip" | "success" | "failure";

function writePostinstallFixture(f: ReturnType<typeof fixture>, route: PostinstallRoute) {
	const scripts = join(f.packageRoot, "scripts");
	mkdirSync(scripts);
	copyFileSync(helperUrl, join(scripts, "install-tui-mode-setting.mjs"));
	copyFileSync(new URL("../scripts/install-gentle-ai.mjs", import.meta.url), join(scripts, "install-gentle-ai.mjs"));
	const installer = route === "failure"
		? 'throw new Error("native failed")'
		: route === "skip"
			? 'throw new Error("skip fixture native installer was invoked")'
			: 'return { installed: true, binaryPath: "fixture" }';
	writeFileSync(join(scripts, "gentle-ai-installer.mjs"), `export const INSTALLER_VERSION = "test"; export async function installGentleAi() { ${installer}; }`);
	return scripts;
}

function runPostinstall(f: ReturnType<typeof fixture>, route: PostinstallRoute) {
	const scripts = writePostinstallFixture(f, route);
	return spawnSync(process.execPath, [join(scripts, "install-gentle-ai.mjs")], {
		encoding: "utf8", env: { ...process.env, ...f.env, GENTLE_PI_SKIP_GENTLE_AI_INSTALL: route === "skip" ? "1" : "0" },
	});
}

function assertPostinstallLifecycle(f: ReturnType<typeof fixture>, route: PostinstallRoute, result: ReturnType<typeof runPostinstall>, settingsExists = route !== "failure") {
	assert.equal(result.status, route === "failure" ? 1 : 0, result.stderr);
	assert.equal(existsSync(f.settings), settingsExists);
	if (route === "failure") assert.match(result.stderr, /gentle-pi could not install its package-local Gentle AI vtest binary: native failed/);
	else {
		assert.doesNotMatch(result.stderr, /skip fixture native installer was invoked/);
		assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).tuiMode, "fullscreen");
	}
}

for (const [name, packagePath] of [
	["npm", ["npm", "node_modules", "gentle-pi"]],
	["Pi Git", ["git", "github.com", "Gentleman-Programming", "gentle-pi"]],
] as const) {
	for (const route of ["skip", "success", "failure"] as const) {
		test(`${name} postinstall lifecycle: ${route}`, (t) => {
			const f = fixture(t, packagePath);
			const result = runPostinstall(f, route);
			assertPostinstallLifecycle(f, route, result);
			if (route === "failure") {
				const existing = fixture(t, packagePath);
				const original = '{"tuiMode":"regular","theme":"kept"}';
				writeFileSync(existing.settings, original);
				const existingResult = runPostinstall(existing, route);
				assertPostinstallLifecycle(existing, route, existingResult, true);
				assert.equal(readFileSync(existing.settings, "utf8"), original);
			}
		});
	}
}
