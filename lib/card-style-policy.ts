import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import { CARD_STYLE, type CardStyle } from "./shell-card.ts";

// The conversation card style chosen in Gentle → Customize. A missing file
// means the borderless float style; a malformed or unreadable one also reads
// as float, and the writer refuses to replace it so a hand edit is never lost.
// There is no environment override.
export const CARD_STYLE_SCHEMA = "gentle-pi.card-style/v1";
const CARD_STYLE_FILE = "card-style.json";
interface CardStyleOptions { gentlePiConfigHome?: string }
export interface CardStyleResolution {
	style: CardStyle;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

function isCardStyle(value: unknown): value is CardStyle {
	return value === CARD_STYLE.NEON || value === CARD_STYLE.FLOAT;
}

export function parseCardStyleFile(raw: string): CardStyle | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== CARD_STYLE_SCHEMA || !("style" in value)) return undefined;
		return isCardStyle(value.style) ? value.style : undefined;
	} catch { return undefined; }
}

export function resolveCardStyle(options: CardStyleOptions = {}): CardStyleResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), CARD_STYLE_FILE);
	try {
		const style = parseCardStyleFile(readFileSync(globalFile, "utf8"));
		return { style: style ?? CARD_STYLE.FLOAT, source: "global_file", malformed: style === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { style: CARD_STYLE.FLOAT, source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

export function writeCardStyle(style: CardStyle, options: CardStyleOptions = {}): string {
	if (!isCardStyle(style)) throw new TypeError("Invalid card style");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const current = resolveCardStyle({ gentlePiConfigHome: home });
	if (current.malformed) throw new Error(`Cannot update malformed or unreadable card style preference: ${current.globalFile}`);
	const path = current.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: CARD_STYLE_SCHEMA, style })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
