import assert from "node:assert/strict";
import test from "node:test";
import { clearCodegraphResolveCache, resolveCodegraphEntry, resolveCodegraphShimState, type ResolveCodegraphIo } from "../lib/codegraph-cli-resolve.ts";

/** A backslash without a backslash literal: keeps this file clear of escape-transport mangling. */
const BS = String.fromCharCode(92);

/** One npm global bin directory and the files an npm install of codegraph leaves in it. */
const BIN = ["C:", "npm-bin"].join(BS);
const NODE_EXE = [BIN, "node.exe"].join(BS);
const SCRIPT_REL = ["node_modules", "@colbymchenry", "codegraph", "dist", "cli.js"].join(BS);
const SCRIPT = [BIN, SCRIPT_REL].join(BS);

/** One npm cmd-shim's text. `tail` is the final invocation line: the modern cmd-shim ships the
 * `endLocal & goto #_undefined_#` form (npm 9+), older npm the plain line — both invoke
 * `%_prog%` with one quoted `%dp0%`-anchored script and forward `%*`. */
function npmCmdShim(scriptRel: string, tail: (rel: string) => string): string {
	return [
		"@ECHO off",
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%' + BS + 'node.exe" (',
		'  SET "_prog=%dp0%' + BS + 'node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		tail(scriptRel),
	].join("\n");
}

const modernTail = (rel: string): string =>
	'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% | "%_prog%"  "%dp0%' + BS + rel + '" %*';
const plainTail = (rel: string): string => '"%_prog%"  "%dp0%' + BS + rel + '" %*';

/** An in-memory Windows world: the platform, PATH, and a file table. A null text means the file
 * exists but cannot be read. Every resolution starts from a cleared cache (the process-lifetime
 * memo is shared state under test, not a per-test fixture). */
function fakeWorld(input: { platform?: NodeJS.Platform; path?: string; files: Array<[string, string | null]> }): {
	io: ResolveCodegraphIo;
	probes: { path: number; exists: string[] };
} {
	const table = new Map(input.files);
	const probes = { path: 0, exists: [] as string[] };
	const io: ResolveCodegraphIo = {
		platform: () => input.platform ?? "win32",
		pathEnv: () => {
			probes.path += 1;
			return input.path ?? "";
		},
		exists: (path) => {
			probes.exists.push(path);
			return table.has(path);
		},
		read: (path) => {
			const text = table.get(path);
			if (typeof text !== "string") throw new Error(`unreadable fixture: ${path}`);
			return text;
		},
	};
	return { io, probes };
}

test("resolveCodegraphEntry: a modern npm cmd-shim resolves to node.exe beside it and the entrypoint", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(io), { node: NODE_EXE, script: SCRIPT });
});

test("resolveCodegraphEntry: the older npm cmd-shim shape resolves identically", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, plainTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(io), { node: NODE_EXE, script: SCRIPT });
});

test("resolveCodegraphEntry: a shim without node.exe beside it resolves the bare node", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(io), { node: "node", script: SCRIPT });
});

test("resolveCodegraphEntry: off win32 nothing is resolved and PATH is never read", () => {
	clearCodegraphResolveCache();
	const { io, probes } = fakeWorld({ platform: "linux", path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.equal(resolveCodegraphEntry(io), null, "the resolver is a win32-only consultation");
	assert.equal(probes.path, 0, "the platform gate returns before PATH is touched");
	assert.deepEqual(probes.exists, [], "no file is probed off win32");
});

test("resolveCodegraphEntry: the first codegraph.cmd on PATH wins and later entries are never probed", () => {
	clearCodegraphResolveCache();
	const laterBin = ["C:", "other-bin"].join(BS);
	const laterScript = [laterBin, SCRIPT_REL].join(BS);
	const { io, probes } = fakeWorld({ path: [BIN, laterBin].join(";"), files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
		[[laterBin, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, plainTail)],
		[[laterBin, "node.exe"].join(BS), ""],
		[laterScript, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(io), { node: NODE_EXE, script: SCRIPT }, "PATH order decides, exactly like cmd.exe");
	const shimProbes = probes.exists.filter((probe) => probe.endsWith("codegraph.cmd"));
	assert.deepEqual(shimProbes, [[BIN, "codegraph.cmd"].join(BS)], "the scan stops at the first shim cmd.exe would run");
});

test("resolveCodegraphEntry: an unprovable first shim fails closed even when a later entry is good", () => {
	clearCodegraphResolveCache();
	const goodBin = ["C:", "good-bin"].join(BS);
	const goodScript = [goodBin, SCRIPT_REL].join(BS);
	const { io } = fakeWorld({ path: [BIN, goodBin].join(";"), files: [
		[[BIN, "codegraph.cmd"].join(BS), "not a shim at all"],
		[[goodBin, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[goodScript, "cli"],
	] });
	assert.equal(resolveCodegraphEntry(io), null, "the resolver never diverges from the shim cmd.exe itself would run");
});

test("resolveCodegraphEntry: quoted and empty PATH entries behave like cmd.exe", () => {
	clearCodegraphResolveCache();
	const quotedBin = ["C:", "Program Files", "nodejs"].join(BS);
	const quotedScript = [quotedBin, SCRIPT_REL].join(BS);
	const path = ["", '"' + quotedBin + '"', "", BIN + BS, ""].join(";");
	const { io } = fakeWorld({ path, files: [
		[[quotedBin, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[quotedScript, "cli"],
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(io), { node: "node", script: quotedScript }, "quotes are stripped, empty entries skipped, trailing separators tolerated");
});

test("resolveCodegraphEntry: no codegraph.cmd anywhere on PATH is null", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: [["C:", "a"].join(BS), ["C:", "b"].join(BS)].join(";"), files: [] });
	assert.equal(resolveCodegraphEntry(io), null);
});

test("resolveCodegraphShimState: a proven shim carries its entry", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphShimState(io), { status: "entry", entry: { node: NODE_EXE, script: SCRIPT } });
	clearCodegraphResolveCache();
});

test("resolveCodegraphShimState: an unprovable first shim is rejected, not a miss", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), "rem not an npm cmd-shim"],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphShimState(io), { status: "rejected" }, "the first shim exists; its invocation is simply unprovable");
	assert.equal(resolveCodegraphEntry(io), null, "the entry projection keeps failing closed on a rejected shim");
	clearCodegraphResolveCache();
	const unreadable = fakeWorld({ path: BIN, files: [[[BIN, "codegraph.cmd"].join(BS), null]] });
	assert.deepEqual(resolveCodegraphShimState(unreadable.io), { status: "rejected" }, "a shim that cannot be read is rejected too");
	clearCodegraphResolveCache();
});

test("resolveCodegraphShimState: no codegraph.cmd on PATH — and off win32 — is a miss", () => {
	clearCodegraphResolveCache();
	const empty = fakeWorld({ path: [["C:", "a"].join(BS), ["C:", "b"].join(BS)].join(";"), files: [] });
	assert.deepEqual(resolveCodegraphShimState(empty.io), { status: "miss" });
	clearCodegraphResolveCache();
	const posix = fakeWorld({ platform: "linux", path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphShimState(posix.io), { status: "miss" }, "off win32 there is no shim to reject");
	clearCodegraphResolveCache();
});

test("resolveCodegraphEntry: unknown shim shapes fail closed", () => {
	const cases: Array<[string, string]> = [
		["garbage text", "total noise"],
		["empty file", ""],
		["pnpm-style shim", [
			'@IF EXIST "%~dp0' + BS + 'node.exe" (',
			'  "%~dp0' + BS + 'node.exe"  "%~dp0%' + BS + SCRIPT_REL + '" %*',
			") ELSE (",
			"  node  " + '"%~dp0%' + BS + SCRIPT_REL + '"' + " %*",
			")",
		].join("\n")],
		["two dp0 spans on the invocation line", npmCmdShim(SCRIPT_REL, (rel) =>
			'"%_prog%"  "%dp0%' + BS + rel + '" "%dp0%' + BS + rel + '" %*')],
		["invocation without a dp0-anchored script", npmCmdShim(SCRIPT_REL, () =>
			'"%_prog%"  "' + ["C:", "elsewhere", "cli.js"].join(BS) + '" %*')],
		["missing dp0 mechanism", npmCmdShim(SCRIPT_REL, modernTail).replaceAll("SET dp0=%~dp0", "REM no dp0 here")],
		["missing node selection block", npmCmdShim(SCRIPT_REL, modernTail).split("\n").filter((line) => !line.includes("node.exe")).join("\n")],
		["a fixed argument after the script", npmCmdShim(SCRIPT_REL, (rel) =>
			'"%_prog%"  "%dp0%' + BS + rel + '" --profile local %*')],
		["a fixed argument before the script", npmCmdShim(SCRIPT_REL, (rel) =>
			'"%_prog%" --profile local "%dp0%' + BS + rel + '" %*')],
		["extra tokens after %*", npmCmdShim(SCRIPT_REL, (rel) =>
			'"%_prog%"  "%dp0%' + BS + rel + '" %* extra')],
	];
	for (const [name, text] of cases) {
		clearCodegraphResolveCache();
		const { io } = fakeWorld({ path: BIN, files: [
			[[BIN, "codegraph.cmd"].join(BS), text],
			[NODE_EXE, ""],
			[SCRIPT, "cli"],
		] });
		assert.equal(resolveCodegraphEntry(io), null, `${name}: an unprovable shape keeps the cmd.exe fallback`);
	}
});

test("resolveCodegraphEntry: an unreadable shim fails closed", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), null],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.equal(resolveCodegraphEntry(io), null);
});

test("resolveCodegraphEntry: the entrypoint must exist, a missing one fails closed", () => {
	clearCodegraphResolveCache();
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
	] });
	assert.equal(resolveCodegraphEntry(io), null, "a shim pointing at a vanished script is unprovable");
});

test("resolveCodegraphEntry: a relative PATH directory fails closed even with a valid shim in it", () => {
	clearCodegraphResolveCache();
	const relBin = "." + BS + "tools";
	const relScript = [relBin, SCRIPT_REL].join(BS);
	const { io } = fakeWorld({ path: relBin, files: [
		[[relBin, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[relScript, "cli"],
	] });
	assert.equal(resolveCodegraphEntry(io), null, "a cwd-dependent target is not a stable process-lifetime resolution");
});

test("resolveCodegraphEntry: a %dp0%-relative .. traversal substitutes textually, unnormalized", () => {
	clearCodegraphResolveCache();
	const traversalRel = ["..", "..", "lib", "codegraph-cli.js"].join(BS);
	const traversalScript = [BIN, traversalRel].join(BS);
	const { io } = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(traversalRel, modernTail)],
		[traversalScript, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(io), { node: "node", script: traversalScript }, "the shim's own spelling reaches node, which resolves the dots");
});

test("resolveCodegraphEntry: the resolution is memoized for the process until cleared", () => {
	clearCodegraphResolveCache();
	const first = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(first.io), { node: NODE_EXE, script: SCRIPT });

	// The world changes around the shim entirely, yet the process-lifetime memo holds while
	// the installation is unchanged: the cached script still exists, so the cache hit
	// revalidates only that existence, never PATH or the shim file.
	const otherScript = [BIN, "other.js"].join(BS);
	const second = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim("other.js", plainTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
		[otherScript, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(second.io), { node: NODE_EXE, script: SCRIPT }, "a cache hit answers without re-reading PATH or the shim");

	clearCodegraphResolveCache();
	assert.deepEqual(resolveCodegraphEntry(second.io), { node: NODE_EXE, script: otherScript }, "clearing re-reads the shim");

	// Null is memoized just the same: a resolution that failed does not retry per spawn.
	clearCodegraphResolveCache();
	const empty = fakeWorld({ path: "", files: [] });
	assert.equal(resolveCodegraphEntry(empty.io), null);
	const laterGood = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[SCRIPT, "cli"],
	] });
	assert.equal(resolveCodegraphEntry(laterGood.io), null, "a failed resolution stays cached for the process");
	clearCodegraphResolveCache();
	assert.deepEqual(resolveCodegraphEntry(laterGood.io), { node: "node", script: SCRIPT });
});

test("resolveCodegraphEntry: a cached entry whose script vanished is resolved again", () => {
	clearCodegraphResolveCache();
	const first = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim(SCRIPT_REL, modernTail)],
		[NODE_EXE, ""],
		[SCRIPT, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(first.io), { node: NODE_EXE, script: SCRIPT });

	// An update replaced the entrypoint and removed the old script: the cached entry must not
	// keep serving the vanished path (node would start, fail the module load, and the caller
	// would never fall back), so the resolution finds the updated installation instead.
	const movedScript = [BIN, "moved.js"].join(BS);
	const updated = fakeWorld({ path: BIN, files: [
		[[BIN, "codegraph.cmd"].join(BS), npmCmdShim("moved.js", plainTail)],
		[NODE_EXE, ""],
		[movedScript, "cli"],
	] });
	assert.deepEqual(resolveCodegraphEntry(updated.io), { node: NODE_EXE, script: movedScript }, "the vanished script invalidates the cached entry and resolves the updated installation");
	assert.deepEqual(resolveCodegraphEntry(updated.io), { node: NODE_EXE, script: movedScript }, "the re-resolved entry is memoized while its script exists");
});
