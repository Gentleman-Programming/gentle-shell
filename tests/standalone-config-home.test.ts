import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { gentleAiDevBinaryRegistrationPath, gentleAiIsolationEnv } from "../lib/gentle-ai-binary.ts";
import { GENTLE_SHELL_CONFIG_HOME_ENV, setBundledInstallForTesting } from "../lib/gentle-shell-bundled.ts";
import { buildPiInvocation, migrateStandaloneConfig, standaloneConfigHome, type ResolvedHome } from "../lib/gentle-shell-launcher.ts";
import { createActiveProfileReader } from "../extensions/gentle-shell.ts";
import { readBannerConfig } from "../extensions/startup-banner.ts";

// #2201 (S1, S1a): the standalone launcher's isolated home keeps Gentle Shell's
// config next to its agent dir (~/.gentle-shell/gentle-ai), not in the shared
// ~/.pi/gentle-ai that a Pi install with gentle-pi also uses.

const posixOnly = { skip: process.platform === "win32" };
const binPath = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const MARKER = "GENTLE_SHELL_CONFIG_HOME";

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "standalone-config-home-")));
}

function launch(home: ResolvedHome, baseEnv: Record<string, string | undefined> = {}, bundled = false) {
	return buildPiInvocation({
		runtime: { kind: "path", command: "fake-pi", args: [] },
		home,
		packageRoot: "/pkg",
		declaration: undefined,
		takeOver: false,
		otherPackagePaths: [],
		passthrough: [],
		baseEnv,
		homedir: "/os-home",
		cwd: "/cwd",
		bundled,
	});
}

function isolated(dir = "/os-home/.gentle-shell/agent"): { home: ResolvedHome } {
	return { home: { mode: "isolated", dir, source: "default" } };
}

test("the marker is exported under its launcher-owned name, never GENTLE_PI_CONFIG_HOME", () => {
	assert.equal(GENTLE_SHELL_CONFIG_HOME_ENV, MARKER);
});

test("config home precedence: explicit GENTLE_PI_CONFIG_HOME > launcher marker > ~/.pi/gentle-ai; empty counts as unset", () => {
	const home = scratch();
	const env = (extra: Record<string, string>) => ({ HOME: home, USERPROFILE: home, ...extra });
	const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		assert.equal(gentlePiConfigHome(env({})), join(home, ".pi", "gentle-ai"));
		assert.equal(gentlePiConfigHome(env({ [MARKER]: "/shell/gentle-ai" })), "/shell/gentle-ai");
		assert.equal(gentlePiConfigHome(env({ [MARKER]: "/shell/gentle-ai", GENTLE_PI_CONFIG_HOME: "/explicit" })), "/explicit");
		assert.equal(gentlePiConfigHome(env({ [MARKER]: "/shell/gentle-ai", GENTLE_PI_CONFIG_HOME: "" })), "/shell/gentle-ai");
		assert.equal(gentlePiConfigHome(env({ [MARKER]: "" })), join(home, ".pi", "gentle-ai"));
		assert.equal(gentlePiConfigHome(env({ [MARKER]: "relative/gentle-ai" })), join(home, ".pi", "gentle-ai"), "a relative marker is ignored");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a bundled prefix still outranks the explicit override and the marker", (t) => {
	const prefix = scratch();
	setBundledInstallForTesting({ root: prefix });
	t.after(() => setBundledInstallForTesting(undefined));
	assert.equal(
		gentlePiConfigHome({ GENTLE_SHELL_PREFIX: prefix, GENTLE_PI_CONFIG_HOME: "/explicit", [MARKER]: "/shell/gentle-ai" }),
		join(prefix, "config", "gentle-ai"),
	);
});

test("the banner and profile readers follow the same resolver, including an empty GENTLE_PI_CONFIG_HOME", async (t) => {
	const root = scratch();
	const config = join(root, "shell", "gentle-ai");
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "banner.json"), JSON.stringify({ showTextLogo: false }));
	writeFileSync(join(config, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "fast", profiles: { fast: {} } }));
	const previous = { marker: process.env[MARKER], explicit: process.env.GENTLE_PI_CONFIG_HOME };
	process.env[MARKER] = config;
	process.env.GENTLE_PI_CONFIG_HOME = "";
	t.after(() => {
		if (previous.marker === undefined) delete process.env[MARKER];
		else process.env[MARKER] = previous.marker;
		if (previous.explicit === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous.explicit;
	});
	assert.equal((await readBannerConfig()).showTextLogo, false);
	assert.equal(createActiveProfileReader({ [MARKER]: config, GENTLE_PI_CONFIG_HOME: "" })(), "fast");
});

test("the launcher gives Pi the marker only in its isolated home", () => {
	const isolatedLaunch = launch(isolated().home);
	assert.equal(isolatedLaunch.env[MARKER], "/os-home/.gentle-shell/gentle-ai");
	assert.equal(isolatedLaunch.env.GENTLE_PI_CONFIG_HOME, undefined, "GENTLE_PI_CONFIG_HOME is never exported to Pi");
	assert.equal(standaloneConfigHome(isolated().home), "/os-home/.gentle-shell/gentle-ai");
	// A custom GENTLE_SHELL_HOME's parent may be anyone's folder (~/myagent ->
	// ~/gentle-ai), so only a .gentle-shell/agent home gets its own config folder.
	assert.equal(launch(isolated("/custom/shell/agent").home).env[MARKER], undefined, "no marker beside a custom GENTLE_SHELL_HOME");
	assert.equal(standaloneConfigHome(isolated("/os-home/myagent").home), undefined, "never the generic ~/gentle-ai");
	assert.equal(standaloneConfigHome(isolated("/data/.gentle-shell/agent").home), "/data/.gentle-shell/gentle-ai");
});

test("--link, a custom --home and a bundled launch keep today's config home and drop an inherited marker", () => {
	const inherited = { [MARKER]: "/outer/gentle-ai" };
	const link = launch({ mode: "link", dir: "/os-home/.pi/agent", source: "flag" }, inherited);
	const path = launch({ mode: "path", dir: "/custom/home", source: "flag" }, inherited);
	const bundled = launch(isolated().home, inherited, true);
	for (const invocation of [link, path, bundled]) assert.equal(MARKER in invocation.env, false);
	assert.equal(standaloneConfigHome({ mode: "link", dir: "/os-home/.pi/agent", source: "flag" }), undefined);
	assert.equal(standaloneConfigHome({ mode: "path", dir: "/custom/home", source: "flag" }), undefined);
});

test("Gentle AI processes started from a standalone isolated session get the bundled-style config pair", () => {
	const env = gentleAiIsolationEnv({ PATH: "/bin", [MARKER]: "/os-home/.gentle-shell/gentle-ai" });
	assert.equal(env.GENTLE_AI_PI_CONFIG_DIR, "/os-home/.gentle-shell/gentle-ai");
	assert.equal(env.GENTLE_PI_CONFIG_HOME, "/os-home/.gentle-shell", "Gentle AI 4.0.0 reads it as the parent of its gentle-ai folder");
	assert.equal(env.PATH, "/bin");
	assert.equal(env.GENTLE_AI_HOME, undefined, "standalone keeps Gentle AI's own state where it was");
});

test("without the marker, or with an explicit GENTLE_PI_CONFIG_HOME, Gentle AI's environment is unchanged", () => {
	const plain = { PATH: "/bin" };
	assert.equal(gentleAiIsolationEnv(plain), plain);
	const explicit = { PATH: "/bin", GENTLE_PI_CONFIG_HOME: "/explicit", [MARKER]: "/os-home/.gentle-shell/gentle-ai" };
	assert.equal(gentleAiIsolationEnv(explicit), explicit);
});

test("the main-channel dev-binary registration ignores the marker and an empty GENTLE_PI_CONFIG_HOME", () => {
	assert.equal(
		gentleAiDevBinaryRegistrationPath({ env: { [MARKER]: "/os-home/.gentle-shell/gentle-ai", GENTLE_PI_CONFIG_HOME: "" }, home: "/os-home" }),
		join("/os-home", ".pi", "gentle-ai", "dev-binary.json"),
	);
	assert.equal(gentleAiDevBinaryRegistrationPath({ env: { GENTLE_PI_CONFIG_HOME: "/explicit" }, home: "/os-home" }), join("/explicit", "dev-binary.json"));
});

// --- migration -----------------------------------------------------------------

// The same real filesystem bin/gentle-shell.mjs gives migrateStandaloneConfig.
const fs = {
	kind: (path: string) => {
		try {
			const stat = lstatSync(path);
			return stat.isDirectory() ? "dir" as const : stat.isFile() ? "file" as const : "other" as const;
		} catch {
			return "missing" as const;
		}
	},
	list: (path: string) => readdirSync(path),
	mkdirPrivate: (path: string) => { mkdirSync(path, { recursive: true, mode: 0o700 }); },
	copyNew: (from: string, to: string) => copyFileSync(from, to, constants.COPYFILE_EXCL),
};

function migrationWorld() {
	const root = scratch();
	const source = join(root, "home", ".pi", "gentle-ai");
	const target = join(root, "home", ".gentle-shell", "gentle-ai");
	mkdirSync(source, { recursive: true });
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(join(source, "banner.json"), "{\"showTextLogo\":false}\n");
	writeFileSync(join(source, "profiles.json"), "{\"active\":\"fast\"}\n");
	writeFileSync(join(source, "dev-binary.json"), "{}\n");
	writeFileSync(join(source, "channel.json"), "{}\n");
	mkdirSync(join(source, "main", "gentle-ai"), { recursive: true });
	writeFileSync(join(source, "main", "gentle-ai", "marker"), "x");
	return { root, source, target };
}

function snapshotTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) for (const [key, value] of Object.entries(snapshotTree(path))) out[join(name, key)] = value;
		else out[name] = stat.isSymbolicLink() ? "symlink" : `${stat.mode}:${stat.mtimeMs}:${readFileSync(path, "utf8")}`;
	}
	return out;
}

test("migration copies the regular files once into a new 0700 folder and never changes the source", posixOnly, () => {
	const w = migrationWorld();
	symlinkSync(join(w.source, "banner.json"), join(w.source, "linked.json"));
	const before = snapshotTree(w.source);
	const result = migrateStandaloneConfig({ source: w.source, target: w.target, fs });
	assert.deepEqual(readdirSync(w.target).sort(), ["banner.json", "profiles.json"]);
	assert.equal(readFileSync(join(w.target, "banner.json"), "utf8"), "{\"showTextLogo\":false}\n");
	assert.equal(statSync(w.target).mode & 0o777, 0o700);
	assert.deepEqual(snapshotTree(w.source), before);
	assert.equal(result.lines.length, 1);
	assert.match(result.lines[0], new RegExp(`${w.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${w.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("migration skips the main-channel files and does nothing once the folder exists", posixOnly, () => {
	const w = migrationWorld();
	migrateStandaloneConfig({ source: w.source, target: w.target, fs });
	assert.equal(existsSync(join(w.target, "dev-binary.json")), false);
	assert.equal(existsSync(join(w.target, "channel.json")), false);
	assert.equal(existsSync(join(w.target, "main")), false);
	writeFileSync(join(w.target, "banner.json"), "{\"color\":\"cyan\"}\n");
	writeFileSync(join(w.source, "vim.json"), "{}\n");
	const again = migrateStandaloneConfig({ source: w.source, target: w.target, fs });
	assert.deepEqual(again.lines, []);
	assert.equal(readFileSync(join(w.target, "banner.json"), "utf8"), "{\"color\":\"cyan\"}\n", "never overwrites");
	assert.equal(existsSync(join(w.target, "vim.json")), false, "runs once");
});

test("without ~/.pi/gentle-ai the migration only creates the empty 0700 folder, silently", posixOnly, () => {
	const root = scratch();
	const target = join(root, ".gentle-shell", "gentle-ai");
	const result = migrateStandaloneConfig({ source: join(root, ".pi", "gentle-ai"), target, fs });
	assert.deepEqual(result.lines, []);
	assert.deepEqual(readdirSync(target), []);
	assert.equal(statSync(target).mode & 0o777, 0o700);
});

test("a failed copy warns and keeps whatever was copied; it never throws", posixOnly, () => {
	const w = migrationWorld();
	chmodSync(join(w.source, "profiles.json"), 0o000);
	if (spawnSync("cat", [join(w.source, "profiles.json")]).status === 0) return; // running as root: nothing is unreadable
	const result = migrateStandaloneConfig({ source: w.source, target: w.target, fs });
	chmodSync(join(w.source, "profiles.json"), 0o644);
	assert.deepEqual(readdirSync(w.target), ["banner.json"]);
	assert.equal(result.lines.length, 1);
	assert.match(result.lines[0], /could not copy/);
	assert.match(result.lines[0], /profiles\.json/);
	const blocked = scratch();
	writeFileSync(join(blocked, "not-a-dir"), "");
	const failed = migrateStandaloneConfig({ source: w.source, target: join(blocked, "not-a-dir", "gentle-ai"), fs });
	assert.equal(failed.lines.length, 1);
	assert.match(failed.lines[0], /could not/);
});

// --- the real launcher -----------------------------------------------------------

function writeFakePi(path: string) {
	writeFileSync(path, [
		"#!/usr/bin/env node",
		"const args = process.argv.slice(2);",
		"if (args.includes('--version')) { console.log('1.2.0'); process.exit(0); }",
		`console.log(JSON.stringify({ marker: process.env.${MARKER} ?? null, explicit: process.env.GENTLE_PI_CONFIG_HOME ?? null }));`,
		"",
	].join("\n"));
	chmodSync(path, 0o755);
}

function writeFakeGentleAi(path: string) {
	writeFileSync(path, [
		"#!/usr/bin/env node",
		"import { mkdirSync, writeFileSync } from 'node:fs';",
		"import { homedir } from 'node:os';",
		"import { join } from 'node:path';",
		"for (const dir of [process.env.GENTLE_AI_PI_CONFIG_DIR, join(homedir(), '.pi', 'gentle-ai')]) {",
		"  if (!dir) continue;",
		"  mkdirSync(dir, { recursive: true });",
		"  writeFileSync(join(dir, 'persona.json'), JSON.stringify({ mode: 'gentleman' }));",
		"}",
		"process.stdout.write(JSON.stringify({ dir: process.env.GENTLE_AI_PI_CONFIG_DIR ?? null, parent: process.env.GENTLE_PI_CONFIG_HOME ?? null }) + '\\n');",
		"",
	].join("\n"));
	chmodSync(path, 0o755);
}

function launcherWorld() {
	const root = scratch();
	const home = join(root, "home");
	mkdirSync(join(home, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(home, ".pi", "gentle-ai", "banner.json"), "{\"showTextLogo\":false}\n");
	const pi = join(root, "fake-pi.mjs");
	writeFakePi(pi);
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, GENTLE_SHELL_PI: pi, GENTLE_SHELL_NO_AUTO_SETUP: "1" };
	const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", env: { ...env, ...extra } });
	return { root, home, env, run, shellConfig: join(home, ".gentle-shell", "gentle-ai") };
}

test("a standalone isolated launch migrates ~/.pi/gentle-ai and points Pi at ~/.gentle-shell/gentle-ai", posixOnly, () => {
	const w = launcherWorld();
	const result = w.run(["list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), { marker: w.shellConfig, explicit: null });
	assert.equal(readFileSync(join(w.shellConfig, "banner.json"), "utf8"), "{\"showTextLogo\":false}\n");
	assert.equal(readFileSync(join(w.home, ".pi", "gentle-ai", "banner.json"), "utf8"), "{\"showTextLogo\":false}\n");
	assert.equal(result.stderr.split("\n").filter((line) => line.includes(w.shellConfig) && line.includes("copied")).length, 1);
	const second = w.run(["list"]);
	assert.doesNotMatch(second.stderr, /copied/);
});

test("--link launches keep ~/.pi/gentle-ai: no marker and no migration", posixOnly, () => {
	const w = launcherWorld();
	mkdirSync(join(w.home, ".pi", "agent"), { recursive: true });
	const result = w.run(["--link", "list"], { [MARKER]: "/outer/gentle-ai" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), { marker: null, explicit: null });
	assert.equal(existsSync(w.shellConfig), false);
});

test("an explicit GENTLE_PI_CONFIG_HOME still wins: it reaches Pi and no migration runs", posixOnly, () => {
	const w = launcherWorld();
	const result = w.run(["list"], { GENTLE_PI_CONFIG_HOME: join(w.root, "explicit") });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)!).explicit, join(w.root, "explicit"));
	assert.equal(existsSync(w.shellConfig), false);
});

test("standalone setup gives Gentle AI the config pair and keeps both persona files unchanged", posixOnly, () => {
	const w = launcherWorld();
	const gentleAi = join(w.root, "fake-gentle-ai.mjs");
	writeFakeGentleAi(gentleAi);
	writeFileSync(join(w.home, ".pi", "gentle-ai", "persona.json"), "{\"mode\":\"neutral\"}");
	const result = w.run(["setup"], { GENTLE_SHELL_GENTLE_AI_BIN: gentleAi });
	assert.equal(result.status, 0, result.stderr);
	const seen = JSON.parse(result.stdout.split("\n").find((line) => line.includes("\"dir\""))!);
	assert.deepEqual(seen, { dir: w.shellConfig, parent: join(w.home, ".gentle-shell") });
	assert.equal(readFileSync(join(w.home, ".pi", "gentle-ai", "persona.json"), "utf8"), "{\"mode\":\"neutral\"}");
	assert.equal(readFileSync(join(w.shellConfig, "persona.json"), "utf8"), "{\"mode\":\"neutral\"}", "the migrated copy is restored too");
});
