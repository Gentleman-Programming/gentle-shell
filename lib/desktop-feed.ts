// Gentle Shell Desktop feed (odd/tasks/herdr-desktop.md T4, S2): the pure half
// of the per-session snapshot publisher. Every live Gentle Shell session writes
// one bounded JSON document describing what its TUI shows, so the Herdr app
// mods (S5, S7) can render the same information out of process.
//
// Everything here is pure: the extension (extensions/gentle-desktop-feed.ts)
// collects raw state from the existing owners and hands it to
// `buildDesktopFeedSnapshot`, which only shapes and bounds it. Nothing here
// reads files, spawns processes or holds timers of its own.

import { REVIEW_SIDEBAR_LABELS, type ReviewSidebarSnapshot } from "./review-sidebar-state.ts";
import { todoSummary, type TodoState } from "./shell-todo.ts";
import type { ChangesModel, WorktreeChanges } from "./shell-changes.ts";
import type { SessionStats } from "./shell-stats.ts";
import type { DesktopJobEntry } from "./desktop-rpc-jobs.ts";
import type { DesktopAgentEntry } from "./desktop-rpc-agents.ts";
import type { DesktopUsageEntry } from "./desktop-rpc-usage.ts";
import { oddPhaseLabel, type OddPhase } from "./odd-phase.ts";

export const DESKTOP_FEED_SCHEMA = "gentle-shell.desktop-feed/v1";
/** Coalescing window: a burst of changes becomes one write at most this late. */
export const DESKTOP_FEED_DEBOUNCE_MS = 250;

/** Array caps: the snapshot never grows with the session's lifetime. */
export const DESKTOP_FEED_LIMITS = {
	changes: 200,
	worktrees: 20,
	todo: 100,
	jobs: 50,
	agents: 50,
	models: 20,
	usageLimits: 10,
	usageWindows: 4,
	questions: 4,
	options: 10,
	ancestors: 8,
	/** Default bound for a free-text field (titles, labels, names, paths). */
	text: 500,
	/** Question text, the one field a human must read whole. */
	question: 2000,
} as const;

/** Tools whose open call is a question the desktop can show (T7 answers it by toolCallId). */
export const DESKTOP_FEED_QUESTION_TOOLS = ["ask_user_choice", "ask_user_question"] as const;

// ---- Snapshot schema ----

export interface DesktopFeedIdentity {
	sessionId: string;
	/** The exact pi session file (null before pi assigns one, e.g. --no-session). */
	sessionFile: string | null;
	sessionName: string | null;
	cwd: string;
	realCwd: string | null;
	pid: number;
	ppid: number;
	/** Best-effort process ancestors above ppid (nearest first), for terminal matching. */
	ancestors: number[];
	mode: string;
	herdr: { paneId: string | null; env: boolean } | null;
}

export interface DesktopFeedQuestionOption {
	label: string;
	description: string | null;
}

export interface DesktopFeedQuestion {
	question: string;
	header: string | null;
	options: DesktopFeedQuestionOption[];
	multi: boolean;
	custom: boolean;
}

export interface DesktopFeedPendingQuestion {
	/** choice / questionnaire: an ask tool call; prompt: an extension dialog; consent: a blocker without content. */
	kind: "choice" | "questionnaire" | "prompt" | "consent";
	tool: string | null;
	toolCallId: string | null;
	/** The first (or only) question, flattened for simple readers. */
	question: string;
	header: string | null;
	options: DesktopFeedQuestionOption[];
	multi: boolean;
	custom: boolean;
	/** Every question of a questionnaire (one entry for a single choice). */
	questions: DesktopFeedQuestion[];
	/** The pi dialog kind for `prompt` (select, confirm, input, editor, custom). */
	promptKind: string | null;
	openedAt: string;
}

export interface DesktopFeedSnapshot {
	schema: typeof DESKTOP_FEED_SCHEMA;
	updatedAt: string;
	identity: DesktopFeedIdentity;
	project: { cwd: string; branch: string | null; dirty: number | null };
	model: {
		id: string | null;
		provider: string | null;
		effort: string | null;
		profile: { name: string | null; tier: "standard" | "fast" | null };
	};
	/** No reachable owner today: the persona lives inside gentle-ai.ts (see the T4 report). */
	persona: null;
	context: { percent: number | null; tokens: number | null; window: number | null } | null;
	cost: { total: number; subscription: boolean };
	usage: {
		provider: string;
		status: string;
		plan: string | null;
		fetchedAt: number | null;
		limits: Array<{ name: string; limitReached: boolean; windows: Array<{ label: string; usedPercent: number; windowSeconds: number; resetAt: number | null }> }>;
	} | null;
	permission: { mode: string; defaultMode: string | null; yolo: boolean; detail: string | null } | null;
	/** Opaque setStatus map: only pi's footer data provider can read it (null, see the T4 report). */
	statuses: null;
	/** The rail's Integrations come from the same opaque statuses (null, see the T4 report). */
	integrations: null;
	todo: {
		items: Array<{ id: number; title: string; state: string; note: string | null }>;
		progress: { done: number; total: number; open: number };
		current: string | null;
		truncated: boolean;
	};
	changes: {
		files: Array<{ path: string; status: string; added: number; deleted: number }>;
		summary: { files: number; added: number; deleted: number };
		worktrees: Array<{ root: string; branch: string | null; files: number }>;
		truncated: boolean;
	} | null;
	agents: {
		items: Array<{ id: string; name: string; role: null; state: string; step: string; model: string; thinking: string | null; spend: { tokens: number; cost: number } }>;
		active: number;
		spend: { runs: number; tokens: number; cost: number };
	} | null;
	jobs: {
		running: Array<{ id: string; label: string; startedAt: number; elapsedMs: number }>;
		recent: Array<{ id: string; label: string; status: string; startedAt: number; endedAt: number | null; exitCode: number | null; elapsedMs: number }>;
	} | null;
	review: { state: string; label: string; scope: string } | null;
	stats: {
		turns: number;
		toolCalls: number;
		toolErrors: number;
		cost: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheHitRate: number | null;
		durationMs: number;
		models: Array<{ model: string; turns: number; tokens: number; cost: number }>;
	};
	activity: { state: "working" | "blocked" | "idle"; streaming: boolean; phase: string | null; phaseLabel: string | null; blockedLabel: string | null };
	pendingQuestion: DesktopFeedPendingQuestion | null;
}

// ---- Raw input the extension collects from the existing owners ----

export interface DesktopFeedInput {
	now: number;
	identity: {
		sessionId: string;
		sessionFile: string | undefined;
		sessionName: string | undefined;
		cwd: string;
		realCwd: string | undefined;
		pid: number;
		ppid: number;
		ancestors: readonly number[];
		mode: string;
		env: NodeJS.ProcessEnv;
	};
	branch: string | null | undefined;
	model: { id: string; provider: string; reasoning?: boolean } | undefined;
	thinkingLevel: string | undefined;
	subscription: boolean;
	profile: { name: string | undefined; tier: "standard" | "fast" | undefined };
	context: { percent: number | null; tokens: number | null; contextWindow: number } | undefined;
	usage: DesktopUsageEntry | undefined;
	permission: { mode: string; defaultMode?: string; detail?: string } | undefined;
	todo: TodoState;
	/** Undefined until the first scan answered. */
	changes: { model: ChangesModel; worktrees: readonly WorktreeChanges[] } | undefined;
	agents: readonly DesktopAgentEntry[] | undefined;
	jobs: readonly DesktopJobEntry[] | undefined;
	review: ReviewSidebarSnapshot | undefined;
	stats: SessionStats;
	activity: { working: boolean; blocked: number; blockedLabel: string | undefined; streaming: boolean; phase: OddPhase | undefined };
	pendingQuestion: DesktopFeedPendingQuestion | undefined;
}

// ---- Bounding helpers ----

/** A bounded, control-free string: snapshot text is shown verbatim by the desktop. */
export function clipText(value: unknown, max: number = DESKTOP_FEED_LIMITS.text): string {
	if (typeof value !== "string") return "";
	const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, "");
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const optionalText = (value: unknown, max?: number): string | null => {
	const text = clipText(value, max);
	return text.length > 0 ? text : null;
};
const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// ---- Pending question ----

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function questionOptions(value: unknown): DesktopFeedQuestionOption[] {
	if (!Array.isArray(value)) return [];
	// Only label and description cross: an ask_user_choice option `value` is an
	// opaque answer token the tool returns only after a real selection.
	return value.slice(0, DESKTOP_FEED_LIMITS.options).map((option) => {
		const data = record(option);
		return { label: clipText(data.label), description: optionalText(data.description) };
	});
}

/**
 * The open question an ask tool call shows, from its call arguments, or
 * undefined for any other tool. The toolCallId is kept so T7 can answer it.
 */
export function pendingQuestionFromTool(toolName: string, toolCallId: string, args: unknown, now: number): DesktopFeedPendingQuestion | undefined {
	const input = record(args);
	let kind: DesktopFeedPendingQuestion["kind"];
	let questions: DesktopFeedQuestion[];
	if (toolName === "ask_user_choice") {
		kind = "choice";
		questions = [{ question: clipText(input.question, DESKTOP_FEED_LIMITS.question), header: null, options: questionOptions(input.options), multi: false, custom: input.allowCustomResponse === true }];
	} else if (toolName === "ask_user_question") {
		kind = "questionnaire";
		const raw = Array.isArray(input.questions) ? input.questions.slice(0, DESKTOP_FEED_LIMITS.questions) : [];
		// The questionnaire view always offers its free-text row ("Type something.").
		questions = raw.map((entry) => {
			const data = record(entry);
			return { question: clipText(data.question, DESKTOP_FEED_LIMITS.question), header: optionalText(data.header), options: questionOptions(data.options), multi: data.multiSelect === true, custom: true };
		});
	} else return undefined;
	const first = questions[0] ?? { question: "", header: null, options: [], multi: false, custom: false };
	return { kind, tool: toolName, toolCallId: clipText(toolCallId), ...first, questions, promptKind: null, openedAt: new Date(now).toISOString() };
}

/** A pi extension dialog (select/confirm/input/editor) or a content-free blocker (consent, guarded command). */
export function pendingPrompt(kind: "prompt" | "consent", title: string | undefined, promptKind: string | undefined, now: number): DesktopFeedPendingQuestion {
	const question = clipText(title ?? "", DESKTOP_FEED_LIMITS.question);
	const custom = promptKind === "input" || promptKind === "editor";
	return { kind, tool: null, toolCallId: null, question, header: null, options: [], multi: false, custom, questions: [{ question, header: null, options: [], multi: false, custom }], promptKind: promptKind ?? null, openedAt: new Date(now).toISOString() };
}

// ---- Snapshot builder ----

function herdrIdentity(env: NodeJS.ProcessEnv): DesktopFeedIdentity["herdr"] {
	const paneId = env.HERDR_PANE_ID?.trim();
	const inHerdr = env.HERDR_ENV === "1";
	if (!inHerdr && !paneId) return null;
	return { paneId: paneId ? clipText(paneId) : null, env: inHerdr };
}

function usageSection(entry: DesktopUsageEntry | undefined): DesktopFeedSnapshot["usage"] {
	if (!entry) return null;
	return {
		provider: clipText(entry.provider),
		status: clipText(entry.status),
		plan: optionalText(entry.plan),
		fetchedAt: finiteOrNull(entry.fetchedAt),
		limits: (entry.limits ?? []).slice(0, DESKTOP_FEED_LIMITS.usageLimits).map((limit) => ({
			name: clipText(limit.name),
			limitReached: limit.limitReached === true,
			windows: limit.windows.slice(0, DESKTOP_FEED_LIMITS.usageWindows).map((window) => ({
				label: clipText(window.label),
				usedPercent: finite(window.usedPercent),
				windowSeconds: finite(window.windowSeconds),
				resetAt: finiteOrNull(window.resetAt),
			})),
		})),
	};
}

function changesSection(input: DesktopFeedInput["changes"]): DesktopFeedSnapshot["changes"] {
	if (!input) return null;
	const { model, worktrees } = input;
	return {
		files: model.files.slice(0, DESKTOP_FEED_LIMITS.changes).map((file) => ({ path: clipText(file.path, 1000), status: file.status, added: finite(file.added), deleted: finite(file.deleted) })),
		summary: { files: model.files.length, added: finite(model.added), deleted: finite(model.deleted) },
		worktrees: worktrees.slice(0, DESKTOP_FEED_LIMITS.worktrees).map((tree) => ({ root: clipText(tree.root, 1000), branch: optionalText(tree.branch), files: tree.model.files.length })),
		truncated: model.files.length > DESKTOP_FEED_LIMITS.changes,
	};
}

function agentsSection(agents: readonly DesktopAgentEntry[] | undefined): DesktopFeedSnapshot["agents"] {
	if (!agents) return null;
	const finished = new Set(["completed", "failed", "cancelled", "timed_out"]);
	let tokens = 0;
	let cost = 0;
	for (const agent of agents) {
		tokens += finite(agent.usage?.total);
		cost += finite(agent.usage?.cost);
	}
	return {
		items: agents.slice(0, DESKTOP_FEED_LIMITS.agents).map((agent) => ({
			id: clipText(agent.id),
			name: clipText(agent.agent),
			role: null,
			state: agent.status,
			step: agent.lastStep,
			model: clipText(agent.model),
			thinking: optionalText(agent.thinking),
			spend: { tokens: finite(agent.usage?.total), cost: finite(agent.usage?.cost) },
		})),
		active: agents.filter((agent) => !finished.has(agent.status)).length,
		spend: { runs: agents.length, tokens, cost },
	};
}

function jobsSection(jobs: readonly DesktopJobEntry[] | undefined, now: number): DesktopFeedSnapshot["jobs"] {
	if (!jobs) return null;
	const bounded = jobs.slice(0, DESKTOP_FEED_LIMITS.jobs);
	return {
		running: bounded.filter((job) => job.status === "running").map((job) => ({ id: clipText(job.id), label: clipText(job.label), startedAt: finite(job.startedAt), elapsedMs: Math.max(0, now - finite(job.startedAt)) })),
		recent: bounded.filter((job) => job.status !== "running").map((job) => ({
			id: clipText(job.id),
			label: clipText(job.label),
			status: job.status,
			startedAt: finite(job.startedAt),
			endedAt: finiteOrNull(job.endedAt),
			exitCode: finiteOrNull(job.exitCode),
			elapsedMs: Math.max(0, (finiteOrNull(job.endedAt) ?? now) - finite(job.startedAt)),
		})),
	};
}

export function buildDesktopFeedSnapshot(input: DesktopFeedInput): DesktopFeedSnapshot {
	const { identity, now } = input;
	const todo = input.todo;
	const progress = todoSummary(todo);
	const effort = input.model?.reasoning ? input.thinkingLevel : undefined;
	return {
		schema: DESKTOP_FEED_SCHEMA,
		updatedAt: new Date(now).toISOString(),
		identity: {
			sessionId: clipText(identity.sessionId),
			sessionFile: optionalText(identity.sessionFile, 4096),
			sessionName: optionalText(identity.sessionName),
			cwd: clipText(identity.cwd, 4096),
			realCwd: optionalText(identity.realCwd, 4096),
			pid: identity.pid,
			ppid: identity.ppid,
			ancestors: identity.ancestors.filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, DESKTOP_FEED_LIMITS.ancestors),
			mode: clipText(identity.mode),
			herdr: herdrIdentity(identity.env),
		},
		project: { cwd: clipText(identity.cwd, 4096), branch: optionalText(input.branch), dirty: input.changes ? input.changes.model.files.length : null },
		model: {
			id: optionalText(input.model?.id),
			provider: optionalText(input.model?.provider),
			effort: optionalText(effort),
			profile: { name: optionalText(input.profile.name), tier: input.profile.tier ?? null },
		},
		persona: null,
		context: input.context ? { percent: finiteOrNull(input.context.percent), tokens: finiteOrNull(input.context.tokens), window: finiteOrNull(input.context.contextWindow) } : null,
		cost: { total: finite(input.stats.cost), subscription: input.subscription },
		usage: usageSection(input.usage),
		permission: input.permission ? {
			mode: clipText(input.permission.mode),
			defaultMode: optionalText(input.permission.defaultMode),
			yolo: input.permission.mode === "yolo" || input.permission.mode === "super-yolo",
			detail: optionalText(input.permission.detail),
		} : null,
		statuses: null,
		integrations: null,
		todo: {
			items: todo.tasks.slice(0, DESKTOP_FEED_LIMITS.todo).map((task) => ({ id: task.id, title: clipText(task.title), state: task.status, note: optionalText(task.note) })),
			progress,
			current: optionalText(todo.tasks.find((task) => task.status === "in_progress")?.title),
			truncated: todo.tasks.length > DESKTOP_FEED_LIMITS.todo,
		},
		changes: changesSection(input.changes),
		agents: agentsSection(input.agents),
		jobs: jobsSection(input.jobs, now),
		review: input.review ? { state: input.review.state, label: REVIEW_SIDEBAR_LABELS[input.review.state] ?? input.review.state, scope: clipText(input.review.scope) } : null,
		stats: {
			turns: input.stats.turns,
			toolCalls: input.stats.toolCalls,
			toolErrors: input.stats.toolErrors,
			cost: finite(input.stats.cost),
			input: input.stats.input,
			output: input.stats.output,
			cacheRead: input.stats.cacheRead,
			cacheWrite: input.stats.cacheWrite,
			cacheHitRate: input.stats.cacheHitRate ?? null,
			durationMs: input.stats.spanMs,
			models: input.stats.models.slice(0, DESKTOP_FEED_LIMITS.models).map((model) => ({ model: clipText(model.model), turns: model.turns, tokens: model.tokens, cost: finite(model.cost) })),
		},
		activity: {
			state: input.activity.blocked > 0 ? "blocked" : input.activity.working ? "working" : "idle",
			streaming: input.activity.streaming,
			phase: input.activity.phase ?? null,
			phaseLabel: input.activity.phase ? oddPhaseLabel(input.activity.phase) : null,
			blockedLabel: input.activity.blocked > 0 ? optionalText(input.activity.blockedLabel) : null,
		},
		pendingQuestion: input.pendingQuestion ?? null,
	};
}

/**
 * The bytes worth writing: the snapshot without its timestamp, so an
 * unchanged session never rewrites its file (and stays inert).
 */
export function desktopFeedDigest(snapshot: DesktopFeedSnapshot): string {
	const { updatedAt: _updatedAt, ...rest } = snapshot;
	// Elapsed counters move every flush; readers derive them from startedAt.
	const jobs = rest.jobs ? { running: rest.jobs.running.map(({ elapsedMs: _e, ...job }) => job), recent: rest.jobs.recent.map(({ elapsedMs: _e, ...job }) => job) } : null;
	return JSON.stringify({ ...rest, jobs });
}

// ---- Debounce ----

export interface DesktopFeedTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const realDesktopFeedTimers: DesktopFeedTimers = {
	set(fn, ms) {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return timer;
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/**
 * Coalesces change notifications: the first one arms a single timer, every
 * later one inside the window joins it, and the flush runs once. Nothing is
 * armed while nothing changes.
 */
export function createDesktopFeedScheduler(flush: () => void, timers: DesktopFeedTimers = realDesktopFeedTimers, delayMs: number = DESKTOP_FEED_DEBOUNCE_MS) {
	let pending: unknown;
	let armed = false;
	const run = () => {
		armed = false;
		pending = undefined;
		flush();
	};
	return {
		schedule(): void {
			if (armed) return;
			armed = true;
			pending = timers.set(run, delayMs);
		},
		/** Flush now, dropping the pending timer (shutdown, tests). */
		flushNow(): void {
			if (armed) timers.clear(pending);
			run();
		},
		cancel(): void {
			if (armed) timers.clear(pending);
			armed = false;
			pending = undefined;
		},
		get armed(): boolean {
			return armed;
		},
	};
}
