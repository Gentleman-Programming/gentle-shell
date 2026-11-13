import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// How /gentle:agents draws its selected thread, chosen in Gentle → Customize
// under Cards. `log` is the pane's original labelled log and stays the default;
// `cards` draws each retained tool call with the renderer the chat itself was
// handed. A missing file means the log, and a malformed or unreadable one also
// reads as log; the writer refuses to replace it so a hand edit is never lost.
// There is no environment override.
//
// The names used to be `registry` and `chat`. Those are still read, mapped to
// the view they selected, so a preference saved before the rename keeps drawing
// what its reader chose instead of turning into a malformed file the writer then
// refuses to replace; writing always stores the current name.
export const AGENTS_VIEW_STYLE = {
	LOG: "log",
	CARDS: "cards",
} as const;
export type AgentsViewStyle = (typeof AGENTS_VIEW_STYLE)[keyof typeof AGENTS_VIEW_STYLE];
const LEGACY_AGENTS_VIEW_STYLE: Readonly<Record<string, AgentsViewStyle>> = { registry: AGENTS_VIEW_STYLE.LOG, chat: AGENTS_VIEW_STYLE.CARDS };
export const AGENTS_VIEW_STYLE_SCHEMA = "gentle-pi.agents-view-style/v1";
const AGENTS_VIEW_STYLE_FILE = "agents-view-style.json";
interface AgentsViewStyleOptions { gentlePiConfigHome?: string }
export interface AgentsViewStyleResolution {
	style: AgentsViewStyle;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

function isAgentsViewStyle(value: unknown): value is AgentsViewStyle {
	return value === AGENTS_VIEW_STYLE.LOG || value === AGENTS_VIEW_STYLE.CARDS;
}

/** The view a saved value selects, including a name written before the rename. */
function savedAgentsViewStyle(value: unknown): AgentsViewStyle | undefined {
	if (typeof value !== "string") return undefined;
	if (isAgentsViewStyle(value)) return value;
	return Object.hasOwn(LEGACY_AGENTS_VIEW_STYLE, value) ? LEGACY_AGENTS_VIEW_STYLE[value] : undefined;
}

export function parseAgentsViewStyleFile(raw: string): AgentsViewStyle | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== AGENTS_VIEW_STYLE_SCHEMA || !("style" in value)) return undefined;
		return savedAgentsViewStyle(value.style);
	} catch { return undefined; }
}

export function resolveAgentsViewStyle(options: AgentsViewStyleOptions = {}): AgentsViewStyleResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), AGENTS_VIEW_STYLE_FILE);
	try {
		const style = parseAgentsViewStyleFile(readFileSync(globalFile, "utf8"));
		return { style: style ?? AGENTS_VIEW_STYLE.LOG, source: "global_file", malformed: style === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { style: AGENTS_VIEW_STYLE.LOG, source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

export function writeAgentsViewStyle(style: AgentsViewStyle, options: AgentsViewStyleOptions = {}): string {
	if (!isAgentsViewStyle(style)) throw new TypeError("Invalid agents view style");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const current = resolveAgentsViewStyle({ gentlePiConfigHome: home });
	if (current.malformed) throw new Error(`Cannot update malformed or unreadable agents view style preference: ${current.globalFile}`);
	const path = current.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		// `wx` never reuses an existing temporary file, and the rename replaces the
		// preference atomically, so a reader never observes a half-written file.
		writeFileSync(temporary, `${JSON.stringify({ schema: AGENTS_VIEW_STYLE_SCHEMA, style })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
