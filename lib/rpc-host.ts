// Interactive RPC host signal: the desktop app sets this environment variable
// on the pi process it spawns directly (`--mode rpc`), letting Gentle answer
// ask-user tools through pi's RPC dialogs and publish live subagent state.
// `lib/agents-runner.ts` strips it from every subagent child env so headless
// RPC children never see it and stay unaffected by this feature.

/** Environment variable the desktop app sets on its own interactive pi process. */
export const INTERACTIVE_HOST_ENV = "GENTLE_SHELL_INTERACTIVE_HOST";

/**
 * True only when running under `--mode rpc` with the interactive host
 * variable set to exactly `"1"`. Any other value, or its absence, keeps RPC
 * headless (the existing subagent behaviour).
 */
export function isInteractiveRpcHost(mode: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return mode === "rpc" && env[INTERACTIVE_HOST_ENV] === "1";
}

/**
 * True for the interactive TUI, or for an interactive RPC host. Extensions
 * use this to offer dialog-capable behaviour without special-casing RPC.
 */
export function isInteractiveMode(mode: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return mode === "tui" || isInteractiveRpcHost(mode, env);
}

/**
 * Copy of `env` with the interactive host variable removed. Used when
 * assembling a subagent child's environment so it never inherits the
 * parent's interactive-host signal, even when the parent itself is one.
 */
export function withoutInteractiveHost(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next = { ...env };
	delete next[INTERACTIVE_HOST_ENV];
	return next;
}
