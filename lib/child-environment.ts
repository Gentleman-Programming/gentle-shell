// Sensitive environment filtering for child agents. A child never inherits
// credentials from the host process: keys matching password, secret,
// credential, token, or API/access/private-key names are removed from the
// child's environment unless the role declares them in `env_keep`. Live
// credential channels whose names match no pattern (SSH agent socket, Docker
// auth config) and credential-bearing database URLs (DATABASE_URL) are
// filtered explicitly.
//
// This module is pure: callers copy the environment first and delete the
// returned keys from the copy, so the parent's own environment is never
// modified.

const SENSITIVE_ENV_KEY_PATTERNS: readonly RegExp[] = [
	/(?:^|_)PASSWORDS?(?:_|$)/,
	/(?:^|_)PASSWD(?:_|$)/,
	/(?:^|_)SECRETS?(?:_|$)/,
	/(?:^|_)CREDENTIALS?(?:_|$)/,
	/_TOKEN$/,
	/_API_KEY/,
	/_ACCESS_KEY/,
	/_PRIVATE_KEY/,
];

const ALWAYS_SENSITIVE_ENV_KEYS = new Set([
	"TOKEN", "PASSWORD", "PASSWD", "SECRET", "SECRETS", "CREDENTIAL", "CREDENTIALS",
	"API_KEY", "ACCESS_KEY", "PRIVATE_KEY", "SECRET_KEY",
	// Live credential channels and credential-bearing database URLs whose names
	// match no pattern above: an SSH agent socket, a Docker auth config, and
	// DATABASE_URL, which can embed credentials in its value. A child that needs
	// one declares it in `env_keep`; npm config stays unfiltered by contract.
	"SSH_AUTH_SOCK", "DOCKER_AUTH_CONFIG", "DATABASE_URL",
]);

/** A key normalized for case-insensitive matching against the keep list and the sensitive-name rules. */
const normalizeEnvKey = (key: string) => key.toUpperCase();

/** Whether a normalized key is always sensitive or matches one of the sensitive-name patterns. */
const isSensitiveEnvKey = (normalizedKey: string) => {
	if (ALWAYS_SENSITIVE_ENV_KEYS.has(normalizedKey)) return true;
	for (const pattern of SENSITIVE_ENV_KEY_PATTERNS) {
		if (pattern.test(normalizedKey)) return true;
	}
	return false;
};

/**
 * Environment keys that must not reach a child agent, sorted. `keep` lists the
 * exact names a role declares it needs; matching is case-insensitive and a
 * kept key is never removed, even when it looks sensitive.
 */
export function inheritedSensitiveChildEnvironmentKeys(
	environment: NodeJS.ProcessEnv = process.env,
	keep: readonly string[] = [],
): string[] {
	const keepKeys = new Set(keep.map(normalizeEnvKey));
	const sensitiveKeys: string[] = [];
	for (const key of Object.keys(environment)) {
		const normalizedKey = normalizeEnvKey(key);
		if (keepKeys.has(normalizedKey)) continue;
		if (isSensitiveEnvKey(normalizedKey)) sensitiveKeys.push(key);
	}
	return sensitiveKeys.toSorted();
}
