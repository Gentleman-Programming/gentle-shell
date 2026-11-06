import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { DESIGN_HANDOFF_NOTE_LIMIT, DesignHandoffsError, createDesignHandoffStore, designPreviewUrlProblem, sendDesignHandoff } from "../lib/design-handoffs.ts";

// design/<slug>/handoffs.json has one owner (S15): the canvas server, the
// command and the gentle_design tool all write through lib/design-handoffs.ts,
// in the same per-file queue as comments.json.

function scratch(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function designRoot(t: TestContext) {
	const root = join(scratch(t, "gentle-design-handoffs-"), "design");
	mkdirSync(join(root, "alpha"), { recursive: true });
	return root;
}

/** A clock that advances one second per call, so every timestamp is distinct and predictable. */
function ticking() {
	let seconds = 0;
	return () => new Date(Date.UTC(2026, 9, 26, 10, 0, seconds++));
}

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 26, 10, 0, seconds)).toISOString();
const onDisk = (root: string) => JSON.parse(readFileSync(join(root, "alpha", "handoffs.json"), "utf8"));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const isCode = (code: string) => (error: unknown) => error instanceof DesignHandoffsError && error.code === code;

test("a missing handoffs.json reads as an empty document with nothing chosen", async (t) => {
	const root = designRoot(t);
	assert.deepEqual(await createDesignHandoffStore(root).read("alpha"), { version: 1, chosen: null, handoffs: {} });
});

test("markSent records a sent handoff, sets chosen, and a second handoff moves chosen", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root, { now: ticking() });
	const first = await store.markSent("alpha", "01-a.html", { queued: true, feature: "odd/tasks/login.md" });
	assert.deepEqual(first.entry, { status: "sent", queued: true, sentAt: at(0), startedAt: null, implementedAt: null, feature: "odd/tasks/login.md" });
	assert.deepEqual(onDisk(root), { version: 1, chosen: "01-a.html", handoffs: { "01-a.html": first.entry } });
	assert.deepEqual(readdirSync(join(root, "alpha")), ["handoffs.json"], "no temp file is left behind");

	const second = await store.markSent("alpha", "02-b.html", { queued: false });
	assert.equal(onDisk(root).chosen, "02-b.html", "one chosen artboard per design; the new handoff moves it");
	assert.deepEqual(onDisk(root).handoffs["01-a.html"], first.entry, "the earlier handoff keeps its state");
	assert.deepEqual(second.entry, { status: "sent", queued: false, sentAt: at(1), startedAt: null, implementedAt: null });
	assert.deepEqual(await store.read("alpha"), onDisk(root));
});

test("setStatus moves a handoff to in_progress and implemented with timestamps, note and previewUrl", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root, { now: ticking() });
	await store.markSent("alpha", "01-a.html", { queued: false });
	const started = await store.setStatus("alpha", "01-a.html", "in_progress", { note: "  Starting with the header  " });
	assert.deepEqual(started, { status: "in_progress", queued: false, sentAt: at(0), startedAt: at(1), implementedAt: null, note: "Starting with the header" });
	const done = await store.setStatus("alpha", "01-a.html", "implemented", { previewUrl: "http://localhost:5173/login" });
	assert.deepEqual(done, { status: "implemented", queued: false, sentAt: at(0), startedAt: at(1), implementedAt: at(2), previewUrl: "http://localhost:5173/login" }, "note and previewUrl are exactly what each update passes");
	assert.deepEqual(onDisk(root).handoffs["01-a.html"], done);

	// A new handoff of the same artboard starts over.
	const again = await store.markSent("alpha", "01-a.html", { queued: true });
	assert.deepEqual(again.entry, { status: "sent", queued: true, sentAt: at(3), startedAt: null, implementedAt: null });
	const restarted = await store.setStatus("alpha", "01-a.html", "in_progress", {});
	assert.equal(restarted.implementedAt, null);
	assert.equal(restarted.startedAt, at(4));
});

test("setStatus on an artboard never handed off records it and makes it chosen; it never moves chosen otherwise", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root, { now: ticking() });
	const entry = await store.setStatus("alpha", "02-b.html", "in_progress", {});
	assert.deepEqual(entry, { status: "in_progress", queued: false, sentAt: at(0), startedAt: at(0), implementedAt: null });
	assert.equal(onDisk(root).chosen, "02-b.html");
	await store.markSent("alpha", "01-a.html", { queued: false });
	await store.setStatus("alpha", "02-b.html", "implemented", {});
	assert.equal(onDisk(root).chosen, "01-a.html", "an update of an earlier handoff keeps the latest handoff chosen");
});

test("setStatus and markSent refuse bad input with a typed error and write nothing", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root);
	await assert.rejects(store.setStatus("alpha", "01-a.html", "sent" as never, {}), isCode("invalid-input"));
	await assert.rejects(store.setStatus("alpha", "01-a.html", "done" as never, {}), isCode("invalid-input"));
	await assert.rejects(store.setStatus("alpha", "../x.html", "in_progress", {}), isCode("invalid-input"));
	await assert.rejects(store.setStatus("alpha", "01-a.html", "in_progress", { note: "x".repeat(DESIGN_HANDOFF_NOTE_LIMIT + 1) }), isCode("invalid-input"));
	await assert.rejects(store.setStatus("alpha", "01-a.html", "in_progress", { note: 7 as never }), isCode("invalid-input"));
	await assert.rejects(store.markSent("alpha", "01-a.html", { queued: "yes" as never }), isCode("invalid-input"));
	await assert.rejects(store.markSent("alpha", "01-a.html", { queued: false, feature: "../x.md" }), isCode("invalid-input"));
	await assert.rejects(store.markSent("alpha", "notes.txt", { queued: false }), isCode("invalid-input"));
	await assert.rejects(store.setStatus("Bad_Slug", "01-a.html", "in_progress", {}), isCode("not-found"));
	await assert.rejects(store.setStatus("missing", "01-a.html", "in_progress", {}), isCode("not-found"));
	const ok = await store.setStatus("alpha", "01-a.html", "in_progress", { note: "x".repeat(DESIGN_HANDOFF_NOTE_LIMIT) });
	assert.equal(ok.note?.length, DESIGN_HANDOFF_NOTE_LIMIT, "a note at the limit is kept");
	assert.equal(Object.keys(onDisk(root).handoffs).length, 1);
});

const ACCEPTED = [
	"http://localhost:3000/",
	"http://localhost:5173/login?tab=a#top",
	"https://localhost:8443/",
	"http://127.0.0.1:8080/app",
	"https://127.0.0.1:1/",
	"http://[::1]:3000/",
	"https://[::1]:4443/x",
	"http://localhost/",
	"http://LOCALHOST:3000/",
];

const REJECTED = [
	"http://example.com",
	"http://localhost.evil.test",
	"http://localhost.evil.test:3000/",
	"http://evil.localhost:3000/",
	"http://user:pw@localhost:3000/",
	"http://user@localhost:3000/",
	"javascript:alert(1)",
	"file:///etc/passwd",
	"data:text/html,hi",
	"ftp://localhost/",
	"ws://localhost:3000/",
	"http://127.0.0.2/",
	"http://0.0.0.0:3000/",
	"http://[::2]:3000/",
	"http://localhost:3000/\nInjected",
	" http://localhost:3000/",
	"//localhost:3000/",
	"localhost:3000",
	"",
	`http://localhost:3000/${"a".repeat(2048 - "http://localhost:3000/".length + 1)}`,
];

test("previewUrl accepts only loopback http(s) URLs without credentials, at most 2048 characters", () => {
	for (const url of ACCEPTED) assert.equal(designPreviewUrlProblem(url), undefined, url);
	assert.equal(designPreviewUrlProblem(`http://localhost:3000/${"a".repeat(2048 - "http://localhost:3000/".length)}`), undefined, "exactly 2048 characters");
	for (const url of REJECTED) assert.equal(typeof designPreviewUrlProblem(url), "string", url);
	assert.equal(REJECTED.at(-1)!.length, 2049);
	for (const value of [7, null, undefined, {}]) assert.equal(typeof designPreviewUrlProblem(value), "string", String(value));
});

test("setStatus stores a valid previewUrl and refuses an invalid one with a typed error", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root);
	await store.markSent("alpha", "01-a.html", { queued: false });
	const before = hash(join(root, "alpha", "handoffs.json"));
	for (const url of REJECTED) {
		await assert.rejects(store.setStatus("alpha", "01-a.html", "implemented", { previewUrl: url }), isCode("invalid-preview-url"), url);
	}
	assert.equal(hash(join(root, "alpha", "handoffs.json")), before, "a refused update writes nothing");
	for (const url of ACCEPTED) {
		const entry = await store.setStatus("alpha", "01-a.html", "implemented", { previewUrl: url });
		assert.equal(entry.previewUrl, new URL(url).href, url);
	}
});

test("20 parallel markSent and setStatus calls leave valid JSON and lose nothing", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root);
	// A second store over the same root shares the process-wide queue.
	const other = createDesignHandoffStore(root);
	const files = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, "0")}-a.html`);
	await Promise.all(files.map((file, index) => index % 2 === 0
		? store.markSent("alpha", file, { queued: index % 4 === 0 })
		: other.setStatus("alpha", file, "implemented", { previewUrl: `http://localhost:${3000 + index}/` })));
	const document = onDisk(root);
	assert.deepEqual(Object.keys(document.handoffs).sort(), files);
	for (const [index, file] of files.entries()) {
		const entry = document.handoffs[file];
		if (index % 2 === 0) assert.equal(entry.status, "sent", file);
		else assert.deepEqual([entry.status, entry.previewUrl], ["implemented", `http://localhost:${3000 + index}/`], file);
	}
	assert.ok(files.includes(document.chosen));
	assert.deepEqual(readdirSync(join(root, "alpha")), ["handoffs.json"]);

	// Racing updates of one artboard each land whole: the last one in queue order wins, never a mix.
	const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.setStatus("alpha", "00-a.html", index % 2 ? "implemented" : "in_progress", { note: `n${index}` })));
	const final = onDisk(root).handoffs["00-a.html"];
	const index = Number(/^n(\d+)$/.exec(final.note)![1]);
	assert.equal(final.status, index % 2 ? "implemented" : "in_progress");
	assert.ok(results.some((entry) => JSON.stringify(entry) === JSON.stringify(final)), "the file holds one complete update");
});

test("an invalid handoffs.json is reported and never overwritten", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root);
	const path = join(root, "alpha", "handoffs.json");
	const broken = [
		"{ not json",
		"[]",
		JSON.stringify({ version: 2, chosen: null, handoffs: {} }),
		JSON.stringify({ version: 1, chosen: null, handoffs: [] }),
		JSON.stringify({ version: 1, chosen: "01-a.html", handoffs: {} }),
		JSON.stringify({ version: 1, chosen: null, handoffs: { "../x.html": { status: "sent", queued: false, sentAt: "t", startedAt: null, implementedAt: null } } }),
		JSON.stringify({ version: 1, chosen: null, handoffs: { "01-a.html": { status: "done", queued: false, sentAt: "t", startedAt: null, implementedAt: null } } }),
		JSON.stringify({ version: 1, chosen: null, handoffs: { "01-a.html": { status: "sent", queued: false, sentAt: "t", startedAt: null, implementedAt: null, previewUrl: "http://example.com/" } } }),
		JSON.stringify({ version: 1, chosen: null, handoffs: { "01-a.html": { status: "sent", queued: 1, sentAt: "t", startedAt: null, implementedAt: null } } }),
	];
	for (const content of broken) {
		writeFileSync(path, content);
		const before = hash(path);
		await assert.rejects(store.read("alpha"), isCode("invalid-file"), content);
		await assert.rejects(store.markSent("alpha", "01-a.html", { queued: false }), isCode("invalid-file"), content);
		await assert.rejects(store.setStatus("alpha", "01-a.html", "implemented", {}), isCode("invalid-file"), content);
		assert.equal(hash(path), before, `${content} is never overwritten`);
	}
	assert.deepEqual(readdirSync(join(root, "alpha")), ["handoffs.json"]);
});

test("a symlinked handoffs.json is refused, and so is a design that escapes design/", async (t) => {
	const root = designRoot(t);
	const outside = scratch(t, "gentle-design-handoffs-outside-");
	const target = join(outside, "handoffs.json");
	writeFileSync(target, JSON.stringify({ version: 1, chosen: null, handoffs: {} }));
	const before = hash(target);
	symlinkSync(target, join(root, "alpha", "handoffs.json"));
	const store = createDesignHandoffStore(root);
	await assert.rejects(store.read("alpha"), isCode("not-found"));
	await assert.rejects(store.markSent("alpha", "01-a.html", { queued: false }), isCode("not-found"));
	await assert.rejects(store.setStatus("alpha", "01-a.html", "in_progress", {}), isCode("not-found"));
	assert.equal(hash(target), before, "the link target is untouched");

	mkdirSync(join(outside, "escaped"));
	symlinkSync(join(outside, "escaped"), join(root, "escaped"));
	await assert.rejects(store.markSent("escaped", "01-a.html", { queued: false }), isCode("not-found"));
	for (const slug of ["..", ".", "../design", "alpha/..", ""]) await assert.rejects(store.read(slug), isCode("not-found"), slug);
	assert.deepEqual(readdirSync(join(outside, "escaped")), [], "nothing is written outside design/");
});

test("sendDesignHandoff records the handoff before delivery, then the queued answer of the delivery", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root, { now: ticking() });
	const seen: unknown[] = [];
	const result = await sendDesignHandoff(store, { slug: "alpha", file: "01-a.html", feature: "odd/tasks/login.md" }, () => {
		seen.push(onDisk(root));
		return { queued: true };
	});
	assert.deepEqual(result, { queued: true });
	assert.deepEqual(seen, [{ version: 1, chosen: "01-a.html", handoffs: { "01-a.html": { status: "sent", queued: false, sentAt: at(0), startedAt: null, implementedAt: null, feature: "odd/tasks/login.md" } } }], "recorded before delivery");
	assert.equal(onDisk(root).handoffs["01-a.html"].queued, true);

	const idle = await sendDesignHandoff(store, { slug: "alpha", file: "02-b.html" }, () => undefined);
	assert.deepEqual(idle, { queued: false });
	assert.equal(onDisk(root).handoffs["02-b.html"].queued, false);
	assert.equal(onDisk(root).chosen, "02-b.html");
});

test("a failed delivery takes the handoff back and restores the previous chosen artboard", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root, { now: ticking() });
	await sendDesignHandoff(store, { slug: "alpha", file: "01-a.html" }, () => ({ queued: false }));
	const before = onDisk(root);
	await assert.rejects(sendDesignHandoff(store, { slug: "alpha", file: "02-b.html" }, () => { throw new Error("boom"); }), /boom/);
	assert.deepEqual(onDisk(root), before, "the failed handoff leaves no trace");

	await store.setStatus("alpha", "01-a.html", "implemented", {});
	const implemented = onDisk(root);
	await assert.rejects(sendDesignHandoff(store, { slug: "alpha", file: "01-a.html" }, async () => { throw new Error("late"); }), /late/);
	assert.deepEqual(onDisk(root), implemented, "a failed re-handoff restores the earlier state of that artboard");
});

test("a delivery answer never overwrites a state the agent already changed", async (t) => {
	const root = designRoot(t);
	const store = createDesignHandoffStore(root, { now: ticking() });
	await sendDesignHandoff(store, { slug: "alpha", file: "01-a.html" }, async () => {
		// The agent picks the handoff up before the delivery returns.
		await store.setStatus("alpha", "01-a.html", "in_progress", {});
		return { queued: true };
	});
	assert.equal(onDisk(root).handoffs["01-a.html"].status, "in_progress");
	assert.equal(onDisk(root).handoffs["01-a.html"].queued, false);
	await assert.rejects(sendDesignHandoff(store, { slug: "alpha", file: "02-b.html" }, async () => {
		await store.setStatus("alpha", "02-b.html", "in_progress", {});
		throw new Error("boom");
	}), /boom/);
	assert.equal(onDisk(root).handoffs["02-b.html"].status, "in_progress", "a failure after the agent took it over keeps the agent's state");
});
