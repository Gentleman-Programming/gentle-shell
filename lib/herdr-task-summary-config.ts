import { createHash } from "node:crypto";

export interface HerdrTaskSummaryConfigOptions {
	enabled: boolean;
	summaryColor: string;
	continuationColor: string;
}
export type HerdrTaskSummaryConfigPlan = { ok: true; text: string; changed: boolean } | { ok: false; error: string };
const TABLE = "ui.sidebar.agents.rows_by_agent";
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MARKER = "# Gentle Shell task summary";
const UNSUPPORTED = "Unsupported or ambiguous TOML; no changes proposed.";
const OWNERSHIP = "Existing agent layout requires an explicit layout ownership choice.";
const TAMPER = "Owned task summary block was changed or is ambiguous; no changes proposed.";
const fail = (error: string): HerdrTaskSummaryConfigPlan => ({ ok: false, error });

function row(summary: string, continuation: string): string {
	return `pi = [["state_icon", "machine", "workspace", "tab"], ["agent"], [{ token = "$summary", fg = "${summary}" }], [{ token = "$summary2", fg = "${continuation}" }]]`;
}
function block(mode: "created" | "existing", join: number, eol: string, summary: string, continuation: string): string {
	const body = `${MARKER} begin v1 ${mode} join=${join}${eol}${mode === "created" ? `[${TABLE}]${eol}` : ""}${row(summary, continuation)}${eol}`;
	// An integrity stamp detects manual edits, including otherwise-valid colors.
	const stamp = createHash("sha256").update(body).digest("hex");
	return `${body}${MARKER} end v1 sha256=${stamp}${eol}`;
}

/** A recognizer, not a TOML parser: single-line basic strings, decimal scalars and
 * nested arrays only. Everything else fails closed, even outside our table.
 * Text is never serialized; offsets retain comments, ordering and line endings.
 */
function simpleValue(source: string): boolean {
	let i = 0;
	const space = () => { while (source[i] === " " || source[i] === "\t") i++; };
	const value = (depth: number): boolean => {
		space();
		if (depth > 8) return false;
		if (source[i] === '"') {
			const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(source.slice(i));
			if (!match) return false;
			i += match[0].length;
			return true;
		}
		if (source[i] === "[") {
			i++; space();
			if (source[i] === "]") { i++; return true; }
			while (value(depth + 1)) {
				space();
				if (source[i] === "]") { i++; return true; }
				if (source[i++] !== ",") return false;
				space();
				if (source[i] === "]") { i++; return true; }
			}
			return false;
		}
		const scalar = /^(?:true|false|[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?)/.exec(source.slice(i));
		if (!scalar) return false;
		i += scalar[0].length;
		return true;
	};
	if (!value(0)) return false;
	space();
	return i === source.length || source[i] === "#";
}
interface Scan { error?: string; insertion: number; hasTable: boolean }
function scan(text: string): Scan {
	const tables = new Set<string>();
	const keys = new Set<string>();
	let section = "", offset = 0, insertion = text.length;
	let layout = false;
	for (const line of text.split(/(?<=\n)/)) {
		const content = line.replace(/\r?\n$/, "").trim();
		if (content && !content.startsWith("#")) {
			const table = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\s*(?:#.*)?$/.exec(content);
			if (table) {
				if (section === TABLE) insertion = offset;
				section = table[1];
				if (tables.has(section) || [...keys].some(key => section === key || section.startsWith(key + "."))) return { error: UNSUPPORTED, insertion, hasTable: false };
				if (section.startsWith(TABLE + ".")) return { error: UNSUPPORTED, insertion, hasTable: false };
				if (section === "ui.sidebar.agents.rows" || section.startsWith("ui.sidebar.agents.rows.")) layout = true;
				tables.add(section);
			} else {
				const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(content);
				if (!assignment || !simpleValue(assignment[2])) return { error: UNSUPPORTED, insertion, hasTable: false };
				const key = section ? `${section}.${assignment[1]}` : assignment[1];
				if (keys.has(key) || [...tables, ...keys].some(path => path.startsWith(key + ".") || path === key)) return { error: UNSUPPORTED, insertion, hasTable: false };
				keys.add(key);
				if (section === "ui.sidebar.agents" && assignment[1] === "rows_by_agent") return { error: UNSUPPORTED, insertion, hasTable: false };
				if ((section === TABLE && assignment[1] === "pi") || (section === "ui.sidebar.agents" && assignment[1] === "rows")) layout = true;
			}
		}
		offset += line.length;
	}
	// Validate the prospective table too, not just tables already in the input.
	if ([...keys].some(key => key === TABLE || TABLE.startsWith(key + "."))) return { error: UNSUPPORTED, insertion, hasTable: tables.has(TABLE) };
	return { error: layout ? OWNERSHIP : undefined, insertion, hasTable: tables.has(TABLE) };
}

/** Pure proposal for Herdr 0.9.3. Never reads, writes, activates or reloads a client.
 * Ownership is limited to an exact stamped block adopting the default Pi rows.
 * Disable restores absence of our override, rather than deleting user rows.
 */
export function planHerdrTaskSummaryConfig(rawText: string, options: HerdrTaskSummaryConfigOptions): HerdrTaskSummaryConfigPlan {
	if (!HEX.test(options.summaryColor) || !HEX.test(options.continuationColor)) return fail("Colors must be concrete #RGB or #RRGGBB values.");
	const eol = rawText.includes("\r\n") ? "\r\n" : "\n";
	if (rawText.replaceAll("\r\n", "").includes("\r") || (eol === "\r\n" && rawText.replaceAll("\r\n", "").includes("\n"))) return fail(UNSUPPORTED);
	let original = rawText;
	let owned: { start: number; end: number; mode: "created" | "existing"; join: number } | undefined;
	if (rawText.includes(MARKER)) {
		const begin = /^# Gentle Shell task summary begin v1 (created|existing) join=([01])\r?$/gm;
		const matches = [...rawText.matchAll(begin)];
		if (matches.length !== 1) return fail(TAMPER);
		const match = matches[0];
		const start = match.index!;
		const endLine = rawText.indexOf(`${MARKER} end v1 sha256=`, start);
		if (endLine < 0) return fail(TAMPER);
		const end = rawText.indexOf(eol, endLine) + eol.length;
		if (end < endLine) return fail(TAMPER);
		const candidate = rawText.slice(start, end);
		const colors = /fg = "(#[0-9a-fA-F]+)"/g;
		const found = [...candidate.matchAll(colors)].map(item => item[1]);
		const mode = match[1] as "created" | "existing", join = Number(match[2]);
		if (found.length !== 2 || !found.every(color => HEX.test(color)) || candidate !== block(mode, join, eol, found[0], found[1])) return fail(TAMPER);
		if (join && (start < eol.length || rawText.slice(start - eol.length, start) !== eol || start === eol.length || rawText.slice(0, start - eol.length).endsWith("\n"))) return fail(TAMPER);
		owned = { start: start - join * eol.length, end, mode, join };
		original = rawText.slice(0, owned.start) + rawText.slice(end);
		if (original.includes(MARKER)) return fail(TAMPER);
	}
	const scanned = scan(original);
	if (scanned.error) return fail(scanned.error);
	if (owned && (owned.mode !== (scanned.hasTable ? "existing" : "created") || owned.start !== (scanned.hasTable ? scanned.insertion : original.length))) return fail(TAMPER);
	if (!options.enabled) return { ok: true, text: original, changed: original !== rawText };
	const position = scanned.hasTable ? scanned.insertion : original.length;
	const join = position > 0 && original[position - 1] !== "\n" ? 1 : 0;
	const addition = (join ? eol : "") + block(scanned.hasTable ? "existing" : "created", join, eol, options.summaryColor, options.continuationColor);
	const text = original.slice(0, position) + addition + original.slice(position);
	return { ok: true, text, changed: text !== rawText };
}
