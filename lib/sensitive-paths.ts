// The one list of paths the sensitive-path policy denies. The tool guard
// (extensions/gentle-ai.ts) and the verifier preparer (scripts/prepare-verifier.mjs)
// both read it, so what the guard denies is never staged into verifier scratch.
// The last path component is an env file name: `.env`, `.env.local`, not `.env/id_rsa`.
const ENV_FILE_NAME = /(^|\/)\.env(?:[._-][^/]*)?$/;
const ENV_FILE_PATTERN = /(^|\/)\.env(?:$|[./_-])/;

export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
	/(^|\/)\.ssh(?:\/|$)/,
	/(^|\/)\.credentials(?:\/|$)/,
	/(^|\/)library\/keychains(?:\/|$)/,
	/(^|\/)\.aws\/credentials$/,
	/(^|\/)\.config\/gh\/hosts\.ya?ml$/,
	/(^|\/)secrets(?:\/|$)/,
	ENV_FILE_PATTERN,
	/(^|\/)\.(?:envrc|netrc)(?:$|\/)/,
	/(^|\/)auth\.json$/,
	/\.(?:pem|key|p12|pfx)$/,
];

/** Matches a path already normalized to lowercase with forward slashes. */
export function matchesSensitivePathPattern(normalized: string): boolean {
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * A path whose last component is an env file name and that no other pattern
 * denies: `.env.local`, not `.env.pem`, `~/.ssh/.env` or `.env/id_rsa`. Same input as matchesSensitivePathPattern.
 */
export function isEnvFilePath(normalized: string): boolean {
	return ENV_FILE_NAME.test(normalized) &&
		!SENSITIVE_PATH_PATTERNS.some((pattern) => pattern !== ENV_FILE_PATTERN && pattern.test(normalized));
}

/** A repository-relative path, normalized the way the guard normalizes it. */
export function isSensitiveRepositoryPath(path: string): boolean {
	return matchesSensitivePathPattern(path.trim().replace(/\\/g, "/").toLowerCase());
}
