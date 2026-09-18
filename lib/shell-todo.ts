import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CARD_TONE, cardInnerWidth, renderCard, type CardTheme } from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// Gentle Todo: the task list the model keeps while it works. Everything here
// is pure. The state lives in the session branch (every tool result carries
// the full snapshot), and staleness is how many turns passed since the last
// write while tasks are still open.

export const TODO_STATUS = {
	PENDING: "pending",
	IN_PROGRESS: "in_progress",
	DONE: "done",
} as const;

export type TodoStatus = (typeof TODO_STATUS)[keyof typeof TODO_STATUS];

export const TODO_ACTION = {
	WRITE: "write",
	ADD: "add",
	UPDATE: "update",
	CLEAR: "clear",
	LIST: "list",
} as const;

export type TodoAction = (typeof TODO_ACTION)[keyof typeof TODO_ACTION];

export interface TodoTask {
	id: number;
	title: string;
	status: TodoStatus;
	note?: string;
}

export interface TodoState {
	tasks: TodoTask[];
	nextId: number;
	/** Turn index of the last write, or null before the first one. */
	updatedTurn: number | null;
}

export interface TodoTaskInput {
	id?: number;
	title?: string;
	status?: string;
	note?: string;
}

export interface TodoParams {
	action: string;
	tasks?: TodoTaskInput[];
	id?: number;
	title?: string;
	status?: string;
	note?: string;
}

export interface TodoResult {
	state: TodoState;
	text: string;
	error?: string;
}

export interface TodoSummary {
	done: number;
	total: number;
	open: number;
}

export interface TodoTheme extends CardTheme {
	strikethrough(text: string): string;
}

export interface TodoRenderOptions {
	/** A scrollable host supplies the height bound instead of folding tasks. */
	scrollable?: boolean;
	collapsed: boolean;
	staleTurns: number;
	collapseKey?: string;
}

/** Tool results carry the snapshot under this key; the old rpiv-todo shape is read too. */
export const TODO_DETAILS_KEY = "gentleTodo";
export const TODO_TOOL_NAME = "todo";
export const TODO_GLYPH = "❀";
const STATUS_ALIASES: Record<string, TodoStatus> = { completed: TODO_STATUS.DONE, complete: TODO_STATUS.DONE, doing: TODO_STATUS.IN_PROGRESS, todo: TODO_STATUS.PENDING };
const STATUS_GLYPH: Record<TodoStatus, string> = { [TODO_STATUS.PENDING]: "○", [TODO_STATUS.IN_PROGRESS]: "◐", [TODO_STATUS.DONE]: "✓" };
const STATUS_ROLE: Record<TodoStatus, string> = { [TODO_STATUS.PENDING]: "text", [TODO_STATUS.IN_PROGRESS]: "accent", [TODO_STATUS.DONE]: "dim" };
const GLYPH_ROLE: Record<TodoStatus, string> = { [TODO_STATUS.PENDING]: "muted", [TODO_STATUS.IN_PROGRESS]: "accent", [TODO_STATUS.DONE]: "success" };
const NOTE_ROLE = "muted";
const STALE_AFTER_TURNS = 2;
/** Above this many rows the finished tasks fold into one line and the rest is capped. */
const ROW_CAP = 12;

export function emptyTodo(): TodoState {
	return { tasks: [], nextId: 1, updatedTurn: null };
}

function cleanText(value: unknown): string {
	return typeof value === "string" ? sanitizeTerminalText(value).replace(/\s+/g, " ").trim() : "";
}

function parseStatus(value: unknown): TodoStatus | undefined {
	if (value === undefined || value === null || value === "") return TODO_STATUS.PENDING;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if ((Object.values(TODO_STATUS) as string[]).includes(normalized)) return normalized as TodoStatus;
	return STATUS_ALIASES[normalized];
}

export function todoSummary(state: TodoState): TodoSummary {
	const done = state.tasks.filter((task) => task.status === TODO_STATUS.DONE).length;
	return { done, total: state.tasks.length, open: state.tasks.length - done };
}

export function staleTurns(state: TodoState, currentTurn: number): number {
	if (state.updatedTurn === null || todoSummary(state).open === 0) return 0;
	return Math.max(0, currentTurn - state.updatedTurn);
}

function summaryText(state: TodoState): string {
	const { done, total } = todoSummary(state);
	const inProgress = state.tasks.filter((task) => task.status === TODO_STATUS.IN_PROGRESS).length;
	return `${total} ${total === 1 ? "task" : "tasks"} · ${done} done · ${inProgress} in progress`;
}

function taskLine(task: TodoTask): string {
	return `[${task.status}] #${task.id} ${task.title}${task.note ? ` — ${task.note}` : ""}`;
}

function buildTask(input: TodoTaskInput, id: number): TodoTask | string {
	const title = cleanText(input.title);
	if (title.length === 0) return "title is required";
	const status = parseStatus(input.status);
	if (status === undefined) return `unknown status "${input.status}" (use pending, in_progress, or done)`;
	const note = cleanText(input.note);
	return { id, title, status, ...(note ? { note } : {}) };
}

function write(state: TodoState, inputs: TodoTaskInput[], turn: number): TodoResult {
	const tasks: TodoTask[] = [];
	let nextId = state.nextId;
	for (const input of inputs) {
		const keepId = typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 && !tasks.some((task) => task.id === input.id);
		const id = keepId ? (input.id as number) : nextId++;
		nextId = Math.max(nextId, id + 1);
		const built = buildTask(input, id);
		if (typeof built === "string") return { state, text: `Error: ${built}`, error: built };
		tasks.push(built);
	}
	const next = { tasks, nextId, updatedTurn: turn };
	return { state: next, text: `Todo list written: ${summaryText(next)}` };
}

function update(state: TodoState, params: TodoParams, turn: number): TodoResult {
	const task = state.tasks.find((candidate) => candidate.id === params.id);
	if (!task) {
		const error = `no task #${params.id}`;
		return { state, text: `Error: ${error}`, error };
	}
	if (params.status === undefined && params.title === undefined && params.note === undefined) {
		const error = "nothing to update: pass status, title, or note";
		return { state, text: `Error: ${error}`, error };
	}
	const built = buildTask({ id: task.id, title: params.title ?? task.title, status: params.status ?? task.status, note: params.note ?? task.note }, task.id);
	if (typeof built === "string") return { state, text: `Error: ${built}`, error: built };
	const next = { ...state, tasks: state.tasks.map((candidate) => (candidate.id === task.id ? built : candidate)), updatedTurn: turn };
	const change = task.status === built.status ? "updated" : `→ ${built.status}`;
	return { state: next, text: `#${built.id} ${built.title} ${change}` };
}

export function applyTodo(state: TodoState, params: TodoParams, turn: number): TodoResult {
	switch (params.action) {
		case TODO_ACTION.WRITE:
			return write(state, Array.isArray(params.tasks) ? params.tasks : [], turn);
		case TODO_ACTION.ADD: {
			const built = buildTask({ title: params.title, status: params.status, note: params.note }, state.nextId);
			if (typeof built === "string") return { state, text: `Error: ${built}`, error: built };
			const next = { tasks: [...state.tasks, built], nextId: state.nextId + 1, updatedTurn: turn };
			return { state: next, text: `Added #${built.id} ${built.title} (${built.status})` };
		}
		case TODO_ACTION.UPDATE:
			return update(state, params, turn);
		case TODO_ACTION.CLEAR:
			return { state: { ...emptyTodo(), updatedTurn: turn }, text: `Cleared ${state.tasks.length} ${state.tasks.length === 1 ? "task" : "tasks"}` };
		case TODO_ACTION.LIST:
			return { state, text: state.tasks.length === 0 ? "No tasks." : state.tasks.map(taskLine).join("\n") };
		default: {
			const error = `unknown action "${params.action}" (use write, add, update, clear, or list)`;
			return { state, text: `Error: ${error}`, error };
		}
	}
}

interface ReplayEntry {
	type?: string;
	message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown };
}

interface RpivTask {
	id?: number;
	subject?: string;
	status?: string;
	activeForm?: string;
}

function fromRpiv(details: { tasks?: RpivTask[]; nextId?: number }): TodoState {
	const tasks: TodoTask[] = [];
	for (const raw of details.tasks ?? []) {
		if (raw.status === "deleted" || typeof raw.id !== "number") continue;
		const built = buildTask({ id: raw.id, title: raw.subject, status: raw.status, note: raw.status === TODO_STATUS.IN_PROGRESS ? raw.activeForm : undefined }, raw.id);
		if (typeof built !== "string") tasks.push(built);
	}
	return { tasks, nextId: typeof details.nextId === "number" ? details.nextId : tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1, updatedTurn: null };
}

// The last successful `todo` result on the branch is the state: ours carries
// the snapshot under `gentleTodo`; rpiv-todo carried `tasks` + `nextId` at the top.
export function replayTodo(entries: readonly unknown[]): TodoState {
	let state = emptyTodo();
	for (const entry of entries as ReplayEntry[]) {
		const message = entry?.message;
		if (entry?.type !== "message" || message?.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME || message.isError === true) continue;
		const details = message.details as Record<string, unknown> | undefined;
		if (!details || typeof details !== "object") continue;
		const ours = details[TODO_DETAILS_KEY] as TodoState | undefined;
		if (ours && Array.isArray(ours.tasks)) state = { tasks: ours.tasks, nextId: ours.nextId, updatedTurn: ours.updatedTurn ?? null };
		else if (Array.isArray(details.tasks)) state = fromRpiv(details as { tasks?: RpivTask[]; nextId?: number });
	}
	return state;
}

export function todoPromptBlock(state: TodoState, stale: number): string | undefined {
	if (todoSummary(state).open === 0) return undefined;
	const lines = state.tasks.map((task, index) => `${index + 1}. [${task.status}] ${task.title}${task.note ? ` — ${task.note}` : ""}`);
	const staleLine = stale >= STALE_AFTER_TURNS ? `\n(stale: ${stale} turns without an update — bring the list up to date now)` : "";
	return [
		"## Todo list",
		"Keep it current with the `todo` tool: mark a task in_progress before starting it, done right after finishing it, and rewrite the whole list with `write` whenever the plan changes. Update it before you end the turn.",
		...lines,
	].join("\n") + staleLine;
}

function taskRow(task: TodoTask, theme: TodoTheme, width: number): string {
	if (task.status === TODO_STATUS.DONE) {
		// Wrap before applying SGR 9: every physical title closes its own style
		// before renderCard adds padding and rails.
		return wrapTextWithAnsi(task.title, Math.max(1, cardInnerWidth(width) - 2))
			.map((line, index) => `${index === 0 ? theme.fg(GLYPH_ROLE[task.status], STATUS_GLYPH[task.status]) : " "} ${theme.fg(STATUS_ROLE[task.status], theme.strikethrough(line))}`)
			.join("\n");
	}
	const title = task.title;
	const note = task.status === TODO_STATUS.IN_PROGRESS && task.note ? ` ${theme.fg(NOTE_ROLE, "·")} ${theme.fg(NOTE_ROLE, task.note)}` : "";
	return `${theme.fg(GLYPH_ROLE[task.status], STATUS_GLYPH[task.status])} ${theme.fg(STATUS_ROLE[task.status], title)}${note}`;
}

// Long lists keep the card short: done tasks fold into "✓ N done" and the
// open ones fill the remaining rows, with a trailing count for the rest.
function bodyRows(state: TodoState, theme: TodoTheme, width: number): string[] {
	if (state.tasks.length <= ROW_CAP) return state.tasks.map((task) => taskRow(task, theme, width));
	const { done } = todoSummary(state);
	const open = state.tasks.filter((task) => task.status !== TODO_STATUS.DONE);
	const rows: string[] = [];
	if (done > 0) rows.push(`${theme.fg(GLYPH_ROLE[TODO_STATUS.DONE], STATUS_GLYPH[TODO_STATUS.DONE])} ${theme.fg(NOTE_ROLE, `${done} done`)}`);
	const room = ROW_CAP - rows.length - (open.length > ROW_CAP - rows.length ? 1 : 0);
	for (const task of open.slice(0, room)) rows.push(taskRow(task, theme, width));
	if (open.length > room) rows.push(theme.fg(NOTE_ROLE, `… ${open.length - room} more`));
	return rows;
}

function collapsedRow(state: TodoState, theme: TodoTheme, width: number): string {
	const active = state.tasks.find((task) => task.status === TODO_STATUS.IN_PROGRESS);
	if (active) return taskRow(active, theme, width);
	const pending = state.tasks.find((task) => task.status === TODO_STATUS.PENDING);
	if (pending) return taskRow(pending, theme, width);
	const { open } = todoSummary(state);
	return `${theme.fg(GLYPH_ROLE[TODO_STATUS.PENDING], STATUS_GLYPH[TODO_STATUS.PENDING])} ${theme.fg(NOTE_ROLE, `${open} open`)}`;
}

export function renderTodoCard(state: TodoState, theme: TodoTheme, width: number, options: TodoRenderOptions): string[] {
	if (state.tasks.length === 0) return [];
	const { done, total } = todoSummary(state);
	const stale = options.staleTurns >= STALE_AFTER_TURNS;
	const action = options.collapsed ? "expand" : "collapse";
	const actionLabel = action[0]!.toUpperCase() + action.slice(1);
	const icon = options.collapsed ? "▸" : "▾";
	const control = `${icon} ${width >= 28 ? actionLabel : ""}`.trimEnd();
	const hint = options.collapseKey ? `${options.collapseKey} ${action}` : undefined;
	const rows = options.collapsed ? [collapsedRow(state, theme, width)] : options.scrollable ? state.tasks.map((task) => taskRow(task, theme, width)) : bodyRows(state, theme, width);
	const body = stale ? [theme.fg(NOTE_ROLE, `stale · ${options.staleTurns} turns`), ...rows] : rows;
	return renderCard(
		{ title: `Todos ${theme.fg("accent", control)}`, subtitle: `${done} of ${total}`, body, tone: stale ? CARD_TONE.WARNING : CARD_TONE.INFO, glyph: TODO_GLYPH },
		theme,
		width,
		{ expanded: true, hint },
	);
}
