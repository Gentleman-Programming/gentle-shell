import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	classifyCodegraphShimPath,
	clearCodegraphUpdateCaches,
	CODEGRAPH_PACKAGE,
	codegraphVersionDiffers,
	defaultExec,
	detectCodegraphInstallSource,
	ensureCodegraphInstalled,
	ensureCodegraphLatest,
	installedCodegraphVersion,
	latestCodegraphVersion,
	NPM_VIEW_TIMEOUT_MS,
	parseCodegraphVersion,
	runCodegraphUpdateCheck,
	UPDATE_TIMEOUT_MS,
	updateCodegraphToLatest,
	VERSION_TIMEOUT_MS,
	type BoundedExec,
	type CodegraphInstallSource,
	type ExecResult,
} from "../lib/codegraph-update.ts";

/** A backslash without a backslash literal, so win32 fixture paths stay transport-safe. */
const BS = String.fromCharCode(92);

const ok = (stdout: string, stderr = ""): ExecResult => ({ ok: true, stdout, stderr });
const fail = (stderr = "failed"): ExecResult => ({ ok: false, stdout: "", stderr });

/** One scripted BoundedExec: every call is recorded and answered by the handler; an undefined
 * answer fails the call, so a test that does not expect an exec observes it loudly. A handler
 * may return a promise to hold a call open (concurrency fixtures gate it on their own signal). */
function scriptedExec(handler: (command: string, args: readonly string[]) => ExecResult | Promise<ExecResult> | undefined): {
	exec: BoundedExec;
	calls: Array<{ command: string; args: string[]; timeoutMs: number }>;
} {
	const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
	const exec: BoundedExec = async (command, args, timeoutMs) => {
		calls.push({ command, args: [...args], timeoutMs });
		return (await handler(command, args)) ?? fail("unexpected exec");
	};
	return { exec, calls };
}

/** Answers by first argument ("codegraph" -> version probe, "npm"/"npm.cmd" -> registry work). */
function execByFirstArg(map: Record<string, (args: readonly string[]) => ExecResult | Promise<ExecResult> | undefined>): {
	exec: BoundedExec;
	calls: Array<{ command: string; args: string[]; timeoutMs: number }>;
} {
	return scriptedExec((command, args) => map[command]?.(args));
}

test("parseCodegraphVersion: the first full version identifier, prerelease suffix included", () => {
	assert.equal(parseCodegraphVersion("1.6.4\n"), "1.6.4");
	assert.equal(parseCodegraphVersion("codegraph 1.6.4\n"), "1.6.4");
	assert.equal(parseCodegraphVersion("codegraph/1.6.4 darwin-arm64 node v22\n"), "1.6.4");
	assert.equal(parseCodegraphVersion("codegraph 1.6.4-beta.2\n"), "1.6.4-beta.2", "the suffix is part of the identifier, never dropped noise");
	assert.equal(parseCodegraphVersion("1.6.5-rc.1\n"), "1.6.5-rc.1");
	assert.equal(parseCodegraphVersion("1.6.4-\n"), undefined, "an empty suffix is malformed output, not a plain triple");
	assert.equal(parseCodegraphVersion("1.6.4-!!\n"), undefined, "an unspellable suffix is malformed output: fail open");
	assert.equal(parseCodegraphVersion(""), undefined);
	assert.equal(parseCodegraphVersion("codegraph\n"), undefined);
	assert.equal(parseCodegraphVersion("not a version at all"), undefined);
});

test("installedCodegraphVersion: a bounded codegraph --version probe, undefined on any failure", async () => {
	const { exec, calls } = execByFirstArg({ codegraph: () => ok("codegraph 1.6.4\n") });
	assert.equal(await installedCodegraphVersion(exec), "1.6.4");
	assert.deepEqual(calls, [{ command: "codegraph", args: ["--version"], timeoutMs: VERSION_TIMEOUT_MS }]);

	const refused = execByFirstArg({ codegraph: () => fail("spawn ENOENT") });
	assert.equal(await installedCodegraphVersion(refused.exec), undefined, "a failed probe never yields a version");

	const garbage = execByFirstArg({ codegraph: () => ok("banana") });
	assert.equal(await installedCodegraphVersion(garbage.exec), undefined, "unparseable output is not a version");
});

test("latestCodegraphVersion: npm view output parsed, cached for the process, cache clearable", async () => {
	clearCodegraphUpdateCaches();
	let viewCount = 0;
	const { exec, calls } = execByFirstArg({
		npm: (args) => {
			if (args[0] === "view") {
				viewCount += 1;
				return ok("1.6.5\n");
			}
			return undefined;
		},
	});
	assert.equal(await latestCodegraphVersion(exec, "darwin"), "1.6.5");
	assert.equal(await latestCodegraphVersion(exec, "darwin"), "1.6.5", "the second call is served from the process cache");
	assert.equal(viewCount, 1);
	assert.deepEqual(calls, [{ command: "npm", args: ["view", CODEGRAPH_PACKAGE, "version"], timeoutMs: NPM_VIEW_TIMEOUT_MS }]);

	clearCodegraphUpdateCaches();
	assert.equal(await latestCodegraphVersion(exec, "darwin"), "1.6.5");
	assert.equal(viewCount, 2, "the cleared cache makes the next call probe again");
});

test("latestCodegraphVersion: a failed lookup is undefined and never cached as failure", async () => {
	clearCodegraphUpdateCaches();
	let failing = true;
	const { exec } = execByFirstArg({
		npm: () => (failing ? fail("ENOTFOUND registry") : ok("1.6.5\n")),
	});
	assert.equal(await latestCodegraphVersion(exec, "darwin"), undefined, "an offline registry lookup is undefined: the check skips");
	failing = false;
	assert.equal(await latestCodegraphVersion(exec, "darwin"), "1.6.5", "a failure is not memoized: the next lookup can succeed");

	clearCodegraphUpdateCaches();
	const unparseable = execByFirstArg({ npm: () => ok("latest: soon") });
	assert.equal(await latestCodegraphVersion(unparseable.exec, "darwin"), undefined, "registry output without a triple is not a version");
});

test("codegraphVersionDiffers: numeric triple compare; anything but an exact match updates, garbage never does", () => {
	assert.equal(codegraphVersionDiffers("1.6.3", "1.6.4"), true, "a patch behind differs");
	assert.equal(codegraphVersionDiffers("1.5.9", "1.6.0"), true, "a minor behind differs");
	assert.equal(codegraphVersionDiffers("0.9.9", "1.0.0"), true, "a major behind differs");
	assert.equal(codegraphVersionDiffers("1.6.4", "1.6.4"), false, "the same version is the wanted version");
	assert.equal(codegraphVersionDiffers("1.7.0", "1.6.10"), true, "numeric fields compare: 1.7.0 differs from 1.6.10");
	assert.equal(codegraphVersionDiffers("2.0.0", "1.9.9"), true, "ahead of latest still differs: latest is the only version kept");
	assert.equal(codegraphVersionDiffers("1.6.4", "1.6.5-beta.1"), true, "a prerelease ahead still differs");
	assert.equal(codegraphVersionDiffers("1.6.4-beta.2", "1.6.4"), true, "a prerelease behind the stable release differs: the stable release is the wanted version");
	assert.equal(codegraphVersionDiffers("1.6.4-beta.2", "1.6.4-beta.2"), false, "the same prerelease is the wanted version");
	assert.equal(codegraphVersionDiffers("1.6.4-beta.1", "1.6.4-beta.2"), true, "different suffixes differ even on an equal triple");
	assert.equal(codegraphVersionDiffers("1.6.4-", "1.6.4"), false, "a malformed version never updates");
	assert.equal(codegraphVersionDiffers("1.7", "1.6.4"), false, "an unparseable installed version never updates");
	assert.equal(codegraphVersionDiffers("garbage", "1.6.4"), false);
	assert.equal(codegraphVersionDiffers("1.6.4", "garbage"), false, "an unparseable latest never updates");
	assert.equal(codegraphVersionDiffers(undefined, "1.6.4"), false);
	assert.equal(codegraphVersionDiffers("1.6.4", undefined), false);
});

test("classifyCodegraphShimPath: bun-global by the homedir .bun prefix, checked first", () => {
	// Literal POSIX spellings: the injected platform owns the fixture's separators, never the
	// host running the suite (join() would spell backslashes on Windows).
	assert.equal(classifyCodegraphShimPath("/Users/tester/.bun/bin/codegraph", {}, "/Users/tester", "darwin"), "bun-global");
	assert.equal(classifyCodegraphShimPath("/home/tester/.bun/bin/codegraph", { npmPrefix: "/home/tester/.npm-global", pnpmBin: "/home/tester/.pnpm-bin" }, "/home/tester", "linux"), "bun-global", "the bun root classifies before npm or pnpm is even asked");
});

test("classifyCodegraphShimPath: npm-global under the npm prefix -g directory", () => {
	const home = homedir();
	assert.equal(classifyCodegraphShimPath("/usr/local/bin/codegraph", { npmPrefix: "/usr/local" }, home, "darwin"), "npm-global");
	assert.equal(classifyCodegraphShimPath("/opt/homebrew/bin/codegraph", { npmPrefix: "/opt/homebrew" }, home, "linux"), "npm-global");
	assert.equal(classifyCodegraphShimPath("/usr/local/bin/codegraph", {}, home, "darwin"), "unknown", "no prefix answer: nothing proves npm owns it");
	assert.equal(classifyCodegraphShimPath("/usr/local/bin/codegraph", { pnpmBin: "/usr/local" }, home, "darwin"), "pnpm-global", "a shim under the pnpm bin dir classifies pnpm-global, whatever the dir is called");
	assert.equal(classifyCodegraphShimPath("/usr/bin/codegraph", { npmPrefix: "/usr/local" }, home, "darwin"), "unknown", "outside every root is never auto-updated");
	assert.equal(classifyCodegraphShimPath(undefined, { npmPrefix: "/usr/local" }, home, "darwin"), "unknown");
});

test("classifyCodegraphShimPath: win32 backslash paths compare case-insensitively across separators", () => {
	const home = ["C:", "Users", "admin"].join(BS);
	assert.equal(classifyCodegraphShimPath(["C:", "Users", "admin", ".bun", "bin", "codegraph.exe"].join(BS), {}, home, "win32"), "bun-global");
	assert.equal(classifyCodegraphShimPath(["c:", "users", "ADMIN", ".bun", "bin", "codegraph.exe"].join(BS), {}, home, "win32"), "bun-global", "win32 paths fold case");
	assert.equal(
		classifyCodegraphShimPath(["C:", "Users", "admin", "AppData", "Roaming", "npm", "codegraph.cmd"].join(BS), { npmPrefix: ["C:", "Users", "admin", "AppData", "Roaming", "npm"].join(BS) }, home, "win32"),
		"npm-global",
		"a backslash shim under a backslash prefix is npm-global",
	);
	assert.equal(
		classifyCodegraphShimPath(["C:", "Users", "admin", "AppData", "Roaming", "npm", "codegraph.cmd"].join(BS), { npmPrefix: ["C:/Users/admin/AppData/Roaming/npm"].join("/") }, home, "win32"),
		"npm-global",
		"forward-slash and backslash spellings of one root still match",
	);
	const prefixWithSlash = ["C:", "Users", "admin", "AppData", "Roaming", "npm", ""].join(BS);
	assert.equal(
		classifyCodegraphShimPath(["C:", "Users", "admin", "AppData", "Roaming", "npm", "codegraph.cmd"].join(BS), { npmPrefix: prefixWithSlash }, home, "win32"),
		"npm-global",
		"a trailing separator on the reported prefix does not double or mismatch",
	);
	assert.equal(
		classifyCodegraphShimPath(["C:", "Users", "admin", "Library", "pnpm", "codegraph.cmd"].join(BS), { pnpmBin: ["C:", "Users", "admin", "Library", "pnpm"].join(BS) }, home, "win32"),
		"pnpm-global",
		"a backslash shim under pnpm's global bin is pnpm-global",
	);
	assert.equal(
		classifyCodegraphShimPath(["C:", "Tools", "codegraph", "codegraph.exe"].join(BS), { npmPrefix: ["C:", "Users", "admin", "AppData", "Roaming", "npm"].join(BS) }, home, "win32"),
		"unknown",
	);
	assert.equal(classifyCodegraphShimPath(["C:", "NotBun", "codegraph.exe"].join(BS), {}, home, "win32"), "unknown", "a prefix like .bun is a directory boundary, not a string prefix");
});

test("detectCodegraphInstallSource: which answers on POSIX and bun skips the npm prefix query", async () => {
	const home = "/Users/tester";
	const shim = `${home}/.bun/bin/codegraph`;
	const { exec, calls } = execByFirstArg({ which: () => ok(`${shim}\n`) });
	const detected = await detectCodegraphInstallSource(exec, { platform: "darwin", home });
	assert.equal(detected.source, "bun-global");
	assert.equal(detected.shimPath, shim);
	assert.deepEqual(calls.map((call) => call.command), ["which"], "the bun root needs no npm prefix probe");
	assert.deepEqual(calls[0]?.args, ["codegraph"]);
});

test("detectCodegraphInstallSource: where.exe first hit classifies npm-global on win32", async () => {
	const home = ["C:", "Users", "admin"].join(BS);
	const first = ["C:", "Users", "admin", "AppData", "Roaming", "npm", "codegraph.cmd"].join(BS);
	const second = ["D:", "tools", "codegraph.cmd"].join(BS);
	const { exec, calls } = execByFirstArg({
		"where.exe": () => ok(`${first}\r\n${second}\r\n`),
		"npm.cmd": (args) => (args[0] === "prefix" ? ok(["C:", "Users", "admin", "AppData", "Roaming", "npm"].join(BS) + "\n") : undefined),
	});
	const detected = await detectCodegraphInstallSource(exec, { platform: "win32", home });
	assert.equal(detected.source, "npm-global");
	assert.equal(detected.shimPath, first, "where.exe answers many hits; the first is the one cmd.exe runs");
	assert.deepEqual(calls.map((call) => call.command), ["where.exe", "npm.cmd"]);
});

test("detectCodegraphInstallSource: a pnpm shim classifies pnpm-global after npm misses", async () => {
	const { exec, calls } = execByFirstArg({
		which: () => ok("/Users/tester/Library/pnpm/bin/codegraph\n"),
		npm: (args) => (args[0] === "prefix" ? ok("/opt/homebrew\n") : undefined),
		pnpm: (args) => (args[0] === "bin" ? ok("/Users/tester/Library/pnpm/bin\n") : undefined),
	});
	const detected = await detectCodegraphInstallSource(exec, { platform: "darwin", home: "/Users/tester" });
	assert.equal(detected.source, "pnpm-global");
	assert.equal(detected.shimPath, "/Users/tester/Library/pnpm/bin/codegraph");
	assert.deepEqual(calls.map((call) => call.command), ["which", "npm", "pnpm"], "bun misses purely, npm is probed before pnpm");
});

test("detectCodegraphInstallSource: win32 probes pnpm through its .cmd shim", async () => {
	const home = ["C:", "Users", "admin"].join(BS);
	const pnpmBin = ["C:", "Users", "admin", "AppData", "Local", "pnpm"].join(BS);
	const { exec, calls } = execByFirstArg({
		"where.exe": (args) => (args[0] === "codegraph"
			? ok([pnpmBin, "codegraph.cmd"].join(BS) + "\r\n")
			: args[0] === "pnpm.cmd" ? ok([pnpmBin, "pnpm.cmd"].join(BS) + "\r\n")
			: undefined),
		"npm.cmd": () => fail("prefix unavailable"),
		"pnpm.cmd": (args) => (args[0] === "bin" ? ok(pnpmBin + "\n") : undefined),
	});
	const detected = await detectCodegraphInstallSource(exec, { platform: "win32", home });
	assert.equal(detected.source, "pnpm-global");
	assert.equal(detected.shimPath, [pnpmBin, "codegraph.cmd"].join(BS));
	assert.deepEqual(calls.map((call) => call.command), ["where.exe", "npm.cmd", "where.exe", "pnpm.cmd"], "the .cmd shim is confirmed on PATH once, then bin -g runs through it");
});

test("detectCodegraphInstallSource: an npm-prefix query failure leaves the source unknown", async () => {
	const { exec, calls } = execByFirstArg({
		which: () => ok("/usr/local/bin/codegraph\n"),
		npm: () => fail("ENOTFOUND"),
		pnpm: () => fail("not installed"),
	});
	const detected = await detectCodegraphInstallSource(exec, { platform: "darwin", home: homedir() });
	assert.equal(detected.source, "unknown");
	assert.match(detected.reason ?? "", /npm prefix -g nor pnpm bin -g/, "the reason names both unprovable roots");
	assert.deepEqual(calls.map((call) => call.command), ["which", "npm", "pnpm"], "both root probes ran, npm before pnpm");
});

test("detectCodegraphInstallSource: a shim not on PATH is unknown with no further probes", async () => {
	const { exec, calls } = execByFirstArg({ which: () => fail("not found") });
	const detected = await detectCodegraphInstallSource(exec, { platform: "darwin", home: homedir() });
	assert.equal(detected.source, "unknown");
	assert.match(detected.reason ?? "", /PATH/);
	assert.deepEqual(calls.map((call) => call.command), ["which"], "no npm work happens without a shim");
});

test("updateCodegraphToLatest: each manager updates in its own form on every platform", async () => {
	const bun = execByFirstArg({ bun: () => ok("") });
	assert.deepEqual(await updateCodegraphToLatest("bun-global", bun.exec, { platform: "darwin" }), { ok: true });
	assert.deepEqual(bun.calls, [{ command: "bun", args: ["update", "-g", CODEGRAPH_PACKAGE, "--latest"], timeoutMs: UPDATE_TIMEOUT_MS }]);

	const windows = execByFirstArg({ "npm.cmd": () => ok("") });
	assert.deepEqual(await updateCodegraphToLatest("npm-global", windows.exec, { platform: "win32" }), { ok: true });
	assert.deepEqual(windows.calls, [{ command: "npm.cmd", args: ["update", "-g", CODEGRAPH_PACKAGE], timeoutMs: UPDATE_TIMEOUT_MS }], "win32 npm goes through its .cmd shim");

	for (const platform of ["darwin", "linux"] as const) {
		const pnpm = execByFirstArg({ pnpm: () => ok("") });
		assert.deepEqual(await updateCodegraphToLatest("pnpm-global", pnpm.exec, { platform }), { ok: true });
		assert.deepEqual(pnpm.calls, [{ command: "pnpm", args: ["update", "-g", CODEGRAPH_PACKAGE, "--latest"], timeoutMs: UPDATE_TIMEOUT_MS }], `${platform}: the pnpm binary spawns directly`);
	}
	const windowsPnpm = execByFirstArg({
		"where.exe": (args) => (args[0] === "pnpm.cmd" ? ok(["C:", "pnpm", "pnpm.cmd"].join(BS) + "\r\n") : undefined),
		"pnpm.cmd": () => ok(""),
	});
	assert.deepEqual(await updateCodegraphToLatest("pnpm-global", windowsPnpm.exec, { platform: "win32" }), { ok: true });
	assert.deepEqual(windowsPnpm.calls, [
		{ command: "where.exe", args: ["pnpm.cmd"], timeoutMs: VERSION_TIMEOUT_MS },
		{ command: "pnpm.cmd", args: ["update", "-g", CODEGRAPH_PACKAGE, "--latest"], timeoutMs: UPDATE_TIMEOUT_MS },
	], "win32 resolves the .cmd shim once, then updates through it");
});

test("updateCodegraphToLatest: pnpm-global runs the user-directed update form on every platform", async () => {
	for (const platform of ["darwin", "linux"] as const) {
		const { exec, calls } = execByFirstArg({ pnpm: () => ok("") });
		const run = await updateCodegraphToLatest("pnpm-global", exec, { platform });
		assert.deepEqual(run, { ok: true });
		assert.deepEqual(calls, [{ command: "pnpm", args: ["update", "-g", CODEGRAPH_PACKAGE, "--latest"], timeoutMs: UPDATE_TIMEOUT_MS }], `${platform}: the pnpm binary spawns directly`);
	}
	const windows = execByFirstArg({ "pnpm.cmd": () => ok("") });
	assert.deepEqual(await updateCodegraphToLatest("pnpm-global", windows.exec, { platform: "win32" }), { ok: true });
	assert.deepEqual(windows.calls.map((call) => call.command), ["where.exe", "where.exe", "pnpm.cmd"], "when neither probe answers, the .cmd spelling stands and the update runs through it exactly as before");
	assert.deepEqual(windows.calls[2], { command: "pnpm.cmd", args: ["update", "-g", CODEGRAPH_PACKAGE, "--latest"], timeoutMs: UPDATE_TIMEOUT_MS });
});

test("updateCodegraphToLatest: an unknown source never spawns an update", async () => {
	const { exec, calls } = execByFirstArg({ bun: () => ok(""), npm: () => ok("") });
	const run = await updateCodegraphToLatest("unknown", exec, { platform: "darwin" });
	assert.equal(run.ok, false);
	assert.match(run.reason ?? "", /unknown/i, "the reason says why nothing ran");
	assert.deepEqual(calls, [], "zero update execs for an unprovable install source");
});

test("updateCodegraphToLatest: a failing update reports the reason and stays ok=false", async () => {
	const { exec } = execByFirstArg({ bun: () => fail("EPERM: operation not permitted") });
	const run = await updateCodegraphToLatest("bun-global", exec, { platform: "darwin" });
	assert.equal(run.ok, false);
	assert.match(run.reason ?? "", /EPERM/);
});

test("runCodegraphUpdateCheck: equal versions mean no update and zero update execs", async () => {
	clearCodegraphUpdateCaches();
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok("1.6.4\n"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		bun: () => ok(""),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home: homedir() });
	assert.deepEqual(check, { ran: false, version: "1.6.4" });
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm"], "the probes ran, no update did");
});

test("runCodegraphUpdateCheck: an unavailable running-binary version skips the whole check", async () => {
	clearCodegraphUpdateCaches();
	const { exec, calls } = execByFirstArg({ codegraph: () => fail("ENOENT") });
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home: homedir() });
	assert.equal(check.ran, false);
	assert.equal(check.version, undefined);
	assert.match(check.reason ?? "", /version/i);
	assert.deepEqual(calls.map((call) => call.command), ["codegraph"], "no registry lookup without a version to compare");
});

test("runCodegraphUpdateCheck: a registry failure fails open with the running version kept", async () => {
	clearCodegraphUpdateCaches();
	const { exec } = execByFirstArg({
		codegraph: () => ok("1.6.3\n"),
		npm: () => fail("ENOTFOUND"),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home: homedir() });
	assert.deepEqual(check, { ran: false, version: "1.6.3", reason: check.reason });
	assert.match(check.reason ?? "", /npm view|registry|latest/i);
});

test("runCodegraphUpdateCheck: a stale bun-global binary updates in bun's form and verifies", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	let binary = "codegraph 1.6.3\n";
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok(binary),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${home}/.bun/bin/codegraph\n`),
		bun: () => {
			binary = "codegraph 1.6.4\n";
			return ok("");
		},
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.deepEqual(check, { ran: true, version: "1.6.3", from: "1.6.3", to: "1.6.4" });
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "bun", "codegraph"], "the verify probe re-reads the binary after the update");
	assert.deepEqual(calls[3]?.args, ["update", "-g", CODEGRAPH_PACKAGE, "--latest"], "bun updates in its own form");
});

test("runCodegraphUpdateCheck: a prerelease running binary is not masked off the stable release", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	let binary = "codegraph 1.6.4-beta.2\n";
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok(binary),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${home}/.bun/bin/codegraph\n`),
		bun: () => {
			binary = "codegraph 1.6.4\n";
			return ok("");
		},
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.deepEqual(check, { ran: true, version: "1.6.4-beta.2", from: "1.6.4-beta.2", to: "1.6.4" }, "the stable release is reached: the suffix no longer collapses both probes onto one triple");
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "bun", "codegraph"], "update, verify: the verify probe observes the full new identifier");
});

test("runCodegraphUpdateCheck: an exit-0 no-op is rescued by the exact-version install, or reported", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	let binary = "codegraph 1.6.3\n";
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok(binary),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${home}/.bun/bin/codegraph\n`),
		bun: (args) => {
			// The update form no-ops (pnpm 12's shape); only the exact-version install changes it.
			if (args[0] === "add") binary = "codegraph 1.6.4\n";
			return ok("");
		},
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.deepEqual(check, { ran: true, version: "1.6.3", from: "1.6.3", to: "1.6.4" }, "the fallback install rescues a no-op update");
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "bun", "codegraph", "bun", "codegraph"], "update, verify, fallback install, final verify");
	assert.deepEqual(calls[5]?.args, ["add", "-g", `${CODEGRAPH_PACKAGE}@1.6.4`], "the fallback pins the exact version");
});

test("runCodegraphUpdateCheck: a no-op even the fallback cannot fix is a reported failure, never ran:true", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	const { exec } = execByFirstArg({
		codegraph: () => ok("codegraph 1.6.3\n"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${home}/.bun/bin/codegraph\n`),
		bun: () => ok(""),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.equal(check.ran, false);
	assert.match(check.reason ?? "", /still reports 1\.6\.3/, "a no-op through both forms is named, never reported as success");
});

test("runCodegraphUpdateCheck: a stale binary on an unknown source never updates", async () => {
	clearCodegraphUpdateCaches();
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok("1.6.3\n"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok("/snap/bin/codegraph\n"),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "linux", home: homedir() });
	assert.equal(check.ran, false);
	assert.equal(check.version, "1.6.3");
	assert.match(check.reason ?? "", /unknown/i);
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "npm", "pnpm"], "probes only: version, registry, shim, npm prefix, pnpm bin — the update command never ran");
});

test("runCodegraphUpdateCheck: a failed update command keeps the current version", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	const { exec } = execByFirstArg({
		codegraph: () => ok("1.6.3\n"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${home}/.bun/bin/codegraph\n`),
		bun: () => fail("EACCES: permission denied"),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.equal(check.ran, false);
	assert.equal(check.version, "1.6.3");
	assert.match(check.reason ?? "", /EACCES/);
});

test("runCodegraphUpdateCheck: an unconfirmed teardown of a timed-out update never starts the fallback install", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok("1.6.3\n"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${home}/.bun/bin/codegraph\n`),
		bun: (args) => (args[0] === "update" ? { ...fail("timed out"), teardownUnconfirmed: true } : undefined),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.equal(check.ran, false);
	assert.equal(check.version, "1.6.3");
	assert.match(check.reason ?? "", /could not be confirmed/, "the reason names the surviving process tree");
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "bun"], "no exact-version install may race a possibly-surviving installer");
});

test("runCodegraphUpdateCheck: a failed attempt that still changed the binary reports the transition", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	let binary = "codegraph 1.6.3\n";
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok(binary),
		npm: (args) => (args[0] === "view" ? ok("1.6.5\n") : undefined),
		which: () => ok(`${home}/.bun/bin/codegraph\n`),
		bun: (args) => {
			if (args[0] === "update") binary = "codegraph 1.6.4\n";
			return fail("exited 1");
		},
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.deepEqual(check, { ran: true, version: "1.6.3", from: "1.6.3", to: "1.6.4", reason: check.reason }, "a nonzero exit does not prove the executable unchanged: the transition is the report");
	assert.match(check.reason ?? "", /1\.6\.4/, "the reason names the observed transition");
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "bun", "bun", "codegraph"], "the final probe re-reads the binary after the failed fallback");
});

test("ensureCodegraphLatest: the check runs once per process until the cache is cleared", async () => {
	clearCodegraphUpdateCaches();
	let probes = 0;
	const { exec } = execByFirstArg({
		codegraph: () => {
			probes += 1;
			return ok("1.6.4\n");
		},
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
	});
	const first = await ensureCodegraphLatest(exec, { platform: "darwin", home: homedir() });
	const second = await ensureCodegraphLatest(exec, { platform: "darwin", home: homedir() });
	assert.equal(first, second, "the memoized outcome object is shared");
	assert.equal(probes, 1, "one codegraph --version probe serves the whole process");

	clearCodegraphUpdateCaches();
	await ensureCodegraphLatest(exec, { platform: "darwin", home: homedir() });
	assert.equal(probes, 2, "the cleared memo re-runs the check");
});

test("ensureCodegraphLatest: a rejecting exec never rejects the check", async () => {
	clearCodegraphUpdateCaches();
	const exec: BoundedExec = async () => {
		throw new Error("exec exploded");
	};
	const check = await ensureCodegraphLatest(exec, { platform: "darwin", home: homedir() });
	assert.equal(check.ran, false);
	assert.equal(check.version, undefined);
});

test("defaultExec: the production runner executes the real codegraph shim on win32", { timeout: 30_000 }, async (t) => {
	if (process.platform !== "win32") return t.skip("win32 real-shim harness");
	// Skip exactly when the shim is absent — the same availability probe the install-source
	// detection uses — so a Windows checkout without a global codegraph skips instead of
	// failing, while the assertions stay untouched whenever the shim is present.
	const located = await defaultExec("where.exe", ["codegraph"], VERSION_TIMEOUT_MS);
	if (!located.ok || located.stdout.trim().length === 0) return t.skip("win32 real-shim harness: no codegraph on PATH");
	const result = await defaultExec("codegraph", ["--version"], VERSION_TIMEOUT_MS);
	assert.equal(result.ok, true, `the shim path must resolve on win32: stderr=${result.stderr.slice(0, 200)}`);
	assert.match(result.stdout, /\d+\.\d+\.\d+/, "the real binary answers with a version");
});

test("ensureCodegraphInstalled: an installed shim installs nothing", async () => {
	const { exec, calls } = execByFirstArg({ which: () => ok("/Users/tester/.bun/bin/codegraph\n") });
	assert.deepEqual(await ensureCodegraphInstalled(exec, { platform: "darwin" }), { installed: true });
	assert.deepEqual(calls.map((call) => call.command), ["which"]);
});

test("ensureCodegraphInstalled: a missing codegraph installs through the first available manager", async () => {
	clearCodegraphUpdateCaches();
	const { exec, calls } = execByFirstArg({
		which: () => fail("not found"),
		npm: (args) => (args[0] === "view" ? ok("1.6.5\n") : undefined),
		bun: (args) => (args[0] === "--version" ? ok("1.x") : args[0] === "add" ? ok("installed") : undefined),
	});
	assert.deepEqual(await ensureCodegraphInstalled(exec, { platform: "darwin" }), { installed: true, via: "bun" });
	assert.deepEqual(calls, [
		{ command: "which", args: ["codegraph"], timeoutMs: VERSION_TIMEOUT_MS },
		{ command: "npm", args: ["view", CODEGRAPH_PACKAGE, "version"], timeoutMs: NPM_VIEW_TIMEOUT_MS },
		{ command: "bun", args: ["--version"], timeoutMs: VERSION_TIMEOUT_MS },
		{ command: "bun", args: ["add", "-g", `${CODEGRAPH_PACKAGE}@1.6.5`], timeoutMs: UPDATE_TIMEOUT_MS },
	], "the spec pins the exact registry version, never the dist-tag");
});

test("ensureCodegraphInstalled: bun missing falls to npm; win32 spells npm.cmd", async () => {
	clearCodegraphUpdateCaches();
	const { exec, calls } = execByFirstArg({
		"where.exe": () => fail("not found"),
		"npm.cmd": (args) => (args[0] === "view" ? ok("1.6.4\n") : args[0] === "--version" ? ok("10.x") : args[0] === "install" ? ok("installed") : undefined),
		bun: () => fail("ENOENT"),
	});
	assert.deepEqual(await ensureCodegraphInstalled(exec, { platform: "win32" }), { installed: true, via: "npm" });
	assert.deepEqual(calls.map((call) => call.command), ["where.exe", "npm.cmd", "bun", "npm.cmd", "npm.cmd"]);
});

test("ensureCodegraphInstalled: a failed install falls through; no manager means a reason", async () => {
	clearCodegraphUpdateCaches();
	const fell = execByFirstArg({
		which: () => fail("not found"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : args[0] === "--version" ? ok("10.x") : ok("installed")),
		bun: (args) => (args[0] === "--version" ? ok("1.x") : fail("EACCES")),
	});
	assert.deepEqual(await ensureCodegraphInstalled(fell.exec, { platform: "darwin" }), { installed: true, via: "npm" });
	const none = execByFirstArg({ which: () => fail("not found"), npm: () => fail("x"), bun: () => fail("x"), pnpm: () => fail("x") });
	const outcome = await ensureCodegraphInstalled(none.exec, { platform: "darwin" });
	assert.equal(outcome.installed, false);
	assert.match(outcome.reason ?? "", /no available package manager/);
});

test("ensureCodegraphInstalled: an unconfirmed teardown stops the manager fall-through", async () => {
	clearCodegraphUpdateCaches();
	const { exec, calls } = execByFirstArg({
		which: () => fail("not found"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		bun: (args) => (args[0] === "--version" ? ok("1.x") : { ...fail("timed out"), teardownUnconfirmed: true }),
	});
	const outcome = await ensureCodegraphInstalled(exec, { platform: "darwin" });
	assert.equal(outcome.installed, false);
	assert.match(outcome.reason ?? "", /could not be confirmed/, "the reason names the surviving process tree");
	assert.deepEqual(calls.map((call) => call.command), ["which", "npm", "bun", "bun"], "no second manager may start beside a possibly-surviving install");
	assert.equal(outcome.teardownUnconfirmed, true, "the outcome carries the flag callers fence later installs and updates on");
	clearCodegraphUpdateCaches();
});

test("ensureCodegraphInstalled: one in-flight fresh install is shared across concurrent callers", async () => {
	clearCodegraphUpdateCaches();
	let addCalls = 0;
	let onPath = false;
	const releases: Array<() => void> = [];
	const { exec } = execByFirstArg({
		which: () => (onPath ? ok("/Users/tester/.bun/bin/codegraph\n") : fail("not found")),
		npm: (args) => (args[0] === "view" ? ok("1.6.5\n") : undefined),
		bun: (args) => {
			if (args[0] === "--version") return ok("1.x");
			if (args[0] === "add") {
				addCalls += 1;
				return new Promise<ExecResult>((resolve) => {
					releases.push(() => resolve(ok("installed")));
				});
			}
			return undefined;
		},
	});
	const first = ensureCodegraphInstalled(exec, { platform: "darwin" });
	const second = ensureCodegraphInstalled(exec, { platform: "darwin" });
	await new Promise((resolve) => setImmediate(resolve));
	for (const release of releases) release();
	assert.deepEqual(await first, { installed: true, via: "bun" });
	assert.deepEqual(await second, { installed: true, via: "bun" }, "the second caller rides the first caller's install, it never starts its own");
	assert.equal(addCalls, 1, "one global install serves every concurrent readiness pass");
	onPath = true;
	assert.deepEqual(await ensureCodegraphInstalled(exec, { platform: "darwin" }), { installed: true }, "a settled install is not memoized: the next call re-probes PATH");
	assert.equal(addCalls, 1, "the re-probe finds the shim and installs nothing");
});

test("ensureCodegraphInstalled: a prerelease registry latest keeps its suffix in the pinned spec", async () => {
	clearCodegraphUpdateCaches();
	const { exec, calls } = execByFirstArg({
		which: () => fail("not found"),
		npm: (args) => (args[0] === "view" ? ok("1.6.5-rc.1\n") : undefined),
		bun: (args) => (args[0] === "--version" ? ok("1.x") : args[0] === "add" ? ok("installed") : undefined),
	});
	assert.deepEqual(await ensureCodegraphInstalled(exec, { platform: "darwin" }), { installed: true, via: "bun" });
	assert.deepEqual(calls[3]?.args, ["add", "-g", `${CODEGRAPH_PACKAGE}@1.6.5-rc.1`], "the spec pins the exact prerelease, suffix included");
});

test("CodegraphInstallSource surface: the three-way classification is the whole vocabulary", () => {
	// The type is a closed union; a compile-time reference pins its members for callers.
	const sources: CodegraphInstallSource[] = ["bun-global", "npm-global", "pnpm-global", "unknown"];
	assert.deepEqual(sources.sort(), ["bun-global", "npm-global", "pnpm-global", "unknown"]);
});

test("parseCodegraphVersion: a malformed suffix segment rejects the whole token, never its valid prefix", () => {
	assert.equal(parseCodegraphVersion("1.6.4-beta.!\n"), undefined, "registry output 1.6.4-beta.! never yields its truncated valid prefix");
	assert.equal(parseCodegraphVersion("1.6.4-beta.2.!!\n"), undefined, "a malformed segment after valid ones rejects the whole token");
	assert.equal(parseCodegraphVersion("codegraph 1.6.4-beta.2\n"), "1.6.4-beta.2", "decorated binary output with a valid suffix still parses whole");
});

test("defaultExec: a worker that outlives a timed-out leader is reported unconfirmed, never confirmed", { timeout: 30_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX process-group teardown harness");
	const scratch = mkdtempSync(join(tmpdir(), "codegraph-teardown-"));
	try {
		const workerPidFile = join(scratch, "worker.pid");
		// The leader exits on the timeout's SIGTERM; the worker traps and ignores it, so the
		// group survives the leader's close — exactly the shape a leader close must never be
		// trusted to confirm.
		const leaderScript = [
			"sh -c \"trap '' TERM; exec sleep 5\" > /dev/null 2>&1 < /dev/null &",
			`echo $! > "${workerPidFile}"`,
			"wait",
		].join("\n");
		const result = await defaultExec("sh", ["-c", leaderScript], 500);
		const workerPid = Number.parseInt(readFileSync(workerPidFile, "utf8").trim(), 10);
		assert.ok(Number.isInteger(workerPid) && workerPid > 0, "the leader records its worker before waiting");
		let workerAlive = false;
		try {
			process.kill(workerPid, 0);
			workerAlive = true;
		} catch {
			workerAlive = false;
		}
		assert.equal(result.ok, false, "a timed-out run is a failure");
		assert.ok(!workerAlive || result.teardownUnconfirmed === true, "a surviving worker must leave the run marked teardownUnconfirmed: callers refuse a new installer beside it");
	} finally {
		try {
			const pid = Number.parseInt(readFileSync(join(scratch, "worker.pid"), "utf8").trim(), 10);
			if (Number.isInteger(pid) && pid > 0) {
				try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
			}
		} catch { /* no pid file: nothing left to clean */ }
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("detectCodegraphInstallSource: a native win32 pnpm executable is resolved and run directly", async () => {
	const home = ["C:", "Users", "admin"].join(BS);
	const pnpmBin = ["C:", "Users", "admin", "AppData", "Local", "pnpm"].join(BS);
	const native = [pnpmBin, "pnpm.exe"].join(BS);
	const { exec, calls } = execByFirstArg({
		"where.exe": (args) => (args[0] === "codegraph"
			? ok([pnpmBin, "codegraph.cmd"].join(BS) + "\r\n")
			: args[0] === "pnpm.cmd" ? fail("no batch shim on this PATH")
			: args[0] === "pnpm" ? ok(native + "\r\n")
			: undefined),
		[native]: (args) => (args[0] === "bin" ? ok(pnpmBin + "\n") : undefined),
	});
	const detected = await detectCodegraphInstallSource(exec, { platform: "win32", home });
	assert.equal(detected.source, "pnpm-global", "a native pnpm entry still proves the pnpm root");
	const binCall = calls.find((call) => call.args[0] === "bin");
	assert.equal(binCall?.command, native, "bin -g runs the resolved native entry, not a forced .cmd spelling");
	assert.deepEqual(calls.map((call) => call.command), ["where.exe", "npm.cmd", "where.exe", "where.exe", native], "the shim, the npm prefix, then the pnpm entry resolution before bin -g");
});

test("updateCodegraphToLatest: a native win32 pnpm executable updates directly", async () => {
	const native = ["C:", "Users", "admin", "AppData", "Local", "pnpm", "pnpm.exe"].join(BS);
	const { exec, calls } = execByFirstArg({
		"where.exe": (args) => (args[0] === "pnpm.cmd" ? fail("no batch shim") : args[0] === "pnpm" ? ok(native + "\r\n") : undefined),
		[native]: () => ok(""),
	});
	const run = await updateCodegraphToLatest("pnpm-global", exec, { platform: "win32" });
	assert.deepEqual(run, { ok: true });
	assert.deepEqual(calls.map((call) => call.command), ["where.exe", "where.exe", native], "pnpm.cmd is probed first, then the native entry, then the update runs through it");
	assert.deepEqual(calls[2], { command: native, args: ["update", "-g", CODEGRAPH_PACKAGE, "--latest"], timeoutMs: UPDATE_TIMEOUT_MS });
});

test("ensureCodegraphInstalled: a native win32 pnpm executable installs through it", async () => {
	clearCodegraphUpdateCaches();
	const native = ["C:", "pnpm", "pnpm.exe"].join(BS);
	const { exec, calls } = execByFirstArg({
		"where.exe": (args) => (args[0] === "codegraph" ? fail("not found") : args[0] === "pnpm.cmd" ? fail("no batch shim") : args[0] === "pnpm" ? ok(native + "\r\n") : undefined),
		"npm.cmd": (args) => (args[0] === "view" ? ok("1.6.4\n") : fail("unavailable")),
		bun: () => fail("ENOENT"),
		[native]: (args) => (args[0] === "--version" ? ok("9.x") : args[0] === "add" ? ok("installed") : undefined),
	});
	assert.deepEqual(await ensureCodegraphInstalled(exec, { platform: "win32" }), { installed: true, via: "pnpm" });
	const addCall = calls.find((call) => call.args[0] === "add");
	assert.equal(addCall?.command, native, "the fresh install runs the native entry, never a forced .cmd");
});

test("runCodegraphUpdateCheck: an unconfirmed teardown of the fallback install defers the binary transition", async () => {
	clearCodegraphUpdateCaches();
	const home = "/Users/tester";
	let binary = "codegraph 1.6.3\n";
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok(binary),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(home + "/.bun/bin/codegraph\n"),
		bun: (args) => {
			// The manager update fails outright; the exact-version install then times out with
			// its tree unconfirmed AFTER its worker replaced the binary — the final probe must
			// never observe that transient state and trigger a rebuild beside the survivor.
			if (args[0] === "update") return fail("exited 1");
			binary = "codegraph 1.6.4\n";
			return { ...fail("timed out"), teardownUnconfirmed: true };
		},
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.equal(check.ran, false, "a possibly-surviving installer never triggers the rebuild");
	assert.equal(check.version, "1.6.3");
	assert.match(check.reason ?? "", /could not be confirmed/, "the reason names the surviving process tree");
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "bun", "bun"], "the final binary probe never runs beside a possibly-surviving installer");
});

test("ensureCodegraphInstalled: an unconfirmed teardown fences every later pass in the process", async () => {
	clearCodegraphUpdateCaches();
	let probes = 0;
	const { exec } = execByFirstArg({
		which: () => {
			probes += 1;
			return fail("not found");
		},
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		bun: (args) => (args[0] === "--version" ? ok("1.x") : { ...fail("timed out"), teardownUnconfirmed: true }),
	});
	const first = await ensureCodegraphInstalled(exec, { platform: "darwin" });
	assert.equal(first.installed, false);
	assert.equal(first.teardownUnconfirmed, true, "the outcome carries the flag callers fence installs and updates on");
	const second = await ensureCodegraphInstalled(exec, { platform: "darwin" });
	assert.equal(second, first, "the fenced outcome is shared, never retried beside a possibly-surviving installer");
	assert.equal(probes, 1, "no later pass starts a new install attempt");
	clearCodegraphUpdateCaches();
});

test("ensureCodegraphInstalled: an ordinary confirmed failure keeps the retry path open", async () => {
	clearCodegraphUpdateCaches();
	let probes = 0;
	const { exec } = execByFirstArg({
		which: () => {
			probes += 1;
			return fail("not found");
		},
		npm: () => fail("registry down"),
		bun: () => fail("ENOENT"),
		pnpm: () => fail("ENOENT"),
	});
	const first = await ensureCodegraphInstalled(exec, { platform: "darwin" });
	assert.equal(first.installed, false);
	assert.equal(first.teardownUnconfirmed, undefined, "an ordinary failure carries no fence flag");
	const second = await ensureCodegraphInstalled(exec, { platform: "darwin" });
	assert.equal(second.installed, false);
	assert.equal(probes, 2, "a confirmed failure retries on the next pass");
	clearCodegraphUpdateCaches();
});

