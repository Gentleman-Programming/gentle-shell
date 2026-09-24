import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Integration tests for the thin bin/gentle-shell.mjs entry: they run the real
// file via spawnSync with an isolated HOME and a fake pi script standing in for
// the real @earendil-works/pi-coding-agent runtime, so the launcher's own logic
// (already covered at the unit level in tests/gentle-shell-launcher.test.ts)
// gets exercised end-to-end through real argv, env, and child-process wiring.

const binUrl = new URL("../bin/gentle-shell.mjs", import.meta.url);
const binPath = fileURLToPath(binUrl);
const packageRoot = dirname(dirname(binPath));

// The launcher's own gentle-pi version, exactly as `ownPackageVersion()` in
// bin/gentle-shell.mjs reads it (package.json at packageRoot) — used to
// assert the post-install gentle-pi removal message and the provisioning
// marker's `gentlePi` field without hardcoding this package's own version.
function ownGentlePiVersion(): string {
	return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
}

// GENTLE_SHELL_NO_AUTO_SETUP=1 is in the base fixture env so every test that
// is not itself about auto-provisioning (S7) keeps today's plain-launch
// behavior: without it, every fixture-driven test against a fresh isolated
// home would trigger a real `gentle-ai install --agent pi` (network, tens of
// seconds, mutating state) unless it also happened to set
// GENTLE_SHELL_GENTLE_AI_BIN. The auto-provision test section below opts
// back in per test via enableAutoProvision.
function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "gentle-shell-bin-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const piScript = join(root, "fake-pi.mjs");
	writePiScript(piScript, "0.85.1");
	const gentleShellHome = join(root, "gentle-shell-home");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GENTLE_SHELL_HOME: gentleShellHome,
		GENTLE_SHELL_PI: piScript,
		GENTLE_SHELL_NO_AUTO_SETUP: "1",
	};
	return { root, home, gentleShellHome, piScript, env };
}

// Removes the fixture's default GENTLE_SHELL_NO_AUTO_SETUP=1 opt-out, for a
// test that specifically exercises auto-provisioning (S7).
function enableAutoProvision(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { GENTLE_SHELL_NO_AUTO_SETUP, ...rest } = env;
	return rest;
}

// `removeExitCode` controls only the `pi remove ...` branch exercised by the
// setup-subcommand conflict-cleanup tests below; every other pi invocation
// (including the version probe) keeps exiting 0, unchanged for every
// existing caller that does not pass it.
function writePiScript(path: string, version: string, removeExitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			`if (args.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }`,
			"if (args[0] === 'remove') {",
			"  console.log(JSON.stringify({",
			"    args,",
			"    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,",
			"    GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME,",
			"    PATH: process.env.PATH,",
			"  }));",
			`  process.exit(${removeExitCode});`,
			"}",
			"console.log(JSON.stringify({",
			"  args,",
			"  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,",
			"  GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME,",
			"}));",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

function run(env: NodeJS.ProcessEnv, args: string[], options: { cwd?: string } = {}) {
	return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", env, ...options });
}

// Test/development-only stub for the setup subcommand's gentle-ai binary:
// records its argv and the environment gentle-shell sets around it, instead
// of running the real package-local gentle-ai (whose supply-chain integrity
// checks a test cannot cheaply satisfy). Pointed to via GENTLE_SHELL_GENTLE_AI_BIN,
// documented as test/development-only in docs/readme-reference.md.
function writeGentleAiScript(path: string, exitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			"process.stdout.write(JSON.stringify({",
			"  args,",
			"  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,",
			"  GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME,",
			"  PATH: process.env.PATH,",
			"}));",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only stub for the setup subcommand's gentle-ai binary
// that also records each invocation's args to `counterPath` (one JSON line
// per run), so an auto-provision test can prove the flow ran exactly once
// (or not at all) across several gentle-shell invocations, independent of
// what lands on stdout/stderr.
function writeGentleAiScriptCountingRuns(path: string, counterPath: string, exitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { appendFileSync } from 'node:fs';",
			"const args = process.argv.slice(2);",
			`appendFileSync(${JSON.stringify(counterPath)}, JSON.stringify(args) + '\\n');`,
			"process.stdout.write(JSON.stringify({ args, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }));",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only stub for setup's self-heal installer seam
// (GENTLE_SHELL_GENTLE_AI_INSTALLER): writes a working gentle-ai stub at
// process.env.GENTLE_SHELL_GENTLE_AI_BIN — the same path setup itself
// resolved the missing binary from — so "the installer created the pinned
// binary" is provable by setup's own retry check finding it, exactly like a
// real `node scripts/install-gentle-ai.mjs` run would leave a real binary at
// gentleAiBinaryPath().
function writeInstallerScriptThatCreatesTheBinary(path: string) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';",
			"import { dirname } from 'node:path';",
			"const target = process.env.GENTLE_SHELL_GENTLE_AI_BIN;",
			"mkdirSync(dirname(target), { recursive: true });",
			"writeFileSync(target, [",
			"  '#!/usr/bin/env node',",
			"  'const args = process.argv.slice(2);',",
			"  'process.stdout.write(JSON.stringify({ args, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME, PATH: process.env.PATH }));',",
			"  'process.exit(0);',",
			"  '',",
			"].join('\\n'));",
			"chmodSync(target, 0o755);",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only stub for setup's self-heal installer seam that
// deliberately never creates the binary, simulating a real installer run
// that failed (e.g. a network or verification failure) — setup's retry
// check must still find the binary missing afterward.
function writeInstallerScriptThatFails(path: string) {
	writeFileSync(path, ["#!/usr/bin/env node", "process.stderr.write('simulated installer failure\\n');", "process.exit(1);", ""].join("\n"));
	chmodSync(path, 0o755);
}

// Test/development-only stub for the setup subcommand's gentle-ai binary,
// simulating the real gentle-ai's managed Pi stack declaring the conflicting
// npm:@juicesharp/rpiv-ask-user-question package (gentle-ai #4820,
// gentle-shell #1277) into the provisioned home's settings.json, the same
// file the isolated-home bootstrap already created before `setup` spawns
// this stub. Its own stdout line ends with "\n" so a test can tell it apart
// from a later `pi remove` line on the same inherited stdout.
function writeGentleAiScriptDeclaringConflict(path: string, exitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { readFileSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"const args = process.argv.slice(2);",
			"const settingsPath = join(process.env.PI_CODING_AGENT_DIR, 'settings.json');",
			"const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));",
			"settings.packages = ['npm:@juicesharp/rpiv-ask-user-question@1.2.3'];",
			"writeFileSync(settingsPath, JSON.stringify(settings));",
			"process.stdout.write(JSON.stringify({ args }) + '\\n');",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only stub for the setup subcommand's gentle-ai binary
// that also rewrites the provisioned home's own settings.json `theme` field,
// simulating gentle-ai's managed Pi install writing its own theme into
// settings.json — the case gentle-shell's own theme-restore logic
// (bin/gentle-shell.mjs's runSetupFlow, enforceDefaultThemeField) must undo.
function writeGentleAiScriptSettingTheme(path: string, theme: string, exitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { readFileSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"const args = process.argv.slice(2);",
			"const settingsPath = join(process.env.PI_CODING_AGENT_DIR, 'settings.json');",
			"const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));",
			`settings.theme = ${JSON.stringify(theme)};`,
			"writeFileSync(settingsPath, JSON.stringify(settings));",
			"process.stdout.write(JSON.stringify({ args }) + '\\n');",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only stub for the setup subcommand's gentle-ai binary,
// simulating the real gentle-ai's managed Pi stack always declaring
// npm:gentle-pi itself into the provisioned home's settings.json (the
// problem this fix addresses: the home must never keep running that
// declared copy instead of the launcher's own). `extraSources` lets a test
// also declare the conflicting rpiv package alongside it, in the given
// order, to prove both post-install removals run together.
function writeGentleAiScriptDeclaringGentlePi(path: string, extraSources: string[] = [], exitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { readFileSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"const args = process.argv.slice(2);",
			"const settingsPath = join(process.env.PI_CODING_AGENT_DIR, 'settings.json');",
			"const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));",
			`settings.packages = [...${JSON.stringify(extraSources)}, 'npm:gentle-pi@3.5.1'];`,
			"writeFileSync(settingsPath, JSON.stringify(settings));",
			"process.stdout.write(JSON.stringify({ args }) + '\\n');",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only fake pi runtime whose `remove <source>` branch also
// rewrites the target home's settings.json, dropping the matching `packages`
// entry — unlike the plain `writePiScript` stub above (which only records
// the invocation), this models what a real `pi remove` does to settings.json
// closely enough to prove a later plain launch sees the declaration gone and
// resumes the launcher's own injection.
function writePiScriptEditingSettingsOnRemove(path: string, version = "0.85.1") {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { readFileSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"const args = process.argv.slice(2);",
			`if (args.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }`,
			"if (args[0] === 'remove') {",
			"  const settingsPath = join(process.env.PI_CODING_AGENT_DIR, 'settings.json');",
			"  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));",
			"  const target = args[1];",
			"  settings.packages = (settings.packages || []).filter((entry) => {",
			"    const source = typeof entry === 'string' ? entry : entry.source;",
			"    return source !== target && !source.startsWith(target + '@');",
			"  });",
			"  writeFileSync(settingsPath, JSON.stringify(settings));",
			"  console.log(JSON.stringify({",
			"    args,",
			"    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,",
			"    GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME,",
			"    PATH: process.env.PATH,",
			"  }));",
			"  process.exit(0);",
			"}",
			"console.log(JSON.stringify({ args, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }));",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only stub for the setup subcommand's gentle-ai binary
// that also rewrites the shared Pi persona file at
// `$HOME/.pi/gentle-ai/persona.json` to the default preset, exactly like the
// real gentle-ai does regardless of `PI_CODING_AGENT_DIR` (gentle-ai's
// `PiPersonaConfigPath` always resolves against the OS home). Reads
// `homedir()` inside the child so it honors the fixture's isolated `HOME`,
// never `PI_CODING_AGENT_DIR` — that mismatch is exactly the bug the
// snapshot/restore wrap in `runSetupFlow` guards against.
function writeGentleAiScriptRewritingPersona(path: string, exitCode = 0) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { writeFileSync, mkdirSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"const personaDir = join(homedir(), '.pi', 'gentle-ai');",
			"mkdirSync(personaDir, { recursive: true });",
			"writeFileSync(join(personaDir, 'persona.json'), JSON.stringify({ mode: 'gentleman' }));",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

// Test/development-only stub for the setup subcommand's gentle-ai binary
// that also rewrites the shared `$HOME/.gentle-ai/state.json` the way the
// real gentle-ai does on every install: it changes managed_asset_digest (the
// field this fix restores) and one unrelated field (installed_agents), so a
// test can prove the digest gets restored while the unrelated field is left
// exactly as the child wrote it. `create` controls whether it merges into an
// existing state.json or writes a brand-new one (for the "no pre-existing
// file" case, where the stub's file must be left alone entirely).
function writeGentleAiScriptRewritingManagedAssetDigest(path: string, opts: { digest?: string; create?: boolean } = {}, exitCode = 0) {
	const digest = opts.digest ?? "digest-from-pinned-gentle-ai";
	const create = opts.create ?? false;
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			"import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"const stateDir = join(homedir(), '.gentle-ai');",
			"mkdirSync(stateDir, { recursive: true });",
			"const statePath = join(stateDir, 'state.json');",
			`const create = ${JSON.stringify(create)};`,
			"const state = !create && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};",
			`state.managed_asset_digest = ${JSON.stringify(digest)};`,
			"state.installed_agents = [...(state.installed_agents || []), 'claude'];",
			"writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n');",
			`process.exit(${exitCode});`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

test("--help exits 0 and prints usage", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage: gentle-shell/);
});

test("home with no args prints the default isolated home", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["home"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), `isolated ${f.gentleShellHome}`);
});

test("home link persists and a later home reflects it", (t) => {
	const f = fixture(t);
	const save = run(f.env, ["home", "link"]);
	assert.equal(save.status, 0, save.stderr);
	const configPath = join(f.home, ".gentle-shell", "config.json");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { home: "link" });
	const check = run(f.env, ["home"]);
	assert.equal(check.status, 0, check.stderr);
	assert.match(check.stdout, /^link /);
});

test("home <path> persists a custom directory", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const save = run(f.env, ["home", target]);
	assert.equal(save.status, 0, save.stderr);
	const configPath = join(f.home, ".gentle-shell", "config.json");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { home: target });
	const check = run(f.env, ["home"]);
	assert.equal(check.stdout.trim(), `path ${target}`);
});

// Test/development-only: GENTLE_SHELL_CONFIG overrides the launcher
// config.json path (normally <homedir>/.gentle-shell/config.json), so a test
// or a field run against the real HOME (for example the packed-artifact E2E
// script, which needs `--link` probes against the real pi home) never
// touches the real ~/.gentle-shell/config.json. Documented as
// test/development-only in docs/readme-reference.md.
test("GENTLE_SHELL_CONFIG redirects the config.json path used by 'home' and auto-provisioning", (t) => {
	const f = fixture(t);
	const overridePath = join(f.root, "alt-config.json");
	const env = { ...f.env, GENTLE_SHELL_CONFIG: overridePath };

	const save = run(env, ["home", "link"]);
	assert.equal(save.status, 0, save.stderr);
	assert.deepEqual(JSON.parse(readFileSync(overridePath, "utf8")), { home: "link" });
	assert.equal(existsSync(join(f.home, ".gentle-shell", "config.json")), false);

	const check = run(env, ["home"]);
	assert.match(check.stdout, /^link /);
});

test("first isolated run bootstraps the home, writes fullscreen, and prints the hint once", (t) => {
	const f = fixture(t);
	assert.equal(existsSync(f.gentleShellHome), false);

	const first = run(f.env, []);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stderr, /using a separate home at/);
	assert.match(first.stderr, /gentle-shell --link/);
	const settings = JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8"));
	assert.equal(settings.tuiMode, "fullscreen");

	const second = run(f.env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stderr, /using a separate home at/);
});

test("forwarded args reach pi after the injected extension flags, in order", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--mode", "rpc", "-p", "hi"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"-e",
		packageRoot,
		"--mode",
		"rpc",
		"-p",
		"hi",
	]);
	assert.equal(payload.GENTLE_PI_AGENT_HOME, f.gentleShellHome);
});

test("--link skips injection and leaves settings.json byte-identical when it already declares gentle-pi", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = '{"packages":["npm:gentle-pi"],"theme":"kept"}';
	writeFileSync(settingsPath, settingsText);
	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };

	const result = run(env, ["--link", "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--mode", "rpc"]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
	assert.equal(payload.PI_CODING_AGENT_DIR, piAgentDir);
	assert.equal(existsSync(join(piAgentDir, ".gentle-shell")), false);
});

// --- injection skip for isolated/--home homes once they declare gentle-pi (S3) ---
//
// `gentle-shell setup` installs npm:gentle-pi into the home's settings.json;
// once that declaration exists, isolated and --home homes must stop
// injecting the launcher's own copy on top of it, the same way --link
// already does. Homes without a declaration keep the plain injection.

test("an isolated home whose settings.json declares npm:gentle-pi gets no injection", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ packages: ["npm:gentle-pi@3.5.1"], tuiMode: "fullscreen" }));

	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--mode", "rpc"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
});

test("an isolated home whose settings.json does not declare gentle-pi keeps the plain injection", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }));

	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
});

test("an isolated home whose settings.json declares a path-based gentle-pi takes over, same as --link", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"], tuiMode: "fullscreen" }));

	const result = run(f.env, ["--mode", "rpc"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from/);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
});

test("gentle-shell list forwards to pi as a bare subcommand, with no injected extension flags", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["list"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["list"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
});

test("gentle-shell install npm:<pkg> forwards the subcommand and its argument verbatim", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["install", "npm:pi-btw"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "npm:pi-btw"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
});

test("a too-old pi exits 1 naming both versions", (t) => {
	const f = fixture(t);
	writePiScript(f.piScript, "0.80.0");
	const result = run(f.env, []);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /0\.80\.0/);
	assert.match(result.stderr, /0\.85\.1/);
});

test("--version prints three lines", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--version"]);
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout.trim().split("\n");
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^gentle-shell /);
	assert.match(lines[1], /^pi 0\.85\.1$/);
	assert.match(lines[2], /^home isolated /);
});

// --- setup subcommand ------------------------------------------------------

test("gentle-shell setup provisions the resolved home through the pinned gentle-ai binary", (t) => {
	const f = fixture(t);
	assert.equal(existsSync(f.gentleShellHome), false);

	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /provisioning/);
	assert.match(result.stderr, new RegExp(f.gentleShellHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "--agent", "pi", "--scope", "global"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
	assert.equal(payload.GENTLE_PI_AGENT_HOME, f.gentleShellHome);
	assert.ok(payload.PATH.startsWith(`${dirname(f.piScript)}${delimiter}`), payload.PATH);

	// Home resolution runs exactly as a normal run: the isolated home gets
	// created with its bootstrap TUI setting, same as a plain `gentle-shell`.
	const settings = JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8"));
	assert.equal(settings.tuiMode, "fullscreen");
});

test("gentle-shell setup forwards --dry-run to gentle-ai", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup", "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "--agent", "pi", "--scope", "global", "--dry-run"]);
});

test("gentle-shell setup accepts a home selector before it and provisions that home", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["--home", target, "setup"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "--agent", "pi", "--scope", "global"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, target);
	assert.equal(payload.GENTLE_PI_AGENT_HOME, target);
	assert.equal(existsSync(join(target, "settings.json")), true);
});

test("gentle-shell setup passes through the gentle-ai exit code", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript, 3);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 3);
});

// --- setup subcommand's self-heal for a missing package-local binary -------
//
// `npm install -g <tarball>` on a machine whose npm config disables lifecycle
// scripts (`ignore-scripts=true`) never runs the package's own postinstall,
// so .gentle-ai/v<pin>/gentle-ai is missing even though the package itself
// installed fine. `gentle-shell setup` self-heals by running the installer
// in place before giving up. GENTLE_SHELL_GENTLE_AI_INSTALLER is a
// test/development-only override for the installer script path, next to
// GENTLE_SHELL_GENTLE_AI_BIN; documented as test/development-only in
// docs/readme-reference.md.

test("gentle-shell setup installs the missing package-local gentle-ai via the installer seam and then continues", (t) => {
	const f = fixture(t);
	const missingBinary = join(f.root, "does-not-exist", "gentle-ai");
	const installerScript = join(f.root, "fake-installer-creates-binary.mjs");
	writeInstallerScriptThatCreatesTheBinary(installerScript);
	const env = {
		...f.env,
		GENTLE_SHELL_GENTLE_AI_BIN: missingBinary,
		GENTLE_SHELL_GENTLE_AI_INSTALLER: installerScript,
		GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0",
	};

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		/gentle-shell: the package-local gentle-ai v3\.6\.0 is missing \(npm lifecycle scripts may be disabled\); installing it now/,
	);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "--agent", "pi", "--scope", "global"]);
	assert.equal(payload.PI_CODING_AGENT_DIR, f.gentleShellHome);
	assert.equal(payload.GENTLE_PI_AGENT_HOME, f.gentleShellHome);
});

test("gentle-shell setup exits 1 with an actionable message when the pinned gentle-ai binary is still missing after the installer runs", (t) => {
	const f = fixture(t);
	const missingBinary = join(f.root, "does-not-exist", "gentle-ai");
	const installerScript = join(f.root, "fake-installer-fails.mjs");
	writeInstallerScriptThatFails(installerScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: missingBinary, GENTLE_SHELL_GENTLE_AI_INSTALLER: installerScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /gentle-shell: the package-local gentle-ai v.+ is missing \(npm lifecycle scripts may be disabled\); installing it now/);
	assert.match(result.stderr, /package-local-binary-missing/);
	assert.match(result.stderr, new RegExp(missingBinary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("gentle-shell setup skips the self-heal install and exits 1 when GENTLE_PI_SKIP_GENTLE_AI_INSTALL is set", (t) => {
	const f = fixture(t);
	const missingBinary = join(f.root, "does-not-exist", "gentle-ai");
	// This installer would prove itself by creating the binary if it ever ran;
	// it must not run at all when the skip variable is set.
	const installerScript = join(f.root, "installer-should-not-run.mjs");
	writeInstallerScriptThatCreatesTheBinary(installerScript);
	const env = {
		...f.env,
		GENTLE_SHELL_GENTLE_AI_BIN: missingBinary,
		GENTLE_SHELL_GENTLE_AI_INSTALLER: installerScript,
		GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "1",
	};

	const result = run(env, ["setup"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /package-local-binary-missing/);
	assert.match(result.stderr, /GENTLE_PI_SKIP_GENTLE_AI_INSTALL/);
	assert.doesNotMatch(result.stderr, /installing it now/);
	assert.equal(existsSync(missingBinary), false);
});

// --- setup subcommand's gentle-ai pin gate (R3/R4 advisory findings) -------
//
// `gentle-shell setup` points PI_CODING_AGENT_DIR at the resolved home
// before spawning the package-local pinned gentle-ai; only gentle-ai >=
// 3.6.0 honors that variable in its own provisioning. An older pin would
// silently provision the caller's real ~/.pi/agent instead, so setup must
// refuse to spawn it. GENTLE_SHELL_GENTLE_AI_PIN is a test/development-only
// override for the reported pin, next to GENTLE_SHELL_GENTLE_AI_BIN;
// documented as test/development-only in docs/readme-reference.md.

test("gentle-shell setup refuses to run an older-than-3.6.0 pin and spawns nothing", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.5.0" };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /gentle-shell: setup needs the package-local gentle-ai v3\.6\.0 or newer \(pinned: 3\.5\.0\); this build cannot provision a home without touching ~\/\.pi\/agent/);
	// The isolated-home bootstrap runs before command dispatch on every run
	// (same as a successful setup); the pin gate only refuses to spawn
	// gentle-ai, so no gentle-ai invocation is recorded on stdout.
	assert.equal(result.stdout, "");
});

test("gentle-shell setup proceeds when the reported pin is exactly 3.6.0", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "--agent", "pi", "--scope", "global"]);
});

// --- setup subcommand conflict cleanup (gentle-ai #4820 / gentle-shell #1277) ---
//
// gentle-ai's managed Pi stack still installs npm:@juicesharp/rpiv-ask-user-question,
// which conflicts with gentle-pi's own first-party ask_user_question tool
// (Pi refuses two providers for the same tool name). Until the gentle-ai fix
// lands, `gentle-shell setup` removes the conflicting package itself once it
// finds gentle-ai declared it in the provisioned home's settings.json.

test("gentle-shell setup removes the conflicting ask-user-question package gentle-ai declared", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptDeclaringConflict(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		/gentle-shell: removing npm:@juicesharp\/rpiv-ask-user-question from .+: gentle-pi ships ask_user_question and Pi refuses two providers \(gentle-ai #4820\)/,
	);

	const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 2, result.stdout);
	assert.deepEqual(JSON.parse(lines[0]).args, ["install", "--agent", "pi", "--scope", "global"]);
	const removePayload = JSON.parse(lines[1]);
	assert.deepEqual(removePayload.args, ["remove", "npm:@juicesharp/rpiv-ask-user-question"]);
	assert.equal(removePayload.PI_CODING_AGENT_DIR, f.gentleShellHome);
	assert.equal(removePayload.GENTLE_PI_AGENT_HOME, f.gentleShellHome);
	assert.ok(removePayload.PATH.startsWith(`${dirname(f.piScript)}${delimiter}`), removePayload.PATH);
});

test("gentle-shell setup runs no pi remove when gentle-ai did not declare the conflicting package", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /removing npm:/);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "--agent", "pi", "--scope", "global"]);
});

// --- setup subcommand keeps the home on the launcher's own gentle-pi -------
//
// gentle-ai's managed Pi stack always declares npm:gentle-pi itself into the
// provisioned home's settings.json. That declaration must never survive
// setup: this launcher always loads its own gentle-pi, so leaving it in
// place would let the home drift onto whatever gentle-pi npm last installed
// (or, worse, onto the published npm package instead of a developer's source
// checkout) instead of the running launcher's own copy.

test("gentle-shell setup removes npm:gentle-pi that gentle-ai declared, naming this launcher's own version", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptDeclaringGentlePi(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		new RegExp(
			`gentle-shell: removing npm:gentle-pi from .+: this launcher loads its own gentle-pi ${ownGentlePiVersion().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, so the home always matches it`,
		),
	);

	const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 2, result.stdout);
	assert.deepEqual(JSON.parse(lines[0]).args, ["install", "--agent", "pi", "--scope", "global"]);
	const removePayload = JSON.parse(lines[1]);
	assert.deepEqual(removePayload.args, ["remove", "npm:gentle-pi"]);
	assert.equal(removePayload.PI_CODING_AGENT_DIR, f.gentleShellHome);
	assert.equal(removePayload.GENTLE_PI_AGENT_HOME, f.gentleShellHome);
	assert.ok(removePayload.PATH.startsWith(`${dirname(f.piScript)}${delimiter}`), removePayload.PATH);
});

test("gentle-shell setup removes both the conflicting rpiv package and npm:gentle-pi, in declaration order", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptDeclaringGentlePi(gentleAiScript, ["npm:@juicesharp/rpiv-ask-user-question@1.2.3"]);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);

	const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 3, result.stdout);
	assert.deepEqual(JSON.parse(lines[0]).args, ["install", "--agent", "pi", "--scope", "global"]);
	assert.deepEqual(JSON.parse(lines[1]).args, ["remove", "npm:@juicesharp/rpiv-ask-user-question"]);
	assert.deepEqual(JSON.parse(lines[2]).args, ["remove", "npm:gentle-pi"]);
});

// A --dry-run gentle-ai install writes nothing, so reading settings.json
// afterwards would only ever report whatever pre-existed the run (e.g. the
// isolated-home bootstrap this fixture's fake-gentle-ai script never
// touches), never what the skipped install would have declared. Setup must
// therefore print the pending-removal message unconditionally, without
// reading settings.json — proven here with a fresh home that never declares
// the conflicting package at all.
test("gentle-shell setup --dry-run prints the pending removal unconditionally, without reading settings.json", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const result = run(env, ["setup", "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		/gentle-shell: setup would then remove npm:@juicesharp\/rpiv-ask-user-question if the install declares it \(gentle-ai #4820\)/,
	);
	assert.match(
		result.stderr,
		new RegExp(
			`gentle-shell: setup would then remove npm:gentle-pi if the install declares it: this launcher loads its own gentle-pi ${ownGentlePiVersion().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, so the home always matches it`,
		),
	);
	assert.doesNotMatch(result.stderr, /gentle-shell: removing/);

	const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 1, result.stdout);
	assert.deepEqual(JSON.parse(lines[0]).args, ["install", "--agent", "pi", "--scope", "global", "--dry-run"]);
});

test("a later normal launch injects the launcher's own package root once gentle-pi is removed from settings.json", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptDeclaringGentlePi(gentleAiScript);
	writePiScriptEditingSettingsOnRemove(f.piScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const setupResult = run(env, ["setup"]);
	assert.equal(setupResult.status, 0, setupResult.stderr);
	const settings = JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, []);

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
});

test("gentle-shell setup propagates a non-zero pi remove exit code with an actionable message", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptDeclaringConflict(gentleAiScript);
	const failingPiScript = join(f.root, "fake-pi-remove-fails.mjs");
	writePiScript(failingPiScript, "0.85.1", 7);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_PI: failingPiScript };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 7);
	assert.match(
		result.stderr,
		/gentle-shell: could not remove npm:@juicesharp\/rpiv-ask-user-question; run `gentle-shell remove npm:@juicesharp\/rpiv-ask-user-question` before starting/,
	);
});

// The remediation message must include whatever home selector setup was run
// with, so a copy-pasted `gentle-shell remove <source>` doesn't silently
// fall back to the isolated default and miss the package in the home the
// user actually set up (gentle-shell #1277 follow-up).
test("gentle-shell setup --home <dir> includes --home <dir> in the failing-removal remediation command", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptDeclaringConflict(gentleAiScript);
	const failingPiScript = join(f.root, "fake-pi-remove-fails.mjs");
	writePiScript(failingPiScript, "0.85.1", 7);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_PI: failingPiScript };

	const result = run(env, ["--home", target, "setup"]);
	assert.equal(result.status, 7);
	assert.match(
		result.stderr,
		new RegExp(
			`gentle-shell: could not remove npm:@juicesharp/rpiv-ask-user-question; run \`gentle-shell --home ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} remove npm:@juicesharp/rpiv-ask-user-question\` before starting`,
		),
	);
});

// A --home path containing a space (or another shell metacharacter) must be
// single-quoted in the remediation command, or a copy-pasted
// `gentle-shell --home <dir> remove <source>` silently splits into extra
// shell words instead of naming the actual home setup provisioned
// (gentle-shell #1277 follow-up).
test("gentle-shell setup shell-quotes a --home path containing a space in the failing-removal remediation command", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom home");
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptDeclaringConflict(gentleAiScript);
	const failingPiScript = join(f.root, "fake-pi-remove-fails.mjs");
	writePiScript(failingPiScript, "0.85.1", 7);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_PI: failingPiScript };

	const result = run(env, ["--home", target, "setup"]);
	assert.equal(result.status, 7);
	assert.match(
		result.stderr,
		new RegExp(
			`gentle-shell: could not remove npm:@juicesharp/rpiv-ask-user-question; run \`gentle-shell --home '${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' remove npm:@juicesharp/rpiv-ask-user-question\` before starting`,
		),
	);
});

// --- persona snapshot/restore -----------------------------------------------
//
// gentle-ai's persona file always lives at the shared `~/.pi/gentle-ai/persona.json`
// regardless of `PI_CODING_AGENT_DIR` (see docs/readme-reference.md's setup
// "Known limitation"), so `setup` snapshots it before spawning gentle-ai and
// restores it afterward — in every mode gentle-ai gets spawned in: manual,
// `--dry-run`, and automatic first-run provisioning.

function personaPathFor(f: { home: string }) {
	return join(f.home, ".pi", "gentle-ai", "persona.json");
}

test("gentle-shell setup restores the user's Pi persona file when gentle-ai rewrites it", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingPersona(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const personaPath = personaPathFor(f);
	mkdirSync(dirname(personaPath), { recursive: true });
	const originalBytes = JSON.stringify({ mode: "neutral" });
	writeFileSync(personaPath, originalBytes);
	chmodSync(personaPath, 0o600);

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(personaPath, "utf8"), originalBytes);
	assert.equal(statSync(personaPath).mode & 0o777, 0o600);
	assert.match(
		result.stderr,
		new RegExp(
			`gentle-shell: kept your Pi persona unchanged \\(gentle-ai rewrote ${personaPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; tracked upstream\\)`,
		),
	);
});

test("gentle-shell setup removes a Pi persona file gentle-ai created where none existed", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingPersona(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const personaPath = personaPathFor(f);
	assert.equal(existsSync(personaPath), false);

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(personaPath), false);
	assert.match(result.stderr, /gentle-shell: kept your Pi persona unchanged/);
});

test("gentle-shell setup prints no persona notice when gentle-ai leaves the persona file alone", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const personaPath = personaPathFor(f);
	mkdirSync(dirname(personaPath), { recursive: true });
	writeFileSync(personaPath, JSON.stringify({ mode: "neutral" }));

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /kept your Pi persona unchanged/);
});

test("gentle-shell setup restores the persona file even when gentle-ai exits non-zero after rewriting it", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingPersona(gentleAiScript, 3);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const personaPath = personaPathFor(f);
	mkdirSync(dirname(personaPath), { recursive: true });
	const originalBytes = JSON.stringify({ mode: "neutral" });
	writeFileSync(personaPath, originalBytes);

	const result = run(env, ["setup"]);
	assert.equal(result.status, 3);
	assert.equal(readFileSync(personaPath, "utf8"), originalBytes);
	assert.match(result.stderr, /gentle-shell: kept your Pi persona unchanged/);
});

test("gentle-shell setup --dry-run also restores the persona file gentle-ai rewrites", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingPersona(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const personaPath = personaPathFor(f);
	mkdirSync(dirname(personaPath), { recursive: true });
	const originalBytes = JSON.stringify({ mode: "neutral" });
	writeFileSync(personaPath, originalBytes);

	const result = run(env, ["setup", "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(personaPath, "utf8"), originalBytes);
	assert.match(result.stderr, /gentle-shell: kept your Pi persona unchanged/);
});

test("automatic first-run provisioning also restores the persona file gentle-ai rewrites", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingPersona(gentleAiScript);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const personaPath = personaPathFor(f);
	mkdirSync(dirname(personaPath), { recursive: true });
	const originalBytes = JSON.stringify({ mode: "neutral" });
	writeFileSync(personaPath, originalBytes);

	const result = run(env, []);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(personaPath, "utf8"), originalBytes);
	assert.match(result.stderr, /gentle-shell: kept your Pi persona unchanged/);
});

// --- managed-asset digest snapshot/restore ----------------------------------
//
// gentle-ai tracks whether its own binary's managed-asset bundle matches the
// shared `~/.gentle-ai/state.json`'s managed_asset_digest field, regardless
// of which home it was installing into. The pinned package-local gentle-ai
// this setup flow spawns writes its own digest into that same shared file,
// so afterward the user's own (unrelated, on-PATH) gentle-ai reports its
// managed assets as outdated and demands `gentle-ai sync`, even though
// nothing about the user's install changed. `setup` restores just that field
// afterward — never the whole file, unlike persona.json, since state.json
// also carries fields (like installed_agents) the pinned gentle-ai is
// supposed to update.

function stateJsonPathFor(f: { home: string }) {
	return join(f.home, ".gentle-ai", "state.json");
}

test("gentle-shell setup restores managed_asset_digest while keeping other state.json fields as the child left them", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingManagedAssetDigest(gentleAiScript, { digest: "digest-from-pinned-gentle-ai" });
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const statePath = stateJsonPathFor(f);
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ managed_asset_digest: "users-own-digest", installed_agents: ["pi"] }, null, 2)}\n`);

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	assert.equal(state.managed_asset_digest, "users-own-digest");
	assert.deepEqual(state.installed_agents, ["pi", "claude"]);
	assert.match(
		result.stderr,
		new RegExp(
			`gentle-shell: kept your Gentle AI managed-asset record unchanged \\(the pinned gentle-ai rewrote ${statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; tracked upstream\\)`,
		),
	);
});

test("gentle-shell setup prints no managed-asset notice when the digest is unchanged", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingManagedAssetDigest(gentleAiScript, { digest: "same-digest" });
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const statePath = stateJsonPathFor(f);
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ managed_asset_digest: "same-digest", installed_agents: ["pi"] }, null, 2)}\n`);

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /kept your Gentle AI managed-asset record unchanged/);
});

test("gentle-shell setup leaves a state.json the pinned gentle-ai created where none existed before", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingManagedAssetDigest(gentleAiScript, { digest: "digest-from-pinned-gentle-ai", create: true });
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const statePath = stateJsonPathFor(f);
	assert.equal(existsSync(statePath), false);

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	assert.equal(state.managed_asset_digest, "digest-from-pinned-gentle-ai");
	assert.doesNotMatch(result.stderr, /kept your Gentle AI managed-asset record unchanged/);
});

test("gentle-shell setup --dry-run also restores managed_asset_digest gentle-ai rewrites", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingManagedAssetDigest(gentleAiScript, { digest: "digest-from-pinned-gentle-ai" });
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript };

	const statePath = stateJsonPathFor(f);
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ managed_asset_digest: "users-own-digest", installed_agents: ["pi"] }, null, 2)}\n`);

	const result = run(env, ["setup", "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	assert.equal(state.managed_asset_digest, "users-own-digest");
	assert.match(result.stderr, /kept your Gentle AI managed-asset record unchanged/);
});

test("automatic first-run provisioning also restores managed_asset_digest gentle-ai rewrites", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptRewritingManagedAssetDigest(gentleAiScript, { digest: "digest-from-pinned-gentle-ai" });
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const statePath = stateJsonPathFor(f);
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ managed_asset_digest: "users-own-digest", installed_agents: ["pi"] }, null, 2)}\n`);

	const result = run(env, []);
	assert.equal(result.status, 0, result.stderr);
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	assert.equal(state.managed_asset_digest, "users-own-digest");
	assert.match(result.stderr, /kept your Gentle AI managed-asset record unchanged/);
});

// --- automatic first-run provisioning (S7) ---------------------------------
//
// A plain `gentle-shell` in an isolated or `--home` home now runs the same
// flow as `gentle-shell setup` automatically, before launching pi, when the
// home has never been provisioned or was provisioned with a different
// gentle-ai pin. GENTLE_SHELL_GENTLE_AI_PIN pins the reported pin to a fixed
// value so these tests are independent of the real installed pin.

test("first launch auto-provisions the isolated home, writes the marker, then launches pi; stdout carries only pi's output", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--mode", "rpc", "-p", "hi"]);
	assert.equal(result.status, 0, result.stderr);

	// The flow ran exactly once, before pi.
	const runs = readFileSync(counterPath, "utf8").trim().split("\n");
	assert.equal(runs.length, 1, counterPath);
	assert.deepEqual(JSON.parse(runs[0]), ["install", "--agent", "pi", "--scope", "global"]);

	// stdout carries only the final pi invocation's own output (the flow's
	// stdout and stderr, and the launcher's own notices, all went to stderr).
	const stdoutLines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
	assert.equal(stdoutLines.length, 1, result.stdout);
	const payload = JSON.parse(stdoutLines[0]);
	assert.deepEqual(payload.args.slice(-4), ["--mode", "rpc", "-p", "hi"]);

	assert.match(result.stderr, /gentle-shell: first run in .+: installing the Gentle AI companion packages \(one time; set GENTLE_SHELL_NO_AUTO_SETUP=1 to skip\)/);
	assert.match(result.stderr, new RegExp(JSON.stringify({ args: ["install", "--agent", "pi", "--scope", "global"], PI_CODING_AGENT_DIR: f.gentleShellHome }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	const config = JSON.parse(readFileSync(join(f.home, ".gentle-shell", "config.json"), "utf8"));
	const homeKey = realpathSync(f.gentleShellHome);
	assert.equal(config.provisioned[homeKey].gentleAi, "3.6.0");
	assert.equal(config.provisioned[homeKey].gentlePi, ownGentlePiVersion());
	assert.equal(typeof config.provisioned[homeKey].at, "string");
	assert.equal(existsSync(join(f.gentleShellHome, ".gentle-shell-setup.lock")), false);
});

test("a second launch against an already-provisioned home skips the flow entirely", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const first = run(env, []);
	assert.equal(first.status, 0, first.stderr);
	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1);

	const second = run(env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stderr, /gentle-shell: first run in/);
	assert.doesNotMatch(second.stderr, /gentle-ai pin changed/);
	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1, "gentle-ai must not run a second time");
});

test("a changed gentle-ai pin re-runs the flow and updates the marker", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const baseEnv = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript });

	const first = run({ ...baseEnv, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" }, []);
	assert.equal(first.status, 0, first.stderr);

	const second = run({ ...baseEnv, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.1" }, []);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stderr, /gentle-shell: gentle-ai pin changed \(3\.6\.0 -> 3\.6\.1\): updating/);

	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 2);
	const config = JSON.parse(readFileSync(join(f.home, ".gentle-shell", "config.json"), "utf8"));
	const homeKey = realpathSync(f.gentleShellHome);
	assert.equal(config.provisioned[homeKey].gentleAi, "3.6.1");
	assert.equal(config.provisioned[homeKey].gentlePi, ownGentlePiVersion());
});

// A marker written before gentle-pi version tracking existed (S8) has no
// `gentlePi` field: needsProvisioning must never trust that omission as a
// match, so the next launch re-provisions and backfills the field.
test("a marker without a gentlePi field re-runs the flow and backfills it", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const first = run(env, []);
	assert.equal(first.status, 0, first.stderr);
	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1);

	const configPath = join(f.home, ".gentle-shell", "config.json");
	const homeKey = realpathSync(f.gentleShellHome);
	const staleConfig = JSON.parse(readFileSync(configPath, "utf8"));
	delete staleConfig.provisioned[homeKey].gentlePi;
	writeFileSync(configPath, JSON.stringify(staleConfig));

	const second = run(env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 2, "gentle-ai must re-run once the marker predates gentlePi tracking");

	const config = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(config.provisioned[homeKey].gentleAi, "3.6.0");
	assert.equal(config.provisioned[homeKey].gentlePi, ownGentlePiVersion());
});

test("a changed gentle-pi version re-runs the flow and prints the gentle-pi-changed line", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const first = run(env, []);
	assert.equal(first.status, 0, first.stderr);

	const configPath = join(f.home, ".gentle-shell", "config.json");
	const homeKey = realpathSync(f.gentleShellHome);
	const staleConfig = JSON.parse(readFileSync(configPath, "utf8"));
	staleConfig.provisioned[homeKey].gentlePi = "0.0.0-previous-launcher";
	writeFileSync(configPath, JSON.stringify(staleConfig));

	const second = run(env, []);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stderr, new RegExp(`gentle-shell: gentle-pi changed \\(0\\.0\\.0-previous-launcher -> ${ownGentlePiVersion().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\): updating`));
	assert.doesNotMatch(second.stderr, /gentle-ai pin changed/);

	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 2);
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(config.provisioned[homeKey].gentlePi, ownGentlePiVersion());
});

test("a failing auto-provision flow warns, still launches pi, and writes no marker", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript, 5);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		/gentle-shell: automatic setup failed \(exit 5\); starting anyway and retrying next run\. Run `gentle-shell setup` to see the full output\./,
	);
	// pi still launches, with today's plain injection (the home never got a
	// gentle-pi declaration since the flow failed).
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args.slice(-2), ["--mode", "rpc"]);

	const configPath = join(f.home, ".gentle-shell", "config.json");
	if (existsSync(configPath)) {
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		assert.equal(config.provisioned, undefined);
	}
});

test("a failing auto-provision flow names the --home selector in its retry remediation", (t) => {
	const f = fixture(t);
	const target = join(f.root, "custom-home");
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript, 5);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		new RegExp(`Run \`gentle-shell --home ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} setup\` to see the full output\\.`),
	);
});

test("GENTLE_SHELL_NO_AUTO_SETUP=1 skips auto-provisioning entirely", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_NO_AUTO_SETUP: "1" };

	const result = run(env, []);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(counterPath), false);
	const configPath = join(f.home, ".gentle-shell", "config.json");
	assert.equal(existsSync(configPath), false);
});

test("--link never auto-provisions", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, PI_CODING_AGENT_DIR: piAgentDir });

	const result = run(env, ["--link", "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(counterPath), false);
	assert.equal(existsSync(join(piAgentDir, ".gentle-shell-setup.lock")), false);
});

test("a pi subcommand (list) never auto-provisions", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript });

	const result = run(env, ["list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(counterPath), false);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["list"]);
});

test("a fresh concurrent lock skips auto-provisioning for this run, without removing the lock", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const lockPath = join(f.gentleShellHome, ".gentle-shell-setup.lock");
	writeFileSync(lockPath, "");
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript });

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(counterPath), false);
	assert.match(result.stderr, /already provisioning/);
	assert.equal(existsSync(lockPath), true);
});

test("a stale lock (older than 15 minutes) is removed and auto-provisioning proceeds", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	const lockPath = join(f.gentleShellHome, ".gentle-shell-setup.lock");
	writeFileSync(lockPath, "");
	const staleTime = new Date(Date.now() - 16 * 60 * 1000);
	utimesSync(lockPath, staleTime, staleTime);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1);
	assert.equal(existsSync(lockPath), false, "the lock must be released once the flow completes");
});

// --- auto-provisioning only touches homes gentle-shell owns (R1-001) -------

test("a --home pointing at an existing non-empty, unmarked directory is never auto-provisioned", (t) => {
	const f = fixture(t);
	const target = join(f.root, "existing-pi-home");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "settings.json"), JSON.stringify({}));
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(counterPath), false, "gentle-ai must never run against a foreign, unmarked home");
	assert.match(
		result.stderr,
		new RegExp(`gentle-shell: ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} already has content and was not set up by gentle-shell`),
	);
	assert.match(result.stderr, new RegExp(`run \`gentle-shell --home ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} setup\` to provision it`));
});

test("an empty or nonexistent --home is still auto-provisioned", (t) => {
	const f = fixture(t);
	const target = join(f.root, "brand-new-home");
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1, "a fresh --home must still be auto-provisioned");
});

test("a --home equal to pi's own default agent home is never auto-provisioned, even when empty", (t) => {
	const f = fixture(t);
	const defaultPiHome = join(f.home, ".pi", "agent");
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	const counterPath = join(f.root, "gentle-ai-runs.log");
	writeGentleAiScriptCountingRuns(gentleAiScript, counterPath);
	// Exercise the default Pi home, not an ambient PI_CODING_AGENT_DIR override.
	const env = enableAutoProvision({ ...f.env, PI_CODING_AGENT_DIR: undefined, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--home", defaultPiHome, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(counterPath), false, "gentle-ai must never run against pi's own default agent home");
	assert.match(result.stderr, /never auto-provisions it/);
});

// --- --home ownership marker and retry after a failed first attempt (R3-001) -----

test("a freshly bootstrapped isolated or --home directory gets a gentle-shell ownership marker file", (t) => {
	const f = fixture(t);
	const target = join(f.root, "marked-home");
	const result = run(f.env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const marker = JSON.parse(readFileSync(join(target, ".gentle-shell-home"), "utf8"));
	assert.equal(marker.createdBy, "gentle-shell");
	assert.equal(marker.version, ownGentlePiVersion());
});

test("a --home directory gentle-shell itself bootstrapped is retried after its first auto-provision attempt fails", (t) => {
	const f = fixture(t);
	const target = join(f.root, "retry-home");
	const failingGentleAiScript = join(f.root, "fake-gentle-ai-fails.mjs");
	writeGentleAiScript(failingGentleAiScript, 1);
	const firstEnv = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: failingGentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const first = run(firstEnv, ["--home", target, "--mode", "rpc"]);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stderr, /gentle-shell: automatic setup failed/);
	assert.ok(existsSync(join(target, "settings.json")), "bootstrap must have seeded settings.json before the failed attempt");
	assert.ok(existsSync(join(target, ".gentle-shell-home")), "bootstrap must mark the home as gentle-shell-owned");

	const counterPath = join(f.root, "gentle-ai-runs.log");
	const succeedingGentleAiScript = join(f.root, "fake-gentle-ai-succeeds.mjs");
	writeGentleAiScriptCountingRuns(succeedingGentleAiScript, counterPath);
	const secondEnv = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: succeedingGentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const second = run(secondEnv, ["--home", target, "--mode", "rpc"]);
	assert.equal(second.status, 0, second.stderr);
	assert.doesNotMatch(second.stderr, /already has content and was not set up by gentle-shell/);
	assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1, "the retry must actually run gentle-ai against the previously-failed home");
});

// --- auto-provisioning interrupts, resilience, timeouts, atomic writes -----

// Waits until `child`'s stderr has emitted a line matching `pattern`, so a
// test can send a signal only once the flow has actually started (never
// racing the signal against the child process not existing yet).
function waitForStderrMatch(child, pattern) {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const onData = (chunk) => {
			buffer += chunk.toString("utf8");
			if (pattern.test(buffer)) {
				child.stderr.off("data", onData);
				resolve(buffer);
			}
		};
		child.stderr.on("data", onData);
		child.once("error", reject);
	});
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unique token the stub gentle-ai below writes to its own stderr (relayed
// through this launcher's inherited stdio, see buildSetupEnv's stdio wiring)
// the instant it starts, before it sleeps. Waiting for this — instead of the
// launcher's own "provisioning" stderr line, which is written before the
// child is even spawned and proves nothing about the child or spawnAndWait's
// signal-forwarding listeners being ready — is deterministic: it can only
// appear once the child process actually exists and spawnAndWait has
// resolved its Promise executor synchronously (spawn + signal handler
// registration, no `await` in between), so no fixed settle delay is needed
// before sending the real signal.
const CHILD_READY_TOKEN = "GENTLE_SHELL_TEST_CHILD_READY";

test("SIGINT during automatic provisioning kills the child and exits 130 without launching pi", { timeout: 10000 }, async (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai-sleep.mjs");
	writeFileSync(
		gentleAiScript,
		["#!/usr/bin/env node", `process.stderr.write(${JSON.stringify(CHILD_READY_TOKEN)} + "\\n");`, "await new Promise((resolve) => setTimeout(resolve, 20000));", "process.exit(0);", ""].join(
			"\n",
		),
	);
	chmodSync(gentleAiScript, 0o755);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const child = spawn(process.execPath, [binPath, "--mode", "rpc", "-p", "hi"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});

	await waitForStderrMatch(child, new RegExp(CHILD_READY_TOKEN));
	child.kill("SIGINT");
	const { code, signal } = await waitForExit(child);

	assert.equal(signal, null, "the launcher process itself must exit normally, not be killed by the signal");
	assert.equal(code, 130);
	assert.equal(stdout.trim(), "", "pi must never launch once an auto-provision spawn was interrupted");
});

test("a child that dies by a signal on its own during automatic provisioning is an ordinary failure, not a launcher interrupt: pi still launches", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai-self-kill.mjs");
	writeFileSync(gentleAiScript, ["#!/usr/bin/env node", "process.kill(process.pid, 'SIGKILL');", ""].join("\n"));
	chmodSync(gentleAiScript, 0o755);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--mode", "rpc", "-p", "hi"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /gentle-shell: automatic setup failed/);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
});

test(
	"an unexpected error writing the provisioning marker (e.g. an unwritable config directory) still launches pi",
	{ skip: process.platform === "win32" ? "chmod-based write restriction is not portable to Windows" : false },
	(t) => {
		const f = fixture(t);
		// The config.json path itself does not exist yet (loadConfig's and
		// maybeAutoProvisionHome's own initial read both tolerate ENOENT, so
		// they succeed normally and reach the install); only its parent
		// directory is read+execute but not write, which lets writeRawConfig's
		// later mkdirSync — run only after a successful install, when it
		// writes the S7 marker — fail with EACCES instead of silently
		// succeeding. This isolates the failure to the write step inside
		// maybeAutoProvisionHome, the one this fix wraps in try/catch.
		const restrictedRoot = join(f.root, "locked-config-root");
		mkdirSync(restrictedRoot, { recursive: true });
		const configPath = join(restrictedRoot, ".gentle-shell", "config.json");
		chmodSync(restrictedRoot, 0o500);
		// No permission restore needed: restrictedRoot stays empty (its own
		// .gentle-shell subdirectory never gets created), and removing an
		// empty directory only requires write permission on its *parent*
		// (f.root, unaffected), not on the directory's own mode.

		const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
		writeGentleAiScript(gentleAiScript);
		const env = enableAutoProvision({
			...f.env,
			GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript,
			GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0",
			GENTLE_SHELL_CONFIG: configPath,
		});

		const result = run(env, ["--mode", "rpc", "-p", "hi"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /gentle-shell: automatic setup failed unexpectedly/);
		const payload = JSON.parse(result.stdout);
		assert.deepEqual(payload.args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
	},
);

test("a persona snapshot read failure is a non-fatal warning in both manual and automatic modes", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	// A directory where persona.json should be: readFileSync throws EISDIR
	// (not ENOENT), the exact non-fatal case snapshotFile must not propagate.
	const personaPath = personaPathFor(f);
	mkdirSync(personaPath, { recursive: true });

	const manual = run({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript }, ["setup"]);
	assert.equal(manual.status, 0, manual.stderr);
	assert.match(manual.stderr, /gentle-shell: could not snapshot your Pi persona file/);

	const auto = run(
		enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.1" }),
		["--mode", "rpc", "-p", "hi"],
	);
	assert.equal(auto.status, 0, auto.stderr);
	assert.match(auto.stderr, /gentle-shell: could not snapshot your Pi persona file/);
	const payload = JSON.parse(auto.stdout);
	assert.deepEqual(payload.args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
});

test("automatic setup failure includes the underlying message on the line after the generic failure line", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	// A pin below MIN_SETUP_GENTLE_AI_VERSION makes runSetupFlow fail early
	// with a concrete `message`, before ever spawning the stub.
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.5.0" });

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stderr.trim().split("\n");
	const failureIndex = lines.findIndex((line) => /gentle-shell: automatic setup failed/.test(line));
	assert.notEqual(failureIndex, -1, result.stderr);
	assert.match(lines[failureIndex + 1], /gentle-shell: setup needs the package-local gentle-ai v3\.6\.0 or newer \(pinned: 3\.5\.0\)/);
});

test("a hung child during automatic provisioning is killed after the timeout ceiling, treated as a failure, and pi still launches", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai-sleep.mjs");
	writeFileSync(gentleAiScript, ["#!/usr/bin/env node", "await new Promise((resolve) => setTimeout(resolve, 60000));", "process.exit(0);", ""].join("\n"));
	chmodSync(gentleAiScript, 0o755);
	const env = enableAutoProvision({
		...f.env,
		GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript,
		GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0",
		GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS: "300",
	});

	const started = Date.now();
	const result = run(env, ["--mode", "rpc", "-p", "hi"]);
	const elapsed = Date.now() - started;
	assert.equal(result.status, 0, result.stderr);
	assert.ok(elapsed < 15000, `expected the hung child to be killed quickly, took ${elapsed}ms`);
	assert.match(result.stderr, /gentle-shell: automatic setup failed/);
	// The message reports the *effective* ceiling (GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS=300
	// above), not the hardcoded production default: 300ms is not a whole number
	// of minutes, so it renders in seconds.
	assert.match(result.stderr, /timed out after 0\.3 seconds/);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
});

test("a hung 'pi remove' during post-install cleanup is killed after the timeout ceiling and reports it in seconds too", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai-declares-conflict.mjs");
	writeGentleAiScriptDeclaringConflict(gentleAiScript);
	const hangingPiScript = join(f.root, "fake-pi-hangs-on-remove.mjs");
	writeFileSync(
		hangingPiScript,
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			'if (args.includes("--version")) { console.log("0.85.1"); process.exit(0); }',
			"if (args[0] === 'remove') { await new Promise((resolve) => setTimeout(resolve, 60000)); process.exit(0); }",
			"console.log(JSON.stringify({ args, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }));",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	chmodSync(hangingPiScript, 0o755);
	const env = enableAutoProvision({
		...f.env,
		GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript,
		GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0",
		GENTLE_SHELL_PI: hangingPiScript,
		GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS: "2000",
	});

	const started = Date.now();
	const result = run(env, ["--mode", "rpc", "-p", "hi"]);
	const elapsed = Date.now() - started;
	assert.equal(result.status, 0, result.stderr);
	assert.ok(elapsed < 15000, `expected the hung 'pi remove' to be killed quickly, took ${elapsed}ms`);
	assert.match(result.stderr, /gentle-shell: pi remove npm:@juicesharp\/rpiv-ask-user-question timed out after 2 seconds/);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args.slice(-4), ["--mode", "rpc", "-p", "hi"]);
});

test("manual setup never times out even past the auto-mode ceiling override", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai-sleep.mjs");
	writeFileSync(gentleAiScript, ["#!/usr/bin/env node", "await new Promise((resolve) => setTimeout(resolve, 300));", "process.exit(0);", ""].join("\n"));
	chmodSync(gentleAiScript, 0o755);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS: "50" };

	const result = run(env, ["setup"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /timed out/);
});

test("the provisioning marker write leaves no stray temp file behind", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScriptCountingRuns(gentleAiScript, join(f.root, "gentle-ai-runs.log"));
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, []);
	assert.equal(result.status, 0, result.stderr);
	const configDir = join(f.home, ".gentle-shell");
	assert.deepEqual(readdirSync(configDir), ["config.json"]);
});

// --- default Gentleman-Cute theme -------------------------------------------

test("a freshly bootstrapped home defaults to the Gentleman-Cute theme", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8"));
	assert.equal(settings.theme, "Gentleman-Cute");
});

test("automatic setup never overwrites a theme the home already declared", (t) => {
	const f = fixture(t);
	const target = join(f.root, "themed-home");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", theme: "rose" }));
	writeFileSync(join(target, ".gentle-shell-home"), JSON.stringify({ createdBy: "gentle-shell", version: ownGentlePiVersion() }));

	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
	assert.equal(settings.theme, "rose");
});

test("gentle-shell --link setup never touches the home's theme", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent-link");
	mkdirSync(piAgentDir, { recursive: true });
	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }));
	const gentleAiScript = join(f.root, "fake-gentle-ai.mjs");
	writeGentleAiScript(gentleAiScript);
	const env = { ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, PI_CODING_AGENT_DIR: piAgentDir };

	const result = run(env, ["--link", "setup"]);
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(join(piAgentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, undefined, "link mode must never gain a theme from gentle-shell's own default-theme logic");
});

test("automatic setup replaces a theme gentle-ai wrote into a home that had none with the default Gentle Shell theme", (t) => {
	const f = fixture(t);
	const target = join(f.root, "theme-home");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }));
	writeFileSync(join(target, ".gentle-shell-home"), JSON.stringify({ createdBy: "gentle-shell", version: ownGentlePiVersion() }));

	const gentleAiScript = join(f.root, "fake-gentle-ai-sets-theme.mjs");
	writeGentleAiScriptSettingTheme(gentleAiScript, "kanagawa");
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
	assert.equal(settings.theme, "Gentleman-Cute");
});

// R3-theme-enforcement-dead-on-fresh-home: on a brand-new home, the isolated
// bootstrap (installIsolatedTuiModeSetting) already writes "theme":
// "Gentleman-Cute" into settings.json *before* auto-provisioning's gentle-ai
// spawn ever runs — so the snapshot runSetupFlow takes right before that
// spawn already has a theme, and a naive "only act when the home had no
// theme before the spawn" check would never fire, letting gentle-ai's own
// theme silently win on every freshly bootstrapped home.
test("automatic setup restores the bootstrapped default theme when gentle-ai overwrites it on a fresh home", (t) => {
	const f = fixture(t);
	const gentleAiScript = join(f.root, "fake-gentle-ai-sets-theme.mjs");
	writeGentleAiScriptSettingTheme(gentleAiScript, "kanagawa");
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(join(f.gentleShellHome, "settings.json"), "utf8"));
	assert.equal(settings.theme, "Gentleman-Cute");
});

test("automatic setup restores the home's own theme when gentle-ai overwrites it", (t) => {
	const f = fixture(t);
	const target = join(f.root, "themed-home-to-restore");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", theme: "dracula" }));
	writeFileSync(join(target, ".gentle-shell-home"), JSON.stringify({ createdBy: "gentle-shell", version: ownGentlePiVersion() }));

	const gentleAiScript = join(f.root, "fake-gentle-ai-sets-theme.mjs");
	writeGentleAiScriptSettingTheme(gentleAiScript, "kanagawa");
	const env = enableAutoProvision({ ...f.env, GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" });

	const result = run(env, ["--home", target, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
	assert.equal(settings.theme, "dracula");
});

// --- --package-root silently ignored in a declared non-link home ----------

test("--package-root warns and is ignored when an isolated home already declares gentle-pi", (t) => {
	const f = fixture(t);
	mkdirSync(f.gentleShellHome, { recursive: true });
	writeFileSync(join(f.gentleShellHome, "settings.json"), JSON.stringify({ packages: ["npm:gentle-pi@3.5.1"], tuiMode: "fullscreen" }));
	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const result = run(f.env, ["--package-root", forcedRoot, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		new RegExp(
			`--package-root only forces a take-over in --link mode; ${f.gentleShellHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} declares gentle-pi, so the installed package is used and ${forcedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is ignored`,
		),
	);
	assert.doesNotMatch(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--mode", "rpc"]);
});

test("--package-root prints no warning when the home does not declare gentle-pi", (t) => {
	const f = fixture(t);
	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const result = run(f.env, ["--package-root", forcedRoot, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /--package-root only forces a take-over/);
});

test("--help mentions the setup subcommand", (t) => {
	const f = fixture(t);
	const result = run(f.env, ["--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /\bsetup\b/);
});

// --- --link takeover of a conflicting path package -----------------------
//
// Regression coverage for the settings.json shape that triggered the tool
// conflict bug: gentle-pi declared as a relative *path* package (not
// npm:gentle-pi) alongside another package. findGentlePiDeclaration now
// recognises that path declaration by reading its package.json "name", and
// the launcher takes over the pi invocation instead of also injecting its
// own -e, which used to load two copies of gentle-pi side by side.

test("--link takes over a path-declared conflicting gentle-pi: --no-extensions, the other package's dir, then this launcher's own -e, settings byte-identical", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	// "npm:some-other" must actually be installed under
	// <agentDir>/npm/node_modules for it to be re-injected (R3-001): a
	// declared-but-missing package dir is now skipped with a warning instead.
	mkdirSync(join(piAgentDir, "npm", "node_modules", "some-other"), { recursive: true });

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other", "../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--mode", "rpc"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	assert.match(result.stderr, /taking over gentle-pi from/);
	assert.match(result.stderr, /other-gentle-pi/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(piAgentDir, "npm", "node_modules", "some-other"),
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);

	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
	assert.equal(payload.PI_CODING_AGENT_DIR, piAgentDir);
});

test("--link install npm:x with a path-declared conflicting gentle-pi in settings forwards the bare subcommand, no take-over", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other", "../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "install", "npm:x"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["install", "npm:x"]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
	assert.equal(payload.PI_CODING_AGENT_DIR, piAgentDir);
});

test("--link does not take over a git-sourced other package: it is skipped with a warning, not injected", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	const settingsPath = join(piAgentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ packages: ["git:github.com/foo/bar", "../other-gentle-pi"] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /skipping git-sourced package/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});

test("--package-root forces a takeover even when settings already declare a matching npm:gentle-pi", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", forcedRoot], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from npm:gentle-pi/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", forcedRoot]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--package-root forces a takeover even with no gentle-pi declaration at all: --no-extensions and the other packages are still injected", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });
	// "npm:some-other" must actually be installed under
	// <agentDir>/npm/node_modules for it to be re-injected (R3-001).
	mkdirSync(join(piAgentDir, "npm", "node_modules", "some-other"), { recursive: true });
	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other"] });
	writeFileSync(settingsPath, settingsText);

	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", forcedRoot], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from the requested package root/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(piAgentDir, "npm", "node_modules", "some-other"),
		"-e",
		forcedRoot,
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--link take-over with --package-root injects exactly one -e when a settings path entry reaches the same physical directory through a symlink (R4-forced-root-symlink-double-injection)", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const packagesDir = join(piAgentDir, "packages");
	const realOtherDir = join(packagesDir, "real-other");
	mkdirSync(realOtherDir, { recursive: true });
	const linkOtherDir = join(packagesDir, "link-other");
	symlinkSync(realOtherDir, linkOtherDir, "dir");

	// settings declares the SYMLINK path; --package-root names the REAL path
	// directly. Both spellings reach the same physical directory, so it must
	// be injected exactly once instead of twice (once as an "other package"
	// via the symlink, once as this launcher's own package root).
	const settingsPath = join(piAgentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ packages: [join("packages", "link-other")] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", realOtherDir], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.equal(payload.args.filter((arg: string) => arg === "-e").length, 1);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		realOtherDir,
	]);
});

// --- loose extension files re-injected during a take-over -----------------
//
// Regression coverage for R4-003/R3-003 (and the follow-up bug it left
// behind): --no-extensions drops pi's normal settings-driven extension
// discovery, which also happens to be how pi finds loose (non-package)
// extensions under <agentDir>/extensions and the project-local
// <cwd>/.pi/extensions. Re-injecting those two directories wholesale as
// `-e <dir>` does not work: pi's `-e` flag hands the path straight to its
// module loader (no directory-discovery pass), so a bare directory holding
// only loose files fails with "Cannot find module ...". A take-over must
// instead discover each loose file the same way pi's own directory scan
// would (see discoverLooseExtensionEntries) and inject it individually.

test("--link take-over re-injects loose extension files, one -e per discovered file, from <agentDir>/extensions and the project-local .pi/extensions", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	// <agentDir>/extensions: a.ts, b.js, c.ts.bak-pre-fullscreen-fix (skipped,
	// suffix doesn't end in .ts/.js/.mjs), sub/index.ts, .hidden.ts (skipped).
	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(join(looseAgentExtensions, "sub"), { recursive: true });
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");
	writeFileSync(join(looseAgentExtensions, "b.js"), "export default () => {};");
	writeFileSync(join(looseAgentExtensions, "gentle-agent-state.ts.bak-pre-fullscreen-fix"), "stale backup");
	writeFileSync(join(looseAgentExtensions, ".hidden.ts"), "export default () => {};");
	writeFileSync(join(looseAgentExtensions, "sub", "index.ts"), "export default () => {};");

	const projectDir = join(f.root, "project");
	const looseProjectExtensions = join(projectDir, ".pi", "extensions");
	mkdirSync(looseProjectExtensions, { recursive: true });
	writeFileSync(join(looseProjectExtensions, "project-ext.mjs"), "export default () => {};");
	// The launcher derives this dir from process.cwd() inside the spawned
	// child, which resolves symlinks (e.g. macOS's /tmp -> /private/tmp);
	// realpath the expectation the same way so the two agree everywhere.
	const resolvedLooseProjectExtensions = join(realpathSync(projectDir), ".pi", "extensions");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--mode", "rpc"], { cwd: projectDir });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "a.ts"),
		"-e",
		join(looseAgentExtensions, "b.js"),
		"-e",
		join(looseAgentExtensions, "sub", "index.ts"),
		"-e",
		join(resolvedLooseProjectExtensions, "project-ext.mjs"),
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--link take-over injects a root-level index.ts as its own loose file entry, alongside a sibling loose file (R4-loose-index-collapses-sibling-extensions)", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "index.ts"), "export default () => {};");
	// A root-level index.ts is just another loose file, not a marker that
	// collapses the whole directory into a single -e <dir>: pi's own
	// discovery loads every direct *.ts/*.js/*.mjs file individually, so a
	// sibling like extra.ts must keep loading too instead of being dropped.
	writeFileSync(join(looseAgentExtensions, "extra.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "extra.ts"),
		"-e",
		join(looseAgentExtensions, "index.ts"),
		"-e",
		packageRoot,
	]);
});

test("--link take-over injects a subdirectory's own index.ts entry point even when the loose extensions dir has no other direct files", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	const subDir = join(looseAgentExtensions, "sub");
	mkdirSync(subDir, { recursive: true });
	writeFileSync(join(subDir, "index.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(subDir, "index.ts"),
		"-e",
		packageRoot,
	]);
});

test("--link take-over omits -e flags for loose extension dirs that do not exist", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});

// --- R3-001/R4-takeover-injects-unverified-package-dirs -------------------
//
// A settings.json package that is declared but not actually installed on
// disk (hand-edited file, a failed or interrupted `pi install`, an npm store
// laid out anywhere other than <agentDir>/npm/node_modules) must not be
// handed to pi as an unresolvable -e: pi's module loader fails on it with
// "Cannot find module", which would break every take-over launch against a
// partially-installed home. It is filtered the same way loose extension
// candidates already are, with one stderr warning naming the source and the
// resolved path, and the launch still succeeds.

test("--link take-over skips a declared package directory that is not installed, warns, and still launches; an installed one is still injected", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	// "npm:some-other" is declared but never installed under
	// <agentDir>/npm/node_modules, so its resolved directory does not exist.
	// "npm:installed-other" IS installed, so it must still be injected.
	const installedOtherDir = join(piAgentDir, "npm", "node_modules", "installed-other");
	mkdirSync(installedOtherDir, { recursive: true });

	const settingsPath = join(piAgentDir, "settings.json");
	const settingsText = JSON.stringify({ packages: ["npm:some-other", "npm:installed-other", "../other-gentle-pi"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--mode", "rpc"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	assert.match(result.stderr, /skipping declared package "npm:some-other"/);
	assert.match(result.stderr, /is not a directory/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		installedOtherDir,
		"-e",
		packageRoot,
		"--mode",
		"rpc",
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
});

test("--link take-over injects the launcher's own package root once when --package-root names a directory settings also declare as a plain path entry", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const settingsPath = join(piAgentDir, "settings.json");
	// The forced root is also declared as an ordinary (non-gentle-pi) path
	// package, so otherPackageInjections would resolve it to the same
	// directory as --package-root.
	const settingsText = JSON.stringify({ packages: ["../forced-root"] });
	writeFileSync(settingsPath, settingsText);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link", "--package-root", forcedRoot], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	const eFlags = payload.args.filter((arg: string, index: number) => payload.args[index - 1] === "-e");
	assert.deepEqual(eFlags, [forcedRoot]);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		forcedRoot,
	]);
});

test("--isolated --package-root produces the plain injection (no --no-extensions): the take-over path is gated on link mode", (t) => {
	const f = fixture(t);
	const forcedRoot = join(f.root, "forced-root");
	mkdirSync(forcedRoot, { recursive: true });

	const result = run(f.env, ["--isolated", "--package-root", forcedRoot, "--mode", "rpc"]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /taking over gentle-pi from/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"-e",
		forcedRoot,
		"--mode",
		"rpc",
	]);
});

test("--package-root naming a directory that does not exist fails with a clear error instead of launching", (t) => {
	const f = fixture(t);
	const missingRoot = join(f.root, "does-not-exist");

	const result = run(f.env, ["--package-root", missingRoot]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--package-root/);
	assert.match(result.stderr, /does not exist|not a directory/);
});

// --- R4-loose-extension-enumeration-fails-silently -------------------------

test("--link take-over warns once when a loose extensions directory cannot be read, instead of failing silently", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "mode bits do not block readdir here" : false }, (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");
	chmodSync(looseAgentExtensions, 0o000);

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	// Restore permissions immediately, before any assertion can throw and
	// skip cleanup: fixture()'s own t.after (registered before this test body
	// runs) removes f.root recursively, which requires read/execute
	// permission on every subdirectory, including this one.
	chmodSync(looseAgentExtensions, 0o755);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /could not read loose extension directory/);
	assert.match(result.stderr, /extensions/);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});

// --- R3-004: loose-extensions manifest branch coverage ----------------------

test("--link take-over falls through to per-file discovery when a loose dir's package.json declares an empty pi.extensions array", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "package.json"), JSON.stringify({ pi: { extensions: [] } }));
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "a.ts"),
		"-e",
		packageRoot,
	]);
});

test("--link take-over treats a malformed package.json as no manifest and falls through to per-file discovery", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const looseAgentExtensions = join(piAgentDir, "extensions");
	mkdirSync(looseAgentExtensions, { recursive: true });
	writeFileSync(join(looseAgentExtensions, "package.json"), "{ not valid json");
	writeFileSync(join(looseAgentExtensions, "a.ts"), "export default () => {};");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, [
		"--no-extensions",
		"-e",
		join(looseAgentExtensions, "a.ts"),
		"-e",
		packageRoot,
	]);
});

// --- R4-takeover-leaves-two-gentle-pi-skill-sets-loaded ---------------------

test("--link take-over stderr message also notes that the taken-over declaration's skills, prompts, and themes still load alongside this launcher's", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /taking over gentle-pi from/);
	assert.match(result.stderr, /skills, prompts, and themes/);
});

test("--link take-over treats a file named `extensions` as not a loose extension dir", (t) => {
	const f = fixture(t);
	const piAgentDir = join(f.root, "pi-agent");
	mkdirSync(piAgentDir, { recursive: true });

	const otherGentlePiDir = join(f.root, "other-gentle-pi");
	mkdirSync(otherGentlePiDir, { recursive: true });
	writeFileSync(join(otherGentlePiDir, "package.json"), JSON.stringify({ name: "gentle-pi" }));

	writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["../other-gentle-pi"] }));
	writeFileSync(join(piAgentDir, "extensions"), "not a directory");

	const env = { ...f.env, PI_CODING_AGENT_DIR: piAgentDir };
	const result = run(env, ["--link"], { cwd: f.root });
	assert.equal(result.status, 0, result.stderr);

	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.args, ["--no-extensions", "-e", packageRoot]);
});
