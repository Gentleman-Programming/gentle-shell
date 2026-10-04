/**
 * Telemetry opt-out detection and environment propagation for CodeGraph and
 * child invocations. Invariant: user opt-outs can never be overridden to
 * enabled by child processes or subagents.
 */

/** Standard opt-out environment map applied to every CodeGraph subprocess. */
const OPT_OUT_ENV: Readonly<Record<string, string>> = {
	DO_NOT_TRACK: "1",
	CODEGRAPH_TELEMETRY: "0",
	GENTLE_AI_TELEMETRY: "0",
	SCARF_NO_ANALYTICS: "1",
	TELEMETRY_DISABLED: "1",
};

/**
 * Returns true when any standard opt-out indicator is set in `env`.
 * Checked indicators: DO_NOT_TRACK=1, GENTLE_AI_TELEMETRY=0,
 * CODEGRAPH_TELEMETRY=0, TELEMETRY_DISABLED=1, SCARF_NO_ANALYTICS=1.
 */
export function isTelemetryOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		env.DO_NOT_TRACK === "1" ||
		env.GENTLE_AI_TELEMETRY === "0" ||
		env.CODEGRAPH_TELEMETRY === "0" ||
		env.TELEMETRY_DISABLED === "1" ||
		env.SCARF_NO_ANALYTICS === "1"
	);
}

/**
 * Returns the standard telemetry opt-out environment map. Always returns the
 * full opt-out set — CodeGraph subprocesses are always opted out regardless
 * of whether the user has explicitly set any opt-out variable.
 *
 * Invariant: user opt-outs present in `baseEnv` are preserved and can never
 * be overridden to enabled values by child processes.
 */
export function resolveTelemetryOptOutEnv(
	baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	// Always enforce the full opt-out set. If the user has opted out via any
	// mechanism, those values are already "1"/"0" and are reinforced, not
	// weakened. No path through this function can produce an enabled value.
	void baseEnv; // consumed only to satisfy the signature; opt-out is unconditional
	return { ...OPT_OUT_ENV };
}
