import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { artifactsFromBranch, buildTowerSnapshot } from "../lib/tower-snapshot.ts";
import { writeTowerSnapshot } from "../lib/tower-hub.ts";
import { startTowerServer, type TowerServer } from "../lib/tower-server.ts";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });

const call = (id: string, name: string, path: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { path } }] } });
const result = (id: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "write", isError } });

test("artifacts are the docs, diagrams and images the session wrote successfully", () => {
	const list = artifactsFromBranch([
		call("1", "write", "docs/plan.md"), result("1"),
		call("2", "edit", "/abs/flow.mmd"), result("2"),
		call("3", "write", "src/app.ts"), result("3"),
		call("4", "write", "shot.png"), result("4", true),
		call("5", "write", "logo.svg"), result("5"),
		call("6", "edit", "docs/plan.md"), result("6"),
		call("7", "read", "notes.md"),
	], "/w/app");
	// newest first: plan.md was edited last (call 6)
	assert.deepEqual(list, [
		{ path: "/w/app/docs/plan.md", kind: "doc" },
		{ path: "/w/app/logo.svg", kind: "image" },
		{ path: "/abs/flow.mmd", kind: "diagram" },
	]);
});

function get(port: number, path: string): Promise<{ status: number; body: string; type?: string; csp?: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path }, (res) => {
			let b = ""; res.on("data", (c) => (b += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, type: res.headers["content-type"], csp: String(res.headers["content-security-policy"] ?? "") }));
		});
		req.on("error", reject); req.end();
	});
}

async function setup(engramUrl?: string) {
	const root = mkdtempSync(join(tmpdir(), "gentle-tower-art-"));
	roots.push(root);
	const project = join(root, "project");
	mkdirSync(join(project, "docs"), { recursive: true });
	writeFileSync(join(project, "docs", "plan.md"), "# Plan\n- step");
	writeFileSync(join(project, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
	writeFileSync(join(project, "secret.md"), "not listed");
	writeFileSync(join(root, "outside.md"), "outside the project");
	symlinkSync(join(root, "outside.md"), join(project, "docs", "link.md"));
	const hub = join(root, "sessions");
	const web = join(root, "web");
	mkdirSync(web);
	writeFileSync(join(web, "index.html"), "<title>t</title>");
	writeTowerSnapshot(hub, buildTowerSnapshot({
		sessionId: "s-1", cwd: project, stats: { cost: 0, input: 0, output: 0 }, todos: [], agents: [], now: 1,
		models: [{ model: "claude-opus-5-5", cost: 0.4, tokens: 1000 }],
		artifacts: [{ path: join(project, "docs", "plan.md"), kind: "doc" }, { path: join(project, "logo.svg"), kind: "image" }, { path: join(project, "docs", "link.md"), kind: "doc" }, { path: join(root, "outside.md"), kind: "doc" }],
	}));
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", ...(engramUrl ? { engramUrl } : {}) });
	closers.push(() => s.close());
	return { s, project, root };
}

test("only artifacts the session wrote are served, never through a symlink", async () => {
	const { s, project, root } = await setup();
	const q = (p: string) => `/tok-123/api/artifact?session=s-1&path=${encodeURIComponent(p)}`;
	const doc = await get(s.port, q(join(project, "docs", "plan.md")));
	assert.equal(doc.status, 200);
	assert.equal(doc.body, "# Plan\n- step");
	assert.match(doc.type ?? "", /text\/plain/);
	const svg = await get(s.port, q(join(project, "logo.svg")));
	assert.equal(svg.status, 200);
	assert.match(svg.type ?? "", /image\/svg\+xml/);
	assert.match(svg.csp ?? "", /sandbox/);
	assert.equal((await get(s.port, q(join(project, "secret.md")))).status, 404, "not listed");
	assert.equal((await get(s.port, q(join(project, "docs", "link.md")))).status, 404, "symlink out of the project");
	// Sessions write into other worktrees and repos; what they listed themselves is theirs to show.
	const outside = await get(s.port, q(join(root, "outside.md")));
	assert.equal(outside.status, 200, "listed and written outside the session folder");
	assert.equal(outside.body, "outside the project");
	assert.equal((await get(s.port, `/tok-123/api/artifact?session=nope&path=${encodeURIComponent(join(project, "docs", "plan.md"))}`)).status, 404);
	assert.equal((await get(s.port, `/wrong/api/artifact?session=s-1&path=x`)).status, 403);
});

test("the snapshot carries per-model spend for the bar tab", async () => {
	const s = buildTowerSnapshot({ sessionId: "s", cwd: "/w/a", stats: { cost: 0, input: 0, output: 0 }, todos: [], agents: [], now: 1, models: [{ model: "m1", cost: 0.25, tokens: 10 }] });
	assert.deepEqual(s.models, [{ model: "m1", cost: 0.25, tokens: 10 }]);
});

test("memory is a read-only window on the local Engram", async () => {
	const seen: string[] = [];
	const engram: Server = createServer((req, res) => {
		seen.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(req.url?.startsWith("/search") ? JSON.stringify([{ id: 1, type: "decision", title: "Re-arm the timer", content: "**What**: x", created_at: "2026-11-14", project: "app" }]) : JSON.stringify({ count: 1, observations: [{ id: 2, type: "preference", title: "Calm UI", project: "app" }] }));
	});
	await new Promise<void>((r) => engram.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => engram.close(() => r())));
	const port = (engram.address() as { port: number }).port;
	const { s } = await setup(`http://127.0.0.1:${port}`);
	const search = await get(s.port, "/tok-123/api/memory/search?project=app&q=timer");
	assert.equal(search.status, 200);
	assert.equal(JSON.parse(search.body)[0].title, "Re-arm the timer");
	const review = await get(s.port, "/tok-123/api/memory/review?project=app");
	assert.equal(JSON.parse(review.body).observations[0].title, "Calm UI");
	assert.equal((await get(s.port, "/tok-123/api/memory/delete?id=1")).status, 404);
	assert.deepEqual(seen, ["GET /search?q=timer&project=app&limit=40", "GET /review?project=app&limit=40"]);
});
