// Gentle Desktop subagents slice: the pure contract shared by the Desktop
// bridge (`lib/desktop-agents-service.ts`) and the owner seam inside
// `extensions/gentle-agents.ts`.
//
// Nothing here starts, stops, or spawns a subagent. It only names the wire
// shapes, projects the owner's actual `TaskRecord` state into the safe
// Desktop projection, and defines the bounded active + recent-finished
// selection the Desktop list uses. The owner (the single parent-session
// `TaskStore` plus the parent `AgentRunner`, reached through
// `cancel_subagent`'s exact `runner.cancel` stop path) stays the single
// source of truth; this module is a projection, not a second store, runner,
// or process manager.

import type { ChildResponseObservation, ChildTokenMeasurement, TaskRecord, TaskStatus, TaskThread, TaskUsage } from "./agents-protocol.ts";
import { FINISHED_STATUSES, TASK_STATUS, THREAD_ITEM } from "./agents-protocol.ts";
import { boundRpcThread, DEFAULT_MAX_BYTES, projectRpcThread, TEXT_ITEM_LIMIT, TOOL_ARGS_LIMIT, TOOL_OUTPUT_LIMIT, type RpcThreadItem } from "./agents-rpc-publisher.ts";

export const DESKTOP_AGENTS_METHODS = ["list_subagents", "cancel_subagent", "get_subagent_thread"] as const;
export const DESKTOP_AGENTS_EVENT = "agents_update";
/** Advertised only because the owner seam records the TaskStore transitions this event carries. */
export const DESKTOP_AGENTS_EVENTS = [DESKTOP_AGENTS_EVENT] as const;

// The versioned owner-service discovery seam (the agents analogue of the jobs
// `gentle:desktop:jobs-service` adapter). The schema string guards the adapter
// against drift; the bridge ignores any responder whose shape does not match.
export const DESKTOP_AGENTS_SERVICE_SCHEMA = "gentle-pi.desktop-agents-service/v1";
export const DESKTOP_AGENTS_SERVICE_CHANNEL = "gentle:desktop:agents-service";

/** Upper bound on the number of subagents one list answer carries (active + recent finished). */
export const DESKTOP_AGENTS_LIST_LIMIT = 50;

export type DesktopAgentStatus = TaskStatus;

/**
 * Per-helper usage: the accumulated total tokens and cost the store already
 * tracks, plus the final-assistant input/output/cache/reasoning breakdown once
 * the runner released it at completion. The breakdown fields are omitted for
 * an in-flight task whose breakdown has not been recorded yet.
 */
export interface DesktopAgentUsage {
	/** Accumulated total tokens billed to this helper (`TaskRecord.tokens`). */
	total: number;
	/** Accumulated cost billed to this helper (`TaskRecord.cost`). */
	cost: number;
	input?: number;
	output?: number;
	/** Cache read plus cache write tokens. */
	cache?: number;
	reasoning?: number;
}

/**
 * The closed `lastStep` vocabulary. Raw `TaskRecord.lastStep` text is never
 * trusted: it can carry an error message, a stderr tail, a provider body, or a
 * path. The projection maps status to a fixed phase label, keeping only a
 * hardcoded set of safe active-step labels for running tasks and a generic
 * reason for every terminal status. Nothing else can reach the wire.
 */
export const DESKTOP_AGENT_STEPS = [
	"queued", "running", "waiting",
	"starting", "writing", "cleaning up", "generating tool arguments", "question dismissed", "answered", "interrupted",
	"completed", "failed", "cancelled", "timed_out",
] as const;
export type DesktopAgentStep = (typeof DESKTOP_AGENT_STEPS)[number];

/** Safe active-step labels kept for a running task; anything else maps to "running". */
const SAFE_ACTIVE_STEPS: ReadonlySet<string> = new Set([
	"starting", "writing", "cleaning up", "generating tool arguments", "question dismissed", "answered", "interrupted",
]);

/** Closed, status-derived step label; never the raw `TaskRecord.lastStep` text. */
function projectDesktopLastStep(task: TaskRecord): DesktopAgentStep {
	switch (task.status) {
		case TASK_STATUS.COMPLETED: return "completed";
		case TASK_STATUS.FAILED: return "failed";
		case TASK_STATUS.CANCELLED: return "cancelled";
		case TASK_STATUS.TIMED_OUT: return "timed_out";
		case TASK_STATUS.QUEUED: return "queued";
		case TASK_STATUS.WAITING: return "waiting";
		case TASK_STATUS.RUNNING:
			return SAFE_ACTIVE_STEPS.has(task.lastStep) ? (task.lastStep as DesktopAgentStep) : "running";
		default:
			return "running";
	}
}

/**
 * The safe wire window for one subagent. Only these fields exist on the wire:
 * identity, the agent name, the status word, the routed model plus its
 * launch-layer source and the fallback it moved away from, the thinking level,
 * the closed step label, and the bounded usage window. Never the prompt
 * text, tool args/output, cwd or session path, result, error text, or any
 * session internal.
 */
export interface DesktopAgentEntry {
	id: string;
	agent: string;
	status: DesktopAgentStatus;
	model: string;
	modelSource?: string;
	fallbackFrom?: string;
	thinking?: string;
	lastStep: DesktopAgentStep;
	usage: DesktopAgentUsage;
	/** Turns the subagent has finished; absent from an owner that predates progress. */
	turns?: number;
	/** Tool calls the subagent has started; absent from an owner that predates progress. */
	toolCalls?: number;
	/** The tool running right now, when its name is a plain identifier; never its arguments. */
	activeTool?: string;
}

/** The owner's list answer for one session: which session, plus its projected agents. */
export interface DesktopAgentsOwnerRead {
	sessionId: string;
	agents: DesktopAgentEntry[];
}

/**
 * A `cancel_subagent` owner result. `requested` is `true` only when
 * `runner.cancel` returned `true` (the owner found an active task and accepted
 * the cancellation). `changed` is `true` only when the store actually
 * transitioned synchronously as a result of that call (a queued task becoming
 * `cancelled`). A running task's cancellation is asynchronous: `requested` is
 * `true` but `changed` is `false`, and the eventual store transition arrives
 * through the normal `agents_update` path, never an immediate fabricated one.
 */
export type DesktopAgentsCancelOutcome =
	| { kind: "ok"; agent: DesktopAgentEntry; requested: boolean; changed: boolean }
	| { kind: "not_found" };

/**
 * One subagent's bounded activity thread: the exact per-item projection and
 * bounds of the `gentle-agents.activity/v1` widget (`projectRpcThread`), plus
 * the store's own thread `version` and `dropped` eviction count. `truncated` is
 * `true` when the store holds more items than the answer carries (the 40-item
 * window or the byte bound cut older items).
 */
export interface DesktopAgentThread {
	id: string;
	version: number;
	items: RpcThreadItem[];
	dropped: number;
	truncated: boolean;
}

export type DesktopAgentsThreadOutcome =
	| { kind: "ok"; thread: DesktopAgentThread }
	| { kind: "not_found" };

/**
 * The owner-service adapter the bridge discovers. Every method is defensive:
 * after `dispose()` it answers empty/no-op rather than speaking into a
 * replaced session.
 */
export interface DesktopAgentsService {
	schema: typeof DESKTOP_AGENTS_SERVICE_SCHEMA;
	read(): DesktopAgentsOwnerRead;
	cancel(id: string): DesktopAgentsCancelOutcome;
	/**
	 * Read one owned subagent's bounded thread. Optional so an adapter that
	 * predates it still serves list/cancel; the bridge answers
	 * `agents_unavailable` for `get_subagent_thread` when it is absent.
	 */
	thread?(id: string): DesktopAgentsThreadOutcome;
	/** Subscribe to actual TaskStore transitions; the unsubscribe stops delivery. */
	observe(onChange: (sessionId: string) => void): () => void;
	dispose(): void;
}

export const INVALID_AGENTS_PARAMS = { code: "invalid_request", message: "Invalid subagents parameters" } as const;
export const AGENTS_UNAVAILABLE = { code: "agents_unavailable", message: "Subagents owner unavailable for this session" } as const;
export const AGENT_NOT_FOUND = { code: "not_found", message: "No subagent with that id in this session" } as const;

/** Freeform name/model bounds; `lastStep` is closed, never truncated raw text. */
const AGENT_FIELD_LIMIT = 200;
const MODEL_FIELD_LIMIT = 128;
const SOURCE_FIELD_LIMIT = 64;
const THINKING_FIELD_LIMIT = 32;
/** A tool name that may cross the wire: a plain identifier, never free text. */
const ACTIVE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

const countField = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The name of the most recent tool still running in the thread, when it is a
 * plain identifier. Finished tool items are skipped, so a parallel call that
 * ended after a still-running one never hides it.
 */
export function activeToolName(thread: TaskThread | undefined): string | undefined {
	if (!thread) return undefined;
	for (let index = thread.items.length - 1; index >= 0; index -= 1) {
		const item = thread.items[index]!;
		if (item.kind !== THREAD_ITEM.TOOL || !item.running) continue;
		return ACTIVE_TOOL_NAME.test(item.name) ? item.name : undefined;
	}
	return undefined;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function projectDesktopAgentUsage(task: TaskRecord): DesktopAgentUsage {
	const usage: DesktopAgentUsage = { total: task.tokens, cost: task.cost };
	if (task.usage !== undefined) {
		usage.input = task.usage.input;
		usage.output = task.usage.output;
		usage.cache = task.usage.cacheRead + task.usage.cacheWrite;
		usage.reasoning = task.usage.reasoning;
	}
	return usage;
}

/**
 * The whitelisted projection of one owner `TaskRecord`. Every field is rebuilt
 * from the named members only, so a foreign or stale object can never smuggle
 * a prompt, path, tool argument, result, or secret into the Desktop payload.
 */
export function projectDesktopAgent(task: TaskRecord, thread?: TaskThread): DesktopAgentEntry {
	const entry: DesktopAgentEntry = {
		id: task.id,
		agent: truncate(task.agent, AGENT_FIELD_LIMIT),
		status: task.status,
		model: truncate(task.model, MODEL_FIELD_LIMIT),
		lastStep: projectDesktopLastStep(task),
		usage: projectDesktopAgentUsage(task),
	};
	if (task.modelSource !== undefined) entry.modelSource = truncate(task.modelSource, SOURCE_FIELD_LIMIT);
	if (task.fallbackFrom !== undefined) entry.fallbackFrom = truncate(task.fallbackFrom, MODEL_FIELD_LIMIT);
	if (task.thinking !== undefined) entry.thinking = truncate(task.thinking, THINKING_FIELD_LIMIT);
	if (countField(task.turns)) entry.turns = task.turns;
	if (countField(task.toolCalls)) entry.toolCalls = task.toolCalls;
	// Only an active task has a tool running; a finished one never reports one.
	const tool = FINISHED_STATUSES.includes(task.status) ? undefined : activeToolName(thread);
	if (tool !== undefined) entry.activeTool = tool;
	return entry;
}

/**
 * The bounded `list_subagents` selection: active tasks first (recency order,
 * matching `TaskStore#list`), then finished tasks (newest end first), capped
 * so the answer can never grow with the lifetime of the process. The store
 * already evicts finished tasks beyond its own retention, so no separate
 * linger window is needed here.
 */
export function selectDesktopAgents(tasks: readonly TaskRecord[], threadOf?: (id: string) => TaskThread | undefined): DesktopAgentEntry[] {
	const active = tasks.filter((task) => !FINISHED_STATUSES.includes(task.status));
	const finished = tasks
		.filter((task) => FINISHED_STATUSES.includes(task.status))
		.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
	return [...active, ...finished].slice(0, DESKTOP_AGENTS_LIST_LIMIT).map((task) => projectDesktopAgent(task, threadOf?.(task.id)));
}

function reportedTokens(measurement: ChildTokenMeasurement): number {
	return measurement.state === "reported" ? measurement.value : 0;
}

/**
 * Accumulates the final-assistant token breakdown across the observations the
 * runner delivered at completion. Only `reported` measurements count; an
 * `unavailable` measurement contributes zero rather than being guessed. The
 * accumulated total is intentionally not derived from these observations:
 * `TaskRecord.tokens` is the store's own running total.
 */
export function accumulateTaskUsage(responses: readonly ChildResponseObservation[]): TaskUsage {
	const usage: TaskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	for (const response of responses) {
		usage.input += reportedTokens(response.tokens.input);
		usage.output += reportedTokens(response.tokens.output);
		usage.cacheRead += reportedTokens(response.tokens.cacheRead);
		usage.cacheWrite += reportedTokens(response.tokens.cacheWrite);
		usage.reasoning += reportedTokens(response.tokens.reasoning);
	}
	return usage;
}

function nonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseDesktopAgentUsage(value: unknown): DesktopAgentUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (!nonNegativeNumber(raw.total) || !nonNegativeNumber(raw.cost)) return undefined;
	const usage: DesktopAgentUsage = { total: raw.total, cost: raw.cost };
	for (const field of ["input", "output", "cache", "reasoning"] as const) {
		const next = raw[field];
		if (next !== undefined) {
			if (!nonNegativeNumber(next)) return undefined;
			usage[field] = next;
		}
	}
	return usage;
}

/**
 * Defensive validation of one owner-projected entry. The owner's answer crosses
 * the event bus, so its shape is never trusted beyond the fields the bridge
 * projects; anything else is junk the bridge answers `agents_unavailable` for
 * rather than projecting into a malformed success.
 */
export function parseDesktopAgentEntry(value: unknown): DesktopAgentEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
	if (typeof raw.agent !== "string" || raw.agent.length > AGENT_FIELD_LIMIT + 1) return undefined;
	if (!Object.values(TASK_STATUS).includes(raw.status as TaskStatus)) return undefined;
	if (typeof raw.model !== "string" || raw.model.length > MODEL_FIELD_LIMIT + 1) return undefined;
	if (!DESKTOP_AGENT_STEPS.includes(raw.lastStep as DesktopAgentStep)) return undefined;
	const usage = parseDesktopAgentUsage(raw.usage);
	if (usage === undefined) return undefined;
	const entry: DesktopAgentEntry = { id: raw.id, agent: raw.agent, status: raw.status as TaskStatus, model: raw.model, lastStep: raw.lastStep as DesktopAgentStep, usage };
	for (const field of ["modelSource", "fallbackFrom", "thinking"] as const) {
		const next = raw[field];
		if (next !== undefined) {
			if (typeof next !== "string") return undefined;
			entry[field] = next;
		}
	}
	for (const field of ["turns", "toolCalls"] as const) {
		const next = raw[field];
		if (next !== undefined) {
			if (!countField(next)) return undefined;
			entry[field] = next;
		}
	}
	if (raw.activeTool !== undefined) {
		if (typeof raw.activeTool !== "string" || !ACTIVE_TOOL_NAME.test(raw.activeTool)) return undefined;
		entry.activeTool = raw.activeTool;
	}
	return entry;
}

/**
 * Projects one owner thread through the widget's own projection and bounds:
 * `projectRpcThread` (last 40 items, per-item field limits) then
 * `boundRpcThread` (256 KB, halving). Pure: never mutates the thread.
 */
export function projectDesktopAgentThread(id: string, thread: TaskThread, maxBytes: number = DEFAULT_MAX_BYTES): DesktopAgentThread {
	const bounded = boundRpcThread(projectRpcThread(thread), maxBytes);
	return { id, version: bounded.version, items: bounded.items, dropped: bounded.dropped, truncated: bounded.items.length < thread.items.length };
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Bounds an item field may reach after `truncate` (the limit itself). */
function boundedString(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length <= limit;
}

function parseThreadItem(value: unknown): RpcThreadItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.kind === THREAD_ITEM.TOOL) {
		if (typeof raw.name !== "string" || !boundedString(raw.args, TOOL_ARGS_LIMIT) || !boundedString(raw.output, TOOL_OUTPUT_LIMIT)) return undefined;
		if (typeof raw.running !== "boolean" || typeof raw.isError !== "boolean") return undefined;
		return { kind: THREAD_ITEM.TOOL, name: raw.name, args: raw.args, running: raw.running, isError: raw.isError, output: raw.output };
	}
	if (raw.kind === THREAD_ITEM.TEXT || raw.kind === THREAD_ITEM.THINKING || raw.kind === THREAD_ITEM.NOTE) {
		if (!boundedString(raw.text, TEXT_ITEM_LIMIT)) return undefined;
		return { kind: raw.kind, text: raw.text };
	}
	return undefined;
}

/**
 * Defensive validation of the owner's thread answer, which crosses the event
 * bus: every field is rebuilt from the whitelist and every item must already
 * respect the activity projection's bounds. Anything else is junk the bridge
 * answers `agents_unavailable` for.
 */
export function parseDesktopAgentThread(value: unknown): DesktopAgentThread | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
	if (!nonNegativeInteger(raw.version) || !nonNegativeInteger(raw.dropped) || typeof raw.truncated !== "boolean") return undefined;
	if (!Array.isArray(raw.items)) return undefined;
	const items: RpcThreadItem[] = [];
	for (const entry of raw.items) {
		const item = parseThreadItem(entry);
		if (item === undefined) return undefined;
		items.push(item);
	}
	return { id: raw.id, version: raw.version, items, dropped: raw.dropped, truncated: raw.truncated };
}

/**
 * Applies `sinceVersion` to a projected thread. The store keeps one thread
 * version, not per-item versions, and an existing item can still change in
 * place (streamed text merges into the last item; a tool item gets its output
 * and end state later). So a `sinceVersion` equal to the current version means
 * nothing changed since that read and returns no items; any other value
 * returns the whole bounded window, which holds every item that changed.
 */
export function applySinceVersion(thread: DesktopAgentThread, sinceVersion: number | undefined): DesktopAgentThread {
	if (sinceVersion === undefined || sinceVersion !== thread.version) return thread;
	return { ...thread, items: [], truncated: false };
}

/**
 * `list_subagents` params must be an empty object; anything else is a typed
 * `invalid_request` before any owner work happens.
 */
export function parseListSubagentsParams(params: Record<string, unknown>): { ok: true } | { error: { code: string; message: string } } {
	return Object.keys(params).length === 0 ? { ok: true } : { error: INVALID_AGENTS_PARAMS };
}

/**
 * `cancel_subagent` params are exactly `{ id: non-empty string }`. Anything
 * else is a typed `invalid_request` before any owner work happens.
 */
export function parseCancelSubagentParams(params: Record<string, unknown>): { id: string } | { error: { code: string; message: string } } {
	const keys = Object.keys(params);
	if (keys.length !== 1 || keys[0] !== "id" || typeof params.id !== "string" || params.id.length === 0) {
		return { error: INVALID_AGENTS_PARAMS };
	}
	return { id: params.id };
}

/**
 * `get_subagent_thread` params are `{ id: non-empty string, sinceVersion?:
 * non-negative integer }`. Anything else is a typed `invalid_request` before
 * any owner work happens.
 */
export function parseGetSubagentThreadParams(params: Record<string, unknown>): { id: string; sinceVersion?: number } | { error: { code: string; message: string } } {
	const keys = Object.keys(params);
	if (keys.some((key) => key !== "id" && key !== "sinceVersion")) return { error: INVALID_AGENTS_PARAMS };
	if (typeof params.id !== "string" || params.id.length === 0) return { error: INVALID_AGENTS_PARAMS };
	if (!keys.includes("sinceVersion")) return { id: params.id };
	if (!nonNegativeInteger(params.sinceVersion)) return { error: INVALID_AGENTS_PARAMS };
	return { id: params.id, sinceVersion: params.sinceVersion };
}

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopAgentsServiceShape(value: unknown): value is DesktopAgentsService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopAgentsService>;
	if (adapter.schema !== DESKTOP_AGENTS_SERVICE_SCHEMA) return false;
	if (adapter.thread !== undefined && typeof adapter.thread !== "function") return false;
	return [adapter.read, adapter.cancel, adapter.observe, adapter.dispose].every((fn) => typeof fn === "function");
}
