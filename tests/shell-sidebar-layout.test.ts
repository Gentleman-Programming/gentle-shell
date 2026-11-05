import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, Container, ScrollView, VStack, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { getScrollViewsAt, renderLayoutFrame, type LayoutBox } from "@earendil-works/pi-tui/dist/layout.js";
import { installSidebar, invalidateSidebar, narrowStatusOwner } from "../lib/shell-sidebar-layout.ts";
import { setSidebarHover, sidebarHeader, sidebarPart, sidebarState, sidebarStatusBar } from "../lib/shell-sidebar.ts";
import { renderShellSidebarBar, renderShellStatusBar } from "../lib/shell-bar.ts";
import { chromeSurface, setChromeSurface } from "../lib/shell-panel.ts";
import { renderTodoCard, type TodoState } from "../lib/shell-todo.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function fixture(mode = "fullscreen", columns = 140) {
	const original = () => ({ type: "vstack", entries: [] });
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: original };
	let renders = 0;
	const host = { mode, terminal: { columns }, layoutRoot: root, requestRender() { renders++; } };
	const tui = host as unknown as TUI;
	const bottom = sidebarPart(tui, "footer", { render: (_width: number) => ["Status"], invalidate() {} });
	return { host, tui, root, original, bottom, renders: () => renders };
}
function rail(f: ReturnType<typeof fixture>): ScrollView {
	const node = f.root[NODE]() as unknown as { type: string; entries: { component: ScrollView }[] };
	assert.equal(node.type, "hstack");
	return node.entries[1].component;
}
type HstackNode = { type: string; gap: number; align: string; entries: { component: unknown; basis: number | string; grow: number; shrink: number; minSize: number }[] };
// Finds the [left, scroll] hstack regardless of whether it is returned
// directly (no active header) or nested one level under the header vstack.
function hstackOf(f: ReturnType<typeof fixture>): HstackNode {
	const node = f.root[NODE]() as unknown as { type: string; entries: { component: { [NODE]?(): HstackNode } }[] };
	if (node.type === "hstack") return node as unknown as HstackNode;
	assert.equal(node.type, "vstack");
	const nested = node.entries[1]?.component[NODE]?.();
	assert.ok(nested, "the vstack's second entry must expose the hstack via NODE");
	return nested!;
}
function railWithHeader(f: ReturnType<typeof fixture>): ScrollView {
	return hstackOf(f).entries[1].component as ScrollView;
}

test("the rail Status keeps its section order and opaque integration text in both card styles", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const painted = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		setCardStyle(style);
		const lines = renderShellSidebarBar({
			cwd: "/project", branch: "main", dirty: 2, sessionName: "session",
			modelId: "model", effort: "high", contextPercent: 45, contextWindow: 1000,
			costTotal: 1, subscription: false, usage: undefined, statuses: ["opaque integration"],
		}, painted, 46);
		const text = lines.join("\n");
		assert.ok(text.indexOf("CHANGES") >= 0 && text.indexOf("CHANGES") < text.indexOf("INTEGRATIONS"), `${style}: Changes before Integrations`);
		assert.match(text, /opaque integration/);
		assert.doesNotMatch(text, /Branch|Usage/);
	}
});

test("scrollable TODO keeps every task while bottom and collapsed cards stay bounded", () => {
	const state: TodoState = { tasks: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `Task-${i + 1}!`, status: "pending" })), nextId: 21, updatedTurn: 0 };
	const todoTheme = { ...theme, strikethrough: (text: string) => text };
	const render = (scrollable: boolean, collapsed = false) => renderTodoCard(state, todoTheme, 46, { scrollable, collapsed, staleTurns: 0 }).join("\n");
	for (const task of state.tasks) assert.ok(render(true).includes(task.title));
	assert.ok(!render(false).includes("Task-20!"));
	assert.ok(!render(true, true).includes("Task-20!"));
});

test("installation on a missing-terminal host is a harmless no-op", () => {
	const dispose = installSidebar({} as TUI, theme);
	assert.doesNotThrow(dispose);
});

test("root hover fallback preserves the original mouse result and restores ownership", () => {
	const f = fixture("fullscreen", 80);
	const root = f.root as typeof f.root & { handleMouse?: (event: TuiMouseEvent) => { handled: boolean } | undefined };
	let calls = 0;
	const result = { handled: true };
	const original = (event: TuiMouseEvent) => { calls++; return event.type === "click" ? result : undefined; };
	root.handleMouse = original;
	const dispose = installSidebar(f.tui, theme);
	const event: TuiMouseEvent = { type: "move", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 24, shift: false, alt: false, ctrl: false };
	let clears = 0;
	setSidebarHover(f.tui, {}, () => { clears++; });
	assert.equal(root.handleMouse!(event), undefined);
	assert.equal(clears, 1);
	setSidebarHover(f.tui, {}, () => { clears++; });
	assert.equal(root.handleMouse!({ ...event, type: "click", button: "left" }), result);
	assert.equal(clears, 1, "non-move events retain ownership");
	assert.equal(calls, 2);
	dispose();
	assert.equal(root.handleMouse, original);
	assert.equal(clears, 2, "dispose clears remaining shell hover");
});

test("root hover fallback never re-renders the transcript for wheel or move events", () => {
	// pi-tui skips layout roots that keep Container.prototype.handleMouse: its
	// fallback measures every child by rendering it, O(transcript) per event.
	const f = fixture("fullscreen", 140);
	let childRenders = 0;
	const root = new Container() as Container & { [NODE]: () => unknown };
	root.addChild({ render: () => { childRenders++; return ["message"]; }, invalidate() {} });
	root[NODE] = f.original;
	(f.host as { layoutRoot: unknown }).layoutRoot = root;
	const dispose = installSidebar(f.tui, theme);
	assert.notEqual(root.handleMouse, Container.prototype.handleMouse, "the hover fallback is installed");
	const base: TuiMouseEvent = { type: "wheel", button: "none", wheelDelta: -1, x: 1, y: 0, screenX: 1, screenY: 0, width: 80, height: 24, shift: false, alt: false, ctrl: false };
	let clears = 0;
	setSidebarHover(f.tui, {}, () => { clears++; });
	assert.equal(root.handleMouse(base), undefined);
	assert.equal(root.handleMouse({ ...base, type: "move" }), undefined);
	assert.equal(clears, 1, "move still clears shell hover");
	assert.equal(childRenders, 0, "mouse events must not render transcript children");
	dispose();
	assert.equal(root.handleMouse, Container.prototype.handleMouse);
});

test("only fullscreen at 140 columns activates; shrinking restores bottom paint", (t) => {
	for (const [mode, width, active] of [["regular", 140, false], ["fullscreen", 139, false], ["fullscreen", 140, true]] as const) {
		const f = fixture(mode, width);
		t.after(installSidebar(f.tui, theme));
		assert.equal(f.root[NODE]().type, active ? "hstack" : "vstack");
		assert.deepEqual(f.bottom.render(80), active ? [] : ["Status"]);
		f.host.terminal.columns = 139;
		assert.equal(f.root[NODE]().type, "vstack");
		assert.deepEqual(f.bottom.render(80), ["Status"]);
	}
});

test("bottom paint follows placement and resize before the next layout pass", (t) => {
	const f = fixture("fullscreen", 140);
	let placement: "auto" | "right" | "bottom" | "hidden" = "auto";
	t.after(installSidebar(f.tui, theme, () => placement));
	assert.equal(f.root[NODE]().type, "hstack");
	assert.deepEqual(f.bottom.render(80), []);

	// A preference notification can request paint before the host measures its root.
	placement = "bottom";
	assert.deepEqual(f.bottom.render(80), ["Status"]);
	assert.equal(f.root[NODE]().type, "vstack");
	placement = "right";
	assert.equal(f.root[NODE]().type, "hstack");
	f.host.terminal.columns = 139;
	assert.deepEqual(f.bottom.render(80), ["Status"]);
	assert.equal(f.root[NODE]().type, "vstack");
	placement = "hidden";
	f.host.terminal.columns = 180;
	assert.deepEqual(f.bottom.render(80), []);
	assert.equal(f.root[NODE]().type, "vstack");
	placement = "auto";
	assert.equal(f.root[NODE]().type, "hstack");
	assert.deepEqual(f.bottom.render(80), []);
});

test("hidden status suppresses bottom paint and placement resizes responsively", (t) => {
	const f = fixture("fullscreen", 140);
	let placement: "auto" | "right" | "bottom" | "hidden" = "auto";
	t.after(installSidebar(f.tui, theme, () => placement));
	assert.equal(f.root[NODE]().type, "hstack");
	placement = "hidden";
	assert.equal(f.root[NODE]().type, "vstack");
	assert.deepEqual(f.bottom.render(80), []);
	placement = "right";
	assert.equal(f.root[NODE]().type, "hstack");
	f.host.terminal.columns = 139;
	assert.equal(f.root[NODE]().type, "vstack");
	placement = "bottom";
	f.host.terminal.columns = 180;
	assert.equal(f.root[NODE]().type, "vstack");
});

test("narrow status owner prefers a configured top header, otherwise the bottom bar, and leaves wide/regular untouched", () => {
	for (const statusPlacement of ["auto", "right", "bottom", "hidden"] as const) {
		for (const columns of [40, 100, 139]) {
			assert.equal(narrowStatusOwner({ mode: "fullscreen", columns, statusPlacement, headerPlacement: "top" }), "header", `${columns}/${statusPlacement}/top`);
			assert.equal(narrowStatusOwner({ mode: "fullscreen", columns, statusPlacement, headerPlacement: "below-input" }), statusPlacement === "hidden" ? "header" : "bottom", `${columns}/${statusPlacement}/below-input`);
		}
		for (const headerPlacement of ["top", "below-input"] as const) {
			assert.equal(narrowStatusOwner({ mode: "fullscreen", columns: 140, statusPlacement, headerPlacement }), undefined, "wide keeps its layout");
			assert.equal(narrowStatusOwner({ mode: "regular", columns: 60, statusPlacement, headerPlacement }), undefined, "regular mode has no top header");
		}
	}
});

test("narrow top header owns Status only while it actually paints, and resize restores the bottom bar before the next layout pass", (t) => {
	const f = fixture("fullscreen", 100);
	let label = "HEADER";
	sidebarHeader(f.tui, { render: () => [label], invalidate() {} });
	let headerPlacement: "top" | "below-input" = "top";
	t.after(installSidebar(f.tui, theme, () => "bottom", () => headerPlacement));
	f.root[NODE]();
	assert.deepEqual(f.bottom.render(100), [], "top header alone at narrow width");
	headerPlacement = "below-input";
	assert.deepEqual(f.bottom.render(100), ["Status"], "below-input leaves the bottom bar as the only status row");
	headerPlacement = "top";
	f.host.terminal.columns = 180;
	assert.deepEqual(f.bottom.render(180), ["Status"], "wide bottom placement keeps both bars");
	f.host.terminal.columns = 100;
	label = "";
	f.root[NODE]();
	assert.deepEqual(f.bottom.render(100), ["Status"], "a blank header never swallows the bottom bar");
});

test("regular mode keeps the bottom bar even with a top header configured", (t) => {
	const f = fixture("regular", 80);
	sidebarHeader(f.tui, { render: () => ["HEADER"], invalidate() {} });
	t.after(installSidebar(f.tui, theme, () => "auto", () => "top"));
	f.root[NODE]();
	assert.deepEqual(f.bottom.render(80), ["Status"]);
});

test("top header remains above native layout at narrow widths and wide bottom/hidden without a rail", (t) => {
	for (const width of [100, 60, 180]) {
		for (const placement of width === 180 ? ["bottom", "hidden"] as const : ["auto"] as const) {
			const f = fixture("fullscreen", width);
			sidebarHeader(f.tui, { render: (available: number) => [`HEADER ${available}`, `RULE ${available}`], invalidate() {} });
			const dispose = installSidebar(f.tui, theme, () => placement);
			t.after(dispose);
			const node = f.root[NODE]() as unknown as { type: string; entries: { component: Component & { [NODE]?(): unknown } }[] };
			assert.equal(node.type, "vstack", `${width}/${placement} keeps the top header`);
			assert.deepEqual(node.entries[0]?.component.render(width), [`HEADER ${width}`, `RULE ${width}`]);
			assert.deepEqual(node.entries[1]?.component[NODE]?.(), f.original(), "native layout remains underneath");
			assert.deepEqual(f.bottom.render(width), placement === "bottom" ? ["Status"] : [], "wide bottom keeps Status; narrow top header and hidden paint no bottom bar");
			assert.equal(sidebarState(f.tui).active, false);
		}
	}
});

test("below-input header never duplicates into the top row, even when the rail is inactive", (t) => {
	for (const [width, placement] of [[60, "auto"], [100, "auto"], [180, "bottom"], [180, "hidden"]] as const) {
		const f = fixture("fullscreen", width);
		sidebarHeader(f.tui, { render: () => ["HEADER"], invalidate() {} });
		t.after(installSidebar(f.tui, theme, () => placement, () => "below-input"));
		assert.deepEqual(f.root[NODE](), f.original());
		assert.deepEqual(f.bottom.render(width), placement === "hidden" ? [] : ["Status"]);
	}
});

test("hidden status suppresses bottom paint in regular, narrow and wide fullscreen while other placements paint", (t) => {
	for (const [mode, width] of [["regular", 180], ["regular", 60], ["fullscreen", 60], ["fullscreen", 100], ["fullscreen", 180]] as const) {
		const f = fixture(mode, width);
		let placement: "auto" | "right" | "bottom" | "hidden" = "hidden";
		t.after(installSidebar(f.tui, theme, () => placement));
		f.root[NODE]();
		assert.deepEqual(f.bottom.render(width), [], `${mode}/${width} hidden paints no bottom Status`);
		assert.equal(sidebarState(f.tui).active, false);
		for (const other of ["auto", "right", "bottom"] as const) {
			placement = other;
			f.root[NODE]();
			const railOwns = mode === "fullscreen" && width >= 140 && other !== "bottom";
			assert.deepEqual(f.bottom.render(width), railOwns ? [] : ["Status"], `${mode}/${width}/${other}`);
		}
		placement = "hidden";
		assert.deepEqual(f.bottom.render(width), [], "switching back to hidden applies before the next layout pass");
	}
});

test("hidden status leaves other bottom parts painting and restores Status on cleanup", () => {
	const f = fixture("regular", 100);
	const todo = sidebarPart(f.tui, "todo", { render: (_width: number) => ["todo"], invalidate() {} });
	const dispose = installSidebar(f.tui, theme, () => "hidden");
	assert.deepEqual(f.bottom.render(100), []);
	assert.deepEqual(todo.render(100), ["todo"]);
	dispose();
	assert.deepEqual(f.bottom.render(100), ["Status"]);
});

// A native-shaped dock: the footer is the last dock entry with a reserved row.
function dockedFooterFixture(width: number) {
	const transcript = { render: () => Array.from({ length: 50 }, (_, index) => `Entry ${index}`), invalidate() {} };
	const primary = new ScrollView(transcript, { primary: true, follow: "end" });
	const host = { mode: "fullscreen", terminal: { columns: width }, layoutRoot: undefined as unknown, requestRender() {} };
	const tui = host as unknown as TUI;
	const footer = sidebarPart(tui, "footer", { render: () => ["Status"], invalidate() {} });
	const editor = { render: () => [`Editor${CURSOR_MARKER}`], invalidate() {} };
	const dock = new VStack([{ component: editor }, { component: footer, minSize: 1 }]);
	const root = new VStack([{ component: primary, basis: 0, grow: 1, shrink: 1, minSize: 1 }, { component: dock }]);
	host.layoutRoot = root;
	return { host, tui, root, frame: () => renderLayoutFrame(root, host.terminal.columns, 12, () => {}).lines };
}

test("hidden status reclaims the reserved footer row in narrow and wide fullscreen", (t) => {
	for (const width of [60, 100, 180]) {
		for (const withHeader of [false, true]) {
			const f = dockedFooterFixture(width);
			if (withHeader) sidebarHeader(f.tui, { render: (available: number) => [`HEADER ${available}`], invalidate() {} });
			let placement: "auto" | "bottom" | "hidden" = "hidden";
			t.after(installSidebar(f.tui, theme, () => placement));
			let lines = f.frame();
			assert.match(lines[lines.length - 1] ?? "", /Editor/, `${width}/${withHeader} hidden leaves no blank footer row`);
			assert.doesNotMatch(lines.join("\n"), /Status/);
			placement = "bottom";
			lines = f.frame();
			if (withHeader && width < 140) {
				// The narrow top header owns Status, so its reserved row is reclaimed too.
				assert.match(lines[lines.length - 1] ?? "", /Editor/, `${width} narrow top header leaves no blank footer row`);
				assert.doesNotMatch(lines.join("\n"), /Status/);
			} else {
				assert.match(lines[lines.length - 1] ?? "", /Status/, `${width}/${withHeader} bottom still paints its footer row`);
			}
		}
	}
});

test("below-input header removes only the rail's top row", (t) => {
	const f = fixture();
	let header: "split" | "below-input" = "split";
	sidebarHeader(f.tui, { render: () => ["header"], invalidate() {} });
	t.after(installSidebar(f.tui, theme, () => "auto", () => header));
	assert.equal(f.root[NODE]().type, "vstack");
	header = "below-input";
	assert.equal(f.root[NODE]().type, "hstack");
	assert.deepEqual(f.bottom.render(80), []);
	header = "split";
	assert.equal(f.root[NODE]().type, "vstack");
});

test("TODO visibility hides both rail and bottom without mutating the registered part", (t) => {
	const f = fixture();
	const todo = sidebarPart(f.tui, "todo", { render: (_width: number) => ["todo"], invalidate() {} });
	t.after(installSidebar(f.tui, theme));
	assert.match(rail(f).render(50).join("\n"), /todo/);
	sidebarState(f.tui).visibility = { todo: false };
	invalidateSidebar(f.tui);
	assert.doesNotMatch(rail(f).render(50).join("\n"), /todo/);
	f.host.terminal.columns = 100;
	assert.equal(f.root[NODE]().type, "vstack");
	assert.deepEqual(todo.render(100), []);
	sidebarState(f.tui).visibility = { todo: true };
	assert.deepEqual(todo.render(100), ["todo"]);
});

test("rail orders live work first, then Status, without standalone changes", (t) => {
	const f = fixture();
	for (const key of ["todo", "agents", "changes"]) {
		sidebarPart(f.tui, key, { render: () => [key, ""], invalidate() {} });
	}
	t.after(installSidebar(f.tui, theme));
	assert.deepEqual(rail(f).render(50).map((line) => line.trim()), ["✿ Gentle Shell ✿", "", "todo", "", "agents", "", "Status"]);
});

test("branding belongs to scroll content before Status, never transcript or narrow bottom", (t) => {
	const f = fixture();
	t.after(installSidebar(f.tui, theme));
	const scroll = rail(f);
	const lines = scroll.render(50);
	const brandIndex = lines.findIndex((line) => line.includes("✿ Gentle Shell ✿"));
	assert.ok(brandIndex >= 0 && brandIndex < lines.findIndex((line) => line.includes("Status")));
	assert.doesNotMatch(lines.join("\n"), /[\u2800-\u28ff]/);
	const heading = lines[brandIndex];
	const usableWidth = scroll.getContentWidth(50) - 2;
	const spare = usableWidth - visibleWidth("✿ Gentle Shell ✿");
	const scrollbarWidth = 50 - scroll.getContentWidth(50);
	assert.equal(heading, " ".repeat(1 + Math.floor(spare / 2)) + "✿ Gentle Shell ✿" + " ".repeat(1 + Math.ceil(spare / 2) + scrollbarWidth));
	assert.deepEqual(f.root.render(), ["transcript"]);
	scroll.updateLayout(lines.length, 2, () => {});
	scroll.scrollBy(9);
	assert.ok(scroll.scrollTop > 0);
	f.host.terminal.columns = 80;
	assert.equal(f.root[NODE]().type, "vstack");
	assert.deepEqual(f.bottom.render(80), ["Status"]);
});

test("wheel scrolls the rail and is consumed at both boundaries and blank space", (t) => {
	const f = fixture();
	t.after(installSidebar(f.tui, theme));
	const scroll = rail(f);
	scroll.updateLayout(20, 5, () => {});
	for (const [delta, expected] of [[-1, 0], [3, 3], [100, 15], [1, 15], [-100, 0]]) {
		const result = scroll.handleMouse({ type: "wheel", wheelDelta: delta, x: 3, y: 4, screenX: 93, screenY: 6, width: 50, height: 5 } as Parameters<typeof scroll.handleMouse>[0]);
		assert.equal(result?.handled, true);
		assert.equal(scroll.scrollTop, expected);
		assert.equal(result?.target?.component, scroll);
	}
	f.host.terminal.columns = 139;
	assert.equal(f.root[NODE]().type, "vstack");
	assert.deepEqual(f.bottom.render(80), ["Status"]);
	f.host.terminal.columns = 160;
	const restored = rail(f);
	assert.deepEqual(f.bottom.render(80), []);
	const layout = f.root[NODE]() as unknown as { gap: number; entries: { basis: number | string; grow: number; shrink: number; minSize: number }[] };
	assert.equal(layout.gap, 3);
	assert.deepEqual(layout.entries.map(({ basis, grow, shrink, minSize }) => ({ basis, grow, shrink, minSize })), [
		{ basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ basis: 50, grow: 0, shrink: 0, minSize: 50 },
	]);
	const restoredLines = restored.render(50);
	// Native ScrollView.render only appends the scrollbar gutter; short rows need not fill the layout allocation.
	for (const line of restoredLines) assert.ok(visibleWidth(line) <= 50);
	assert.ok(restoredLines.some((line) => line.startsWith(" Status ")));
	assert.deepEqual(f.root.render(), ["transcript"]);
	restored.updateLayout(20, 5, () => {});
	const before = restored.scrollTop;
	const result = restored.handleMouse({ type: "wheel", wheelDelta: 2, x: 3, y: 4, screenX: 113, screenY: 6, width: 50, height: 5 } as Parameters<typeof restored.handleMouse>[0]);
	assert.equal(result?.handled, true);
	assert.equal(result?.target?.component, restored);
	assert.equal(restored.scrollTop, Math.min(15, before + 2));
	for (const line of restored.render(50)) assert.ok(visibleWidth(line) <= 50);
	assert.deepEqual(f.root.render(), ["transcript"]);
	scroll.updateLayout(1, 5, () => {});
	assert.equal(scroll.handleMouse({ type: "wheel", wheelDelta: 1 } as Parameters<typeof scroll.handleMouse>[0])?.handled, true);
	assert.equal(scroll.scrollTop, 0);
});

test("wheel over a bounded Todo viewport scrolls the section before the surrounding rail", (t) => {
	const f = fixture();
	const received: TuiMouseEvent[] = [];
	let consumes = true;
	sidebarPart(f.tui, "todo", {
		render: () => ["Todo viewport", "Todo body"], invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			received.push(event);
			return consumes && event.type === "wheel" ? { handled: true, render: true } : undefined;
		},
	});
	t.after(installSidebar(f.tui, theme));
	const scroll = rail(f);
	const content = scroll.render(50);
	scroll.updateLayout(content.length + 20, content.length, () => {});
	const y = content.findIndex((line) => line.includes("Todo body"));
	const event: TuiMouseEvent = { type: "wheel", button: "none", wheelDelta: 2, x: 3, y, screenX: 93, screenY: y, width: 50, height: content.length, shift: false, alt: false, ctrl: false };
	assert.equal(scroll.handleMouse(event)?.handled, true);
	assert.equal(scroll.scrollTop, 0, "inner viewport consumes wheel without moving the rail");
	assert.equal(received.at(-1)?.y, 1, "section coordinates are local");
	consumes = false;
	assert.equal(scroll.handleMouse(event)?.handled, true);
	assert.equal(scroll.scrollTop, 2, "unbounded/collapsed sections fall back to rail scrolling");
});

test("rail dispatches a clipped, scroll-translated left click to only the matching sidebar part", (t) => {
	const f = fixture();
	let clicks = 0;
	const received: TuiMouseEvent[] = [];
	const todo = {
		render: () => ["Todo header", "Todo body"],
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			received.push(event);
			if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
			clicks++;
			return { handled: true, render: true };
		},
	};
	sidebarPart(f.tui, "todo", todo);
	const dispose = installSidebar(f.tui, theme);
	t.after(dispose);
	const scroll = rail(f);
	const content = scroll.render(50);
	scroll.updateLayout(content.length, 5, () => {});
	scroll.scrollBy(1);
	const headerY = content.findIndex((line) => line.includes("Todo header")) - scroll.scrollTop;
	assert.ok(headerY >= 0);
	const mouse = (type: TuiMouseEvent["type"], button: TuiMouseEvent["button"], y: number): TuiMouseEvent => ({
		type, button, x: 2, y, screenX: 92, screenY: 30 + y, width: 50, height: 5, shift: false, alt: false, ctrl: false,
	});

	assert.equal(scroll.handleMouse(mouse("press", "left", headerY)), undefined);
	assert.equal(scroll.handleMouse(mouse("click", "right", headerY)), undefined);
	assert.equal(scroll.handleMouse(mouse("click", "left", headerY + 1)), undefined);
	assert.equal(clicks, 0);
	const hit = scroll.handleMouse(mouse("click", "left", headerY));
	assert.equal(hit?.handled, true);
	assert.equal(clicks, 1);
		// With a transient scrollbar the rail no longer reserves a column, so
	// clipped parts are one column wider than in the always-on geometry.
	assert.deepEqual(received.at(-1) && { x: received.at(-1)!.x, y: received.at(-1)!.y, width: received.at(-1)!.width, height: received.at(-1)!.height }, { x: 1, y: 0, width: 48, height: 2 });

	const gapY = headerY - 1;
	assert.equal(scroll.handleMouse(mouse("click", "left", gapY)), undefined, "section gaps do not hit a neighbor");
	assert.equal(scroll.handleMouse({ ...mouse("click", "left", headerY), x: 49 }), undefined, "padding outside the clipped part is inert");
	invalidateSidebar(f.tui);
	assert.equal(scroll.handleMouse(mouse("click", "left", headerY)), undefined, "stale geometry is inert");
	f.host.terminal.columns = 139;
	assert.equal(scroll.handleMouse(mouse("click", "left", headerY)), undefined, "resized-away rails are inert");
	dispose();
	assert.equal(scroll.handleMouse(mouse("click", "left", headerY)), undefined, "disposed rails are inert");
});

test("rail rejects removed or replaced parts before cached geometry is prepared again", (t) => {
	const f = fixture();
	let originalClicks = 0;
	let replacementClicks = 0;
	const original = {
		render: () => ["Todo header"],
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			originalClicks++;
			return { handled: true };
		},
	};
	const mounted = sidebarPart(f.tui, "todo", { render: () => ["Todo bottom"], invalidate() {}, dispose() {} }, original);
	const dispose = installSidebar(f.tui, theme);
	t.after(dispose);
	const scroll = rail(f);
	const content = scroll.render(50);
	scroll.updateLayout(content.length, 5, () => {});
	const headerY = content.findIndex((line) => line.includes("Todo header"));
	const click = (): TuiMouseEvent => ({ type: "click", button: "left", x: 2, y: headerY, screenX: 92, screenY: 30 + headerY, width: 50, height: 5, shift: false, alt: false, ctrl: false });
	assert.equal(scroll.handleMouse(click())?.handled, true, "healthy cached geometry still dispatches");
	assert.equal(originalClicks, 1);

	mounted.dispose();
	assert.equal(scroll.handleMouse(click()), undefined, "removed parts are inert before the next prepare");
	assert.equal(originalClicks, 1);

	const replacement = {
		render: () => ["Todo replacement"],
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			replacementClicks++;
			return { handled: true };
		},
	};
	sidebarPart(f.tui, "todo", { render: () => ["Todo bottom"], invalidate() {} }, replacement);
	assert.equal(scroll.handleMouse(click()), undefined, "a replacement cannot receive stale cached geometry");
	assert.equal(originalClicks, 1);
	assert.equal(replacementClicks, 0);

	rail(f);
	assert.equal(scroll.handleMouse(click())?.handled, true, "prepared replacement dispatches normally");
	assert.equal(replacementClicks, 1);
});

test("real layout frames reuse unchanged sidebar output and invalidate at state and breakpoint boundaries", (t) => {
	const f = fixture();
	const counts = { footer: 0, changes: 0, agents: 0, todo: 0 };
	let todo = "Todo one";
	for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
		sidebarPart(f.tui, key, {
			render: () => {
				counts[key]++;
				return [`${key === "todo" ? todo : key}`];
			},
			invalidate() {},
		});
	}
	t.after(installSidebar(f.tui, theme));

	const first = renderLayoutFrame(f.root, 140, 20, () => {});
	assert.deepEqual(counts, { footer: 1, changes: 0, agents: 1, todo: 1 });
	const sidebarRail = first.root.children[1]?.component as ScrollView;
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.deepEqual(counts, { footer: 1, changes: 0, agents: 1, todo: 1 });

	todo = "Todo two";
	sidebarRail.invalidate();
	const changed = renderLayoutFrame(f.root, 140, 20, () => {});
	assert.match(changed.lines.join("\n"), /Todo two/);
	assert.deepEqual(counts, { footer: 2, changes: 0, agents: 2, todo: 2 });

	f.host.terminal.columns = 139;
	renderLayoutFrame(f.root, 139, 20, () => {});
	assert.deepEqual(f.bottom.render(80), ["Status"]);
	f.host.terminal.columns = 140;
	renderLayoutFrame(f.root, 140, 20, () => {});
	// Dipping below the breakpoint and back nulls the whole-rail `prepared`
	// memo, but the per-section cache survives underneath it: the revision
	// never moved, so no section actually needed to re-render.
	assert.deepEqual(counts, { footer: 2, changes: 0, agents: 2, todo: 2 });

	f.host.mode = "regular";
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.deepEqual(f.bottom.render(80), ["Status"]);
	f.host.mode = "fullscreen";
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.deepEqual(counts, { footer: 2, changes: 0, agents: 2, todo: 2 });

	let replacementRenders = 0;
	sidebarPart(f.tui, "todo", {
		render: () => {
			replacementRenders++;
			return ["Todo replacement"];
		},
		invalidate() {},
	});
	const replaced = renderLayoutFrame(f.root, 140, 20, () => {});
	assert.match(replaced.lines.join("\n"), /Todo replacement/);
	assert.equal(replacementRenders, 1);
});

test("a rail digest refreshes live state that no invalidation announces", (t) => {
	const f = fixture();
	let model = "model-a";
	let renders = 0;
	// The digest is the only signal: no part is re-registered and invalidateSidebar
	// is never called here, which is exactly the /model case in fullscreen.
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} }, {
		digest: () => model,
		render: () => {
			renders++;
			return [`Model ${model}`];
		},
		invalidate() {},
	});
	t.after(installSidebar(f.tui, theme));

	assert.match(renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n"), /Model model-a/);
	assert.equal(renders, 1);
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.equal(renders, 1, "an unchanged digest still reuses the prepared rail");

	model = "model-b";
	assert.match(renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n"), /Model model-b/);
	assert.equal(renders, 2);

	// Rail digests run inside the layout frame, so a broken one must not disable
	// the sidebar for the parts that still work.
	let todoRenders = 0;
	sidebarPart(f.tui, "todo", { render: () => ["Todo bottom"], invalidate() {} }, {
		digest: () => { throw new Error("broken digest"); },
		render: () => {
			todoRenders++;
			return ["Todo card"];
		},
		invalidate() {},
	});
	model = "model-c";
	assert.match(renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n"), /Model model-c/);
	assert.equal(todoRenders, 1);
	assert.match(renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n"), /Todo card/);
	assert.equal(todoRenders, 1, "a throwing digest degrades to invalidation-only");
	invalidateSidebar(f.tui);
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.equal(todoRenders, 2, "explicit invalidation still reaches a rail without a digest");
});

test("the rail paints Todos, Jobs and Agents before Status", (t) => {
	const f = fixture();
	sidebarPart(f.tui, "jobs", { render: () => ["jobs"], invalidate() {} }, { digest: () => "jobs", render: () => ["Jobs card"], invalidate() {} });
	sidebarPart(f.tui, "agents", { render: () => ["agents"], invalidate() {} }, { digest: () => "agents", render: () => ["Agents card"], invalidate() {} });
	sidebarPart(f.tui, "todo", { render: () => ["todo"], invalidate() {} }, { digest: () => "todo", render: () => ["Todo card"], invalidate() {} });
	t.after(installSidebar(f.tui, theme));
	const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	const footer = text.indexOf("Status");
	const jobs = text.indexOf("Jobs card");
	const agents = text.indexOf("Agents card");
	const todo = text.indexOf("Todo card");
	for (const [name, index] of [["Status", footer], ["Jobs card", jobs], ["Agents card", agents], ["Todo card", todo]] as const) {
		assert.ok(index >= 0, `${name} paints in the rail`);
	}
	assert.ok(todo < jobs && jobs < agents && agents < footer, `sections paint in order, got: ${text}`);
});

test("panel sections paint on the rail surface, joined by a tinted gap, while card sections stay unpainted", (t) => {
	const f = fixture();
	const roleCode: Record<string, number> = { customMessageBg: 236 };
	const painting = { ...theme, bg: (color: string, text: string) => `\x1b[48;5;${roleCode[color] ?? 1}m${text}\x1b[49m` };
	const open = "\x1b[48;5;236m";
	sidebarPart(f.tui, "jobs", { render: () => ["jobs"], invalidate() {} }, { surface: "panel", digest: () => "jobs", render: (width: number) => ["JOBS".padEnd(width)], invalidate() {} });
	sidebarPart(f.tui, "todo", { render: () => ["todo"], invalidate() {} }, { surface: "panel", digest: () => "todo", render: (width: number) => ["TODOS".padEnd(width)], invalidate() {} });
	t.after(installSidebar(f.tui, painting));
	const lines = rail(f).render(50);
	const status = lines.find((line) => line.includes("Status"))!;
	const jobs = lines.findIndex((line) => line.includes("JOBS"));
	const todo = lines.findIndex((line) => line.includes("TODOS"));
	assert.ok(!status.includes(open), "the Status card keeps its own chrome");
	assert.ok(lines[jobs]!.startsWith(`${open} JOBS`), `panel row is painted including its padding: ${JSON.stringify(lines[jobs])}`);
	assert.equal(jobs, todo + 2, "one gap row separates two panel sections");
	assert.match(lines[todo + 1]!, /^\x1b\[48;5;236m +\x1b\[49m$/, "the gap between two panel sections is tinted too");
	assert.ok(lines[todo]!.startsWith(`${open} TODOS`));
});

test("a theme switch repaints rail sections whose digest did not change", (t) => {
	const f = fixture();
	// Pi hands extensions a live theme proxy and announces a switch only through
	// ui.invalidate(), which never reaches the rail inside the layout tree.
	let code = 31;
	const live = { fg: (_color: string, text: string) => `\x1b[${code}m${text}\x1b[39m`, bold: (text: string) => text };
	for (const key of ["footer", "agents", "todo"]) {
		sidebarPart(f.tui, key, { render: () => [key], invalidate() {} }, {
			digest: () => "stable",
			render: () => [live.fg("accent", `${key} card`)],
			invalidate() {},
		});
	}
	t.after(installSidebar(f.tui, live));

	const before = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	for (const key of ["footer", "agents", "todo"]) assert.ok(before.includes(`\x1b[31m${key} card`), `${key} paints with the first theme`);

	code = 32;
	const after = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	for (const key of ["footer", "agents", "todo"]) {
		assert.ok(after.includes(`\x1b[32m${key} card`), `${key} repaints with the new theme`);
		assert.ok(!after.includes(`\x1b[31m${key} card`), `${key} drops the old theme`);
	}
});

test("structural cache misses skip the whole-rail digest pass", (t) => {
	const f = fixture();
	let digests = 0;
	sidebarPart(f.tui, "todo", { render: () => ["Todo"], invalidate() {} }, {
		digest: () => { digests++; return "stable"; },
		render: () => [`Todo ${digests}`],
		invalidate() {},
	});
	t.after(installSidebar(f.tui, theme));

	// Every frame evaluates the digest exactly once: the whole-rail comparison
	// reuses it for the section cache instead of calling each digest twice per
	// prepare (issue #1681).
	renderLayoutFrame(f.root, 140, 20, () => {});
	const prepared = digests;
	assert.equal(prepared, 1, "preparing the rail evaluates the digest once");
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.equal(digests, prepared + 1, "a cache hit compares the digest once");
	renderLayoutFrame(f.root, 141, 20, () => {});
	assert.equal(digests, prepared + 2, "a structural miss re-prepares with a single digest pass");
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.equal(digests, prepared + 3, "returning to the cached structure stays on a single digest pass");
});

test("reuses final sidebar presentation until a relevant invalidation", (t) => {
	const f = fixture();
	sidebarPart(f.tui, "todo", { render: () => Array.from({ length: 10 }, (_, index) => `Todo ${index}`), invalidate() {} });
	t.after(installSidebar(f.tui, theme));

	const first = f.root[NODE]();
	assert.equal(f.root[NODE](), first);
	const scroll = (first as { entries: { component: ScrollView }[] }).entries[1].component;
	scroll.updateLayout(scroll.render(50).length, 1, () => {});
	scroll.scrollBy(1);
	const scrolled = f.root[NODE]();
	assert.notEqual(scrolled, first);
	assert.equal(f.root[NODE](), scrolled);

	scroll.invalidate();
	const invalidated = f.root[NODE]();
	assert.notEqual(invalidated, scrolled);
	assert.equal(f.root[NODE](), invalidated);

	f.host.terminal.columns = 141;
	const resized = f.root[NODE]();
	assert.notEqual(resized, invalidated);
	assert.equal(f.root[NODE](), resized);
	f.host.mode = "regular";
	assert.equal(f.root[NODE]().type, "vstack");
	assert.deepEqual(f.bottom.render(80), ["Status"]);
});

test("cleanup restores the native layout and bottom paint without disposing widgets", () => {
	const f = fixture();
	const dispose = installSidebar(f.tui, theme);
	rail(f);
	dispose();
	assert.equal(f.root[NODE], f.original);
	assert.deepEqual(f.bottom.render(80), ["Status"]);
	assert.equal(sidebarState(f.tui).parts.size, 1);
	assert.ok(f.renders() >= 2);
});

test("unsupported roots, empty rails and overflowing parts leave native layout intact", (t) => {
	for (const lines of [[], ["x".repeat(100)]]) {
		const f = fixture();
		sidebarPart(f.tui, "footer", { render: () => lines, invalidate() {} });
		t.after(installSidebar(f.tui, theme));
		assert.equal(f.root[NODE]().type, "vstack");
		assert.equal(sidebarState(f.tui).active, false);
	}
	const f = fixture();
	Reflect.deleteProperty(f.root, NODE);
	t.after(installSidebar(f.tui, theme));
	assert.deepEqual(f.bottom.render(80), ["Status"]);
});

// A real native subtree exposes duplicate rendering hidden by empty-layout fixtures.
function nativeSidebarFixture(legacyMeasurement = false) {
	let transcriptRenders = 0;
	let editorRows = 1;
	const transcript = {
		render(width: number) {
			transcriptRenders++;
			return Array.from({ length: 1000 }, (_, index) => `\x1b[32mEntry ${index} 界 é at ${width}\x1b[0m`);
		},
		invalidate() {},
	};
	const primary = new ScrollView(transcript, { primary: true, follow: "end", scrollbar: "always" });
	const editor = { render: () => Array.from({ length: editorRows }, (_, index) => `Editor ${index}${index === editorRows - 1 ? CURSOR_MARKER : ""}`), invalidate() {} };
	const root = new VStack([{ component: primary, basis: 0, grow: 1 }, { component: editor }]);
	const originalRender = root.render;
	const host = { mode: "fullscreen", terminal: { columns: 180 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	sidebarPart(tui, "footer", { render: () => Array.from({ length: 100 }, (_, i) => `Status ${i}`), invalidate() {} });
	const dispose = installSidebar(tui, theme);
	const nativeRoot = root as unknown as { [NODE](): { entries: Array<{ component: { render(width: number): string[] } }> } };
	if (legacyMeasurement) nativeRoot[NODE]().entries[0].component.render = (width) => root.render(width);
	return {
		root, primary, host, dispose, originalRender,
		growEditor: () => { editorRows = 4; },
		frame(width = host.terminal.columns, height = 30) {
			host.terminal.columns = width;
			transcriptRenders = 0;
			const frame = renderLayoutFrame(root, width, height, () => {});
			return { frame, transcriptRenders };
		},
	};
}

function layoutGeometry(box: LayoutBox): unknown {
	return { rect: box.rect, clip: box.clip, lineOffset: box.lineOffset, scroll: !!box.scrollView, children: box.children.map(layoutGeometry) };
}

test("fullscreen native transcript renders once without changing bytes, geometry or primary scroll", (t) => {
	const current = nativeSidebarFixture();
	const legacy = nativeSidebarFixture(true);
	t.after(current.dispose);
	t.after(legacy.dispose);
	for (const grow of [false, true]) {
		if (grow) { current.growEditor(); legacy.growEditor(); }
		for (const [width, height] of [[180, 30], [140, 18], [220, 50]]) {
			const actual = current.frame(width, height);
			const expected = legacy.frame(width, height);
			assert.equal(actual.transcriptRenders, 1, "measurement must not render the native transcript");
			assert.equal(expected.transcriptRenders, 2, "legacy control must reproduce the redundant render");
			assert.deepEqual(actual.frame.lines, expected.frame.lines);
			assert.deepEqual(layoutGeometry(actual.frame.root), layoutGeometry(expected.frame.root));
			assert.equal(actual.frame.primaryScrollView, current.primary);
			assert.equal(current.root.render, current.originalRender, "native root rendering is not patched");
			assert.ok(actual.frame.lines.some(line => line.includes(CURSOR_MARKER)), "editor cursor remains visible");
		}
	}
});

test("native fullscreen header survives narrow and bottom transitions without replacing transcript scroll", (t) => {
	const f = nativeSidebarFixture();
	let placement: "right" | "bottom" | "hidden" = "right";
	let headerPlacement: "split" | "below-input" = "split";
	// Reinstall with live preferences so the transition uses the same native root.
	f.dispose();
	sidebarHeader(f.host as unknown as TUI, { render: (width: number) => [`HEADER ${width}`], invalidate() {} });
	const dispose = installSidebar(f.host as unknown as TUI, theme, () => placement, () => headerPlacement);
	t.after(dispose);
	for (const [width, status] of [[100, "right"], [60, "right"], [180, "bottom"], [180, "hidden"], [180, "right"]] as const) {
		placement = status;
		const { frame, transcriptRenders } = f.frame(width);
		assert.equal(transcriptRenders, 1, "native transcript paints only once");
		assert.equal(frame.primaryScrollView, f.primary);
		assert.match(frame.lines[0] ?? "", new RegExp(`HEADER ${width}`));
		assert.ok(frame.lines.some((line) => line.includes("Editor")), "native editor survives");
		assert.equal(frame.root.children.some((box) => box.component instanceof ScrollView && box.component !== f.primary), false, "no extra root scroll view");
	}
	headerPlacement = "below-input";
	placement = "bottom";
	const below = f.frame(100).frame;
	assert.doesNotMatch(below.lines.join("\n"), /HEADER/, "below-input owns its own widget, never the top row");
	assert.equal(below.primaryScrollView, f.primary);
});

test("native transcript and sidebar keep separate scroll routing across resize, breakpoint and mode transitions", (t) => {
	const fixture = nativeSidebarFixture();
	t.after(fixture.dispose);
	let result = fixture.frame();
	const rail = result.frame.root.children[1].component as ScrollView;
	assert.equal(getScrollViewsAt(result.frame, 1, 1)[0], fixture.primary);
	assert.equal(getScrollViewsAt(result.frame, 179, 1)[0], rail);
	const transcriptTop = fixture.primary.scrollTop;
	rail.scrollBy(5);
	result = fixture.frame();
	assert.equal(fixture.primary.scrollTop, transcriptTop);
	assert.equal(rail.scrollTop, 5);
	fixture.primary.scrollBy(-7);
	result = fixture.frame();
	assert.equal(fixture.primary.scrollTop, transcriptTop - 7);
	assert.equal(rail.scrollTop, 5);
	assert.equal(result.transcriptRenders, 1);
	for (const [mode, width] of [["fullscreen", 139], ["fullscreen", 140], ["regular", 180], ["fullscreen", 180]] as const) {
		fixture.host.mode = mode;
		result = fixture.frame(width);
		assert.equal(result.transcriptRenders, 1);
		assert.equal(result.frame.primaryScrollView, fixture.primary);
		assert.equal(result.frame.root.children.some(box => box.component === rail), mode === "fullscreen" && width >= 140);
	}
});

// T3: per-section render memo. Each rail section caches its rendered lines by
// its own digest, so a section whose digest did not change is never re-run
// when a sibling section's digest ticks — only the whole rail's assembled
// `lines`/`hits` are rebuilt from the (possibly cached) per-section lines.

test("a footer digest change does not re-render Agents or TODO", (t) => {
	const f = fixture();
	let footerLabel = "one";
	const counts = { footer: 0, agents: 0, todo: 0 };
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} }, {
		digest: () => footerLabel,
		render: () => { counts.footer++; return [`Footer ${footerLabel}`]; },
		invalidate() {},
	});
	for (const key of ["agents", "todo"] as const) {
		sidebarPart(f.tui, key, { render: () => [key], invalidate() {} }, {
			render: () => { counts[key]++; return [key]; },
			invalidate() {},
		});
	}
	t.after(installSidebar(f.tui, theme));

	assert.match(rail(f).render(50).join("\n"), /Footer one/);
	assert.deepEqual(counts, { footer: 1, agents: 1, todo: 1 });

	// Re-render with nothing changed at all: the outer unchanged fast path
	// must not call any section's render either.
	assert.match(rail(f).render(50).join("\n"), /Footer one/);
	assert.deepEqual(counts, { footer: 1, agents: 1, todo: 1 });

	footerLabel = "two";
	assert.match(rail(f).render(50).join("\n"), /Footer two/);
	assert.deepEqual(counts, { footer: 2, agents: 1, todo: 1 }, "only the section whose digest changed re-renders");

	// invalidateSidebar bumps the global revision, which is only what a
	// no-digest section keys its cache on: footer's own unchanged digest
	// still protects it from re-rendering.
	invalidateSidebar(f.tui);
	assert.match(rail(f).render(50).join("\n"), /Footer two/);
	assert.deepEqual(counts, { footer: 2, agents: 2, todo: 2 }, "revision invalidation reaches only the sections with no digest of their own");
});

test("a card style change re-renders sections whose digest is unchanged", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(CARD_STYLE.FLOAT);
	const f = fixture();
	let renders = 0;
	sidebarPart(f.tui, "todo", { render: () => ["todo"], invalidate() {} }, {
		digest: () => "unchanged",
		render: () => { renders++; return [`Todos ${cardStyle()}`]; },
		invalidate() {},
	});
	t.after(installSidebar(f.tui, theme));

	assert.match(rail(f).render(50).join("\n"), /Todos float/);
	assert.equal(renders, 1);

	setCardStyle(CARD_STYLE.NEON);
	const output = rail(f).render(50).join("\n");
	assert.match(output, /Todos neon/, "the cached float lines must not survive a switch to neon");
	assert.doesNotMatch(output, /Todos float/);
	assert.equal(renders, 2);

	assert.match(rail(f).render(50).join("\n"), /Todos neon/);
	assert.equal(renders, 2, "an unchanged style keeps the section cache");
});

test("a throwing digest still degrades to invalidation-only under the per-section memo", (t) => {
	const f = fixture();
	let todoRenders = 0;
	sidebarPart(f.tui, "todo", { render: () => ["Todo"], invalidate() {} }, {
		digest: () => { throw new Error("broken digest"); },
		render: () => { todoRenders++; return ["Todo card"]; },
		invalidate() {},
	});
	t.after(installSidebar(f.tui, theme));

	assert.match(rail(f).render(50).join("\n"), /Todo card/);
	assert.equal(todoRenders, 1);
	assert.match(rail(f).render(50).join("\n"), /Todo card/);
	assert.equal(todoRenders, 1, "an unchanged frame reuses the cached section even without a digest");

	invalidateSidebar(f.tui);
	assert.match(rail(f).render(50).join("\n"), /Todo card/);
	assert.equal(todoRenders, 2, "explicit invalidation still reaches a rail without a digest");
});

test("a part replaced under the same key never reuses the previous part's cached lines", (t) => {
	const f = fixture();
	let firstRenders = 0;
	sidebarPart(f.tui, "todo", { render: () => ["Todo"], invalidate() {} }, {
		render: () => { firstRenders++; return ["first"]; },
		invalidate() {},
	});
	t.after(installSidebar(f.tui, theme));
	assert.match(rail(f).render(50).join("\n"), /first/);
	assert.equal(firstRenders, 1);

	let secondRenders = 0;
	sidebarPart(f.tui, "todo", { render: () => ["Todo"], invalidate() {} }, {
		render: () => { secondRenders++; return ["second"]; },
		invalidate() {},
	});
	const text = rail(f).render(50).join("\n");
	assert.match(text, /second/);
	assert.doesNotMatch(text, /first/);
	assert.equal(secondRenders, 1);
});

// T2: the live header row. A registered "header" part wraps the existing
// [left, scroll] hstack in a one-row-taller vstack and takes over the brand
// the banner used to carry inside the rail. Hosts that never register a
// header (every fixture above) keep the exact old hstack-direct shape.

test("an active header wraps the hstack in a vstack and removes the banner from the rail", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(CARD_STYLE.NEON);
	const f = fixture();
	sidebarHeader(f.tui, { render: (width: number) => [`HEADER ${width}`], invalidate() {} });
	t.after(installSidebar(f.tui, theme));

	const node = f.root[NODE]() as unknown as HstackNode;
	assert.equal(node.type, "vstack");
	assert.equal(node.gap, 0);
	assert.equal(node.align, "stretch");
	// basis "auto": pi-tui measures the header leaf from its rendered lines
	// (one line: the status bar; with the rule row: two) instead of hard-pinning the row.
	assert.deepEqual(node.entries.map(({ basis, grow, shrink, minSize }) => ({ basis, grow, shrink, minSize })), [
		{ basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		{ basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	const header = node.entries[0].component as { render(width: number): string[] };
	// The rail card ends two columns before the terminal edge (its padding plus
	// the scrollbar column); the header stops there too so its right group
	// lines up with the card border instead of touching the edge.
	assert.deepEqual(header.render(0), ["HEADER 140"], "the header renders at the full terminal width, not the rail width");

	const hstack = hstackOf(f);
	assert.equal(hstack.type, "hstack");
	const scroll = railWithHeader(f);
	const rail = scroll.render(50);
	assert.doesNotMatch(rail.join("\n"), /✿ Gentle Shell ✿/, "the header carries the brand now, not the banner");
	// A split title block carries its own margin row across the rail, so the
	// rail opens with its first card right under it.
	assert.notEqual(rail[0]?.trim(), "", "the first card starts on the rail's first row");
});

test("the top header has a rail-local inset without moving the conversation or losing hits", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(CARD_STYLE.FLOAT);
	const painted = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	for (const placement of ["split", "below-input"] as const) {
		const f = fixture();
		const received: TuiMouseEvent[] = [];
		const status = renderShellSidebarBar({
			cwd: "/project", branch: "main", dirty: 0, sessionName: undefined,
			modelId: "model", effort: "high", contextPercent: 45, contextWindow: 1000,
			costTotal: 1, subscription: false, usage: undefined, statuses: ["one", "two", "three", "four", "five"],
		}, painted, 48);
		sidebarPart(f.tui, "footer", {
			surface: "panel",
			render: () => status,
			invalidate() {},
			handleMouse(event) { received.push(event); return { handled: true }; },
		});
		sidebarHeader(f.tui, { render: () => ["HEADER", "RULE"], invalidate() {} });
		const transcript = { render: () => ["CONVERSATION"], invalidate() {} };
		f.root[NODE] = () => ({ type: "vstack", entries: [{ component: transcript }] });
		t.after(installSidebar(f.tui, painted, () => "auto", () => placement));
		const frame = renderLayoutFrame(f.root, 140, 8, () => {});
		const bodyY = placement === "split" ? 2 : 0;
		assert.match(frame.lines[bodyY], /CONVERSATION/);
		// The split title block's margin row spans the rail, so the rail adds no inset.
		const inset = 0;
		assert.doesNotMatch(frame.lines.slice(0, bodyY).join("\n"), /\x1b\[48;5;22m/);
		assert.match(frame.lines[bodyY], /\x1b\[48;5;22m/, "the panel surface reaches the header");
		assert.match(frame.lines[bodyY + inset], /\x1b\[48;5;22m/);
		for (const line of frame.lines.slice(bodyY)) assert.equal(visibleWidth(line), 140);
		const scroll = railWithHeader(f);
		const content = scroll.render(50);
		assert.deepEqual(content, [...(inset ? [`\x1b[48;5;22m${" ".repeat(scroll.getContentWidth(50))}\x1b[49m`] : []), ...status.map((line) => `\x1b[48;5;22m ${line} \x1b[49m`)]);
		const height = 8 - bodyY;
		const click = (y: number): TuiMouseEvent => ({ type: "click", button: "left", x: 2, y, screenX: 92, screenY: bodyY + y, width: 50, height, shift: false, alt: false, ctrl: false });
		if (inset) assert.equal(scroll.handleMouse(click(0)), undefined, "inset is not a hit target");
		assert.equal(scroll.handleMouse(click(inset))?.handled, true);
		assert.equal(received.at(-1)?.y, 0, "first section row keeps its local hit offset");
		assert.equal(scroll.handleMouse(click(inset + 1))?.handled, true);
		assert.equal(received.at(-1)?.y, 1);
		scroll.scrollBy(1000);
		assert.equal(scroll.scrollTop, status.length + inset - height, "scroll bounds include the inset exactly once");
		assert.equal(scroll.handleMouse(click(height - 1))?.handled, true);
		assert.equal(received.at(-1)?.y, status.length - 1, "last clipped viewport row hits the last card row");
		const count = received.length;
		assert.equal(scroll.handleMouse(click(height)), undefined, "outside the viewport is inert");
		assert.equal(received.length, count);
	}
});

test("float rail alignment preserves fallback banners and neon bytes across live style switches", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	for (const header of [undefined, "", "HEADER"]) {
		setCardStyle(CARD_STYLE.NEON);
		const f = fixture();
		if (header !== undefined) sidebarHeader(f.tui, { render: () => [header], invalidate() {} });
		sidebarPart(f.tui, "todo", { render: () => ["TODO"], invalidate() {} });
		t.after(installSidebar(f.tui, theme));
		const baseline = railWithHeader(f).render(50);
		if (header) assert.deepEqual(baseline, [" TODO ", "", " Status "], "the split title block carries the top margin");
		else assert.match(baseline.join("\n"), /✿ Gentle Shell ✿/);
		setCardStyle(CARD_STYLE.FLOAT);
		assert.deepEqual(railWithHeader(f).render(50), baseline, "the active split header keeps the same rail in both styles");
		setCardStyle(CARD_STYLE.NEON);
		assert.deepEqual(railWithHeader(f).render(50), baseline, "neon is byte-identical after switching back");
	}
});

test("the header leaf carries the rule row: a two-line header renders both lines at full width", (t) => {
	const f = fixture();
	sidebarHeader(f.tui, {
		render: (width: number) => [`HEADER ${width}`, `RULE ${width}`],
		invalidate() {},
	});
	t.after(installSidebar(f.tui, theme));

	const node = f.root[NODE]() as unknown as { type: string; entries: { component: Component }[] };
	assert.equal(node.type, "vstack", "a two-line header still wraps the hstack in a vstack");
	const header = node.entries[0]!.component as { render(width: number): string[] };
	assert.deepEqual(header.render(0), ["HEADER 140", "RULE 140"], "both the status line and the rule row reach the layout, rendered at the terminal width minus the rail's right inset");
});

test("below the sidebar breakpoint a rule-like header paints above native layout without a rail", (t) => {
	const f = fixture("fullscreen", 139);
	sidebarHeader(f.tui, { render: (width: number) => [`HEADER ${width}`, `RULE ${width}`], invalidate() {} });
	t.after(installSidebar(f.tui, theme));

	const node = f.root[NODE]() as unknown as { type: string; entries: { component: Component }[] };
	assert.equal(node.type, "vstack");
	assert.deepEqual(node.entries[0]?.component.render(139), ["HEADER 139", "RULE 139"]);
	assert.deepEqual(f.bottom.render(139), [], "the narrow top header is the only status row");
});

test("without a registered header the rail keeps the banner and the plain hstack", (t) => {
	const f = fixture();
	t.after(installSidebar(f.tui, theme));
	const node = f.root[NODE]() as unknown as { type: string };
	assert.equal(node.type, "hstack");
	const scroll = rail(f);
	assert.match(scroll.render(50).join("\n"), /✿ Gentle Shell ✿/);
});

test("a header too narrow to show anything falls back to the plain hstack and the banner", (t) => {
	const f = fixture();
	sidebarHeader(f.tui, { render: () => [""], invalidate() {} });
	t.after(installSidebar(f.tui, theme));
	const node = f.root[NODE]() as unknown as { type: string };
	assert.equal(node.type, "hstack", "a blank header line does not earn its own row");
	const scroll = rail(f);
	assert.match(scroll.render(50).join("\n"), /✿ Gentle Shell ✿/);
});

test("header content changes reach the header row while an unrelated part is untouched", (t) => {
	const f = fixture();
	let label = "one";
	sidebarHeader(f.tui, { digest: () => label, render: () => [`HEADER ${label}`], invalidate() {} });
	t.after(installSidebar(f.tui, theme));

	const headerLines = () => (f.root[NODE]() as unknown as HstackNode).entries[0].component as { render(width: number): string[] };
	assert.deepEqual(headerLines().render(0), ["HEADER one"]);
	label = "two";
	assert.deepEqual(headerLines().render(0), ["HEADER two"]);
});

test("rail mouse dispatch still maps clicks correctly with the header row above it", (t) => {
	const f = fixture();
	let clicks = 0;
	const todo = {
		render: () => ["Todo header", "Todo body"],
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
			clicks++;
			return { handled: true, render: true };
		},
	};
	sidebarPart(f.tui, "todo", todo);
	sidebarHeader(f.tui, { render: () => ["HEADER"], invalidate() {} });
	const dispose = installSidebar(f.tui, theme);
	t.after(dispose);
	const scroll = railWithHeader(f);
	const content = scroll.render(50);
	scroll.updateLayout(content.length, 5, () => {});
	const headerY = content.findIndex((line) => line.includes("Todo header"));
	assert.ok(headerY >= 0);
	// The mouse event carries coordinates local to the scroll component itself
	// (pi-tui's layout tree translates screen coordinates before dispatch), so
	// nesting the hstack one level deeper under the header row does not shift
	// what the rail receives.
	const hit = scroll.handleMouse({ type: "click", button: "left", x: 2, y: headerY, screenX: 92, screenY: 31 + headerY, width: 50, height: 5, shift: false, alt: false, ctrl: false });
	assert.equal(hit?.handled, true);
	assert.equal(clicks, 1);
});

// T8(c): the header row is a leaf in the layout tree, not inside the rail's
// ScrollView, so pi-tui's mouse dispatch (tui-alt-screen.js) finds and calls
// its own handleMouse directly — it never goes through dispatchPartMouse.
test("the header component's handleMouse delegates to the registered header part", (t) => {
	const f = fixture();
	const received: TuiMouseEvent[] = [];
	let result: { handled: boolean; render?: boolean } | undefined = { handled: true, render: true };
	sidebarHeader(f.tui, {
		render: () => ["HEADER"],
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			received.push(event);
			return result;
		},
	});
	t.after(installSidebar(f.tui, theme));

	const node = f.root[NODE]() as unknown as { type: string; entries: { component: Component }[] };
	assert.equal(node.type, "vstack", "an active header wraps the hstack in a vstack");
	const header = node.entries[0]!.component as { handleMouse(event: TuiMouseEvent): { handled: boolean; render?: boolean } | undefined };

	const event = { type: "click", button: "left", x: 5, y: 0, screenX: 5, screenY: 0, width: 140, height: 1, shift: false, alt: false, ctrl: false } as TuiMouseEvent;
	assert.deepEqual(header.handleMouse(event), { handled: true, render: true });
	assert.equal(received.length, 1);
	assert.equal(received[0], event, "the event reaches the registered part unmodified");

	result = undefined;
	assert.equal(header.handleMouse(event), undefined, "an ignored click returns undefined, same as any other component");
});

test("the header component's handleMouse is a harmless no-op when no header part is registered", (t) => {
	const f = fixture();
	t.after(installSidebar(f.tui, theme));
	const node = f.root[NODE]() as unknown as { type: string; entries?: { component: Component }[] };
	// No header registered: the active node stays the plain hstack (T2's
	// backward-compatible fallback), so there is no header leaf to click at all.
	assert.equal(node.type, "hstack");
});

test("rail scrollbar is transient: hidden by default, visible only while scrolling overflow", (t) => {
	const f = fixture();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	t.after(installSidebar(f.tui, theme));
	const scroll = rail(f);
	// Regression guard: the rail scroll view used to hardcode scrollbar
	// "always", re-slicing its column on every render pass even when idle.
	assert.equal(scroll.scrollbar, "auto");
	sidebarPart(f.tui, "todo", { render: () => Array.from({ length: 60 }, (_, i) => `todo row ${i}`), invalidate() {} });
	renderLayoutFrame(f.root, 140, 20, () => {});
	assert.equal(scroll.isScrollbarVisible, false, "no scroll yet: hidden even with overflow");
	scroll.scrollBy(1);
	assert.equal(scroll.isScrollbarVisible, true, "rail scroll reveals the transient scrollbar");
	t.mock.timers.tick(1000);
	assert.equal(scroll.isScrollbarVisible, false, "hidden again after the transient window");
});

test("rail scrollbar stays hidden when the rail does not overflow", (t) => {
	const f = fixture();
	t.after(installSidebar(f.tui, theme));
	const scroll = rail(f);
	renderLayoutFrame(f.root, 140, 20, () => {});
	scroll.scrollBy(1);
	assert.equal(scroll.isScrollbarVisible, false);
});

test("a status bar part paints one full-width row below the transcript and the rail", (t) => {
	const f = fixture("fullscreen", 160);
	let widthSeen = 0;
	sidebarHeader(f.tui, { render: () => ["TITLE"], invalidate() {} });
	sidebarStatusBar(f.tui, { render: (width: number) => { widthSeen = width; return ["STATUS BAR"]; }, invalidate() {} });
	const transcript = { render: () => ["CONVERSATION"], invalidate() {} };
	f.root[NODE] = () => ({ type: "vstack", entries: [{ component: transcript }] });
	t.after(installSidebar(f.tui, theme));
	const frame = renderLayoutFrame(f.root, 160, 8, () => {});
	assert.match(frame.lines[0]!, /TITLE/);
	assert.match(frame.lines.at(-1)!, /^STATUS BAR/, "the status bar is the last row, under the rail too");
	assert.match(frame.lines[1]!, /CONVERSATION/, "the transcript starts immediately below the title");
	assert.ok(frame.lines.slice(1, -1).some((line) => /Status/.test(line)), "the rail sits above the status bar");
	assert.equal(widthSeen, 160, "rendered at the full width, so the bar reaches the window edge");
});

test("below the rail breakpoint the status bar row stays only while its part paints one (mobile)", (t) => {
	const f = fixture("fullscreen", 139);
	let paints = true;
	sidebarStatusBar(f.tui, { render: () => paints ? ["STATUS BAR"] : [], invalidate() {} });
	t.after(installSidebar(f.tui, theme));
	assert.match(renderLayoutFrame(f.root, 139, 6, () => {}).lines.at(-1)!, /^STATUS BAR/, "the mobile status bar is the last row");
	paints = false;
	assert.doesNotMatch(renderLayoutFrame(f.root, 139, 6, () => {}).lines.join("\n"), /STATUS BAR/, "a part with nothing to show leaves the native layout");
});

test("the rail panel surface reaches the bottom of the viewport, not just the last section", (t) => {
	const f = fixture("fullscreen", 160);
	const painting = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m` };
	sidebarPart(f.tui, "todo", { render: () => ["todo"], invalidate() {} }, { surface: "panel", digest: () => "todo", render: (width: number) => ["TODOS".padEnd(width)], invalidate() {} });
	// The shell's Status is a panel too, so the rail ends on the panel surface.
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} }, { surface: "panel", digest: () => "status", render: (width: number) => ["CHANGES".padEnd(width)], invalidate() {} });
	const transcript = { render: () => ["CONVERSATION"], invalidate() {} };
	f.root[NODE] = () => ({ type: "vstack", entries: [{ component: transcript }] });
	t.after(installSidebar(f.tui, painting));
	renderLayoutFrame(f.root, 160, 12, () => {});
	const frame = renderLayoutFrame(f.root, 160, 12, () => {});
	const tinted = frame.lines.filter((line) => line.includes("\x1b[48;5;236m")).length;
	assert.ok(frame.lines.at(-1)!.includes("\x1b[48;5;236m"), `the last screen row is still on the rail surface: ${JSON.stringify(frame.lines.at(-1))}`);
	assert.ok(tinted >= 10, `the surface fills the rail column (${tinted} tinted rows)`);
	assert.equal(rail(f).scrollTop, 0);
	rail(f).scrollBy(5);
	assert.equal(rail(f).scrollTop, 0, "the fill adds no scroll range");
});

test("a top header sits inside the conversation column, and it and the rail both start on the window's first row", (t) => {
	for (const density of ["comfortable", "compact", "minimal"] as const) {
		const f = fixture("fullscreen", 160);
		const received: TuiMouseEvent[] = [];
		sidebarHeader(f.tui, {
			render: (width: number) => [`HEADER ${width}`],
			invalidate() {},
			handleMouse(event) { received.push(event); return { handled: true }; },
		});
		const transcript = { render: () => ["CONVERSATION".padEnd(107, "x")], invalidate() {} };
		const dock = { render: () => ["EDITOR".padEnd(110, "e")], invalidate() {} };
		f.root[NODE] = () => ({ type: "vstack", gap: 0, entries: [{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 }, { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 }] });
		t.after(installSidebar(f.tui, theme, () => "auto", () => "top", () => density));
		assert.equal(f.root[NODE]().type, "hstack", `${density}: no full-width row spans the rail`);
		const lines = renderLayoutFrame(f.root, 160, 6, () => {}).lines.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, ""));
		assert.match(lines[5]!, /^EDITORe{101}/, `${density}: the editor stays in the conversation column`);
		assert.equal(lines[5]!.slice(107, 110), "   ", `${density}: the editor keeps the 3-column gap from the rail`);
		// 160 columns minus the 50-column rail: the header reaches the rail, with no gap.
		assert.match(lines[0]!, /^HEADER 110 /, `${density}: the header runs up to the rail`);
		assert.equal(lines[1]!.slice(107, 110), "   ", `${density}: the conversation keeps its 3-column gap from the rail`);
		assert.match(lines[1]!, /^CONVERSATION/, `${density}: the conversation follows the header's own rows`);
		assert.match(lines[density === "comfortable" ? 1 : 0]!, /Status/, `${density}: the rail's first section is level with the header's text row`);
		const click: TuiMouseEvent = { type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0, width: 110, height: 1, shift: false, alt: false, ctrl: false };
		(f.root[NODE]() as unknown as { entries: { component: { [key: symbol]: () => { entries: { component: Component }[] } } }[] }).entries[0]!.component[NODE]().entries[0]!.component.handleMouse?.(click);
		assert.equal(received.at(-1)?.x, 3, `${density}: the header leaf still routes its clicks`);
		const railRows = railWithHeader(f).render(50);
		assert.deepEqual(railRows, density === "comfortable" ? ["", " Status "] : [" Status "], `${density}: beside a centered comfortable top bar the rail keeps a top padding row`);
		assert.equal(sidebarState(f.tui).active, true);
	}
});

test("a split header keeps the full-width title row above the rail", (t) => {
	const f = fixture("fullscreen", 160);
	sidebarHeader(f.tui, { render: (width: number) => [`HEADER ${width}`], invalidate() {} });
	t.after(installSidebar(f.tui, theme, () => "auto", () => "split"));
	const node = f.root[NODE]() as unknown as { type: string; entries: { component: Component }[] };
	assert.equal(node.type, "vstack");
	assert.deepEqual(node.entries[0]!.component.render(160), ["HEADER 160"], "the title bar reaches the window edge");
});

test("a top header falls back to the full width when the rail is not shown", (t) => {
	const f = fixture("fullscreen", 180);
	sidebarHeader(f.tui, { render: (width: number) => [`HEADER ${width}`], invalidate() {} });
	t.after(installSidebar(f.tui, theme, () => "bottom", () => "top"));
	const node = f.root[NODE]() as unknown as { type: string; entries: { component: Component }[] };
	assert.equal(node.type, "vstack");
	assert.deepEqual(node.entries[0]!.component.render(180), ["HEADER 180"]);
});

test("a transparent chrome drops the rail, title row and status bar backgrounds and keeps the density's spacing", (t) => {
	const previousStyle = cardStyle();
	t.after(() => setCardStyle(previousStyle));
	setCardStyle(CARD_STYLE.NEON);
	const previous = chromeSurface();
	t.after(() => setChromeSurface(previous));
	const painted = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	const tinted = /\x1b\[48;5;22m/;
	for (const density of ["compact", "minimal"] as const) {
		setChromeSurface("transparent");
		const f = fixture("fullscreen", 160);
		sidebarPart(f.tui, "todo", { render: () => ["TODO"], invalidate() {} });
		sidebarPart(f.tui, "footer", { surface: "panel", render: () => ["Status"], invalidate() {} });
		sidebarHeader(f.tui, { render: () => ["HEADER"], invalidate() {} });
		t.after(installSidebar(f.tui, painted, () => "auto", () => "split", () => density));
		const rows = railWithHeader(f).render(50);
		assert.doesNotMatch(rows.join("\n"), tinted, `${density}: no panel background`);
		// A transparent rail draws each section as a card (neon here): a one-row
		// section is its title in the top rule, then the bottom edge.
		const text = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
		const between = text.findIndex((row) => row.includes("Status")) - text.findIndex((row) => row.includes("TODO"));
		assert.equal(between, 2, `${density}: TODO's card closes and Status's card opens with no gap row: the surface never changes the density`);
		setChromeSurface("tinted");
		assert.match(railWithHeader(f).render(50).join("\n"), tinted, "switching back repaints the panel");
	}
	setChromeSurface("transparent");
	const model = { cwd: "/project", branch: "main", dirty: 0, sessionName: undefined, modelId: "model", effort: "high", contextPercent: 45, contextWindow: 1000, costTotal: 1, subscription: false, usage: undefined, statuses: [] };
	assert.doesNotMatch(renderShellStatusBar(model, painted, 120).rows.join("\n"), tinted, "the status bar floats");
	setChromeSurface("tinted");
	assert.match(renderShellStatusBar(model, painted, 120).rows.join("\n"), tinted);
});

test("beside a centered comfortable top bar the rail starts with its padding row and puts its first section on the text row", (t) => {
	const previousStyle = cardStyle();
	t.after(() => setCardStyle(previousStyle));
	setCardStyle(CARD_STYLE.NEON);
	const previous = chromeSurface();
	t.after(() => setChromeSurface(previous));
	const painted = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	for (const surface of ["tinted", "transparent"] as const) {
		setChromeSurface(surface);
		const f = fixture("fullscreen", 160);
		sidebarPart(f.tui, "footer", { surface: "panel", render: () => ["Status"], invalidate() {} });
		sidebarHeader(f.tui, { render: () => ["PAD", "HEADER", "PAD"], invalidate() {} });
		t.after(installSidebar(f.tui, painted, () => "auto", () => "top"));
		const rows = railWithHeader(f).render(50);
		const top = rows[0]!.replace(/\x1b\[[0-9;]*m/g, "").trim();
		if (surface === "tinted") {
			assert.equal(top, "", "tinted: the rail's top padding is level with the bar's top margin");
			assert.match(rows[1]!, /Status/, "tinted: the first section sits on the header's text row");
		} else {
			assert.match(top, /^╭─ .*Status ─+╮$/, "transparent: the first card's title rule is level with the bar's top margin");
		}
		if (surface === "tinted") assert.match(rows[0]!, /\x1b\[48;5;22m/, "the panel surface starts on the window's first row");
		else assert.doesNotMatch(rows.join("\n"), /\x1b\[48;5;22m/);
	}
});

test("a split title row's margin row spans the rail, so the rail adds no top padding of its own", (t) => {
	const painted = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	const f = fixture("fullscreen", 160);
	sidebarPart(f.tui, "footer", { surface: "panel", render: () => ["Status"], invalidate() {} });
	sidebarHeader(f.tui, { render: (width: number) => [`TITLE ${width}`, "PAD"], invalidate() {} });
	t.after(installSidebar(f.tui, painted, () => "auto", () => "split"));
	assert.match(railWithHeader(f).render(50)[0]!, /Status/, "the first section starts right under the title block");
});

test("beside the rail a below-input layout keeps the transcript and the dock in the gapped column", (t) => {
	const f = fixture("fullscreen", 160);
	sidebarHeader(f.tui, { render: () => ["HEADER"], invalidate() {} });
	const transcript = { render: () => ["T".repeat(120)], invalidate() {} };
	const dock = { render: () => ["D".repeat(120)], invalidate() {} };
	f.root[NODE] = () => ({ type: "vstack", gap: 0, entries: [{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 }, { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 }] });
	t.after(installSidebar(f.tui, theme, () => "auto", () => "below-input"));
	const lines = renderLayoutFrame(f.root, 160, 4, () => {}).lines.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, ""));
	assert.match(lines[0]!, /^T{107} {3}/, "the transcript keeps its 3-column gap from the rail");
	assert.match(lines[3]!, /^D{107} {3}/, "so does the dock with the editor");
});

test("a compact or minimal split title row has no margin row, so the rail keeps its own top gap", (t) => {
	const painted = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	for (const density of ["compact", "minimal"] as const) {
		const f = fixture("fullscreen", 160);
		sidebarPart(f.tui, "footer", { surface: "panel", render: () => ["Status"], invalidate() {} });
		sidebarHeader(f.tui, { render: (width: number) => [`TITLE ${width}`], invalidate() {} });
		t.after(installSidebar(f.tui, painted, () => "auto", () => "split", () => density));
		const rail = railWithHeader(f).render(50);
		assert.equal(rail[0]!.replace(/\x1b\[[0-9;]*m/g, "").trim(), "", `${density}: a blank rail row under the title`);
		assert.match(rail[1]!, /Status/, `${density}: the first section follows it`);
	}
});

test("a transparent rail draws every section as its own card in the transcript's card style, with the key hints outside the cards", (t) => {
	const [previousStyle, previousSurface] = [cardStyle(), chromeSurface()];
	t.after(() => { setCardStyle(previousStyle); setChromeSurface(previousSurface); });
	const painted = { ...theme, bg: (role: string, text: string) => `\x1b[48;5;${role === "customMessageBg" ? 171 : 120}m${text}\x1b[49m` };
	const strip = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "");
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		setCardStyle(style);
		setChromeSurface("transparent");
		const f = fixture("fullscreen", 160);
		const received: TuiMouseEvent[] = [];
		const lines = (width: number) => [`\x1b[35m▾\x1b[39m CHANGES${" ".repeat(width - 14)}clean`, "  no changes", "", `▾ INTEGRATIONS${" ".repeat(width - 15)}1`, "  - gentle-pi · ready", "", "  ctrl+shift+t todos"];
		sidebarPart(f.tui, "footer", { render: () => [], invalidate() {} }, {
			surface: "panel",
			render: (width: number) => lines(width),
			cardGroups: () => ({ groups: [{ start: 0, end: 2 }, { start: 3, end: 5 }], loose: [6] }),
			invalidate() {},
			handleMouse(event) { received.push(event); return { handled: true }; },
		});
		sidebarHeader(f.tui, { render: () => ["HEADER"], invalidate() {} });
		t.after(installSidebar(f.tui, painted, () => "auto", () => "split", () => "compact"));
		const scroll = railWithHeader(f);
		const rows = scroll.render(50);
		const text = rows.map(strip);
		const content = scroll.getContentWidth(50);
		for (const row of rows) assert.ok(visibleWidth(row) <= content, `${style}: no row overflows the rail`);
		const changes = text.findIndex((row) => row.includes("CHANGES"));
		const integrations = text.findIndex((row) => row.includes("INTEGRATIONS"));
		const hints = text.findIndex((row) => row.includes("ctrl+shift+t todos"));
		assert.ok(changes >= 0 && integrations > changes && hints > integrations, `${style}: Changes, Integrations, then the hints`);
		if (style === CARD_STYLE.NEON) {
			assert.match(text[changes]!, /^╭─ ▾ CHANGES ─+ clean ╮$/, "neon: the section title and count sit in the card's top rule, like a transcript card");
			assert.equal((text[changes]!.match(/▾/g) ?? []).length, 1, "neon: a styled header glyph is not repeated");
			assert.match(text[changes + 1]!, /^│ +no changes +│$/);
			assert.match(text[changes + 2]!, /^╰─+╯$/, "neon: every section closes its own card");
			assert.match(text[integrations]!, /^╭─ ▾ INTEGRATIONS ─+ 1 ╮$/, "neon: Integrations is its own card");
		} else {
			assert.match(rows[changes]!, /\x1b\[48;5;120m/, "float: the card tone background");
			assert.match(text[changes]!, /▎/, "float: the accent bar of a float card");
			assert.notEqual(rows.findIndex((row) => row.includes("\x1b[48;5;120m") && strip(row).includes("INTEGRATIONS")), -1, "float: Integrations is its own card");
		}
		assert.doesNotMatch(rows[hints]!, /\x1b\[48;5;/, `${style}: the hints sit outside the cards`);
		assert.doesNotMatch(text[hints]!, /[│╭╰▎]/, `${style}: no card chrome on the hints`);
		const click = (x: number, y: number): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: 110 + x, screenY: y, width: 50, height: 30, shift: false, alt: false, ctrl: false });
		assert.equal(scroll.handleMouse(click(6, changes))?.handled, true, `${style}: the title row folds the section`);
		assert.equal(received.at(-1)?.y, 0, `${style}: the title row maps to the section header`);
		const body = text.findIndex((row) => row.includes("no changes"));
		assert.equal(scroll.handleMouse(click(6, body))?.handled, true);
		assert.equal(received.at(-1)?.y, 1, `${style}: a body row maps to its own row`);
		assert.equal(scroll.handleMouse(click(6, integrations))?.handled, true);
		assert.equal(received.at(-1)?.y, 3, `${style}: the second card's title maps to its header`);
	}
});

test("float rail cards never fuse: an unpainted row separates them in every density, while neon cards may touch", (t) => {
	const [previousStyle, previousSurface] = [cardStyle(), chromeSurface()];
	t.after(() => { setCardStyle(previousStyle); setChromeSurface(previousSurface); });
	const painted = { ...theme, bg: (role: string, text: string) => `\x1b[48;5;${role === "customMessageBg" ? 171 : 120}m${text}\x1b[49m` };
	const tinted = /\x1b\[48;5;\d+m/;
	setChromeSurface("transparent");
	for (const style of [CARD_STYLE.FLOAT, CARD_STYLE.NEON]) {
		for (const density of ["comfortable", "compact", "minimal"] as const) {
			setCardStyle(style);
			const f = fixture("fullscreen", 160);
			sidebarPart(f.tui, "todo", { render: () => [], invalidate() {} }, { render: () => ["▾ TODOS  1/2", "  task"], invalidate() {} });
			sidebarPart(f.tui, "footer", { render: () => [], invalidate() {} }, {
				surface: "panel",
				render: () => ["▾ CHANGES  clean", "  none", "▾ INTEGRATIONS  1", "  ready"],
				cardGroups: () => ({ groups: [{ start: 0, end: 2 }, { start: 2, end: 4 }] }),
				invalidate() {},
			});
			sidebarHeader(f.tui, { render: () => ["HEADER"], invalidate() {} });
			t.after(installSidebar(f.tui, painted, () => "auto", () => "split", () => density));
			const rows = railWithHeader(f).render(50);
			const text = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
			for (const title of ["CHANGES", "INTEGRATIONS"]) {
				const at = text.findIndex((row) => row.includes(title));
				if (style === CARD_STYLE.FLOAT) {
					// A float card opens with a padding row, so the row above that one separates two cards.
					assert.doesNotMatch(rows[at - 2] ?? "", tinted, `float/${density}: an unpainted row separates the card before ${title}`);
					assert.match(rows[at - 1]!, tinted, `float/${density}: ${title}'s card keeps its own top padding`);
				} else {
					const above = text.slice(0, at).filter((row) => row.trim() !== "").at(-1)!;
					assert.match(above, /^╰─+╯$/, `neon/${density}: the previous card's bottom rule closes it above ${title}`);
					assert.equal(text[at - 1]!.trim() === "", density === "comfortable", `neon/${density}: only comfortable adds a gap row`);
				}
			}
		}
	}
});
