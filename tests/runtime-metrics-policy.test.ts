import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeMetricsPolicy, runtimeMetricsEnvAllows } from "../lib/runtime-metrics-policy.ts";

const grant = { schema: "gentle-ai.telemetry-policy/v1", operation: "policy", enabled: true, source: "state", reason: "enabled" };
const result = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0,
	signal: null, timedOut: false, outputLimitExceeded: false });

test("only strict enabled policy grants; uses bounded policy invocation exclusively", async () => {
	let calls = 0;
	assert.equal(await readRuntimeMetricsPolicy("/workspace", {
		resolve: () => "/fixture/gentle-ai", exec: async request => {
			calls++;
			assert.deepEqual(request.arguments, ["telemetry", "policy", "--json"]);
			assert.equal(request.file, "/fixture/gentle-ai");
			assert.equal(request.cwd, "/workspace");
			assert.equal(request.timeoutMs, 1000);
			assert.equal(request.maxBufferBytes, 2048);
			return result(grant);
		},
	}), true);
	assert.equal(calls, 1);
	for (const patch of [{ schema: "wrong" }, { operation: "status" }, { enabled: "true" },
		{ enabled: false, reason: "disabled" }, { reason: "enrollment_pending" }, { reason: "state_unavailable" },
		{ source: "private" }, { raw: "private" }, { reason: undefined }]) {
		assert.equal(await readRuntimeMetricsPolicy("/workspace", {
			resolve: () => "fixture", exec: async () => result({ ...grant, ...patch }),
		}), false);
	}
});

test("missing, old, timed-out and malformed binary responses fail closed without fallback", async () => {
	for (const patch of [{ exitCode: 1 }, { timedOut: true }, { outputLimitExceeded: true },
		{ signal: "SIGTERM" }, { stderr: "private error" }, { stdout: "unsupported command" },
		{ stdout: "x".repeat(2049) }, { stdout: "null" }, { stdout: "[]" }]) {
		let calls = 0;
		assert.equal(await readRuntimeMetricsPolicy("/workspace", { resolve: () => "fixture",
			exec: async () => { calls++; return { ...result(grant), ...patch } as any; } }), false);
		assert.equal(calls, 1);
	}
	assert.equal(await readRuntimeMetricsPolicy("/workspace", {
		resolve: () => { throw new Error("missing"); }, exec: async () => assert.fail("must not spawn"),
	}), false);
	assert.equal(await readRuntimeMetricsPolicy("/workspace", {
		resolve: () => "fixture", exec: async () => { throw new Error("ENOENT"); },
	}), false);
});

test("outer deadline releases callers even when an exec adapter never settles", async () => {
	let signal: AbortSignal | undefined;
	assert.equal(await readRuntimeMetricsPolicy("/workspace", { resolve: () => "fixture",
		exec: request => { signal = request.signal; return new Promise(() => {}); } }), false);
	assert.equal(signal?.aborted, true);
});

test("native-compatible environment veto accepts broad truthy spellings", () => {
	for (const key of ["DO_NOT_TRACK", "CI", "GITHUB_ACTIONS"]) {
		for (const value of ["1", "true", "TRUE", " yes ", "on", "t", "unknown"]) assert.equal(runtimeMetricsEnvAllows({ [key]: value }), false);
	}
	assert.equal(runtimeMetricsEnvAllows({ GENTLE_AI_TELEMETRY: "0" }), false);
	assert.equal(runtimeMetricsEnvAllows({ DO_NOT_TRACK: "false", CI: "0" }), true);
});
