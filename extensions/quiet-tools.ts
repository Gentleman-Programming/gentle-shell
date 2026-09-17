import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadToolDefinition,
	createWriteTool,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { resolveGentleAiDevBinaryOverride, type GentleAiDevBinaryOverride } from "../lib/gentle-ai-binary.ts";
import { quietToolsEnabled } from "../lib/quiet-tools-config.ts";
import { getGentleAiRenderState, renderGentleAiLifecycleCall, renderGentleAiResult, type GentleAiRenderContext } from "../lib/gentle-ai-renderer.ts";
import { sanitizeTerminalText } from "../lib/terminal-theme.ts";

type QuietToolName = "read" | "bash" | "grep" | "find" | "ls" | "edit" | "write";
type ThemeLike = {
	bold(value: string): string;
	fg(color: string, value: string): string;
};

const TOOL_CREATORS = {
	read: createReadToolDefinition,
	bash: createBashTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
	edit: createEditTool,
	write: createWriteTool,
} satisfies Record<QuietToolName, (cwd: string) => any>;

const COLLAPSED_COUNT_LABELS: Partial<Record<QuietToolName, string>> = {
	grep: "matches",
	find: "files",
	ls: "entries",
};

const COLLAPSED_TAIL_LINE_LIMIT = 10;
const PREVIEW_LINE_LIMIT = 3;

const EMPTY_RESULT_MESSAGES: Partial<Record<QuietToolName, string[]>> = {
	grep: ["No matches found"],
	find: ["No files found matching pattern"],
	ls: ["Directory is empty", "(empty directory)"],
	bash: ["(no output)"],
};

const toolCache = new Map<string, Record<QuietToolName, any>>();

function createBuiltInTools(cwd: string): Record<QuietToolName, any> {
	return Object.fromEntries(
		(Object.entries(TOOL_CREATORS) as [QuietToolName, (cwd: string) => any][]).map(
			([name, createTool]) => [name, createTool(cwd)],
		),
	) as Record<QuietToolName, any>;
}

function getBuiltInTools(cwd: string): Record<QuietToolName, any> {
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

export type GentleAiRoutineCommand = "sdd-status" | "sdd-continue" | "sdd-attempt" | "review";

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
const SDD_ATTEMPT_VERBS = new Set(["grant"]);

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

function authorizationRootCount(tokens: string[]): number {
	let count = 0;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--authorization-root") {
			const value = tokens[index + 1];
			if (value !== undefined && !value.startsWith("-")) count += 1;
			continue;
		}
		if (token.startsWith("--authorization-root=") && token.slice("--authorization-root=".length).length > 0) {
			count += 1;
		}
	}
	return count;
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
 * gentle-ai. These commands otherwise emit machine-readable SDD/RDD data.
 */
export function isGentleAiDirectCommand(args: Record<string, unknown> | undefined, commandArguments = GENTLE_AI_COMMAND_ARGUMENTS): boolean {
	return gentleAiCommandTokens(args, commandArguments) !== undefined;
}

export function gentleAiRoutineCommand(args: Record<string, unknown> | undefined, commandArguments = GENTLE_AI_COMMAND_ARGUMENTS): GentleAiRoutineCommand | undefined {
	const tokens = gentleAiCommandTokens(args, commandArguments);
	if (!tokens) return undefined;
	if (tokens[0] === "sdd-status") return "sdd-status";
	if (tokens[0] === "sdd-continue") return "sdd-continue";
	if (tokens[0] === "sdd-attempt" && SDD_ATTEMPT_VERBS.has(tokens[1] ?? "")) return "sdd-attempt";
	if (tokens[0] === "review") return "review";
	return undefined;
}

function gentleAiOperationPathFrom(tokens: string[]): string {
	if (tokens[0] === "sdd-status") return "sdd status";
	if (tokens[0] === "sdd-continue") return "sdd continue";
	if (tokens[0] === "sdd-attempt") {
		const verb = tokens[1] ?? "";
		if (!SDD_ATTEMPT_VERBS.has(verb)) return "sdd attempt";
		const rootCount = authorizationRootCount(tokens);
		return rootCount > 0
			? `sdd attempt grant · ${rootCount} root${rootCount === 1 ? "" : "s"}`
			: "sdd attempt grant";
	}
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

export function isGentleAiGrantCommand(args: Record<string, unknown> | undefined, commandArguments = GENTLE_AI_COMMAND_ARGUMENTS): boolean {
	const tokens = gentleAiCommandTokens(args, commandArguments);
	return tokens?.[0] === "sdd-attempt" && tokens[1] === "grant";
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
		const detail = expandedResultText(toolName, result, text);
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

function lineRangeSuffix(args: Record<string, unknown>, theme: ThemeLike): string {
	if (args.offset === undefined && args.limit === undefined) return "";
	const startLine = typeof args.offset === "number" ? args.offset : 1;
	const endLine = typeof args.limit === "number" ? startLine + args.limit - 1 : undefined;
	return theme.fg("warning", `:${startLine}${endLine === undefined ? "" : `-${endLine}`}`);
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
	[key: string]: unknown;
}

function formatToolCall(toolName: QuietToolName, args: Record<string, unknown>, theme: ThemeLike): string {
	switch (toolName) {
		case "read": {
			const path = safeText(shortenPath(args.path) || "...");
			return `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}${lineRangeSuffix(args, theme)}`;
		}
		case "bash": {
			const command = safeText(asString(args.command, "..."));
			const timeout = typeof args.timeout === "number" ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			return `${theme.fg("toolTitle", theme.bold(`$ ${command}`))}${timeout}`;
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

class BoundedRows implements Component {
	private readonly sections: readonly BoundedRowSection[];

	constructor(sections: readonly BoundedRowSection[]) {
		this.sections = sections;
	}

	render(width: number): string[] {
		return this.sections.flatMap(({ text, rows, tail = false }) => {
			if (rows <= 0) return [];
			const rendered = new Text(text, 0, 0).render(width);
			return tail ? rendered.slice(-rows) : rendered.slice(0, rows);
		});
	}

	invalidate(): void {}
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

function hasExpandableContent(toolName: QuietToolName, result: AgentToolResult<unknown>, text: string): boolean {
	if (isEmptyResultMessage(toolName, text)) return false;
	if (text.length > 0 || hasImageContent(result)) return true;
	const diff = detailsRecord(result).diff;
	return toolName === "edit" && typeof diff === "string" && diff.length > 0;
}

function sanitizedRenderContext(context: ToolRenderContextLike | undefined): ToolRenderContextLike {
	if (!context) return { args: {} };
	return {
		...context,
		args: sanitizedArgs(context.args),
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

function registerQuietTool(pi: ExtensionAPI, toolName: QuietToolName, commandArguments: () => RegExp): void {
	const registrationTool = getBuiltInTools(process.cwd())[toolName];
	const officialRenderResult = registrationTool.renderResult;

	pi.registerTool({
		...registrationTool,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const runtimeTool = getBuiltInTools(ctx.cwd)[toolName];
			return runtimeTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const callArgs = args as Record<string, unknown>;
			const renderContext = sanitizedRenderContext(context as ToolRenderContextLike | undefined);
			const operationPath = toolName === "bash"
				? gentleAiRenderTransition(callArgs, renderContext, commandArguments()).operationPath
				: undefined;
			if (operationPath) {
				const detail = renderContext.expanded === true && typeof callArgs.command === "string" ? `$ ${callArgs.command}` : undefined;
				return renderGentleAiLifecycleCall(operationPath, theme, renderContext as GentleAiRenderContext, detail);
			}
			return new Text(formatToolCall(toolName, callArgs, theme), 0, 0);
		},
		renderResult(result, options, theme, context) {
			const renderContext = context as ToolRenderContextLike | undefined;
			const safeResult = sanitizedResult(result);
			const text = safeText(extractTextContent(safeResult));
			const isError = renderContext?.isError ?? options.isError ?? false;
			const directResult = toolName === "bash" && gentleAiRenderTransition(
				renderContext?.args,
				renderContext,
				commandArguments(),
				{ result: true, isPartial: options.isPartial },
			).directResult;
			if (directResult) {
				return renderGentleAiResult(safeResult, { expanded: options.expanded, isPartial: options.isPartial, isError }, theme, renderContext as GentleAiRenderContext | undefined);
			}
			if (options.isPartial) {
				if (options.expanded) return new Text(`${theme.fg("warning", partialLabel(toolName, text))}\n${theme.fg("muted", text)}`, 0, 0);
				const visible = lastOutputLines(text, PREVIEW_LINE_LIMIT);
				return new BoundedRows([
					{ text: theme.fg("warning", partialLabel(toolName, text)), rows: 1 },
					...(visible ? [{ text: theme.fg("muted", visible), rows: PREVIEW_LINE_LIMIT, tail: true }] : []),
				]);
			}
			if (options.expanded && toolName === "read" && hasImageContent(safeResult) && officialRenderResult) {
				return officialRenderResult(
					safeResult,
					options,
					theme,
					sanitizedRenderContext(renderContext) as any,
				);
			}
			const output = formatToolResultOutput(toolName, safeResult, {
				expanded: options.expanded,
				isError,
				args: renderContext?.args,
			});
			const hint = !options.expanded && !directResult && hasExpandableContent(toolName, safeResult, text)
				? `\n${keyHint("app.tools.expand", "to expand")}`
				: "";
			const color = options.expanded ? "toolOutput" : isError ? "error" : "muted";
			if (options.expanded) return new Text(output ? theme.fg(color, output) : "", 0, 0);
			if (output) {
				const tail = shouldRenderPreviewTail(toolName, text, isError, renderContext?.args);
				return new BoundedRows([
					{ text: theme.fg(color, output.replace(/^\n/, "")), rows: PREVIEW_LINE_LIMIT, tail },
					...(hint ? [{ text: theme.fg(color, hint.slice(1)), rows: 1 }] : []),
				]);
			}
			return new Text(hint ? theme.fg(color, hint.slice(1)) : "", 0, 0);
		},
	});
}

export default function quietTools(pi: ExtensionAPI, resolveOverride: GentleAiDevBinaryOverrideResolver = () => resolveGentleAiDevBinaryOverride()): void {
	if (!quietToolsEnabled()) return;
	for (const toolName of Object.keys(TOOL_CREATORS) as QuietToolName[]) {
		registerQuietTool(pi, toolName, () => createGentleAiCommandArguments(resolveQuietToolsDevBinaryPath(resolveOverride)));
	}
}
