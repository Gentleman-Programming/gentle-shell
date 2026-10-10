import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProjectMapStore } from "../lib/project-map-store.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, serializeProjectMapStoreValue, type ProjectMapStoreReadinessReceiptV1 } from "../lib/project-map-store-schema.ts";

const receipts = await import("../lib/project-map-store-receipts.ts").catch(() => ({})) as typeof import("../lib/project-map-store-receipts.ts");
const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-09-24T12:00:00.000Z";
const CAPABILITY_ID = "project-map";

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function receiptDirectory(root: string, capabilityId = CAPABILITY_ID): string {
	return join(root, "receipts", digest(capabilityId));
}

function canonicalReceiptBytes(value: ProjectMapStoreReadinessReceiptV1): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function receiptPath(root: string, receipt: ProjectMapStoreReadinessReceiptV1): string {
	const bytes = canonicalReceiptBytes(receipt);
	return join(receiptDirectory(root, receipt.capability_id), `${receipt.issued_at.replace(/[:.]/g, "-")}-${digest(bytes)}.json`);
}

function receipt(capabilityId = CAPABILITY_ID, issuedAt = NOW): ProjectMapStoreReadinessReceiptV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "readiness-receipt",
		capability_id: capabilityId,
		issued_by: "session-a",
		issued_at: issuedAt,
		verified: ["focused-tests"],
		evidence: ["node --test"],
		authority: "none",
	};
}

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-receipts-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function initialize(root: string): void {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
	assert.ok(result.descriptor, result.diagnostics.map((entry) => entry.message).join("\n"));
}

function issue(root: string, options: Partial<{ capabilityId: string; issuedBy: string; verified: string[]; evidence: string[]; now: string }> = {}) {
	return receipts.issueProjectMapStoreReadinessReceipt({
		root,
		capabilityId: options.capabilityId ?? CAPABILITY_ID,
		issuedBy: options.issuedBy ?? "session-a",
		verified: options.verified ?? ["focused-tests"],
		evidence: options.evidence ?? ["node --test"],
		now: options.now ?? NOW,
	});
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((entry) => entry.code);
}

function writeReceipt(root: string, entry: string, value: ProjectMapStoreReadinessReceiptV1, bytes = canonicalReceiptBytes(value)): string {
	const directory = receiptDirectory(root, value.capability_id);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, entry);
	writeFileSync(path, bytes, "utf8");
	return path;
}

test("pins the readiness receipt history limit", () => {
	assert.equal(receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT, 20);
});

test("issues a canonical readiness receipt and reads it back without authority", () => {
	withRoot((root) => {
		initialize(root);
		const issued = issue(root);
		assert.deepEqual(issued.diagnostics, []);
		assert.deepEqual(issued.receipt, receipt());
		assert.equal(readFileSync(receiptPath(root, issued.receipt!), "utf8"), serializeProjectMapStoreValue("readiness-receipt", issued.receipt).record);
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 10 });
		assert.deepEqual(read.diagnostics, []);
		assert.deepEqual(read.receipts, [issued.receipt]);
	});
});

test("reads one capability newest-first and bounded by limit", () => {
	withRoot((root) => {
		initialize(root);
		issue(root, { now: "2026-09-24T12:00:00.000Z", verified: ["first"] });
		issue(root, { now: "2026-09-24T12:01:00.000Z", verified: ["second"] });
		issue(root, { now: "2026-09-24T12:02:00.000Z", verified: ["third"] });
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 2 });
		assert.deepEqual(read.diagnostics, []);
		assert.deepEqual(read.receipts.map((entry: ProjectMapStoreReadinessReceiptV1) => entry.verified), [["third"], ["second"]]);
		assert.deepEqual(receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: -1 }).receipts, []);
	});
});

test("classifies a receipt granting delivery authority as corrupted", () => {
	withRoot((root) => {
		initialize(root);
		// The receipt-level fixture cannot isolate the authority rule on its own: canonical
		// form always rewrites `authority` to "none", so a record that somehow passed
		// validation would still fail the canonical check. The schema test is the one that
		// pins the rule; this one pins that such a file is never returned as a receipt.
		const value = { ...receipt(), authority: "delivery" } as unknown as ProjectMapStoreReadinessReceiptV1;
		const bytes = `${JSON.stringify(value, null, 2)}\n`;
		writeReceipt(root, `${NOW.replace(/[:.]/g, "-")}-${digest(bytes)}.json`, value, bytes);
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 10 });
		assert.deepEqual(read.receipts, []);
		assert.ok(codes(read).includes(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED));
	});
});

test("refuses a receipt whose raw bytes do not match its name digest", () => {
	withRoot((root) => {
		initialize(root);
		const value = { ...receipt(), evidence: ["\uFFFD"] };
		const canonical = Buffer.from(canonicalReceiptBytes(value), "utf8");
		const marker = Buffer.from("\uFFFD", "utf8");
		const at = canonical.indexOf(marker);
		assert.notEqual(at, -1);
		// One invalid byte decodes to the same U+FFFD character, so a text-based check
		// accepts it while the bytes on disk no longer match the name.
		const tampered = Buffer.concat([canonical.subarray(0, at), Buffer.from([0xff]), canonical.subarray(at + marker.length)]);
		const directory = receiptDirectory(root);
		mkdirSync(directory, { recursive: true });
		const path = join(directory, `${NOW.replace(/[:.]/g, "-")}-${digest(canonical)}.json`);
		writeFileSync(path, tampered);
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 10 });
		assert.deepEqual(read.receipts, []);
		assert.ok(codes(read).includes(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED));
	});
});

test("classifies non-canonical, mismatched, and digest-mismatched receipts as corrupted", () => {
	withRoot((root) => {
		initialize(root);
		const canonical = receipt();
		mkdirSync(receiptDirectory(root), { recursive: true });
		const compact = JSON.stringify(canonical);
		writeFileSync(join(receiptDirectory(root), `${NOW.replace(/[:.]/g, "-")}-${digest(compact)}.json`), compact, "utf8");
		const mismatched = { ...canonical, capability_id: "other-capability" };
		const mismatchedBytes = canonicalReceiptBytes(mismatched);
		writeFileSync(join(receiptDirectory(root), `${NOW.replace(/[:.]/g, "-")}-${digest(mismatchedBytes)}.json`), mismatchedBytes, "utf8");
		writeReceipt(root, `digest-mismatch-${digest("wrong-bytes")}.json`, canonical);
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 10 });
		assert.deepEqual(read.receipts, []);
		assert.equal(codes(read).filter((code) => code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED).length, 3);
		assert.ok(read.diagnostics.every((entry) => entry.path === "$"), "diagnostics report a JSON path, not a filesystem path");
	});
});

test("orders mixed ISO offsets chronologically rather than lexicographically", () => {
	withRoot((root) => {
		initialize(root);
		issue(root, { now: "2026-09-24T12:30:00.000+01:00", verified: ["earlier-offset"] });
		issue(root, { now: "2026-09-24T12:00:00.000Z", verified: ["later-zulu"] });
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 10 });
		assert.deepEqual(read.receipts.map((entry: ProjectMapStoreReadinessReceiptV1) => entry.verified), [["later-zulu"], ["earlier-offset"]]);
	});
});

test("prunes each capability to the history limit and removes the oldest bytes", () => {
	withRoot((root) => {
		initialize(root);
		const oldest = issue(root, { now: "2026-09-24T12:00:00.000Z", verified: ["oldest"] });
		const oldestPath = receiptPath(root, oldest.receipt!);
		for (let index = 1; index <= receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT; index += 1) {
			issue(root, { now: `2026-09-24T12:${String(index).padStart(2, "0")}:00.000Z`, verified: [`receipt-${index}`] });
		}
		assert.equal(existsSync(oldestPath), false);
		assert.equal(readdirSync(receiptDirectory(root)).length, receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT);
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 100 });
		assert.equal(read.receipts.length, receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT);
		assert.deepEqual(read.receipts.at(-1)?.verified, ["receipt-1"]);
	});
});

test("removes corrupt entries before retaining readable receipts during pruning", () => {
	withRoot((root) => {
		initialize(root);
		const corrupt = writeReceipt(root, "corrupt.json", receipt(), "not json");
		for (let index = 0; index < receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT; index += 1) {
			issue(root, { now: `2026-09-24T12:${String(index).padStart(2, "0")}:00.000Z`, verified: [`receipt-${index}`] });
		}
		issue(root, { now: "2026-09-24T13:00:00.000Z", verified: ["newest"] });
		assert.equal(existsSync(corrupt), false);
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 100 });
		assert.equal(read.receipts.length, receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT);
		assert.deepEqual(read.receipts.at(-1)?.verified, ["receipt-1"]);
	});
});

test("refuses issuance on an uninitialized store without writing", () => {
	withRoot((root) => {
		rmSync(root, { recursive: true, force: true });
		const issued = issue(root);
		assert.equal(issued.receipt, null);
		assert.deepEqual(codes(issued), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.equal(existsSync(root), false);
	});
});

test("treats a missing receipts directory as an empty history", () => {
	withRoot((root) => {
		initialize(root);
		assert.deepEqual(receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 10 }), { receipts: [], diagnostics: [] });
	});
});

test("refuses to overwrite a damaged receipt at the same address", () => {
	withRoot((root) => {
		initialize(root);
		const first = issue(root);
		const path = receiptPath(root, first.receipt!);
		const bytes = readFileSync(path, "utf8");
		const repeated = issue(root);
		assert.ok(repeated.receipt);
		assert.equal(readFileSync(path, "utf8"), bytes);
		writeFileSync(path, "not json", "utf8");
		const damaged = issue(root);
		assert.equal(damaged.receipt, null);
		assert.deepEqual(codes(damaged), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED]);
		assert.equal(readFileSync(path, "utf8"), "not json");
	});
});

test("bounds each capability separately and leaves another capability's receipts untouched", () => {
	withRoot((root) => {
		initialize(root);
		const other = issue(root, { capabilityId: "other-capability", now: "2026-09-24T11:00:00.000Z", verified: ["other"] });
		const otherPath = receiptPath(root, other.receipt!);
		const otherBytes = readFileSync(otherPath, "utf8");
		for (let index = 0; index <= receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT; index += 1) {
			issue(root, { now: `2026-09-24T12:${String(index).padStart(2, "0")}:00.000Z`, verified: [`receipt-${index}`] });
		}
		assert.equal(readFileSync(otherPath, "utf8"), otherBytes);
		assert.deepEqual(receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: "other-capability", limit: 10 }).receipts.map((entry: ProjectMapStoreReadinessReceiptV1) => entry.verified), [["other"]]);
		assert.equal(readdirSync(receiptDirectory(root)).length, receipts.PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT);
	});
});

test("refuses an invalid instant and a corrupted descriptor without creating receipt files", () => {
	withRoot((root) => {
		initialize(root);
		const invalidInstant = issue(root, { now: "not-an-instant" });
		assert.equal(invalidInstant.receipt, null);
		assert.deepEqual(codes(invalidInstant), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.equal(existsSync(join(root, "receipts")), false);
		writeFileSync(join(root, "store.json"), "not json", "utf8");
		const corruptStore = issue(root);
		assert.equal(corruptStore.receipt, null);
		assert.ok(codes(corruptStore).includes(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE));
		assert.equal(existsSync(join(root, "receipts")), false);
	});
});

test("never deletes a receipt entry it could not read", () => {
	withRoot((root) => {
		initialize(root);
		const directory = receiptDirectory(root);
		mkdirSync(directory, { recursive: true });
		const path = join(directory, "unreadable.json");
		writeFileSync(path, canonicalReceiptBytes(receipt()), "utf8");
		chmodSync(path, 0o000);
		const issued = issue(root);
		assert.ok(issued.receipt);
		assert.equal(existsSync(path), true);
		assert.ok(codes(issued).includes(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE));
	});
});

test("ignores a writer's in-flight temp file instead of reporting corruption", () => {
	withRoot((root) => {
		initialize(root);
		const issued = issue(root);
		writeFileSync(join(receiptDirectory(root), ".receipt.json.0000-0000.tmp"), "half-written", "utf8");
		const read = receipts.readProjectMapStoreReadinessReceipts({ root, capabilityId: CAPABILITY_ID, limit: 10 });
		assert.deepEqual(read.diagnostics, []);
		assert.deepEqual(read.receipts, [issued.receipt]);
	});
});

test("does not alias the caller's arrays into the issued receipt", () => {
	withRoot((root) => {
		initialize(root);
		const verified = ["focused-tests"];
		const evidence = ["node --test"];
		const issued = receipts.issueProjectMapStoreReadinessReceipt({ root, capabilityId: CAPABILITY_ID, issuedBy: "session-a", verified, evidence, now: NOW });
		assert.ok(issued.receipt);
		verified.push("tampered");
		evidence.length = 0;
		assert.deepEqual(issued.receipt.verified, ["focused-tests"]);
		assert.deepEqual(issued.receipt.evidence, ["node --test"]);
	});
});

test("hashes adversarial capability ids inside receipts", () => {
	withRoot((root) => {
		initialize(root);
		const capabilityId = "../../outside/../capability";
		const issued = issue(root, { capabilityId });
		assert.ok(issued.receipt);
		assert.equal(existsSync(receiptPath(root, issued.receipt)), true);
		assert.deepEqual(readdirSync(join(root, "receipts")), [digest(capabilityId)]);
		assert.deepEqual(readdirSync(root).sort(), ["locks-quarantine", "receipts", "store.json"]);
		assert.equal(existsSync(join(root, "outside")), false);
	});
});
