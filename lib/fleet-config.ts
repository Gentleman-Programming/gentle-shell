import { readFileSync } from "node:fs";
import { join } from "node:path";

// Fleet limits (odd/tasks/fleet-orchestrator.md T4, L15): the human owns them
// in `<gentle-pi config home>/fleet.json`; the controller only reads the file
// and has no tool to change it. Cost is information, not a product cap: the
// live-member limit defaults to 8 and both budgets are optional. A missing,
// malformed or invalid value reads as its default and is reported, never thrown.

export const FLEET_CONFIG_FILE = "fleet.json";
export const DEFAULT_MAX_LIVE_MEMBERS = 8;

export interface FleetConfig {
	path: string;
	maxLiveMembers: number;
	/** USD; absent means no fleet budget. */
	fleetBudgetUsd: number | undefined;
	/** USD per member; absent means no member budget. */
	memberBudgetUsd: number | undefined;
	/** What the file had but code ignored, one entry per field. */
	ignored: string[];
}

const WHOLE_FILE = "the whole file (a JSON object)";

function budget(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function readFleetConfig(configHome: string): FleetConfig {
	const path = join(configHome, FLEET_CONFIG_FILE);
	const config: FleetConfig = { path, maxLiveMembers: DEFAULT_MAX_LIVE_MEMBERS, fleetBudgetUsd: undefined, memberBudgetUsd: undefined, ignored: [] };
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		if (!missing) config.ignored.push(WHOLE_FILE);
		return config;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		config.ignored.push(WHOLE_FILE);
		return config;
	}
	const file = raw as Record<string, unknown>;
	if ("maxLiveMembers" in file) {
		const value = file.maxLiveMembers;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) config.maxLiveMembers = value;
		else config.ignored.push("maxLiveMembers (an integer of at least 1)");
	}
	for (const key of ["fleetBudgetUsd", "memberBudgetUsd"] as const) {
		if (!(key in file)) continue;
		config[key] = budget(file[key]);
		if (config[key] === undefined) config.ignored.push(`${key} (a number of USD above 0)`);
	}
	return config;
}
