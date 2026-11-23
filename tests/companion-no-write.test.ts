import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { drakoncAiIsolationEnv } from "../lib/drakonc-ai-binary.ts";
import {
	DRAKONC_SHELL_CONFIG_HOME_ENV,
	DRAKONC_SHELL_PREFIX_ENV,
	resetRunningBundledPrefixForTesting,
	resolveDrakoncPiConfigHome,
	setBundledInstallForTesting,
} from "../lib/drakonc-shell-bundled.ts";

// D2: the companion must not write outside Drakonc's homes. This is the
// integration proof, with no network and no real binary: a stand-in script that
// writes exactly where the isolation environment sends it, or — when a variable
// is missing, like the real gentle-ai 5.0.0 with the DRAKONC_* names alone —
// into its own defaults (~/.gentle-ai, ~/.pi/gentle-ai), run against a temporary
// HOME seeded with the folders of the products that must stay untouched.

// The stand-in companion: same file layout the pinned binary produces (its own
// state, the Pi persona and the background-subagents policy), each one where the
// isolation variable points, or in gentle-ai's default when it is missing.
const COMPANION_SCRIPT = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const env = process.env;

// Its own state: GENTLE_AI_HOME, or gentle-ai's ~/.gentle-ai when missing.
const stateHome = env.GENTLE_AI_HOME || env.DRAKONC_AI_HOME || join(home, ".gentle-ai");
mkdirSync(stateHome, { recursive: true });
writeFileSync(join(stateHome, "state.json"), JSON.stringify({ managed_asset_digest: "companion" }) + "\\n");

// The Pi persona folder and the policy: GENTLE_AI_PI_CONFIG_DIR wins
// (gentle-ai 5.0.0 knows it), else GENTLE_PI_CONFIG_HOME with gentle-ai's own
// folder appended, else its ~/.pi/gentle-ai default.
const via = env.GENTLE_AI_PI_CONFIG_DIR ? "GENTLE_AI_PI_CONFIG_DIR"
	: env.DRAKONC_AI_PI_CONFIG_DIR ? "DRAKONC_AI_PI_CONFIG_DIR"
	: env.GENTLE_PI_CONFIG_HOME ? "GENTLE_PI_CONFIG_HOME"
	: "default";
const piDir = via === "default" ? join(home, ".pi", "gentle-ai")
	: via === "GENTLE_PI_CONFIG_HOME" ? join(env.GENTLE_PI_CONFIG_HOME, "gentle-ai")
	: env.GENTLE_AI_PI_CONFIG_DIR || env.DRAKONC_AI_PI_CONFIG_DIR;
mkdirSync(piDir, { recursive: true });
writeFileSync(join(piDir, "persona.json"), JSON.stringify({ mode: "companion" }) + "\\n");
writeFileSync(join(piDir, "background-subagents.json"), JSON.stringify({ via, dir: piDir }) + "\\n");
`;

function scratch(t: test.TestContext, prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// A HOME with the folders and files of the neighbouring products, as a real
// machine has them before the first launch.
function seededHome(t: test.TestContext): string {
	const home = scratch(t, "companion-no-write-home-");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}\n");
	mkdirSync(join(home, ".gentle-ai"), { recursive: true });
	writeFileSync(join(home, ".gentle-ai", "state.json"), `${JSON.stringify({ managed_asset_digest: "user-own" })}\n`);
	mkdirSync(join(home, ".gentle-shell"), { recursive: true });
	writeFileSync(join(home, ".gentle-shell", "x"), "x\n");
	return home;
}

// Every file under `dir` with its content and mtime: a write, a creation and a
// deletion all show up here, which is what "identical" means for this test.
function snapshotTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (base: string): void => {
		for (const name of readdirSync(base).sort()) {
			const path = join(base, name);
			const details = lstatSync(path);
			if (details.isDirectory()) walk(path);
			else out[relative(dir, path)] = `${details.mtimeMs}:${readFileSync(path, "utf8")}`;
		}
	};
	walk(dir);
	return out;
}

const WATCHED_FOLDERS = [".pi", ".gentle-ai", ".gentle-shell"];

function watchedTrees(home: string): Record<string, Record<string, string>> {
	return Object.fromEntries(WATCHED_FOLDERS.map((folder) => [folder, snapshotTree(join(home, folder))]));
}

function writeCompanion(t: test.TestContext): string {
	const dir = scratch(t, "companion-no-write-bin-");
	const script = join(dir, "companion.mjs");
	writeFileSync(script, COMPANION_SCRIPT);
	return script;
}

function runCompanion(script: string, env: NodeJS.ProcessEnv): void {
	const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

// The policy the companion wrote, read from the folder drakonc-pi itself
// resolves — its own environment (the launcher marker or the bundled prefix),
// never the companion's. Writing and reading must be the same folder.
function readPolicy(piEnv: NodeJS.ProcessEnv, home: string): { via: string; dir: string } {
	const resolved = resolveDrakoncPiConfigHome(piEnv, home);
	const path = join(resolved, "background-subagents.json");
	assert.ok(existsSync(path), `the companion's policy is expected in ${resolved}`);
	return JSON.parse(readFileSync(path, "utf8")) as { via: string; dir: string };
}

test("an isolated first setup run leaves ~/.pi, ~/.gentle-ai and ~/.gentle-shell untouched", (t) => {
	const home = seededHome(t);
	const script = writeCompanion(t);
	const before = watchedTrees(home);
	const configHome = join(home, ".drakonc-shell", "drakonc-ai");
	const env = drakoncAiIsolationEnv({
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		[DRAKONC_SHELL_CONFIG_HOME_ENV]: configHome,
	}, { osHome: home });
	runCompanion(script, env);
	assert.deepEqual(watchedTrees(home), before, "nothing of ~/.pi, ~/.gentle-ai or ~/.gentle-shell may change");
	// The companion wrote inside Drakonc's own folders, and the policy is where
	// drakonc-pi reads it with its own environment (the launcher marker).
	assert.ok(existsSync(join(home, ".drakonc-shell", "drakonc-ai-home", "state.json")), "its state stays in Drakonc's home");
	const policy = readPolicy({ HOME: home, USERPROFILE: home, [DRAKONC_SHELL_CONFIG_HOME_ENV]: configHome }, home);
	assert.equal(policy.dir, env.GENTLE_AI_PI_CONFIG_DIR);
	assert.equal(policy.via, "GENTLE_AI_PI_CONFIG_DIR", "the variable the pinned gentle-ai 5.0.0 actually reads");
});

test("a packaged first setup run leaves ~/.pi, ~/.gentle-ai and ~/.gentle-shell untouched", (t) => {
	const home = seededHome(t);
	const script = writeCompanion(t);
	const prefix = scratch(t, "companion-no-write-prefix-");
	setBundledInstallForTesting({ root: prefix });
	t.after(() => {
		setBundledInstallForTesting(undefined);
		resetRunningBundledPrefixForTesting();
	});
	const before = watchedTrees(home);
	const env = drakoncAiIsolationEnv({
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		[DRAKONC_SHELL_PREFIX_ENV]: prefix,
	}, { osHome: home });
	runCompanion(script, env);
	assert.deepEqual(watchedTrees(home), before, "nothing of ~/.pi, ~/.gentle-ai or ~/.gentle-shell may change");
	assert.ok(existsSync(join(prefix, "drakonc-ai", "state.json")), "its state stays inside the prefix");
	const policy = readPolicy({ HOME: home, USERPROFILE: home, [DRAKONC_SHELL_PREFIX_ENV]: prefix }, home);
	assert.equal(policy.dir, env.GENTLE_AI_PI_CONFIG_DIR);
	assert.equal(policy.via, "GENTLE_AI_PI_CONFIG_DIR");
});

// The control run proves the check above can fail: with no isolation variables
// at all — the environment the launcher used to give before the GENTLE_* names
// were restored — the same stand-in writes into both neighbouring products.
test("the same companion without the isolation variables does write in both folders", (t) => {
	const home = seededHome(t);
	const script = writeCompanion(t);
	const before = watchedTrees(home);
	runCompanion(script, { PATH: process.env.PATH, HOME: home, USERPROFILE: home });
	const after = watchedTrees(home);
	assert.notDeepEqual(after[".gentle-ai"], before[".gentle-ai"], "without the variables it falls back to ~/.gentle-ai");
	assert.notDeepEqual(after[".pi"], before[".pi"], "and writes its persona into ~/.pi/gentle-ai");
	assert.ok(existsSync(join(home, ".pi", "gentle-ai", "persona.json")));
});
