import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLauncherArgs } from "../lib/gentle-shell-launcher.ts";
import { findStartupUpdate, shouldCheckStartupUpdate } from "../lib/gentle-shell-startup-update.ts";

const eligible = {
	args: parseLauncherArgs([]), env: {}, bundled: true, inputTTY: true, outputTTY: true,
};

test("ordinary bundled interactive launch and resume are eligible", () => {
	for (const argv of [[], ["--resume"], ["-r"], ["--continue"], ["-c"]]) {
		assert.equal(shouldCheckStartupUpdate({ ...eligible, args: parseLauncherArgs(argv) }), true);
	}
});

test("commands, overrides, non-TTY runs and child/offline opt-outs are excluded", () => {
	for (const argv of [["upgrade"], ["home"], ["setup"], ["install", "npm:x"], ["--help"], ["--version"], ["--package-root", "/custom"]]) {
		assert.equal(shouldCheckStartupUpdate({ ...eligible, args: parseLauncherArgs(argv) }), false, argv.join(" "));
	}
	for (const overrides of [{ bundled: false }, { inputTTY: false }, { outputTTY: false }, { args: { ...eligible.args, error: "invalid arguments" } }]) {
		assert.equal(shouldCheckStartupUpdate({ ...eligible, ...overrides }), false);
	}
	for (const name of ["GENTLE_PI_AGENTS_CHILD", "PI_OFFLINE", "GENTLE_SHELL_SKIP_STARTUP_UPDATE"]) {
		assert.equal(shouldCheckStartupUpdate({ ...eligible, env: { [name]: "1" } }), false);
	}
});

test("forwarded command modes and unknown flags never trigger a startup offer", () => {
	for (const argv of [["--print", "hello"], ["-p", "hello"], ["--mode", "rpc"], ["--mode=json"], ["--export", "session.json"], ["--list-models"], ["auth"], ["mcp"], ["--unknown"], ["--resume", "--print"], ["--resume", "session", "--mode", "json"]]) {
		assert.equal(shouldCheckStartupUpdate({ ...eligible, args: parseLauncherArgs(argv) }), false, argv.join(" "));
	}
});

test("only a newer strict stable version produces official release notes, without numeric precision loss", async () => {
	for (const [current, latest] of [["1.2.3", "1.2.4"], ["1.99.99", "2.0.0"], ["1.9007199254740992.0", "1.9007199254740993.0"]]) {
		assert.deepEqual(await findStartupUpdate({ current, lookup: async () => latest }), {
			current, latest, notesUrl: `https://github.com/Gentleman-Programming/gentle-shell/releases/tag/v${latest}`,
		});
	}
});

test("same, older, prerelease and malformed versions produce no offer", async () => {
	for (const latest of ["1.2.3", "1.2.2", "0.99.99", "2.0.0-beta.1", "2.0.0+build", "v2.0.0", "02.0.0", "2.0", "2.0.0\n", "garbage", undefined]) {
		assert.equal(await findStartupUpdate({ current: "1.2.3", lookup: async () => latest }), undefined);
	}
	for (const current of ["v1.2.3", "1.2.3-beta", "01.2.3", "1.2", ""]) {
		assert.equal(await findStartupUpdate({ current, lookup: async () => "2.0.0" }), undefined);
	}
});

test("skipping suppresses exactly the skipped release, not later releases", async () => {
	assert.equal(await findStartupUpdate({ current: "1.0.0", skipped: "2.0.0", lookup: async () => "2.0.0" }), undefined);
	assert.equal((await findStartupUpdate({ current: "1.0.0", skipped: "2.0.0", lookup: async () => "2.0.1" }))?.latest, "2.0.1");
});

test("lookup rejection and synchronous failure silently return no offer", async () => {
	assert.equal(await findStartupUpdate({ current: "1.0.0", lookup: async () => { throw new Error("offline"); } }), undefined);
	assert.equal(await findStartupUpdate({ current: "1.0.0", lookup: () => { throw new Error("offline"); } }), undefined);
});

test("timeout aborts and returns even when lookup ignores its signal", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let signal: AbortSignal | undefined;
	const pending = findStartupUpdate({ current: "1.0.0", lookup: (value) => { signal = value; return new Promise(() => {}); } });
	await Promise.resolve();
	t.mock.timers.tick(1499);
	assert.equal(signal?.aborted, false);
	t.mock.timers.tick(1);
	assert.equal(await pending, undefined);
	assert.equal(signal?.aborted, true);
});

test("custom deadline is bounded and settled lookups clear the timeout", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let timedSignal: AbortSignal | undefined;
	const pending = findStartupUpdate({ current: "1.0.0", timeoutMs: 20, lookup: (signal) => { timedSignal = signal; return new Promise(() => {}); } });
	await Promise.resolve();
	t.mock.timers.tick(20);
	assert.equal(await pending, undefined);
	assert.equal(timedSignal?.aborted, true);
	let settledSignal: AbortSignal | undefined;
	assert.ok(await findStartupUpdate({ current: "1.0.0", timeoutMs: 20, lookup: async (signal) => { settledSignal = signal; return "2.0.0"; } }));
	t.mock.timers.tick(20);
	assert.equal(settledSignal?.aborted, false);
});
