import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { existsSync, readdirSync } from "node:fs";
const home = process.env.GENTLE_PI_CONFIG_HOME;
console.log("ENV_PROBE=" + JSON.stringify({
  git: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GIT_"))),
  agents: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GENTLE_PI_AGENTS_"))),
  home,
  files: home && existsSync(home) ? readdirSync(home) : null,
  sentinel: process.env.TEST_ENV_SENTINEL,
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
	assert.deepEqual(unit.git, {});
	for (const [key, value] of Object.entries(env)) assert.equal(provider.git[key], value);
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
	assert.deepEqual(unit.files, []);
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
	assert.deepEqual(unit.files, []);
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
