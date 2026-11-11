import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { DESIGN_PARTS_MAX, DesignPartsError, createDesignPartStore, sendDesignPart } from "../lib/design-parts.ts";

// design/<slug>/parts.json (canvas-implement-part S2-S4, S6): the parts of artboards handed to the session one at a
// time ("Implement only this"). It never touches handoffs.json, so no direction is chosen or discarded.

function designRoot(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-design-parts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "design");
	mkdirSync(join(root, "alpha"), { recursive: true });
	return root;
}

function ticking() {
	let seconds = 0;
	return () => new Date(Date.UTC(2026, 9, 31, 10, 0, seconds++));
}

function ids() {
	let n = 0;
	return () => `part${++n}`;
}

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, seconds)).toISOString();
const partsPath = (root: string) => join(root, "alpha", "parts.json");
const onDisk = (root: string) => JSON.parse(readFileSync(partsPath(root), "utf8"));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const isCode = (code: string) => (error: unknown) => error instanceof DesignPartsError && error.code === code;
const SIDEBAR = { file: "01-a.html", selector: "nav.sidebar", excerpt: "Inicio Tours Reservas", instruction: "Only the menu, not the header" };

test("S4: a missing parts.json reads as an empty document", async (t) => {
	const root = designRoot(t);
	assert.deepEqual(await createDesignPartStore(root).read("alpha"), { version: 1, parts: [] });
});

test("S4: add records a sent part with its artboard, element and note, appends the next one, and never touches handoffs.json", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	const first = await store.add("alpha", SIDEBAR);
	assert.deepEqual(first, { id: "part1", file: "01-a.html", selector: "nav.sidebar", excerpt: "Inicio Tours Reservas", instruction: "Only the menu, not the header", status: "sent", queued: false, sentAt: at(0), startedAt: null, implementedAt: null });
	assert.deepEqual(onDisk(root), { version: 1, parts: [first] });
	assert.deepEqual(readdirSync(join(root, "alpha")), ["parts.json"], "no temp file and no handoffs.json");

	const second = await store.add("alpha", { file: "02-b.html", selector: "  footer\n .links ", excerpt: "  a   lot\nof   space ", instruction: "" });
	assert.deepEqual(second, { id: "part2", file: "02-b.html", selector: "footer .links", excerpt: "a lot of space", status: "sent", queued: false, sentAt: at(1), startedAt: null, implementedAt: null }, "collapsed selector and excerpt; an empty note is left out");
	assert.deepEqual(onDisk(root).parts, [first, second], "in the order they were sent");
	assert.deepEqual(await store.read("alpha"), onDisk(root));
	assert.equal(existsSync(join(root, "alpha", "handoffs.json")), false);
});

test("S4: add refuses a bad artboard path, selector or note, cuts the excerpt to 300, and holds at most DESIGN_PARTS_MAX parts", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	await assert.rejects(store.add("alpha", { ...SIDEBAR, file: "../x.html" }), isCode("invalid-input"));
	await assert.rejects(store.add("alpha", { ...SIDEBAR, file: "notes.txt" }), isCode("invalid-input"));
	await assert.rejects(store.add("alpha", { ...SIDEBAR, selector: "   " }), isCode("invalid-input"), "a selector is required");
	await assert.rejects(store.add("alpha", { ...SIDEBAR, selector: "a".repeat(501) }), isCode("invalid-input"));
	await assert.rejects(store.add("alpha", { ...SIDEBAR, instruction: "n".repeat(2001) }), isCode("invalid-input"));
	assert.equal(existsSync(partsPath(root)), false, "a refused part writes nothing");
	const long = await store.add("alpha", { ...SIDEBAR, excerpt: "x".repeat(400) });
	assert.equal(long.excerpt.length, 300);
	for (let i = 1; i < DESIGN_PARTS_MAX; i++) await store.add("alpha", SIDEBAR);
	assert.equal(onDisk(root).parts.length, DESIGN_PARTS_MAX);
	await assert.rejects(store.add("alpha", SIDEBAR), isCode("limit"));
	assert.equal(onDisk(root).parts.length, DESIGN_PARTS_MAX, "the full file is unchanged");
});

test("S6: setStatus moves a part to in_progress and implemented with timestamps and the agent's note, checked against its artboard", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	await store.add("alpha", SIDEBAR);
	const started = await store.setStatus("alpha", "01-a.html", "part1", "in_progress", { note: "  Building the sidebar\r\n " });
	assert.deepEqual(started, { ...onDisk(root).parts[0], status: "in_progress", startedAt: at(1), implementedAt: null, note: "Building the sidebar" });
	const done = await store.setStatus("alpha", "01-a.html", "part1", "implemented", {});
	assert.equal(done.status, "implemented");
	assert.equal(done.startedAt, at(1), "the start time stays");
	assert.equal(done.implementedAt, at(2));
	assert.equal(done.note, undefined, "the note is exactly what the last call passed");
	assert.deepEqual(onDisk(root).parts, [done]);
	await assert.rejects(store.setStatus("alpha", "01-a.html", "nope", "implemented", {}), isCode("not-found"));
	await assert.rejects(store.setStatus("alpha", "02-b.html", "part1", "implemented", {}), isCode("invalid-input"), "the part belongs to another artboard");
	await assert.rejects(store.setStatus("alpha", "01-a.html", "part1", "sent" as never, {}), isCode("invalid-input"));
	await assert.rejects(store.setStatus("alpha", "01-a.html", "part1", "implemented", { note: "n".repeat(1001) }), isCode("invalid-input"));
	assert.deepEqual(onDisk(root).parts, [done], "refusals change nothing");
});

test("S4: sendDesignPart records the part before delivering it, marks it queued, and takes it back when the delivery fails", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	const sent = await sendDesignPart(store, "alpha", SIDEBAR, () => {
		assert.equal(onDisk(root).parts.length, 1, "on disk before the session gets the message");
		return { queued: true };
	});
	assert.equal(sent.queued, true);
	assert.equal(sent.part.id, "part1");
	assert.equal(onDisk(root).parts[0].queued, true);

	await assert.rejects(sendDesignPart(store, "alpha", { ...SIDEBAR, file: "02-b.html" }, () => { throw new Error("session closed"); }), /session closed/);
	assert.deepEqual(onDisk(root).parts.map((part: { id: string }) => part.id), ["part1"], "the failed part is removed, the earlier one kept");
	const idle = await sendDesignPart(store, "alpha", SIDEBAR, () => undefined);
	assert.equal(idle.queued, false);
	assert.equal(onDisk(root).parts[1].queued, false);
});

test("S4: a parts.json the store cannot parse is reported and never overwritten", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	for (const bad of ["not json", JSON.stringify({ version: 2, parts: [] }), JSON.stringify({ version: 1, parts: {} }), JSON.stringify({ version: 1, parts: [{ id: "x", file: "../a.html" }] })]) {
		writeFileSync(partsPath(root), bad);
		const before = hash(partsPath(root));
		await assert.rejects(store.read("alpha"), isCode("invalid-file"));
		await assert.rejects(store.add("alpha", SIDEBAR), isCode("invalid-file"));
		assert.equal(hash(partsPath(root)), before, "untouched");
	}
	await assert.rejects(store.read("../etc"), isCode("not-found"));
});

// canvas-server-data S2: "Remove" clears a part the agent never reported. It goes through the same serialized
// parts.json writer, removes only a part still `sent` (queued or not), and refuses anything else without writing.

test("S2: removeSent takes out a sent part, queued or not, keeps the others in order, and never touches handoffs.json", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	const first = await store.add("alpha", SIDEBAR);
	const second = await store.add("alpha", { ...SIDEBAR, file: "02-b.html" });
	const third = await store.add("alpha", SIDEBAR);
	assert.equal(await store.markQueued("alpha", third.id), true);
	assert.deepEqual(await store.removeSent("alpha", "part2"), second, "it answers the removed part");
	assert.deepEqual(onDisk(root), { version: 1, parts: [first, { ...third, queued: true }] });
	assert.deepEqual(await store.removeSent("alpha", "part3"), { ...third, queued: true }, "a queued part is still sent and can be removed");
	assert.deepEqual(onDisk(root), { version: 1, parts: [first] });
	assert.equal(readFileSync(partsPath(root), "utf8"), `${JSON.stringify({ version: 1, parts: [first] }, null, 2)}\n`);
	assert.deepEqual(readdirSync(join(root, "alpha")), ["parts.json"], "no temp file and no handoffs.json");
});

test("S2: removeSent refuses a part in progress or implemented, an unknown or malformed id, a missing design and a broken file, leaving parts.json byte for byte", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	await store.add("alpha", SIDEBAR);
	await store.add("alpha", SIDEBAR);
	await store.setStatus("alpha", "01-a.html", "part1", "in_progress", {});
	await store.setStatus("alpha", "01-a.html", "part2", "implemented", {});
	writeFileSync(join(root, "alpha", "handoffs.json"), "{\"handoffs\":[]}");
	const before = hash(partsPath(root));
	const handoffs = hash(join(root, "alpha", "handoffs.json"));
	await assert.rejects(store.removeSent("alpha", "part1"), (error: unknown) => error instanceof DesignPartsError && error.code === "not-sent" && error.message === 'Part "part1" is in_progress, not sent; only a sent part can be removed.');
	await assert.rejects(store.removeSent("alpha", "part2"), (error: unknown) => error instanceof DesignPartsError && error.code === "not-sent" && error.message === 'Part "part2" is implemented, not sent; only a sent part can be removed.');
	await assert.rejects(store.removeSent("alpha", "nope"), (error: unknown) => error instanceof DesignPartsError && error.code === "not-found" && error.message === 'No part "nope" in design/alpha/parts.json.');
	for (const id of ["", "UPPER", "a".repeat(33), "../x", 7 as never, undefined as never]) {
		await assert.rejects(store.removeSent("alpha", id), (error: unknown) => error instanceof DesignPartsError && error.code === "invalid-input" && error.message === "id must be 1 to 32 lowercase letters or digits", `id ${String(id)}`);
	}
	await assert.rejects(store.removeSent("missing", "part1"), isCode("not-found"));
	assert.equal(hash(partsPath(root)), before, "every refusal leaves parts.json unchanged");
	assert.equal(hash(join(root, "alpha", "handoffs.json")), handoffs, "and handoffs.json untouched");
	writeFileSync(partsPath(root), "not json");
	await assert.rejects(store.removeSent("alpha", "part1"), isCode("invalid-file"));
	assert.equal(readFileSync(partsPath(root), "utf8"), "not json", "a broken file is never overwritten");
});

test("S2: removeSent shares the serialized writer, so a parallel add and removal both land", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	await store.add("alpha", SIDEBAR);
	const [added] = await Promise.all([store.add("alpha", { ...SIDEBAR, file: "02-b.html" }), store.removeSent("alpha", "part1")]);
	assert.deepEqual(onDisk(root).parts, [added], "the new part is kept and the removed one is gone");
});

test("S2 preserve: remove still takes back a part whatever its status (a failed delivery)", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	await store.add("alpha", SIDEBAR);
	await store.setStatus("alpha", "01-a.html", "part1", "implemented", {});
	assert.equal(await store.remove("alpha", "part1"), true);
	assert.equal(await store.remove("alpha", "part1"), false);
	assert.deepEqual(onDisk(root), { version: 1, parts: [] });
});

// canvas-server-data S9: parts.json holds at most 1 MiB. The serialized document is measured before the file is
// replaced, so a write that would pass the limit is refused and the previous file stays byte for byte. Control
// characters escape to six bytes each, which is how plain-looking text can reach the limit.

const MAX_PARTS_BYTES = 1024 * 1024;
const CONTROL = "\u0001";
const serialized = (parts: object[]) => `${JSON.stringify({ version: 1, parts }, null, 2)}\n`;
const bytesOf = (parts: object[]) => Buffer.byteLength(serialized(parts));

/** Filler parts so that the document of the fillers plus `extra` serializes to exactly `target` bytes. */
function fillTo(target: number, extra: object[]): object[] {
	const fillers: Array<Record<string, unknown>> = [];
	for (let i = 0; ; i++) {
		const part: Record<string, unknown> = { id: `fill${i}`, file: "01-a.html", selector: "s", excerpt: "", instruction: "", status: "sent", queued: false, sentAt: at(0), startedAt: null, implementedAt: null };
		const gap = target - bytesOf([...fillers, ...extra]);
		fillers.push(part);
		const overhead = bytesOf([...fillers, ...extra]) - bytesOf([...fillers.slice(0, -1), ...extra]);
		// Whole six-byte escapes in the instruction, never leaving a gap too small for one more filler.
		let length = Math.min(2000, Math.floor((gap - overhead) / 6));
		if (length === 2000 && gap - overhead - 12000 < overhead + 12) length = 1000;
		assert.ok(length >= 0 && fillers.length < 99, "the fillers fit in the parts a design can hold");
		part.instruction = CONTROL.repeat(length);
		const left = target - bytesOf([...fillers, ...extra]);
		if (left >= 6) continue;
		part.excerpt = "x".repeat(left);
		assert.equal(bytesOf([...fillers, ...extra]), target);
		return fillers;
	}
}

test("S9: add refuses a part that would push parts.json past 1 MiB with a too-large error, leaving the file byte for byte", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	const added = { id: "part1", ...SIDEBAR, status: "sent", queued: false, sentAt: at(0), startedAt: null, implementedAt: null };
	writeFileSync(partsPath(root), serialized(fillTo(MAX_PARTS_BYTES + 1, [added])));
	const before = hash(partsPath(root));
	await assert.rejects(store.add("alpha", SIDEBAR), (error: unknown) => error instanceof DesignPartsError && error.code === "too-large" && error.message === `design/alpha/parts.json would grow to ${MAX_PARTS_BYTES + 1} bytes, past the 1 MiB it can hold; nothing was written.`);
	assert.equal(hash(partsPath(root)), before, "the previous file is intact");
	assert.deepEqual(readdirSync(join(root, "alpha")), ["parts.json"], "no temp file is left");
	assert.ok((await store.read("alpha")).parts.length > 0, "and it still reads");
});

test("S9: a write that lands exactly on 1 MiB is kept, and control characters in the note count as their six-byte escapes", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	const added = { id: "part1", ...SIDEBAR, status: "sent", queued: false, sentAt: at(0), startedAt: null, implementedAt: null };
	writeFileSync(partsPath(root), serialized(fillTo(MAX_PARTS_BYTES, [added])));
	assert.deepEqual(await store.add("alpha", SIDEBAR), added);
	assert.equal(readFileSync(partsPath(root)).length, MAX_PARTS_BYTES, "exactly at the limit is allowed");
	const before = hash(partsPath(root));
	await assert.rejects(store.add("alpha", { ...SIDEBAR, instruction: CONTROL }), isCode("too-large"));
	await assert.rejects(store.setStatus("alpha", "01-a.html", "part1", "in_progress", { note: CONTROL.repeat(10) }), isCode("too-large"), "a growing progress note is refused too");
	assert.equal(hash(partsPath(root)), before, "every refusal leaves the full file unchanged");
	assert.deepEqual(await store.removeSent("alpha", "part1"), added, "Remove still repairs a full file");
	assert.ok(readFileSync(partsPath(root)).length < MAX_PARTS_BYTES);
});

// canvas-server-data S11: a repeated in_progress report keeps the time the part was first started.

test("S11: a repeated in_progress report keeps the first startedAt; in_progress after implemented starts again", async (t) => {
	const root = designRoot(t);
	const store = createDesignPartStore(root, { now: ticking(), randomId: ids() });
	await store.add("alpha", SIDEBAR);
	const first = await store.setStatus("alpha", "01-a.html", "part1", "in_progress", { note: "header" });
	assert.equal(first.startedAt, at(1));
	const again = await store.setStatus("alpha", "01-a.html", "part1", "in_progress", { note: "menu" });
	assert.equal(again.startedAt, at(1), "the repeated report keeps the start time");
	assert.equal(again.note, "menu", "the note is still exactly what the last call passed");
	assert.equal(onDisk(root).parts[0].startedAt, at(1));
	const done = await store.setStatus("alpha", "01-a.html", "part1", "implemented", {});
	assert.equal(done.startedAt, at(1));
	assert.equal(done.implementedAt, at(3));
	const reopened = await store.setStatus("alpha", "01-a.html", "part1", "in_progress", {});
	assert.equal(reopened.startedAt, at(4), "taking an implemented part up again is a new start, as before");
	assert.equal(reopened.implementedAt, null);
});
