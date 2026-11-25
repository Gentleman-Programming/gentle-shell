import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { writeProfileCard } from "../lib/profile-card-policy.ts";
import { createProfileCardOwner, mountProfileCard, PROFILE_CARD_SIDEBAR_KEY, runProfileCardShortcut } from "../lib/profile-card-sidebar.ts";
import { renderProfileCardSection, type ProfileCardItem } from "../lib/profile-card-widget.ts";
import { HOVER_ROLE } from "../lib/shell-hover.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
// A theme that tags every painted span with its role, so hover paint is observable.
const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text };
const plain = (line: string) => line.replace(/<\/?[a-zA-Z]+>/g, "");
const item = (name: string, markers: Partial<ProfileCardItem> = {}): ProfileCardItem => ({ name, active: false, pinned: false, session: false, ...markers });

function fixture(t: { after(fn: () => void): void }, profiles: ProfileCardItem[]) {
	const home = mkdtempSync(join(tmpdir(), "profile-card-collapse-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: () => ({ type: "vstack", entries: [] }) };
	let renders = 0;
	const host = { mode: "fullscreen", terminal: { columns: 140 }, layoutRoot: root, requestRender() { renders++; } };
	const tui = host as unknown as TUI;
	const used: string[] = [];
	const owner = createProfileCardOwner({ loadItems: () => profiles, configHome: () => home, onUse: (name) => { used.push(name); } });
	const part = mountProfileCard(tui, theme, owner);
	t.after(() => part.dispose());
	const rail = sidebarState(tui).parts.get(PROFILE_CARD_SIDEBAR_KEY)!;
	writeProfileCard(true, { gentlePiConfigHome: home });
	owner.refreshVisibility();
	return { owner, rail, used, renders: () => renders };
}
const mouse = (type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({ type, button: type === "move" ? "none" : "left", x, y, screenX: x, screenY: y, width: 48, height: 3, shift: false, alt: false, ctrl: false, ...extra }) as TuiMouseEvent;
const lines = (rail: { render(width: number): readonly string[] }) => rail.render(48).map(plain).map((line) => line.trimEnd());

test("hovering the title row paints the shared hover role; moving to the body or leaving clears it", (t) => {
	const f = fixture(t, [item("alpha"), item("beta")]);
	assert.ok(!f.rail.render(48)[0]!.includes(`<${HOVER_ROLE}>`), "idle header is not highlighted");
	const digestIdle = f.rail.digest!();
	assert.deepEqual(f.rail.handleMouse!(mouse("move", 5, 0)), { handled: true, render: true });
	assert.ok(f.rail.render(48)[0]!.includes(`<${HOVER_ROLE}>`), "hovered header uses the hover role");
	assert.notEqual(f.rail.digest!(), digestIdle, "hover is part of the digest so the rail repaints");
	assert.deepEqual(f.rail.handleMouse!(mouse("move", 6, 0)), { handled: true }, "same hover state asks for no repaint");
	const before = f.renders();
	assert.deepEqual(f.rail.handleMouse!(mouse("move", 5, 1)), { handled: true }, "leaving the title clears the hover through a repaint request");
	assert.ok(f.renders() > before);
	assert.ok(!f.rail.render(48)[0]!.includes(`<${HOVER_ROLE}>`), "a body row is not the header control");
	f.rail.handleMouse!(mouse("move", 5, 0));
	assert.ok(f.rail.render(48)[0]!.includes(`<${HOVER_ROLE}>`));
	f.rail.invalidate?.();
	assert.ok(!f.rail.render(48)[0]!.includes(`<${HOVER_ROLE}>`), "invalidate clears the hover");
});

test("a left click on the title row collapses to the header only and a second click expands", (t) => {
	const f = fixture(t, [item("alpha"), item("beta", { active: true })]);
	assert.equal(lines(f.rail).length, 3);
	const digestOpen = f.rail.digest!();
	assert.deepEqual(f.rail.handleMouse!(mouse("click", 3, 0)), { handled: true, render: true });
	assert.equal(f.owner.collapsed(), true);
	assert.ok(f.renders() > 0, "a repaint is requested");
	const collapsed = lines(f.rail);
	assert.equal(collapsed.length, 1, "only the header remains");
	assert.match(collapsed[0]!, /▸ PROFILE/);
	assert.doesNotMatch(collapsed.join("\n"), /◀|▶|✓/);
	assert.notEqual(f.rail.digest!(), digestOpen, "collapse is part of the digest");
	assert.equal(f.rail.handleMouse!(mouse("click", 0, 1)), undefined, "the hidden ◀ hit is gone");
	assert.equal(f.rail.handleMouse!(mouse("click", 47, 1)), undefined, "the hidden ▶ hit is gone");
	assert.equal(f.rail.handleMouse!(mouse("click", 2, 2)), undefined, "the hidden use hit is gone");
	assert.deepEqual(f.used, []);
	assert.equal(f.owner.shown()?.name, "beta", "collapsing keeps the shown profile");
	assert.deepEqual(f.rail.handleMouse!(mouse("click", 3, 0)), { handled: true, render: true });
	assert.equal(f.owner.collapsed(), false);
	const open = lines(f.rail);
	assert.equal(open.length, 3);
	assert.match(open[0]!, /▾ PROFILE/);
	assert.match(open[1]!, /◀ beta \(active\).*2\/2 ▶$/);
});

test("only a left click on the header toggles; other buttons and rows do not", (t) => {
	const f = fixture(t, [item("alpha"), item("beta")]);
	f.rail.render(48);
	assert.equal(f.rail.handleMouse!(mouse("click", 3, 0, { button: "right" })), undefined);
	assert.equal(f.rail.handleMouse!(mouse("press", 3, 0)), undefined);
	assert.equal(f.owner.collapsed(), false);
});

test("expanded body clicks and the shortcuts keep working; a collapsed card still reports its shortcuts", (t) => {
	const f = fixture(t, [item("alpha"), item("beta"), item("gamma")]);
	const prevX = 2;
	const nextX = 47;
	f.rail.render(48);
	f.rail.handleMouse!(mouse("click", nextX, 1));
	assert.equal(f.owner.shown()?.name, "beta");
	f.rail.handleMouse!(mouse("click", 3, 2));
	assert.deepEqual(f.used, ["beta"]);
	f.rail.handleMouse!(mouse("click", 3, 0));
	f.rail.handleMouse!(mouse("click", 3, 0));
	f.rail.render(48);
	f.rail.handleMouse!(mouse("click", prevX, 1));
	assert.equal(f.owner.shown()?.name, "alpha");
	const notes: string[] = [];
	runProfileCardShortcut(f.owner, "next", (message) => notes.push(message));
	assert.equal(f.owner.shown()?.name, "beta");
	assert.deepEqual(notes, []);
});

test("an empty card collapses to its header too", (t) => {
	const f = fixture(t, []);
	assert.equal(lines(f.rail).length, 2);
	f.rail.handleMouse!(mouse("click", 3, 0));
	assert.deepEqual(lines(f.rail).map((line) => line.replace(/\s+/g, " ")), ["▸ PROFILE"]);
});

test("a session boundary expands a collapsed card and the body is back", (t) => {
	const f = fixture(t, [item("alpha"), item("beta", { session: true })]);
	assert.equal(lines(f.rail).length, 3);
	f.rail.handleMouse!(mouse("click", 3, 0));
	assert.equal(f.owner.collapsed(), true);
	assert.equal(lines(f.rail).length, 1, "the card is folded to its header");
	const digestCollapsed = f.rail.digest!();
	// The collapse state is in memory for one session: a boundary starts expanded.
	f.owner.resetForSession();
	assert.equal(f.owner.collapsed(), false, "the collapse state does not survive the session boundary");
	assert.notEqual(f.rail.digest!(), digestCollapsed, "the boundary repaints the expanded card");
	const open = lines(f.rail);
	assert.equal(open.length, 3, "the body rows are back");
	assert.equal(f.owner.shown()?.name, "beta", "the boundary still restarts on the new session's profile");
});

test("a hidden card expands at the session boundary without reading a profile store", (t) => {
	const home = mkdtempSync(join(tmpdir(), "profile-card-collapse-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	let loads = 0;
	const owner = createProfileCardOwner({ loadItems: () => { loads++; return [item("alpha")]; }, configHome: () => home });
	// The card was shown and folded, then turned off: its collapse state is still set.
	writeProfileCard(true, { gentlePiConfigHome: home });
	owner.refreshVisibility();
	owner.toggleCollapsed();
	assert.equal(owner.collapsed(), true);
	writeProfileCard(false, { gentlePiConfigHome: home });
	owner.refreshVisibility();
	assert.equal(owner.visible(), false);
	const reads = loads;
	owner.resetForSession();
	assert.equal(loads, reads, "a hidden card never touches the profile stores");
	assert.equal(owner.collapsed(), false, "the boundary expands the card for the next session");
});

test("the pure renderer: collapsed drops body rows and hits, hovered highlights only the header", () => {
	const items = [item("alpha"), item("beta")];
	const collapsed = renderProfileCardSection(items, 0, theme, 48, { collapsed: true });
	assert.equal(collapsed.lines.length, 1);
	assert.deepEqual(collapsed.hits, []);
	const hovered = renderProfileCardSection(items, 0, theme, 48, { hovered: true });
	assert.ok(hovered.lines[0]!.includes(`<${HOVER_ROLE}>`));
	assert.ok(hovered.lines.slice(1).every((line) => !line.includes(`<${HOVER_ROLE}>`)));
	assert.equal(hovered.hits.length, 3);
	assert.deepEqual(renderProfileCardSection(items, 0, theme, 48), renderProfileCardSection(items, 0, theme, 48, {}), "no options keeps the previous output");
});
