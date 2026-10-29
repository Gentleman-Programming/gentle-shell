import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// The conversation card content level chosen in Gentle → Customize. `default`
// keeps the quiet tools' result previews; `minimal` draws every quiet tool
// card as the command alone. A missing file means default, so nobody loses the
// previews without choosing to; a malformed or unreadable one also reads as
// default, and the writer refuses
// to replace it so a hand edit is never lost. There is no environment override.
export const CARD_CONTENT_SCHEMA = "gentle-pi.card-content/v1";
const CARD_CONTENT_FILE = "card-content.json";

export const CARD_CONTENT = {
	DEFAULT: "default",
	MINIMAL: "minimal",
} as const;

export type CardContent = (typeof CARD_CONTENT)[keyof typeof CARD_CONTENT];

interface CardContentOptions { gentlePiConfigHome?: string }

export interface CardContentResolution {
	content: CardContent;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

function isCardContent(value: unknown): value is CardContent {
	return value === CARD_CONTENT.DEFAULT || value === CARD_CONTENT.MINIMAL;
}

export function parseCardContentFile(raw: string): CardContent | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== CARD_CONTENT_SCHEMA || !("content" in value)) return undefined;
		return isCardContent(value.content) ? value.content : undefined;
	} catch { return undefined; }
}

export function resolveCardContent(options: CardContentOptions = {}): CardContentResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), CARD_CONTENT_FILE);
	try {
		const content = parseCardContentFile(readFileSync(globalFile, "utf8"));
		return { content: content ?? CARD_CONTENT.DEFAULT, source: "global_file", malformed: content === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { content: CARD_CONTENT.DEFAULT, source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

export function writeCardContent(content: CardContent, options: CardContentOptions = {}): string {
	if (!isCardContent(content)) throw new TypeError("Invalid card content");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const current = resolveCardContent({ gentlePiConfigHome: home });
	if (current.malformed) throw new Error(`Cannot update malformed or unreadable card content preference: ${current.globalFile}`);
	const path = current.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: CARD_CONTENT_SCHEMA, content })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}

// Pi loads every extension with its own module cache, so the renderers in
// quiet-tools and the customize command in gentle-shell never share a module
// instance. The process-wide slot keeps one live content level per process,
// exactly like the card style slot; an unset slot reads as default.
const CARD_CONTENT_SLOT = Symbol.for("gentle-pi.card-content");
const contentState = globalThis as typeof globalThis & { [CARD_CONTENT_SLOT]?: unknown };

export function cardContent(): CardContent {
	return contentState[CARD_CONTENT_SLOT] === CARD_CONTENT.MINIMAL ? CARD_CONTENT.MINIMAL : CARD_CONTENT.DEFAULT;
}

export function setCardContent(content: CardContent): void {
	contentState[CARD_CONTENT_SLOT] = content;
}
