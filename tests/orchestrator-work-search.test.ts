import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PresencePublisher } from "../lib/orchestrator-presence.ts";
import { discoverOrchestrators } from "../lib/orchestrator-discovery.ts";
import { OrchestratorStateCache } from "../lib/orchestrator-state.ts";
import { OrchestratorScopeCache } from "../lib/orchestrator-scope.ts";
import { searchPublishedWork, validateWorkFilter } from "../lib/orchestrator-work-search.ts";

function fixture(t: TestContext, sessionId = "peer", sharedProfile?: string) {
	const profile = sharedProfile ?? realpathSync(mkdtempSync(join(tmpdir(), "work-search-")));
	if (!sharedProfile) t.after(() => rmSync(profile, { recursive: true, force: true }));
	const peer = { version: 1 as const, sessionId, endpoint: "/activation", createdAt: 1 };
	const publisher = PresencePublisher.start({ profile, sessionId, label: "Review", activity: [] });
	t.after(() => publisher.dispose());
	const cache = new OrchestratorStateCache();
	const manager = { getSessionId: () => sessionId, getCwd: () => "/repo", getBranch: () => [] };
	cache.load(manager);
	cache.publish(manager, { objective: "PRIVATE", work: { area: "Auth" } }, () => {}, 1);
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [], state: cache.get(manager) });
	const publish = (state: unknown, tasks: { id: string; label: string; status: string; cwd: string }[] = []) => {
		cache.publish(manager, state, () => {}, 2);
		const scope = new OrchestratorScopeCache(path => path === "/unknown" ? undefined : ({ root: path, commonDir: "/clone" }), () => 3)
			.project("/recorded", tasks, []);
		publisher.updateDiscovery(peer, { workspace: "/launch", tasks, scope, state: cache.get(manager) });
	};
	const sidecar = join(profile, "gentle-agents", "presence", `${publisher.target.sessionHash}.${publisher.target.incarnation}.discovery.json`);
	return { profile, peer, publisher, cache, manager, publish, sidecar };
}

test("explicit work projection exports classification only; default discovery stays unchanged", t => {
	const { profile, peer } = fixture(t);
	const candidate = discoverOrchestrators(profile, [peer], Date.now(), { includeWork: true })[0];
	assert.deepEqual(candidate.workRecord, { work: { area: "Auth" }, recordedAt: 1 });
	assert.equal(candidate.state, undefined);
	assert.equal(discoverOrchestrators(profile, [peer], Date.now(), { recipientSessionId: "peer", includeWork: true })[0].state, undefined);
	assert.doesNotMatch(JSON.stringify(candidate), /PRIVATE/);
	assert.equal(discoverOrchestrators(profile, [peer])[0].workRecord, undefined);
});

test("provided empty recipients never broaden discovery; invalid query selections reject before I/O", t => {
	const { profile, peer } = fixture(t);
	assert.deepEqual(discoverOrchestrators(profile, [peer], Date.now(), { recipientSessionId: "" }), []);
	assert.equal(discoverOrchestrators(profile, [peer]).length, 1);
	assert.equal(discoverOrchestrators(profile, [peer], Date.now(), {}).length, 1);
	for (const selection of [null, [], false, 1, "peer", { recipientSessionId: "" }, { recipientSessionId: 1 },
		{ recipientSessionId: "x".repeat(257) }, { recipientSessionId: "\u0000" }, { recipientSessionId: "\ud800" }])
		assert.throws(() => searchPublishedWork(undefined as never, [peer], {}, selection as never), /invalid-work-selection/);
	assert.equal(searchPublishedWork(profile, [peer], {}, { recipientSessionId: " peer " }).coverage.examinedPeers, 0);
});

const ref = { kind: "issue" as const, repository: "github.com/Owner/Repo", id: "12" };
test("AND filters fold human spelling only; refs keep exact repository, kind and ID", t => {
	const { profile, peer, publish } = fixture(t);
	publish({ objective: "SECRET", work: { area: " Café ", topic: "Login", tags: ["Review"], refs: [ref] } });
	const query = (filter: unknown) => searchPublishedWork(profile, [peer], filter);
	const result = query({ area: "CAFE\u0301", topic: " LOGIN ", tag: "review", text: "VIEW", ref });
	assert.deepEqual(result.matches[0].reasons, ["area", "topic", "tag", "text", "ref"]);
	assert.equal(result.matches[0].work.area, " Café ");
	for (const filter of [{ area: "Other" }, { text: "SECRET" }, { tag: "other" },
		{ ref: { ...ref, repository: "github.com/Owner/Other" } }, { ref: { ...ref, kind: "pr" } },
		{ ref: { ...ref, repository: "github.com/owner/repo" } }, { ref: { ...ref, id: "13" } }]) assert.equal(query(filter).matches.length, 0);
	result.matches[0].work.tags!.push("mutated");
	assert.deepEqual(query({}).matches[0].work.tags, ["Review"]);
	assert.equal(result.ownerReply, false);
	assert.equal(result.authority, "none");
	assert.equal(result.matches[0].recordedAt, 2);
	assert.ok(result.observedAt > 2);
	assert.doesNotMatch(JSON.stringify(result), /SECRET|endpoint|activation|capabilities|cursor/);
});

test("tasks join only current page exact IDs; recorded roots never inherit or resolve launch paths", t => {
	const { profile, peer, publish } = fixture(t);
	const tasks = Array.from({ length: 65 }, (_, i) => ({ id: `t${i}`, label: `Task ${i}`, status: "running", cwd: i === 1 ? "/unknown" : "/child" }));
	publish({ work: { area: "Parent", tasks: { t0: { area: "Child" }, t1: { tags: ["Unknown"] }, ghost: { area: "Ghost" }, t9: { area: "Later" } } } }, tasks);
	const query = (filter: unknown = {}, selection?: { recipientSessionId?: string; cursor?: string }) => searchPublishedWork(profile, [peer], filter, selection);
	const result = query();
	assert.deepEqual(result.matches.map(m => m.taskId), [undefined, "t0", "t1"]);
	assert.equal(result.coverage.unmatchedTaskAnnotations, 2);
	assert.equal(result.coverage.pendingCatalogPages, 1);
	assert.equal(result.coverage.catalogOmittedTasks, 1);
	assert.equal(query({ area: "Ghost" }).matches.length, 0);
	assert.equal(query({ area: "Later" }).matches.length, 0);
	assert.equal(query({ repository_root: "/recorded" }).matches.length, 1);
	assert.equal(query({ repository_root: "/launch" }).matches.length, 0);
	assert.equal(query({ area: "Child", repository_root: "/recorded" }).matches.length, 0);
	assert.equal(query({ repository_root: "/child" }).matches[0].taskId, "t0");
	assert.equal(query({ tag: "Unknown", repository_root: "/unknown" }).matches.length, 0);
	assert.equal(result.matches[2].repository?.root, null);
	assert.equal(result.matches[0].repository?.resolvedAt, 3);
	const cursor = discoverOrchestrators(profile, [peer])[0].catalog!.cursor!;
	assert.throws(() => query({}, { cursor }), /requires-recipient/);
	assert.equal(query({ area: "Later" }, { recipientSessionId: "peer", cursor }).matches[0].taskId, "t9");
	assert.equal(query({}, { recipientSessionId: "peer", cursor: "invalid" }).coverage.catalogUnknown, 1);
	publish({ work: { tasks: { ghost: { area: "Finished" } } } }, []);
	assert.equal(query().matches.length, 0);
	assert.equal(query().coverage.unmatchedTaskAnnotations, 1);
	publish({ work: { area: "Parent" } }, [{ id: "toString", label: "Unclassified", status: "running", cwd: "/child" }]);
	assert.equal(query().matches.length, 1, "prototype keys cannot become task annotations");
});

test("strict filters reject before profile access", () => {
	for (const filter of [null, [], { topic: "x" }, { area: "" }, { tag: 1 },
		{ area: "😀".repeat(17) }, { text: "x".repeat(1025) }, { text: "\u0000" }, { text: "\ud800" },
		{ ref: { ...ref, id: "012" } }, { ref: { ...ref, extra: true } }, { repository_root: "relative" },
		{ repository_root: "/" + "r".repeat(256) }, { repository_root: "/a\u00a0b" }]) {
		assert.throws(() => searchPublishedWork(undefined as never, [], filter), /invalid-work-filter/);
	}
	for (const separator of ["\u00a0", ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)), "\u202f", "\u205f", "\u3000"])
		assert.throws(() => validateWorkFilter({ repository_root: `/a${separator}b` }), /invalid-work-filter/);
	assert.deepEqual(validateWorkFilter({}), {});
});

test("nullable classification, malformed/foreign notes, stale/ambiguous presence and rejected scans fail closed", t => {
	const { profile, peer, publish, sidecar } = fixture(t);
	const query = (peers = [peer], now = Date.now()) => searchPublishedWork(profile, peers, {}, undefined, now);
	publish(null);
	assert.equal(query().coverage.unclassified, 1);
	assert.deepEqual(discoverOrchestrators(profile, [peer], Date.now(), { includeWork: true })[0].workRecord, { work: null, recordedAt: 2 });
	publish({ work: { area: "Auth" } });
	const snapshot = JSON.parse(readFileSync(sidecar, "utf8"));
	for (const state of [{ ...snapshot.metadata.state, sessionId: "foreign" }, { ...snapshot.metadata.state, state: { work: { area: 12 } } }]) {
		writeFileSync(sidecar, JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, state } }));
		assert.equal(query().coverage.unknownContext, 1);
		assert.equal(discoverOrchestrators(profile, [peer])[0].workspace, "/launch");
	}
	writeFileSync(sidecar, JSON.stringify(snapshot));
	assert.equal(query([peer], Date.now() + 20000).matches.length, 0);
	assert.equal(query([peer, { ...peer, endpoint: "/duplicate" }]).coverage.unknownContext, 1);
	assert.equal(query([{ ...peer, endpoint: "/replacement" }]).matches.length, 0);
	writeFileSync(join(profile, "gentle-agents", "presence", "bad.header.json"), "invalid");
	assert.equal(query().matches.length, 0);
	assert.equal(query().coverage.unknownContext, 1);
});

test("64 unique-peer cap is deterministic; whole-row byte omissions account for all matches", t => {
	const { profile, peer } = fixture(t);
	const peers = Array.from({ length: 66 }, (_, i) => ({ ...peer, sessionId: `p${String(i).padStart(2, "0")}`, endpoint: `/activation/${i}` }));
	const work = { area: "界".repeat(20), tags: Array.from({ length: 8 }, (_, i) => "界".repeat(20) + i),
		refs: [{ ...ref, kind: "task" as const, id: "x".repeat(256) }] };
	for (const p of [...peers.slice(0, 20), peers[65]]) {
		const pub = PresencePublisher.start({ profile, sessionId: p.sessionId, label: "Work", activity: [] });
		t.after(() => pub.dispose());
		const cache = new OrchestratorStateCache();
		const manager = { getSessionId: () => p.sessionId, getCwd: () => "/repo", getBranch: () => [] };
		cache.load(manager);
		cache.publish(manager, { work }, () => {}, 1);
		pub.updateDiscovery(p, { workspace: "/repo", tasks: [], state: cache.get(manager) });
	}
	const result = searchPublishedWork(profile, peers);
	assert.equal(result.coverage.examinedPeers, 64);
	assert.equal(result.coverage.unexaminedPeers, 2);
	assert.equal(result.coverage.exhaustive, false);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384);
	assert.ok(result.coverage.omittedMatches > 0);
	assert.equal(result.matches.length + result.coverage.omittedMatches, 20);
	assert.deepEqual(result.matches[0].work, work);
	assert.deepEqual(searchPublishedWork(profile, [...peers].reverse(), {}, undefined, result.observedAt), result);
	assert.equal(searchPublishedWork(profile, [...peers, { ...peers[0], endpoint: "/duplicate" }]).coverage.unknownContext, 45);
	assert.equal(result.coverage.unknownContext, 44);
	const relatedFilter = { related_to: { session_id: peers[65].sessionId } };
	const related = searchPublishedWork(profile, peers, relatedFilter);
	assert.equal(related.source?.status, "available");
	assert.equal(related.coverage.examinedPeers, 64);
	assert.equal(related.coverage.unexaminedPeers, 2);
	assert.equal(related.matches.length + related.coverage.omittedMatches, 20);
	assert.ok(related.coverage.omittedMatches > 0);
	assert.ok(Buffer.byteLength(JSON.stringify(related)) <= 16384);
	assert.deepEqual(related.matches[0].work, work);
	assert.deepEqual(related.matches[0].reasons, ["shared-declared-reference", "possible-area-overlap", "possible-tag-overlap"]);
	assert.deepEqual(searchPublishedWork(profile, [...peers].reverse(), relatedFilter, undefined, related.observedAt), related);
	const ambiguous = searchPublishedWork(profile, [...peers, { ...peers[65], endpoint: "/duplicate" }], relatedFilter);
	assert.equal(ambiguous.source?.status, "unavailable");
	assert.equal(ambiguous.matches.length, 0);
	// Directory entries, not admitted headers, bound the presence scan.
	for (let i = 0; i < 130; i++) writeFileSync(join(profile, "gentle-agents", "presence", `overflow-${i}`), "");
	assert.equal(searchPublishedWork(profile, peers).coverage.unknownContext, 64);
	const rejected = searchPublishedWork(profile, peers, relatedFilter);
	assert.equal(rejected.source?.reason, "source-context-unavailable");
	assert.equal(rejected.matches.length, 0);
	assert.equal(rejected.coverage.unknownContext, 64);
});


test("related sources use exact current entities and explicit non-authoritative reasons", t => {
	const { profile, peer, publish } = fixture(t);
	const task = (id: string) => ({ id, label: id, status: "running", cwd: "/child" });
	publish({ objective: "PRIVATE", work: { area: " Café ", topic: "Login", tags: ["Review"], refs: [ref], tasks: {
		a: { area: "CAFE\u0301", topic: " login ", tags: ["review"], refs: [ref] },
		b: { refs: [{ ...ref, kind: "pr" }] },
		c: { refs: [{ ...ref, repository: "github.com/owner/repo" }] },
		d: { refs: [{ ...ref, id: "13" }] },
		e: { refs: [{ ...ref, repository: "github.com/Owner/Other" }] },
		ghost: { area: "Café" },
	} } }, ["a", "b", "c", "d", "e"].map(task));
	const query = (task_id?: string, extra = {}) => searchPublishedWork(profile, [peer], {
		related_to: { session_id: "peer", ...(task_id === undefined ? {} : { task_id }) }, ...extra,
	});
	const root = query();
	assert.equal(root.source?.status, "available");
	assert.equal(root.source?.provenance, "published-work");
	assert.deepEqual(root.matches.map(m => m.taskId), ["a"]);
	assert.equal(query(" a ").source?.reason, "source-task-not-on-current-page");
	assert.deepEqual(root.matches[0].reasons, ["shared-declared-reference", "possible-area-overlap", "possible-topic-overlap", "possible-tag-overlap"]);
	assert.deepEqual(query("a").matches.map(m => m.taskId), [undefined]);
	assert.equal(query(undefined, { area: "other" }).matches.length, 0);
	assert.equal(query("ghost").source?.reason, "source-task-not-on-current-page");
	assert.equal(query("ghost").matches.length, 0);
	assert.equal(root.source?.node?.recordedAt, 2);
	root.source!.node!.work.tags!.push("mutated");
	root.matches[0].work.tags!.push("mutated");
	assert.deepEqual(query().source?.node?.work.tags, ["Review"]);
	assert.deepEqual(query().matches[0].work.tags, ["review"]);
	assert.doesNotMatch(JSON.stringify(root), /PRIVATE|endpoint|activation|capabilities/);
	assert.equal(root.ownerReply, false);
	assert.equal(root.authority, "none");
	assert.equal(root.reachability, "unknown");
	assert.equal(searchPublishedWork(profile, [peer]).source, undefined);
});


test("related selector boundaries reject before I/O and preserve exact opaque IDs", () => {
	for (const related_to of [null, [], false, "peer", {}, { sessionId: "peer" }, { session_id: "" },
		{ session_id: 1 }, { session_id: "peer", task_id: undefined }, { session_id: "peer", extra: 1 },
		...[" ", "x".repeat(257), "😀".repeat(65), "\u0000", "\u200b", "\ud800"].flatMap(id => [
			{ session_id: id }, { session_id: "peer", task_id: id },
		])]) assert.throws(() => searchPublishedWork(undefined as never, [], { related_to }), /invalid-work-filter/);
	const related_to = { session_id: " peer ", task_id: " e\u0301 " };
	assert.deepEqual(validateWorkFilter({ related_to }), { related_to });
	assert.deepEqual(validateWorkFilter({ related_to: { session_id: "😀".repeat(64), task_id: "x".repeat(256) } }).related_to,
		{ session_id: "😀".repeat(64), task_id: "x".repeat(256) });
});

test("related unavailable sources never broaden and classification never inherits", t => {
	const { profile, peer, publish, sidecar } = fixture(t);
	const query = (session_id = "peer", task_id?: string, peers = [peer], now = Date.now()) => searchPublishedWork(profile, peers,
		{ related_to: { session_id, ...(task_id === undefined ? {} : { task_id }) } }, undefined, now);
	assert.equal(query(" peer ").source?.reason, "source-not-advertised");
	assert.equal(query("alias").matches.length, 0);
	const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: `Task ${i}`, status: "running", cwd: "/child" }));
	publish({ work: { tasks: { t0: { area: "Child" }, t1: { area: "Child" }, t9: { area: "Child" } } } }, tasks);
	assert.equal(query().source?.reason, "source-unclassified");
	assert.equal(query().matches.length, 0);
	assert.deepEqual(query("peer", "t0").matches.map(m => m.taskId), ["t1"]);
	const outside = query("peer", "t9");
	assert.equal(outside.source?.reason, "source-task-not-on-current-page");
	assert.equal(outside.coverage.unmatchedTaskAnnotations, 1);
	assert.equal(outside.coverage.pendingCatalogPages, 1);
	assert.equal(outside.coverage.unclassified, 7);
	publish({ work: { area: "Parent" } }, tasks);
	assert.equal(query("peer", "t0").source?.reason, "source-unclassified");
	publish(null);
	assert.equal(query().source?.reason, "source-unclassified");
	publish({ work: { area: "Auth" } });
	for (const unavailable of [query("peer", undefined, [peer], Date.now() + 20000),
		query("peer", undefined, [peer, { ...peer, endpoint: "/duplicate" }]),
		query("peer", undefined, [{ ...peer, endpoint: "/replacement" }])]) {
		assert.equal(unavailable.source?.reason, "source-context-unavailable");
		assert.equal(unavailable.matches.length, 0);
	}
	const snapshot = JSON.parse(readFileSync(sidecar, "utf8"));
	writeFileSync(sidecar, JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, state: { ...snapshot.metadata.state, sessionId: "foreign" } } }));
	assert.equal(query().source?.reason, "source-context-unavailable");
	writeFileSync(sidecar, JSON.stringify(snapshot));
	writeFileSync(join(profile, "gentle-agents", "presence", "bad.header.json"), "invalid");
	assert.equal(query().source?.status, "unavailable");
	assert.equal(query().matches.length, 0);
});

test("selected recipient alone emits matches; source context has no borrowed cursor or target filters", t => {
	const source = fixture(t, "source");
	const target = fixture(t, "target", source.profile);
	const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: `Task ${i}`, status: "running", cwd: "/child" }));
	source.publish({ work: { area: "Other", refs: [ref], tasks: { t0: { refs: [ref] }, t9: { refs: [ref] } } } }, tasks);
	target.publish({ work: { area: "Target", refs: [ref], tasks: { t9: { area: "Target", refs: [ref] } } } }, tasks);
	const peers = [source.peer, target.peer];
	const cursor = discoverOrchestrators(source.profile, [target.peer])[0].catalog!.cursor!;
	const query = (task_id?: string, selection = { recipientSessionId: "target", cursor }) => searchPublishedWork(source.profile, peers,
		{ area: "Target", repository_root: "/recorded", related_to: { session_id: "source", ...(task_id === undefined ? {} : { task_id }) } }, selection);
	const result = query();
	assert.equal(result.coverage.examinedPeers, 2);
	assert.equal(result.source?.node?.work.area, "Other");
	assert.deepEqual(result.matches.map(m => [m.sessionId, m.taskId]), [["target", undefined]]);
	assert.deepEqual(result.matches[0].reasons, ["area", "repository_root", "shared-declared-reference"]);
	assert.equal(result.source?.node?.repository?.resolvedAt, 3);
	assert.equal(result.source?.node?.repository?.root, "/recorded");
	assert.equal(query("t0").source?.status, "available");
	assert.equal(query("t9").source?.reason, "source-task-not-on-current-page");
	const missingSourceCatalog = searchPublishedWork(source.profile, peers, { related_to: { session_id: "source", task_id: "t0" } },
		{ recipientSessionId: "source", cursor: "invalid" });
	assert.equal(missingSourceCatalog.source?.reason, "source-catalog-unavailable");
	assert.equal(missingSourceCatalog.matches.length, 0);
	const sourceCursor = discoverOrchestrators(source.profile, [source.peer])[0].catalog!.cursor!;
	const continuedSource = searchPublishedWork(source.profile, peers, { related_to: { session_id: "source", task_id: "t9" } },
		{ recipientSessionId: "source", cursor: sourceCursor });
	assert.equal(continuedSource.source?.status, "available");
	assert.deepEqual(continuedSource.matches.map(m => m.taskId), [undefined]);
	assert.equal(query(undefined, { recipientSessionId: "missing", cursor }).matches.length, 0);
	assert.equal(query(undefined, { recipientSessionId: "target", cursor: "invalid" }).coverage.catalogUnknown, 1);
});

test("possible overlap is literal and topic requires shared area; refs imply no dependency", t => {
	const source = fixture(t, "source");
	const target = fixture(t, "target", source.profile);
	const query = () => searchPublishedWork(source.profile, [source.peer, target.peer], { related_to: { session_id: "source" } });
	source.publish({ work: { area: "Auth", topic: "Login", tags: [" Review "] } });
	target.publish({ work: { area: "Other", topic: "Login", tags: ["review"] } });
	assert.deepEqual(query().matches[0].reasons, ["possible-tag-overlap"]);
	target.publish({ work: { area: "Other", topic: "Login" } });
	assert.equal(query().matches.length, 0);
	target.publish({ work: { area: "AUTH", topic: "Different" } });
	assert.deepEqual(query().matches[0].reasons, ["possible-area-overlap"]);
	source.publish({ work: { refs: [ref] } });
	target.publish({ work: { refs: [ref] } });
	assert.deepEqual(query().matches[0].reasons, ["shared-declared-reference"]);
});
