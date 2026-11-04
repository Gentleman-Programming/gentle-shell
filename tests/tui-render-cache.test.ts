import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	applyTuiRenderCache,
	renderSourceIsPatchable,
	tuiRenderCacheState,
} from "../extensions/tui-render-cache.ts";

// Guards the runtime patch for upstream pi#7730: Container.render used to
// rebuild the full concatenated line array on every frame, so per-frame work
// scaled with transcript size. The patch reuses the aggregate while every
// child returns the same line-array instance.

function makeTextContainer(width = 40): { container: Container; children: Text[] } {
	const children = [new Text("alpha"), new Text("beta"), new Text("gamma")];
	const container = new Container();
	for (const child of children) container.addChild(child);
	void width;
	return { container, children };
}

test("unpatched Container.render rebuilds the aggregate every frame (the #7730 defect)", () => {
	const { container } = makeTextContainer();
	const first = container.render(40);
	const second = container.render(40);
	assert.notEqual(first, second, "control: two renders of an unchanged frame allocate distinct arrays");
});

test("applyTuiRenderCache patches the real pi-tui Container once", () => {
	const first = applyTuiRenderCache();
	assert.equal(first.applied, true, `guard rejected the installed pi-tui shape: ${first.reason ?? ""}`);
	const second = applyTuiRenderCache();
	assert.equal(second.applied, true);
	assert.equal(second.reason, "already-applied");
	assert.equal(tuiRenderCacheState()?.applied, true);
});

test("patched render returns the same aggregate for an unchanged frame", () => {
	const { container } = makeTextContainer();
	container.render(40);
	const warm = container.render(40);
	const again = container.render(40);
	assert.equal(warm, again, "unchanged frame must reuse the cached aggregate array");
});

test("patched render rebuilds when a cached child's content changes (setText path)", () => {
	const { container, children } = makeTextContainer();
	container.render(40);
	const before = container.render(40);
	children[1].setText("BETA!");
	const after = container.render(40);
	assert.notEqual(before, after);
	assert.match(after.join("\n"), /BETA!/);
	assert.doesNotMatch(after.join("\n"), /beta/);
});

test("patched render rebuilds when children are added or removed", () => {
	const { container, children } = makeTextContainer();
	container.render(40);
	const before = container.render(40);
	container.addChild(new Text("delta"));
	const grown = container.render(40);
	assert.notEqual(before, grown);
	assert.match(grown.join("\n"), /delta/);
	container.removeChild(children[0]);
	const shrunk = container.render(40);
	assert.doesNotMatch(shrunk.join("\n"), /alpha/);
});

test("patched render rebuilds when the width changes", () => {
	const { container } = makeTextContainer();
	container.render(40);
	const at40 = container.render(40);
	const at60 = container.render(60);
	assert.notEqual(at40, at60);
	assert.match(at60.join("\n"), /alpha/);
	assert.match(at60.join("\n"), /gamma/);
	// Single-slot child caches re-render after a width alternation, so identity
	// is only stable while the width stays the same — the aggregate must still
	// be correct either way.
	assert.notEqual(container.render(40), at40);
	assert.equal(container.render(40), container.render(40));
});

test("patched render keeps mouseLayout in sync with child heights", () => {
	const { container, children } = makeTextContainer();
	container.render(40);
	container.render(40);
	const layout = (container as unknown as { mouseLayout: { width: number; children: Array<{ height: number }> } }).mouseLayout;
	assert.equal(layout.width, 40);
	assert.deepEqual(layout.children.map((entry) => entry.height), children.map((child) => child.render(40).length));
});

test("patched render composes nested containers without stale output", () => {
	const inner = new Container();
	inner.addChild(new Text("one"));
	const outer = new Container();
	outer.addChild(inner);
	outer.addChild(new Text("two"));
	outer.render(40);
	assert.equal(outer.render(40), outer.render(40), "nested patched containers reuse their aggregates");
	inner.addChild(new Text("three"));
	const rebuilt = outer.render(40);
	assert.match(rebuilt.join("\n"), /three/);
});

test("guard rejects a render shape the patch cannot reason about", () => {
	assert.equal(renderSourceIsPatchable("render(width){const lines=[];for(const child of this.children){const childLines=child.render(width);lines.push(...childLines);}return lines;}"), false);
	assert.equal(renderSourceIsPatchable("render(width){const childLines=child.render(width);this.mouseLayout={width,children:[]};return childLines;}"), true);
});
