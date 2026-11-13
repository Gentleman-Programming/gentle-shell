// Compact, truthful previews for the CodeGraph card — the native `codegraph` tool
// (drawn by extensions/quiet-tools.ts) and the same program run through the shell.
// The collapsed card summarizes the facts CodeGraph printed; an outcome the tool did
// not print is not one the card may claim. Pure: no Pi, filesystem or process access.

import { SHELL_ACTIVITY_IDENTITY, codeGraphCommandWords, inferShellActivity, shellCommandSegments } from "./odd-phase-inference.ts";

/** The tool both surfaces draw, and the mark and theme role its card wears. */
export const CODEGRAPH_TOOL = "codegraph";
export const CODEGRAPH_MARK = SHELL_ACTIVITY_IDENTITY.codegraph.glyph;
export const CODEGRAPH_TITLE_ROLE = SHELL_ACTIVITY_IDENTITY.codegraph.titleRole;

const PREVIEW_ROWS = 3;
// The init CLI paints a progress box; its separator rows carry no facts.
const CHROME = /^[\s│┌└─]*$/;
// A status row's mark is decoration; the row's own words are the fact.
const STATUS_MARK = /^[◆◇●▲✗✓ℹ]\s+/;
// The init log trails into telemetry and upgrade notices after its summary, so the
// collapsed rows name the index it built rather than the last lines it wrote.
const INIT_FACT = /\b(Indexed \d+ files?|\d+ nodes?, \d+ edges?|Initialized in)\b/;
// This build's init ends with one sentence about the workspace index: it built a new
// one, or found the one already there. Only those sentences state that fact.
const INIT_OUTCOMES: ReadonlyArray<readonly [RegExp, string]> = [
	[/^Initialized in .+$/, "initialized"],
	[/^Already initialized in .+$/, "already initialized"],
];

/** The CodeGraph call a card heads: the operation it ran, and the query it named. */
export interface CodeGraphCall {
	operation: string;
	query?: string;
}

function outputLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
	return normalized.length > 0 ? normalized.split("\n") : [];
}

/**
 * The CodeGraph call a shell command runs, gated by the classifier's own verdict so
 * the preview never disagrees with the card identity that admitted the call.
 */
export function codegraphCallFromCommand(command: string): CodeGraphCall | undefined {
	if (inferShellActivity(command) !== CODEGRAPH_TOOL) return undefined;
	const segments = shellCommandSegments(command);
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const words = codeGraphCommandWords(segments[index] ?? "");
		if (words === undefined) continue;
		const operation = words.find((word) => !word.startsWith("-"));
		if (operation === undefined) continue;
		const query = queryPayload(operation, words);
		return { operation, ...(query === undefined ? {} : { query }) };
	}
	return undefined;
}

/** The payload after the command's own `--`; a bare word is read only when alone, since an option may take the next one. */
function queryPayload(operation: string, words: readonly string[]): string | undefined {
	if (operation !== "query" && operation !== "explore") return undefined;
	const separator = words.indexOf("--");
	const payload = separator >= 0 ? words.slice(separator + 1) : words.slice(words.indexOf(operation) + 1);
	if (separator < 0 && payload.length !== 1) return undefined;
	const query = payload.join(" ").replace(/\s+/g, " ").trim();
	return query.length > 0 ? query : undefined;
}

/** The heading detail both surfaces use: the operation, and the query when the call named one. */
export function codegraphCallDetail(call: CodeGraphCall): string {
	return call.query === undefined ? call.operation : `${call.operation} ${call.query}`;
}

/** What an init stated it did to the index, or undefined when it printed no such sentence. */
export function codeGraphInitOutcome(text: string): string | undefined {
	for (const line of outputLines(text)) {
		const row = line.trim().replace(STATUS_MARK, "");
		for (const [pattern, action] of INIT_OUTCOMES) if (pattern.test(row)) return action;
	}
	return undefined;
}

/** The count CodeGraph's own output states, or undefined for a shape the card cannot read. */
export function codeGraphResultSummary(operation: string, text: string): string | undefined {
	if (operation === "query") {
		if (/^.*No results found for /m.test(text)) return "0 results";
		if (!/^Search Results for .*:$/m.test(text)) return undefined;
		// One entry per blank-line-separated block: a symbol line at column zero
		// followed by its indented path:line location.
		const entries = text.split(/\n\s*\n/).filter((block) => {
			const [head = "", ...rest] = outputLines(block);
			return /^\S+\s{2,}\S/.test(head) && rest.some((line) => /^ {2}.+:\d+(?::\d+)?\s*$/.test(line));
		});
		return entries.length === 0 ? undefined : `${entries.length} ${entries.length === 1 ? "result" : "results"}`;
	}
	if (operation !== "explore") return undefined;
	const found = /^Found (\d+) symbols? across (\d+) files?\.$/m.exec(text);
	if (!found) return undefined;
	const symbols = Number(found[1]);
	const files = Number(found[2]);
	return `${symbols} ${symbols === 1 ? "symbol" : "symbols"} in ${files} ${files === 1 ? "file" : "files"}`;
}

/** The output without the progress box's empty rows, keeping the rows it ends with. */
export function codeGraphPreview(text: string, limit = PREVIEW_ROWS): string {
	return outputLines(text).filter((line) => !CHROME.test(line)).slice(-limit).join("\n");
}

/** The rows a collapsed card draws: the stated count, the init sentence, its facts, or its rows. */
export function codeGraphCollapsedRows(
	operation: string,
	text: string,
	failed: boolean,
	withheld: boolean,
	limit = PREVIEW_ROWS,
): { text: string; rows: number; tail: boolean } | undefined {
	if (withheld && !failed) return undefined;
	if (failed) {
		const reason = outputLines(text).filter((line) => line.trim().length > 0).slice(-limit).join("\n");
		return reason ? { text: reason, rows: limit, tail: true } : undefined;
	}
	const summary = codeGraphResultSummary(operation, text);
	if (summary) return { text: `→ ${summary}`, rows: 1, tail: false };
	const outcome = operation === "init" ? codeGraphInitOutcome(text) : undefined;
	if (outcome) return { text: `→ ${outcome}`, rows: 1, tail: false };
	const lines = outputLines(text).filter((line) => !CHROME.test(line));
	const facts = operation === "init" ? lines.filter((line) => INIT_FACT.test(line)).slice(-limit) : [];
	const preview = (facts.length > 0 ? facts : lines.slice(-limit)).join("\n");
	return preview ? { text: preview, rows: limit, tail: true } : undefined;
}
