// Compact, truthful previews for the versioning card — the local-history
// commands `git add`, `git commit`, `git rebase`, `git cherry-pick` and a
// stack's local half (`gh stack init|add|rebase`). Shared by the chat's bash card
// (extensions/quiet-tools.ts) and the Agents thread pane (lib/agents-thread-view.ts)
// so one call never reads as two cards, and the same output is never previewed
// two ways.
//
// Only shapes git does not translate are read: its `[<ref> <abbreviated sha>]
// <subject>` summary line and the `(+)`/`(-)` diffstat markers. A translated
// sentence is never parsed, so a card cannot mistake a localized success for a
// failure, invent a count from a message it does not understand, or claim a
// success the command never printed. Anything this module cannot read falls back
// to the raw rows the command actually printed, and a failed call always previews
// its own cause: the preview is a smaller view of the output, never a substitute
// for it, and the expanded card keeps every row.
//
// Pure: no Pi, registry, filesystem or git access. The command and the output the
// host already retained are the only inputs.

import { inferShellActivity, shellCommandSegments } from "./odd-phase-inference.ts";

/**
 * The local-history commands the versioning card previews, each with its own
 * shape. `stack` covers the `gh stack` half that creates and rebases branches
 * locally; a stack's remote half is publishing and keeps its own card.
 */
export const VERSIONING_COMMAND_FAMILIES = ["add", "commit", "rebase", "cherry-pick", "stack"] as const;

export type VersioningCommandFamily = (typeof VERSIONING_COMMAND_FAMILIES)[number];

/** What a collapsed versioning card draws, and whether expanding it shows more. */
export interface VersioningCardPreview {
	/** The rows to draw, joined; empty when the command printed nothing worth a row. */
	text: string;
	/** Whether the rows are the tail of the output (a log's last rows) rather than its head (a summary). */
	tail: boolean;
	/** Whether expanding the card shows anything these rows do not. */
	reveals: boolean;
}

export interface VersioningCardPreviewInput {
	/** The command the call ran, exactly as the card heads it. */
	command: string;
	/** The output the call produced, exactly as the host retained it. */
	output: string;
	/** Whether the call failed; a failure always previews its own cause. */
	failed: boolean;
	/** Rows a raw fallback may spend, defaulting to the chat's three-row preview budget. */
	limit?: number;
}

const PREVIEW_ROWS = 3;

// Git's own global options sit between the program and its verb, so `git -C repo
// add` and `git --no-pager commit` name the same families as their plain forms.
const GIT_GLOBAL_OPTIONS = String.raw`(?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)\s+\S+|\s+--?[A-Za-z][\w-]*(?:=\S+)?)*`;
const FAMILY_COMMANDS: ReadonlyArray<readonly [VersioningCommandFamily, RegExp]> = [
	["add", new RegExp(String.raw`^git${GIT_GLOBAL_OPTIONS}\s+add(?:\s|$)`)],
	["commit", new RegExp(String.raw`^git${GIT_GLOBAL_OPTIONS}\s+commit(?:\s|$)`)],
	["rebase", new RegExp(String.raw`^git${GIT_GLOBAL_OPTIONS}\s+rebase(?:\s|$)`)],
	["cherry-pick", new RegExp(String.raw`^git${GIT_GLOBAL_OPTIONS}\s+cherry-pick(?:\s|$)`)],
	["stack", /^gh\s+stack\s+(?:init|add|rebase)(?:\s|$)/],
];

// A commit's own summary row: a ref (or `detached HEAD`) and an abbreviated sha
// inside brackets, then the subject. Git never translates this format string, and
// the sha keeps a hook's own bracketed line (`[eslint] 2 problems`) from reading
// as a commit.
const COMMIT_SUMMARY = /^\[[^\]\n]+ [0-9a-f]{4,40}\] \S/;
// Git's diffstat row. It opens with a count, so a hook or a tool line that merely
// carries the markers (`check (+)`, `lint (+2)`) is never read as the stat the
// commit printed, and the words around the markers stay whatever the locale made
// them.
const DIFFSTAT_ROW = /^[ \t]+\d+[^\n]*(?:\(\+\)|\(-\))/;
// git's own `error:` and `fatal:` prefixes are not translated, so the row that
// states a failure's cause is readable without reading its sentence.
const CAUSE_ROW = /^(?:error|fatal):\s/;
// The status row the host appends to a failed command (`Command exited with code
// 1`, `Command timed out after 30 seconds`, …). It is the host's own untranslated
// text, so it names the outcome whatever language the command answered in.
const EXIT_STATUS_ROW = /^Command (?:exited with code \d+|timed out after \d+ seconds?|aborted|terminated without an exit code)\.?$/;

/**
 * The local-history family a command belongs to, or undefined for anything else.
 * Only a segment that *starts* with the versioning verb is read — a commit
 * message that merely mentions a command stays one segment — and the last such
 * segment wins, because the output belongs to the step that reported last:
 * `git add -A && git commit -m x` prints its commit, so the commit shape is the
 * one its output has.
 *
 * The segments come from the classifier's own splitter, which is quote-aware: a
 * `&&` or a `;` quoted inside a commit message separates nothing, so the message
 * never names a family the call did not run. The gate above reads the same split
 * through `inferShellActivity`, so the family can never disagree with the card
 * identity that admitted the call.
 */
export function versioningCommandFamily(command: string): VersioningCommandFamily | undefined {
	const segments = shellCommandSegments(command).map((segment) => segment.trim());
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index] ?? "";
		for (const [family, pattern] of FAMILY_COMMANDS) if (pattern.test(segment)) return family;
	}
	return undefined;
}

/** The output's rows, without the blank rows a command's own final newline leaves behind. */
function outputRows(output: string): string[] {
	const trimmed = output.replace(/\r\n/g, "\n").replace(/(?:\n[ \t]*)+$/, "");
	return trimmed.length > 0 ? trimmed.split("\n") : [];
}

/** The summary and diffstat rows a commit or a cherry-pick printed, or nothing when the shape is not one this module reads. */
function commitRows(rows: readonly string[]): string[] | undefined {
	const at = rows.findIndex((row) => COMMIT_SUMMARY.test(row));
	if (at < 0) return undefined;
	const preview = [(rows[at] as string).trimEnd()];
	// Only what follows the summary is a candidate. Git prints its diffstat with the
	// commit, so a hook row that happens to carry the markers belongs to the hook —
	// including one printed before the summary — and a row after it that is not a
	// diffstat leaves the summary as the only row the commit stated.
	const diffstat = rows.slice(at + 1).find((row) => DIFFSTAT_ROW.test(row));
	if (diffstat !== undefined) preview.push(diffstat.trimEnd());
	return preview;
}

/**
 * The rows a failed call previews: the row that states its cause first, the rows
 * that follow it, and the exit status the host appended.
 *
 * The cause leads because a card draws the head of its rows once they wrap: a
 * conflict's cause is long enough to wrap on a narrow terminal while its advice is
 * short, so a tail-anchored preview would spend every row on advice and the status
 * and leave a reader without the reason the call failed. Rows the call printed
 * before the cause belong to the context an expansion restores, never to the
 * three-row preview.
 */
function failureRows(rows: readonly string[], budget: number): { rows: string[]; tail: boolean } {
	// A failed call repeats no success: the summary and the diffstat are the two rows
	// that would read as one.
	const kept = rows.filter((row) => row.trim().length > 0 && !COMMIT_SUMMARY.test(row) && !DIFFSTAT_ROW.test(row));
	// The host's status row is the one fact a failure always carries, so it keeps a row
	// of the budget — as long as the cause leaves it one, which a budget of one row
	// does not.
	const statusRoom = Math.max(0, budget - 1);
	const status = statusRoom === 0 ? [] : kept.filter((row) => EXIT_STATUS_ROW.test(row)).slice(-statusRoom);
	const body = kept.filter((row) => !EXIT_STATUS_ROW.test(row));
	const room = Math.max(1, budget - status.length);
	const cause = body.findLastIndex((row) => CAUSE_ROW.test(row));
	// Nothing untranslated names the cause (a localized failure), so the card reads
	// nothing into the output and keeps the rows the command printed last.
	if (cause < 0) return { rows: [...body.slice(-room), ...status], tail: true };
	// The cause and the rows that follow it, in the order the call printed them: the
	// advice can follow the cause, never replace it.
	return { rows: [...body.slice(cause, cause + room), ...status], tail: false };
}

/**
 * The rows a collapsed versioning card draws, or undefined when the call is not a
 * versioning card at all (inspection, a check, and publishing each keep their own
 * preview). The card identity is the authority: a compound that also pushes is a
 * publishing card, so its commit is never previewed here.
 */
export function versioningCardPreview({ command, output, failed, limit = PREVIEW_ROWS }: VersioningCardPreviewInput): VersioningCardPreview | undefined {
	if (inferShellActivity(command) !== "versioning") return undefined;
	const family = versioningCommandFamily(command);
	if (family === undefined) return undefined;
	const rows = outputRows(output);
	const budget = Math.max(1, Math.floor(limit));
	const whole = rows.join("\n");
	const preview = (drawn: readonly string[], tail: boolean): VersioningCardPreview => {
		const text = drawn.join("\n");
		return { text, tail, reveals: text !== whole };
	};
	// A failure states its own cause and nothing else: no summary is derived from an
	// output whose status the card does not know, and the cause leads so wrapping
	// cannot hide it.
	if (failed) {
		const failure = failureRows(rows, budget);
		return preview(failure.rows, failure.tail);
	}
	if (family === "add") {
		// `git add` prints nothing when it succeeds. That silence is not evidence of
		// what it staged, so the card draws no rows rather than inventing a count.
		if (rows.every((row) => row.trim().length === 0)) return { text: "", tail: false, reveals: false };
		return preview(rows.slice(-budget), true);
	}
	if (family === "commit" || family === "cherry-pick") {
		const summary = commitRows(rows);
		if (summary === undefined) return preview(rows.slice(-budget), true);
		return preview(summary, false);
	}
	// A rebase sentence is translated and a stack's own output is a shape this
	// module has no evidence for, so both keep the rows the command printed.
	return preview(rows.slice(-budget), true);
}
