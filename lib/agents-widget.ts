import { visibleWidth } from "@earendil-works/pi-tui";
import { isFinished, TASK_STATUS, type TaskRecord, type TaskStatus } from "./agents-protocol.ts";
import { formatTokens } from "./shell-bar.ts";
import { CARD_TONE, cardInnerWidth, renderCard, type CardTheme, type CardTone } from "./shell-card.ts";

// Gentle Agents widget: the card above the editor. Reads task records only
// (status, prompt, counters, timestamps), so drawing it costs nothing per
// event. One row per task: glyph, agent, task summary, then
// model · effort · tokens · cost · time right-aligned.

export const AGENTS_GLYPH = "❀";

export interface AgentsWidgetOptions {
	collapsed: boolean;
	collapseKey?: string;
	// Rows the card may spend on tasks; beyond that the rest fold into one
	// "… N more" line so the card never pushes the editor off the screen.
	maxRows?: number;
	viewKey?: string;
}

interface StatusLook {
	glyph: string;
	role: string;
}

interface Columns {
	inner: number;
	name: number;
	task: number;
	meta: number;
	fullMetrics: boolean;
}

const LOOK: Record<TaskStatus, StatusLook> = {
	[TASK_STATUS.QUEUED]: { glyph: "○", role: "muted" },
	[TASK_STATUS.RUNNING]: { glyph: "◐", role: "accent" },
	[TASK_STATUS.WAITING]: { glyph: "?", role: "warning" },
	[TASK_STATUS.COMPLETED]: { glyph: "✓", role: "success" },
	[TASK_STATUS.FAILED]: { glyph: "✗", role: "error" },
	[TASK_STATUS.CANCELLED]: { glyph: "–", role: "dim" },
	[TASK_STATUS.TIMED_OUT]: { glyph: "✗", role: "error" },
};
const FINISHED_TTL_MS = 60_000;
const MAX_FINISHED = 3;
const ROWS_MIN = 3;
const ROWS_MAX = 8;
const ROWS_RATIO = 0.25;
const SHOW_PRIORITY: Record<TaskStatus, number> = {
	[TASK_STATUS.WAITING]: 0,
	[TASK_STATUS.RUNNING]: 1,
	[TASK_STATUS.QUEUED]: 2,
	[TASK_STATUS.COMPLETED]: 3,
	[TASK_STATUS.FAILED]: 3,
	[TASK_STATUS.CANCELLED]: 3,
	[TASK_STATUS.TIMED_OUT]: 3,
};
const NAME_MAX = 20;
const TASK_MIN = 12;
const GLYPH_GAP = "  ";
const COLUMN_GAP = "  ";
const NAME_ROLE = "text";
const TASK_ROLE = "muted";
const META_ROLE = "dim";
const ELLIPSIS = "…";

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let out = "";
	for (const char of text) {
		if (visibleWidth(out + char) > width - 1) break;
		out += char;
	}
	return `${out}${ELLIPSIS}`;
}

// Every active task plus the few that finished within the last minute, in
// the order they started, so a batch reads top to bottom like a timeline.
export function widgetTasks(tasks: readonly TaskRecord[], now: number): TaskRecord[] {
	const active = tasks.filter((task) => !isFinished(task.status));
	const finished = tasks
		.filter((task) => isFinished(task.status) && task.endedAt !== null && now - task.endedAt < FINISHED_TTL_MS)
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
		.slice(0, MAX_FINISHED);
	return [...active, ...finished].sort(startOrder);
}

// How long until the next finished row leaves the card, or undefined when no
// shown row is waiting to expire. The host asks for exactly one frame at that
// moment instead of ticking while the terminal is idle.
export function widgetExpiryMs(tasks: readonly TaskRecord[], now: number): number | undefined {
	const deadlines = widgetTasks(tasks, now)
		.filter((task) => isFinished(task.status) && task.endedAt !== null)
		.map((task) => (task.endedAt ?? now) + FINISHED_TTL_MS - now);
	return deadlines.length === 0 ? undefined : Math.max(1, Math.min(...deadlines));
}

// A quarter of the terminal, never fewer than three rows nor more than eight.
export function widgetRows(terminalRows: number | undefined): number {
	if (terminalRows === undefined) return ROWS_MAX;
	return Math.max(ROWS_MIN, Math.min(ROWS_MAX, Math.floor(terminalRows * ROWS_RATIO)));
}

function startOrder(a: TaskRecord, b: TaskRecord): number {
	return (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt);
}

// When the card overflows, questions and running work keep their rows first;
// what stays visible is still drawn in start order.
function visibleRows(shown: readonly TaskRecord[], maxRows: number | undefined): { listed: TaskRecord[]; hidden: number } {
	if (maxRows === undefined || shown.length <= maxRows) return { listed: [...shown], hidden: 0 };
	const kept = Math.max(1, maxRows - 1);
	const listed = [...shown]
		.sort((a, b) => SHOW_PRIORITY[a.status] - SHOW_PRIORITY[b.status] || startOrder(a, b))
		.slice(0, kept)
		.sort(startOrder);
	return { listed, hidden: shown.length - listed.length };
}

function overflowRow(hidden: number, theme: CardTheme, viewKey: string | undefined): string {
	const hint = viewKey ? ` · ${viewKey} to view` : "";
	return theme.fg(META_ROLE, `${ELLIPSIS} ${hidden} more${hint}`);
}

function elapsed(task: TaskRecord, now: number): string {
	return task.startedAt === null ? "" : formatElapsed((task.endedAt ?? now) - task.startedAt);
}

function modelLabel(task: TaskRecord): string {
	const id = task.model.includes("/") ? task.model.slice(task.model.lastIndexOf("/") + 1) : task.model;
	return id === "default" ? "" : id;
}

function executionLabel(task: TaskRecord, width = Infinity): string {
	const model = modelLabel(task);
	const effort = task.thinking ?? "";
	if (!model) return clip(effort, width);
	if (!effort) return clip(model, width);
	const suffix = ` · ${effort}`;
	if (width <= visibleWidth(suffix)) return clip(`${model} · ${effort}`, width);
	return clip(model, width - visibleWidth(suffix)) + suffix;
}

function meta(task: TaskRecord, now: number, fullMetrics: boolean): string {
	if (task.status === TASK_STATUS.QUEUED) return "queued";
	if (!fullMetrics) return executionLabel(task);
	const parts = [executionLabel(task), task.tokens > 0 ? formatTokens(task.tokens) : "", task.cost > 0 ? `$${task.cost.toFixed(2)}` : "", elapsed(task, now)];
	return parts.filter((part) => part.length > 0).join(" · ");
}

function taskText(task: TaskRecord): string {
	if (task.status === TASK_STATUS.WAITING) return task.lastStep;
	if (task.error) return task.error;
	return task.label;
}

// Narrow cards give up the task and usage columns before execution metadata.
function columns(tasks: readonly TaskRecord[], inner: number, now: number): Columns {
	const name = Math.max(0, Math.min(NAME_MAX, inner - 3, Math.max(...tasks.map((task) => visibleWidth(task.agent)))));
	const fixed = 1 + GLYPH_GAP.length + name + COLUMN_GAP.length;
	const metaWidth = (fullMetrics: boolean) => Math.max(...tasks.map((task) => visibleWidth(meta(task, now, fullMetrics))));
	const full = metaWidth(true);
	const task = inner - fixed - full - COLUMN_GAP.length;
	if (task >= TASK_MIN) return { inner, name, meta: full, task, fullMetrics: true };
	return { inner, name, meta: Math.max(0, Math.min(inner - fixed, metaWidth(false))), task: 0, fullMetrics: false };
}

function row(task: TaskRecord, theme: CardTheme, cols: Columns, now: number, allowMetadataRow: boolean): string[] {
	const look = LOOK[task.status];
	const name = clip(task.agent, cols.name);
	const head = `${theme.fg(look.role, look.glyph)}${GLYPH_GAP}${theme.fg(NAME_ROLE, name)}${" ".repeat(cols.name - visibleWidth(name))}`;
	const metadata = cols.fullMetrics ? meta(task, now, true) : task.status === TASK_STATUS.QUEUED ? clip("queued", cols.meta) : executionLabel(task, cols.meta);
	const tail = theme.fg(META_ROLE, " ".repeat(Math.max(0, cols.meta - visibleWidth(metadata))) + metadata);
	if (cols.inner < 3) return [theme.fg(look.role, clip(look.glyph, cols.inner))];
	// The scrollable sidebar can preserve identity and execution metadata on
	// separate rows. The height-capped above-editor widget keeps its row budget.
	if (allowMetadataRow && cols.task === 0 && task.status !== TASK_STATUS.QUEUED && visibleWidth(executionLabel(task)) > cols.meta) {
		return [head, theme.fg(META_ROLE, executionLabel(task, cols.inner))];
	}
	if (cols.task === 0) return [`${head}${" ".repeat(Math.max(0, cols.inner - visibleWidth(head) - visibleWidth(tail)))}${tail}`];
	const text = clip(taskText(task), cols.task);
	return [`${head}${COLUMN_GAP}${theme.fg(TASK_ROLE, text)}${" ".repeat(cols.task - visibleWidth(text))}${COLUMN_GAP}${tail}`];
}

function counts(tasks: readonly TaskRecord[]): string {
	const labels: Array<[TaskStatus, string]> = [
		[TASK_STATUS.RUNNING, "active"],
		[TASK_STATUS.WAITING, "waiting"],
		[TASK_STATUS.QUEUED, "queued"],
		[TASK_STATUS.COMPLETED, "done"],
		[TASK_STATUS.FAILED, "failed"],
		[TASK_STATUS.TIMED_OUT, "timed out"],
		[TASK_STATUS.CANCELLED, "cancelled"],
	];
	return labels
		.map(([status, label]) => [tasks.filter((task) => task.status === status).length, label] as const)
		.filter(([count]) => count > 0)
		.map(([count, label]) => `${count} ${label}`)
		.join(" · ");
}

function tone(tasks: readonly TaskRecord[]): CardTone {
	if (tasks.some((task) => task.status === TASK_STATUS.WAITING)) return CARD_TONE.WARNING;
	if (tasks.some((task) => task.status === TASK_STATUS.FAILED || task.status === TASK_STATUS.TIMED_OUT)) return CARD_TONE.ERROR;
	return CARD_TONE.INFO;
}

// The batch clock: from the first start among the shown tasks until now, or
// until the last one ended when nothing is running.
function batchElapsed(tasks: readonly TaskRecord[], now: number): string | undefined {
	const starts = tasks.map((task) => task.startedAt).filter((value): value is number => value !== null);
	if (starts.length === 0) return undefined;
	const active = tasks.some((task) => !isFinished(task.status));
	const end = active ? now : Math.max(...tasks.map((task) => task.endedAt ?? now));
	return formatElapsed(end - Math.min(...starts));
}

export function renderAgentsCard(tasks: readonly TaskRecord[], theme: CardTheme, width: number, now: number, options: AgentsWidgetOptions): string[] {
	const shown = widgetTasks(tasks, now);
	if (shown.length === 0) return [];
	const cols = columns(shown, cardInnerWidth(width), now);
	const { listed, hidden } = options.collapsed ? { listed: [shown[0]], hidden: 0 } : visibleRows(shown, options.maxRows);
	const hint = options.collapsed && options.collapseKey ? `${options.collapseKey} expand` : shown.length > 1 ? batchElapsed(shown, now) : undefined;
	const body = listed.flatMap((task) => row(task, theme, cols, now, options.maxRows === undefined));
	if (hidden > 0) body.push(overflowRow(hidden, theme, options.viewKey));
	return renderCard(
		{ title: "Agents", subtitle: counts(shown), body, tone: tone(shown), glyph: AGENTS_GLYPH },
		theme,
		width,
		{ expanded: true, hint },
	);
}
