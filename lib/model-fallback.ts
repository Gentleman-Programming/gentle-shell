// Minimal shared typed provider error eligibility + single fallback attempt policy (FB-2).

export const FALLBACK_PROVIDER = "cli-proxy-api";
export const FALLBACK_MODEL_ID = "gemini-3.8-flash-high";
export const FALLBACK_MODEL = `${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID}`;
export const FALLBACK_EFFORT = "high" as const;

export type FallbackEffort = typeof FALLBACK_EFFORT;
export type FailureOrigin = "model_provider" | "provider" | "tool" | "task" | "agent" | "rdd" | "user" | "unknown";

export interface ProviderErrorCandidate {
	origin?: string;
	status?: number;
	statusCode?: number;
	code?: string | number;
	name?: string;
	message?: string;
	reason?: string;
	details?: unknown;
}

export interface FallbackStopDecision {
	readonly action: "stop";
	readonly reason: string;
	readonly eligible: boolean;
}

export interface FallbackActiveDecision {
	readonly action: "fallback";
	readonly reason: string;
	readonly eligible: true;
	readonly fallbackModel: typeof FALLBACK_MODEL;
	readonly fallbackEffort: FallbackEffort;
	readonly metadata: {
		readonly target: typeof FALLBACK_MODEL;
		readonly provider: typeof FALLBACK_PROVIDER;
		readonly modelId: typeof FALLBACK_MODEL_ID;
		readonly effort: FallbackEffort;
		readonly primaryModel: string;
		readonly primaryEffort?: string;
	};
}

export type FallbackDecision = FallbackStopDecision | FallbackActiveDecision;

export interface FallbackEvaluationInput {
	primaryModel: string;
	primaryEffort?: string;
	error: unknown;
	origin?: string;
	attempted?: boolean;
	fallbackAvailable?: boolean;
}

const ELIGIBLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const ELIGIBLE_QUOTA_CODES = new Set([
	"RESOURCE_EXHAUSTED", "resource_exhausted",
	"rate_limit_exceeded", "RATE_LIMIT_EXCEEDED",
	"quota_exceeded", "QUOTA_EXHAUSTED",
]);
const ELIGIBLE_SERVICE_CODES = new Set([
	"UNAVAILABLE", "SERVICE_UNAVAILABLE", "service_unavailable",
	"TRANSIENT_FAILURE", "transient_service", "SERVER_ERROR",
]);
const ELIGIBLE_TRANSPORT_CODES = new Set([
	"ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE",
	"UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
	"ENOTFOUND", "NETWORK_ERROR", "ERR_STREAM_PREMATURE_CLOSE",
]);
const KNOWN_TRANSPORT_PATTERNS = [
	"socket hang up", "premature close", "connection reset", "stream disconnected",
	"transport disconnection", "fetch failed", "network error", "connection closed",
	"service unavailable", "gateway timeout", "bad gateway", "econnreset", "etimedout",
];

function isProviderOrigin(val?: string): boolean { return val === "model_provider" || val === "provider"; }

function hasValidProviderOrigin(error: unknown, explicitOrigin?: string): boolean {
	const explicit = typeof explicitOrigin === "string" ? explicitOrigin.trim() : undefined;
	const embedded =
		typeof error === "object" && error !== null && "origin" in error && typeof (error as { origin?: unknown }).origin === "string"
			? (error as { origin: string }).origin.trim()
			: undefined;

	if (embedded !== undefined) {
		if (!isProviderOrigin(embedded)) return false;
		if (explicit !== undefined && !isProviderOrigin(explicit)) return false;
		return true;
	}
	return isProviderOrigin(explicit);
}

function extractFields(error: unknown): { name?: string; message?: string; code?: string | number; status?: number; reason?: string } {
	if (typeof error !== "object" || error === null) return typeof error === "string" ? { message: error } : {};
	const rec = error as Record<string, unknown>;
	const status = typeof rec.status === "number" ? rec.status : typeof rec.statusCode === "number" ? rec.statusCode : undefined;
	const code = typeof rec.code === "string" || typeof rec.code === "number" ? rec.code : undefined;
	const name = typeof rec.name === "string" ? rec.name : undefined;
	const message = typeof rec.message === "string" ? rec.message : undefined;
	const reason = typeof rec.reason === "string" ? rec.reason : undefined;
	return { status, code, name, message, reason };
}

export function isEligibleProviderError(error: unknown, origin?: string): boolean {
	if (!hasValidProviderOrigin(error, origin)) return false;

	const ext = extractFields(error);
	const msg = ext.message?.toLowerCase();

	// Negative gates: abort, user refusal, rdd failure, tool denial
	if (ext.name === "AbortError" || ext.code === "ABORT_ERR" || ext.code === "ERR_ABORTED" || ext.reason === "aborted" || msg?.includes("aborted")) return false;
	if (ext.code === "USER_REFUSAL" || ext.code === "user_refusal" || ext.reason === "user_refusal" || msg?.includes("user refusal") || msg?.includes("user declined")) return false;
	if (ext.code === "RDD_FAILURE" || ext.code === "rdd_failure" || ext.reason === "native_rdd_failure" || msg?.includes("rdd failure") || msg?.includes("native review authority")) return false;
	if (ext.code === "TOOL_CAPABILITY_DENIAL" || ext.code === "tool_capability_denial" || msg?.includes("tool capability denial") || msg?.includes("tool denied")) return false;

	// Negative gates: auth invalid credentials
	if (ext.status === 401 || ext.status === 403 || ext.code === "UNAUTHENTICATED" || ext.code === "PERMISSION_DENIED" || ext.code === "INVALID_API_KEY" || ext.code === "AUTH_INVALID" || ext.code === "AUTH_UNAVAILABLE" || msg?.includes("invalid api key") || msg?.includes("unauthorized")) return false;

	// Negative gates: context overflow
	if (ext.code === "CONTEXT_OVERFLOW" || ext.code === "context_length_exceeded" || ext.code === "max_tokens_exceeded" || ext.code === "prompt_too_long" || msg?.includes("context length exceeded") || msg?.includes("context overflow") || msg?.includes("maximum context length")) return false;

	// Negative gates: invalid request
	if (ext.status === 400 || ext.status === 422 || ext.code === "INVALID_ARGUMENT" || ext.code === "INVALID_REQUEST" || ext.code === "invalid_request_error" || ext.code === "BAD_REQUEST" || msg?.includes("invalid request")) return false;

	// Positives: status codes 429, 500, 502, 503, 504
	if (ext.status !== undefined && ELIGIBLE_STATUS_CODES.has(ext.status)) return true;
	if (typeof ext.code === "number" && ELIGIBLE_STATUS_CODES.has(ext.code)) return true;
	if (typeof ext.code === "string") {
		if (/^\d{3}$/.test(ext.code)) {
			const parsed = Number(ext.code);
			if (ELIGIBLE_STATUS_CODES.has(parsed)) return true;
		}
		if (ELIGIBLE_QUOTA_CODES.has(ext.code) || ELIGIBLE_SERVICE_CODES.has(ext.code) || ELIGIBLE_TRANSPORT_CODES.has(ext.code)) return true;
	}

	// Positives: known transport disconnection strings
	if (msg) {
		for (const pattern of KNOWN_TRANSPORT_PATTERNS) {
			if (msg.includes(pattern)) return true;
		}
	}

	return false;
}

export function evaluateModelFallback(input: FallbackEvaluationInput): FallbackDecision {
	const primary = input.primaryModel?.trim();
	if (!primary || primary === FALLBACK_MODEL || primary === FALLBACK_MODEL_ID) {
		return { action: "stop", reason: "primary_equals_fallback", eligible: false };
	}
	if (input.attempted) {
		return { action: "stop", reason: "already_attempted", eligible: false };
	}
	if (input.fallbackAvailable !== true) {
		return { action: "stop", reason: "fallback_unavailable", eligible: false };
	}

	const eligible = isEligibleProviderError(input.error, input.origin);
	if (!eligible) {
		return { action: "stop", reason: "ineligible_provider_error", eligible: false };
	}

	return {
		action: "fallback",
		reason: "eligible_provider_error",
		eligible: true,
		fallbackModel: FALLBACK_MODEL,
		fallbackEffort: FALLBACK_EFFORT,
		metadata: {
			target: FALLBACK_MODEL,
			provider: FALLBACK_PROVIDER,
			modelId: FALLBACK_MODEL_ID,
			effort: FALLBACK_EFFORT,
			primaryModel: input.primaryModel,
			...(input.primaryEffort ? { primaryEffort: input.primaryEffort } : {}),
		},
	};
}
