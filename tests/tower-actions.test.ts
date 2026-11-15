import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { consumeTowerActions, parseTowerAction, TOWER_ACTION_MAX_BYTES, towerInboxDir, writeTowerAction } from "../lib/tower-actions.ts";
import { startTowerServer, type TowerServer } from "../lib/tower-server.ts";

const roots: string[] = [];
const servers: TowerServer[] = [];
after(async () => { for (const s of servers) await s.close(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
function scratch() {
	const root = mkdtempSync(join(tmpdir(), "gentle-tower-act-"));
	roots.push(root);
	const hub = join(root, "sessions");
	const web = join(root, "web");
	mkdirSync(web);
	writeFileSync(join(web, "index.html"), "<title>t</title>");
	return { root, hub, web };
}

test("only the closed set of actions parses", () => {
	assert.deepEqual(parseTowerAction({ type: "message", sessionId: "s-1", text: " hi " }), { type: "message", sessionId: "s-1", text: "hi" });
	assert.deepEqual(parseTowerAction({ type: "cancel-helper", sessionId: "s-1", helperId: "t1" }), { type: "cancel-helper", sessionId: "s-1", helperId: "t1" });
	for (const mode of ["normal", "auto", "yolo", "super-yolo"]) assert.deepEqual(parseTowerAction({ type: "permission", sessionId: "s-1", mode }), { type: "permission", sessionId: "s-1", mode });
	assert.equal(parseTowerAction({ type: "permission", sessionId: "s-1", mode: "SUPER-YOLO" }), undefined);
	assert.deepEqual(parseTowerAction({ type: "review", sessionId: "s-1", enabled: false }), { type: "review", sessionId: "s-1", enabled: false });
	for (const bad of [
		null, "x", {}, { type: "shell", sessionId: "s-1", command: "rm -rf /" },
		{ type: "message", sessionId: "../x", text: "hi" }, { type: "message", sessionId: "s-1", text: "" },
		{ type: "message", sessionId: "s-1", text: "x".repeat(4001) }, { type: "cancel-helper", sessionId: "s-1" },
		{ type: "permission", sessionId: "s-1", mode: "root" }, { type: "review", sessionId: "s-1", enabled: "yes" },
		{ type: "message", sessionId: "s-1", text: "hi", extra: 1 }, { type: "answer", sessionId: "s-1", answer: "x" },
	]) assert.equal(parseTowerAction(bad), undefined, JSON.stringify(bad));
});

test("the inbox is private and consuming empties it in order", () => {
	const { hub } = scratch();
	writeTowerAction(hub, { type: "message", sessionId: "s-1", text: "first" });
	writeTowerAction(hub, { type: "message", sessionId: "s-1", text: "second" });
	writeTowerAction(hub, { type: "message", sessionId: "s-2", text: "other floor" });
	const box = towerInboxDir(hub, "s-1");
	assert.equal(statSync(box).mode & 0o777, 0o700);
	for (const f of readdirSync(box)) assert.equal(statSync(join(box, f)).mode & 0o777, 0o600);
	assert.deepEqual(consumeTowerActions(hub, "s-1").map((a) => a.type === "message" && a.text), ["first", "second"]);
	assert.deepEqual(readdirSync(box), []);
	assert.deepEqual(consumeTowerActions(hub, "s-1"), []);
	assert.equal(consumeTowerActions(hub, "s-2").length, 1);
});

test("a tampered inbox file is dropped, never executed", () => {
	const { hub } = scratch();
	writeTowerAction(hub, { type: "message", sessionId: "s-1", text: "ok" });
	writeFileSync(join(towerInboxDir(hub, "s-1"), "9999-evil.json"), JSON.stringify({ type: "shell", sessionId: "s-1", command: "x" }), { mode: 0o600 });
	writeFileSync(join(towerInboxDir(hub, "s-1"), "9998-other.json"), JSON.stringify({ type: "message", sessionId: "s-2", text: "wrong floor" }), { mode: 0o600 });
	assert.deepEqual(consumeTowerActions(hub, "s-1").map((a) => a.type), ["message"]);
	assert.deepEqual(readdirSync(towerInboxDir(hub, "s-1")), []);
});

function post(port: number, path: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
			let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
		});
		req.on("error", reject); req.end(body);
	});
}

test("the server queues a valid action for its floor and refuses the rest", async () => {
	const { hub, web } = scratch();
	writeTowerSnapshot(hub, buildTowerSnapshot({ sessionId: "s-1", cwd: "/w/app", stats: { cost: 0, input: 0, output: 0 }, todos: [], agents: [], now: 1 }));
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123" });
	servers.push(s);
	const own = { Origin: `http://127.0.0.1:${s.port}` };
	const ok = await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "message", sessionId: "s-1", text: "hello floor" }), own);
	assert.equal(ok.status, 202);
	assert.equal(consumeTowerActions(hub, "s-1").length, 1);
	assert.equal((await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "shell", sessionId: "s-1" }), own)).status, 400);
	assert.equal((await post(s.port, "/tok-123/api/action", "{nope", own)).status, 400);
	assert.equal((await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "message", sessionId: "s-1", text: "hi" }), {})).status, 403);
	assert.equal((await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "message", sessionId: "s-1", text: "hi" }), { Origin: "https://evil.example" })).status, 403);
	assert.equal((await post(s.port, "/wrong/api/action", JSON.stringify({ type: "message", sessionId: "s-1", text: "hi" }), own)).status, 403);
	assert.equal((await post(s.port, "/tok-123/api/action", "x".repeat(TOWER_ACTION_MAX_BYTES + 10), own)).status, 413);
	assert.equal(existsSync(towerInboxDir(hub, "s-1")) ? readdirSync(towerInboxDir(hub, "s-1")).length : 0, 0);
});

// ---------- new floor: a new Gentle Shell session in a project already in the tower ----------
import { EventEmitter } from "node:events";
import { buildLaunchScript, launchInTerminal, shellQuote } from "../lib/tower-launch.ts";
import { buildTowerSnapshot } from "../lib/tower-snapshot.ts";
import { writeTowerSnapshot } from "../lib/tower-hub.ts";

test("a new floor parses with a project path and an optional first message", () => {
	assert.deepEqual(parseTowerAction({ type: "new-floor", project: "/w/app", prompt: " fix the login " }), { type: "new-floor", project: "/w/app", prompt: "fix the login" });
	assert.deepEqual(parseTowerAction({ type: "new-floor", project: "/w/app" }), { type: "new-floor", project: "/w/app" });
	for (const bad of [{ type: "new-floor", project: "relative/path" }, { type: "new-floor", project: "/w/app", prompt: "x".repeat(4001) }, { type: "new-floor" }, { type: "new-floor", project: "/w/app\nrm" }])
		assert.equal(parseTowerAction(bad), undefined, JSON.stringify(bad));
});

test("the launch script quotes everything; a hostile message stays one argument", () => {
	assert.equal(shellQuote("it's"), `'it'\\''s'`);
	const script = buildLaunchScript({ cwd: "/w/my app", node: "/usr/bin/node", launcher: "/pkg/bin/gentle-shell.mjs", prompt: "'; rm -rf ~; echo '" });
	assert.equal(script, `#!/bin/sh\nrm -f "$0"\ncd '/w/my app' && exec '/usr/bin/node' '/pkg/bin/gentle-shell.mjs' '--' '--' ''\\''; rm -rf ~; echo '\\'''\n`);
	assert.equal(buildLaunchScript({ cwd: "/w/a", node: "/n", launcher: "/l" }), `#!/bin/sh\nrm -f "$0"\ncd '/w/a' && exec '/n' '/l'\n`);
});

test("the server opens a floor only in a project already in the tower", async () => {
	const { hub, web } = scratch();
	writeTowerSnapshot(hub, buildTowerSnapshot({ sessionId: "s-1", cwd: "/w/app", stats: { cost: 0, input: 0, output: 0 }, todos: [], agents: [], now: 1 }));
	const opened: Array<[string, string | undefined]> = [];
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", onNewFloor: async (cwd, prompt) => { opened.push([cwd, prompt]); } });
	servers.push(s);
	const own = { Origin: `http://127.0.0.1:${s.port}` };
	assert.equal((await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "new-floor", project: "/w/app", prompt: "fix it" }), own)).status, 202);
	assert.equal((await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "new-floor", project: "/etc" }), own)).status, 403);
	assert.equal((await post(s.port, "/tok-123/api/action", JSON.stringify({ type: "new-floor", project: "/w/app" }), {})).status, 403);
	assert.deepEqual(opened, [["/w/app", "fix it"]]);
});

const spec = { cwd: "/w/a", node: "/n", launcher: "/l" };
function fakeSpawn(events: Array<[string, unknown]>) {
	const calls: Array<[string, string[]]> = [];
	const fn = ((cmd: string, args: string[]) => {
		calls.push([cmd, args]);
		const child = Object.assign(new EventEmitter(), { unref() {} });
		setTimeout(() => { for (const [name, value] of events) child.emit(name, value); }, 5);
		return child;
	}) as unknown as typeof import("node:child_process").spawn;
	return { fn, calls };
}

test("opening a floor rejects, never throws, when its script cannot be written", async () => {
	const { root } = scratch();
	let launched: Promise<void> | undefined;
	assert.doesNotThrow(() => { launched = launchInTerminal(spec, { tmpRoot: join(root, "missing", "dir"), spawn: fakeSpawn([["spawn", undefined]]).fn }); });
	await assert.rejects(launched!);
});

test("on macOS a floor opens only when `open` exits 0", async () => {
	const { root } = scratch();
	const bad = fakeSpawn([["spawn", undefined], ["exit", 1]]);
	await assert.rejects(launchInTerminal(spec, { tmpRoot: root, platform: "darwin", spawn: bad.fn }), /exited with 1/);
	assert.equal(bad.calls[0][0], "open");
	const good = fakeSpawn([["spawn", undefined], ["exit", 0]]);
	await launchInTerminal(spec, { tmpRoot: root, platform: "darwin", spawn: good.fn });
	assert.deepEqual(good.calls[0][1].slice(0, 2), ["-a", "Terminal"]);
	const missing = fakeSpawn([["error", new Error("ENOENT")]]);
	await assert.rejects(launchInTerminal(spec, { tmpRoot: root, platform: "darwin", spawn: missing.fn }), /ENOENT/);
});

test("on Linux the terminal itself keeps running, so starting it is enough", async () => {
	const { root } = scratch();
	const term = fakeSpawn([["spawn", undefined]]);
	await launchInTerminal(spec, { tmpRoot: root, platform: "linux", spawn: term.fn });
	assert.equal(term.calls[0][0], "x-terminal-emulator");
});

test("an action bigger than the inbox limit is refused before it is written", () => {
	const { hub } = scratch();
	assert.throws(() => writeTowerAction(hub, { type: "message", sessionId: "s-1", text: "漢".repeat(4000) }), /too large/);
	assert.equal(existsSync(towerInboxDir(hub, "s-1")) ? readdirSync(towerInboxDir(hub, "s-1")).length : 0, 0);
	writeTowerAction(hub, { type: "message", sessionId: "s-1", text: "漢".repeat(2000) });
	assert.deepEqual(consumeTowerActions(hub, "s-1").map((a) => a.type === "message" && a.text.length), [2000]);
});
