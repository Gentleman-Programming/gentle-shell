import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { bundledGentleAiPaths, gentleAiIsolationEnv } from "../lib/gentle-ai-binary.ts";
import { resetRunningBundledPrefixForTesting, runningBundledPrefix } from "../lib/gentle-shell-bundled.ts";
import { engramPinVersion } from "../scripts/installer-downloads.mjs";

// S9: gentle-pi's own gentle-ai runs in a bundled install keep Gentle AI's
// state, persona and Engram inside the prefix. Only this package inside the
// prefix's versions/ honors the launcher's GENTLE_SHELL_PREFIX.

const ID = "4.1.0-1.1.0";

// A valid bundled install: the version's marker, and `current` naming it (a
// relative symlink on POSIX, a pointer file on Windows), as bundled-install.mjs writes them.
function bundledPrefix(t: test.TestContext, { marked = true, current = ID } = {}) {
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), "gentle-ai-isolation-")));
	t.after(() => rmSync(prefix, { recursive: true, force: true }));
	const version = join(prefix, "versions", ID);
	const packageRoot = join(version, "node_modules", "gentle-pi");
	mkdirSync(packageRoot, { recursive: true });
	if (marked) writeFileSync(join(version, ".gentle-shell-version"), `${ID}\n`);
	if (process.platform === "win32") writeFileSync(join(prefix, "current"), `${current}\n`);
	else symlinkSync(`versions/${current}`, join(prefix, "current"));
	const engram = join(prefix, "runtime", `engram-${engramPinVersion}`, process.platform === "win32" ? "engram.exe" : "engram");
	mkdirSync(join(engram, ".."), { recursive: true });
	writeFileSync(engram, "engram", { mode: 0o700 });
	return { prefix, packageRoot, engram };
}

// B2a: gentle-pi's bundled config folder is <prefix>/config/gentle-ai, so a
// Gentle AI 4.0.0 given GENTLE_PI_CONFIG_HOME=<prefix>/config (its parent, the
// way 4.0.0 reads it) writes the background-subagents policy into it.
test("bundledGentleAiPaths names the prefix's Gentle AI home, gentle-pi config folder and its parent, and pinned Engram", () => {
	assert.deepEqual(bundledGentleAiPaths("/home/ana/.gentle-shell", "linux"), {
		home: "/home/ana/.gentle-shell/gentle-ai",
		piConfigParent: "/home/ana/.gentle-shell/config",
		piConfig: "/home/ana/.gentle-shell/config/gentle-ai",
		engram: `/home/ana/.gentle-shell/runtime/engram-${engramPinVersion}/engram`,
	});
	assert.equal(bundledGentleAiPaths("C:\\Users\\Ana\\AppData\\Local\\gentle-shell", "win32").engram,
		`C:\\Users\\Ana\\AppData\\Local\\gentle-shell\\runtime\\engram-${engramPinVersion}\\engram.exe`);
});

test("gentleAiIsolationEnv adds the four Gentle AI variables for this package inside a bundled prefix", (t) => {
	const { prefix, packageRoot, engram } = bundledPrefix(t);
	const base = { PATH: "/usr/bin", GENTLE_SHELL_PREFIX: prefix };
	const env = gentleAiIsolationEnv(base, { packageRoot });
	assert.deepEqual(env, {
		...base,
		GENTLE_AI_HOME: join(prefix, "gentle-ai"),
		GENTLE_AI_PI_CONFIG_DIR: join(prefix, "config", "gentle-ai"),
		GENTLE_AI_ENGRAM_BIN: engram,
		GENTLE_AI_NO_SELF_UPDATE: "1",
		GENTLE_PI_CONFIG_HOME: join(prefix, "config"),
		// #2105: Gentle AI 4.0.0 ignores GENTLE_AI_ENGRAM_BIN and looks `engram` up on PATH
		// first; with the pinned one first it never falls back to `brew tap`.
		PATH: `${dirname(engram)}${delimiter}/usr/bin`,
	});
	assert.equal("GENTLE_AI_HOME" in base, false, "the caller's environment is not changed");
	// Without the published Engram, Gentle AI gets no Engram to use, and PATH stays as it was.
	rmSync(engram);
	const without = gentleAiIsolationEnv(base, { packageRoot });
	assert.equal("GENTLE_AI_ENGRAM_BIN" in without, false);
	assert.equal(without.PATH, "/usr/bin");
});

test("gentleAiIsolationEnv returns the environment unchanged outside a bundled install", (t) => {
	const { prefix, packageRoot } = bundledPrefix(t);
	const unchanged = (env: NodeJS.ProcessEnv, root = packageRoot) => assert.equal(gentleAiIsolationEnv(env, { packageRoot: root }), env);
	unchanged({ PATH: "/usr/bin" });
	unchanged({ GENTLE_SHELL_PREFIX: "" });
	unchanged({ GENTLE_SHELL_PREFIX: "relative/prefix" });
	unchanged({ GENTLE_SHELL_PREFIX: join(prefix, "missing") });
	// A gentle-pi outside the prefix's versions (the user's own, run from the
	// agent's shell, which inherits GENTLE_SHELL_PREFIX) keeps its own Gentle AI.
	const outside = join(prefix, "elsewhere", "gentle-pi");
	mkdirSync(outside, { recursive: true });
	unchanged({ GENTLE_SHELL_PREFIX: prefix }, outside);
	unchanged({ GENTLE_SHELL_PREFIX: prefix }, join(prefix, "versions"));
});

// A2: only a valid bundled install, never a folder that merely sits under a versions/.
test("gentleAiIsolationEnv gives nothing to an nvm gentle-pi or an unmarked version", (t) => {
	const nvm = realpathSync(mkdtempSync(join(tmpdir(), "gentle-ai-isolation-nvm-")));
	t.after(() => rmSync(nvm, { recursive: true, force: true }));
	const nvmPackage = join(nvm, ".nvm", "versions", "node", "v24.21.0", "lib", "node_modules", "gentle-pi");
	mkdirSync(nvmPackage, { recursive: true });
	const nvmEnv = { GENTLE_SHELL_PREFIX: join(nvm, ".nvm") };
	assert.equal(gentleAiIsolationEnv(nvmEnv, { packageRoot: nvmPackage }), nvmEnv);
	const { prefix: unmarked, packageRoot: unmarkedRoot } = bundledPrefix(t, { marked: false });
	const unmarkedEnv = { GENTLE_SHELL_PREFIX: unmarked };
	assert.equal(gentleAiIsolationEnv(unmarkedEnv, { packageRoot: unmarkedRoot }), unmarkedEnv);
	// A valid install, but the variable names another folder.
	const { packageRoot } = bundledPrefix(t);
	const other = { GENTLE_SHELL_PREFIX: nvm };
	assert.equal(gentleAiIsolationEnv(other, { packageRoot }), other);
});

// The answer is remembered per package root and GENTLE_SHELL_PREFIX value: one
// process gets each env's own answer, and a `current` that moves while Pi runs
// does not change a remembered one.
test("runningBundledPrefix answers per env in one process and keeps a remembered answer when current moves", (t) => {
	resetRunningBundledPrefixForTesting();
	t.after(resetRunningBundledPrefixForTesting);
	const { prefix, packageRoot } = bundledPrefix(t);
	const other = realpathSync(mkdtempSync(join(tmpdir(), "gentle-ai-isolation-other-")));
	t.after(() => rmSync(other, { recursive: true, force: true }));
	assert.equal(runningBundledPrefix({ GENTLE_SHELL_PREFIX: prefix }, { packageRoot }), prefix);
	assert.equal(runningBundledPrefix({ GENTLE_SHELL_PREFIX: other }, { packageRoot }), undefined);
	assert.equal(runningBundledPrefix({}, { packageRoot }), undefined);
	assert.equal(runningBundledPrefix({ GENTLE_SHELL_PREFIX: prefix }, { packageRoot }), prefix);
	// An upgrade switches current to another version while this one runs.
	rmSync(join(prefix, "current"));
	if (process.platform === "win32") writeFileSync(join(prefix, "current"), "4.2.0-1.1.0\n");
	else symlinkSync("versions/4.2.0-1.1.0", join(prefix, "current"));
	// The version stops being a finished install (its marker is gone).
	rmSync(join(prefix, "versions", ID, ".gentle-shell-version"));
	assert.equal(runningBundledPrefix({ GENTLE_SHELL_PREFIX: prefix }, { packageRoot }), prefix, "remembered");
	resetRunningBundledPrefixForTesting();
	assert.equal(runningBundledPrefix({ GENTLE_SHELL_PREFIX: prefix }, { packageRoot }), undefined, "decided again after a reset");
});

// N1: a subagent started after `gentle-shell upgrade` moved `current` runs from
// the previous version, which the prefix still keeps: it stays bundled.
test("a kept, marked version that current no longer names is still bundled for its own runs", (t) => {
	resetRunningBundledPrefixForTesting();
	t.after(resetRunningBundledPrefixForTesting);
	const { prefix, packageRoot } = bundledPrefix(t, { current: "4.2.0-1.1.0" });
	const env = { GENTLE_SHELL_PREFIX: prefix };
	assert.equal(runningBundledPrefix(env, { packageRoot }), prefix);
	assert.equal(gentleAiIsolationEnv(env, { packageRoot }).GENTLE_AI_HOME, join(prefix, "gentle-ai"));
});
