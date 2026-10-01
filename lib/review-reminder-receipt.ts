import { isAbsolute } from "node:path";

// Reminder bookkeeping only: these entries neither define review scope nor grant
// authority. Both extensions append to the parent's active Pi session branch.
export const REVIEW_REMINDER_RECEIPT = "gentle-pi.review-reminder-receipt/v1";
export interface ReceiptSession {
	getSessionId(): string;
	getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
}
interface ReceiptHost { appendEntry(type: string, data: unknown): void }
export interface MutationEvidence {
	source: "direct" | "subagent";
	toolName: "write" | "edit";
	toolCallId: string;
	taskId?: string;
	/** Runtime-resolved writer model id; omitted when the runtime does not know it (gentle-pi#1175). */
	writerModelId?: string;
	/** Runtime-resolved writer effort (thinking level); omitted when unknown. */
	writerEffort?: string;
}
/** The runtime-recorded writer profile of one pending mutation; absent fields are unknown. */
export interface PendingWriterProfile {
	writerModelId?: string;
	writerEffort?: string;
}
type Mutation = MutationEvidence & { kind: "mutation"; sessionId: string; root: string; id: string };
type Consumption = { kind: "nudged" | "acknowledged"; sessionId: string; root: string; through: string; targetIdentity: string };
type Receipt = Mutation | Consumption;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const WRITER_PROFILE_FIELDS = ["writerModelId", "writerEffort"] as const;

function valid(value: unknown): value is Receipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	if (!text(data.sessionId) || !text(data.root) || !isAbsolute(data.root)) return false;
	let fields: string[];
	if (data.kind === "mutation") {
		if (!text(data.id) || !text(data.toolCallId) || (data.toolName !== "write" && data.toolName !== "edit")) return false;
		if (data.source !== "direct" && data.source !== "subagent") return false;
		if (data.source === "subagent" ? !text(data.taskId) : data.taskId !== undefined) return false;
		if (data.id !== JSON.stringify([data.source, data.taskId ?? "", data.toolCallId])) return false;
		// Profile fields are optional (older receipts stay valid), but never blank.
		const profileFields = WRITER_PROFILE_FIELDS.filter((field) => data[field] !== undefined);
		if (!profileFields.every((field) => text(data[field]))) return false;
		fields = ["kind", "sessionId", "root", "id", "source", "toolName", "toolCallId", ...(data.source === "subagent" ? ["taskId"] : []), ...profileFields];
	} else {
		if (data.kind !== "nudged" && data.kind !== "acknowledged") return false;
		if (!text(data.through) || !text(data.targetIdentity)) return false;
		fields = ["kind", "sessionId", "root", "through", "targetIdentity"];
	}
	return Object.keys(data).length === fields.length && fields.every((field) => Object.hasOwn(data, field));
}

function receipts(session: ReceiptSession, root: string): Receipt[] {
	const sessionId = session.getSessionId();
	return session.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === REVIEW_REMINDER_RECEIPT &&
		valid(entry.data) && entry.data.sessionId === sessionId && entry.data.root === root ? [entry.data] : []);
}

// The first receipt per mutation id, in branch order, plus the index of the
// last consumed one (-1 when nothing was consumed).
function mutationLedger(session: ReceiptSession, root: string): { mutations: Mutation[]; consumed: number } {
	const mutations: Mutation[] = [];
	let consumed = -1;
	for (const receipt of receipts(session, root)) {
		if (receipt.kind === "mutation") {
			if (!mutations.some((mutation) => mutation.id === receipt.id)) mutations.push(receipt);
		} else {
			// Only consume the captured prefix, not writes arriving while native
			// STATUS/ACK was awaited. Unknown or off-branch watermarks do nothing.
			consumed = Math.max(consumed, mutations.findIndex((mutation) => mutation.id === receipt.through));
		}
	}
	return { mutations, consumed };
}

export function pendingReviewMutation(session: ReceiptSession, root: string, captured?: string): string | undefined {
	const { mutations, consumed } = mutationLedger(session, root);
	if (captured !== undefined) return mutations.findIndex((mutation) => mutation.id === captured) > consumed ? captured : undefined;
	return mutations.length - 1 > consumed ? mutations.at(-1)?.id : undefined;
}

/**
 * The runtime-recorded writer profiles of every mutation still pending for
 * `root`, with exactly `pendingReviewMutation`'s consumption semantics. ASSESS
 * reads these instead of trusting a model re-declaration (gentle-pi#1175).
 */
export function pendingReviewMutationProfiles(session: ReceiptSession, root: string): PendingWriterProfile[] {
	const { mutations, consumed } = mutationLedger(session, root);
	return mutations.slice(consumed + 1).map((mutation) => ({
		...(mutation.writerModelId === undefined ? {} : { writerModelId: mutation.writerModelId }),
		...(mutation.writerEffort === undefined ? {} : { writerEffort: mutation.writerEffort }),
	}));
}

export function recordReviewMutation(host: ReceiptHost, session: ReceiptSession, root: string, evidence: MutationEvidence): void {
	const id = JSON.stringify([evidence.source, evidence.taskId ?? "", evidence.toolCallId]);
	const { writerModelId, writerEffort, ...required } = evidence;
	// An unknown or blank profile field is omitted, never allowed to invalidate
	// (and so drop) the mutation evidence itself.
	const receipt: Mutation = {
		kind: "mutation", sessionId: session.getSessionId(), root, id, ...required,
		...(text(writerModelId) ? { writerModelId } : {}),
		...(text(writerEffort) ? { writerEffort } : {}),
	};
	if (!valid(receipt) || receipts(session, root).some((entry) => entry.kind === "mutation" && entry.id === id)) return;
	host.appendEntry(REVIEW_REMINDER_RECEIPT, receipt);
}

export function consumeReviewMutation(host: ReceiptHost, session: ReceiptSession, root: string, through: string | undefined, kind: Consumption["kind"], targetIdentity: string): void {
	if (through === undefined) return;
	const receipt: Consumption = { kind, sessionId: session.getSessionId(), root, through, targetIdentity };
	if (valid(receipt)) host.appendEntry(REVIEW_REMINDER_RECEIPT, receipt);
}
