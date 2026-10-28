import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLauncherArgs } from "../lib/gentle-shell-launcher.ts";
import { findStartupUpdate, parseStartupReleaseCache, shouldCheckStartupUpdate, writeStartupReleaseCache } from "../lib/gentle-shell-startup-update.ts";

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

// A fresh cache keeps the everyday launch off the network entirely: the offer
// (or its absence) is decided from the recorded lookup, and the live lookup —
// whose result is the only thing worth caching — runs only when the cache is
// stale, missing, or malformed.
test("a fresh cache decides the offer without touching the network", async () => {
	const offline = async (): Promise<string> => { throw new Error("lookup must not run on a fresh cache"); };
	const fresh = { checkedAt: Date.now() - 60 * 60 * 1000, latest: "2.0.0" };
	assert.deepEqual(await findStartupUpdate({ current: "1.0.0", lookup: offline, cache: fresh, ttlMs: 24 * 60 * 60 * 1000 }), {
		current: "1.0.0", latest: "2.0.0", notesUrl: "https://github.com/Gentleman-Programming/gentle-shell/releases/tag/v2.0.0",
	});
	assert.equal(await findStartupUpdate({ current: "2.0.0", lookup: offline, cache: fresh, ttlMs: 24 * 60 * 60 * 1000 }), undefined);
});

test("a fresh cache respects the skipped release exactly like a live lookup", async () => {
	const offline = async (): Promise<string> => { throw new Error("lookup must not run on a fresh cache"); };
	assert.equal(await findStartupUpdate({ current: "1.0.0", skipped: "2.0.0", lookup: offline, cache: { checkedAt: Date.now() - 1000, latest: "2.0.0" } }), undefined);
	assert.equal((await findStartupUpdate({ current: "1.0.0", skipped: "2.0.0", lookup: offline, cache: { checkedAt: Date.now() - 1000, latest: "2.0.1" } }))?.latest, "2.0.1");
});

test("a stale, missing or malformed cache runs the live lookup and records its answer", async () => {
	const written: string[] = [];
	const opts = {
		current: "1.0.0",
		lookup: async () => "2.0.1",
		ttlMs: 1000,
		cacheWrite: (latest: string) => { written.push(latest); },
	};
	// Stale beyond the TTL.
	assert.equal((await findStartupUpdate({ ...opts, cache: { checkedAt: Date.now() - 1001, latest: "2.0.0" } }))?.latest, "2.0.1");
	// No cache at all.
	assert.equal((await findStartupUpdate({ ...opts }))?.latest, "2.0.1");
	// A cache whose latest never parsed: never trusted, refreshed instead.
	assert.equal((await findStartupUpdate({ ...opts, cache: { checkedAt: Date.now() - 1, latest: "garbage" } }))?.latest, "2.0.1");
	assert.deepEqual(written, ["2.0.1", "2.0.1", "2.0.1"]);
});

test("an unanswered lookup is never cached", async () => {
	const written: string[] = [];
	assert.equal(await findStartupUpdate({ current: "1.0.0", lookup: async () => undefined, cacheWrite: (latest) => { written.push(latest); } }), undefined);
	assert.equal(await findStartupUpdate({ current: "1.0.0", lookup: async () => { throw new Error("offline"); }, cacheWrite: (latest) => { written.push(latest); } }), undefined);
	assert.deepEqual(written, []);
});

test("the cache ages against the injected clock, not the wall", async () => {
	const now = 1_700_000_000_000;
	const offline = async (): Promise<string> => { throw new Error("lookup must not run on a fresh cache"); };
	// Exactly at the TTL boundary the cache is already stale: the check errs
	// toward the live lookup, never toward skipping it.
	assert.equal((await findStartupUpdate({ current: "1.0.0", lookup: async () => "2.0.0", ttlMs: 1000, nowMs: now, cache: { checkedAt: now - 1000, latest: "2.0.0" } }))?.latest, "2.0.0");
	assert.deepEqual(await findStartupUpdate({ current: "1.0.0", lookup: offline, ttlMs: 1000, nowMs: now - 1, cache: { checkedAt: now - 1000, latest: "2.0.0" } }).then((offer) => offer?.latest), "2.0.0");
});

test("parseStartupReleaseCache accepts the recorded shape and rejects everything else", () => {
	assert.deepEqual(parseStartupReleaseCache({ checkedAt: "2026-01-01T00:00:00.000Z", latest: "2.0.1" }), { checkedAt: Date.parse("2026-01-01T00:00:00.000Z"), latest: "2.0.1" });
	assert.deepEqual(parseStartupReleaseCache({ checkedAt: 1_700_000_000_000, latest: "2.0.1" }), { checkedAt: 1_700_000_000_000, latest: "2.0.1" });
	for (const bad of [undefined, null, "x", [], {}, { checkedAt: "nope", latest: "2.0.1" }, { checkedAt: 1_700_000_000_000 }, { checkedAt: 1_700_000_000_000, latest: "" }]) {
		assert.equal(parseStartupReleaseCache(bad), undefined);
	}
});

test("writeStartupReleaseCache records one lookup alongside the existing config keys", () => {
	const stored: string[] = [];
	const config = JSON.stringify({ skippedStartupRelease: "9.9.9", other: { nested: true } });
	writeStartupReleaseCache(() => config, (text) => stored.push(text), "2.0.1", 1_700_000_000_000);
	const saved = JSON.parse(stored[0]);
	assert.equal(saved.skippedStartupRelease, "9.9.9");
	assert.deepEqual(saved.other, { nested: true });
	assert.equal(saved.startupReleaseCheck.latest, "2.0.1");
	assert.equal(saved.startupReleaseCheck.checkedAt, new Date(1_700_000_000_000).toISOString());
	// An absent config file starts a minimal one.
	writeStartupReleaseCache(() => undefined, (text) => stored.push(text), "2.0.1");
	assert.deepEqual(JSON.parse(stored[1]).startupReleaseCheck.latest, "2.0.1");
	// An invalid config must fail loudly, never overwrite it silently.
	assert.throws(() => writeStartupReleaseCache(() => "{ broken", () => {}, "2.0.1"));
});
