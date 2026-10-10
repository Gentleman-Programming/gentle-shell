import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { decodeCuratedState, decodePublishedState, ORCHESTRATOR_STATE_ENTRY, OrchestratorStateCache } from "../lib/orchestrator-state.ts";

test("only explicit typed branch records become historical knowledge", () => {
	const cache = new OrchestratorStateCache();
	const entries: { type: string; customType?: string; data?: unknown; message?: unknown; summary?: string }[] = [
		{ type: "message", get message() { throw new Error("private body accessed"); } },
		{ type: "compaction", get summary(): string { throw new Error("private summary accessed"); } },
	];
	let scans = 0;
	const manager = { getSessionId: () => "owner", getCwd: () => "/repo", getBranch: () => { scans++; return entries; } };
	cache.load(manager);
	assert.equal(cache.get(manager), undefined);
	const append = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
	const input = { objective: "Review", decisions: "Advisory" };
	cache.publish(manager, input, append, 10);
	input.objective = "mutated";
	const record = cache.get(manager)!;
	assert.deepEqual(record, { schema: 1, sessionId: "owner", cwd: "/repo", recordedAt: 10,
		source: "owner-curated", ownerReply: false, authority: "none", state: { objective: "Review", decisions: "Advisory" },
		aliases: { initialAlias: null, currentAlias: null } });
	record.state!.objective = "reader mutated";
	for (let i = 0; i < 1000; i++) assert.equal(cache.get(manager)?.recordedAt, 10);
	assert.equal(scans, 1);
	const replacement = { ...manager };
	assert.equal(cache.get(replacement), undefined);
	cache.load(replacement);
	assert.equal(cache.get(replacement)?.state?.objective, "Review");
	cache.publish(replacement, null, append, 11);
	cache.load(replacement);
	assert.equal(cache.get(replacement)?.state, null);
	entries.pop(); // Navigate to the earlier branch, not a publication.
	cache.load(replacement);
	assert.equal(cache.get(replacement)?.recordedAt, 10);
	entries.push({ type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { invalid: true } });
	cache.load(replacement);
	assert.equal(cache.get(replacement), undefined, "latest malformed record never resurrects old state");
	entries.pop();
	const foreign = { ...manager, getSessionId: () => "fork" };
	cache.load(foreign);
	assert.equal(cache.get(foreign), undefined);
	assert.throws(() => cache.publish(manager, {}, append), /stale/);
	cache.clear();
	assert.equal(cache.get(foreign), undefined);
});

test("alias identity preserves status age, validates data, and rejects stale branch publication", () => {
	const cache = new OrchestratorStateCache();
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const manager = { getSessionId: () => "owner", getCwd: () => "/repo", getBranch: () => entries };
	const append = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
	cache.load(manager);
	cache.publish(manager, { progress: "Old status" }, append, 10);
	cache.load(manager); // A new, undeclared record is not legacy history.
	cache.publish(manager, undefined, append, 20, "First");
	cache.publish(manager, undefined, append, 30, "Current");
	assert.equal(cache.get(manager)?.recordedAt, 10);
	assert.equal(cache.get(manager)?.state?.progress, "Old status");
	assert.deepEqual(cache.get(manager)?.aliases, { initialAlias: "First", currentAlias: "Current" });
	const valid = cache.get(manager)!;
	for (const aliases of [{ initialAlias: "First", currentAlias: "bad\n" }, { initialAlias: "x", currentAlias: null },
		{ initialAlias: null, currentAlias: "\ud800" }, { initialAlias: "x", currentAlias: "x".repeat(121) },
		{ initialAlias: null, currentAlias: " x " }, { initialAlias: null, currentAlias: "x", grant: true }])
		assert.equal(decodePublishedState({ ...valid, aliases }), undefined);
	const writes = entries.length;
	for (const subject of [123, {}, "\ud800"]) assert.throws(() => cache.publish(manager, undefined, append, 40, subject), /invalid/);
	assert.equal(entries.length, writes);
	assert.throws(() => cache.publish(manager, undefined, () => cache.load(manager), 40, "Stale"), /stale/);
	assert.deepEqual(cache.get(manager)?.aliases, valid.aliases);
	cache.publish(manager, null, append, 50);
	cache.load(manager);
	assert.deepEqual(cache.get(manager)?.aliases, valid.aliases);
});

test("recorded cwd preserves only unambiguous native absolute paths", () => {
	const separators = [0x00a0, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000];
	const invalid = ["relative/repo", "/repo\nother", "/repo\ud800", "/" + "x".repeat(1024),
		...separators.map(code => `/repo${String.fromCodePoint(code)}name`)];
	const cache = new OrchestratorStateCache();
	const manager = { getSessionId: () => "owner", getCwd: () => join(process.cwd(), "repo name", "日本語"), getBranch: () => [] };
	cache.load(manager);
	cache.publish(manager, { objective: "Curated" }, () => {}, 10);
	const valid = cache.get(manager)!;
	assert.equal(valid.cwd, manager.getCwd());
	for (const cwd of invalid) {
		manager.getCwd = () => cwd;
		cache.publish(manager, { objective: "Curated" }, () => {}, 10);
		assert.equal(cache.get(manager)?.cwd, null, `publication withholds ${JSON.stringify(cwd)}`);
		assert.equal(decodePublishedState({ ...valid, cwd }), undefined, `decoder rejects ${JSON.stringify(cwd)}`);
	}
});

test("whitelist, UTF-8 and envelope limits reject before persistence", () => {
	assert.deepEqual(decodeCuratedState({ objective: "😀".repeat(512) }), { objective: "😀".repeat(512) });
	for (const input of [{ objective: "😀".repeat(513) }, { objective: "a".repeat(2048), progress: "b" },
		{ objective: "bad\ncontrol" }, { blockers: "\u202e" }, { progress: "\ud800" }, { grant: "yes" }, { recordedAt: 1 }, [], "text"])
		assert.throws(() => decodeCuratedState(input), /invalid/);
	const cache = new OrchestratorStateCache();
	const manager = { getSessionId: () => "owner", getCwd: () => "x".repeat(1025), getBranch: () => [] };
	cache.load(manager);
	let writes = 0;
	const append = () => { writes++; };
	assert.throws(() => cache.publish(manager, { secret: "no" }, append));
	assert.throws(() => cache.publish(manager, {}, append, -1));
	assert.throws(() => cache.publish(manager, { objective: '"'.repeat(2048) }, append), /invalid/, "escaped envelope is also bounded");
	assert.equal(writes, 0);
	cache.publish(manager, { progress: "done" }, append, 1);
	assert.equal(cache.get(manager)?.cwd, null);
	const valid = cache.get(manager)!;
	for (const change of [{ source: "conversation" }, { ownerReply: true }, { authority: "grant" }, { recordedAt: NaN },
		{ extra: true }, { state: { objective: "a".repeat(2049) } }]) assert.equal(decodePublishedState({ ...valid, ...change }), undefined);
});
