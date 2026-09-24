import { isFinished, THREAD_ITEM, TASK_STATUS, type TaskRecord, type TaskStatus, type TaskStore, type TaskSummary, type ThreadItem } from "./agents-protocol.ts";

// Publishes live Gentle Agents subagent state to an interactive RPC host
// (the desktop app), the RPC equivalent of the above-editor TUI card. Pi's
// only fire-and-forget, structured-enough RPC push is `setWidget(key, string[])`
// (component factories are ignored in RPC mode), so this module projects the
// TaskStore through the same field-whitelist discipline as
// `lib/orchestrator-presence.ts`, bounds the payload, and coalesces bursts of
// task events into one `setWidget` call per window.

/** Schema tag carried on every published line so a client can version the payload shape. */
export const ACTIVITY_SCHEMA = "gentle-agents.activity/v1";
/** Same widget key the TUI card uses. RPC's `setWidget` only accepts a component
 * factory (ignored) or a `string[]` (sent), so the two publications never collide
 * on the wire even though they share a key. */
export const ACTIVITY_WIDGET_KEY = "gentle-agents";

/** Prompts are the field most likely to carry a long user request; keep only a preview. */
const PROMPT_LIMIT = 200;
/** Tool args/output can be arbitrarily large; bound each independently. */
const TOOL_ARGS_LIMIT = 500;
const TOOL_OUTPUT_LIMIT = 500;
/** Text/thinking/note thread item text can be arbitrarily large (a whole streamed reply); bound it too. */
const TEXT_ITEM_LIMIT = 2000;
/** Summary fields that can carry a long, freeform diagnostic or step name. */
const SUMMARY_FIELD_LIMIT = 500;
/** Thread items kept per task in one push, most recent last. */
const DEFAULT_THREAD_ITEMS = 40;
/** Total payload bound before shrinking kicks in. */
export const DEFAULT_MAX_BYTES = 256 * 1024;
/** How long a burst of task/summary changes is coalesced before one push. */
const DEFAULT_COALESCE_MS = 150;

export interface RpcTaskSummary {
	id: string;
	agent: string;
	label: string;
	prompt: string;
	status: TaskStatus;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	lastStep: string;
	lastActivityAt: number;
	turns: number;
	toolCalls: number;
	error: string | null;
}

export interface RpcThreadTextItem {
	kind: typeof THREAD_ITEM.TEXT | typeof THREAD_ITEM.THINKING | typeof THREAD_ITEM.NOTE;
	text: string;
}

export interface RpcThreadToolItem {
	kind: typeof THREAD_ITEM.TOOL;
	name: string;
	/** JSON-stringified and truncated; never the raw args object. */
	args: string;
	running: boolean;
	isError: boolean;
	output: string;
}

export type RpcThreadItem = RpcThreadTextItem | RpcThreadToolItem;

export interface RpcThread {
	version: number;
	dropped: number;
	items: RpcThreadItem[];
}

export interface RpcTask {
	summary: RpcTaskSummary;
	thread: RpcThread;
}

export interface RpcActivity {
	schema: typeof ACTIVITY_SCHEMA;
	summary: TaskSummary;
	tasks: RpcTask[];
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

function projectThreadItem(item: ThreadItem): RpcThreadItem {
	if (item.kind === THREAD_ITEM.TOOL) {
		return {
			kind: item.kind,
			name: item.name,
			args: truncate(safeStringify(item.args), TOOL_ARGS_LIMIT),
			running: item.running,
			isError: item.isError,
			output: truncate(item.output, TOOL_OUTPUT_LIMIT),
		};
	}
	return { kind: item.kind, text: truncate(item.text, TEXT_ITEM_LIMIT) };
}

function projectTaskSummary(task: TaskRecord): RpcTaskSummary {
	return {
		id: task.id,
		agent: task.agent,
		label: truncate(task.label, SUMMARY_FIELD_LIMIT),
		prompt: truncate(task.prompt, PROMPT_LIMIT),
		status: task.status,
		createdAt: task.createdAt,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		lastStep: truncate(task.lastStep, SUMMARY_FIELD_LIMIT),
		lastActivityAt: task.lastActivityAt,
		turns: task.turns,
		toolCalls: task.toolCalls,
		error: task.error === null ? null : truncate(task.error, SUMMARY_FIELD_LIMIT),
	};
}

/** Ordering rank: running, then waiting, then queued, ahead of every finished status. */
const STATUS_RANK: Partial<Record<TaskStatus, number>> = {
	[TASK_STATUS.RUNNING]: 0,
	[TASK_STATUS.WAITING]: 1,
	[TASK_STATUS.QUEUED]: 2,
};
const FINISHED_RANK = 3;

function orderTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
	return [...tasks].sort((a, b) => {
		const rankA = STATUS_RANK[a.status] ?? FINISHED_RANK;
		const rankB = STATUS_RANK[b.status] ?? FINISHED_RANK;
		if (rankA !== rankB) return rankA - rankB;
		// Within the active ranks, TaskStore#list's own recency order is kept
		// (Array#sort is stable). Finished tasks sort by endedAt desc.
		return rankA === FINISHED_RANK ? (b.endedAt ?? 0) - (a.endedAt ?? 0) : 0;
	});
}

export interface ProjectRpcActivityOptions {
	/** Restrict to one parent session's tasks, matching `TaskStore#list`/`#summary`. */
	parentSessionId?: string;
	/** Thread items kept per task, most recent last. */
	maxThreadItems?: number;
}

/** Whitelisted, ordered, size-bounded projection of `store` for one RPC push. Pure: reads the store, never mutates it. */
export function projectRpcActivity(store: TaskStore, opts: ProjectRpcActivityOptions = {}): RpcActivity {
	const { parentSessionId, maxThreadItems = DEFAULT_THREAD_ITEMS } = opts;
	const tasks = orderTasks(store.list(parentSessionId));
	return {
		schema: ACTIVITY_SCHEMA,
		summary: store.summary(parentSessionId),
		tasks: tasks.map((task) => {
			const thread = store.thread(task.id);
			const kept = maxThreadItems >= thread.items.length ? thread.items : thread.items.slice(thread.items.length - maxThreadItems);
			return { summary: projectTaskSummary(task), thread: { version: thread.version, dropped: thread.dropped, items: kept.map(projectThreadItem) } };
		}),
	};
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function halveThreadItems(task: RpcTask): RpcTask {
	if (task.thread.items.length <= 1) return task;
	const nextLength = Math.max(1, Math.floor(task.thread.items.length / 2));
	return { ...task, thread: { ...task.thread, items: task.thread.items.slice(task.thread.items.length - nextLength) } };
}

function emptyFinishedThread(task: RpcTask): RpcTask {
	return isFinished(task.summary.status) ? { ...task, thread: { ...task.thread, items: [] } } : task;
}

function lastFinishedIndex(tasks: readonly RpcTask[]): number {
	for (let index = tasks.length - 1; index >= 0; index -= 1) {
		if (isFinished(tasks[index]!.summary.status)) return index;
	}
	return -1;
}

/**
 * Serializes `activity` as one JSON line, shrinking it under `maxBytes` when
 * needed, in order: first halve every task's kept thread items (repeatedly,
 * down to one item each), then empty finished tasks' threads, then drop
 * whole finished tasks (oldest-finished first, by `endedAt`), and finally --
 * once only active (running/waiting/queued) tasks with one item each
 * remain -- empty every remaining task's thread too, emitting a
 * summary-only payload. Never throws; a payload nothing can shrink further
 * is returned as-is, oversized.
 */
export function encodeActivityLines(activity: RpcActivity, maxBytes: number = DEFAULT_MAX_BYTES): string[] {
	let working = activity;
	let line = JSON.stringify(working);
	if (byteLength(line) <= maxBytes) return [line];

	while (byteLength(line) > maxBytes && working.tasks.some((task) => task.thread.items.length > 1)) {
		working = { ...working, tasks: working.tasks.map(halveThreadItems) };
		line = JSON.stringify(working);
	}

	while (byteLength(line) > maxBytes && working.tasks.some((task) => isFinished(task.summary.status) && task.thread.items.length > 0)) {
		working = { ...working, tasks: working.tasks.map(emptyFinishedThread) };
		line = JSON.stringify(working);
	}

	while (byteLength(line) > maxBytes) {
		const dropIndex = lastFinishedIndex(working.tasks);
		if (dropIndex === -1) break;
		working = { ...working, tasks: working.tasks.filter((_task, index) => index !== dropIndex) };
		line = JSON.stringify(working);
	}

	// Last resort: every finished task is already dropped, but the
	// remaining active tasks' single-item threads still don't fit. No
	// summary itself is ever dropped -- only its thread.
	while (byteLength(line) > maxBytes && working.tasks.some((task) => task.thread.items.length > 0)) {
		working = { ...working, tasks: working.tasks.map((task) => ({ ...task, thread: { ...task.thread, items: [] } })) };
		line = JSON.stringify(working);
	}

	return [line];
}

export interface RpcActivityPublisherUi {
	setWidget(key: string, lines: string[]): void;
}

export interface RpcActivityPublisherDeps {
	store: TaskStore;
	ui: RpcActivityPublisherUi;
	/** Unused by the publisher itself; accepted for symmetry with the rest of `AgentsDeps`. */
	now?: () => number;
	/** Same convention as `AgentsDeps.schedule`: returns a cancel function. */
	schedule?: (fn: () => void, ms: number) => () => void;
	coalesceMs?: number;
	maxBytes?: number;
	maxThreadItems?: number;
	parentSessionId?: string;
	/** Never let a `setWidget` failure escape the publisher; logs go here instead. */
	onError?: (error: unknown) => void;
}

export interface RpcActivityPublisher {
	start(): void;
	stop(): void;
	/** Publish immediately, cancelling any pending coalescing timer. */
	flush(): void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	(timer as unknown as { unref?: () => void }).unref?.();
	return () => clearTimeout(timer);
}

/**
 * Subscribes to `store.subscribeSummary` (task add/remove/status changes)
 * and to `store.subscribe(id)` for every known task, coalescing bursts into
 * one bounded `setWidget(ACTIVITY_WIDGET_KEY, lines)` push per window.
 */
export function createRpcActivityPublisher(deps: RpcActivityPublisherDeps): RpcActivityPublisher {
	const {
		store,
		ui,
		schedule = defaultSchedule,
		coalesceMs = DEFAULT_COALESCE_MS,
		maxBytes = DEFAULT_MAX_BYTES,
		maxThreadItems = DEFAULT_THREAD_ITEMS,
		parentSessionId,
		onError = () => {},
	} = deps;

	let cancelTimer: (() => void) | undefined;
	const taskUnsubscribes = new Map<string, () => void>();
	let summaryUnsubscribe: (() => void) | undefined;
	let started = false;

	const publish = () => {
		try {
			const activity = projectRpcActivity(store, { parentSessionId, maxThreadItems });
			const lines = encodeActivityLines(activity, maxBytes);
			ui.setWidget(ACTIVITY_WIDGET_KEY, lines);
		} catch (error) {
			onError(error);
		}
	};

	const scheduleFlush = () => {
		if (cancelTimer) return;
		cancelTimer = schedule(() => {
			cancelTimer = undefined;
			publish();
		}, coalesceMs);
	};

	const trackTask = (id: string) => {
		if (taskUnsubscribes.has(id)) return;
		taskUnsubscribes.set(id, store.subscribe(id, scheduleFlush));
	};

	const syncTasks = () => {
		for (const task of store.list(parentSessionId)) trackTask(task.id);
	};

	return {
		start() {
			if (started) return;
			started = true;
			syncTasks();
			summaryUnsubscribe = store.subscribeSummary(() => {
				syncTasks();
				scheduleFlush();
			});
			scheduleFlush();
		},
		stop() {
			if (!started) return;
			started = false;
			cancelTimer?.();
			cancelTimer = undefined;
			summaryUnsubscribe?.();
			summaryUnsubscribe = undefined;
			for (const unsubscribe of taskUnsubscribes.values()) unsubscribe();
			taskUnsubscribes.clear();
			publish();
		},
		flush() {
			cancelTimer?.();
			cancelTimer = undefined;
			publish();
		},
	};
}
