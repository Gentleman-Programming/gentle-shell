import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomicallySync } from "./agent-profiles.ts";
import {
	acquireProjectMapStoreLock,
	readProjectMapStoreDescriptor,
	releaseProjectMapStoreLock,
} from "./project-map-store.ts";
import {
	PROJECT_MAP_STORE_DIAGNOSTIC_CODES,
	parseProjectMapStoreValue,
	serializeProjectMapStoreValue,
	type ProjectMapStoreDiagnostic,
	type ProjectMapStoreReadinessReceiptV1,
} from "./project-map-store-schema.ts";
import { isIsoInstant } from "./shell-project-map-schema.ts";

export const PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT = 20;

export interface IssueProjectMapStoreReadinessReceiptOptions {
	root: string;
	capabilityId: string;
	issuedBy: string;
	verified: string[];
	evidence: string[];
	now: string;
}

export interface ProjectMapStoreReadinessReceiptIssueResult {
	receipt: ProjectMapStoreReadinessReceiptV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ReadProjectMapStoreReadinessReceiptsOptions {
	root: string;
	capabilityId: string;
	limit: number;
}

export interface ProjectMapStoreReadinessReceiptReadResult {
	receipts: ProjectMapStoreReadinessReceiptV1[];
	diagnostics: ProjectMapStoreDiagnostic[];
}

type ReceiptState = "valid" | "corrupted" | "unreadable";

interface ClassifiedReceipt {
	receipt: ProjectMapStoreReadinessReceiptV1 | null;
	state: ReceiptState;
	diagnostics: ProjectMapStoreDiagnostic[];
}

interface ReceiptEntry {
	entry: string;
	receipt: ProjectMapStoreReadinessReceiptV1;
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function receiptDirectory(root: string, capabilityId: string): string {
	return join(root, "receipts", digest(capabilityId));
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string, path = "$"): ProjectMapStoreDiagnostic {
	return { code, path, message, severity: "error" };
}

function invalidNowDiagnostic(): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, "Expected an ISO-8601 instant.", "$.now");
}

function corruptedReceiptDiagnostic(message: string): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, message);
}

function unreadableStoreDiagnostic(message: string): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, message);
}

function readyStoreDiagnostics(root: string): ProjectMapStoreDiagnostic[] {
	const descriptor = readProjectMapStoreDescriptor(root);
	if (descriptor.status === "ready") return [];
	if (descriptor.status === "missing") {
		return [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store has to be initialized first.")];
	}
	return [
		diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store is not ready for readiness receipt operations."),
		...descriptor.diagnostics,
	];
}

function receiptFileName(receipt: ProjectMapStoreReadinessReceiptV1, bytes: string | Buffer): string {
	return `${receipt.issued_at.replace(/[:.]/g, "-")}-${digest(bytes)}.json`;
}

function classifyReceipt(path: string, entry: string, capabilityId: string): ClassifiedReceipt {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch {
		return {
			receipt: null,
			state: "unreadable",
			diagnostics: [unreadableStoreDiagnostic(`Readiness receipt "${path}" could not be read.`)],
		};
	}
	const parsed = parseProjectMapStoreValue("readiness-receipt", raw.toString("utf8"));
	if (parsed.record === null) {
		return {
			receipt: null,
			state: "corrupted",
			diagnostics: [corruptedReceiptDiagnostic(`Readiness receipt "${path}" is corrupted.`)],
		};
	}
	const receipt = parsed.record as ProjectMapStoreReadinessReceiptV1;
	if (receipt.capability_id !== capabilityId) {
		return {
			receipt: null,
			state: "corrupted",
			diagnostics: [corruptedReceiptDiagnostic(`Readiness receipt "${path}" capability id does not match the requested capability.`)],
		};
	}
	const canonical = serializeProjectMapStoreValue("readiness-receipt", receipt);
	if (canonical.record === null || !raw.equals(Buffer.from(canonical.record, "utf8"))) {
		return {
			receipt: null,
			state: "corrupted",
			diagnostics: [corruptedReceiptDiagnostic(`Readiness receipt "${path}" is not in canonical form.`)],
		};
	}
	if (entry !== receiptFileName(receipt, raw)) {
		return {
			receipt: null,
			state: "corrupted",
			diagnostics: [corruptedReceiptDiagnostic(`Readiness receipt "${path}" does not match its record digest.`)],
		};
	}
	return { receipt, state: "valid", diagnostics: [] };
}

function compareNewest(left: ReceiptEntry, right: ReceiptEntry): number {
	const difference = Date.parse(right.receipt.issued_at) - Date.parse(left.receipt.issued_at);
	if (Number.isFinite(difference) && difference !== 0) return difference;
	if (left.entry < right.entry) return -1;
	if (left.entry > right.entry) return 1;
	return 0;
}

function listReceiptEntries(root: string, capabilityId: string): { entries: string[]; diagnostics: ProjectMapStoreDiagnostic[] } {
	const directory = receiptDirectory(root, capabilityId);
	try {
		// A lock-free read may run while another session publishes a receipt through its
		// sibling temp file, so the in-flight temp name is not store evidence.
		return { entries: readdirSync(directory).filter((entry) => !entry.endsWith(".tmp")), diagnostics: [] };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], diagnostics: [] };
		return { entries: [], diagnostics: [unreadableStoreDiagnostic(`Readiness receipt directory "${directory}" could not be read.`)] };
	}
}

function pruneReceiptHistory(root: string, capabilityId: string): ProjectMapStoreDiagnostic[] {
	const directory = receiptDirectory(root, capabilityId);
	const listed = listReceiptEntries(root, capabilityId);
	const diagnostics = [...listed.diagnostics];
	if (listed.diagnostics.length > 0) return diagnostics;
	const valid: ReceiptEntry[] = [];
	for (const entry of listed.entries) {
		const path = join(directory, entry);
		const current = classifyReceipt(path, entry, capabilityId);
		if (current.state === "valid" && current.receipt !== null) {
			valid.push({ entry, receipt: current.receipt });
			continue;
		}
		diagnostics.push(...current.diagnostics);
		// An entry that could not be read is not an entry this may delete: a permission problem or
		// a transient read error would otherwise destroy evidence that was never inspected.
		if (current.state === "unreadable") continue;
		try {
			unlinkSync(path);
		} catch {
			diagnostics.push(unreadableStoreDiagnostic(`Readiness receipt "${path}" could not be removed.`));
		}
	}
	valid.sort(compareNewest);
	for (const entry of valid.slice(PROJECT_MAP_STORE_RECEIPT_HISTORY_LIMIT).reverse()) {
		const path = join(directory, entry.entry);
		try {
			unlinkSync(path);
		} catch {
			diagnostics.push(unreadableStoreDiagnostic(`Readiness receipt "${path}" could not be removed.`));
		}
	}
	return diagnostics;
}

function receiptRecord(options: IssueProjectMapStoreReadinessReceiptOptions): ProjectMapStoreReadinessReceiptV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "readiness-receipt",
		capability_id: options.capabilityId,
		issued_by: options.issuedBy,
		issued_at: options.now,
		verified: [...options.verified],
		evidence: [...options.evidence],
		authority: "none",
	};
}

export function issueProjectMapStoreReadinessReceipt(options: IssueProjectMapStoreReadinessReceiptOptions): ProjectMapStoreReadinessReceiptIssueResult {
	if (!isIsoInstant(options.now)) return { receipt: null, diagnostics: [invalidNowDiagnostic()] };
	const receipt = receiptRecord(options);
	const serialized = serializeProjectMapStoreValue("readiness-receipt", receipt);
	if (serialized.record === null) return { receipt: null, diagnostics: serialized.diagnostics };
	const beforeLock = readyStoreDiagnostics(options.root);
	if (beforeLock.length > 0) return { receipt: null, diagnostics: beforeLock };
	const acquired = acquireProjectMapStoreLock(options.root, options.now);
	if (acquired.handle === null) return { receipt: null, diagnostics: acquired.diagnostics };
	let result: ProjectMapStoreReadinessReceiptIssueResult;
	try {
		const underLock = readyStoreDiagnostics(options.root);
		if (underLock.length > 0) {
			result = { receipt: null, diagnostics: underLock };
		} else {
			try {
				const directory = receiptDirectory(options.root, options.capabilityId);
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const target = join(directory, receiptFileName(receipt, serialized.record));
				if (existsSync(target) && !readFileSync(target).equals(Buffer.from(serialized.record, "utf8"))) {
					result = { receipt: null, diagnostics: [corruptedReceiptDiagnostic(`Readiness receipt "${target}" already exists with different bytes; refusing to overwrite it.`)] };
				} else {
					writeJsonFileAtomicallySync(target, serialized.record);
					result = { receipt, diagnostics: pruneReceiptHistory(options.root, options.capabilityId) };
				}
			} catch {
				result = { receipt: null, diagnostics: [unreadableStoreDiagnostic("Readiness receipt could not be written.")] };
			}
		}
	} catch {
		result = { receipt: null, diagnostics: [unreadableStoreDiagnostic("Readiness receipt operation could not be completed.")] };
	}
	const releaseDiagnostics = releaseProjectMapStoreLock(options.root, acquired.handle);
	if (releaseDiagnostics.length > 0) result.diagnostics.push(...releaseDiagnostics.map((entry) => result.receipt === null ? entry : { ...entry, severity: "warning" as const }));
	return result;
}

export function readProjectMapStoreReadinessReceipts(options: ReadProjectMapStoreReadinessReceiptsOptions): ProjectMapStoreReadinessReceiptReadResult {
	const directory = receiptDirectory(options.root, options.capabilityId);
	const listed = listReceiptEntries(options.root, options.capabilityId);
	const diagnostics = [...listed.diagnostics];
	const receipts: ReceiptEntry[] = [];
	for (const entry of listed.entries) {
		const current = classifyReceipt(join(directory, entry), entry, options.capabilityId);
		if (current.state === "valid" && current.receipt !== null) receipts.push({ entry, receipt: current.receipt });
		else diagnostics.push(...current.diagnostics);
	}
	receipts.sort(compareNewest);
	if (!Number.isFinite(options.limit) || options.limit < 0) return { receipts: [], diagnostics };
	return { receipts: receipts.slice(0, options.limit).map((entry) => entry.receipt), diagnostics };
}
