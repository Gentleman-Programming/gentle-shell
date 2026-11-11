import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { DESIGN_LAYOUT_COORDINATE_MAX, DESIGN_LAYOUT_MAX_POSITIONS, DesignLayoutError, createDesignLayoutStore } from "../lib/design-layout.ts";

// design/<slug>/layout.json (canvas-layout S3): where each artboard sits on the canvas and the arrangement last
// chosen. Validated whole before it is written; a file that cannot be read is no layout, never an error.

function designRoot(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-design-layout-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "design");
	mkdirSync(join(root, "alpha"), { recursive: true });
	return root;
}

const layoutPath = (root: string) => join(root, "alpha", "layout.json");
const isCode = (code: string) => (error: unknown) => error instanceof DesignLayoutError && error.code === code;
const LAYOUT = { arrangement: "free", positions: { system: { x: 0, y: 0 }, "01-a.html": { x: 880, y: -40 }, "sub/02-b.html": { x: 1360, y: 400 } } };

test("S3: a design without layout.json has no layout, and an unknown design is not found", async (t) => {
	const root = designRoot(t);
	const store = createDesignLayoutStore(root);
	assert.equal(await store.read("alpha"), null);
	await assert.rejects(store.read("missing"), isCode("not-found"));
	await assert.rejects(store.read("../alpha"), isCode("not-found"));
	await assert.rejects(store.write("missing", LAYOUT), isCode("not-found"));
	assert.equal(existsSync(join(root, "missing")), false);
});

test("S3: write saves the whole layout as formatted JSON, leaves no temp file, and read gives it back", async (t) => {
	const root = designRoot(t);
	const store = createDesignLayoutStore(root);
	assert.deepEqual(await store.write("alpha", LAYOUT), LAYOUT);
	assert.equal(readFileSync(layoutPath(root), "utf8"), `${JSON.stringify(LAYOUT, null, 2)}\n`);
	assert.deepEqual(readdirSync(join(root, "alpha")), ["layout.json"]);
	assert.deepEqual(await store.read("alpha"), LAYOUT);
	// Each write replaces the whole file: a board left out is dropped.
	const row = { arrangement: "row", positions: { "01-a.html": { x: 0, y: 0 } } };
	await store.write("alpha", row);
	assert.deepEqual(JSON.parse(readFileSync(layoutPath(root), "utf8")), row);
	for (const arrangement of ["column", "grid"]) assert.equal((await store.write("alpha", { arrangement, positions: {} })).arrangement, arrangement);
});

test("S3: write refuses anything but a known arrangement and integer positions of artboards, and writes nothing", async (t) => {
	const root = designRoot(t);
	const store = createDesignLayoutStore(root);
	const many = Object.fromEntries(Array.from({ length: DESIGN_LAYOUT_MAX_POSITIONS + 1 }, (_, index) => [`${index}.html`, { x: 0, y: 0 }]));
	const refused: Array<[unknown, RegExp]> = [
		[null, /must be a JSON object/],
		[[], /must be a JSON object/],
		["row", /must be a JSON object/],
		[{ ...LAYOUT, version: 1 }, /unknown keys: version/],
		[{ positions: {} }, /arrangement must be/],
		[{ arrangement: "diagonal", positions: {} }, /arrangement must be/],
		[{ arrangement: "row" }, /positions must be an object/],
		[{ arrangement: "row", positions: [] }, /positions must be an object/],
		[{ arrangement: "row", positions: { "../x.html": { x: 0, y: 0 } } }, /keys must be relative \.html artboard paths or "system"/],
		[{ arrangement: "row", positions: { "notes.txt": { x: 0, y: 0 } } }, /keys must be/],
		[{ arrangement: "row", positions: { "": { x: 0, y: 0 } } }, /keys must be/],
		[{ arrangement: "row", positions: { "01-a.html": [0, 0] } }, /must be an object with x and y/],
		[{ arrangement: "row", positions: { "01-a.html": { x: 0, y: 0, z: 1 } } }, /may hold only x and y/],
		[{ arrangement: "row", positions: { "01-a.html": { x: 1.5, y: 0 } } }, /x and y must be integers between -2000000 and 2000000/],
		[{ arrangement: "row", positions: { "01-a.html": { x: "1", y: 0 } } }, /x and y must be integers/],
		[{ arrangement: "row", positions: { "01-a.html": { x: 0 } } }, /x and y must be integers/],
		[{ arrangement: "row", positions: { "01-a.html": { x: Number.NaN, y: 0 } } }, /x and y must be integers/],
		[{ arrangement: "row", positions: { "01-a.html": { x: Number.POSITIVE_INFINITY, y: 0 } } }, /x and y must be integers/],
		[{ arrangement: "row", positions: { "01-a.html": { x: 0, y: -DESIGN_LAYOUT_COORDINATE_MAX - 1 } } }, /x and y must be integers/],
		[{ arrangement: "row", positions: many }, /at most 100 boards/],
	];
	for (const [value, message] of refused) {
		await assert.rejects(store.write("alpha", value), (error: unknown) => isCode("invalid-input")(error) && message.test((error as Error).message), JSON.stringify(value)?.slice(0, 80));
	}
	assert.equal(existsSync(layoutPath(root)), false, "a refused layout writes nothing");
	await store.write("alpha", LAYOUT);
	const before = readFileSync(layoutPath(root), "utf8");
	await assert.rejects(store.write("alpha", { arrangement: "row", positions: { "01-a.html": { x: 0.5, y: 0 } } }), isCode("invalid-input"));
	assert.equal(readFileSync(layoutPath(root), "utf8"), before, "and leaves the saved one as it was");
	// The bounds themselves are accepted.
	const edge = { arrangement: "free", positions: { "01-a.html": { x: -DESIGN_LAYOUT_COORDINATE_MAX, y: DESIGN_LAYOUT_COORDINATE_MAX } } };
	assert.deepEqual(await store.write("alpha", edge), edge);
});

test("S3: an unreadable or invalid layout.json reads as no layout, and the next write replaces it", async (t) => {
	const root = designRoot(t);
	const store = createDesignLayoutStore(root);
	for (const content of ["{ not json", "[]", JSON.stringify({ arrangement: "row" }), JSON.stringify({ arrangement: "row", positions: { "01-a.html": { x: 1.5, y: 0 } } }), "x".repeat(300 * 1024)]) {
		writeFileSync(layoutPath(root), content);
		assert.equal(await store.read("alpha"), null, content.slice(0, 40));
	}
	await store.write("alpha", LAYOUT);
	assert.deepEqual(await store.read("alpha"), LAYOUT);
	rmSync(layoutPath(root));
	mkdirSync(layoutPath(root));
	assert.equal(await store.read("alpha"), null, "a directory named layout.json is no layout");
});
