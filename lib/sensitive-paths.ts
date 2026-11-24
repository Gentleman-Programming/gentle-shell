// The one list of paths the sensitive-path policy denies. The tool guard
// (extensions/gentle-ai.ts) and the verifier preparer (scripts/prepare-verifier.mjs)
// both read it, so what the guard denies is never staged into verifier scratch.
export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
	/(^|\/)\.ssh(?:\/|$)/,
	/(^|\/)\.credentials(?:\/|$)/,
	/(^|\/)library\/keychains(?:\/|$)/,
	/(^|\/)\.aws\/credentials$/,
	/(^|\/)\.config\/gh\/hosts\.ya?ml$/,
	/(^|\/)secrets(?:\/|$)/,
	/(^|\/)\.env(?:$|[./_-])/,
	/(^|\/)\.(?:envrc|netrc)(?:$|\/)/,
	/(^|\/)auth\.json$/,
	/\.(?:pem|key|p12|pfx)$/,
];

/** Matches a path already normalized to lowercase with forward slashes. */
export function matchesSensitivePathPattern(normalized: string): boolean {
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** A repository-relative path, normalized the way the guard normalizes it. */
export function isSensitiveRepositoryPath(path: string): boolean {
	return matchesSensitivePathPattern(path.trim().replace(/\\/g, "/").toLowerCase());
}
