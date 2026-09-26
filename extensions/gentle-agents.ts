import { agentsViewKey, agentsCollapseKey, agentsStopKey } from "../lib/agents-keys.ts";
import { spawn } from "node:child_process";
import { recordReviewMutation } from "../lib/review-reminder-receipt.ts";
import { SESSION_CHANGE_RELAY } from "../lib/session-changes.ts";
import { publishForeignSessionChange } from "../lib/session-change-capture.ts";
import { SessionWorktreeRegistry, resolveSessionWorktree, type WorktreeResolver } from "../lib/session-worktree-registry.ts";
import { ForeignTargetGrants } from "../lib/foreign-target-grants.ts";
import { MESSAGING_REASON_MAX_UTF8_BYTES, MESSAGING_REASON_MIN_CHARACTERS, normalizeMessagingReason, SessionMessagingGrants } from "../lib/session-messaging-grants.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { invalidateSidebar } from "../lib/shell-sidebar-layout.ts";
import { VISUAL_SETTINGS_CHANGED } from "../lib/shell-sidebar.ts";
import { resolveVisualSettings } from "../lib/visual-customization-policy.ts";
import { createCompletionQueue } from "../lib/agents-completion-delivery.ts";
import { createAgentMessageQueue, type PendingAgentMessage } from "../lib/agents-message-delivery.ts";
import { AGENT_MODE, discoverAgents, loadAgentsConfig, resolveAgentProfile, withPinnedModelProfiles, type AgentDefinition, type AgentMode } from "../lib/agents-config.ts";
import { resolveBackgroundSubagentsPolicy } from "../lib/background-subagents-policy.ts";
import { installBackgroundCacheWarming } from "../lib/background-cache-warming.ts";
import { isFinished, TASK_EVENT, TASK_STATUS, TaskStore, type AskRequest, type TaskRecord } from "../lib/agents-protocol.ts";
import { AgentRunner, piCommand, abortReasonText, type AskAnswer, type RunnerDeps, type TaskRequest } from "../lib/agents-runner.ts";
import { ChildMessenger, type IpcEndpoint } from "../lib/agents-messaging.ts";
import { ActiveSessionClient, ActiveSessionListener, SessionPresenceRegistry, type PresenceRecord, type ReceivedNotification, type SentNotification, type SessionPresenceCandidate } from "../lib/agents-session-transport.ts";
import { WindowsActiveSessionClient, WindowsActiveSessionListener, WindowsSessionPresenceRegistry, type WindowsSessionRegistryPhaseObserver } from "../lib/windows-session-transport.ts";
import { hasReviewSessionPermission, resolveCanonicalGitRepositoryIdentitySync, type ReviewSessionManager } from "../lib/review-session-standing-permission.ts";
import { inheritedUnsafeGitEnvironmentKeys } from "../lib/review-repository.ts";
import { historyDir, loadHistory, loadStoredTask, pruneHistory, saveTask } from "../lib/agents-history.ts";
import { sessionToMarkdown } from "../lib/agents-transcript.ts";
import { AgentsView } from "../lib/agents-view.ts";
import { withOverlayRepaint } from "../lib/overlay-repaint.ts";
import { PresencePublisher } from "../lib/orchestrator-presence.ts";
import { createRpcActivityPublisher, type RpcActivityPublisher } from "../lib/agents-rpc-publisher.ts";
import { isInteractiveRpcHost } from "../lib/rpc-host.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import { AGENTS_GLYPH, renderAgentsCard, widgetExpiryMs, widgetRows } from "../lib/agents-widget.ts";
import { CARD_TONE, renderCard } from "../lib/shell-card.ts";
import { openInExternalEditor } from "./gentle-shell.ts";
import { resolveGentlePiAgentHome, gentlePiConfigHome } from "../lib/agent-home.ts";
import { resolveProfilePin } from "../lib/agent-profile-pin.ts";
import { CHILD_METRICS_EVENT, CHILD_METRICS_REVOKED, childEvent, launchSelection, type LaunchSelection } from "../lib/runtime-metrics-children.ts";
import { runtimeMetricsEnvAllows, type RuntimeMetricsPolicyDeps } from "../lib/runtime-metrics-policy.ts";

// Gentle Agents: subagents as isolated `pi --mode rpc` children, a task
// store that notifies per task, and a Gentle Shell card above the editor.
// The tool names match the retired pi-subagents package so prompts, skills,
// and gentle-ai's delegation rules keep working unchanged.

export const AGENTS_WIDGET_KEY = "gentle-agents";
export const AGENTS_COMMAND_NAME = "gentle:agents";
export const AGENTS_RESULT_TYPE = "gentle-agents.result";
export const AGENTS_MESSAGE_TYPE = "gentle-agents.message";
export const AGENTS_ORCHESTRATOR_MESSAGE_TYPE = "gentle-agents.orchestrator-message";
export const AGENTS_STALE_RESULT_TYPE = "gentle-agents.stale-result";
const RENDER_COALESCE_MS = 400;
const CLOCK_TICK_MS = 1000;
const TOOL_PREFIX = "subagent_";

const retiredSddAgent = (name: string): boolean => /^sdd(?:-|$)/.test(name);

export interface SessionTransportRegistry {
	list(excludeSessionId?: string): Promise<readonly SessionPresenceCandidate[]>;
	listActivations(excludeSessionId?: string): Promise<readonly PresenceRecord[]>;
	close?(): Promise<void>;
}

export interface SessionTransportListener {
	readonly registry: SessionTransportRegistry;
	readonly closesRegistry?: boolean;
	start(): Promise<void>;
	close(): Promise<void>;
}

export interface SessionTransportClient {
	close(): void;
	sendNotification(recipientSessionId: string, message: string, options?: { id?: string; expectedActivation?: PresenceRecord; beforeConnect?: () => boolean | Promise<boolean>; signal?: AbortSignal }): Promise<SentNotification>;
}

export interface SessionTransportFactory {
	createRegistry(agentHome: string, observeWindowsPhase?: WindowsSessionRegistryPhaseObserver): Promise<SessionTransportRegistry>;
	createListener(registry: SessionTransportRegistry, sessionId: string, onNotification: (notification: ReceivedNotification) => Promise<void>): SessionTransportListener;
	createClient(registry: SessionTransportRegistry, sessionId: string): SessionTransportClient;
}

export interface AgentsDeps extends RunnerDeps {
	home: string;
	agentHome?: string;
	childIpc?: IpcEndpoint;
	sessionTransport?: SessionTransportFactory;
	env: NodeJS.ProcessEnv;
	resolveWorktree: WorktreeResolver;
	runtimeMetricsPolicy?: RuntimeMetricsPolicyDeps;
	metricsNow?: () => number;
	metricsSchedule?: RunnerDeps["schedule"];
}

export function agentRuntimePaths(home: string, agentHome = join(home, ".pi", "agent")): { sessions: string; transcripts: string } {
	const root = join(agentHome, "gentle-agents");
	return { sessions: join(root, "sessions"), transcripts: join(root, "transcripts") };
}

interface ToolText {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	terminate?: boolean;
}

const defaultDeps = (env: NodeJS.ProcessEnv): AgentsDeps => ({
	spawn: (command, args, options) => spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? ["pipe", "pipe", "pipe"], windowsHide: true, detached: options.detached }),
	now: () => Date.now(),
	schedule: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
	pi: piCommand(),
	home: os.homedir(),
	resolveWorktree: resolveSessionWorktree,
	env,
});

export function agentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return false;
	const value = env.GENTLE_PI_AGENTS?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}

// The retired pi-subagents package registers the same tool names. While it
// is still installed we stay out of the way and say how to switch.
export const LEGACY_SUBAGENTS_PACKAGE = "pi-subagents-j0k3r";

export function legacySubagentsInstalled(home: string): boolean {
	return legacySubagentsInstalledAt(join(home, ".pi", "agent"));
}

function legacySubagentsInstalledAt(agentHome: string): boolean {
	const settingsPath = join(agentHome, "settings.json");
	if (!existsSync(settingsPath)) return false;
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
		return Array.isArray(settings.packages) && settings.packages.some((entry) => typeof entry === "string" && entry.includes(LEGACY_SUBAGENTS_PACKAGE));
	} catch {
		return false;
	}
}

export { agentsViewKey, agentsCollapseKey, agentsStopKey };

function sanitizeTerminalText(value: string): string {
	return value.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, (control) => `\\x${control.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("\n");
}

function ownedChildIpc(env: NodeJS.ProcessEnv, candidate: IpcEndpoint | undefined): IpcEndpoint | undefined {
	if (env.GENTLE_PI_AGENTS_CHILD !== "1" || !env.GENTLE_PI_AGENTS_OWNED_IPC || !candidate || typeof candidate.send !== "function" || typeof candidate.on !== "function") return undefined;
	return candidate;
}

function registerChildMessaging(pi: ExtensionAPI, ipc: IpcEndpoint): void {
	const messenger = new ChildMessenger(ipc);
	pi.registerTool({
		name: "subagent_parent_message",
		label: "Agent parent message",
		description: "Send a bounded notification or correlated query to this subagent's parent.",
		parameters: { type: "object", additionalProperties: false, required: ["message"], properties: { kind: { type: "string", enum: ["notification", "query"] }, message: { type: "string" } } } as never,
		async execute(_id, params) {
			const input = params as { kind?: unknown; message?: unknown };
			if (typeof input.message !== "string") throw new Error("parent messages require text");
			if (input.kind === undefined || input.kind === "notification") {
				await messenger.notify(input.message);
				return { content: [{ type: "text", text: "Notification accepted by the parent." }], details: {} };
			}
			if (input.kind !== "query") throw new Error("parent messages require notification or query kind");
			const reply = await messenger.query(input.message);
			return { content: [{ type: "text", text: reply }], details: { reply } };
		},
	});
}

const posixSessionTransport: SessionTransportFactory = {
	createRegistry(agentHome) { return SessionPresenceRegistry.create(agentHome); },
	createListener(registry: SessionPresenceRegistry, sessionId, onNotification) { return Object.assign(new ActiveSessionListener(registry, sessionId, onNotification), { closesRegistry: false }); },
	createClient(registry: SessionPresenceRegistry, sessionId) { return new ActiveSessionClient(registry, sessionId); },
};

const windowsSessionTransport: SessionTransportFactory = {
	createRegistry(agentHome, observeWindowsPhase) { return WindowsSessionPresenceRegistry.create(agentHome, observeWindowsPhase); },
	createListener(registry: WindowsSessionPresenceRegistry, sessionId, onNotification) { return Object.assign(new WindowsActiveSessionListener(registry, sessionId, onNotification), { closesRegistry: true }); },
	createClient(registry: WindowsSessionPresenceRegistry, sessionId) { return new WindowsActiveSessionClient(registry, sessionId); },
};

export function createDefaultSessionTransport(platform: NodeJS.Platform = process.platform): SessionTransportFactory {
	return platform === "win32" ? windowsSessionTransport : posixSessionTransport;
}

function text(value: string, details: Record<string, unknown> = {}, terminate = false): ToolText {
	return { content: [{ type: "text", text: value }], details, ...(terminate ? { terminate: true } : {}) };
}

function taskDetails(task: TaskRecord): Record<string, unknown> {
	return { gentleAgents: { taskId: task.id, agent: task.agent, status: task.status, mode: task.mode, cwd: task.cwd } };
}

export function describeTask(task: TaskRecord): string {
	const head = `${task.id} · ${task.agent} · ${task.status} · ${task.mode}`;
	const detail = task.error ? `\n${task.error}` : "";
	return `${head} · cwd: ${task.cwd} · ${task.turns} turns · ${task.toolCalls} tool calls · last: ${task.lastStep}${detail}`;
}

function finishedText(task: TaskRecord): string {
	if (task.status === "completed") return task.result ?? "(the subagent returned no text)";
	return `Subagent ${task.agent} ${task.status}${task.error ? `: ${task.error}` : ""}${task.result ? `\n\nLast answer:\n${task.result}` : ""}`;
}

// pi's keybinding hint needs a live theme; outside one (tests, headless) the
// plain words still tell the reader what the key does.
function expandHint(expanded: boolean): string {
	try {
		return keyHint("app.tools.expand", expanded ? "collapse" : "expand");
	} catch {
		return expanded ? "collapse" : "expand";
	}
}

// The default mode for a subagent_run request that named neither an explicit
// mode nor an agent-defined one. Background is a runtime default only when
// the background-subagents policy is on AND the parent can receive results:
// print mode exits before a parent session exists to deliver them to (see
// the `ctx.mode === "print"` guard in `launch` below), so it must keep the
// configured default (normally task) even when the policy is on.
export function resolveDefaultSubagentMode(input: {
	configuredDefault: AgentMode;
	policy: "on" | "off";
	parentMode: string | undefined;
}): AgentMode {
	return input.policy === "on" && input.parentMode !== "print"
		? AGENT_MODE.BACKGROUND
		: input.configuredDefault;
}

// What the model reads when a background task ends: the outcome first, then
// the answer itself. The card renderer shows the same text.
export function completionText(task: TaskRecord): string {
	const outcome = task.status === "completed" ? "finished" : task.status.replace("_", " ");
	return `Subagent ${task.agent} (task ${task.id}, "${task.label}") ${outcome}.\n\n${finishedText(task)}`;
}

// Host-side answer to a child's dialog: the same ctx.ui the human already
// uses, so a subagent's question looks like any other pi dialog.
export async function answerThroughUi(ui: ExtensionContext["ui"] | undefined, ask: AskRequest, raw: Record<string, unknown>): Promise<AskAnswer> {
	if (!ui) return { cancelled: true };
	const title = `${AGENTS_GLYPH} ${ask.title}`;
	switch (ask.method) {
		case "select": {
			const options = Array.isArray(raw.options) ? raw.options.map(String) : [];
			const value = await ui.select(title, options);
			return value === undefined ? { cancelled: true } : { value };
		}
		case "confirm":
			return { confirmed: await ui.confirm(title, typeof raw.message === "string" ? raw.message : "") };
		case "input": {
			const value = await ui.input(title, typeof raw.placeholder === "string" ? raw.placeholder : undefined);
			return value === undefined ? { cancelled: true } : { value };
		}
		case "editor": {
			const value = await ui.editor(title, typeof raw.prefill === "string" ? raw.prefill : undefined);
			return value === undefined ? { cancelled: true } : { value };
		}
		default:
			return { cancelled: true };
	}
}

export default function gentleAgents(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, overrides: Partial<AgentsDeps> = {}): void {
	const childIpc = ownedChildIpc(env, overrides.childIpc ?? (process.send ? process as unknown as IpcEndpoint : undefined));
	if (env.GENTLE_PI_AGENTS_CHILD === "1") {
		// A stale managed-SDD child must never inherit unrestricted ordinary tools.
		if (env.GENTLE_PI_RESEARCH_TOOLS !== undefined || env.GENTLE_PI_RESEARCH_SELECTION !== undefined || env.GENTLE_PI_RESEARCH_ARTIFACT !== undefined || env.GENTLE_PI_SDD_REMEDIATION_PLAN !== undefined) {
			pi.on("tool_call", () => ({ block: true, reason: "Retired SDD child launch is not supported." }));
			return;
		}
		if (childIpc) registerChildMessaging(pi, childIpc);
		return;
	}
	if (!agentsEnabled(env)) return;
	const deps: AgentsDeps = { ...defaultDeps(env), ...overrides };
	const selectedHome = overrides.agentHome ?? (overrides.home === undefined ? resolveGentlePiAgentHome(deps.env) : join(deps.home, ".pi", "agent"));
	// Expand environment tildes like Pi, but leave explicit path APIs literal.
	const environmentHome = overrides.agentHome === undefined && overrides.home === undefined;
	const expandedHome = environmentHome && selectedHome === "~" ? deps.home
		: environmentHome && (selectedHome.startsWith("~/") || (process.platform === "win32" && selectedHome.startsWith("~\\"))) ? join(deps.home, selectedHome.slice(2)) : selectedHome;
	// Freeze the host's root before a child uses a different session cwd.
	const agentHome = resolve(expandedHome);
	const sessionTransport = deps.sessionTransport ?? createDefaultSessionTransport();
	if (legacySubagentsInstalledAt(agentHome)) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`${AGENTS_GLYPH} Gentle Agents is waiting: remove the old package first with "pi remove npm:${LEGACY_SUBAGENTS_PACKAGE}"`, "warning");
		});
		return;
	}
	const collapseKey = agentsCollapseKey(env);
	const viewKey = agentsViewKey(env);
	const stopKey = agentsStopKey(env);
	const store = new TaskStore();
	const restoredTaskIds = new Set<string>();
	const tasksDir = historyDir(deps.home, agentHome);
	let ui: ExtensionContext["ui"] | undefined;
	let host: { requestRender(): void } | undefined;
	let sidebarTui: TUI | undefined;
	const visualHome = gentlePiConfigHome(env);
	let agentsVisible = resolveVisualSettings({ gentlePiConfigHome: visualHome }).settings.visibility.agents;
	let stopVisualUpdates: (() => void) | undefined;
	let sessions: ExtensionContext["sessionManager"] | undefined;
	let presence: PresencePublisher | undefined;
	let rpcActivityPublisher: RpcActivityPublisher | undefined;
	// Messages already surfaced to the user this session through the RPC
	// activity publisher's `onError`, so a recurring push failure (the
	// coalescing window retries every burst) notifies at most once per
	// session instead of flooding the UI. Reset on every `session_start`.
	let notifiedRpcActivityErrors: Set<string> | undefined;
	const overlays = new Set<AgentsView>();
	const publishActivity = () => {
		if (!sessions) return;
		try {
			if (!presence || presence.error) {
				presence = PresencePublisher.start({ profile: agentHome, sessionId: activeSessionId() ?? "",
					label: sessions.getSessionName?.() || sessions.getCwd().split(/[\\/]/).pop() || "Orchestrator", activity: [] });
			}
			presence?.update(store.list(activeSessionId()).filter((task) => !isFinished(task.status) && !restoredTaskIds.has(task.id)).map((task) => ({ task, thread: store.thread(task.id) })));
		} catch { presence?.dispose(); presence = undefined; }
	};
	let worktrees: SessionWorktreeRegistry | undefined;
	const foreignGrants = new ForeignTargetGrants();
	const messagingGrants = new SessionMessagingGrants();
	const foreignTasks = new Map<string, { root: string; commonDir: string; manager: ExtensionContext["sessionManager"] }>();
	const foreignRequests = new WeakMap<TaskRequest, { root: string; commonDir: string; manager: ExtensionContext["sessionManager"] }>();
	const registryFor = (ctx: ExtensionContext) => {
		if (!worktrees || worktrees.sessionId !== ctx.sessionManager.getSessionId()) {
			worktrees?.close();
			worktrees = new SessionWorktreeRegistry(pi, ctx.sessionManager, ctx.sessionManager.getCwd(), deps.resolveWorktree);
		}
		return worktrees;
	};
	let collapsed = false;
	let renderQueued = false;
	let cancelClock: (() => void) | undefined;
	const ownedTaskIds = new Set<string>();
	// One diagnostic note per (task, guard): a dropped mutation says why once,
	// not once per file, so a chatty child cannot flood its own thread.
	const droppedAttributionGuards = new Set<string>();
	const stoppingTaskIds = new Set<string>();
	const yieldedTaskIds = new Set<string>();
	const metricsNow = deps.metricsNow ?? (() => performance.now());
	let metricsOwner = {};
	const metricTasks = new Map<string, { selection?: LaunchSelection; started: number; launched: boolean; finished: boolean; current(): boolean; valid(): boolean }>();
	const unsubscribeMetrics = pi.events.on(CHILD_METRICS_REVOKED, id => {
		if (id === activeSessionId()) {
			metricsOwner = {};
			for (const taskId of metricTasks.keys()) runner.discardResponseObservations(taskId);
			metricTasks.clear();
		}
	});
	const clearTaskMetrics = () => {
		metricsOwner = {};
		for (const taskId of metricTasks.keys()) runner.discardResponseObservations(taskId);
		metricTasks.clear();
	};
	pi.on("session_start", clearTaskMetrics);
	pi.on("session_shutdown", () => {
		clearTaskMetrics();
		unsubscribeMetrics();
	});
	let stopAllConfirmation: Promise<void> | undefined;

	// The card and its clock follow the session pi has open right now; a task
	// started before /new or /resume stays in the store and comes back with
	// its session. Before the first session_start there is nothing to scope by.
	const activeSessionId = (): string | undefined => (sessions === undefined ? undefined : sessions.getSessionId() ?? "");
	// Pi 0.86.1 adds this event; the package's pinned 0.85.1 types predate it.
	installBackgroundCacheWarming(pi as unknown as Parameters<typeof installBackgroundCacheWarming>[0], () => ({
		sessionId: activeSessionId(),
		ownedTaskIds,
		tasks: store.list(activeSessionId()),
	}));
	const visibleTasks = (): TaskRecord[] => store.list(activeSessionId());
	type SessionTransport = { generation: number; sessionId: string; sessionManager: ExtensionContext["sessionManager"]; client: SessionTransportClient; listener: SessionTransportListener; registry: SessionTransportRegistry; close(): Promise<void> };
	let transportGeneration = 0;
	let activeSessionTransport: SessionTransport | undefined;
	const pendingTransportStartups = new Set<Promise<void>>();
	const validTransportSessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
	const closeSessionTransport = async (transport: SessionTransport | undefined) => {
		if (!transport) return;
		await transport.close();
	};
	const trackTransportOperation = (operation: Promise<void>) => {
		pendingTransportStartups.add(operation);
		operation.then(() => { pendingTransportStartups.delete(operation); }, () => { pendingTransportStartups.delete(operation); });
		return operation;
	};
	const startSessionTransport = (ctx: ExtensionContext) => {
		const previous = activeSessionTransport;
		const generation = ++transportGeneration;
		const sessionManager = ctx.sessionManager;
		activeSessionTransport = undefined;
		const operation = (async () => {
			let registry: SessionTransportRegistry | undefined;
			let listener: SessionTransportListener | undefined;
			let client: SessionTransportClient | undefined;
			let closePromise: Promise<void> | undefined;
			const closeStartupTransport = () => {
				if (closePromise) return closePromise;
				closePromise = Promise.resolve().then(async () => {
					await Promise.allSettled([
						(async () => { try { client?.close(); } catch {} })(),
						(async () => { try { await listener?.close(); } catch {} })(),
						(async () => { try { if (registry && (!listener || !listener.closesRegistry)) await registry.close?.(); } catch {} })(),
					]);
				});
				return closePromise;
			};
			try {
				if (previous) trackTransportOperation(closeSessionTransport(previous));
				const sessionId = sessionManager.getSessionId();
				if (!validTransportSessionId(sessionId) || sessions !== sessionManager || generation !== transportGeneration) return;
				registry = await sessionTransport.createRegistry(agentHome);
				if (sessions !== sessionManager || generation !== transportGeneration) {
					await closeStartupTransport();
					return;
				}
				listener = sessionTransport.createListener(registry, sessionId, async (notification) => {
					const active = activeSessionTransport;
					if (!active || active.generation !== generation || active.sessionManager !== sessionManager || active.sessionId !== sessionId || sessions !== sessionManager || activeSessionId() !== sessionId) throw new Error("stale session transport");
					pi.sendMessage({ customType: AGENTS_ORCHESTRATOR_MESSAGE_TYPE, content: `Session message from ${notification.senderSessionId} (correlation ${notification.id}): ${notification.message}`, display: true, details: { gentleAgents: { senderSessionId: notification.senderSessionId, recipientSessionId: sessionId, correlationId: notification.id, direction: "incoming" } } }, { deliverAs: "followUp", triggerTurn: true });
				});
				client = sessionTransport.createClient(registry, sessionId);
				if (sessions !== sessionManager || generation !== transportGeneration || activeSessionId() !== sessionId) {
					await closeStartupTransport();
					return;
				}
				const transport = { generation, sessionId, sessionManager, client, listener, registry, close: closeStartupTransport };
				// The listener deliberately accepts while publishing. Bind its callback
				// first so a peer accepted in that interval remains current-session work.
				activeSessionTransport = transport;
				await listener.start();
				if (sessions !== sessionManager || generation !== transportGeneration || activeSessionId() !== sessionId) {
					if (activeSessionTransport === transport) activeSessionTransport = undefined;
					await closeStartupTransport();
					return;
				}
			} catch {
				if (activeSessionTransport?.generation === generation) activeSessionTransport = undefined;
				await closeStartupTransport();
			}
		})();
		trackTransportOperation(operation);
		return operation;
	};
	const shutdownSessionTransport = async () => {
		const active = activeSessionTransport;
		activeSessionTransport = undefined;
		transportGeneration++;
		if (active) await closeSessionTransport(active);
		while (pendingTransportStartups.size > 0) {
			await Promise.allSettled([...pendingTransportStartups]);
		}
	};
	const activeTransportFor = (ctx: ExtensionContext) => {
		const active = activeSessionTransport;
		const sessionId = ctx.sessionManager.getSessionId();
		return active && active.generation === transportGeneration && active.sessionManager === ctx.sessionManager && active.sessionId === sessionId && sessions === ctx.sessionManager ? active : undefined;
	};

	const requestRender = () => {
		if (renderQueued) return;
		renderQueued = true;
		deps.schedule(() => {
			renderQueued = false;
			if (sidebarTui) invalidateSidebar(sidebarTui);
			host?.requestRender();
		}, RENDER_COALESCE_MS);
	};

	// The elapsed column ticks once a second while something runs. Once every
	// task is done, one frame is due when the next finished row leaves the
	// card, so an idle terminal still sees it clear.
	const tickClock = () => {
		cancelClock?.();
		cancelClock = undefined;
		if (!sessions) return;
		const tasks = visibleTasks();
		if (tasks.some((task) => !isFinished(task.status))) {
			cancelClock = deps.schedule(() => {
				requestRender();
				tickClock();
			}, CLOCK_TICK_MS);
			return;
		}
		const expiry = widgetExpiryMs(tasks, deps.now());
		if (expiry === undefined) return;
		cancelClock = deps.schedule(() => {
			if (sidebarTui) invalidateSidebar(sidebarTui);
			host?.requestRender();
			tickClock();
		}, expiry);
	};

	// A finished task goes to disk once, after its child is gone; the history
	// is then trimmed to the configured size. Failures never reach the TUI.
	const persist = (task: TaskRecord) => {
		void saveTask(tasksDir, task, store.thread(task.id))
			.then(() => pruneHistory(tasksDir, loadAgentsConfig({ cwd: task.cwd, home: deps.home, agentHome }).historyMaxTasks))
			.catch(() => {});
	};

	// A background result used to be handed straight to the host as a followUp
	// message, but the host only drains that queue when the parent agent stops
	// calling tools entirely, so in a long orchestrator run the notification
	// could land nearly an hour after the parent pulled the same result (#867).
	// Gentle Agents now owns the pending completions: they settle here, are
	// flushed at the next turn boundary, and a stale one never re-enters the
	// conversation.
	const completions = createCompletionQueue<TaskRecord>();
	const messages = createAgentMessageQueue();
	let activeAgentRuns = 0;

	const isTaskLive = (id: string): boolean => {
		const task = store.get(id);
		return Boolean(task && ownedTaskIds.has(task.id) && !isFinished(task.status));
	};

	const deliver = (task: TaskRecord) => {
		// Ownership is consulted at delivery time, matching onNotification and
		// onQuery: a completion owned by another session is dropped, not delivered.
		if (activeSessionId() !== task.parentSessionId) return;
		// "steer" + triggerTurn keeps delivery bounded to the current turn. While
		// the parent streams, the host polls steering each turn and injects the
		// message before the next LLM call; "followUp" is NOT acceptable here
		// because the host drains the follow-up queue only in the run loop's stop
		// branch, so a parent that keeps calling tools would see the completion
		// only when the whole run ends — the original #867 delay. When the parent
		// is idle, triggerTurn runs the prompt immediately, preserving wake-up.
		pi.sendMessage({ customType: AGENTS_RESULT_TYPE, content: completionText(task), display: true, details: taskDetails(task) }, { deliverAs: "steer", triggerTurn: true });
	};

	// A stale completion must not re-enter the LLM conversation, so it is
	// delivered as durable TUI-only content and the human still sees it.
	const deliverStale = (task: TaskRecord, settledAt: number) => {
		if (activeSessionId() !== task.parentSessionId) return;
		const ageSeconds = Math.max(0, Math.round((deps.now() - settledAt) / 1000));
		pi.appendEntry(AGENTS_STALE_RESULT_TYPE, { taskId: task.id, agent: task.agent, label: task.label, status: task.status, ageSeconds });
	};

	const deliverMessage = (msg: PendingAgentMessage) => {
		if (activeSessionId() !== msg.parentSessionId) return;
		pi.sendMessage(
			{ customType: AGENTS_MESSAGE_TYPE, content: msg.content, display: msg.display, details: msg.details },
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const flushMessages = (rethrow = false) => {
		for (const msg of messages.takeDeliverable(deps.now(), activeSessionId() ?? "", isTaskLive)) {
			try {
				deliverMessage(msg);
			} catch (error) {
				if (rethrow) throw error;
				/* Best-effort delivery: at most once, even if forwarding fails. */
			}
		}
	};

	const flushCompletions = () => {
		for (const { task, settledAt, stale } of completions.takeDeliverable(deps.now())) {
			try {
				if (stale) deliverStale(task, settledAt);
				else deliver(task);
			} catch { /* Best-effort delivery: at most once, even if forwarding fails. */ }
		}
	};

	const flushAll = () => {
		flushMessages();
		flushCompletions();
	};

	// A completion settles into our queue. An idle parent flushes right away so
	// the wake-up behavior is unchanged; a busy parent flushes at the next turn
	// boundary, and the steer mode injects it before that turn's next LLM call
	// instead of parking it behind the whole run.
	const settleCompletion = (task: TaskRecord) => {
		messages.invalidateTask(task.id);
		completions.enqueue(task, deps.now());
		if (activeAgentRuns === 0) flushAll();
	};

	// `agent_start`/`agent_end` bracket a parent agent run; `turn_end` fires at
	// every turn boundary inside one, so with steering delivery a held
	// completion is injected before the next LLM call and never outlives the
	// current turn. `agent_end` stays a flush trigger for runs that end without
	// a final `turn_end` (an aborted run, or the host's early post-run return
	// when a run produced no assistant message; the host compensates via
	// hasQueuedMessages() + continue(), so steering there is still bounded).
	// `agent_settled` is the final idle boundary after retries — normally a
	// no-op safety net, since anything enqueued while idle flushes right away.
	pi.on("agent_start", () => { activeAgentRuns += 1; });
	pi.on("agent_end", () => {
		activeAgentRuns = Math.max(0, activeAgentRuns - 1);
		flushAll();
	});
	pi.on("agent_settled", () => flushAll());
	pi.on("turn_end", () => flushAll());

	const runner = new AgentRunner(store, loadAgentsConfig({ cwd: process.cwd(), home: deps.home, agentHome }), deps, {
		askUser: (_taskId, ask, raw) => answerThroughUi(ui, ask, raw),
		onNotification: (task, message) => {
			if (activeSessionId() !== task.parentSessionId || isFinished(task.status)) return false;
			messages.enqueueNotification(task, message, deps.now());
			if (activeAgentRuns === 0) flushMessages();
			return true;
		},
		onQuery: (task, requestId, message) => {
			if (activeSessionId() !== task.parentSessionId || isFinished(task.status)) return false;
			const hadYield = yieldedTaskIds.has(task.id);
			if (task.mode === AGENT_MODE.TASK) yieldedTaskIds.add(task.id);
			try {
				messages.enqueueQuery(task, requestId, message, deps.now());
				if (activeAgentRuns === 0) flushMessages(true);
				return true;
			} catch (error) {
				messages.expireQuery(task.id, requestId);
				if (task.mode === AGENT_MODE.TASK && !hadYield) yieldedTaskIds.delete(task.id);
				throw error;
			}
		},
		onQuerySettled: (taskId, requestId, outcome) => {
			if (outcome === "replied") messages.consumeQuery(taskId, requestId);
			else messages.expireQuery(taskId, requestId);
		},
		onSuccessfulMutation: (task, tool) => {
			// Same-clone registry attribution remains unchanged. A foreign task
			// uses a separately bound, live-grant path only for successful tool evidence.
			let root: string | undefined;
			let childRoot: string | undefined;
			const noteDrop = (guard: string) => {
				const key = `${task.id}:${guard}`;
				if (droppedAttributionGuards.has(key)) return;
				droppedAttributionGuards.add(key);
				try { store.apply(task.id, { type: TASK_EVENT.NOTE, text: `changes not attributed: ${guard} (root=${root ?? "unknown"}, child=${childRoot ?? "unknown"})` }, deps.now()); }
				catch { /* A note is best-effort explanation; it must never block the guard it is explaining. */ }
			};
			if (!sessions || !worktrees) return noteDrop("session-inactive");
			if (task.parentSessionId !== activeSessionId()) return noteDrop("parent-session-mismatch");
			if (!ownedTaskIds.has(task.id)) return noteDrop("not-owned");
			root = deps.resolveWorktree(tool.path, task.cwd)?.root;
			childRoot = deps.resolveWorktree(task.cwd, task.cwd)?.root;
			if (!root) return noteDrop("root-unresolved");
			if (root !== childRoot) return noteDrop("root-mismatch");
			const foreignTask = foreignTasks.get(task.id);
			if (foreignTask) {
				if (sessions !== foreignTask.manager || root !== foreignTask.root || tool.evidence?.root !== root) return noteDrop("foreign-identity-mismatch");
				const identity = resolveSessionWorktree(root, root);
				if (!identity || identity.commonDir !== foreignTask.commonDir) return noteDrop("foreign-identity-drift");
				try { foreignGrants.assertCurrent({ sessionManager: sessions }, identity); }
				catch { return noteDrop("foreign-grant-lost"); }
			} else if (!worktrees.roots().includes(root)) return noteDrop("root-not-registered");
			if (!tool.evidence) {
				noteDrop("evidence-missing");
			} else if (tool.evidence.root !== root) {
				noteDrop("evidence-root-mismatch");
			} else {
				let path = tool.path.replace(/^@/, "").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
				if (path === "~" || path.startsWith("~/")) path = os.homedir() + path.slice(1);
				let resolvedPath: string | undefined;
				try {
					resolvedPath = realpathSync(resolve(task.cwd, path));
				} catch {
					noteDrop("evidence-path-unreadable");
				}
				if (resolvedPath === resolve(root, tool.evidence.path)) {
					const evidence = { ...tool.evidence, id: `${task.id}:${tool.toolCallId}` };
					if (foreignTask) publishForeignSessionChange(pi, task.parentSessionId, evidence);
					else pi.events.emit(SESSION_CHANGE_RELAY, { sessionId: task.parentSessionId, evidence });
				}
				else if (resolvedPath !== undefined) noteDrop("evidence-path-mismatch");
			}
			if (!foreignTask) recordReviewMutation(pi, sessions, root, { source: "subagent", taskId: task.id, toolName: tool.toolName, toolCallId: tool.toolCallId });
		},
		onFinish: (task, observations) => {
			// Completion is the only forwarding opportunity. No pending event, policy
			// query or promise survives this callback; the receiver drops when busy.
			const { id, parentSessionId, status } = task;
			const metrics = metricTasks.get(id);
			metricTasks.delete(id); // Deliver at most once, even if forwarding fails.
			try {
				const authorized = metrics?.valid();
				if (metrics) metrics.finished = true;
				if (authorized && metrics?.launched && metrics.selection && observations) {
					const event = childEvent(parentSessionId, id, metrics.selection, status, observations, metrics.started);
					if (event && metrics.current()) pi.events.emit(CHILD_METRICS_EVENT, event);
				}
			} catch { /* Metrics must never interrupt task finalization. */ }
			try {
				ownedTaskIds.delete(task.id);
				messages.invalidateTask(task.id);
				requestRender();
				persist(task);
				const yielded = yieldedTaskIds.delete(task.id);
				if ((task.mode === AGENT_MODE.BACKGROUND && task.status !== TASK_STATUS.CANCELLED) || (yielded && task.status !== TASK_STATUS.CANCELLED && activeSessionId() === task.parentSessionId)) settleCompletion(task);
			} catch { /* Best-effort completion bookkeeping cannot strand runner waiters. */ }
		},
	});

	pi.registerMessageRenderer(AGENTS_MESSAGE_TYPE, (message, options, theme) => {
		const details = (message.details as { gentleAgents?: { taskId?: unknown; agent?: unknown } } | undefined)?.gentleAgents;
		const taskId = typeof details?.taskId === "string" ? details.taskId : "unknown";
		const agent = typeof details?.agent === "string" ? details.agent : "Subagent";
		const heading = `${sanitizeTerminalText(agent)} message · Task ${sanitizeTerminalText(taskId)}`;
		const body = sanitizeTerminalText(messageText(message.content));
		return new Text(`${theme.fg("customMessageLabel", heading)}\n${theme.fg("customMessageText", body)}`, options.outputPad, 0);
	});

	pi.registerMessageRenderer(AGENTS_ORCHESTRATOR_MESSAGE_TYPE, (message, options, theme) => {
		const details = (message.details as { gentleAgents?: { senderSessionId?: unknown } } | undefined)?.gentleAgents;
		const sender = typeof details?.senderSessionId === "string" ? details.senderSessionId : "unknown";
		const heading = `⇄ Orchestrator message · Received · From ${sanitizeTerminalText(sender)}`;
		const body = sanitizeTerminalText(messageText(message.content));
		return new Text(`${theme.fg("customMessageLabel", heading)}\n${theme.fg("customMessageText", body)}`, options.outputPad, 0);
	});

	pi.registerMessageRenderer(AGENTS_RESULT_TYPE, (message, options, theme) => {
		const details = (message.details as { gentleAgents?: { agent?: string; status?: string } } | undefined)?.gentleAgents;
		const content = message.content as string | Array<{ type: string; text?: string }>;
		const body = (typeof content === "string" ? content : content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n")).split("\n");
		const tone = details?.status === "completed" ? CARD_TONE.SUCCESS : CARD_TONE.ERROR;
		const hint = expandHint(options.expanded);
		return {
			render(width: number) {
				return renderCard({ title: "Agent result", subtitle: details?.agent, body, tone, glyph: AGENTS_GLYPH }, theme, width, { expanded: options.expanded, hint });
			},
			invalidate() {},
		};
	});

	// A stale completion is appended as a custom entry: durable transcript
	// content for the human that never participates in the LLM context.
	pi.registerEntryRenderer(AGENTS_STALE_RESULT_TYPE, (entry, options, theme) => {
		const data = (entry.data ?? {}) as { taskId?: unknown; agent?: unknown; label?: unknown; status?: unknown; ageSeconds?: unknown };
		const taskId = typeof data.taskId === "string" ? data.taskId : "unknown";
		const agent = typeof data.agent === "string" ? data.agent : "Subagent";
		const label = typeof data.label === "string" ? data.label : "";
		const status = typeof data.status === "string" ? data.status.replace("_", " ") : "unknown";
		const ageSeconds = typeof data.ageSeconds === "number" && Number.isFinite(data.ageSeconds) ? Math.max(0, Math.round(data.ageSeconds)) : 0;
		const age = ageSeconds < 90 ? `${ageSeconds}s` : ageSeconds < 3600 ? `${Math.round(ageSeconds / 60)}m` : `${Math.round(ageSeconds / 3600)}h`;
		const body = [
			`Subagent ${sanitizeTerminalText(agent)} (task ${sanitizeTerminalText(taskId)}, "${sanitizeTerminalText(label)}") ${sanitizeTerminalText(status)} about ${age} ago, while the orchestrator was still busy.`,
			"Marked stale: the result was not replayed into the conversation. It stays available through subagent_status and subagent_result.",
		];
		return {
			render(width: number) {
				return renderCard({ title: "Stale agent result", subtitle: `${agent} · task ${taskId}`, body, tone: CARD_TONE.WARNING, glyph: AGENTS_GLYPH }, theme, width, { expanded: options.expanded, hint: expandHint(options.expanded) });
			},
			invalidate() {},
		};
	});

	const isOwnedActive = (task: TaskRecord | undefined): task is TaskRecord => task !== undefined && ownedTaskIds.has(task.id) && !isFinished(task.status);

	const stopSelected = async (task: TaskRecord, ctx: ExtensionContext): Promise<void> => {
		const selected = store.get(task.id);
		if (!isOwnedActive(selected)) return;
		if (selected.status === TASK_STATUS.QUEUED) {
			if (runner.cancel(selected.id, "stopped from the agents panel")) ctx.ui.notify(`Stopped ${selected.agent}.`);
			else ctx.ui.notify(`Task ${selected.agent} already finished.`, "warning");
			return;
		}
		if (stoppingTaskIds.has(selected.id)) return;
		stoppingTaskIds.add(selected.id);
		try {
			const message = selected.status === TASK_STATUS.WAITING ? "Its pending question will be dismissed." : "Current work may be incomplete.";
			if (!await ctx.ui.confirm(`Stop ${selected.agent}?`, message)) return;
			const current = store.get(selected.id);
			if (!isOwnedActive(current)) {
				ctx.ui.notify(`Task ${selected.agent} already finished.`, "warning");
				return;
			}
			if (runner.cancel(current.id, "stopped from the agents panel")) ctx.ui.notify(`Stopped ${current.agent}.`);
			else ctx.ui.notify(`Task ${current.agent} already finished.`, "warning");
		} finally {
			stoppingTaskIds.delete(selected.id);
		}
	};

	const stopAll = (ctx: ExtensionContext): Promise<void> => {
		if (stopAllConfirmation) return stopAllConfirmation;
		const active = store.list().filter(isOwnedActive);
		if (active.length === 0) {
			ctx.ui.notify("No active subagents to stop.");
			return Promise.resolve();
		}
		const count = active.length;
		const noun = count === 1 ? "subagent" : "subagents";
		const confirmation = (async () => {
			try {
				if (!await ctx.ui.confirm(`Stop ${count} active ${noun}?`, `Only these ${count} ${noun} will stop. Current work may be incomplete.`)) return;
				const cancelled = active.filter((task) => runner.cancel(task.id, "stopped from the agents panel (stop all)")).length;
				ctx.ui.notify(`Stopped ${cancelled} ${cancelled === 1 ? "subagent" : "subagents"}.`);
			} finally {
				stopAllConfirmation = undefined;
			}
		})();
		stopAllConfirmation = confirmation;
		return confirmation;
	};

	// Tasks from earlier sessions come back from disk on demand.
	const resolveTask = async (id: string): Promise<TaskRecord | undefined> => {
		const live = store.get(id);
		if (live) return live;
		const stored = await loadStoredTask(tasksDir, id);
		if (stored) {
			restoredTaskIds.add(stored.task.id);
			store.restore(stored.task, stored.thread);
		}
		return stored?.task;
	};

	// Restores this exact session's own finished subagents as visible history
	// on an explicit resume, or on startup into a session that already has
	// entries -- never on new, fork, or reload (see the session_start handler's
	// preexisting check below, which is the actual gate). Marked in
	// restoredTaskIds like any other disk restoration, so it stays
	// non-cancellable (ownedTaskIds never gained the id either way) and is
	// skipped if the id is somehow already live.
	const restoreSessionHistory = async (ctx: ExtensionContext, sessionId: string): Promise<void> => {
		let history: Awaited<ReturnType<typeof loadHistory>>;
		try {
			history = await loadHistory(tasksDir);
		} catch {
			return;
		}
		// The session may have moved on while disk was read; a stale restore
		// must never land in the wrong session's store.
		if (ctx.sessionManager.getSessionId() !== sessionId) return;
		// Fire-and-forget from session_start: a throwing summary subscriber must
		// never surface as an unhandled rejection. History is best-effort.
		try {
			for (const { task, thread } of history) {
				if (task.parentSessionId !== sessionId) continue;
				if (store.restore(task, thread)) restoredTaskIds.add(task.id);
			}
		} catch { /* Partial history is acceptable; the live session keeps running. */ }
	};

	const openOverlay = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The agents overlay requires TUI mode.", "warning");
			return;
		}
		let view: AgentsView | undefined;
		let overlayHost: { requestRender(force?: boolean): void; stop(): void; start(): void } | undefined;
		const chosen = await ctx.ui.custom<TaskRecord | null>(
			(tui, theme, _keybindings, done) => {
				const close = withOverlayRepaint(tui, done);
				overlayHost = tui;
				view = new AgentsView({
					theme,
					rows: () => Math.max(0, tui.terminal.rows),
					store,
					sessionId: ctx.sessionManager.getSessionId() ?? "",
					presence: {
						profile: agentHome,
						get target() { return presence?.target; },
					},
					now: () => deps.now(),
					onCancel: (task) => void stopSelected(task, ctx),
					canCancel: isOwnedActive,
					isLocalTask: (task) => !restoredTaskIds.has(task.id),
					onOpen: (task) => close(task),
					onClose: () => close(null),
					requestRender: () => tui.requestRender(),
				});
				overlays.add(view);
				const interaction = createNativeFullscreenInteraction({
					keyboardTarget: view,
					requestRender: () => tui.requestRender(),
					mouseObserver: view.mouseObserver(),
				});
				interaction.addChild(view);
				return interaction;
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } },
		).finally(() => {
			view?.dispose();
			if (view) overlays.delete(view);
		});
		if (!chosen || !overlayHost) return;
		if (!chosen.sessionPath) {
			ctx.ui.notify("This task has no session file yet.", "warning");
			return;
		}
		// The child's session is JSONL; the reader gets a markdown transcript.
		let transcriptPath: string;
		try {
			transcriptPath = await writeTranscript(chosen);
		} catch (error) {
			ctx.ui.notify(`Could not read the task's session: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		if (!openInExternalEditor(overlayHost, transcriptPath)) ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
	};

	const writeTranscript = async (task: TaskRecord): Promise<string> => {
		const dir = agentRuntimePaths(deps.home, agentHome).transcripts;
		await mkdir(dir, { recursive: true });
		const markdown = sessionToMarkdown(await readFile(task.sessionPath ?? "", "utf8"), { title: `${task.agent} · ${task.label} · ${task.status}` });
		const path = join(dir, `${task.id}.md`);
		await writeFile(path, markdown, "utf8");
		return path;
	};
	// A status change is worth a frame right away; deltas inside a task are
	// coalesced so a chatty child cannot flood the terminal.
	store.subscribeSummary(() => {
		publishActivity();
		if (sidebarTui) invalidateSidebar(sidebarTui);
		host?.requestRender();
		tickClock();
	});

	const showWidget = (ctx: ExtensionContext) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		sessions = ctx.sessionManager;
		agentsVisible = resolveVisualSettings({ gentlePiConfigHome: visualHome }).settings.visibility.agents;
		stopVisualUpdates?.();
		stopVisualUpdates = pi.events.on(VISUAL_SETTINGS_CHANGED, (event) => {
			if ((event as { configHome?: unknown } | undefined)?.configHome !== visualHome) return;
			agentsVisible = resolveVisualSettings({ gentlePiConfigHome: visualHome }).settings.visibility.agents;
			if (sidebarTui) invalidateSidebar(sidebarTui);
			host?.requestRender();
		});
		tickClock();
		// Agents is not a rail part: the fullscreen sidebar only suppresses
		// bottom components registered through sidebarPart, and this widget is
		// the only Agents surface in every mode, so it stays a plain component.
		ui?.setWidget(AGENTS_WIDGET_KEY, (tui, theme) => {
			host = tui;
			sidebarTui = tui;
			return {
				render(width: number) {
					if (!agentsVisible) return [];
					const lines = renderAgentsCard(visibleTasks(), theme, width, deps.now(), { collapsed, collapseKey, maxRows: widgetRows(tui.terminal?.rows), viewKey });
					return lines.length === 0 ? [] : [...lines, ""];
				},
				invalidate() {},
			};
		});
	};

	const roots = (ctx: ExtensionContext) => ({ cwd: ctx.sessionManager.getCwd(), home: deps.home, agentHome });

	const buildRequest = async (ctx: ExtensionContext, agent: AgentDefinition, prompt: string, label: string | undefined, context: string | undefined, mode: AgentMode, resume?: string, workspaceRoot?: string, signal?: AbortSignal, repositoryRoot?: string): Promise<TaskRequest> => {
		if (retiredSddAgent(agent.name)) throw new Error("Retired SDD agents cannot be dispatched.");
		if (signal?.aborted) throw new Error("Subagent launch aborted before authorization.");
		const registry = registryFor(ctx);
		const parentCwd = ctx.sessionManager.getCwd();
		// An explicit target is validated before any queue or session-dir writes.
		const parentIdentity = deps.resolveWorktree(parentCwd, parentCwd);
		if (repositoryRoot !== undefined && workspaceRoot !== undefined) throw new Error("repository_root and workspace_root are mutually exclusive.");
		if (repositoryRoot !== undefined && (deps.env.GENTLE_PI_AGENTS_CHILD === "1" || ctx.mode !== "tui" || !ctx.hasUI)) throw new Error("Foreign repository launch requires an interactive parent session.");
		const selectedRoot = repositoryRoot ?? workspaceRoot;
		// Preserve ordinary non-Git continuation, without admitting any new root.
		const sameNonGitContinuation = resume !== undefined && repositoryRoot === undefined && selectedRoot === parentCwd && !parentIdentity;
		let foreign = false;
		let foreignIdentity: { root: string; commonDir: string } | undefined;
		let foreignParent: { root: string; commonDir: string } | undefined;
		let target: string | undefined;
		if (selectedRoot !== undefined && !sameNonGitContinuation) {
			if (repositoryRoot === undefined) target = registry.validate(selectedRoot);
			else {
				// Only an explicitly selected canonical foreign Git root can escape the
				// same-clone registry. Never use a caller-injected resolver for this identity.
				const identity = resolveSessionWorktree(selectedRoot, parentCwd);
				const canonicalParent = resolveSessionWorktree(parentCwd, parentCwd);
				if (!identity || (canonicalParent && identity.commonDir === canonicalParent.commonDir) || selectedRoot !== identity.root || !isAbsolute(selectedRoot) || realpathSync(selectedRoot) !== selectedRoot) throw new Error("repository_root must select a canonical independent Git repository.");
				await foreignGrants.authorize(ctx, identity, { continuation: resume !== undefined, signal });
				foreignIdentity = identity;
				foreignParent = canonicalParent;
				target = identity.root;
				foreign = true;
			}
		} else target = parentIdentity?.root;
		// A per-repository profile pin replaces subagent routing for this launch without
		// materialising anything: the global stores stay untouched, so two repositories
		// worked in parallel stop fighting over one global routing. The child's own
		// worktree is the repository in question, and the local pin sits in the shared
		// Git common directory, so it survives every worktree of the clone. When the
		// launch stays in the session's own worktree the identity already resolved above
		// is reused instead of asking Git a second time. The orchestrator is out of
		// scope: only `modelProfiles` is replaced.
		const pinIdentity: WorktreeResolver = foreign ? resolveSessionWorktree : target !== undefined && parentIdentity !== undefined && target === parentIdentity.root
			? () => parentIdentity
			: deps.resolveWorktree;
		const config = withPinnedModelProfiles(
			loadAgentsConfig(roots(ctx)),
			resolveProfilePin({
				cwd: target ?? parentCwd,
				configHome: gentlePiConfigHome(deps.env),
				resolveWorktree: pinIdentity,
			})?.modelProfiles,
		);
		const profile = resolveAgentProfile(agent, config);
		const sessionDir = agentRuntimePaths(deps.home, agentHome).sessions;
		if (foreign && target) {
			const identity = resolveSessionWorktree(target, parentCwd);
			if (!identity || identity.root !== target || identity.commonDir !== foreignIdentity?.commonDir) throw new Error("Foreign clone identity changed before launch.");
			foreignGrants.assertCurrent(ctx, identity);
		}
		if (signal?.aborted) throw new Error("Subagent launch aborted before queueing.");
		mkdirSync(sessionDir, { recursive: true });
		const parentSessionManager = ctx.sessionManager as unknown as ReviewSessionManager;
		const parentSessionId = ctx.sessionManager.getSessionId() ?? "";
		const parentWorktreeRoot = ctx.sessionManager.getCwd();
		const parentRepositoryIdentity = resolveCanonicalGitRepositoryIdentitySync(parentWorktreeRoot);
		const childEnv = { ...deps.env };
		if (foreign) for (const key of inheritedUnsafeGitEnvironmentKeys(childEnv)) delete childEnv[key];
		const request: TaskRequest = {
			agent,
			prompt,
			label,
			context,
			mode,
			cwd: target ?? parentWorktreeRoot,
			parentSessionId,
			...(foreign && target ? { beforeSpawn: () => {
				if (signal?.aborted || sessions !== ctx.sessionManager || ctx.sessionManager.getSessionId() !== registry.sessionId || ctx.sessionManager.getCwd() !== parentCwd) throw new Error("Foreign clone session or tool call changed before spawn.");
				const identity = resolveSessionWorktree(target, parentCwd);
				const parent = resolveSessionWorktree(parentCwd, parentCwd);
				if (!identity || identity.root !== target || identity.commonDir !== foreignIdentity?.commonDir || parent?.root !== foreignParent?.root || parent?.commonDir !== foreignParent?.commonDir) throw new Error("Foreign clone identity changed before spawn.");
				foreignGrants.assertCurrent(ctx, identity);
			} } : {}),
			...(target === undefined || foreign ? {} : { onLaunch: () => { registry.register(target, "subagent:spawn"); } }),
			model: profile.model,
			thinking: profile.thinking,
			sessionDir,
			resumeSessionPath: resume,
			env: childEnv,
			...(foreign || parentRepositoryIdentity === undefined ? {} : {
				authorizeParentStandingReviewPermission: (repositoryIdentity: string) => {
					try {
						return repositoryIdentity === parentRepositoryIdentity &&
							parentSessionManager.getSessionId() === parentSessionId &&
							parentSessionId.length > 0 &&
							hasReviewSessionPermission({
								sessionManager: parentSessionManager,
								sessionId: parentSessionId,
								worktreeRoot: parentWorktreeRoot,
								repositoryIdentity: parentRepositoryIdentity,
							});
					} catch {
						return false;
					}
				},
			}),
		};
		if (foreign && target && foreignIdentity) foreignRequests.set(request, { root: target, commonDir: foreignIdentity.commonDir, manager: ctx.sessionManager });
		return request;
	};

	const launch = async (ctx: ExtensionContext, request: TaskRequest, signal?: AbortSignal): Promise<ToolText> => {
		if (ctx.mode === "print" && request.mode === AGENT_MODE.BACKGROUND) {
			throw new Error("Background subagents are unavailable in print mode: pi -p exits before a parent session can receive results. Use task mode, RPC mode, or interactive Pi.");
		}
		if (retiredSddAgent(request.agent.name)) throw new Error("Retired SDD agents cannot be dispatched.");

		// Bounded live observation only. Native send owns the fresh policy decision;
		// child execution never starts a telemetry policy process or renewal timer.
		const owner = metricsOwner;
		const metrics = { selection: undefined as LaunchSelection | undefined,
			started: 0, launched: false, finished: false,
			current: () => owner === metricsOwner && request.parentSessionId === activeSessionId() && runtimeMetricsEnvAllows(deps.env),
			valid: () => !metrics.finished && metrics.current() };
		const observe = runtimeMetricsEnvAllows(deps.env) && metricTasks.size < 256;
		let launched = false;
		let launchedTaskId: string | undefined;
		const task = runner.run({ ...request, collectResponseObservations: false,
			onLaunch: () => {
				metrics.launched = true;
				request.onLaunch?.();
				launched = true;
				const foreign = foreignRequests.get(request);
				if (foreign && launchedTaskId) foreignTasks.set(launchedTaskId, foreign);
			},
			...(observe ? { canCollectResponseObservations: metrics.valid, prepareResponseObservations: async () => {
				if (metrics.finished || owner !== metricsOwner || request.parentSessionId !== activeSessionId() || !runtimeMetricsEnvAllows(deps.env)) return false;
				if (!metrics.valid()) return false;
				metrics.selection = launchSelection(request.agent, request.model, request.thinking);
				metrics.started = metricsNow();
				return metrics.valid();
			} } : {}),
		});
		if (observe) metricTasks.set(task.id, metrics);
		launchedTaskId = task.id;
		const foreignRequest = foreignRequests.get(request);
		if (launched && foreignRequest) foreignTasks.set(task.id, foreignRequest);
		ownedTaskIds.add(task.id);
		store.subscribe(task.id, () => { publishActivity(); requestRender(); });
		if (request.mode === AGENT_MODE.BACKGROUND) return text(`Started ${task.agent} in the background as task ${task.id}. Retain that id; completion is pushed automatically. Never sleep or periodically poll subagent_status/subagent_result for completion or cache maintenance. Inspect status only at a real orchestration decision boundary; never relaunch equivalent queued/running work.`, taskDetails(task));
		// A tool call aborted by the host (a human interrupting the turn, a timeout)
		// would otherwise leave the child running and end the call with no result and
		// no recorded reason. Cancel through the runner so the lifecycle runs and the
		// record is persisted, and tell the user why.
		const onAbort = (): void => {
			if (runner.cancel(task.id, `cancelled: the tool call was aborted${abortReasonText(signal?.reason)}`)) {
				ctx.ui.notify(
					`Subagent ${task.agent} cancelled: the tool call was aborted${abortReasonText(signal?.reason)}. The run is recorded as cancelled.`,
					"warning",
				);
			}
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const query = await runner.waitForQuery(task.id);
			if (query) {
				const live = store.get(task.id) ?? task;
				messages.consumeQuery(task.id, query.requestId);
				const questionSuffix = query.message ? `\n\nQuestion:\n${query.message}` : "";
				return text(
					`Subagent ${live.agent} is waiting for your reply to request ${query.requestId}.${questionSuffix}`,
					{ gentleAgents: { taskId: live.id, agent: live.agent, status: live.status, mode: live.mode, requestId: query.requestId, ...(query.message ? { question: query.message } : {}) } },
					true,
				);
			}
			const finished = await runner.waitFor(task.id);
			completions.consume(finished.id);
			messages.invalidateTask(finished.id);
			return text(finishedText(finished), taskDetails(finished));
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	const tool = (name: string, description: string, parameters: Record<string, unknown>, execute: (params: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal) => Promise<ToolText>) => {
		pi.registerTool({
			name: `${TOOL_PREFIX}${name}`,
			renderShell: "self",
			label: `Agent ${name.replace(/_/g, " ")}`,
			description,
			parameters: { type: "object", additionalProperties: false, ...parameters } as never,
			renderCall(args, theme) {
				const params = args as { agent?: string; task_id?: string };
				return new Text(theme.fg("toolTitle", `${AGENTS_GLYPH} agent ${name.replace(/_/g, " ")}${params.agent ? ` · ${params.agent}` : params.task_id ? ` · ${params.task_id}` : ""}`), 0, 0);
			},
			renderResult(result, options, theme) {
				const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
				return new Text(options.expanded ? body : theme.fg("muted", body.split("\n")[0] ?? ""), 0, 0);
			},
			async execute(_id, params, signal, _onUpdate, ctx) {
				return execute(params as Record<string, unknown>, ctx, signal);
			},
		});
	};

	pi.registerTool({
		name: "orchestrator_session_id",
		label: "Orchestrator session ID",
		description: "Return this host session's active ID.",
		parameters: { type: "object", additionalProperties: false, properties: {} } as never,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const transport = activeTransportFor(ctx);
			return transport ? text(`Active session ID: ${transport.sessionId}`, { gentleAgents: { senderSessionId: transport.sessionId } }) : text("Error: session messaging is not ready.", { error: "not ready" });
		},
	});
	pi.registerTool({
		name: "orchestrator_list",
		label: "List orchestrators",
		description: "List other sessions advertised by the trusted local profile. Advertised reachability is unknown and does not prove a session is live.",
		parameters: { type: "object", additionalProperties: false, properties: {} } as never,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const transport = activeTransportFor(ctx);
			if (!transport) return text("Error: session discovery is not ready.", { error: "not ready" });
			try {
				const peers = await transport.listener.registry.list(transport.sessionId);
				if (activeTransportFor(ctx) !== transport) return text("Error: session discovery became unavailable before results were confirmed.", { error: "stale" });
				return peers.length === 0 ? text("No other sessions are currently advertised. Advertisements have unknown reachability and do not guarantee a live session.") : text(`Advertised sessions (reachability is unknown):\n${peers.map((peer) => `- ${peer.sessionId}`).join("\n")}`, { gentleAgents: { candidates: peers } });
			} catch {
				return text("Error: session discovery is unavailable.", { error: "unavailable" });
			}
		},
	});
	pi.registerTool({
		name: "orchestrator_send_message",
		label: "Send orchestrator message",
		description: "Send a notification to another active session in this trusted local profile. If recipient_session_id is omitted, the sole peer is selected or the user selects one. Acceptance means enqueued, not read or completed.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["message", "reason"],
			properties: {
				recipient_session_id: { type: "string" },
				message: { type: "string" },
				reason: { type: "string", minLength: MESSAGING_REASON_MIN_CHARACTERS, maxLength: MESSAGING_REASON_MAX_UTF8_BYTES, description: "Required concrete caller-supplied reason: at least 8 characters after trimming and at most 512 UTF-8 bytes." },
			},
		} as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const transport = activeTransportFor(ctx);
			const input = params as { recipient_session_id?: unknown; message?: unknown; reason?: unknown };
			if (!transport) return text("Error: session messaging is not ready.", { error: "not ready" });
			const message = input.message;
			if (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 8192) return text("Error: recipient session ID or message is invalid.", { error: "invalid input" });
			let reason: string;
			try { reason = normalizeMessagingReason(input.reason); }
			catch { return text("Error: recipient session ID or message is invalid; a concrete reason of at least 8 trimmed characters and at most 512 UTF-8 bytes is required.", { error: "invalid input" }); }
			let recipient: string | undefined;
			let activation: PresenceRecord | undefined;
			if (input.recipient_session_id !== undefined) {
				if (!validTransportSessionId(input.recipient_session_id)) return text("Error: recipient session ID or message is invalid.", { error: "invalid input" });
				recipient = input.recipient_session_id;
			}
			if (recipient === undefined) {
				try {
					const candidates = (await transport.listener.registry.listActivations(transport.sessionId)).filter((candidate) => candidate.sessionId !== transport.sessionId);
					if (activeTransportFor(ctx) !== transport || signal?.aborted) return text("Message selection was cancelled.", { error: "cancelled" });
					if (candidates.length === 0) return text("No other sessions are currently advertised; message delivery is unavailable.", { error: "unavailable" });
					if (candidates.length === 1) {
						recipient = candidates[0].sessionId;
						activation = candidates[0];
					} else if (!ctx.hasUI) return text("Several recipient orchestrators are available. Ask the user to choose a recipient label; do not ask for a session ID.", { gentleAgents: { candidates: candidates.map((candidate) => ({ label: `Orchestrator ${candidate.sessionId}`, sessionId: candidate.sessionId })) } });
					else {
						const labels = candidates.map((candidate) => `Orchestrator ${candidate.sessionId}`);
						const selected = await ctx.ui.select("Select recipient orchestrator", labels, { signal });
						if (selected === undefined || activeTransportFor(ctx) !== transport || signal?.aborted) return text("Message selection was cancelled.", { error: "cancelled" });
						const index = labels.indexOf(selected);
						if (index < 0) return text("Message selection was cancelled.", { error: "cancelled" });
						recipient = candidates[index].sessionId;
						activation = candidates[index];
					}
				} catch {
					return text("Error: session discovery is unavailable.", { error: "unavailable" });
				}
			}
			if (recipient === undefined || !validTransportSessionId(recipient)) return text("Error: recipient session ID or message is invalid.", { error: "invalid input" });
			if (recipient === transport.sessionId) return text("Error: cannot send a message to the active session.", { error: "self" });
			try {
				await messagingGrants.authorize(ctx, recipient, { message, reason, signal });
			} catch (error) {
				if (signal?.aborted) return text("Cross-orchestrator communication was cancelled.", { error: "cancelled" });
				return text(`Error: ${error instanceof Error ? error.message : String(error)}`, { error: "denied" });
			}
			try {
				const accepted = await transport.client.sendNotification(recipient, message, { signal, expectedActivation: activation, beforeConnect: () => activeTransportFor(ctx) === transport });
				return activeTransportFor(ctx) === transport ? text(`Message ${accepted.id} from ${transport.sessionId} to ${recipient} accepted for delivery; it is not a delivery or read receipt.`, { gentleAgents: { messageId: accepted.id, senderSessionId: transport.sessionId, recipientSessionId: recipient, state: "accepted" } }) : text("Error: session messaging is not ready.", { error: "stale" });
			} catch {
				return text("Error: session message was not accepted.", { error: "not accepted" });
			}
		},
	});

	tool("list_agents", "List the subagents defined for this project and user, with their descriptions.", { properties: {} }, async (_params, ctx) => {
		const { agents, errors } = discoverAgents(roots(ctx));
		const lines = agents.map((agent) => `- ${agent.name} (${agent.scope}): ${agent.description || "no description"}`);
		const problems = errors.map((error) => `! ${error}`);
		return text(lines.length === 0 ? "No subagents defined." : [...lines, ...problems].join("\n"));
	});

	tool(
		"run",
		"Delegate a task to a named subagent. Task mode waits for the answer; background mode returns a task id immediately.",
		{
			required: ["agent", "task"],
			properties: {
				agent: { type: "string", description: "Subagent name from subagent_list_agents." },
				task: { type: "string", description: "What the subagent must do, self-contained." },
				label: { type: "string", description: "Three to six words naming the work, shown on the agents card, e.g. 'map footer data sources'." },
				context: { type: "string", description: "Optional extra context appended to the task." },
				workspace_root: { type: "string", description: "Optional canonical main or linked Git worktree within the parent's same clone only; mutually exclusive with repository_root." },
				repository_root: { type: "string", description: "Optional canonical independent Git repository; requires direct interactive session-scoped consent before queueing; mutually exclusive with workspace_root." },
				mode: { type: "string", enum: ["task", "background"], description: "task waits for the result (default); background returns immediately." },
			},
		},
		async (params, ctx, signal) => {
			if (Object.hasOwn(params, "repository_root") && Object.hasOwn(params, "workspace_root")) throw new Error("repository_root and workspace_root are mutually exclusive.");
			if ((Object.hasOwn(params, "repository_root") && typeof params.repository_root !== "string") || (Object.hasOwn(params, "workspace_root") && typeof params.workspace_root !== "string")) throw new Error("Root selectors must be strings.");
			if (Object.hasOwn(params, "sdd_change") || Object.hasOwn(params, "remediation") || Object.hasOwn(params, "research_selection") || retiredSddAgent(String(params.agent))) return text("Error: retired SDD delegation is not supported.", { error: "retired SDD delegation" });
			const { agents } = discoverAgents(roots(ctx));
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) return text(`Error: no subagent named "${String(params.agent)}". Known: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`, { error: "unknown agent" });
			const mode = (params.mode as AgentMode | undefined) ?? agent.mode ?? resolveDefaultSubagentMode({
				configuredDefault: loadAgentsConfig(roots(ctx)).defaultMode,
				policy: resolveBackgroundSubagentsPolicy(ctx.cwd).policy,
				parentMode: ctx.mode,
			});
			return launch(ctx, await buildRequest(ctx, agent, String(params.task ?? ""), typeof params.label === "string" ? params.label : undefined, typeof params.context === "string" ? params.context : undefined, mode, undefined, typeof params.workspace_root === "string" ? params.workspace_root : undefined, signal, typeof params.repository_root === "string" ? params.repository_root : undefined), signal);
		},
	);

	tool("status", "Report the status of one subagent task.", { required: ["task_id"], properties: { task_id: { type: "string" } } }, async (params) => {
		const task = await resolveTask(String(params.task_id));
		return task ? text(describeTask(task), taskDetails(task)) : text(`Error: no task ${String(params.task_id)}`, { error: "unknown task" });
	});

	tool("result", "Return the final answer of a finished subagent task, or its current state if it is still running.", { required: ["task_id"], properties: { task_id: { type: "string" } } }, async (params) => {
		const task = await resolveTask(String(params.task_id));
		if (!task) return text(`Error: no task ${String(params.task_id)}`, { error: "unknown task" });
		// The parent just pulled a finished result; its pending completion must
		// never be replayed on top of it.
		if (isFinished(task.status)) {
			completions.consume(task.id);
			messages.invalidateTask(task.id);
		}
		return text(isFinished(task.status) ? finishedText(task) : `Task ${task.id} is still ${task.status} (last: ${task.lastStep}).`, taskDetails(task));
	});

	tool("list_tasks", "List the subagent tasks of this session, newest first.", { properties: {} }, async (_params, ctx) => {
		const tasks = store.list(ctx.sessionManager.getSessionId() ?? "");
		return text(tasks.length === 0 ? "No subagent tasks in this session." : tasks.map(describeTask).join("\n"));
	});

	tool("reply", "Reply once to a live query from a child of the current parent session.", { required: ["task_id", "request_id", "message"], properties: { task_id: { type: "string" }, request_id: { type: "string" }, message: { type: "string" } } }, async (params, ctx) => {
		const taskId = String(params.task_id);
		const requestId = String(params.request_id);
		const accepted = await runner.reply(taskId, requestId, typeof params.message === "string" ? params.message : "", ctx.sessionManager.getSessionId() ?? "");
		return accepted ? text("Reply accepted for delivery.") : text("Error: query is unavailable.", { error: "query unavailable" });
	});

	tool("cancel",  "Cancel a queued or running subagent task.", { required: ["task_id"], properties: { task_id: { type: "string" } } }, async (params) => {
		const id = String(params.task_id);
		messages.invalidateTask(id);
		return runner.cancel(id, "cancelled by the cancel tool") ? text(`Cancelled task ${id}.`) : text(`Error: task ${id} is not running.`, { error: "not running" });
	});

	tool("send_message", "Steer a running subagent with a message delivered before its next model call.", { required: ["task_id", "message"], properties: { task_id: { type: "string" }, message: { type: "string" } } }, async (params) => {
		const id = String(params.task_id);
		return runner.steer(id, String(params.message ?? "")) ? text(`Message queued for task ${id}.`) : text(`Error: task ${id} is not running.`, { error: "not running" });
	});

	tool(
		"continue",
		"Resume a finished subagent task in its own session with a follow-up prompt.",
		{ required: ["task_id", "prompt"], properties: { task_id: { type: "string" }, prompt: { type: "string" }, label: { type: "string", description: "Three to six words naming the follow-up." }, mode: { type: "string", enum: ["task", "background"] } } },
		async (params, ctx, signal) => {
			if (Object.hasOwn(params, "sdd_change") || Object.hasOwn(params, "remediation") || Object.hasOwn(params, "research_selection")) return text("Error: retired SDD delegation is not supported.", { error: "retired SDD delegation" });
			const previous = await resolveTask(String(params.task_id));
			if (!previous) return text(`Error: no task ${String(params.task_id)}`, { error: "unknown task" });
			if (retiredSddAgent(previous.agent)) return text("Error: retired SDD agents cannot be continued.", { error: "retired SDD delegation" });
			if (!isFinished(previous.status) || !previous.sessionPath) return text(`Error: task ${previous.id} cannot be continued yet (${previous.status}).`, { error: "not continuable" });
			// Continuing acts on the previous result, so any pending completion for
			// it is already consumed by the parent.
			completions.consume(previous.id);
			messages.invalidateTask(previous.id);
			const agent = discoverAgents(roots(ctx)).agents.find((candidate) => candidate.name === previous.agent);
			if (!agent) return text(`Error: subagent "${previous.agent}" is no longer defined.`, { error: "unknown agent" });
			const mode = (params.mode as AgentMode | undefined) ?? (previous.mode as AgentMode);
			const foreignContinuation = foreignTasks.has(previous.id);
			return launch(ctx, await buildRequest(ctx, agent, String(params.prompt ?? ""), typeof params.label === "string" ? params.label : undefined, typeof params.context === "string" ? params.context : undefined, mode, previous.sessionPath, foreignContinuation ? undefined : previous.cwd, signal, foreignContinuation ? previous.cwd : undefined), signal);
		},
	);

	if (collapseKey) {
		pi.registerShortcut(collapseKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Collapse or expand the agents card",
			handler: async () => {
				collapsed = !collapsed;
				if (sidebarTui) invalidateSidebar(sidebarTui);
				host?.requestRender();
			},
		});
	}

	pi.registerCommand(AGENTS_COMMAND_NAME, {
		description: "Show this session's active subagents; a lists open orchestrators in this profile. Peer threads are read-only; o opens a local task's transcript in $EDITOR.",
		handler: async (_args, ctx) => openOverlay(ctx),
	});
	if (viewKey) {
		pi.registerShortcut(viewKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Show the subagents overlay",
			handler: async (ctx) => openOverlay(ctx),
		});
	}
	if (stopKey) {
		pi.registerShortcut(stopKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Stop active subagent(s)",
			handler: async (ctx) => stopAll(ctx),
		});
	}

	pi.on("session_start", async (event, ctx) => {
		// A resumed, reloaded, or replaced session starts with an empty completion
		// queue so nothing pending from another session can replay here.
		completions.dropAll();
		messages.dropAll();
		presence?.dispose();
		registryFor(ctx);
		showWidget(ctx);
		// An explicit in-session /resume always brings this session's own
		// finished subagents back from disk. Pi also reports "startup" (not
		// "resume") when the CLI is launched directly into an existing session
		// file, e.g. --continue or the --resume picker (agent-session.js:152
		// defaults to "startup"); that case restores too, but only when the
		// session actually has prior entries -- a brand-new session can also be
		// announced as "startup", and a fresh session has none. "new", "fork",
		// and "reload" never restore here, matching the existing on-demand
		// resolveTask path for anything else.
		const sessionId = ctx.sessionManager.getSessionId();
		const preexisting = event.reason === "resume" || (event.reason === "startup" && ctx.sessionManager.getEntries().length > 0);
		if (preexisting && sessionId) void restoreSessionHistory(ctx, sessionId);
		try {
			presence = PresencePublisher.start({ profile: agentHome, sessionId: activeSessionId() ?? "",
				label: ctx.sessionManager.getSessionName?.() || ctx.sessionManager.getCwd().split(/[\\/]/).pop() || "Orchestrator", activity: [] });
			publishActivity();
		} catch { presence = undefined; }
		void startSessionTransport(ctx);
		// The desktop app's own pi process: publish live subagent state through
		// setWidget's RPC-mode string[] path. Plain headless RPC (no variable) and
		// TUI are untouched -- the TUI card above the editor is showWidget's own
		// factory push, ignored by pi's RPC transport since it is not an array.
		rpcActivityPublisher?.stop();
		rpcActivityPublisher = undefined;
		notifiedRpcActivityErrors = new Set();
		if (ctx.hasUI && isInteractiveRpcHost(ctx.mode, deps.env)) {
			rpcActivityPublisher = createRpcActivityPublisher({
				store,
				ui: { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) },
				now: deps.now,
				schedule: deps.schedule,
				parentSessionId: activeSessionId(),
				onError: (error) => {
					const message = `Gentle Agents activity push failed: ${error instanceof Error ? error.message : String(error)}`;
					if (notifiedRpcActivityErrors?.has(message)) return;
					notifiedRpcActivityErrors?.add(message);
					ctx.ui.notify(message, "warning");
				},
			});
			rpcActivityPublisher.start();
		}
	});
	pi.on("session_shutdown", async () => {
		completions.dropAll();
		messages.dropAll();
		activeAgentRuns = 0;
		presence?.dispose();
		presence = undefined;
		rpcActivityPublisher?.stop();
		rpcActivityPublisher = undefined;
		cancelClock?.();
		for (const view of overlays) { view.handleInput("q"); view.dispose(); }
		overlays.clear();
		sessions = undefined;
		stopVisualUpdates?.();
		stopVisualUpdates = undefined;
		sidebarTui = undefined;
		worktrees?.close();
		worktrees = undefined;
		const stopped = shutdownSessionTransport();
		runner.cancelAll("cancelled: parent session shut down");
		await stopped;
	});
}
