import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Which session snapshots are live (herdr/mods/*/snapshot.js liveFeeds): the desktop asks `ps`
// whether each publisher pid still runs, and `tasklist` where `ps` cannot start (native Windows).
// Every gentle-* mod carries its own byte-identical copy, so each copy is loaded and checked, with
// a fake `herdr` host module whose `exec` answers per case.

const MODS = fileURLToPath(new URL("../herdr/mods/", import.meta.url));
const copies = readdirSync(MODS).filter((m) => readdirSync(join(MODS, m)).includes("snapshot.js")).sort();

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecCall = { command: string; args: string[]; options: unknown };
const host = globalThis as unknown as { __herdrExec: (call: ExecCall) => ExecResult };

const scratch = mkdtempSync(join(tmpdir(), "gentle-liveness-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(join(scratch, "package.json"), JSON.stringify({ type: "module" }));
mkdirSync(join(scratch, "node_modules", "herdr"), { recursive: true });
writeFileSync(join(scratch, "node_modules", "herdr", "package.json"), JSON.stringify({ name: "herdr", type: "module", exports: "./index.js" }));
writeFileSync(
	join(scratch, "node_modules", "herdr", "index.js"),
	`export const exec = async (command, args, options) => globalThis.__herdrExec({ command, args, options });
export const focused = () => null;
export const agents = () => [];
export const terminals = () => [];
export const panes = () => [];
export const shared = () => null;
export const setShared = () => {};
export const home = () => "/home/test";
export const layout = () => null;
export const watchFolder = () => {};
export const run = () => {};
`,
);

type Feed = { identity: { pid: number; sessionId: string } };
type Snapshot = { liveFeeds: (feeds: Feed[]) => Promise<Feed[]>; parseTasklistPids: (stdout: string) => Set<number> };

// A fresh module per load: liveFeeds keeps the verdicts of the last 5 s at module level.
let loads = 0;
const load = async (mod: string, answer: (call: ExecCall) => ExecResult) => {
	mkdirSync(join(scratch, mod), { recursive: true });
	copyFileSync(join(MODS, mod, "snapshot.js"), join(scratch, mod, "snapshot.js"));
	const calls: ExecCall[] = [];
	host.__herdrExec = (call) => {
		calls.push(call);
		return answer(call);
	};
	const snapshot: Snapshot = await import(`${pathToFileURL(join(scratch, mod, "snapshot.js")).href}?load=${++loads}`);
	return { snapshot, calls };
};

const feed = (pid: number): Feed => ({ identity: { pid, sessionId: `s${pid}` } });
const pids = (feeds: Feed[]) => feeds.map((f) => f.identity.pid);
const missing = (command: string) => {
	throw new Error(`spawn ${command} ENOENT`);
};
// `tasklist /NH /FO CSV` as Windows prints it: one quoted row per process, CRLF line ends.
const tasklist = (...running: number[]): ExecResult => ({
	code: 0,
	stdout: [`"System Idle Process","0","Services","0","8 K"`, ...running.map((p) => `"app${p}.exe","${p}","Console","1","10,000 K"`)].join("\r\n") + "\r\n",
	stderr: "",
});

test("liveness: the copies under test are every gentle-* mod's snapshot.js", () => {
	assert.equal(copies.length, 10);
});

for (const mod of copies) {
	test(`${mod}: an MSYS/Git ps that rejects -o decides nothing, so the session stays listed (#3387)`, async () => {
		const msys: ExecResult = { code: 1, stdout: "", stderr: "ps: unknown option -- o\nTry `ps --help' for more information.\n" };
		const { snapshot, calls } = await load(mod, ({ command }) => (command === "ps" ? msys : missing(command)));
		assert.deepEqual(pids(await snapshot.liveFeeds([feed(14156)])), [14156]);
		// Nothing was recorded: the next refresh asks again instead of reusing a verdict.
		assert.deepEqual(pids(await snapshot.liveFeeds([feed(14156)])), [14156]);
		assert.deepEqual(calls.map((c) => c.command), ["ps", "tasklist", "ps", "tasklist"]);
	});

	test(`${mod}: with an MSYS/Git ps on a Windows PATH, tasklist decides and a closed session is dropped (#3387)`, async () => {
		const msys: ExecResult = { code: 1, stdout: "", stderr: "ps: unknown option -- o\n" };
		const { snapshot } = await load(mod, ({ command }) => (command === "ps" ? msys : tasklist(200)));
		assert.deepEqual(pids(await snapshot.liveFeeds([feed(100), feed(200)])), [200]);
	});

	test(`${mod}: a POSIX ps that exits 1 because one pid is gone still drops that session`, async () => {
		const { snapshot, calls } = await load(mod, ({ command }) => (command === "ps" ? { code: 1, stdout: "  200\n", stderr: "" } : missing(command)));
		assert.deepEqual(pids(await snapshot.liveFeeds([feed(100), feed(200)])), [200]);
		assert.deepEqual(calls.map((c) => [c.command, c.args]), [["ps", ["-o", "pid=", "-p", "100,200"]]]);
	});

	test(`${mod}: where ps cannot start, tasklist lists the running pids and a closed session is dropped (#3352, #3390)`, async () => {
		const { snapshot, calls } = await load(mod, ({ command }) => (command === "tasklist" ? tasklist(200) : missing(command)));
		assert.deepEqual(pids(await snapshot.liveFeeds([feed(100), feed(200)])), [200]);
		assert.deepEqual(calls.map((c) => [c.command, c.args, c.options]), [
			["ps", ["-o", "pid=", "-p", "100,200"], { timeout: 3000 }],
			["tasklist", ["/NH", "/FO", "CSV"], { timeout: 3000 }],
		]);
		// The verdict is kept for 5 s, as with ps: no second listing.
		assert.deepEqual(pids(await snapshot.liveFeeds([feed(100), feed(200)])), [200]);
		assert.equal(calls.length, 2);
	});

	test(`${mod}: when neither ps nor tasklist answers, every session stays listed`, async () => {
		const failures: Array<[string, (command: string) => ExecResult]> = [
			["tasklist cannot start", missing],
			["tasklist fails", () => ({ code: 1, stdout: "", stderr: "ERROR: access denied\r\n" })],
		];
		for (const [name, tasklistAnswer] of failures) {
			const { snapshot, calls } = await load(mod, ({ command }) => (command === "tasklist" ? tasklistAnswer(command) : missing(command)));
			assert.deepEqual(pids(await snapshot.liveFeeds([feed(100), feed(200)])), [100, 200], name);
			assert.deepEqual(calls.map((c) => c.command), ["ps", "tasklist"], name);
		}
	});

	test(`${mod}: parseTasklistPids reads the pids out of tasklist CSV output`, async () => {
		const { snapshot } = await load(mod, ({ command }) => missing(command));
		assert.deepEqual([...snapshot.parseTasklistPids(tasklist(4, 4321).stdout)].sort((a, b) => a - b), [0, 4, 4321]);
		assert.equal(snapshot.parseTasklistPids("").size, 0);
	});
}
