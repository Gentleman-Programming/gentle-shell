// Shortcut helpers for the Drakonc Agents view. Pure (no Pi API), so both
// extensions/drakonc-agents.ts (which owns the view) and other extensions
// that only need the key mapping (extensions/drakonc-shell.ts, for the
// command palette's shortcut hints) can depend on it without importing one
// another. Defaults and the saved keymaps live in lib/keymaps.ts.

import { effectiveKey, type KeymapBindings } from "./keymaps.ts";

export function agentsViewKey(env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): string | undefined {
	return effectiveKey("agents.view", env, bindings);
}

export function agentsCollapseKey(env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): string | undefined {
	return effectiveKey("agents.collapse", env, bindings);
}

export function agentsStopKey(env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): string | undefined {
	return effectiveKey("agents.stop", env, bindings);
}
