import { isAbsolute } from "node:path";

export const ORCHESTRATOR_STATE_ENTRY = "gentle-agents.published-state";
const fields = ["objective", "progress", "decisions", "blockers"] as const;
export type CuratedState = Partial<Record<typeof fields[number], string>>;
export interface PublishedState {
	schema: 1; sessionId: string; recordedAt: number; cwd: string | null;
	source: "owner-curated"; ownerReply: false; authority: "none"; state: CuratedState | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeText = (v: unknown): v is string => typeof v === "string" && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v);
const safeCwd = (v: unknown): v is string => safeText(v) && isAbsolute(v) && Buffer.byteLength(v) <= 1024
	&& !/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(v);
/** Field whitelist, not secret redaction. Reject rather than truncate meaning. */
export function decodeCuratedState(value: unknown): CuratedState | null {
	if (value === null) return null;
	if (!object(value) || Object.keys(value).some(k => !fields.includes(k as typeof fields[number]))
		|| Object.values(value).some(v => !safeText(v))
		|| Object.values(value).reduce<number>((bytes, v) => bytes + Buffer.byteLength(v as string), 0) > 2048)
		throw new Error("invalid-published-state");
	return Object.fromEntries(fields.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
}
export function decodePublishedState(value: unknown): PublishedState | undefined {
	try {
		const keys = ["schema", "sessionId", "recordedAt", "cwd", "source", "ownerReply", "authority", "state"];
		if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))
			|| value.schema !== 1 || !safeText(value.sessionId) || !value.sessionId || Buffer.byteLength(value.sessionId) > 256
			|| !Number.isSafeInteger(value.recordedAt) || (value.recordedAt as number) < 0
			|| !(value.cwd === null || safeCwd(value.cwd))
			|| value.source !== "owner-curated" || value.ownerReply !== false || value.authority !== "none"
			|| Buffer.byteLength(JSON.stringify(value)) > 4096) return undefined;
		return { schema: 1, sessionId: value.sessionId, recordedAt: value.recordedAt as number,
			cwd: safeText(value.cwd) ? value.cwd : null, source: "owner-curated", ownerReply: false, authority: "none", state: decodeCuratedState(value.state) };
	} catch { return undefined; }
}
interface StateManager {
	getSessionId(): string; getCwd(): string;
	getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
}
/** One branch-local cache. Never accesses message bodies, summaries, or results. */
export class OrchestratorStateCache {
	private manager?: StateManager;
	private sessionId?: string;
	private value?: PublishedState;
	clear() { this.manager = undefined; this.sessionId = undefined; this.value = undefined; }
	load(manager: StateManager) {
		this.clear();
		this.manager = manager;
		this.sessionId = manager.getSessionId();
		const branch = manager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== ORCHESTRATOR_STATE_ENTRY) continue;
			const decoded = decodePublishedState(entry.data);
			// A malformed/foreign latest record suppresses older knowledge.
			this.value = decoded?.sessionId === this.sessionId ? decoded : undefined;
			break;
		}
	}
	get(manager: StateManager): PublishedState | undefined {
		return this.manager === manager && this.sessionId === manager.getSessionId() && this.value
			? structuredClone(this.value) : undefined;
	}
	publish(manager: StateManager, input: unknown, append: (type: string, data: PublishedState) => void, now = Date.now()) {
		const state = decodeCuratedState(input);
		if (this.manager !== manager || this.sessionId !== manager.getSessionId()) throw new Error("stale-published-state");
		const cwd = manager.getCwd();
		const record = decodePublishedState({ schema: 1, sessionId: manager.getSessionId(), recordedAt: now,
			cwd: safeCwd(cwd) ? cwd : null,
			source: "owner-curated", ownerReply: false, authority: "none", state });
		if (!record) throw new Error("invalid-published-state");
		append(ORCHESTRATOR_STATE_ENTRY, structuredClone(record));
		this.value = record;
	}
}
