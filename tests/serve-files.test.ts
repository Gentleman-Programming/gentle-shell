import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after, before } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { searchScore } from "../lib/serve-files.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { call, pairDevice, stream } from "./serve-test-client.ts";

const ADMIN = "gsa_test-admin-token";
const savedHome = process.env.HOME;
let root: string;
let home: string;
let work: string;
let server: ServeServer;
let reader: { id: string; token: string };
let operator: { id: string; token: string };

before(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-serve-files-")));
	// The protected-path rules read the server user's home: a throwaway one here.
	home = join(root, "home");
	work = join(home, "work");
	mkdirSync(work, { recursive: true });
	process.env.HOME = home;
	const auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth,
		version: "test",
		launchSession: () => { throw new Error("no sessions here"); },
		fsLimits: { listEntries: 50, readBytes: 64, writeBytes: 1024 * 1024, watchersPerDevice: 2, watchDebounceMs: 50 },
	});
	reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader");
	operator = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"], "operator");
});
after(async () => {
	await server?.close();
	process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
});

const q = (path: string) => encodeURIComponent(path);

test("GET /api/server names the platform, the architecture and the path separator", async () => {
	const info = await call(server.url, "GET", "/api/server", { token: reader.token });
	assert.equal(info.status, 200);
	assert.equal(info.body.platform, process.platform);
	assert.equal(info.body.pathSeparator, sep);
	assert.equal(typeof info.body.arch, "string");
	assert.ok(info.body.capabilities.includes("files"));
	assert.equal(info.body.home, undefined, "home only for operate");
});

test("list: entries with kind, size and mtime, hidden ones included, links resolved to their kind", async () => {
	const dir = join(work, "list");
	mkdirSync(join(dir, "sub"), { recursive: true });
	writeFileSync(join(dir, "a.txt"), "hello");
	writeFileSync(join(dir, ".hidden"), "");
	symlinkSync(join(dir, "sub"), join(dir, "to-sub"));
	symlinkSync(join(dir, "missing"), join(dir, "dangling"));
	const listed = await call(server.url, "GET", `/api/fs/list?path=${q(dir)}`, { token: reader.token });
	assert.equal(listed.status, 200, JSON.stringify(listed.body));
	assert.equal(listed.body.truncated, false);
	const byName = Object.fromEntries(listed.body.entries.map((e: { name: string }) => [e.name, e]));
	assert.deepEqual(Object.keys(byName), [".hidden", "a.txt", "dangling", "sub", "to-sub"]);
	assert.equal(byName["a.txt"].kind, "file");
	assert.equal(byName["a.txt"].size, 5);
	assert.equal(typeof byName["a.txt"].mtime, "number");
	assert.equal(byName.sub.kind, "dir");
	assert.equal(byName["to-sub"].kind, "symlink");
	assert.equal(byName["to-sub"].linkKind, "dir");
	assert.equal(byName.dangling.linkKind, null);

	const big = join(work, "big");
	mkdirSync(big);
	for (let i = 0; i < 60; i += 1) writeFileSync(join(big, `f${i}`), "");
	const capped = await call(server.url, "GET", `/api/fs/list?path=${q(big)}`, { token: reader.token });
	assert.equal(capped.body.entries.length, 50);
	assert.equal(capped.body.truncated, true);
});

test("paths must be absolute, without NUL; missing ones answer 404; auth applies", async () => {
	assert.equal((await call(server.url, "GET", "/api/fs/list?path=relative/dir", { token: reader.token })).body.error.code, "invalid_path");
	assert.equal((await call(server.url, "GET", `/api/fs/list?path=${q(`${work}\0x`)}`, { token: reader.token })).body.error.code, "invalid_path");
	assert.equal((await call(server.url, "GET", "/api/fs/list", { token: reader.token })).body.error.code, "invalid_path");
	const missing = await call(server.url, "GET", `/api/fs/stat?path=${q(join(work, "nope"))}`, { token: reader.token });
	assert.equal(missing.status, 404);
	assert.equal(missing.body.error.code, "not_found");
	assert.equal((await call(server.url, "GET", `/api/fs/list?path=${q(work)}`)).status, 401);
	assert.equal((await call(server.url, "POST", "/api/fs/list", { token: reader.token })).status, 405);
	assert.equal((await call(server.url, "GET", "/api/fs/nothing", { token: reader.token })).status, 404);
});

test("stat: a file's etag and mode; a link's target, its kind and the file it points to", async () => {
	const file = join(work, "stat.txt");
	writeFileSync(file, "abc");
	chmodSync(file, 0o640);
	symlinkSync(file, join(work, "stat-link"));
	const plain = await call(server.url, "GET", `/api/fs/stat?path=${q(file)}`, { token: reader.token });
	assert.equal(plain.status, 200);
	assert.equal(plain.body.kind, "file");
	assert.equal(plain.body.size, 3);
	assert.equal(plain.body.mode, 0o640);
	assert.match(plain.body.etag, /^"[0-9a-z]+-[0-9a-z]+"$/);
	assert.equal(plain.body.realPath, file);
	const link = await call(server.url, "GET", `/api/fs/stat?path=${q(join(work, "stat-link"))}`, { token: reader.token });
	assert.equal(link.body.kind, "symlink");
	assert.equal(link.body.linkTarget, file);
	assert.equal(link.body.linkKind, "file");
	assert.equal(link.body.realPath, file);
	assert.equal(link.body.size, 3);
	assert.equal(link.body.etag, plain.body.etag);
});

test("read: raw bytes, offset and length, capped per call, conditional requests", async () => {
	const file = join(work, "read.bin");
	const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
	writeFileSync(file, bytes);
	const first = await call(server.url, "GET", `/api/fs/read?path=${q(file)}`, { token: reader.token });
	assert.equal(first.status, 200);
	assert.equal(first.headers["content-type"], "application/octet-stream");
	assert.deepEqual(first.bytes, bytes.subarray(0, 64), "capped at the per-call limit");
	assert.equal(first.headers["x-file-size"], "100");
	assert.equal(first.headers["x-truncated"], "1");
	const rest = await call(server.url, "GET", `/api/fs/read?path=${q(file)}&offset=64`, { token: reader.token });
	assert.deepEqual(rest.bytes, bytes.subarray(64));
	assert.equal(rest.headers["x-truncated"], "0");
	const slice = await call(server.url, "GET", `/api/fs/read?path=${q(file)}&offset=10&length=5`, { token: reader.token });
	assert.deepEqual(slice.bytes, bytes.subarray(10, 15));
	const past = await call(server.url, "GET", `/api/fs/read?path=${q(file)}&offset=500`, { token: reader.token });
	assert.equal(past.status, 200);
	assert.equal(past.bytes.length, 0);

	const etag = first.headers.etag as string;
	assert.equal((await call(server.url, "GET", `/api/fs/read?path=${q(file)}`, { token: reader.token, headers: { "If-None-Match": etag } })).status, 304);
	const since = first.headers["last-modified"] as string;
	assert.equal((await call(server.url, "GET", `/api/fs/read?path=${q(file)}`, { token: reader.token, headers: { "If-Modified-Since": since } })).status, 304);
	assert.equal((await call(server.url, "GET", `/api/fs/read?path=${q(file)}`, { token: reader.token, headers: { "If-None-Match": "\"other\"" } })).status, 200);

	assert.equal((await call(server.url, "GET", `/api/fs/read?path=${q(work)}`, { token: reader.token })).body.error.code, "not_a_file");
	assert.equal((await call(server.url, "GET", `/api/fs/read?path=${q(file)}&offset=-1`, { token: reader.token })).body.error.code, "invalid_offset");
});

test("write: atomic create and replace, mode kept, create_only, If-Match, through a link, bounded", async () => {
	const file = join(work, "write.txt");
	const url = (extra = "") => `/api/fs/write?path=${q(file)}${extra}`;
	assert.equal((await call(server.url, "PUT", url(), { token: reader.token, raw: "x" })).status, 403);
	const created = await call(server.url, "PUT", url(), { token: operator.token, raw: "one" });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	assert.equal(created.body.created, true);
	assert.equal(readFileSync(file, "utf8"), "one");
	chmodSync(file, 0o755);
	const replaced = await call(server.url, "PUT", url(), { token: operator.token, raw: "two!" });
	assert.equal(replaced.status, 200);
	assert.equal(replaced.body.size, 4);
	assert.equal(statSync(file).mode & 0o777, 0o755);
	assert.equal((await call(server.url, "PUT", url("&create_only=1"), { token: operator.token, raw: "three" })).body.error.code, "exists");
	assert.equal(readFileSync(file, "utf8"), "two!");

	const stale = await call(server.url, "PUT", url(), { token: operator.token, raw: "late", headers: { "If-Match": created.body.etag } });
	assert.equal(stale.status, 412);
	assert.equal(stale.body.error.code, "changed");
	const fresh = await call(server.url, "PUT", url(), { token: operator.token, raw: "ok", headers: { "If-Match": replaced.body.etag } });
	assert.equal(fresh.status, 200);

	const onlyNew = join(work, "fresh.txt");
	assert.equal((await call(server.url, "PUT", `/api/fs/write?path=${q(onlyNew)}&create_only=1`, { token: operator.token, raw: "n" })).status, 201);

	const link = join(work, "write-link");
	symlinkSync(file, link);
	assert.equal((await call(server.url, "PUT", `/api/fs/write?path=${q(link)}`, { token: operator.token, raw: "via link" })).status, 200);
	assert.ok(lstatSync(link).isSymbolicLink(), "the link stays a link");
	assert.equal(readFileSync(file, "utf8"), "via link");

	const tooBig = await call(server.url, "PUT", url(), { token: operator.token, raw: Buffer.alloc(1024 * 1024 + 1) });
	assert.equal(tooBig.status, 413);
	assert.equal(readFileSync(file, "utf8"), "via link");
	assert.equal((await call(server.url, "PUT", `/api/fs/write?path=${q(join(work, "no-dir", "x"))}`, { token: operator.token, raw: "x" })).status, 404);
	assert.equal((await call(server.url, "PUT", `/api/fs/write?path=${q(work)}`, { token: operator.token, raw: "x" })).body.error.code, "not_a_file");
	const leftovers = (await call(server.url, "GET", `/api/fs/list?path=${q(work)}`, { token: reader.token })).body.entries.filter((e: { name: string }) => e.name.endsWith(".tmp"));
	assert.deepEqual(leftovers, [], "no temporary file is left behind");
});

test("mkdir, rename and remove", async () => {
	const nested = join(work, "m", "n");
	const made = await call(server.url, "POST", "/api/fs/mkdir", { token: operator.token, body: { path: nested } });
	assert.equal(made.status, 201);
	assert.equal(made.body.created, true);
	assert.equal((await call(server.url, "POST", "/api/fs/mkdir", { token: operator.token, body: { path: nested } })).body.created, false);
	assert.equal((await call(server.url, "POST", "/api/fs/mkdir", { token: reader.token, body: { path: nested } })).status, 403);

	writeFileSync(join(work, "r1"), "1");
	writeFileSync(join(work, "r2"), "2");
	const clash = await call(server.url, "POST", "/api/fs/rename", { token: operator.token, body: { from: join(work, "r1"), to: join(work, "r2") } });
	assert.equal(clash.status, 409);
	assert.equal((await call(server.url, "POST", "/api/fs/rename", { token: operator.token, body: { from: join(work, "r1"), to: join(work, "r2"), overwrite: true } })).status, 200);
	assert.equal(readFileSync(join(work, "r2"), "utf8"), "1");
	assert.equal(existsSync(join(work, "r1")), false);
	assert.equal((await call(server.url, "POST", "/api/fs/rename", { token: operator.token, body: { from: join(work, "r1"), to: join(work, "r3") } })).status, 404);

	const notEmpty = await call(server.url, "POST", "/api/fs/remove", { token: operator.token, body: { path: join(work, "m") } });
	assert.equal(notEmpty.status, 409);
	assert.equal(notEmpty.body.error.code, "not_empty");
	assert.equal((await call(server.url, "POST", "/api/fs/remove", { token: operator.token, body: { path: join(work, "m"), recursive: true } })).status, 200);
	assert.equal(existsSync(join(work, "m")), false);
	assert.equal((await call(server.url, "POST", "/api/fs/remove", { token: operator.token, body: { path: join(work, "r2") } })).status, 200);
});

test("remove and rename refuse the root, the home and the folders above it; a link to the home goes, not the home", async () => {
	for (const path of ["/", home, root, `${home}/work/..`]) {
		const refused = await call(server.url, "POST", "/api/fs/remove", { token: operator.token, body: { path, recursive: true } });
		assert.equal(refused.status, 403, path);
		assert.equal(refused.body.error.code, "protected_path");
	}
	assert.equal((await call(server.url, "POST", "/api/fs/rename", { token: operator.token, body: { from: home, to: join(root, "moved") } })).body.error.code, "protected_path");
	const link = join(work, "home-link");
	symlinkSync(home, link);
	assert.equal((await call(server.url, "POST", "/api/fs/remove", { token: operator.token, body: { path: link, recursive: true } })).status, 200);
	assert.equal(existsSync(link), false);
	assert.ok(existsSync(work), "the home is untouched");
	// A path through a link to the home's parent is the same folder: refused.
	symlinkSync(root, join(work, "root-link"));
	assert.equal((await call(server.url, "POST", "/api/fs/remove", { token: operator.token, body: { path: join(work, "root-link", "home"), recursive: true } })).body.error.code, "protected_path");
	assert.equal(readlinkSync(join(work, "root-link")), root);
});

test("search: ranked filename matches, .git and node_modules skipped", async () => {
	assert.equal(searchScore("main.rs", "src/main.rs", "main.rs"), 100);
	assert.equal(searchScore("main.rs", "src/main.rs", "mai"), 80);
	assert.equal(searchScore("domain.rs", "src/domain.rs", "main"), 60);
	assert.equal(searchScore("lib.rs", "src/app/lib.rs", "app/lib"), 40);
	assert.equal(searchScore("serve-files.ts", "lib/serve-files.ts", "sfts"), 10);
	assert.equal(searchScore("abc", "abc", "zzz"), 0);

	const tree = join(work, "tree");
	mkdirSync(join(tree, "src", "deep"), { recursive: true });
	mkdirSync(join(tree, ".git"), { recursive: true });
	mkdirSync(join(tree, "node_modules", "pkg"), { recursive: true });
	writeFileSync(join(tree, "src", "deep", "widget.ts"), "");
	writeFileSync(join(tree, "src", "my-widget-list.ts"), "");
	writeFileSync(join(tree, ".git", "widget"), "");
	writeFileSync(join(tree, "node_modules", "pkg", "widget.ts"), "");
	const found = await call(server.url, "GET", `/api/fs/search?root=${q(tree)}&q=Widget.ts`, { token: reader.token });
	assert.equal(found.status, 200, JSON.stringify(found.body));
	// The exact name first; the loose in-order match after it.
	assert.deepEqual(found.body.results.map((r: { path: string }) => r.path), [join(tree, "src", "deep", "widget.ts"), join(tree, "src", "my-widget-list.ts")]);
	const loose = await call(server.url, "GET", `/api/fs/search?root=${q(tree)}&q=widget&limit=1`, { token: reader.token });
	assert.equal(loose.body.results.length, 1);
	assert.equal(loose.body.results[0].name, "widget.ts");
	assert.equal(loose.body.truncated, false);
	assert.equal((await call(server.url, "GET", `/api/fs/search?root=${q(tree)}`, { token: reader.token })).body.error.code, "invalid_query");
});

test("watch: debounced change batches over SSE, capped per device, closed on revoke", async () => {
	const dir = join(work, "watched");
	mkdirSync(dir);
	const watchDevice = await pairDevice(server.url, ADMIN, ["sessions:read"], "watcher");
	const changes = await stream(server.url, `/api/fs/watch?path=${q(dir)}`, watchDevice.token);
	assert.equal(changes.status, 200);
	await changes.waitFor("event: ready");
	writeFileSync(join(dir, "new.txt"), "x");
	await changes.waitFor("event: changes");
	await changes.waitFor(JSON.stringify(join(dir, "new.txt")).slice(1, -1));

	const second = await stream(server.url, `/api/fs/watch?path=${q(dir)}`, watchDevice.token);
	assert.equal(second.status, 200);
	const third = await call(server.url, "GET", `/api/fs/watch?path=${q(dir)}`, { token: watchDevice.token });
	assert.equal(third.status, 429);
	assert.equal((await call(server.url, "GET", `/api/fs/watch?path=${q(join(dir, "missing"))}`, { token: reader.token })).status, 404);

	assert.equal((await call(server.url, "DELETE", `/api/devices/${watchDevice.id}`, { token: ADMIN })).status, 200);
	await changes.closed;
	await second.closed;
});
