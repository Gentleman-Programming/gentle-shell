import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import {
	BUNDLED_VERIFY_ENV,
	bundledChildEnv,
	bundledPi,
	bundledSetupEnv,
	bundledUpdateNext,
	bundledUpdateNotice,
	bundledUpdatePlan,
	parseBundledUpgradeArgs,
	withBundledNpmCommand,
	resolveBundledInstall,
	setBundledInstallForTesting,
	type BundledFs,
	type BundledPi,
} from "../lib/gentle-shell-bundled.ts";
import { artifactFor, engramPinVersion } from "../scripts/installer-downloads.mjs";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { resolveBackgroundSubagentsPolicy } from "../lib/background-subagents-policy.ts";

// A fake filesystem keyed by exact paths, so every platform's paths are plain
// strings on every runner: realpath maps a link to its target, and any other
// path holding a file to itself; readText returns a regular file's text,
// readLink a symlink's.
function fakeFs({ real = {}, files = {}, links = {} }: { real?: Record<string, string>; files?: Record<string, string>; links?: Record<string, string> }): BundledFs {
	const known = [...Object.keys(files), ...Object.keys(links), ...Object.values(real)];
	const exists = (path: string) => known.some((entry) => entry === path || entry.startsWith(`${path}/`) || entry.startsWith(`${path}\\`));
	return {
		realpath: (path) => real[path] ?? (exists(path) ? path : undefined),
		readText: (path) => files[path],
		readLink: (path) => links[path],
	};
}

const ID = "4.1.0-1.1.0";
const POSIX_ROOT = "/home/ana/.gentle-shell";
const POSIX_VERSION = posix.join(POSIX_ROOT, "versions", ID);
const POSIX_PACKAGE = posix.join(POSIX_VERSION, "node_modules", ".pnpm", "gentle-pi@4.1.0", "node_modules", "gentle-pi");
const PI_PACKAGE = (version: string, path = posix) => path.join(version, "node_modules", "@earendil-works", "pi-coding-agent");

function posixInstall(overrides: { current?: string; marker?: string; link?: string } = {}) {
	return fakeFs({
		real: { [posix.join(POSIX_VERSION, "node_modules", "gentle-pi")]: overrides.link ?? POSIX_PACKAGE },
		files: { [posix.join(POSIX_VERSION, ".gentle-shell-version")]: overrides.marker ?? `${ID}\n`, [posix.join(POSIX_PACKAGE, "package.json")]: "{}" },
		links: { [posix.join(POSIX_ROOT, "current")]: overrides.current ?? `versions/${ID}` },
	});
}

test("resolveBundledInstall finds the version folder current names from the real package root", () => {
	assert.deepEqual(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall() }),
		{ root: POSIX_ROOT, id: ID, versionDir: POSIX_VERSION });
});

test("resolveBundledInstall is off unless current names this marked version and its gentle-pi is this package", () => {
	// Kept for rollback, but not the active one.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ current: "versions/4.0.0-1.0.0" }) }), undefined);
	// An unfinished install, or a folder without our marker.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ marker: `installing ${ID} 42\n` }) }), undefined);
	// The version's gentle-pi is another copy, not the running one.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ link: "/elsewhere/gentle-pi" }) }), undefined);
	// A global npm or pnpm install, or a source checkout.
	for (const packageRoot of ["/usr/lib/node_modules/gentle-pi", "/home/ana/.local/share/pnpm/global/5/node_modules/gentle-pi", "/home/ana/src/gentle-shell"]) {
		assert.equal(resolveBundledInstall({ packageRoot, platform: "linux", fs: posixInstall() }), undefined, packageRoot);
	}
	// An id the bundled install never writes.
	const unsafe = posix.join(POSIX_ROOT, "versions", "-x", "node_modules", "gentle-pi");
	assert.equal(resolveBundledInstall({ packageRoot: unsafe, platform: "linux", fs: fakeFs({
		files: { [posix.join(POSIX_ROOT, "versions", "-x", ".gentle-shell-version")]: "-x\n" }, links: { [posix.join(POSIX_ROOT, "current")]: "versions/-x" } }) }), undefined);
});

test("resolveBundledInstall treats only the version being verified as current, for that check", () => {
	const kept = posixInstall({ current: "versions/4.0.0-1.0.0" });
	assert.deepEqual(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: kept, verifying: ID }), { root: POSIX_ROOT, id: ID, versionDir: POSIX_VERSION });
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: kept, verifying: "4.0.0-1.0.0" }), undefined);
	// The marker and the package location are still required.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ current: "versions/x", marker: "x\n" }), verifying: ID }), undefined);
});

test("resolveBundledInstall on Windows reads the current pointer file, never a link", () => {
	const root = "C:\\Users\\Ana\\AppData\\Local\\gentle-shell";
	const version = win32.join(root, "versions", ID);
	const packageRoot = win32.join(version, "node_modules", ".pnpm", "gentle-pi@4.1.0", "node_modules", "gentle-pi");
	const files = { [win32.join(version, ".gentle-shell-version")]: `${ID}\n`, [win32.join(root, "current")]: `${ID}\n` };
	const real = { [win32.join(version, "node_modules", "gentle-pi")]: packageRoot };
	assert.deepEqual(resolveBundledInstall({ packageRoot, platform: "win32", fs: fakeFs({ real, files }) }), { root, id: ID, versionDir: version });
	const linked = fakeFs({ real, files: { [win32.join(version, ".gentle-shell-version")]: `${ID}\n` }, links: { [win32.join(root, "current")]: `versions/${ID}` } });
	assert.equal(resolveBundledInstall({ packageRoot, platform: "win32", fs: linked }), undefined);
});

function piFiles(pinned: string, installed: string, path = posix, version = POSIX_VERSION) {
	const pi = PI_PACKAGE(version, path);
	return {
		[path.join(version, "package.json")]: JSON.stringify({ dependencies: { "gentle-pi": "4.1.0", "@earendil-works/pi-coding-agent": pinned } }),
		[path.join(pi, "package.json")]: JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: installed, bin: { pi: "dist/bundle/cli.js" } }),
		[path.join(pi, "dist", "bundle", "cli.js")]: "",
	};
}
const install = { root: POSIX_ROOT, id: ID, versionDir: POSIX_VERSION };
const messageOf = (pi: BundledPi) => ("message" in pi ? pi.message : "");

test("bundledPi returns only the Pi the version pins, inside the version folder", () => {
	assert.deepEqual(bundledPi(install, { platform: "linux", fs: fakeFs({ files: piFiles("1.1.0", "1.1.0") }) }),
		{ ok: true, version: "1.1.0", cli: posix.join(PI_PACKAGE(POSIX_VERSION), "dist", "bundle", "cli.js") });
	const windows = { root: "C:\\G", id: ID, versionDir: `C:\\G\\versions\\${ID}` };
	assert.deepEqual(bundledPi(windows, { platform: "win32", fs: fakeFs({ files: piFiles("1.1.0", "1.1.0", win32, windows.versionDir) }) }),
		{ ok: true, version: "1.1.0", cli: win32.join(PI_PACKAGE(windows.versionDir, win32), "dist", "bundle", "cli.js") });
});

test("bundledPi fails with the version, the pinned Pi and the way to repair it", () => {
	const repair = /Gentle Shell 4\.1\.0-1\.1\.0 .*Pi 1\.1\.0.*gentle-shell upgrade.*installer/s;
	const mismatch = bundledPi(install, { platform: "linux", fs: fakeFs({ files: piFiles("1.1.0", "1.0.0") }) });
	assert.equal(mismatch.ok, false);
	assert.match(messageOf(mismatch), repair);
	assert.match(messageOf(mismatch), /found Pi 1\.0\.0/);
	const files = piFiles("1.1.0", "1.1.0");
	delete files[posix.join(PI_PACKAGE(POSIX_VERSION), "dist", "bundle", "cli.js")];
	const missing = bundledPi(install, { platform: "linux", fs: fakeFs({ files }) });
	assert.match(messageOf(missing), repair);
	// A Pi linked from outside the version folder is not the bundled one.
	const outside = fakeFs({ real: { [PI_PACKAGE(POSIX_VERSION)]: "/usr/lib/node_modules/@earendil-works/pi-coding-agent" }, files: piFiles("1.1.0", "1.1.0") });
	assert.equal(bundledPi(install, { platform: "linux", fs: outside }).ok, false);
});

const ISOLATION = { prefix: "/g", engram: "/g/runtime/engram-3.4.0/engram" };

test("bundledChildEnv keeps the user's environment and adds only the bundled Pi, the prefix and Engram, no Pi override and no Pi update check", () => {
	const user = { PATH: "/home/ana/.nvm/bin:/usr/bin", NODE_OPTIONS: "--max-old-space-size=4096", npm_config_registry: "https://npm.example", npm_config_prefix: "/home/ana/.npm-global",
		GENTLE_SHELL_PI: "/usr/local/bin/pi", GENTLE_PI_AGENTS_PI: "pi", [BUNDLED_VERIFY_ENV]: ID, GENTLE_PI_CONFIG_HOME: "/home/ana/.pi/gentle-ai" };
	const env = bundledChildEnv(user, { node: "/g/node", cli: "/g/cli.js", ...ISOLATION });
	// S9: Gentle AI's own variables never reach Pi (its shell would pass them to
	// a gentle-ai the user runs); gentle-pi adds them to its own gentle-ai runs.
	// GENTLE_PI_CONFIG_HOME stays the user's: gentle-pi derives its bundled config
	// folder from the prefix, and Gentle AI 4.0.0 reads that variable as a parent.
	assert.deepEqual(env, { PATH: user.PATH, NODE_OPTIONS: user.NODE_OPTIONS, npm_config_registry: user.npm_config_registry, npm_config_prefix: user.npm_config_prefix,
		GENTLE_PI_CONFIG_HOME: user.GENTLE_PI_CONFIG_HOME, GENTLE_PI_AGENTS_PI: "/g/node /g/cli.js", PI_SKIP_VERSION_CHECK: "1", GENTLE_SHELL_PREFIX: "/g",
		ENGRAM_BIN: "/g/runtime/engram-3.4.0/engram" });
	// The subagent runner splits that variable on whitespace: a spaced path falls
	// back to its own default, the running node and cli.js.
	const spaced = bundledChildEnv({ GENTLE_PI_AGENTS_PI: "pi" }, { node: "C:\\Users\\Ana Li\\node.exe", cli: "C:\\cli.js", ...ISOLATION });
	assert.equal("GENTLE_PI_AGENTS_PI" in spaced, false);
	// gentle-engram reads ENGRAM_BIN: the user's own choice is kept, and an
	// Engram that is not published is never named.
	assert.equal(bundledChildEnv({ ENGRAM_BIN: "/opt/engram" }, { node: "/g/node", cli: "/g/cli.js", ...ISOLATION }).ENGRAM_BIN, "/opt/engram");
	assert.equal("ENGRAM_BIN" in bundledChildEnv({}, { node: "/g/node", cli: "/g/cli.js", ...ISOLATION, engram: undefined }), false);
});

test("bundledSetupEnv puts only our node and the version's bin ahead of the user's PATH", () => {
	const env = bundledSetupEnv({ PATH: "/usr/bin", NODE_OPTIONS: "--x", npm_config_registry: "r" }, { dirs: ["/g/node-bin", "/g/v/node_modules/.bin"], platform: "linux" });
	assert.deepEqual(env, { PATH: "/g/node-bin:/g/v/node_modules/.bin:/usr/bin", NODE_OPTIONS: "--x", npm_config_registry: "r" });
	const windows = bundledSetupEnv({ Path: "C:\\Windows" }, { dirs: ["C:\\G\\node"], platform: "win32" });
	assert.deepEqual(windows, { Path: "C:\\G\\node;C:\\Windows" });
});

test("withBundledNpmCommand sets only npmCommand and leaves an already bundled settings file as it is", () => {
	const command = ["/g/node", "/g/npm-cli.js", "--userconfig=/g/npmrc"];
	const text = '{\n    "theme": "gentle",\n    "packages": ["npm:x"]\n}\n';
	const added = withBundledNpmCommand(text, command);
	assert.equal(added.status, "write");
	const written = added.status === "write" ? added.text : "";
	assert.deepEqual(JSON.parse(written), { theme: "gentle", packages: ["npm:x"], npmCommand: command });
	assert.match(written, /^\{\n {4}"theme"/);
	assert.ok(written.endsWith("}\n"));
	assert.deepEqual(withBundledNpmCommand(written, command), { status: "unchanged" });
	const replaced = withBundledNpmCommand('{"npmCommand":["npm"]}', command);
	assert.deepEqual(JSON.parse(replaced.status === "write" ? replaced.text : "{}"), { npmCommand: command });
	assert.deepEqual(JSON.parse((withBundledNpmCommand(undefined, command) as { text: string }).text), { npmCommand: command });
	for (const malformed of ["{", "[]", "null"]) assert.deepEqual(withBundledNpmCommand(malformed, command), { status: "malformed" });
});

test("bundledUpdatePlan redirects Pi's own update and keeps the extension updates", () => {
	assert.deepEqual(bundledUpdatePlan(["update"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "--self"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "pi"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "self"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "--all"]), { self: true, piArgs: ["update", "--extensions"] });
	assert.deepEqual(bundledUpdatePlan(["update", "--self", "--extensions", "--approve"]), { self: true, piArgs: ["update", "--extensions", "--approve"] });
	// Pi reads a self positional with --extensions as "all" too.
	for (const target of ["pi", "self"]) {
		assert.deepEqual(bundledUpdatePlan(["update", target, "--extensions"]), { self: true, piArgs: ["update", "--extensions"] }, target);
		assert.deepEqual(bundledUpdatePlan(["update", "--extensions", target, "-a"]), { self: true, piArgs: ["update", "--extensions", "-a"] }, target);
	}
	// Pi itself refuses conflicting or unknown forms before updating anything.
	for (const passthrough of [["update", "--extensions"], ["update", "npm:x"], ["update", "--models"], ["update", "--extension", "npm:x"], ["update", "--help"],
		["update", "--all", "--self"], ["update", "pi", "--all"], ["update", "pi", "npm:x"], ["update", "--bogus"]]) {
		assert.deepEqual(bundledUpdatePlan(passthrough), { self: false, piArgs: passthrough }, passthrough.join(" "));
	}
});

test("bundledUpdateNext still updates extensions when the upgrade did not complete", () => {
	assert.deepEqual(bundledUpdateNext({ self: false, piArgs: ["update", "npm:x"] }, undefined), { piArgs: ["update", "npm:x"] });
	assert.deepEqual(bundledUpdateNext({ self: true }, 0), { exitCode: 0 });
	assert.deepEqual(bundledUpdateNext({ self: true }, 1), { exitCode: 1 });
	assert.deepEqual(bundledUpdateNext({ self: true }, undefined), { exitCode: 0 });
	assert.deepEqual(bundledUpdateNext({ self: true, piArgs: ["update", "--extensions"] }, 0), { piArgs: ["update", "--extensions"] });
	const failed = bundledUpdateNext({ self: true, piArgs: ["update", "--extensions"] }, 1);
	assert.deepEqual("piArgs" in failed ? failed.piArgs : [], ["update", "--extensions"]);
	assert.match("note" in failed ? String(failed.note) : "", /upgrade did not complete.*extensions/);
});

test("bundledUpdateNotice explains the pinned Pi and runs or names gentle-shell upgrade", () => {
	const interactive = bundledUpdateNotice({ piVersion: "1.1.0", interactive: true }).join("\n");
	assert.match(interactive, /Pi ships pinned with Gentle Shell \(Pi 1\.1\.0\)/);
	assert.match(interactive, /Running 'gentle-shell upgrade'/);
	assert.match(bundledUpdateNotice({ piVersion: "1.1.0", interactive: false }).join("\n"), /Run 'gentle-shell upgrade'/);
});

test("parseBundledUpgradeArgs accepts the release channel and --rollback and refuses the main channel", () => {
	assert.deepEqual(parseBundledUpgradeArgs([]), { action: "upgrade" });
	assert.deepEqual(parseBundledUpgradeArgs(["--channel", "release"]), { action: "upgrade" });
	assert.deepEqual(parseBundledUpgradeArgs(["--channel=release"]), { action: "upgrade" });
	assert.deepEqual(parseBundledUpgradeArgs(["--rollback"]), { action: "rollback" });
	for (const args of [["--channel", "main"], ["--channel=main"]]) {
		const parsed = parseBundledUpgradeArgs(args);
		assert.equal("error" in parsed && parsed.usage, false);
		assert.match("error" in parsed ? parsed.error : "", /release channel only/);
	}
	for (const args of [["--rollback", "--channel", "release"], ["--channel"], ["--nope"]]) {
		const parsed = parseBundledUpgradeArgs(args);
		assert.equal("error" in parsed && parsed.usage, true, args.join(" "));
	}
});

// The real bin, run from a bundled prefix: a copy of bin/ and package.json
// placed where pnpm puts gentle-pi (runtime/ and scripts/ linked from this
// checkout), a fake exact Pi beside it, and `current` naming the version.
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const posixHost = process.platform === "win32" ? "the bundled prefix fixture uses a POSIX current symlink" : false;
const SHELL = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).version;
const FIXTURE_ID = `${SHELL}-1.1.0`;
const FAKE_PI = [
	"import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'; import {join, dirname} from 'node:path';",
	"const args = process.argv.slice(2);",
	"if (args[0] === 'install' && args[1] === 'npm:gentle-engram@0.4.2' && process.env.FIXTURE_INSTALL_CAPABILITY !== '0') {",
	" const home = process.env.PI_CODING_AGENT_DIR; const metadata = join(home, 'npm/node_modules/gentle-engram/package.json'); mkdirSync(dirname(metadata), {recursive:true});",
	" writeFileSync(metadata, JSON.stringify({name:'gentle-engram',version:'0.4.2',engram:{startupPolicy:1}}));",
	" const path = join(home,'settings.json'); let settings={}; try {settings=JSON.parse(readFileSync(path,'utf8'));} catch {}",
	" if (process.env.FIXTURE_INSTALL_CAPABILITY !== 'metadata-only') { const packages = settings.packages ?? []; const index = packages.findIndex(p => /^npm:gentle-engram(?:@|$)/.test(typeof p === 'string' ? p : p.source));",
	" if (index < 0) packages.push(args[1]); else packages[index] = typeof packages[index] === 'string' ? args[1] : {...packages[index], source:args[1]}; settings.packages = packages; writeFileSync(path, JSON.stringify(settings)); }",
	"}",
	"if (args.includes('--version')) { console.log('1.1.0'); process.exit(0); }",
	// Stands in for gentle-engram creating the store through the bundled core during the session.
	"if (process.env.FIXTURE_CREATE_STORE && args[0] !== 'install' && args[0] !== 'list') {",
	" const data = join(process.env.HOME, '.engram');",
	" if (process.env.ENGRAM_BIN?.includes('engram-guard') !== true) { mkdirSync(data, {recursive:true});",
	"  if (!existsSync(join(data, '.instance-id'))) writeFileSync(join(data, '.instance-id'), process.env.FIXTURE_CREATE_STORE + '\\n');",
	"  const header = Buffer.alloc(4096); header.write('SQLite format 3\\0', 0, 'latin1'); header.writeUInt16BE(4096, 16); header[18] = 2; header[19] = 2;",
	"  writeFileSync(join(data, 'engram.db'), header); writeFileSync(join(data, 'engram.db-wal'), '');",
	" }",
	"}",
	"const pick = ['PATH', 'GENTLE_SHELL_PI', 'GENTLE_PI_AGENTS_PI', 'PI_SKIP_VERSION_CHECK', 'npm_config_prefix', 'npm_config_registry', 'NODE_OPTIONS', 'PI_CODING_AGENT_DIR',",
	"\t'GENTLE_SHELL_PREFIX', 'GENTLE_PI_CONFIG_HOME', 'ENGRAM_BIN', 'ENGRAM_URL', 'ENGRAM_STARTUP_POLICY', 'ENGRAM_STARTUP_NOTICE', 'GENTLE_AI_HOME', 'GENTLE_AI_PI_CONFIG_DIR', 'GENTLE_AI_ENGRAM_BIN', 'GENTLE_AI_NO_SELF_UPDATE', 'GH_TOKEN', 'ENGRAM_NO_UPDATE_CHECK'];",
	"const record = join(process.env.GENTLE_SHELL_PREFIX ?? '', 'config', 'engram-provenance.json');",
	"const provenance = (() => { try { return JSON.parse(readFileSync(record, 'utf8')); } catch { return null; } })();",
	"console.log(JSON.stringify({ cli: process.argv[1], args, provenance, env: Object.fromEntries(pick.map((k) => [k, process.env[k]])) }));",
	// Stands in for a crash, kill or power loss of the launcher before its exit handler runs.
	"if (process.env.FIXTURE_KILL_LAUNCHER && args[0] !== 'install') process.kill(process.ppid, 'SIGKILL');",
].join("\n");
const FIXTURE_CORE = [
	"#!/bin/sh",
	'if [ "$1" != instance-id ]; then echo engram; exit 0; fi',
	'[ -z "$FIXTURE_PROVISION_ENV" ] || env > "$FIXTURE_PROVISION_ENV"',
	'[ -z "$FIXTURE_INSTANCE_ID_FAIL" ] || exit 3',
	'mkdir -p "$HOME/.engram" || exit 1',
	'[ -f "$HOME/.engram/.instance-id" ] || printf \'%s\\n\' "${FIXTURE_INSTANCE_ID:-0123456789abcdef0123456789abcdef}" > "$HOME/.engram/.instance-id"',
	'cat "$HOME/.engram/.instance-id"',
	"",
].join("\n");

function bundledPrefix(t: TestContext, { pi = "1.1.0", core = true } = {}) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gentle-shell-bundled-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const home = join(base, "home");
	const root = join(home, ".gentle-shell");
	const version = join(root, "versions", FIXTURE_ID);
	const modules = join(version, "node_modules");
	const shell = join(modules, ".pnpm", `gentle-pi@${SHELL}`, "node_modules", "gentle-pi");
	mkdirSync(join(shell, "bin"), { recursive: true });
	writeFileSync(join(shell, "bin", "gentle-shell.mjs"), readFileSync(join(repository, "bin", "gentle-shell.mjs")));
	const guard = join(shell, "bin", "engram-guard");
	if (existsSync(join(repository, "bin", "engram-guard"))) {
		copyFileSync(join(repository, "bin", "engram-guard"), guard);
		chmodSync(guard, 0o755);
	}
	writeFileSync(join(shell, "package.json"), readFileSync(join(repository, "package.json")));
	for (const dir of ["runtime", "scripts"]) symlinkSync(join(repository, dir), join(shell, dir));
	symlinkSync(shell, join(modules, "gentle-pi"));
	const piDir = join(modules, "@earendil-works", "pi-coding-agent");
	mkdirSync(join(piDir, "dist", "bundle"), { recursive: true });
	writeFileSync(join(piDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: pi, bin: { pi: "dist/bundle/cli.js" } }));
	writeFileSync(join(piDir, "dist", "bundle", "cli.js"), FAKE_PI);
	writeFileSync(join(version, "package.json"), JSON.stringify({ dependencies: { "gentle-pi": SHELL, "@earendil-works/pi-coding-agent": "1.1.0" } }));
	writeFileSync(join(version, ".gentle-shell-version"), `${FIXTURE_ID}\n`);
	symlinkSync(`versions/${FIXTURE_ID}`, join(root, "current"));
	// The bundled npm the npmCommand entry loads.
	const npmCli = join(root, "runtime", "node-24.21.0", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	mkdirSync(dirname(npmCli), { recursive: true });
	writeFileSync(npmCli, "console.log('11.19.0');\n");
	// The pinned Engram, published as ensureEngram leaves it (reused, never downloaded here).
	// With `core: false` the prefix is as the wizard leaves it, without Engram.
	const engramDir = join(root, "runtime", `engram-${engramPinVersion}`);
	const engram = join(engramDir, "engram");
	if (core) {
		mkdirSync(engramDir, { recursive: true });
		writeFileSync(engram, FIXTURE_CORE, { mode: 0o700 });
		writeFileSync(join(engramDir, ".gentle-shell-runtime"), `${artifactFor("engram", process.platform, process.arch).url}\n`);
	}
	// The launcher's ensureEngram never downloads here: a module hook gives it a
	// stand-in that publishes the same files and marker a verified download would.
	const publisher = join(base, "engram-publisher.mjs");
	writeFileSync(publisher, `export * from ${JSON.stringify(pathToFileURL(join(repository, "scripts", "bundled-install.mjs")).href)};
		import { artifactFor } from ${JSON.stringify(pathToFileURL(join(repository, "scripts", "installer-downloads.mjs")).href)};
		import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
		export async function ensureEngram({ layout, platform, arch }) {
			if (existsSync(layout.engram)) return false;
			mkdirSync(layout.engramDir, { recursive: true });
			writeFileSync(layout.engram, ${JSON.stringify(FIXTURE_CORE)}, { mode: 0o700 });
			writeFileSync(layout.engramDir + '/.gentle-shell-runtime', artifactFor('engram', platform, arch).url + '\\n');
			return true;
		}`);
	const hooks = join(base, "engram-hooks.mjs");
	writeFileSync(hooks, `export async function resolve(specifier, context, next) {
		if (specifier.endsWith('scripts/bundled-install.mjs') && context.parentURL?.endsWith('/bin/gentle-shell.mjs')) {
			return { url: ${JSON.stringify(pathToFileURL(publisher).href)}, shortCircuit: true };
		}
		return next(specifier, context);
	}`);
	const registerHooks = join(base, "engram-register.mjs");
	writeFileSync(registerHooks, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
	// A Pi on PATH and in GENTLE_SHELL_PI that must never run.
	const userBin = join(base, "user-bin");
	mkdirSync(userBin);
	writeFileSync(join(userBin, "pi"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
	// No test contacts the actual default Engram endpoint: connections to 7437
	// are redirected to a closed ephemeral port (refused) or to a local fixture
	// server (FIXTURE_ENGRAM_PORT). FIXTURE_NO_PROBE makes any probe fail the test.
	const network = join(base, "network.mjs");
	writeFileSync(network, `import net from 'node:net'; import { syncBuiltinESMExports } from 'node:module';
		const original = net.createConnection;
		const probe = net.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
		const closed = probe.address().port; await new Promise((resolve) => probe.close(resolve));
		net.createConnection = (options, ...rest) => {
			if (Number(options?.port ?? options) !== 7437) return original(options, ...rest);
			if (process.env.FIXTURE_NO_PROBE === '1') { process.stderr.write('unexpected Engram probe\\n'); process.exit(97); }
			return original({ ...options, port: Number(process.env.FIXTURE_ENGRAM_PORT || closed) }, ...rest);
		};
		syncBuiltinESMExports();`);
	const metadata = join(home, ".gentle-shell", "agent", "npm", "node_modules", "gentle-engram", "package.json");
	mkdirSync(dirname(metadata), { recursive: true });
	writeFileSync(metadata, JSON.stringify({ name: "gentle-engram", version: "0.4.2", engram: { startupPolicy: 1 } }));
	const env = { HOME: home, PATH: `${userBin}:/usr/bin:/bin`, GENTLE_SHELL_PI: join(userBin, "pi"), GENTLE_SHELL_NO_AUTO_SETUP: "1",
		NODE_OPTIONS: `--no-warnings --import=${network} --import=${registerHooks}`, npm_config_registry: "https://npm.example" };
	const entry = join(root, "current", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
	const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [entry, ...args], { env: { ...env, ...extra }, encoding: "utf8", input: "" });
	return { root, home, userBin, version, piDir, npmCli, engram, metadata, network, guard, run, env, entry: join(shell, "bin", "gentle-shell.mjs") };
}

const STORE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_STORE_ID = "fedcba9876543210fedcba9876543210";
const lastLaunch = (result: { stdout: string }) => JSON.parse(result.stdout.trim().split("\n").at(-1)!);
const memoryOf = (result: { stdout: string }) => [lastLaunch(result).env.ENGRAM_STARTUP_POLICY, lastLaunch(result).env.ENGRAM_BIN];
const provenancePath = (prefix: { root: string }) => join(prefix.root, "config", "engram-provenance.json");
const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function writeHeader(path: string, userVersion: number, magic = "SQLite format 3\0") {
	const header = Buffer.alloc(4096);
	header.write(magic, 0, "latin1");
	header.writeUInt16BE(4096, 16);
	header[18] = 2;
	header[19] = 2;
	header.writeUInt32BE(userVersion, 60);
	writeFileSync(path, header);
}

// A local fixture standing in for a running Engram server on an ephemeral port;
// the launcher's probe of the default port is redirected to it.
async function engramServer(t: TestContext, routes: Record<string, [number, unknown]>): Promise<string> {
	const script = `const routes = ${JSON.stringify(routes)};
		require('node:http').createServer((request, response) => { const [status, body] = routes[request.url] ?? [404, { error: 'not found' }];
		response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); })
		.listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => { child.kill(); });
	return new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk).trim())));
}

test("a fresh launch provisions the store identity and finalizes provenance before Pi starts", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const provisioning = join(prefix.home, "provisioning-env");
	const result = prefix.run([], { FIXTURE_PROVISION_ENV: provisioning, GH_TOKEN: "fixture-token", GITHUB_TOKEN: "fixture-token" });
	assert.equal(result.status, 0, result.stderr);
	const seen = lastLaunch(result);
	assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN, seen.env.ENGRAM_URL], ["allow", prefix.engram, undefined]);
	// Already finalized while Pi runs, from the identity file the core wrote.
	const record = { schema: 1, dataDir: join(prefix.home, ".engram"), instanceId: STORE_ID, coreSha256: sha256File(prefix.engram) };
	assert.deepEqual(seen.provenance, record);
	assert.deepEqual(JSON.parse(readFileSync(provenancePath(prefix), "utf8")), record);
	// Only the provisioning child skips Engram's update check and loses GitHub tokens; Pi keeps the user's environment.
	const child = Object.fromEntries(readFileSync(provisioning, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
	assert.deepEqual([child.ENGRAM_NO_UPDATE_CHECK, child.GH_TOKEN, child.GITHUB_TOKEN, child.ENGRAM_DATA_DIR, child.HOME], ["1", undefined, undefined, undefined, prefix.home]);
	assert.deepEqual([seen.env.GH_TOKEN, seen.env.ENGRAM_NO_UPDATE_CHECK], ["fixture-token", undefined]);
});

test("a session that never creates a database keeps Shell's identity; a foreign store with another identity is never adopted", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	assert.equal(prefix.run([]).status, 0);
	const data = join(prefix.home, ".engram");
	assert.deepEqual(readdirSync(data).sort(), [".instance-id"]);
	assert.deepEqual(memoryOf(prefix.run([])), ["allow", prefix.engram]);
	// Another Engram client replaces the shared directory with its own store.
	rmSync(data, { recursive: true });
	mkdirSync(data);
	writeFileSync(join(data, ".instance-id"), `${OTHER_STORE_ID}\n`);
	writeHeader(join(data, "engram.db"), 1);
	const foreign = prefix.run([]);
	assert.deepEqual(memoryOf(foreign), ["disabled", prefix.guard]);
	assert.equal(JSON.parse(readFileSync(provenancePath(prefix), "utf8")).instanceId, STORE_ID);
});
test("a later launch reuses Shell's own store, including a stale WAL header, without rewriting provenance", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	assert.equal(prefix.run([], { FIXTURE_CREATE_STORE: STORE_ID }).status, 0);
	const recorded = readFileSync(provenancePath(prefix), "utf8");
	for (const userVersion of [0, 1]) {
		writeHeader(join(prefix.home, ".engram", "engram.db"), userVersion);
		const second = prefix.run([]);
		assert.equal(second.status, 0, second.stderr);
		const seen = lastLaunch(second);
		assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN, seen.env.ENGRAM_URL], ["allow", prefix.engram, undefined], String(userVersion));
	}
	assert.equal(readFileSync(provenancePath(prefix), "utf8"), recorded);
});

test("provenance mismatches disable memory behind the guard: instance, core digest, newer or malformed header", { skip: posixHost }, (t) => {
	const mismatches: Array<[string, (prefix: ReturnType<typeof bundledPrefix>) => void]> = [
		["instance", (prefix) => writeFileSync(join(prefix.home, ".engram", ".instance-id"), `${OTHER_STORE_ID}\n`)],
		["invalid identity", (prefix) => writeFileSync(join(prefix.home, ".engram", ".instance-id"), "not-an-id\n")],
		["core digest", (prefix) => writeFileSync(prefix.engram, "#!/bin/sh\necho upgraded engram\n", { mode: 0o700 })],
		["newer schema", (prefix) => writeHeader(join(prefix.home, ".engram", "engram.db"), 2)],
		["malformed header", (prefix) => writeHeader(join(prefix.home, ".engram", "engram.db"), 1, "not sqlite at all")],
		["symlinked database", (prefix) => {
			const db = join(prefix.home, ".engram", "engram.db");
			renameSync(db, `${db}.real`);
			symlinkSync(`${db}.real`, db);
		}],
		["corrupt provenance", (prefix) => writeFileSync(provenancePath(prefix), "{")],
	];
	for (const [name, change] of mismatches) {
		const prefix = bundledPrefix(t);
		assert.equal(prefix.run([], { FIXTURE_CREATE_STORE: STORE_ID }).status, 0, name);
		change(prefix);
		const result = prefix.run([]);
		assert.equal(result.status, 0, `${name}: ${result.stderr}`);
		const seen = lastLaunch(result);
		assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN], ["disabled", prefix.guard], name);
		assert.match(result.stderr, /memory disabled.*could not verify.*compatibility.*Back up/s, name);
	}
});

test("public help explains compatibility evidence without promising update recovery", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const result = prefix.run(["--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /Matching versions or updating alone do not prove compatibility/);
	assert.match(result.stdout, /\/compatibility/);
	assert.doesNotMatch(result.stdout, /update Engram, restart/);
});

test("a foreign pre-existing store stays disabled and never receives provenance", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const data = join(prefix.home, ".engram");
	mkdirSync(data);
	writeFileSync(join(data, ".instance-id"), `${STORE_ID}\n`);
	writeHeader(join(data, "engram.db"), 1);
	const result = prefix.run([], { FIXTURE_CREATE_STORE: STORE_ID });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual([lastLaunch(result).env.ENGRAM_STARTUP_POLICY, lastLaunch(result).env.ENGRAM_BIN], ["disabled", prefix.guard]);
	assert.equal(existsSync(provenancePath(prefix)), false);
});

test("a listening server is reused for Shell's store only with the recorded /health instance and the exact core version", { skip: posixHost }, async (t) => {
	const cases: Array<[string, unknown, string]> = [
		["match", { status: "ok", instance_id: STORE_ID, version: engramPinVersion }, "allow"],
		["other instance", { status: "ok", instance_id: OTHER_STORE_ID, version: engramPinVersion }, "disabled"],
		["other version", { status: "ok", instance_id: STORE_ID, version: "9.9.9" }, "disabled"],
	];
	for (const [name, health, policy] of cases) {
		const prefix = bundledPrefix(t);
		assert.equal(prefix.run([], { FIXTURE_CREATE_STORE: STORE_ID }).status, 0, name);
		const port = await engramServer(t, { "/health": [200, health] });
		const result = prefix.run([], { FIXTURE_ENGRAM_PORT: port });
		assert.equal(result.status, 0, `${name}: ${result.stderr}`);
		const seen = lastLaunch(result);
		assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN, seen.env.ENGRAM_URL],
			[policy, policy === "allow" ? prefix.engram : prefix.guard, undefined], name);
	}
});

test("a verified /compatibility server is reused through an explicit URL and the guard, without provenance", { skip: posixHost }, async (t) => {
	const ready = { revision: 1, source: "active", status: "ready", offline_automatic_opening_authorized: false, active_reuse_authorized: true,
		instance_id: STORE_ID, runtime_id: "a".repeat(32), capability: "startup-verified-store-v1" };
	const prefix = bundledPrefix(t);
	const data = join(prefix.home, ".engram");
	mkdirSync(data);
	writeHeader(join(data, "engram.db"), 1);
	const port = await engramServer(t, { "/compatibility": [200, ready] });
	const result = prefix.run([], { FIXTURE_ENGRAM_PORT: port });
	assert.equal(result.status, 0, result.stderr);
	const seen = lastLaunch(result);
	assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_URL, seen.env.ENGRAM_BIN], ["allow", "http://127.0.0.1:7437", prefix.guard]);
	assert.equal(existsSync(provenancePath(prefix)), false);
	const unready = bundledPrefix(t);
	mkdirSync(join(unready.home, ".engram"));
	const notReady = await engramServer(t, { "/compatibility": [200, { ...ready, status: "unknown", active_reuse_authorized: false }] });
	assert.equal(lastLaunch(unready.run([], { FIXTURE_ENGRAM_PORT: notReady })).env.ENGRAM_STARTUP_POLICY, "disabled");
});

test("a foreign store behind a 3.3.2 server stays guarded and the launch names the server version to update", { skip: posixHost }, async (t) => {
	const prefix = bundledPrefix(t);
	const data = join(prefix.home, ".engram");
	mkdirSync(data);
	writeHeader(join(data, "engram.db"), 1);
	const before = readFileSync(join(data, "engram.db"));
	// Engram 3.3.2 has no /compatibility route (the fixture answers 404).
	const port = await engramServer(t, { "/health": [200, { status: "ok", service: "engram", version: "3.3.2", instance_id: OTHER_STORE_ID }] });
	const result = prefix.run([], { FIXTURE_ENGRAM_PORT: port });
	assert.equal(result.status, 0, result.stderr);
	const seen = lastLaunch(result);
	assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN, seen.env.ENGRAM_URL], ["disabled", prefix.guard, undefined]);
	assert.match(result.stderr, /memory disabled.*reports version 3\.3\.2.*update that server to 3\.4\.0 or later/s);
	assert.deepEqual(readFileSync(join(data, "engram.db")), before);
	assert.equal(existsSync(provenancePath(prefix)), false);
});

test("a fresh launch whose launcher is killed during Pi already has finalized provenance, and the next launch allows memory", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const first = prefix.run([], { FIXTURE_CREATE_STORE: STORE_ID, FIXTURE_KILL_LAUNCHER: "1" });
	assert.equal(first.signal, "SIGKILL");
	assert.equal(JSON.parse(readFileSync(provenancePath(prefix), "utf8")).instanceId, STORE_ID);
	assert.deepEqual(memoryOf(prefix.run([])), ["allow", prefix.engram]);
});
test("a failed identity provisioning disables memory for that launch and records nothing", { skip: posixHost }, (t) => {
	const cases: Array<[string, Record<string, string>, (prefix: ReturnType<typeof bundledPrefix>) => void]> = [
		["instance-id failure", { FIXTURE_INSTANCE_ID_FAIL: "1" }, () => {}],
		["invalid identity file", { FIXTURE_INSTANCE_ID: "not-an-id" }, () => {}],
		["provenance write failure", {}, (prefix) => mkdirSync(provenancePath(prefix), { recursive: true })],
	];
	for (const [name, extra, prepare] of cases) {
		const prefix = bundledPrefix(t);
		prepare(prefix);
		const result = prefix.run([], extra);
		assert.equal(result.status, 0, `${name}: ${result.stderr}`);
		assert.deepEqual(memoryOf(result), ["disabled", prefix.guard], name);
		assert.match(result.stderr, /could not provision/, name);
		assert.equal(lastLaunch(result).provenance, null, name);
	}
});

test("--version and forwarded Pi version or help flags never probe Engram, install the companion or print memory notices", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	writeFileSync(prefix.metadata, '{"name":"gentle-engram","version":"0.4.1"}');
	mkdirSync(join(prefix.home, ".engram"));
	assert.equal(prefix.run([], { FIXTURE_INSTALL_CAPABILITY: "0" }).status, 0);
	const settings = join(prefix.home, ".gentle-shell", "agent", "settings.json");
	const before = readFileSync(settings, "utf8");
	for (const args of [["--version"], ["--", "--version"], ["--", "-v"], ["--", "--help"], ["--", "explain this", "-h"]]) {
		const result = prefix.run(args, { FIXTURE_NO_PROBE: "1" });
		assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
		assert.doesNotMatch(result.stderr, /memory disabled|installing policy-capable|startupPolicy/, args.join(" "));
		assert.equal(readFileSync(settings, "utf8"), before, args.join(" "));
		assert.equal(JSON.parse(readFileSync(prefix.metadata, "utf8")).version, "0.4.1", args.join(" "));
	}
	assert.equal(existsSync(provenancePath(prefix)), false);
});

test("-v or --help as a prompt or an option value never switches memory off", { skip: posixHost }, (t) => {
	for (const args of [["--", "--", "-v"], ["--", "--model", "-v", "hello"], ["--", "--name", "--help"], ["--", "explain the -v flag"]]) {
		const prefix = bundledPrefix(t);
		const result = prefix.run(args);
		assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
		assert.deepEqual(memoryOf(result), ["allow", prefix.engram], args.join(" "));
		assert.equal(lastLaunch(result).provenance.instanceId, STORE_ID, args.join(" "));
	}
});
test("a missing bundled core uses the guard, never an engram on PATH", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	rmSync(prefix.engram);
	const marker = join(prefix.home, "path-engram-ran");
	writeFileSync(join(prefix.userBin, "engram"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
	const result = prefix.run([]);
	assert.equal(result.status, 0, result.stderr);
	const seen = lastLaunch(result);
	assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN], ["disabled", prefix.guard]);
	assert.match(seen.env.ENGRAM_STARTUP_NOTICE, /bundled Engram core/);
	assert.equal(spawnSync(seen.env.ENGRAM_BIN, ["instance-id"], { env: { ...prefix.env, ...seen.env } }).status === 0, false);
	assert.equal(existsSync(marker), false);
});

// A Gentle AI stand-in for setup: counts its runs and changes nothing else.
function countingGentleAi(prefix: ReturnType<typeof bundledPrefix>) {
	const log = join(prefix.home, "installer-runs");
	const bin = join(prefix.userBin, "gentle-ai");
	writeFileSync(bin, `#!/bin/sh\necho run >> '${log}'\n`, { mode: 0o755 });
	return { bin, runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
}

test("setup on a fresh machine publishes the bundled core; the next launch is fresh, records provenance and is reused", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t, { core: false });
	const installer = countingGentleAi(prefix);
	const setup = prefix.run(["setup"], { GENTLE_SHELL_GENTLE_AI_BIN: installer.bin });
	assert.equal(setup.status, 0, setup.stderr);
	assert.equal(installer.runs(), 1);
	assert.equal(existsSync(prefix.engram), true);
	const first = prefix.run([], { FIXTURE_CREATE_STORE: STORE_ID });
	assert.equal(first.status, 0, first.stderr);
	assert.deepEqual([lastLaunch(first).env.ENGRAM_STARTUP_POLICY, lastLaunch(first).env.ENGRAM_BIN], ["allow", prefix.engram]);
	assert.equal(JSON.parse(readFileSync(provenancePath(prefix), "utf8")).instanceId, STORE_ID);
	const second = prefix.run([]);
	assert.equal(second.status, 0, second.stderr);
	assert.deepEqual([lastLaunch(second).env.ENGRAM_STARTUP_POLICY, lastLaunch(second).env.ENGRAM_BIN], ["allow", prefix.engram]);
});

test("an explicit ENGRAM_URL alone keeps the verified core, or the guard without it, as ENGRAM_BIN", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const url = { ENGRAM_URL: "https://do-not-contact.invalid" };
	const seen = lastLaunch(prefix.run([], url)).env;
	assert.deepEqual([seen.ENGRAM_BIN, seen.ENGRAM_URL, seen.ENGRAM_STARTUP_POLICY], [prefix.engram, url.ENGRAM_URL, "disabled"]);
	rmSync(prefix.engram);
	assert.equal(lastLaunch(prefix.run([], url)).env.ENGRAM_BIN, prefix.guard);
	assert.equal(lastLaunch(prefix.run([], { ...url, ENGRAM_BIN: "/chosen/binary" })).env.ENGRAM_BIN, "/chosen/binary");
});

test("a failed companion check after setup is a warning, not a setup failure", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	writeFileSync(prefix.metadata, '{"name":"gentle-engram","version":"0.4.1"}');
	const data = join(prefix.home, ".engram");
	mkdirSync(data);
	writeFileSync(join(data, "engram.db"), "untouched database sentinel");
	const installer = countingGentleAi(prefix);
	const setup = prefix.run(["setup"], { GENTLE_SHELL_GENTLE_AI_BIN: installer.bin, FIXTURE_INSTALL_CAPABILITY: "0" });
	assert.equal(setup.status, 0, setup.stderr);
	assert.equal(installer.runs(), 1);
	assert.match(setup.stderr, /startupPolicy/);
	assert.deepEqual(memoryOf(prefix.run([], { FIXTURE_INSTALL_CAPABILITY: "0" })), ["disabled", prefix.guard]);
	assert.deepEqual(readdirSync(data), ["engram.db"]);
	assert.equal(readFileSync(join(data, "engram.db"), "utf8"), "untouched database sentinel");
});

test("setup with a foreign existing store runs the installer like the baseline, while memory stays behind the guard", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t, { core: false });
	const data = join(prefix.home, ".engram");
	mkdirSync(data);
	writeFileSync(join(data, "engram.db"), "untouched database sentinel");
	const installer = countingGentleAi(prefix);
	const setup = prefix.run(["setup"], { GENTLE_SHELL_GENTLE_AI_BIN: installer.bin });
	assert.equal(setup.status, 0, setup.stderr);
	assert.equal(installer.runs(), 1);
	assert.equal(existsSync(prefix.engram), true);
	assert.match(setup.stderr, /memory disabled.*could not verify.*compatibility.*Back up/s);
	assert.doesNotMatch(setup.stderr, /update Engram and restart/);
	assert.doesNotMatch(setup.stderr, /deferred/);
	const guarded = prefix.run([]);
	assert.equal(guarded.status, 0, guarded.stderr);
	const env = lastLaunch(guarded).env;
	assert.deepEqual([env.ENGRAM_STARTUP_POLICY, env.ENGRAM_BIN, env.ENGRAM_URL], ["disabled", prefix.guard, undefined]);
	// Subagents receive the same environment (GENTLE_PI_AGENTS_PI runs the same Pi with it).
	assert.equal(env.GENTLE_PI_AGENTS_PI.endsWith(join("dist", "bundle", "cli.js")), true);
	const provider = spawnSync(env.ENGRAM_BIN, ["instance-id"], { env: { ...prefix.env, ...env }, encoding: "utf8" });
	assert.notEqual(provider.status, 0);
	assert.match(provider.stderr, /Back up/);
	const result = prefix.run([], { ENGRAM_BIN: "/chosen/binary", ENGRAM_URL: "https://do-not-contact.invalid" });
	assert.equal(result.status, 0, result.stderr);
	const seen = lastLaunch(result);
	assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN, seen.env.ENGRAM_URL], ["disabled", "/chosen/binary", "https://do-not-contact.invalid"]);
	assert.equal(readFileSync(join(data, "engram.db"), "utf8"), "untouched database sentinel");
	assert.deepEqual(readdirSync(data), ["engram.db"]);
	assert.equal(existsSync(provenancePath(prefix)), false);
});

test("a gentle-pi version change re-provisions Shell's own store once and keeps its memory", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t, { core: false });
	const installer = countingGentleAi(prefix);
	const auto = { GENTLE_SHELL_NO_AUTO_SETUP: "", GENTLE_SHELL_GENTLE_AI_BIN: installer.bin };
	const first = prefix.run([], { ...auto, FIXTURE_CREATE_STORE: STORE_ID });
	assert.equal(first.status, 0, first.stderr);
	assert.equal(installer.runs(), 1);
	assert.deepEqual([lastLaunch(first).env.ENGRAM_STARTUP_POLICY, lastLaunch(first).env.ENGRAM_BIN], ["allow", prefix.engram]);
	assert.equal(existsSync(provenancePath(prefix)), true);
	assert.equal(prefix.run([], auto).status, 0);
	assert.equal(installer.runs(), 1);
	const manifest = join(dirname(dirname(prefix.entry)), "package.json");
	writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "999.0.0" }));
	const changed = prefix.run([], auto);
	assert.equal(changed.status, 0, changed.stderr);
	assert.equal(installer.runs(), 2);
	assert.doesNotMatch(changed.stderr, /automatic setup failed|deferred/);
	assert.deepEqual([lastLaunch(changed).env.ENGRAM_STARTUP_POLICY, lastLaunch(changed).env.ENGRAM_BIN], ["allow", prefix.engram]);
	assert.equal(prefix.run([], auto).status, 0);
	assert.equal(installer.runs(), 2);
});

test("an unsupported companion is pinned through Pi configuration; a failed readback warns and the guard still protects memory", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	writeFileSync(prefix.metadata, '{"name":"gentle-engram","version":"0.4.1"}');
	mkdirSync(join(prefix.home, ".engram"));
	const result = prefix.run([], { FIXTURE_INSTALL_CAPABILITY: "0" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /install.*npm:gentle-engram@0.4.2/s);
	assert.match(result.stderr, /startupPolicy/);
	assert.equal(lastLaunch(result).env.ENGRAM_BIN, prefix.guard);
});

test("capability readback also requires Pi to declare the selected pinned companion", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const result = prefix.run([], { FIXTURE_INSTALL_CAPABILITY: "metadata-only" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /startupPolicy/);
	// Only the identity Shell provisions before Pi: no database is opened.
	assert.deepEqual(readdirSync(join(prefix.home, ".engram")), [".instance-id"]);
});

test("pinning preserves resource filters and unrelated settings and does not reinstall next launch", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const settings = join(prefix.home, ".gentle-shell", "agent", "settings.json");
	const other = { source: "npm:unrelated", extensions: ["keep.ts"] };
	writeFileSync(settings, JSON.stringify({ theme: "chosen", packages: [other, { source: "npm:gentle-engram@0.4.1", autoload: false, extensions: [] }] }));
	const first = prefix.run([]);
	assert.equal(first.status, 0, first.stderr);
	const updated = JSON.parse(readFileSync(settings, "utf8"));
	assert.equal(updated.theme, "chosen");
	assert.deepEqual(updated.packages, [other, { source: "npm:gentle-engram@0.4.2", autoload: false, extensions: [] }]);
	assert.doesNotMatch(prefix.run([]).stderr, /installing policy-capable companion/);
});

test("final startup rechecks data created during automatic setup and records no provenance for it", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const fake = join(prefix.userBin, "gentle-ai");
	writeFileSync(fake, `#!/bin/sh\nmkdir -p "$HOME/.engram"\nprintf '${STORE_ID}\\n' > "$HOME/.engram/.instance-id"\nprintf fixture > "$HOME/.engram/engram.db"\n`, { mode: 0o755 });
	const result = prefix.run([], { GENTLE_SHELL_NO_AUTO_SETUP: "", GENTLE_SHELL_GENTLE_AI_BIN: fake });
	assert.equal(result.status, 0, result.stderr);
	const seen = lastLaunch(result);
	assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN], ["disabled", prefix.guard]);
	assert.equal(readFileSync(join(prefix.home, ".engram", "engram.db"), "utf8"), "fixture");
	assert.equal(existsSync(provenancePath(prefix)), false);
});

test("explicit endpoints and invalid policies never trigger availability probes or override executables", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	for (const value of ["", "disabled", "invalid"]) {
		const result = prefix.run([], { FIXTURE_NO_PROBE: "1", ENGRAM_STARTUP_POLICY: value, ENGRAM_URL: "https://do-not-contact.invalid", ENGRAM_BIN: "/never-execute" });
		assert.equal(result.status, 0, result.stderr);
		const seen = lastLaunch(result);
		assert.deepEqual([seen.env.ENGRAM_STARTUP_POLICY, seen.env.ENGRAM_BIN, seen.env.ENGRAM_URL], ["disabled", "/never-execute", "https://do-not-contact.invalid"]);
	}
	const policyOnly = prefix.run([], { FIXTURE_NO_PROBE: "1", ENGRAM_STARTUP_POLICY: "invalid" });
	assert.equal(policyOnly.status, 0, policyOnly.stderr);
	assert.equal(lastLaunch(policyOnly).env.ENGRAM_BIN, prefix.guard);
});

test("startup offer precedes Pi, not-now preserves config and omit suppresses just that release", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const config = join(prefix.root, "config.json");
	writeFileSync(config, '{"other":"preserved"}\n');
	const preload = (latest: string) => `
		Object.defineProperty(process.stdin, 'isTTY', {value:true});
		Object.defineProperty(process.stdout, 'isTTY', {value:true});
		process.stdin.setRawMode = (raw) => { process.stdin.isRaw = raw; };
		globalThis.fetch = async () => new Response(JSON.stringify({version:${JSON.stringify(latest)}}));
	`;
	const run = (latest: string, input: string, args: string[] = []) => spawnSync(process.execPath, [prefix.entry, ...args], {
		env: { ...prefix.env, NODE_OPTIONS: `${prefix.env.NODE_OPTIONS} --import=data:text/javascript,${encodeURIComponent(preload(latest))}` },
		encoding: "utf8", input, timeout: 10000,
	});
	const skipped = run("999.0.0", "2\r");
	assert.equal(skipped.status, 0, skipped.stderr);
	assert.match(skipped.stdout, /Gentle Shell update available/);
	assert.ok(skipped.stdout.indexOf("Gentle Shell update available") < skipped.stdout.indexOf('"cli":'));
	assert.equal(readFileSync(config, "utf8"), '{"other":"preserved"}\n');
	const omitted = run("999.0.0", "3\r");
	assert.equal(omitted.status, 0, omitted.stderr);
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { other: "preserved", skippedStartupRelease: "999.0.0" });
	assert.doesNotMatch(run("999.0.0", "").stdout, /Gentle Shell update available/);
	assert.match(run("999.0.1", "2\r").stdout, /Gentle Shell update available/);
	const command = run("999.0.1", "", ["list"]);
	assert.equal(command.status, 0, command.stderr);
	assert.doesNotMatch(command.stdout, /Gentle Shell update available/);
	assert.deepEqual(JSON.parse(command.stdout.trim().split("\n").at(-1)).args, ["list"]);
});

test("the bundled launcher runs only its version's Pi, with the user's environment and the bundled npm in its own home", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const version = prefix.run(["--version"]);
	assert.equal(version.status, 0, version.stderr);
	assert.match(version.stdout, new RegExp(`^gentle-shell ${SHELL.replaceAll(".", "\\.")}\npi 1\\.1\\.0\n`));
	const launched = prefix.run(["list"]);
	assert.equal(launched.status, 0, launched.stderr);
	const seen = JSON.parse(launched.stdout.trim().split("\n").at(-1) ?? "{}");
	assert.equal(seen.cli, join(realpathSync(prefix.piDir), "dist", "bundle", "cli.js"));
	assert.deepEqual(seen.args, ["list"]);
	assert.equal(seen.env.GENTLE_SHELL_PI, undefined);
	assert.equal(seen.env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(seen.env.GENTLE_PI_AGENTS_PI, `${process.execPath} ${seen.cli}`);
	// S9: what the agent runs in the user's projects sees the user's tools and settings.
	assert.equal(seen.env.PATH, prefix.env.PATH);
	assert.equal(seen.env.NODE_OPTIONS, prefix.env.NODE_OPTIONS);
	assert.equal(seen.env.npm_config_registry, "https://npm.example");
	assert.equal(seen.env.npm_config_prefix, undefined);
	// S9: gentle-pi's config folder inside the prefix, the pinned Engram for
	// gentle-engram, and none of Gentle AI's own variables.
	assert.equal(seen.env.GENTLE_SHELL_PREFIX, prefix.root);
	assert.equal(seen.env.GENTLE_PI_CONFIG_HOME, undefined);
	assert.equal(seen.env.ENGRAM_BIN, prefix.engram);
	for (const name of ["GENTLE_AI_HOME", "GENTLE_AI_PI_CONFIG_DIR", "GENTLE_AI_ENGRAM_BIN", "GENTLE_AI_NO_SELF_UPDATE"]) assert.equal(seen.env[name], undefined, name);
	// Pi's own npm is ours, configured only from the prefix, through the isolated home's settings.
	const settings = JSON.parse(readFileSync(join(prefix.home, ".gentle-shell", "agent", "settings.json"), "utf8"));
	const shim = join(prefix.root, "runtime", "node-24.21.0", "gentle-shell", "npm");
	assert.deepEqual(settings.npmCommand.slice(0, 2), [join(prefix.root, "runtime", "node-24.21.0", "bin", "node"), shim]);
	// The entry named npm exists before Pi is given it, and runs our npm.
	assert.equal(spawnSync(process.execPath, [shim, "--version"], { encoding: "utf8" }).stdout, "11.19.0\n");
	assert.ok(settings.npmCommand.includes(`--userconfig=${join(prefix.root, "pnpm", "config", "npmrc")}`));
	assert.equal(settings.npmCommand.some((part: string) => part.startsWith("--prefix")), false);
	// --link is the user's own Pi home: never given our npm.
	const linked = join(prefix.home, ".pi", "agent");
	mkdirSync(linked, { recursive: true });
	writeFileSync(join(linked, "settings.json"), "{}\n");
	assert.equal(prefix.run(["--link", "list"]).status, 0);
	assert.equal(readFileSync(join(linked, "settings.json"), "utf8"), "{}\n");
});

// S9: `gentle-shell setup` gives the pinned Gentle AI the prefix's state folder,
// gentle-pi config folder and Engram, and no self-update; the personas and the
// managed-asset record it may rewrite are put back.
test("bundled setup runs Gentle AI with the prefix's isolation variables and keeps both personas", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const probe = join(prefix.home, "gentle-ai-env.txt");
	const fakeGentleAi = join(prefix.userBin, "gentle-ai");
	// Writes what a Gentle AI with and without #5462 would: the prefix persona and the user's.
	// Without the variable (a launcher that does not set it) it writes inside the temporary HOME, never elsewhere.
	writeFileSync(fakeGentleAi, ["#!/bin/sh", `env > "${probe}"`, 'config="${GENTLE_AI_PI_CONFIG_DIR:-$HOME/no-config-dir}"', 'mkdir -p "$config" "$HOME/.pi/gentle-ai"',
		'echo rewritten > "$config/persona.json"', 'echo rewritten > "$HOME/.pi/gentle-ai/persona.json"', ""].join("\n"), { mode: 0o755 });
	const userPersona = join(prefix.home, ".pi", "gentle-ai", "persona.json");
	const prefixPersona = join(prefix.root, "config", "gentle-ai", "persona.json");
	for (const path of [userPersona, prefixPersona]) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{\"mode\":\"chosen\"}\n");
	}
	const result = prefix.run(["setup"], { GENTLE_SHELL_GENTLE_AI_BIN: fakeGentleAi, ENGRAM_BIN: "", GENTLE_AI_HOME: "/home/ana/.gentle-ai" });
	assert.equal(result.status, 0, result.stderr);
	const seen = Object.fromEntries(readFileSync(probe, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
	assert.equal(seen.GENTLE_AI_HOME, join(prefix.root, "gentle-ai"));
	assert.equal(seen.GENTLE_AI_PI_CONFIG_DIR, join(prefix.root, "config", "gentle-ai"));
	assert.equal(seen.GENTLE_AI_ENGRAM_BIN, prefix.engram);
	// #2105: the pinned Engram is the first `engram` on Gentle AI's PATH, so no `brew` is needed.
	assert.equal(seen.PATH.split(":")[0], dirname(prefix.engram));
	assert.equal(seen.GENTLE_AI_NO_SELF_UPDATE, "1");
	assert.equal(seen.PI_CODING_AGENT_DIR, join(prefix.home, ".gentle-shell", "agent"));
	// Only setup's Gentle AI gets it, as the parent Gentle AI 4.0.0 reads it as.
	assert.equal(seen.GENTLE_PI_CONFIG_HOME, join(prefix.root, "config"));
	for (const path of [userPersona, prefixPersona]) assert.equal(readFileSync(path, "utf8"), "{\"mode\":\"chosen\"}\n", path);
});

// B2a: a Gentle AI that knows no GENTLE_AI_PI_CONFIG_DIR (the pinned 4.0.0,
// internal/cli/pi_background.go piBackgroundPolicyPath) writes the managed
// background-subagents policy to <GENTLE_PI_CONFIG_HOME>/gentle-ai, else to
// ~/.pi/gentle-ai. Bundled setup makes that the bundled gentle-pi's own config
// folder, and the user's ~/.pi/gentle-ai stays untouched.
test("bundled setup puts Gentle AI 4.0.0's background-subagents policy where the bundled gentle-pi reads it", { skip: posixHost }, async (t) => {
	const prefix = bundledPrefix(t);
	const fakeGentleAi = join(prefix.userBin, "gentle-ai");
	writeFileSync(fakeGentleAi, ["#!/bin/sh", 'base="${GENTLE_PI_CONFIG_HOME:-$HOME/.pi}"', 'mkdir -p "$base/gentle-ai"',
		`printf '%s' '{"schema":"gentle-pi.background-subagents/v1","policy":"on"}' > "$base/gentle-ai/background-subagents.json"`, ""].join("\n"), { mode: 0o755 });
	const result = prefix.run(["setup"], { GENTLE_SHELL_GENTLE_AI_BIN: fakeGentleAi });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(prefix.home, ".pi", "gentle-ai")), false, "the user's config folder is untouched");
	// The bundled gentle-pi's own reading: its config home is derived from the prefix.
	setBundledInstallForTesting({ root: prefix.root });
	t.after(() => setBundledInstallForTesting(undefined));
	const env = { GENTLE_SHELL_PREFIX: prefix.root };
	const resolution = resolveBackgroundSubagentsPolicy(prefix.home, { env, gentlePiConfigHome: gentlePiConfigHome(env) });
	assert.deepEqual([resolution.policy, resolution.source], ["on", "global_file"]);
	assert.equal(resolution.globalFile, join(prefix.root, "config", "gentle-ai", "background-subagents.json"));
});

test("a home holding the npmCommand written before the npm entry existed gets only that key updated", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const node = join(prefix.root, "runtime", "node-24.21.0");
	const flags = [`--userconfig=${join(prefix.root, "pnpm", "config", "npmrc")}`, `--globalconfig=${join(prefix.root, "npm", "npmrc")}`,
		`--cache=${join(prefix.root, "npm", "cache")}`, "--update-notifier=false"];
	// The value written before N1: npm-cli.js directly, and a --prefix flag.
	const previous = [join(node, "bin", "node"), prefix.npmCli, ...flags.slice(0, 3), `--prefix=${join(prefix.root, "npm", "prefix")}`, flags[3]];
	const agent = join(prefix.home, ".gentle-shell", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), `${JSON.stringify({ theme: "gentle", npmCommand: previous, packages: ["npm:x"] }, null, 2)}\n`);
	assert.equal(prefix.run(["list"]).status, 0);
	const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
	assert.deepEqual(settings, { theme: "gentle", npmCommand: [join(node, "bin", "node"), join(node, "gentle-shell", "npm"), ...flags], packages: ["npm:x"] });
});

test("a runtime without our npm gives Pi no npmCommand and says so", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	rmSync(prefix.npmCli);
	const result = prefix.run(["list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /could not give Pi the bundled npm.*Bundled npm missing/);
	const settings = join(prefix.home, ".gentle-shell", "agent", "settings.json");
	assert.equal(existsSync(settings) && "npmCommand" in JSON.parse(readFileSync(settings, "utf8")), false);
});

test("the version check before activation runs that version in bundled mode, never a PATH Pi", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const other = join(prefix.root, "versions", "0.0.1-1.0.0");
	mkdirSync(other);
	writeFileSync(join(other, ".gentle-shell-version"), "0.0.1-1.0.0\n");
	rmSync(join(prefix.root, "current"));
	symlinkSync("versions/0.0.1-1.0.0", join(prefix.root, "current"));
	const verify = (env: Record<string, string>) => spawnSync(process.execPath, [prefix.entry, "--version"], { env: { HOME: prefix.home, PATH: `${prefix.userBin}:/usr/bin:/bin`, ...env },
		encoding: "utf8", input: "" });
	const good = verify({ [BUNDLED_VERIFY_ENV]: FIXTURE_ID });
	assert.equal(good.status, 0, good.stderr);
	assert.match(good.stdout, /\npi 1\.1\.0\n/);
	// The version's own Pi is broken, and the user's Pi prints the expected version.
	writeFileSync(join(prefix.userBin, "pi"), "#!/bin/sh\necho 1.1.0\n", { mode: 0o755 });
	rmSync(join(prefix.piDir, "dist", "bundle", "cli.js"));
	const broken = verify({ [BUNDLED_VERIFY_ENV]: FIXTURE_ID });
	assert.equal(broken.status, 1);
	assert.match(broken.stderr, /bundled Pi 1\.1\.0/);
	// Without the verification input, the same entry is an ordinary launcher that would pass.
	assert.match(verify({}).stdout, /\npi 1\.1\.0\n/);
	// Only --version honors it.
	const list = spawnSync(process.execPath, [prefix.entry, "list"], { env: { HOME: prefix.home, PATH: `${prefix.userBin}:/usr/bin:/bin`, [BUNDLED_VERIFY_ENV]: FIXTURE_ID,
		GENTLE_SHELL_NO_AUTO_SETUP: "1" }, encoding: "utf8", input: "" });
	assert.equal(list.stdout, "1.1.0\n");
});

test("the bundled launcher refuses a Pi that is not the pinned one", { skip: posixHost }, (t) => {
	const result = bundledPrefix(t, { pi: "1.0.0" }).run(["--version"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, new RegExp(`Gentle Shell ${FIXTURE_ID.replaceAll(".", "\\.")} .*gentle-shell upgrade`, "s"));
	assert.doesNotMatch(result.stdout, /9\.9\.9/);
});

test("gentle-shell update in a bundled install explains the pinned Pi instead of updating it", { skip: posixHost }, (t) => {
	const result = bundledPrefix(t).run(["update"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Pi ships pinned with Gentle Shell \(Pi 1\.1\.0\)/);
	assert.match(result.stdout, /Run 'gentle-shell upgrade'/);
	assert.doesNotMatch(result.stdout, /"args"/);
});

test("gentle-shell update pi --extensions in a bundled install redirects Pi's part and still updates the extensions with the bundled npm", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const result = prefix.run(["update", "pi", "--extensions"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Pi ships pinned with Gentle Shell \(Pi 1\.1\.0\)/);
	const seen = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
	assert.deepEqual(seen.args, ["update", "--extensions"]);
	assert.ok(JSON.parse(readFileSync(join(prefix.home, ".gentle-shell", "agent", "settings.json"), "utf8")).npmCommand);
});

test("a kept version that current does not name keeps the ordinary launcher, Pi override and Pi update included", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const other = join(prefix.root, "versions", "0.0.1-1.0.0");
	mkdirSync(other);
	writeFileSync(join(other, ".gentle-shell-version"), "0.0.1-1.0.0\n");
	rmSync(join(prefix.root, "current"));
	symlinkSync("versions/0.0.1-1.0.0", join(prefix.root, "current"));
	const update = spawnSync(process.execPath, [prefix.entry, "update"], { env: { HOME: dirname(prefix.root), PATH: "/usr/bin:/bin",
		GENTLE_SHELL_PI: join(dirname(dirname(prefix.root)), "user-bin", "pi"), GENTLE_SHELL_NO_AUTO_SETUP: "1" }, encoding: "utf8", input: "" });
	assert.equal(update.status, 0, update.stderr);
	assert.equal(update.stdout, "9.9.9\n");
});

test("gentle-shell upgrade in a bundled install refuses the main channel and rolls back to the kept version", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const main = prefix.run(["upgrade", "--channel", "main"]);
	assert.equal(main.status, 1);
	assert.match(main.stderr, /release channel only/);
	const none = prefix.run(["upgrade", "--rollback"]);
	assert.equal(none.status, 1);
	assert.match(none.stderr, /No previous Gentle Shell version/);
	assert.equal(readlinkSync(join(prefix.root, "current")), `versions/${FIXTURE_ID}`);
});

// T6 (S6, S7): the bundled launcher's self-uninstall, end to end through the real bin.
test("gentle-shell self-uninstall in a bundled install removes the recorded PATH line and the prefix's own folders, and keeps the Gentle Shell home", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const zshrc = join(prefix.home, ".zshrc");
	const line = `export PATH="${join(prefix.root, "bin")}:$PATH" # gentle-shell bundled install`;
	writeFileSync(zshrc, `alias ll='ls -l'\n${line}\n`);
	writeFileSync(join(prefix.root, "path-entry.json"), JSON.stringify({ schema: 1, kind: "profile", path: zshrc, line, create: false, separator: false }));
	mkdirSync(join(prefix.root, "bin"));
	writeFileSync(join(prefix.root, "bin", "gentle-shell"), "#!/bin/sh\n");
	const agent = join(prefix.home, ".gentle-shell", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "auth.json"), "{}");
	const dry = prefix.run(["self-uninstall", "--dry-run"]);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /bundled install in /);
	assert.ok(dry.stdout.includes(`the line ${line} in ${zshrc}`));
	assert.equal(readFileSync(zshrc, "utf8"), `alias ll='ls -l'\n${line}\n`);
	const result = prefix.run(["self-uninstall", "--yes"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Gentle Shell was removed\./);
	assert.equal(readFileSync(zshrc, "utf8"), "alias ll='ls -l'\n");
	assert.deepEqual(readdirSync(prefix.root), ["agent"]);
	assert.equal(readFileSync(join(agent, "auth.json"), "utf8"), "{}");
	// The fixture links this checkout's runtime/ and scripts/ into the version: links go, never their targets.
	assert.equal(existsSync(join(repository, "scripts", "bundled-install.mjs")), true);
	assert.equal(existsSync(join(repository, "runtime", "gentle-shell-uninstall.mjs")), true);
});

// A1 (T6 verifier): a receipt naming a file the PATH plan never edits is not acted on.
test("gentle-shell self-uninstall in a bundled install never edits or deletes a file a forged PATH receipt names, and says to remove the entry by hand", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const line = `export PATH="${join(prefix.root, "bin")}:$PATH" # gentle-shell bundled install`;
	const dotfile = join(prefix.home, "dotfiles", "path.sh");
	mkdirSync(dirname(dotfile), { recursive: true });
	writeFileSync(dotfile, `${line}\n`);
	writeFileSync(join(prefix.root, "path-entry.json"), JSON.stringify({ schema: 1, kind: "profile", path: dotfile, line, create: true, separator: false }));
	const result = prefix.run(["self-uninstall", "--yes"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(dotfile, "utf8"), `${line}\n`);
	assert.match(result.stdout, /does not describe this install's PATH entry/);
	assert.match(result.stdout, /\(none recorded; see below\)/);
});
