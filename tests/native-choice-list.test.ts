import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
	KeybindingsManager, stripTerminalSequences, Text, TUI_KEYBINDINGS,
	type Component, type TuiMouseEvent, visibleWidth,
} from "@earendil-works/pi-tui";
import { NativeChoiceList } from "../lib/native-choice-list.ts";
import {
	NativePointerScope,
	type NativePointerRegionCallbacks,
} from "../lib/native-pointer-region.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";

const selectedForeground = "\u001b[38;5;39m";
const hoverBackground = "\u001b[48;5;236m";
const theme = {
	selectedPrefix: (text: string) => `${selectedForeground}${text}\u001b[39m`,
	selectedText: (text: string) => `${selectedForeground}${text}\u001b[39m`,
	description: (text: string) => `\u001b[38;5;244m${text}\u001b[39m`,
	hoverBackground: (text: string) => `${hoverBackground}${text}\u001b[49m`,
};

function event(
	type: TuiMouseEvent["type"], button: TuiMouseEvent["button"],
	y: number, width: number, height: number, wheelDelta?: number,
): TuiMouseEvent {
	return {
		type, button, x: 0, y, screenX: 0, screenY: y, width, height,
		shift: false, alt: false, ctrl: false, wheelDelta,
	};
}

function layout(
	list: NativeChoiceList<{ id: string; label: string; description: string }>, width: number, text: string,
) {
	const lines = list.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), "ANSI-stripped lines fit the current render width");
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes(text));
	assert.ok(row >= 0, "the current wrapped layout locates the requested row");
	return { lines, row };
}

test("native choice list presents one hovered wrapped option without changing selection", () => {
	const list = new NativeChoiceList([
		{
			id: "same", label: "Duplicate label",
			description: "A wrapped description that spans more than one display line at this width.",
		},
		{
			id: "other", label: "Duplicate label",
			description: "The second item has the same label but a distinct stable identity.",
		},
	], theme);
	const narrow = layout(list, 40, "second item");
	assert.equal(list.handleMouse(event("move", "none", narrow.row, 40, narrow.lines.length))?.render, true);
	const narrowHover = list.render(40);
	assert.ok(
		narrowHover.every((line, index) => index >= narrow.row - 1 || !line.includes(hoverBackground)),
		"only the hovered option rows have a background",
	);
	assert.ok(
		narrowHover.some((line) => line.includes(selectedForeground) && !line.includes(hoverBackground)),
		"keyboard selection has a distinct foreground",
	);
	assert.equal(list.handleMouse(event("move", "none", narrow.row, 40, narrow.lines.length))?.render, false);
	assert.equal(list.getSelectedItem()?.id, "same");

	const wider = layout(list, 56, "second item");
	assert.doesNotMatch(
		wider.lines.join("\n"),
		new RegExp(hoverBackground.replace(/[\[\]]/g, "\\$&")), "resize clears hover",
	);
	assert.equal(list.handleMouse(event("move", "none", wider.row, 56, wider.lines.length))?.render, true);
	const hovered = list.render(56);
	assert.ok(hovered.some((line) => line.includes(hoverBackground)), "real SGR background marks the second option");
	const firstRow = hovered.findIndex((line) => stripTerminalSequences(line).includes("Duplicate label"));
	assert.ok(firstRow >= 0);
	list.handleMouse(event("move", "none", firstRow, 56, hovered.length));
	const selectedHover = list.render(56)[firstRow];
	assert.ok(
		selectedHover?.includes(selectedForeground) && selectedHover.includes(hoverBackground),
		"selected and hovered styles combine",
	);
	list.invalidate();
	assert.doesNotMatch(list.render(56).join("\n"), new RegExp(hoverBackground.replace(/[\[\]]/g, "\\$&")));
});

test("native choice list refreshes existing item content without changing selection", () => {
	const items = [
		{ id: "first", label: "First", description: "Initial detail." },
		{ id: "second", label: "Second", description: "Second detail." },
	];
	const list = new NativeChoiceList(items, theme);
	list.setSelectedIndex(1);
	items[1]!.description = "Updated detail.";
	list.refreshItems();
	assert.equal(list.getSelectedItem()?.id, "second");
	assert.match(stripTerminalSequences(list.render(40).join("\n")), /Updated detail\./);
});

test("native choice list ignores Kitty key releases", () => {
	const list = new NativeChoiceList(
		[{ id: "first", label: "First" }, { id: "second", label: "Second" }],
		theme, new KeybindingsManager(TUI_KEYBINDINGS),
	);
	const selected: string[] = [];
	let cancelled = 0;
	list.onSelect = (item) => selected.push(item.id);
	list.onCancel = () => { cancelled++; };
	list.handleInput("\u001b[B");
	list.handleInput("\r");
	assert.deepEqual(selected, ["second"], "legacy arrow and Enter use semantic bindings");
	list.setSelectedIndex(0);
	selected.length = 0;
	list.handleInput("\u001b[1;1:3B");
	assert.equal(list.getSelectedItem()?.id, "first", "Kitty arrow release does not navigate");
	list.handleInput("\u001b[1;1:1B");
	assert.equal(list.getSelectedItem()?.id, "second", "Kitty arrow press navigates");
	list.setSelectedIndex(0);
	list.handleInput("\u001b[1;1:2B");
	assert.equal(list.getSelectedItem()?.id, "second", "Kitty arrow repeat still navigates");
	list.handleInput("\u001b[13;1:3u");
	list.handleInput("\u001b[27;1:3u");
	assert.deepEqual([selected, cancelled], [[], 0], "Kitty confirm and cancel releases do not activate callbacks");
	list.handleInput("\u001b[13;1:1u");
	list.handleInput("\u001b[27;1:1u");
	assert.deepEqual([selected, cancelled], [["second"], 1], "Kitty confirm and cancel presses still activate");
});

test("root observer clears hover and disabled controls ignore every input", () => {
	const list = new NativeChoiceList([
		{ id: "first", label: "First choice", description: "First detail." },
		{ id: "second", label: "Second choice", description: "Second detail." },
	], theme);
	let renders = 0;
	let selected = 0;
	let cancelled = 0;
	list.onSelect = () => { selected++; };
	list.onCancel = () => { cancelled++; };
	const root = createNativeFullscreenInteraction({
		keyboardTarget: list, requestRender: () => { renders++; },
		mouseObserver: list.createMouseObserver(() => { renders++; }),
	});
	root.addChild(new Text("Header", 0, 0));
	root.addChild(list);
	root.addChild(new Text("Footer", 0, 0));
	const lines = root.render(48);
	const firstRow = lines.findIndex((line) => stripTerminalSequences(line).includes("First"));
	const secondRow = lines.findIndex((line) => stripTerminalSequences(line).includes("Second"));
	assert.ok(firstRow >= 0 && secondRow >= 0);
	root.handleMouse(event("move", "none", secondRow, 48, lines.length));
	assert.match(root.render(48).join("\n"), new RegExp(hoverBackground.replace(/[\[\]]/g, "\\$&")));
	root.handleMouse(event("move", "none", 0, 48, lines.length));
	assert.doesNotMatch(root.render(48).join("\n"), new RegExp(hoverBackground.replace(/[\[\]]/g, "\\$&")));
	assert.equal(renders, 1);
	root.handleMouse(event("move", "none", 0, 48, lines.length));
	assert.equal(renders, 1);
	list.handleMouse(event("move", "none", secondRow, 48, lines.length));
	list.setDisabled(true);
	assert.doesNotMatch(
		root.render(48).join("\n"),
		new RegExp(hoverBackground.replace(/[\[\]]/g, "\\$&")), "disabling clears hover",
	);
	const before = list.getSelectedItem()?.id;
	for (const [type, button, delta] of [
		["move", "none"], ["press", "left"],
		["click", "left"], ["wheel", "none", 1],
	] as const) {
		assert.equal(
			root.handleMouse(event(type, button, firstRow, 48, lines.length, delta)), undefined,
		);
	}
	for (const input of ["\r", "\u001b"]) list.handleInput(input);
	assert.deepEqual(
		[list.getSelectedItem()?.id, selected, cancelled], [before, 0, 0],
		"disabled mouse and keyboard events cannot mutate or activate",
	);
});

test("empty native choice lists do not activate phantom selections", () => {
	const list = new NativeChoiceList([], theme);
	let selected = 0;
	let cancelled = 0;
	list.onSelect = () => { selected++; };
	list.onCancel = () => { cancelled++; };
	list.handleInput("\r");
	list.handleInput("\u001b");
	assert.equal(selected, 0);
	assert.equal(cancelled, 1);
});

test("native choice list composes rows through the shared pointer scope", () => {
	const originalWrap = NativePointerScope.prototype.wrap;
	let wraps = 0;
	const spy = mock.method(NativePointerScope.prototype, "wrap", function (
		this: NativePointerScope, child: Component, callbacks: NativePointerRegionCallbacks,
	) {
		wraps++;
		return originalWrap.call(this, child, callbacks);
	});
	try {
		const list = new NativeChoiceList([
			{ id: "first", label: "First" },
			{ id: "second", label: "Second" },
		], theme);
		const lines = list.render(40);
		assert.equal(wraps, 2, "each choice row uses the composable shared pointer primitive");
		const second = lines.findIndex((line) => line.includes("Second"));
		assert.ok(second >= 0);
		assert.equal(list.handleMouse(event("move", "none", second, 40, lines.length))?.render, true);
		assert.equal(list.getSelectedItem()?.id, "first", "hover remains distinct from keyboard selection");
	} finally {
		spy.mock.restore();
	}
});
