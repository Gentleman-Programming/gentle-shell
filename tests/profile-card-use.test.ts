import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProfilesFileResult } from "../lib/agent-profiles.ts";
import { readSessionProfileDisk } from "../lib/session-profile-disk-reader.ts";
import { beginDesktopProfileApply, endDesktopProfileApply, isDesktopProfileApplyRunning } from "../lib/desktop-rpc-profiles.ts";
import { PROFILE_CARD_BUSY_NOTICE, createProfileCardOwner, createProfileCardReader, createProfileCardUseHandler, readProfileCardItems } from "../lib/profile-card-sidebar.ts";
import { bindSessionProfile, readSessionProfileBinding, readSessionProfileStartupNone, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { createSessionProfileBind, createSessionProfileClear, createSessionProfileStartupBind, SESSION_PROFILE_CUSTOM_TYPE } from "../lib/session-profile-persistence.ts";
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

// ---- The session marker follows the profile in effect: explicit choice, then the startup record, else none ----

const profilesJson = `${JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "alpha", profiles: { alpha: {}, beta: {}, gamma: {} } })}
`;
const recordEntry = (id: string, data: unknown) => ({ type: "custom", id, parentId: null, timestamp: "2026-10-05T00:00:00Z", customType: SESSION_PROFILE_CUSTOM_TYPE, data });
function sessionFixture(t: { after(fn: () => void): void }, entries: unknown[], options: { flushed?: boolean } = {}) {
	const home = scratch(t);
	t.after(() => resetSessionProfileBindingsForTesting());
	writeFileSync(join(home, "profiles.json"), profilesJson);
	const file = join(home, "session.jsonl");
	if (options.flushed !== false) writeFileSync(file, [{ type: "session", id: "s2", version: 3 }, ...entries].map((row) => JSON.stringify(row)).join("\n"));
	const session = { getSessionId: () => "s2", getSessionFile: () => file, getBranch: () => entries };
	const read = () => readProfileCardItems({ configHome: home, sessionId: "s2", cwd: home, session });
	const snapshot = () => JSON.stringify([readSessionProfileBinding("s2"), readSessionProfileStartupNone("s2"), readdirSync(home).sort(), readFileSync(join(home, "profiles.json"), "utf8"), options.flushed === false ? "" : readFileSync(file, "utf8"), entries]);
	return { home, read, snapshot };
}
const marks = (items: ProfileCardItem[]) => items.map((entry) => `${entry.name}${entry.active ? "*" : ""}${entry.session ? "#" : ""}`);
function startIndex(home: string, read: () => ProfileCardItem[]) {
	const owner = createProfileCardOwner({ loadItems: read, configHome: () => home });
	writeFileSync(join(home, "profile-card.json"), `${JSON.stringify({ schema: "gentle-pi.profile-card/v1", visible: true })}
`);
	owner.refreshVisibility();
	return owner.shown()?.name;
}

test("an explicit session choice marks its profile and the card starts there", (t) => {
	const f = sessionFixture(t, [recordEntry("e1", createSessionProfileBind("gamma", {}))]);
	const before = f.snapshot();
	assert.deepEqual(marks(f.read()), ["alpha*", "beta", "gamma#"]);
	assert.equal(startIndex(f.home, f.read), "gamma");
	assert.equal(f.snapshot().replace(/"profile-card\.json",/, ""), before.replace(/"profile-card\.json",/, ""), "session state, stores and the session file are untouched");
});

test("a startup-only record marks the startup profile and the card starts there", (t) => {
	for (const origin of ["global", "local", "repo"] as const) {
		const f = sessionFixture(t, [recordEntry("s1", createSessionProfileStartupBind(origin, "beta", {}))]);
		const before = f.snapshot();
		assert.deepEqual(marks(f.read()), ["alpha*", "beta#", "gamma"], origin);
		assert.equal(startIndex(f.home, f.read), "beta", origin);
		assert.equal(f.snapshot().replace(/"profile-card\.json",/, ""), before.replace(/"profile-card\.json",/, ""), `${origin}: nothing mutated`);
	}
});

test("a newer clear (legacy or started with no profile) shows no session marker and the card falls back to the active profile", (t) => {
	for (const clear of [createSessionProfileClear(), createSessionProfileClear("none")]) {
		const f = sessionFixture(t, [recordEntry("e1", createSessionProfileBind("gamma", {})), recordEntry("e2", clear)]);
		const before = f.snapshot();
		assert.deepEqual(marks(f.read()), ["alpha*", "beta", "gamma"]);
		assert.equal(startIndex(f.home, f.read), "alpha");
		assert.equal(f.snapshot().replace(/"profile-card\.json",/, ""), before.replace(/"profile-card\.json",/, ""));
	}
});

test("a session with no record falls back to the active profile", (t) => {
	const f = sessionFixture(t, []);
	const before = f.snapshot();
	assert.deepEqual(marks(f.read()), ["alpha*", "beta", "gamma"]);
	assert.equal(startIndex(f.home, f.read), "alpha");
	assert.equal(f.snapshot().replace(/"profile-card\.json",/, ""), before.replace(/"profile-card\.json",/, ""));
});

test("a session file not flushed yet falls back to the in-memory binding, still without writes", (t) => {
	const f = sessionFixture(t, [recordEntry("e1", createSessionProfileBind("beta", {}))], { flushed: false });
	assert.deepEqual(marks(f.read()), ["alpha*", "beta", "gamma"], "nothing bound in memory yet: no marker");
	bindSessionProfile("s2", "beta", {});
	const before = f.snapshot();
	assert.deepEqual(marks(f.read()), ["alpha*", "beta#", "gamma"]);
	assert.equal(f.snapshot(), before);
});

// ---- The session file and profiles.json are re-read only when they change ----

function counted(t: { after(fn: () => void): void }, flushed = true) {
	const home = scratch(t);
	t.after(() => resetSessionProfileBindingsForTesting());
	writeFileSync(join(home, "profiles.json"), profilesJson);
	const file = join(home, "session.jsonl");
	const entries: unknown[] = [];
	const flush = () => writeFileSync(file, [{ type: "session", id: "s3", version: 3 }, ...entries].map((row) => JSON.stringify(row)).join("\n"));
	if (flushed) flush();
	let diskReads = 0;
	let profileReads = 0;
	const reader = createProfileCardReader({
		readDisk: (source) => { diskReads++; return readSessionProfileDisk(source); },
		readProfiles: (path) => { profileReads++; return readProfilesFileResult(path); },
	});
	const session = { getSessionId: () => "s3", getSessionFile: () => file, getBranch: () => entries };
	const read = () => marks(readProfileCardItems({ configHome: home, sessionId: "s3", cwd: home, session }, reader));
	return { home, entries, flush, reader, read, disk: () => diskReads, profiles: () => profileReads };
}

test("repeated reads with an unchanged session file and profiles.json read neither again", (t) => {
	const f = counted(t);
	f.entries.push(recordEntry("e1", createSessionProfileBind("gamma", {})));
	f.flush();
	for (let i = 0; i < 5; i++) assert.deepEqual(f.read(), ["alpha*", "beta", "gamma#"]);
	assert.equal(f.disk(), 1, "the session file is parsed once");
	assert.equal(f.profiles(), 1, "profiles.json is parsed once");
});

test("an appended session record re-reads the file and moves the marker", (t) => {
	const f = counted(t);
	f.entries.push(recordEntry("e1", createSessionProfileBind("gamma", {})));
	f.flush();
	assert.deepEqual(f.read(), ["alpha*", "beta", "gamma#"]);
	f.entries.push(recordEntry("e2", createSessionProfileBind("beta", {})));
	f.flush();
	assert.deepEqual(f.read(), ["alpha*", "beta#", "gamma"]);
	assert.equal(f.disk(), 2);
	f.read();
	assert.equal(f.disk(), 2, "stable again afterwards");
});

test("an edited profiles.json is re-read; a changed in-memory binding or invalidate() re-reads the session", (t) => {
	const f = counted(t);
	f.entries.push(recordEntry("e1", createSessionProfileBind("gamma", {})));
	f.flush();
	f.read();
	writeFileSync(join(f.home, "profiles.json"), profilesJson.replace('"gamma":{}', '"gamma":{},"delta":{}'));
	assert.deepEqual(f.read(), ["alpha*", "beta", "gamma#", "delta"]);
	assert.equal(f.profiles(), 2);
	assert.equal(f.disk(), 1, "the session file did not change");
	bindSessionProfile("s3", "beta", {});
	f.read();
	assert.equal(f.disk(), 2, "a changed in-memory binding name re-reads");
	f.reader.invalidate();
	f.read();
	assert.equal(f.disk(), 3, "invalidate (after a use) re-reads");
	assert.equal(f.profiles(), 3, "and profiles.json too");
});

test("an indeterminate read is never cached as final", (t) => {
	const f = counted(t, false);
	f.entries.push(recordEntry("e1", createSessionProfileBind("gamma", {})));
	// No session file yet: indeterminate, memory has no binding.
	assert.deepEqual(f.read(), ["alpha*", "beta", "gamma"]);
	assert.deepEqual(f.read(), ["alpha*", "beta", "gamma"]);
	assert.equal(f.disk(), 2, "retried on every tick");
	f.flush();
	assert.deepEqual(f.read(), ["alpha*", "beta", "gamma#"], "the flushed file now decides");
	f.read();
	assert.equal(f.disk(), 3, "and is cached once determinate");
	// A record newer than disk is indeterminate too: retried, never frozen.
	f.entries.push(recordEntry("e2", createSessionProfileBind("beta", {})));
	f.read();
	f.read();
	assert.equal(f.disk(), 5);
	f.flush();
	assert.deepEqual(f.read(), ["alpha*", "beta#", "gamma"]);
});
