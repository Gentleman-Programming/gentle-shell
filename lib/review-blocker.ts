export const REVIEW_BLOCKER_GUIDANCE = "When blocker is present, explain its category, actor and next_step in the user's language. It describes only this review step: native continuations, stop/no-retry rules, consent and ordinary repository delivery policy remain authoritative. Do not infer a need to contact a remote maintainer from maintainerAuthorization alone.";

/** Informational host diagnosis; native continuations and repository policy remain authoritative. */
export interface ReviewBlocker {
	category: "configuration" | "input" | "consent" | "continuation" | "stale-binding" | "provider-capability" | "provider-unavailable" | "admission-refused" | "generation-invalid" | "authority-unavailable" | "provider-stop" | "diagnosis-required";
	scope: "review-step";
	actor: "user" | "caller" | "authorized-operator" | "unknown";
	next_step: string;
	automatic_retry: false;
	native_next_action?: string;
}

/** Read object-shaped diagnostic fields without interpreting scalars or arrays. */
function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Classify structured facts only, never provider prose, prompts or stderr. */
export function withReviewBlocker(result: Record<string, unknown>): Record<string, unknown> {
	if (result.status !== "blocked") return result;
	const native = record(result.native_failure);
	const transition = record(record(result.result).next_transition);
	const failure = record(result.failure);
	const nativeAction = typeof native.next_action === "string" ? native.next_action : undefined;
	const diagnose = (category: ReviewBlocker["category"], actor: ReviewBlocker["actor"], next_step: string): Record<string, unknown> => ({
		...result,
		blocker: { category, scope: "review-step", actor, next_step, automatic_retry: false,
			...(nativeAction === undefined ? {} : { native_next_action: nativeAction }) } satisfies ReviewBlocker,
	});
	// Uncertainty takes precedence over convenient local remedies. A diagnosis
	// must not suggest re-running an operation that may already have committed.
	if (result.mutation_outcome === "unknown" || result.mutation_outcome === "partial_unknown") {
		return diagnose("authority-unavailable", "unknown", "Follow the returned native reconciliation or stop action. Do not replay an operation with an unknown outcome.");
	}
	if (nativeAction === "explicit-maintainer-action") {
		return diagnose("authority-unavailable", "authorized-operator", "Use the provider-supported maintenance route with its required fresh authorization. Do not infer permission to repair or replay.");
	}
	if (nativeAction !== "stop" && transition.kind !== "stop" && (result.outcome === "native-status-unsupported" || result.outcome === "request-context-unsupported" || failure.kind === "relay-unavailable" || failure.kind === "handshake-refused" || result.outcome === "pi-host-relay-handshake-refused" || result.outcome === "pi-host-relay-unavailable" || result.outcome === "pi-host-relay-transport-unavailable")) {
		return diagnose("provider-capability", "user", "Check the package-selected native provider, its supported capabilities and the host handshake; reload the host after a supported installation change. Escalate only if the required capability is still unavailable.");
	}
	if (result.outcome === "native-status-package-binary-missing" || native.code === "managed_assets_outdated") {
		return diagnose("configuration", "user", "Use the returned installation or managed-asset remediation. Keep any provider stop and authorization requirements in force.");
	}
	if (["reviewer-config-invalid", "reviewer-model-not-found", "reviewer-thinking-invalid"].includes(String(failure.kind))) {
		return diagnose("configuration", "user", "Configure the indicated review routing key with an available model and supported thinking setting. Then follow the returned continuation; this does not authorize a model run or retry.");
	}
	if (failure.kind === "reviewer-auth-unavailable") {
		return diagnose("configuration", "user", "Resolve authentication for the configured reviewer provider, then follow the returned continuation without replaying an uncertain submission.");
	}
	if (failure.kind === "submission-refused") {
		return diagnose("admission-refused", "caller", "The provider refused the generated submission. Preserve its evidence and exact next action; do not strip fields, fabricate a verdict or retry automatically.");
	}
	if (["reviewer-tool-call-attempted", "reviewer-empty-output", "reviewer-output-too-large"].includes(String(failure.kind))) {
		return diagnose("generation-invalid", "caller", "The completion did not satisfy the reviewer boundary. Follow the returned native continuation; do not substitute a result or assume another generation is authorized.");
	}
	if (result.outcome === "native-review-consent-required" || result.outcome === "reviewer-model-run-forecast" || result.outcome === "consent-binding-invalid") {
		return diagnose("consent", "user", "Resolve the returned consent or model-run confirmation through the host using its current binding. This diagnostic grants no consent.");
	}
	if (result.outcome === "consent-binding-stale" || (result.outcome === "intended-untracked-selection-binding-rejected" && ["binding-mismatch", "status-field-mismatch"].includes(String(result.reason)))) {
		return diagnose("stale-binding", "caller", "Do not resend this binding. Follow the host's current continuation to obtain the exact binding for the current candidate, preserving any stop or authorization requirement.");
	}
	// A blocked facade response can be a normal offer awaiting its next host
	// operation. Do not diagnose a ready ACK or collect offer as an unknown error.
	if (result.outcome === undefined && result.failure === undefined && result.native_failure === undefined && result.reconciliation_failure === undefined && result.reconciliation === undefined && transition.kind === "collect" && transition.reason_code === "empty_candidate_base_ref_required") {
		return diagnose("input", "caller", "The current candidate needs an explicit baseRef with committedOnly: true if a committed range is intended. To check a previously acknowledged candidate, use ASSESS with its original committed range and follow the returned evidence. This input request does not establish that an earlier review failed or remains open; it does not authorize another review, acknowledgement or maintenance operation.");
	}
	if (result.outcome === undefined && result.failure === undefined && result.native_failure === undefined && result.reconciliation_failure === undefined && result.reconciliation === undefined && (
		(transition.kind === "execute" && ["review.start", "review.status", "review.acknowledge-approved"].includes(String(record(transition.execute).operation))) ||
		(Array.isArray(result.collectBindings) && result.collectBindings.length > 0)
	)) {
		return diagnose("continuation", "caller", "Follow the exact offered host continuation and its required model-run confirmation or consent. This is a pending review step, not an unknown failure or a new execution permission.");
	}
	if (native.code === "invalid_request" || typeof result.selectionBinding === "string" || Array.isArray(result.collectBindings) || result.outcome === "capture-binding-rejected" || result.outcome === "capture-group-rejected" || (typeof result.outcome === "string" && result.outcome.startsWith("native-start-"))) {
		return diagnose("input", "caller", "Supply the exact requested fields or current host-issued binding. Follow any native stop or no-retry action; a corrected input is not automatic replay permission.");
	}
	if (nativeAction === "stop" || transition.kind === "stop") {
		return diagnose("provider-stop", "unknown", "The provider stopped this review step. Use only a recovery or continuation it explicitly offers; otherwise preserve the diagnostic for investigation.");
	}
	if (result.outcome === "native-status-timed-out") {
		return diagnose("provider-unavailable", "user", "The read-only review inventory read timed out before it completed. Nothing was mutated; rerun the returned remediation_command when ready. Pi does not retry automatically.");
	}
	if (record(result.diagnostics).timed_out === true) {
		return diagnose("provider-unavailable", "unknown", "The native process timed out; its internal phase is not established. Follow the returned action without assuming lock contention, deleting locks or retrying automatically.");
	}
	if (result.outcome === "capture-route-registration-rejected" || result.inventory_complete === false) {
		return diagnose("authority-unavailable", "unknown", "The current authority or routing evidence is incomplete. Preserve the diagnostic and use only the supported native continuation; do not reset or rebuild authority locally.");
	}
	if (failure.kind === "pi-timed-out" || failure.kind === "materialize-failed" || failure.kind === "pi-failed" || result.outcome === "native-operation-failed" || result.outcome === "native-status-unavailable" || result.outcome === "native-status-failed") {
		return diagnose("provider-unavailable", "unknown", "Inspect the returned phase and sanitized diagnostics. A timeout alone does not identify a lock or permit a retry; follow the returned native action.");
	}
	return diagnose("diagnosis-required", "unknown", "Use the structured diagnostic and the supported continuation to identify the cause. No maintainer intervention, retry or authority mutation is implied.");
}
