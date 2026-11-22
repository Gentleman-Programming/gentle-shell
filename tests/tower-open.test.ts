import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { openTowerServer, runTower, TOWER_WEB_DIR } from "../lib/tower-open.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function scratch(): string {
	const r = mkdtempSync(join(tmpdir(), "gentle-tower-open-"));
	roots.push(r);
	return r;
}
function builtWeb(root: string): string {
	const web = join(root, "web");
	mkdirSync(web, { recursive: true });
	writeFileSync(join(web, "index.html"), "<title>Gentle Tower</title>");
	return web;
}
const URL_SHAPE = /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32,}\/$/;

test("the default web dir is the package's built web app", () => {
	assert.match(TOWER_WEB_DIR, /web[\\/]tower[\\/]dist$/);
});

test("openTowerServer refuses a web app that is not built, with the exact message", async () => {
	const root = scratch();
	const missing = join(root, "missing");
	await assert.rejects(openTowerServer({ GENTLE_TOWER_HOME: join(root, "hub") }, { webDir: missing, presenceDirs: [] }),
		{ message: `Gentle Tower: the web app is not built (${missing}). Run: pnpm build:tower` });
});

test("openTowerServer serves a built web app on 127.0.0.1 behind a fresh token", async () => {
	const root = scratch();
	const server = await openTowerServer({ GENTLE_TOWER_HOME: join(root, "hub") }, { webDir: builtWeb(root), presenceDirs: [] });
	try {
		assert.equal(server.host, "127.0.0.1");
		assert.match(server.url, URL_SHAPE);
		const page = await fetch(server.url);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /Gentle Tower/);
	} finally {
		await server.close();
	}
});

test("runTower prints the not-built message to stderr and exits 1", async () => {
	const root = scratch();
	const missing = join(root, "missing");
	const out: string[] = [], err: string[] = [], opened: string[] = [];
	const code = await runTower({ env: { GENTLE_TOWER_HOME: join(root, "hub") }, open: true, webDir: missing, presenceDirs: [],
		stdout: (s) => out.push(s), stderr: (s) => err.push(s), openUrl: (u) => opened.push(u), untilStopped: async () => {} });
	assert.equal(code, 1);
	assert.deepEqual(out, []);
	assert.deepEqual(opened, []);
	assert.equal(err.join(""), `Gentle Tower: the web app is not built (${missing}). Run: pnpm build:tower\n`);
});

test("runTower prints the URL, opens it, serves until stopped, then closes", async () => {
	const root = scratch();
	const out: string[] = [], err: string[] = [], opened: string[] = [];
	let url = "";
	const code = await runTower({ env: { GENTLE_TOWER_HOME: join(root, "hub") }, open: true, webDir: builtWeb(root), presenceDirs: [],
		stdout: (s) => out.push(s), stderr: (s) => err.push(s), openUrl: (u) => opened.push(u),
		untilStopped: async (s) => { url = s.url; assert.equal((await fetch(s.url)).status, 200); } });
	assert.equal(code, 0);
	assert.deepEqual(err, []);
	assert.match(url, URL_SHAPE);
	assert.deepEqual(opened, [url]);
	assert.equal(out.join(""), `Gentle Tower: ${url}\nPress Ctrl+C to stop.\n`);
	await assert.rejects(fetch(url), "the server is closed after stopping");
});

test("runTower --no-open only prints the URL, and honours a fixed port", async () => {
	const root = scratch();
	const probe = await openTowerServer({ GENTLE_TOWER_HOME: join(root, "hub") }, { webDir: builtWeb(root), presenceDirs: [] });
	const port = probe.port;
	await probe.close();
	const out: string[] = [], opened: string[] = [];
	let url = "";
	const code = await runTower({ env: { GENTLE_TOWER_HOME: join(root, "hub") }, open: false, port, webDir: join(root, "web"), presenceDirs: [],
		stdout: (s) => out.push(s), stderr: () => {}, openUrl: (u) => opened.push(u), untilStopped: async (s) => { url = s.url; } });
	assert.equal(code, 0);
	assert.deepEqual(opened, []);
	assert.ok(url.startsWith(`http://127.0.0.1:${port}/`), url);
	assert.match(out.join(""), new RegExp(`^Gentle Tower: http://127\\.0\\.0\\.1:${port}/`));
});

test("runTower --json prints one JSON line with the URL instead of the text lines", async () => {
	const root = scratch();
	const out: string[] = [], err: string[] = [], opened: string[] = [];
	let server = { url: "", port: 0 };
	const code = await runTower({ env: { GENTLE_TOWER_HOME: join(root, "hub") }, open: false, json: true, webDir: builtWeb(root), presenceDirs: [],
		stdout: (s) => out.push(s), stderr: (s) => err.push(s), openUrl: (u) => opened.push(u),
		untilStopped: async (s) => { server = { url: s.url, port: s.port }; } });
	assert.equal(code, 0);
	assert.deepEqual(err, []);
	assert.deepEqual(opened, []);
	assert.match(server.url, URL_SHAPE);
	assert.equal(out.join(""), `${JSON.stringify({ schema: "gentle-shell.tower/v1", url: server.url, host: "127.0.0.1", port: server.port })}\n`);
});

test("runTower --json still reports a start failure as text on stderr and exits 1", async () => {
	const root = scratch();
	const out: string[] = [], err: string[] = [];
	const code = await runTower({ env: { GENTLE_TOWER_HOME: join(root, "hub") }, open: false, json: true, webDir: join(root, "missing-web"), presenceDirs: [],
		stdout: (s) => out.push(s), stderr: (s) => err.push(s), untilStopped: async () => {} });
	assert.equal(code, 1);
	assert.deepEqual(out, []);
	assert.equal(err.length, 1);
});

test("the package check needs the built tower only when packing after a build", async () => {
	const { packageRequiredPaths, requiredPaths: base } = await import("../scripts/verify-package-files.mjs");
	assert.ok(!base.includes("web/tower/dist/index.html"), "a plain check (tests, CI) never needs the gitignored build");
	assert.ok(!packageRequiredPaths(["node", "verify"]).includes("web/tower/dist/index.html"));
	assert.ok(packageRequiredPaths(["node", "verify", "--with-built-web"]).includes("web/tower/dist/index.html"));
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const hook of ["prepack", "prepublishOnly"]) assert.match(pkg.scripts[hook], /build:tower && node scripts\/verify-package-files\.mjs --with-built-web/);
});
