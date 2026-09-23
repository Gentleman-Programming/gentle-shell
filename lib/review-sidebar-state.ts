import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { sanitizeTerminalText } from "./terminal-theme.ts";

/** Ephemeral display data only; this event grants no review authority. */
export const REVIEW_SIDEBAR_EVENT = "gentle-ai:review-sidebar";
export const REVIEW_SCOPE_UNAVAILABLE = "Candidate scope unavailable";

export const REVIEW_SIDEBAR_LABELS = {
	reviewing: "Reviewing",
	in_review: "In review",
	checking: "Checking review",
	approved: "Approved · awaiting acknowledgement",
	closed: "Closed",
	correction: "Correction required",
	declined: "Declined",
	invalidated: "Invalidated",
	unavailable: "Unavailable",
	unknown: "Unknown",
	ready: "Ready for review",
	consent: "Awaiting consent",
	forecast: "Awaiting reviewer run",
} as const;

export interface ReviewSidebarSnapshot {
	state: keyof typeof REVIEW_SIDEBAR_LABELS;
	scope: string;
}

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function candidateScope(paths: unknown): string {
	if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string" && path.length > 0)) return REVIEW_SCOPE_UNAVAILABLE;
	const unique = [...new Set(paths as string[])];
	const first = sanitizeTerminalText(unique[0]!.replaceAll("\\", "/").split("/").pop() ?? "").trim();
	if (!first || first === "." || first === "..") return REVIEW_SCOPE_UNAVAILABLE;
	return `${first}${unique.length > 1 ? ` +${unique.length - 1}` : ""}`;
}

/** Interpret only the facade's explicit evidence, not tool success or opaque bindings. */
export function reviewSidebarSnapshot(operation: string, details: unknown): ReviewSidebarSnapshot {
	const data = record(details);
	const result = record(data.result);
	const closure = record(data.closure);
	const transition = record(result.next_transition);
	const scope = candidateScope(record(result.projection).paths ?? record(data.actor_binding).candidate_paths);
	const snapshot = (state: ReviewSidebarSnapshot["state"]): ReviewSidebarSnapshot => ({ state, scope });
	if (operation === "acknowledge-approved" && data.operation === operation &&
		data.outcome === "native-approved-acknowledgement-completed" &&
		data.status === "closed" && data.authority === "burned") return snapshot("closed");
	if (data.outcome === "consent-declined-this-candidate") return snapshot("declined");
	if (data.outcome === "native-review-consent-required") return snapshot("consent");
	if (data.native_failure || data.failure || data.reconciliation_failure) return snapshot("unavailable");
	if (data.outcome === "reviewer-model-run-forecast") return snapshot("forecast");
	// A terminal capture reports status=closed even when acknowledgement is still
	// pending. Its explicit closure state, not that wrapper status, is evidence.
	const capture = data.outcome === "native-last-event-closure" && closure.schema === "gentle-ai.review-last-event-closure/v1";
	const status = typeof result.schema === "string" && /^gentle-ai\.review-integration\.status\/v[3-9]$/.test(result.schema);
	// An inspect/status call can finish host-mediated consent and return an
	// answer-consent result. Interpret the returned operation, not the input.
	const start = ["start", "answer-consent", "select-intended-untracked"].includes(String(data.operation)) &&
		(result.action === "created" || result.action === "resumed" || result.action === "replayed");
	if (!capture && !status && !start) return snapshot(data.status === "blocked" ? "unavailable" : "unknown");
	const state = capture ? closure.state : status ? record(result.authority).state : result.state;
	if (state === "invalidated") return snapshot("invalidated");
	if (state === "correction_required") return snapshot("correction");
	if (status && (result.action === "recover" || transition.kind === "stop")) return snapshot("unavailable");
	if (status && result.action === "start") return snapshot("ready");
	if (state === "approved") return snapshot("approved");
	// Completed native results show lifecycle state, not active capture execution.
	if (state === "reviewing" || state === "validating") return snapshot("in_review");
	return snapshot("unknown");
}

// Correlation is display-only: compare provider-issued strings verbatim, never
// decode bindings, synthesize identity, or use this cache to authorize a call.
interface ReviewScope {
	workspace: string;
	lineage: string;
	target: string;
	scope: string;
	bindings: string[];
}

function issuedBindings(data: Record<string, unknown>): string[] {
	return Array.isArray(data.collectBindings)
		? data.collectBindings.map((entry) => record(entry).collectBinding).filter((binding): binding is string => typeof binding === "string")
		: [];
}

function matchesCapture(name: string, input: Record<string, unknown>, prior: ReviewScope | undefined): boolean {
	if (!prior || input.lineageId !== prior.lineage) return false;
	if (name === "gentle_review_capture") return typeof input.collectBinding === "string" && prior.bindings.includes(input.collectBinding);
	return name === "gentle_review_capture_group" && Array.isArray(input.collectBindings) &&
		prior.bindings.length > 0 && input.collectBindings.length === prior.bindings.length &&
		input.collectBindings.every((binding, index) => binding === prior.bindings[index]);
}

// This pathless single-capture envelope is not a status or terminal closure.
// It can describe idle continuity only with the publisher's issued correlation.
function isNonterminalReviewerCapture(data: Record<string, unknown>): boolean {
	const relay = record(data.host_relay);
	return data.tool === "gentle_review_capture" && data.status === "captured" &&
		data.outcome === "native-reviewer-result-captured" &&
		typeof data.lineage_id === "string" && data.lineage_id.length > 0 &&
		data.result === undefined && data.closure === undefined &&
		data.native_failure === undefined && data.failure === undefined && data.reconciliation_failure === undefined &&
		relay.transport === "pi_host_relay" &&
		[relay.prompt_bytes, relay.result_bytes].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0) &&
		typeof relay.submission === "string" && relay.submission.length > 0 &&
		[relay.lens, relay.order, relay.subject_hash, relay.role].every((value) => value === undefined || (typeof value === "string" && value.length > 0));
}

/** One in-memory snapshot per live runtime; observation cannot affect tool outcomes. */
export function createReviewSidebarPublisher(pi: ExtensionAPI) {
	let active = true;
	let sessionId: string | undefined;
	let generation = 0;
	let scope: ReviewScope | undefined;
	const publish = (id: string, snapshot: ReviewSidebarSnapshot) => {
		try { pi.events?.emit(REVIEW_SIDEBAR_EVENT, { sessionId: id, snapshot }); } catch { /* Display only. */ }
	};
	return {
		reset(ctx?: ExtensionContext) {
			generation += 1;
			scope = undefined;
			active = ctx !== undefined;
			sessionId = ctx?.sessionManager?.getSessionId();
		},
		tool<TParams extends TSchema, TDetails>(definition: ToolDefinition<TParams, TDetails>): ToolDefinition<TParams, TDetails> {
			return {
				...definition,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const run = () => definition.execute(toolCallId, params, signal, onUpdate, ctx);
					const input = record(params);
					const operation = String(input.operation ?? definition.name);
					if (operation === "assess") return run();
					const id = ctx.sessionManager?.getSessionId();
					if (!active || !id || (sessionId !== undefined && sessionId !== id)) return run();
					sessionId = id;
					const ticket = ++generation;
					const current = () => active && generation === ticket && sessionId === id && ctx.sessionManager.getSessionId() === id;
					const workspace = typeof input.workspaceRoot === "string" ? input.workspaceRoot : ctx.cwd;
					const prior = scope?.workspace === workspace ? scope : undefined;
					const boundCapture = matchesCapture(definition.name, input, prior);
					// Unbound refreshes and new candidates discard the previous display.
					// Keep only a local acknowledgement comparison until its target is known.
					scope = undefined;
					publish(id, { state: boundCapture ? "reviewing" : "checking", scope: boundCapture ? prior!.scope : REVIEW_SCOPE_UNAVAILABLE });
					try {
						const result = await run();
						if (current()) {
							const data = record(result.details);
							const native = record(data.result);
							const closure = record(data.closure);
							const snapshot = reviewSidebarSnapshot(operation, data);
							const lineage = record(native.authority).lineage_id ?? native.lineage_id ?? data.lineage_id ?? closure.lineage_id;
							const target = native.target_identity ?? data.target_identity ?? closure.target_identity;
							const terminalClosure = data.outcome === "native-last-event-closure";
							const closureMatches = !terminalClosure || (closure.schema === "gentle-ai.review-last-event-closure/v1" &&
								closure.lineage_id === prior?.lineage && closure.target_identity === prior?.target);
							const sameCapture = boundCapture && closureMatches &&
								(lineage === undefined || lineage === prior!.lineage) && (target === undefined || target === prior!.target);
							if (definition.name === "gentle_review_capture" && sameCapture && isNonterminalReviewerCapture(data) &&
								data.lineage_id === prior!.lineage && (data.target_identity === undefined || data.target_identity === prior!.target)) {
								snapshot.state = "in_review";
								snapshot.scope = prior!.scope;
							}
							const healthy = !["unknown", "unavailable", "invalidated", "declined"].includes(snapshot.state);
							const sameAcknowledgement = operation === "acknowledge-approved" && snapshot.state === "closed" &&
								prior !== undefined && input.lineageId === prior.lineage && lineage === prior.lineage && target === prior.target;
							if (healthy && (sameCapture || sameAcknowledgement)) {
								if (snapshot.scope === REVIEW_SCOPE_UNAVAILABLE) snapshot.scope = prior!.scope;
								scope = { ...prior!, scope: snapshot.scope, bindings: snapshot.state === "forecast" ? prior!.bindings : [] };
							}
							// A fresh native projection replaces correlation, even for the same lineage.
							if (healthy && native.applicability === "current_target" && snapshot.scope !== REVIEW_SCOPE_UNAVAILABLE && typeof lineage === "string" && lineage && typeof target === "string" && target && native.projection) {
								scope = { workspace, lineage, target, scope: snapshot.scope, bindings: issuedBindings(data) };
							}
							publish(id, snapshot);
						}
						return result;
					} catch (error) {
						if (current()) {
							scope = undefined;
							publish(id, { state: "unavailable", scope: REVIEW_SCOPE_UNAVAILABLE });
						}
						throw error;
					}
				},
			};
		},
	};
}

export function isReviewSidebarSnapshot(value: unknown): value is ReviewSidebarSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<ReviewSidebarSnapshot>;
	return typeof snapshot.state === "string" && Object.hasOwn(REVIEW_SIDEBAR_LABELS, snapshot.state)
		&& typeof snapshot.scope === "string" && snapshot.scope.length > 0;
}
