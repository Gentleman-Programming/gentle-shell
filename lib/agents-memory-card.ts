import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolItem } from "./agents-protocol.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

/**
 * Every tool an Engram memory plugin registers is named under this prefix. The
 * chat's memory chrome belongs to that plugin, which registers its renderers with
 * the host and publishes nothing another extension can read; the Agents pane can
 * only recognize the namespace and draw the retained call and result itself.
 */
export const MEMORY_TOOL_PREFIX = "mem_";

/** The plugin's own memory identity, so the rows read as one kind of call. */
const MEMORY_GLYPH = "🧠";

/** The ellipsis the plugin closes its call row with: the style, not a truncation. */
const CALL_ELLIPSIS = "…";

/** The plugin names a call with at most this much of its argument. */
const ARGUMENT_WIDTH = 48;

/** A failed call reports one bounded line, never a stack or a JSON dump. */
const FAILURE_WIDTH = 64;

const RESULT_MARKER = "↳ ";
const RESULT_ROLE = "muted";
const SUCCESS_GLYPH = "✓";
const FAILURE_GLYPH = "✗";

/** Retained call fields the plugin prints as `#<value>` instead of a quoted name. */
const ID_ARGUMENTS = new Set(["id", "observation_id", "memory_id_a", "memory_id_b"]);

export interface MemoryCardTheme {
	fg(color: string, text: string): string;
}

/**
 * The plugin's compact design per memory tool: the retained call fields that name
 * the call, first present won, and the one-word status it reports once the call
 * finished. `withId` is the status the plugin writes when the call itself carries
 * `idField`; without it the plugin reports the id from a result `details` this
 * pane never receives, so the bare status is the most it may claim.
 */
interface MemoryToolDesign {
	argument: readonly string[];
	status: string;
	idField?: string;
	withId?: string;
}

const MEMORY_TOOL_DESIGN: Record<string, MemoryToolDesign> = {
	search: { argument: ["query"], status: "results" },
	save: { argument: ["title", "type"], status: "saved", idField: "id", withId: "saved" },
	update: { argument: ["id", "title"], status: "updated", idField: "id", withId: "updated" },
	consolidate: { argument: ["new_title"], status: "done" },
	delete: { argument: ["id"], status: "deleted", idField: "id", withId: "deleted" },
	suggest_topic_key: { argument: ["title", "type"], status: "suggested" },
	save_prompt: { argument: ["content"], status: "prompt saved" },
	session_summary: { argument: ["content"], status: "saved", idField: "id", withId: "saved" },
	session_finalize: { argument: ["project"], status: "done" },
	finalize_session: { argument: ["project"], status: "done" },
	context: { argument: ["project", "scope"], status: "loaded" },
	stats: { argument: ["project"], status: "loaded" },
	timeline: { argument: ["observation_id"], status: "timeline" },
	get_observation: { argument: ["id"], status: "loaded", idField: "id", withId: "observation" },
	session_start: { argument: ["id"], status: "started" },
	session_end: { argument: ["id"], status: "ended" },
	current_project: { argument: ["cwd"], status: "detected" },
	doctor: { argument: ["check", "project"], status: "checked" },
	capture_passive: { argument: ["source", "content"], status: "captured" },
	judge: { argument: ["judgment_id", "relation"], status: "judged" },
	judge_many: { argument: [], status: "judged" },
	compare: { argument: ["memory_id_a", "memory_id_b"], status: "compared" },
	review: { argument: [], status: "reviewed" },
	list_projects: { argument: ["org"], status: "done" },
	pin: { argument: ["id"], status: "done" },
	unpin: { argument: ["id"], status: "done" },
};

/** A tool the plugin adds later keeps its label and claims only that it finished. */
const UNKNOWN_TOOL_DESIGN: MemoryToolDesign = { argument: [], status: "done" };

/** Whether `name` belongs to the memory tool namespace rather than to another tool. */
export function isMemoryToolName(name: string): boolean {
	return name.startsWith(MEMORY_TOOL_PREFIX) && name.length > MEMORY_TOOL_PREFIX.length;
}

/** The tool's own name inside the namespace, e.g. `get_observation`. */
function memoryToolName(name: string): string {
	return name.startsWith(MEMORY_TOOL_PREFIX) ? name.slice(MEMORY_TOOL_PREFIX.length) : name;
}

function design(name: string): MemoryToolDesign {
	return MEMORY_TOOL_DESIGN[memoryToolName(name)] ?? UNKNOWN_TOOL_DESIGN;
}

/**
 * `text` cut to `width`, with every escape removed again: pi-tui closes a cut row
 * with a reset, and a memory row carries that only as the theme's own paint. The
 * visible width is unchanged, so the bound and the fit both still hold.
 */
function clip(text: string, width: number): string {
	return sanitizeTerminalText(truncateToWidth(text, Math.max(1, width), "…"));
}

/** `mem_get_observation` reads `get observation`, the name the plugin shows. */
export function memoryToolLabel(name: string): string {
	const label = sanitizeTerminalText(memoryToolName(name)).replace(/_/g, " ").trim();
	return label.length > 0 ? label : sanitizeTerminalText(name);
}

/** One retained argument value, or `undefined` when the call left it empty. */
function scalar(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const text = sanitizeTerminalText(String(value)).replace(/\s+/g, " ").trim();
	return text.length === 0 ? undefined : text;
}

function quoted(key: string): string {
	return `“${clip(key, ARGUMENT_WIDTH)}”`;
}

/** The plugin quotes a name and prefixes an id with `#`. */
function argumentValue(key: string, text: string): string {
	return ID_ARGUMENTS.has(key) ? `#${clip(text, ARGUMENT_WIDTH)}` : quoted(text);
}

/** `mem_review` names its call from several fields, skipping the ones it lacks. */
function reviewArgument(args: Record<string, unknown> | undefined): string | undefined {
	const parts: string[] = [];
	const action = scalar(args?.action);
	if (action !== undefined) parts.push(quoted(action));
	const id = scalar(args?.observation_id) ?? scalar(args?.id);
	if (id !== undefined) parts.push(`#${clip(id, ARGUMENT_WIDTH)}`);
	const project = scalar(args?.project);
	if (project !== undefined) parts.push(quoted(project));
	const limit = scalar(args?.limit);
	if (limit !== undefined) parts.push(`limit ${limit}`);
	return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * The one argument a compact memory row names its call with: the first field the
 * plugin reads for that tool that the retained call actually carries. Nothing else
 * is looked up — no value is invented for a call that did not send it — and a call
 * with no such field is named by its label alone.
 */
export function memoryToolArgument(name: string, args: Record<string, unknown> | undefined): string | undefined {
	if (memoryToolName(name) === "review") return reviewArgument(args);
	for (const key of design(name).argument) {
		const text = scalar(args?.[key]);
		if (text !== undefined) return argumentValue(key, text);
	}
	return undefined;
}

/** The status the plugin reports for a finished call, as far as the call itself says. */
function statusWord(name: string, args: Record<string, unknown> | undefined): string {
	const spec = design(name);
	const id = spec.idField === undefined ? undefined : scalar(args?.[spec.idField]);
	return id === undefined ? spec.status : `${spec.withId ?? spec.status} #${id}`;
}

/** A failure reports its first retained words, never the stack behind them. */
function failureSummary(output: string): string {
	const first = output.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).find((line) => line.length > 0);
	return first === undefined ? "" : clip(first, FAILURE_WIDTH);
}

function painted(theme: MemoryCardTheme, role: string, text: string, width: number): string {
	return theme.fg(role, clip(text, width));
}

/**
 * One memory call drawn in the plugin's compact design, from the retained call and
 * result alone: always the call row, then the plugin's own status once the call
 * finished. There is no preview, no body and no expansion — the plugin has none.
 *
 * This is deliberately not a copy of the plugin's renderer and never claims to be
 * one: it states only the arguments and outcome the thread retained, so it cannot
 * report an observation id, a count or a result the call did not carry. The caller
 * draws it only when no real renderer was offered for the tool, and a real
 * renderer always wins.
 */
export function memoryToolCard(item: ToolItem, theme: MemoryCardTheme, width: number): string[] {
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return [];
	const argument = memoryToolArgument(item.name, item.args);
	const head = [MEMORY_GLYPH, memoryToolLabel(item.name), ...(argument === undefined ? [] : [argument])].join(" ");
	const rows = [painted(theme, item.isError ? "error" : "accent", `${head} ${CALL_ELLIPSIS}`, target)];
	if (item.running) return rows;
	const status = item.isError
		? [FAILURE_GLYPH, failureSummary(sanitizeTerminalText(item.output))].filter((part) => part.length > 0).join(" ")
		: `${SUCCESS_GLYPH} ${statusWord(item.name, item.args)}`;
	return [...rows, painted(theme, RESULT_ROLE, `${RESULT_MARKER}${status}`, target)];
}
