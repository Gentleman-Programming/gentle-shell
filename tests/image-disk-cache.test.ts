import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageDiskCache, defaultCacheRoot } from "../lib/image-disk-cache.ts";
import { ImageAttachments } from "../lib/image-attachments.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "gentle-image-cache-"));
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("the cache root honours XDG_CACHE_HOME and falls back to ~/.cache", () => {
	assert.equal(defaultCacheRoot({ XDG_CACHE_HOME: "/custom/cache" }, "/home/u"), "/custom/cache/gentle-shell/images");
	assert.equal(defaultCacheRoot({}, "/home/u"), "/home/u/.cache/gentle-shell/images");
	assert.equal(defaultCacheRoot({ XDG_CACHE_HOME: "" }, "/home/u"), "/home/u/.cache/gentle-shell/images");
});

test("a session id cannot escape its own directory", () => {
	const root = tempRoot();
	const cache = new ImageDiskCache({ root, sessionId: "../../etc" });
	assert.equal(cache.directory, join(root, "etc"));
	assert.ok(cache.directory.startsWith(root));
});

test("writing stores the exact bytes with a private directory and file", () => {
	const root = tempRoot();
	const cache = new ImageDiskCache({ root, sessionId: "s1" });
	const path = cache.write(1, PNG, "image/png");

	assert.ok(path, "write must return the file path");
	assert.deepEqual(new Uint8Array(readFileSync(path)), PNG);
	assert.equal(statSync(cache.directory).mode & 0o777, 0o700, "session directory is private");
	assert.equal(statSync(path).mode & 0o777, 0o600, "image file is private");
});

test("the file extension follows the mime type", () => {
	const root = tempRoot();
	const cache = new ImageDiskCache({ root, sessionId: "s1" });
	assert.match(cache.write(2, PNG, "image/jpeg") ?? "", /image-2\.jpg$/);
});

test("a write that cannot happen degrades instead of throwing", () => {
	const blocked = join(tempRoot(), "not-a-directory");
	writeFileSync(blocked, "x");
	const cache = new ImageDiskCache({ root: blocked, sessionId: "s1" });
	assert.equal(cache.write(1, PNG, "image/png"), undefined);
});

test("disposing removes only this session's directory", () => {
	const root = tempRoot();
	const mine = new ImageDiskCache({ root, sessionId: "mine" });
	const other = new ImageDiskCache({ root, sessionId: "other" });
	mine.write(1, PNG, "image/png");
	const otherPath = other.write(1, PNG, "image/png");

	mine.dispose();

	assert.equal(existsSync(mine.directory), false, "own directory is gone");
	assert.ok(otherPath && existsSync(otherPath), "another session is untouched");
});

test("the sweep removes stale sessions and keeps fresh ones", () => {
	const root = tempRoot();
	const stale = new ImageDiskCache({ root, sessionId: "stale" });
	const fresh = new ImageDiskCache({ root, sessionId: "fresh" });
	const staleFile = stale.write(1, PNG, "image/png")!;
	fresh.write(1, PNG, "image/png");
	const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	utimesSync(staleFile, longAgo, longAgo);

	const removed = ImageDiskCache.sweepStale(root, 7 * 24 * 60 * 60 * 1000);

	assert.equal(removed, 1);
	assert.equal(existsSync(stale.directory), false, "old session removed");
	assert.ok(existsSync(fresh.directory), "fresh session kept");
});

test("the sweep never deletes outside the cache root", () => {
	const root = tempRoot();
	const outside = mkdtempSync(join(tmpdir(), "gentle-outside-"));
	mkdirSync(join(outside, "victim"));
	assert.equal(ImageDiskCache.sweepStale(outside, 0), 0);
	assert.ok(existsSync(join(outside, "victim")), "a foreign directory is left alone");
});

test("attachments keep their in-memory contract and gain a path only when a cache is given", () => {
	const plain = new ImageAttachments();
	const withoutCache = plain.add({ bytes: PNG, mimeType: "image/png" } as never);
	assert.equal(withoutCache.diskPath, undefined, "no cache, no path, old behaviour");
	assert.ok(withoutCache.base64.length > 0, "base64 stays the source of truth");

	const root = tempRoot();
	const withCache = new ImageAttachments(new ImageDiskCache({ root, sessionId: "s1" }));
	const withPath = withCache.add({ bytes: PNG, mimeType: "image/png" } as never);
	assert.ok(withPath.diskPath && existsSync(withPath.diskPath), "path exists on disk");
	assert.ok(withPath.token.startsWith("[Image#"), "chip token unchanged");

	withCache.dispose();
	assert.equal(existsSync(join(root, "s1")), false, "dispose clears the session directory");
});
