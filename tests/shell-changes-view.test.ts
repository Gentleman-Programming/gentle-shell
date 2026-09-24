import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, visibleWidth, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { CHANGE_STATUS, changesModel, type ChangedFile } from "../lib/shell-changes.ts";
import { WorktreeChangesView, ChangesView, colorDiff, type ChangesViewDeps } from "../lib/shell-changes-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The changes overlay: files on the left, the selected file's diff on the
// right, keys at the bottom. Rendering is pure; git access is injected.

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

function file(path: string, added: number, deleted: number, status: ChangedFile["status"] = CHANGE_STATUS.MODIFIED): ChangedFile {
	return { path, added, deleted, status };
}

const DIFF_A = ["diff --git a/lib/a.ts b/lib/a.ts", "index 1..2 100644", "--- a/lib/a.ts", "+++ b/lib/a.ts", "@@ -1,2 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;"].join("\n");

function view(overrides: Partial<ChangesViewDeps> = {}, files = [file("lib/a.ts", 2, 1), file("lib/b.ts", 10, 0, CHANGE_STATUS.ADDED)]) {
	const calls: string[] = [];
	const events: string[] = [];
	const deps: ChangesViewDeps = {
		theme: plainTheme,
		rows: 12,
		async loadDiff(target) {
			calls.push(target.path);
			return target.path === "lib/a.ts" ? DIFF_A : "";
		},
		onOpen(target) {
			events.push(`open:${target.path}`);
		},
		onClose() {
			events.push("close");
		},
		requestRender() {
			events.push("render");
		},
		...overrides,
	};
	return { view: new ChangesView(changesModel(files), deps), calls, events };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function mouse(type: TuiMouseEvent["type"], x: number, y: number, wheelDelta?: number, height = 12): TuiMouseEvent {
	return { type, button: type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y, width: 80, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

function mouseButton(type: TuiMouseEvent["type"], button: TuiMouseEvent["button"], x: number, y: number, height: number): TuiMouseEvent {
	return { type, button, x, y, screenX: x, screenY: y, width: 80, height, shift: false, alt: false, ctrl: false };
}

// H1 (odd/tasks/usage-click-and-changes-attribution.md): the same shared
// hover role every other clickable surface uses, and it never overrides the
// already-selected row's own role.
test("WorktreeChangesView paints the shared hover role over an unselected row, never the selected one", async () => {
	const trees = ["/main", "/linked"].map((root) => ({ root, branch: root === "/main" ? "main" : undefined, model: changesModel([file("same.ts", 1, 0)]) }));
	const component = new WorktreeChangesView(trees, {
		theme: taggedTheme, rows: 10,
		loadDiff: async () => "",
		onOpen: () => {},
		onClose: () => {}, requestRender() {}, onRefresh() {},
	});
	component.render(80);
	// Row y=1 is the selected group header (/main, index 0); row y=2 is /linked's header.
	const hoverOther = component.handleMouse(mouseButton("move", "none", 3, 2, 10));
	assert.deepEqual(hoverOther, { handled: true, render: true });
	assert.match(component.render(80)[2]!, /<warning>[^<]*detached/, "hovering the unselected row paints the shared hover role");
	assert.doesNotMatch(component.render(80)[1]!, /<warning>/, "the selected row keeps its own role");

	const hoverSelected = component.handleMouse(mouseButton("move", "none", 3, 1, 10));
	assert.deepEqual(hoverSelected, { handled: true, render: true });
	assert.doesNotMatch(component.render(80)[1]!, /<warning>/, "hovering the selected row still never paints the hover role");
	assert.doesNotMatch(component.render(80)[2]!, /<warning>/, "leaving the other row clears its hover");
});

test("worktree accordion keeps groups and nested files beside a framed lazy diff", async () => {
	const trees = ["/main", "/linked"].map((root) => ({ root, branch: root === "/main" ? "main" : undefined, model: changesModel([file("same.ts", 1, 0)]) }));
	const loaded: string[] = [];
	const opened: string[] = [];
	let closed = 0;
	const component = new WorktreeChangesView(trees, {
		theme: plainTheme, rows: 10,
		loadDiff: async (root, target) => { loaded.push(root); return `+${root}:${target.path}`; },
		onOpen: (root, target) => { opened.push(`${root}:${target.path}`); },
		onClose: () => { closed++; }, requestRender() {}, onRefresh() {},
	});
	assert.deepEqual(loaded, [], "list must not eagerly load diffs");
	assert.match(component.render(100).join("\n"), /detached · linked/);
	component.handleInput("\r");
	assert.deepEqual(loaded, [], "expanding a header must not select a file");
	component.handleInput("j");
	await settle();
	const lines = component.render(100);
	assert.equal(lines.length, 10);
	assert.match(lines[0], /^╭─ ✎ Changes/);
	assert.match(lines[1], /^│   ▾ main · main +│ \+\/main:same.ts +│$/);
	assert.match(lines[2], /^│ ▸   M same.ts +\+1 -0 +│/);
	assert.match(lines[3], /^│   ▸ detached · linked +│/);
	assert.match(lines[9], /^╰─+╯$/);
	for (const line of lines) assert.equal(visibleWidth(line), 100);
	assert.match(component.render(100).join("\n"), /\+\/main:same.ts/);
	component.handleInput("o");
	component.handleInput("j");
	assert.doesNotMatch(component.render(100).join("\n"), /\+\/main:same.ts/, "header selection clears unrelated preview");
	assert.match(component.render(100)[2], /^│     M same.ts +\+1 -0 +│/, "unselected children retain their fixed marker and indentation");
	component.handleInput(" ");
	component.handleInput("j");
	await settle();
	assert.match(component.render(100).join("\n"), /▾ main · main/, "multiple groups remain expanded");
	assert.match(component.render(100).join("\n"), /\+\/linked:same.ts/);
	assert.doesNotMatch(component.render(100).join("\n"), /\+\/main:same.ts/);
	component.handleInput("\r");
	assert.deepEqual(opened, ["/main:same.ts", "/linked:same.ts"]);
	assert.deepEqual(loaded, ["/main", "/linked"]);
	component.update([trees[0]]);
	assert.match(component.render(100).join("\n"), /main · main/);
	component.handleInput("\x1b");
	assert.equal(closed, 1);
});

test("worktree accordion selects a clicked file without opening its editor", () => {
	const opened: string[] = [];
	const component = new WorktreeChangesView([{ root: "/main", branch: "main", model: changesModel([file("a.ts", 1, 0), file("b.ts", 1, 0)]) }], {
		theme: plainTheme, rows: 8, loadDiff: async () => "+preview",
		onOpen: (_root, target) => { opened.push(target.path); }, onClose() {}, onRefresh() {}, requestRender() {},
	});
	component.handleInput("\r");
	component.render(80);
	const result = component.handleMouse({ type: "click", button: "left", x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 8, shift: false, alt: false, ctrl: false });
	assert.deepEqual(result, { handled: true, render: true });
	assert.match(component.render(80)[3], /▸   M b\.ts/);
	assert.deepEqual(opened, []);
});

test("worktree accordion receives native fullscreen press and release as a file click", async () => {
	let onInput: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(input) { onInput = input; }, stop() {}, async drainInput() {}, write() {}, get columns() { return 80; }, get rows() { return 8; }, get kittyProtocolActive() { return false; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const opened: string[] = [];
	const component = new WorktreeChangesView([{ root: "/main", branch: "main", model: changesModel([file("a.ts", 1, 0), file("b.ts", 1, 0)]) }], {
		theme: plainTheme, rows: 8, loadDiff: async () => "+preview",
		onOpen: (_root, target) => { opened.push(target.path); }, onClose() {}, onRefresh() {}, requestRender() {},
	});
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	tui.setLayoutRoot(component);
	tui.start();
	component.handleInput("\r");
	tui.renderNow(true);
	try {
		onInput?.("\x1b[<0;4;4M");
		onInput?.("\x1b[<0;4;4m");
		assert.match(component.render(80)[3], /▸   M b\.ts/);
		assert.deepEqual(opened, []);
	} finally {
		tui.stop();
	}
});

test("worktree pointer regions scroll independently and expire on refresh or dispose", async () => {
	const files = Array.from({ length: 8 }, (_, index) => file(`file-${index}.ts`, 1, 0));
	const long = Array.from({ length: 20 }, (_, index) => `+line ${index}`).join("\n");
	const trees = [{ root: "/main", branch: "main", model: changesModel(files) }];
	const component = new WorktreeChangesView(trees, {
		theme: plainTheme, rows: 8, loadDiff: async () => `@@ -0,0 +1,20 @@\n${long}`,
		onOpen() {}, onClose() {}, onRefresh() {}, requestRender() {},
	});
	component.handleInput("\r");
	component.handleInput("j");
	await settle();
	component.render(80);
	assert.deepEqual(component.handleMouse(mouse("move", 3, 2, undefined, 8)), undefined, "hover must not select");
	assert.deepEqual(component.handleMouse(mouse("wheel", 3, 1, 2, 8)), { handled: true, render: true });
	assert.match(component.render(80)[1], /M file-1\.ts/);
	component.update(trees);
	assert.deepEqual(component.handleMouse(mouse("wheel", 3, 1, 1, 8)), { handled: true, render: false }, "refresh invalidates stale pointer geometry");
	assert.match(component.render(80)[1], /M file-1\.ts/, "unchanged polling keeps the manual list viewport");
	assert.deepEqual(component.handleMouse(mouse("wheel", 50, 1, 2, 8)), { handled: true, render: true });
	assert.doesNotMatch(component.render(80)[1], /@@/);
	component.dispose();
	assert.deepEqual(component.handleMouse(mouse("click", 3, 1, undefined, 8)), { handled: true, render: false });
});

test("file-list pointer capture is limited to an active left gesture in both views", () => {
	const { view: standalone } = view();
	const accordion = new WorktreeChangesView([{ root: "/main", branch: "main", model: changesModel([file("a.ts", 1, 0)]) }], {
		theme: plainTheme, rows: 8, loadDiff: async () => "+preview", onOpen() {}, onClose() {}, onRefresh() {}, requestRender() {},
	});
	accordion.handleInput("\r");
	standalone.render(80);
	accordion.render(80);
	for (const [component, y, height] of [[standalone, 1, 12], [accordion, 2, 8]] as const) {
		for (const button of ["right", "middle"] as const) {
			assert.equal(component.handleMouse(mouseButton("press", button, 3, y, height)), undefined, `${button} press must reach pi-tui fallback`);
			assert.equal(component.handleMouse(mouseButton("release", button, 3, y, height)), undefined, `${button} release must reach pi-tui fallback`);
		}
		assert.deepEqual(component.handleMouse(mouseButton("press", "left", 3, y, height)), { handled: true, capture: true, render: false });
		assert.deepEqual(component.handleMouse(mouseButton("release", "none", 3, y, height)), { handled: true, render: false });
	}
	standalone.handleMouse(mouseButton("press", "left", 3, 1, 12));
	standalone.update(changesModel([file("a.ts", 1, 0)]));
	standalone.render(80);
	assert.equal(standalone.handleMouse(mouseButton("release", "none", 3, 1, 12)), undefined, "update clears a captured left gesture");
	accordion.handleMouse(mouseButton("press", "left", 3, 2, 8));
	accordion.invalidate();
	accordion.render(80);
	assert.equal(accordion.handleMouse(mouseButton("release", "none", 3, 2, 8)), undefined, "invalidate clears a captured left gesture");
});

test("an outside release clears an active left gesture in both views", () => {
	const { view: standalone } = view();
	const accordion = new WorktreeChangesView([{ root: "/main", branch: "main", model: changesModel([file("a.ts", 1, 0)]) }], {
		theme: plainTheme, rows: 8, loadDiff: async () => "+preview", onOpen() {}, onClose() {}, onRefresh() {}, requestRender() {},
	});
	accordion.handleInput("\r");
	standalone.render(80);
	accordion.render(80);
	for (const [component, y, height] of [[standalone, 1, 12], [accordion, 2, 8]] as const) {
		assert.deepEqual(component.handleMouse(mouseButton("press", "left", 3, y, height)), { handled: true, capture: true, render: false });
		assert.deepEqual(component.handleMouse(mouseButton("release", "none", 50, y, height)), { handled: true, render: false }, "captured release outside the file pane clears state");
		assert.equal(component.handleMouse(mouseButton("release", "none", 3, y, height)), undefined, "a later unrelated release must not consume stale state");
	}
});

test("a stale-layout release clears an active left gesture in both views", () => {
	let standaloneRows = 12;
	let accordionRows = 8;
	const { view: standalone } = view({ rows: () => standaloneRows });
	const accordion = new WorktreeChangesView([{ root: "/main", branch: "main", model: changesModel([file("a.ts", 1, 0)]) }], {
		theme: plainTheme, rows: () => accordionRows, loadDiff: async () => "+preview", onOpen() {}, onClose() {}, onRefresh() {}, requestRender() {},
	});
	accordion.handleInput("\r");
	standalone.render(80);
	accordion.render(80);
	for (const [component, y, beforeHeight, afterHeight, resize] of [
		[standalone, 1, 12, 8, () => { standaloneRows = 8; }],
		[accordion, 2, 8, 6, () => { accordionRows = 6; }],
	] as const) {
		assert.deepEqual(component.handleMouse(mouseButton("press", "left", 3, y, beforeHeight)), { handled: true, capture: true, render: false });
		resize();
		for (const button of ["right", "middle"] as const) assert.equal(component.handleMouse(mouseButton("release", button, 3, y, afterHeight)), undefined, `${button} release must still reach pi-tui with stale geometry`);
		assert.deepEqual(component.handleMouse(mouseButton("release", "none", 3, y, afterHeight)), { handled: true, render: false }, "the captured release is accepted despite stale geometry");
		component.render(80);
		assert.equal(component.handleMouse(mouseButton("release", "none", 3, y, afterHeight)), undefined, "a later unrelated release must not consume stale state");
	}
});

test("non-left gestures pass through with current, stale, and missing layouts in both views", () => {
	let standaloneRows = 12;
	let accordionRows = 8;
	const { view: standalone } = view({ rows: () => standaloneRows });
	const accordion = new WorktreeChangesView([{ root: "/main", branch: "main", model: changesModel([file("a.ts", 1, 0)]) }], {
		theme: plainTheme, rows: () => accordionRows, loadDiff: async () => "+preview", onOpen() {}, onClose() {}, onRefresh() {}, requestRender() {},
	});
	accordion.handleInput("\r");
	standalone.render(80);
	accordion.render(80);
	for (const [component, y, currentHeight, staleHeight, resize] of [
		[standalone, 1, 12, 8, () => { standaloneRows = 8; }],
		[accordion, 2, 8, 6, () => { accordionRows = 6; }],
	] as const) {
		resize();
		assert.deepEqual(component.handleMouse(mouseButton("press", "left", 3, y, staleHeight)), { handled: true, render: false }, "stale geometry does not capture a left press");
		for (const button of ["right", "middle"] as const) {
			assert.equal(component.handleMouse(mouseButton("press", button, 3, y, staleHeight)), undefined, `${button} press must reach pi-tui with stale geometry`);
			assert.equal(component.handleMouse(mouseButton("release", button, 3, y, staleHeight)), undefined, `${button} release must reach pi-tui with stale geometry`);
		}
		component.render(80);
		assert.deepEqual(component.handleMouse(mouseButton("press", "left", 3, y, staleHeight)), { handled: true, capture: true, render: false }, "current geometry captures a left press");
		assert.deepEqual(component.handleMouse(mouseButton("release", "none", 3, y, staleHeight)), { handled: true, render: false }, "current geometry clears the active left release");
		for (const button of ["right", "middle"] as const) {
			assert.equal(component.handleMouse(mouseButton("press", button, 3, y, staleHeight)), undefined, `${button} press must reach pi-tui with current geometry`);
			assert.equal(component.handleMouse(mouseButton("release", button, 3, y, staleHeight)), undefined, `${button} release must reach pi-tui with current geometry`);
		}
		component.invalidate();
		assert.deepEqual(component.handleMouse(mouseButton("press", "left", 3, y, currentHeight)), { handled: true, render: false }, "missing geometry does not capture a left press");
		for (const button of ["right", "middle"] as const) {
			assert.equal(component.handleMouse(mouseButton("press", button, 3, y, currentHeight)), undefined, `${button} press must reach pi-tui without geometry`);
			assert.equal(component.handleMouse(mouseButton("release", button, 3, y, currentHeight)), undefined, `${button} release must reach pi-tui without geometry`);
		}
	}
});

test("right press reaches the native Windows paste fallback when eligible", () => {
	let onInput: ((data: string) => void) | undefined;
	let pasted = 0;
	const terminal: Terminal = {
		start(input) { onInput = input; }, stop() {}, async drainInput() {}, write() {}, get columns() { return 80; }, get rows() { return 12; }, get kittyProtocolActive() { return false; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const { view: component } = view();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, onRightClickPaste: () => { pasted++; } });
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const termProgram = process.env.TERM_PROGRAM;
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	delete process.env.TERM_PROGRAM;
	tui.setLayoutRoot(component);
	tui.start();
	tui.renderNow(true);
	try {
		onInput?.("\x1b[<2;4;2M");
		assert.equal(pasted, 1);
	} finally {
		tui.stop();
		Object.defineProperty(process, "platform", platform);
		if (termProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = termProgram;
	}
});

test("worktree list keeps selection visible, preserves root across reorder and refreshes from either level", async () => {
	const trees = Array.from({ length: 15 }, (_, index) => ({ root: `/tree-${index}`, branch: `branch-${index}`, model: changesModel([file("a.ts", 1, 0)]) }));
	let refreshed = 0;
	const loaded: string[] = [];
	const component = new WorktreeChangesView(trees, {
		theme: plainTheme, rows: 8, loadDiff: async (root) => { loaded.push(root); return ""; },
		onOpen() {}, onClose() {}, requestRender() {}, onRefresh() { refreshed++; },
	});
	for (let index = 0; index < 14; index++) component.handleInput("j");
	assert.match(component.render(100).join("\n"), /▸ ▸ branch-14/);
	component.update([...trees].reverse());
	component.handleInput("r");
	component.handleInput("\r");
	component.handleInput("j");
	component.handleInput("r");
	await settle();
	assert.deepEqual(loaded, ["/tree-14"]);
	assert.equal(refreshed, 2);
	for (const line of component.render(30)) assert.ok(visibleWidth(line) <= 30);
	component.update([]);
	assert.match(component.render(100).join("\n"), /No dirty worktrees/);
	component.handleInput("\r");
	assert.equal(loaded.length, 1);
});

test("worktree labels remove terminal controls without changing diff or editor roots", async () => {
	const root = "/repo\nline\tcolumn\r\x07\x1b[31mred\x1b[0m\x1b]0;injected title\x07";
	const routed: string[] = [];
	const component = new WorktreeChangesView([{ root, branch: "main", model: changesModel([file("a.ts", 1, 0)]) }], {
		theme: plainTheme, rows: 8,
		loadDiff: async (actualRoot) => { routed.push(actualRoot); return "+safe"; },
		onOpen: (actualRoot) => { routed.push(actualRoot); },
		onClose() {}, onRefresh() {}, requestRender() {},
	});
	const assertSafe = (lines: string[]) => {
		for (const line of lines) {
			assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
			assert.ok(visibleWidth(line) <= 100);
		}
		assert.match(lines.join("\n"), /main · repo line columnred/);
		assert.doesNotMatch(lines.join("\n"), /injected title/);
	};
	assertSafe(component.render(100));
	component.handleInput("\r");
	component.handleInput("j");
	await settle();
	assertSafe(component.render(100));
	component.handleInput("o");
	assert.deepEqual(routed, [root, root], "display sanitization must not alter raw root identity");
});

test("accordion refresh preserves expanded roots and selected file; left returns to parent then collapses", async () => {
	const trees = ["/parent/one", "/parent/two"].map((root) => ({ root, branch: "main", model: changesModel([file("a.ts", 1, 0), file("b.ts", 1, 0)]) }));
	const opened: string[] = [];
	const component = new WorktreeChangesView(trees, {
		theme: plainTheme, rows: 12, loadDiff: async () => "+preview",
		onOpen: (root, target) => { opened.push(`${root}/${target.path}`); },
		onClose() {}, onRefresh() {}, requestRender() {},
	});
	component.handleInput("\x1b[C");
	component.handleInput("j");
	component.handleInput("j");
	component.update([trees[1], trees[0]]);
	component.handleInput("o");
	assert.deepEqual(opened, ["/parent/one/b.ts"]);
	assert.match(component.render(100).join("\n"), /▾ main · one/);
	component.handleInput("\x1b[D");
	assert.match(component.render(100).join("\n"), /▸ ▾ main · one/);
	component.handleInput("\x1b[D");
	assert.doesNotMatch(component.render(100).join("\n"), /b.ts/);
	component.handleInput("\r");
	component.handleInput("j");
	component.update([{ ...trees[0], model: changesModel([file("b.ts", 1, 0)]) }]);
	assert.match(component.render(100).join("\n"), /▸ ▾ main · one/, "removed file falls back to its parent header");
	component.handleInput("o");
	assert.equal(opened.length, 1, "header must not open a file");
	component.update([]);
	await settle();
	assert.match(component.render(100).join("\n"), /No dirty worktrees/);
});

test("accordion selection scrolls flattened rows and diff scrolling does not open the editor", async () => {
	let opened = 0;
	const component = new WorktreeChangesView([{ root: "/long/root", branch: "main", model: changesModel(Array.from({ length: 20 }, (_, index) => file(`file-${String(index).padStart(2, "0")}.ts`, 1, 0))) }], {
		theme: plainTheme, rows: 8,
		loadDiff: async () => Array.from({ length: 30 }, (_, index) => `+line ${index}`).join("\n"),
		onOpen() { opened++; }, onClose() {}, onRefresh() {}, requestRender() {},
	});
	component.handleInput(" ");
	for (let index = 0; index < 20; index++) component.handleInput("j");
	await settle();
	assert.match(component.render(100).join("\n"), /▸   M file-19.ts/);
	component.handleInput("\x0a");
	assert.match(component.render(100)[1], /\+line 5/);
	component.handleInput("\x0b");
	assert.match(component.render(100)[1], /\+line 0/);
	assert.equal(opened, 0);
	for (const width of [1, 8, 20, 40, 100]) {
		for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

const statusCases = [
	[CHANGE_STATUS.MODIFIED, "M", 2, 1],
	[CHANGE_STATUS.ADDED, "A", 3, 0],
	[CHANGE_STATUS.DELETED, "D", 0, 4],
	[CHANGE_STATUS.RENAMED, "R", 0, 0],
	[CHANGE_STATUS.UNTRACKED, "??", 5, 0],
] as const;

for (const [status, code, added, deleted] of statusCases) {
	test(`both file lists render ${status} with colored signed counts`, () => {
		const theme = {
			fg(role: string, text: string) {
				const color = role === "success" ? 32 : role === "error" ? 31 : 36;
				return `\x1b[${color}m${text}\x1b[39m`;
			},
		};
		const target = file("a.ts", added, deleted, status);
		const accordion = new WorktreeChangesView([{ root: "/main", branch: "main", model: changesModel([target]) }], {
			theme, rows: 10, loadDiff: async () => "", onOpen() {}, onClose() {}, onRefresh() {}, requestRender() {},
		});
		accordion.handleInput("\r");
		const standalone = view({ theme }, [target]).view;
		for (const selected of [false, true]) {
			if (selected) accordion.handleInput("j");
			for (const [component, row] of [[accordion, 2], [standalone, 1]] as const) {
				const line = component.render(100)[row];
				assert.ok(stripAnsi(line).includes(`${code} a.ts  +${added} -${deleted}`));
				assert.ok(line.includes(`\x1b[32m+${added}\x1b[39m`), "addition uses success color");
				assert.ok(line.includes(`\x1b[31m-${deleted}\x1b[39m`), "deletion uses error color");
				for (const width of [8, 20, 40, 100]) {
					for (const rendered of component.render(width)) assert.ok(visibleWidth(rendered) <= width);
				}
			}
		}
	});
}

test("colorDiff drops git headers and colors hunks, additions, and removals by role", () => {
	const lines = colorDiff(DIFF_A, taggedTheme);
	assert.deepEqual(lines, [
		"<customMessageLabel>@@ -1,2 +1,3 @@</customMessageLabel>",
		"<toolDiffContext> const a = 1;</toolDiffContext>",
		"<toolDiffRemoved>-const b = 2;</toolDiffRemoved>",
		"<toolDiffAdded>+const b = 3;</toolDiffAdded>",
		"<toolDiffAdded>+const c = 4;</toolDiffAdded>",
	]);
});

test("ChangesView renders a framed two-pane layout at the requested size", async () => {
	const { view: component } = view();
	await settle();
	const lines = component.render(80);
	assert.equal(lines.length, 12);
	for (const line of lines) assert.equal(visibleWidth(line), 80, `"${stripAnsi(line)}" is not 80 wide`);
	const plain = lines.map(stripAnsi);
	assert.match(plain[0], /^╭─ ✎ Changes · 2 files · \+12 −1 ─+╮$/);
	assert.match(plain[1], /^│ ▸ M lib\/a\.ts +\+2 -1 +│ @@ -1,2 \+1,3 @@ +│$/);
	assert.match(plain[2], /^│   A lib\/b\.ts +\+10 -0 +│  const a = 1; +│$/);
	assert.match(plain[11], /^╰─+╯$/);
	assert.match(plain[10], /j\/k file .* o open in editor .* esc close/);
});

test("ChangesView loads the selected diff lazily and moves with j/k and arrows", async () => {
	const { view: component, calls, events } = view();
	await settle();
	assert.deepEqual(calls, ["lib/a.ts"]);
	component.handleInput("j");
	await settle();
	assert.deepEqual(calls, ["lib/a.ts", "lib/b.ts"]);
	assert.match(stripAnsi(component.render(80)[2]), /^│ ▸ A lib\/b\.ts/);
	component.handleInput("\x1b[A");
	assert.match(stripAnsi(component.render(80)[1]), /^│ ▸ M lib\/a\.ts/);
	component.handleInput("k");
	assert.match(stripAnsi(component.render(80)[1]), /^│ ▸ M lib\/a\.ts/);
	assert.ok(events.filter((event) => event === "render").length >= 2);
});

test("ChangesView scrolls the diff pane and shows an empty state for files without a diff", async () => {
	const long = Array.from({ length: 40 }, (_, index) => `+line ${index}`).join("\n");
	const { view: component } = view({ async loadDiff() { return `@@ -0,0 +1,40 @@\n${long}`; } });
	await settle();
	component.handleInput("\x1b[6~");
	const plain = component.render(80).map(stripAnsi);
	assert.doesNotMatch(plain[1], /@@/);
	assert.match(plain[1], /\+line \d+/);
	component.handleInput("\x0b");
	assert.match(stripAnsi(component.render(80)[1]), /@@/, "ctrl+k scrolls back to the top");
	component.handleInput("\x0a");
	assert.doesNotMatch(stripAnsi(component.render(80)[1]), /@@/, "ctrl+j scrolls a page down");

	const empty = view({ async loadDiff() { return ""; } });
	await settle();
	assert.match(stripAnsi(empty.view.render(80)[1]), /no diff for this file/);
});

test("ChangesView opens the selected file and closes on escape or q", async () => {
	const { view: component, events } = view();
	await settle();
	component.handleInput("o");
	assert.ok(events.includes("open:lib/a.ts"));
	component.handleInput("\x1b");
	component.handleInput("q");
	assert.equal(events.filter((event) => event === "close").length, 2);
});

// H1 (odd/tasks/usage-click-and-changes-attribution.md): the same shared
// hover role every other clickable surface uses, and it never overrides the
// already-selected row's own role.
test("ChangesView paints the shared hover role over an unselected file row, never the selected one", async () => {
	const { view: component } = view({ theme: taggedTheme });
	await settle();
	component.render(80);
	// Row y=1 is the selected file (lib/a.ts, index 0); row y=2 is lib/b.ts.
	const hoverOther = component.handleMouse(mouseButton("move", "none", 3, 2, 12));
	assert.deepEqual(hoverOther, { handled: true, render: true });
	assert.match(component.render(80)[2]!, /<warning>[^<]*lib\/b\.ts/, "the hovered, unselected row paints the shared hover role");
	assert.doesNotMatch(component.render(80)[1]!, /<warning>/, "the selected row keeps its own role instead");

	const hoverSelected = component.handleMouse(mouseButton("move", "none", 3, 1, 12));
	assert.deepEqual(hoverSelected, { handled: true, render: true });
	assert.doesNotMatch(component.render(80)[1]!, /<warning>/, "hovering the selected row still never paints the hover role");
	assert.doesNotMatch(component.render(80)[2]!, /<warning>/, "leaving lib/b.ts clears its hover paint");

	const left = component.handleMouse(mouseButton("move", "none", 60, 1, 12)); // outside the list pane entirely
	assert.deepEqual(left, { handled: true, render: true });
	assert.doesNotMatch(component.render(80).join("\n"), /<warning>/, "moving off the list clears any hover");
});

test("ChangesView click selects a file without opening it", async () => {
	const { view: component, events } = view();
	await settle();
	component.render(80);
	component.handleMouse(mouse("press", 3, 2));
	component.handleMouse(mouse("release", 3, 2));
	component.handleMouse(mouse("click", 3, 2));
	await settle();
	assert.match(stripAnsi(component.render(80)[2]), /^│ ▸ A lib\/b\.ts/);
	assert.deepEqual(events.filter((event) => event.startsWith("open:")), []);
});

test("ChangesView receives native fullscreen press and release as a click", async () => {
	let onInput: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(input) { onInput = input; }, stop() {}, async drainInput() {}, write() {}, get columns() { return 80; }, get rows() { return 12; }, get kittyProtocolActive() { return false; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const { view: component, events } = view();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	tui.setLayoutRoot(component);
	tui.start();
	tui.renderNow(true);
	try {
		onInput?.("\x1b[<0;4;3M");
		onInput?.("\x1b[<0;4;3m");
		assert.match(stripAnsi(component.render(80)[2]), /^│ ▸ A lib\/b\.ts/);
		assert.deepEqual(events.filter((event) => event.startsWith("open:")), []);
	} finally {
		tui.stop();
	}
});

test("ChangesView rebuilds pointer geometry when its overlay height changes", async () => {
	let rows = 12;
	const { view: component } = view({ rows: () => rows });
	await settle();
	component.render(80);
	rows = 8;
	assert.deepEqual(component.handleMouse(mouse("click", 3, 2, undefined, 8)), { handled: true, render: false });
	component.render(80);
	assert.deepEqual(component.handleMouse(mouse("click", 3, 2, undefined, 8)), { handled: true, render: true });
	assert.match(stripAnsi(component.render(80)[2]), /^│ ▸ A lib\/b\.ts/);
});

test("ChangesView scrolls the file list and diff independently, ignores hover, and clears stale pointer layouts", async () => {
	const files = Array.from({ length: 8 }, (_, index) => file(`lib/${index}.ts`, 1, 0));
	const long = Array.from({ length: 20 }, (_, index) => `+line ${index}`).join("\n");
	const { view: component, events } = view({ rows: 8, async loadDiff() { return `@@ -0,0 +1,20 @@\n${long}`; } }, files);
	await settle();
	component.render(80);
	component.handleMouse(mouse("move", 3, 2, undefined, 8));
	assert.match(stripAnsi(component.render(80)[1]), /^│ ▸ M lib\/0\.ts/);
	assert.deepEqual(events.filter((event) => event.startsWith("open:")), []);

	assert.deepEqual(component.handleMouse(mouse("wheel", 3, 1, 2, 8)), { handled: true, render: true });
	assert.match(stripAnsi(component.render(80)[1]), /^│   M lib\/2\.ts/);
	component.update(changesModel(files));
	assert.match(stripAnsi(component.render(80)[1]), /^│   M lib\/2\.ts/, "an unchanged live refresh preserves the independently scrolled file viewport");
	assert.deepEqual(component.handleMouse(mouse("wheel", 50, 1, 2, 8)), { handled: true, render: true });
	assert.doesNotMatch(stripAnsi(component.render(80)[1]), /@@/);
	assert.deepEqual(component.handleMouse(mouse("wheel", 50, 1, -100, 8)), { handled: true, render: true });
	assert.deepEqual(component.handleMouse(mouse("wheel", 50, 1, -1, 8)), { handled: true, render: false });

	component.update(changesModel([file("lib/new.ts", 1, 0)]));
	assert.deepEqual(component.handleMouse(mouse("click", 3, 1, undefined, 8)), { handled: true, render: false });
	component.render(80);
	component.dispose();
	assert.deepEqual(component.handleMouse(mouse("click", 3, 1, undefined, 8)), { handled: true, render: false });
});

test("ChangesView keeps keyboard selection visible after file-list scrolling", async () => {
	const files = Array.from({ length: 8 }, (_, index) => file(`lib/${index}.ts`, 1, 0));
	const { view: component } = view({ rows: 8 }, files);
	await settle();
	component.render(80);
	component.handleMouse(mouse("wheel", 3, 1, 2, 8));
	component.handleInput("j");
	assert.match(stripAnsi(component.render(80)[1]), /^│ ▸ M lib\/1\.ts/);
	component.update(changesModel(files.slice(0, 3)));
	assert.match(stripAnsi(component.render(80)[1]), /^│   M lib\/0\.ts/);
});

test("ChangesView.update keeps the selected file, reloads moved diffs, and survives an empty tree", async () => {
	const { view: component, calls } = view();
	await settle();
	component.handleInput("j");
	await settle();
	assert.deepEqual(calls, ["lib/a.ts", "lib/b.ts"]);

	component.update(changesModel([file("lib/a.ts", 5, 1), file("lib/b.ts", 10, 0, CHANGE_STATUS.ADDED), file("lib/c.ts", 1, 0)]));
	await settle();
	assert.match(stripAnsi(component.render(80)[2]), /^│ ▸ A lib\/b\.ts/);
	assert.deepEqual(calls, ["lib/a.ts", "lib/b.ts"], "unchanged selected file must not reload");
	component.handleInput("k");
	await settle();
	assert.deepEqual(calls, ["lib/a.ts", "lib/b.ts", "lib/a.ts"], "moved counts must reload the diff");

	component.update(changesModel([]));
	const plain = component.render(80).map(stripAnsi);
	assert.match(plain[0], /0 files · \+0 −0/);
	assert.match(plain[1], /working tree is clean/);
	component.handleInput("j");
	component.handleInput("o");
});
