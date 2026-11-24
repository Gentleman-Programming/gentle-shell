// Pins the mobile layout rules of the Gentle Tower web app through the pure
// functions web/tower/src/layout.ts exports (no browser needed).

import assert from "node:assert/strict";
import test from "node:test";
import { FH, fitBuilding, SCENE_W, SHEET_MAX_WIDTH, useBottomSheet } from "../web/tower/src/layout.ts";

test("useBottomSheet is on at or below 720 CSS px and for coarse pointers", () => {
	assert.equal(useBottomSheet(390, false), true);
	assert.equal(useBottomSheet(720, false), true);
	assert.equal(useBottomSheet(721, false), false);
	assert.equal(useBottomSheet(768, false), false);
	assert.equal(useBottomSheet(768, true), true, "an iPad-width coarse pointer still gets the sheet");
	assert.equal(useBottomSheet(1440, true), true, "a coarse pointer on a big screen is still touch");
	assert.equal(useBottomSheet(1440, false), false);
	assert.equal(SHEET_MAX_WIDTH, 720);
});

test("fitBuilding scales the building to the phone width and keeps floors tappable", () => {
	const phone = fitBuilding(390, 844, 4);
	assert.ok(Math.abs(phone.scale - 390 / SCENE_W) < 1e-9, "the building fits the viewport width");
	assert.ok(phone.floorHeight >= 44, `floor height ${phone.floorHeight} is a large enough tap target`);
	assert.ok(Number.isFinite(phone.contentHeight) && phone.contentHeight > 0);
	assert.ok(phone.contentHeight >= phone.floorHeight * 4);
});

test("fitBuilding never shrinks a floor below 44 CSS px, whatever the width", () => {
	for (const width of [200, 280, 320, 360, 390, 414, 480, 540, 720]) {
		const f = fitBuilding(width, 844, 2);
		assert.ok(f.floorHeight >= 44, `${width}px: floor height ${f.floorHeight}`);
		assert.ok(Number.isFinite(f.scale) && f.scale > 0);
	}
});

test("fitBuilding keeps the desktop behavior unchanged at 720px and up", () => {
	// Today: scale = max(1, width / 720); the mobile path must not change it.
	for (const [width, height] of [[720, 900], [768, 1024], [1024, 768], [1440, 900], [2560, 1440]] as const) {
		const f = fitBuilding(width, height, 3);
		assert.ok(Math.abs(f.scale - Math.max(1, width / SCENE_W)) < 1e-9, `${width}px keeps the desktop scale`);
		assert.ok(f.floorHeight === FH * f.scale);
	}
});

test("fitBuilding grows the content height with the floors and the viewport", () => {
	const few = fitBuilding(390, 844, 2), many = fitBuilding(390, 844, 30);
	assert.ok(many.contentHeight > few.contentHeight, "thirty floors need more height than two");
	assert.ok(many.contentHeight >= 30 * 44, "every floor keeps its tap height in the content");
	const short = fitBuilding(390, 400, 4), tall = fitBuilding(390, 1200, 4);
	assert.ok(tall.contentHeight > short.contentHeight, "a taller viewport grows the sky");
	for (const f of [few, many, short, tall]) assert.ok(Number.isFinite(f.contentHeight) && f.contentHeight > 0);
});
