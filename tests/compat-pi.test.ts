import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	FallbackMouseRegion,
	FallbackVStack,
	fallbackColorToRgb,
	fallbackParseColor,
	MouseRegion,
	VStack,
	colorToRgb,
	parseColor,
} from "../lib/compat-pi-tui.ts";
import {
	fallbackGenerateUnifiedPatch,
	generateUnifiedPatch,
	createCodemodeExtension,
	getReadmePath,
} from "../lib/compat-pi-agent.ts";

test("FallbackMouseRegion renders child and delegates mouse event", () => {
	const child = {
		render(_width: number) {
			return ["line 1", "line 2"];
		},
		invalidate() {},
	};
	let handledEvent: unknown;
	const region = new FallbackMouseRegion(child, (event) => {
		handledEvent = event;
		return { handled: true };
	});

	assert.deepEqual(region.render(40), ["line 1", "line 2"]);
	const mockEvent = { x: 5, y: 10, type: "click" as const };
	const result = region.handleMouse(mockEvent as unknown as TuiMouseEvent);
	assert.deepEqual(result, { handled: true });
	assert.equal(handledEvent, mockEvent);
});

test("FallbackMouseRegion prefers child mouse handler when provided", () => {
	let childHandled = false;
	const child = {
		render: () => [],
		handleMouse: () => {
			childHandled = true;
			return { handled: true };
		},
		invalidate: () => {},
	};
	const region = new FallbackMouseRegion(child, () => {
		assert.fail("should not reach fallback when child handles event");
	});
	region.handleMouse({ x: 0, y: 0, type: "move" as const } as unknown as TuiMouseEvent);
	assert.equal(childHandled, true);
});

test("FallbackVStack renders children from entries", () => {
	const entryA = { render: () => ["entry a"], invalidate: () => {} };
	const entryB = { component: { render: () => ["entry b1", "entry b2"], invalidate: () => {} } };
	const vstack = new FallbackVStack([entryA, entryB]);

	assert.deepEqual(vstack.render(80), ["entry a", "entry b1", "entry b2"]);
});

test("fallbackColorToRgb handles objects and defaults", () => {
	assert.deepEqual(fallbackColorToRgb({ kind: "rgb", r: 10, g: 20, b: 30 }), { r: 10, g: 20, b: 30 });
	assert.deepEqual(fallbackColorToRgb({ r: 50, g: 60, b: 70 }), { r: 50, g: 60, b: 70 });
	assert.deepEqual(fallbackColorToRgb(null), { r: 128, g: 128, b: 128 });
	assert.deepEqual(fallbackColorToRgb("invalid"), { r: 128, g: 128, b: 128 });
});

test("fallbackParseColor parses 3-hex, 6-hex, and defaults", () => {
	assert.deepEqual(fallbackParseColor("#fff"), { kind: "rgb", r: 255, g: 255, b: 255 });
	assert.deepEqual(fallbackParseColor("#ff8800"), { kind: "rgb", r: 255, g: 136, b: 0 });
	assert.deepEqual(fallbackParseColor("not-a-color"), { kind: "rgb", r: 128, g: 128, b: 128 });
});

test("compat-pi-tui exports are functions or constructors", () => {
	assert.equal(typeof MouseRegion, "function");
	assert.equal(typeof VStack, "function");
	assert.equal(typeof colorToRgb, "function");
	assert.equal(typeof parseColor, "function");
});

test("fallbackGenerateUnifiedPatch returns empty string for identical content", () => {
	assert.equal(fallbackGenerateUnifiedPatch("test.txt", "same", "same"), "");
});

test("fallbackGenerateUnifiedPatch produces diff when content differs", () => {
	const patch = fallbackGenerateUnifiedPatch("test.txt", "before", "after");
	assert.ok(patch.includes("--- test.txt"));
	assert.ok(patch.includes("+++ test.txt"));
	assert.ok(patch.includes("-before"));
	assert.ok(patch.includes("+after"));
});

test("compat-pi-agent exports functions and fallbacks cleanly", () => {
	assert.equal(typeof generateUnifiedPatch, "function");
	assert.equal(typeof createCodemodeExtension, "function");
	assert.equal(typeof getReadmePath, "function");
	const ext = createCodemodeExtension();
	assert.equal(typeof ext, "function");
	assert.equal(typeof getReadmePath(), "string");
});
