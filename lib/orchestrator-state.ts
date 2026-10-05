import { isAbsolute } from "node:path";
import { decodeWork, type PublishedWork } from "./orchestrator-work.ts";

export const ORCHESTRATOR_STATE_ENTRY = "gentle-agents.published-state";
const fields = ["objective", "progress", "decisions", "blockers"] as const;
export type CuratedState = Partial<Record<typeof fields[number], string>> & { work?: PublishedWork };
export interface PublishedState {
	schema: 1 | 2; sessionId: string; recordedAt: number; cwd: string | null;
	source: "owner-curated"; ownerReply: false; authority: "none"; state: CuratedState | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeText = (v: unknown): v is string => typeof v === "string" && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v);
const safeCwd = (v: unknown): v is string => safeText(v) && isAbsolute(v) && Buffer.byteLength(v) <= 1024
	&& !/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(v);
/** Field whitelist, not secret redaction. Reject rather than truncate meaning. */
export function decodeCuratedState(value: unknown): CuratedState | null {
	if (value === null) return null;
	if (!object(value) || Object.keys(value).some(k => k !== "work" && !fields.includes(k as typeof fields[number])))
		throw new Error("invalid-published-state");
	const state: CuratedState = {};
	let bytes = 0;
	for (const key of fields) {
		if (!Object.hasOwn(value, key)) continue;
		if (!safeText(value[key])) throw new Error("invalid-published-state");
		state[key] = value[key];
		bytes += Buffer.byteLength(value[key]);
	}
	if (Object.hasOwn(value, "work")) {
		state.work = decodeWork(value.work);
		bytes += Buffer.byteLength(JSON.stringify(state.work));
	}
	if (bytes > 2048) throw new Error("invalid-published-state");
	return state;
}
export function decodePublishedState(value: unknown): PublishedState | undefined {
	try {
		const keys = ["schema", "sessionId", "recordedAt", "cwd", "source", "ownerReply", "authority", "state"];
		if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))
			|| (value.schema !== 1 && value.schema !== 2) || !safeText(value.sessionId) || !value.sessionId || Buffer.byteLength(value.sessionId) > 256
			|| !Number.isSafeInteger(value.recordedAt) || (value.recordedAt as number) < 0
			|| !(value.cwd === null || safeCwd(value.cwd))
			|| value.source !== "owner-curated" || value.ownerReply !== false || value.authority !== "none"
			|| Buffer.byteLength(JSON.stringify(value)) > 4096) return undefined;
		const state = decodeCuratedState(value.state);
		if ((value.schema === 2) !== !!state?.work) return undefined;
		return { schema: value.schema, sessionId: value.sessionId, recordedAt: value.recordedAt as number,
			cwd: safeText(value.cwd) ? value.cwd : null, source: "owner-curated", ownerReply: false, authority: "none", state };
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
		const record = decodePublishedState({ schema: state?.work ? 2 : 1, sessionId: manager.getSessionId(), recordedAt: now,
			cwd: safeCwd(cwd) ? cwd : null,
			source: "owner-curated", ownerReply: false, authority: "none", state });
		if (!record) throw new Error("invalid-published-state");
		append(ORCHESTRATOR_STATE_ENTRY, structuredClone(record));
		if (this.manager !== manager || this.sessionId !== record.sessionId || manager.getSessionId() !== record.sessionId) throw new Error("stale-published-state");
		this.value = record;
	}
}
