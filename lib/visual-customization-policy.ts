import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const VISUAL_SCHEMA = "gentle-pi.visual-customization/v1";
export const STATUS_PLACEMENT = { AUTO: "auto", RIGHT: "right", BOTTOM: "bottom", HIDDEN: "hidden" } as const;
/**
 * Where the header row goes: `top` above the conversation, inside its column;
 * `below-input` under the editor; `split` the IDE chrome, a full-width title
 * row on top and the per-frame counters in a status bar at the bottom.
 */
export const HEADER_PLACEMENT = { TOP: "top", BELOW_INPUT: "below-input", SPLIT: "split" } as const;
export const DENSITY = { COMFORTABLE: "comfortable", COMPACT: "compact", MINIMAL: "minimal" } as const;
/** The chrome background: `tinted` paints the rail, title row, status bar and panel sheet; `transparent` lets the terminal show through. */
export const CHROME_SURFACE = { TINTED: "tinted", TRANSPARENT: "transparent" } as const;
export type StatusPlacement = (typeof STATUS_PLACEMENT)[keyof typeof STATUS_PLACEMENT];
export type HeaderPlacement = (typeof HEADER_PLACEMENT)[keyof typeof HEADER_PLACEMENT];
export type Density = (typeof DENSITY)[keyof typeof DENSITY];
export type ChromeSurface = (typeof CHROME_SURFACE)[keyof typeof CHROME_SURFACE];

export interface VisualVisibility {
	changes: boolean;
	rdd: boolean;
	agents: boolean;
	todo: boolean;
	usageCost: boolean;
	modelDetails: boolean;
	/** High-context warning notice; independent from audio notifications. */
	contextWarning: boolean;
	/** Session statistics in the Status rail (spend, tokens, cache, tools, per model); the Power user preset turns it on. */
	stats: boolean;
}
export interface VisualSettings {
	statusPlacement: StatusPlacement;
	headerPlacement: HeaderPlacement;
	density: Density;
	/** Stored only when tinted, so files that keep the transparent default stay readable by older versions. */
	surface: ChromeSurface;
	visibility: VisualVisibility;
}
export const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
	statusPlacement: STATUS_PLACEMENT.AUTO,
	headerPlacement: HEADER_PLACEMENT.TOP,
	density: DENSITY.COMFORTABLE,
	surface: CHROME_SURFACE.TRANSPARENT,
	visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false },
};
/**
 * Presets bundle the visibility switches (design/shell-rework/inventory.md):
 * Light is the minimal edition: Status at the bottom (no rail) and priority 1
 * only (model, context, agent questions, review); Neutral is the default;
 * Power user adds session Stats. Density is its own axis, like the header
 * placement and the surface: a preset neither sets nor compares it. The active
 * preset is whichever bundle the current settings match.
 */
export const VISUAL_PRESET = { LIGHT: "light", NEUTRAL: "neutral", POWER_USER: "power-user" } as const;
export type VisualPreset = (typeof VISUAL_PRESET)[keyof typeof VISUAL_PRESET];
const PRESET_BUNDLES: Record<VisualPreset, Pick<VisualSettings, "visibility">> = {
	[VISUAL_PRESET.LIGHT]: { visibility: { changes: false, rdd: true, agents: true, todo: false, usageCost: true, modelDetails: true, contextWarning: true, stats: false } },
	[VISUAL_PRESET.NEUTRAL]: { visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility } },
	// What Power user adds is content (Stats).
	[VISUAL_PRESET.POWER_USER]: { visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: true } },
};
export function applyVisualPreset(settings: VisualSettings, preset: VisualPreset): VisualSettings {
	const bundle = PRESET_BUNDLES[preset];
	// Light is the minimal edition without the rail (Status at the bottom);
	// leaving it brings the rail back, and the other presets keep any placement.
	const leavingLight = visualPresetOf(settings) === VISUAL_PRESET.LIGHT;
	const statusPlacement = preset === VISUAL_PRESET.LIGHT ? STATUS_PLACEMENT.BOTTOM
		: leavingLight ? STATUS_PLACEMENT.AUTO : settings.statusPlacement;
	return { ...settings, statusPlacement, visibility: { ...bundle.visibility } };
}
/** The preset the settings match, or undefined for a hand-tuned mix. */
export function visualPresetOf(settings: VisualSettings): VisualPreset | undefined {
	return (Object.values(VISUAL_PRESET) as VisualPreset[]).find((preset) => {
		const bundle = PRESET_BUNDLES[preset];
		if ((settings.statusPlacement === STATUS_PLACEMENT.BOTTOM) !== (preset === VISUAL_PRESET.LIGHT)) return false;
		return (Object.keys(bundle.visibility) as (keyof VisualVisibility)[]).every((key) => bundle.visibility[key] === settings.visibility[key]);
	});
}
/** Sections row order; `rdd` follows `changes` as the RDD group follows Changes in the Status card. */
export const VISUAL_SECTION_KEYS = ["changes", "rdd", "agents", "todo", "usageCost", "modelDetails", "contextWarning", "stats"] as const satisfies readonly (keyof VisualVisibility)[];
/** Keys added after v1 shipped, with the value a stored file that omits them loads as. */
const ADDED_SECTION_DEFAULTS: Partial<Record<keyof VisualVisibility, boolean>> = { rdd: true, contextWarning: true, stats: false };
const ADDED_SECTION_KEYS = Object.keys(ADDED_SECTION_DEFAULTS) as (keyof VisualVisibility)[];
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
	if (!record(value) || !keysMatch(value, ["statusPlacement", "headerPlacement", "density", "surface", "visibility"])) return false;
	const visibility = value.visibility;
	return member(value.statusPlacement, STATUS_PLACEMENT)
		&& member(value.headerPlacement, HEADER_PLACEMENT)
		&& member(value.density, DENSITY)
		&& member(value.surface, CHROME_SURFACE)
		&& record(visibility)
		&& keysMatch(visibility, VISUAL_SECTION_KEYS)
		&& Object.values(visibility).every((item) => typeof item === "boolean");
}
/**
 * Reader-side validation: accepts the current shape plus every historical one.
 * Every key must be known, every base key present, and every present value a
 * boolean; missing added keys then take their default (`rdd`, `contextWarning` shown, `stats` hidden),
 * while present values (including `rdd: false`) are preserved. Writers stay strict.
 */
export function normalizeVisualSettings(raw: unknown): VisualSettings | undefined {
	if (!record(raw) || !record(raw.visibility)) return undefined;
	// A file without `surface` (older versions, or the transparent default) reads as the default.
	const value = Object.hasOwn(raw, "surface") ? raw : { ...raw, surface: DEFAULT_VISUAL_SETTINGS.surface };
	const visibility = raw.visibility;
	if (!Object.keys(visibility).every((key) => (VISUAL_SECTION_KEYS as readonly string[]).includes(key))) return undefined;
	if (!BASE_SECTION_KEYS.every((key) => Object.hasOwn(visibility, key))) return undefined;
	// A key that is present is authoritative: only a missing added key may default to shown.
	if (!Object.keys(visibility).every((key) => typeof visibility[key] === "boolean")) return undefined;
	const candidate = keysMatch(visibility, VISUAL_SECTION_KEYS)
		? value
		: { ...value, visibility: Object.fromEntries(VISUAL_SECTION_KEYS.map((key) => [key, visibility[key] ?? ADDED_SECTION_DEFAULTS[key] ?? true])) };
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
/** The stored shape: the default surface stays out of the file, so older versions keep reading it. */
export function storedVisualSettings(settings: VisualSettings): Omit<VisualSettings, "surface"> & { surface?: ChromeSurface } {
	const { surface, ...stored } = settings;
	return surface === DEFAULT_VISUAL_SETTINGS.surface ? stored : { ...stored, surface };
}
/** Same-directory rename keeps partial JSON invisible to readers. */
export function writeVisualSettings(settings: VisualSettings, options: VisualOptions = {}): string {
	if (!isVisualSettings(settings)) throw new TypeError("Invalid visual settings");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "visual-customization.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: VISUAL_SCHEMA, ...storedVisualSettings(settings) })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
