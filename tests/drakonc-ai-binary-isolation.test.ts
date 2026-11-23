import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import {
	bundledDrakoncAiPaths,
	drakoncAiIsolationEnv,
	drakoncAiPersonaSnapshotPaths,
	sharedDrakoncAiPersonaPaths,
	sharedDrakoncAiStatePaths,
	standaloneDrakoncAiHome,
} from "../lib/drakonc-ai-binary.ts";
import { DRAKONC_SHELL_CONFIG_HOME_ENV, resetRunningBundledPrefixForTesting, runningBundledPrefix } from "../lib/drakonc-shell-bundled.ts";
import { engramPinVersion } from "../scripts/installer-downloads.mjs";

// An OS home that never exists: every non-bundled expectation below is computed
// against it, so no assertion depends on (or touches) the real one.
const OS_HOME = join(tmpdir(), "drakonc-ai-isolation-os-home");
const STANDALONE_AI_HOME = join(OS_HOME, ".drakonc-shell", "drakonc-ai-home");

// Is `path` inside `folder` (or equal to it)? Same rule the module uses.
function isInside(folder: string, path: string): boolean {
	const relativePath = relative(folder, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

// S9: drakonc-pi's own drakonc-ai runs in a bundled install keep Drakonc AI's
// state, persona and Engram inside the prefix. Only this package inside the
// prefix's versions/ honors the launcher's DRAKONC_SHELL_PREFIX.

const ID = "4.1.0-1.1.0";

// A valid bundled install: the version's marker, and `current` naming it (a
// relative symlink on POSIX, a pointer file on Windows), as bundled-install.mjs writes them.
function bundledPrefix(t: test.TestContext, { marked = true, current = ID } = {}) {
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), "drakonc-ai-isolation-")));
	t.after(() => rmSync(prefix, { recursive: true, force: true }));
	const version = join(prefix, "versions", ID);
	const packageRoot = join(version, "node_modules", "drakonc-pi");
	mkdirSync(packageRoot, { recursive: true });
	if (marked) writeFileSync(join(version, ".drakonc-shell-version"), `${ID}\n`);
	if (process.platform === "win32") writeFileSync(join(prefix, "current"), `${current}\n`);
	else symlinkSync(`versions/${current}`, join(prefix, "current"));
	const engram = join(prefix, "runtime", `engram-${engramPinVersion}`, process.platform === "win32" ? "engram.exe" : "engram");
	mkdirSync(join(engram, ".."), { recursive: true });
	writeFileSync(engram, "engram", { mode: 0o700 });
	return { prefix, packageRoot, engram };
}

// B2a: drakonc-pi's bundled config folder is <prefix>/config/drakonc-ai, so a
// Drakonc AI 4.0.0 given DRAKONC_PI_CONFIG_HOME=<prefix>/config (its parent, the
// way 4.0.0 reads it) writes the background-subagents policy into it.
test("bundledDrakoncAiPaths names the prefix's Drakonc AI home, drakonc-pi config folder and its parent, and pinned Engram", () => {
	assert.deepEqual(bundledDrakoncAiPaths("/home/ana/.drakonc-shell", "linux"), {
		home: "/home/ana/.drakonc-shell/drakonc-ai",
		piConfigParent: "/home/ana/.drakonc-shell/config",
		piConfig: "/home/ana/.drakonc-shell/config/drakonc-ai",
		engram: `/home/ana/.drakonc-shell/runtime/engram-${engramPinVersion}/engram`,
	});
	assert.equal(bundledDrakoncAiPaths("C:\\Users\\Ana\\AppData\\Local\\drakonc-shell", "win32").engram,
		`C:\\Users\\Ana\\AppData\\Local\\drakonc-shell\\runtime\\engram-${engramPinVersion}\\engram.exe`);
});

test("drakoncAiIsolationEnv adds every Drakonc AI variable under both names for this package inside a bundled prefix", (t) => {
	const { prefix, packageRoot, engram } = bundledPrefix(t);
	const base = { PATH: "/usr/bin", DRAKONC_SHELL_PREFIX: prefix };
	const env = drakoncAiIsolationEnv(base, { packageRoot });
	assert.deepEqual(env, {
		...base,
		DRAKONC_AI_HOME: join(prefix, "drakonc-ai"),
		// D1: the pinned companion is the original gentle-ai 5.0.0, which reads
		// only GENTLE_*, so each variable goes out under both names.
		GENTLE_AI_HOME: join(prefix, "drakonc-ai"),
		DRAKONC_AI_PI_CONFIG_DIR: join(prefix, "config", "drakonc-ai"),
		GENTLE_AI_PI_CONFIG_DIR: join(prefix, "config", "drakonc-ai"),
		DRAKONC_AI_ENGRAM_BIN: engram,
		GENTLE_AI_ENGRAM_BIN: engram,
		DRAKONC_AI_NO_SELF_UPDATE: "1",
		GENTLE_AI_NO_SELF_UPDATE: "1",
		DRAKONC_PI_CONFIG_HOME: join(prefix, "config"),
		// gentle-ai appends "gentle-ai" to its own name for this one, so the
		// prefix's config folder contains any fallback write.
		GENTLE_PI_CONFIG_HOME: join(prefix, "config"),
		// #2105: Drakonc AI 4.0.0 ignores DRAKONC_AI_ENGRAM_BIN and looks `engram` up on PATH
		// first; with the pinned one first it never falls back to `brew tap`.
		PATH: `${dirname(engram)}${delimiter}/usr/bin`,
	});
	assert.equal("DRAKONC_AI_HOME" in base, false, "the caller's environment is not changed");
	// Without the published Engram, Drakonc AI gets no Engram to use, and PATH stays as it was.
	rmSync(engram);
	const without = drakoncAiIsolationEnv(base, { packageRoot });
	assert.equal("DRAKONC_AI_ENGRAM_BIN" in without, false);
	assert.equal("GENTLE_AI_ENGRAM_BIN" in without, false);
	assert.equal(without.PATH, "/usr/bin");
});

test("outside a bundled install the companion gets Drakonc's own home and no self-update, never a prefix path", (t) => {
	const { prefix, packageRoot } = bundledPrefix(t);
	const isolated = (env: NodeJS.ProcessEnv, root = packageRoot) => drakoncAiIsolationEnv(env, { packageRoot: root, osHome: OS_HOME });
	for (const env of [
		{ PATH: "/usr/bin" },
		{ DRAKONC_SHELL_PREFIX: "" },
		{ DRAKONC_SHELL_PREFIX: "relative/prefix" },
		{ DRAKONC_SHELL_PREFIX: join(prefix, "missing") },
	]) {
		const result = isolated(env);
		assert.equal(result.DRAKONC_AI_HOME, STANDALONE_AI_HOME);
		assert.equal(result.GENTLE_AI_HOME, STANDALONE_AI_HOME);
		assert.equal(result.DRAKONC_AI_NO_SELF_UPDATE, "1");
		assert.equal(result.GENTLE_AI_NO_SELF_UPDATE, "1");
		assert.equal("DRAKONC_AI_ENGRAM_BIN" in result, false);
		assert.equal("DRAKONC_AI_PI_CONFIG_DIR" in result, false, "no config folder of its own outside a marker");
		assert.equal("GENTLE_PI_CONFIG_HOME" in result, false);
	}
	// A drakonc-pi outside the prefix's versions (the user's own, run from the
	// agent's shell, which inherits DRAKONC_SHELL_PREFIX) gets nothing of the prefix.
	const outside = join(prefix, "elsewhere", "drakonc-pi");
	mkdirSync(outside, { recursive: true });
	for (const [env, root] of [[{ DRAKONC_SHELL_PREFIX: prefix }, outside], [{ DRAKONC_SHELL_PREFIX: prefix }, join(prefix, "versions")]] as const) {
		assert.equal(isolated(env, root).DRAKONC_AI_HOME, STANDALONE_AI_HOME);
	}
});

// A2: only a valid bundled install, never a folder that merely sits under a versions/.
test("drakoncAiIsolationEnv gives nothing of a prefix to an nvm drakonc-pi or an unmarked version", (t) => {
	const nvm = realpathSync(mkdtempSync(join(tmpdir(), "drakonc-ai-isolation-nvm-")));
	t.after(() => rmSync(nvm, { recursive: true, force: true }));
	const nvmPackage = join(nvm, ".nvm", "versions", "node", "v24.21.0", "lib", "node_modules", "drakonc-pi");
	mkdirSync(nvmPackage, { recursive: true });
	const nvmHome = { DRAKONC_SHELL_PREFIX: join(nvm, ".nvm") };
	const nvmEnv = drakoncAiIsolationEnv(nvmHome, { packageRoot: nvmPackage, osHome: OS_HOME });
	assert.equal(nvmEnv.DRAKONC_AI_HOME, STANDALONE_AI_HOME);
	assert.equal("DRAKONC_AI_PI_CONFIG_DIR" in nvmEnv, false);
	const { prefix: unmarked, packageRoot: unmarkedRoot } = bundledPrefix(t, { marked: false });
	const unmarkedEnv = drakoncAiIsolationEnv({ DRAKONC_SHELL_PREFIX: unmarked }, { packageRoot: unmarkedRoot, osHome: OS_HOME });
	assert.equal(unmarkedEnv.DRAKONC_AI_HOME, STANDALONE_AI_HOME);
	assert.equal("DRAKONC_AI_ENGRAM_BIN" in unmarkedEnv, false);
	// A valid install, but the variable names another folder.
	const { packageRoot } = bundledPrefix(t);
	const other = drakoncAiIsolationEnv({ DRAKONC_SHELL_PREFIX: nvm }, { packageRoot, osHome: OS_HOME });
	assert.equal(other.DRAKONC_AI_HOME, STANDALONE_AI_HOME);
});

// The answer is remembered per package root and DRAKONC_SHELL_PREFIX value: one
// process gets each env's own answer, and a `current` that moves while Pi runs
// does not change a remembered one.
test("runningBundledPrefix answers per env in one process and keeps a remembered answer when current moves", (t) => {
	resetRunningBundledPrefixForTesting();
	t.after(resetRunningBundledPrefixForTesting);
	const { prefix, packageRoot } = bundledPrefix(t);
	const other = realpathSync(mkdtempSync(join(tmpdir(), "drakonc-ai-isolation-other-")));
	t.after(() => rmSync(other, { recursive: true, force: true }));
	assert.equal(runningBundledPrefix({ DRAKONC_SHELL_PREFIX: prefix }, { packageRoot }), prefix);
	assert.equal(runningBundledPrefix({ DRAKONC_SHELL_PREFIX: other }, { packageRoot }), undefined);
	assert.equal(runningBundledPrefix({}, { packageRoot }), undefined);
	assert.equal(runningBundledPrefix({ DRAKONC_SHELL_PREFIX: prefix }, { packageRoot }), prefix);
	// An upgrade switches current to another version while this one runs.
	rmSync(join(prefix, "current"));
	if (process.platform === "win32") writeFileSync(join(prefix, "current"), "4.2.0-1.1.0\n");
	else symlinkSync("versions/4.2.0-1.1.0", join(prefix, "current"));
	// The version stops being a finished install (its marker is gone).
	rmSync(join(prefix, "versions", ID, ".drakonc-shell-version"));
	assert.equal(runningBundledPrefix({ DRAKONC_SHELL_PREFIX: prefix }, { packageRoot }), prefix, "remembered");
	resetRunningBundledPrefixForTesting();
	assert.equal(runningBundledPrefix({ DRAKONC_SHELL_PREFIX: prefix }, { packageRoot }), undefined, "decided again after a reset");
});

// N1: a subagent started after `drakonc-shell upgrade` moved `current` runs from
// the previous version, which the prefix still keeps: it stays bundled.
test("a kept, marked version that current no longer names is still bundled for its own runs", (t) => {
	resetRunningBundledPrefixForTesting();
	t.after(resetRunningBundledPrefixForTesting);
	const { prefix, packageRoot } = bundledPrefix(t, { current: "4.2.0-1.1.0" });
	const env = { DRAKONC_SHELL_PREFIX: prefix };
	assert.equal(runningBundledPrefix(env, { packageRoot }), prefix);
	assert.equal(drakoncAiIsolationEnv(env, { packageRoot }).DRAKONC_AI_HOME, join(prefix, "drakonc-ai"));
});

// D1: one contract for the three modes the launcher builds the companion
// environment in — packaged, isolated by default and `--link` — and the two
// invariants that keep it inside Drakonc: no self-update anywhere, and no path
// of another product (~/.gentle-ai, ~/.pi, ~/.gentle-shell) in either name.
test("packaged, isolated and linked modes name each variable twice and forbid self-update", (t) => {
	resetRunningBundledPrefixForTesting();
	t.after(resetRunningBundledPrefixForTesting);
	const { prefix, packageRoot } = bundledPrefix(t);
	const isolatedMarker = join(OS_HOME, ".drakonc-shell", "drakonc-ai");
	const modes: Record<string, NodeJS.ProcessEnv> = {
		packaged: drakoncAiIsolationEnv({ DRAKONC_SHELL_PREFIX: prefix }, { packageRoot, osHome: OS_HOME }),
		isolated: drakoncAiIsolationEnv({ [DRAKONC_SHELL_CONFIG_HOME_ENV]: isolatedMarker }, { osHome: OS_HOME }),
		linked: drakoncAiIsolationEnv({}, { osHome: OS_HOME }),
	};
	for (const [mode, env] of Object.entries(modes)) {
		assert.equal(env.DRAKONC_AI_NO_SELF_UPDATE, "1", `${mode}: the companion never replaces the pinned binary`);
		assert.equal(env.GENTLE_AI_NO_SELF_UPDATE, "1", `${mode}: under the name the pinned gentle-ai reads`);
		assert.ok(env.DRAKONC_AI_HOME !== undefined, `${mode}: the companion has a home of its own`);
		assert.equal(env.GENTLE_AI_HOME, env.DRAKONC_AI_HOME, `${mode}: one home, two names`);
		for (const folder of [".gentle-ai", ".pi", ".gentle-shell"]) {
			assert.equal(isInside(join(OS_HOME, folder), env.DRAKONC_AI_HOME), false, `${mode}: the companion home stays out of ${folder}`);
		}
		if (env.DRAKONC_AI_PI_CONFIG_DIR !== undefined) {
			assert.equal(env.GENTLE_AI_PI_CONFIG_DIR, env.DRAKONC_AI_PI_CONFIG_DIR, `${mode}: one config folder, two names`);
			assert.equal(env.GENTLE_PI_CONFIG_HOME, dirname(env.DRAKONC_AI_PI_CONFIG_DIR), `${mode}: the parent the companion appends its folder to`);
		}
		if (env.DRAKONC_AI_ENGRAM_BIN !== undefined) {
			assert.equal(env.GENTLE_AI_ENGRAM_BIN, env.DRAKONC_AI_ENGRAM_BIN, `${mode}: one Engram, two names`);
		}
	}
	// The isolated home's config pair follows its marker; the linked home keeps
	// the user's own folder, so it gets no config pair of its own.
	assert.equal(modes.isolated.DRAKONC_AI_PI_CONFIG_DIR, isolatedMarker);
	assert.equal(modes.isolated.DRAKONC_PI_CONFIG_HOME, dirname(isolatedMarker));
	assert.equal("DRAKONC_AI_PI_CONFIG_DIR" in modes.linked, false);
	assert.equal("DRAKONC_PI_CONFIG_HOME" in modes.linked, false);
	// Packaged and isolated keep Drakonc AI's state inside Drakonc.
	assert.equal(modes.packaged.DRAKONC_AI_HOME, join(prefix, "drakonc-ai"));
	assert.equal(modes.isolated.DRAKONC_AI_HOME, STANDALONE_AI_HOME);
});

// D1: a declared home is respected, except one of another product: inheriting
// GENTLE_AI_HOME from a real gentle-ai install would put the companion's state
// back in ~/.gentle-ai, the leak this isolation removes.
test("a declared companion home is respected unless it names another product's folder", () => {
	const declared = join(OS_HOME, "companion-state");
	const home = (env: NodeJS.ProcessEnv) => standaloneDrakoncAiHome(env, OS_HOME, process.platform);
	assert.equal(home({ DRAKONC_AI_HOME: declared }), declared);
	assert.equal(home({ GENTLE_AI_HOME: declared }), declared);
	assert.equal(home({ DRAKONC_AI_HOME: declared, GENTLE_AI_HOME: join(OS_HOME, ".gentle-ai") }), declared, "Drakonc's own name wins");
	for (const foreign of [".gentle-ai", ".pi", ".gentle-shell"]) {
		assert.equal(standaloneDrakoncAiHome({ GENTLE_AI_HOME: join(OS_HOME, foreign, "companion") }, OS_HOME, process.platform), STANDALONE_AI_HOME);
	}
	assert.equal(home({ GENTLE_AI_HOME: "relative/state" }), STANDALONE_AI_HOME);
	assert.equal(home({}), STANDALONE_AI_HOME);
	// The declared home reaches the environment under both names.
	const env = drakoncAiIsolationEnv({ DRAKONC_AI_HOME: declared }, { osHome: OS_HOME });
	assert.equal(env.GENTLE_AI_HOME, declared);
	// win32 keeps its own separators.
	assert.equal(
		standaloneDrakoncAiHome({ DRAKONC_AI_HOME: "C:\\Users\\Ana\\state" }, "C:\\Users\\Ana", "win32"),
		"C:\\Users\\Ana\\state",
	);
	assert.equal(
		standaloneDrakoncAiHome({ GENTLE_AI_HOME: "C:\\Users\\Ana\\.gentle-ai" }, "C:\\Users\\Ana", "win32"),
		"C:\\Users\\Ana\\.drakonc-shell\\drakonc-ai-home",
	);
});

// S3: the pinned gentle-ai writes the persona to ~/.pi/gentle-ai/persona.json and
// its digest to ~/.gentle-ai/state.json, so setup protects both files and not
// only Drakonc's own.
test("setup snapshots both persona files and both shared state files", () => {
	const linkHome = sharedDrakoncAiPersonaPaths("/os-home", "linux");
	assert.deepEqual(linkHome, ["/os-home/.pi/drakonc-ai/persona.json", "/os-home/.pi/gentle-ai/persona.json"]);
	assert.deepEqual(sharedDrakoncAiStatePaths("/os-home", "linux"), ["/os-home/.drakonc-ai/state.json", "/os-home/.gentle-ai/state.json"]);
	// The isolated home first: the folder this launcher gives the companion.
	assert.deepEqual(drakoncAiPersonaSnapshotPaths({ configHome: "/os-home/.drakonc-shell/drakonc-ai", osHome: "/os-home", platform: "linux" }), [
		"/os-home/.drakonc-shell/drakonc-ai/persona.json",
		"/os-home/.pi/drakonc-ai/persona.json",
		"/os-home/.pi/gentle-ai/persona.json",
	]);
	// A bundled install's config folder outranks the standalone one.
	assert.deepEqual(drakoncAiPersonaSnapshotPaths({ bundledPiConfig: "/prefix/config/drakonc-ai", configHome: "/ignored", osHome: "/os-home", platform: "linux" }), [
		"/prefix/config/drakonc-ai/persona.json",
		"/os-home/.pi/drakonc-ai/persona.json",
		"/os-home/.pi/gentle-ai/persona.json",
	]);
	// --link and a custom --home keep the shared folder only.
	assert.deepEqual(drakoncAiPersonaSnapshotPaths({ osHome: "/os-home", platform: "linux" }), linkHome);
	assert.deepEqual(sharedDrakoncAiPersonaPaths("C:\\Users\\Ana", "win32"), [
		"C:\\Users\\Ana\\.pi\\drakonc-ai\\persona.json",
		"C:\\Users\\Ana\\.pi\\gentle-ai\\persona.json",
	]);
	assert.deepEqual(sharedDrakoncAiStatePaths("C:\\Users\\Ana", "win32"), [
		"C:\\Users\\Ana\\.drakonc-ai\\state.json",
		"C:\\Users\\Ana\\.gentle-ai\\state.json",
	]);
});
