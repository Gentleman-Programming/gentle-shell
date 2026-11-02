// Fleet orchestrator roles (odd/tasks/fleet-orchestrator.md). The launcher
// marks the Pi it starts for `gentle-shell fleet` as the controller;
// the controller marks each headless session it spawns as a member. Any
// other launch removes the marker, so a nested shell never inherits it.
// Subagent children inherit the parent env, so a child marker always wins:
// a controller's subagent is never a second controller (no nested fleets).
export const FLEET_ROLE_ENV = "GENTLE_SHELL_FLEET_ROLE";

export type FleetRole = "controller" | "member";

export function fleetRole(env: Record<string, string | undefined>): FleetRole | undefined {
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return undefined;
	const value = env[FLEET_ROLE_ENV];
	return value === "controller" || value === "member" ? value : undefined;
}
