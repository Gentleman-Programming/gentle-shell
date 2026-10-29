import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { DesignCommentsError, MAX_DESIGN_COMMENTS, MAX_DESIGN_SCREENSHOT_BYTES, createDesignCommentStore } from "../lib/design-comments.ts";

// design/<slug>/comments.json has one owner: every read and write goes through
// lib/design-comments.ts, so the canvas server and the agent tool serialize.

function scratch(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function designRoot(t: TestContext) {
	const root = join(scratch(t, "gentle-design-comments-"), "design");
	mkdirSync(join(root, "alpha"), { recursive: true });
	return root;
}

const INPUT = { file: "01-hero.html", selector: "body > h1", excerpt: "Hero", comment: "Make it bigger" };
const FIXED = new Date("2026-10-26T10:00:00.000Z");

function fixedStore(root: string) {
	let next = 0;
	return createDesignCommentStore(root, { now: () => FIXED, randomId: () => `id${String(next++).padStart(4, "0")}` });
}

test("a missing comments.json reads as an empty document, and add appends an open, unsent comment", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	assert.deepEqual(await store.read("alpha"), { version: 1, comments: [] });
	const added = await store.add("alpha", INPUT);
	assert.deepEqual(added, { id: "id0000", ...INPUT, createdAt: FIXED.toISOString(), status: "open", sentAt: null, resolvedAt: null });
	const onDisk = JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8"));
	assert.deepEqual(onDisk, { version: 1, comments: [added] });
	assert.deepEqual(await store.read("alpha"), onDisk);
	assert.deepEqual(readdirSync(join(root, "alpha")), ["comments.json"], "no temp file is left behind");
});

test("generated ids are short, URL-safe and unique within the design", async (t) => {
	const root = designRoot(t);
	const store = createDesignCommentStore(root);
	const ids = new Set<string>();
	for (let index = 0; index < 30; index++) ids.add((await store.add("alpha", INPUT)).id);
	assert.equal(ids.size, 30);
	for (const id of ids) assert.match(id, /^[a-z0-9]{6,12}$/);
	// A colliding generator still yields unique ids.
	const colliding = createDesignCommentStore(root, { randomId: () => [...ids][0] });
	await assert.rejects(colliding.add("alpha", INPUT), (error: unknown) => error instanceof DesignCommentsError && error.code === "id-exhausted");
});

test("setStatus resolves and reopens by id, and reports unknown ids", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const b = await store.add("alpha", { ...INPUT, file: "02-bold.html" });
	const resolved = await store.setStatus("alpha", [a.id, "nope00"], "resolved");
	assert.deepEqual(resolved.updated.map((comment) => [comment.id, comment.status, comment.resolvedAt]), [[a.id, "resolved", FIXED.toISOString()]]);
	assert.deepEqual(resolved.unknown, ["nope00"]);
	assert.deepEqual((await store.listOpen("alpha")).map((comment) => comment.id), [b.id]);
	assert.deepEqual((await store.listOpen("alpha", "02-bold.html")).map((comment) => comment.id), [b.id]);
	assert.deepEqual(await store.listOpen("alpha", "01-hero.html"), []);
	const reopened = await store.setStatus("alpha", [a.id], "open");
	assert.equal(reopened.updated[0].status, "open");
	assert.equal(reopened.updated[0].resolvedAt, null);
	await assert.rejects(store.setStatus("alpha", [a.id], "done" as never), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input");
});

test("markSent stamps sentAt once and leaves other comments alone", async (t) => {
	const root = designRoot(t);
	let clock = FIXED.getTime();
	const store = createDesignCommentStore(root, { now: () => new Date(clock) });
	const a = await store.add("alpha", INPUT);
	const b = await store.add("alpha", INPUT);
	await store.markSent("alpha", [a.id]);
	clock += 60_000;
	await store.markSent("alpha", [a.id]);
	const { comments } = await store.read("alpha");
	assert.equal(comments.find((comment) => comment.id === a.id)!.sentAt, FIXED.toISOString());
	assert.equal(comments.find((comment) => comment.id === b.id)!.sentAt, null);
});

test("concurrent adds through separate stores keep every comment in valid JSON", async (t) => {
	const root = designRoot(t);
	// Two stores, as the server and the agent tool would have.
	const server = createDesignCommentStore(root);
	const tool = createDesignCommentStore(root);
	const added = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? server : tool).add("alpha", { ...INPUT, comment: `c${index}` })));
	const onDisk = JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8"));
	assert.equal(onDisk.comments.length, 20);
	assert.deepEqual(new Set(onDisk.comments.map((comment: { id: string }) => comment.id)), new Set(added.map((comment) => comment.id)));
	await Promise.all([server.setStatus("alpha", [added[0].id], "resolved"), tool.markSent("alpha", [added[1].id]), server.add("alpha", INPUT)]);
	const after = await tool.read("alpha");
	assert.equal(after.comments.length, 21);
	assert.equal(after.comments.find((comment) => comment.id === added[0].id)!.status, "resolved");
	assert.notEqual(after.comments.find((comment) => comment.id === added[1].id)!.sentAt, null);
});

test("an unparsable or invalid comments.json is a typed error and is never overwritten", async (t) => {
	const root = designRoot(t);
	const store = createDesignCommentStore(root);
	const path = join(root, "alpha", "comments.json");
	for (const bytes of ["{ not json", JSON.stringify({ version: 2, comments: [] }), JSON.stringify({ version: 1, comments: [{ id: "x" }] }), "[]"]) {
		writeFileSync(path, bytes);
		await assert.rejects(store.read("alpha"), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file", bytes);
		await assert.rejects(store.add("alpha", INPUT), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file");
		await assert.rejects(store.setStatus("alpha", ["x"], "resolved"));
		assert.equal(readFileSync(path, "utf8"), bytes, "bytes unchanged");
	}
});

test("a design holds at most 500 comments; the next one is refused with a clear error", async (t) => {
	const root = designRoot(t);
	const store = createDesignCommentStore(root);
	assert.equal(MAX_DESIGN_COMMENTS, 500);
	const comments = Array.from({ length: 500 }, (_, index) => ({ id: `c${String(index).padStart(5, "0")}`, ...INPUT, createdAt: FIXED.toISOString(), status: "open", sentAt: null, resolvedAt: null }));
	writeFileSync(join(root, "alpha", "comments.json"), JSON.stringify({ version: 1, comments }));
	await assert.rejects(store.add("alpha", INPUT), (error: unknown) => error instanceof DesignCommentsError && error.code === "limit" && /500/.test(error.message));
	assert.equal((await store.read("alpha")).comments.length, 500);
});

test("inputs are validated before anything is written", async (t) => {
	const root = designRoot(t);
	const store = createDesignCommentStore(root);
	const invalid = [
		{ ...INPUT, file: "../beta/01.html" },
		{ ...INPUT, file: "styles.css" },
		{ ...INPUT, comment: "" },
		{ ...INPUT, comment: "x".repeat(2001) },
		{ ...INPUT, selector: "" },
		{ ...INPUT, selector: "a".repeat(501) },
		{ ...INPUT, excerpt: "e".repeat(301) },
	];
	for (const input of invalid) await assert.rejects(store.add("alpha", input), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input");
	for (const slug of ["Alpha", "../alpha", "", "missing"]) await assert.rejects(store.add(slug, INPUT), (error: unknown) => error instanceof DesignCommentsError && error.code === "not-found", slug);
	assert.deepEqual(readdirSync(join(root, "alpha")), []);
});

test("a design directory or comments.json that escapes the root by symlink is refused", async (t) => {
	const root = designRoot(t);
	const outside = scratch(t, "gentle-design-comments-outside-");
	writeFileSync(join(outside, "comments.json"), JSON.stringify({ version: 1, comments: [] }));
	symlinkSync(outside, join(root, "escape"));
	const store = createDesignCommentStore(root);
	await assert.rejects(store.read("escape"), (error: unknown) => error instanceof DesignCommentsError && error.code === "not-found");
	await assert.rejects(store.add("escape", INPUT), (error: unknown) => error instanceof DesignCommentsError && error.code === "not-found");
	mkdirSync(join(root, "beta"));
	symlinkSync(join(outside, "comments.json"), join(root, "beta", "comments.json"));
	await assert.rejects(store.add("beta", INPUT), (error: unknown) => error instanceof DesignCommentsError && error.code === "not-found");
	assert.equal(readFileSync(join(outside, "comments.json"), "utf8"), JSON.stringify({ version: 1, comments: [] }), "the outside file is untouched");
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("frame")]);

test("a comment with a screenshot stores the image beside comments.json and reads it back", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const added = await store.add("alpha", { ...INPUT, screenshot: { mimeType: "image/png", data: PNG } });
	assert.deepEqual(added, { id: "id0000", ...INPUT, screenshot: ".screenshots/id0000.png", createdAt: FIXED.toISOString(), status: "open", sentAt: null, resolvedAt: null });
	assert.deepEqual(readFileSync(join(root, "alpha", ".screenshots", "id0000.png")), PNG);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8")).comments, [added]);
	assert.deepEqual(await store.read("alpha"), { version: 1, comments: [added] });
	assert.deepEqual(await store.readScreenshot("alpha", "id0000"), { path: ".screenshots/id0000.png", mimeType: "image/png", data: PNG });
	const plain = await store.add("alpha", INPUT);
	assert.equal("screenshot" in plain, false, "a comment without a screenshot keeps the old shape");
	assert.equal(await store.readScreenshot("alpha", plain.id), undefined);
	assert.equal(await store.readScreenshot("alpha", "nope"), undefined);
	assert.deepEqual(readdirSync(join(root, "alpha", ".screenshots")), ["id0000.png"], "no temp file is left behind");
});

test("a screenshot of an unknown type, a mismatched signature, or over the size limit is refused and writes nothing", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const refused = [
		{ mimeType: "image/svg+xml", data: PNG },
		{ mimeType: "image/jpeg", data: PNG },
		{ mimeType: "image/png", data: Buffer.alloc(0) },
		{ mimeType: "image/png", data: Buffer.concat([PNG, Buffer.alloc(MAX_DESIGN_SCREENSHOT_BYTES)]) },
	];
	for (const screenshot of refused) {
		await assert.rejects(store.add("alpha", { ...INPUT, screenshot }), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input");
	}
	assert.deepEqual(readdirSync(join(root, "alpha")), []);
});

test("a stored screenshot path outside .screenshots makes comments.json invalid, and a linked .screenshots is refused", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const entry = { id: "a1", ...INPUT, screenshot: "../secret.png", createdAt: FIXED.toISOString(), status: "open", sentAt: null, resolvedAt: null };
	writeFileSync(join(root, "alpha", "comments.json"), JSON.stringify({ version: 1, comments: [entry] }));
	await assert.rejects(store.read("alpha"), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file");
	rmSync(join(root, "alpha", "comments.json"));
	const outside = scratch(t, "gentle-design-shots-outside-");
	symlinkSync(outside, join(root, "alpha", ".screenshots"));
	await assert.rejects(store.add("alpha", { ...INPUT, screenshot: { mimeType: "image/png", data: PNG } }), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file");
	assert.deepEqual(readdirSync(outside), []);
});
