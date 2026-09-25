import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const VISUAL_SCHEMA = "gentle-pi.visual-customization/v1";
export const STATUS_PLACEMENT = { AUTO: "auto", RIGHT: "right", BOTTOM: "bottom", HIDDEN: "hidden" } as const;
export const HEADER_PLACEMENT = { TOP: "top", BELOW_INPUT: "below-input" } as const;
export const DENSITY = { COMFORTABLE: "comfortable", COMPACT: "compact", MINIMAL: "minimal" } as const;
export type StatusPlacement = (typeof STATUS_PLACEMENT)[keyof typeof STATUS_PLACEMENT];
export type HeaderPlacement = (typeof HEADER_PLACEMENT)[keyof typeof HEADER_PLACEMENT];
export type Density = (typeof DENSITY)[keyof typeof DENSITY];

export interface VisualVisibility {
	changes: boolean;
	agents: boolean;
	todo: boolean;
	usageCost: boolean;
	modelDetails: boolean;
}
export interface VisualSettings {
	statusPlacement: StatusPlacement;
	headerPlacement: HeaderPlacement;
	density: Density;
	visibility: VisualVisibility;
}
export const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
	statusPlacement: STATUS_PLACEMENT.AUTO,
	headerPlacement: HEADER_PLACEMENT.TOP,
	density: DENSITY.COMFORTABLE,
	visibility: { changes: true, agents: true, todo: true, usageCost: true, modelDetails: true },
};
interface VisualOptions { gentlePiConfigHome?: string }
export interface VisualResolution {
	settings: VisualSettings;
	source: "global_file" | "default";
	malformed: boolean;
	readError: boolean;
	globalFile: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysMatch(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function member<T extends string>(value: unknown, choices: Record<string, T>): value is T {
	return typeof value === "string" && Object.values(choices).includes(value as T);
}
export function isVisualSettings(value: unknown): value is VisualSettings {
	if (!record(value) || !keysMatch(value, ["statusPlacement", "headerPlacement", "density", "visibility"])) return false;
	const visibility = value.visibility;
	return member(value.statusPlacement, STATUS_PLACEMENT)
		&& member(value.headerPlacement, HEADER_PLACEMENT)
		&& member(value.density, DENSITY)
		&& record(visibility)
		&& keysMatch(visibility, ["changes", "agents", "todo", "usageCost", "modelDetails"])
		&& Object.values(visibility).every((item) => typeof item === "boolean");
}
export function parseVisualSettingsFile(raw: string): VisualSettings | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!record(parsed) || parsed.schema !== VISUAL_SCHEMA) return undefined;
		const { schema: _schema, ...settings } = parsed;
		return isVisualSettings(settings) ? settings : undefined;
	} catch { return undefined; }
}
export function resolveVisualSettings(options: VisualOptions = {}): VisualResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "visual-customization.json");
	try {
		const settings = parseVisualSettingsFile(readFileSync(globalFile, "utf8"));
		return { settings: settings ?? structuredClone(DEFAULT_VISUAL_SETTINGS), source: "global_file", malformed: settings === undefined, readError: false, globalFile };
	} catch (error) {
		const missing = record(error) && error.code === "ENOENT";
		return { settings: structuredClone(DEFAULT_VISUAL_SETTINGS), source: missing ? "default" : "global_file", malformed: false, readError: !missing, globalFile };
	}
}
/** Same-directory rename keeps partial JSON invisible to readers. */
export function writeVisualSettings(settings: VisualSettings, options: VisualOptions = {}): string {
	if (!isVisualSettings(settings)) throw new TypeError("Invalid visual settings");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "visual-customization.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: VISUAL_SCHEMA, ...settings })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
