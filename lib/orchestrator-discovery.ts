import type { PresenceRecord } from "./agents-session-transport.ts";
import { activationHash, listPresence, readDiscovery, sessionHash, type DiscoveryMetadata } from "./orchestrator-presence.ts";

export interface OrchestratorCandidate {
	sessionId: string;
	reachability: "unknown";
	freshness: "unknown" | "recent" | "stale";
	label?: string;
	workspace?: string;
	tasks?: DiscoveryMetadata["tasks"];
	omitted?: number;
}

/** One bounded metadata page, no thread reads or transport probes. The registry
 * selects a canonical routing activation; metadata must bind to that exact one.
 * Incomplete scans and duplicate presence headers fail closed. */
export function discoverOrchestrators(profile: string, peers: readonly PresenceRecord[], now = Date.now()): OrchestratorCandidate[] {
	const page = listPresence(profile, now);
	const ids = [...new Set(peers.map(peer => peer.sessionId))];
	return ids.map(sessionId => {
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
		return { ...unknown, freshness: "recent", label: header.label, workspace: metadata.workspace,
			tasks: metadata.tasks, omitted: metadata.omitted };
	});
}
