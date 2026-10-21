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
	rdd: boolean;
	agents: boolean;
	todo: boolean;
	usageCost: boolean;
	modelDetails: boolean;
	/** High-context warning notice; independent from audio notifications. */
	contextWarning: boolean;
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
	visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true },
};
/** Sections row order; `rdd` follows `changes` as the RDD group follows Changes in the Status card. */
export const VISUAL_SECTION_KEYS = ["changes", "rdd", "agents", "todo", "usageCost", "modelDetails", "contextWarning"] as const satisfies readonly (keyof VisualVisibility)[];
/** Keys added after v1 shipped: stored settings may omit them together or one at a time, and they default to shown. */
const ADDED_SECTION_KEYS: readonly (keyof VisualVisibility)[] = ["rdd", "contextWarning"];
const BASE_SECTION_KEYS = VISUAL_SECTION_KEYS.filter((key) => !ADDED_SECTION_KEYS.includes(key));
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
		&& keysMatch(visibility, VISUAL_SECTION_KEYS)
		&& Object.values(visibility).every((item) => typeof item === "boolean");
}
/**
 * Reader-side validation: accepts the current shape plus every historical one.
 * Every key must be known, every base key present, and every present value a
 * boolean; missing added keys (`rdd`, `contextWarning`) then default to shown,
 * while present values (including `rdd: false`) are preserved. Writers stay strict.
 */
export function normalizeVisualSettings(value: unknown): VisualSettings | undefined {
	if (!record(value) || !record(value.visibility)) return undefined;
	const visibility = value.visibility;
	if (!Object.keys(visibility).every((key) => (VISUAL_SECTION_KEYS as readonly string[]).includes(key))) return undefined;
	if (!BASE_SECTION_KEYS.every((key) => Object.hasOwn(visibility, key))) return undefined;
	// A key that is present is authoritative: only a missing added key may default to shown.
	if (!Object.keys(visibility).every((key) => typeof visibility[key] === "boolean")) return undefined;
	const candidate = keysMatch(visibility, VISUAL_SECTION_KEYS)
		? value
		: { ...value, visibility: Object.fromEntries(VISUAL_SECTION_KEYS.map((key) => [key, visibility[key] ?? true])) };
	return isVisualSettings(candidate) ? candidate : undefined;
}
export function parseVisualSettingsFile(raw: string): VisualSettings | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!record(parsed) || parsed.schema !== VISUAL_SCHEMA) return undefined;
		const { schema: _schema, ...settings } = parsed;
		return normalizeVisualSettings(settings);
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
