import assert from "node:assert/strict";
import test from "node:test";
import { decodeCuratedState, decodePublishedState, OrchestratorStateCache, ORCHESTRATOR_STATE_ENTRY } from "../lib/orchestrator-state.ts";

import { decodeWorkDescriptor } from "../lib/orchestrator-work.ts";

const work = { area: "Auth", topic: "Login", tags: ["Review"], refs: [
	{ kind: "issue", repository: "github.com/Owner/Repo", id: "12" },
] };
const record = (schema: number, state: unknown) => ({ schema, sessionId: "s1", recordedAt: 1,
	cwd: "/repo", source: "owner-curated", ownerReply: false, authority: "none", state });

test("task-only work is detached, bounded, root-only and replaces rather than inherits", () => {
	const tasks = { actual: structuredClone(work) };
	const decoded = decodeCuratedState({ work: { tasks } })!;
	tasks.actual.area = "Changed";
	assert.deepEqual(decoded.work?.tasks?.actual, work);
	assert.ok(decodeCuratedState({ work: { tags: [], refs: [], tasks: { actual: work } } }));
	assert.equal(decodePublishedState(record(2, { work: { tasks: { actual: work } } }))?.schema, 2);
	assert.equal(decodePublishedState(record(1, { work: { tasks: { actual: work } } })), undefined);
	assert.throws(() => decodeWorkDescriptor({ tasks: { actual: work } }));
	for (const tasks of [{}, { actual: { tasks: { child: work } } },
		...['__proto__', 'constructor', 'prototype', 'bad\n', '\ud800', '😀'.repeat(65)].map(id => ({ [id]: work })),
		Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`t${i}`, { area: "A" }]))])
		assert.throws(() => decodeCuratedState({ work: { tasks } }));
	assert.ok(decodeCuratedState({ work: { tasks: { ['😀'.repeat(64)]: { area: "A" } } } }));
	const manager = { getSessionId: () => "s1", getCwd: () => "/repo", getBranch: () => [] };
	const cache = new OrchestratorStateCache();
	cache.load(manager);
	cache.publish(manager, { work: { tasks: { actual: work } } }, () => {});
	cache.get(manager)!.state!.work!.tasks!.actual.tags!.push("Detached");
	assert.deepEqual(cache.get(manager)?.state?.work?.tasks?.actual, work);
	cache.publish(manager, { work: { area: "Owner" } }, () => {});
	assert.equal(cache.get(manager)?.state?.work?.tasks, undefined);
	assert.throws(() => cache.publish(manager, { work }, () => cache.load({ ...manager })), /stale/);
	assert.equal(cache.get(manager), undefined);
});

test("reentrant append changing the same manager session preserves the new owner cache", () => {
	let sessionId = "owner-before";
	let branch: { type: string; customType: string; data: unknown }[] = [];
	const manager = { getSessionId: () => sessionId, getCwd: () => "/repo", getBranch: () => branch };
	const cache = new OrchestratorStateCache();
	cache.load(manager);
	assert.throws(() => cache.publish(manager, { objective: "Old owner notes", work }, () => {
		sessionId = "owner-after";
		branch = [{ type: "custom", customType: ORCHESTRATOR_STATE_ENTRY,
			data: { ...record(2, { objective: "New owner notes", work }), sessionId } }];
		cache.load(manager);
	}), /stale-published-state/);
	assert.equal(cache.get(manager)?.sessionId, "owner-after");
	assert.deepEqual(cache.get(manager)?.state, { objective: "New owner notes", work });
});

test("work publication round-trips through the existing curated state API", () => {
	assert.deepEqual(decodeCuratedState({ progress: "Recorded", work }), { progress: "Recorded", work });
});

test("work rejects unknown keys, empty information, unsafe nested strings and malformed scoped refs", () => {
	const ref = work.refs[0];
	const invalid = [null, {}, [], { tags: [], refs: [] }, { topic: "Login" }, { area: "" },
		{ area: "Auth", extra: {} }, { area: "Auth", topic: null }, { area: "Auth", tags: ["ok", {}] },
		{ refs: [{ ...ref, extra: "no" }] }, { refs: [{ kind: "issue", id: "12" }] },
		{ refs: [{ ...ref, kind: "session" }] }, { refs: [{ ...ref, id: 12 }] },
		...["0", "01", "-1", "#12", "1.0"].map(id => ({ refs: [{ ...ref, id }] })),
		...["Owner/Repo", "https://github.com/Owner/Repo", "github.com/../Repo", "user:secret@github.com/Owner/Repo",
			"github.com/Owner/Repo?token=x"].map(repository => ({ refs: [{ ...ref, repository }] })),
		...["\n", "\u202e", "\ud800"].flatMap(control => [
			{ area: `A${control}` }, { area: "Auth", topic: `T${control}` }, { tags: [`t${control}`] },
			{ refs: [{ ...ref, repository: `github.com/O${control}/Repo` }] },
			{ refs: [{ ...ref, kind: "task", id: `t${control}` }] },
		]),
	];
	for (const value of invalid) assert.throws(() => decodeCuratedState({ work: value }), /invalid/, JSON.stringify(value));
});

test("work enforces UTF-8 bytes, counts, exact duplicates and the combined state budget", () => {
	for (const key of ["area", "topic"]) {
		assert.ok(decodeCuratedState({ work: { area: "Auth", [key]: "😀".repeat(16) } }));
		assert.throws(() => decodeCuratedState({ work: { area: "Auth", [key]: "😀".repeat(17) } }));
	}
	assert.ok(decodeCuratedState({ work: { tags: Array.from({ length: 8 }, (_, i) => `${i}`) } }));
	assert.ok(decodeCuratedState({ work: { tags: ["😀".repeat(16)] } }));
	for (const tags of [Array.from({ length: 9 }, (_, i) => `${i}`), Array(1), ["a", "a"], ["😀".repeat(17)]])
		assert.throws(() => decodeCuratedState({ work: { tags } }));
	const task = { kind: "task", repository: "github.com/Owner/Repo", id: "😀".repeat(64) };
	assert.ok(decodeCuratedState({ work: { refs: [task] } }));
	const scoped = { ...task, repository: `github.com/Owner/${"r".repeat(239)}`, id: "task_ABC" };
	assert.equal(Buffer.byteLength(scoped.repository), 256);
	assert.ok(decodeCuratedState({ work: { refs: [scoped] } }));
	assert.ok(decodeCuratedState({ work: { refs: Array.from({ length: 8 }, (_, i) => ({ ...task, id: `${i}` })) } }));
	for (const refs of [[task, task], [{ ...task, id: task.id + "x" }],
		[{ ...task, repository: `github.com/Owner/${"r".repeat(240)}` }],
		Array.from({ length: 9 }, (_, i) => ({ ...task, id: `${i}` }))])
		assert.throws(() => decodeCuratedState({ work: { refs } }));
	const refs = [work.refs[0], { ...work.refs[0], kind: "pr" },
		{ ...work.refs[0], repository: "github.com/Other/Repo" }, { ...task, id: "t_ABC" }];
	assert.deepEqual(decodeCuratedState({ work: { refs } })?.work?.refs, refs, "kind and repository scope prevent collisions");
	const bytes = Buffer.byteLength(JSON.stringify(work));
	assert.ok(decodeCuratedState({ objective: "x".repeat(2048 - bytes), work }));
	assert.throws(() => decodeCuratedState({ objective: "x".repeat(2049 - bytes), work }));
	assert.ok(decodeCuratedState({ objective: "x".repeat(2048) }), "legacy exact limit");
});

test("published schema 1 remains exact legacy and schema 2 requires validated work", () => {
	assert.equal(decodePublishedState(record(1, { objective: "x".repeat(2048) }))?.schema, 1);
	assert.equal(decodePublishedState(record(2, { work }))?.schema, 2);
	for (const value of [record(1, { work }), record(2, {}), record(2, null), record(3, { work }),
		record(1, { objective: 1 }), record(2, { work: { area: "A", extra: 1 } }),
		{ ...record(2, { work }), extra: true }, record(1, { objective: '"'.repeat(2048) })])
		assert.equal(decodePublishedState(value), undefined);
});

test("work uses one cache, detached readback, replacement, withdrawal and latest-record suppression", () => {
	let branch: { type: string; customType: string; data: unknown }[] = [];
	const manager = { getSessionId: () => "s1", getCwd: () => "/repo", getBranch: () => branch };
	const cache = new OrchestratorStateCache();
	cache.load(manager);
	const append = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data });
	const input = structuredClone(work);
	cache.publish(manager, { work: input }, append, 42);
	input.refs[0].id = "99";
	const read = cache.get(manager)!;
	read.state!.work!.tags!.push("Changed");
	assert.deepEqual(cache.get(manager)?.state?.work, work);
	assert.equal(cache.get(manager)?.recordedAt, 42);
	assert.equal(branch.length, 1);
	cache.load(manager);
	assert.deepEqual(cache.get(manager)?.state?.work, work);
	assert.throws(() => cache.publish(manager, { work: null }, append));
	assert.equal(branch.length, 1, "invalid input has no append effect");
	cache.publish(manager, { progress: "Replacement" }, append, 43);
	assert.equal(cache.get(manager)?.schema, 1);
	assert.equal(cache.get(manager)?.state?.work, undefined);
	cache.publish(manager, null, append, 44);
	assert.equal(cache.get(manager)?.state, null);
	for (const data of [record(2, { work: {} }), { ...record(2, { work }), sessionId: "foreign" }]) {
		branch = [branch[0], { type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data }];
		cache.load(manager);
		assert.equal(cache.get(manager), undefined);
	}
	assert.equal(cache.get({ ...manager }), undefined, "same ID is not same manager");
	cache.load({ ...manager, getBranch: () => [] });
	assert.equal(cache.get(manager), undefined);
	cache.clear();
	assert.throws(() => cache.publish(manager, { work }, append), /stale/);
});
