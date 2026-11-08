import type { AgentToolResult, ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadToolDefinition,
	createWriteTool,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { resolveGentleAiDevBinaryOverride, type GentleAiDevBinaryOverride } from "../lib/gentle-ai-binary.ts";
import { CARD_CONTENT, cardContent } from "../lib/card-content-policy.ts";
import { GentleAiElapsedTimingLedger } from "../lib/gentle-ai-elapsed-store.ts";
import { inferOddPhase, inferShellActivity, SHELL_ACTIVITY_IDENTITY, type ShellActivity } from "../lib/odd-phase-inference.ts";
import type { OddPhase } from "../lib/odd-phase.ts";
import {
	CODEGRAPH_MARK, CODEGRAPH_TITLE_ROLE, CODEGRAPH_TOOL, codeGraphCollapsedRows, codeGraphPreview,
	codegraphCallDetail, codegraphCallFromCommand,
} from "../lib/codegraph-card-preview.ts";
import { versioningCardPreview } from "../lib/versioning-card-preview.ts";
import { quietToolsEnabled } from "../lib/quiet-tools-config.ts";
import { registerCompactCodemode } from "../lib/codemode-renderer.ts";
import { offerBuiltinCodemodeOptOut, type BuiltinCodemodeOptOutOptions } from "../lib/builtin-codemode-optout.ts";
import { getGentleAiRenderState, renderGentleAiLifecycleCall, renderGentleAiResult, type GentleAiRenderContext } from "../lib/gentle-ai-renderer.ts";
import {
	CARD_TONE, cardAwaitingResult, cardBottom, cardElapsed, cardInnerWidth, cardLine, cardRunningLine, cardStyle, cardTopLine, cardTopRows, floatRows, markCardResult,
	type CardRowContext, type CardTheme,
} from "../lib/shell-card.ts";
import { sanitizeTerminalText, stripAnsi } from "../lib/terminal-theme.ts";

type QuietToolName = "read" | "bash" | "grep" | "find" | "ls" | "edit" | "write";
type RegisteredToolName = Exclude<QuietToolName, "bash">;
type ThemeLike = {
	bold(value: string): string;
	fg(color: string, value: string): string;
};

/** One quiet card's drawing slots: the shape pi's own tool definitions carry. */
type QuietToolRenderer = Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult">;

const TOOL_CREATORS = {
	read: createReadToolDefinition,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
	edit: createEditTool,
	write: createWriteTool,
} satisfies Record<RegisteredToolName, (cwd: string) => any>;

// Caller-owned identities: shared notices and lower widgets retain their glyphs.
const TOOL_GLYPH = {
	read: "≡",
	bash: "$",
	grep: "⌕",
	find: "⌖",
	ls: "☷",
	edit: "✎",
	write: "+",
} as const satisfies Record<QuietToolName, string>;

// A bash command's activity decides the card's identity. `exploring` and
// `checking` are ODD phases; every other activity (a deletion, a history change,
// a publish, a rewrite, a build-up) is presentation only, so it names and paints
// the card without ever reaching the phase label, the global phase enum or the
// exploration budget. edit, write, todo and the choice tools keep their own
// existing cards.
export type BashCardPhase = Extract<OddPhase, "exploring" | "checking">;

// Each activity leads with its own mark and paints itself in its own theme role,
// so a deletion never looks like a check. The table lives beside the classifier
// so one call never reads as two activities.
/** The identity of a command whose phase the inference cannot tell: the tool's own mark and role, never a borrowed phase. */
export const BASH_IDENTITY = { glyph: TOOL_GLYPH.bash, titleRole: "bashMode" } as const;

const COLLAPSED_COUNT_LABELS: Partial<Record<QuietToolName, string>> = {
	grep: "matches",
	find: "files",
	ls: "entries",
};

// Cards that show only the command while the Card content preference is
// minimal: their results stay one expand key away and never add rows to the
// transcript view.
const COMMAND_ONLY_TOOLS: ReadonlySet<QuietToolName> = new Set(["read", "bash", "grep", "find", "ls", "edit", "write"]);

const COLLAPSED_TAIL_LINE_LIMIT = 10;
const PREVIEW_LINE_LIMIT = 3;

const EMPTY_RESULT_MESSAGES: Partial<Record<QuietToolName, string[]>> = {
	grep: ["No matches found"],
	find: ["No files found matching pattern"],
	ls: ["Directory is empty", "(empty directory)"],
	bash: ["(no output)"],
};

const toolCache = new Map<string, Record<RegisteredToolName, any>>();

function createBuiltInTools(cwd: string): Record<RegisteredToolName, any> {
	return Object.fromEntries(
		(Object.entries(TOOL_CREATORS) as [RegisteredToolName, (cwd: string) => any][]).map(
			([name, createTool]) => [name, createTool(cwd)],
		),
	) as Record<RegisteredToolName, any>;
}

function getBuiltInTools(cwd: string): Record<RegisteredToolName, any> {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string" || path.length === 0) return "";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function countNonEmptyLines(text: string): number {
	return text.split("\n").filter((line) => line.trim().length > 0).length;
}

export function tailLines(text: string, limit: number): string {
	const lines = text.split("\n");
	return lines.slice(Math.max(0, lines.length - limit)).join("\n");
}

function outputLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
	return normalized.length > 0 ? normalized.split("\n") : [];
}

function firstLines(text: string, limit: number): string {
	return outputLines(text).slice(0, limit).join("\n");
}

function lastOutputLines(text: string, limit: number): string {
	return outputLines(text).slice(-limit).join("\n");
}

function lastMeaningfulOutputLines(text: string, limit: number): string {
	return outputLines(text)
		.filter((line) => line.trim().length > 0)
		.slice(-limit)
		.join("\n");
}

function semanticJsonPreview(text: string): string | undefined {
	const trimmed = text.trim();
	if (!/^[\[{]/.test(trimmed)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const normalized = JSON.stringify(parsed, null, 2);
	if (normalized === undefined) return undefined;
	return outputLines(normalized)
		.filter((line) => !/^[\s{}\[\],]*$/.test(line))
		.slice(0, PREVIEW_LINE_LIMIT)
		.join("\n");
}

export function extractTextContent(result: AgentToolResult<unknown>): string {
	return result.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n");
}

function safeText(value: string): string {
	return sanitizeTerminalText(value);
}

function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") return safeText(value);
	return value;
}

function sanitizedArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
	return (sanitizeValue(args ?? {}) as Record<string, unknown>) ?? {};
}

function sanitizedResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	return {
		...result,
		content: result.content.map((content) => content.type === "text" ? { ...content, text: safeText(content.text) } : content.type === "image" ? { ...content, mimeType: safeText(content.mimeType) } : content),
		details: sanitizeValue(result.details),
	};
}

function isEmptyResultMessage(toolName: QuietToolName, text: string): boolean {
	const normalized = text.trim();
	return EMPTY_RESULT_MESSAGES[toolName]?.some((message) => normalized === message) ?? false;
}

function grepMatchCount(text: string, args: Record<string, unknown> | undefined): number {
	const context = args?.context;
	if (typeof context !== "number" || context <= 0) return countNonEmptyLines(text);
	return outputLines(text).filter((line) => /^\s*.+:\d+:\s?/.test(line)).length;
}

function isGitCommand(args: Record<string, unknown> | undefined): boolean {
	const command = typeof args?.command === "string" ? args.command.trim() : "";
	return /^(?:env\s+\S+=\S+\s+|command\s+|\w+=\S+\s+)*git(?:\s|$)/.test(command);
}

export type GentleAiRoutineCommand = "review";

const GENTLE_AI_EXECUTABLE = String.raw`(?:gentle-ai(?:\.exe)?|(?:\.{1,2}[\\/]|(?:[A-Za-z]:)?(?:[\\/][^\\/\r\n]+)*[\\/])\.gentle-ai[\\/]v\d+\.\d+\.\d+[\\/]gentle-ai(?:\.exe)?)`;
const GENTLE_AI_COMMAND_ARGUMENTS = new RegExp(`^${GENTLE_AI_EXECUTABLE}$`);

function createGentleAiCommandArguments(activeDevBinaryPath?: string): RegExp {
	if (!activeDevBinaryPath) return GENTLE_AI_COMMAND_ARGUMENTS;
	const escapedPath = activeDevBinaryPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(`^(?:${GENTLE_AI_EXECUTABLE}|${escapedPath})$`);
}

type ShellTokenization =
	| { kind: "complete" | "incomplete"; tokens: string[] }
	| { kind: "generic" };

function shellTokens(command: string): ShellTokenization {
	const tokens: string[] = [];
	let token = "";
	let quote: "single" | "double" | undefined;
	let tokenStarted = false;
	const push = () => {
		if (tokenStarted) tokens.push(token);
		token = "";
		tokenStarted = false;
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (character === "\r" || character === "\n") return { kind: "generic" };
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else token += character;
			continue;
		}
		if (quote === "double") {
			if (character === '"') { quote = undefined; continue; }
			if (character === "\\") {
				const next = command[++index];
				if (next === undefined || next === "\r" || next === "\n") return { kind: "incomplete", tokens };
				token += "$`\"\\".includes(next) ? next : `\\${next}`;
				continue;
			}
			if (character === "$" || character === "`") return { kind: "generic" };
			token += character;
			continue;
		}
		if (/\s/.test(character)) { push(); continue; }
		if (character === "'") { quote = "single"; tokenStarted = true; continue; }
		if (character === '"') { quote = "double"; tokenStarted = true; continue; }
		if (character === "\\") {
			const next = command[++index];
			if (next === undefined || next === "\r" || next === "\n") return { kind: "incomplete", tokens };
			const windowsPath = token === "." || /^[A-Za-z]:$/.test(token) || token.includes("\\");
			token += windowsPath ? `\\${next}` : next;
			tokenStarted = true;
			continue;
		}
		if ("*?~{}".includes(character)) return { kind: "generic" };
		if (character === "[" && command.indexOf("]", index + 1) >= 0) return { kind: "generic" };
		if (";&|<>`()".includes(character) || character === "$" || character === "`") return { kind: "generic" };
		if (character === "#" && !tokenStarted) return { kind: "generic" };
		token += character;
		tokenStarted = true;
	}
	if (quote) return { kind: "incomplete", tokens };
	push();
	return { kind: "complete", tokens };
}

function isAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}
const REVIEW_DIRECT_OPERATIONS = new Set([
	"capabilities",
	"start",
	"finalize",
	"status",
	"repair",
	"invalidate",
	"abandon",
	"recover",
	"reclaim",
	"validate",
	"capture-result",
	"capture-refuter",
	"capture-validation",
	"capture-evidence",
	"preserve-result",
	"lens-context",
	"retry-final-verification",
	"store-reset",
	"inspect-authority",
	"inspect-candidate",
	"dispose-result",
	"reopen-results",
	"opencode-transport",
	"bind-sdd",
]);
const REVIEW_MODE_VALUES = new Set(["enable", "disable", "status"]);
const REVIEW_VALIDATE_GATES = new Set(["post-apply", "pre-commit", "pre-push", "pre-pr", "release"]);
const REVIEW_SCHEMA_NAMES = new Set([
	"capture-result-dry-run",
	"final-verification-incident",
	"refuter",
	"reviewer",
	"validator",
	"verification-evidence",
	"verification-evidence-record",
]);

function gentleAiCommandTokensFrom(tokens: string[], commandArguments: RegExp): string[] | undefined {
	let index = 0;
	while (isAssignment(tokens[index] ?? "")) index += 1;
	if (tokens[index] === "command") {
		index += 1;
		if (tokens[index] === "--") index += 1;
		else if ((tokens[index] ?? "").startsWith("-")) return undefined;
	}
	if (tokens[index] === "env") {
		index += 1;
		while (isAssignment(tokens[index] ?? "")) index += 1;
		if ((tokens[index] ?? "").startsWith("-")) return undefined;
	}
	if (!commandArguments.test(tokens[index] ?? "")) return undefined;
	return tokens.slice(index + 1);
}

function gentleAiCommandTokens(args: Record<string, unknown> | undefined, commandArguments = GENTLE_AI_COMMAND_ARGUMENTS): string[] | undefined {
	const shell = shellTokens(typeof args?.command === "string" ? args.command : "");
	return shell.kind === "complete" ? gentleAiCommandTokensFrom(shell.tokens, commandArguments) : undefined;
}

function displayToken(token: string): string {
	return token.replace(/-/g, " ");
}

function validateGate(tokens: string[]): string | undefined {
	const gateFlag = tokens.findIndex((token) => token === "--gate" || token.startsWith("--gate="));
	if (gateFlag < 0) return undefined;
	const gate = tokens[gateFlag]!.startsWith("--gate=")
		? tokens[gateFlag]!.slice("--gate=".length)
		: tokens[gateFlag + 1];
	return gate !== undefined && REVIEW_VALIDATE_GATES.has(gate) ? gate : "";
}

/**
 * Matches only supported routine Gentle AI CLI calls, including bounded
 * package-local paths, not arbitrary shell output that merely mentions
 * gentle-ai. Review commands otherwise emit machine-readable RDD data.
 */
export function isGentleAiDirectCommand(args: Record<string, unknown> | undefined, commandArguments = GENTLE_AI_COMMAND_ARGUMENTS): boolean {
	return gentleAiCommandTokens(args, commandArguments) !== undefined;
}

export function gentleAiRoutineCommand(args: Record<string, unknown> | undefined, commandArguments = GENTLE_AI_COMMAND_ARGUMENTS): GentleAiRoutineCommand | undefined {
	const tokens = gentleAiCommandTokens(args, commandArguments);
	if (!tokens) return undefined;
	if (tokens[0] === "review") return "review";
	return undefined;
}

function gentleAiOperationPathFrom(tokens: string[]): string | undefined {
	if (tokens[0]?.startsWith("sdd-")) return undefined;
	if (tokens[0] === "version") return "version";
	if (tokens[0] !== "review") return "command";

	const operation = tokens[1];
	if (operation === undefined) return "review";
	if (operation === "mode") {
		const mode = tokens[2];
		return mode !== undefined && REVIEW_MODE_VALUES.has(mode) ? `review mode ${displayToken(mode)}` : "review";
	}
	if (operation === "validate") {
		const gate = validateGate(tokens);
		if (gate === "") return "review";
		return gate === undefined ? "review validate" : `review validate ${displayToken(gate)}`;
	}
	if (operation === "schema") {
		const schema = tokens[2];
		return schema !== undefined && REVIEW_SCHEMA_NAMES.has(schema) ? `review schema ${displayToken(schema)}` : "review schema";
	}
	return REVIEW_DIRECT_OPERATIONS.has(operation) ? `review ${displayToken(operation)}` : "review";
}

export function gentleAiOperationPath(args: Record<string, unknown> | undefined, commandArguments = GENTLE_AI_COMMAND_ARGUMENTS): string | undefined {
	const tokens = gentleAiCommandTokens(args, commandArguments);
	return tokens ? gentleAiOperationPathFrom(tokens) : undefined;
}

interface ToolResultFormatOptions {
	expanded: boolean;
	isError?: boolean;
	args?: Record<string, unknown>;
}

function detailsRecord(result: AgentToolResult<unknown>): Record<string, unknown> {
	const details = sanitizeValue(result.details);
	return details && typeof details === "object" && !Array.isArray(details)
		? details as Record<string, unknown>
		: {};
}

function diffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

function editSummary(result: AgentToolResult<unknown>): string {
	const diff = detailsRecord(result).diff;
	if (typeof diff === "string") {
		const stats = diffStats(diff);
		return `✓ +${stats.additions} / -${stats.removals}`;
	}
	return "✓ applied";
}

function writeSummary(text: string): string {
	const bytes = text.match(/(?:Successfully )?wrote\s+(\d+)\s+bytes/i)?.[1];
	return `✓ ${bytes ? `wrote ${bytes} bytes` : "written"}`;
}

function expandedResultText(toolName: QuietToolName, result: AgentToolResult<unknown>, text: string): string {
	if (toolName === "edit") {
		const diff = detailsRecord(result).diff;
		if (typeof diff === "string") return safeText(diff);
	}
	return text;
}

export function formatToolResultOutput(
	toolName: QuietToolName,
	result: AgentToolResult<unknown>,
	{ expanded, isError = false, args }: ToolResultFormatOptions,
): string {
	const text = safeText(extractTextContent(result));
	if (expanded) {
		// Write results only acknowledge the operation; the body lives in the call args.
		const detail = toolName === "write" && !isError && typeof args?.content === "string" && args.content.length > 0
			? safeText(args.content)
			: expandedResultText(toolName, result, text);
		return detail ? `\n${detail}` : "";
	}
	if (isError) {
		const tail = lastMeaningfulOutputLines(text, PREVIEW_LINE_LIMIT);
		return tail ? `\n${tail}` : "";
	}
	const summaryLabel = COLLAPSED_COUNT_LABELS[toolName];
	if (summaryLabel) {
		if (isEmptyResultMessage(toolName, text)) return "";
		const count = toolName === "grep" ? grepMatchCount(text, args) : countNonEmptyLines(text);
		return count > 0 ? ` → ${count} ${summaryLabel}` : "";
	}
	if (toolName === "bash" && isGitCommand(args)) {
		const tail = tailLines(text, COLLAPSED_TAIL_LINE_LIMIT);
		return tail ? `\n${tail}` : "";
	}
	if (toolName === "read") {
		const head = firstLines(text, PREVIEW_LINE_LIMIT);
		return head ? `\n${head}` : "";
	}
	if (toolName === "bash") {
		const preview = semanticJsonPreview(text);
		const tail = preview ?? lastOutputLines(text, PREVIEW_LINE_LIMIT);
		return tail ? `\n${tail}` : "";
	}
	if (toolName === "edit") return `\n${editSummary(result)}`;
	if (toolName === "write") return `\n${writeSummary(text)}`;
	return "";
}

/** One expansion level's rows, as the card draws them. */
interface QuietResultRows {
	/** The rows the card draws. */
	text: string;
	/** Whether the preview keeps the tail of its text (a log's last rows) rather than its head (a summary). */
	tail: boolean;
	/** Set when the preview knows its own shape; otherwise the card compares its two levels itself. */
	reveals?: boolean;
}

/** What one shared command preview draws: the rows, which end they lead from, and whether expanding shows more. */
type CommandPreview = { text: string; tail: boolean; reveals: boolean };

interface CommandPreviewInput {
	command: string;
	output: string;
	failed: boolean;
	limit?: number;
}

// The shared previews, in the order a card tries them: local history
// (lib/versioning-card-preview.ts) and CodeGraph (lib/codegraph-card-preview.ts).
// A shared preview owns one command family and answers nothing for another, so the
// card wires it once.
const COMMAND_PREVIEWS: ReadonlyArray<(input: CommandPreviewInput) => CommandPreview | undefined> = [
	versioningCardPreview,
	codegraphCommandPreview,
];

/** The CodeGraph summary a bash card collapses to, or undefined when the command runs something else. */
function codegraphCommandPreview({ command, output, failed, limit }: CommandPreviewInput): CommandPreview | undefined {
	const call = codegraphCallFromCommand(command);
	if (call === undefined) return undefined;
	const rows = codeGraphCollapsedRows(call.operation, output, failed, false, limit);
	if (rows === undefined) return undefined;
	const whole = output.replace(/\r\n/g, "\n").replace(/(?:\n[ \t]*)+$/, "");
	return { text: rows.text, tail: rows.tail, reveals: rows.text !== whole };
}

// pi re-renders every visible card each frame, so a shared preview is parsed once
// per retained result: the command and the output of one call never change, and
// only the drawn rows are kept, never a copy of the output.
const commandPreviewCache = new WeakMap<object, { key: string; preview: CommandPreview | undefined }>();

/**
 * The preview a shared helper draws for this result, or undefined when the call is
 * none of theirs (inspection, a check and every other write keep the card's own
 * bounded preview).
 */
function commandPreviewRows(
	result: AgentToolResult<unknown>,
	text: string,
	args: Record<string, unknown> | undefined,
	failed: boolean,
): QuietResultRows | undefined {
	const command = typeof args?.command === "string" ? args.command : "";
	if (command.length === 0) return undefined;
	const cacheKey = typeof result === "object" && result !== null ? result : undefined;
	const key = `${failed ? 1 : 0}\u0000${PREVIEW_LINE_LIMIT}\u0000${command}`;
	const cached = cacheKey === undefined ? undefined : commandPreviewCache.get(cacheKey);
	let preview: CommandPreview | undefined;
	if (cached !== undefined && cached.key === key) {
		preview = cached.preview;
	} else {
		preview = COMMAND_PREVIEWS.reduce<CommandPreview | undefined>((found, helper) => found ?? helper({ command, output: text, failed, limit: PREVIEW_LINE_LIMIT }), undefined);
		if (cacheKey !== undefined) commandPreviewCache.set(cacheKey, { key, preview });
	}
	return preview === undefined ? undefined : { text: preview.text, tail: preview.tail, reveals: preview.reveals };
}

/**
 * The visible rows of one quiet result at one expansion level, before the card
 * paints them. Both levels are computed for every result, so a card can tell
 * whether expanding it would show anything else at all.
 */
function quietResultRows(
	toolName: QuietToolName,
	result: AgentToolResult<unknown>,
	text: string,
	options: { expanded: boolean; isError: boolean; args?: Record<string, unknown>; withheld: boolean },
): QuietResultRows {
	const { expanded, isError, args, withheld } = options;
	if (!expanded && withheld) return { text: "", tail: false };
	// A versioning call previews the shape its own command named instead of the tail
	// of whatever it printed: a commit's summary and diffstat, nothing for a silent
	// add, and the raw rows for a shape the shared helper refuses to read.
	if (!expanded) {
		const preview = commandPreviewRows(result, text, args, isError);
		if (preview !== undefined) return preview;
	}
	let output = formatToolResultOutput(toolName, result, { expanded, isError, args });
	// Counts alone hide the result: retain their useful totals alongside actual rows.
	if (!expanded && !isError && output && COLLAPSED_COUNT_LABELS[toolName]) {
		output += `\n${firstLines(text, PREVIEW_LINE_LIMIT - 1)}`;
	}
	if (!expanded && !isError && toolName === "edit") {
		const diff = detailsRecord(result).diff;
		if (typeof diff === "string") output += `\n${firstLines(safeText(diff).split("\n").filter((line) => /^[+-]/.test(line)).join("\n"), PREVIEW_LINE_LIMIT - 1)}`;
	}
	return { text: output.replace(/^\n/, ""), tail: !expanded && shouldRenderPreviewTail(toolName, text, isError, args) };
}

function lineRangeSuffix(args: Record<string, unknown>, theme: ThemeLike): string {
	if (args.offset === undefined && args.limit === undefined) return "";
	const startLine = typeof args.offset === "number" ? args.offset : 1;
	const endLine = typeof args.limit === "number" ? startLine + args.limit - 1 : undefined;
	return theme.fg("warning", `:${startLine}${endLine === undefined ? "" : `-${endLine}`}`);
}

/**
 * Splits a shell composition into its segments, or undefined when the command
 * carries quoting, substitution, escapes, or a pipe the card cannot read
 * safely. It never guesses: an unreadable composition keeps the whole command
 * visible. A pipeline routes output into another program (`| tee log.txt`,
 * `| xargs rm`, `|| fallback`), so no single segment is the whole story.
 */
function splitShellSegments(command: string): string[] | undefined {
	if (/['"`]|\$\(|\\|\|/.test(command)) return undefined;
	return command.split(/&&|\|\||;|\n/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

// A composition may skip a segment only when it is a harmless no-op whose output
// nobody reads. Deliberately tiny: anything unlisted makes the card name the
// whole command, so a consequential action is never hidden behind a test run.
const BASH_IGNORABLE_SEGMENT = /^(cd|pushd|popd|echo|printf|sleep|true|false|export|set|\[\[?|test)\b/;
// A no-op stops being harmless the moment it redirects output to a file. Stream
// merges and discarded output are not writes; anything else is. Quotes and
// escapes never reach this check (the splitter refuses those commands).
const BASH_HARMLESS_REDIRECT = /\s*(\d?>&\d|&?\d?>\s*\/dev\/null)/g;

function writesFileSegment(segment: string): boolean {
	return segment.replace(BASH_HARMLESS_REDIRECT, "").includes(">");
}

/**
 * The segment of a shell composition that names the work the phase came from:
 * the last segment the same classifier also labels with that phase. A single
 * segment has nothing to abbreviate, an unreadable composition returns
 * undefined, and so does a composition holding any segment that is neither a
 * read/verify step nor a harmless no-op — the heading then keeps the whole
 * command instead of hiding what else runs.
 */
function bashPrincipalAction(command: string, phase: BashCardPhase): string | undefined {
	const segments = splitShellSegments(command);
	if (!segments || segments.length < 2) return undefined;
	const safe = segments.every((segment) => {
		const segmentPhase = inferOddPhase("bash", { command: segment });
		if (segmentPhase === "exploring" || segmentPhase === "checking") return true;
		return BASH_IGNORABLE_SEGMENT.test(segment) && !writesFileSegment(segment);
	});
	if (!safe) return undefined;
	return segments.filter((segment) => inferOddPhase("bash", { command: segment }) === phase).at(-1);
}

/**
 * The bash heading: the activity its own command names (with that activity's mark
 * and color), or the unconditional generic `bash` fallback, over the command the
 * call actually runs. The detail is always that complete command — never a
 * shortened substitute — so nothing the call does is hidden: collapsed the
 * heading stays one row and an over-wide command ends in an ellipsis, and
 * expanded the whole command continues on the rows below. The rail that leads
 * the card is painted in the same role as the label, so the card's left edge
 * belongs to its heading.
 */
function bashHeading(args: Record<string, unknown>, theme: ThemeLike, expanded: boolean): ToolCardHeading {
	const command = safeText(asString(args.command, "..."));
	const timeout = typeof args.timeout === "number" ? ` (timeout ${args.timeout}s)` : "";
	const identity = bashIdentity(args);
	// A CodeGraph call heads with the operation and query it ran, through the same
	// helper the native tool's card uses, so one program reads as one card.
	const codegraph = identity.activity === "codegraph" ? codegraphCallFromCommand(command) : undefined;
	// Only a composition every segment of which is a read or a check names a
	// principal action; anything else keeps the whole command, so nothing
	// consequential is hidden behind a detail line.
	const phaseLike = identity.activity === "exploring" || identity.activity === "checking" ? identity.activity : undefined;
	const named = phaseLike === undefined ? undefined : bashPrincipalAction(command, phaseLike);
	const detail = codegraph !== undefined
		? codegraphCallDetail(codegraph)
		: named ?? command;
	return {
		title: theme.bold(identity.activity ?? "bash"),
		subtitle: `${detail}${timeout}`,
		// A composition the inference cannot name keeps its whole command, so collapsed it
		// folds to the one row that says what the command does and how much folds behind.
		// A composed gentle-ai call is never compacted: the card must show the whole call.
		...(named === undefined && codegraph === undefined && !/(^|[\s;&|])gentle-ai($|[\s;&|])/u.test(command) ? { collapsedDetail: (room: number) => `${bashSummary(command, Math.max(1, room - visibleWidth(timeout)))}${timeout}` } : {}),
		glyph: identity.glyph,
		titleRole: identity.titleRole,
		railRole: identity.titleRole,
		singleLine: !expanded,
	};
}

/**
 * The identity a bash call wears: the activity its own command names, or the
 * generic `$ bash` fallback's. The heading and the rail its result continues are
 * two halves of one card, so both derive it from the retained call the same way —
 * and without a theme, so a result drawn alone reaches the same role.
 */
function bashIdentity(args: Record<string, unknown> | undefined): { activity: ShellActivity | undefined; glyph: string; titleRole: string } {
	const command = asString(args?.command);
	const activity = command.length > 0 ? inferShellActivity(command) : undefined;
	const identity = activity === undefined ? BASH_IDENTITY : SHELL_ACTIVITY_IDENTITY[activity];
	return { activity, glyph: identity.glyph, titleRole: identity.titleRole };
}

/** The parts of a tool card heading: what it says, the mark that leads it, the theme role that paints it, and whether it must fit one row. */
interface ToolCardHeading {
	title: string;
	subtitle?: string;
	/** The collapsed detail, measured at the room the drawn row actually leaves. */
	collapsedDetail?: (room: number) => string;
	glyph: string;
	titleRole?: string;
	/** Theme role for the card's left rail; a labelled card names its identity there, so the rail matches the label. */
	railRole?: string;
	singleLine?: boolean;
}

/** One heading at one expansion level, drawn with whatever card chrome is active right now. */
function headingRows(heading: ToolCardHeading, tone: ToolTone, theme: CardTheme, singleLine: boolean, width: number, hint?: string): string[] {
	const card = { ...heading, body: [], tone };
	return singleLine ? [cardTopLine(card, theme, width, hint, heading.collapsedDetail)] : cardTopRows(card, theme, width, hint);
}

interface ToolRenderContextLike {
	args?: Record<string, unknown>;
	argsComplete?: boolean;
	executionStarted?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	lastComponent?: unknown;
	state?: unknown;
	cwd?: string;
	expanded?: boolean;
	toolCallId?: string;
	durationMs?: number;
}

// A collapsed minimal bash card says what the command does in one row: its
// first line without leading `cd <dir> &&` hops, and how many lines fold behind.
function bashSummary(command: string, width: number): string {
	const lines = command.replace(/\s+$/, "").split("\n");
	const first = lines.findIndex((line) => line.trim() !== "");
	const line = lines[first] ?? "";
	const action = line.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "").trim() || line.trim();
	const folded = lines.length - first - 1;
	const suffix = folded > 0 ? ` … +${folded} line${folded === 1 ? "" : "s"}` : "";
	const room = Math.max(1, width - visibleWidth(suffix));
	return `${clipPlain(action, room)}${suffix}`;
}

// Clips plain text to `width` columns with a trailing ellipsis and no SGR reset,
// so the caller's title style still covers the suffix that follows.
function clipPlain(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let clipped = Array.from(text);
	while (clipped.length > 0 && visibleWidth(clipped.join("")) > width - 1) clipped = clipped.slice(0, -1);
	return `${clipped.join("")}…`;
}

function formatToolCall(toolName: Exclude<QuietToolName, "bash">, args: Record<string, unknown>, theme: ThemeLike): string {
	switch (toolName) {
		case "read": {
			const path = safeText(shortenPath(args.path) || "...");
			return `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}${lineRangeSuffix(args, theme)}`;
		}
		case "grep": {
			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${safeText(asString(args.pattern))}/`)} in ${safeText(shortenPath(args.path) || ".")}`;
			if (typeof args.glob === "string") text += theme.fg("toolOutput", ` (${safeText(args.glob)})`);
			if (typeof args.limit === "number") text += theme.fg("toolOutput", ` limit ${args.limit}`);
			return text;
		}
		case "find": {
			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", safeText(asString(args.pattern, "*")))} in ${safeText(shortenPath(args.path) || ".")}`;
			if (typeof args.limit === "number") text += theme.fg("toolOutput", ` limit ${args.limit}`);
			return text;
		}
		case "ls": {
			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", safeText(shortenPath(args.path) || "."))}`;
			if (typeof args.limit === "number") text += theme.fg("toolOutput", ` limit ${args.limit}`);
			return text;
		}
		case "edit":
			return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", safeText(shortenPath(args.path) || "..."))}`;
		case "write": {
			const content = typeof args.content === "string" ? args.content : "";
			const lineInfo = content.length > 0 ? theme.fg("muted", ` (${content.split("\n").length} lines)`) : "";
			return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", safeText(shortenPath(args.path) || "..."))}${lineInfo}`;
		}
	}
}

interface BoundedRowSection {
	text: string;
	rows: number;
	tail?: boolean;
}

// Cache the rendered preview slice per stable tool-result object: pi re-renders
// every visible card each frame, so re-tokenizing the full output text per pass is
// pure waste. Only the returned preview slice is retained, never the full wrapped
// text, so an arbitrarily large output cannot pin every wrapped line for the
// result object's lifetime.
const boundedRowsLineCache = new WeakMap<object, Array<{ text: string; width: number; rows: number; tail: boolean; lines: string[] } | undefined>>();

class BoundedRows implements Component {
	private readonly sections: readonly BoundedRowSection[];
	private readonly cacheKey: object | undefined;

	constructor(sections: readonly BoundedRowSection[], cacheKey?: object) {
		this.sections = sections;
		this.cacheKey = cacheKey;
	}

	/** Renders each section through the wrapped-line cache, sliced to the section row budget; cache hits skip re-tokenizing and re-wrapping the section text. */
	render(width: number): string[] {
		const cache = this.cacheKey ? boundedRowsLineCache.get(this.cacheKey) : undefined;
		return this.sections.flatMap(({ text, rows, tail = false }, index) => {
			if (rows <= 0) return [];
			const hit = cache?.[index];
			if (hit && hit.text === text && hit.width === width && hit.rows === rows && hit.tail === tail) {
				return [...hit.lines];
			}
			const rendered = new Text(text, 0, 0).render(width);
			const sliced = tail ? rendered.slice(-rows) : rendered.slice(0, rows);
			if (this.cacheKey) {
				const slot = boundedRowsLineCache.get(this.cacheKey) ?? [];
				slot[index] = { text, width, rows, tail, lines: sliced };
				boundedRowsLineCache.set(this.cacheKey, slot);
			}
			return [...sliced];
		});
	}

	invalidate(): void {}
}

// Tool card: every quiet tool call is a rounded petal card, like the Gentle AI
// card, so the call and its output read as one block apart from assistant
// prose. pi does not paint tool backgrounds for renderShell "self", so the
// frame tone carries the status the painted Box would otherwise show. The call
// owns the top rule; the result draws the sides and always closes the frame.
// Until the first result exists, the call closes the frame itself.
type ToolTone = typeof CARD_TONE.WARNING | typeof CARD_TONE.SUCCESS | typeof CARD_TONE.ERROR;

function toolTone(pending: boolean, failed: boolean): ToolTone {
	if (failed) return CARD_TONE.ERROR;
	return pending ? CARD_TONE.WARNING : CARD_TONE.SUCCESS;
}

function expansionSlot(state: unknown): Record<PropertyKey, unknown> | undefined {
	return state !== null && typeof state === "object" ? state as Record<PropertyKey, unknown> : undefined;
}

// Nothing to expand. A card offers the expand key, and takes a left click, only
// when expanding it shows something else: a call whose result already fits stays
// quiet instead of offering a no-op. Both halves of one row are measured where
// the row is actually drawn — a result only a narrow terminal wraps past the
// preview budget still counts as truncated — so the heading and the result halves
// answer together. Only the bash card opts in; every other quiet card keeps the
// key and the click it has always had. A host that shares no row state cannot pass
// the measurement along, so its card also keeps the affordance.
const CARD_REVEALS = Symbol.for("gentle-pi.card-reveals");

/** What one row of a card still has to show, measured at the width the row is drawn at. */
interface CardReveal {
	/** Whether expanding the call continues its heading on more rows. */
	heading?: (rowWidth: number) => boolean;
	/** Whether expanding shows result rows the collapsed preview does not. */
	body?: (rowWidth: number) => boolean;
}

/** This pass's measurement for the row, reused so either half may run first; both halves refresh their own closure every pass. */
function cardReveal(state: unknown): CardReveal | undefined {
	const slot = expansionSlot(state);
	if (slot === undefined) return undefined;
	const existing = slot[CARD_REVEALS] as CardReveal | undefined;
	if (existing !== undefined) return existing;
	const reveal: CardReveal = {};
	slot[CARD_REVEALS] = reveal;
	return reveal;
}

/** Whether expanding this row shows anything more; a host sharing no row state cannot tell, so its card keeps the key. */
function cardShowsMore(reveal: CardReveal | undefined, rowWidth: number): boolean {
	if (reveal === undefined) return true;
	return reveal.heading?.(rowWidth) === true || reveal.body?.(rowWidth) === true;
}

/** Physical rows a piece of card content needs at this width, before any preview budget clips it. */
function contentRows(text: string, width: number): number {
	return text === "" ? 0 : new Text(text, 0, 0).render(width).length;
}

/** Two renderings say the same thing when their visible text matches row for row. */
function sameText(a: string, b: string): boolean {
	const normalize = (text: string) => stripAnsi(text).split("\n").map((line) => line.trimEnd()).join("\n").trimEnd();
	return normalize(a) === normalize(b);
}

/**
 * The card's part in a click. Expansion belongs to the host: pi wraps every tool
 * row in a click region that toggles the row's own `expanded`, which is the same
 * state the card paints and the same state the expand key's global toggle applies
 * to every row. So a revealing click is left to that region rather than kept in an
 * override of our own: an override would leave the host believing the row was
 * still closed, and the next key press — which sets every row to the expansion the
 * transcript settles on — would appear to do nothing for a row that already looked
 * open. Without it the card and the key agree at every step, like pi's own rows.
 *
 * A click the card cannot show anything for is consumed instead, so the region
 * cannot toggle the row into a state a later resize or streamed tail would expose.
 * Only the click is taken: press, drag, release, wheel and other buttons stay with
 * the host, so dragging a text selection across the card is untouched.
 */
function cardClickResult(event: TuiMouseEvent, showsMore: boolean): TuiMouseEventResult | undefined {
	if (event.type !== "click" || event.button !== "left") return undefined;
	if (showsMore) return undefined;
	return { handled: true, render: false };
}

/** One settled frame per component: bounded memory, including all card chrome. */
class ToolCardRows {
	private frame?: { width: number; style: ReturnType<typeof cardStyle>; running: boolean; lines: string[] };

	render(width: number, running: boolean, build: () => string[]): string[] {
		const style = cardStyle();
		if (this.frame?.width === width && this.frame.style === style && this.frame.running === running) return this.frame.lines;
		const lines = build();
		this.frame = { width, style, running, lines };
		return lines;
	}

	invalidate(): void { this.frame = undefined; }
}

class ToolCardTop implements Component {
	private readonly rows = new ToolCardRows();
	private readonly heading: ToolCardHeading;
	private readonly tone: ToolTone;
	private readonly theme: CardTheme;
	private readonly hint: string | undefined;
	private readonly row: CardRowContext | undefined;
	private readonly reveal: CardReveal | undefined;
	/** Read on every pass, so a measurement the result half wrote first is never missed. */
	private readonly revealOf: (() => CardReveal | undefined) | undefined;
	private showsMore = true;

	constructor(heading: ToolCardHeading, tone: ToolTone, theme: CardTheme, hint?: string, row?: CardRowContext, reveal?: CardReveal, revealOf?: () => CardReveal | undefined) {
		this.heading = heading;
		this.tone = tone;
		this.theme = theme;
		this.hint = hint;
		this.row = row;
		this.reveal = reveal;
		this.revealOf = revealOf;
	}

	/** A left click on the heading toggles the card, like the expand key in its top rule. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return cardClickResult(event, this.showsMore);
	}

	/** The heading at one expansion level; `singleLine` is the collapsed form, and `hint` rides its rule. */
	private headRows(width: number, singleLine: boolean, hint: string | undefined): string[] {
		return headingRows(this.heading, this.tone, this.theme, singleLine, width, hint);
	}

	/** Renders `╭─ <icon> <title> · <detail> ── <hint> ╮`. A single-line heading keeps the card one row and ends an over-wide detail in an ellipsis; an expandable heading continues the complete detail on the rows below so every line of the call stays visible. The key only rides the rule when expanding the card shows something else. */
	render(width: number): string[] {
		const target = Math.max(0, Math.floor(width));
		if (target === 0) return [];
		const running = this.row !== undefined && cardAwaitingResult(this.row);
		return this.rows.render(target, running, () => floatRows(this.tone, this.theme, target, (inner) => {
			// Measured at the width this row is drawn at, with the chrome it is drawn in,
			// so a heading that only truncates because the terminal is narrow still counts.
			const measured = this.revealOf === undefined ? this.reveal : this.revealOf();
			this.showsMore = cardShowsMore(measured, inner);
			const hint = this.showsMore ? this.hint : undefined;
			return {
				head: this.headRows(inner, this.heading.singleLine === true, hint),
				body: running ? [cardRunningLine(this.tone, this.theme, inner)] : undefined,
				bottom: running ? cardBottom(this.tone, this.theme, inner) : undefined,
			};
		}, this.heading.railRole));
	}

	invalidate(): void { this.rows.invalidate(); }
}

class ToolCardBody implements Component {
	private readonly rows = new ToolCardRows();
	private readonly inner: () => Component;
	private readonly tone: ToolTone;
	private readonly theme: CardTheme;

	private readonly cacheable: boolean;
	private readonly elapsed: string | undefined;
	private readonly reveal: CardReveal | undefined;
	private readonly railRole: string | undefined;
	/** What the last drawn frame showed; a card with nothing left keeps the click with the host. */
	private showsMore = true;

	constructor(inner: () => Component, tone: ToolTone, theme: CardTheme, cacheable = true, elapsed?: string, reveal?: CardReveal, railRole?: string) {
		this.inner = inner;
		this.tone = tone;
		this.theme = theme;
		this.cacheable = cacheable;
		this.elapsed = elapsed;
		this.reveal = reveal;
		this.railRole = railRole;
	}

	/** A left click on the result rows toggles the card through the same state as its heading. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return cardClickResult(event, this.showsMore);
	}

	/** Renders the inner component between the card sides and closes the frame, even when the result has no rows. */
	render(width: number): string[] {
		const target = Math.max(0, Math.floor(width));
		if (target === 0) return [];
		const build = () => floatRows(this.tone, this.theme, target, (inner) => {
			// The same measurement the heading reads, at the width these rows are drawn at.
			this.showsMore = cardShowsMore(this.reveal, inner);
			return {
				body: this.inner().render(cardInnerWidth(inner)).map((line) => cardLine(line.trimEnd(), this.tone, this.theme, inner)),
				bottom: cardBottom(this.tone, this.theme, inner, this.elapsed),
				afterHeading: true,
			};
		}, this.railRole);
		return this.cacheable ? this.rows.render(target, false, build) : build();
	}

	invalidate(): void { this.rows.invalidate(); }
}

function shouldRenderPreviewTail(
	toolName: QuietToolName,
	text: string,
	isError: boolean,
	args: Record<string, unknown> | undefined,
): boolean {
	if (isError) return true;
	if (toolName !== "bash") return false;
	return isGitCommand(args) || semanticJsonPreview(text) === undefined;
}

function partialLabel(toolName: QuietToolName, text: string): string {
	const lineCount = countNonEmptyLines(text);
	return lineCount === 0
		? `… ${toolName}`
		: `… ${toolName} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

function hasImageContent(result: AgentToolResult<unknown>): boolean {
	return result.content.some((content) => content.type === "image");
}

function isRenderArgs(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedRenderContext(context: (Omit<ToolRenderContextLike, "args"> & { args?: unknown }) | undefined): ToolRenderContextLike {
	if (!context) return { args: {} };
	return {
		...context,
		args: sanitizedArgs(isRenderArgs(context.args) ? context.args : undefined),
		cwd: typeof context.cwd === "string" ? safeText(context.cwd) : context.cwd,
	};
}

type GentleAiDevBinaryOverrideResolver = () => GentleAiDevBinaryOverride | undefined;
function resolveQuietToolsDevBinaryPath(resolveOverride: GentleAiDevBinaryOverrideResolver): string | undefined {
	try { const path = resolveOverride()?.path; return typeof path === "string" && isAbsolute(path) ? path : undefined; }
	catch { return undefined; }
}

function gentleAiRenderTransition(
	args: Record<string, unknown> | undefined, context: ToolRenderContextLike | undefined,
	commandArguments: RegExp, options: { result?: boolean; isPartial?: boolean } = {},
): { operationPath?: string; directResult: boolean } {
	const state = getGentleAiRenderState(context?.state);
	const tokenization = shellTokens(typeof args?.command === "string" ? args.command : "");
	const directTokens = tokenization.kind === "generic" ? undefined : gentleAiCommandTokensFrom(tokenization.tokens, commandArguments);
	const operationPath = directTokens ? gentleAiOperationPathFrom(directTokens) : undefined;
	const argsComplete = context?.argsComplete === true;
	const forResult = options.result === true;
	const isPartial = options.isPartial === true || context?.isPartial === true;
	if (operationPath && (tokenization.kind === "complete" || !argsComplete) && state?.genericLocked !== true) {
		return { operationPath, directResult: forResult };
	}
	if (forResult && state?.lifecycleComponent === true && state.genericLocked !== true) return { directResult: true };
	if (state && (tokenization.kind === "generic" || argsComplete || (forResult && !isPartial))) {
		state.genericLocked = true; state.lifecycleComponent = false;
	}
	return { directResult: false };
}

/** Rendering-only factory; the default export attaches the Bash renderers to native Bash through pi.registerToolRenderer, so execution and schema stay pi's. */
export function createQuietToolRenderer(
	toolName: QuietToolName,
	resolveOverride: GentleAiDevBinaryOverrideResolver = () => undefined,
	timing: () => GentleAiElapsedTimingLedger | undefined = () => undefined,
	officialRenderResult?: ToolDefinition["renderResult"],
): QuietToolRenderer {
	const commandArguments = () => createGentleAiCommandArguments(resolveQuietToolsDevBinaryPath(resolveOverride));
	const withElapsedTiming = (context: GentleAiRenderContext): GentleAiRenderContext => {
		const ledger = timing();
		return ledger ? { ...context, elapsedTiming: ledger } : context;
	};

	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const callArgs = args as Record<string, unknown>;
			const renderContext = sanitizedRenderContext(context);
			const operationPath = toolName === "bash"
				? gentleAiRenderTransition(callArgs, renderContext, commandArguments()).operationPath
				: undefined;
			if (operationPath) {
				const detail = renderContext.expanded === true && typeof callArgs.command === "string" ? `$ ${callArgs.command}` : undefined;
				return renderGentleAiLifecycleCall(operationPath, theme, withElapsedTiming(renderContext as GentleAiRenderContext), detail);
			}
			const tone = toolTone(renderContext.isPartial !== false, renderContext.isError === true);
			// Same place and wording as the Gentle AI card: the expand key rides the top
			// rule once the call finished. Pi flips isPartial to false only with a result,
			// so a card rebuilt from a stored session is finished too, even though Pi never
			// saw the call start. The host owns expansion, so a left click moves that state.
			const expanded = renderContext.expanded === true;
			const finished = renderContext.isPartial === false;
			const hint = finished ? stripAnsi(keyHint("app.tools.expand", expanded ? "to collapse" : "to expand")) : undefined;
			const heading = toolName === "bash"
				? bashHeading(callArgs, theme, expanded)
				: { title: formatToolCall(toolName, callArgs, theme), glyph: TOOL_GLYPH[toolName] };
			// Only the bash card withholds a no-op expansion; every other quiet card
			// keeps the key and the click it has always had.
			const revealOf = toolName === "bash" ? () => cardReveal(renderContext.state) : undefined;
			const reveal = revealOf?.();
			// A heading that folds its own detail always draws two different rows, so the
			// comparison would always claim something to reveal. Such a card measures its
			// body instead, which is where the rest of the call actually lives.
			if (reveal) reveal.heading = (rowWidth) => !sameText(
				headingRows({ ...heading, collapsedDetail: undefined }, tone, theme, true, rowWidth).join("\n"),
				headingRows(heading, tone, theme, false, rowWidth).join("\n"),
			);
			return new ToolCardTop(heading, tone, theme, hint, renderContext, reveal, revealOf);
		},
		/** Builds the card component for this render pass; collapsed cards delegate to the wrapped-line cache keyed by the tool result object. */
		renderResult(result, options, theme, context) {
			const renderContext = context ? sanitizedRenderContext(context) : undefined;
			markCardResult(renderContext?.state);
			const cacheKey = typeof result === "object" && result !== null ? result : undefined;
			const safeResult = sanitizedResult(result);
			const text = safeText(extractTextContent(safeResult));
			// Current Pi carries errors on the context. Older renderer callers
			// supplied them on options; keep that structural fallback for those hosts.
			const legacyError = "isError" in options && options.isError === true;
			const isError = renderContext?.isError ?? legacyError;
			const directResult = toolName === "bash" && gentleAiRenderTransition(
				renderContext?.args,
				renderContext,
				commandArguments(),
				{ result: true, isPartial: options.isPartial },
			).directResult;
			if (directResult) {
				return renderGentleAiResult(safeResult, { expanded: options.expanded, isPartial: options.isPartial, isError }, theme, renderContext ? withElapsedTiming(renderContext as GentleAiRenderContext) : undefined);
			}
			const resultTone = toolTone(options.isPartial === true, isError);
			// Bash reports how long a finished call took on its closing rule; a partial
			// call has no duration yet, and every other quiet card keeps the closing
			// rule it has always had.
			const elapsed = toolName === "bash" && options.isPartial !== true ? cardElapsed(renderContext?.durationMs) : undefined;
			const expanded = options.expanded;
			const revealOf = toolName === "bash" ? () => cardReveal(renderContext?.state) : undefined;
			const reveal = revealOf?.();
			// The result continues the heading's card, so a card whose heading names a rail
			// keeps that rail, derived from the same retained call the heading read.
			const railRole = toolName === "bash" ? bashIdentity(renderContext?.args).titleRole : undefined;
			const carded = (component: () => Component, cacheable = options.isPartial !== true): Component => new ToolCardBody(component, resultTone, theme, cacheable, elapsed, reveal, railRole);
			// Under the minimal Card content preference, every quiet tool draws
			// the command alone while collapsed; the expand key still reveals
			// the full result. Failures keep their bounded error tail so a red
			// card always says why. The default preference keeps the previews.
			const withheld = COMMAND_ONLY_TOOLS.has(toolName) && !isError && cardContent() === CARD_CONTENT.MINIMAL;
			// Both levels are known here, so the card knows whether expanding shows more,
			// measured where the rows are drawn (wrapping at a narrow width hides rows too).
			const collapsedRows = quietResultRows(toolName, safeResult, text, { expanded: false, isError, args: renderContext?.args, withheld });
			const expandedRows = quietResultRows(toolName, safeResult, text, { expanded: true, isError, args: renderContext?.args, withheld });
			// A versioning preview judges its own text, so its `reveals` is authoritative
			// there; every other preview is compared level against level. Either way the
			// rows are measured where they are drawn, because wrapping at a narrow width
			// hides rows too: a preview whose text is the whole output still leaves rows
			// behind the key once those rows no longer fit, and expanding draws them.
			if (reveal) reveal.body = (rowWidth) => {
				const overflows = contentRows(collapsedRows.text, cardInnerWidth(rowWidth)) > PREVIEW_LINE_LIMIT;
				if (collapsedRows.reveals !== undefined) return collapsedRows.reveals || overflows;
				return collapsedRows.text !== expandedRows.text || overflows;
			};
			if (!expanded && withheld) return carded(() => new Text("", 0, 0));
			if (options.isPartial) {
				const label = partialLabel(toolName, text);
				const visible = lastOutputLines(text, PREVIEW_LINE_LIMIT);
				if (reveal) reveal.body = (rowWidth) => !sameText(`${label}\n${visible}`, `${label}\n${text}`) || contentRows(`${label}\n${visible}`, cardInnerWidth(rowWidth)) > PREVIEW_LINE_LIMIT;
				if (expanded) return carded(() => new Text(`${theme.fg("warning", label)}\n${theme.fg("muted", text)}`, 0, 0));
				return carded(() => new BoundedRows([
					{ text: theme.fg("warning", label), rows: 1 },
					...(visible ? [{ text: theme.fg("muted", visible), rows: PREVIEW_LINE_LIMIT, tail: true }] : []),
				], cacheKey));
			}
			if (expanded && toolName === "read" && hasImageContent(safeResult) && officialRenderResult) {
				return carded(() => officialRenderResult(
					safeResult,
					options,
					theme,
					{ ...sanitizedRenderContext(renderContext), lastComponent: undefined } as any,
				), false);
			}
			const color = isError ? "error" : expanded ? "toolOutput" : "muted";
			if (expanded) return carded(() => new Text(expandedRows.text ? theme.fg(color, expandedRows.text) : "", 0, 0));
			if (collapsedRows.text) {
				return carded(() => new BoundedRows([
					{ text: theme.fg(color, collapsedRows.text), rows: PREVIEW_LINE_LIMIT, tail: collapsedRows.tail },
				], cacheKey));
			}
			// The card top rule carries the expand key, so an empty result only closes the frame.
			return carded(() => new Text("", 0, 0));
		},
	};
}

// CodeGraph draws its own row (`renderShell: "self"`) and ships no card, so quiet
// tools supplies one through the same resolver that redraws bash. The tool keeps its
// execution, schema and timeouts; only the drawing is Gentle's, and the summary it
// collapses to is shared with the same program run through bash.
/** The CodeGraph heading: the tool's own mark, name and role, with the operation and query from the call's arguments. */
function codeGraphHeading(args: Record<string, unknown>, theme: ThemeLike, expanded: boolean): ToolCardHeading {
	const operation = asString(args.operation, "...");
	const query = asString(args.query);
	return {
		title: theme.bold(CODEGRAPH_TOOL),
		subtitle: codegraphCallDetail({ operation, ...(query.length > 0 ? { query } : {}) }),
		glyph: CODEGRAPH_MARK,
		titleRole: CODEGRAPH_TITLE_ROLE,
		railRole: CODEGRAPH_TITLE_ROLE,
		singleLine: !expanded,
	};
}

/** Rendering-only factory for the CodeGraph card; the tool keeps its own execution, schema, and timeouts. */
export function createCodeGraphCardRenderer(): QuietToolRenderer {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const renderContext = sanitizedRenderContext(context);
			const tone = toolTone(renderContext.isPartial !== false, renderContext.isError === true);
			const expanded = renderContext.expanded === true;
			// Same rule as every quiet card: only the final result says the call finished,
			// because a host replaying a stored transcript never starts it.
			const hint = renderContext.isPartial === false
				? stripAnsi(keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"))
				: undefined;
			const heading = codeGraphHeading(isRenderArgs(args) ? args : {}, theme, expanded);
			const reveal = cardReveal(renderContext.state);
			if (reveal) reveal.heading = (rowWidth) => !sameText(headingRows(heading, tone, theme, true, rowWidth).join("\n"), headingRows(heading, tone, theme, false, rowWidth).join("\n"));
			return new ToolCardTop(heading, tone, theme, hint, renderContext, reveal);
		},
		renderResult(result, options, theme, context) {
			const renderContext = context ? sanitizedRenderContext(context) : undefined;
			markCardResult(renderContext?.state);
			const cacheKey = typeof result === "object" && result !== null ? result : undefined;
			const safeResult = sanitizedResult(result);
			const details = detailsRecord(safeResult);
			const operation = asString(renderContext?.args?.operation) || asString(details.operation);
			const text = safeText(extractTextContent(safeResult));
			// The tool reports a failed or unavailable run as an ordinary result with a
			// recorded status, while the host flags a thrown call on its context (older
			// hosts still put the flag on the options). Either one is a failure here.
			const legacyError = "isError" in options && options.isError === true;
			const failed = (renderContext?.isError ?? legacyError) || typeof details.status === "string";
			const tone = toolTone(options.isPartial === true, failed);
			const elapsed = cardElapsed(renderContext?.durationMs);
			const expanded = options.expanded;
			const reveal = cardReveal(renderContext?.state);
			// The result continues the heading's card, so it keeps the rail the tool's
			// own label paints instead of falling back to the call's status tone.
			const railRole = CODEGRAPH_TITLE_ROLE;
			const carded = (component: () => Component, cacheable = options.isPartial !== true): Component => new ToolCardBody(component, tone, theme, cacheable, elapsed, reveal, railRole);
			// Both levels are known here, so the card knows whether expanding shows more,
			// measured where the rows are drawn (wrapping at a narrow width hides rows too).
			const withheld = cardContent() === CARD_CONTENT.MINIMAL;
			const collapsed = codeGraphCollapsedRows(operation, text, failed, withheld);
			if (reveal) reveal.body = (rowWidth) => {
				const rows = collapsed?.text ?? "";
				return !sameText(rows, text) || contentRows(rows, cardInnerWidth(rowWidth)) > (collapsed?.rows ?? PREVIEW_LINE_LIMIT);
			};
			// Minimal cards keep the heading alone; a failure always says why.
			if (withheld && !expanded && !failed) return carded(() => new Text("", 0, 0));
			if (options.isPartial) {
				const visible = codeGraphPreview(text);
				if (reveal) reveal.body = (rowWidth) => !sameText(visible, text) || contentRows(visible, cardInnerWidth(rowWidth)) > PREVIEW_LINE_LIMIT;
				return carded(() => new BoundedRows([
					...(visible ? [{ text: theme.fg("muted", visible), rows: PREVIEW_LINE_LIMIT, tail: true }] : []),
				], cacheKey));
			}
			if (expanded) return carded(() => new Text(text ? theme.fg(failed ? "error" : "toolOutput", text) : "", 0, 0));
			if (collapsed === undefined) return carded(() => new Text("", 0, 0));
			return carded(() => new BoundedRows([
				{ text: theme.fg(failed ? "error" : "muted", collapsed.text), rows: collapsed.rows, tail: collapsed.tail },
			], cacheKey));
		},
	};
}

/** A card this load handed the host, with the answer to whether the chat draws it right now. */
interface PublishedQuietToolRenderer {
	renderer: QuietToolRenderer;
	active(): boolean;
	/** Whether a reader may cache the rows this card draws; only a card that always draws the same thing for the same result may set it. */
	rowStable?: boolean;
}

// Pi loads extensions with `moduleCache: false`, so one process can hold two copies
// of this module; the process-wide slot is where they meet. A consumer that wants
// this extension's drawing finds the very card handed to the host there, never a
// lookalike of its own that could drift from the registration.
const PUBLISHED_TOOL_RENDERERS = Symbol.for("gentle-pi.quiet-tool-renderers");
const publishedRendererState = globalThis as typeof globalThis & { [PUBLISHED_TOOL_RENDERERS]?: Map<string, PublishedQuietToolRenderer> };

function publishedQuietToolRenderers(): Map<string, PublishedQuietToolRenderer> {
	const existing = publishedRendererState[PUBLISHED_TOOL_RENDERERS];
	if (existing !== undefined) return existing;
	const created = new Map<string, PublishedQuietToolRenderer>();
	publishedRendererState[PUBLISHED_TOOL_RENDERERS] = created;
	return created;
}

/**
 * Stores the one card this load draws for `toolName` and returns that stored
 * record, so every later resolve and every other consumer hold one object instead
 * of a fresh card per call. `drawing` answers whether the chat draws the card right
 * now; a card whose resolve always returns it keeps the default.
 */
function publishQuietToolRenderer(toolName: string, card: () => QuietToolRenderer, drawing: () => boolean = () => true): PublishedQuietToolRenderer {
	const published = publishedQuietToolRenderers();
	const existing = published.get(toolName);
	if (existing !== undefined) return existing;
	const created: PublishedQuietToolRenderer = { renderer: card(), active: drawing, rowStable: true };
	published.set(toolName, created);
	return created;
}

function registerQuietTool(pi: ExtensionAPI, toolName: RegisteredToolName, resolveOverride: GentleAiDevBinaryOverrideResolver, timing: () => GentleAiElapsedTimingLedger | undefined): void {
	const registrationTool = getBuiltInTools(process.cwd())[toolName];
	pi.registerTool({
		...registrationTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd)[toolName].execute(toolCallId, params, signal, onUpdate, ctx);
		},
		...createQuietToolRenderer(toolName, resolveOverride, timing, registrationTool.renderResult),
	});
}

export default function quietTools(
	pi: ExtensionAPI,
	resolveOverride: GentleAiDevBinaryOverrideResolver = () => resolveGentleAiDevBinaryOverride(),
	codemodeOptOut: Omit<BuiltinCodemodeOptOutOptions, "effectiveExtensions"> = {},
): ReturnType<ExtensionFactory> {
	// A fresh load replaces whatever an earlier instance published, so a disabled
	// extension leaves nothing behind for a second consumer to reuse.
	publishedQuietToolRenderers().clear();
	if (!quietToolsEnabled()) return;
	let elapsedTiming: GentleAiElapsedTimingLedger | undefined;
	// Every card this load can draw, by the name pi asks the resolver for, created and
	// published now: another extension drawing a child's bash or CodeGraph call reads
	// them before the chat itself resolves one. A tool added to this table is published
	// by the same step, and the resolver below hands over what it stored here.
	const cards: Record<string, () => QuietToolRenderer> = {
		bash: () => createQuietToolRenderer("bash", resolveOverride, () => elapsedTiming),
		[CODEGRAPH_TOOL]: () => createCodeGraphCardRenderer(),
	};
	for (const [toolName, card] of Object.entries(cards)) publishQuietToolRenderer(toolName, card);
	let codemodeOptOutOffered = false;
	pi.on("session_start", (_event, ctx) => {
		elapsedTiming = new GentleAiElapsedTimingLedger(ctx.sessionManager, pi);
		// The compact codemode below displaces Pi's builtin, which makes Pi warn
		// at startup. Offer the settings opt-out once per process, detached so
		// the dialog never holds up startup; the offer itself never throws.
		if (codemodeOptOutOffered) return;
		codemodeOptOutOffered = true;
		let effectiveExtensions: unknown;
		try { effectiveExtensions = pi.getSettings().extensions; } catch { /* Fall back to the settings file alone. */ }
		void offerBuiltinCodemodeOptOut(ctx, { ...codemodeOptOut, effectiveExtensions });
	});
	// Only bash calls that render as gentle-ai cards carry a durable duration;
	// every other quiet tool keeps its plain renderer and writes no entries.
	const recordGentleTiming = (event: { toolCallId: string; toolName: string; args?: unknown }, endedAt?: number): void => {
		const ledger = elapsedTiming;
		if (!ledger || event.toolName !== "bash" || !isGentleAiDirectCommand(event.args as Record<string, unknown> | undefined, createGentleAiCommandArguments(resolveQuietToolsDevBinaryPath(resolveOverride)))) return;
		try {
			if (endedAt === undefined) ledger.recordStart(event.toolCallId, Date.now());
			else ledger.recordEnd(event.toolCallId, endedAt);
		} catch { /* Timing persistence is best-effort and never breaks the tool event. */ }
	};
	pi.on("tool_execution_start", (event) => recordGentleTiming(event));
	pi.on("tool_execution_end", (event) => recordGentleTiming(event, Date.now()));
	const withElapsedTiming = (context: GentleAiRenderContext): GentleAiRenderContext =>
		elapsedTiming ? { ...context, elapsedTiming } : context;
	for (const toolName of Object.keys(TOOL_CREATORS) as RegisteredToolName[]) {
		registerQuietTool(pi, toolName, resolveOverride, () => elapsedTiming);
	}
	// Native Bash keeps pi's execution and schema; only its drawing becomes a
	// Gentle card, so quiet bash rows match the other tools at both Card
	// content levels and can carry the phase inferred from the command. The
	// resolver API is newer than this package's pinned pi types, so it is
	// probed structurally; hosts without it keep pi's native bash rendering.
	const host = pi as typeof pi & { registerToolRenderer?: (resolver: (toolName: string, next: () => unknown) => unknown) => void };
	if (typeof host.registerToolRenderer === "function") {
		host.registerToolRenderer((toolName, next) => {
			const card = cards[toolName];
			return card === undefined ? next() : publishQuietToolRenderer(toolName, card).renderer;
		});
	}
	return registerCompactCodemode(pi);
}
