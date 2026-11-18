import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginDesktopProfileApply, endDesktopProfileApply, isDesktopProfileApplyRunning } from "../lib/desktop-rpc-profiles.ts";
import { PROFILE_CARD_BUSY_NOTICE, createProfileCardOwner, createProfileCardUseHandler, readProfileCardItems } from "../lib/profile-card-sidebar.ts";
import { bindSessionProfile, readSessionProfileBinding, readSessionProfileStartupNone, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import type { ProfileCardItem } from "../lib/profile-card-widget.ts";

const item = (name: string, markers: Partial<ProfileCardItem> = {}): ProfileCardItem => ({ name, active: false, pinned: false, session: false, ...markers });

function setup(t: { after(fn: () => void): void }, run: (name: string) => Promise<void> | void, home?: string) {
	assert.equal(isDesktopProfileApplyRunning(), false, "the gate starts free");
	t.after(() => endDesktopProfileApply());
	const notices: Array<[string, string]> = [];
	let loads = 0;
	let profiles = [item("alpha"), item("beta")];
	const owner = createProfileCardOwner({ loadItems: () => { loads++; return profiles; }, configHome: () => home });
	const runs: string[] = [];
	const handler = createProfileCardUseHandler({
		begin: beginDesktopProfileApply,
		end: endDesktopProfileApply,
		notify: (message, level) => { notices.push([level, message]); },
		run: async (name) => { runs.push(name); await run(name); },
		refresh: () => owner.refreshItems(),
	});
	owner.setUseHandler(handler);
	return { owner, notices, runs, loads: () => loads, setProfiles: (next: ProfileCardItem[]) => { profiles = next; } };
}
// The owner only acts while visible; flip it through the store-free path.
function show(owner: ReturnType<typeof createProfileCardOwner>, home: string) {
	writeFileSync(join(home, "profile-card.json"), `${JSON.stringify({ schema: "gentle-pi.profile-card/v1", visible: true })}\n`);
	owner.refreshVisibility();
}
function scratch(t: { after(fn: () => void): void }) {
	const home = mkdtempSync(join(tmpdir(), "profile-card-use-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("use runs the owner action once with the shown profile name, under the shared gate, then refreshes", async (t) => {
	const home = scratch(t);
	let gateDuringRun: boolean | undefined;
	const f = setup(t, () => { gateDuringRun = isDesktopProfileApplyRunning(); });
	const owner = createProfileCardOwner({ loadItems: () => [item("alpha"), item("beta")], configHome: () => home });
	let refreshes = 0;
	owner.setUseHandler(createProfileCardUseHandler({ begin: beginDesktopProfileApply, end: endDesktopProfileApply, notify: () => {}, run: async (name) => { f.runs.push(name); gateDuringRun = isDesktopProfileApplyRunning(); }, refresh: () => { refreshes++; owner.refreshItems(); } }));
	show(owner, home);
	owner.next();
	assert.equal(owner.use(), true);
	await settle();
	assert.deepEqual(f.runs, ["beta"]);
	assert.equal(gateDuringRun, true, "the apply runs inside the shared gate");
	assert.equal(isDesktopProfileApplyRunning(), false, "the gate is released afterwards");
	assert.equal(refreshes, 1, "markers refresh after the action");
	assert.deepEqual(f.notices, []);
});

test("a busy gate applies nothing and says so once", async (t) => {
	const f = setup(t, () => {});
	assert.equal(beginDesktopProfileApply(), true);
	await createProfileCardUseHandler({ begin: beginDesktopProfileApply, end: endDesktopProfileApply, notify: (m, l) => { f.notices.push([l, m]); }, run: async (name) => { f.runs.push(name); }, refresh: () => { throw new Error("must not refresh"); } })("alpha");
	assert.deepEqual(f.runs, []);
	assert.deepEqual(f.notices, [["info", PROFILE_CARD_BUSY_NOTICE]]);
	assert.equal(isDesktopProfileApplyRunning(), true, "the other apply keeps its gate");
});

test("an owner action that applies nothing (declined or not applied) leaves items refreshed and throws nothing", async (t) => {
	const home = scratch(t);
	const f = setup(t, () => { /* the owner declined: it only notifies and returns */ }, home);
	show(f.owner, home);
	const before = f.loads();
	f.setProfiles([item("alpha", { session: false }), item("beta")]);
	assert.equal(f.owner.use(), true);
	await settle();
	assert.deepEqual(f.runs, ["alpha"]);
	assert.ok(f.loads() > before, "items re-read after the action");
	assert.equal(isDesktopProfileApplyRunning(), false);
	assert.deepEqual(f.notices, []);
});

test("a throwing owner action is notified as a warning, releases the gate and still refreshes", async (t) => {
	const home = scratch(t);
	const f = setup(t, () => { throw new Error("boom"); }, home);
	show(f.owner, home);
	const before = f.loads();
	f.owner.use();
	await settle();
	assert.deepEqual(f.notices, [["warning", 'Could not use profile "alpha" in this session: boom']]);
	assert.equal(isDesktopProfileApplyRunning(), false);
	assert.ok(f.loads() > before);
});

test("a second use while an apply runs starts no second apply", async (t) => {
	const home = scratch(t);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const f = setup(t, () => pending, home);
	show(f.owner, home);
	f.owner.use();
	await settle();
	f.owner.use();
	f.owner.use();
	await settle();
	assert.deepEqual(f.runs, ["alpha"], "only the first click applies");
	assert.deepEqual(f.notices, [["info", PROFILE_CARD_BUSY_NOTICE], ["info", PROFILE_CARD_BUSY_NOTICE]]);
	release();
	await settle();
	assert.equal(isDesktopProfileApplyRunning(), false);
	f.owner.use();
	await settle();
	assert.deepEqual(f.runs, ["alpha", "alpha"], "a later click applies again once the gate is free");
});

test("the display read marks the session binding without mutating session profile state or the stores", (t) => {
	const home = scratch(t);
	t.after(() => resetSessionProfileBindingsForTesting());
	const profiles = `${JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "alpha", profiles: { alpha: {}, beta: {} } })}\n`;
	writeFileSync(join(home, "profiles.json"), profiles);
	const read = () => readProfileCardItems({ configHome: home, sessionId: "s1", cwd: home });
	// Unbound: nothing is bound, recorded or cleared by looking.
	assert.deepEqual(read().map((entry) => [entry.name, entry.active, entry.session]), [["alpha", true, false], ["beta", false, false]]);
	assert.equal(readSessionProfileBinding("s1"), undefined);
	assert.equal(readSessionProfileStartupNone("s1"), false);
	bindSessionProfile("s1", "beta", { worker: { model: "p/m" } } as never);
	const binding = readSessionProfileBinding("s1");
	assert.deepEqual(read().map((entry) => [entry.name, entry.session]), [["alpha", false], ["beta", true]]);
	assert.deepEqual(readSessionProfileBinding("s1"), binding, "the binding is untouched");
	assert.equal(readFileSync(join(home, "profiles.json"), "utf8"), profiles);
	assert.deepEqual(readdirSync(home).sort(), ["profiles.json"], "no store file was written");
	assert.deepEqual(readProfileCardItems({ configHome: join(home, "missing"), sessionId: "s1", cwd: home }), [], "no profiles file shows no profiles and writes nothing");
	assert.deepEqual(readdirSync(home).sort(), ["profiles.json"]);
});
