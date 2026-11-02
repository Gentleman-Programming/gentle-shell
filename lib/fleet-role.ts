// Fleet orchestrator roles (odd/tasks/fleet-orchestrator.md). The launcher
// marks the Pi it starts for `gentle-shell orchestrator` as the controller;
// the controller marks each headless session it spawns as a member. Any
// other launch removes the marker, so a nested shell never inherits it.
export const FLEET_ROLE_ENV = "GENTLE_SHELL_FLEET_ROLE";

export type FleetRole = "controller" | "member";

export function fleetRole(env: Record<string, string | undefined>): FleetRole | undefined {
	const value = env[FLEET_ROLE_ENV];
	return value === "controller" || value === "member" ? value : undefined;
}
