import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	classifyCodegraphShimPath,
	clearCodegraphUpdateCaches,
	CODEGRAPH_PACKAGE,
	codegraphVersionOutdated,
	detectCodegraphInstallSource,
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
 * answer fails the call, so a test that does not expect an exec observes it loudly. */
function scriptedExec(handler: (command: string, args: readonly string[]) => ExecResult | undefined): {
	exec: BoundedExec;
	calls: Array<{ command: string; args: string[]; timeoutMs: number }>;
} {
	const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
	const exec: BoundedExec = async (command, args, timeoutMs) => {
		calls.push({ command, args: [...args], timeoutMs });
		return handler(command, args) ?? fail("unexpected exec");
	};
	return { exec, calls };
}

/** Answers by first argument ("codegraph" -> version probe, "npm"/"npm.cmd" -> registry work). */
function execByFirstArg(map: Record<string, (args: readonly string[]) => ExecResult | undefined>): {
	exec: BoundedExec;
	calls: Array<{ command: string; args: string[]; timeoutMs: number }>;
} {
	return scriptedExec((command, args) => map[command]?.(args));
}

test("parseCodegraphVersion: the first dotted triple of the running binary's output", () => {
	assert.equal(parseCodegraphVersion("1.6.4\n"), "1.6.4");
	assert.equal(parseCodegraphVersion("codegraph 1.6.4\n"), "1.6.4");
	assert.equal(parseCodegraphVersion("codegraph/1.6.4 darwin-arm64 node v22\n"), "1.6.4");
	assert.equal(parseCodegraphVersion("codegraph 1.6.4-beta.2\n"), "1.6.4");
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
	assert.equal(await latestCodegraphVersion(exec), "1.6.5");
	assert.equal(await latestCodegraphVersion(exec), "1.6.5", "the second call is served from the process cache");
	assert.equal(viewCount, 1);
	assert.deepEqual(calls, [{ command: "npm", args: ["view", CODEGRAPH_PACKAGE, "version"], timeoutMs: NPM_VIEW_TIMEOUT_MS }]);

	clearCodegraphUpdateCaches();
	assert.equal(await latestCodegraphVersion(exec), "1.6.5");
	assert.equal(viewCount, 2, "the cleared cache makes the next call probe again");
});

test("latestCodegraphVersion: a failed lookup is undefined and never cached as failure", async () => {
	clearCodegraphUpdateCaches();
	let failing = true;
	const { exec } = execByFirstArg({
		npm: () => (failing ? fail("ENOTFOUND registry") : ok("1.6.5\n")),
	});
	assert.equal(await latestCodegraphVersion(exec), undefined, "an offline registry lookup is undefined: the check skips");
	failing = false;
	assert.equal(await latestCodegraphVersion(exec), "1.6.5", "a failure is not memoized: the next lookup can succeed");

	clearCodegraphUpdateCaches();
	const unparseable = execByFirstArg({ npm: () => ok("latest: soon") });
	assert.equal(await latestCodegraphVersion(unparseable.exec), undefined, "registry output without a triple is not a version");
});

test("codegraphVersionOutdated: numeric triple compare; garbage or missing never updates", () => {
	assert.equal(codegraphVersionOutdated("1.6.3", "1.6.4"), true, "a patch behind is stale");
	assert.equal(codegraphVersionOutdated("1.5.9", "1.6.0"), true, "a minor behind is stale");
	assert.equal(codegraphVersionOutdated("0.9.9", "1.0.0"), true, "a major behind is stale");
	assert.equal(codegraphVersionOutdated("1.6.4", "1.6.4"), false, "the same version is not stale");
	assert.equal(codegraphVersionOutdated("1.7.0", "1.6.10"), false, "numeric fields compare, not strings: 10 > 0");
	assert.equal(codegraphVersionOutdated("2.0.0", "1.9.9"), false, "ahead is not stale");
	assert.equal(codegraphVersionOutdated("1.6.4", "1.6.5-beta.1"), true, "a prerelease ahead is still a newer triple");
	assert.equal(codegraphVersionOutdated("1.7", "1.6.4"), false, "an unparseable installed version never updates");
	assert.equal(codegraphVersionOutdated("garbage", "1.6.4"), false);
	assert.equal(codegraphVersionOutdated("1.6.4", "garbage"), false, "an unparseable latest never updates");
	assert.equal(codegraphVersionOutdated(undefined, "1.6.4"), false);
	assert.equal(codegraphVersionOutdated("1.6.4", undefined), false);
});

test("classifyCodegraphShimPath: bun-global by the homedir .bun prefix, checked first", () => {
	const home = homedir();
	assert.equal(classifyCodegraphShimPath(join(home, ".bun", "bin", "codegraph"), undefined, home, "darwin"), "bun-global");
	assert.equal(classifyCodegraphShimPath(join(home, ".bun", "bin", "codegraph"), join(home, ".npm-global"), home, "linux"), "bun-global", "the bun root classifies before npm is even asked");
});

test("classifyCodegraphShimPath: npm-global under the npm prefix -g directory", () => {
	const home = homedir();
	assert.equal(classifyCodegraphShimPath("/usr/local/bin/codegraph", "/usr/local", home, "darwin"), "npm-global");
	assert.equal(classifyCodegraphShimPath("/opt/homebrew/bin/codegraph", "/opt/homebrew", home, "linux"), "npm-global");
	assert.equal(classifyCodegraphShimPath("/usr/local/bin/codegraph", undefined, home, "darwin"), "unknown", "no prefix answer: nothing proves npm owns it");
	assert.equal(classifyCodegraphShimPath("/usr/bin/codegraph", "/usr/local", home, "darwin"), "unknown", "outside both roots is never auto-updated");
	assert.equal(classifyCodegraphShimPath(undefined, "/usr/local", home, "darwin"), "unknown");
});

test("classifyCodegraphShimPath: win32 backslash paths compare case-insensitively across separators", () => {
	const home = ["C:", "Users", "admin"].join(BS);
	assert.equal(classifyCodegraphShimPath(["C:", "Users", "admin", ".bun", "bin", "codegraph.exe"].join(BS), undefined, home, "win32"), "bun-global");
	assert.equal(classifyCodegraphShimPath(["c:", "users", "ADMIN", ".bun", "bin", "codegraph.exe"].join(BS), undefined, home, "win32"), "bun-global", "win32 paths fold case");
	assert.equal(
		classifyCodegraphShimPath(["C:", "Users", "admin", "AppData", "Roaming", "npm", "codegraph.cmd"].join(BS), ["C:", "Users", "admin", "AppData", "Roaming", "npm"].join(BS), home, "win32"),
		"npm-global",
		"a backslash shim under a backslash prefix is npm-global",
	);
	assert.equal(
		classifyCodegraphShimPath(["C:", "Users", "admin", "AppData", "Roaming", "npm", "codegraph.cmd"].join(BS), ["C:/Users/admin/AppData/Roaming/npm"].join("/"), home, "win32"),
		"npm-global",
		"forward-slash and backslash spellings of one root still match",
	);
	const prefixWithSlash = ["C:", "Users", "admin", "AppData", "Roaming", "npm", ""].join(BS);
	assert.equal(
		classifyCodegraphShimPath(["C:", "Users", "admin", "AppData", "Roaming", "npm", "codegraph.cmd"].join(BS), prefixWithSlash, home, "win32"),
		"npm-global",
		"a trailing separator on the reported prefix does not double or mismatch",
	);
	assert.equal(
		classifyCodegraphShimPath(["C:", "Tools", "codegraph", "codegraph.exe"].join(BS), ["C:", "Users", "admin", "AppData", "Roaming", "npm"].join(BS), home, "win32"),
		"unknown",
	);
	assert.equal(classifyCodegraphShimPath(["C:", "NotBun", "codegraph.exe"].join(BS), undefined, home, "win32"), "unknown", "a prefix like .bun is a directory boundary, not a string prefix");
});

test("detectCodegraphInstallSource: which answers on POSIX and bun skips the npm prefix query", async () => {
	const home = homedir();
	const shim = join(home, ".bun", "bin", "codegraph");
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

test("detectCodegraphInstallSource: an npm-prefix query failure leaves the source unknown", async () => {
	const { exec, calls } = execByFirstArg({
		which: () => ok("/usr/local/bin/codegraph\n"),
		npm: () => fail("ENOTFOUND"),
	});
	const detected = await detectCodegraphInstallSource(exec, { platform: "darwin", home: homedir() });
	assert.equal(detected.source, "unknown");
	assert.match(detected.reason ?? "", /npm prefix/, "the reason names the unprovable root");
	assert.deepEqual(calls.map((call) => call.command), ["which", "npm"]);
});

test("detectCodegraphInstallSource: a shim not on PATH is unknown with no further probes", async () => {
	const { exec, calls } = execByFirstArg({ which: () => fail("not found") });
	const detected = await detectCodegraphInstallSource(exec, { platform: "darwin", home: homedir() });
	assert.equal(detected.source, "unknown");
	assert.match(detected.reason ?? "", /PATH/);
	assert.deepEqual(calls.map((call) => call.command), ["which"], "no npm work happens without a shim");
});

test("updateCodegraphToLatest: bun-global runs bun add -g on every platform", async () => {
	for (const platform of ["darwin", "linux", "win32"] as const) {
		const { exec, calls } = execByFirstArg({ bun: () => ok("installed @colbymchenry/codegraph@1.6.5") });
		const run = await updateCodegraphToLatest("bun-global", exec, { platform });
		assert.deepEqual(run, { ok: true });
		assert.deepEqual(calls, [{ command: "bun", args: ["add", "-g", `${CODEGRAPH_PACKAGE}@latest`], timeoutMs: UPDATE_TIMEOUT_MS }], `${platform}: bun spawns directly, no .cmd shim`);
	}
});

test("updateCodegraphToLatest: npm-global picks the platform's npm spelling", async () => {
	const posix = execByFirstArg({ npm: () => ok("") });
	assert.deepEqual(await updateCodegraphToLatest("npm-global", posix.exec, { platform: "darwin" }), { ok: true });
	assert.deepEqual(posix.calls, [{ command: "npm", args: ["install", "-g", `${CODEGRAPH_PACKAGE}@latest`], timeoutMs: UPDATE_TIMEOUT_MS }]);

	const windows = execByFirstArg({ "npm.cmd": () => ok("") });
	assert.deepEqual(await updateCodegraphToLatest("npm-global", windows.exec, { platform: "win32" }), { ok: true });
	assert.deepEqual(windows.calls, [{ command: "npm.cmd", args: ["install", "-g", `${CODEGRAPH_PACKAGE}@latest`], timeoutMs: UPDATE_TIMEOUT_MS }], "win32 npm goes through its .cmd shim");
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

test("runCodegraphUpdateCheck: a stale bun-global binary updates and reports from/to", async () => {
	clearCodegraphUpdateCaches();
	const home = homedir();
	const { exec, calls } = execByFirstArg({
		codegraph: () => ok("codegraph 1.6.3\n"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${join(home, ".bun", "bin", "codegraph")}\n`),
		bun: () => ok(""),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.deepEqual(check, { ran: true, version: "1.6.3", from: "1.6.3", to: "1.6.4" });
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "bun"]);
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
	assert.deepEqual(calls.map((call) => call.command), ["codegraph", "npm", "which", "npm"], "probes only: version, registry, shim, npm prefix — the update command never ran");
});

test("runCodegraphUpdateCheck: a failed update command keeps the current version", async () => {
	clearCodegraphUpdateCaches();
	const home = homedir();
	const { exec } = execByFirstArg({
		codegraph: () => ok("1.6.3\n"),
		npm: (args) => (args[0] === "view" ? ok("1.6.4\n") : undefined),
		which: () => ok(`${join(home, ".bun", "bin", "codegraph")}\n`),
		bun: () => fail("EACCES: permission denied"),
	});
	const check = await runCodegraphUpdateCheck(exec, { platform: "darwin", home });
	assert.equal(check.ran, false);
	assert.equal(check.version, "1.6.3");
	assert.match(check.reason ?? "", /EACCES/);
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

test("CodegraphInstallSource surface: the three-way classification is the whole vocabulary", () => {
	// The type is a closed union; a compile-time reference pins its members for callers.
	const sources: CodegraphInstallSource[] = ["bun-global", "npm-global", "unknown"];
	assert.deepEqual(sources.sort(), ["bun-global", "npm-global", "unknown"]);
});
