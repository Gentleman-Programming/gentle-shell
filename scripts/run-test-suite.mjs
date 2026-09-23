#!/usr/bin/env node
// Sequential test-suite runner for `pnpm test` (gentle-pi#1285).
//
// `pnpm test` used to chain its three stages with `&&`, so any stage-1
// failure — including a known-flaky unit test — silently suppressed the
// provider-contract check and the runtime harness while reporting a plain
// "test failed". This runner executes every stage unconditionally, prints a
// per-stage header and a final summary, and exits non-zero when any stage
// fails. Stages are plain shell commands, so behavior stays identical on
// POSIX and Windows CI.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_STAGES = [
	{ name: "unit-tests", command: "node --experimental-strip-types --test tests/*.test.ts" },
	{ name: "provider-contract", command: "pnpm run check:provider-contract" },
	{ name: "runtime-harness", command: "pnpm run test:harness" },
];

export async function runStage(stage) {
	return await new Promise((resolve) => {
		const child = spawn(stage.command, { shell: true, stdio: "inherit" });
		child.on("close", (code) => resolve({ name: stage.name, code: code ?? 1 }));
		child.on("error", () => resolve({ name: stage.name, code: 1 }));
	});
}

export async function runTestSuite(stages = DEFAULT_STAGES, { runStageImpl = runStage, write = (line) => console.log(line) } = {}) {
	const results = [];
	for (const stage of stages) {
		write(`\n=== [${stage.name}] ${stage.command} ===`);
		results.push(await runStageImpl(stage));
	}
	write("\n=== test suite summary ===");
	for (const result of results) write(`${result.code === 0 ? "PASS" : "FAIL"}  ${result.name}`);
	const failures = results.filter((result) => result.code !== 0);
	write(failures.length === 0 ? "all stages passed" : `${failures.length} stage(s) failed: ${failures.map((f) => f.name).join(", ")}`);
	return results;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
	const results = await runTestSuite();
	const failed = results.some((result) => result.code !== 0);
	process.exitCode = failed ? 1 : 0;
}
