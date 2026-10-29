import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { designCommentBatchContent, designCommentContent, formatDesignComment, formatDesignCommentBatch, startDesignCanvasServer, type DesignCanvasServerOptions, type DesignComment } from "../lib/design-canvas-server.ts";

const TOKEN = "test-token-0123456789abcdef";
const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));

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

async function start(t: TestContext, extra: { initialSlug?: string; onImplement?: DesignCanvasServerOptions["onImplement"] } = {}) {
	const { root } = fixture(t);
	const comments: DesignComment[] = [];
	const batches: DesignComment[][] = [];
	const implements_: Array<{ slug: string; file: string }> = [];
	const server = await startDesignCanvasServer({
		designRoot: root,
		onComment: (comment) => { comments.push(comment); },
		onComments: (batch) => { batches.push(batch); },
		onImplement: (request) => { implements_.push(request); },
		randomToken: () => TOKEN,
		...extra,
	});
	t.after(() => server.close());
	return { server, root, comments, batches, implements: implements_, port: server.port, base: `/${TOKEN}/` };
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
	assert.deepEqual(JSON.parse(config[1]), { base, slug: null });
	assert.ok(page.body.includes(`src="${base}assets/canvas.js"`));
	const slugPage = await rawRequest(port, `${base}d/alpha/`);
	assert.equal(slugPage.status, 200);
	assert.deepEqual(JSON.parse(/<script id="gd-config" type="application\/json">([^<]*)<\/script>/.exec(slugPage.body)![1]), { base, slug: "alpha" });
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
	// an exhausted inotify limit silently stops the server's change events.
	const waitFor = (pattern: RegExp) => new Promise<RegExpExecArray>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`events never matched ${pattern} within 5s; got: ${JSON.stringify(buffer.slice(-200))}`)), 5000);
		const settle = (match: RegExpExecArray) => { clearTimeout(timeout); resolve(match); };
		const match = pattern.exec(buffer);
		if (match) settle(match); else waiters.push({ pattern, resolve: settle });
	});
	return { ready, waitFor, req };
}

test("events stream a debounced change after an artboard write", async (t) => {
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
		"frame-src 'self' http://localhost:* http://127.0.0.1:* http://[::1]:* https://localhost:* https://127.0.0.1:* https://[::1]:*",
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
		"When it is applied, mark it resolved with the gentle_design_comments tool (action \"resolve\", slug \"landing\", ids [\"k3x9p2\"]), or set its status to \"resolved\" in design/landing/comments.json.",
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
		"When a comment is applied, mark it resolved with the gentle_design_comments tool (action \"resolve\", slug \"landing\", ids [\"aaa111\", \"bbb222\"]), or set its status to \"resolved\" in design/landing/comments.json.",
	].join("\n"));
});

test("canvas assets sandbox artboards without allow-same-origin and reference no remote URL", () => {
	const canvas = readFileSync(join(ASSET_DIR, "canvas.js"), "utf8");
	assert.match(canvas, /setAttribute\("sandbox", "allow-scripts"\)/);
	// The one allow-same-origin is the Compare preview of the running app, another loopback origin (S15).
	assert.deepEqual(canvas.match(/"[^"\n]*allow-same-origin[^"\n]*"/g), ['"allow-scripts allow-same-origin allow-forms allow-popups"']);
	for (const name of ["index.html", "canvas.css", "canvas.js", "inspector.js"]) {
		const source = readFileSync(join(ASSET_DIR, name), "utf8");
		if (name !== "canvas.js") assert.ok(!source.includes("allow-same-origin"), `${name} must not grant allow-same-origin`);
		assert.ok(!/https?:\/\//i.test(source), `${name} must not reference remote URLs`);
	}
	const inspector = readFileSync(join(ASSET_DIR, "inspector.js"), "utf8");
	assert.match(inspector, /gd:pick/);
	assert.match(canvas, /event\.source/);
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
		"When it is applied, mark it resolved with the gentle_design_comments tool (action \"resolve\", slug \"landing\", ids [\"k3x9p2\"]), or set its status to \"resolved\" in design/landing/comments.json.",
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
