import { createHash } from "node:crypto";
import type { PresenceRecord } from "./agents-session-transport.ts";
import { discoverOrchestrators } from "./orchestrator-discovery.ts";

export const CONSULTATION_BYTES = 16 * 1024;
export interface MetadataSelection { recipientSessionId: string; cursor?: string }
type Candidate = ReturnType<typeof discoverOrchestrators>[number];
export interface MetadataReceipt {
	schema: "gentle-agents.consultation/v1";
	kind: "metadata"; status: "available" | "unavailable";
	source: "published_snapshot"; ownerReply: false; authority: "none";
	targetSessionId: string; observedAt: number;
	freshness: "unknown" | "recent" | "stale";
	presenceObservedAt?: number;
	digest?: string;
	snapshot?: { label: string | null; aliases?: Candidate["aliases"]; workspace: string | null; tasks: Candidate["tasks"];
		omittedTasks: number; scope: Candidate["scope"] | null; catalog: Candidate["catalog"] | null;
		state: Candidate["state"] | null };
	unknowns: string[]; omissions: string[];
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
export function unavailableMetadata(targetSessionId: string, reason: string, now = Date.now(), freshness: MetadataReceipt["freshness"] = "unknown"): MetadataReceipt {
	return freeze({ schema: "gentle-agents.consultation/v1", kind: "metadata", status: "unavailable",
		source: "published_snapshot", ownerReply: false, authority: "none", targetSessionId, observedAt: now,
		freshness, unknowns: [reason], omissions: ["private-context", "owner-decision", "reachability", "exclusive-writer-ownership"] });
}
/** Reads the existing bounded, selected-activation projection, never activity.
 * Identity excludes private activity generation/digests and observation clocks.
 * Existing readers validate exact field whitelists before this detached capture. */
export function consultPublishedMetadata(profile: string, peers: readonly PresenceRecord[], selection: MetadataSelection, now = Date.now()): MetadataReceipt {
	const peer = discoverOrchestrators(profile, peers, now, { recipientSessionId: selection.recipientSessionId,
		cursor: selection.cursor, consultation: true })[0];
	if (!peer?.publication || peer.freshness !== "recent") return unavailableMetadata(selection.recipientSessionId, "publication-unknown-or-stale", now, peer?.freshness);
	if (selection.cursor !== undefined && !peer.catalog) return unavailableMetadata(selection.recipientSessionId, "catalog-unknown-or-invalid-cursor", now);
	const snapshot = {
		label: peer.label || null, ...(peer.aliases ? { aliases: peer.aliases } : {}), workspace: peer.workspace || null,
		tasks: peer.tasks?.map(t => ({ id: t.id, label: t.label, status: t.status, workspace: t.workspace })) ?? [],
		omittedTasks: peer.omitted ?? 0, scope: peer.scope ?? null, catalog: peer.catalog ?? null, state: peer.state ?? null,
	};
	const unknowns = ["reachability", "exclusive-writer-ownership", "owner-decision"];
	if (!snapshot.workspace) unknowns.push("workspace");
	if (!snapshot.scope) unknowns.push("repository-scope");
	if (!snapshot.catalog) unknowns.push("catalog");
	if (!snapshot.state) unknowns.push("curated-state");
	const digest = createHash("sha256").update(JSON.stringify([selection.recipientSessionId,
		peer.publication.incarnation, peer.publication.activation, snapshot])).digest("hex");
	const receipt: MetadataReceipt = { schema: "gentle-agents.consultation/v1", kind: "metadata", status: "available",
		source: "published_snapshot", ownerReply: false, authority: "none", targetSessionId: selection.recipientSessionId,
		observedAt: now, freshness: peer.freshness, presenceObservedAt: peer.publication.heartbeat, digest, snapshot,
		unknowns, omissions: ["private-context", "git-facts-beyond-published-prefix"] };
	// JSON capture detaches every nested list/record and guarantees plain JSON.
	const bytes = JSON.stringify(receipt);
	if (Buffer.byteLength(bytes) > CONSULTATION_BYTES) return unavailableMetadata(selection.recipientSessionId, "snapshot-too-large", now);
	return freeze(JSON.parse(bytes) as MetadataReceipt);
}
