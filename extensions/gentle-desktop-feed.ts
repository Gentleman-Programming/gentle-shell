import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome, resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import { resolvePersonaMode, type PersonaMode } from "../lib/persona-config.ts";
import { CLAUDE_BRIDGE_PROVIDER } from "../lib/bridge-cost.ts";
import { isHomeOrBroadUserDirectory } from "../lib/bounded-writer-admission.ts";
import {
	buildDesktopFeedSnapshot,
	clipText,
	createDesktopFeedScheduler,
	desktopActivityState,
	DESKTOP_FEED_LIMITS,
	DESKTOP_FEED_QUESTION_TOOLS,
	desktopFeedDigest,
	pendingPrompt,
	pendingQuestionFromTool,
	realDesktopFeedTimers,
	runningAgents,
	runningJobs,
	type DesktopFeedPendingQuestion,
	type DesktopFeedSnapshot,
	type DesktopFeedTimers,
} from "../lib/desktop-feed.ts";
import { createDesktopFeedStore, sweepDesktopFeedOrphans, type DesktopFeedStore } from "../lib/desktop-feed-store.ts";
import { answerableFromDesktop, createDesktopActionInbox, DESKTOP_ACTION_LIMITS, createDesktopActivityTimeline, providerDecisionIn, questionShape, sweepDesktopActionOrphans, watchDesktopActionInbox, type DesktopActionInbox, type DesktopActionQuestion, type DesktopActivityTimeline } from "../lib/desktop-feed-actions.ts";
import { askAnswerHandle } from "../lib/desktop-feed-answers.ts";
import { DesktopPermissionBridge } from "../lib/desktop-rpc-permissions.ts";
import { createDesktopFeedProfileReader, createUntrackedLineCounter, desktopFeedGitRunner, processAncestors, type DesktopFeedProfile, type ParentOf, type UntrackedLineCounter } from "../lib/desktop-feed-sources.ts";
import { DesktopAgentsBridge } from "../lib/desktop-agents-service.ts";
import { DesktopJobsBridge } from "../lib/desktop-jobs-service.ts";
import { DesktopUsageBridge } from "../lib/desktop-usage-service.ts";
import { DesktopProfilesBridge } from "../lib/desktop-rpc-profiles.ts";
import type { DesktopRpcOutcome } from "../lib/desktop-rpc.ts";
import type { DesktopAgentEntry } from "../lib/desktop-rpc-agents.ts";
import type { DesktopJobEntry } from "../lib/desktop-rpc-jobs.ts";
import type { DesktopUsageEntry } from "../lib/desktop-rpc-usage.ts";
import { DESKTOP_SESSION_SERVICE_CHANNEL, DESKTOP_SESSION_SERVICE_SCHEMA, type DesktopSessionService } from "../lib/desktop-rpc-session.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { PROFILE_TIER_EVENT } from "../lib/openai-fast-tier.ts";
import { REVIEW_SIDEBAR_EVENT, isReviewSidebarSnapshot, type ReviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";
import { isInteractiveRpcHost } from "../lib/rpc-host.ts";
import { sessionChangeRoots } from "../lib/session-changes.ts";
import { foreignRootBranch, WorktreeChangesTracker, type GitRunner } from "../lib/shell-changes.ts";
import type { SessionStats } from "../lib/shell-stats.ts";
import { createSessionStatsFold, type SessionStatsFold } from "../lib/desktop-feed-stats.ts";
import { replayTodo, TODO_DETAILS_KEY, TODO_PROGRESS_EVENT, TODO_TOOL_NAME, type TodoState } from "../lib/shell-todo.ts";
import { discoverYoloUiAdapter, SUPER_YOLO_STATUS_TEXT, YOLO_DISPLAY, YOLO_STATUS_TEXT, type YoloUiAdapter } from "../lib/yolo-session-policy.ts";
import { NOTIFICATION_ATTENTION_EVENT } from "../lib/notification-events.ts";
import { FINISHED_STATUSES } from "../lib/agents-protocol.ts";

// Gentle Shell Desktop feed (odd/tasks/herdr-desktop.md T4, S2): every live
// Gentle Shell session keeps one bounded JSON snapshot of what its TUI shows
// under `<agentDir>/desktop/sessions/<sessionId>.json`, so the Herdr app mods
// can show the same information out of process. Every value comes from the
// existing owner through its public seam (desktop owner services, sidebar
// events, the todo/changes/stats functions); this extension keeps no store of
// its own beyond the last snapshot it wrote. It arms no timer while nothing
// changes, and an unchanged snapshot is never rewritten.
//
// S13: two tiers. A change to what the desktop must answer at once (an open or
// answered question, the permission mode, the idle/working/blocked state, a held
// prompt) is written within DESKTOP_FEED_URGENT_MS; anything else waits for the
// routine tier, at most one write per DESKTOP_FEED_BUSY_INTERVAL_MS while the
// session is busy. A flush folds only new session entries into the stats and
// reuses pi's command registry until a session start or a resource rediscovery.

export interface DesktopFeedOptions {
	env?: NodeJS.ProcessEnv;
	agentDir?: string;
	now?: () => number;
	timers?: DesktopFeedTimers;
	store?: (agentDir: string, sessionId: string) => DesktopFeedStore;
	git?: (root: string) => GitRunner;
	parentOf?: ParentOf;
	profile?: (cwd: string, sessionId: string | undefined) => DesktopFeedProfile;
	/** The persona for a session cwd; defaults to the persona.json resolution the TUI uses. */
	persona?: (cwd: string) => PersonaMode | undefined;
	realpath?: (path: string) => string | undefined;
	rootExists?: (root: string) => boolean;
	sweep?: (agentDir: string, keep: string) => void;
	/** Watches the action inbox (T7); defaults to fs.watch. */
	actionWatch?: (dir: string, onChange: () => void) => () => void;
	/** The file clock the activity timeline uses (T7); defaults to Date.now. */
	activityClock?: () => number;
}

const SUBSCRIPTION_PROVIDERS = new Set([CLAUDE_BRIDGE_PROVIDER]);

// A persona that cannot be read leaves the feed field null instead of failing the snapshot.
function safePersona(read: (cwd: string) => PersonaMode | undefined, cwd: string): PersonaMode | undefined {
	try { return read(cwd); } catch { return undefined; }
}

function permissionDetail(mode: string): string | undefined {
	const text = mode === "yolo" ? YOLO_STATUS_TEXT : mode === "super-yolo" ? SUPER_YOLO_STATUS_TEXT : undefined;
	return text?.includes(" — ") ? text.slice(text.indexOf(" — ") + 3).trim() : text;
}

interface Live {
	ctx: ExtensionContext;
	sessionId: string;
	store: DesktopFeedStore;
	lastDigest: string | undefined;
	realCwd: string | undefined;
	ancestors: number[];
	working: boolean;
	streaming: boolean;
	blocked: number;
	blockedLabel: string | undefined;
	blockedAt: number;
	askTool: DesktopFeedPendingQuestion | undefined;
	/** The open ask tool's real list shape, for desktop answers (T7). */
	askShape: DesktopActionQuestion | undefined;
	uiPrompt: DesktopFeedPendingQuestion | undefined;
	review: ReviewSidebarSnapshot | undefined;
	todo: TodoState;
	jobs: DesktopJobEntry[] | undefined;
	agents: DesktopAgentEntry[] | undefined;
	usage: DesktopUsageEntry | undefined;
	/** Every provider of the usage panel's scope, as the owner last answered (S12). */
	usageProviders: DesktopUsageEntry[] | undefined;
	/** The pending follow-up read of the usage owner, after a point where the TUI fetches. */
	usageFollow: unknown;
	/** Counts owner snapshots pushed to the feed: a read started before one is older than it. */
	usageEpoch: number;
	permission: { mode: string; defaultMode?: string; detail?: string } | undefined;
	profile: DesktopFeedProfile;
	branch: string | null | undefined;
	changes: { tracker: WorktreeChangesTracker; lines: UntrackedLineCounter; scanned: boolean; requested: boolean };
	stats: { count: number; stats: SessionStats } | undefined;
	/** S13: folds only the entries added since the last flush. */
	statsFold: SessionStatsFold;
	/** S13: pi's command registry as last read; re-read when `commandsStale`. */
	commands: ReturnType<ExtensionAPI["getCommands"]> | undefined;
	commandsStale: boolean;
	/** S13: the urgent state the last flush published (see urgentKey). */
	publishedKey: string | undefined;
	jobsBridge: DesktopJobsBridge;
	agentsBridge: DesktopAgentsBridge;
	usageBridge: DesktopUsageBridge;
	permissionBridge: DesktopPermissionBridge;
	profilesBridge: DesktopProfilesBridge;
	actions: DesktopActionInbox | undefined;
	/** When the agent, a job or a subagent could act: desktop escalations written then are refused (T7). */
	activity: DesktopActivityTimeline;
	/** The agent run in which a tool result carried a provider decision envelope (T7). */
	providerRun: number | undefined;
	runs: number;
	yolo: { adapter: YoloUiAdapter; unobserve: () => void } | undefined;
	/** pi runs a manual compaction or a /tree navigation: it refuses prompts until it ends (T11). */
	compacting: boolean;
	/** The one desktop prompt held for after it, as the TUI editor queues one. */
	held: { text: string; expand: boolean } | undefined;
	heldTimer: unknown;
	closed: boolean;
}

/**
 * S12: when the feed reads the usage owner again after a point where the TUI fetches
 * (its forced fetch at session start, its throttled one after a turn): the fetch
 * runs inside gentle-shell and tells no event when it settles, so the feed reads the
 * owner's store once soon and once after the fetch window (10 s by default). Reads
 * are in-memory: the feed itself never asks a provider.
 */
const USAGE_FOLLOW_MS = [2_000, 12_000] as const;
/** Confirmation text and notes handed to the desktop stay inside its 4 KiB answer. */
const PROFILE_ANSWER_TEXT = 1500;
const PROFILE_ANSWER_NOTES = 4;

/** How often a held prompt checks that pi takes prompts again (only while one is held). */
const HELD_PROMPT_POLL_MS = 500;
const HELD_PROMPT_DROPPED = "Gentle Shell Desktop: a prompt sent during compaction was not delivered (the session ended).";

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// The owner's apply answer, bounded for the desktop's 4 KiB result: the dialog text and the
// notes are cut (the confirmation token still binds the owner's full dialog).
function profileAnswer(outcome: DesktopRpcOutcome | undefined): DesktopRpcOutcome | undefined {
	if (!outcome || !outcome.ok) return outcome;
	const data = record(outcome.data);
	const cut = (value: unknown) => clipText(value, PROFILE_ANSWER_TEXT);
	const answer: Record<string, unknown> = { profile: data.profile, mode: data.mode, status: data.status };
	const confirmation = record(data.confirmation);
	if (data.confirmation !== undefined) answer.confirmation = { title: cut(confirmation.title), message: cut(confirmation.message), token: confirmation.token };
	if (Array.isArray(data.notes)) answer.notes = data.notes.slice(0, PROFILE_ANSWER_NOTES).map((note) => ({ level: record(note).level, text: cut(record(note).text) }));
	return { ok: true, data: answer };
}

export function createDesktopFeedExtension(options: DesktopFeedOptions = {}) {
	return (pi: ExtensionAPI): void => {
		const env = options.env ?? process.env;
		// Subagent children are not sessions a terminal shows; plain Pi is not Gentle Shell.
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || env.PI_PROGRAM_STATUS_APP !== "gentle-shell") return;
		const agentDir = options.agentDir ?? resolveGentlePiAgentHome(env);
		const now = options.now ?? Date.now;
		const timers = options.timers ?? realDesktopFeedTimers;
		const gitFor = options.git ?? ((root: string) => desktopFeedGitRunner(root, env));
		const readProfile = options.profile ?? createDesktopFeedProfileReader(env);
		const readPersona = options.persona ?? ((cwd: string) => resolvePersonaMode(cwd, gentlePiConfigHome(env)));
		const rootExists = options.rootExists ?? ((root: string) => { try { return realpathSync(root) !== ""; } catch { return false; } });
		const realpath = options.realpath ?? ((path: string) => { try { return realpathSync.native(path); } catch { return undefined; } });
		const activityClock = options.activityClock ?? Date.now;
		let live: Live | undefined;

		// Busy: the agent works, or a background job or a subagent of this session runs.
		const busyNow = (session: Live): boolean => {
			let working = session.working;
			try { working = working || session.ctx.isIdle?.() === false; } catch { /* stale context */ }
			return working
				|| (session.jobs ?? []).some((job) => job.status === "running")
				|| (session.agents ?? []).some((agent) => !FINISHED_STATUSES.includes(agent.status));
		};
		const markActivity = (session: Live) => { try { session.activity.set(busyNow(session)); } catch { /* never break the feed */ } };

		const owns = (ctx: ExtensionContext | undefined): boolean => {
			if (!live || live.closed || !ctx) return false;
			try { return ctx.sessionManager.getSessionId() === live.sessionId; } catch { return false; }
		};
		const current = (session: Live) => live === session && !session.closed;

		// S13: getEntryCount() is free; only a changed count reads the entries, and the
		// fold walks just the new ones.
		const sessionStats = (session: Live): SessionStats => {
			const manager = session.ctx.sessionManager as ExtensionContext["sessionManager"] & { getEntryCount?(): number };
			let count: number | undefined;
			try { count = manager.getEntryCount?.(); } catch { /* stale context */ }
			if (session.stats && count !== undefined && session.stats.count === count) return session.stats.stats;
			let entries: readonly unknown[] = [];
			try { entries = manager.getEntries(); } catch { /* stale context */ }
			const stats = session.statsFold.update(entries);
			session.stats = { count: count ?? entries.length, stats };
			return stats;
		};

		const pendingQuestion = (session: Live): DesktopFeedPendingQuestion | undefined => {
			if (session.askTool) return session.askTool;
			if (session.uiPrompt) return session.uiPrompt;
			// A blocker with no content of its own (review consent, a guarded command):
			// the desktop shows its label and answers through the terminal (T7).
			if (session.blocked > 0 && session.blockedLabel) return pendingPrompt("consent", session.blockedLabel, undefined, session.blockedAt);
			return undefined;
		};

		// S13: what the desktop must see at once. A change here makes the write urgent.
		// S15: the state counts background work (working / waiting / idle), as the snapshot does.
		const urgentKey = (session: Live): string => {
			const question = pendingQuestion(session);
			return JSON.stringify([
				desktopActivityState(session, runningAgents(session.agents), runningJobs(session.jobs?.slice(0, DESKTOP_FEED_LIMITS.jobs))),
				question ? [question.kind, question.toolCallId, question.question, question.terminalOnly, question.openedAt] : null,
				session.permission?.mode ?? null,
				session.held ? 1 : 0,
			]);
		};

		// The snapshot of what the TUI shows now. The flush writes it; the Desktop
		// RPC session seam (#3319) reads it live. Building has no side effect beyond
		// the command-registry and stats-fold caches.
		const buildSnapshot = (session: Live): DesktopFeedSnapshot => {
			const { ctx } = session;
			const manager = ctx.sessionManager;
			const model = ctx.model;
			let subscription = false;
			try { subscription = model ? SUBSCRIPTION_PROVIDERS.has(model.provider) || ctx.modelRegistry.isUsingOAuth(model) : false; } catch { subscription = false; }
			let context: ReturnType<ExtensionContext["getContextUsage"]>;
			try { context = ctx.getContextUsage(); } catch { context = undefined; }
			let thinkingLevel: string | undefined;
			try { thinkingLevel = pi.getThinkingLevel(); } catch { thinkingLevel = undefined; }
			// The command registry (T10): extension commands, prompt templates, skills.
			// S13: read once per session start or resource rediscovery, not per flush.
			if (session.commandsStale) {
				session.commandsStale = false;
				try { session.commands = typeof pi.getCommands === "function" ? pi.getCommands() : undefined; } catch { session.commands = undefined; }
			}
			const commands = session.commands;
			return buildDesktopFeedSnapshot({
				now: now(),
				identity: {
					sessionId: session.sessionId,
					sessionFile: manager.getSessionFile?.(),
					sessionName: manager.getSessionName?.(),
					cwd: ctx.cwd,
					realCwd: session.realCwd,
					pid: process.pid,
					ppid: process.ppid,
					ancestors: session.ancestors,
					mode: ctx.mode,
					agentDir,
					env,
				},
				branch: session.branch,
				model: model ? { id: model.id, provider: model.provider, reasoning: Boolean(model.reasoning) } : undefined,
				thinkingLevel,
				subscription,
				profile: session.profile,
				persona: safePersona(readPersona, ctx.cwd),
				context: context ? { percent: context.percent, tokens: context.tokens, contextWindow: context.contextWindow } : undefined,
				usage: session.usage,
				usageProviders: session.usageProviders,
				permission: session.permission,
				todo: session.todo,
				changes: session.changes.scanned ? { model: session.changes.tracker.model, worktrees: session.changes.tracker.worktrees, uncounted: session.changes.lines.uncounted() } : undefined,
				agents: session.agents,
				jobs: session.jobs,
				review: session.review,
				stats: sessionStats(session),
				activity: { working: session.working, blocked: session.blocked, blockedLabel: session.blockedLabel, streaming: session.streaming, phase: oddPhaseRegistry.get(session.sessionId) },
				pendingQuestion: pendingQuestion(session),
				commands,
			});
		};
		// #3319: the Desktop RPC session seam's observers, told of each snapshot a flush publishes.
		const snapshotObservers = new Set<(sessionId: string, snapshot: DesktopFeedSnapshot) => void>();
		const flush = () => {
			const session = live;
			if (!session || session.closed) return;
			try {
				// Changes are Git work: never at the session start itself, first at the
				// first flush (once the shell registered its roots), then per settled turn.
				if (!session.changes.requested) refreshChanges(session);
				session.publishedKey = urgentKey(session);
				const snapshot = buildSnapshot(session);
				const digest = desktopFeedDigest(snapshot);
				if (digest === session.lastDigest) return;
				// The same tiers as the file: an observer hears a changed snapshot when it is written.
				for (const observer of [...snapshotObservers]) {
					try { observer(session.sessionId, snapshot); } catch { /* an observer never breaks the feed */ }
				}
				if (session.store.write(snapshot)) session.lastDigest = digest;
			} catch { /* The feed is display data: it never interrupts Pi. */ }
		};
		const scheduler = createDesktopFeedScheduler(flush, timers, { now, busy: () => (live && !live.closed ? busyNow(live) : false) });
		const schedule = () => {
			const session = live;
			if (!session || session.closed) return;
			let urgent = false;
			try { urgent = urgentKey(session) !== session.publishedKey; } catch { urgent = false; }
			scheduler.schedule(urgent);
		};

		const refreshChanges = (session: Live) => {
			session.changes.requested = true;
			const { ctx } = session;
			const cwd = ctx.cwd;
			void foreignRootBranch(gitFor(cwd)).then((branch) => branch ?? null, () => undefined).then((branch) => {
				if (!current(session) || branch === session.branch) return;
				session.branch = branch;
				schedule();
			});
			void session.changes.tracker.refresh().then(() => {
				if (!current(session)) return;
				session.changes.scanned = true;
				schedule();
			}, () => undefined);
		};

		// The usage panel's scope as the owner answered it: the session's provider is `usage`.
		const takeUsage = (session: Live, providers: DesktopUsageEntry[], only: string | undefined) => {
			if (only === undefined) session.usageProviders = providers;
			else {
				const list = [...(session.usageProviders ?? [])];
				for (const entry of providers) {
					const at = list.findIndex((item) => item.provider === entry.provider);
					if (at >= 0) list[at] = entry; else list.push(entry);
				}
				session.usageProviders = list;
			}
			const active = session.ctx.model?.provider;
			session.usage = session.usageProviders.find((entry) => entry.provider === active);
		};

		// Reads the owner's store (never a fetch). `follow`: the TUI fetches now, so read
		// again on USAGE_FOLLOW_MS to show what that fetch brings.
		const refreshUsage = (session: Live, follow = false) => {
			if (follow) followUsage(session, 0);
			const epoch = session.usageEpoch;
			void session.usageBridge.handle("get_subscription_usage", {}).then((outcome) => {
				// A snapshot pushed while this read was in flight is newer than its answer.
				if (!current(session) || !outcome || !outcome.ok || epoch !== session.usageEpoch) return;
				takeUsage(session, (record(outcome.data).providers ?? []) as DesktopUsageEntry[], undefined);
				schedule();
			}, () => undefined);
		};
		const followUsage = (session: Live, step: number) => {
			if (session.usageFollow !== undefined) { timers.clear(session.usageFollow); session.usageFollow = undefined; }
			const at = USAGE_FOLLOW_MS[step];
			if (at === undefined || !current(session)) return;
			const wait = at - (step > 0 ? USAGE_FOLLOW_MS[step - 1]! : 0);
			session.usageFollow = timers.set(() => {
				session.usageFollow = undefined;
				if (!current(session)) return;
				refreshUsage(session);
				followUsage(session, step + 1);
			}, wait);
		};

		const refreshPermission = (session: Live) => {
			const adapter = session.yolo?.adapter;
			if (!adapter || typeof adapter.readSnapshot !== "function") return;
			void adapter.readSnapshot().then((snapshot) => {
				if (!current(session)) return;
				session.permission = !snapshot || snapshot.yolo === YOLO_DISPLAY.unavailable ? undefined
					: { mode: snapshot.mode, defaultMode: snapshot.defaultMode, detail: permissionDetail(snapshot.mode) };
				schedule();
			}, () => undefined);
		};

		const refreshProfile = (session: Live) => {
			try { session.profile = readProfile(session.ctx.cwd, session.sessionId); } catch { /* keep the last answer */ }
			schedule();
		};

		// pi refuses a prompt during a manual compaction or a /tree navigation and its
		// runtime swallows the error (V9): the session holds the text instead, as the TUI
		// editor does, until pi takes prompts again. Busy with no agent run started is
		// treated the same: a compaction this extension did not hear of yet.
		const refusesPrompts = (session: Live): boolean => {
			if (session.compacting) return true;
			try { return session.ctx.isIdle() === false && !session.working; } catch { return false; }
		};
		const armHeld = (session: Live, ms: number) => {
			if (session.heldTimer !== undefined) { timers.clear(session.heldTimer); session.heldTimer = undefined; }
			if (!session.held || !current(session)) return;
			session.heldTimer = timers.set(() => { session.heldTimer = undefined; releaseHeld(session); }, ms);
		};
		const releaseHeld = (session: Live) => {
			if (!session.held || !current(session)) return;
			// Idle means no compaction (pi: isIdle = no run and not compacting), whatever ended it.
			let idle = false;
			try { idle = session.ctx.isIdle() === true; } catch { idle = false; }
			if (idle) session.compacting = false;
			if (refusesPrompts(session)) { armHeld(session, HELD_PROMPT_POLL_MS); return; }
			const { text, expand } = session.held;
			session.held = undefined;
			try { pi.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: expand }); } catch { /* pi reports it */ }
			schedule();
		};
		// After pi's own end event: pi clears its compaction state once its handlers return.
		const compactionEnded = (session: Live) => {
			session.compacting = false;
			armHeld(session, 0);
		};

		const close = () => {
			const session = live;
			live = undefined;
			scheduler.cancel();
			if (!session) return;
			session.closed = true;
			if (session.heldTimer !== undefined) { try { timers.clear(session.heldTimer); } catch { /* gone */ } session.heldTimer = undefined; }
			if (session.usageFollow !== undefined) { try { timers.clear(session.usageFollow); } catch { /* gone */ } session.usageFollow = undefined; }
			if (session.held) {
				session.held = undefined;
				try { session.ctx.ui?.notify?.(HELD_PROMPT_DROPPED, "error"); } catch { /* the UI is gone */ }
			}
			try { session.actions?.close(); } catch { /* never break shutdown */ }
			for (const bridge of [session.jobsBridge, session.agentsBridge, session.usageBridge, session.permissionBridge, session.profilesBridge]) {
				try { bridge.reset(); } catch { /* owner teardown */ }
			}
			try { session.yolo?.unobserve(); session.yolo?.adapter.dispose(); } catch { /* owner teardown */ }
			try { session.store.remove(); } catch { /* never break shutdown */ }
		};

		const open = (ctx: ExtensionContext) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			const store = (options.store ?? createDesktopFeedStore)(agentDir, sessionId);
			let todo: TodoState;
			try { todo = replayTodo(ctx.sessionManager.getBranch()); } catch { todo = replayTodo([]); }
			const roots = () => {
				try { return sessionChangeRoots(sessionId, ctx.sessionManager.getEntries() as never).filter((root) => rootExists(root) && !isHomeOrBroadUserDirectory(root)); }
				catch { return []; }
			};
			const lines = createUntrackedLineCounter();
			const session: Live = {
				ctx, sessionId, store, lastDigest: undefined,
				realCwd: realpath(ctx.cwd), ancestors: [],
				working: ctx.isIdle?.() === false, streaming: false, blocked: 0, blockedLabel: undefined, blockedAt: 0,
				askTool: undefined, askShape: undefined, uiPrompt: undefined, review: undefined, todo,
				jobs: undefined, agents: undefined, usage: undefined, usageProviders: undefined, usageFollow: undefined, usageEpoch: 0, permission: undefined,
				profile: { name: undefined, tier: undefined }, branch: undefined,
				changes: { tracker: new WorktreeChangesTracker(gitFor(ctx.cwd), gitFor, lines.forRoot, roots), lines, scanned: false, requested: false },
				stats: undefined, statsFold: createSessionStatsFold(), commands: undefined, commandsStale: true, publishedKey: undefined,
				jobsBridge: new DesktopJobsBridge(pi), agentsBridge: new DesktopAgentsBridge(pi), usageBridge: new DesktopUsageBridge(pi),
				permissionBridge: new DesktopPermissionBridge(pi), profilesBridge: new DesktopProfilesBridge(pi), actions: undefined,
				activity: createDesktopActivityTimeline(activityClock), providerRun: undefined, runs: 0,
				yolo: undefined, compacting: false, held: undefined, heldTimer: undefined, closed: false,
			};
			markActivity(session);
			live = session;
			try {
				if (options.sweep) options.sweep(agentDir, store.path);
				else {
					sweepDesktopFeedOrphans(agentDir, store.path);
					// After the snapshot sweep: a dead session's inbox/outbox has no snapshot left.
					sweepDesktopActionOrphans(agentDir, sessionId);
				}
			} catch { /* never block a start */ }

			// Owners reached through their existing desktop seams; each change schedules a write.
			session.jobsBridge.attach(ctx);
			session.jobsBridge.wire((_event, data) => { if (!current(session)) return; session.jobs = (data.jobs as DesktopJobEntry[] | undefined) ?? []; markActivity(session); schedule(); });
			void session.jobsBridge.start().then(() => session.jobsBridge.handle("list_jobs", {})).then((outcome) => {
				if (!current(session) || !outcome?.ok) return;
				session.jobs = (record(outcome.data).jobs as DesktopJobEntry[] | undefined) ?? [];
				markActivity(session);
				schedule();
			}, () => undefined);
			session.agentsBridge.attach(ctx);
			session.agentsBridge.wire((_event, data) => { if (!current(session)) return; session.agents = (data.agents as DesktopAgentEntry[] | undefined) ?? []; markActivity(session); schedule(); });
			void session.agentsBridge.start().then(() => session.agentsBridge.handle("list_subagents", {})).then((outcome) => {
				if (!current(session) || !outcome?.ok) return;
				session.agents = (record(outcome.data).agents as DesktopAgentEntry[] | undefined) ?? [];
				markActivity(session);
				schedule();
			}, () => undefined);
			session.usageBridge.attach(ctx);
			session.usageBridge.wire((_event, data) => {
				if (!current(session)) return;
				// A response-carried (or refreshed) snapshot: one provider of the panel's scope.
				const entries = ((data.snapshots ?? []) as DesktopUsageEntry[]).filter((item) => item && typeof item.provider === "string");
				if (entries.length === 0) return;
				session.usageEpoch += 1;
				takeUsage(session, entries, entries[0]!.provider);
				schedule();
			});
			// gentle-shell fetches at session start (forced): read now, and again once it settled.
			refreshUsage(session, true);
			void discoverYoloUiAdapter(pi, ctx).then((adapter) => {
				if (!adapter) return;
				if (!current(session)) { try { adapter.dispose(); } catch { /* owner teardown */ } return; }
				let unobserve = () => {};
				try { unobserve = adapter.observe(() => refreshPermission(session)); } catch { /* read once */ }
				session.yolo = { adapter, unobserve };
				refreshPermission(session);
			}, () => undefined);
			void processAncestors(process.ppid, DESKTOP_FEED_LIMITS.ancestors, options.parentOf).then((ancestors) => {
				if (!current(session) || ancestors.length === 0) return;
				session.ancestors = ancestors;
				schedule();
			});
			refreshProfile(session);
			openActions(session);
			schedule();
		};

		// Desktop actions (T7): the same owners and bridges the desktop RPC uses,
		// bound to this session; each owner still decides.
		const openActions = (session: Live) => {
			session.permissionBridge.attach(session.ctx);
			session.profilesBridge.attach(session.ctx);
			const actions = createDesktopActionInbox({
				agentDir,
				sessionId: session.sessionId,
				now,
				timers,
				watch: options.actionWatch ?? watchDesktopActionInbox,
				owners: {
					setPermissionMode: (mode) => session.permissionBridge.handle("set_permission_mode", { mode }),
					cancelJob: (id) => session.jobsBridge.handle("cancel_job", { id }),
					cancelSubagent: (id) => session.agentsBridge.handle("cancel_subagent", { id }),
					question: () => (current(session) ? session.askShape : undefined),
					// The TUI's Esc Esc: in the TUI, ctx.abort() is pi's interrupt (queued
					// messages go back to the editor), the same path the key takes.
					working: () => { try { return current(session) && session.ctx.isIdle() === false; } catch { return false; } },
					abortTurn: () => { session.ctx.abort(); },
					permissionMode: () => session.permission?.mode,
					// Read the state now first: an activity no event announced still counts.
					busyAt: (time) => { markActivity(session); return session.activity.busyAt(time); },
					// The inbox file alone never raises the mode: the human says yes here.
					// T11 (S10): prompts and answers for a session the desktop has no terminal for.
					questionOpen: () => current(session) && pendingQuestion(session) !== undefined,
					commandSource: (name) => {
						try { return typeof pi.getCommands === "function" ? pi.getCommands().find((command) => command.name === name)?.source : undefined; }
						catch { return undefined; }
					},
					// The TUI editor's submit: a prompt while idle, a steer while the agent works.
					sendPrompt: (text, expand) => {
						if (refusesPrompts(session)) {
							if (session.held) return { compacting: true };
							session.held = { text, expand };
							armHeld(session, HELD_PROMPT_POLL_MS);
							schedule();
							return session.compacting ? { queued: true, after: "compaction" } : { queued: true };
						}
						let queued = false;
						try { queued = session.ctx.isIdle() === false; } catch { queued = false; }
						pi.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: expand });
						return { queued };
					},
					// The ask tool's own list answers it (lib/desktop-feed-answers.ts), once.
					answerQuestion: (toolCallId, answer) => {
						const handle = current(session) ? askAnswerHandle(toolCallId) : undefined;
						if (!handle) return false;
						try { return handle.answer(answer) === true; } catch { return false; }
					},
					// S12: the TUI panel's r. The answer names each provider's status; the snapshot carries the rest.
					refreshUsage: async (provider) => {
						const outcome = await session.usageBridge.handle("refresh_subscription_usage", provider === undefined ? {} : { provider });
						if (!outcome || !outcome.ok || !current(session)) return outcome;
						const providers = (record(outcome.data).providers ?? []) as DesktopUsageEntry[];
						session.usageEpoch += 1;
						takeUsage(session, providers, provider);
						schedule();
						return { ok: true, data: { providers: providers.map((entry) => ({ provider: entry.provider, status: entry.status, ...(entry.refresh ? { refresh: entry.refresh } : {}) })) } };
					},
					// S12: /gentle:profiles' "Use in this session", through its own apply; never the global default.
					applyProfile: async (name, confirmation) => {
						const outcome = await session.profilesBridge.handle("apply_profile", { profile: name, mode: "session", ...(confirmation === undefined ? {} : { confirmation }) });
						if (current(session)) refreshProfile(session);
						return profileAnswer(outcome);
					},
					confirmEscalation: async (from, to) => {
						const ui = session.ctx.ui as { confirm?: ExtensionContext["ui"]["confirm"] } | undefined;
						if (!current(session) || typeof ui?.confirm !== "function") return false;
						try {
							return (await ui.confirm("Raise the permission mode?", `Gentle Shell Desktop asks to switch this session from ${from ?? "normal"} to ${to}. Confirm only if you asked for it there.`, { timeout: DESKTOP_ACTION_LIMITS.confirmMs })) === true;
						} catch { return false; }
					},
				},
			});
			session.actions = actions;
			actions.start();
		};

		// #3319: the Desktop RPC session seam. The adapter is bound to the asking
		// session: it reads that session's live snapshot and hears its flushes only.
		// The feed answers only where it runs (the TUI or an interactive RPC host).
		pi.events.on(DESKTOP_SESSION_SERVICE_CHANNEL, (data: unknown) => {
			const request = record(data);
			const context = request.context as ExtensionContext | undefined;
			if (typeof request.respond !== "function" || !context) return;
			let sessionId: string | undefined;
			try {
				if (!context.hasUI || (context.mode !== "tui" && !isInteractiveRpcHost(context.mode, env))) return;
				sessionId = context.sessionManager.getSessionId();
			} catch { return; }
			if (!sessionId) return;
			const bound = sessionId;
			let disposed = false;
			const mine = new Set<(sessionId: string, snapshot: DesktopFeedSnapshot) => void>();
			const service: DesktopSessionService = {
				schema: DESKTOP_SESSION_SERVICE_SCHEMA,
				read: () => {
					const session = live;
					if (disposed || !session || session.closed || session.sessionId !== bound) return undefined;
					try { return buildSnapshot(session); } catch { return undefined; }
				},
				observe: (onSnapshot) => {
					const observer = (id: string, snapshot: DesktopFeedSnapshot) => { if (!disposed && id === bound) onSnapshot(snapshot); };
					mine.add(observer);
					snapshotObservers.add(observer);
					return () => { mine.delete(observer); snapshotObservers.delete(observer); };
				},
				dispose: () => {
					disposed = true;
					for (const observer of mine) snapshotObservers.delete(observer);
					mine.clear();
				},
			};
			(request.respond as (service: DesktopSessionService) => void)(service);
		});

		// Bus listeners are registered once; each one only speaks for the live session.
		pi.events.on(NOTIFICATION_ATTENTION_EVENT, (data: unknown) => {
			if (!live || live.closed) return;
			const event = record(data);
			if (event.active === true) {
				if (live.blocked === 0) live.blockedAt = now();
				live.blocked += 1;
				live.blockedLabel = typeof event.label === "string" ? event.label : live.blockedLabel;
			} else {
				live.blocked = Math.max(0, live.blocked - 1);
				if (live.blocked === 0) live.blockedLabel = undefined;
			}
			schedule();
		});
		pi.events.on(REVIEW_SIDEBAR_EVENT, (data: unknown) => {
			const event = record(data);
			if (!live || event.sessionId !== live.sessionId || !isReviewSidebarSnapshot(event.snapshot)) return;
			live.review = { state: event.snapshot.state, scope: event.snapshot.scope };
			schedule();
		});
		pi.events.on(TODO_PROGRESS_EVENT, () => schedule());
		pi.events.on(PROFILE_TIER_EVENT, () => { if (live && !live.closed) refreshProfile(live); });

		pi.on("session_start", (_event, ctx) => {
			close();
			// The interactive TUI, or an interactive RPC host (the desktop app); never print/json.
			if (!ctx.hasUI || (ctx.mode !== "tui" && !isInteractiveRpcHost(ctx.mode, env))) return;
			try { open(ctx); } catch { close(); }
		});
		pi.on("session_shutdown", (_event, ctx) => { if (owns(ctx)) close(); });
		// S13: skills and prompt templates an extension adds are read again after pi rediscovers them.
		pi.on("resources_discover", () => {
			if (!live || live.closed) return;
			live.commandsStale = true;
			schedule();
		});
		pi.on("session_before_compact", (event, ctx) => {
			// Only a manual compaction makes pi refuse prompts; automatic ones queue them.
			if (owns(ctx) && (event as { reason?: string }).reason === "manual") live!.compacting = true;
		});
		pi.on("session_compact_failed", (_event, ctx) => { if (owns(ctx)) compactionEnded(live!); });
		pi.on("session_before_tree", (_event, ctx) => { if (owns(ctx)) live!.compacting = true; });
		pi.on("session_tree", (_event, ctx) => {
			if (!owns(ctx)) return;
			compactionEnded(live!);
			try { live!.todo = replayTodo(ctx.sessionManager.getBranch()); } catch { /* keep */ }
			live!.review = undefined;
			schedule();
		});
		pi.on("session_info_changed", (_event, ctx) => { if (owns(ctx)) schedule(); });
		pi.on("session_compact", (_event, ctx) => { if (owns(ctx)) { compactionEnded(live!); schedule(); } });
		pi.on("model_select", (_event, ctx) => { if (owns(ctx)) { live!.ctx = ctx; refreshUsage(live!); schedule(); } });
		pi.on("thinking_level_select", (_event, ctx) => { if (owns(ctx)) schedule(); });
		pi.on("agent_start", (_event, ctx) => {
			if (!owns(ctx)) return;
			live!.working = true;
			live!.runs += 1;
			// A run started: pi takes prompts (as steers) again.
			if (live!.compacting || live!.held) compactionEnded(live!);
			markActivity(live!);
			refreshProfile(live!);
		});
		pi.on("agent_settled", (_event, ctx) => {
			if (!owns(ctx)) return;
			const session = live!;
			if (ctx.isIdle?.() !== false) session.working = false;
			session.streaming = false;
			markActivity(session);
			refreshChanges(session);
			// gentle-shell's agent_end fetch (throttled to 5 minutes per provider): read, then follow it.
			refreshUsage(session, true);
			refreshPermission(session);
			refreshProfile(session);
		});
		pi.on("message_start", (event, ctx) => {
			if (!owns(ctx) || (event as { message?: { role?: string } }).message?.role !== "assistant") return;
			live!.streaming = true;
			schedule();
		});
		pi.on("message_end", (event, ctx) => {
			if (!owns(ctx)) return;
			if ((event as { message?: { role?: string } }).message?.role === "assistant") live!.streaming = false;
			schedule();
		});
		pi.on("tool_execution_start", (event, ctx) => {
			if (!owns(ctx)) return;
			if (!event.parentToolCallId && (DESKTOP_FEED_QUESTION_TOOLS as readonly string[]).includes(event.toolName)) {
				// A provider decision seen in this run's (or the previous run's) tool
				// results makes this question its relay: terminal only.
				const session = live!;
				const relayed = session.providerRun !== undefined && session.runs - session.providerRun <= 1;
				const shape = questionShape(event.toolName, event.toolCallId, event.args, relayed);
				session.askShape = shape;
				session.askTool = pendingQuestionFromTool(event.toolName, event.toolCallId, event.args, now(), shape ? !answerableFromDesktop(shape) : true);
			}
			schedule();
		});
		pi.on("tool_execution_end", (event, ctx) => {
			if (!owns(ctx)) return;
			const session = live!;
			if (session.askTool?.toolCallId === event.toolCallId) session.askTool = undefined;
			if (session.askShape?.toolCallId === event.toolCallId) session.askShape = undefined;
			if (!(DESKTOP_FEED_QUESTION_TOOLS as readonly string[]).includes(event.toolName) && providerDecisionIn(event.result)) session.providerRun = session.runs;
			if (event.toolName === TODO_TOOL_NAME && !event.isError) {
				const details = record(record(event.result).details);
				const state = details[TODO_DETAILS_KEY] as TodoState | undefined;
				if (state && Array.isArray(state.tasks) && !details.error) session.todo = { tasks: state.tasks, nextId: state.nextId, updatedTurn: state.updatedTurn ?? null };
			}
			schedule();
		});
		pi.on("ui_prompt_start", (event, ctx) => {
			if (!owns(ctx)) return;
			live!.uiPrompt = pendingPrompt("prompt", event.title, event.kind, now());
			schedule();
		});
		pi.on("ui_prompt_end", (_event, ctx) => {
			if (!owns(ctx)) return;
			live!.uiPrompt = undefined;
			schedule();
		});
	};
}

export default createDesktopFeedExtension();
