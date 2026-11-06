import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Container, MouseRegion, type TuiMouseEvent, SelectList, Text } from "@earendil-works/pi-tui";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";

const items = [
	{ value: "first", label: "First option", description: "A description keeps the list layout realistic." },
	{ value: "second", label: "Second option", description: "A second description verifies the target row." },
];

const theme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

function mouse(
	type: TuiMouseEvent["type"],
	button: TuiMouseEvent["button"],
	y: number,
	height: number,
	wheelDelta?: number,
): TuiMouseEvent {
	return {
		type,
		button,
		x: 0,
		y,
		screenX: 0,
		screenY: y,
		width: 80,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta,
	};
}

test("native fullscreen interaction preserves observer order and native dispatch identity", () => {
	const order: string[] = [];
	const root = createNativeFullscreenInteraction({
		keyboardTarget: new Text("keyboard", 0, 0),
		requestRender() {},
		mouseObserver: { beforeMouse: () => order.push("before"), afterMouse: () => order.push("after") },
	});
	root.addChild(new Text("before child", 0, 0));
	root.addChild(new MouseRegion(new Text("native child", 0, 0), () => {
		order.push("native child");
		return { handled: true, focus: true };
	}));
	root.addChild(new Text("after child", 0, 0));
	const lines = root.render(80);
	const row = lines.findIndex((line) => line.includes("native child"));
	assert.ok(row >= 0);
	const nativeHandleMouse = Container.prototype.handleMouse;
	let nativeResult: ReturnType<typeof nativeHandleMouse>;
	const spy = mock.method(Container.prototype, "handleMouse", function (this: Container, event: TuiMouseEvent) {
		nativeResult = nativeHandleMouse.call(this, event);
		return nativeResult;
	});
	try {
		const result = root.handleMouse(mouse("press", "left", row, lines.length));
		assert.deepEqual(order, ["before", "native child", "after"]);
		assert.equal(result, nativeResult, "the observer returns the exact native Container result");
		assert.equal(result?.focusTarget, root, "native focus ownership remains with the root");
	} finally {
		spy.mock.restore();
	}
});

test("native fullscreen interaction preserves Container geometry and SelectList behavior", () => {
	const list = new SelectList(items, items.length, theme);
	const selected: string[] = [];
	let renders = 0;
	list.onSelect = (item) => selected.push(item.value);
	const root = createNativeFullscreenInteraction({
		keyboardTarget: list,
		requestRender: () => { renders++; },
	});
	root.addChild(new Text("A long header wraps before the SelectList and must not define hit rows.", 1, 0));
	root.addChild(list);

	assert.ok(root instanceof Container);
	assert.ok(root.render(20).length > items.length, "the narrow render includes a wrapped header");
	const lines = root.render(80);
	const secondRow = lines.findIndex((line) => line.includes("Second option"));
	assert.ok(secondRow >= 0, "the test locates the actual rendered SelectList row");

	const wheel = root.handleMouse(mouse("wheel", "none", secondRow, lines.length, 1));
	assert.equal(wheel?.handled, true);
	assert.equal(wheel?.render, true);
	assert.deepEqual(selected, [], "wheel never activates an option");
	assert.equal(
		root.handleMouse(mouse("wheel", "none", secondRow, lines.length, 1))?.render,
		false,
		"wheel clamps at the final item",
	);
	assert.equal(root.handleMouse(mouse("move", "none", secondRow, lines.length)), undefined);
	assert.equal(list.getSelectedItem()?.value, "second", "move does not change native selection");

	root.handleInput("\u001b[A");
	assert.equal(renders, 1, "keyboard input forwards to the native control and requests a render");
	assert.equal(list.getSelectedItem()?.value, "first", "keyboard selection remains independent of pointer movement");
	assert.deepEqual(selected, [], "keyboard navigation does not activate an option");

	const press = root.handleMouse(mouse("press", "left", secondRow, lines.length));
	assert.equal(press?.handled, true);
	assert.equal(press?.focus, true);
	assert.equal(press?.focusTarget, root, "the root remains the keyboard focus owner");
	assert.deepEqual(selected, [], "press never activates an option");
	assert.equal(root.handleMouse(mouse("release", "left", secondRow, lines.length)), undefined);
	assert.equal(root.handleMouse(mouse("click", "right", secondRow, lines.length)), undefined);
	assert.equal(root.handleMouse(mouse("click", "left", lines.length, lines.length)), undefined);

	root.handleInput("\r");
	assert.equal(renders, 2, "Enter renders after activating the focused native item");
	assert.deepEqual(selected, ["second"], "Enter activates the item selected by press");

	const click = root.handleMouse(mouse("click", "left", secondRow, lines.length));
	assert.equal(click?.handled, true);
	assert.deepEqual(selected, ["second", "second"]);
});
