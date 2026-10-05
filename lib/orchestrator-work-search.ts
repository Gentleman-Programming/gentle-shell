import { isAbsolute } from "node:path";
import type { PresenceRecord } from "./agents-session-transport.ts";
import { discoverOrchestrators, type OrchestratorCandidate } from "./orchestrator-discovery.ts";
import { decodeWorkDescriptor, type WorkDescriptor, type WorkRef } from "./orchestrator-work.ts";
import type { RepositoryFact } from "./orchestrator-scope.ts";

export interface WorkFilter {
	area?: string;
	topic?: string;
	tag?: string;
	text?: string;
	ref?: WorkRef;
	repository_root?: string;
	related_to?: { session_id: string; task_id?: string };
}
const safeText = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim()
	&& Buffer.byteLength(v) <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v);
const fold = (s: string) => s.normalize("NFC").trim().toLowerCase();

/** Validate before discovery; preserve public spelling and exact reference identity. */
export function validateWorkFilter(value: unknown): WorkFilter {
	const invalid = () => { throw new Error("invalid-work-filter"); };
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some(k => !["area", "topic", "tag", "text", "ref", "repository_root", "related_to"].includes(k))) return invalid();
	const result: WorkFilter = {};
	for (const key of ["area", "topic", "tag", "text", "repository_root"] as const) {
		if (!Object.hasOwn(input, key)) continue;
		const v = input[key];
		if (!safeText(v, key === "text" ? 1024 : key === "repository_root" ? 256 : 64)) return invalid();
		if (key === "repository_root" && (!isAbsolute(v) || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(v))) return invalid();
		result[key] = v;
	}
	if (result.topic && !result.area) return invalid();
	if (Object.hasOwn(input, "ref")) {
		try { result.ref = decodeWorkDescriptor({ refs: [input.ref] }).refs![0]; }
		catch { return invalid(); }
	}
	if (Object.hasOwn(input, "related_to")) {
		const source = input.related_to;
		if (!source || typeof source !== "object" || Array.isArray(source)) return invalid();
		const keys = source as Record<string, unknown>;
		if (Object.keys(keys).some(k => !["session_id", "task_id"].includes(k))
			|| !Object.hasOwn(keys, "session_id") || !safeText(keys.session_id, 256)
			|| (Object.hasOwn(keys, "task_id") && !safeText(keys.task_id, 256))) return invalid();
		result.related_to = { session_id: keys.session_id,
			...(Object.hasOwn(keys, "task_id") ? { task_id: keys.task_id as string } : {}) };
	}
	return result;
}

interface WorkNode {
	sessionId: string;
	taskId?: string;
	label?: string;
	workspace?: string | null;
	status?: string;
	repository?: RepositoryFact;
	work: WorkDescriptor;
	recordedAt: number;
}
export interface WorkSearchResult {
	schema: 1;
	ownerReply: false;
	authority: "none";
	reachability: "unknown";
	observedAt: number;
	coverage: {
		exhaustive: false;
		examinedPeers: number;
		unexaminedPeers: number;
		unknownContext: number;
		unclassified: number;
		unmatchedTaskAnnotations: number;
		catalogUnknown: number;
		catalogOmittedTasks: number;
		pendingCatalogPages: number;
		omittedMatches: number;
	};
	source?: {
		status: "available" | "unavailable";
		provenance: "published-work";
		selector: NonNullable<WorkFilter["related_to"]>;
		reason?: string;
		node?: WorkNode;
	};
	matches: (WorkNode & { reasons: string[] })[];
}

/** Only current catalog IDs are task identities; annotations never imply liveness. */
function collectNodes(candidate: OrchestratorCandidate, coverage: WorkSearchResult["coverage"]): WorkNode[] {
	const record = candidate.workRecord;
	if (!record) coverage.unknownContext++;
	if (!candidate.catalog) coverage.catalogUnknown++;
	else {
		coverage.catalogOmittedTasks += candidate.catalog.omittedTasks;
		if (candidate.catalog.cursor) coverage.pendingCatalogPages++;
	}
	const nodes: WorkNode[] = [];
	const { tasks: annotations = {}, ...root } = record?.work ?? {};
	const classified = (work: WorkDescriptor) => !!(work.area || work.tags?.length || work.refs?.length);
	const base = { sessionId: candidate.sessionId, recordedAt: record?.recordedAt ?? 0 };
	if (record && classified(root)) nodes.push({ ...base, label: candidate.label, workspace: candidate.workspace,
		repository: candidate.scope?.host, work: root });
	else if (record) coverage.unclassified++;
	const live = candidate.catalog?.tasks ?? [];
	coverage.unmatchedTaskAnnotations += Object.keys(annotations).filter(id => !live.some(t => t.id === id)).length;
	for (const task of live) {
		const work = Object.hasOwn(annotations, task.id) ? annotations[task.id] : undefined;
		if (!work) {
			if (record) coverage.unclassified++;
			continue;
		}
		nodes.push({ ...base, taskId: task.id, label: task.label, workspace: task.cwd, status: task.status,
			repository: candidate.scope?.tasks.find(t => t.id === task.id)?.repository, work });
	}
	return nodes;
}

function matchReasons(node: WorkNode, filter: WorkFilter): string[] | undefined {
	const reasons: string[] = [];
	const check = (present: boolean, matches: boolean, reason: string) => {
		if (!present) return true;
		if (!matches) return false;
		reasons.push(reason);
		return true;
	};
	const work = node.work;
	if (!check(filter.area !== undefined, !!work.area && fold(work.area) === fold(filter.area ?? ""), "area")) return;
	if (!check(filter.topic !== undefined, !!work.topic && fold(work.topic) === fold(filter.topic ?? ""), "topic")) return;
	if (!check(filter.tag !== undefined, !!work.tags?.some(t => fold(t) === fold(filter.tag ?? "")), "tag")) return;
	const text = [node.label, work.area, work.topic, ...(work.tags ?? []),
		...(work.refs ?? []).flatMap(r => [r.kind, r.repository, r.id])].filter((s): s is string => s !== undefined);
	if (!check(filter.text !== undefined, text.some(s => fold(s).includes(fold(filter.text ?? ""))), "text")) return;
	const ref = filter.ref;
	if (!check(!!ref, !!work.refs?.some(r => r.kind === ref?.kind && r.repository === ref.repository && r.id === ref.id), "ref")) return;
	if (!check(filter.repository_root !== undefined, node.repository?.root === filter.repository_root, "repository_root")) return;
	return reasons.length ? reasons : ["classified"];
}

function relationReasons(node: WorkNode, source: WorkNode): string[] {
	if (node.sessionId === source.sessionId && node.taskId === source.taskId) return [];
	const work = node.work;
	const other = source.work;
	const reasons: string[] = [];
	if (work.refs?.some(r => other.refs?.some(s => r.kind === s.kind && r.repository === s.repository && r.id === s.id)))
		reasons.push("shared-declared-reference");
	const area = !!work.area && !!other.area && fold(work.area) === fold(other.area);
	if (area) reasons.push("possible-area-overlap");
	if (area && work.topic && other.topic && fold(work.topic) === fold(other.topic)) reasons.push("possible-topic-overlap");
	if (work.tags?.some(t => other.tags?.some(s => fold(t) === fold(s)))) reasons.push("possible-tag-overlap");
	return reasons;
}

/** Detached bounded index, not an owner reply, live probe, or exhaustive search. */
export function searchPublishedWork(profile: string, peers: readonly PresenceRecord[], filter: unknown = {},
	selection?: { recipientSessionId?: string; cursor?: string }, now = Date.now()): WorkSearchResult {
	const validated = validateWorkFilter(filter);
	if (selection !== undefined) {
		if (!selection || typeof selection !== "object" || Array.isArray(selection)
			|| Object.keys(selection).some(k => !["recipientSessionId", "cursor"].includes(k))
			|| (selection.recipientSessionId !== undefined && !safeText(selection.recipientSessionId, 256))
			|| (selection.cursor !== undefined && (typeof selection.cursor !== "string" || selection.cursor.length > 1024)))
			throw new Error("invalid-work-selection");
	}
	if (selection?.cursor !== undefined && selection.recipientSessionId === undefined) throw new Error("work-cursor-requires-recipient");
	const ids = [...new Set(peers.map(p => p.sessionId))].sort();
	const eligible = selection?.recipientSessionId !== undefined ? ids.filter(id => id === selection.recipientSessionId) : ids;
	const selected = new Set(eligible.slice(0, 64));
	const sourceId = validated.related_to?.session_id;
	if (sourceId !== undefined && ids.includes(sourceId) && !selected.has(sourceId)) {
		if (selected.size === 64) selected.delete(eligible[63]);
		selected.add(sourceId);
	}
	const result: WorkSearchResult = { schema: 1, ownerReply: false, authority: "none", reachability: "unknown", observedAt: now,
		coverage: { exhaustive: false, examinedPeers: selected.size, unexaminedPeers: ids.length - selected.size,
			unknownContext: 0, unclassified: 0, unmatchedTaskAnnotations: 0, catalogUnknown: 0,
			catalogOmittedTasks: 0, pendingCatalogPages: 0, omittedMatches: 0 }, matches: [] };
	// Retain duplicate activations so discovery can refuse ambiguous joins.
	const candidatePeers = peers.filter(p => selected.has(p.sessionId));
	const candidates = discoverOrchestrators(profile, candidatePeers, now, { ...selection, includeWork: true });
	if (sourceId !== undefined && selected.has(sourceId) && selection?.recipientSessionId !== undefined
		&& selection.recipientSessionId !== sourceId) {
		candidates.push(...discoverOrchestrators(profile, candidatePeers.filter(p => p.sessionId === sourceId), now, { includeWork: true }));
	}
	candidates.sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
	const nodes = candidates.flatMap(c => collectNodes(c, result.coverage));
	let source: WorkNode | undefined;
	if (validated.related_to) {
		const selector = validated.related_to;
		const candidate = candidates.find(c => c.sessionId === sourceId);
		source = nodes.find(n => n.sessionId === sourceId && n.taskId === selector.task_id);
		const reason = !candidate ? "source-not-advertised" : !candidate.workRecord ? "source-context-unavailable"
			: selector.task_id !== undefined && !candidate.catalog ? "source-catalog-unavailable"
			: selector.task_id !== undefined && !candidate.catalog?.tasks.some(t => t.id === selector.task_id)
				? "source-task-not-on-current-page" : "source-unclassified";
		result.source = { status: source ? "available" : "unavailable", provenance: "published-work", selector,
			...(source ? { node: source } : { reason }) };
	}
	const matches = nodes.filter(n => selection?.recipientSessionId === undefined || n.sessionId === selection.recipientSessionId)
		.map(node => {
			const ordinary = matchReasons(node, validated);
			if (!validated.related_to) return { node, reasons: ordinary };
			const related = source ? relationReasons(node, source) : [];
			return { node, reasons: ordinary && related.length ? [...ordinary.filter(r => r !== "classified"), ...related] : undefined };
		}).filter(m => m.reasons !== undefined);
	result.coverage.omittedMatches = matches.length;
	for (const { node, reasons } of matches) {
		result.matches.push({ ...node, reasons: reasons! });
		result.coverage.omittedMatches--;
		if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) {
			result.matches.pop();
			result.coverage.omittedMatches++;
		}
	}
	return structuredClone(result);
}
