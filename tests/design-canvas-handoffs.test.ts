import assert from "node:assert/strict";
import test from "node:test";
import { boardsOf, handoffDoc, loadCanvas, setHandoffs, texts, withClass } from "./support/design-canvas-dom.ts";

// S15: handoff badges, the chosen artboard, and the Compare button (canvas-handoffs.js).

test("the handoff badge follows the state live, and shows the linked feature document", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { queued: true, feature: "odd/tasks/login.md" } }) });
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(first, "gd-handoff-badge"), ["Queued"]);
	assert.deepEqual(texts(first, "gd-handoff-feature"), ["odd/tasks/login.md"]);
	assert.deepEqual(texts(second, "gd-handoff-badge"), [], "an artboard never handed off has no badge");
	const states: Array<[Record<string, unknown>, string]> = [
		[{ queued: false }, "Implementing…"],
		[{ status: "in_progress", startedAt: "2026-10-26T10:01:00.000Z" }, "In progress"],
		[{ status: "implemented", implementedAt: "2026-10-26T10:02:00.000Z", note: "Done with the header" }, "Implemented ✓"],
	];
	for (const [entry, label] of states) {
		await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": { feature: "odd/tasks/login.md", ...entry } }));
		assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-badge"), [label], label);
	}
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-note"), ["Done with the header"]);
	assert.ok(canvas.fetched.filter((url) => url === "/t/api/designs/alpha/handoffs").length >= 4, "every handoffs.json change is fetched");
	assert.equal(boardsOf(canvas)[0], first, "a handoffs.json change does not reload the artboards");
});

test("the chosen artboard gets a Chosen badge and an accent frame; the others are labeled Alternative", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc(null, {}) });
	for (const board of boardsOf(canvas)) {
		assert.deepEqual(texts(board, "gd-choice"), [], "nothing is chosen yet");
		assert.equal(board.classes.has("gd-chosen"), false);
	}
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(second, "gd-choice"), ["Chosen"]);
	assert.equal(second.classes.has("gd-chosen"), true);
	assert.deepEqual(texts(first, "gd-choice"), ["Alternative"]);
	assert.equal(first.classes.has("gd-chosen"), false);
	await setHandoffs(canvas, handoffDoc("01-a.html", { "02-b.html": {}, "01-a.html": {} }));
	assert.deepEqual(boardsOf(canvas).map((board) => texts(board, "gd-choice")[0]), ["Chosen", "Alternative"], "a new handoff moves Chosen");
});

test("Compare appears only on an implemented artboard with a loopback previewUrl other than the canvas", async () => {
	const canvas = await loadCanvas();
	const compareButtons = () => boardsOf(canvas).map((board) => withClass(board, "gd-compare-start").length);
	const cases: Array<[Record<string, unknown>, number]> = [
		[{ status: "implemented" }, 0],
		[{ status: "in_progress", previewUrl: "http://localhost:3000/" }, 0],
		[{ status: "implemented", previewUrl: "http://example.com/" }, 0],
		[{ status: "implemented", previewUrl: "http://localhost:4100/" }, 0],
		[{ status: "implemented", previewUrl: "javascript:alert(1)" }, 0],
		[{ status: "implemented", previewUrl: "http://localhost:3000/" }, 1],
		[{ status: "implemented", previewUrl: "http://[::1]:3000/" }, 1],
	];
	for (const [entry, count] of cases) {
		await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": entry }));
		assert.deepEqual(compareButtons(), [count, 0], JSON.stringify(entry));
	}
});
