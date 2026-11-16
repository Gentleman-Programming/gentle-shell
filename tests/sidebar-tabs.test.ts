import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ScrollView, VStack, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderLayoutFrame, type LayoutBox } from "@earendil-works/pi-tui/dist/layout.js";
import { installSidebar, invalidateSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarHeader, sidebarPart, sidebarStatusBar, type SidebarRail } from "../lib/shell-sidebar.ts";
import { chromeSurface, setChromeSurface } from "../lib/shell-panel.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";

const theme = {
	fg: (role: string, text: string) => `\x1b[${role === "accent" ? 35 : role === "border" ? 34 : 37}m${text}\x1b[39m`,
	bold: (text: string) => text,
	bg: (_role: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m`,
};
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, "");
function fixture(t: TestContext, enabled = true, header: "top" | "split" | "below-input" = "split", density: "comfortable" | "compact" | "minimal" = "comfortable", railTheme = theme) {
	const root = new VStack([{ component: { render: () => ["TRANSCRIPT"], invalidate() {} }, basis: 0, grow: 1 }]);
	const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	const received: Array<[string, TuiMouseEvent]> = [];
	let mainRenders = 0;
	const main: SidebarRail = {
		digest: () => "stable", surface: "panel",
		render: () => { mainRenders++; return ["▾ TODOS  ctrl+shift+t  1/2", "  task", "▾ STATS  profile test", "  cost"]; },
		cardGroups: () => ({ groups: [{ start: 0, end: 2 }, { start: 2, end: 4 }] }),
		invalidate() {}, handleMouse(event) { received.push(["main", event]); return { handled: true }; },
	};
	let git: SidebarRail | undefined = {
		surface: "panel", render: () => ["▾ FIXTURE", "  git body"], invalidate() {},
		handleMouse(event) { received.push(["git", event]); return { handled: true }; },
	};
	sidebarPart(tui, "todo", main);
	sidebarHeader(tui, { render: () => ["TITLE"], invalidate() {} });
	sidebarStatusBar(tui, { render: () => ["STATUS profile test"], invalidate() {} });
	t.after(installSidebar(tui, railTheme, () => "auto", () => header, () => density, () => enabled && git ? [{ id: "main", label: "MAIN" }, { id: "git", label: "GIT", rail: git }] : undefined));
	const frame = () => renderLayoutFrame(root, host.terminal.columns, 20, () => {});
	const boxes = (box: LayoutBox): LayoutBox[] => [box, ...box.children.flatMap(boxes)];
	const scroll = () => boxes(frame().root).find(box => box.component instanceof ScrollView)!.component as ScrollView;
	const navigation = () => {
		const leaf = boxes(frame().root).find(box => box.children.length === 0 && /^(\[MAIN\]| MAIN )/.test(strip(box.component.render(box.rect.width)[0] ?? "")));
		assert.ok(leaf, "the layout exposes a navigation leaf");
		return leaf.component;
	};
	const click = (component: Component, x: number, y = 0) => component.handleMouse?.({ type: "click", button: "left", x, y, screenX: 110 + x, screenY: y, width: 50, height: 16, shift: false, alt: false, ctrl: false });
	return { frame, scroll, navigation, click, received, host, mainRenders: () => mainRenders, removeGit: () => { git = undefined; } };
}

test("card title hits follow float geometry when themes share foregrounds but differ in background support", t => {
 const previous = [chromeSurface(), cardStyle()] as const;
 t.after(() => { setChromeSurface(previous[0]); setCardStyle(previous[1]); });
 setChromeSurface("transparent"); setCardStyle(CARD_STYLE.FLOAT);
 const unpainted = fixture(t, false, "split", "comfortable", { ...theme, bg: (_role, text) => text });
 const first = unpainted.scroll();
 let row = first.render(50).map(strip).findIndex(line => line.includes("TODOS"));
 assert.equal(unpainted.click(first, 6, row)?.handled, true);
 const painted = fixture(t, false);
 const second = painted.scroll();
 row = second.render(50).map(strip).findIndex(line => line.includes("TODOS"));
 assert.equal(painted.click(second, 6, row)?.handled, true);
 assert.equal(painted.received.at(-1)?.[1].y, 0);
});

test("destination lifecycle follows selection, resize and disposal", t => {
 const root = new VStack([{ component: { render: () => ["TRANSCRIPT"], invalidate() {} }, basis: 0, grow: 1 }]);
 const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
 const tui = host as unknown as TUI;
 sidebarPart(tui, "todo", { render: () => ["▾ MAIN"], invalidate() {} });
 const events: boolean[] = [];
 const rail: SidebarRail = { render: () => ["▾ HISTORY"], invalidate() {} };
 const dispose = installSidebar(tui, theme, () => "auto", () => "split", () => "comfortable", () => [{ id: "main", label: "MAIN" }, { id: "git", label: "GIT", rail }], (id) => events.push(id === "git"));
 t.after(dispose);
 const frame = () => renderLayoutFrame(root, host.terminal.columns, 20, () => {});
 const boxes = (box: LayoutBox): LayoutBox[] => [box, ...box.children.flatMap(boxes)];
 const first = frame();
 const nav = boxes(first.root).find(box => strip(box.component.render(box.rect.width)[0] ?? "").includes("[MAIN]"))!.component;
 nav.handleMouse?.({ type: "click", button: "left", x: 10, y: 0, screenX: 120, screenY: 0, width: 50, height: 3, shift: false, alt: false, ctrl: false });
 frame(); assert.equal(events.at(-1), true);
 host.terminal.columns = 139; frame(); assert.equal(events.at(-1), false);
 dispose();
});

test("inactive MAIN sections do no digest or render work and refresh when restored", t => {
	const root = new VStack([{ component: { render: () => ["TRANSCRIPT"], invalidate() {} }, basis: 0, grow: 1 }]);
	const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	let version = 0, digests = 0, renders = 0, headerDigests = 0;
	sidebarPart(tui, "todo", { digest: () => { digests++; return String(version); }, render: () => { renders++; return [`▾ MAIN ${version}`]; }, invalidate() {} });
	sidebarHeader(tui, { digest: () => { headerDigests++; return String(version); }, render: () => [`HEADER ${version}`], invalidate() {} });
	const other: SidebarRail = { render: () => ["▾ TREE CONTENT"], invalidate() {} };
	let items: Array<{ id: string; label: string; rail?: SidebarRail }> = [];
	t.after(installSidebar(tui, theme, () => "auto", () => "split", () => "comfortable", () => items));
	const text = () => renderLayoutFrame(root, 160, 20, () => {}).lines.map(strip).join("\n");
	assert.match(text(), /MAIN 0/);
	items = [{ id: "tree", label: "TREE", rail: other }];
	assert.match(text(), /TREE CONTENT/);
	const before = { digests, renders, headerDigests };
	version = 1; invalidateSidebar(tui);
	assert.match(text(), /HEADER 1/); assert.match(text(), /TREE CONTENT/);
	assert.equal(digests, before.digests); assert.equal(renders, before.renders);
	assert.ok(headerDigests > before.headerDigests, "shared header stays live");
	items = [];
	assert.match(text(), /MAIN 1/);
	assert.ok(digests > before.digests); assert.ok(renders > before.renders);
});

test("generic single destination renders without navigation and zero destinations falls back to MAIN", t => {
	const root = new VStack([{ component: { render: () => ["TRANSCRIPT"], invalidate() {} }, basis: 0, grow: 1 }]);
	const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	sidebarPart(tui, "todo", { render: () => ["▾ MAIN CONTENT"], invalidate() {} });
	const other: SidebarRail = { render: () => ["▾ TREE CONTENT"], invalidate() {} };
	let destinations = [{ id: "tree", label: "TREE", rail: other }];
	t.after(installSidebar(tui, theme, () => "auto", () => "split", () => "comfortable", () => destinations));
	const text = () => renderLayoutFrame(root, 160, 20, () => {}).lines.map(strip).join("\n");
	assert.match(text(), /TREE CONTENT/);
	assert.doesNotMatch(text(), /MAIN CONTENT|\[TREE\]/);
	destinations = [];
	assert.match(text(), /MAIN CONTENT/);
	assert.doesNotMatch(text(), /TREE CONTENT/);
});

test("generic destinations retain ordering and only active content is evaluated", t => {
	const root = new VStack([{ component: { render: () => ["TRANSCRIPT"], invalidate() {} }, basis: 0, grow: 1 }]);
	const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	const counts = { treeDigest: 0, treeRender: 0, statsDigest: 0, statsRender: 0 };
	const tree: SidebarRail = { digest: () => { counts.treeDigest++; return "tree"; }, render: () => { counts.treeRender++; return ["▾ TREE BODY"]; }, invalidate() {} };
	const stats: SidebarRail = { digest: () => { counts.statsDigest++; return "stats"; }, render: () => { counts.statsRender++; return ["▾ STATS BODY"]; }, invalidate() {} };
	let items = [{ id: "tree", label: "TREE", rail: tree }, { id: "stats", label: "STATS", rail: stats }];
	t.after(installSidebar(tui, theme, () => "auto", () => "split", () => "comfortable", () => items));
	const frame = () => renderLayoutFrame(root, 160, 20, () => {});
	const boxes = (box: LayoutBox): LayoutBox[] => [box, ...box.children.flatMap(boxes)];
	const initial = frame();
	assert.match(initial.lines.map(strip).join("\n"), /\[TREE\]\s+STATS/);
	assert.match(initial.lines.map(strip).join("\n"), /TREE BODY/);
	assert.deepEqual([counts.statsDigest, counts.statsRender], [0, 0]);
	const nav = boxes(initial.root).find(box => strip(box.component.render(box.rect.width)[0] ?? "").includes("[TREE]"))!.component;
	const click = (x: number) => nav.handleMouse?.({ type: "click", button: "left", x, y: 0, screenX: 110 + x, screenY: 0, width: 50, height: 3, shift: false, alt: false, ctrl: false });
	assert.equal(click(11)?.handled, true);
	assert.match(frame().lines.map(strip).join("\n"), /STATS BODY/);
	const before = { ...counts }; frame();
	assert.equal(counts.treeDigest, before.treeDigest); assert.equal(counts.treeRender, before.treeRender);
	const scroll = boxes(frame().root).find(box => box.component instanceof ScrollView)!.component as ScrollView;
	scroll.updateLayout(40, 2, () => {});
	items = [items[1]!, items[0]!];
	assert.equal(scroll.handleMouse({ type: "wheel", button: "none", wheelDelta: 3, x: 1, y: 0, screenX: 111, screenY: 0, width: 50, height: 2, shift: false, alt: false, ctrl: false })?.handled, true);
	assert.equal(scroll.scrollTop, 0, "stale wheel cannot scroll the previous destination");
	assert.equal(click(2), undefined, "stale navigation is inert before repaint");
	assert.match(frame().lines.map(strip).join("\n"), /\[STATS\]\s+TREE/);
	items = [items[1]!];
	assert.equal(click(2), undefined);
	assert.match(frame().lines.map(strip).join("\n"), /TREE BODY/);
});

test("six compact destination labels fit the rail and every tab remains selectable", t => {
	const root = new VStack([{ component: { render: () => ["TRANSCRIPT"], invalidate() {} }, basis: 0, grow: 1 }]);
	const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	sidebarPart(tui, "todo", { render: () => ["▾ MAIN BODY"], invalidate() {} });
	const labels = ["MAIN", "PROF", "MEM", "STAT", "GIT", "TREE"];
	const items = labels.map((label, index) => ({ id: label.toLowerCase(), label, ...(index ? { rail: { render: () => [`▾ ${label} BODY`], invalidate() {} } } : {}) }));
	t.after(installSidebar(tui, theme, () => "auto", () => "split", () => "comfortable", () => items));
	const boxes = (box: LayoutBox): LayoutBox[] => [box, ...box.children.flatMap(boxes)];
	const frame = () => renderLayoutFrame(root, 160, 20, () => {});
	for (const label of labels) {
		const current = frame();
		const nav = boxes(current.root).find(box => box.children.length === 0 && strip(box.component.render(box.rect.width)[0] ?? "").includes("["));
		assert.ok(nav, "navigation remains visible");
		const rows = nav.component.render(nav.rect.width); const plain = rows.map(strip);
		assert.equal(plain[0]!.length, 50); assert.equal(plain[1]!.length, 50);
		const position = plain[0]!.indexOf(label); assert.ok(position >= 0, label);
		assert.equal(nav.component.handleMouse?.({ type: "click", button: "left", x: position, y: 0, screenX: nav.rect.x + position, screenY: nav.rect.y, width: nav.rect.width, height: nav.rect.height, shift: false, alt: false, ctrl: false })?.handled, true);
		const next = frame(); const nextNav = boxes(next.root).find(box => box.children.length === 0 && strip(box.component.render(box.rect.width)[0] ?? "").includes(`[${label}]`));
		assert.ok(nextNav); const selected = nextNav.component.render(50);
		assert.equal(selected.length, 3, "navigation occupies one label row, divider, and gap");
		const start = strip(selected[0]!).indexOf(`[${label}]`);
		const accent = selected[1]!.indexOf(`\x1b[35m${"─".repeat(label.length + 2)}\x1b[39m`);
		assert.ok(accent >= 0);
		assert.equal(strip(selected[1]!.slice(0, accent)).length, start, "divider accent aligns with selected label");
		assert.equal(strip(selected[1]!).length, 50); assert.ok(start >= 0);
		assert.match(strip(next.lines.join("\n")), new RegExp(`${label} BODY`));
	}
});

test("internal navigation paints prior tab spacing, selected accent, divider and breathing row on the panel", t => {
	const previous = chromeSurface(); t.after(() => setChromeSurface(previous)); setChromeSurface("tinted");
	const f = fixture(t);
	const rows = f.navigation().render(50);
	assert.deepEqual(rows.map(strip), ["[MAIN]    GIT ".padEnd(50), "─".repeat(50), " ".repeat(50)]);
	assert.match(rows[0]!, /\x1b\[35m\[MAIN\]/);
	assert.match(rows[1]!, /\x1b\[35m──────\x1b\[39m/);
	for (const row of rows) assert.match(row, /\x1b\[48;5;22m/);
	assert.equal(f.frame().lines.length, 20);
});

test("tab clicks switch destinations, reset scroll and reject previous content before repaint", t => {
	const f = fixture(t);
	const navigation = f.navigation();
	const scroll = f.scroll();
	const rows = scroll.render(50);
	const y = rows.findIndex(row => row.includes("task"));
	assert.equal(f.click(scroll, 4, y)?.handled, true);
	assert.equal(f.received.at(-1)?.[0], "main");
	assert.equal(f.click(navigation, 7), undefined, "inter-tab spacing is inert");
	assert.equal(f.click(navigation, 10, 1), undefined, "divider is inert");
	scroll.updateLayout(40, 10, () => {});
	scroll.scrollBy(5);
	assert.equal(scroll.scrollTop, 5, "control actually scrolled before switching");
	assert.equal(f.click(navigation, 10)?.handled, true);
	assert.equal(f.click(scroll, 4, y), undefined, "old MAIN hit map cannot dispatch");
	const switched = f.frame().lines.join("\n");
	assert.match(switched, /git body/); assert.doesNotMatch(switched, /ctrl\+shift\+t|cost/);
	assert.match(switched, /STATUS profile test/);
	assert.equal(scroll.scrollTop, 0);
	const gitY = scroll.render(50).findIndex(row => row.includes("git body"));
	assert.equal(f.click(scroll, 4, gitY)?.handled, true);
	assert.equal(f.received.at(-1)?.[0], "git");
	assert.equal(f.click(navigation, 2)?.handled, true);
	assert.equal(f.click(scroll, 4, gitY), undefined, "old GIT hit map cannot dispatch");
	assert.match(f.frame().lines.join("\n"), /ctrl\+shift\+t/);
	assert.equal(f.mainRenders(), 1, "switching preserves the MAIN section cache");
});

test("provider removal and resize make cached navigation and GIT hits inert, then restore MAIN", t => {
	const f = fixture(t); const nav = f.navigation(); f.click(nav, 10);
	const scroll = f.scroll(); const y = scroll.render(50).findIndex(row => row.includes("git body"));
	f.removeGit();
	assert.equal(f.click(scroll, 4, y), undefined);
	assert.equal(f.click(nav, 10), undefined);
	assert.doesNotMatch(f.frame().lines.join("\n"), /GIT|FIXTURE/);
	assert.match(f.frame().lines.join("\n"), /TODOS/);
	f.host.terminal.columns = 139;
	assert.equal(f.click(nav, 2), undefined);
});

test("default-off provider preserves single destination frame and geometry without a GIT placeholder", t => {
	const f = fixture(t, false);
	const frame = f.frame();
	assert.doesNotMatch(frame.lines.join("\n"), /MAIN|GIT|FIXTURE/);
	assert.match(frame.lines.join("\n"), /TODOS/);
	assert.equal(frame.root.children[1]!.children[1]!.component instanceof ScrollView, true);
});

test("navigation preserves surfaces and stays absent below the rail breakpoint", t => {
	const previous = [chromeSurface(), cardStyle()] as const;
	t.after(() => { setChromeSurface(previous[0]); setCardStyle(previous[1]); });
	for (const surface of ["tinted", "transparent"] as const) for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		setChromeSurface(surface); setCardStyle(style);
		const f = fixture(t);
		assert.match(f.frame().lines.map(strip).join("\n"), /\[MAIN\]/);
		f.host.terminal.columns = 139;
		assert.doesNotMatch(f.frame().lines.map(strip).join("\n"), /\[MAIN\]|GIT/);
	}
});

test("navigation leaves cardGroups, whole-row folding and float gaps intact across header placements and densities", t => {
	const previous = [chromeSurface(), cardStyle()] as const;
	t.after(() => { setChromeSurface(previous[0]); setCardStyle(previous[1]); });
	setChromeSurface("transparent"); setCardStyle(CARD_STYLE.FLOAT);
	for (const header of ["top", "split", "below-input"] as const) for (const density of ["comfortable", "compact", "minimal"] as const) {
		const f = fixture(t, true, header, density);
		const frame = f.frame(); const text = frame.lines.map(strip);
		const navY = text.findIndex(row => row.includes("[MAIN]"));
		assert.equal(navY, header === "below-input" ? 0 : 1);
		assert.equal(text[navY + 2]!.slice(110).trim(), "", "navigation keeps a breathing row");
		assert.match(text[navY + 4]!, /TODOS/, "first float title follows the navigation and its card padding");
		if (header === "top") assert.match(text[0]!, /^TITLE/, "the existing full-width top header remains above the rail");
		const scroll = f.scroll(); const rows = scroll.render(50); const plain = rows.map(strip);
		for (const [title, local] of [["TODOS", 0], ["STATS", 2]] as const) {
			const y = plain.findIndex(row => row.includes(title));
			assert.equal(f.click(scroll, 49, y)?.handled, true, `${header}/${density}: whole title row`);
			assert.equal(f.received.at(-1)?.[1].y, local);
			if (title === "STATS") assert.equal(plain[y - 2]!.trim(), "", "float cards keep an unpainted separator");
		}
		assert.match(text.at(-1)!, /STATUS profile test/);
		assert.equal(frame.lines.length, 20);
	}
});
