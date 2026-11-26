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
import { join, resolve } from "node:path";
import type { ChangedFile, ChangesModel, WorktreeChanges } from "./shell-changes.ts";
import type { SessionStats } from "./shell-stats.ts";
import type { DesktopJobEntry } from "./desktop-rpc-jobs.ts";
import type { DesktopAgentEntry } from "./desktop-rpc-agents.ts";
import type { DesktopUsageEntry } from "./desktop-rpc-usage.ts";
import { oddPhaseLabel, type OddPhase } from "./odd-phase.ts";
import { profileRoutingRows, readProfileOrchestrator, type OrchestratorMode } from "./agent-profiles.ts";
import type { AgentModelConfig } from "./model-routing-authority.ts";
import type { PersonaMode } from "./persona-config.ts";
import { CODEX_PROVIDER, providerNote, USAGE_FETCH_FAILED_NOTE } from "./shell-usage.ts";
import { FINISHED_STATUSES } from "./agents-protocol.ts";
import { extensionCommandWorksOverRpc } from "./desktop-command-rpc.ts";

export const DESKTOP_FEED_SCHEMA = "gentle-shell.desktop-feed/v1";
/** Coalescing window: a burst of changes becomes one write at most this late. */
export const DESKTOP_FEED_DEBOUNCE_MS = 250;
/**
 * S13: urgent state (an open or answered question, the permission mode, an
 * idle/working/blocked transition, a held prompt) is written this soon, so the
 * desktop answers without waiting for the routine tier.
 */
export const DESKTOP_FEED_URGENT_MS = 16;
/** S13: while the session is busy, routine changes are written at most once per this interval. */
export const DESKTOP_FEED_BUSY_INTERVAL_MS = 1000;

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
	/** Providers the usage panel lists: the session's own, then its subagent routes. */
	usageProviders: 8,
	/** Saved profiles listed, and routing roles listed per profile. */
	profiles: 20,
	profileRoles: 40,
	questions: 4,
	options: 10,
	ancestors: 8,
	commands: 200,
	/** A command description. */
	commandText: 200,
	/** Default bound for a free-text field (titles, labels, names, paths). */
	text: 500,
	/** Question text, the one field a human must read whole. */
	question: 2000,
} as const;

/** Tools whose open call is a question the desktop can show (T7 answers it by toolCallId). */
export const DESKTOP_FEED_QUESTION_TOOLS = ["ask_user_choice", "ask_user_question"] as const;

// ---- Slash commands (T10, S9) ----

/**
 * pi's built-in slash commands the desktop offers (its palette and the
 * composer's "/" menu). pi keeps BUILTIN_SLASH_COMMANDS out of its public
 * exports, so this mirrors it (tests/desktop-feed.test.ts checks every name
 * against pi's list); `/quit` is left out: it is typed, never one click away.
 * `terminal`: the command shows its result or a picker in the TUI, so the
 * desktop shows the Terminal after sending it. `args`: the command needs an
 * argument, so the desktop puts it in the composer instead of sending it.
 * `rpc`: Pi's RPC protocol has a matching command (modes/rpc/rpc-mode.js, named
 * after each entry), so an RPC client can do the same without the TUI; typing
 * the slash command into an RPC session's `prompt` does not run a built-in.
 */
export const DESKTOP_FEED_BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string; args: string | null; terminal: boolean; rpc: boolean }> = [
	{ name: "new", description: "Start a new session", args: null, terminal: false, rpc: true }, // RPC: new_session
	{ name: "resume", description: "Resume another session", args: null, terminal: true, rpc: false },
	{ name: "fork", description: "Create a new fork from a previous user message", args: null, terminal: true, rpc: true }, // RPC: get_fork_messages + fork
	{ name: "clone", description: "Duplicate the current session at the current position", args: null, terminal: false, rpc: true }, // RPC: clone
	{ name: "tree", description: "Navigate session tree (switch branches)", args: null, terminal: true, rpc: false },
	{ name: "compact", description: "Manually compact the session context", args: null, terminal: true, rpc: true }, // RPC: compact
	{ name: "name", description: "Set session display name", args: "<name>", terminal: false, rpc: true }, // RPC: set_session_name
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)", args: null, terminal: true, rpc: true }, // RPC: export_html
	{ name: "session", description: "Show session info and stats", args: null, terminal: true, rpc: true }, // RPC: get_session_stats
	{ name: "copy", description: "Copy last agent message to clipboard", args: null, terminal: false, rpc: true }, // RPC: get_last_assistant_text
	{ name: "model", description: "Select model (opens selector UI)", args: null, terminal: true, rpc: true }, // RPC: get_available_models + set_model
	{ name: "thinking", description: "Set thinking level", args: null, terminal: true, rpc: true }, // RPC: set_thinking_level
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", args: null, terminal: true, rpc: false },
	{ name: "settings", description: "Open settings menu", args: null, terminal: true, rpc: false },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", args: null, terminal: true, rpc: false },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files", args: null, terminal: true, rpc: false },
	{ name: "import", description: "Import a JSONL session, preserving its ID and working directory", args: null, terminal: true, rpc: false },
	{ name: "share", description: "Share session via a Radius artifact or a GitHub gist", args: null, terminal: true, rpc: false },
	{ name: "changelog", description: "Show changelog entries", args: null, terminal: true, rpc: false },
	{ name: "trust", description: "Save project trust decision for future sessions", args: null, terminal: true, rpc: false },
	{ name: "login", description: "Configure provider authentication", args: null, terminal: true, rpc: false },
	{ name: "logout", description: "Remove provider authentication", args: null, terminal: true, rpc: false },
	{ name: "bug", description: "Report a bug to the Pi developers", args: "<description>", terminal: true, rpc: false },
];

/** The desktop RPC's own machine channel: not a command a person runs. */
const HIDDEN_COMMANDS = new Set(["gentle:desktop"]);

/** One entry of pi's command registry (`pi.getCommands()`), as far as the snapshot reads it. */
export interface DesktopFeedCommandInput {
	name: string;
	description?: string;
	source: string;
}

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
	/**
	 * The absolute agent dir this snapshot lives under (`<agentDir>/desktop/sessions`): the bundled
	 * `~/.gentle-shell/agent`, the Pi extension's `~/.pi/agent`, or a custom home. Readers send the
	 * session's actions to this dir's inbox.
	 */
	agentDir: string;
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
	/**
	 * Answered in the terminal only (T7): prompts, consent, multi-question or
	 * multi-select questions, and a provider consent or maintenance
	 * authorization the agent relays through an ask tool.
	 */
	terminalOnly: boolean;
	openedAt: string;
}

export interface DesktopFeedUsageEntry {
	provider: string;
	status: string;
	plan: string | null;
	fetchedAt: number | null;
	/** What the TUI panel says for a provider with no windows (null when it has some). */
	note: string | null;
	limits: Array<{ name: string; limitReached: boolean; windows: Array<{ label: string; usedPercent: number; windowSeconds: number; resetAt: number | null }> }>;
}

export interface DesktopFeedProfileRoute {
	model: string;
	thinking: string;
}

export interface DesktopFeedProfileItem {
	name: string;
	/** The orchestrator's service tier, as the status bar shows it. */
	tier: "standard" | "fast" | null;
	mode: string;
	orchestrator: (DesktopFeedProfileRoute & { tier: string | null }) | null;
	/** One row per agent role, alphabetical, as the /gentle:profiles table lists them. */
	roles: Array<DesktopFeedProfileRoute & { agent: string }>;
	truncated: boolean;
}

/** The profiles store as the reader found it (lib/desktop-feed-sources.ts). */
export interface DesktopFeedProfileCatalog {
	active: string | undefined;
	default: string | undefined;
	items: ReadonlyArray<{ name: string; config: AgentModelConfig; mode: OrchestratorMode | string }>;
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
	/** The active persona (lib/persona-config.ts), or null when it could not be read. */
	persona: PersonaMode | null;
	context: { percent: number | null; tokens: number | null; window: number | null } | null;
	cost: { total: number; subscription: boolean };
	/**
	 * The TUI usage panel (alt+u, /gentle:usage): the session's provider first (its fields at the
	 * top level, as before), and every provider the panel lists in `providers`, from the same owner.
	 */
	usage: (DesktopFeedUsageEntry & { providers: DesktopFeedUsageEntry[] }) | null;
	/** The saved model profiles (/gentle:profiles), or null when the store cannot be read. */
	profiles: {
		/** The profile this session routes with (its configured name, without the label's marker). */
		active: string | null;
		/** The store's default for new sessions. */
		default: string | null;
		items: DesktopFeedProfileItem[];
		truncated: boolean;
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
		/** added / deleted are null for an untracked file whose lines were not counted (binary, too large). */
		files: Array<{ path: string; status: string; added: number | null; deleted: number | null }>;
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
	/**
	 * S15: `waiting` is a session whose turn ended while its background subagents or jobs still
	 * run. `agents` / `jobs`: the live work (the same counts as `agents.active` and
	 * `jobs.running`); `label`: the words every desktop region shows ("Working · 2 agents",
	 * "Waiting on 2 agents", "Idle", or the blocker's own label).
	 */
	activity: {
		state: DesktopFeedActivityState;
		streaming: boolean;
		phase: string | null;
		phaseLabel: string | null;
		blockedLabel: string | null;
		agents: number;
		jobs: number;
		label: string;
	};
	pendingQuestion: DesktopFeedPendingQuestion | null;
	/**
	 * The session's slash commands: pi's built-ins, then its registry (extension
	 * commands, prompt templates, skills) in pi's order. Extension commands show
	 * their result in the TUI (`terminal`); prompts and skills answer in the chat.
	 * `rpc`: the command works from an RPC client (lib/desktop-command-rpc.ts for
	 * extension commands, Pi's matching RPC command for built-ins; prompts and
	 * skills expand through Pi's `prompt`); false when undeclared.
	 */
	commands: {
		items: Array<{ name: string; description: string | null; args: string | null; terminal: boolean; rpc: boolean; source: "builtin" | "extension" | "prompt" | "skill" }>;
		truncated: boolean;
	};
}

export type DesktopFeedActivityState = "working" | "waiting" | "blocked" | "idle";

// ---- Live work (S15) ----

/** Subagents of the session that still run (queued, running, waiting): the header's Agents count. */
export function runningAgents(agents: readonly DesktopAgentEntry[] | undefined): number {
	return (agents ?? []).filter((agent) => !FINISHED_STATUSES.includes(agent.status)).length;
}

/** Background jobs of the session that still run: the status bar's Jobs count. */
export function runningJobs(jobs: readonly DesktopJobEntry[] | undefined): number {
	return (jobs ?? []).filter((job) => job.status === "running").length;
}

/** blocked > working (the turn) > waiting (only background work) > idle. */
export function desktopActivityState(turn: { working: boolean; blocked: number }, agents: number, jobs: number): DesktopFeedActivityState {
	if (turn.blocked > 0) return "blocked";
	if (turn.working) return "working";
	return agents > 0 || jobs > 0 ? "waiting" : "idle";
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The activity's words: "Working · 2 agents · 1 job", "Waiting on 2 agents", "Idle". */
export function desktopActivityLabel(state: DesktopFeedActivityState, agents: number, jobs: number, blockedLabel: string | null = null): string {
	const work = [agents > 0 ? counted(agents, "agent") : null, jobs > 0 ? counted(jobs, "job") : null].filter(Boolean).join(" · ");
	if (state === "blocked") return blockedLabel ?? "Needs you";
	if (state === "working") return work ? `Working · ${work}` : "Working";
	if (state === "waiting") return `Waiting on ${work}`;
	return "Idle";
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
		agentDir: string;
		env: NodeJS.ProcessEnv;
	};
	branch: string | null | undefined;
	model: { id: string; provider: string; reasoning?: boolean } | undefined;
	thinkingLevel: string | undefined;
	subscription: boolean;
	profile: { name: string | undefined; tier: "standard" | "fast" | undefined; catalog?: DesktopFeedProfileCatalog };
	/** The active persona; undefined publishes null. */
	persona?: PersonaMode;
	context: { percent: number | null; tokens: number | null; contextWindow: number } | undefined;
	/** The session's own provider, as the usage owner reports it. */
	usage: DesktopUsageEntry | undefined;
	/** Every provider in the usage panel's scope, in its order (the session's own first). */
	usageProviders?: readonly DesktopUsageEntry[];
	permission: { mode: string; defaultMode?: string; detail?: string } | undefined;
	todo: TodoState;
	/** Undefined until the first scan answered. */
	changes: { model: ChangesModel; worktrees: readonly WorktreeChanges[]; uncounted?: ReadonlySet<string> } | undefined;
	agents: readonly DesktopAgentEntry[] | undefined;
	jobs: readonly DesktopJobEntry[] | undefined;
	review: ReviewSidebarSnapshot | undefined;
	stats: SessionStats;
	activity: { working: boolean; blocked: number; blockedLabel: string | undefined; streaming: boolean; phase: OddPhase | undefined };
	pendingQuestion: DesktopFeedPendingQuestion | undefined;
	/** pi's command registry; undefined when the runtime has none. */
	commands?: readonly DesktopFeedCommandInput[];
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
export function pendingQuestionFromTool(toolName: string, toolCallId: string, args: unknown, now: number, terminalOnly = false): DesktopFeedPendingQuestion | undefined {
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
	const desktop = !terminalOnly && questions.length === 1 && !first.multi && first.options.length > 0;
	return { kind, tool: toolName, toolCallId: clipText(toolCallId), ...first, questions, promptKind: null, terminalOnly: !desktop, openedAt: new Date(now).toISOString() };
}

/** A pi extension dialog (select/confirm/input/editor) or a content-free blocker (consent, guarded command). */
export function pendingPrompt(kind: "prompt" | "consent", title: string | undefined, promptKind: string | undefined, now: number): DesktopFeedPendingQuestion {
	const question = clipText(title ?? "", DESKTOP_FEED_LIMITS.question);
	const custom = promptKind === "input" || promptKind === "editor";
	return { kind, tool: null, toolCallId: null, question, header: null, options: [], multi: false, custom, questions: [{ question, header: null, options: [], multi: false, custom }], promptKind: promptKind ?? null, terminalOnly: true, openedAt: new Date(now).toISOString() };
}

// ---- Snapshot builder ----

function herdrIdentity(env: NodeJS.ProcessEnv): DesktopFeedIdentity["herdr"] {
	const paneId = env.HERDR_PANE_ID?.trim();
	const inHerdr = env.HERDR_ENV === "1";
	if (!inHerdr && !paneId) return null;
	return { paneId: paneId ? clipText(paneId) : null, env: inHerdr };
}

/** The panel's note for a provider it knows nothing of: no subscription usage. */
const UNSUPPORTED_NOTE = providerNote("");

// The usage panel's own words for a provider without windows (lib/shell-usage.ts
// renderUsagePanel): a settled empty refresh, a pending fetch or response, or a
// provider with no subscription usage at all.
function usageNote(entry: DesktopUsageEntry): string | null {
	if ((entry.limits ?? []).length > 0) return null;
	if (entry.status === "failed") return USAGE_FETCH_FAILED_NOTE;
	if (entry.status === "pending") {
		const note = providerNote(entry.provider);
		// A provider with a registered source: the panel's default pending note.
		return note === UNSUPPORTED_NOTE ? providerNote(CODEX_PROVIDER) : note;
	}
	if (entry.status === "unavailable") return UNSUPPORTED_NOTE;
	return null;
}

function usageEntry(entry: DesktopUsageEntry): DesktopFeedUsageEntry {
	return {
		provider: clipText(entry.provider),
		status: clipText(entry.status),
		plan: optionalText(entry.plan),
		fetchedAt: finiteOrNull(entry.fetchedAt),
		note: usageNote(entry),
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

function usageSection(active: DesktopUsageEntry | undefined, scope: readonly DesktopUsageEntry[] | undefined): DesktopFeedSnapshot["usage"] {
	const first = active ?? scope?.[0];
	if (!first) return null;
	const providers = (scope && scope.length > 0 ? scope : [first]).slice(0, DESKTOP_FEED_LIMITS.usageProviders).map(usageEntry);
	return { ...usageEntry(first), providers };
}

const route = (entry: { model?: string; thinking?: string } | undefined): DesktopFeedProfileRoute => ({
	model: clipText(entry?.model ?? "inherit"),
	thinking: clipText(entry?.thinking ?? "inherit"),
});

function profilesSection(catalog: DesktopFeedProfileCatalog | undefined): DesktopFeedSnapshot["profiles"] {
	if (!catalog) return null;
	const items = catalog.items.slice(0, DESKTOP_FEED_LIMITS.profiles).map((item): DesktopFeedProfileItem => {
		const rows = profileRoutingRows(item.config);
		const orchestrator = readProfileOrchestrator(item.config);
		const tier = orchestrator?.tier === "fast" || orchestrator?.tier === "standard" ? orchestrator.tier : null;
		return {
			name: clipText(item.name, 128),
			tier,
			mode: clipText(item.mode, 64),
			orchestrator: orchestrator ? { ...route(orchestrator), tier: optionalText(orchestrator.tier) } : null,
			roles: rows.slice(0, DESKTOP_FEED_LIMITS.profileRoles).map((row) => ({ agent: clipText(row.agent, 128), model: clipText(row.model), thinking: clipText(row.thinking) })),
			truncated: rows.length > DESKTOP_FEED_LIMITS.profileRoles,
		};
	});
	return {
		active: optionalText(catalog.active, 128),
		default: optionalText(catalog.default, 128),
		items,
		truncated: catalog.items.length > DESKTOP_FEED_LIMITS.profiles,
	};
}

function changesSection(input: DesktopFeedInput["changes"]): DesktopFeedSnapshot["changes"] {
	if (!input) return null;
	const { model, worktrees, uncounted } = input;
	// The combined model's paths are relative to the one root, else already absolute (WorktreeChangesTracker.model).
	const absolute = (path: string) => join(worktrees.length === 1 ? worktrees[0]!.root : "", path);
	const counted = (file: ChangedFile) => !(file.status === "untracked" && uncounted?.has(absolute(file.path)));
	return {
		files: model.files.slice(0, DESKTOP_FEED_LIMITS.changes).map((file) => counted(file)
			? { path: clipText(file.path, 1000), status: file.status, added: finite(file.added), deleted: finite(file.deleted) }
			: { path: clipText(file.path, 1000), status: file.status, added: null, deleted: null }),
		summary: { files: model.files.length, added: finite(model.added), deleted: finite(model.deleted) },
		worktrees: worktrees.slice(0, DESKTOP_FEED_LIMITS.worktrees).map((tree) => ({ root: clipText(tree.root, 1000), branch: optionalText(tree.branch), files: tree.model.files.length })),
		truncated: model.files.length > DESKTOP_FEED_LIMITS.changes,
	};
}

function agentsSection(agents: readonly DesktopAgentEntry[] | undefined): DesktopFeedSnapshot["agents"] {
	if (!agents) return null;
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
		active: runningAgents(agents),
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

// S13: the registry array is cached by the extension until it changes, so its
// shaped section is too (a frozen builtin-only one stands for "no registry").
const commandSections = new WeakMap<readonly DesktopFeedCommandInput[], DesktopFeedSnapshot["commands"]>();
const NO_REGISTRY: readonly DesktopFeedCommandInput[] = [];

function commandsSection(registry: readonly DesktopFeedCommandInput[] | undefined): DesktopFeedSnapshot["commands"] {
	const key = registry ?? NO_REGISTRY;
	const cached = commandSections.get(key);
	if (cached) return cached;
	const section = shapeCommands(key);
	commandSections.set(key, section);
	return section;
}

function shapeCommands(registry: readonly DesktopFeedCommandInput[]): DesktopFeedSnapshot["commands"] {
	const items: DesktopFeedSnapshot["commands"]["items"] = DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => ({ ...command, source: "builtin" as const }));
	const seen = new Set(items.map((item) => item.name));
	let truncated = false;
	for (const command of registry) {
		const name = clipText(command?.name, 128);
		if (!name || HIDDEN_COMMANDS.has(name) || seen.has(name)) continue;
		if (items.length >= DESKTOP_FEED_LIMITS.commands) { truncated = true; break; }
		seen.add(name);
		const source = command.source === "prompt" || command.source === "skill" ? command.source : "extension";
		// Prompt templates and skills expand through Pi's `prompt` in any mode (agent-session.js `prompt`).
		const rpc = source === "extension" ? extensionCommandWorksOverRpc(name) : true;
		items.push({ name, description: optionalText(command.description, DESKTOP_FEED_LIMITS.commandText), args: null, terminal: source === "extension", rpc, source });
	}
	return { items, truncated };
}

export function buildDesktopFeedSnapshot(input: DesktopFeedInput): DesktopFeedSnapshot {
	const { identity, now } = input;
	const todo = input.todo;
	const progress = todoSummary(todo);
	const effort = input.model?.reasoning ? input.thinkingLevel : undefined;
	const agentsLive = runningAgents(input.agents);
	const jobsLive = runningJobs(input.jobs?.slice(0, DESKTOP_FEED_LIMITS.jobs));
	const state = desktopActivityState(input.activity, agentsLive, jobsLive);
	const blockedLabel = input.activity.blocked > 0 ? optionalText(input.activity.blockedLabel) : null;
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
			agentDir: resolve(identity.agentDir),
			herdr: herdrIdentity(identity.env),
		},
		project: { cwd: clipText(identity.cwd, 4096), branch: optionalText(input.branch), dirty: input.changes ? input.changes.model.files.length : null },
		model: {
			id: optionalText(input.model?.id),
			provider: optionalText(input.model?.provider),
			effort: optionalText(effort),
			profile: { name: optionalText(input.profile.name), tier: input.profile.tier ?? null },
		},
		persona: input.persona ?? null,
		context: input.context ? { percent: finiteOrNull(input.context.percent), tokens: finiteOrNull(input.context.tokens), window: finiteOrNull(input.context.contextWindow) } : null,
		cost: { total: finite(input.stats.cost), subscription: input.subscription },
		usage: usageSection(input.usage, input.usageProviders),
		profiles: profilesSection(input.profile.catalog),
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
			state,
			streaming: input.activity.streaming,
			phase: input.activity.phase ?? null,
			phaseLabel: input.activity.phase ? oddPhaseLabel(input.activity.phase) : null,
			blockedLabel,
			agents: agentsLive,
			jobs: jobsLive,
			label: desktopActivityLabel(state, agentsLive, jobsLive, blockedLabel),
		},
		pendingQuestion: input.pendingQuestion ?? null,
		commands: commandsSection(input.commands),
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

// ---- Two-tier scheduling (S13) ----

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

export interface DesktopFeedSchedulerOptions {
	/** Routine debounce while idle (default 250 ms). */
	delayMs?: number;
	/** Delay for an urgent change (default 16 ms). */
	urgentMs?: number;
	/** Minimum spacing of routine writes while busy (default 1000 ms). */
	intervalMs?: number;
	/** The clock the busy interval is measured on. */
	now?: () => number;
	/** True while the agent, a job or a subagent works: routine writes are spaced. */
	busy?: () => boolean;
}

/**
 * Coalesces change notifications into one armed timer. An urgent change is
 * flushed within `urgentMs` (pulling a pending routine write forward with it);
 * a routine one joins the pending timer, waits `delayMs` while idle, and while
 * busy waits until `intervalMs` after the previous flush. Nothing is armed
 * while nothing changes.
 */
export function createDesktopFeedScheduler(flush: () => void, timers: DesktopFeedTimers = realDesktopFeedTimers, options: DesktopFeedSchedulerOptions = {}) {
	const delayMs = options.delayMs ?? DESKTOP_FEED_DEBOUNCE_MS;
	const urgentMs = options.urgentMs ?? DESKTOP_FEED_URGENT_MS;
	const intervalMs = options.intervalMs ?? DESKTOP_FEED_BUSY_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const busy = options.busy ?? (() => false);
	let pending: unknown;
	let armed = false;
	let dueAt = 0;
	let lastRun = -Infinity;
	const run = () => {
		armed = false;
		pending = undefined;
		lastRun = now();
		flush();
	};
	return {
		schedule(urgent = false): void {
			const at = now();
			let due = at + (urgent ? urgentMs : delayMs);
			if (!urgent) {
				let spaced = false;
				try { spaced = busy(); } catch { spaced = false; }
				if (spaced) due = Math.max(due, lastRun + intervalMs);
			}
			if (armed) {
				if (dueAt <= due) return;
				timers.clear(pending);
			}
			armed = true;
			dueAt = due;
			pending = timers.set(run, due - at);
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
