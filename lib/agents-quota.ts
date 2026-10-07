// Explicit provider credit/quota exhaustion, the only failure that moves a role
// to its next fallback model. A rate limit, a concurrency cap or an overload is
// transient and stays with Pi's own retry policy; routing must never change for
// those, so this classifier is deliberately conservative.

const MAX_CLASSIFIED_CHARS = 2_000;

// Pi's own non-retryable provider-limit vocabulary (pi-ai `isRetryableAssistantError`).
// Not retrying is not proof of exhaustion: a per-minute "quota exceeded" is a rate
// limit, so the transient guard below applies to these too.
const PI_PROVIDER_LIMIT = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i;

// Further explicit exhaustion wording from providers outside Pi's list.
const QUOTA_EXHAUSTED = [
	/^\s*402\b/,
	/\bpayment required\b/i,
	/\binsufficient[_\s-]+(quota|credits?|funds|balance)\b/i,
	/\b(exceeded|exhausted|out of)\b.{0,40}\b(quota|credits?)\b/i,
	/\bquota\b.{0,40}\b(exhausted|reached)\b/i,
	/\bcredit balance\b/i,
	/usage[_\s-]?limit/i,
];

// Transient limiters always win. RESOURCE_EXHAUSTED alone is not evidence either:
// Google also uses it for RPM/TPM throttling, so it needs exhaustion wording above.
const TRANSIENT_LIMIT = /\b(concurren\w*|simultaneous|per[\s-]+(minute|second)|rpm|tpm|rate[_\s-]?limit\w*|too many requests|overloaded)\b/i;

export function isQuotaExhaustion(message: unknown): boolean {
	if (typeof message !== "string") return false;
	const text = message.slice(0, MAX_CLASSIFIED_CHARS);
	if (TRANSIENT_LIMIT.test(text)) return false;
	return PI_PROVIDER_LIMIT.test(text) || QUOTA_EXHAUSTED.some((pattern) => pattern.test(text));
}
