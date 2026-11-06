import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONSULTATION_BYTES, consultPublishedMetadata } from "../lib/orchestrator-consultation.ts";
import { PresencePublisher } from "../lib/orchestrator-presence.ts";

const peer = { version: 1 as const, sessionId: "peer", endpoint: "/PRIVATE/socket", createdAt: 1 };
function fixture(t: TestContext) {
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "consult-")));
	const publisher = PresencePublisher.start({ profile, sessionId: "peer", label: "Review", activity: [] });
	t.after(() => { publisher.dispose(); rmSync(profile, { recursive: true, force: true }); });
	const consult = (cursor?: string, peers = [peer], now = Date.now()) => consultPublishedMetadata(profile, peers, { recipientSessionId: "peer", cursor }, now);
	const sidecar = join(profile, "gentle-agents", "presence", `${publisher.target.sessionHash}.${publisher.target.incarnation}.discovery.json`);
	return { profile, publisher, consult, sidecar };
}
test("consultation captures frozen public notes and pages, never private task getters", t => {
	const { publisher, consult, sidecar } = fixture(t);
	const tasks = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, label: "Check", status: "running", cwd: "/repo",
		get prompt(): never { throw new Error("private prompt read"); }, get result(): never { throw new Error("private result read"); },
		get thread(): never { throw new Error("private thread read"); } }));
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered: tasks.map((_, i) => `/root/${i}`), state: {
		schema: 1, sessionId: "peer", cwd: "/repo", recordedAt: 1, source: "owner-curated", ownerReply: false,
		authority: "none", state: { progress: "Published progress" },
	} });
	writeFileSync(sidecar.replace("discovery.json", "activity.json"), "PRIVATE owner-history sentinel: invalid activity JSON");
	const result = consult();
	assert.equal(result.status, "available");
	assert.ok(result.observedAt >= result.presenceObservedAt!);
	assert.equal(result.freshness, "recent");
	assert.equal(result.snapshot?.state?.state?.progress, "Published progress");
	assert.equal(result.snapshot?.state?.recordedAt, 1);
	assert.equal(result.ownerReply, false);
	assert.equal(result.authority, "none");
	assert.equal(result.source, "published_snapshot");
	assert.ok(Object.isFrozen(result.snapshot?.catalog?.tasks[0]));
	assert.throws(() => { result.snapshot!.state!.state!.progress = "Changed"; }, TypeError);
	assert.doesNotMatch(JSON.stringify(result), /PRIVATE|endpoint|activation|prompt|result|thread/);
	const next = consult(result.snapshot!.catalog!.cursor);
	assert.deepEqual(next.snapshot?.catalog?.tasks.map(t => t.id), ["t8"]);
	assert.deepEqual(next.snapshot?.catalog?.registered, ["/root/8"]);
	assert.equal(consult().snapshot?.state?.state?.progress, "Published progress");
	publisher.refreshLabel();
	assert.equal(consult().digest, result.digest);
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [] });
	assert.equal(consult(result.snapshot!.catalog!.cursor).status, "unavailable");
	assert.equal(result.snapshot?.catalog?.tasks.length, 8, "captured page survives source replacement");
});
test("missing, stale, wrong selected activation and invalid cursors are unknown, not owner negatives", t => {
	const { publisher, consult, profile } = fixture(t);
	assert.equal(consult().status, "unavailable");
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [] });
	const result = consult();
	assert.ok(result.unknowns.includes("curated-state"));
	assert.ok(result.unknowns.includes("repository-scope"));
	assert.equal(result.snapshot?.state, null);
	publisher.updateDiscovery({ ...peer, endpoint: "/newer-unselected", createdAt: 2 }, { workspace: "/wrong", tasks: [] });
	assert.equal(consult().status, "unavailable", "never substitute metadata from a newer unselected activation");
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [] });
	for (const unavailable of [consult("invalid"), consult(undefined, []), consult(undefined, [{ ...peer, endpoint: "/replacement" }]),
		consult(undefined, [peer, peer]), consult(undefined, [peer], Date.now() + 20_000), consult(undefined, [peer], 0),
		consultPublishedMetadata(profile, [peer], { recipientSessionId: "other" })]) {
		assert.equal(unavailable.status, "unavailable");
		assert.equal(unavailable.snapshot, undefined);
		assert.equal(unavailable.ownerReply, false);
		assert.equal(unavailable.authority, "none");
	}
	publisher.dispose();
	const replacement = PresencePublisher.start({ profile, sessionId: "peer", label: "Review", activity: [] });
	t.after(() => replacement.dispose());
	replacement.updateDiscovery(peer, { workspace: "/repo", tasks: [] });
	assert.notEqual(consult().digest, result.digest, "incarnation is part of snapshot identity");
});
test("extra authority/source bytes fail closed and withdrawn notes remain explicit", t => {
	const { publisher, consult, sidecar } = fixture(t);
	const state = { schema: 1 as const, sessionId: "peer", cwd: "/repo", recordedAt: 1, source: "owner-curated" as const,
		ownerReply: false as const, authority: "none" as const, state: { progress: "Published" } };
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [], state });
	const original = JSON.parse(readFileSync(sidecar, "utf8"));
	for (const invalid of [{ ...state, authority: "grant" }, { ...state, ownerReply: true }, { ...state, sessionId: "other" },
		{ ...state, consent: true }, { ...state, state: { progress: "x".repeat(2049) } }]) {
		writeFileSync(sidecar, JSON.stringify({ ...original, metadata: { ...original.metadata, state: invalid } }));
		assert.equal(consult().snapshot?.state, null);
		assert.ok(consult().unknowns.includes("curated-state"));
	}
	for (const bytes of ["{broken", JSON.stringify({ ...original, authority: "grant" }), JSON.stringify(original) + " ".repeat(16 * 1024)]) {
		writeFileSync(sidecar, bytes);
		assert.equal(consult().status, "unavailable");
	}
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [], state: { ...state, state: null } });
	assert.equal(consult().snapshot?.state?.state, null);
	assert.ok(!consult().unknowns.includes("curated-state"));
});
test("whole snapshot byte overflow is unavailable; entry gaps have exact counts", t => {
	const { publisher, consult } = fixture(t);
	const tasks = Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, label: "Check", status: "running", cwd: "/repo" }));
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered: tasks.map((_, i) => `/root/${i}`) });
	const bounded = consult();
	assert.equal(bounded.snapshot?.omittedTasks, 62);
	assert.equal(bounded.snapshot?.catalog?.omittedTasks, 6);
	assert.equal(bounded.snapshot?.catalog?.omittedRegistered, 6);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= CONSULTATION_BYTES);
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: tasks.slice(0, 8).map(t => ({ ...t, id: "😀".repeat(119), label: "😀".repeat(120), cwd: "/" + "r".repeat(118) })) });
	const tooLarge = consult();
	assert.equal(tooLarge.status, "unavailable");
	assert.deepEqual(tooLarge.unknowns, ["snapshot-too-large"]);
	assert.equal(tooLarge.snapshot, undefined);
	assert.ok(Object.isFrozen(tooLarge));
	assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) <= CONSULTATION_BYTES);
});
