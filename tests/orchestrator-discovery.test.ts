import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PresencePublisher, listPresence } from "../lib/orchestrator-presence.ts";
import { ActiveSessionListener, SessionPresenceRegistry } from "../lib/agents-session-transport.ts";
import { discoverOrchestrators } from "../lib/orchestrator-discovery.ts";

function fixture(t: TestContext) {
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "discovery-")));
	t.after(() => rmSync(profile, { recursive: true, force: true }));
	return profile;
}
const peer = { version: 1 as const, sessionId: "peer", endpoint: "/socket/activation", createdAt: 1 };
// Frozen schema-1 contract, independent of current Header types and Git history.
function assertLegacyHeader(h: Record<string, any>) {
	assert.deepEqual(Object.keys(h).sort(), ["schema", "sessionHash", "incarnation", "label", "heartbeat", "generation", "counts", "digest", "unavailable"].sort());
	assert.equal(h.schema, 1);
	assert.match(h.sessionHash, /^[a-f0-9]{64}$/);
	assert.match(h.incarnation, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
	assert.equal(typeof h.label, "string");
	assert.ok(Array.from(h.label).length <= 120);
	assert.equal(h.label, h.label.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim());
	for (const value of [h.heartbeat, h.generation]) assert.ok(Number.isSafeInteger(value) && value >= 0);
	assert.ok(h.generation > 0);
	assert.deepEqual(Object.keys(h.counts).sort(), ["running", "queued", "waiting", "finished"].sort());
	for (const value of Object.values(h.counts)) assert.ok(Number.isSafeInteger(value) && (value as number) >= 0);
	if (h.unavailable === null) assert.match(h.digest, /^[a-f0-9]{64}$/);
	else {
		assert.equal(h.unavailable, "activity-too-large");
		assert.equal(h.digest, null);
	}
}

test("published headers retain the frozen legacy schema-1 contract after metadata update", (t) => {
	const profile = fixture(t);
	const publisher = PresencePublisher.start({ profile, sessionId: "peer", label: "Review", activity: [] });
	t.after(() => publisher.dispose());
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [] });
	const name = `${publisher.target.sessionHash}.${publisher.target.incarnation}.header.json`;
	const header = JSON.parse(readFileSync(join(profile, "gentle-agents", "presence", name), "utf8"));
	assertLegacyHeader(header);
	assert.throws(() => assertLegacyHeader({ ...header, discovery: {} }));
	assert.throws(() => assertLegacyHeader({ ...header, schema: 2 }));
	const sidecar = join(profile, "gentle-agents", "presence", name.replace("header.json", "discovery.json"));
	const value = JSON.parse(readFileSync(sidecar, "utf8"));
	for (const invalid of ["{broken", JSON.stringify({ ...value, generation: 999 }), JSON.stringify({ ...value, incarnation: "other" }), JSON.stringify({ ...value, metadata: {} })]) {
		writeFileSync(sidecar, invalid);
		assert.equal(listPresence(profile).entries.length, 1);
		assert.equal(discoverOrchestrators(profile, [peer])[0].freshness, "unknown");
	}
	rmSync(sidecar);
	assert.equal(listPresence(profile).entries.length, 1);
	assert.equal(discoverOrchestrators(profile, [peer])[0].freshness, "unknown");
});
test("joins activation-bound metadata without exporting prompts or thread output", (t) => {
	const profile = fixture(t);
	const publisher = PresencePublisher.start({ profile, sessionId: peer.sessionId, label: "Review auth", activity: [] });
	try {
		publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [{ id: "t1", label: "Verify auth", status: "running", cwd: "/repo-child", prompt: "PRIVATE PROMPT", result: "PRIVATE OUTPUT" } as never] });
		const [candidate] = discoverOrchestrators(profile, [peer]);
		assert.equal(candidate.label, "Review auth");
		assert.equal(candidate.workspace, "/repo");
		assert.deepEqual(candidate.tasks, [{ id: "t1", label: "Verify auth", status: "running", workspace: "/repo-child" }]);
		assert.equal(candidate.reachability, "unknown");
		assert.doesNotMatch(JSON.stringify(candidate), /PRIVATE|endpoint|activation/);
		assert.equal(discoverOrchestrators(profile, [{ ...peer, endpoint: "/socket/replacement" }])[0].freshness, "unknown");
		assert.equal(discoverOrchestrators(profile, [peer], Date.now() + 20_000)[0].freshness, "stale");
		assert.equal(discoverOrchestrators(profile, [peer], 0)[0].freshness, "stale");
		assert.equal(discoverOrchestrators(profile, [peer, { ...peer, endpoint: "/socket/duplicate" }])[0].freshness, "unknown");
		publisher.updateDiscovery(peer, { workspace: "/" + "x".repeat(121), tasks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: "\u001b[31mCheck\n auth", status: "queued", cwd: "/repo\nother" })) });
		const bounded = discoverOrchestrators(profile, [peer])[0];
		assert.equal(bounded.workspace, "");
		assert.equal(bounded.tasks?.length, 8);
		assert.equal(bounded.omitted, 2);
		assert.equal(bounded.tasks?.[0].label, "Check auth");
		assert.equal(bounded.tasks?.[0].workspace, "");
		assert.throws(() => publisher.updateDiscovery({ ...peer, sessionId: "other" }, { workspace: "/repo", tasks: [] }), /malformed/);
	} finally { publisher.dispose(); }
});

test("missing and ambiguous metadata never hide routing IDs", (t) => {
	const profile = fixture(t);
	assert.deepEqual(discoverOrchestrators(profile, [peer]), [{ sessionId: "peer", reachability: "unknown", freshness: "unknown" }]);
	const publishers = [1, 2].map(() => PresencePublisher.start({ profile, sessionId: "peer", label: "Same name", activity: [] }));
	try {
		for (const publisher of publishers) publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [] });
		assert.equal(discoverOrchestrators(profile, [peer])[0].freshness, "unknown");
		assert.throws(() => publishers[0].updateDiscovery(peer, { workspace: "/repo", tasks: [{ id: "x", label: "x", status: "invented", cwd: "/repo" }] }), /malformed/);
	} finally { publishers.forEach(publisher => publisher.dispose()); }
	writeFileSync(join(profile, "gentle-agents", "presence", "invalid.header.json"), "{not-json");
	assert.equal(discoverOrchestrators(profile, [peer])[0].freshness, "unknown");
});

test("real POSIX registry selects one routing activation; another activation's metadata cannot join", { skip: process.platform === "win32" }, async (t) => {
	const profile = fixture(t);
	const publisher = PresencePublisher.start({ profile, sessionId: "peer", label: "Selected peer", activity: [] });
	t.after(() => publisher.dispose());
	const registry = await SessionPresenceRegistry.create(profile);
	const listeners = [1, 2].map(() => new ActiveSessionListener(registry, "peer", async () => {}));
	t.after(async () => { await Promise.all(listeners.map(listener => listener.close())); });
	for (const listener of listeners) await listener.start();
	const selected = await registry.listActivations();
	assert.equal(selected.length, 1);
	assert.deepEqual(selected[0], await registry.resolve("peer"));
	const other = listeners.map(listener => listener.record!).find(record => record.endpoint !== selected[0].endpoint)!;
	publisher.updateDiscovery(other, { workspace: "/wrong", tasks: [] });
	assert.equal(discoverOrchestrators(profile, selected)[0].freshness, "unknown");
	publisher.updateDiscovery(selected[0], { workspace: "/selected", tasks: [] });
	assert.equal(discoverOrchestrators(profile, selected)[0].workspace, "/selected");
	assert.equal(discoverOrchestrators(profile, selected)[0].reachability, "unknown");
});

test("duplicate display names do not become routing identities", (t) => {
	const profile = fixture(t);
	const peers = [peer, { ...peer, sessionId: "other", endpoint: "/socket/other" }];
	const publishers = peers.map(p => PresencePublisher.start({ profile, sessionId: p.sessionId, label: "Same name", activity: [] }));
	try {
		publishers.forEach((publisher, i) => publisher.updateDiscovery(peers[i], { workspace: `/repo${i}`, tasks: [] }));
		const candidates = discoverOrchestrators(profile, peers);
		assert.deepEqual(candidates.map(c => c.label), ["Same name", "Same name"]);
		assert.deepEqual(candidates.map(c => c.sessionId), ["peer", "other"]);
		assert.deepEqual(candidates.map(c => c.workspace), ["/repo0", "/repo1"]);
	} finally { publishers.forEach(publisher => publisher.dispose()); }
});
