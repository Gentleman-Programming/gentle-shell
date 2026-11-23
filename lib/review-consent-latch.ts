import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertManagedStorePathV1, resolveRepositoryAuthorityV1 } from "./review-repository.ts";

// Pi-owned, clone-local (Git-common-dir) latch recording that the one-time
// "run the review now?" question has already been put to the user for this
// clone. Design Decision #2 (organic-rdd-parity): scope, direction, and
// asymmetry mirror drakonc-ai's own RDDConsentAsked/RecordRDDConsentAsked
// exactly (per clone, accept-only, never committed, never inherited) —
// but this is Pi's OWN latch, at Pi's OWN path, never drakonc-ai's private
// rdd-mode/asked.json. Writing another product's private authority store
// would be a boundary violation.
export const REVIEW_CONSENT_LATCH_SCHEMA = "drakonc-pi.review-consent-asked/v1";
const REVIEW_CONSENT_LATCH_PAYLOAD = `{"schema":"${REVIEW_CONSENT_LATCH_SCHEMA}"}\n`;

function reviewConsentLatchPath(cwd: string): string {
	const authority = resolveRepositoryAuthorityV1(cwd);
	return assertManagedStorePathV1(authority.common_directory, join(authority.common_directory, "drakonc-pi", "review-consent", "asked.json"));
}

/**
 * Reads whether the one-time consent question has already been asked for
 * this clone. Returns false when no latch has ever been recorded. Throws
 * when the repository/Git-common-dir authority cannot be resolved at all
 * (unresolvable, non-Git, or shallow repository) — callers must treat that
 * as "no latch write, review proceeds" per the Threat Matrix rather than
 * silently reporting a latch.
 */
export function readReviewConsentLatch(cwd: string): boolean {
	const path = reviewConsentLatchPath(cwd);
	let payload: string;
	try {
		payload = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	return payload === REVIEW_CONSENT_LATCH_PAYLOAD;
}

/**
 * Records the one-time consent question as asked for this clone. One-way:
 * called only on accept, never on decline. Idempotent — recording twice
 * writes the same exact canonical bytes.
 */
export function recordReviewConsentLatch(cwd: string): void {
	const path = reviewConsentLatchPath(cwd);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, REVIEW_CONSENT_LATCH_PAYLOAD, { mode: 0o600 });
	chmodSync(path, 0o600);
}
