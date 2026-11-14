import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// The bash card identity chosen in Gentle → Customize. `activity` heads the card
// with the activity its command names, the default and the only level that reads
// the activity table; `output` restores the pre-activity card, the plain `bash`
// identity whose box follows the call's tone. The switch changes the heading
// identity only: the command, its detail and the result preview stay as they are.
// A missing file means activity, the default; a malformed or unreadable one also
// reads as activity, and the writer refuses to replace it so a hand edit is never
// lost. There is no environment override.
export const CARD_BASH_SCHEMA = "gentle-pi.card-bash/v1";
const CARD_BASH_FILE = "card-bash.json";

export const CARD_BASH = {
	ACTIVITY: "activity",
	OUTPUT: "output",
} as const;

export type CardBash = (typeof CARD_BASH)[keyof typeof CARD_BASH];
/** What a missing or unreadable preference means: the activity heading. */
export const DEFAULT_CARD_BASH: CardBash = CARD_BASH.ACTIVITY;

interface CardBashOptions { gentlePiConfigHome?: string }

export interface CardBashResolution {
	bash: CardBash;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

function isCardBash(value: unknown): value is CardBash {
	return value === CARD_BASH.ACTIVITY || value === CARD_BASH.OUTPUT;
}

export function parseCardBashFile(raw: string): CardBash | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== CARD_BASH_SCHEMA || !("bash" in value)) return undefined;
		return isCardBash(value.bash) ? value.bash : undefined;
	} catch { return undefined; }
}

export function resolveCardBash(options: CardBashOptions = {}): CardBashResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), CARD_BASH_FILE);
	try {
		const bash = parseCardBashFile(readFileSync(globalFile, "utf8"));
		return { bash: bash ?? DEFAULT_CARD_BASH, source: "global_file", malformed: bash === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { bash: DEFAULT_CARD_BASH, source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

export function writeCardBash(bash: CardBash, options: CardBashOptions = {}): string {
	if (!isCardBash(bash)) throw new TypeError("Invalid card bash");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const current = resolveCardBash({ gentlePiConfigHome: home });
	if (current.malformed) throw new Error(`Cannot update malformed or unreadable card bash preference: ${current.globalFile}`);
	const path = current.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: CARD_BASH_SCHEMA, bash })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}

// Pi loads every extension with its own module cache, so the renderers in
// quiet-tools and the customize command in gentle-shell never share a module
// instance. The process-wide slot keeps one live bash mode per process, exactly
// like the card style and content slots; an unset slot (no Gentle Shell
// resolution yet, e.g. a host without it) reads as the activity heading.
const CARD_BASH_SLOT = Symbol.for("gentle-pi.card-bash");
const bashState = globalThis as typeof globalThis & { [CARD_BASH_SLOT]?: unknown };

export function cardBash(): CardBash {
	return bashState[CARD_BASH_SLOT] === CARD_BASH.OUTPUT ? CARD_BASH.OUTPUT : CARD_BASH.ACTIVITY;
}

export function setCardBash(bash: CardBash): void {
	bashState[CARD_BASH_SLOT] = bash;
}
