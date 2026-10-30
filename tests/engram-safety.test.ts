import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import * as shell from "../lib/gentle-shell-bundled.ts";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const GUARD = join(repository, "bin", "engram-guard");
const ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const READY = { revision: 1, source: "active", status: "ready", offline_automatic_opening_authorized: false, active_reuse_authorized: true,
	instance_id: ID, runtime_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capability: "startup-verified-store-v1" };
const REFUSED: shell.EngramProbe = { kind: "refused" };
const CORE = "3.5.2";
const listening = (compatible: boolean, healthInstanceId?: string, healthVersion = CORE): shell.EngramProbe =>
	({ kind: "listening", compatible, healthInstanceId, healthVersion: healthInstanceId === undefined ? undefined : healthVersion });

// Isolated: no inherited policy, notice or explicit Engram selection.
const clean = (extra: Record<string, string> = {}) => {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of ["GENTLE_PI_AGENTS_CHILD", "ENGRAM_STARTUP_POLICY", "ENGRAM_STARTUP_NOTICE", "ENGRAM_BIN", "ENGRAM_URL", "ENGRAM_PORT",
		"ENGRAM_DATA_DIR", "ENGRAM_DATABASE_URL", "ENGRAM_HTTP_TOKEN"]) if (!(key in extra)) delete env[key];
	return env;
};
const classify = (input: Partial<Parameters<typeof shell.classifyEngramStartup>[0]> = {}) =>
	shell.classifyEngramStartup({ env: {}, endpoint: REFUSED, core: true, coreVersion: CORE, ...input });

test("shared Engram environment drops only session scratch temp paths", () => {
	for (const platform of ["win32", "linux"]) {
		for (const prefix of ["gp", "ga"]) {
			const scratch = platform === "win32" ? `C:\\Temp\\${prefix}Ab12Z9\\` : `/tmp/${prefix}Ab12Z9/`;
			const base = { TEMP: scratch, TMP: scratch, TMPDIR: scratch, PATH: "keep", OTHER: scratch };
			assert.deepEqual(shell.sharedEngramEnv(base, platform), { ...(platform === "win32" ? { TEMP: "C:\\Temp", TMP: "C:\\Temp", TMPDIR: "C:\\Temp" } : {}), PATH: "keep", OTHER: scratch, ENGRAM_NO_UPDATE_CHECK: "1" });
			assert.equal(base.TEMP, scratch, "does not mutate parent");
		}
		for (const chosen of ["/tmp/custom", "/tmp/gp12345", "/tmp/ga1234567", "/tmp/gp123456/child", "/tmp/gp12-456"]) {
			assert.equal(shell.sharedEngramEnv({ TEMP: chosen }, platform).TEMP, chosen);
		}
	}
	assert.deepEqual(shell.sharedEngramEnv({ Temp: "C:\\Temp\\gp123456\\gaAb12Z9\\", tMp: "D:/custom", tmpdir: "C:/chosen" }, "win32"),
		{ Temp: "C:\\Temp", tMp: "D:/custom", tmpdir: "C:/chosen", ENGRAM_NO_UPDATE_CHECK: "1" });
	for (const key of ["TMP", "TMPDIR"]) {
		assert.deepEqual(shell.sharedEngramEnv({ [key]: "C:\\Temp\\gp123456" }, "win32"),
			{ [key]: "C:\\Temp", TEMP: "C:\\Temp", ENGRAM_NO_UPDATE_CHECK: "1" });
		assert.equal(shell.sharedEngramEnv({ [key]: "C:\\Temp\\gp123456", Temp: "D:\\chosen" }, "win32").Temp, "D:\\chosen");
	}
	for (const invalid of ["gp123456", "relative\\ga123456", "C:gp123456", "\\gp123456"]) {
		assert.throws(() => shell.sharedEngramEnv({ TEMP: invalid }, "win32"), /absolute.*scratch/i);
	}
	assert.equal(shell.sharedEngramEnv({ tmp: "/tmp/gp123456" }, "linux").tmp, "/tmp/gp123456");
});

test("shared Engram environment detects Windows scratch after a trailing dot", () => {
	assert.equal(shell.sharedEngramEnv({ TEMP: "C:\\Temp\\gp123456\\." }, "win32").TEMP, "C:\\Temp");
});

test("shared Engram environment detects POSIX scratch after child/..", () => {
	assert.deepEqual(shell.sharedEngramEnv({ TMPDIR: "/tmp/gp123456/child/.." }, "linux"), { ENGRAM_NO_UPDATE_CHECK: "1" });
});

test("shared Engram environment refuses original Windows .. even when normalization hides it", () => {
	assert.throws(() => shell.sharedEngramEnv({ TEMP: "C:\\Temp\\gp123456\\child\\.." }, "win32"), /absolute.*scratch/i);
});

test("shared Engram environment refuses scratch-shaped UNC share roots without looping", () => {
	const script = `import assert from 'node:assert/strict';
		import { sharedEngramEnv } from './lib/gentle-shell-bundled.ts';
		assert.throws(() => sharedEngramEnv({ TEMP: ${JSON.stringify("\\\\server\\gp123456\\")} }, 'win32'), /absolute.*scratch/i);`;
	const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script], { cwd: repository, encoding: "utf8", timeout: 3000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
	assert.equal(shell.sharedEngramEnv({ TEMP: "\\\\server\\share\\gp123456\\gaAb12Z9\\" }, "win32").TEMP, "\\\\server\\share\\");
	assert.equal(shell.sharedEngramEnv({ TEMP: "C:\\gp123456\\" }, "win32").TEMP, "C:\\");
});

test("shared Engram environment reaches an actual Windows Node child with explicit stable TEMP", { skip: process.platform !== "win32" }, () => {
	const stable = "C:\\chosen-temp";
	const scratch = `${stable}\\gp123456\\gaAb12Z9`;
	const probe = `const os = require('node:os'); process.stdout.write(JSON.stringify({TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, tmpdir: os.tmpdir()}));`;
	// Set known ambient scratch only inside an isolated parent process. No files
	// are created: neither chosen path needs to exist for this zero-write probe.
	const script = `import { sharedEngramEnv } from './lib/gentle-shell-bundled.ts';
		import { spawnSync } from 'node:child_process';
		process.env.TEMP = ${JSON.stringify(scratch)};
		const env = sharedEngramEnv({ TMPDIR: ${JSON.stringify(scratch)} });
		const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(probe)}], {env, encoding: 'utf8'});
		process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exit(child.status ?? 99);`;
	const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script], { cwd: repository, encoding: "utf8", timeout: 10000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout, JSON.stringify({ TEMP: stable, TMPDIR: stable, tmpdir: stable }));
});

test("shared Engram environment retains sanitization and detached spawn wiring", () => {
	assert.deepEqual(shell.sharedEngramEnv({ ENGRAM_BIN: "chosen", ENGRAM_OTHER: "value", ENGRAM_NO_UPDATE_CHECK: "0", GH_TOKEN: "token", GITHUB_TOKEN: "token", HOME: "home", TEMP: "chosen" }),
		{ HOME: "home", TEMP: "chosen", ENGRAM_NO_UPDATE_CHECK: "1" });
	const launcher = readFileSync(join(repository, "bin", "gentle-shell.mjs"), "utf8");
	assert.match(launcher, /const env = sharedEngramEnv\(process\.env\);/);
	assert.match(launcher, /spawn\(core, \["serve"\], \{ cwd: homedir\(\), env, detached: true, stdio: "ignore", windowsHide: true \}\)/);
});

test("nothing listening with a verified bundled core starts the shared server and reuses it through the default URL", () => {
	assert.deepEqual(classify(), { policy: "allow", url: "http://127.0.0.1:7437", spawn: true });
});

test("nothing listening without the verified bundled core is disabled, never a PATH fallback", () => {
	const result = classify({ core: false });
	assert.equal(result.policy, "disabled");
	assert.equal(result.spawn, undefined);
	assert.match(result.notice!, /bundled Engram core/);
});

test("an existing store no longer disables memory by itself; only a newer schema header keeps the server stopped", () => {
	for (const userVersion of [undefined, 0, 1]) {
		assert.deepEqual(classify({ userVersion }), { policy: "allow", url: "http://127.0.0.1:7437", spawn: true }, String(userVersion));
	}
	const newer = classify({ userVersion: 2 });
	assert.deepEqual([newer.policy, newer.spawn, newer.url], ["disabled", undefined, undefined]);
	assert.equal(newer.notice, shell.ENGRAM_NEWER_SCHEMA_NOTICE);
	assert.match(newer.notice!, /newer Engram.*Back up/s);
	// A pin without a verified schema cannot rule out a newer store: never started.
	assert.equal(classify({ coreVersion: "9.9.9", userVersion: 1 }).policy, "disabled");
	assert.equal(classify({ coreVersion: "9.9.9" }).spawn, true);
});

test("a listener that does not verify keeps memory disabled and is never replaced", () => {
	for (const endpoint of [listening(false), listening(false, ID), { kind: "unknown" } as shell.EngramProbe]) {
		const result = classify({ endpoint });
		assert.deepEqual([result.policy, result.spawn, result.url], ["disabled", undefined, undefined], JSON.stringify(endpoint));
		assert.match(result.notice!, /could not verify.*compatibility.*Back up/is);
	}
	// Not even the bundled core version on /health stands in for /compatibility.
	assert.equal(classify({ endpoint: listening(false, ID, CORE) }).policy, "disabled");
});

test("a running server older than the first compatibility-capable core is named in the notice, without changing the decision", () => {
	for (const version of ["3.3.2", "v3.3.2", "2.9.0"]) {
		const result = classify({ endpoint: listening(false, OTHER_ID, version) });
		assert.equal(result.policy, "disabled", version);
		assert.equal(result.url, undefined, version);
		assert.match(result.notice!, new RegExp(`reports version ${version.replace(/^v/, "").replaceAll(".", "\\.")}`), version);
		assert.match(result.notice!, /update that server to 3\.4\.0 or later.*restart it/s, version);
		assert.match(result.notice!, /Back up/, version);
	}
});

test("a current, unparsable or hostile server version keeps the generic notice and is never echoed", () => {
	for (const version of ["3.4.0", "3.10.0", "4.0.0", "dev", "", "3.3.2\u001b[31m", "3.3.2 update now", "03.3.2", "3.03.2", "3.3.02", "v03.3.2"]) {
		const result = classify({ endpoint: listening(false, OTHER_ID, version) });
		assert.equal(result.policy, "disabled", JSON.stringify(version));
		assert.equal(result.notice, shell.ENGRAM_RECOVERY_NOTICE, JSON.stringify(version));
	}
	assert.equal(classify({ endpoint: listening(false) }).notice, shell.ENGRAM_RECOVERY_NOTICE);
});

test("explicit selections and invalid policies are disabled without depending on probes", () => {
	for (const key of ["ENGRAM_BIN", "ENGRAM_URL", "ENGRAM_DATA_DIR", "ENGRAM_PORT", "ENGRAM_SOCKET", "ENGRAM_DATABASE_URL", "ENGRAM_SERVER_MODE"]) {
		for (const endpoint of [listening(true), REFUSED]) {
			const result = classify({ env: { [key]: "chosen" }, endpoint });
			assert.deepEqual([result.policy, result.spawn], ["disabled", undefined], key);
		}
	}
	assert.equal(classify({ env: { ENGRAM_STARTUP_POLICY: "allow" } }).spawn, true);
	for (const value of ["", "disabled", "ALLOW", " allow ", "invalid"]) {
		for (const endpoint of [listening(true), REFUSED]) {
			const result = classify({ env: { ENGRAM_STARTUP_POLICY: value }, endpoint });
			assert.deepEqual([result.policy, result.spawn], ["disabled", undefined], value);
		}
	}
	assert.equal(shell.engramProbeAllowed({ ENGRAM_URL: "https://chosen.invalid" }), false);
	assert.equal(shell.engramProbeAllowed({ ENGRAM_STARTUP_POLICY: "" }), false);
	assert.equal(shell.engramProbeAllowed({ ENGRAM_BIN: "  " }), true);
});

test("a verified /compatibility contract reuses the running server through an explicit URL", () => {
	// Reused unchanged, whatever the store header or the bundled core.
	for (const input of [{}, { userVersion: 2 }, { core: false }]) {
		assert.deepEqual(classify({ ...input, endpoint: listening(true) }), { policy: "allow", url: "http://127.0.0.1:7437" }, JSON.stringify(input));
	}
});

test("the compatibility contract must match exactly", () => {
	assert.equal(shell.isReadyCompatibility(JSON.stringify(READY)), true);
	assert.equal(shell.isReadyCompatibility(JSON.stringify({ ...READY, offline_automatic_opening_authorized: undefined })), true);
	for (const change of [{ status: "unknown" }, { active_reuse_authorized: false }, { capability: "other" }, { revision: 2 }, { source: "offline" },
		{ instance_id: "short" }, { runtime_id: undefined }, { offline_automatic_opening_authorized: true }, { status: undefined }]) {
		assert.equal(shell.isReadyCompatibility(JSON.stringify({ ...READY, ...change })), false, JSON.stringify(change));
	}
	for (const text of ["", "{", "null", "[]", '"ready"']) assert.equal(shell.isReadyCompatibility(text), false, text);
});

test("provenance records parse strictly", () => {
	const valid = { schema: 1, dataDir: "/home/ana/.engram", instanceId: ID, coreSha256: "a".repeat(64) };
	assert.deepEqual(shell.parseEngramProvenance(JSON.stringify(valid)), valid);
	for (const change of [{ schema: 2 }, { dataDir: "relative" }, { instanceId: "XYZ" }, { coreSha256: "short" }, { coreSha256: undefined }, { instanceId: undefined }]) {
		assert.equal(shell.parseEngramProvenance(JSON.stringify({ ...valid, ...change })), undefined, JSON.stringify(change));
	}
	assert.equal(shell.parseEngramProvenance("{"), undefined);
	assert.equal(shell.parseEngramProvenance(undefined), undefined);
	assert.equal(shell.engramProvenancePath("/home/ana/.gentle-shell", "linux"), "/home/ana/.gentle-shell/config/engram-provenance.json");
});

test("only flag-position version or help tokens count as a Pi version or help request", () => {
	for (const argv of [["--version"], ["-v"], ["--help"], ["-h"], ["explain this", "-v"], ["-p", "-v"], ["--mode", "-h"], ["--offline", "--help"]]) {
		assert.equal(shell.piVersionOrHelpRequested(argv), true, argv.join(" "));
	}
	for (const argv of [[], ["explain the -v flag"], ["--", "-v"], ["--model", "-v"], ["--name", "--help"], ["-e", "-h"], ["--append-system-prompt", "--version"],
		["--provider", "-v", "--", "--help"]]) {
		assert.equal(shell.piVersionOrHelpRequested(argv), false, argv.join(" "));
	}
});

function sqliteHeader({ magic = "SQLite format 3\0", pageSize = 4096, write = 2, read = 2, userVersion = 1 } = {}): Buffer {
	const header = Buffer.alloc(100);
	header.write(magic, 0, "latin1");
	header.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
	header[18] = write;
	header[19] = read;
	header.writeUInt32BE(userVersion, 60);
	return header;
}

test("the SQLite header user_version is read from raw bytes and malformed headers are rejected", () => {
	assert.equal(shell.sqliteHeaderUserVersion(sqliteHeader(), 8192), 1);
	assert.equal(shell.sqliteHeaderUserVersion(sqliteHeader({ write: 1, read: 1, userVersion: 7 }), 4096), 7);
	assert.equal(shell.sqliteHeaderUserVersion(sqliteHeader({ pageSize: 65536 }), 65536), 1);
	// Bytes 18 and 19 are each checked against {1, 2} (rollback or WAL).
	assert.equal(shell.sqliteHeaderUserVersion(sqliteHeader({ write: 1, read: 2 }), 4096), 1);
	for (const [header, size] of [[sqliteHeader({ magic: "SQLite format 2\0" }), 4096], [sqliteHeader({ pageSize: 1000 }), 4000],
		[sqliteHeader({ write: 3, read: 3 }), 4096], [sqliteHeader({ write: 2, read: 0 }), 4096], [sqliteHeader(), 4095], [sqliteHeader(), 0],
		[sqliteHeader().subarray(0, 99), 4096]] as Array<[Buffer, number]>) {
		assert.equal(shell.sqliteHeaderUserVersion(header, size), undefined);
	}
});

test("the header is a newer-schema tripwire against the verified bundled schema, never a compatibility proof", () => {
	// v3.3.2:internal/store/store.go declares schemaVersion = 1.
	assert.equal(shell.bundledEngramSchema("3.3.2"), 1);
	assert.equal(shell.bundledEngramSchema("3.4.0"), 1);
	assert.equal(shell.bundledEngramSchema("3.5.2"), 1);
	assert.equal(shell.bundledEngramSchema("3.3.3"), undefined);
	for (const userVersion of [0, 1]) assert.equal(shell.engramHeaderAllows(userVersion, 1), true, String(userVersion));
	assert.equal(shell.engramHeaderAllows(2, 1), false);
	assert.equal(shell.engramHeaderAllows(undefined, 1), false);
	assert.equal(shell.engramHeaderAllows(0, undefined), false);
});

function listen(t: TestContext, handler: (path: string, response: import("node:http").ServerResponse) => void): Promise<number> {
	const server: Server = createServer((request, response) => handler(request.url ?? "", response));
	t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}
const json = (response: import("node:http").ServerResponse, status: number, body: unknown) => {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(typeof body === "string" ? body : JSON.stringify(body));
};

test("probe reads only /compatibility and /health from a local fixture, without credentials", async (t) => {
	const seen: string[] = [];
	let authorization: string | undefined = "unset";
	const ready = await listen(t, (path, response) => { seen.push(path); json(response, 200, READY); });
	const server = createServer((request, response) => { authorization = request.headers.authorization; json(response, 200, READY); });
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
	assert.deepEqual(await shell.probeEngramEndpoint({ port: ready }), { kind: "listening", compatible: true });
	assert.deepEqual(seen, ["/compatibility"]);
	process.env.ENGRAM_HTTP_TOKEN = "never-sent";
	try {
		await shell.probeEngramEndpoint({ port });
	} finally {
		delete process.env.ENGRAM_HTTP_TOKEN;
	}
	assert.equal(authorization, undefined);
});

test("probe treats 404, 401, malformed and oversized answers as not compatible and reads the /health instance", async (t) => {
	const cases: Array<[number, string, number, unknown, string | undefined]> = [
		[404, "not found", 200, { status: "ok", instance_id: ID, version: CORE }, ID],
		[401, "authorization required", 200, { instance_id: ID, version: CORE }, ID],
		[200, "{", 200, "{", undefined],
		[200, JSON.stringify({ ...READY, pad: "x".repeat(20000) }), 500, { error: "health check failed" }, undefined],
		[404, "", 200, { instance_id: "NOT-HEX", version: CORE }, undefined],
		[404, "", 200, { instance_id: ID }, undefined],
	];
	for (const [status, body, healthStatus, health, expected] of cases) {
		const port = await listen(t, (path, response) => path === "/compatibility" ? json(response, status, body) : json(response, healthStatus, health));
		assert.deepEqual(await shell.probeEngramEndpoint({ port }),
			{ kind: "listening", compatible: false, healthInstanceId: expected, healthVersion: expected === undefined ? undefined : CORE }, `${status} ${body.slice(0, 20)}`);
	}
});

test("probe reports refused for a closed port and unknown for a silent listener", async (t) => {
	const closed = await new Promise<number>((resolve) => {
		const server = createTcpServer();
		server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
	});
	assert.deepEqual(await shell.probeEngramEndpoint({ port: closed }), { kind: "refused" });
	const accepted: import("node:net").Socket[] = [];
	const silent = createTcpServer((socket) => { accepted.push(socket); });
	t.after(() => new Promise<void>((resolve) => { for (const socket of accepted) socket.destroy(); silent.close(() => resolve()); }));
	const port = await new Promise<number>((resolve) => silent.listen(0, "127.0.0.1", () => resolve((silent.address() as { port: number }).port)));
	const started = Date.now();
	assert.deepEqual(await shell.probeEngramEndpoint({ port, timeoutMs: 200 }), { kind: "unknown" });
	assert.ok(Date.now() - started < 2000);
});

const base = { node: "/node", cli: "/pi", prefix: "/prefix", engram: "/prefix/runtime/engram-3.5.2/engram", guard: GUARD };

test("disabled memory without explicit selections points ENGRAM_BIN at the guard and keeps the policy", () => {
	const memory = classify({ endpoint: listening(false) });
	const env = shell.bundledChildEnv({ ENGRAM_STARTUP_NOTICE: "display only" }, { ...base, memory });
	assert.equal(env.ENGRAM_BIN, GUARD);
	assert.equal(env.ENGRAM_URL, undefined);
	assert.equal(env.ENGRAM_STARTUP_POLICY, "disabled");
	assert.match(env.ENGRAM_STARTUP_NOTICE!, /Back up.*display only/s);
	assert.equal(shell.bundledChildEnv({ ENGRAM_BIN: "" }, { ...base, memory }).ENGRAM_BIN, GUARD);
});

test("explicit ENGRAM_BIN or ENGRAM_URL are never replaced or removed", () => {
	const memory = classify({ endpoint: listening(false) });
	for (const selected of [{ ENGRAM_BIN: "/explicit" }, { ENGRAM_URL: "https://chosen.invalid" }, { ENGRAM_BIN: "/explicit", ENGRAM_URL: "https://chosen.invalid" }]) {
		const before = { ...selected };
		const env = shell.bundledChildEnv(selected, { ...base, memory });
		// An explicit URL alone still gets the verified core, never a PATH engram.
		assert.equal(env.ENGRAM_BIN, before.ENGRAM_BIN ?? base.engram);
		assert.equal(env.ENGRAM_URL, before.ENGRAM_URL);
		assert.equal(env.ENGRAM_STARTUP_POLICY, "disabled");
		assert.deepEqual(selected, before);
	}
	assert.equal(shell.bundledChildEnv({ ENGRAM_URL: "https://chosen.invalid" }, { ...base, engram: undefined, memory }).ENGRAM_BIN, GUARD);
});

test("allowed memory always reaches the shared server through the reuse URL and the guard, never a session-owned server", () => {
	for (const memory of [classify(), classify({ endpoint: listening(true) })]) {
		const env = shell.bundledChildEnv({}, { ...base, memory });
		assert.deepEqual([env.ENGRAM_URL, env.ENGRAM_BIN, env.ENGRAM_STARTUP_POLICY, env.ENGRAM_SERVER_MODE], ["http://127.0.0.1:7437", GUARD, "allow", undefined]);
		// The user's own server mode, if any, is passed through untouched.
		assert.equal(shell.bundledChildEnv({ ENGRAM_SERVER_MODE: "shared" }, { ...base, memory }).ENGRAM_SERVER_MODE, "shared");
	}
	assert.equal("ENGRAM_PRIVATE_REQUIRED_NOTICE" in shell, false);
	assert.equal("supportsEngramSessionOwned" in shell, false);
	const missing = shell.bundledChildEnv({}, { ...base, engram: undefined, memory: classify({ core: false }) });
	assert.equal(missing.ENGRAM_BIN, GUARD);
	assert.throws(() => shell.bundledChildEnv({}, { ...base, guard: undefined, memory: classify() }), /guard/);
});

function dataSnapshot(dir: string): string {
	return JSON.stringify(readdirSync(dir, { recursive: true }).map(String).sort().map((name) => {
		const path = join(dir, name);
		return [name, statSync(path).isFile() ? readFileSync(path, "base64") : "dir", statSync(path).mode];
	}));
}

test("the guard fails non-zero, reports the notice and leaves Engram data byte-identical", { skip: process.platform === "win32" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "engram-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const data = join(root, ".engram");
	mkdirSync(data);
	writeFileSync(join(data, "engram.db"), "sqlite fixture bytes");
	writeFileSync(join(data, ".instance-id"), `${ID}\n`);
	const before = dataSnapshot(data);
	for (const args of [["instance-id"], ["serve"], ["version"], ["mcp"], []]) {
		const result = spawnSync(GUARD, args, { env: clean({ HOME: root, ENGRAM_STARTUP_NOTICE: "Back up first. $(touch injected)" }), encoding: "utf8" });
		assert.equal(result.error, undefined);
		assert.notEqual(result.status, 0);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Back up first\. \$\(touch injected\)/);
	}
	const fallback = spawnSync(GUARD, ["instance-id"], { env: clean({ HOME: root }), encoding: "utf8" });
	assert.equal(fallback.status, 78);
	assert.equal(fallback.stdout, "");
	assert.match(fallback.stderr, /could not verify.*compatibility/i);
	assert.doesNotMatch(fallback.stderr, /update Engram, restart/i);
	assert.equal(dataSnapshot(data), before);
	assert.deepEqual(readdirSync(root).sort(), [".engram"]);
});

test("a provider-style instance-id spawn against the environment Shell builds fails closed", { skip: process.platform === "win32" }, () => {
	const env = shell.bundledChildEnv(clean(), { ...base, memory: classify({ endpoint: listening(false) }) });
	const result = spawnSync(env.ENGRAM_BIN!, ["instance-id"], { env, encoding: "utf8", timeout: 5000 });
	assert.notEqual(result.status, 0);
	assert.doesNotMatch(result.stdout, /^[a-f0-9]{32}$/m);
});
