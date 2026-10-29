import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_STAGES, runTestSuite } from "../scripts/run-test-suite.mjs";

// #1285 requires that a stage-1 failure never suppresses later stages.
// Orchestration tests use fake stages; CLI tests exercise real child processes.

function fakeRunStage(codes) {
	let index = 0;
	return async (stage) => {
		const code = codes[index++] ?? 0;
		return { name: stage.name, code };
	};
}

test("default stages cover unit tests, provider contract, and runtime harness", () => {
	assert.deepEqual(
		DEFAULT_STAGES.map((stage) => stage.name),
		["unit-tests", "provider-contract", "runtime-harness"],
	);
});

test("every stage runs even when an earlier stage fails", async () => {
	const run = fakeRunStage([1, 0, 1]);
	const results = await runTestSuite(DEFAULT_STAGES, { runStageImpl: run, write: () => {} });
	assert.deepEqual(
		results,
		[
			{ name: "unit-tests", code: 1 },
			{ name: "provider-contract", code: 0 },
			{ name: "runtime-harness", code: 1 },
		],
	);
});

test("summary reports each stage outcome and names the failures", async () => {
	const lines: string[] = [];
	await runTestSuite(DEFAULT_STAGES, {
		runStageImpl: fakeRunStage([1, 0, 0]),
		write: (line: string) => lines.push(line),
	});
	const summary = lines.slice(lines.findIndex((line) => line.includes("=== test suite summary ===")));
	assert.ok(summary.includes("FAIL  unit-tests"));
	assert.ok(summary.includes("PASS  provider-contract"));
	assert.ok(summary.includes("PASS  runtime-harness"));
	assert.ok(summary.includes("1 stage(s) failed: unit-tests"));
});

test("all-pass summary reports success", async () => {
	const lines: string[] = [];
	await runTestSuite(DEFAULT_STAGES, {
		runStageImpl: fakeRunStage([0, 0, 0]),
		write: (line: string) => lines.push(line),
	});
	assert.ok(lines.includes("all stages passed"));
});

// The CLI branch is what `pnpm test` actually executes, so its exit contract
// is covered with a real child process and a temporary stages JSON file.

const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-test-suite.mjs");

function writeStagesFile(t: test.TestContext, stages: Array<{ name: string; command: string }>): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-pi-run-test-suite-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stagesPath = join(dir, "stages.json");
	writeFileSync(stagesPath, JSON.stringify(stages));
	return stagesPath;
}

test("direct invocation exits 1 and names the failed stage when a stage fails", (t) => {
	const stagesPath = writeStagesFile(t, [
		{ name: "failing-stage", command: "node -e \"process.exit(1)\"" },
		{ name: "ok-stage", command: "node -e \"process.exit(0)\"" },
	]);
	const result = spawnSync(process.execPath, [runnerPath, stagesPath], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stdout ?? "", /FAIL  failing-stage/);
	assert.match(result.stdout ?? "", /1 stage\(s\) failed: failing-stage/);
});

test("direct invocation exits 0 when every stage passes", (t) => {
	const stagesPath = writeStagesFile(t, [
		{ name: "first", command: "node -e \"process.exit(0)\"" },
		{ name: "second", command: "node -e \"process.exit(0)\"" },
	]);
	const result = spawnSync(process.execPath, [runnerPath, stagesPath], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout ?? "", /all stages passed/);
});

test("direct invocation still runs stages when reached through a file symlink", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-pi-run-test-suite-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const linkPath = join(dir, "runner-link.mjs");
	try {
		symlinkSync(runnerPath, linkPath);
	} catch {
		t.skip("symlinks unavailable on this filesystem");
		return;
	}
	const stagesPath = writeStagesFile(t, [{ name: "only", command: "node -e \"process.exit(0)\"" }]);
	const result = spawnSync(process.execPath, [linkPath, stagesPath], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout ?? "", /PASS  only/);
	assert.match(result.stdout ?? "", /all stages passed/);
});

function probeStageEnvironment(t: test.TestContext, env: NodeJS.ProcessEnv) {
	const stagesPath = writeStagesFile(t, []);
	const probePath = join(dirname(stagesPath), "probe.mjs");
	writeFileSync(probePath, `
import { existsSync, readFileSync, readdirSync } from "node:fs";
const home = process.env.GENTLE_PI_CONFIG_HOME;
const gitGlobalPath = process.env.GIT_CONFIG_GLOBAL;
const xdgPath = process.env.XDG_CONFIG_HOME;
console.log("ENV_PROBE=" + JSON.stringify({
  git: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GIT_"))),
  gitGlobal: gitGlobalPath ? { exists: existsSync(gitGlobalPath), content: existsSync(gitGlobalPath) ? readFileSync(gitGlobalPath, "utf8") : null } : null,
  xdg: xdgPath ?? null,
  agents: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GENTLE_PI_AGENTS_"))),
  home,
  files: home && existsSync(home) ? readdirSync(home) : null,
  sentinel: process.env.TEST_ENV_SENTINEL,
  tmp: process.env.TMPDIR ?? null,
  tmpExists: process.env.TMPDIR ? existsSync(process.env.TMPDIR) : null,
}));
`);
	writeFileSync(stagesPath, JSON.stringify([
		{ name: "unit-tests", command: `node "${probePath}"` },
		{ name: "provider-contract", command: `node "${probePath}"` },
	]));
	const result = spawnSync(process.execPath, [runnerPath, stagesPath], {
		encoding: "utf8", env: { ...process.env, ...env, TEST_ENV_SENTINEL: "preserved" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /PASS  unit-tests/);
	assert.match(result.stdout, /PASS  provider-contract/);
	const probes = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("ENV_PROBE="))
		.map((line) => JSON.parse(line.slice("ENV_PROBE=".length)));
	assert.equal(probes.length, 2);
	for (const probe of probes) assert.equal(probe.sentinel, "preserved");
	return probes;
}

test("unit stage strips inherited Git configuration without changing later stages", (t) => {
	const env = {
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "credential.interactive", GIT_CONFIG_VALUE_0: "false",
		GIT_CONFIG_KEY_1: "credential.guiPrompt", GIT_CONFIG_VALUE_1: "false",
		GIT_DIR: "inherited-repository", GIT_AUTHOR_NAME: "inherited-author",
	};
	const [unit, provider] = probeStageEnvironment(t, env);
	assert.equal(unit.git.GIT_DIR, undefined);
	assert.equal(unit.git.GIT_AUTHOR_NAME, undefined);
	assert.equal(unit.git.GIT_CONFIG_COUNT, undefined);
	for (const [key, value] of Object.entries(env)) assert.equal(provider.git[key], value);
});

// gentle-shell#2552: Git reads its global/system config files by path, so
// stripping inherited GIT_* environment was not enough — a host global ignore
// (e.g. ".agents/") leaked into fixtures and dropped untracked symlink targets
// from `git add -A`. The stage must pin every remaining config source.
test("unit stage pins Git config files to empty defaults; later stages keep inherited ones", (t) => {
	const [unit, provider] = probeStageEnvironment(t, { GIT_CONFIG_GLOBAL: "inherited-global", GIT_CONFIG_NOSYSTEM: "0" });
	assert.match(unit.git.GIT_CONFIG_GLOBAL ?? "", /empty\.gitconfig$/);
	assert.deepEqual(unit.gitGlobal, { exists: true, content: "" }, "the pinned global config exists and is empty while the stage runs");
	assert.equal(unit.git.GIT_CONFIG_NOSYSTEM, "1");
	assert.equal(provider.git.GIT_CONFIG_GLOBAL, "inherited-global");
	assert.deepEqual(provider.gitGlobal, { exists: false, content: null }, "later stages keep their inherited Git config sources");
	assert.equal(provider.xdg, process.env.XDG_CONFIG_HOME ?? null, "later stages keep the inherited XDG configuration");
});

// gentle-shell#2552: Git reads $XDG_CONFIG_HOME/git/ignore even with an empty
// GIT_CONFIG_GLOBAL, so a host ignore file (e.g. ".agents/") must not drop
// fixture files from `git add -A` inside the unit stage.
test("unit stage isolates the XDG ignore file; a hostile host ignore cannot hide fixture files", (t) => {
	const hostileHome = mkdtempSync(join(tmpdir(), "gentle-pi-hostile-home-"));
	t.after(() => rmSync(hostileHome, { recursive: true, force: true }));
	mkdirSync(join(hostileHome, ".config", "git"), { recursive: true });
	writeFileSync(join(hostileHome, ".config", "git", "ignore"), ".agents/\n");
	const stagesDir = mkdtempSync(join(tmpdir(), "gentle-pi-xdg-fixture-"));
	t.after(() => rmSync(stagesDir, { recursive: true, force: true }));
	const fixturePath = join(stagesDir, "fixture.mjs");
	writeFileSync(fixturePath, `
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-xdg-repo-"));
const run = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
run("init", "-b", "main");
mkdirSync(join(cwd, ".agents", "skills", "example"), { recursive: true });
writeFileSync(join(cwd, ".agents", "skills", "example", "SKILL.md"), "example\\n");
run("add", "-A");
console.log("XDG_FIXTURE=" + JSON.stringify({ staged: run("ls-files").includes(".agents/skills/example/SKILL.md") }));
`);
	writeFileSync(join(stagesDir, "stages.json"), JSON.stringify([
		{ name: "unit-tests", command: `node "${fixturePath}"` },
	]));
	const result = spawnSync(process.execPath, [runnerPath, join(stagesDir, "stages.json")], {
		encoding: "utf8", env: { ...process.env, HOME: hostileHome, XDG_CONFIG_HOME: "" },
	});
	assert.equal(result.status, 0, result.stderr);
	const fixture = result.stdout.split(/\r?\n/).find((line) => line.startsWith("XDG_FIXTURE="));
	assert.ok(fixture, "the fixture probe ran");
	assert.deepEqual(JSON.parse(fixture.slice("XDG_FIXTURE=".length)), { staged: true }, "the hostile XDG ignore did not hide the fixture file");
});

test("unit stage strips inherited subagent context without changing later stages", (t) => {
	const env = { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: "1" };
	const [unit, provider] = probeStageEnvironment(t, env);
	assert.deepEqual(unit.agents, {});
	for (const [key, value] of Object.entries(env)) assert.equal(provider.agents[key], value);
});

test("unit stage accepts an uncreated inherited config home without creating it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-pi-caller-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const home = join(dir, "not-created");
	assert.equal(existsSync(home), false);
	const [unit, provider] = probeStageEnvironment(t, { GENTLE_PI_CONFIG_HOME: home });
	assert.notEqual(unit.home, home);
	assert.deepEqual(unit.files, ["empty.gitconfig"]);
	assert.equal(existsSync(unit.home), false);
	assert.equal(provider.home, home);
	assert.equal(provider.files, null);
	assert.equal(existsSync(home), false);
});

test("unit stage uses an empty temporary config home and removes it after exit", (t) => {
	const home = mkdtempSync(join(tmpdir(), "gentle-pi-caller-config-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const configPath = join(home, "runtime-guardrails.json");
	const config = JSON.stringify({ autonomousMode: true, guardedCommands: { gitPush: "allow", gitRebase: "allow", gitBranchDeleteForce: "allow" } });
	writeFileSync(configPath, config);
	const [unit, provider] = probeStageEnvironment(t, { GENTLE_PI_CONFIG_HOME: home });
	assert.notEqual(unit.home, home);
	assert.deepEqual(unit.files, ["empty.gitconfig"]);
	assert.equal(existsSync(unit.home), false);
	assert.equal(provider.home, home);
	assert.deepEqual(provider.files, ["runtime-guardrails.json"]);
	assert.equal(readFileSync(configPath, "utf8"), config);
});

test("direct invocation rejects a malformed stages file with a non-zero exit", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-pi-run-test-suite-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stagesPath = join(dir, "stages.json");
	writeFileSync(stagesPath, JSON.stringify([{ name: "missing-command" }]));
	const result = spawnSync(process.execPath, [runnerPath, stagesPath], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr ?? "", /stages file must be an array/);
});

// Harness roadmap T3: each subagent gets its own TMPDIR, and unit fixtures that
// leave a fake child unfinished would leave it behind; the stage owns them all.
test("unit stage gets a private TMPDIR removed after the stage; later stages keep the inherited one", (t) => {
	const inherited = mkdtempSync(join(tmpdir(), "gentle-pi-caller-tmp-"));
	t.after(() => rmSync(inherited, { recursive: true, force: true }));
	const [unit, provider] = probeStageEnvironment(t, { TMPDIR: inherited });
	assert.notEqual(unit.tmp, inherited);
	assert.match(unit.tmp, /gentle-pi-unit-tmp-/);
	assert.equal(unit.tmpExists, true, "the private TMPDIR exists while the stage runs");
	assert.equal(existsSync(unit.tmp), false, "the private TMPDIR is removed after the stage");
	assert.equal(provider.tmp, inherited);
});
