import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import { CLAUDE_BRIDGE_PROVIDER } from "../lib/bridge-cost.ts";
import { isHomeOrBroadUserDirectory } from "../lib/bounded-writer-admission.ts";
import {
	buildDesktopFeedSnapshot,
	createDesktopFeedScheduler,
	DESKTOP_FEED_LIMITS,
	DESKTOP_FEED_QUESTION_TOOLS,
	desktopFeedDigest,
	pendingPrompt,
	pendingQuestionFromTool,
	realDesktopFeedTimers,
	type DesktopFeedPendingQuestion,
	type DesktopFeedTimers,
} from "../lib/desktop-feed.ts";
import { createDesktopFeedStore, sweepDesktopFeedOrphans, type DesktopFeedStore } from "../lib/desktop-feed-store.ts";
import { answerableFromDesktop, createDesktopActionInbox, createDesktopActivityTimeline, providerDecisionIn, questionShape, sweepDesktopActionOrphans, watchDesktopActionInbox, type DesktopActionInbox, type DesktopActionQuestion, type DesktopActivityTimeline } from "../lib/desktop-feed-actions.ts";
import { DesktopPermissionBridge } from "../lib/desktop-rpc-permissions.ts";
import { createDesktopFeedProfileReader, createUntrackedLineCounter, desktopFeedGitRunner, processAncestors, psParentOf, type DesktopFeedProfile, type ParentOf, type UntrackedLineCounter } from "../lib/desktop-feed-sources.ts";
import { DesktopAgentsBridge } from "../lib/desktop-agents-service.ts";
import { DesktopJobsBridge } from "../lib/desktop-jobs-service.ts";
import { DesktopUsageBridge } from "../lib/desktop-usage-service.ts";
import type { DesktopAgentEntry } from "../lib/desktop-rpc-agents.ts";
import type { DesktopJobEntry } from "../lib/desktop-rpc-jobs.ts";
import type { DesktopUsageEntry } from "../lib/desktop-rpc-usage.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { PROFILE_TIER_EVENT } from "../lib/openai-fast-tier.ts";
import { REVIEW_SIDEBAR_EVENT, isReviewSidebarSnapshot, type ReviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";
import { isInteractiveRpcHost } from "../lib/rpc-host.ts";
import { sessionChangeRoots } from "../lib/session-changes.ts";
import { foreignRootBranch, WorktreeChangesTracker, type GitRunner } from "../lib/shell-changes.ts";
import { collectSessionStats, type SessionStats } from "../lib/shell-stats.ts";
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

export interface DesktopFeedOptions {
	env?: NodeJS.ProcessEnv;
	agentDir?: string;
	now?: () => number;
	timers?: DesktopFeedTimers;
	store?: (agentDir: string, sessionId: string) => DesktopFeedStore;
	git?: (root: string) => GitRunner;
	parentOf?: ParentOf;
	profile?: (cwd: string, sessionId: string | undefined) => DesktopFeedProfile;
	realpath?: (path: string) => string | undefined;
	rootExists?: (root: string) => boolean;
	sweep?: (agentDir: string, keep: string) => void;
	/** Watches the action inbox (T7); defaults to fs.watch. */
	actionWatch?: (dir: string, onChange: () => void) => () => void;
	/** The file clock the activity timeline uses (T7); defaults to Date.now. */
	activityClock?: () => number;
}

const SUBSCRIPTION_PROVIDERS = new Set([CLAUDE_BRIDGE_PROVIDER]);

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
	permission: { mode: string; defaultMode?: string; detail?: string } | undefined;
	profile: DesktopFeedProfile;
	branch: string | null | undefined;
	changes: { tracker: WorktreeChangesTracker; lines: UntrackedLineCounter; scanned: boolean; requested: boolean };
	stats: { count: number; stats: SessionStats } | undefined;
	jobsBridge: DesktopJobsBridge;
	agentsBridge: DesktopAgentsBridge;
	usageBridge: DesktopUsageBridge;
	permissionBridge: DesktopPermissionBridge;
	actions: DesktopActionInbox | undefined;
	/** When the agent, a job or a subagent could act: desktop escalations written then are refused (T7). */
	activity: DesktopActivityTimeline;
	/** The agent run in which a tool result carried a provider decision envelope (T7). */
	providerRun: number | undefined;
	runs: number;
	yolo: { adapter: YoloUiAdapter; unobserve: () => void } | undefined;
	closed: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

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

		const sessionStats = (session: Live): SessionStats => {
			const manager = session.ctx.sessionManager as ExtensionContext["sessionManager"] & { getEntryCount?(): number };
			let count = -1;
			try { count = manager.getEntryCount?.() ?? manager.getEntries().length; } catch { /* stale context */ }
			if (session.stats && session.stats.count === count && count >= 0) return session.stats.stats;
			let entries: unknown[] = [];
			try { entries = manager.getEntries(); } catch { /* stale context */ }
			const stats = collectSessionStats(entries);
			session.stats = { count, stats };
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

		const flush = () => {
			const session = live;
			if (!session || session.closed) return;
			const { ctx } = session;
			try {
				// Changes are Git work: never at the session start itself, first at the
				// first flush (once the shell registered its roots), then per settled turn.
				if (!session.changes.requested) refreshChanges(session);
				const manager = ctx.sessionManager;
				const model = ctx.model;
				let subscription = false;
				try { subscription = model ? SUBSCRIPTION_PROVIDERS.has(model.provider) || ctx.modelRegistry.isUsingOAuth(model) : false; } catch { subscription = false; }
				let context: ReturnType<ExtensionContext["getContextUsage"]>;
				try { context = ctx.getContextUsage(); } catch { context = undefined; }
				let thinkingLevel: string | undefined;
				try { thinkingLevel = pi.getThinkingLevel(); } catch { thinkingLevel = undefined; }
				// The command registry (T10): extension commands, prompt templates, skills.
				let commands: ReturnType<ExtensionAPI["getCommands"]> | undefined;
				try { commands = typeof pi.getCommands === "function" ? pi.getCommands() : undefined; } catch { commands = undefined; }
				const snapshot = buildDesktopFeedSnapshot({
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
					context: context ? { percent: context.percent, tokens: context.tokens, contextWindow: context.contextWindow } : undefined,
					usage: session.usage,
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
				const digest = desktopFeedDigest(snapshot);
				if (digest === session.lastDigest) return;
				if (session.store.write(snapshot)) session.lastDigest = digest;
			} catch { /* The feed is display data: it never interrupts Pi. */ }
		};
		const scheduler = createDesktopFeedScheduler(flush, timers);
		const schedule = () => { if (live && !live.closed) scheduler.schedule(); };

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

		const refreshUsage = (session: Live) => {
			void session.usageBridge.handle("get_subscription_usage", {}).then((outcome) => {
				if (!current(session) || !outcome || !outcome.ok) return;
				const providers = (record(outcome.data).providers ?? []) as DesktopUsageEntry[];
				const active = session.ctx.model?.provider;
				session.usage = providers.find((entry) => entry.provider === active);
				schedule();
			}, () => undefined);
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

		const close = () => {
			const session = live;
			live = undefined;
			scheduler.cancel();
			if (!session) return;
			session.closed = true;
			try { session.actions?.close(); } catch { /* never break shutdown */ }
			for (const bridge of [session.jobsBridge, session.agentsBridge, session.usageBridge, session.permissionBridge]) {
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
				jobs: undefined, agents: undefined, usage: undefined, permission: undefined,
				profile: { name: undefined, tier: undefined }, branch: undefined,
				changes: { tracker: new WorktreeChangesTracker(gitFor(ctx.cwd), gitFor, lines.forRoot, roots), lines, scanned: false, requested: false },
				stats: undefined,
				jobsBridge: new DesktopJobsBridge(pi), agentsBridge: new DesktopAgentsBridge(pi), usageBridge: new DesktopUsageBridge(pi),
				permissionBridge: new DesktopPermissionBridge(pi), actions: undefined,
				activity: createDesktopActivityTimeline(activityClock), providerRun: undefined, runs: 0,
				yolo: undefined, closed: false,
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
				const entry = ((data.snapshots ?? []) as DesktopUsageEntry[]).find((item) => item.provider === session.ctx.model?.provider);
				if (!entry) return;
				session.usage = entry;
				schedule();
			});
			refreshUsage(session);
			void discoverYoloUiAdapter(pi, ctx).then((adapter) => {
				if (!adapter) return;
				if (!current(session)) { try { adapter.dispose(); } catch { /* owner teardown */ } return; }
				let unobserve = () => {};
				try { unobserve = adapter.observe(() => refreshPermission(session)); } catch { /* read once */ }
				session.yolo = { adapter, unobserve };
				refreshPermission(session);
			}, () => undefined);
			void processAncestors(process.ppid, DESKTOP_FEED_LIMITS.ancestors, options.parentOf ?? psParentOf).then((ancestors) => {
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
				},
			});
			session.actions = actions;
			actions.start();
		};

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
		pi.on("session_tree", (_event, ctx) => {
			if (!owns(ctx)) return;
			try { live!.todo = replayTodo(ctx.sessionManager.getBranch()); } catch { /* keep */ }
			live!.review = undefined;
			schedule();
		});
		pi.on("session_info_changed", (_event, ctx) => { if (owns(ctx)) schedule(); });
		pi.on("session_compact", (_event, ctx) => { if (owns(ctx)) schedule(); });
		pi.on("model_select", (_event, ctx) => { if (owns(ctx)) { live!.ctx = ctx; refreshUsage(live!); schedule(); } });
		pi.on("thinking_level_select", (_event, ctx) => { if (owns(ctx)) schedule(); });
		pi.on("agent_start", (_event, ctx) => {
			if (!owns(ctx)) return;
			live!.working = true;
			live!.runs += 1;
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
			refreshUsage(session);
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
