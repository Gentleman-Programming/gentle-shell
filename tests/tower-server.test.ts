import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { startTowerServer, type TowerServer } from "../lib/tower-server.ts";
import { writeTowerSnapshot } from "../lib/tower-hub.ts";
import { buildTowerSnapshot } from "../lib/tower-snapshot.ts";

const roots: string[] = [];
const servers: TowerServer[] = [];
after(async () => { for (const s of servers) await s.close(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });

function setup() {
	const root = mkdtempSync(join(tmpdir(), "gentle-tower-srv-"));
	roots.push(root);
	const hub = join(root, "sessions");
	const web = join(root, "web");
	mkdirSync(web);
	writeFileSync(join(web, "index.html"), "<!doctype html><title>Gentle Tower</title>");
	writeFileSync(join(root, "secret.txt"), "do not serve");
	return { hub, web, root };
}
const snap = (id: string, name: string) => buildTowerSnapshot({ sessionId: id, sessionName: name, cwd: "/w/gentle-ai", stats: { cost: 0.1, input: 1, output: 1 }, todos: [], agents: [], now: 1 });

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; type?: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body, type: res.headers["content-type"] }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function start(hub: string, web: string) {
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", pollMs: 50 });
	servers.push(s);
	return s;
}

test("binds to localhost and serves the app only with the token", async () => {
	const { hub, web } = setup();
	const s = await start(hub, web);
	assert.equal(s.host, "127.0.0.1");
	assert.ok(s.port > 0);
	assert.equal(s.url, `http://127.0.0.1:${s.port}/tok-123/`);
	assert.equal((await get(s.port, "/")).status, 403);
	assert.equal((await get(s.port, "/wrong/")).status, 403);
	assert.equal((await get(s.port, "/?t=tok-123")).status, 403);
	const ok = await get(s.port, "/tok-123/");
	assert.equal(ok.status, 200);
	assert.match(ok.body, /Gentle Tower/);
	assert.match(ok.type ?? "", /text\/html/);
});

test("app assets are served under the token path with their real type", async () => {
	const { hub, web } = setup();
	mkdirSync(join(web, "assets"));
	writeFileSync(join(web, "assets", "app.css"), "body{}");
	writeFileSync(join(web, "assets", "app.js"), "export {}");
	const s = await start(hub, web);
	assert.match((await get(s.port, "/tok-123/assets/app.css")).type ?? "", /text\/css/);
	assert.match((await get(s.port, "/tok-123/assets/app.js")).type ?? "", /javascript/);
	assert.equal((await get(s.port, "/assets/app.js")).status, 403);
	assert.equal((await get(s.port, "/tok-123")).status, 308);
});

test("the API lists every published floor", async () => {
	const { hub, web } = setup();
	writeTowerSnapshot(hub, snap("s-1", "Token refresh fix"));
	writeTowerSnapshot(hub, snap("s-2", "Release notes"));
	const s = await start(hub, web);
	const r = await get(s.port, "/tok-123/api/sessions");
	assert.equal(r.status, 200);
	assert.deepEqual(JSON.parse(r.body).sessions.map((x: { name: string }) => x.name), ["Token refresh fix", "Release notes"]);
	assert.equal((await get(s.port, "/api/sessions")).status, 403);
});

test("a foreign Origin is refused even with the token", async () => {
	const { hub, web } = setup();
	const s = await start(hub, web);
	assert.equal((await get(s.port, "/tok-123/api/sessions", { Origin: "https://evil.example" })).status, 403);
	assert.equal((await get(s.port, "/tok-123/api/sessions", { Origin: `http://127.0.0.1:${s.port}` })).status, 200);
});

test("static files never escape the web folder", async () => {
	const { hub, web } = setup();
	const s = await start(hub, web);
	for (const path of ["/tok-123/../secret.txt", "/tok-123/%2e%2e/secret.txt", "/tok-123/..%2fsecret.txt", "/tok-123/%2e%2e%2fsecret.txt"]) {
		const r = await get(s.port, path);
		assert.notEqual(r.status, 200, path);
		assert.doesNotMatch(r.body, /do not serve/);
	}
});

test("the event stream pushes a fresh list when a floor changes", async () => {
	const { hub, web } = setup();
	writeTowerSnapshot(hub, snap("s-1", "First"));
	const s = await start(hub, web);
	const lines: string[] = [];
	await new Promise<void>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: s.port, path: "/tok-123/api/events" }, (res) => {
			assert.equal(res.statusCode, 200);
			assert.match(String(res.headers["content-type"]), /text\/event-stream/);
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				lines.push(chunk);
				const all = lines.join("");
				if (all.includes("First") && !all.includes("Second")) writeTowerSnapshot(hub, snap("s-2", "Second"));
				if (all.includes("Second")) { req.destroy(); resolve(); }
			});
		});
		req.on("error", (e) => (String(e).includes("socket hang up") ? resolve() : reject(e)));
		req.end();
		setTimeout(() => reject(new Error("no update")), 3000).unref();
	});
	assert.match(lines.join(""), /data: .*Second/);
});
