import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { acquireProjectMapClaim } from "../lib/project-map-store-claims.ts";
import { initializeProjectMapStore } from "../lib/project-map-store.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, serializeProjectMapStoreValue, type ProjectMapStoreHeartbeatV1, type ProjectMapStoreSessionBindingV1 } from "../lib/project-map-store-schema.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const INCARNATION_A = "123e4567-e89b-12d3-a456-426614174001";
const INCARNATION_B = "123e4567-e89b-12d3-a456-426614174002";
const NOW = "2026-09-24T12:00:00.000Z";
const LATER = "2026-09-24T12:00:10.000Z";
const STALE = "2026-09-24T12:01:00.000Z";

async function heartbeats() {
	return import("../lib/project-map-store-heartbeats.ts");
}

function heartbeatPath(root: string, sessionId: string): string {
	return join(root, "heartbeats", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function bindingPath(root: string, sessionId: string): string {
	return join(root, "sessions", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-heartbeats-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function initialize(root: string): void {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
	assert.ok(result.descriptor, result.diagnostics.map((entry) => entry.message).join("\n"));
	assert.deepEqual(result.diagnostics, []);
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((entry) => entry.code);
}

function exitedPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.ok(result.pid);
	return result.pid;
}

test("exports the fixed heartbeat intervals", async () => {
	const { PROJECT_MAP_STORE_HEARTBEAT_INTERVAL_MS, PROJECT_MAP_STORE_HEARTBEAT_STALE_MS } = await heartbeats();
	assert.equal(PROJECT_MAP_STORE_HEARTBEAT_INTERVAL_MS, 10_000);
	assert.equal(PROJECT_MAP_STORE_HEARTBEAT_STALE_MS, 60_000);
});

test("writes a first canonical heartbeat and reads it as fresh", async () => {
	const { beatProjectMapStoreHeartbeat, readProjectMapStoreHeartbeat } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		const beat = beatProjectMapStoreHeartbeat({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, now: NOW });
		assert.ok(beat.heartbeat);
		assert.deepEqual(beat.diagnostics, []);
		assert.equal(readFileSync(heartbeatPath(root, "session-a"), "utf8"), serializeProjectMapStoreValue("heartbeat", beat.heartbeat).record);
		const read = readProjectMapStoreHeartbeat({ root, sessionId: "session-a", now: NOW });
		assert.equal(read.status, "fresh");
		assert.deepEqual(read.heartbeat, beat.heartbeat);
	});
});

test("refuses a heartbeat inside the cadence without changing bytes", async () => {
	const { beatProjectMapStoreHeartbeat } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		assert.ok(beatProjectMapStoreHeartbeat({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, now: NOW }).heartbeat);
		const path = heartbeatPath(root, "session-a");
		const before = readFileSync(path, "utf8");
		const refused = beatProjectMapStoreHeartbeat({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, now: "2026-09-24T12:00:09.999Z" });
		assert.equal(refused.heartbeat, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.HEARTBEAT_TOO_EARLY]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("rewrites a heartbeat at the cadence with its new owner values", async () => {
	const { beatProjectMapStoreHeartbeat } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		assert.ok(beatProjectMapStoreHeartbeat({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, now: NOW }).heartbeat);
		const rewritten = beatProjectMapStoreHeartbeat({ root, sessionId: "session-a", pid: 12345, incarnation: INCARNATION_B, now: LATER });
		assert.equal(rewritten.heartbeat?.beat_at, LATER);
		assert.equal(rewritten.heartbeat?.pid, 12345);
		assert.equal(rewritten.heartbeat?.incarnation, INCARNATION_B);
	});
});

test("classifies a heartbeat at the stale boundary as stale", async () => {
	const { beatProjectMapStoreHeartbeat, readProjectMapStoreHeartbeat } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		assert.ok(beatProjectMapStoreHeartbeat({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, now: NOW }).heartbeat);
		assert.equal(readProjectMapStoreHeartbeat({ root, sessionId: "session-a", now: STALE }).status, "stale");
	});
});

test("prunes only stale heartbeats with provably dead owners", async () => {
	const { beatProjectMapStoreHeartbeat, pruneProjectMapStoreHeartbeats } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		const deadSession = "dead";
		assert.ok(beatProjectMapStoreHeartbeat({ root, sessionId: deadSession, pid: exitedPid(), incarnation: INCARNATION_A, now: NOW }).heartbeat);
		assert.ok(beatProjectMapStoreHeartbeat({ root, sessionId: "fresh", pid: process.pid, incarnation: INCARNATION_A, now: STALE }).heartbeat);
		assert.ok(beatProjectMapStoreHeartbeat({ root, sessionId: "live-stale", pid: process.pid, incarnation: INCARNATION_A, now: NOW }).heartbeat);
		assert.ok(acquireProjectMapClaim({ root, capabilityId: "live-claim", sessionId: "live-stale", now: NOW }).claim);
		const pruned = pruneProjectMapStoreHeartbeats({ root, now: STALE });
		assert.deepEqual(pruned.removed, [deadSession]);
		assert.deepEqual(pruned.retained, ["live-stale"]);
		assert.equal(existsSync(heartbeatPath(root, deadSession)), false);
		assert.equal(existsSync(heartbeatPath(root, "fresh")), true);
		assert.equal(existsSync(join(root, "claims", `${createHash("sha256").update("live-claim").digest("hex")}.json`)), true);
	});
});

test("classifies non-canonical and mismatched-session heartbeat files as corrupted", async () => {
	const { readProjectMapStoreHeartbeat } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		const heartbeat: ProjectMapStoreHeartbeatV1 = { schema: "gentle-shell.project-map-store/v1", kind: "heartbeat", session_id: "session-a", pid: process.pid, incarnation: INCARNATION_A, beat_at: NOW };
		mkdirSync(join(root, "heartbeats"));
		const path = heartbeatPath(root, "session-a");
		writeFileSync(path, JSON.stringify(heartbeat), "utf8");
		assert.equal(readProjectMapStoreHeartbeat({ root, sessionId: "session-a", now: NOW }).status, "corrupted");
		writeFileSync(path, serializeProjectMapStoreValue("heartbeat", { ...heartbeat, session_id: "other" }).record!, "utf8");
		const mismatched = readProjectMapStoreHeartbeat({ root, sessionId: "session-a", now: NOW });
		assert.equal(mismatched.status, "corrupted");
		assert.ok(mismatched.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED && entry.path === "$.session_id"));
	});
});

test("binds, refreshes, refuses a live holder, and takes over a dead holder", async () => {
	const { bindProjectMapStoreSession, readProjectMapStoreSessionBinding } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		const first = bindProjectMapStoreSession({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, workspaceRoot: "/first", now: NOW });
		assert.ok(first.binding);
		const refreshed = bindProjectMapStoreSession({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, workspaceRoot: "/second", now: LATER });
		assert.equal(refreshed.binding?.bound_at, LATER);
		assert.equal(refreshed.binding?.workspace_root, "/first");
		const path = bindingPath(root, "session-a");
		const before = readFileSync(path, "utf8");
		const held = bindProjectMapStoreSession({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_B, workspaceRoot: "/third", now: STALE });
		assert.equal(held.binding, null);
		assert.deepEqual(codes(held), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.SESSION_BINDING_HELD]);
		assert.equal(readFileSync(path, "utf8"), before);
		const deadPid = exitedPid();
		const dead: ProjectMapStoreSessionBindingV1 = { schema: "gentle-shell.project-map-store/v1", kind: "session-binding", session_id: "dead-session", pid: deadPid, incarnation: INCARNATION_A, workspace_root: "/dead", bound_at: NOW };
		writeFileSync(bindingPath(root, "dead-session"), serializeProjectMapStoreValue("session-binding", dead).record!, "utf8");
		const takeover = bindProjectMapStoreSession({ root, sessionId: "dead-session", pid: process.pid, incarnation: INCARNATION_B, workspaceRoot: "/new", now: STALE });
		assert.equal(takeover.binding?.incarnation, INCARNATION_B);
		assert.equal(readProjectMapStoreSessionBinding({ root, sessionId: "dead-session" }).binding?.pid, process.pid);
	});
});

test("proves only a different exited pid dead", async () => {
	const { projectMapStoreBindingProvesDead } = await heartbeats();
	assert.equal(projectMapStoreBindingProvesDead({ pid: process.pid } as ProjectMapStoreSessionBindingV1), false);
	assert.equal(projectMapStoreBindingProvesDead({ pid: exitedPid() } as ProjectMapStoreSessionBindingV1), true);
});

test("refuses heartbeat and binding writes without a descriptor and creates nothing", async () => {
	const { beatProjectMapStoreHeartbeat, bindProjectMapStoreSession } = await heartbeats();
	withRoot((root) => {
		rmSync(root, { recursive: true, force: true });
		const heartbeat = beatProjectMapStoreHeartbeat({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, now: NOW });
		const binding = bindProjectMapStoreSession({ root, sessionId: "session-a", pid: process.pid, incarnation: INCARNATION_A, workspaceRoot: "/workspace", now: NOW });
		assert.equal(heartbeat.heartbeat, null);
		assert.equal(binding.binding, null);
		assert.deepEqual(codes(heartbeat), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.deepEqual(codes(binding), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.equal(existsSync(root), false);
	});
});

test("hashes adversarial session ids into heartbeat and binding directories", async () => {
	const { beatProjectMapStoreHeartbeat, bindProjectMapStoreSession } = await heartbeats();
	withRoot((root) => {
		initialize(root);
		const sessionId = "../../outside/../session";
		assert.ok(beatProjectMapStoreHeartbeat({ root, sessionId, pid: process.pid, incarnation: INCARNATION_A, now: NOW }).heartbeat);
		assert.ok(bindProjectMapStoreSession({ root, sessionId, pid: process.pid, incarnation: INCARNATION_A, workspaceRoot: "/workspace", now: NOW }).binding);
		const name = `${createHash("sha256").update(sessionId).digest("hex")}.json`;
		assert.deepEqual(readdirSync(join(root, "heartbeats")), [name]);
		assert.deepEqual(readdirSync(join(root, "sessions")), [name]);
		assert.equal(existsSync(join(root, "outside")), false);
	});
});
