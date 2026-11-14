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
	assert.deepEqual(parseTowerAction({ type: "permission", sessionId: "s-1", mode: "normal" }), { type: "permission", sessionId: "s-1", mode: "normal" });
	assert.deepEqual(parseTowerAction({ type: "review", sessionId: "s-1", enabled: false }), { type: "review", sessionId: "s-1", enabled: false });
	for (const bad of [
		null, "x", {}, { type: "shell", sessionId: "s-1", command: "rm -rf /" },
		{ type: "message", sessionId: "../x", text: "hi" }, { type: "message", sessionId: "s-1", text: "" },
		{ type: "message", sessionId: "s-1", text: "x".repeat(4001) }, { type: "cancel-helper", sessionId: "s-1" },
		{ type: "permission", sessionId: "s-1", mode: "root" }, { type: "review", sessionId: "s-1", enabled: "yes" },
		{ type: "message", sessionId: "s-1", text: "hi", extra: 1 }, { type: "answer", sessionId: "s-1", answer: "x" },
		{ type: "permission", sessionId: "s-1", mode: "super-yolo" }, { type: "permission", sessionId: "s-1", mode: "yolo" },
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
