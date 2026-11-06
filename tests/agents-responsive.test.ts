import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { measureAgentsViewLayout } from "../lib/agents-view-layout.ts";

const widths = [0, 1, 2, 11, 12, 59, 60, 90];

for (const rows of [0, 1, 2]) {
	test(`Agents layout safely bounds ${rows}-row terminals`, () => {
		for (const width of widths) {
			const layout = measureAgentsViewLayout(width, rows);
			assert.equal(layout.height, rows);
			assert.ok(layout.width >= 0 && layout.width <= width);
			assert.ok(layout.bodyRows >= 0);
			assert.ok(layout.listWidth >= 0 && layout.threadWidth >= 0);
		}
	});
}

test("Agents layout reserves fallback for tiny terminals, a single viewport for narrow terminals, and panes at 60 cells", () => {
	for (const width of [0, 1, 2, 11]) assert.equal(measureAgentsViewLayout(width, 8).mode, "fallback");
	for (const height of [0, 1, 2]) assert.equal(measureAgentsViewLayout(80, height).mode, "fallback");
	for (const width of [12, 59]) {
		const narrow = measureAgentsViewLayout(width, 3);
		assert.equal(narrow.mode, "narrow");
		assert.equal(narrow.bodyRows, 0);
		assert.equal(narrow.footerY, 1);
	}
	const layout = measureAgentsViewLayout(60, 8);
	assert.equal(layout.mode, "panes");
	assert.equal(layout.height, 8);
	assert.equal(layout.bodyRows, 5);
	assert.equal(layout.footerY, 6);
	assert.equal(layout.listX, 2);
	assert.equal(layout.threadX, layout.listX + layout.listWidth + 3);
	assert.ok(layout.threadX + layout.threadWidth + 1 <= layout.width);
	const fullscreen = measureAgentsViewLayout(60, 8, true);
	assert.equal(fullscreen.mode, "narrow");
	assert.equal(fullscreen.threadWidth, 56);
	assert.equal(fullscreen.threadX, 2);
	assert.equal(fullscreen.height, 8);
	assert.equal(visibleWidth("寿司"), 4, "multibyte widths remain terminal-cell widths");
});
