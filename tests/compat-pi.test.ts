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
	fallbackCreateCodemodeExtension,
	generateUnifiedPatch,
	createCodemodeExtension,
	getReadmePath,
} from "../lib/compat-pi-agent.ts";
import { createNanProviderConfig } from "../lib/nan-provider.ts";
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
test("FallbackMouseRegion falls back to onMouse when child reports handled: false", () => {
	let fallbackCalled = false;
	const child = {
		render: () => [],
		handleMouse: () => ({ handled: false }),
		invalidate: () => {},
	};
	const region = new FallbackMouseRegion(child, () => {
		fallbackCalled = true;
		return { handled: true };
	});
	const res = region.handleMouse({ x: 0, y: 0, type: "click" as const } as unknown as TuiMouseEvent);
	assert.equal(fallbackCalled, true);
	assert.deepEqual(res, { handled: true });
});

test("FallbackVStack continues past entries that return handled: false", () => {
	let entryBCalled = false;
	const entryA = {
		render: () => [],
		handleMouse: () => ({ handled: false }),
		invalidate: () => {},
	};
	const entryB = {
		render: () => [],
		handleMouse: () => {
			entryBCalled = true;
			return { handled: true };
		},
		invalidate: () => {},
	};
	const vstack = new FallbackVStack([entryA, entryB]);
	const res = vstack.handleMouse({ x: 0, y: 0, type: "click" as const } as unknown as TuiMouseEvent);
	assert.equal(entryBCalled, true);
	assert.deepEqual(res, { handled: true });
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
	assert.ok(patch.includes("@@ -1 +1 @@"));
	assert.ok(patch.includes("-before"));
	assert.ok(patch.includes("+after"));
});

test("fallbackGenerateUnifiedPatch handles multiline additions and removals", () => {
	const patch = fallbackGenerateUnifiedPatch("file.txt", "line 1\nline 2", "line 1\nline 2\nline 3");
	assert.ok(patch.includes("--- file.txt\n+++ file.txt"));
	assert.ok(patch.includes("@@ -1,2 +1,3 @@"));
	assert.ok(patch.includes("-line 1\n-line 2\n+line 1\n+line 2\n+line 3"));
});

test("fallbackGenerateUnifiedPatch handles empty old content (new file)", () => {
	const patch = fallbackGenerateUnifiedPatch("new.txt", "", "hello\nworld");
	assert.ok(patch.includes("--- new.txt\n+++ new.txt"));
	assert.ok(patch.includes("@@ -0,0 +1,2 @@"));
	assert.ok(patch.includes("+hello\n+world"));
});

test("fallbackGenerateUnifiedPatch handles empty new content (deleted file)", () => {
	const patch = fallbackGenerateUnifiedPatch("deleted.txt", "bye\nworld", "");
	assert.ok(patch.includes("--- deleted.txt\n+++ deleted.txt"));
	assert.ok(patch.includes("@@ -1,2 +0,0 @@"));
	assert.ok(patch.includes("-bye\n-world"));
});

test("fallbackCreateCodemodeExtension registers tool and throws on execute", () => {
	let registered: { name: string; execute: Function } | undefined;
	const pi = {
		registerTool: (tool: { name: string; execute: Function }) => {
			registered = tool;
		},
	};
	const ext = fallbackCreateCodemodeExtension();
	ext(pi as never);
	assert.ok(registered);
	assert.equal(registered.name, "codemode");
	assert.throws(() => registered!.execute(), /not supported/);
});

test("createNanProviderConfig builds valid provider configuration", () => {
	const config = createNanProviderConfig();
	assert.ok(config);
	assert.equal(config.id, "nan");
	assert.equal(config.name, "NaN");
});

test("compat-pi-agent exports functions and fallbacks cleanly", () => {
	assert.equal(typeof generateUnifiedPatch, "function");
	assert.equal(typeof createCodemodeExtension, "function");
	assert.equal(typeof getReadmePath, "function");
	assert.equal(typeof fallbackGenerateUnifiedPatch, "function");
	assert.equal(typeof fallbackCreateCodemodeExtension, "function");
	const ext = createCodemodeExtension();
	assert.equal(typeof ext, "function");
	assert.equal(typeof getReadmePath(), "string");
});
