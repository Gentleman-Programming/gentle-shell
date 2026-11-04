// Deterministic ODD phase inference from observed tool activity. The Gentle
// Shell working label used to depend only on the model calling
// gentle_odd_phase, which models routinely skip; the tools the primary
// session actually runs are a reliable, observable signal instead.
//
// The mapping is deliberately conservative: an unknown tool, unknown subagent
// role, or an ambiguous shell command returns undefined so the caller leaves
// the current label unchanged. This module is pure (no Pi or registry
// imports); precedence against explicit reports lives in OddPhaseRegistry.

import type { OddPhase } from "./odd-phase.ts";

/**
 * The activity a shell call names on its own card. `exploring` and `checking` are
 * ODD phases; the rest are presentation only — installing, reformatting, deleting,
 * a commit or a push is not a step of the ODD protocol, so none of them reaches the
 * phase label, the global phase enum, or the exploration budget.
 */
export const SHELL_ACTIVITIES = ["checking", "formatting", "preparing", "publishing", "versioning", "exploring"] as const;

export type ShellActivity = (typeof SHELL_ACTIVITIES)[number];

/**
 * The mark and theme role reserved for each activity. Classifier families and
 * card consumers are introduced separately; this table does not change them.
 *
 * The roles are the theme's own slots, never a fixed palette: `mdLink` and
 * `mdHeading` paint the two ODD phases, `warning` is the warm role a local history change wears, and
 * `success` the green one a remote write wears, so a theme that changes its
 * palette changes the cards with it. `syntaxFunction` is the code palette, and it
 * is the one slot `preparing` and `formatting` share: the shipped themes define
 * six colours a heading can wear, and the two maintenance identities are told
 * apart by their mark and their word rather than by a colour no theme has. The
 * mark still tells an identity apart from a status tone, and the frame keeps
 * painting the call's own state.
 *
 * A mark carries its own gap where a font may paint it wider than pi-tui counts:
 * U+2692 is drawn two cells wide by an emoji-fallback font while pi-tui counts it
 * as one, so a single space after it is painted inside the glyph's own second cell
 * and the heading reads `⚒preparing`. Preparing's mark therefore ends in one
 * space — the minimum that still shows — so one column always appears and the
 * heading's counted width matches what the terminal paints.
 */
export const SHELL_ACTIVITY_IDENTITY: Record<ShellActivity, { glyph: string; titleRole: string }> = {
	checking: { glyph: "✓", titleRole: "mdHeading" },
	formatting: { glyph: "≋", titleRole: "syntaxFunction" },
	preparing: { glyph: "⚒ ", titleRole: "syntaxFunction" },
	publishing: { glyph: "↑", titleRole: "success" },
	versioning: { glyph: "⎇", titleRole: "warning" },
	exploring: { glyph: "⌕", titleRole: "mdLink" },
};

const TOOL_PHASES: Readonly<Record<string, OddPhase>> = {
	read: "exploring",
	grep: "exploring",
	find: "exploring",
	ls: "exploring",
	codegraph: "exploring",
	ask_user_choice: "deciding",
	ask_user_question: "deciding",
	todo: "planning",
	gentle_review: "checking",
	gentle_review_scope: "checking",
	gentle_review_capture: "checking",
	gentle_review_capture_group: "checking",
};

const DELEGATED_PHASES: Readonly<Record<string, OddPhase>> = {
	"gentle-ai-worker": "implementing",
	"gentle-ai-verify": "checking",
	"gentle-ai-explore": "exploring",
};

const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

// Test, typecheck, lint, and build runners. Matched per shell segment.
const CHECKING_COMMANDS: readonly RegExp[] = [
	/^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|build|check)\b/,
	/^node\b.*\s--test\b/,
	/^node\s+\S*(test|check|lint|typecheck)[\w-]*\.m?[jt]s\b/,
	/^((npx|pnpx|bunx)\s+|(pnpm|yarn)\s+exec\s+)?(vitest|jest|mocha|tsc|eslint|pytest)\b/,
	/^python3?\s+-m\s+pytest\b/,
	/^go\s+(test|build|vet)\b/,
	/^cargo\s+(test|build|check|clippy)\b/,
	/^make\b/,
	// Waiting on or reading CI results verifies work; it is not exploration.
	/^gh\s+pr\s+checks\b/,
	/^gh\s+run\s+(view|watch|list)\b/,
];

// Git listing flags that may take one non-flag argument (`--contains <rev>`)
// without turning `git branch`/`git tag` into a create.
const GIT_LIST_FLAG = String.raw`(\s+(-a|-r|-l|-v|-vv|-n\d*|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--points-at|--sort=\S+)(\s+[^-\s]\S*)?)*$`;

// Read-only inspection. Matched per shell segment.
const EXPLORING_COMMANDS: readonly RegExp[] = [
	/^git\s+(status|log|diff|show|blame|rev-parse|rev-list|merge-base|ls-files|ls-remote|ls-tree|cat-file|describe|shortlog|reflog|grep|check-ignore|for-each-ref|name-rev|count-objects)\b/,
	new RegExp(String.raw`^git\s+(branch|tag)${GIT_LIST_FLAG}`),
	/^git\s+remote(\s+(-v|--verbose|show|get-url)\b.*)?$/,
	/^git\s+(worktree|stash)\s+list\b/,
	/^git\s+config\s+(--get|--get-all|--get-regexp|-l|--list)\b/,
	/^gh\s+(pr|issue|repo|release)\s+(view|list|diff|status)\b/,
	/^(ls|cat|head|tail|grep|egrep|rg|wc|pwd|tree|stat|file|which|type|readlink|realpath|dirname|basename|cut|uniq|tr|nl|column|strings|diff|cmp|od|xxd|hexdump|shasum|sha256sum|md5|md5sum|du|df|date|uname|whoami|ps|pgrep|lsof|jq|awk)\b/,
	/^command\s+-v\b/,
	/^(\[\[?|test)\s/,
	/^sort\b(?!.*\s(-o|--output)\b)/,
	/^sed\b(?!.*\s(-[a-zA-Z]*i|--in-place)\b)/,
	/^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*)\b)/,
];

// Segments that neither inspect nor change anything worth labeling: shell
// control words, no-op builtins, and bare variable assignments (their
// command substitutions are classified as commands of their own).
const NEUTRAL_COMMANDS: readonly RegExp[] = [
	/^(cd|pushd|popd|echo|printf|sleep|true|false|export|set)\b/,
	/^(done|fi|esac|\}|\))$/,
	/^for\s+\w+(\s+in\b.*)?$/,
	// Each assignment must end at whitespace or the end: an optional separator
	// would let `a=a=a=…` split anywhere and backtrack exponentially.
	/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*(\s+|$))+$/,
];

// Shell keywords that prefix the command they introduce (`do grep x`).
const LEADING_KEYWORDS = /^(do|then|else|elif|if|while|until|time|!|\{|\()\s+/;

/**
 * Infers the ODD phase implied by a tool call, or undefined when the call
 * carries no reliable phase signal and the label must stay as it is.
 */
export function inferOddPhase(toolName: string, args: unknown): OddPhase | undefined {
	const name = normalizeToolName(toolName);
	if (name === "subagent_run") {
		const agent = stringArg(args, "agent");
		return agent && Object.hasOwn(DELEGATED_PHASES, agent) ? DELEGATED_PHASES[agent] : undefined;
	}
	if (WRITE_TOOLS.has(name)) return isOddTaskPath(stringArg(args, "path") ?? stringArg(args, "file_path")) ? "planning" : "implementing";
	if (SHELL_TOOLS.has(name)) return inferShellPhase(stringArg(args, "command"));
	return Object.hasOwn(TOOL_PHASES, name) ? TOOL_PHASES[name] : undefined;
}

// Some runtimes expose tools through an MCP proxy as `mcp__<server>__<tool>`.
function normalizeToolName(toolName: string): string {
	return toolName.replace(/^mcp__.+?__/, "");
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function isOddTaskPath(path: string | undefined): boolean {
	return path !== undefined && /(^|\/)odd\/tasks\//.test(path.replaceAll("\\", "/"));
}

/**
 * A command checks when any segment runs a checker; it explores only when
 * every segment is read-only inspection (or neutral like `cd`). Anything
 * else — a mutation, an install, an unknown program — is ambiguous.
 */
function inferShellPhase(command: string | undefined): OddPhase | undefined {
	const segments = shellSegments(command);
	if (segments.length === 0) return undefined;
	const activities = segments.map(segmentActivity);
	if (activities.includes("checking")) return "checking";
	return activities.every((activity) => activity === "exploring") ? "exploring" : undefined;
}

/**
 * The activity a shell command names for its own card, or undefined when some
 * segment carries no reliable signal. Formatting, preparing, versioning and
 * publishing are card identities, not ODD phases: the working label and the
 * exploration budget read inferOddPhase, which never returns them.
 *
 * The card keeps every segment honest: a segment nothing can name keeps the whole
 * call generic — a check printed beside an unknown script never claims the card —
 * and a check outranks the inspection beside it. That is a display rule only: the
 * phase inference still lets any checking segment decide the label.
 */
export function inferShellActivity(command: string | undefined): ShellActivity | undefined {
	const segments = shellSegments(command);
	if (segments.length === 0) return undefined;
	const activities = segments.map(segmentActivity);
	// Beside a segment nothing can name the card stays generic: the heading never
	// claims a check — or any other identity — for work the call also did silently.
	if (activities.includes(undefined)) return undefined;
	if (activities.includes("checking")) return "checking";
	return "exploring";
}

/** The command split into the simple commands the classifier reads, with the ones that do nothing dropped. */
function shellSegments(command: string | undefined): string[] {
	if (command === undefined) return [];
	return splitShellCommands(command)
		.map(stripSegment)
		.filter((segment) => segment.length > 0 && !isNeutral(segment));
}

/**
 * What one simple command does. A check verifies work and a read-only segment
 * inspects it; everything else — a mutation, an install, an unknown program, a
 * redirect — carries no activity this classifier can name.
 */
function segmentActivity(segment: string): ShellActivity | undefined {
	if (matchesAny(CHECKING_COMMANDS, segment)) return "checking";
	if (isReadOnlyInspection(segment)) return "exploring";
	return undefined;
}

/**
 * Splits a shell command into simple commands. Top-level `&&`, `||`, `;`,
 * `|`, `&`, and newlines separate them; quoted text never does; and every
 * `$(...)` substitution contributes its own commands, leaving a `$_`
 * placeholder behind. Not a full shell parser: whatever it cannot follow
 * lands in a segment that matches no pattern, so the label stays unchanged.
 */
function splitShellCommands(command: string): string[] {
	const commands: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote === "'") {
			current += char;
			if (char === "'") quote = undefined;
		} else if (char === "\\") {
			current += char + (command[i + 1] ?? "");
			i++;
		} else if (char === "$" && command[i + 1] === "(") {
			const end = findSubstitutionEnd(command, i + 2);
			if (end < 0) return [...commands, current + command.slice(i)];
			commands.push(...splitShellCommands(command.slice(i + 2, end)));
			current += "$_";
			i = end;
		} else if (quote === '"') {
			current += char;
			if (char === '"') quote = undefined;
		} else if (char === "'" || char === '"') {
			quote = char;
			current += char;
		} else if (isSeparator(command, i)) {
			commands.push(current);
			current = "";
			if ((char === "|" || char === "&") && command[i + 1] === char) i++;
		} else {
			current += char;
		}
	}
	commands.push(current);
	return commands;
}

// `&` inside a redirection (`2>&1`, `&>/dev/null`) is not a separator.
function isSeparator(command: string, i: number): boolean {
	const char = command[i];
	if (char === "&") return command[i - 1] !== ">" && command[i + 1] !== ">";
	return char === ";" || char === "|" || char === "\n";
}

// Index of the `)` closing a `$(` whose body starts at `start`, or -1.
function findSubstitutionEnd(command: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	for (let i = start; i < command.length; i++) {
		const char = command[i];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') i++;
		} else if (char === "\\") i++;
		else if (char === "'" || char === '"') quote = char;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return i;
	}
	return -1;
}

// Drops harmless redirections (`2>&1`, `2>/dev/null`), leading shell
// keywords (`do grep x`), environment assignments (`CI=1 pnpm test`), git
// global options (`git -C dir status`), and whitespace. A bare assignment
// is left intact for NEUTRAL_COMMANDS.
function stripSegment(segment: string): string {
	let stripped = segment.replace(HARMLESS_REDIRECTS, "").trim();
	while (LEADING_KEYWORDS.test(stripped)) stripped = stripped.replace(LEADING_KEYWORDS, "");
	return stripped
		.replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*\s+)+(?=\S)/, "")
		.replace(/^git\s+((-C|-c)\s+\S+\s+|--no-pager\s+)+/, "git ");
}

// A segment that writes a file (`echo x > out`) is never a no-op.
function isNeutral(segment: string): boolean {
	return !writesFile(segment) && matchesAny(NEUTRAL_COMMANDS, segment);
}

function isReadOnlyInspection(segment: string): boolean {
	return !writesFile(segment) && matchesAny(EXPLORING_COMMANDS, segment);
}

// Stream merges and discarded output; neither writes a file.
const HARMLESS_REDIRECTS = /\s*(\d?>&\d|&?\d?>\s*\/dev\/null)/g;

// Output redirection to a file is a write. Deliberately naive: a `>` inside
// quoted text also counts, which only ever leaves the label unchanged.
function writesFile(segment: string): boolean {
	return segment.replace(HARMLESS_REDIRECTS, "").includes(">");
}

function matchesAny(patterns: readonly RegExp[], segment: string): boolean {
	return patterns.some((pattern) => pattern.test(segment));
}
