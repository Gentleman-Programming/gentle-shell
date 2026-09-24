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

export function isReviewSidebarSnapshot(value: unknown): value is ReviewSidebarSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<ReviewSidebarSnapshot>;
	return typeof snapshot.state === "string" && Object.hasOwn(REVIEW_SIDEBAR_LABELS, snapshot.state)
		&& typeof snapshot.scope === "string" && snapshot.scope.length > 0;
}
