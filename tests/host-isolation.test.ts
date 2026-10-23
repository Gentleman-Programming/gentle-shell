import assert from "node:assert/strict";
import test from "node:test";
import {
	buildIsolatedExecutionPlan,
	clearIsolationCache,
	probeHostIsolation,
	type HostIsolationCapability,
} from "../lib/host-isolation.ts";

function alwaysSucceed(): boolean { return true; }
function alwaysFail(): boolean { return false; }
function succeedFor(...cmds: string[]): (cmd: string) => boolean {
	const s = new Set(cmds);
	return (cmd) => s.has(cmd);
}

// ─── probeHostIsolation ──────────────────────────────────────────────────────

test("Linux: bwrap present and functional -> linux_bwrap, supported", () => {
	clearIsolationCache();
	const cap = probeHostIsolation({ platform: "linux", runner: alwaysSucceed, forceRefresh: true });
	assert.equal(cap.mechanism, "linux_bwrap");
	assert.equal(cap.status, "supported");
	assert.equal(cap.platform, "linux");
	assert.equal(cap.enforced, true);
});

test("Linux: bwrap --version succeeds but full probe fails -> linux_bwrap, disabled", () => {
	clearIsolationCache();
	const runner = (cmd: string, args: string[]): boolean =>
		cmd === "bwrap" && args[0] === "--version";
	const cap = probeHostIsolation({ platform: "linux", runner, forceRefresh: true });
	assert.equal(cap.mechanism, "linux_bwrap");
	assert.equal(cap.status, "disabled");
	assert.equal(cap.enforced, false);
	assert.match(cap.reason, /unprivileged/);
});

test("Linux: bwrap missing but unshare works -> linux_unshare, supported", () => {
	clearIsolationCache();
	const cap = probeHostIsolation({ platform: "linux", runner: succeedFor("unshare"), forceRefresh: true });
	assert.equal(cap.mechanism, "linux_unshare");
	assert.equal(cap.status, "supported");
	assert.equal(cap.enforced, true);
});

test("Linux: neither bwrap nor unshare -> none, unsupported", () => {
	clearIsolationCache();
	const cap = probeHostIsolation({ platform: "linux", runner: alwaysFail, forceRefresh: true });
	assert.equal(cap.mechanism, "none");
	assert.equal(cap.status, "unsupported");
	assert.equal(cap.enforced, false);
});

test("macOS: sandbox-exec present and functional -> macos_sandbox, supported", () => {
	clearIsolationCache();
	const cap = probeHostIsolation({ platform: "darwin", runner: alwaysSucceed, forceRefresh: true });
	assert.equal(cap.mechanism, "macos_sandbox");
	assert.equal(cap.status, "supported");
	assert.equal(cap.platform, "darwin");
	assert.equal(cap.enforced, true);
});

test("macOS: sandbox-exec fails -> macos_sandbox, failed", () => {
	clearIsolationCache();
	const cap = probeHostIsolation({ platform: "darwin", runner: alwaysFail, forceRefresh: true });
	assert.equal(cap.mechanism, "macos_sandbox");
	assert.equal(cap.status, "failed");
	assert.equal(cap.enforced, false);
});

test("Windows: none, unsupported, honest reason mentioning Windows", () => {
	clearIsolationCache();
	const cap = probeHostIsolation({ platform: "win32", runner: alwaysSucceed, forceRefresh: true });
	assert.equal(cap.mechanism, "none");
	assert.equal(cap.status, "unsupported");
	assert.equal(cap.platform, "win32");
	assert.equal(cap.enforced, false);
	assert.match(cap.reason, /Windows/);
});

test("Unknown platform: none, unsupported, platform name in reason", () => {
	clearIsolationCache();
	const cap = probeHostIsolation({ platform: "freebsd", runner: alwaysSucceed, forceRefresh: true });
	assert.equal(cap.mechanism, "none");
	assert.equal(cap.status, "unsupported");
	assert.match(cap.reason, /freebsd/);
});

// ─── Caching ─────────────────────────────────────────────────────────────────

test("Cache: probe called once; subsequent calls use cached result", () => {
	clearIsolationCache();
	let calls = 0;
	const counting = (): boolean => { calls++; return true; };
	const first = probeHostIsolation({ platform: "linux", runner: counting });
	const afterFirst = calls;
	assert.ok(afterFirst > 0, "runner must be called on first probe");
	const second = probeHostIsolation({ platform: "linux", runner: counting });
	assert.equal(calls, afterFirst, "runner must not be called on cached probe");
	assert.equal(first, second, "cached and fresh reference must be the same object");
	clearIsolationCache();
});

test("Cache: forceRefresh bypasses cache and re-probes", () => {
	clearIsolationCache();
	let calls = 0;
	const counting = (): boolean => { calls++; return true; };
	probeHostIsolation({ platform: "linux", runner: counting });
	const after = calls;
	probeHostIsolation({ platform: "linux", runner: counting, forceRefresh: true });
	assert.ok(calls > after, "runner must be called again with forceRefresh");
	clearIsolationCache();
});

// ─── buildIsolatedExecutionPlan ──────────────────────────────────────────────

const unsupported: HostIsolationCapability = {
	mechanism: "none", status: "unsupported", platform: "win32", enforced: false,
	reason: "Windows has no unprivileged sandbox",
};

test("Permissive policy on unsupported host -> unwrapped, isolated: false", () => {
	const plan = buildIsolatedExecutionPlan("node", ["app.js"], { policy: "permissive", capability: unsupported });
	assert.equal(plan.command, "node");
	assert.deepEqual(plan.args, ["app.js"]);
	assert.equal(plan.isolated, false);
});

test("Default policy is permissive (no throw on unsupported)", () => {
	const plan = buildIsolatedExecutionPlan("echo", ["hello"], { capability: unsupported });
	assert.equal(plan.isolated, false);
	assert.equal(plan.command, "echo");
});

test("Strict policy on unsupported host -> throws fail-closed error", () => {
	assert.throws(
		() => buildIsolatedExecutionPlan("node", ["app.js"], { policy: "strict", capability: unsupported }),
		(e: unknown) => e instanceof Error && /Isolation required but unavailable/.test(e.message) && /Windows has no unprivileged sandbox/.test(e.message),
	);
});

test("Strict policy on disabled host -> throws fail-closed error", () => {
	const disabled: HostIsolationCapability = {
		mechanism: "linux_bwrap", status: "disabled", platform: "linux", enforced: false,
		reason: "bwrap present but userns disabled",
	};
	assert.throws(
		() => buildIsolatedExecutionPlan("node", ["app.js"], { policy: "strict", capability: disabled }),
		(e: unknown) => e instanceof Error && /Isolation required but unavailable/.test((e as Error).message),
	);
});

test("linux_bwrap supported -> bwrap-wrapped, --unshare-net present, isolated: true", () => {
	const cap: HostIsolationCapability = {
		mechanism: "linux_bwrap", status: "supported", platform: "linux", enforced: true, reason: "ok",
	};
	const plan = buildIsolatedExecutionPlan("node", ["app.js"], { capability: cap, cwd: "/workspace" });
	assert.equal(plan.command, "bwrap");
	assert.equal(plan.isolated, true);
	assert.ok(plan.args.includes("--unshare-net"));
	assert.ok(plan.args.includes("/workspace"));
	assert.ok(plan.args.includes("node"));
	assert.ok(plan.args.includes("app.js"));
});

test("linux_unshare supported -> unshare --net wrapped, isolated: true", () => {
	const cap: HostIsolationCapability = {
		mechanism: "linux_unshare", status: "supported", platform: "linux", enforced: true, reason: "ok",
	};
	const plan = buildIsolatedExecutionPlan("curl", ["-s", "http://x.test"], { capability: cap });
	assert.equal(plan.command, "unshare");
	assert.equal(plan.isolated, true);
	assert.ok(plan.args.includes("--net"));
	assert.ok(plan.args.includes("curl"));
});

test("macos_sandbox supported -> sandbox-exec wrapped, deny network present, isolated: true", () => {
	const cap: HostIsolationCapability = {
		mechanism: "macos_sandbox", status: "supported", platform: "darwin", enforced: true, reason: "ok",
	};
	const plan = buildIsolatedExecutionPlan("node", ["server.js"], { capability: cap });
	assert.equal(plan.command, "sandbox-exec");
	assert.equal(plan.isolated, true);
	assert.ok(plan.args.some((a) => a.includes("deny network")));
	assert.ok(plan.args.includes("node"));
	assert.ok(plan.args.includes("server.js"));
});
