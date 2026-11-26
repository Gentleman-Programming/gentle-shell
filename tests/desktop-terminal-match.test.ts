import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { DESKTOP_FEED_LIMITS } from "../lib/desktop-feed.ts";
import { createWindowsParentOf, processAncestors, psParentOf, type WalkableParentOf } from "../lib/desktop-feed-sources.ts";

// The mods import the host module "herdr", which only exists inside the Herdr app. Load the real
// snapshot.js with that import pointed at a stub whose agents(), terminals() and panes() come from globals.
const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "herdr", "mods", "gentle-chat", "snapshot.js");
const STUB = "data:text/javascript," + encodeURIComponent([
	"export const agents = () => globalThis.__matchAgents ?? []; export const terminals = () => globalThis.__matchTerminals ?? [];",
	"export const panes = () => globalThis.__matchPanes ?? [];",
	"export const focused = () => null; export const layout = () => null; export const watchFolder = () => () => {};",
	"export const run = () => {}; export const shared = () => undefined; export const setShared = () => {};",
	"export const home = () => \"C:/Users/dev\"; export const exec = async () => ({ code: 1, stdout: \"\" });",
].join("\n"));

type Terminal = { address: string; id?: string; pid?: number; foreground?: { pid: number }; agent?: string };
type Feed = { identity: { pid: number; ppid?: number; sessionId: string; agentDir: string; ancestors?: number[]; herdr?: { paneId: string } | null; platform?: string }; updatedAt: string };
type Row = { key: string; feed: Feed | null; terminal: Terminal | null };

let loads = 0;
async function loadSnapshot(t: test.TestContext, host: { terminals?: Terminal[]; panes?: { terminal: string }[] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "terminal-match-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const source = readFileSync(SNAPSHOT, "utf8").replace(/from "herdr";/, `from "${STUB}";`);
	assert.ok(source.includes(STUB), "the herdr import was redirected to the stub");
	const file = join(dir, "snapshot.mjs");
	writeFileSync(file, source);
	const g = globalThis as Record<string, unknown>;
	g.__matchAgents = [];
	g.__matchTerminals = host.terminals ?? [];
	g.__matchPanes = host.panes ?? [];
	t.after(() => { delete g.__matchAgents; delete g.__matchTerminals; delete g.__matchPanes; });
	const mod = await import(`${pathToFileURL(file).href}?load=${++loads}`);
	return mod as { matchFeed(terminal: Terminal, feeds: Feed[]): Feed | null; allSessions(feeds: Feed[]): Row[] };
}

const processTable = (rows: Record<number, number>) => Object.entries(rows).map(([pid, ppid]) => `${pid},${ppid}`).join("\r\n") + "\r\n";

// A publisher as the extension stamps it: pid, ppid and the ancestors above ppid, read from a fake Windows process table.
async function publisher(sessionId: string, pid: number, table: Record<number, number>, depth: number, herdr: { paneId: string } | null = null): Promise<Feed> {
	const parentOf = createWindowsParentOf(async () => processTable(table), 60_000, () => 0);
	const ppid = table[pid];
	const ancestors = await processAncestors(ppid, depth, parentOf);
	return { identity: { pid, ppid, sessionId, agentDir: "C:/Users/dev/.gentle-shell/agent", ancestors, herdr }, updatedAt: "2026-11-21T10:00:00.000Z" };
}

// pi (500) <- node launcher (400) <- shell (300) <- Herdr terminal process (200) <- Herdr (100)
const NATIVE_TABLE = { 500: 400, 400: 300, 300: 200, 200: 100, 100: 50 };

test("should match the feed whose publisher descends from the terminal pid on a native Windows launch", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const feed = await publisher("native", 500, NATIVE_TABLE, 8);
	assert.equal(feed.identity.herdr, null);
	assert.deepEqual(feed.identity.ancestors, [300, 200, 100, 50]);
	assert.equal(matchFeed({ address: "t1", id: "t1", pid: 200 }, [feed]), feed);
});

test("should pick the feed that is nearest to the terminal pid on a native Windows launch", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const near = await publisher("near", 500, NATIVE_TABLE, 8);
	const far = await publisher("far", 600, { ...NATIVE_TABLE, 600: 500 }, 8);
	assert.equal(matchFeed({ address: "t1", id: "t1", pid: 300 }, [far, near]), near);
});

test("should not match a wrapper launch whose foreground pid is not in the publisher ancestors and has no pane id", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const feed = await publisher("wrapper", 500, NATIVE_TABLE, 8);
	assert.equal(feed.identity.herdr, null);
	const terminal = { address: "t1", id: "t1", pid: 7000, foreground: { pid: 7100 } };
	assert.equal(matchFeed(terminal, [feed]), null);
});

test("should match a wrapper launch when the chain reaches the terminal pid within the ancestors limit", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const reached = await publisher("reached", 500, NATIVE_TABLE, 3);
	assert.deepEqual(reached.identity.ancestors, [300, 200, 100]);
	const terminal = { address: "t1", id: "t1", pid: 7000, foreground: { pid: 100 } };
	assert.equal(matchFeed(terminal, [reached]), reached);
});

test("should not match a wrapper launch when the chain stops before the terminal pid because of the ancestors limit", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const short = await publisher("short", 500, NATIVE_TABLE, 2);
	assert.deepEqual(short.identity.ancestors, [300, 200]);
	const terminal = { address: "t1", id: "t1", pid: 7000, foreground: { pid: 100 } };
	assert.equal(matchFeed(terminal, [short]), null);
});

test("should match by Herdr pane id when the pid chain does not overlap", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const feed = await publisher("pane", 500, NATIVE_TABLE, 8, { paneId: "wMJ:p1" });
	assert.equal(matchFeed({ address: "wMJ:p1", pid: 7000 }, [feed]), feed);
	assert.equal(matchFeed({ address: "t9", id: "wMJ:p1", pid: 7000 }, [feed]), feed);
});

test("should not match by pane id when it names another terminal", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const feed = await publisher("pane", 500, NATIVE_TABLE, 8, { paneId: "wMJ:p1" });
	assert.equal(matchFeed({ address: "wMJ:p2", id: "wMJ:p2", pid: 7000 }, [feed]), null);
});

test("should list a live feed and its Herdr terminal as one session", async (t) => {
	const terminal = { address: "t1", id: "t1", pid: 200, agent: "gentle-shell" };
	const { allSessions } = await loadSnapshot(t, { terminals: [terminal], panes: [{ terminal: "t1" }] });
	const feed = await publisher("native", 500, NATIVE_TABLE, 8);
	const rows = allSessions([feed]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].feed, feed);
	assert.equal(rows[0].terminal, terminal);
});

test("should give a Gentle terminal that no feed matches its own row without a feed", async (t) => {
	const matched = { address: "t1", id: "t1", pid: 200, agent: "gentle-shell" };
	const unmatched = { address: "t2", id: "t2", pid: 7000, agent: "gentle-shell" };
	const { allSessions } = await loadSnapshot(t, { terminals: [matched, unmatched], panes: [{ terminal: "t1" }, { terminal: "t2" }] });
	const feed = await publisher("native", 500, NATIVE_TABLE, 8);
	const rows = allSessions([feed]);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map((r) => [r.feed, r.terminal]), [[feed, matched], [null, unmatched]]);
	assert.equal(rows[1].key, "terminal|t2");
});

test("should never match a terminal that lives on another machine", async (t) => {
	const remote = { address: "vps/t7", id: "vps/t7", pid: 200, foreground: { pid: 300 }, agent: "gentle-shell" };
	const { matchFeed, allSessions } = await loadSnapshot(t, { terminals: [remote], panes: [{ terminal: "vps/t7" }] });
	const feed = await publisher("remote", 500, NATIVE_TABLE, 8, { paneId: "vps/t7" });
	assert.equal(matchFeed(remote, [feed]), null);
	const rows = allSessions([feed]);
	assert.deepEqual(rows.map((r) => [r.feed, r.terminal]), [[feed, null], [null, remote]]);
});

test("should match a launcher at the last recorded ancestor and not one hop beyond it, at the production limit", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const limit = DESKTOP_FEED_LIMITS.ancestors;
	const table: Record<number, number> = {};
	for (let pid = 1000; pid <= 1000 + limit + 3; pid++) table[pid] = pid + 1;
	table[1000 + limit + 4] = 50;
	const feed = await publisher("boundary", 1000, table, limit);
	assert.equal(feed.identity.ancestors.length, limit);
	const lastRecorded = feed.identity.ancestors[limit - 1];
	assert.equal(lastRecorded, 1001 + limit, "ppid plus the recorded ancestors reach limit + 1 hops above the publisher");
	assert.equal(matchFeed({ address: "t1", id: "t1", pid: lastRecorded }, [feed]), feed);
	assert.equal(matchFeed({ address: "t1", id: "t1", pid: lastRecorded + 1 }, [feed]), null);
});

test("should rank a pane id one step past each feed's own chain, so a short chain with the pane id can outrank a distant pid match", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const identity = (sessionId: string, chain: number[], paneId: string | null) => ({ pid: chain[0], ppid: chain[1], sessionId, agentDir: "C:/Users/dev/.gentle-shell/agent", ancestors: chain.slice(2), herdr: paneId ? { paneId } : null });
	const withPane: Feed = { identity: identity("pane", [10, 11], "t1"), updatedAt: "2026-11-21T10:00:00.000Z" };
	const distantPid: Feed = { identity: identity("pid", [20, 21, 22, 7000], null), updatedAt: "2026-11-21T10:00:00.000Z" };
	const terminal = { address: "t1", id: "t1", pid: 7000 };
	assert.equal(matchFeed(terminal, [distantPid, withPane]), withPane);
	assert.equal(matchFeed(terminal, [distantPid]), distantPid);
});

test("should read the real parent of this process through the exported psParentOf on Windows", { skip: process.platform !== "win32" }, async () => {
	assert.equal(await psParentOf(process.pid), process.ppid);
	assert.equal(await psParentOf(2_000_000_000), undefined, "a pid that does not exist has no parent");
});

test("should answer undefined for every pid when the process-table read throws synchronously", async () => {
	const parentOf = createWindowsParentOf((() => { throw new Error("no powershell"); }) as unknown as () => Promise<string | undefined>);
	assert.equal(await parentOf(500), undefined);
	assert.deepEqual(await processAncestors(500, 8, parentOf), []);
});

test("should walk every hop of one ancestry on the same table even when the cache expires mid-walk", async () => {
	let clock = 0;
	let reads = 0;
	const tables = [processTable(NATIVE_TABLE), processTable({ 500: 9000, 9000: 9001 })];
	const parentOf = createWindowsParentOf(async () => tables[Math.min(reads++, tables.length - 1)], 1000, () => (clock += 600));
	assert.deepEqual(await processAncestors(500, 8, parentOf), [400, 300, 200, 100, 50], "the whole walk used the first table");
	assert.equal(reads, 1, "the table expiring during the walk did not trigger a second read");
	clock += 5000;
	assert.deepEqual(await processAncestors(500, 8, parentOf), [9000, 9001], "the next walk starts on a fresh table");
	assert.equal(reads, 2);
});

test("should not rank a feed by pid when its publisher runs on another platform than this Windows host", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const foreign: Feed = { identity: { pid: 200, sessionId: "wsl", agentDir: "C:/Users/dev/.gentle-shell/agent", platform: "linux" }, updatedAt: "2026-11-21T10:00:00.000Z" };
	assert.equal(matchFeed({ address: "t1", id: "t1", pid: 200 }, [foreign]), null);
});

test("should still match a feed from another platform by its Herdr pane id", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const foreign: Feed = { identity: { pid: 200, sessionId: "wsl", agentDir: "C:/Users/dev/.gentle-shell/agent", platform: "linux", herdr: { paneId: "p1" } }, updatedAt: "2026-11-21T10:00:00.000Z" };
	assert.equal(matchFeed({ address: "t1", id: "t1", pid: 999, pane: "p1" } as Terminal, [foreign]), foreign);
});

test("should keep ranking by pid a feed that names win32 or no platform on a Windows host", async (t) => {
	const { matchFeed } = await loadSnapshot(t);
	const stamped: Feed = { identity: { pid: 200, sessionId: "a", agentDir: "C:/a", platform: "win32" }, updatedAt: "2026-11-21T10:00:00.000Z" };
	const legacy: Feed = { identity: { pid: 300, sessionId: "b", agentDir: "C:/b" }, updatedAt: "2026-11-21T10:00:00.000Z" };
	assert.equal(matchFeed({ address: "t1", id: "t1", pid: 200 }, [stamped]), stamped);
	assert.equal(matchFeed({ address: "t2", id: "t2", pid: 300 }, [legacy]), legacy);
});

test("should expose the single-table walk on the exported psParentOf on Windows and not elsewhere", () => {
	const walk = (psParentOf as WalkableParentOf).walk;
	if (process.platform === "win32") assert.equal(typeof walk, "function", "production ancestry walks read one table");
	else assert.equal(walk, undefined, "ps answers one pid per call, there is no table to share");
});

test("should answer the same ancestors through the exported psParentOf walk as hop by hop on Windows", { skip: process.platform !== "win32" }, async () => {
	const hopByHop: number[] = [];
	let current = process.ppid;
	for (let hop = 0; hop < 3; hop++) {
		const parent = await psParentOf(current);
		if (parent === undefined) break;
		hopByHop.push(parent);
		current = parent;
	}
	assert.deepEqual(await processAncestors(process.ppid, 3, psParentOf), hopByHop);
});

test("should not keep a failed process-table read for the cache lifetime", async () => {
	let reads = 0;
	const parentOf = createWindowsParentOf(async () => { if (reads++ === 0) throw new Error("transient powershell failure"); return processTable(NATIVE_TABLE); }, 60_000, () => 0);
	assert.deepEqual(await processAncestors(500, 8, parentOf), [], "the failed read finds nothing");
	assert.deepEqual(await processAncestors(500, 8, parentOf), [400, 300, 200, 100, 50], "the next walk reads again instead of reusing the failure");
	assert.equal(reads, 2);
});

test("should keep a successful process-table read for the cache lifetime", async () => {
	let reads = 0;
	const parentOf = createWindowsParentOf(async () => { reads++; return processTable(NATIVE_TABLE); }, 60_000, () => 0);
	await processAncestors(500, 8, parentOf);
	await processAncestors(500, 8, parentOf);
	assert.equal(reads, 1);
});
