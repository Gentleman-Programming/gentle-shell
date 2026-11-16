import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { PRESENCE_MAX_AGE_MS, readPresenceFloors } from "../lib/tower-presence.ts";
import { writeTowerSnapshot } from "../lib/tower-hub.ts";
import { buildTowerSnapshot } from "../lib/tower-snapshot.ts";
import { startTowerServer, type TowerServer } from "../lib/tower-server.ts";
import { towerInboxDir } from "../lib/tower-actions.ts";

const roots: string[] = [];
const servers: TowerServer[] = [];
after(async () => { for (const s of servers) await s.close(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
const NOW = 1_800_000_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function presence(dir: string, sessionId: string, opts: { label: string; workspace: string; heartbeat?: number; tasks?: unknown[]; unavailable?: unknown }) {
	mkdirSync(dir, { recursive: true });
	const hash = sha(sessionId), inc = "11111111-2222-3333-4444-555555555555", base = `${hash}.${inc}`;
	writeFileSync(join(dir, `${base}.header.json`), JSON.stringify({ schema: 1, sessionHash: hash, incarnation: inc, label: opts.label, heartbeat: opts.heartbeat ?? NOW - 5000, generation: 1, counts: {}, unavailable: opts.unavailable ?? null }));
	writeFileSync(join(dir, `${base}.discovery.json`), JSON.stringify({ schema: 1, sessionHash: hash, incarnation: inc, generation: 1, metadata: { workspace: opts.workspace, tasks: opts.tasks ?? [] } }));
	return hash;
}
function setup() {
	const root = mkdtempSync(join(tmpdir(), "gentle-tower-presence-"));
	roots.push(root);
	return { root, dir: join(root, "presence"), hub: join(root, "sessions") };
}

test("every live Gentle Shell session becomes a basic floor, its helpers named by role and task", () => {
	const { dir } = setup();
	presence(dir, "sess-a", { label: "Herdr app package", workspace: "/w/gentle-ai", tasks: [
		{ id: "t1", agent: "gentle-ai-worker", label: "T4 desktop snapshot publisher", status: "running" },
		{ id: "t2", agent: "gentle-ai-worker", label: "Write the parity tests", status: "queued" },
		{ id: "t3", agent: "gentle-ai-explore", label: "map the sidebar", status: "completed" },
	] });
	const [f] = readPresenceFloors([dir], NOW);
	assert.equal(f.basic, true);
	assert.equal(f.name, "Herdr app package");
	assert.deepEqual(f.project, { cwd: "/w/gentle-ai", name: "gentle-ai" });
	assert.deepEqual(f.subagents.map((a) => [a.name, a.status]), [["worker-t4", "running"], ["worker-parity", "queued"]]);
	assert.deepEqual(f.todos, []);
	assert.match(f.sessionId, /^p-[0-9a-f]{32}$/);
});

test("stale, unavailable and malformed presence entries are skipped", () => {
	const { dir } = setup();
	presence(dir, "old", { label: "Closed yesterday", workspace: "/w/a", heartbeat: NOW - 10 * 60_000 });
	presence(dir, "gone", { label: "Unavailable", workspace: "/w/a", unavailable: { reason: "x" } });
	writeFileSync(join(dir, "junk.header.json"), "{not json");
	presence(dir, "live", { label: "Live one", workspace: "/w/a" });
	assert.deepEqual(readPresenceFloors([dir], NOW).map((f) => f.name), ["Live one"]);
	assert.deepEqual(readPresenceFloors([join(dir, "missing")], NOW), []);
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })); });
		req.on("error", reject); req.end();
	});
}
function post(port: number, path: string, body: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
		req.on("error", reject); req.end(body);
	});
}

test("the tower shows detailed floors and every other live session once; basic floors take no actions", async () => {
	const { root, dir, hub } = setup();
	writeTowerSnapshot(hub, buildTowerSnapshot({ sessionId: "sess-a", sessionName: "Detailed", cwd: "/w/gentle-ai", stats: { cost: 1, input: 0, output: 0 }, todos: [], agents: [], now: NOW }));
	presence(dir, "sess-a", { label: "Detailed (presence copy)", workspace: "/w/gentle-ai" });
	presence(dir, "sess-b", { label: "Only in presence", workspace: "/w/engram" });
	const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "<title>t</title>");
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", presenceDirs: [dir], now: () => NOW });
	servers.push(s);
	const sessions = JSON.parse((await get(s.port, "/tok-123/api/sessions")).body).sessions as Array<{ name: string; basic?: boolean; sessionId: string }>;
	assert.deepEqual(sessions.map((x) => [x.name, x.basic ?? false]), [["Detailed", false], ["Only in presence", true]]);
	const basic = sessions.find((x) => x.basic)!;
	assert.equal(await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "message", sessionId: basic.sessionId, text: "hi" })), 404);
	assert.equal(existsSync(towerInboxDir(hub, basic.sessionId)) ? readdirSync(towerInboxDir(hub, basic.sessionId)).length : 0, 0);
	assert.equal(await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "message", sessionId: "sess-a", text: "hi" })), 202);
});

test("finished helpers never reach the web, even from a session running older publisher code", async () => {
	const { root, hub } = setup();
	const agent = (id: string, status: string) => ({ id, agent: "gentle-ai-explore", status, usage: { total: 1, cost: 0 } });
	writeTowerSnapshot(hub, buildTowerSnapshot({ sessionId: "old", cwd: "/w/a", stats: { cost: 0, input: 0, output: 0 }, todos: [], agents: [agent("a", "completed"), agent("b", "failed"), agent("c", "running"), agent("d", "cancelled")], now: NOW }));
	const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "<title>t</title>");
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123" });
	servers.push(s);
	const [floor] = JSON.parse((await get(s.port, "/tok-123/api/sessions")).body).sessions as Array<{ subagents: Array<{ id: string }> }>;
	assert.deepEqual(floor.subagents.map((a) => a.id), ["c"]);
});

test("a detailed floor whose snapshot is older than its heartbeat takes its live helpers from presence", async () => {
	const { root, dir, hub } = setup();
	writeTowerSnapshot(hub, buildTowerSnapshot({ sessionId: "sess-a", cwd: "/w/a", stats: { cost: 2, input: 0, output: 0 }, todos: [], agents: [], now: NOW - 90_000 }));
	presence(dir, "sess-a", { label: "x", workspace: "/w/a", heartbeat: NOW - 1000, tasks: [{ id: "t9", agent: "gentle-ai-worker", label: "T4 publisher", status: "running" }] });
	const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "<title>t</title>");
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", presenceDirs: [dir], now: () => NOW });
	servers.push(s);
	const [floor] = JSON.parse((await get(s.port, "/tok-123/api/sessions")).body).sessions as Array<{ cost: { total: number }; subagents: Array<{ id: string; name: string }> }>;
	assert.equal(floor.cost.total, 2);
	assert.deepEqual(floor.subagents.map((a) => [a.id, a.name]), [["t9", "worker"]]);
});

test("a snapshot whose process is gone is dropped; the live session shows from presence instead", async () => {
	const { root, dir, hub } = setup();
	const dead = 2 ** 22 + 12345;
	writeTowerSnapshot(hub, { ...buildTowerSnapshot({ sessionId: "sess-a", sessionName: "Frozen", cwd: "/w/a", stats: { cost: 3, input: 0, output: 0 }, todos: [], agents: [], now: NOW - 600_000, said: "old words" }), pid: dead });
	writeTowerSnapshot(hub, { ...buildTowerSnapshot({ sessionId: "sess-b", sessionName: "Alive", cwd: "/w/a", stats: { cost: 1, input: 0, output: 0 }, todos: [], agents: [], now: NOW }), pid: process.pid });
	presence(dir, "sess-a", { label: "Live via presence", workspace: "/w/a" });
	const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "<title>t</title>");
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", presenceDirs: [dir], now: () => NOW });
	servers.push(s);
	const list = JSON.parse((await get(s.port, "/tok-123/api/sessions")).body).sessions as Array<{ name: string; basic?: boolean; said?: string }>;
	assert.deepEqual(list.map((x) => [x.name, x.basic ?? false]), [["Alive", false], ["Live via presence", true]]);
	assert.ok(!list.some((x) => x.said === "old words"));
	assert.equal(await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "message", sessionId: "sess-a", text: "hi" })), 404);
});

test("an abrupt death can leave a basic lookalike only until its presence heartbeat expires", async () => {
	const { root, dir, hub } = setup();
	const dead = 2 ** 22 + 12345;
	writeTowerSnapshot(hub, { ...buildTowerSnapshot({ sessionId: "dead", sessionName: "Same name", cwd: "/w/a", stats: { cost: 1, input: 0, output: 0 }, todos: [], agents: [], now: NOW - 6000 }), pid: dead });
	writeTowerSnapshot(hub, { ...buildTowerSnapshot({ sessionId: "live", sessionName: "Same name", cwd: "/w/a", stats: { cost: 2, input: 0, output: 0 }, todos: [], agents: [], now: NOW }), pid: process.pid });
	presence(dir, "dead", { label: "Same name", workspace: "/w/a" });
	presence(dir, "live", { label: "Same name", workspace: "/w/a" });
	const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "<title>t</title>");
	let now = NOW;
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", presenceDirs: [dir], now: () => now });
	servers.push(s);
	const floors = async () => JSON.parse((await get(s.port, "/tok-123/api/sessions")).body).sessions as Array<{ sessionId: string; name: string; basic?: boolean }>;
	const before = await floors();
	assert.deepEqual(before.map((f) => [f.name, f.basic ?? false]), [["Same name", false], ["Same name", true]]);
	assert.equal(await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "message", sessionId: before[1].sessionId, text: "hi" })), 404);
	now += PRESENCE_MAX_AGE_MS;
	assert.deepEqual((await floors()).map((f) => [f.name, f.basic ?? false]), [["Same name", false]]);
});

test("a Windows workspace path is a floor; null or malformed tasks are skipped", () => {
	const { dir } = setup();
	presence(dir, "win", { label: "On Windows", workspace: "C:\\work\\project", tasks: [null, 7, "x", { id: "t1", agent: "gentle-ai-worker", status: "running" }] });
	presence(dir, "rel", { label: "Relative", workspace: "work\\project" });
	const floors = readPresenceFloors([dir], NOW);
	assert.deepEqual(floors.map((f) => [f.name, f.project]), [["On Windows", { cwd: "C:\\work\\project", name: "project" }]]);
	assert.deepEqual(floors[0].subagents.map((a) => a.id), ["t1"]);
});

test("a recently updated detailed floor keeps its own helper details over a newer heartbeat", async () => {
	const { root, dir, hub } = setup();
	writeTowerSnapshot(hub, buildTowerSnapshot({ sessionId: "sess-a", cwd: "/w/a", stats: { cost: 2, input: 0, output: 0 }, todos: [], agents: [{ id: "t1", agent: "gentle-ai-worker", status: "running", lastStep: "editing", usage: { total: 500, cost: 0.4 } }], now: NOW - 30_000 }));
	presence(dir, "sess-a", { label: "x", workspace: "/w/a", heartbeat: NOW - 1000, tasks: [{ id: "t1", agent: "gentle-ai-worker", status: "running" }] });
	const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "<title>t</title>");
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", presenceDirs: [dir], now: () => NOW });
	servers.push(s);
	const [floor] = JSON.parse((await get(s.port, "/tok-123/api/sessions")).body).sessions as Array<{ subagents: Array<{ id: string; cost: number; tokens: number; lastStep?: string }> }>;
	assert.deepEqual(floor.subagents.map((a) => [a.id, a.cost, a.tokens, a.lastStep]), [["t1", 0.4, 500, "editing"]]);
});

test("a new floor opens in a project that only has basic floors; still never an unknown folder", async () => {
	const { root, dir, hub } = setup();
	presence(dir, "sess-b", { label: "Only in presence", workspace: "/w/engram" });
	const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "<title>t</title>");
	const opened: string[] = [];
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", presenceDirs: [dir], now: () => NOW, onNewFloor: async (cwd) => { opened.push(cwd); } });
	servers.push(s);
	assert.equal(await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "new-floor", project: "/w/engram" })), 202);
	assert.equal(await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "new-floor", project: "/w/other" })), 403);
	assert.deepEqual(opened, ["/w/engram"]);
});
