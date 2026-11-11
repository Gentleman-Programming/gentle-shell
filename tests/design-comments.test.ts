import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { DesignCommentsError, MAX_DESIGN_COMMENTS, MAX_DESIGN_SCREENSHOT_BYTES, createDesignCommentStore, describeViewport, normalizeNote } from "../lib/design-comments.ts";

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

// S7: the optional viewport a comment was made at.

const VIEWPORT = { width: 390, height: 844 };
const stored = (extra: Record<string, unknown> = {}) => ({ id: "a1", ...INPUT, createdAt: FIXED.toISOString(), status: "open", sentAt: null, resolvedAt: null, ...extra });

test("S7: a comment added with a viewport stores it; without one the key is absent", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const withViewport = await store.add("alpha", { ...INPUT, viewport: VIEWPORT });
	assert.deepEqual(withViewport, { id: "id0000", ...INPUT, viewport: VIEWPORT, createdAt: FIXED.toISOString(), status: "open", sentAt: null, resolvedAt: null });
	const plain = await store.add("alpha", INPUT);
	assert.equal("viewport" in plain, false, "never written when absent");
	const onDisk = JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8"));
	assert.deepEqual(onDisk.comments[0].viewport, VIEWPORT);
	assert.equal("viewport" in onDisk.comments[1], false);
	assert.deepEqual(await store.read("alpha"), onDisk);
	// The bounds are inclusive.
	for (const edge of [{ width: 240, height: 1 }, { width: 4096, height: 20000 }]) assert.deepEqual((await store.add("alpha", { ...INPUT, viewport: edge })).viewport, edge);
});

test("S7: an invalid viewport is refused before anything is written", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const invalid: unknown[] = [
		{ width: 239, height: 844 }, { width: 4097, height: 844 }, { width: 390, height: 0 }, { width: 390, height: 20001 },
		{ width: 390.5, height: 844 }, { width: "390", height: 844 }, { width: 390 }, { height: 844 }, {}, null, [], "390x844", 390,
		{ width: Number.NaN, height: 844 }, { width: Infinity, height: 844 },
	];
	for (const viewport of invalid) {
		await assert.rejects(store.add("alpha", { ...INPUT, viewport } as never), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input" && /viewport/.test(error.message), JSON.stringify(viewport));
	}
	assert.deepEqual(readdirSync(join(root, "alpha")), [], "comments.json was not created");
});

test("S7: a comments.json with a valid viewport reads; one without it stays valid; an invalid one makes the file invalid and is never overwritten", async (t) => {
	const root = designRoot(t);
	const store = createDesignCommentStore(root);
	const path = join(root, "alpha", "comments.json");
	writeFileSync(path, JSON.stringify({ version: 1, comments: [stored({ viewport: VIEWPORT }), stored({ id: "a2" })] }));
	const { comments } = await store.read("alpha");
	assert.deepEqual(comments[0].viewport, VIEWPORT);
	assert.equal("viewport" in comments[1], false);
	// Other writes keep the viewport.
	await store.setStatus("alpha", ["a1"], "resolved");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).comments[0].viewport, VIEWPORT);

	for (const viewport of [{ width: 100, height: 844 }, { width: 390, height: 99999 }, { width: 390 }, "wide", null, [], { width: 390.5, height: 1 }]) {
		const bytes = JSON.stringify({ version: 1, comments: [stored({ viewport })] });
		writeFileSync(path, bytes);
		await assert.rejects(store.read("alpha"), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file" && /comments\[0\]: viewport/.test(error.message), bytes);
		await assert.rejects(store.add("alpha", INPUT), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file");
		assert.equal(readFileSync(path, "utf8"), bytes, "bytes unchanged");
	}
});

test("S7: describeViewport names the Phone and Tablet presets and otherwise reads width × height", () => {
	assert.equal(describeViewport({ width: 390, height: 844 }), "Phone 390 × 844");
	assert.equal(describeViewport({ width: 820, height: 1180 }), "Tablet 820 × 1180");
	assert.equal(describeViewport({ width: 720, height: 820 }), "720 × 820");
	assert.equal(describeViewport({ width: 390, height: 900 }), "390 × 900", "the preset name needs the preset height too");
});

// S5: the agent's one-line reply on a resolved comment.

test("S5: setStatus resolved with a note stores it, trimmed, as the comment's resolution", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const b = await store.add("alpha", INPUT);
	const result = await store.setStatus("alpha", [a.id], "resolved", { note: "  Made the title 32px.\r\n " });
	assert.equal(result.updated[0].resolution, "Made the title 32px.");
	const onDisk = JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8")).comments;
	assert.equal(onDisk[0].resolution, "Made the title 32px.");
	assert.equal("resolution" in onDisk[1], false, "comments resolved or open without a note never get the key");
	assert.equal((await store.read("alpha")).comments.find((comment) => comment.id === b.id)!.resolution, undefined);
});

test("S11: the resolution note is one line: line breaks and the whitespace around them become one space", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const result = await store.setStatus("alpha", [a.id], "resolved", { note: " Made the title 32px. \r\n\n  Kept the  spacing.\rDone\n " });
	assert.equal(result.updated[0].resolution, "Made the title 32px. Kept the  spacing. Done", "spaces inside a line are kept");
	assert.equal(JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8")).comments[0].resolution, "Made the title 32px. Kept the  spacing. Done");
	assert.equal(normalizeNote("a\u2028b\u2029 c"), "a b c", "Unicode line and paragraph separators are line breaks too");
	assert.equal(normalizeNote(" \n\r\n "), undefined, "nothing left is no note");
	assert.equal(normalizeNote("one line"), "one line");
});

test("S5: setStatus resolved without a note, or with a blank one, stores no resolution", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const b = await store.add("alpha", INPUT);
	await store.setStatus("alpha", [a.id], "resolved");
	await store.setStatus("alpha", [b.id], "resolved", { note: "   \n " });
	const onDisk = JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8")).comments;
	assert.deepEqual(onDisk.map((comment: { status: string }) => comment.status), ["resolved", "resolved"]);
	assert.deepEqual(onDisk.map((comment: object) => "resolution" in comment), [false, false]);
});

test("S5: a note of 500 characters is kept; 501 is refused as invalid-input and comments.json is unchanged", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const path = join(root, "alpha", "comments.json");
	const before = readFileSync(path, "utf8");
	await assert.rejects(store.setStatus("alpha", [a.id], "resolved", { note: "x".repeat(501) }), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input" && /at most 500 characters/.test(error.message));
	await assert.rejects(store.setStatus("alpha", [a.id], "resolved", { note: 7 as never }), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input" && /note must be a string/.test(error.message));
	assert.equal(readFileSync(path, "utf8"), before);
	const kept = await store.setStatus("alpha", [a.id], "resolved", { note: "x".repeat(500) });
	assert.equal(kept.updated[0].resolution!.length, 500);
});

test("S5: reopening a comment clears its resolution; resolving again with a note replaces it", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	await store.setStatus("alpha", [a.id], "resolved", { note: "First try." });
	const reopened = await store.setStatus("alpha", [a.id], "open");
	assert.equal(reopened.updated[0].status, "open");
	assert.equal("resolution" in reopened.updated[0], false);
	assert.equal("resolution" in JSON.parse(readFileSync(join(root, "alpha", "comments.json"), "utf8")).comments[0], false);
	await store.setStatus("alpha", [a.id], "resolved", { note: "Second try." });
	const again = await store.setStatus("alpha", [a.id], "resolved", { note: "Final." });
	assert.equal(again.updated[0].resolution, "Final.");
	assert.equal((await store.read("alpha")).comments[0].resolution, "Final.");
});

test("S5: a note on an open-status change is refused rather than stored", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const before = readFileSync(join(root, "alpha", "comments.json"), "utf8");
	await assert.rejects(store.setStatus("alpha", [a.id], "open", { note: "nope" }), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input");
	assert.equal(readFileSync(join(root, "alpha", "comments.json"), "utf8"), before);
});

test("S5: a malformed resolution in an existing comments.json is an invalid-file error and the file is never overwritten", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const path = join(root, "alpha", "comments.json");
	const good = JSON.parse(readFileSync(path, "utf8"));
	for (const resolution of [7, null, ["x"], "x".repeat(501)]) {
		const bytes = JSON.stringify({ version: 1, comments: [{ ...good.comments[0], status: "resolved", resolution }] });
		writeFileSync(path, bytes);
		await assert.rejects(store.read("alpha"), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file" && /resolution/.test(error.message), JSON.stringify(resolution));
		await assert.rejects(store.setStatus("alpha", [a.id], "open"), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file");
		assert.equal(readFileSync(path, "utf8"), bytes);
	}
	// A valid resolution and a comment without one both read back.
	writeFileSync(path, JSON.stringify({ version: 1, comments: [{ ...good.comments[0], status: "resolved", resolution: "Done." }, { ...good.comments[0], id: "other1" }] }));
	assert.deepEqual((await store.read("alpha")).comments.map((comment) => comment.resolution), ["Done.", undefined]);
});

test("setText normalizes like a new comment: line endings become \\n, the text is trimmed, and blank text is refused without writing", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const edited = await store.setText("alpha", a.id, "  Line one\r\nLine two\rLine three  \n");
	assert.equal(edited.comment.comment, "Line one\nLine two\nLine three");
	assert.equal((await store.read("alpha")).comments[0].comment, "Line one\nLine two\nLine three", "the stored text is the normalized one");
	const path = join(root, "alpha", "comments.json");
	const before = readFileSync(path, "utf8");
	for (const blank of ["   ", "\r\n\t"]) {
		await assert.rejects(store.setText("alpha", a.id, blank), (error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-input", JSON.stringify(blank));
	}
	assert.equal(readFileSync(path, "utf8"), before, "a refused text leaves comments.json unchanged");
	const same = await store.setText("alpha", a.id, "Line one\r\nLine two\nLine three ");
	assert.equal(same.previous, "Line one\nLine two\nLine three");
	assert.equal(readFileSync(path, "utf8"), before, "a text equal after normalizing writes nothing");
});

test("canvas-layout S17: setText changes the text of an open comment, sent or not, returns the previous text and refuses resolved, unknown and invalid ones without writing", async (t) => {
	const root = designRoot(t);
	const store = fixedStore(root);
	const a = await store.add("alpha", INPUT);
	const sent = await store.add("alpha", INPUT);
	const resolved = await store.add("alpha", INPUT);
	await store.markSent("alpha", [sent.id]);
	await store.setStatus("alpha", [resolved.id], "resolved");
	const edited = await store.setText("alpha", a.id, "Make it much bigger");
	assert.equal(edited.comment.comment, "Make it much bigger");
	assert.equal(edited.previous, "Make it bigger");
	assert.equal(edited.comment.sentAt, null);
	assert.equal(edited.comment.createdAt, FIXED.toISOString(), "the creation time stays");
	const resent = await store.setText("alpha", sent.id, "Smaller");
	assert.deepEqual([resent.comment.comment, resent.previous, resent.comment.sentAt], ["Smaller", "Make it bigger", FIXED.toISOString()], "a sent comment can change and keeps its sentAt");
	const path = join(root, "alpha", "comments.json");
	const before = readFileSync(path, "utf8");
	assert.equal(JSON.parse(before).comments[0].comment, "Make it much bigger");
	const refused = (code: string) => (error: unknown) => error instanceof DesignCommentsError && error.code === code;
	await assert.rejects(store.setText("alpha", resolved.id, "New"), refused("locked"));
	await assert.rejects(store.setText("alpha", "nope00", "New"), refused("not-found"));
	await assert.rejects(store.setText("alpha", a.id, ""), refused("invalid-input"));
	await assert.rejects(store.setText("alpha", a.id, "x".repeat(2001)), refused("invalid-input"));
	assert.equal(readFileSync(path, "utf8"), before, "a refused edit writes nothing");
});
