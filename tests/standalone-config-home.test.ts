import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { drakoncPiConfigHome } from "../lib/agent-home.ts";
import { drakoncAiDevBinaryRegistrationPath, drakoncAiIsolationEnv } from "../lib/drakonc-ai-binary.ts";
import { DRAKONC_SHELL_CONFIG_HOME_ENV, resolveDrakoncPiConfigHome, setBundledInstallForTesting } from "../lib/drakonc-shell-bundled.ts";
import { buildPiInvocation, migrateStandaloneConfig, standaloneConfigHome, type ResolvedHome } from "../lib/drakonc-shell-launcher.ts";
import { createActiveProfileReader } from "../extensions/drakonc-shell.ts";
import { readBannerConfig } from "../extensions/startup-banner.ts";

// #2201 (S1, S1a): the standalone launcher's isolated home keeps Drakonc Shell's
// config next to its agent dir (~/.drakonc-shell/drakonc-ai), not in the shared
// ~/.pi/drakonc-ai that a Pi install with drakonc-pi also uses. Every reader
// falls back to that folder, with or without the launcher marker, and an
// existing ~/.pi/drakonc-ai is only ever read (D3).

const posixOnly = { skip: process.platform === "win32" };
const binPath = fileURLToPath(new URL("../bin/drakonc-shell.mjs", import.meta.url));
const MARKER = "DRAKONC_SHELL_CONFIG_HOME";

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

function isolated(dir = "/os-home/.drakonc-shell/agent"): { home: ResolvedHome } {
	return { home: { mode: "isolated", dir, source: "default" } };
}

test("the marker is exported under its launcher-owned name, never DRAKONC_PI_CONFIG_HOME", () => {
	assert.equal(DRAKONC_SHELL_CONFIG_HOME_ENV, MARKER);
});

test("config home precedence: explicit DRAKONC_PI_CONFIG_HOME > launcher marker > ~/.drakonc-shell/drakonc-ai; empty counts as unset", () => {
	const home = scratch();
	const env = (extra: Record<string, string>) => ({ HOME: home, USERPROFILE: home, ...extra });
	const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		assert.equal(drakoncPiConfigHome(env({})), join(home, ".drakonc-shell", "drakonc-ai"));
		assert.equal(drakoncPiConfigHome(env({ [MARKER]: "/shell/drakonc-ai" })), "/shell/drakonc-ai");
		assert.equal(drakoncPiConfigHome(env({ [MARKER]: "/shell/drakonc-ai", DRAKONC_PI_CONFIG_HOME: "/explicit" })), "/explicit");
		assert.equal(drakoncPiConfigHome(env({ [MARKER]: "/shell/drakonc-ai", DRAKONC_PI_CONFIG_HOME: "" })), "/shell/drakonc-ai");
		assert.equal(drakoncPiConfigHome(env({ [MARKER]: "" })), join(home, ".drakonc-shell", "drakonc-ai"));
		assert.equal(drakoncPiConfigHome(env({ [MARKER]: "relative/drakonc-ai" })), join(home, ".drakonc-shell", "drakonc-ai"), "a relative marker is ignored");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// D3: the default config folder is Drakonc Shell's own, and no reader creates
// or touches the legacy ~/.pi/drakonc-ai (only the documented one-time import
// reads it). A new HOME therefore never grows a ~/.pi folder of ours.
test("a new HOME resolves and writes config inside ~/.drakonc-shell without creating ~/.pi/drakonc-ai", (t) => {
	const root = scratch();
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const legacy = join(home, ".pi", "drakonc-ai");
	assert.equal(resolveDrakoncPiConfigHome({}, home), join(home, ".drakonc-shell", "drakonc-ai"));
	// What every writer does: create its folder and write its file.
	const config = resolveDrakoncPiConfigHome({}, home);
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "banner.json"), JSON.stringify({ showTextLogo: false }));
	assert.equal(existsSync(config), true);
	assert.equal(existsSync(legacy), false, "~/.pi/drakonc-ai is never created");
});

test("a seeded legacy ~/.pi/drakonc-ai stays identical, contents and dates, after config is resolved and written", (t) => {
	const root = scratch();
	const home = join(root, "home");
	const legacy = join(home, ".pi", "drakonc-ai");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "profiles.json"), '{"active":"fast"}\n');
	writeFileSync(join(legacy, "persona.json"), '{"mode":"neutral"}\n');
	const before = snapshotTree(legacy);
	const config = resolveDrakoncPiConfigHome({}, home);
	assert.equal(config, join(home, ".drakonc-shell", "drakonc-ai"));
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "profiles.json"), '{"active":"other"}\n');
	assert.deepEqual(snapshotTree(legacy), before, "reading and writing the new folder leaves the old one untouched");
});

test("a bundled prefix still outranks the explicit override and the marker", (t) => {
	const prefix = scratch();
	setBundledInstallForTesting({ root: prefix });
	t.after(() => setBundledInstallForTesting(undefined));
	assert.equal(
		drakoncPiConfigHome({ DRAKONC_SHELL_PREFIX: prefix, DRAKONC_PI_CONFIG_HOME: "/explicit", [MARKER]: "/shell/drakonc-ai" }),
		join(prefix, "config", "drakonc-ai"),
	);
});

test("the banner and profile readers follow the same resolver, including an empty DRAKONC_PI_CONFIG_HOME", async (t) => {
	const root = scratch();
	const config = join(root, "shell", "drakonc-ai");
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "banner.json"), JSON.stringify({ showTextLogo: false }));
	writeFileSync(join(config, "profiles.json"), JSON.stringify({ kind: "drakonc-pi.agent_model_profiles", version: 1, active: "fast", profiles: { fast: {} } }));
	const previous = { marker: process.env[MARKER], explicit: process.env.DRAKONC_PI_CONFIG_HOME };
	process.env[MARKER] = config;
	process.env.DRAKONC_PI_CONFIG_HOME = "";
	t.after(() => {
		if (previous.marker === undefined) delete process.env[MARKER];
		else process.env[MARKER] = previous.marker;
		if (previous.explicit === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previous.explicit;
	});
	assert.equal((await readBannerConfig()).showTextLogo, false);
	assert.equal(createActiveProfileReader({ [MARKER]: config, DRAKONC_PI_CONFIG_HOME: "" })(), "fast");
});

test("the launcher gives Pi the marker only in its isolated home", () => {
	const isolatedLaunch = launch(isolated().home);
	assert.equal(isolatedLaunch.env[MARKER], "/os-home/.drakonc-shell/drakonc-ai");
	assert.equal(isolatedLaunch.env.DRAKONC_PI_CONFIG_HOME, undefined, "DRAKONC_PI_CONFIG_HOME is never exported to Pi");
	assert.equal(standaloneConfigHome(isolated().home), "/os-home/.drakonc-shell/drakonc-ai");
	// A custom DRAKONC_SHELL_HOME's parent may be anyone's folder (~/myagent ->
	// ~/drakonc-ai), so only a .drakonc-shell/agent home gets its own config folder.
	assert.equal(launch(isolated("/custom/shell/agent").home).env[MARKER], undefined, "no marker beside a custom DRAKONC_SHELL_HOME");
	assert.equal(standaloneConfigHome(isolated("/os-home/myagent").home), undefined, "never the generic ~/drakonc-ai");
	assert.equal(standaloneConfigHome(isolated("/data/.drakonc-shell/agent").home), "/data/.drakonc-shell/drakonc-ai");
});

test("--link, a custom --home and a bundled launch keep today's config home and drop an inherited marker", () => {
	const inherited = { [MARKER]: "/outer/drakonc-ai" };
	const link = launch({ mode: "link", dir: "/os-home/.pi/agent", source: "flag" }, inherited);
	const path = launch({ mode: "path", dir: "/custom/home", source: "flag" }, inherited);
	const bundled = launch(isolated().home, inherited, true);
	for (const invocation of [link, path, bundled]) assert.equal(MARKER in invocation.env, false);
	assert.equal(standaloneConfigHome({ mode: "link", dir: "/os-home/.pi/agent", source: "flag" }), undefined);
	assert.equal(standaloneConfigHome({ mode: "path", dir: "/custom/home", source: "flag" }), undefined);
});

test("Drakonc AI processes started from a standalone isolated session get the bundled-style config pair and Drakonc's own state home", () => {
	const env = drakoncAiIsolationEnv({ PATH: "/bin", [MARKER]: "/os-home/.drakonc-shell/drakonc-ai" });
	assert.equal(env.DRAKONC_AI_PI_CONFIG_DIR, "/os-home/.drakonc-shell/drakonc-ai");
	assert.equal(env.GENTLE_AI_PI_CONFIG_DIR, "/os-home/.drakonc-shell/drakonc-ai", "the pinned gentle-ai reads this name");
	assert.equal(env.DRAKONC_PI_CONFIG_HOME, "/os-home/.drakonc-shell", "Drakonc AI 4.0.0 reads it as the parent of its drakonc-ai folder");
	assert.equal(env.GENTLE_PI_CONFIG_HOME, "/os-home/.drakonc-shell", "gentle-ai appends its own folder to it, inside Drakonc's");
	assert.equal(env.PATH, "/bin");
	// S1: the isolated mode used to give no AI_HOME at all, so the pinned binary
	// fell back to ~/.gentle-ai. It now gets Drakonc's own home, under both names.
	assert.equal(env.DRAKONC_AI_HOME, join(homedir(), ".drakonc-shell", "drakonc-ai-home"));
	assert.equal(env.GENTLE_AI_HOME, env.DRAKONC_AI_HOME);
	assert.equal(env.GENTLE_AI_NO_SELF_UPDATE, "1");
});

test("without the marker, or with an explicit DRAKONC_PI_CONFIG_HOME, Drakonc AI gets no config pair but still its own home", () => {
	const plain = drakoncAiIsolationEnv({ PATH: "/bin" });
	assert.equal(plain.PATH, "/bin");
	assert.equal("DRAKONC_AI_PI_CONFIG_DIR" in plain, false);
	assert.equal("DRAKONC_PI_CONFIG_HOME" in plain, false);
	assert.equal(plain.DRAKONC_AI_HOME, join(homedir(), ".drakonc-shell", "drakonc-ai-home"));
	assert.equal(plain.DRAKONC_AI_NO_SELF_UPDATE, "1");
	const explicit = drakoncAiIsolationEnv({ PATH: "/bin", DRAKONC_PI_CONFIG_HOME: "/explicit", [MARKER]: "/os-home/.drakonc-shell/drakonc-ai" });
	assert.equal("DRAKONC_AI_PI_CONFIG_DIR" in explicit, false, "an explicit DRAKONC_PI_CONFIG_HOME keeps its meaning");
	assert.equal(explicit.DRAKONC_PI_CONFIG_HOME, "/explicit");
	assert.equal(explicit.GENTLE_AI_NO_SELF_UPDATE, "1");
});

test("the companion's isolation variables never reach Pi or its shell", () => {
	const baseEnv = { PATH: "/bin" };
	const companion = drakoncAiIsolationEnv({ ...baseEnv, [MARKER]: "/os-home/.drakonc-shell/drakonc-ai" });
	assert.equal(companion.GENTLE_AI_NO_SELF_UPDATE, "1", "the companion does get them");
	const pi = launch(isolated().home, baseEnv);
	for (const name of [
		"DRAKONC_AI_HOME",
		"GENTLE_AI_HOME",
		"DRAKONC_AI_PI_CONFIG_DIR",
		"GENTLE_AI_PI_CONFIG_DIR",
		"DRAKONC_AI_ENGRAM_BIN",
		"GENTLE_AI_ENGRAM_BIN",
		"DRAKONC_AI_NO_SELF_UPDATE",
		"GENTLE_AI_NO_SELF_UPDATE",
		"DRAKONC_PI_CONFIG_HOME",
		"GENTLE_PI_CONFIG_HOME",
	]) {
		assert.equal(name in pi.env, false, `${name} belongs to the companion run only`);
	}
	// Pi still gets the launcher-owned marker, which is not one of them.
	assert.equal(pi.env[MARKER], "/os-home/.drakonc-shell/drakonc-ai");
});

test("the main-channel dev-binary registration ignores the marker and an empty DRAKONC_PI_CONFIG_HOME", () => {
	assert.equal(
		drakoncAiDevBinaryRegistrationPath({ env: { [MARKER]: "/os-home/.drakonc-shell/drakonc-ai", DRAKONC_PI_CONFIG_HOME: "" }, home: "/os-home" }),
		join("/os-home", ".drakonc-shell", "drakonc-ai", "dev-binary.json"),
	);
	assert.equal(drakoncAiDevBinaryRegistrationPath({ env: { DRAKONC_PI_CONFIG_HOME: "/explicit" }, home: "/os-home" }), join("/explicit", "dev-binary.json"));
});

// --- migration -----------------------------------------------------------------

// The same real filesystem bin/drakonc-shell.mjs gives migrateStandaloneConfig.
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
	const source = join(root, "home", ".pi", "drakonc-ai");
	const target = join(root, "home", ".drakonc-shell", "drakonc-ai");
	mkdirSync(source, { recursive: true });
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(join(source, "banner.json"), "{\"showTextLogo\":false}\n");
	writeFileSync(join(source, "profiles.json"), "{\"active\":\"fast\"}\n");
	writeFileSync(join(source, "dev-binary.json"), "{}\n");
	writeFileSync(join(source, "channel.json"), "{}\n");
	mkdirSync(join(source, "main", "drakonc-ai"), { recursive: true });
	writeFileSync(join(source, "main", "drakonc-ai", "marker"), "x");
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

test("without ~/.pi/drakonc-ai the migration only creates the empty 0700 folder, silently", posixOnly, () => {
	const root = scratch();
	const target = join(root, ".drakonc-shell", "drakonc-ai");
	const result = migrateStandaloneConfig({ source: join(root, ".pi", "drakonc-ai"), target, fs });
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
	const failed = migrateStandaloneConfig({ source: w.source, target: join(blocked, "not-a-dir", "drakonc-ai"), fs });
	assert.equal(failed.lines.length, 1);
	assert.match(failed.lines[0], /could not/);
});

// --- the real launcher -----------------------------------------------------------

function writeFakePi(path: string) {
	writeFileSync(path, [
		"#!/usr/bin/env node",
		"const args = process.argv.slice(2);",
		"if (args.includes('--version')) { console.log('1.2.0'); process.exit(0); }",
		`console.log(JSON.stringify({ marker: process.env.${MARKER} ?? null, explicit: process.env.DRAKONC_PI_CONFIG_HOME ?? null }));`,
		"",
	].join("\n"));
	chmodSync(path, 0o755);
}

function writeFakeDrakoncAi(path: string) {
	writeFileSync(path, [
		"#!/usr/bin/env node",
		"import { mkdirSync, writeFileSync } from 'node:fs';",
		"import { homedir } from 'node:os';",
		"import { join } from 'node:path';",
		"for (const dir of [process.env.DRAKONC_AI_PI_CONFIG_DIR, join(homedir(), '.pi', 'drakonc-ai')]) {",
		"  if (!dir) continue;",
		"  mkdirSync(dir, { recursive: true });",
		"  writeFileSync(join(dir, 'persona.json'), JSON.stringify({ mode: 'drakoncman' }));",
		"}",
		"process.stdout.write(JSON.stringify({ dir: process.env.DRAKONC_AI_PI_CONFIG_DIR ?? null, parent: process.env.DRAKONC_PI_CONFIG_HOME ?? null }) + '\\n');",
		"",
	].join("\n"));
	chmodSync(path, 0o755);
}

// The pinned companion is the original gentle-ai 5.0.0, which writes its own
// persona and managed-asset record (~/.pi/gentle-ai, ~/.gentle-ai) as well as
// Drakonc's. This stub writes all four files so a test can prove each one comes
// back unchanged.
function writeFakeGentleAi(path: string) {
	writeFileSync(path, [
		"#!/usr/bin/env node",
		"import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
		"import { homedir } from 'node:os';",
		"import { join } from 'node:path';",
		"const home = homedir();",
		"for (const dir of [join(home, '.pi', 'drakonc-ai'), join(home, '.pi', 'gentle-ai')]) {",
		"  mkdirSync(dir, { recursive: true });",
		"  writeFileSync(join(dir, 'persona.json'), JSON.stringify({ mode: 'companion' }));",
		"}",
		"for (const dir of [join(home, '.drakonc-ai'), join(home, '.gentle-ai')]) {",
		"  mkdirSync(dir, { recursive: true });",
		"  const statePath = join(dir, 'state.json');",
		"  const previous = JSON.parse(readFileSync(statePath, 'utf8'));",
		"  writeFileSync(statePath, JSON.stringify({ managed_asset_digest: 'companion', installed_agents: [...previous.installed_agents, 'claude'] }) + '\\n');",
		"}",
		"process.stdout.write(JSON.stringify({ dir: process.env.GENTLE_AI_PI_CONFIG_DIR ?? null }) + '\\n');",
		"",
	].join("\n"));
	chmodSync(path, 0o755);
}

function launcherWorld() {
	const root = scratch();
	const home = join(root, "home");
	mkdirSync(join(home, ".pi", "drakonc-ai"), { recursive: true });
	writeFileSync(join(home, ".pi", "drakonc-ai", "banner.json"), "{\"showTextLogo\":false}\n");
	const pi = join(root, "fake-pi.mjs");
	writeFakePi(pi);
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DRAKONC_SHELL_PI: pi, DRAKONC_SHELL_NO_AUTO_SETUP: "1" };
	const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", env: { ...env, ...extra } });
	return { root, home, env, run, shellConfig: join(home, ".drakonc-shell", "drakonc-ai") };
}

test("a standalone isolated launch migrates ~/.pi/drakonc-ai and points Pi at ~/.drakonc-shell/drakonc-ai", posixOnly, () => {
	const w = launcherWorld();
	const result = w.run(["list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), { marker: w.shellConfig, explicit: null });
	assert.equal(readFileSync(join(w.shellConfig, "banner.json"), "utf8"), "{\"showTextLogo\":false}\n");
	assert.equal(readFileSync(join(w.home, ".pi", "drakonc-ai", "banner.json"), "utf8"), "{\"showTextLogo\":false}\n");
	assert.equal(result.stderr.split("\n").filter((line) => line.includes(w.shellConfig) && line.includes("copied")).length, 1);
	const second = w.run(["list"]);
	assert.doesNotMatch(second.stderr, /copied/);
});

test("--link launches get no marker and no migration: readers use the default folder on their own", posixOnly, () => {
	const w = launcherWorld();
	mkdirSync(join(w.home, ".pi", "agent"), { recursive: true });
	const result = w.run(["--link", "list"], { [MARKER]: "/outer/drakonc-ai" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), { marker: null, explicit: null });
	assert.equal(existsSync(w.shellConfig), false, "nothing is copied for a --link launch");
	// The old folder is not seeded for them either: a reader that resolves now
	// lands in ~/.drakonc-shell/drakonc-ai without any migration.
	assert.equal(existsSync(join(w.home, ".pi", "drakonc-ai", "banner.json")), true);
});

test("an explicit DRAKONC_PI_CONFIG_HOME still wins: it reaches Pi and no migration runs", posixOnly, () => {
	const w = launcherWorld();
	const result = w.run(["list"], { DRAKONC_PI_CONFIG_HOME: join(w.root, "explicit") });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)!).explicit, join(w.root, "explicit"));
	assert.equal(existsSync(w.shellConfig), false);
});

test("standalone setup gives Drakonc AI the config pair and keeps both persona files unchanged", posixOnly, () => {
	const w = launcherWorld();
	const drakoncAi = join(w.root, "fake-drakonc-ai.mjs");
	writeFakeDrakoncAi(drakoncAi);
	writeFileSync(join(w.home, ".pi", "drakonc-ai", "persona.json"), "{\"mode\":\"neutral\"}");
	const result = w.run(["setup"], { DRAKONC_SHELL_DRAKONC_AI_BIN: drakoncAi });
	assert.equal(result.status, 0, result.stderr);
	const seen = JSON.parse(result.stdout.split("\n").find((line) => line.includes("\"dir\""))!);
	assert.deepEqual(seen, { dir: w.shellConfig, parent: join(w.home, ".drakonc-shell") });
	assert.equal(readFileSync(join(w.home, ".pi", "drakonc-ai", "persona.json"), "utf8"), "{\"mode\":\"neutral\"}");
	assert.equal(readFileSync(join(w.shellConfig, "persona.json"), "utf8"), "{\"mode\":\"neutral\"}", "the migrated copy is restored too");
});

// S3: while the installed binary is gentle-ai, setup must put back the files it
// writes against the OS home, including the ones in gentle-ai's own folders.
test("standalone setup restores the persona and state files the pinned gentle-ai writes", posixOnly, () => {
	const w = launcherWorld();
	const companion = join(w.root, "fake-gentle-ai.mjs");
	writeFakeGentleAi(companion);
	const persona = join(w.home, ".pi", "drakonc-ai", "persona.json");
	const gentlePersona = join(w.home, ".pi", "gentle-ai", "persona.json");
	const state = join(w.home, ".drakonc-ai", "state.json");
	const gentleState = join(w.home, ".gentle-ai", "state.json");
	const original = {
		persona: "{\"mode\":\"neutral\"}\n",
		state: "{\"managed_asset_digest\":\"user-own\",\"installed_agents\":[\"pi\"]}\n",
	};
	for (const path of [persona, gentlePersona, state, gentleState]) mkdirSync(dirname(path), { recursive: true });
	for (const path of [persona, gentlePersona]) writeFileSync(path, original.persona);
	for (const path of [state, gentleState]) writeFileSync(path, original.state);
	const result = w.run(["setup"], { DRAKONC_SHELL_DRAKONC_AI_BIN: companion });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(persona, "utf8"), original.persona);
	assert.equal(readFileSync(gentlePersona, "utf8"), original.persona, "the pinned gentle-ai persona is restored too");
	for (const path of [state, gentleState]) {
		const restored = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(restored.managed_asset_digest, "user-own", `${path} keeps the user's managed-asset digest`);
		assert.deepEqual(restored.installed_agents, ["pi", "claude"], `${path} keeps what the companion recorded`);
	}
	assert.equal(result.stderr.match(/managed-asset record unchanged/g)?.length, 2, "one notice per shared state file");
});
