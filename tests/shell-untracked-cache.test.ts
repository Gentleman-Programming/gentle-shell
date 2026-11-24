import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorktreeChangesTracker } from "../lib/shell-changes.ts";
import { shellUntrackedLines } from "../lib/shell-untracked-lines.ts";

async function fixture(t: TestContext) {
	const tmp = await fs.mkdtemp(join(tmpdir(), "gentle-untracked-cache-"));
	t.after(() => fs.rm(tmp, { recursive: true, force: true }));
	const root = join(tmp, "repo");
	const otherRoot = join(tmp, "other-repo");
	const directory = join(tmp, "cache", "untracked");
	await Promise.all([fs.mkdir(root), fs.mkdir(otherRoot)]);
	const key = createHash("sha256").update(await fs.realpath(root)).digest("hex");
	const cacheFile = join(directory, `${key}.json`);
	const files = new Map<string, { bytes: Buffer; mtimeMs: number }>();
	const put = (path: string, content: string | Buffer, mtimeMs = 1) => files.set(path, { bytes: Buffer.from(content), mtimeMs });
	function session(repo = root, cacheDirectory = directory) {
		const reads: string[] = [];
		const io = {
			lstat: async (path: string) => {
				const { bytes, mtimeMs } = files.get(path.slice(repo.length + 1))!;
				return { isFile: () => true, size: bytes.length, mtimeMs };
			},
			read: async (path: string, length: number, offset: number) => {
				const relative = path.slice(repo.length + 1);
				reads.push(relative);
				return files.get(relative)!.bytes.subarray(offset, offset + length);
			},
		};
		const tracker = new WorktreeChangesTracker(
			async () => ({ stdout: `worktree ${repo}\0branch refs/heads/main\0\0`, code: 0 }),
			() => async ([cmd]) => ({ stdout: cmd === "status" ? [...files.keys()].map((path) => `?? ${path}\0`).join("") : "", code: 0 }),
			undefined, () => [repo], undefined, shellUntrackedLines(io, undefined, cacheDirectory),
		);
		return { tracker, reads, start: () => tracker.start(), close: () => tracker.closeUntrackedCounts(),
			counts: () => tracker.model.files.map(({ path, added, countsUnavailable }) => [path, added, countsUnavailable]) };
	}
	return { put, files, session, tmp, root, otherRoot, directory, cacheFile,
		readCache: async () => JSON.parse(await fs.readFile(cacheFile, "utf8")) };
}

const missing = { code: "ENOENT" };
const count = (path: string, added: number) => [path, added, undefined];

test("a new counter uses the same real root's saved counts without reading unchanged content", async (t) => {
	const f = await fixture(t);
	f.put("binary", Buffer.from([0, 10]));
	f.put("sub/file", "a\nb\n");
	const cold = f.session();
	await cold.start();
	assert.deepEqual(cold.counts(), [count("binary", 0), count("sub/file", 2)]);
	assert.deepEqual(cold.reads.sort(), ["binary", "sub/file"]);
	await assert.rejects(fs.stat(f.cacheFile), missing, "scanning does not write immediately");
	await cold.close();
	const warm = f.session(await fs.realpath(f.root));
	await warm.start();
	assert.deepEqual(warm.counts(), cold.counts());
	assert.deepEqual(warm.reads, []);
	await warm.close();
	const other = f.session(f.otherRoot);
	await other.start();
	assert.deepEqual(other.counts(), cold.counts());
	assert.deepEqual(other.reads.sort(), ["binary", "sub/file"], "different roots do not share counts");
	await other.close();
});

test("changes to either size or mtime force a new read, never unchanged siblings", async (t) => {
	const f = await fixture(t);
	f.put("mtime", "ab"); f.put("size", "ab"); f.put("stable", "a\n");
	const before = f.session(); await before.start(); await before.close();
	f.put("mtime", "\n\n", 2); f.put("size", "\n\n\n");
	const after = f.session(); await after.start();
	assert.deepEqual(after.counts(), [count("mtime", 2), count("size", 3), count("stable", 1)]);
	assert.deepEqual(after.reads.sort(), ["mtime", "size"]);
	await after.close();
});

test("paths that leave the Git inventory are pruned from the saved snapshot", async (t) => {
	const f = await fixture(t);
	f.put("gone", "a\n"); f.put("live", "b\n");
	const before = f.session(); await before.start(); await before.close();
	f.files.delete("gone");
	const after = f.session(); await after.start(); await after.close();
	assert.deepEqual(after.counts(), [count("live", 1)]);
	assert.deepEqual(after.reads, []);
	assert.deepEqual(await f.readCache(), { version: 1, entries: { live: { size: 2, mtimeMs: 1, added: 1 } } });
	f.files.clear();
	const empty = f.session(); await empty.start(); await empty.close();
	assert.deepEqual(empty.counts(), []);
	assert.deepEqual(await f.readCache(), { version: 1, entries: {} });
});

test("malformed JSON, another version and malformed entries fall back to recounting", async (t) => {
	const f = await fixture(t);
	f.put("text", "one\ntwo\n");
	await fs.mkdir(f.directory, { recursive: true });
	for (const data of ["{", JSON.stringify({ version: 2, entries: { text: { size: 8, mtimeMs: 1, added: 100 } } }),
		JSON.stringify({ version: 1, entries: { text: { size: 8, mtimeMs: 1, added: "not a number" }, "../outside": { size: 2, mtimeMs: 1, added: 1 } } })]) {
		await fs.writeFile(f.cacheFile, data);
		const session = f.session(); await session.start(); await session.close();
		assert.deepEqual(session.counts(), [count("text", 2)]);
		assert.deepEqual(session.reads, ["text"]);
		assert.deepEqual(await f.readCache(), { version: 1, entries: { text: { size: 8, mtimeMs: 1, added: 2 } } });
	}
});

test("slow failed cache writes do not block scans or repeatedly retry in a read-only directory", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	await fs.mkdir(f.directory, { recursive: true });
	await fs.chmod(f.directory, 0o500);
	const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	let attempts = 0;
	const writeFile = fs.writeFile;
	const mock = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
		attempts++;
		started.resolve();
		await release.promise;
		// Also exercise the failure on CI running as root (which can write to 0500).
		if (process.getuid?.() === 0) throw Object.assign(new Error("read-only"), { code: "EACCES" });
		return writeFile(...args);
	});
	syncBuiltinESMExports();
	try {
		f.put("f", "a\n");
		const live = f.session(); await live.start();
		assert.deepEqual(live.counts(), [count("f", 1)]);
		assert.equal(attempts, 0);
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			const attempted = new Promise<boolean>((resolve) => { deadline = setTimeout(resolve, 8_000, false); });
			assert.equal(await Promise.race([started.promise.then(() => true), attempted]), true, "the debounced writer did attempt a write");
		} finally {
			clearTimeout(deadline);
		}
		f.put("f", "\n\n", 2);
		await live.tracker.refresh();
		assert.deepEqual(live.counts(), [count("f", 2)], "the scan settled while the write was blocked");
		release.resolve();
		await live.close();
		assert.equal(attempts, 1);
		assert.deepEqual(await fs.readdir(f.directory), []);
	} finally {
		release.resolve();
		mock.mock.restore(); syncBuiltinESMExports();
		await fs.chmod(f.directory, 0o700);
	}
});

test("two concurrent sessions leave one complete reusable snapshot for the same root", async (t) => {
	const f = await fixture(t);
	f.put("first", "a\n"); f.put("second", "b\nc\n");
	const a = f.session(), b = f.session();
	await Promise.all([a.start(), b.start()]);
	assert.deepEqual(a.reads.sort(), ["first", "second"]);
	assert.deepEqual(b.reads.sort(), ["first", "second"]);
	await Promise.all([a.close(), b.close()]);
	assert.deepEqual(await fs.readdir(f.directory), [basename(f.cacheFile)]);
	const next = f.session(); await next.start(); await next.close();
	assert.deepEqual(next.counts(), [count("first", 1), count("second", 2)]);
	assert.deepEqual(next.reads, []);
});

test("cache directories and snapshots are created with user-only permissions", { skip: process.platform === "win32" }, async (t) => {
	const f = await fixture(t);
	f.put("f", "a\n");
	const s = f.session(); await s.start(); await s.close();
	assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(f.cacheFile)).mode & 0o777, 0o600);
});

test("an injected cache directory inside the repository is not used", async (t) => {
	const f = await fixture(t);
	f.put("f", "a\n");
	const inside = join(f.root, "cache", "untracked");
	const s = f.session(f.root, inside); await s.start(); await s.close();
	assert.deepEqual(s.counts(), [count("f", 1)]);
	assert.deepEqual(s.reads, ["f"]);
	await assert.rejects(fs.stat(inside), missing);
});

test("a scan with nothing to remember does not create a cache directory", async (t) => {
	const f = await fixture(t);
	const s = f.session(); await s.start(); await s.close();
	assert.deepEqual(s.counts(), []);
	assert.deepEqual(s.reads, []);
	await assert.rejects(fs.stat(f.directory), missing);
});

// The memory names the user's untracked paths: it is only ever published in a
// directory nobody else can read, also when that directory already existed.
test("a snapshot is never published in a non-private cache directory", { skip: process.platform === "win32" }, async (t) => {
	const f = await fixture(t);
	await fs.mkdir(f.directory, { recursive: true });
	await fs.chmod(f.directory, 0o755);
	f.put("f", "a\n");
	const s = f.session();
	await s.start();
	assert.deepEqual(s.counts(), [count("f", 1)]);
	await s.close();
	const published = await fs.stat(f.cacheFile).catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (published) {
		assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
		assert.equal(published.mode & 0o777, 0o600);
	}
});
