import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STAGES, runTestSuite } from "../scripts/run-test-suite.mjs";

// `pnpm test` chains its three stages; #1285 requires that a stage-1 failure
// never suppresses the later stages. These tests cover the runner's
// orchestration contract with fake stage implementations, so no real test
// process is spawned.

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
