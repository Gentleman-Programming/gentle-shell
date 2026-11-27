import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

/**
 * How the console column is folded.
 *
 * Two independent folds, because the user wants both: the whole column can
 * disappear to give the conversation the full width (`collapsed`), and each
 * panel inside it can fold to its title row (`folded`).
 *
 * The state lives in the config home, next to the other shell preferences, and
 * a malformed file falls back to the defaults instead of breaking the console.
 */
export const CONSOLE_PANEL_SCHEMA = "gentle-pi.console-panel/v1";
const FILE = "console-panel.json";

export interface ConsolePanelState {
	readonly schema: typeof CONSOLE_PANEL_SCHEMA;
	/** true when the whole column is folded away. */
	readonly collapsed: boolean;
	/** The panels the user folded, by rail key. */
	readonly folded: readonly string[];
}

export function defaultConsolePanelState(): ConsolePanelState {
	return { schema: CONSOLE_PANEL_SCHEMA, collapsed: false, folded: [] };
}

/** A tolerant read: an old or malformed file yields the defaults, never a throw. */
export function resolveConsolePanelState(raw: unknown): ConsolePanelState {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaultConsolePanelState();
	const record = raw as { schema?: unknown; collapsed?: unknown; folded?: unknown };
	if (record.schema !== CONSOLE_PANEL_SCHEMA) return defaultConsolePanelState();
	const folded = Array.isArray(record.folded)
		? [...new Set(record.folded.filter((key): key is string => typeof key === "string"))]
		: [];
	return {
		schema: CONSOLE_PANEL_SCHEMA,
		collapsed: record.collapsed === true,
		folded,
	};
}

/** The state file path: `<config home>/console-panel.json`. */
export function consolePanelPath(configHome: string = gentlePiConfigHome(process.env)): string {
	return join(configHome, FILE);
}

/** Reads the persisted state; a missing or malformed file yields the defaults. */
export function readConsolePanelState(path: string = consolePanelPath()): ConsolePanelState {
	try {
		return resolveConsolePanelState(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return defaultConsolePanelState();
	}
}

/** Writes the state atomically (`.tmp` + rename) with owner-only permissions. */
export function writeConsolePanelState(
	state: ConsolePanelState,
	path: string = consolePanelPath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, path);
}

/** A copy of the state with the column folded or unfolded. */
export function withConsoleCollapsed(state: ConsolePanelState, collapsed: boolean): ConsolePanelState {
	return { ...state, collapsed };
}

/** A copy of the state with one panel folded or unfolded. */
export function withPanelFolded(
	state: ConsolePanelState,
	key: string,
	folded: boolean,
): ConsolePanelState {
	const next = new Set(state.folded);
	if (folded) next.add(key);
	else next.delete(key);
	return { ...state, folded: [...next] };
}
