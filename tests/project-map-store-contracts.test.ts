import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireProjectMapStoreLock, initializeProjectMapStore, releaseProjectMapStoreLock } from "../lib/project-map-store.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, serializeProjectMapStoreValue } from "../lib/project-map-store-schema.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-09-24T12:00:00.000Z";
const LATER = "2026-09-24T12:01:00.000Z";
const DIGEST = `sha256:${"b".repeat(64)}`;

async function contracts(): Promise<typeof import("../lib/project-map-store-contracts.ts") | null> {
	return await import("../lib/project-map-store-contracts.ts").catch(() => null);
}

function contractPath(root: string, capabilityId: string, contractId: string): string {
	return join(root, "contracts", createHash("sha256").update(capabilityId).digest("hex"), `${createHash("sha256").update(contractId).digest("hex")}.json`);
}

function withRoot(run: (root: string) => Promise<void> | void): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-contracts-"));
	return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function initialize(root: string): void {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
	assert.ok(result.descriptor, result.diagnostics.map((entry) => entry.message).join("\n"));
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((entry) => entry.code);
}

function proposal(module: NonNullable<Awaited<ReturnType<typeof contracts>>>, root: string, contractId: string, options: Partial<{ capabilityId: string; title: string; digest: string; sessionId: string; now: string }> = {}) {
	return module.proposeProjectMapContract({ root, capabilityId: options.capabilityId ?? "project-map", contractId, title: options.title ?? "Shared boundary", digest: options.digest ?? DIGEST, sessionId: options.sessionId ?? "session-a", now: options.now ?? NOW });
}

test("proposes two contracts for one capability and reads both exact records", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.deepEqual(proposal(module, root, "contract-a").diagnostics, []);
		assert.deepEqual(proposal(module, root, "contract-b", { title: "Another boundary", sessionId: "session-b" }).diagnostics, []);
		assert.deepEqual(module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a" }), {
			contract: { schema: "gentle-shell.project-map-store/v1", kind: "contract-proposal", capability_id: "project-map", contract_id: "contract-a", title: "Shared boundary", digest: DIGEST, proposed_by: "session-a", proposed_at: NOW, state: "proposed" },
			status: "proposed",
			diagnostics: [],
		});
		assert.equal(module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-b" }).contract?.title, "Another boundary");
	});
});

test("refuses a duplicate proposal without changing contract bytes", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a").contract);
		const path = contractPath(root, "project-map", "contract-a");
		const before = readFileSync(path, "utf8");
		const refused = proposal(module, root, "contract-a", { title: "Replacement" });
		assert.equal(refused.contract, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_EXISTS]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("accepts a proposal while preserving every proposal field and canonical bytes", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		// Deliberately different from every fixture default, so an implementation that reset the
		// proposal metadata on decision could not pass.
		const proposed = proposal(module, root, "contract-a", { title: "Boundary with varied metadata", digest: `sha256:${"c".repeat(64)}`, sessionId: "session-proposer", now: "2026-09-24T11:00:00.000Z" });
		assert.ok(proposed.contract);
		const decided = module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "accepted", rationale: "Boundary approved", sessionId: "session-lead", now: LATER });
		assert.deepEqual(decided.diagnostics, []);
		assert.deepEqual(decided.contract, { schema: "gentle-shell.project-map-store/v1", kind: "contract-proposal", capability_id: "project-map", contract_id: "contract-a", title: "Boundary with varied metadata", digest: `sha256:${"c".repeat(64)}`, proposed_by: "session-proposer", proposed_at: "2026-09-24T11:00:00.000Z", state: "accepted", decided_by: "session-lead", decided_at: LATER, rationale: "Boundary approved" });
		const reread = module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a" });
		assert.deepEqual(reread, { contract: decided.contract, status: "accepted", diagnostics: [] });
		assert.deepEqual({ title: reread.contract?.title, digest: reread.contract?.digest, proposed_by: reread.contract?.proposed_by, proposed_at: reread.contract?.proposed_at }, { title: "Boundary with varied metadata", digest: `sha256:${"c".repeat(64)}`, proposed_by: "session-proposer", proposed_at: "2026-09-24T11:00:00.000Z" });
		assert.equal(readFileSync(contractPath(root, "project-map", "contract-a"), "utf8"), serializeProjectMapStoreValue("contract-proposal", decided.contract).record);
	});
});

test("rejects a proposal with the decided record shape and without arbitrating the decider", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a", { title: "Varied rejection metadata", sessionId: "session-proposer" }).contract);
		// The store records who decided and never checks that it is the lead: arbitration is the
		// projection's and the command's job, and this assertion is what pins that.
		const decided = module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "rejected", rationale: "Boundary conflicts", sessionId: "session-anyone", now: LATER });
		assert.equal(decided.contract?.state, "rejected");
		assert.equal(decided.contract?.decided_by, "session-anyone");
		assert.equal(decided.contract?.decided_at, LATER);
		assert.equal(decided.contract?.rationale, "Boundary conflicts");
		assert.equal(decided.contract?.title, "Varied rejection metadata");
		assert.equal(decided.contract?.proposed_by, "session-proposer");
		assert.equal(module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a" }).status, "rejected");
	});
});

test("refuses a second decision and preserves the first decision bytes", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a").contract);
		assert.ok(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "accepted", rationale: "Approved", sessionId: "session-lead", now: LATER }).contract);
		const path = contractPath(root, "project-map", "contract-a");
		const before = readFileSync(path, "utf8");
		const refused = module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "rejected", rationale: "Overwritten", sessionId: "session-other", now: "2026-09-24T12:02:00.000Z" });
		assert.equal(refused.contract, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_ALREADY_DECIDED]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("reports an absent contract when deciding", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		const result = module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "missing", decision: "accepted", rationale: "Approved", sessionId: "session-lead", now: LATER });
		assert.equal(result.contract, null);
		assert.deepEqual(codes(result), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_ABSENT]);
	});
});

test("lists chronologically across offsets, with code-unit ties, and honours includeDecided", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "late-zulu", { now: "2026-09-24T12:00:00.000Z" }).contract);
		assert.ok(proposal(module, root, "early-offset", { now: "2026-09-24T12:30:00.000+01:00" }).contract);
		assert.ok(proposal(module, root, "a-tie", { now: NOW }).contract);
		assert.ok(proposal(module, root, "B-tie", { now: NOW }).contract);
		assert.ok(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "a-tie", decision: "accepted", rationale: "Approved", sessionId: "session-lead", now: LATER }).contract);
		assert.deepEqual(module.listProjectMapContracts({ root, capabilityId: "project-map", includeDecided: false }).contracts.map((contract) => contract.contract_id), ["early-offset", "B-tie", "late-zulu"]);
		assert.deepEqual(module.listProjectMapContracts({ root, capabilityId: "project-map", includeDecided: true }).contracts.map((contract) => contract.contract_id), ["early-offset", "B-tie", "a-tie", "late-zulu"]);
	});
});

test("classifies non-canonical and mismatched contract records as corrupted", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		const capabilityId = "project-map";
		const contractId = "contract-a";
		const contract = { schema: "gentle-shell.project-map-store/v1", kind: "contract-proposal", capability_id: capabilityId, contract_id: contractId, title: "Shared boundary", digest: DIGEST, proposed_by: "session-a", proposed_at: NOW, state: "proposed" } as const;
		const path = contractPath(root, capabilityId, contractId);
		mkdirSync(join(root, "contracts", createHash("sha256").update(capabilityId).digest("hex")), { recursive: true });
		writeFileSync(path, JSON.stringify(contract), "utf8");
		assert.equal(module.readProjectMapContract({ root, capabilityId, contractId }).status, "corrupted");
		writeFileSync(path, serializeProjectMapStoreValue("contract-proposal", { ...contract, capability_id: "other-capability" }).record!, "utf8");
		const capabilityMismatch = module.readProjectMapContract({ root, capabilityId, contractId });
		assert.equal(capabilityMismatch.status, "corrupted");
		assert.ok(capabilityMismatch.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED && entry.path === "$.capability_id"));
		writeFileSync(path, serializeProjectMapStoreValue("contract-proposal", { ...contract, contract_id: "other-contract" }).record!, "utf8");
		const contractMismatch = module.readProjectMapContract({ root, capabilityId, contractId });
		assert.equal(contractMismatch.status, "corrupted");
		assert.ok(contractMismatch.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED && entry.path === "$.contract_id"));
	});
});

test("classifies a decided contract missing rationale as corrupted through the pairing rule alone", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		const path = contractPath(root, "project-map", "contract-a");
		mkdirSync(join(root, "contracts", createHash("sha256").update("project-map").digest("hex")), { recursive: true });
		// Canonical bytes for a record that carries a decision without its rationale: built by hand
		// because the serializer refuses to produce one. The pairing rule is therefore the only
		// rejection reason, which is what makes this test discriminate.
		const decidedWithoutRationale = { schema: "gentle-shell.project-map-store/v1", kind: "contract-proposal", capability_id: "project-map", contract_id: "contract-a", title: "Shared boundary", digest: DIGEST, proposed_by: "session-a", proposed_at: NOW, state: "accepted", decided_by: "session-lead", decided_at: LATER };
		writeFileSync(path, `${JSON.stringify(decidedWithoutRationale, null, 2)}\n`, "utf8");
		const read = module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a" });
		assert.equal(read.status, "corrupted");
		assert.ok(read.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD && entry.path === "$.rationale"));
	});
});

test("reports free for a missing record and unreadable for one it cannot read", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.equal(module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "missing" }).status, "free");
		const path = contractPath(root, "project-map", "contract-a");
		mkdirSync(join(root, "contracts", createHash("sha256").update("project-map").digest("hex")), { recursive: true });
		writeFileSync(path, serializeProjectMapStoreValue("contract-proposal", { schema: "gentle-shell.project-map-store/v1", kind: "contract-proposal", capability_id: "project-map", contract_id: "contract-a", title: "Shared boundary", digest: DIGEST, proposed_by: "session-a", proposed_at: NOW, state: "proposed" }).record!, "utf8");
		chmodSync(path, 0o000);
		assert.equal(module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a" }).status, "unreadable");
	});
});

test("refuses mutations while the store lock is held and keeps lock-free reads working", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a").contract);
		const path = contractPath(root, "project-map", "contract-a");
		const before = readFileSync(path, "utf8");
		const held = acquireProjectMapStoreLock(root, NOW);
		assert.ok(held.handle);
		assert.deepEqual(codes(proposal(module, root, "contract-b")), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED]);
		assert.deepEqual(codes(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "accepted", rationale: "Approved", sessionId: "session-lead", now: LATER })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED]);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.equal(module.readProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a" }).status, "proposed");
		assert.deepEqual(module.listProjectMapContracts({ root, capabilityId: "project-map", includeDecided: true }).contracts.map((contract) => contract.contract_id), ["contract-a"]);
		assert.deepEqual(releaseProjectMapStoreLock(root, held.handle!), []);
	});
});

test("refuses mutations on a corrupted descriptor and preserves contract bytes", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a").contract);
		const path = contractPath(root, "project-map", "contract-a");
		const before = readFileSync(path, "utf8");
		writeFileSync(join(root, "store.json"), "not json", "utf8");
		assert.ok(codes(proposal(module, root, "contract-b")).includes(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE));
		assert.ok(codes(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "accepted", rationale: "Approved", sessionId: "session-lead", now: LATER })).includes(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE));
		assert.equal(readFileSync(path, "utf8"), before);
		assert.equal(readFileSync(join(root, "store.json"), "utf8"), "not json");
	});
});

test("refuses invalid mutation inputs without writing or leaving a lock behind", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		const path = contractPath(root, "project-map", "contract-a");
		assert.deepEqual(codes(proposal(module, root, "contract-a", { now: "not-an-instant" })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.deepEqual(codes(proposal(module, root, "contract-a", { title: "" })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.deepEqual(codes(proposal(module, root, "contract-a", { sessionId: "" })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.deepEqual(codes(proposal(module, root, "contract-a", { digest: "not-a-digest" })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.equal(existsSync(path), false);
		assert.equal(existsSync(join(root, "store.lock")), false);
		assert.ok(proposal(module, root, "contract-a").contract);
		const before = readFileSync(path, "utf8");
		assert.deepEqual(codes(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "accepted", rationale: "", sessionId: "session-lead", now: LATER })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("keeps decided records immutable for later proposals and decisions", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a").contract);
		assert.ok(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "accepted", rationale: "Approved", sessionId: "session-lead", now: LATER }).contract);
		const acceptedPath = contractPath(root, "project-map", "contract-a");
		const acceptedBytes = readFileSync(acceptedPath, "utf8");
		assert.deepEqual(codes(proposal(module, root, "contract-a", { title: "Replacement" })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_EXISTS]);
		assert.equal(readFileSync(acceptedPath, "utf8"), acceptedBytes);
		assert.ok(proposal(module, root, "contract-b").contract);
		assert.ok(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-b", decision: "rejected", rationale: "No", sessionId: "session-lead", now: LATER }).contract);
		const rejectedPath = contractPath(root, "project-map", "contract-b");
		const rejectedBytes = readFileSync(rejectedPath, "utf8");
		assert.deepEqual(codes(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-b", decision: "accepted", rationale: "Changed my mind", sessionId: "session-lead", now: "2026-09-24T12:02:00.000Z" })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_ALREADY_DECIDED]);
		assert.deepEqual(codes(proposal(module, root, "contract-b")), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_EXISTS]);
		assert.equal(readFileSync(rejectedPath, "utf8"), rejectedBytes);
	});
});

test("reports foreign and corrupt entries while listing one capability only", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a").contract);
		assert.ok(proposal(module, root, "other-contract", { capabilityId: "other-capability" }).contract);
		const directory = join(root, "contracts", createHash("sha256").update("project-map").digest("hex"));
		writeFileSync(join(directory, "broken.json"), "not json", "utf8");
		const foreign = { schema: "gentle-shell.project-map-store/v1", kind: "contract-proposal", capability_id: "other-capability", contract_id: "foreign", title: "Foreign", digest: DIGEST, proposed_by: "session-a", proposed_at: NOW, state: "proposed" } as const;
		writeFileSync(join(directory, `${createHash("sha256").update("foreign").digest("hex")}.json`), serializeProjectMapStoreValue("contract-proposal", foreign).record!, "utf8");
		const misplaced = { ...foreign, capability_id: "project-map", contract_id: "declared-y" };
		writeFileSync(join(directory, `${createHash("sha256").update("declared-z").digest("hex")}.json`), serializeProjectMapStoreValue("contract-proposal", misplaced).record!, "utf8");
		const listed = module.listProjectMapContracts({ root, capabilityId: "project-map", includeDecided: true });
		assert.deepEqual(listed.contracts.map((contract) => contract.contract_id), ["contract-a"]);
		assert.equal(listed.diagnostics.filter((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED).length, 3);
		assert.deepEqual(module.listProjectMapContracts({ root, capabilityId: "other-capability", includeDecided: true }).contracts.map((contract) => contract.contract_id), ["other-contract"]);
	});
});

test("refuses mutation operations on an uninitialized store without writing", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		rmSync(root, { recursive: true, force: true });
		assert.deepEqual(codes(proposal(module, root, "contract-a")), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.deepEqual(codes(module.decideProjectMapContract({ root, capabilityId: "project-map", contractId: "contract-a", decision: "accepted", rationale: "Approved", sessionId: "session-lead", now: LATER })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.equal(existsSync(root), false);
	});
});

test("hashes adversarial ids inside contracts without writing outside the store", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		const capabilityId = "../../outside/../capability";
		const contractId = "../outside/../contract";
		assert.ok(proposal(module, root, contractId, { capabilityId }).contract);
		assert.equal(existsSync(contractPath(root, capabilityId, contractId)), true);
		assert.deepEqual(readdirSync(join(root, "contracts")), [createHash("sha256").update(capabilityId).digest("hex")]);
		assert.deepEqual(readdirSync(join(root, "contracts", createHash("sha256").update(capabilityId).digest("hex"))), [`${createHash("sha256").update(contractId).digest("hex")}.json`]);
		assert.equal(existsSync(join(root, "outside")), false);
	});
});

test("refuses a contract whose raw bytes are not the canonical record", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		const capabilityId = "project-map";
		const contractId = "contract-a";
		const contract = { schema: "gentle-shell.project-map-store/v1", kind: "contract-proposal", capability_id: capabilityId, contract_id: contractId, title: "Boundary \uFFFD", digest: DIGEST, proposed_by: "session-a", proposed_at: NOW, state: "proposed" } as const;
		const canonical = Buffer.from(serializeProjectMapStoreValue("contract-proposal", contract).record!, "utf8");
		const marker = Buffer.from("\uFFFD", "utf8");
		const at = canonical.indexOf(marker);
		assert.notEqual(at, -1);
		// One invalid byte decodes to the same character, so a text-based comparison accepts it
		// while the bytes on disk are no longer the canonical record.
		const tampered = Buffer.concat([canonical.subarray(0, at), Buffer.from([0xff]), canonical.subarray(at + marker.length)]);
		const path = contractPath(root, capabilityId, contractId);
		mkdirSync(join(root, "contracts", createHash("sha256").update(capabilityId).digest("hex")), { recursive: true });
		writeFileSync(path, tampered);
		assert.equal(module.readProjectMapContract({ root, capabilityId, contractId }).status, "corrupted");
	});
});

test("ignores an in-flight tmp entry while listing contracts", async () => {
	const module = await contracts();
	assert.ok(module, "contract store module must be implemented");
	await withRoot((root) => {
		initialize(root);
		assert.ok(proposal(module, root, "contract-a").contract);
		writeFileSync(join(root, "contracts", createHash("sha256").update("project-map").digest("hex"), "publication.tmp"), "not store evidence", "utf8");
		const listed = module.listProjectMapContracts({ root, capabilityId: "project-map", includeDecided: true });
		assert.deepEqual(listed.contracts.map((contract) => contract.contract_id), ["contract-a"]);
		assert.deepEqual(listed.diagnostics, []);
	});
});
