import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// The mods import the host module "herdr", which only exists inside the Herdr app. Load the real
// snapshot.js with that import pointed at a stub, so the shipped code is what runs.
const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "herdr", "mods", "gentle-status", "snapshot.js");
const STUB = "data:text/javascript," + encodeURIComponent([
	"export const agents = () => []; export const terminals = () => []; export const panes = () => [];",
	"export const focused = () => null; export const layout = () => null; export const watchFolder = () => () => {};",
	"export const run = () => {}; export const shared = () => undefined; export const setShared = () => {};",
	"export const home = () => globalThis.__livenessHome;",
	"export const exec = (...args) => globalThis.__livenessExec(...args);",
].join("\n"));

type ExecResult = { code: number; stdout: string; stderr?: string };
type ExecCall = { command: string; args: string[] };

let loads = 0;
async function loadSnapshot(t: test.TestContext, host: { home: string; exec: (call: ExecCall) => ExecResult | Promise<ExecResult> }) {
	const dir = mkdtempSync(join(tmpdir(), "liveness-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const source = readFileSync(SNAPSHOT, "utf8").replace(/from "herdr";/, `from "${STUB}";`);
	assert.ok(source.includes(STUB), "the herdr import was redirected to the stub");
	const file = join(dir, "snapshot.mjs");
	writeFileSync(file, source);
	const calls: ExecCall[] = [];
	const g = globalThis as Record<string, unknown>;
	g.__livenessHome = host.home;
	g.__livenessExec = async (command: string, args: string[]) => { calls.push({ command, args }); return host.exec({ command, args }); };
	t.after(() => { delete g.__livenessHome; delete g.__livenessExec; });
	// A fresh module instance per test: liveFeeds keeps a module-level cache of recent checks.
	const mod = await import(`${pathToFileURL(file).href}?load=${++loads}`);
	return { mod, calls };
}

const WINDOWS_HOME = "C:/Users/dev";
const feedFor = (pid: number, startedAt?: number) => ({ identity: { pid, sessionId: `s${pid}`, ...(startedAt === undefined ? {} : { startedAt }) } });
const tasklist = (...pids: number[]) => ({ code: 0, stdout: ["System Idle Process", ...pids.map((p) => `app${p}.exe`)].map((name, i) => `"${name}","${i === 0 ? 0 : pids[i - 1]}","Console","1","10,000 K"`).join("\r\n") + "\r\n" });

test("should drop a feed whose publisher is not in the Windows process list", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" }) });
	const live = await mod.liveFeeds([feedFor(100), feedFor(200)]);
	assert.deepEqual(live.map((f: { identity: { pid: number } }) => f.identity.pid), [200]);
});

test("should ask tasklist, not ps, on a Windows host", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" }) });
	await mod.liveFeeds([feedFor(200)]);
	assert.deepEqual(calls.map((c) => c.command), ["tasklist"]);
});

test("should keep every feed when the Windows process list cannot be read", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => { throw new Error("no tasklist"); } });
	const live = await mod.liveFeeds([feedFor(100), feedFor(200)]);
	assert.equal(live.length, 2);
});

test("should drop a feed whose pid now belongs to a process started at a different time", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt + 3_600_000}\r\n` }),
	});
	assert.deepEqual(await mod.liveFeeds([feedFor(200, startedAt)]), []);
});

test("should keep a feed whose pid runs a process started when the publisher started", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt + 800}\r\n` }),
	});
	assert.equal((await mod.liveFeeds([feedFor(200, startedAt)])).length, 1);
});

test("should fall back to the pid alone when the feed carries no start time", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" }) });
	assert.equal((await mod.liveFeeds([feedFor(200)])).length, 1);
	assert.deepEqual(calls.map((c) => c.command), ["tasklist"]);
});

test("should keep checking with ps on a POSIX host", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: "/home/dev", exec: ({ command }) => (command === "ps" ? { code: 1, stdout: "  200\n" } : { code: 2, stdout: "" }) });
	const live = await mod.liveFeeds([feedFor(100), feedFor(200)]);
	assert.deepEqual(live.map((f: { identity: { pid: number } }) => f.identity.pid), [200]);
	assert.deepEqual(calls.map((c) => c.command), ["ps"]);
});

test("should parse the pids out of tasklist CSV output", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => ({ code: 1, stdout: "" }) });
	assert.deepEqual([...mod.parseTasklistPids(tasklist(4, 4321).stdout)].sort((a: number, b: number) => a - b), [0, 4, 4321]);
	assert.equal(mod.parseTasklistPids("").size, 0);
});

test("should treat processes whose start times differ by more than the tolerance as different", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => ({ code: 1, stdout: "" }) });
	assert.equal(mod.sameProcess(1_000_000, 1_000_000 + 2_000), true);
	assert.equal(mod.sameProcess(1_000_000, 1_000_000 + 60_000), false);
	assert.equal(mod.sameProcess(undefined, 5), true);
});
