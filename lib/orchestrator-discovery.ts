import { readCatalog, type CatalogPage } from "./orchestrator-catalog.ts";
import type { PublishedWork } from "./orchestrator-work.ts";
import type { PresenceRecord } from "./agents-session-transport.ts";
import { activationHash, discoveryAbsent, PresenceCursor, readDiscovery, sessionHash, type DiscoveryMetadata, type PresencePage } from "./orchestrator-presence.ts";

export interface OrchestratorCandidate {
	sessionId: string;
	reachability: "unknown";
	freshness: "unknown" | "recent" | "stale";
	label?: string;
	/** Display-only label of a live peer whose code predates discovery publication:
	 * its schema-1 header heartbeats, but it never writes a discovery sidecar. */
	legacyLabel?: string;
	aliases?: DiscoveryMetadata["aliases"];
	/** stateOnly selection: whether this peer published owner-curated state. Boolean
	 * only — curated state prose stays out of the default session list. */
	statePublished?: boolean;
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

/** Total directory-entry budget for one discovery scan. A directory this large
 * is treated as flooded and fails closed; aligns with SWEEP_MAX_FILES in
 * agents-session-transport.ts. */
const SCAN_MAX_ENTRIES = 4096;

/** Mirrors orchestrator-presence's reason() for the cursor constructor's throw,
 * which next() would otherwise report as an unavailable page. */
function presenceUnavailable(error: unknown): string {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" ? "missing" : code ? "io-error" : error instanceof SyntaxError ? "malformed" : (error as Error).message;
}

/** Full pagination over PresenceCursor instead of the first-page-only listPresence:
 * legitimate busy directories (hundreds of header + activity + discovery sidecars)
 * must not blind every peer behind the 128-entry first page (#3185). Overflow is
 * reported only when the total directory-entry budget is exceeded; any per-page
 * unavailable result still fails closed. */
function scanPresence(profile: string, now: number): PresencePage {
	let cursor: PresenceCursor;
	try { cursor = new PresenceCursor(profile); }
	catch (error) { return { entries: [], scanned: 0, rejected: 0, overflow: false, unavailable: presenceUnavailable(error) }; }
	const entries: PresencePage["entries"] = [];
	let scanned = 0;
	let rejected = 0;
	try {
		for (;;) {
			const page = cursor.next(now);
			entries.push(...page.entries);
			scanned += page.scanned;
			rejected += page.rejected;
			if (page.unavailable) return { entries, scanned, rejected, overflow: false, unavailable: page.unavailable };
			if (!page.overflow) return { entries, scanned, rejected, overflow: false };
			if (scanned >= SCAN_MAX_ENTRIES) return { entries, scanned, rejected, overflow: true };
		}
	} finally { cursor.close(); }
}

/** One bounded metadata page, no thread reads or transport probes. The registry
 * selects a canonical routing activation; metadata must bind to that exact one.
 * Incomplete scans and duplicate presence headers fail closed. */
export function discoverOrchestrators(profile: string, peers: readonly PresenceRecord[], now = Date.now(), selection?: { recipientSessionId?: string; cursor?: string; consultation?: boolean; includeWork?: boolean; stateOnly?: boolean }): OrchestratorCandidate[] {
	const page = scanPresence(profile, now);
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
		if (!metadata && header.recent && discoveryAbsent(profile, header)) return { ...unknown, legacyLabel: header.label };
		if (metadata?.activation !== activationHash(activations[0])) return unknown;
		if (!header.recent) return { ...unknown, freshness: "stale" };
		const catalog = readCatalog(profile, header, metadata.activation, selection?.recipientSessionId === sessionId ? selection.cursor : undefined);
		return { ...unknown, ...(catalog.page ? { catalog: catalog.page } : { catalogUnavailable: catalog.unavailable }), freshness: "recent", label: header.label, workspace: metadata.workspace,
			tasks: metadata.tasks, omitted: metadata.omitted, ...(metadata.aliases ? { aliases: metadata.aliases } : {}), ...(metadata.scope ? { scope: metadata.scope } : {}),
			...(selection?.consultation ? { publication: { incarnation: header.incarnation, activation: metadata.activation, heartbeat: header.heartbeat } } : {}),
			...(selection?.includeWork && metadata.state?.sessionId === sessionId
				? { workRecord: { work: metadata.state.state?.work ?? null, recordedAt: metadata.state.recordedAt } } : {}),
			...(selection?.stateOnly ? { statePublished: metadata.state?.sessionId === sessionId } : {}),
			...(!selection?.includeWork && selection?.recipientSessionId === sessionId && metadata.state?.sessionId === sessionId ? { state: metadata.state } : {}) };
	});
}
