import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { ScrollView } from "@earendil-works/pi-tui";
import { writeProfileCard } from "../lib/profile-card-policy.ts";
import { createProfileCardOwner, mountProfileCard, PROFILE_CARD_REFRESH_MS, PROFILE_CARD_SIDEBAR_KEY } from "../lib/profile-card-sidebar.ts";
import { PROFILE_CARD_EMPTY_HINT, type ProfileCardItem } from "../lib/profile-card-widget.ts";
import { setChromeSurface, chromeSurface } from "../lib/shell-panel.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const item = (name: string, markers: Partial<ProfileCardItem> = {}): ProfileCardItem => ({ name, active: false, pinned: false, session: false, ...markers });

function fixture(t: { after(fn: () => void): void }, profiles: ProfileCardItem[]) {
	const home = mkdtempSync(join(tmpdir(), "profile-card-sidebar-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: () => ({ type: "vstack", entries: [] }) };
	let renders = 0;
	const host = { mode: "fullscreen", terminal: { columns: 140 }, layoutRoot: root, requestRender() { renders++; } };
	const tui = host as unknown as TUI;
	const state = { profiles, used: [] as string[], now: 0 };
	const owner = createProfileCardOwner({ loadItems: () => state.profiles, configHome: () => home, now: () => state.now, onUse: (name) => { state.used.push(name); } });
	const part = mountProfileCard(tui, theme, owner);
	t.after(() => part.dispose());
	const rail = sidebarState(tui).parts.get(PROFILE_CARD_SIDEBAR_KEY)!;
	const setVisible = (visible: boolean) => { writeProfileCard(visible, { gentlePiConfigHome: home }); owner.refreshVisibility(); };
	return { home, host, tui, owner, part, rail, state, setVisible, renders: () => renders, root };
}
const click = (x: number, y: number): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 48, height: 3, shift: false, alt: false, ctrl: false });
const text = (rail: { render(width: number): string[] }) => rail.render(48).map((line) => line.trimEnd());

test("the card is registered under 'profiles', hidden by default and empty above the editor", (t) => {
	const f = fixture(t, [item("alpha"), item("beta")]);
	assert.equal(f.owner.visible(), false);
	assert.deepEqual(f.rail.render(48), []);
	assert.deepEqual(f.part.render(48), []);
	assert.equal(f.rail.digest?.(), f.owner.digest());
	f.setVisible(true);
	assert.deepEqual(f.part.render(48), [], "the above-editor copy never paints");
});

test("a profile-card settings event re-read turns the card on and off live", (t) => {
	const f = fixture(t, [item("alpha"), item("beta", { active: true })]);
	const hiddenDigest = f.rail.digest!();
	f.setVisible(true);
	assert.notEqual(f.rail.digest!(), hiddenDigest, "visibility is part of the digest");
	assert.ok(f.renders() > 0, "a repaint is requested");
	const lines = text(f.rail);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /PROFILE/);
	assert.match(lines[1]!, /◀ beta \(active\)\s+2\/2 ▶$/, "starts on the active profile");
	assert.match(lines[2]!, /✓ Use in session/);
	f.setVisible(false);
	assert.deepEqual(f.rail.render(48), []);
});

test("clicks on ◀ and ▶ wrap through the profiles and re-render", (t) => {
	const f = fixture(t, [item("alpha"), item("beta"), item("gamma")]);
	f.setVisible(true);
	const lines = text(f.rail);
	assert.match(lines[1]!, /◀ alpha\s+1\/3 ▶$/);
	const prevX = lines[1]!.indexOf("◀");
	const nextX = lines[1]!.indexOf("▶");
	const shown = () => text(f.rail)[1]!.match(/◀ (\w+)/)![1];
	const before = f.renders();
	assert.deepEqual(f.rail.handleMouse!(click(prevX, 1)), { handled: true, render: true });
	assert.equal(shown(), "gamma", "first → last");
	assert.ok(f.renders() > before);
	f.rail.handleMouse!(click(nextX, 1));
	assert.equal(shown(), "alpha", "last → first");
	f.rail.handleMouse!(click(nextX, 1));
	assert.equal(shown(), "beta");
	assert.deepEqual(f.state.used, [], "navigation never uses a profile");
	assert.equal(f.rail.handleMouse!({ ...click(prevX, 1), button: "right" }), undefined);
	assert.equal(f.rail.handleMouse!({ ...click(prevX, 1), type: "press" }), undefined);
	assert.deepEqual(f.rail.handleMouse!(click(prevX, 0)), { handled: true, render: true }, "the header folds the card (S7), it is not an arrow action");
	assert.deepEqual(f.rail.handleMouse!(click(prevX, 0)), { handled: true, render: true });
	assert.equal(f.rail.handleMouse!(click(prevX + 2, 1)), undefined, "the name is not an action");
	assert.equal(shown(), "beta");
});

test("a click on the use action calls the injected handler with the shown profile name", (t) => {
	const f = fixture(t, [item("alpha"), item("beta", { session: true })]);
	f.setVisible(true);
	assert.match(text(f.rail)[1]!, /◀ beta \(session\)/, "starts on the session profile");
	const useX = text(f.rail)[2]!.indexOf("✓");
	assert.deepEqual(f.rail.handleMouse!(click(useX, 2)), { handled: true, render: true });
	assert.deepEqual(f.state.used, ["beta"]);
	f.rail.handleMouse!(click(text(f.rail)[1]!.indexOf("▶"), 1));
	f.rail.handleMouse!(click(useX, 2));
	assert.deepEqual(f.state.used, ["beta", "alpha"]);
	f.setVisible(false);
	assert.equal(f.rail.handleMouse!(click(useX, 2)), undefined, "a hidden card answers nothing");
	assert.deepEqual(f.state.used, ["beta", "alpha"]);
});

test("the use handler can be replaced and is the single seam", (t) => {
	const f = fixture(t, [item("alpha")]);
	f.setVisible(true);
	const seen: string[] = [];
	f.owner.setUseHandler((name) => { seen.push(name); });
	assert.equal(f.owner.use(), true);
	assert.deepEqual(seen, ["alpha"]);
	assert.deepEqual(f.state.used, []);
	f.owner.setUseHandler(undefined);
	assert.equal(f.owner.use(), true, "no handler is a no-op");
});

test("an empty profile list shows only the hint, with no actions", (t) => {
	const f = fixture(t, []);
	f.setVisible(true);
	const lines = f.rail.render(60).map((line) => line.trimEnd());
	assert.equal(lines.length, 2);
	assert.equal(lines[1], `  ${PROFILE_CARD_EMPTY_HINT}`);
	for (let x = 0; x < 48; x++) for (let y = 1; y < 3; y++) assert.equal(f.rail.handleMouse!(click(x, y)), undefined);
	assert.equal(f.owner.use(), false);
	assert.equal(f.owner.next(), false);
	assert.deepEqual(f.state.used, []);
});

test("saved profiles are re-read at most once per refresh window and keep the shown profile by name", (t) => {
	const f = fixture(t, [item("alpha"), item("beta"), item("gamma")]);
	f.setVisible(true);
	f.owner.next();
	assert.equal(f.owner.shown()?.name, "beta");
	f.state.profiles = [item("zeta"), item("beta"), item("gamma")];
	f.rail.digest!();
	assert.equal(f.owner.items()[0]!.name, "alpha", "not re-read inside the window");
	f.state.now += PROFILE_CARD_REFRESH_MS;
	f.rail.digest!();
	assert.equal(f.owner.items()[0]!.name, "zeta");
	assert.equal(f.owner.shown()?.name, "beta", "the shown profile is followed by name");
	f.state.profiles = [item("zeta")];
	f.owner.refreshItems();
	assert.equal(f.owner.shown()?.name, "zeta");
	assert.equal(f.owner.index(), 0);
});

test("through the installed rail a click lands on the arrows in tinted and carded surfaces", (t) => {
	const found = chromeSurface();
	t.after(() => setChromeSurface(found));
	for (const surface of ["tinted", "transparent"] as const) {
		setChromeSurface(surface);
		const f = fixture(t, [item("alpha"), item("beta"), item("gamma")]);
		sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} });
		f.setVisible(true);
		const dispose = installSidebar(f.tui, theme);
		const node = f.root[NODE]() as unknown as { entries: { component: ScrollView }[] };
		const scroll = node.entries[1]!.component;
		const content = scroll.render(50);
		scroll.updateLayout(content.length, 20, () => {});
		const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
		const lines = () => { f.root[NODE](); return scroll.render(50).map(plain); };
		const navY = () => lines().findIndex((line) => line.includes("◀"));
		const mouse = (x: number, y: number): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: 90 + x, screenY: y, width: 50, height: 20, shift: false, alt: false, ctrl: false });
		const row = lines()[navY()]!;
		assert.match(row, /alpha/, `${surface}: starts on the first profile`);
		assert.equal(scroll.handleMouse(mouse(row.indexOf("▶"), navY()))?.handled, true, `${surface}: ▶ click handled`);
		assert.match(lines()[navY()]!, /◀ beta/, `${surface}: ▶ moved to beta`);
		scroll.handleMouse(mouse(lines()[navY()]!.indexOf("◀"), navY()));
		assert.match(lines()[navY()]!, /◀ alpha/, `${surface}: ◀ moved back`);
		scroll.handleMouse(mouse(lines()[navY()]!.indexOf("◀"), navY()));
		assert.match(lines()[navY()]!, /◀ gamma/, `${surface}: ◀ wraps`);
		const useRow = lines().findIndex((line) => line.includes("✓ Use in session"));
		scroll.handleMouse(mouse(lines()[useRow]!.indexOf("✓"), useRow));
		assert.deepEqual(f.state.used, ["gamma"], `${surface}: use click reaches the handler`);
		f.setVisible(false);
		assert.ok(!lines().some((line) => line.includes("◀")), `${surface}: hidden card leaves the rail`);
		dispose();
	}
});

