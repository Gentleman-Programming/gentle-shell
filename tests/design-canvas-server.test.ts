import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { designCommentBatchContent, designCommentContent, describeWatchFailure, formatDesignComment, formatDesignCommentBatch, startDesignCanvasServer, type DesignCanvasServerOptions, type DesignComment, type DesignImplementPartRequest } from "../lib/design-canvas-server.ts";

const TOKEN = "test-token-0123456789abcdef";
const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));

// gentle-shell#3156: when the host's inotify limit is exhausted, fs.watch cannot register and the
// server's change events never fire; the server now says so per stream, and the tests that wait
// for those events skip naming the environment instead of failing like a canvas regression.
function probeFsWatch(): boolean {
	const dir = mkdtempSync(join(tmpdir(), "fs-watch-probe-"));
	try {
		watch(dir, { persistent: false }, () => {}).close();
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const FS_WATCH_AVAILABLE = probeFsWatch();
const FS_WATCH_SKIP = "fs.watch unavailable: inotify watch limit exhausted (ENOSPC); canvas change events cannot be observed on this host";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string; bytes: Buffer };
type Options = { method?: string; headers?: Record<string, string>; body?: string; host?: string | null };

function rawRequest(port: number, path: string, options: Options = {}): Promise<Reply> {
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (options.host !== null) headers.Host = options.host ?? `127.0.0.1:${port}`;
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers, setHost: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: bytes.toString("utf8"), bytes }); });
			res.on("error", reject);
		});
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

function manifest(title: string, files: string[]) {
	return JSON.stringify({
		title,
		brief: `${title} brief`,
		artboards: files.map((file, index) => ({ file, title: `Direction ${index + 1}`, tradeoff: `Tradeoff ${index + 1}`, width: 1280, height: 800 })),
	});
}

/** A `mktemp -d` style directory removed when the test ends. */
function scratch(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fixture(t: TestContext) {
	const root = scratch(t, "gentle-design-canvas-");
	const outside = scratch(t, "gentle-design-outside-");
	writeFileSync(join(outside, "secret.html"), "<p>secret</p>");
	const alpha = join(root, "alpha");
	mkdirSync(join(alpha, "sub"), { recursive: true });
	writeFileSync(join(alpha, "design.json"), manifest("Alpha", ["01-hero.html", "02-bare.html"]));
	writeFileSync(join(alpha, "01-hero.html"), "<!doctype html><html><body><h1>Hero</h1></body></html>");
	writeFileSync(join(alpha, "02-bare.html"), "<h1>Bare</h1>");
	writeFileSync(join(alpha, "styles.css"), "h1{color:red}");
	writeFileSync(join(alpha, "logo.svg"), "<svg></svg>");
	writeFileSync(join(alpha, "notes.txt"), "not served");
	writeFileSync(join(alpha, "sub", "inner.html"), "<p>inner</p>");
	symlinkSync(join(outside, "secret.html"), join(alpha, "escape.html"));
	symlinkSync(outside, join(alpha, "linkdir"));
	symlinkSync(join(alpha, "01-hero.html"), join(alpha, "alias.html"));
	mkdirSync(join(root, "beta"));
	writeFileSync(join(root, "beta", "design.json"), manifest("Beta", ["01-a.html"]));
	writeFileSync(join(root, "beta", "01-a.html"), "<p>beta</p>");
	mkdirSync(join(root, "broken"));
	writeFileSync(join(root, "broken", "design.json"), "{ not json");
	mkdirSync(join(root, "Not_A_Slug"));
	writeFileSync(join(root, "Not_A_Slug", "design.json"), manifest("Ignored", ["01-a.html"]));
	utimesSync(join(alpha, "design.json"), 3000, 3000);
	utimesSync(join(root, "broken", "design.json"), 2000, 2000);
	utimesSync(join(root, "beta", "design.json"), 1000, 1000);
	return { root, outside };
}

async function start(t: TestContext, extra: { initialSlug?: string; onComment?: DesignCanvasServerOptions["onComment"]; onImplement?: DesignCanvasServerOptions["onImplement"]; onVariant?: DesignCanvasServerOptions["onVariant"]; onImplementPart?: DesignCanvasServerOptions["onImplementPart"] } = {}) {
	const { root } = fixture(t);
	const comments: DesignComment[] = [];
	const batches: DesignComment[][] = [];
	const implements_: Array<{ slug: string; file: string }> = [];
	const variants: Array<{ slug: string; file: string; instruction: string }> = [];
	const parts: DesignImplementPartRequest[] = [];
	const server = await startDesignCanvasServer({
		designRoot: root,
		onComment: (comment) => { comments.push(comment); },
		onComments: (batch) => { batches.push(batch); },
		onImplement: (request) => { implements_.push(request); },
		onVariant: (request) => { variants.push(request); },
		onImplementPart: (request) => { parts.push(request); },
		randomToken: () => TOKEN,
		...extra,
	});
	t.after(() => server.close());
	return { server, root, comments, batches, implements: implements_, variants, parts, port: server.port, base: `/${TOKEN}/` };
}

test("start returns a loopback URL with a random base64url token by default", async (t) => {
	const { root } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => {} });
	t.after(() => server.close());
	assert.match(server.token, /^[A-Za-z0-9_-]{32}$/);
	assert.equal(server.url, `http://127.0.0.1:${server.port}/${server.token}/`);
	const withSlug = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, initialSlug: "alpha" });
	t.after(() => withSlug.close());
	assert.notEqual(withSlug.token, server.token);
	assert.equal(withSlug.url, `http://127.0.0.1:${withSlug.port}/${withSlug.token}/d/alpha/`);
	await assert.rejects(startDesignCanvasServer({ designRoot: root, onComment: () => {}, initialSlug: "../x" }));
	await assert.rejects(startDesignCanvasServer({ designRoot: "relative/design", onComment: () => {} }));
});

test("every route needs the token and anything else is 404", async (t) => {
	const { port } = await start(t);
	for (const path of ["/", "/api/designs", "/wrong-token/", `/${TOKEN.slice(0, -1)}/`, `/${TOKEN}x/api/designs`, `/${TOKEN}/unknown`]) {
		assert.equal((await rawRequest(port, path)).status, 404, path);
	}
	assert.equal((await rawRequest(port, `/${TOKEN}/`)).status, 200);
});

test("a foreign or missing Host header is rejected", async (t) => {
	const { port, base } = await start(t);
	assert.equal((await rawRequest(port, base, { host: `evil.example:${port}` })).status, 421);
	assert.equal((await rawRequest(port, base, { host: `127.0.0.1:${port + 1}` })).status, 421);
	assert.equal((await rawRequest(port, base, { host: "127.0.0.1" })).status, 421);
	assert.equal((await rawRequest(port, base, { host: null })).status, 421);
	assert.equal((await rawRequest(port, base, { host: `localhost:${port}` })).status, 200);
});

test("a GET carrying a foreign Origin is rejected", async (t) => {
	const { port, base } = await start(t);
	assert.equal((await rawRequest(port, `${base}api/designs`, { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await rawRequest(port, `${base}api/designs`, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test("sandboxed artboards load their subresources with Origin null, but nothing else accepts it", async (t) => {
	// Chrome sends `Origin: null` for script requests from an opaque-origin (sandboxed) artboard.
	const { port, base } = await start(t);
	const nullOrigin = { headers: { Origin: "null" } };
	for (const path of ["assets/inspector.js", "files/alpha/01-hero.html", "files/alpha/styles.css", "files/alpha/logo.svg"]) {
		assert.equal((await rawRequest(port, `${base}${path}`, nullOrigin)).status, 200, path);
	}
	for (const path of ["", "d/alpha/", "assets/canvas.js", "assets/canvas.css", "api/designs", "api/designs/alpha", "events"]) {
		assert.equal((await rawRequest(port, `${base}${path}`, nullOrigin)).status, 403, path);
	}
	assert.equal((await rawRequest(port, `${base}assets/inspector.js`, { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await rawRequest(port, `${base}files/alpha/01-hero.html`, { headers: { Origin: "http://evil.example" } })).status, 403);
	// Every canvas asset behaves like canvas.js at the Origin gate; only inspector.js runs inside the sandbox.
	for (const name of Object.keys(DESIGN_CANVAS_ASSETS)) {
		assert.equal((await rawRequest(port, `${base}assets/${name}`, nullOrigin)).status, name === "inspector.js" ? 200 : 403, name);
	}
});

test("the canvas page carries a strict CSP and a JSON config, never inline code", async (t) => {
	const { port, base } = await start(t);
	const page = await rawRequest(port, base);
	assert.equal(page.status, 200);
	assert.match(String(page.headers["content-type"]), /^text\/html/);
	assert.equal(page.headers["cache-control"], "no-store");
	assert.equal(page.headers["x-content-type-options"], "nosniff");
	const csp = String(page.headers["content-security-policy"]);
	for (const directive of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive), directive);
	assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
	const config = /<script id="gd-config" type="application\/json">([^<]*)<\/script>/.exec(page.body);
	assert.ok(config, "config script present");
	assert.deepEqual(JSON.parse(config[1]), { base, slug: null, delivery: { comment: true, batch: true, implement: true, variant: true, part: true } });
	assert.ok(page.body.includes(`src="${base}assets/canvas.js"`));
	const slugPage = await rawRequest(port, `${base}d/alpha/`);
	assert.equal(slugPage.status, 200);
	assert.deepEqual(JSON.parse(/<script id="gd-config" type="application\/json">([^<]*)<\/script>/.exec(slugPage.body)![1]), { base, slug: "alpha", delivery: { comment: true, batch: true, implement: true, variant: true, part: true } });
	assert.equal((await rawRequest(port, `${base}d/Bad_Slug/`)).status, 404);
	assert.equal((await rawRequest(port, `${base}d/alpha/extra`)).status, 404);
	assert.equal((await rawRequest(port, base, { method: "POST" })).status, 405);
});

test("only the fixed canvas assets are served", async (t) => {
	const { port, base } = await start(t);
	const js = await rawRequest(port, `${base}assets/canvas.js`);
	assert.equal(js.status, 200);
	assert.match(String(js.headers["content-type"]), /^text\/javascript/);
	assert.equal(js.body, readFileSync(join(ASSET_DIR, "canvas.js"), "utf8"));
	assert.match(String((await rawRequest(port, `${base}assets/canvas.css`)).headers["content-type"]), /^text\/css/);
	assert.equal((await rawRequest(port, `${base}assets/inspector.js`)).status, 200);
	for (const name of ["index.html", "missing.js", "..%2Fpackage.json", "%2e%2e", "canvas.js/x"]) {
		assert.equal((await rawRequest(port, `${base}assets/${name}`)).status, 404, name);
	}
	for (const [name, type] of Object.entries(DESIGN_CANVAS_ASSETS)) {
		const asset = await rawRequest(port, `${base}assets/${name}`);
		assert.equal(asset.status, 200, name);
		assert.equal(asset.headers["content-type"], type, name);
		assert.deepEqual(asset.bytes, readFileSync(join(ASSET_DIR, name)), `${name} is served byte for byte`);
	}
});

test("designs are listed from design.json manifests, most recent first", async (t) => {
	const { port, base } = await start(t);
	const reply = await rawRequest(port, `${base}api/designs`);
	assert.equal(reply.status, 200);
	assert.match(String(reply.headers["content-type"]), /^application\/json/);
	const designs = JSON.parse(reply.body).designs;
	assert.deepEqual(designs.map((design: { slug: string }) => design.slug), ["alpha", "broken", "beta"]);
	assert.deepEqual(designs[0], { slug: "alpha", title: "Alpha", mtime: 3000000, valid: true });
	assert.deepEqual(designs[1], { slug: "broken", title: "broken", mtime: 2000000, valid: false });
});

test("a manifest is returned normalized, and invalid slugs or manifests are refused", async (t) => {
	const { port, base, root } = await start(t);
	const reply = await rawRequest(port, `${base}api/designs/alpha`);
	assert.equal(reply.status, 200);
	assert.deepEqual(JSON.parse(reply.body), {
		slug: "alpha",
		title: "Alpha",
		brief: "Alpha brief",
		artboards: [
			{ file: "01-hero.html", title: "Direction 1", tradeoff: "Tradeoff 1", width: 1280, height: 800 },
			{ file: "02-bare.html", title: "Direction 2", tradeoff: "Tradeoff 2", width: 1280, height: 800 },
		],
	});
	assert.equal((await rawRequest(port, `${base}api/designs/Alpha`)).status, 404);
	assert.equal((await rawRequest(port, `${base}api/designs/missing`)).status, 404);
	const broken = await rawRequest(port, `${base}api/designs/broken`);
	assert.equal(broken.status, 422);
	assert.match(JSON.parse(broken.body).reason, /JSON/);
	mkdirSync(join(root, "gamma"));
	writeFileSync(join(root, "gamma", "design.json"), JSON.stringify({ title: "G", artboards: [{ file: "../beta/01-a.html", title: "x", width: 10, height: 10 }] }));
	assert.match(JSON.parse((await rawRequest(port, `${base}api/designs/gamma`)).body).reason, /file/);
	writeFileSync(join(root, "gamma", "design.json"), JSON.stringify({ title: "G", artboards: [{ file: "01.html", width: -1, height: 10 }] }));
	assert.equal((await rawRequest(port, `${base}api/designs/gamma`)).status, 422);
	writeFileSync(join(root, "gamma", "design.json"), JSON.stringify({ title: "G", artboards: "nope" }));
	assert.equal((await rawRequest(port, `${base}api/designs/gamma`)).status, 422);
});

test("artboard HTML is served sandboxed with the inspector injected once", async (t) => {
	const { port, base } = await start(t);
	const inspector = `<script src="${base}assets/inspector.js"></script>`;
	const hero = await rawRequest(port, `${base}files/alpha/01-hero.html`);
	assert.equal(hero.status, 200);
	assert.match(String(hero.headers["content-type"]), /^text\/html/);
	assert.equal(hero.headers["x-content-type-options"], "nosniff");
	assert.equal(hero.headers["cache-control"], "no-store");
	assert.match(String(hero.headers["content-security-policy"]), /^sandbox allow-scripts;/);
	assert.match(String(hero.headers["content-security-policy"]), /connect-src 'none'/);
	assert.equal(hero.body, `<!doctype html><html><body><h1>Hero</h1>${inspector}</body></html>`);
	assert.equal((await rawRequest(port, `${base}files/alpha/02-bare.html`)).body, `<h1>Bare</h1>${inspector}`);
	assert.equal((await rawRequest(port, `${base}files/alpha/sub/inner.html`)).status, 200);
	assert.equal((await rawRequest(port, `${base}files/alpha/alias.html`)).status, 200, "a symlink that stays inside the design is allowed");
	const css = await rawRequest(port, `${base}files/alpha/styles.css`);
	assert.equal(css.body, "h1{color:red}");
	assert.match(String(css.headers["content-type"]), /^text\/css/);
	assert.equal((await rawRequest(port, `${base}files/alpha/logo.svg`)).headers["content-type"], "image/svg+xml");
	assert.match(String((await rawRequest(port, `${base}files/alpha/design.json`)).headers["content-type"]), /^application\/json/);
});

test("traversal, symlink escape, directories and disallowed extensions are 404", async (t) => {
	const { port, base } = await start(t);
	const refused = [
		"files/alpha/../beta/01-a.html",
		"files/alpha/%2e%2e/beta/01-a.html",
		"files/alpha/%2E%2E%2Fbeta%2F01-a.html",
		"files/alpha/sub%2Finner.html",
		"files/alpha/..%5Cbeta%5C01-a.html",
		"files/../../etc/passwd",
		"files/alpha/escape.html",
		"files/alpha/linkdir/secret.html",
		"files/alpha/notes.txt",
		"files/alpha/sub",
		"files/alpha/",
		"files/alpha",
		"files/Alpha/01-hero.html",
		"files/missing/01.html",
		"files/alpha/missing.html",
		"files/alpha/.hidden.html",
		"files/alpha/01-hero.html%00.txt",
	];
	for (const path of refused) assert.equal((await rawRequest(port, `${base}${path}`)).status, 404, path);
	assert.equal((await rawRequest(port, `${base}files/alpha/%E0%A4%A`)).status, 400);
});

function postComment(port: number, body: unknown, headers: Record<string, string> = {}) {
	return rawRequest(port, `/${TOKEN}/api/comments`, {
		method: "POST",
		headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const VALID = { slug: "alpha", file: "01-hero.html", selector: "body > h1", excerpt: "Hero", comment: "Make it bigger" };

test("comment POSTs need the exact own Origin and a JSON content type", async (t) => {
	const { port, comments } = await start(t);
	const noOrigin = await rawRequest(port, `/${TOKEN}/api/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(VALID) });
	assert.equal(noOrigin.status, 403);
	assert.equal((await postComment(port, VALID, { Origin: "http://evil.example" })).status, 403);
	assert.equal((await postComment(port, VALID, { Origin: "null" })).status, 403);
	assert.equal((await postComment(port, VALID, { Origin: `http://localhost:${port + 1}` })).status, 403);
	assert.equal((await postComment(port, VALID, { Origin: `http://localhost.evil.test:${port}` })).status, 403);
	assert.equal((await postComment(port, VALID, { "Content-Type": "text/plain" })).status, 415);
	assert.equal((await postComment(port, VALID, { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
	assert.equal((await rawRequest(port, `/${TOKEN}/api/comments`)).status, 405);
	assert.deepEqual(comments, []);
});

test("comment bodies and fields are bounded and validated", async (t) => {
	const { port, comments } = await start(t);
	assert.equal((await postComment(port, { ...VALID, comment: "x".repeat(17 * 1024) })).status, 413);
	assert.equal((await postComment(port, "{ nope")).status, 400);
	assert.equal((await postComment(port, "[]")).status, 400);
	const invalid = [
		{ ...VALID, comment: "   " },
		{ ...VALID, comment: "x".repeat(2001) },
		{ ...VALID, comment: 7 },
		{ ...VALID, selector: "" },
		{ ...VALID, selector: "a".repeat(501) },
		{ ...VALID, slug: "Alpha" },
		{ ...VALID, slug: "missing" },
		{ ...VALID, file: "../beta/01-a.html" },
		{ ...VALID, file: "missing.html" },
		{ ...VALID, file: "styles.css" },
		{ ...VALID, file: "escape.html" },
		{ ...VALID, excerpt: 5 },
	];
	for (const body of invalid) assert.equal((await postComment(port, body)).status, 400, JSON.stringify(body).slice(0, 80));
	assert.deepEqual(comments, []);
});

test("a valid comment is accepted with 202 and delivered trimmed and bounded", async (t) => {
	const { port, comments } = await start(t);
	const reply = await postComment(port, {
		slug: "alpha",
		file: "sub/inner.html",
		selector: "  body > main:nth-of-type(2)\n  > h1  ",
		excerpt: `  Hello\n\n   world ${"y".repeat(400)}`,
		comment: "  Use the brand color\r\nand a larger title  ",
	}, { "Content-Type": "application/json; charset=utf-8" });
	assert.equal(reply.status, 202);
	assert.equal(comments.length, 1);
	const { id, ...delivered } = comments[0];
	assert.match(id, /^[a-z0-9]{6,12}$/);
	assert.deepEqual(JSON.parse(reply.body), { ok: true, id, sent: true });
	assert.deepEqual(delivered, {
		slug: "alpha",
		file: "sub/inner.html",
		selector: "body > main:nth-of-type(2) > h1",
		excerpt: `Hello world ${"y".repeat(400)}`.slice(0, 300),
		comment: "Use the brand color\nand a larger title",
	});
	assert.equal((await postComment(port, { ...VALID, excerpt: undefined })).status, 202);
	assert.equal(comments[1].excerpt, "");
});

type Stored = { id: string; file: string; selector: string; excerpt: string; comment: string; status: string; sentAt: string | null; resolvedAt: string | null };

function storedComments(root: string, slug = "alpha"): Stored[] {
	return JSON.parse(readFileSync(join(root, slug, "comments.json"), "utf8")).comments;
}

test("a failing onComment yields 500, keeps the comment saved and unsent, and the server survives", async (t) => {
	const { root } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => { throw new Error("boom"); }, randomToken: () => TOKEN });
	t.after(() => server.close());
	const reply = await postComment(server.port, VALID);
	assert.equal(reply.status, 500);
	const [saved] = storedComments(root);
	assert.deepEqual(JSON.parse(reply.body), { error: "delivery-failed", id: saved.id, saved: true, sent: false });
	assert.equal(saved.sentAt, null);
	assert.equal(saved.status, "open");
	assert.equal((await rawRequest(server.port, `/${TOKEN}/api/designs`)).status, 200);
});

test("send mode saves the comment, delivers it with its id, then marks it sent", async (t) => {
	const { port, root, comments } = await start(t);
	const reply = await postComment(port, { ...VALID, mode: "send" });
	assert.equal(reply.status, 202);
	const [saved] = storedComments(root);
	assert.deepEqual(comments, [{ ...VALID, id: saved.id }]);
	assert.notEqual(saved.sentAt, null);
	assert.deepEqual({ file: saved.file, selector: saved.selector, excerpt: saved.excerpt, comment: saved.comment, status: saved.status }, { file: VALID.file, selector: VALID.selector, excerpt: VALID.excerpt, comment: VALID.comment, status: "open" });
	assert.equal((await postComment(port, { ...VALID, mode: "later" })).status, 400);
});

test("collect mode saves without delivering, and the comments route lists it", async (t) => {
	const { port, root, comments, batches, base } = await start(t);
	const reply = await postComment(port, { ...VALID, mode: "collect" });
	assert.equal(reply.status, 201);
	const [saved] = storedComments(root);
	assert.deepEqual(JSON.parse(reply.body), { ok: true, id: saved.id, sent: false });
	assert.equal(saved.sentAt, null);
	assert.deepEqual(comments, []);
	assert.deepEqual(batches, []);
	const listed = await rawRequest(port, `${base}api/designs/alpha/comments`);
	assert.equal(listed.status, 200);
	assert.deepEqual(JSON.parse(listed.body), { version: 1, comments: [saved] });
	assert.deepEqual(JSON.parse((await rawRequest(port, `${base}api/designs/beta/comments`)).body), { version: 1, comments: [] });
	assert.equal((await rawRequest(port, `${base}api/designs/missing/comments`)).status, 404);
	assert.equal((await rawRequest(port, `${base}api/designs/Alpha/comments`)).status, 404);
	writeFileSync(join(root, "beta", "comments.json"), "{ broken");
	const broken = await rawRequest(port, `${base}api/designs/beta/comments`);
	assert.equal(broken.status, 422);
	assert.equal(JSON.parse(broken.body).error, "invalid-comments");
});

function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
	return rawRequest(port, `/${TOKEN}/${path}`, {
		method: "POST",
		headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

test("send-all delivers one batch with every open unsent comment and marks them sent", async (t) => {
	const { port, root, comments, batches } = await start(t);
	await postComment(port, { ...VALID, comment: "first", mode: "collect" });
	await postComment(port, { ...VALID, file: "02-bare.html", comment: "second", mode: "collect" });
	await postComment(port, { ...VALID, comment: "already sent", mode: "send" });
	await postComment(port, { ...VALID, comment: "resolved one", mode: "collect" });
	const resolvedId = storedComments(root)[3].id;
	assert.equal((await postJson(port, `api/designs/alpha/comments/${resolvedId}/status`, { status: "resolved" })).status, 200);
	const reply = await postJson(port, "api/designs/alpha/comments/send-all", {});
	assert.equal(reply.status, 202);
	assert.equal(batches.length, 1);
	assert.deepEqual(batches[0].map((comment) => comment.comment), ["first", "second"]);
	assert.deepEqual(batches[0].map((comment) => comment.slug), ["alpha", "alpha"]);
	const stored = storedComments(root);
	assert.deepEqual(JSON.parse(reply.body), { ok: true, sent: 2, ids: [stored[0].id, stored[1].id] });
	assert.ok(stored.slice(0, 3).every((comment) => comment.sentAt !== null));
	assert.equal(stored[3].sentAt, null, "a resolved comment is not sent");
	assert.equal(comments.length, 1, "send-all never uses the single-comment callback");
	const again = await postJson(port, "api/designs/alpha/comments/send-all", {});
	assert.equal(again.status, 200);
	assert.deepEqual(JSON.parse(again.body), { ok: true, sent: 0, ids: [] });
	assert.equal(batches.length, 1, "nothing to send means no delivery");
});

test("a failing batch delivery leaves the comments unsent", async (t) => {
	const { root } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onComments: () => { throw new Error("boom"); }, randomToken: () => TOKEN });
	t.after(() => server.close());
	await postComment(server.port, { ...VALID, mode: "collect" });
	const reply = await postJson(server.port, "api/designs/alpha/comments/send-all", {});
	assert.equal(reply.status, 500);
	assert.equal(JSON.parse(reply.body).error, "delivery-failed");
	assert.equal(storedComments(root)[0].sentAt, null);
});

// Advisory 4: a canvas opened through localhost posts with its own localhost origin.
test("POSTs accept the server's own localhost origin and no look-alike", async (t) => {
	const { port, root, comments } = await start(t);
	const localhost = { Origin: `http://localhost:${port}`, "Content-Type": "application/json" };
	const ok = await rawRequest(port, `/${TOKEN}/api/comments`, { method: "POST", headers: localhost, host: `localhost:${port}`, body: JSON.stringify(VALID) });
	assert.equal(ok.status, 202);
	assert.equal(comments.length, 1);
	const [saved] = storedComments(root);
	const status = await rawRequest(port, `/${TOKEN}/api/designs/alpha/comments/${saved.id}/status`, { method: "POST", headers: localhost, host: `localhost:${port}`, body: JSON.stringify({ status: "resolved" }) });
	assert.equal(status.status, 200);
	for (const origin of [`http://localhost:${port + 1}`, `http://localhost.evil.test:${port}`, "null", `http://localhost`]) {
		const refused = await rawRequest(port, `/${TOKEN}/api/comments`, { method: "POST", headers: { ...localhost, Origin: origin }, host: `localhost:${port}`, body: JSON.stringify(VALID) });
		assert.equal(refused.status, 403, origin);
	}
	assert.equal(comments.length, 1);
});

// Advisory 1: a send-now comment still in flight must not ride along in a parallel send-all.
test("a send-now comment in flight is not delivered again by a parallel send-all", async (t) => {
	const { root } = fixture(t);
	const singles: DesignComment[] = [];
	const batches: DesignComment[][] = [];
	const server = await startDesignCanvasServer({
		designRoot: root,
		onComment: async (comment) => { singles.push(comment); await new Promise((resolve) => setTimeout(resolve, 200)); },
		onComments: (batch) => { batches.push(batch); },
		randomToken: () => TOKEN,
	});
	t.after(() => server.close());
	const sendNow = postComment(server.port, { ...VALID, mode: "send" });
	// Wait until the comment is saved and its delivery has started.
	while (singles.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	const sendAll = postJson(server.port, "api/designs/alpha/comments/send-all", {});
	const [now, all] = await Promise.all([sendNow, sendAll]);
	assert.equal(now.status, 202);
	assert.equal(all.status, 200);
	assert.deepEqual(JSON.parse(all.body), { ok: true, sent: 0, ids: [] });
	const id = singles[0].id;
	const deliveries = singles.filter((comment) => comment.id === id).length + batches.flat().filter((comment) => comment.id === id).length;
	assert.equal(deliveries, 1);
	assert.notEqual(storedComments(root)[0].sentAt, null);
});

// The canvas slices excerpts to 300 UTF-16 units, which can split a pair at the boundary.
test("an excerpt ending in a lone high surrogate within the limit is stored well formed", async (t) => {
	const { port, root } = await start(t);
	const reply = await postComment(port, { ...VALID, excerpt: `${"a".repeat(299)}\uD83D` });
	assert.equal(reply.status, 202);
	const [saved] = storedComments(root);
	assert.equal(saved.excerpt, "a".repeat(299));
	assert.ok(saved.excerpt.isWellFormed(), "no lone surrogate");
});

// Advisory 2: the server truncates the excerpt in the store's unit (UTF-16) without splitting a pair.
test("an excerpt of astral characters is truncated to the store limit without a lone surrogate", async (t) => {
	const { port, root, comments } = await start(t);
	const reply = await postComment(port, { ...VALID, excerpt: "😀".repeat(200) });
	assert.equal(reply.status, 202);
	const [saved] = storedComments(root);
	assert.ok(saved.excerpt.length <= 300, `stored ${saved.excerpt.length} UTF-16 units`);
	assert.equal(saved.excerpt, "😀".repeat(150));
	assert.ok(saved.excerpt.isWellFormed(), "no lone surrogate");
	assert.equal(comments[0].excerpt, saved.excerpt);
	const odd = await postComment(port, { ...VALID, excerpt: `a${"😀".repeat(200)}` });
	assert.equal(odd.status, 202);
	const second = storedComments(root)[1].excerpt;
	assert.equal(second, `a${"😀".repeat(149)}`, "a pair that would straddle the limit is dropped whole");
	assert.ok(second.isWellFormed());
});

// S5: the agent's resolution reaches the canvas through the comments route.

test("S5: the comments route lists a comment's resolution, the status route clears it on reopen, and a malformed one is a 422", async (t) => {
	const { port, root, base } = await start(t);
	await postComment(port, { ...VALID, mode: "collect" });
	await postComment(port, { ...VALID, mode: "collect" });
	const path = join(root, "alpha", "comments.json");
	const document = JSON.parse(readFileSync(path, "utf8"));
	document.comments[0].status = "resolved";
	document.comments[0].resolvedAt = "2026-10-28T10:00:00.000Z";
	document.comments[0].resolution = "Made the title 32px.";
	writeFileSync(path, JSON.stringify(document));
	const listed = JSON.parse((await rawRequest(port, `${base}api/designs/alpha/comments`)).body).comments;
	assert.equal(listed[0].resolution, "Made the title 32px.");
	assert.equal("resolution" in listed[1], false);
	const id = document.comments[0].id;
	const reopened = await postJson(port, `api/designs/alpha/comments/${id}/status`, { status: "open" });
	assert.equal(reopened.status, 200);
	assert.equal("resolution" in JSON.parse(reopened.body).comment, false);
	assert.equal("resolution" in storedComments(root)[0], false);
	document.comments[1].resolution = 7;
	writeFileSync(path, JSON.stringify(document));
	const broken = await rawRequest(port, `${base}api/designs/alpha/comments`);
	assert.equal(broken.status, 422);
	assert.equal(JSON.parse(broken.body).error, "invalid-comments");
	assert.match(JSON.parse(broken.body).reason, /resolution/);
});

test("the status route resolves and reopens one comment", async (t) => {
	const { port, root } = await start(t);
	await postComment(port, { ...VALID, mode: "collect" });
	const [saved] = storedComments(root);
	const resolved = await postJson(port, `api/designs/alpha/comments/${saved.id}/status`, { status: "resolved" });
	assert.equal(resolved.status, 200);
	assert.equal(JSON.parse(resolved.body).comment.status, "resolved");
	assert.equal(storedComments(root)[0].status, "resolved");
	assert.notEqual(storedComments(root)[0].resolvedAt, null);
	assert.equal((await postJson(port, `api/designs/alpha/comments/${saved.id}/status`, { status: "open" })).status, 200);
	assert.equal(storedComments(root)[0].status, "open");
	assert.equal((await postJson(port, `api/designs/alpha/comments/${saved.id}/status`, { status: "done" })).status, 400);
	assert.equal((await postJson(port, "api/designs/alpha/comments/zzzzzz/status", { status: "resolved" })).status, 404);
	assert.equal((await postJson(port, "api/designs/alpha/comments/bad%2Fid/status", { status: "resolved" })).status, 404);
});

test("the new comment routes keep the Host, token, Origin, content-type and method rules", async (t) => {
	const { port, root, batches } = await start(t);
	await postComment(port, { ...VALID, mode: "collect" });
	const [saved] = storedComments(root);
	const posts = ["api/designs/alpha/comments/send-all", `api/designs/alpha/comments/${saved.id}/status`];
	const body = JSON.stringify({ status: "resolved" });
	for (const path of posts) {
		const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
		assert.equal((await rawRequest(port, `/${TOKEN}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403, `${path} without Origin`);
		for (const origin of ["http://evil.example", "null", `http://localhost:${port + 1}`, `http://localhost.evil.test:${port}`, `https://127.0.0.1:${port}`]) {
			assert.equal((await rawRequest(port, `/${TOKEN}/${path}`, { method: "POST", headers: { ...own, Origin: origin }, body })).status, 403, `${path} ${origin}`);
		}
		assert.equal((await rawRequest(port, `/${TOKEN}/${path}`, { method: "POST", headers: { ...own, "Content-Type": "text/plain" }, body })).status, 415, path);
		assert.equal((await rawRequest(port, `/wrong-token-0123456789/${path}`, { method: "POST", headers: own, body })).status, 404, path);
		assert.equal((await rawRequest(port, `/${TOKEN}/${path}`, { method: "POST", headers: own, body, host: `evil.example:${port}` })).status, 421, path);
		assert.equal((await rawRequest(port, `/${TOKEN}/${path}`, { method: "POST", headers: own, body: JSON.stringify({ pad: "x".repeat(17 * 1024) }) })).status, 413, path);
		assert.equal((await rawRequest(port, `/${TOKEN}/${path}`)).status, 405, `${path} GET`);
	}
	const list = `/${TOKEN}/api/designs/alpha/comments`;
	assert.equal((await rawRequest(port, list, { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await rawRequest(port, list, { headers: { Origin: "null" } })).status, 403);
	assert.equal((await rawRequest(port, list, { host: `evil.example:${port}` })).status, 421);
	assert.equal((await rawRequest(port, `/wrong-token-0123456789/api/designs/alpha/comments`)).status, 404);
	assert.equal((await rawRequest(port, list, { method: "POST", headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }, body: "{}" })).status, 405);
	assert.equal(storedComments(root)[0].status, "open");
	assert.equal(storedComments(root)[0].sentAt, null);
	assert.deepEqual(batches, []);
});

function openEvents(port: number) {
	let buffer = "";
	const waiters: Array<{ pattern: RegExp; resolve: (match: RegExpExecArray) => void }> = [];
	const req = httpRequest({ host: "127.0.0.1", port, path: `/${TOKEN}/events`, headers: { Host: `127.0.0.1:${port}` }, setHost: false });
	const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
		req.on("response", (res) => {
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buffer += chunk;
				for (const waiter of [...waiters]) {
					const match = waiter.pattern.exec(buffer);
					if (match) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(match); }
				}
			});
			res.on("error", () => {});
			resolve(res.headers);
		});
		req.on("error", reject);
	});
	req.end();
	// A waiter that never matches must fail loud, not hang the whole suite:
	// an exhausted inotify limit stops the server's change events, and the fs.watch
	// preflight above skips these tests naming that environment when it cannot register.
	const waitFor = (pattern: RegExp) => new Promise<RegExpExecArray>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`events never matched ${pattern} within 5s; got: ${JSON.stringify(buffer.slice(-200))}`)), 5000);
		const settle = (match: RegExpExecArray) => { clearTimeout(timeout); resolve(match); };
		const match = pattern.exec(buffer);
		if (match) settle(match); else waiters.push({ pattern, resolve: settle });
	});
	return { ready, waitFor, req };
}

test("events stream a debounced change after an artboard write", async (t) => {
	if (!FS_WATCH_AVAILABLE) return t.skip(FS_WATCH_SKIP);
	const { port, root } = await start(t);
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	const headers = await events.ready;
	assert.match(String(headers["content-type"]), /^text\/event-stream/);
	assert.equal(headers["cache-control"], "no-store");
	await events.waitFor(/: connected\n\n/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	writeFileSync(join(root, "alpha", "01-hero.html"), "<p>changed</p>");
	const match = await events.waitFor(/event: change\ndata: (\{"slug":"alpha","file":"01-hero\.html"\})\n\n/);
	assert.deepEqual(JSON.parse(match[1]), { slug: "alpha", file: "01-hero.html" });
});

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("connectedClients counts the open event streams", async (t) => {
	const { server, port } = await start(t);
	assert.equal(server.connectedClients(), 0);
	const first = openEvents(port);
	t.after(() => first.req.destroy());
	await first.ready;
	await first.waitFor(/: connected\n\n/);
	assert.equal(server.connectedClients(), 1);
	const second = openEvents(port);
	t.after(() => second.req.destroy());
	await second.ready;
	await second.waitFor(/: connected\n\n/);
	assert.equal(server.connectedClients(), 2);
	first.req.destroy();
	second.req.destroy();
	await until(() => server.connectedClients() === 0);
});

test("show() tells every connected page which design to show, or the system-only view for null", async (t) => {
	const { server, port } = await start(t);
	assert.equal(server.show("alpha"), 0, "no page is connected yet");
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	assert.equal(server.show("beta"), 1);
	const match = await events.waitFor(/event: show\ndata: (\{[^\n]*\})\n\n/);
	assert.deepEqual(JSON.parse(match[1]), { slug: "beta" });
	assert.equal(server.show(null), 1);
	await events.waitFor(/event: show\ndata: \{"slug":null\}\n\n/);
	for (const slug of ["../x", "Beta", "", "a b"]) assert.throws(() => server.show(slug), /kebab-case/, slug);
});

test("events stream a change when comments.json is written", async (t) => {
	if (!FS_WATCH_AVAILABLE) return t.skip(FS_WATCH_SKIP);
	const { port } = await start(t);
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await postComment(port, { ...VALID, mode: "collect" })).status, 201);
	await events.waitFor(/event: change\ndata: \{"slug":"alpha","file":"comments\.json"\}\n\n/);
});

const SYSTEM_HTML = "<!doctype html><html><body><h1>Tokens</h1></body></html>";

test("GET api/system reports whether design/system.html exists, at 1440 wide", async (t) => {
	const { port, base, root } = await start(t);
	const missing = await rawRequest(port, `${base}api/system`);
	assert.equal(missing.status, 200);
	const absent = JSON.parse(missing.body);
	assert.equal(absent.exists, false);
	assert.equal(absent.file, "system.html");
	assert.equal(absent.width, 1440);
	assert.ok(Number.isInteger(absent.height) && absent.height >= 600, "a sensible default height");
	assert.equal((await rawRequest(port, `${base}system.html`)).status, 404);
	writeFileSync(join(root, "system.html"), SYSTEM_HTML);
	const present = JSON.parse((await rawRequest(port, `${base}api/system`)).body);
	assert.deepEqual(present, { ...absent, exists: true });
});

test("the system board is served sandboxed with the inspector injected", async (t) => {
	const { port, base, root } = await start(t);
	writeFileSync(join(root, "system.html"), SYSTEM_HTML);
	const board = await rawRequest(port, `${base}system.html?v=1`);
	assert.equal(board.status, 200);
	assert.match(String(board.headers["content-type"]), /^text\/html/);
	assert.match(String(board.headers["content-security-policy"]), /^sandbox allow-scripts;/);
	assert.match(String(board.headers["content-security-policy"]), /connect-src 'none'/);
	assert.equal(board.headers["cross-origin-resource-policy"], undefined);
	assert.equal(board.body, `<!doctype html><html><body><h1>Tokens</h1><script src="${base}assets/inspector.js"></script></body></html>`);
	// Only that one file: system.md and other root names are not routes.
	writeFileSync(join(root, "system.md"), "# Tokens");
	for (const path of ["system.md", "system.htm", "system.html/x", "api/system/x", "files/system.html"]) {
		assert.equal((await rawRequest(port, `${base}${path}`)).status, 404, path);
	}
});

test("a symlinked system.html escaping the design root is 404, and a directory is not a board", async (t) => {
	const { port, base, root } = await start(t);
	const outside = scratch(t, "gentle-design-system-outside-");
	writeFileSync(join(outside, "system.html"), "<p>secret</p>");
	symlinkSync(join(outside, "system.html"), join(root, "system.html"));
	assert.equal((await rawRequest(port, `${base}system.html`)).status, 404);
	assert.equal(JSON.parse((await rawRequest(port, `${base}api/system`)).body).exists, false);
	const dirRoot = scratch(t, "gentle-design-system-dir-");
	mkdirSync(join(dirRoot, "system.html"));
	const other = await startDesignCanvasServer({ designRoot: dirRoot, onComment: () => {}, randomToken: () => TOKEN });
	t.after(() => other.close());
	assert.equal((await rawRequest(other.port, `/${TOKEN}/system.html`)).status, 404);
	assert.equal(JSON.parse((await rawRequest(other.port, `/${TOKEN}/api/system`)).body).exists, false);
});

test("the system routes keep the Host, token, Origin and method rules", async (t) => {
	const { port, base, root } = await start(t);
	writeFileSync(join(root, "system.html"), SYSTEM_HTML);
	for (const path of ["system.html", "api/system"]) {
		assert.equal((await rawRequest(port, `${base}${path}`, { host: `evil.example:${port}` })).status, 421, path);
		assert.equal((await rawRequest(port, `/wrong-token-0123456789/${path}`)).status, 404, path);
		assert.equal((await rawRequest(port, `${base}${path}`, { headers: { Origin: "http://evil.example" } })).status, 403, path);
		assert.equal((await rawRequest(port, `${base}${path}`, { headers: { Origin: `http://localhost:${port}` } })).status, 200, path);
		assert.equal((await rawRequest(port, `${base}${path}`, { method: "POST", headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }, body: "{}" })).status, 405, path);
	}
	// Like an artboard, the sandboxed system board may load with Origin null; its metadata may not.
	assert.equal((await rawRequest(port, `${base}system.html`, { headers: { Origin: "null" } })).status, 200);
	assert.equal((await rawRequest(port, `${base}api/system`, { headers: { Origin: "null" } })).status, 403);
});

test("events stream a change when system.html or system.md is written", async (t) => {
	if (!FS_WATCH_AVAILABLE) return t.skip(FS_WATCH_SKIP);
	const { port, root } = await start(t);
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	writeFileSync(join(root, "system.html"), SYSTEM_HTML);
	await events.waitFor(/event: change\ndata: \{"slug":null,"file":"system\.html"\}\n\n/);
	writeFileSync(join(root, "system.md"), "# Tokens");
	await events.waitFor(/event: change\ndata: \{"slug":null,"file":"system\.md"\}\n\n/);
});

test("implement validates the artboard against the manifest, calls onImplement once and answers 202", async (t) => {
	const { port, implements: calls } = await start(t);
	const ok = await postJson(port, "api/designs/alpha/implement", { file: "01-hero.html" });
	assert.equal(ok.status, 202);
	assert.deepEqual(JSON.parse(ok.body), { ok: true, slug: "alpha", file: "01-hero.html", queued: false });
	assert.deepEqual(calls, [{ slug: "alpha", file: "01-hero.html" }]);
	// sub/inner.html exists but is not an artboard of the manifest.
	for (const file of ["sub/inner.html", "missing.html", "../beta/01-a.html", "styles.css", 7, ""]) {
		assert.equal((await postJson(port, "api/designs/alpha/implement", { file })).status, 400, String(file));
	}
	assert.equal((await postJson(port, "api/designs/missing/implement", { file: "01-hero.html" })).status, 404);
	assert.equal((await postJson(port, "api/designs/broken/implement", { file: "01-a.html" })).status, 422);
	assert.equal((await postJson(port, "api/designs/Alpha/implement", { file: "01-hero.html" })).status, 404);
	assert.equal(calls.length, 1, "no refused request reaches onImplement");
});

test("the implement route keeps the Host, token, Origin, content-type and method rules", async (t) => {
	const { port, implements: calls } = await start(t);
	const path = `/${TOKEN}/api/designs/alpha/implement`;
	const body = JSON.stringify({ file: "01-hero.html" });
	const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403, "no Origin");
	for (const origin of ["http://evil.example", "null", `http://localhost:${port + 1}`]) {
		assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: origin }, body })).status, 403, origin);
	}
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, "Content-Type": "text/plain" }, body })).status, 415);
	assert.equal((await rawRequest(port, `/wrong-token-0123456789/api/designs/alpha/implement`, { method: "POST", headers: own, body })).status, 404);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: own, body, host: `evil.example:${port}` })).status, 421);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: own, body: JSON.stringify({ pad: "x".repeat(17 * 1024) }) })).status, 413);
	assert.equal((await rawRequest(port, path)).status, 405);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: `http://localhost:${port}` }, body })).status, 202);
	assert.equal(calls.length, 1);
});

test("implement is 501 without onImplement and 500 when it throws", async (t) => {
	const { root } = fixture(t);
	const bare = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, randomToken: () => TOKEN });
	t.after(() => bare.close());
	assert.equal((await postJson(bare.port, "api/designs/alpha/implement", { file: "01-hero.html" })).status, 501);
	const failing = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplement: () => { throw new Error("boom"); }, randomToken: () => TOKEN });
	t.after(() => failing.close());
	const reply = await postJson(failing.port, "api/designs/alpha/implement", { file: "01-hero.html" });
	assert.equal(reply.status, 500);
	assert.deepEqual(JSON.parse(reply.body), { error: "delivery-failed", slug: "alpha", file: "01-hero.html", reason: "boom" });
	assert.equal((await rawRequest(failing.port, `/${TOKEN}/api/designs`)).status, 200, "the server survives");
});

// T2/S3: "Try another direction from this…" posts to api/designs/<slug>/variant.

const VARIANT = "api/designs/alpha/variant";

test("T2/S3: variant delivers exactly one request with the source file and the instruction, and answers 202", async (t) => {
	const { port, variants } = await start(t);
	const ok = await postJson(port, VARIANT, { file: "01-hero.html", instruction: "  More compact\r\nfor phones  " });
	assert.equal(ok.status, 202);
	assert.deepEqual(JSON.parse(ok.body), { ok: true, slug: "alpha", file: "01-hero.html", queued: false });
	assert.deepEqual(variants, [{ slug: "alpha", file: "01-hero.html", instruction: "More compact\nfor phones" }], "trimmed, with LF line ends");
	const edge = await postJson(port, VARIANT, { file: "02-bare.html", instruction: "x".repeat(2000) });
	assert.equal(edge.status, 202, "2000 characters are allowed");
	assert.equal(variants.length, 2);
	assert.equal(variants[1].instruction.length, 2000);
});

test("T2/S3: variant refuses an empty or over-long instruction, a file outside the manifest and a bad design, delivering nothing", async (t) => {
	const { port, root, variants } = await start(t);
	for (const instruction of ["", "   \n ", "x".repeat(2001), `  ${"x".repeat(2001)}  `, 7, null, ["a"], undefined]) {
		const reply = await postJson(port, VARIANT, { file: "01-hero.html", instruction });
		assert.equal(reply.status, 400, JSON.stringify(instruction)?.slice(0, 20));
		assert.equal(JSON.parse(reply.body).error, "invalid-instruction");
	}
	// sub/inner.html exists but is not an artboard of the manifest.
	for (const file of ["sub/inner.html", "missing.html", "../beta/01-a.html", "styles.css", "alias.html", 7, "", undefined]) {
		const reply = await postJson(port, VARIANT, { file, instruction: "Bolder" });
		assert.equal(reply.status, 400, String(file));
		assert.equal(JSON.parse(reply.body).error, "invalid-file");
	}
	assert.equal((await postJson(port, "api/designs/missing/variant", { file: "01-hero.html", instruction: "Bolder" })).status, 404);
	assert.equal((await postJson(port, "api/designs/broken/variant", { file: "01-a.html", instruction: "Bolder" })).status, 422);
	assert.equal((await postJson(port, "api/designs/Alpha/variant", { file: "01-hero.html", instruction: "Bolder" })).status, 404);
	assert.equal((await postJson(port, "api/designs/Not_A_Slug/variant", { file: "01-a.html", instruction: "Bolder" })).status, 404);
	assert.equal((await postJson(port, "api/designs/..%2Falpha/variant", { file: "01-hero.html", instruction: "Bolder" })).status, 404);
	assert.equal(variants.length, 0, "no refused request reaches onVariant");
	assert.equal(existsSync(join(root, "alpha", "handoffs.json")), false, "a variant is not a handoff: nothing is written");
});

test("T2/S3: the variant route keeps the Host, token, Origin, content-type, JSON, size and method rules", async (t) => {
	const { port, variants } = await start(t);
	const path = `/${TOKEN}/${VARIANT}`;
	const body = JSON.stringify({ file: "01-hero.html", instruction: "Bolder" });
	const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403, "no Origin");
	for (const origin of ["http://evil.example", "null", `http://localhost:${port + 1}`]) {
		assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: origin }, body })).status, 403, origin);
	}
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, "Content-Type": "text/plain" }, body })).status, 415);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { "Origin": own.Origin }, body })).status, 415, "no content type");
	assert.equal((await rawRequest(port, `/wrong-token-0123456789/${VARIANT}`, { method: "POST", headers: own, body })).status, 404, "wrong token");
	assert.equal((await rawRequest(port, `/${VARIANT}`, { method: "POST", headers: own, body })).status, 404, "missing token");
	assert.equal((await rawRequest(port, path, { method: "POST", headers: own, body, host: `evil.example:${port}` })).status, 421);
	for (const text of ["not json", "[1]", "null", "\"x\""]) {
		const reply = await rawRequest(port, path, { method: "POST", headers: own, body: text });
		assert.equal(reply.status, 400, text);
	}
	assert.equal(JSON.parse((await rawRequest(port, path, { method: "POST", headers: own, body: "not json" })).body).error, "invalid-json");
	assert.equal((await rawRequest(port, path, { method: "POST", headers: own, body: JSON.stringify({ file: "01-hero.html", instruction: "x".repeat(17 * 1024) }) })).status, 413);
	assert.equal((await rawRequest(port, path)).status, 405);
	assert.equal((await rawRequest(port, path, { method: "PUT", headers: own, body })).status, 405);
	assert.equal(variants.length, 0, "nothing refused reaches onVariant");
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: `http://localhost:${port}` }, body })).status, 202);
	assert.equal(variants.length, 1);
});

test("T2/S3: variant answers queued from the delivery, 501 without onVariant and 500 when it throws", async (t) => {
	const { root } = fixture(t);
	const request = { file: "01-hero.html", instruction: "Bolder" };
	const bare = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplement: () => {}, randomToken: () => TOKEN });
	t.after(() => bare.close());
	const none = await postJson(bare.port, VARIANT, request);
	assert.equal(none.status, 501);
	assert.deepEqual(JSON.parse(none.body), { error: "variant-unavailable" });

	const states = [{ queued: true }, { queued: false }, undefined];
	const seen: unknown[] = [];
	const queueing = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onVariant: async (call) => { seen.push(call); return states[seen.length - 1]; }, randomToken: () => TOKEN });
	t.after(() => queueing.close());
	assert.equal(JSON.parse((await postJson(queueing.port, VARIANT, request)).body).queued, true);
	assert.equal(JSON.parse((await postJson(queueing.port, VARIANT, request)).body).queued, false);
	assert.equal(JSON.parse((await postJson(queueing.port, VARIANT, request)).body).queued, false, "no answer means not queued");

	const failing = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onVariant: () => { throw new Error("boom"); }, randomToken: () => TOKEN });
	t.after(() => failing.close());
	const reply = await postJson(failing.port, VARIANT, request);
	assert.equal(reply.status, 500);
	assert.deepEqual(JSON.parse(reply.body), { error: "delivery-failed", slug: "alpha", file: "01-hero.html", reason: "boom" });
	assert.equal((await rawRequest(failing.port, `/${TOKEN}/api/designs`)).status, 200, "the server survives");
});

// canvas-trim S4: Mix is gone; its former route is an unknown path like any other.

test("canvas-trim S4: POST to the former mix route answers 404 not-found like an unknown route and reaches no session callback", async (t) => {
	const { port, comments, batches, implements: implemented, variants, parts } = await start(t);
	const body = { base: "01-hero.html", picks: [{ file: "02-bare.html", selector: "body > h1", excerpt: "Bare", note: "" }] };
	const former = await postJson(port, "api/designs/alpha/mix", body);
	const unknown = await postJson(port, "api/designs/alpha/no-such-route", body);
	assert.equal(former.status, 404);
	assert.deepEqual(JSON.parse(former.body), { error: "not-found" });
	assert.deepEqual([former.status, former.body], [unknown.status, unknown.body], "the same answer as an unknown route");
	assert.equal((await rawRequest(port, `/${TOKEN}/api/designs/alpha/mix`)).status, 404, "no method makes it a known route");
	assert.deepEqual([comments, batches, implemented, variants, parts].map((calls) => calls.length), [0, 0, 0, 0, 0], "no session callback is called");
});

// canvas-implement-part S2, S4: "Implement only this" hands one element of an artboard to the session, recorded in
// design/<slug>/parts.json before delivery; handoffs.json and the chosen artboard stay as they are.
const PARTS = "api/designs/alpha/implement-part";
const PARTS_LIST = "api/designs/alpha/parts";
const SIDE = { file: "02-bare.html", selector: "  nav.side\n > ul ", excerpt: "  Home\n  Tours ", note: "  solo el menú\r\nsin la cabecera  " };

test("implement-part S4: Implement only this records the part, delivers it once with its id, answers 202, and leaves handoffs.json alone", async (t) => {
	const { port, root, parts } = await start(t);
	const reply = await postJson(port, PARTS, SIDE);
	assert.equal(reply.status, 202);
	const body = JSON.parse(reply.body);
	assert.deepEqual(Object.keys(body), ["ok", "id", "queued"]);
	assert.equal(body.ok, true);
	assert.equal(body.queued, false);
	assert.match(body.id, /^[a-z0-9]{1,32}$/);
	const onDisk = JSON.parse(readFileSync(join(root, "alpha", "parts.json"), "utf8"));
	assert.equal(onDisk.parts.length, 1);
	const [part] = onDisk.parts;
	assert.deepEqual({ ...part, sentAt: "t" }, { id: body.id, file: "02-bare.html", selector: "nav.side > ul", excerpt: "Home Tours", instruction: "solo el menú\nsin la cabecera", status: "sent", queued: false, sentAt: "t", startedAt: null, implementedAt: null }, "selector and excerpt collapsed, the note trimmed with LF line ends");
	assert.deepEqual(parts, [{ slug: "alpha", part }], "the session gets exactly the recorded part");
	assert.equal(existsSync(join(root, "alpha", "handoffs.json")), false, "no direction is chosen");
	const listed = await rawRequest(port, `/${TOKEN}/${PARTS_LIST}`);
	assert.equal(listed.status, 200);
	assert.deepEqual(JSON.parse(listed.body), onDisk);
	const bare = await postJson(port, PARTS, { file: "01-hero.html", selector: "h1" });
	assert.equal(bare.status, 202, "excerpt and note are optional");
	assert.equal(JSON.parse(readFileSync(join(root, "alpha", "parts.json"), "utf8")).parts[1].instruction, undefined);
});

test("implement-part S4: the route takes a selector of 500 and a note of 2000 characters and cuts the excerpt to 300 (canvas-trim S6)", async (t) => {
	const { port, parts } = await start(t);
	const reply = await postJson(port, PARTS, { file: "02-bare.html", selector: "s".repeat(500), excerpt: "e".repeat(400), note: "n".repeat(2000) });
	assert.equal(reply.status, 202);
	assert.equal(parts.length, 1);
	assert.equal(parts[0].part.selector.length, 500);
	assert.equal(parts[0].part.excerpt.length, 300, "the excerpt is cut to its limit, like a comment's");
	assert.equal(parts[0].part.instruction?.length, 2000);
});

test("implement-part S4: the route refuses a file outside the manifest and bad fields, delivering and recording nothing", async (t) => {
	const { port, root, parts } = await start(t);
	const refused = async (body: unknown, status: number, error: string, label: string) => {
		const reply = await postJson(port, PARTS, body);
		assert.equal(reply.status, status, label);
		assert.equal(JSON.parse(reply.body).error, error, label);
	};
	for (const file of ["sub/inner.html", "missing.html", "../beta/01-a.html", "alias.html", 7, "", undefined]) await refused({ ...SIDE, file }, 400, "invalid-file", `file ${String(file)}`);
	for (const selector of ["", "   ", "s".repeat(501), 7, undefined]) await refused({ ...SIDE, selector }, 400, "invalid-selector", `selector ${String(selector).slice(0, 10)}`);
	await refused({ ...SIDE, excerpt: 7 }, 400, "invalid-excerpt", "excerpt not text");
	for (const note of ["n".repeat(2001), 7]) await refused({ ...SIDE, note }, 400, "invalid-note", `note ${String(note).slice(0, 10)}`);
	assert.equal((await postJson(port, "api/designs/missing/implement-part", SIDE)).status, 404);
	assert.equal((await postJson(port, "api/designs/Not_A_Slug/implement-part", SIDE)).status, 404);
	assert.equal(parts.length, 0, "nothing refused reaches the session");
	assert.equal(existsSync(join(root, "alpha", "parts.json")), false, "and nothing is recorded");
	writeFileSync(join(root, "alpha", "parts.json"), "not json");
	const broken = await postJson(port, PARTS, { file: "01-hero.html", selector: "h1" });
	assert.equal(broken.status, 422);
	assert.equal(JSON.parse(broken.body).error, "invalid-parts");
	assert.equal(readFileSync(join(root, "alpha", "parts.json"), "utf8"), "not json", "a broken file is never overwritten");
	assert.equal((await rawRequest(port, `/${TOKEN}/${PARTS_LIST}`)).status, 422);
});

test("implement-part S4: the route answers queued from the delivery, 501 without onImplementPart, and 500 when the delivery throws, taking the part back", async (t) => {
	const { root } = fixture(t);
	const request = { file: "01-hero.html", selector: "h1" };
	const bare = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, randomToken: () => TOKEN });
	t.after(() => bare.close());
	const none = await postJson(bare.port, PARTS, request);
	assert.equal(none.status, 501);
	assert.deepEqual(JSON.parse(none.body), { error: "implement-part-unavailable" });
	assert.equal(existsSync(join(root, "alpha", "parts.json")), false);

	const queueing = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplementPart: () => ({ queued: true }), randomToken: () => TOKEN });
	t.after(() => queueing.close());
	const queued = await postJson(queueing.port, PARTS, request);
	assert.equal(JSON.parse(queued.body).queued, true);
	assert.equal(JSON.parse(readFileSync(join(root, "alpha", "parts.json"), "utf8")).parts[0].queued, true);

	const failing = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplementPart: () => { throw new Error("session closed"); }, randomToken: () => TOKEN });
	t.after(() => failing.close());
	const reply = await postJson(failing.port, PARTS, request);
	assert.equal(reply.status, 500);
	assert.deepEqual(JSON.parse(reply.body), { error: "delivery-failed", slug: "alpha", file: "01-hero.html", reason: "session closed" });
	assert.equal(JSON.parse(readFileSync(join(root, "alpha", "parts.json"), "utf8")).parts.length, 1, "the failed part is taken back, the queued one stays");
});

test("implement-part S4: the parts route keeps the Origin, content-type, JSON and method rules", async (t) => {
	const { port, parts } = await start(t);
	const path = `/${TOKEN}/${PARTS}`;
	const body = JSON.stringify({ file: "01-hero.html", selector: "h1" });
	const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403, "no Origin");
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: "http://evil.example" }, body })).status, 403);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, "Content-Type": "text/plain" }, body })).status, 415);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: own, body: "not json" })).status, 400);
	assert.equal((await rawRequest(port, path, { method: "PUT", headers: own, body })).status, 405);
	assert.equal((await rawRequest(port, path)).status, 405, "the list is read from api/designs/<slug>/parts");
	assert.equal((await rawRequest(port, `/${TOKEN}/${PARTS_LIST}`, { method: "POST", headers: own, body })).status, 405, "and written only through implement-part");
	assert.equal(parts.length, 0);
});

// canvas-server-data S2: "Remove" clears a part still `sent` from parts.json through the same writer; anything else is
// refused without writing, and handoffs.json is never touched.
const PARTS_REMOVE = "api/designs/alpha/parts/remove";
const partsFile = (root: string) => join(root, "alpha", "parts.json");

test("S2: parts/remove takes out a sent part, answers 200 with its id, keeps the others and leaves handoffs.json byte for byte", async (t) => {
	const { port, root } = await start(t);
	assert.equal((await postJson(port, "api/designs/alpha/implement", { file: "01-hero.html" })).status, 202);
	const handoffs = readFileSync(join(root, "alpha", "handoffs.json"));
	const first = JSON.parse((await postJson(port, PARTS, SIDE)).body).id;
	const second = JSON.parse((await postJson(port, PARTS, { file: "01-hero.html", selector: "h1" })).body).id;
	const kept = JSON.parse(readFileSync(partsFile(root), "utf8")).parts[1];
	const reply = await postJson(port, PARTS_REMOVE, { id: first });
	assert.equal(reply.status, 200);
	assert.deepEqual(JSON.parse(reply.body), { ok: true, id: first });
	assert.equal(readFileSync(partsFile(root), "utf8"), `${JSON.stringify({ version: 1, parts: [kept] }, null, 2)}\n`);
	assert.equal(kept.id, second);
	assert.deepEqual(readFileSync(join(root, "alpha", "handoffs.json")), handoffs, "handoffs.json is never written");
	assert.deepEqual(JSON.parse((await rawRequest(port, `/${TOKEN}/${PARTS_LIST}`)).body), { version: 1, parts: [kept] });
});

test("S2: parts/remove refuses a part not sent, an unknown or malformed id, a bad body, Origin or method, and a missing design, writing nothing", async (t) => {
	const { port, root } = await start(t);
	assert.equal((await postJson(port, "api/designs/alpha/implement", { file: "01-hero.html" })).status, 202);
	const at = "2026-10-31T10:00:00.000Z";
	const part = (id: string, status: string) => ({ id, file: "01-hero.html", selector: "h1", excerpt: "Hero", status, queued: false, sentAt: at, startedAt: status === "sent" ? null : at, implementedAt: status === "implemented" ? at : null });
	writeFileSync(partsFile(root), `${JSON.stringify({ version: 1, parts: [part("busy", "in_progress"), part("done", "implemented"), part("open", "sent")] }, null, 2)}\n`);
	const parts = readFileSync(partsFile(root));
	const handoffs = readFileSync(join(root, "alpha", "handoffs.json"));
	const refused = async (reply: Promise<{ status: number; body: string }>, status: number, body: unknown, label: string) => {
		const answer = await reply;
		assert.equal(answer.status, status, label);
		assert.deepEqual(JSON.parse(answer.body), body, label);
		assert.deepEqual(readFileSync(partsFile(root)), parts, `${label}: parts.json unchanged`);
		assert.deepEqual(readFileSync(join(root, "alpha", "handoffs.json")), handoffs, `${label}: handoffs.json untouched`);
	};
	await refused(postJson(port, PARTS_REMOVE, { id: "busy" }), 409, { error: "part-not-sent", reason: 'Part "busy" is in_progress, not sent; only a sent part can be removed.' }, "in progress");
	await refused(postJson(port, PARTS_REMOVE, { id: "done" }), 409, { error: "part-not-sent", reason: 'Part "done" is implemented, not sent; only a sent part can be removed.' }, "implemented");
	await refused(postJson(port, PARTS_REMOVE, { id: "nope" }), 404, { error: "not-found" }, "unknown id");
	for (const id of ["", "UPPER", "a".repeat(33), 7, undefined]) {
		await refused(postJson(port, PARTS_REMOVE, { id }), 400, { error: "invalid-part", reason: "id must be 1 to 32 lowercase letters or digits" }, `id ${String(id)}`);
	}
	await refused(postJson(port, PARTS_REMOVE, [1]), 400, { error: "invalid-body" }, "not an object");
	const path = `/${TOKEN}/${PARTS_REMOVE}`;
	const body = JSON.stringify({ id: "open" });
	const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
	await refused(rawRequest(port, path, { method: "POST", headers: own, body: "not json" }), 400, { error: "invalid-json" }, "not JSON");
	await refused(rawRequest(port, path, { method: "POST", headers: { "Content-Type": "application/json" }, body }), 403, { error: "forbidden" }, "no Origin");
	await refused(rawRequest(port, path, { method: "POST", headers: { ...own, Origin: "http://evil.example" }, body }), 403, { error: "forbidden" }, "foreign Origin");
	await refused(rawRequest(port, path, { method: "POST", headers: { ...own, "Content-Type": "text/plain" }, body }), 415, { error: "unsupported-media-type" }, "not JSON content");
	await refused(rawRequest(port, path, { method: "POST", headers: own, body, host: `evil.example:${port}` }), 421, { error: "misdirected" }, "foreign Host");
	await refused(rawRequest(port, `/wrong-token-0123456789abcdef/${PARTS_REMOVE}`, { method: "POST", headers: own, body }), 404, { error: "not-found" }, "wrong token");
	const get = await rawRequest(port, path);
	assert.equal(get.headers.allow, "POST");
	await refused(Promise.resolve(get), 405, { error: "method-not-allowed" }, "GET");
	await refused(rawRequest(port, path, { method: "PUT", headers: own, body }), 405, { error: "method-not-allowed" }, "PUT");
	await refused(rawRequest(port, path, { method: "POST", headers: own, body: JSON.stringify({ id: "open", pad: "x".repeat(17 * 1024) }) }), 413, { error: "body-too-large" }, "over 16 KiB");
	await refused(postJson(port, "api/designs/missing/parts/remove", { id: "open" }), 404, { error: "not-found" }, "missing design");
	await refused(postJson(port, "api/designs/Not_A_Slug/parts/remove", { id: "open" }), 404, { error: "not-found" }, "bad slug");
	writeFileSync(partsFile(root), "not json");
	const broken = await postJson(port, PARTS_REMOVE, { id: "open" });
	assert.equal(broken.status, 422);
	assert.equal(JSON.parse(broken.body).error, "invalid-parts");
	assert.equal(readFileSync(partsFile(root), "utf8"), "not json", "a broken file is never overwritten");
});

test("S2: removing a part streams one change for parts.json", async (t) => {
	if (!FS_WATCH_AVAILABLE) return t.skip(FS_WATCH_SKIP);
	const { port } = await start(t);
	const id = JSON.parse((await postJson(port, PARTS, SIDE)).body).id;
	// Let the change of that write go out before the stream opens, so only the removal can match.
	await new Promise((resolve) => setTimeout(resolve, 400));
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await postJson(port, PARTS_REMOVE, { id })).status, 200);
	await events.waitFor(/event: change\ndata: \{"slug":"alpha","file":"parts\.json"\}\n\n/);
});

// canvas-server-data S9: parts.json holds at most 1 MiB, checked before the file is replaced.
const MAX_PARTS_BYTES = 1024 * 1024;
const CONTROL = "\u0001";
const partsDocument = (parts: object[]) => `${JSON.stringify({ version: 1, parts }, null, 2)}\n`;

/** Valid sent parts whose parts.json is exactly `target` bytes, mostly control characters (six bytes each once escaped). */
function partsOfSize(target: number): object[] {
	const fillers: Array<Record<string, unknown>> = [];
	const size = () => Buffer.byteLength(partsDocument(fillers));
	for (let i = 0; ; i++) {
		const part: Record<string, unknown> = { id: `fill${i}`, file: "01-hero.html", selector: "h1", excerpt: "", instruction: "", status: "sent", queued: false, sentAt: "2026-10-31T10:00:00.000Z", startedAt: null, implementedAt: null };
		const gap = target - size();
		fillers.push(part);
		const overhead = size() - Buffer.byteLength(partsDocument(fillers.slice(0, -1)));
		let length = Math.min(2000, Math.floor((gap - overhead) / 6));
		if (length === 2000 && gap - overhead - 12000 < overhead + 12) length = 1000;
		assert.ok(length >= 0 && fillers.length < 99, "the fillers fit in the parts a design can hold");
		part.instruction = CONTROL.repeat(length);
		const left = target - size();
		if (left >= 6) continue;
		part.excerpt = "x".repeat(left);
		assert.equal(size(), target);
		return fillers;
	}
}

test("S9: implement-part refuses a part that would push parts.json past 1 MiB with 409 parts-too-large, delivering nothing and leaving the file byte for byte", async (t) => {
	const { port, root, parts } = await start(t);
	writeFileSync(partsFile(root), partsDocument(partsOfSize(MAX_PARTS_BYTES - 2000)));
	const before = readFileSync(partsFile(root));
	const reply = await postJson(port, PARTS, { file: "01-hero.html", selector: "h1", note: CONTROL.repeat(2000) });
	assert.equal(reply.status, 409);
	const body = JSON.parse(reply.body);
	assert.deepEqual(Object.keys(body), ["error", "reason"]);
	assert.equal(body.error, "parts-too-large");
	assert.match(body.reason, /^design\/alpha\/parts\.json would grow to \d+ bytes, past the 1 MiB it can hold; nothing was written\.$/);
	assert.deepEqual(readFileSync(partsFile(root)), before, "the previous file is intact");
	assert.equal(parts.length, 0, "a refused part never reaches the session");
	const small = await postJson(port, PARTS, { file: "01-hero.html", selector: "h1" });
	assert.equal(small.status, 202, "a part that still fits is recorded");
	assert.ok(readFileSync(partsFile(root)).length <= MAX_PARTS_BYTES);
	assert.equal((await rawRequest(port, `/${TOKEN}/${PARTS_LIST}`)).status, 200, "and the file still reads");
	assert.equal((await postJson(port, PARTS_REMOVE, { id: JSON.parse(small.body).id })).status, 200, "Remove still works on a nearly full file");
});

// canvas-server-data S10: parts/remove runs under the same per-design exclusivity as the implement-part delivery, so a
// Remove that arrives while a part is being delivered waits for that delivery to settle.

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

async function inFlightPart(t: TestContext) {
	const { root } = fixture(t);
	const delivery = deferred<undefined>();
	const delivered: DesignImplementPartRequest[] = [];
	const server = await startDesignCanvasServer({
		designRoot: root,
		onComment: () => {},
		onImplementPart: (request) => { delivered.push(request); return delivery.promise; },
		randomToken: () => TOKEN,
	});
	t.after(() => server.close());
	const implement = postJson(server.port, PARTS, { file: "01-hero.html", selector: "h1" });
	// Bounded: a route that answers without delivering, or never delivers, fails here instead of hanging.
	let implementSettled = false;
	void implement.then(() => { implementSettled = true; }, () => { implementSettled = true; });
	const deadline = Date.now() + 5000;
	while (delivered.length === 0 && !implementSettled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	if (delivered.length === 0) {
		assert.fail(implementSettled ? `implement-part answered ${(await implement).status} without delivering` : "implement-part did not deliver within 5 s");
	}
	assert.equal(delivered.length, 1, "the delivery callback ran once");
	const id = delivered[0].part.id;
	let removeSettled = false;
	const remove = postJson(server.port, PARTS_REMOVE, { id }).finally(() => { removeSettled = true; });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(removeSettled, false, "the Remove waits while the delivery is in flight");
	assert.deepEqual(JSON.parse(readFileSync(partsFile(root), "utf8")).parts.map((part: { id: string }) => part.id), [id], "the part is still on disk while it is delivered");
	return { root, delivery, implement, remove, id };
}

test("S10: a Remove fired while implement-part is delivering waits for it, then removes the delivered part", async (t) => {
	const { root, delivery, implement, remove, id } = await inFlightPart(t);
	delivery.resolve(undefined);
	const [implemented, removed] = await Promise.all([implement, remove]);
	assert.equal(implemented.status, 202);
	assert.deepEqual(JSON.parse(implemented.body), { ok: true, id, queued: false });
	assert.equal(removed.status, 200);
	assert.deepEqual(JSON.parse(removed.body), { ok: true, id });
	assert.deepEqual(JSON.parse(readFileSync(partsFile(root), "utf8")), { version: 1, parts: [] });
});

test("S10: a Remove fired while implement-part is delivering finds nothing once the failed delivery takes the part back", async (t) => {
	const { root, delivery, implement, remove } = await inFlightPart(t);
	delivery.reject(new Error("session closed"));
	const [implemented, removed] = await Promise.all([implement, remove]);
	assert.equal(implemented.status, 500);
	assert.deepEqual(JSON.parse(implemented.body), { error: "delivery-failed", slug: "alpha", file: "01-hero.html", reason: "session closed" });
	assert.equal(removed.status, 404, "the part was taken back before the Remove ran");
	assert.deepEqual(JSON.parse(removed.body), { error: "not-found" });
	assert.deepEqual(JSON.parse(readFileSync(partsFile(root), "utf8")), { version: 1, parts: [] });
});

// S15: the canvas Implement route records the handoff in design/<slug>/handoffs.json.

const handoffsOf = (root: string, slug = "alpha") => JSON.parse(readFileSync(join(root, slug, "handoffs.json"), "utf8"));

test("implement records the handoff as sent and chosen before delivery, with queued from onImplement", async (t) => {
	const seen: unknown[] = [];
	const state = { busy: true, root: "" };
	const started = await start(t, {
		onImplement: () => {
			seen.push(handoffsOf(state.root));
			return { queued: state.busy };
		},
	});
	state.root = started.root;
	const queued = await postJson(started.port, "api/designs/alpha/implement", { file: "01-hero.html" });
	assert.equal(queued.status, 202);
	assert.deepEqual(JSON.parse(queued.body), { ok: true, slug: "alpha", file: "01-hero.html", queued: true });
	assert.equal(seen.length, 1);
	const before = seen[0] as { chosen: string; handoffs: Record<string, { status: string }> };
	assert.equal(before.chosen, "01-hero.html", "recorded before delivery");
	assert.equal(before.handoffs["01-hero.html"].status, "sent");
	const afterQueued = handoffsOf(state.root);
	assert.equal(afterQueued.chosen, "01-hero.html");
	assert.deepEqual({ status: afterQueued.handoffs["01-hero.html"].status, queued: afterQueued.handoffs["01-hero.html"].queued }, { status: "sent", queued: true });
	assert.match(afterQueued.handoffs["01-hero.html"].sentAt, /^\d{4}-\d\d-\d\dT/);

	state.busy = false;
	const immediate = await postJson(started.port, "api/designs/alpha/implement", { file: "02-bare.html" });
	assert.deepEqual(JSON.parse(immediate.body), { ok: true, slug: "alpha", file: "02-bare.html", queued: false });
	const moved = handoffsOf(state.root);
	assert.equal(moved.chosen, "02-bare.html", "handing off another artboard moves chosen");
	assert.equal(moved.handoffs["02-bare.html"].queued, false);
	assert.equal(moved.handoffs["01-hero.html"].queued, true, "the earlier handoff keeps its state");
});

test("implement links the handoff to the design's feature document", async (t) => {
	const { port, root } = await start(t);
	writeFileSync(join(root, "alpha", "design.json"), JSON.stringify({ title: "Alpha", feature: "odd/tasks/login.md", artboards: [{ file: "01-hero.html", title: "H", width: 10, height: 10 }] }));
	assert.equal((await postJson(port, "api/designs/alpha/implement", { file: "01-hero.html" })).status, 202);
	assert.equal(handoffsOf(root).handoffs["01-hero.html"].feature, "odd/tasks/login.md");
});

test("a failed delivery takes the handoff back, and an invalid handoffs.json refuses the handoff untouched", async (t) => {
	const { root } = fixture(t);
	const failing = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplement: () => { throw new Error("boom"); }, randomToken: () => TOKEN });
	t.after(() => failing.close());
	assert.equal((await postJson(failing.port, "api/designs/alpha/implement", { file: "01-hero.html" })).status, 500);
	assert.deepEqual(handoffsOf(root), { version: 1, chosen: null, handoffs: {} }, "no handoff is left behind");

	const calls: unknown[] = [];
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplement: (request) => { calls.push(request); }, randomToken: () => "other-token-0123456789abcdef" });
	t.after(() => server.close());
	const path = join(root, "alpha", "handoffs.json");
	writeFileSync(path, "{ broken");
	const reply = await rawRequest(server.port, "/other-token-0123456789abcdef/api/designs/alpha/implement", { method: "POST", headers: { Origin: `http://127.0.0.1:${server.port}`, "Content-Type": "application/json" }, body: JSON.stringify({ file: "01-hero.html" }) });
	assert.equal(reply.status, 422);
	assert.equal(JSON.parse(reply.body).error, "invalid-handoffs");
	assert.equal(readFileSync(path, "utf8"), "{ broken", "never overwritten");
	assert.deepEqual(calls, [], "nothing is delivered");
	assert.equal((await rawRequest(server.port, "/other-token-0123456789abcdef/api/designs/alpha/handoffs")).status, 422);
});

test("GET handoffs returns the design's handoffs.json, or an empty document", async (t) => {
	const { port, base, root } = await start(t);
	assert.deepEqual(JSON.parse((await rawRequest(port, `${base}api/designs/alpha/handoffs`)).body), { version: 1, chosen: null, handoffs: {} });
	await postJson(port, "api/designs/alpha/implement", { file: "01-hero.html" });
	const reply = await rawRequest(port, `${base}api/designs/alpha/handoffs`);
	assert.equal(reply.status, 200);
	assert.match(String(reply.headers["content-type"]), /^application\/json/);
	assert.deepEqual(JSON.parse(reply.body), handoffsOf(root));
	assert.equal((await rawRequest(port, `${base}api/designs/missing/handoffs`)).status, 404);
	assert.equal((await rawRequest(port, `${base}api/designs/Bad_Slug/handoffs`)).status, 404);
	assert.equal((await rawRequest(port, `${base}api/designs/alpha/handoffs/extra`)).status, 404);
});

test("the handoffs route keeps the Host, token, Origin and method rules", async (t) => {
	const { port } = await start(t);
	const path = `/${TOKEN}/api/designs/alpha/handoffs`;
	assert.equal((await rawRequest(port, path)).status, 200);
	assert.equal((await rawRequest(port, path, { headers: { Origin: `http://localhost:${port}` } })).status, 200);
	for (const origin of ["http://evil.example", "null", `http://localhost:${port + 1}`, `http://localhost.evil.test:${port}`]) {
		assert.equal((await rawRequest(port, path, { headers: { Origin: origin } })).status, 403, origin);
	}
	assert.equal((await rawRequest(port, path, { host: `evil.example:${port}` })).status, 421);
	assert.equal((await rawRequest(port, `/wrong-token-0123456789/api/designs/alpha/handoffs`)).status, 404);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }, body: "{}" })).status, 405);
});

test("a refused implement request records no handoff", async (t) => {
	const { port, root } = await start(t);
	const path = `/${TOKEN}/api/designs/alpha/implement`;
	const body = JSON.stringify({ file: "01-hero.html" });
	const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
	await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: "null" }, body });
	await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: "http://evil.example" }, body });
	await rawRequest(port, path, { method: "POST", headers: own, body, host: `evil.example:${port}` });
	await rawRequest(port, `/wrong-token-0123456789/api/designs/alpha/implement`, { method: "POST", headers: own, body });
	await postJson(port, "api/designs/alpha/implement", { file: "sub/inner.html" });
	assert.throws(() => readFileSync(join(root, "alpha", "handoffs.json")), /ENOENT/);
});

test("events stream a change when handoffs.json is written", async (t) => {
	if (!FS_WATCH_AVAILABLE) return t.skip(FS_WATCH_SKIP);
	const { port } = await start(t);
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await postJson(port, "api/designs/alpha/implement", { file: "01-hero.html" })).status, 202);
	await events.waitFor(/event: change\ndata: \{"slug":"alpha","file":"handoffs\.json"\}\n\n/);
});

test("the canvas CSP frames only loopback previews, and the artboard CSP is unchanged", async (t) => {
	const { port, base } = await start(t);
	assert.equal(String((await rawRequest(port, base)).headers["content-security-policy"]), [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data:",
		"connect-src 'self'",
		// No [::1]: CSP host sources have no IPv6 form, so browsers reject it and log an error on every load.
		"frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; "));
	assert.equal(String((await rawRequest(port, `${base}files/alpha/01-hero.html`)).headers["content-security-policy"]), [
		"sandbox allow-scripts",
		`default-src 'self' http://127.0.0.1:${port} 'unsafe-inline' data: blob:`,
		"connect-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`frame-ancestors http://127.0.0.1:${port} http://localhost:${port}`,
	].join("; "));
});

test("a valid manifest feature link is kept; an invalid one is dropped and reported", async (t) => {
	const { port, base, root } = await start(t);
	const withFeature = (feature: unknown) => JSON.stringify({ title: "Alpha", artboards: [{ file: "01-hero.html", title: "H", width: 10, height: 10 }], feature });
	writeFileSync(join(root, "alpha", "design.json"), withFeature("odd/tasks/pricing-page.md"));
	const kept = JSON.parse((await rawRequest(port, `${base}api/designs/alpha`)).body);
	assert.equal(kept.feature, "odd/tasks/pricing-page.md");
	assert.equal(kept.warnings, undefined);
	for (const feature of ["../x.md", "/abs.md", "odd/tasks/x.txt", "odd/other/x.md", "odd/tasks/../x.md", "odd/tasks/.x.md", "odd/tasks/a/b.md", " odd/tasks/x.md", 7]) {
		writeFileSync(join(root, "alpha", "design.json"), withFeature(feature));
		const reply = await rawRequest(port, `${base}api/designs/alpha`);
		assert.equal(reply.status, 200, String(feature));
		const manifest = JSON.parse(reply.body);
		assert.equal("feature" in manifest, false, String(feature));
		assert.equal(manifest.warnings.length, 1, String(feature));
		assert.match(manifest.warnings[0], /feature/);
	}
});

test("close() is idempotent, ends event streams and frees the port", async (t) => {
	const { root } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, randomToken: () => TOKEN });
	const events = openEvents(server.port);
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	await Promise.all([server.close(), server.close()]);
	await server.close();
	await assert.rejects(rawRequest(server.port, `/${TOKEN}/`), /ECONNREFUSED/);
});

test("a missing design root lists nothing and still serves the canvas", async (t) => {
	const parent = scratch(t, "gentle-design-empty-");
	const server = await startDesignCanvasServer({ designRoot: join(parent, "design"), onComment: () => {}, randomToken: () => TOKEN });
	t.after(() => server.close());
	assert.deepEqual(JSON.parse((await rawRequest(server.port, `/${TOKEN}/api/designs`)).body), { designs: [] });
	assert.equal((await rawRequest(server.port, `/${TOKEN}/`)).status, 200);
	assert.equal((await rawRequest(server.port, `/${TOKEN}/files/alpha/01.html`)).status, 404);
});

test("formatDesignComment builds the exact session message with the comment id", () => {
	assert.equal(formatDesignComment({ id: "k3x9p2", slug: "landing", file: "02-bold.html", selector: "body > header > h1", excerpt: "Ship faster", comment: "Make the headline shorter." }), [
		"Design comment for design/landing/02-bold.html",
		"",
		"Design: landing",
		"Artboard: design/landing/02-bold.html",
		"Comment id: k3x9p2",
		"Element: body > header > h1",
		"Excerpt: \"Ship faster\"",
		"",
		"Comment:",
		"Make the headline shorter.",
		"",
		"Edit only the artboard design/landing/02-bold.html, following the gentle-design skill.",
		"When it is applied, mark it resolved with the gentle_design_comments tool (action \"resolve\", slug \"landing\", ids [\"k3x9p2\"], note \"<one line on what you changed>\"), or set its status to \"resolved\" in design/landing/comments.json.",
	].join("\n"));
	assert.match(formatDesignComment({ ...VALID, id: "a1", excerpt: "" }), /\nExcerpt: \(none\)\n/);
});

test("formatDesignCommentBatch builds one exact message listing every comment", () => {
	const batch: DesignComment[] = [
		{ id: "aaa111", slug: "landing", file: "01-calm.html", selector: "#cta", excerpt: "Start", comment: "Make it green." },
		{ id: "bbb222", slug: "landing", file: "02-bold.html", selector: "body > h1", excerpt: "", comment: "Shorter.\nAnd bolder." },
	];
	assert.equal(formatDesignCommentBatch(batch), [
		"Design comments for design/landing (2)",
		"",
		"1. Comment id: aaa111",
		"   Artboard: design/landing/01-calm.html",
		"   Element: #cta",
		"   Excerpt: \"Start\"",
		"   Comment:",
		"   Make it green.",
		"",
		"2. Comment id: bbb222",
		"   Artboard: design/landing/02-bold.html",
		"   Element: body > h1",
		"   Excerpt: (none)",
		"   Comment:",
		"   Shorter.",
		"   And bolder.",
		"",
		"Apply each comment following the gentle-design skill, editing only the artboard it names.",
		"When a comment is applied, mark it resolved with the gentle_design_comments tool (action \"resolve\", slug \"landing\", ids [\"aaa111\", \"bbb222\"], note \"<one line on what you changed>\"), or set its status to \"resolved\" in design/landing/comments.json.",
	].join("\n"));
});

test("canvas assets sandbox artboards without allow-same-origin and reference no remote URL", () => {
	const boards = readFileSync(join(ASSET_DIR, "canvas-boards.js"), "utf8");
	assert.match(boards, /setAttribute\("sandbox", "allow-scripts"\)/);
	// The one allow-same-origin is the Compare preview of the running app, another loopback origin (S15).
	const compare = readFileSync(join(ASSET_DIR, "canvas-compare.js"), "utf8");
	assert.deepEqual(compare.match(/"[^"\n]*allow-same-origin[^"\n]*"/g), ['"allow-scripts allow-same-origin allow-forms allow-popups"']);
	for (const name of ["index.html", ...Object.keys(DESIGN_CANVAS_ASSETS)]) {
		const source = readFileSync(join(ASSET_DIR, name), "utf8");
		if (name !== "canvas-compare.js") assert.ok(!source.includes("allow-same-origin"), `${name} must not grant allow-same-origin`);
		assert.ok(!/https?:\/\//i.test(source), `${name} must not reference remote URLs`);
	}
	const inspector = readFileSync(join(ASSET_DIR, "inspector.js"), "utf8");
	assert.match(inspector, /gd:pick/);
	assert.match(readFileSync(join(ASSET_DIR, "canvas-messages.js"), "utf8"), /event\.source/);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64 * 1024, 7)]);
const SHOT = { mimeType: "image/png", data: PNG.toString("base64") };

test("a comment with a screenshot is stored, delivered with its image, and served by the screenshot route", async (t) => {
	const { port, root, comments, base } = await start(t);
	const reply = await postComment(port, { ...VALID, screenshot: SHOT });
	assert.equal(reply.status, 202, reply.body);
	const [saved] = storedComments(root);
	const path = `design/alpha/.screenshots/${saved.id}.png`;
	assert.deepEqual(comments, [{ ...VALID, id: saved.id, screenshot: { path, mimeType: "image/png", data: SHOT.data } }]);
	assert.deepEqual(readFileSync(join(root, "alpha", ".screenshots", `${saved.id}.png`)), PNG);
	const image = await rawRequest(port, `${base}api/designs/alpha/comments/${saved.id}/screenshot`);
	assert.equal(image.status, 200);
	assert.equal(image.headers["content-type"], "image/png");
	assert.deepEqual(image.bytes, PNG);
	assert.equal((await rawRequest(port, `${base}api/designs/alpha/comments/${saved.id}/screenshot`, { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await postComment(port, { ...VALID, mode: "collect" })).status, 201);
	const plain = storedComments(root)[1];
	assert.equal("screenshot" in plain, false);
	assert.equal((await rawRequest(port, `${base}api/designs/alpha/comments/${plain.id}/screenshot`)).status, 404);
	assert.equal((await rawRequest(port, `${base}api/designs/alpha/comments/nope/screenshot`)).status, 404);
	assert.equal((await rawRequest(port, `${base}api/designs/alpha/comments/${saved.id}/screenshot`, { method: "POST" })).status, 405);
});

test("an invalid screenshot is refused with 400 and stores nothing", async (t) => {
	const { port, root, comments } = await start(t);
	const invalid = [
		{ mimeType: "image/png", data: "not base64!" },
		{ mimeType: "image/png", data: "" },
		{ mimeType: "image/svg+xml", data: SHOT.data },
		{ mimeType: "image/jpeg", data: SHOT.data },
		{ mimeType: "image/png" },
		"image",
	];
	for (const screenshot of invalid) {
		const reply = await postComment(port, { ...VALID, screenshot });
		assert.equal(reply.status, 400, JSON.stringify(screenshot).slice(0, 80));
		assert.equal(JSON.parse(reply.body).error, "invalid-screenshot");
	}
	assert.deepEqual(comments, []);
	assert.equal(existsSync(join(root, "alpha", "comments.json")), false);
	assert.equal(existsSync(join(root, "alpha", ".screenshots")), false);
	assert.equal((await postComment(port, { ...VALID, comment: "x".repeat(17 * 1024), screenshot: SHOT })).status, 413, "the comment fields keep their own body limit");
});

test("send-all delivers the screenshots of collected comments in the batch", async (t) => {
	const { port, root, batches } = await start(t);
	await postComment(port, { ...VALID, comment: "first", mode: "collect", screenshot: SHOT });
	await postComment(port, { ...VALID, comment: "second", mode: "collect" });
	assert.equal((await postJson(port, "api/designs/alpha/comments/send-all", {})).status, 202);
	const [first, second] = storedComments(root);
	assert.deepEqual(batches, [[
		{ ...VALID, comment: "first", id: first.id, screenshot: { path: `design/alpha/.screenshots/${first.id}.png`, mimeType: "image/png", data: SHOT.data } },
		{ ...VALID, comment: "second", id: second.id },
	]]);
});

test("formatDesignComment names the screenshot, and the session content attaches it", () => {
	const comment: DesignComment = { id: "k3x9p2", slug: "landing", file: "02-bold.html", selector: "#cta", excerpt: "Go", comment: "The button jumps mid-animation.", screenshot: { path: "design/landing/.screenshots/k3x9p2.png", mimeType: "image/png", data: "iVBORw0KGgo=" } };
	const text = [
		"Design comment for design/landing/02-bold.html",
		"",
		"Design: landing",
		"Artboard: design/landing/02-bold.html",
		"Comment id: k3x9p2",
		"Element: #cta",
		"Excerpt: \"Go\"",
		"Screenshot: design/landing/.screenshots/k3x9p2.png (attached; open it with the read tool if you cannot see it)",
		"",
		"Comment:",
		"The button jumps mid-animation.",
		"",
		"Edit only the artboard design/landing/02-bold.html, following the gentle-design skill.",
		"When it is applied, mark it resolved with the gentle_design_comments tool (action \"resolve\", slug \"landing\", ids [\"k3x9p2\"], note \"<one line on what you changed>\"), or set its status to \"resolved\" in design/landing/comments.json.",
	].join("\n");
	assert.equal(formatDesignComment(comment), text);
	assert.deepEqual(designCommentContent(comment), [{ type: "text", text }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
	const { screenshot: _drop, ...plain } = comment;
	assert.equal(designCommentContent(plain), formatDesignComment(plain));
	const unreadable = { ...comment, screenshot: { path: comment.screenshot!.path, mimeType: "image/png" } };
	assert.match(formatDesignComment(unreadable), /\nScreenshot: design\/landing\/\.screenshots\/k3x9p2\.png \(open it with the read tool\)\n/);
	assert.equal(designCommentContent(unreadable), formatDesignComment(unreadable));
});

test("a batch attaches at most six screenshots, in order, and names the rest for the read tool", () => {
	const batch: DesignComment[] = Array.from({ length: 8 }, (_, index) => ({
		id: `c${index}`, slug: "landing", file: "01-calm.html", selector: "#cta", excerpt: "", comment: `note ${index}`,
		...(index === 1 ? {} : { screenshot: { path: `design/landing/.screenshots/c${index}.png`, mimeType: "image/png", data: `data${index}` } }),
	}));
	const text = formatDesignCommentBatch(batch);
	assert.match(text, /\n   Excerpt: \(none\)\n   Screenshot: design\/landing\/\.screenshots\/c0\.png \(attached; open it with the read tool if you cannot see it\)\n   Comment:\n/);
	assert.ok(!text.includes("c1.png"));
	assert.match(text, /c6\.png \(attached; open it with the read tool if you cannot see it\)/);
	assert.match(text, /c7\.png \(open it with the read tool\)\n/);
	const content = designCommentBatchContent(batch);
	assert.ok(Array.isArray(content));
	assert.deepEqual(content, [{ type: "text", text }, ...[0, 2, 3, 4, 5, 6].map((index) => ({ type: "image", data: `data${index}`, mimeType: "image/png" }))]);
	const plain = batch.map(({ screenshot: _drop, ...rest }) => rest);
	assert.equal(designCommentBatchContent(plain), formatDesignCommentBatch(plain));
});

test("module names are served only as one exact, flat segment", async (t) => {
	const { port, base } = await start(t);
	for (const path of ["sub/canvas-boot.js", "canvas-boot.js/", "canvas-boot.js%2F", "..%2Fcanvas-boot.js", "Canvas-Boot.js", "__proto__", "constructor"]) {
		assert.equal((await rawRequest(port, `${base}assets/${path}`)).status, 404, path);
	}
});

test("the page config tells the canvas which deliveries exist, and the 501 checks stay", async (t) => {
	const { root } = fixture(t);
	const configOf = async (port: number, token: string) => JSON.parse(/<script id="gd-config" type="application\/json">([^<]*)<\/script>/.exec((await rawRequest(port, `/${token}/`)).body)![1]);

	const bare = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, randomToken: () => TOKEN });
	t.after(() => bare.close());
	assert.deepEqual((await configOf(bare.port, TOKEN)).delivery, { comment: true, batch: false, implement: false, variant: false, part: false });
	const batchOnly = await postJson(bare.port, "api/designs/alpha/comments/send-all", {});
	// Nothing unsent: the batch capability is only checked when there is something to deliver.
	assert.equal(batchOnly.status, 200);
	await postComment(bare.port, { ...VALID, mode: "collect" });
	const refused = await postJson(bare.port, "api/designs/alpha/comments/send-all", {});
	assert.equal(refused.status, 501);
	assert.equal(JSON.parse(refused.body).error, "batch-delivery-unavailable");
	const noImplement = await postJson(bare.port, "api/designs/alpha/implement", { file: "01-a.html" });
	assert.equal(noImplement.status, 501);
	assert.equal(JSON.parse(noImplement.body).error, "implement-unavailable");

	const batch = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onComments: () => {}, randomToken: () => "b".repeat(32) });
	t.after(() => batch.close());
	assert.deepEqual((await configOf(batch.port, "b".repeat(32))).delivery, { comment: true, batch: true, implement: false, variant: false, part: false });
	const implement = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplement: () => ({ queued: false }), randomToken: () => "i".repeat(32) });
	t.after(() => implement.close());
	assert.deepEqual((await configOf(implement.port, "i".repeat(32))).delivery, { comment: true, batch: false, implement: true, variant: false, part: false });
	const variant = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onVariant: () => ({ queued: false }), randomToken: () => "v".repeat(32) });
	t.after(() => variant.close());
	assert.deepEqual((await configOf(variant.port, "v".repeat(32))).delivery, { comment: true, batch: false, implement: false, variant: true, part: false });
	const noVariant = await postJson(bare.port, "api/designs/alpha/variant", { file: "01-a.html", instruction: "Bolder" });
	assert.equal(noVariant.status, 501);
	assert.equal(JSON.parse(noVariant.body).error, "variant-unavailable");
	const part = await startDesignCanvasServer({ designRoot: root, onComment: () => {}, onImplementPart: () => ({ queued: false }), randomToken: () => "p".repeat(32) });
	t.after(() => part.close());
	assert.deepEqual((await configOf(part.port, "p".repeat(32))).delivery, { comment: true, batch: false, implement: false, variant: false, part: true });
});

// S7: the viewport a comment was made at.

const VIEWPORT = { width: 390, height: 844 };

test("S7: a comment with a viewport is stored with it and delivered with it; without one the key is absent", async (t) => {
	const { port, root, comments } = await start(t);
	const reply = await postComment(port, { ...VALID, viewport: VIEWPORT });
	assert.equal(reply.status, 202);
	const { id } = JSON.parse(reply.body);
	assert.deepEqual(comments, [{ ...VALID, id, viewport: VIEWPORT }], "the session comment carries the viewport");
	assert.deepEqual((storedComments(root)[0] as Stored & { viewport?: unknown }).viewport, VIEWPORT);
	assert.equal((await postComment(port, VALID)).status, 202);
	assert.equal("viewport" in comments[1], false);
	assert.equal("viewport" in storedComments(root)[1], false, "never written when absent");
	// Collected comments keep it too, and a Send all delivers it.
	const collected = await postComment(port, { ...VALID, mode: "collect", viewport: { width: 720, height: 820 } });
	assert.equal(collected.status, 201);
	assert.deepEqual((storedComments(root)[2] as Stored & { viewport?: unknown }).viewport, { width: 720, height: 820 });
});

test("S7: an invalid viewport is refused with 400 invalid-viewport and leaves comments.json unchanged", async (t) => {
	const { port, root, comments } = await start(t);
	const invalid: unknown[] = [
		{ width: 239, height: 844 }, { width: 4097, height: 844 }, { width: 390, height: 0 }, { width: 390, height: 20001 },
		{ width: 390.5, height: 844 }, { width: "390", height: 844 }, { width: 390 }, {}, null, [], "390x844", 390,
	];
	for (const viewport of invalid) {
		const reply = await postComment(port, { ...VALID, viewport });
		assert.equal(reply.status, 400, JSON.stringify(viewport));
		assert.equal(JSON.parse(reply.body).error, "invalid-viewport");
	}
	assert.deepEqual(comments, [], "nothing was delivered");
	assert.equal(existsSync(join(root, "alpha", "comments.json")), false, "nothing was stored");
	// A stored file stays byte for byte as it was.
	assert.equal((await postComment(port, VALID)).status, 202);
	const before = readFileSync(join(root, "alpha", "comments.json"), "utf8");
	assert.equal((await postComment(port, { ...VALID, viewport: { width: 1, height: 1 } })).status, 400);
	assert.equal(readFileSync(join(root, "alpha", "comments.json"), "utf8"), before);
});

test("S7: formatDesignComment names the viewport so the agent edits for that width, and says nothing without one", () => {
	const comment: DesignComment = { id: "k3x9p2", slug: "landing", file: "02-bold.html", selector: "#cta", excerpt: "Go", comment: "Too wide.", viewport: { width: 390, height: 844 } };
	const text = formatDesignComment(comment);
	assert.match(text, /\nExcerpt: "Go"\nViewport: Phone 390 × 844 \(the comment was made at this size; make the change hold at this width\)\n\nComment:\n/);
	assert.match(formatDesignComment({ ...comment, viewport: { width: 720, height: 820 } }), /\nViewport: 720 × 820 \(/);
	const { viewport: _drop, ...plain } = comment;
	assert.ok(!formatDesignComment(plain).includes("Viewport:"));
});

test("S7: formatDesignCommentBatch names each comment's viewport, and only those that have one", () => {
	const batch: DesignComment[] = [
		{ id: "aaa111", slug: "landing", file: "01-calm.html", selector: "#cta", excerpt: "Start", comment: "Make it green.", viewport: { width: 820, height: 1180 } },
		{ id: "bbb222", slug: "landing", file: "02-bold.html", selector: "body > h1", excerpt: "", comment: "Shorter." },
	];
	const text = formatDesignCommentBatch(batch);
	assert.match(text, /\n   Excerpt: "Start"\n   Viewport: Tablet 820 × 1180 \(the comment was made at this size; make the change hold at this width\)\n   Comment:\n/);
	assert.equal(text.match(/Viewport:/g)?.length, 1);
	assert.match(text, /\n   Excerpt: \(none\)\n   Comment:\n   Shorter\.\n/);
});

// Token inspector (T1): the tokens of design/system.md, read-only.

const SYSTEM_MD = "# System\n\n## Colors\n\n| Token | Value |\n| --- | --- |\n| `--bg` | `#1a1218` |\n| `--accent` | `#f095c8` |\n";

test("S1: GET api/system/tokens gives the tokens of design/system.md, and none when it is missing", async (t) => {
	const { port, base, root } = await start(t);
	const missing = await rawRequest(port, `${base}api/system/tokens`);
	assert.equal(missing.status, 200);
	assert.deepEqual(JSON.parse(missing.body), { exists: false, tokens: [] });
	writeFileSync(join(root, "system.md"), SYSTEM_MD);
	const present = await rawRequest(port, `${base}api/system/tokens`);
	assert.equal(present.status, 200);
	assert.match(String(present.headers["content-type"]), /^application\/json/);
	assert.deepEqual(JSON.parse(present.body), { exists: true, tokens: [
		{ name: "--bg", value: "#1a1218", section: "Colors", group: "color" },
		{ name: "--accent", value: "#f095c8", section: "Colors", group: "color" },
	] });
	// The file is read on every request, so a change shows without restarting the server.
	writeFileSync(join(root, "system.md"), `${SYSTEM_MD}| \`--text\` | \`#f6eff3\` |\n`);
	assert.equal(JSON.parse((await rawRequest(port, `${base}api/system/tokens`)).body).tokens.length, 3);
});

test("S1: an empty, malformed, huge, linked or directory system.md never fails the route", async (t) => {
	const { port, base, root } = await start(t);
	const tokens = async () => rawRequest(port, `${base}api/system/tokens`);
	writeFileSync(join(root, "system.md"), "");
	assert.deepEqual(JSON.parse((await tokens()).body), { exists: true, tokens: [] });
	writeFileSync(join(root, "system.md"), "| `--a\n|||`| `\u0000\n");
	const malformed = await tokens();
	assert.equal(malformed.status, 200);
	assert.deepEqual(JSON.parse(malformed.body).tokens, []);
	writeFileSync(join(root, "system.md"), `${SYSTEM_MD}${"x".repeat(300 * 1024)}`);
	assert.deepEqual(JSON.parse((await tokens()).body), { exists: true, tokens: [], problem: "too-large" });
	rmSync(join(root, "system.md"));
	const outside = scratch(t, "gentle-design-tokens-outside-");
	writeFileSync(join(outside, "system.md"), SYSTEM_MD);
	symlinkSync(join(outside, "system.md"), join(root, "system.md"));
	assert.deepEqual(JSON.parse((await tokens()).body), { exists: false, tokens: [] }, "a link out of the design root is not read");
	rmSync(join(root, "system.md"));
	mkdirSync(join(root, "system.md"));
	assert.deepEqual(JSON.parse((await tokens()).body), { exists: false, tokens: [] });
});

test("S1: the tokens route keeps the Host, token, Origin and method rules, and system.md stays unserved", async (t) => {
	const { port, base, root } = await start(t);
	writeFileSync(join(root, "system.md"), SYSTEM_MD);
	const path = "api/system/tokens";
	assert.equal((await rawRequest(port, `${base}${path}`, { host: `evil.example:${port}` })).status, 421);
	assert.equal((await rawRequest(port, `/wrong-token-0123456789/${path}`)).status, 404);
	assert.equal((await rawRequest(port, `${base}${path}`, { headers: { Origin: "http://evil.example" } })).status, 403);
	assert.equal((await rawRequest(port, `${base}${path}`, { headers: { Origin: "null" } })).status, 403, "a sandboxed artboard may not read the tokens");
	assert.equal((await rawRequest(port, `${base}${path}`, { headers: { Origin: `http://localhost:${port}` } })).status, 200);
	assert.equal((await rawRequest(port, `${base}${path}`, { method: "POST", headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }, body: "{}" })).status, 405);
	for (const extra of ["api/system/tokens/x", "api/system/token", "system.md"]) assert.equal((await rawRequest(port, `${base}${extra}`)).status, 404, extra);
});


// canvas-trim S3: version history is gone; its routes answer like any unknown path.

test("canvas-trim S3: the history routes are unknown paths (404 whatever the method) and seeing a design writes no .history", async (t) => {
	const { server, port, base, root } = await start(t);
	assert.equal((await rawRequest(port, `${base}api/designs/alpha`)).status, 200);
	server.show("alpha");
	for (const path of ["api/designs/alpha/history", "history/alpha/1/01-hero.html"]) {
		const reply = await rawRequest(port, `${base}${path}`);
		assert.equal(reply.status, 404, path);
		assert.deepEqual(JSON.parse(reply.body), { error: "not-found" }, path);
		assert.equal((await rawRequest(port, `${base}${path}`, { method: "POST", headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }, body: "{}" })).status, 404, `POST ${path}`);
	}
	const restore = await postJson(port, "api/designs/alpha/history/restore", { file: "01-hero.html", n: 1 });
	assert.equal(restore.status, 404);
	assert.deepEqual(JSON.parse(restore.body), { error: "not-found" });
	assert.equal((await rawRequest(port, `${base}api/designs/alpha/history/restore`)).status, 404, "GET restore");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(existsSync(join(root, "alpha", ".history")), false);
});

// canvas-layout S3: design/<slug>/layout.json, read and written whole by the canvas through the server.

const LAYOUT_PATH = "api/designs/alpha/layout";
const SAVED_LAYOUT = { arrangement: "free", positions: { system: { x: 0, y: 0 }, "01-hero.html": { x: 1520, y: 0 }, "02-bare.html": { x: 0, y: 1280 } } };

test("canvas-layout S3: GET layout is null without layout.json; POST validates and saves it whole; GET gives it back", async (t) => {
	const { port, base, root } = await start(t);
	const missing = await rawRequest(port, `${base}${LAYOUT_PATH}`);
	assert.equal(missing.status, 200);
	assert.deepEqual(JSON.parse(missing.body), { layout: null });
	const saved = await postJson(port, LAYOUT_PATH, SAVED_LAYOUT);
	assert.equal(saved.status, 200);
	assert.deepEqual(JSON.parse(saved.body), { ok: true, layout: SAVED_LAYOUT });
	assert.equal(readFileSync(join(root, "alpha", "layout.json"), "utf8"), `${JSON.stringify(SAVED_LAYOUT, null, 2)}\n`);
	const read = await rawRequest(port, `${base}${LAYOUT_PATH}`);
	assert.equal(read.status, 200);
	assert.deepEqual(JSON.parse(read.body), { layout: SAVED_LAYOUT });
	// A broken file is no layout the canvas can use, but it is no missing one either (S17); the next save replaces it.
	writeFileSync(join(root, "alpha", "layout.json"), "{ broken");
	assert.equal((await rawRequest(port, `${base}${LAYOUT_PATH}`)).status, 422);
	assert.equal((await postJson(port, LAYOUT_PATH, SAVED_LAYOUT)).status, 200);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "alpha", "layout.json"), "utf8")), SAVED_LAYOUT);
});

test("canvas-layout S17: GET layout tells a missing layout.json (null) from one it cannot read or use (422 with the reason), and changes nothing on disk", async (t) => {
	const { port, base, root } = await start(t);
	const file = join(root, "alpha", "layout.json");
	const get = async () => {
		const reply = await rawRequest(port, `${base}${LAYOUT_PATH}`);
		return { status: reply.status, body: JSON.parse(reply.body) };
	};
	assert.deepEqual(await get(), { status: 200, body: { layout: null } }, "a missing file is no layout");
	const cases: Array<[string, string]> = [
		["{ broken", "not valid JSON"],
		["[]", "layout must be a JSON object"],
		[JSON.stringify({ arrangement: "row" }), "positions must be an object"],
		[JSON.stringify({ arrangement: "diagonal", positions: {} }), 'arrangement must be "row", "column", "grid" or "free"'],
		["x".repeat(300 * 1024), "larger than 262144 bytes"],
	];
	for (const [content, reason] of cases) {
		writeFileSync(file, content);
		assert.deepEqual(await get(), { status: 422, body: { error: "unreadable-layout", reason } }, content.slice(0, 40));
		assert.equal(readFileSync(file, "utf8"), content, "the file is left as it was");
	}
	rmSync(file);
	writeFileSync(join(root, "elsewhere.json"), JSON.stringify(SAVED_LAYOUT));
	symlinkSync(join(root, "elsewhere.json"), file);
	assert.deepEqual(await get(), { status: 422, body: { error: "unreadable-layout", reason: "not a regular file" } }, "a link is never followed");
	rmSync(file);
	mkdirSync(file);
	assert.deepEqual(await get(), { status: 422, body: { error: "unreadable-layout", reason: "not a regular file" } }, "a directory named layout.json");
	assert.equal((await rawRequest(port, `${base}api/designs/missing/layout`)).status, 404, "an unknown design is still not found");
});

test("canvas-layout S23: a position far out of range (1e300) is a layout.json the server cannot use on GET (422) and refuses on POST", async (t) => {
	const { port, base, root } = await start(t);
	const far = { arrangement: "free", positions: { "01-hero.html": { x: 1e300, y: 0 } } };
	const file = join(root, "alpha", "layout.json");
	writeFileSync(file, JSON.stringify(far));
	const read = await rawRequest(port, `${base}${LAYOUT_PATH}`);
	assert.deepEqual({ status: read.status, body: JSON.parse(read.body) }, { status: 422, body: { error: "unreadable-layout", reason: 'positions["01-hero.html"] x and y must be integers between -2000000 and 2000000' } });
	const save = await postJson(port, LAYOUT_PATH, far);
	assert.deepEqual({ status: save.status, body: JSON.parse(save.body) }, { status: 400, body: { error: "invalid-layout", reason: 'positions["01-hero.html"] x and y must be integers between -2000000 and 2000000' } });
	assert.equal(readFileSync(file, "utf8"), JSON.stringify(far), "the file is left as it was");
});

test("canvas-layout S3: an invalid layout is refused with its reason and nothing is written", async (t) => {
	const { port, root } = await start(t);
	const refuse = async (body: unknown, reason: RegExp) => {
		const reply = await postJson(port, LAYOUT_PATH, body);
		assert.equal(reply.status, 400, JSON.stringify(body));
		const answer = JSON.parse(reply.body);
		assert.equal(answer.error, "invalid-layout");
		assert.match(answer.reason, reason);
	};
	await refuse({ arrangement: "diagonal", positions: {} }, /^arrangement must be "row", "column", "grid" or "free"$/);
	await refuse({ arrangement: "row", positions: { "01-hero.html": { x: 1.5, y: 0 } } }, /x and y must be integers/);
	await refuse({ arrangement: "row", positions: { "../beta/01-a.html": { x: 0, y: 0 } } }, /keys must be relative \.html artboard paths/);
	await refuse({ arrangement: "row", positions: {}, extra: true }, /unknown keys: extra/);
	assert.equal(existsSync(join(root, "alpha", "layout.json")), false, "nothing is written");
	assert.equal((await postJson(port, LAYOUT_PATH, SAVED_LAYOUT)).status, 200);
	const before = readFileSync(join(root, "alpha", "layout.json"), "utf8");
	await refuse({ arrangement: "row", positions: { "01-hero.html": { x: 0, y: 3_000_000 } } }, /between -2000000 and 2000000/);
	assert.equal(readFileSync(join(root, "alpha", "layout.json"), "utf8"), before, "the saved layout stays as it was");
	assert.equal((await postJson(port, "api/designs/missing/layout", SAVED_LAYOUT)).status, 404);
	assert.equal((await postJson(port, "api/designs/Not_A_Slug/layout", SAVED_LAYOUT)).status, 404);
	assert.equal(existsSync(join(root, "missing")), false);
});

test("canvas-layout S3: the layout route keeps the Origin, content-type, JSON and method rules", async (t) => {
	const { port, base, root } = await start(t);
	const path = `${base}${LAYOUT_PATH}`;
	const body = JSON.stringify(SAVED_LAYOUT);
	const own = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403, "no Origin");
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, Origin: "http://evil.example" }, body })).status, 403);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: { ...own, "Content-Type": "text/plain" }, body })).status, 415);
	assert.equal((await rawRequest(port, path, { method: "POST", headers: own, body: "not json" })).status, 400);
	const put = await rawRequest(port, path, { method: "PUT", headers: own, body });
	assert.equal(put.status, 405);
	assert.equal(put.headers.allow, "GET, POST");
	assert.equal((await rawRequest(port, path, { headers: { Origin: "http://evil.example" } })).status, 403, "only this server's pages read it");
	assert.equal((await rawRequest(port, path, { headers: { Origin: "null" } })).status, 403, "a sandboxed artboard may not read it");
	assert.equal((await rawRequest(port, `${base}api/designs/missing/layout`)).status, 404);
	assert.equal(existsSync(join(root, "alpha", "layout.json")), false);
	// The other GET-only and POST-only routes keep answering 405 with their one method.
	const comments = await rawRequest(port, `${base}api/designs/alpha/comments`, { method: "POST", headers: own, body: "{}" });
	assert.equal(comments.status, 405);
	assert.equal(comments.headers.allow, "GET");
	const implement = await rawRequest(port, `${base}api/designs/alpha/implement`);
	assert.equal(implement.status, 405);
	assert.equal(implement.headers.allow, "POST");
});

test("canvas-layout S3: saving the layout streams one change for layout.json", async (t) => {
	if (!FS_WATCH_AVAILABLE) return t.skip(FS_WATCH_SKIP);
	const { port } = await start(t);
	const events = openEvents(port);
	t.after(() => events.req.destroy());
	await events.ready;
	await events.waitFor(/: connected\n\n/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await postJson(port, LAYOUT_PATH, SAVED_LAYOUT)).status, 200);
	await events.waitFor(/event: change\ndata: \{"slug":"alpha","file":"layout\.json"\}\n\n/);
});

test("canvas-layout S17: the text route edits an open comment; a changed sent one reaches the session as an edit, an unsent one waits, a resolved, unknown, invalid or cross-origin edit is refused without writing", async (t) => {
	const { port, root, comments } = await start(t);
	await postComment(port, { ...VALID, mode: "collect" });
	await postComment(port, { ...VALID, mode: "collect" });
	await postComment(port, { ...VALID, mode: "collect" });
	const [open, sent, resolved] = storedComments(root);
	const path = join(root, "alpha", "comments.json");
	const document = JSON.parse(readFileSync(path, "utf8"));
	document.comments[1].sentAt = "2026-11-08T10:00:00.000Z";
	document.comments[2].status = "resolved";
	document.comments[2].resolvedAt = "2026-11-08T10:00:00.000Z";
	writeFileSync(path, JSON.stringify(document));
	const edited = await postJson(port, `api/designs/alpha/comments/${open.id}/text`, { comment: "  Make it\r\nmuch bigger  " });
	assert.equal(edited.status, 200);
	assert.equal(JSON.parse(edited.body).comment.comment, "Make it\nmuch bigger", "line endings normalized and trimmed like a new comment");
	assert.equal(JSON.parse(edited.body).sent, false, "an unsent comment waits for Send all");
	assert.equal(storedComments(root)[0].comment, "Make it\nmuch bigger");
	assert.equal(comments.length, 0, "nothing reaches the session for an unsent comment");

	const resent = await postJson(port, `api/designs/alpha/comments/${sent.id}/text`, { comment: "Smaller" });
	assert.equal(resent.status, 200);
	assert.equal(JSON.parse(resent.body).sent, true);
	assert.equal(storedComments(root)[1].comment, "Smaller");
	assert.equal(storedComments(root)[1].sentAt, "2026-11-08T10:00:00.000Z", "it stays sent");
	assert.equal(comments.length, 1);
	assert.deepEqual([comments[0].id, comments[0].comment, comments[0].edited], [sent.id, "Smaller", { previous: "Make it bigger" }]);
	const same = await postJson(port, `api/designs/alpha/comments/${sent.id}/text`, { comment: "Smaller" });
	assert.deepEqual([same.status, JSON.parse(same.body).sent], [200, false]);
	assert.equal(comments.length, 1, "an unchanged text is not sent again");

	const before = readFileSync(path, "utf8");
	const refusal = async (id: string, body: unknown) => {
		const reply = await postJson(port, `api/designs/alpha/comments/${id}/text`, body);
		return [reply.status, JSON.parse(reply.body || "{}").error];
	};
	assert.deepEqual(await refusal(resolved.id, { comment: "New" }), [409, "comment-resolved"]);
	assert.deepEqual(await refusal("zzzzzz", { comment: "New" }), [404, "not-found"]);
	assert.deepEqual(await refusal(open.id, { comment: "   " }), [400, "invalid-comment"]);
	assert.deepEqual(await refusal(open.id, { comment: "x".repeat(2001) }), [400, "invalid-comment"]);
	assert.deepEqual(await refusal(open.id, { comment: 7 }), [400, "invalid-comment"]);
	const foreign = await rawRequest(port, `/${TOKEN}/api/designs/alpha/comments/${open.id}/text`, { method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ comment: "New" }) });
	assert.equal(foreign.status, 403);
	assert.equal(readFileSync(path, "utf8"), before, "no refused edit writes comments.json");
	assert.equal(comments.length, 1);
});

test("canvas-layout S17: when the session refuses the edit of a sent comment, the new text stays saved and the reply says it was not sent", async (t) => {
	const { port, root } = await start(t, { onComment: () => { throw new Error("offline"); } });
	await postComment(port, { ...VALID, mode: "collect" });
	const [saved] = storedComments(root);
	const path = join(root, "alpha", "comments.json");
	const document = JSON.parse(readFileSync(path, "utf8"));
	document.comments[0].sentAt = "2026-11-08T10:00:00.000Z";
	writeFileSync(path, JSON.stringify(document));
	const reply = await postJson(port, `api/designs/alpha/comments/${saved.id}/text`, { comment: "Smaller" });
	assert.equal(reply.status, 500);
	assert.deepEqual(JSON.parse(reply.body), { error: "edit-not-delivered", id: saved.id, saved: true, sent: false });
	assert.equal(storedComments(root)[0].comment, "Smaller");
});

test("canvas-layout S17: an edited comment's message names it as an edit and quotes the previous text", () => {
	const text = formatDesignComment({ id: "k3x9p2", slug: "landing", file: "02-bold.html", selector: "h1", excerpt: "", comment: "Make it shorter.", edited: { previous: "Make it bigger." } });
	assert.ok(text.startsWith("Design comment edited for design/landing/02-bold.html\n"));
	assert.ok(text.includes("\nComment (edited; it replaces the text you received earlier for this id):\nMake it shorter.\n"));
	assert.ok(text.includes("\nPrevious text:\nMake it bigger.\n"));
	assert.ok(!formatDesignComment({ id: "k3x9p2", slug: "landing", file: "02-bold.html", selector: "h1", excerpt: "", comment: "x" }).includes("edited"));
});

test("describeWatchFailure names the exhausted inotify limit (gentle-shell#3156)", () => {
	assert.match(describeWatchFailure(Object.assign(new Error("watch failed"), { code: "ENOSPC" })), /fs\.watch failed: ENOSPC .*fs\.inotify\.max_user_watches/);
	assert.match(describeWatchFailure(new Error("boom")), /fs\.watch failed: /);
});
