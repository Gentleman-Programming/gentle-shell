/**
 * SEC-14: Protected versioned negative specification, deterministic enforcement,
 * and canaries. Policy surfaces require explicit human approval for modification.
 */

export const NEGATIVE_SPEC_SCHEMA = "gentle-ai.negative-spec/v1" as const;

export const NEGATIVE_INVARIANTS = [
	"no_credentials",
	"no_arbitrary_bash_escape",
	"no_unauthorized_policy_modification",
	"no_unverified_green",
	"fail_closed_malformed_policy",
] as const;

export type NegativeInvariant = (typeof NEGATIVE_INVARIANTS)[number];

/** Protected policy surfaces that require explicit human approval to modify. */
const PROTECTED_POLICY_PATTERNS: ReadonlyArray<(path: string) => boolean> = [
	(p) => /^\.semgrep(?:\/|$)/.test(p),
	(p) => /^lib\/[^/]*policy[^/]*\.ts$/.test(p),
	(p) => p === "lib/negative-specification.ts",
	(p) => p === "lib/actor-capabilities.ts",
	(p) => p === "lib/bounded-writer-admission.ts",
];

/**
 * Returns true when `filePath` is a protected policy surface.
 * Accepts both relative and absolute paths; compares against
 * canonical relative forms.
 */
export function isProtectedPolicySurface(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
	return PROTECTED_POLICY_PATTERNS.some((check) => check(normalized));
}

/**
 * Evaluates write admission for a given file path.
 * Protected policy surfaces deny admission unless `hasHumanApproval` is true.
 */
export function evaluatePolicyWriteAdmission(
	filePath: string,
	options?: { hasHumanApproval?: boolean },
): { admitted: boolean; reason?: string } {
	if (isProtectedPolicySurface(filePath)) {
		if (options?.hasHumanApproval !== true) {
			return {
				admitted: false,
				reason: `modification of protected policy surface ${filePath} requires explicit human approval`,
			};
		}
	}
	return { admitted: true };
}

export interface NegativeSpecificationPayload {
	schema: string;
	invariants: readonly string[];
}

/**
 * Validates a negative specification payload. Fails closed on null/undefined,
 * non-object, wrong schema version, or missing/incomplete invariants.
 */
export function validateNegativeSpecification(spec: unknown): { valid: boolean; reason?: string } {
	if (spec === null || spec === undefined) return { valid: false, reason: "specification is null or undefined" };
	if (typeof spec !== "object" || Array.isArray(spec)) return { valid: false, reason: "specification is not an object" };
	const record = spec as Record<string, unknown>;
	if (record["schema"] !== NEGATIVE_SPEC_SCHEMA) {
		return { valid: false, reason: `schema mismatch: expected "${NEGATIVE_SPEC_SCHEMA}", got ${JSON.stringify(record["schema"])}` };
	}
	if (!Array.isArray(record["invariants"])) return { valid: false, reason: "invariants field is missing or not an array" };
	const invariants = record["invariants"] as unknown[];
	for (const inv of NEGATIVE_INVARIANTS) {
		if (!invariants.includes(inv)) return { valid: false, reason: `missing required invariant: "${inv}"` };
	}
	return { valid: true };
}
