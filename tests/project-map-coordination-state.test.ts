import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { raiseProjectMapStoreBlocker } from "../lib/project-map-store-blockers.ts";
import { acquireProjectMapClaim } from "../lib/project-map-store-claims.ts";
import { proposeProjectMapContract } from "../lib/project-map-store-contracts.ts";
import { beatProjectMapStoreHeartbeat } from "../lib/project-map-store-heartbeats.ts";
import { advanceProjectMapStore, initializeProjectMapStore } from "../lib/project-map-store.ts";
import { issueProjectMapStoreReadinessReceipt } from "../lib/project-map-store-receipts.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES } from "../lib/project-map-store-schema.ts";
import { PROJECT_MAP_SCHEMA_V1, serializeProjectMap, type ProjectMapCapabilityV1, type ProjectMapV1 } from "../lib/shell-project-map-schema.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-09-25T12:00:00.000Z";
const LATER = "2026-09-25T12:01:00.000Z";
const INCARNATION = "223e4567-e89b-12d3-a456-426614174000";
const DIGEST = `sha256:${"b".repeat(64)}`;

type CoordinationState = {
	map: ProjectMapV1 | null;
	lead: { capabilityId: string; sessionId: string | null; lease: { renewal_after: string; renew_by: string } | null; status: "free" | "live" | "stale" | "corrupted" };
	satellites: Array<{ capabilityId: string; sessionId: string; lease: { renewal_after: string; renew_by: string }; status: "live" | "stale"; heartbeat: "fresh" | "stale" | "missing" | "corrupted" }>;
	conflicts: Array<{ code: string; capabilityId?: string; sessionId?: string; message: string }>;
	capabilities: Array<{ capabilityId: string; dependencyReady: boolean; complete: boolean; openBlockers: number; proposedContracts: number; nextSafeAction: string }>;
	diagnostics: Array<{ code: string; path: string; message: string; severity: string }>;
};

async function readState(options: { root: string; mapPath: string; now: string; expectedGeneration?: number }): Promise<CoordinationState> {
	const subject = await import("../lib/project-map-coordination-state.ts").catch(() => ({})) as {
		readProjectMapCoordinationState?: (options: { root: string; mapPath: string; now: string; expectedGeneration?: number }) => CoordinationState;
	};
	assert.equal(typeof subject.readProjectMapCoordinationState, "function", "readProjectMapCoordinationState must be exported by project-map-coordination-state.ts");
	return subject.readProjectMapCoordinationState!(options);
}

function capability(id: string, options: Partial<Pick<ProjectMapCapabilityV1, "dependsOn" | "surfaces" | "state">> = {}): ProjectMapCapabilityV1 {
	return {
		id,
		outcome: `${id} is available.`,
		foundationRefs: [],
		dependsOn: options.dependsOn ?? [],
		contracts: [],
		featureDocs: [],
		surfaces: options.surfaces ?? ["web"],
		state: options.state ?? "planned",
	};
}

function projectMap(capabilities: ProjectMapCapabilityV1[]): ProjectMapV1 {
	return {
		version: PROJECT_MAP_SCHEMA_V1,
		project: { id: "example-project", name: "Example Project" },
		approval: { state: "draft" },
		foundations: [],
		capabilities,
	};
}

function withFixture(run: (fixture: { root: string; mapPath: string }) => Promise<void> | void, map = projectMap([capability("catalog")])): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "project-map-coordination-state-"));
	const mapPath = join(root, "project-map.json");
	writeFileSync(mapPath, serializeProjectMap(map), "utf8");
	const initialized = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
	assert.ok(initialized.descriptor, initialized.diagnostics.map((entry) => entry.message).join("\n"));
	return Promise.resolve(run({ root, mapPath })).finally(() => rmSync(root, { recursive: true, force: true }));
}

function claim(root: string, capabilityId: string, sessionId: string, now = NOW): void {
	const result = acquireProjectMapClaim({ root, capabilityId, sessionId, now });
	assert.ok(result.claim, result.diagnostics.map((entry) => entry.message).join("\n"));
}

function heartbeat(root: string, sessionId: string, now = NOW): void {
	const result = beatProjectMapStoreHeartbeat({ root, sessionId, pid: process.pid, incarnation: INCARNATION, now });
	assert.ok(result.heartbeat, result.diagnostics.map((entry) => entry.message).join("\n"));
}

function receipt(root: string, capabilityId: string, now = NOW): void {
	const result = issueProjectMapStoreReadinessReceipt({ root, capabilityId, issuedBy: "session-receipt", verified: ["focused-tests"], evidence: ["node --test"], now });
	assert.ok(result.receipt, result.diagnostics.map((entry) => entry.message).join("\n"));
}

function stateFor(state: CoordinationState, capabilityId: string): CoordinationState["capabilities"][number] {
	const entry = state.capabilities.find((candidate) => candidate.capabilityId === capabilityId);
	assert.ok(entry, `missing capability ${capabilityId}`);
	return entry;
}

function conflictCodes(state: CoordinationState): string[] {
	return state.conflicts.map((conflict) => conflict.code);
}

function claimPath(root: string, capabilityId: string): string {
	return join(root, "claims", `${createHash("sha256").update(capabilityId).digest("hex")}.json`);
}

function storeSnapshot(root: string, relative = ""): Array<{ path: string; bytes: Buffer | null }> {
	const directory = join(root, relative);
	const entries = readdirSync(directory).sort();
	const result: Array<{ path: string; bytes: Buffer | null }> = [{ path: relative || ".", bytes: null }];
	for (const entry of entries) {
		const child = relative === "" ? entry : join(relative, entry);
		if (statSync(join(root, child)).isDirectory()) result.push(...storeSnapshot(root, child));
		else result.push({ path: child, bytes: readFileSync(join(root, child)) });
	}
	return result;
}

test("a free store projects no lead, satellites, or conflicts", async () => {
	await withFixture(async ({ root, mapPath }) => {
		const state = await readState({ root, mapPath, now: NOW });
		assert.equal(state.map?.project.id, "example-project");
		assert.deepEqual(state.lead, { capabilityId: "__lead", sessionId: null, lease: null, status: "free" });
		assert.deepEqual(state.satellites, []);
		assert.deepEqual(state.conflicts, []);
		assert.equal(stateFor(state, "catalog").nextSafeAction, "claim");
		assert.deepEqual(state.diagnostics, []);
	});
});

test("a live lead claim projects its session, lease, and live status", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "__lead", "lead-session");
		const state = await readState({ root, mapPath, now: NOW });
		assert.deepEqual(state.lead, {
			capabilityId: "__lead",
			sessionId: "lead-session",
			lease: { renewal_after: "2026-09-25T12:00:10.000Z", renew_by: "2026-09-25T12:01:00.000Z" },
			status: "live",
		});
		// The reserved lead id is the lead, never a satellite.
		assert.deepEqual(state.satellites, []);
		assert.deepEqual(state.conflicts, []);
	});
});

test("a stale lead is retained as stale with its previous holder named", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "__lead", "previous-lead");
		const state = await readState({ root, mapPath, now: LATER });
		assert.equal(state.lead.status, "stale");
		assert.equal(state.lead.sessionId, "previous-lead");
		assert.match(JSON.stringify(state.lead), /previous-lead/);
	});
});

test("two claimed capabilities appear as satellites", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "catalog", "session-a");
		claim(root, "checkout", "session-b");
		const state = await readState({ root, mapPath, now: NOW });
		assert.deepEqual(state.satellites.map((satellite) => [satellite.capabilityId, satellite.sessionId, satellite.status]), [["catalog", "session-a", "live"], ["checkout", "session-b", "live"]]);
	}, projectMap([capability("catalog"), capability("checkout")]));
});

test("a claim on an undeclared capability is an unknown-capability conflict", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "unknown-capability", "session-a");
		const state = await readState({ root, mapPath, now: NOW });
		const conflict = state.conflicts.find((candidate) => candidate.code === "unknown-capability");
		assert.deepEqual(conflict && { capabilityId: conflict.capabilityId, sessionId: conflict.sessionId }, { capabilityId: "unknown-capability", sessionId: "session-a" });
		assert.ok(state.satellites.some((satellite) => satellite.capabilityId === "unknown-capability"));
	});
});

test("a claimed capability with no declared surfaces is an undeclared-surfaces conflict", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "catalog", "session-a");
		const state = await readState({ root, mapPath, now: NOW });
		const conflict = state.conflicts.find((candidate) => candidate.code === "undeclared-surfaces");
		assert.deepEqual(conflict && { capabilityId: conflict.capabilityId, sessionId: conflict.sessionId }, { capabilityId: "catalog", sessionId: "session-a" });
	}, projectMap([capability("catalog", { surfaces: [] })]));
});

test("a live claim without a fresh heartbeat is an unavailable-peer conflict", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "catalog", "session-a");
		const state = await readState({ root, mapPath, now: NOW });
		const satellite = state.satellites.find((candidate) => candidate.capabilityId === "catalog");
		assert.equal(satellite?.heartbeat, "missing");
		assert.ok(state.conflicts.some((candidate) => candidate.code === "unavailable-peer" && candidate.capabilityId === "catalog" && candidate.sessionId === "session-a"));
	});
});

test("a map declaring the reserved lead capability reports reserved-capability-declared", async () => {
	await withFixture(async ({ root, mapPath }) => {
		const state = await readState({ root, mapPath, now: NOW });
		assert.ok(state.conflicts.some((candidate) => candidate.code === "reserved-capability-declared" && candidate.capabilityId === "__lead"));
	}, projectMap([capability("__lead")]));
});

test("a moved descriptor generation conflicts only with a stale expected generation", async () => {
	await withFixture(async ({ root, mapPath }) => {
		const before = readFileSync(join(root, "store.json"));
		const advanced = advanceProjectMapStore({
			root,
			expected: { generation: 0, epoch: EPOCH, predecessor: `sha256:${createHash("sha256").update(before).digest("hex")}` },
			now: LATER,
		});
		assert.equal(advanced.descriptor?.generation, 1);
		const stale = await readState({ root, mapPath, now: LATER, expectedGeneration: 0 });
		assert.ok(stale.conflicts.some((candidate) => candidate.code === "stale-generation"));
		const current = await readState({ root, mapPath, now: LATER, expectedGeneration: 1 });
		assert.equal(conflictCodes(current).includes("stale-generation"), false);
	});
});

test("dependency readiness follows dependency state and receipts, while completion follows its own receipt", async () => {
	await withFixture(async ({ root, mapPath }) => {
		let state = await readState({ root, mapPath, now: NOW });
		assert.equal(stateFor(state, "checkout").dependencyReady, false);
		assert.equal(stateFor(state, "catalog").complete, false);
		receipt(root, "catalog");
		state = await readState({ root, mapPath, now: NOW });
		assert.equal(stateFor(state, "catalog").complete, true);
		assert.equal(stateFor(state, "checkout").dependencyReady, true);
		assert.equal(stateFor(state, "checkout").complete, false);
		assert.equal(stateFor(state, "waiting").dependencyReady, false);
	}, projectMap([capability("catalog"), capability("checkout", { dependsOn: ["catalog"] }), capability("blocked-dependency", { state: "blocked" }), capability("waiting", { dependsOn: ["blocked-dependency"] })]));
});

test("next safe actions follow the documented priority order", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "work", "worker");
		heartbeat(root, "worker");
		raiseProjectMapStoreBlocker({ root, capabilityId: "resolve", blockerId: "blocker-a", owner: "owner", reason: "Needs decision", sessionId: "session-a", now: NOW });
		assert.ok(proposeProjectMapContract({ root, capabilityId: "contract", contractId: "boundary", title: "Boundary", digest: DIGEST, sessionId: "session-a", now: NOW }).contract);
		receipt(root, "integrate");
		const state = await readState({ root, mapPath, now: NOW });
		assert.deepEqual(Object.fromEntries(state.capabilities.map((entry) => [entry.capabilityId, entry.nextSafeAction])), {
			done: "done",
			blocked: "blocked",
			resolve: "resolve-blocker",
			wait: "wait-for-dependency",
			contract: "decide-contract",
			integrate: "integrate",
			work: "work",
			claim: "claim",
			"missing-dependency": "claim",
		});
	}, projectMap([
		capability("done", { state: "done" }),
		capability("blocked", { state: "blocked" }),
		capability("resolve"),
		capability("missing-dependency"),
		capability("wait", { dependsOn: ["missing-dependency"] }),
		capability("contract"),
		capability("integrate"),
		capability("work"),
		capability("claim"),
	]));
});

test("a corrupt descriptor, corrupt lead claim, and unreadable map yield diagnostics and unknown parts", async () => {
	await withFixture(async ({ root, mapPath }) => {
		writeFileSync(join(root, "store.json"), "not json", "utf8");
		let state = await readState({ root, mapPath, now: NOW });
		assert.ok(state.diagnostics.length > 0);
		assert.equal(state.map?.project.id, "example-project");

		const restored = initializeProjectMapStore({ root: join(root, "fresh-store"), repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
		assert.ok(restored.descriptor);
		claim(join(root, "fresh-store"), "__lead", "lead-session");
		writeFileSync(claimPath(join(root, "fresh-store"), "__lead"), "not json", "utf8");
		state = await readState({ root: join(root, "fresh-store"), mapPath, now: NOW });
		assert.equal(state.lead.status, "corrupted");
		assert.ok(state.diagnostics.length > 0);

		state = await readState({ root: join(root, "fresh-store"), mapPath: join(root, "missing-map.json"), now: NOW });
		assert.equal(state.map, null);
		assert.ok(state.diagnostics.length > 0);
	});
});

test("refuses the time-dependent parts when the instant cannot be parsed", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "catalog", "session-satellite");
		const state = await readState({ root, mapPath, now: "not-an-instant" });
		// A live claim must not be reported as stale just because the caller's instant is unusable.
		assert.deepEqual(state.satellites, []);
		assert.deepEqual(state.conflicts, []);
		assert.deepEqual(state.capabilities, []);
		assert.equal(state.lead.status, "corrupted");
		assert.ok(state.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD && entry.path === "$.now"));
	});
});

test("the projection writes nothing to the store", async () => {
	await withFixture(async ({ root, mapPath }) => {
		claim(root, "catalog", "session-a");
		heartbeat(root, "session-a");
		receipt(root, "catalog");
		mkdirSync(join(root, "claims"), { recursive: true });
		writeFileSync(join(root, "claims", "in-flight.tmp"), "half-written", "utf8");
		const before = storeSnapshot(root);
		await readState({ root, mapPath, now: NOW });
		assert.deepEqual(storeSnapshot(root), before);
	});
});
