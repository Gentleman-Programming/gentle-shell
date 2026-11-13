import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { readDesignFile } from "./design-comments.ts";

// The design tokens of design/system.md (written by /gentle:design sync), read-only. The canvas
// inspector compares what an artboard renders with them. A token is a table row whose first cell is a
// backticked CSS custom property (`--name`) and whose second cell is its backticked value, filed under
// the `##` section it appears in. The file is the project's own markdown, so nothing here may fail the
// canvas: a missing, huge or malformed file just yields fewer tokens.

export const SYSTEM_TOKENS_FILE = "system.md";
export const MAX_SYSTEM_MD_BYTES = 256 * 1024;
export const MAX_SYSTEM_TOKENS = 500;
const MAX_NAME = 64;
const MAX_VALUE = 400;
const MAX_SECTION = 80;
// A token row is short; a longer line is skipped before any pattern runs on it.
export const MAX_SYSTEM_LINE = 1000;

export type DesignTokenGroup = "color" | "font" | "spacing" | "radius" | "shadow" | "layout" | "other";
export type DesignToken = { name: string; value: string; section: string; group: DesignTokenGroup };
export type DesignSystemTokens = { exists: boolean; tokens: DesignToken[]; problem?: "too-large" | "unreadable" };

const NAME = /^--[A-Za-z0-9_-]+$/;
const TICKED = /`([^`]+)`/g;
// Tokens written inline in a first cell, as "`--radius-sm` 8px, `--radius-md` 12px" or "`--font-sans`: `Inter, ...`".
// No two adjacent runs can match the same text (the second whitespace run follows the colon, and a
// number is digits with an optional fraction or a bare fraction), so a failing match stays linear.
const INLINE = /`(--[A-Za-z0-9_-]+)`[ \t]*(?::[ \t]*)?(?:`([^`]+)`|(-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|ms|s)?|#[0-9a-fA-F]{3,8}))[ \t]*(?=[,;]|$|`--)/g;

function groupOf(section: string): DesignTokenGroup {
	if (/color/i.test(section)) return "color";
	if (/typograph|font/i.test(section)) return "font";
	if (/spacing/i.test(section)) return "spacing";
	if (/radius/i.test(section)) return "radius";
	if (/shadow|motion/i.test(section)) return "shadow";
	if (/layout/i.test(section)) return "layout";
	return "other";
}

/** The cells of a markdown table row, with escaped pipes restored; undefined when the line is not a row. */
function cellsOf(line: string): string[] | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return undefined;
	return trimmed.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function ticked(cell: string): { items: string[]; rest: string } {
	const items = [...cell.matchAll(TICKED)].map((match) => match[1].trim());
	return { items, rest: cell.replace(TICKED, "") };
}

/** [name, value] pairs of one row: name and value cells (lists pair up by position), else tokens inline in the first cell. */
function pairsOf(cells: string[]): Array<[string, string]> {
	const names = ticked(cells[0] ?? "");
	if (!names.items.some((item) => NAME.test(item))) return [];
	if (names.items.every((item) => NAME.test(item)) && /^[\s/,&]*$/.test(names.rest)) {
		const values = ticked(cells[1] ?? "").items;
		return values.length === names.items.length ? names.items.map((name, index): [string, string] => [name, values[index]]) : [];
	}
	return [...(cells[0] ?? "").matchAll(INLINE)].map((match): [string, string] => [match[1], (match[2] ?? match[3]).trim()]);
}

/** The tokens of a design/system.md text; a name defined twice keeps its first definition. */
export function parseSystemTokens(text: string): DesignToken[] {
	const tokens: DesignToken[] = [];
	const seen = new Set<string>();
	let section = "";
	for (const line of text.split(/\r\n?|\n/)) {
		const heading = /^##\s+(.*)$/.exec(line);
		if (heading) {
			section = heading[1].trim().slice(0, MAX_SECTION);
			continue;
		}
		if (line.length > MAX_SYSTEM_LINE) continue;
		const cells = cellsOf(line);
		if (!cells) continue;
		for (const [name, value] of pairsOf(cells)) {
			if (name.length > MAX_NAME || value.length === 0 || value.length > MAX_VALUE || seen.has(name)) continue;
			if (tokens.length >= MAX_SYSTEM_TOKENS) return tokens;
			seen.add(name);
			tokens.push({ name, value, section, group: groupOf(section) });
		}
	}
	return tokens;
}

/** Real path of `<designRoot>/system.md` when it is a regular file inside the real design root, else undefined. */
async function locate(designRoot: string): Promise<string | undefined> {
	try {
		const root = await realpath(designRoot);
		const target = await realpath(join(root, SYSTEM_TOKENS_FILE));
		if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
		return (await stat(target)).isFile() ? target : undefined;
	} catch {
		return undefined;
	}
}

/** The tokens of `<designRoot>/system.md`; never throws: no file is `exists: false`, a bad one has `problem`. */
export async function readSystemTokens(designRoot: string): Promise<DesignSystemTokens> {
	const path = await locate(designRoot);
	if (!path) return { exists: false, tokens: [] };
	const tooLarge = new Error("too-large");
	try {
		const text = await readDesignFile(path, MAX_SYSTEM_MD_BYTES, () => tooLarge);
		return text === undefined ? { exists: false, tokens: [] } : { exists: true, tokens: parseSystemTokens(text) };
	} catch (error) {
		return { exists: true, tokens: [], problem: error === tooLarge ? "too-large" : "unreadable" };
	}
}
