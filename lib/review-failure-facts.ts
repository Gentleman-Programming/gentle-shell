import { NativeReviewCliError, NativeReviewConsentBindingError, NativeReviewIntegrationError, sanitizeForeignNativeReviewDiagnostics, type NativeReviewProcessDiagnostics } from "./native-review-cli.ts";

/** Narrow decoded objects before reading error facts. */
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recognize source/bundled CLI errors without trusting foreign diagnostics. */
export function asNativeReviewCliError(error: unknown): { code: string; diagnostics: NativeReviewProcessDiagnostics } | undefined {
	if (error instanceof NativeReviewCliError) return error;
	if (!record(error) || error.name !== "NativeReviewCliError" || typeof error.code !== "string") return undefined;
	const diagnostics = sanitizeForeignNativeReviewDiagnostics(error.diagnostics);
	return diagnostics === undefined || error.code !== diagnostics.error_code ? undefined : { code: error.code, diagnostics };
}

/** Read consent-binding failures across source and bundled module boundaries. */
function consentBindingFailure(error: unknown): { reason: string; message: string } | undefined {
	if (error instanceof NativeReviewConsentBindingError) return { reason: error.reason, message: error.message };
	if (!(error instanceof Error) || error.name !== "NativeReviewConsentBindingError") return undefined;
	const reason = (error as unknown as { reason?: unknown }).reason;
	return typeof reason !== "string" || reason.length === 0 ? undefined : { reason, message: error.message };
}

/**
 * Read existing error facts once. This does not grant retry, infer authority,
 * sanitize a provider envelope, or decide an operation's public outcome.
 */
export function readReviewFailureFacts(error: unknown) {
	const value = record(error) ? error : {};
	const envelope = record(value.failureEnvelope) && record(value.failureEnvelope.raw) ? value.failureEnvelope : undefined;
	return {
		cli: asNativeReviewCliError(error),
		consentBinding: consentBindingFailure(error),
		// Group/status historically accept only decoded integration instances;
		// keep that stricter provenance separate from the operation envelope.
		integration: error instanceof NativeReviewIntegrationError ? error.failureEnvelope : undefined,
		envelope: envelope === undefined ? undefined : {
			raw: envelope.raw as Record<string, unknown>,
			mutationOutcome: envelope.mutationOutcome,
			replayability: typeof envelope.replayability === "string" ? envelope.replayability : undefined,
			nextAction: typeof envelope.nextAction === "string" ? envelope.nextAction : undefined,
			managedAssetsCommand: envelope.code === "managed_assets_outdated" && record(envelope.continuation) && typeof envelope.continuation.command === "string" ? envelope.continuation.command : undefined,
		},
		mutationOutcome: value.mutationOutcome === "unknown" ? "unknown" as const : "none" as const,
		nextAction: value.nextAction,
		auditRecord: record(value.auditRecord) ? value.auditRecord : undefined,
		candidateViewPreNative: value.candidateViewPreNative === true,
	};
}
