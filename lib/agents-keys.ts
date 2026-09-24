// Shortcut helpers for the Gentle Agents view. Pure (no Pi API), so both
// extensions/gentle-agents.ts (which owns the view) and other extensions
// that only need the key mapping (extensions/gentle-shell.ts, for the
// command palette's shortcut hints) can depend on it without importing one
// another.

const COLLAPSE_KEY_DEFAULT = "ctrl+shift+a";
const VIEW_KEY_DEFAULT = "alt+a";
const STOP_KEY_DEFAULT = "alt+s";

export function agentsViewKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_AGENTS_VIEW_KEY?.trim();
	if (value === undefined) return VIEW_KEY_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}

export function agentsCollapseKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_AGENTS_KEY?.trim();
	if (value === undefined) return COLLAPSE_KEY_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}

export function agentsStopKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_AGENTS_STOP_KEY?.trim();
	if (value === undefined) return STOP_KEY_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}
