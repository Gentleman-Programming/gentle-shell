import { readCatalog, type CatalogPage } from "./orchestrator-catalog.ts";
import type { PublishedWork } from "./orchestrator-work.ts";
import type { PresenceRecord } from "./agents-session-transport.ts";
import { activationHash, listPresence, readDiscovery, sessionHash, type DiscoveryMetadata } from "./orchestrator-presence.ts";

export interface OrchestratorCandidate {
	sessionId: string;
	reachability: "unknown";
	freshness: "unknown" | "recent" | "stale";
	label?: string;
	aliases?: DiscoveryMetadata["aliases"];
	workspace?: string;
	tasks?: DiscoveryMetadata["tasks"];
	omitted?: number;
	scope?: DiscoveryMetadata["scope"];
	state?: DiscoveryMetadata["state"];
	workRecord?: { work: PublishedWork | null; recordedAt: number };
	catalog?: CatalogPage;
	catalogUnavailable?: string;
	/** Internal binding for targeted consultation; never expose transport records. */
	publication?: { incarnation: string; activation: string; heartbeat: number };
}

/** One bounded metadata page, no thread reads or transport probes. The registry
 * selects a canonical routing activation; metadata must bind to that exact one.
 * Incomplete scans and duplicate presence headers fail closed. */
export function discoverOrchestrators(profile: string, peers: readonly PresenceRecord[], now = Date.now(), selection?: { recipientSessionId?: string; cursor?: string; consultation?: boolean; includeWork?: boolean }): OrchestratorCandidate[] {
	const page = listPresence(profile, now);
	const ids = [...new Set(peers.map(peer => peer.sessionId))];
	return ids.filter(id => selection?.recipientSessionId === undefined || selection.recipientSessionId === id).map(sessionId => {
		const unknown: OrchestratorCandidate = { sessionId, reachability: "unknown", freshness: "unknown" };
		const activations = peers.filter(peer => peer.sessionId === sessionId);
		if (page.unavailable || page.overflow || page.rejected || activations.length !== 1) return unknown;
		const matches = page.entries.filter(h => h.sessionHash === sessionHash(sessionId));
		// Even a stale duplicate could represent another process with the same ID.
		if (matches.length !== 1) return unknown;
		const header = matches[0];
		const metadata = readDiscovery(profile, header);
		if (metadata?.activation !== activationHash(activations[0])) return unknown;
		if (!header.recent) return { ...unknown, freshness: "stale" };
		const catalog = readCatalog(profile, header, metadata.activation, selection?.recipientSessionId === sessionId ? selection.cursor : undefined);
		return { ...unknown, ...(catalog.page ? { catalog: catalog.page } : { catalogUnavailable: catalog.unavailable }), freshness: "recent", label: header.label, workspace: metadata.workspace,
			tasks: metadata.tasks, omitted: metadata.omitted, ...(metadata.aliases ? { aliases: metadata.aliases } : {}), ...(metadata.scope ? { scope: metadata.scope } : {}),
			...(selection?.consultation ? { publication: { incarnation: header.incarnation, activation: metadata.activation, heartbeat: header.heartbeat } } : {}),
			...(selection?.includeWork && metadata.state?.sessionId === sessionId
				? { workRecord: { work: metadata.state.state?.work ?? null, recordedAt: metadata.state.recordedAt } } : {}),
			...(!selection?.includeWork && selection?.recipientSessionId === sessionId && metadata.state?.sessionId === sessionId ? { state: metadata.state } : {}) };
	});
}
