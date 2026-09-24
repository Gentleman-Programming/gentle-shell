import assert from "node:assert/strict";
import test from "node:test";
import {
	INTERACTIVE_HOST_ENV,
	isInteractiveMode,
	isInteractiveRpcHost,
	withoutInteractiveHost,
} from "../lib/rpc-host.ts";

// Interactive host signal: the desktop app sets GENTLE_SHELL_INTERACTIVE_HOST=1
// on the pi process it spawns directly (`--mode rpc`). Subagent children
// spawned by lib/agents-runner.ts must never see it, so rpc without the
// variable stays byte-identical to today's headless behaviour.

test("isInteractiveRpcHost is true only for rpc mode with the variable set to \"1\"", () => {
	assert.equal(isInteractiveRpcHost("rpc", { [INTERACTIVE_HOST_ENV]: "1" }), true);
});

test("isInteractiveRpcHost is false for rpc mode without the variable", () => {
	assert.equal(isInteractiveRpcHost("rpc", {}), false);
});

test("isInteractiveRpcHost is false for rpc mode when the variable is not exactly \"1\"", () => {
	assert.equal(isInteractiveRpcHost("rpc", { [INTERACTIVE_HOST_ENV]: "true" }), false);
	assert.equal(isInteractiveRpcHost("rpc", { [INTERACTIVE_HOST_ENV]: "0" }), false);
	assert.equal(isInteractiveRpcHost("rpc", { [INTERACTIVE_HOST_ENV]: "" }), false);
});

test("isInteractiveRpcHost is false for every non-rpc mode even with the variable set", () => {
	for (const mode of ["tui", "print", "json"]) {
		assert.equal(isInteractiveRpcHost(mode, { [INTERACTIVE_HOST_ENV]: "1" }), false, `mode ${mode}`);
	}
});

test("isInteractiveRpcHost defaults to process.env when no env is supplied", (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});

	assert.equal(isInteractiveRpcHost("rpc"), true);
});

test("isInteractiveMode is true for tui regardless of the variable", () => {
	assert.equal(isInteractiveMode("tui", {}), true);
	assert.equal(isInteractiveMode("tui", { [INTERACTIVE_HOST_ENV]: "1" }), true);
});

test("isInteractiveMode is true for an interactive rpc host", () => {
	assert.equal(isInteractiveMode("rpc", { [INTERACTIVE_HOST_ENV]: "1" }), true);
});

test("isInteractiveMode is false for rpc without the variable, and for print/json", () => {
	assert.equal(isInteractiveMode("rpc", {}), false);
	assert.equal(isInteractiveMode("print", { [INTERACTIVE_HOST_ENV]: "1" }), false);
	assert.equal(isInteractiveMode("json", { [INTERACTIVE_HOST_ENV]: "1" }), false);
});

test("withoutInteractiveHost returns a copy without the variable, preserving the rest", () => {
	const source = { PATH: "/bin", [INTERACTIVE_HOST_ENV]: "1", KEEP: "yes" };

	const result = withoutInteractiveHost(source);

	assert.deepEqual(result, { PATH: "/bin", KEEP: "yes" });
	assert.deepEqual(source, { PATH: "/bin", [INTERACTIVE_HOST_ENV]: "1", KEEP: "yes" }, "the source env is not mutated");
});

test("withoutInteractiveHost is a no-op copy when the variable is absent", () => {
	const source = { PATH: "/bin" };

	const result = withoutInteractiveHost(source);

	assert.deepEqual(result, { PATH: "/bin" });
	assert.notEqual(result, source, "a fresh object is returned, not the same reference");
});
