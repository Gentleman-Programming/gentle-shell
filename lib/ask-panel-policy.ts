import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// How the questionnaire panel presents itself while minimized, chosen in
// Gentle → Customize. A missing file means the minimal one-line bar; a
// malformed or unreadable one also reads as the defaults, and the writer
// refuses to replace it so a hand edit is never lost. There is no environment
// override.
export const ASK_PANEL_SCHEMA = "gentle-pi.ask-panel/v1";
const ASK_PANEL_FILE = "ask-panel.json";

/** Minimized-panel contents shown instead of the question body. */
export const ASK_PANEL_INDICATOR = { MINIMAL: "minimal", TABBED: "tabbed", ANSWERS: "answers" } as const;

/** Panel state before the user interacts with it. */
export const ASK_PANEL_DEFAULT_STATE = { EXPANDED: "expanded", AUTO: "auto", COLLAPSED: "collapsed" } as const;

export type AskPanelIndicator = (typeof ASK_PANEL_INDICATOR)[keyof typeof ASK_PANEL_INDICATOR];
export type AskPanelDefaultState = (typeof ASK_PANEL_DEFAULT_STATE)[keyof typeof ASK_PANEL_DEFAULT_STATE];

/** Defaults shared by the missing-file and malformed-file paths. */
export const ASK_PANEL_DEFAULTS = { indicator: ASK_PANEL_INDICATOR.MINIMAL, defaultState: ASK_PANEL_DEFAULT_STATE.EXPANDED } as const;

export interface AskPanelPreferences {
	indicator: AskPanelIndicator;
	defaultState: AskPanelDefaultState;
}

interface AskPanelOptions { gentlePiConfigHome?: string }

export interface AskPanelResolution {
	preferences: AskPanelPreferences;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

function isAskPanelIndicator(value: unknown): value is AskPanelIndicator {
	return value === ASK_PANEL_INDICATOR.MINIMAL || value === ASK_PANEL_INDICATOR.TABBED || value === ASK_PANEL_INDICATOR.ANSWERS;
}

function isAskPanelDefaultState(value: unknown): value is AskPanelDefaultState {
	return value === ASK_PANEL_DEFAULT_STATE.EXPANDED || value === ASK_PANEL_DEFAULT_STATE.AUTO || value === ASK_PANEL_DEFAULT_STATE.COLLAPSED;
}

function isAskPanelPreferences(value: unknown): value is AskPanelPreferences {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& isAskPanelIndicator((value as AskPanelPreferences).indicator)
		&& isAskPanelDefaultState((value as AskPanelPreferences).defaultState);
}

/**
 * Parses one preference file. The key set is exact (`schema`, `indicator`,
 * `defaultState`); anything else -- a missing or wrong schema, an unknown key,
 * a value outside its allowed set, non-object JSON -- reads as undefined so the
 * caller can treat it as malformed.
 */
export function parseAskPanelFile(raw: string): AskPanelPreferences | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 3 || !("schema" in value) || value.schema !== ASK_PANEL_SCHEMA || !("indicator" in value) || !("defaultState" in value)) return undefined;
		if (!isAskPanelIndicator(value.indicator) || !isAskPanelDefaultState(value.defaultState)) return undefined;
		return { indicator: value.indicator, defaultState: value.defaultState };
	} catch { return undefined; }
}

/** Resolves the ask-panel preferences, falling back to the defaults on a missing or malformed file. */
export function resolveAskPanelPreferences(options: AskPanelOptions = {}): AskPanelResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), ASK_PANEL_FILE);
	try {
		const preferences = parseAskPanelFile(readFileSync(globalFile, "utf8"));
		return { preferences: preferences ?? ASK_PANEL_DEFAULTS, source: "global_file", malformed: preferences === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { preferences: ASK_PANEL_DEFAULTS, source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

/** Atomically replaces the preference file; refuses a malformed one and returns the written path. */
export function writeAskPanelPreferences(preferences: AskPanelPreferences, options: AskPanelOptions = {}): string {
	if (!isAskPanelPreferences(preferences)) throw new TypeError("Invalid ask panel preferences");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const current = resolveAskPanelPreferences({ gentlePiConfigHome: home });
	if (current.malformed) throw new Error(`Cannot update malformed or unreadable ask panel preference: ${current.globalFile}`);
	const path = current.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: ASK_PANEL_SCHEMA, indicator: preferences.indicator, defaultState: preferences.defaultState })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
