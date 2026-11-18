import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { effectiveKey } from "../lib/keymaps.ts";
import {
	PROFILE_CARD_EMPTY_NOTICE,
	PROFILE_CARD_HIDDEN_NOTICE,
	createProfileCardOwner,
	registerProfileCardShortcuts,
} from "../lib/profile-card-sidebar.ts";
import type { ProfileCardItem } from "../lib/profile-card-widget.ts";

const item = (name: string): ProfileCardItem => ({ name, active: false, pinned: false, session: false });

function fixture(t: { after(fn: () => void): void }, profiles: ProfileCardItem[], env: NodeJS.ProcessEnv = {}, bindings = {}) {
	const home = mkdtempSync(join(tmpdir(), "profile-card-shortcuts-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const owner = createProfileCardOwner({ loadItems: () => profiles, configHome: () => home });
	const used: string[] = [];
	owner.setUseHandler((name) => { used.push(name); });
	const registered = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
	registerProfileCardShortcuts({ registerShortcut: (key: string, options: { description?: string; handler: (ctx: unknown) => unknown }) => { registered.set(key, options); } } as never, owner, env, bindings);
	const notices: Array<[string, string]> = [];
	const ctx = { ui: { notify: (message: string, level: string) => { notices.push([level, message]); } } };
	const setVisible = (visible: boolean) => {
		writeFileSync(join(home, "profile-card.json"), `${JSON.stringify({ schema: "gentle-pi.profile-card/v1", visible })}\n`);
		owner.refreshVisibility();
	};
	const press = async (key: string) => { await registered.get(key)!.handler(ctx); };
	return { owner, registered, notices, used, setVisible, press };
}

test("the three shortcuts register on alt+, alt+. and alt+m, spelled as Pi's key parser accepts them", (t) => {
	const f = fixture(t, [item("a")]);
	assert.deepEqual([...f.registered.keys()].sort(), ["alt+,", "alt+.", "alt+m"]);
	assert.equal(matchesKey("\x1b,", "alt+,"), true);
	assert.equal(matchesKey("\x1b.", "alt+."), true);
	assert.equal(matchesKey("\x1bm", "alt+m"), true);
	assert.match(f.registered.get("alt+,")!.description!, /previous/i);
	assert.match(f.registered.get("alt+.")!.description!, /next/i);
	assert.match(f.registered.get("alt+m")!.description!, /use/i);
});

test("with the card hidden every shortcut changes nothing and shows one notice naming card on", async (t) => {
	const f = fixture(t, [item("a"), item("b")]);
	const digest = f.owner.digest();
	for (const key of ["alt+,", "alt+.", "alt+m"]) {
		f.notices.length = 0;
		await f.press(key);
		assert.deepEqual(f.notices, [["info", "The profile card is hidden. Turn it on with /gentle:profiles card on."]], key);
	}
	assert.equal(PROFILE_CARD_HIDDEN_NOTICE, "The profile card is hidden. Turn it on with /gentle:profiles card on.");
	assert.equal(f.owner.digest(), digest);
	assert.deepEqual(f.used, []);
});

test("with no saved profiles every shortcut changes nothing and shows one notice naming /gentle:profiles", async (t) => {
	const f = fixture(t, []);
	f.setVisible(true);
	const digest = f.owner.digest();
	for (const key of ["alt+,", "alt+.", "alt+m"]) {
		f.notices.length = 0;
		await f.press(key);
		assert.deepEqual(f.notices, [["info", "The profile card has no saved profiles. Create one in /gentle:profiles."]], key);
	}
	assert.equal(PROFILE_CARD_EMPTY_NOTICE, "The profile card has no saved profiles. Create one in /gentle:profiles.");
	assert.equal(f.owner.digest(), digest);
	assert.deepEqual(f.used, []);
});

test("visible: next and previous wrap, change the rail digest and show no notice", async (t) => {
	const f = fixture(t, [item("a"), item("b"), item("c")]);
	f.setVisible(true);
	const seen: string[] = [];
	let repaints = 0;
	f.owner.onChange(() => { repaints++; });
	const step = async (key: string) => { await f.press(key); seen.push(f.owner.shown()!.name); };
	const first = f.owner.digest();
	await step("alt+.");
	assert.notEqual(f.owner.digest(), first, "the rail digest moves");
	await step("alt+.");
	await step("alt+.");
	await step("alt+,");
	await step("alt+,");
	await step("alt+,");
	assert.deepEqual(seen, ["b", "c", "a", "c", "b", "a"], "wraps both ways");
	assert.equal(repaints, 6, "each press repaints at once");
	assert.deepEqual(f.notices, []);
});

test("use runs the same use handler once with the shown profile name", async (t) => {
	const f = fixture(t, [item("a"), item("b")]);
	f.setVisible(true);
	await f.press("alt+.");
	await f.press("alt+m");
	assert.deepEqual(f.used, ["b"]);
	assert.deepEqual(f.notices, []);
});

test("an environment variable rebinds, and off or empty leaves a shortcut unregistered", (t) => {
	const f = fixture(t, [item("a")], { GENTLE_PI_PROFILE_CARD_NEXT_KEY: "alt+j", GENTLE_PI_PROFILE_CARD_PREVIOUS_KEY: "off", GENTLE_PI_PROFILE_CARD_USE_KEY: "" });
	assert.deepEqual([...f.registered.keys()], ["alt+j"]);
	const saved = fixture(t, [item("a")], {}, { "profileCard.use": "alt+y", "profileCard.next": null });
	assert.deepEqual([...saved.registered.keys()].sort(), ["alt+,", "alt+y"]);
	assert.equal(effectiveKey("profileCard.previous", {}, {}), "alt+,");
});
