import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_RPC_COMMAND,
	DESKTOP_RPC_WIDGET,
	DesktopRpcRouter,
	type DesktopRpcDomain,
	type DesktopRpcPublish,
} from "../lib/desktop-rpc.ts";
import {
	DESKTOP_CONFIG_EVENTS,
	DESKTOP_CONFIG_METHODS,
	DesktopConfigBridge,
} from "../lib/desktop-rpc-config.ts";
import {
	DESKTOP_PERMISSION_EVENT,
	DESKTOP_PERMISSION_METHODS,
	DesktopPermissionBridge,
} from "../lib/desktop-rpc-permissions.ts";
import { DESKTOP_USAGE_EVENTS, DESKTOP_USAGE_METHODS } from "../lib/desktop-rpc-usage.ts";
import { DesktopUsageBridge } from "../lib/desktop-usage-service.ts";
import { DESKTOP_DESIGN_EVENTS, DESKTOP_DESIGN_METHODS } from "../lib/desktop-rpc-design.ts";
import { DesktopDesignBridge } from "../lib/desktop-design-service.ts";
import { DESKTOP_JOBS_EVENTS, DESKTOP_JOBS_METHODS } from "../lib/desktop-rpc-jobs.ts";
import { DesktopJobsBridge } from "../lib/desktop-jobs-service.ts";
import { DESKTOP_AGENTS_EVENTS, DESKTOP_AGENTS_METHODS } from "../lib/desktop-rpc-agents.ts";
import { DesktopAgentsBridge } from "../lib/desktop-agents-service.ts";
import { DESKTOP_CHANGES_EVENTS, DESKTOP_CHANGES_METHODS } from "../lib/desktop-rpc-changes.ts";
import { DesktopChangesBridge } from "../lib/desktop-changes-service.ts";
import { DESKTOP_PROFILES_EVENTS, DESKTOP_PROFILES_METHODS, DesktopProfilesBridge } from "../lib/desktop-rpc-profiles.ts";
import { DESKTOP_SESSION_EVENTS } from "../lib/desktop-rpc-session.ts";
import { DesktopSessionBridge } from "../lib/desktop-session-service.ts";
import { DESKTOP_SESSIONS_EVENTS, DESKTOP_SESSIONS_METHODS, desktopRequestId, desktopSessionsErrorLine, SESSION_SWITCHING } from "../lib/desktop-rpc-sessions.ts";
import { DesktopSessionsBridge } from "../lib/desktop-sessions-service.ts";
import { DESKTOP_REVIEW_EVENTS, DESKTOP_REVIEW_METHODS } from "../lib/desktop-rpc-review.ts";
import { DesktopReviewBridge } from "../lib/desktop-review-service.ts";
import { DESKTOP_STATS_EVENTS, DESKTOP_STATS_METHODS } from "../lib/desktop-rpc-stats.ts";
import { DesktopStatsBridge } from "../lib/desktop-stats-service.ts";
import { DESKTOP_UPDATES_EVENTS, DESKTOP_UPDATES_METHODS } from "../lib/desktop-rpc-updates.ts";
import { DesktopUpdatesBridge, type UpdateSourcesFactory } from "../lib/desktop-updates-service.ts";
import { DESKTOP_AGENT_DEFINITIONS_EVENTS, DESKTOP_AGENT_DEFINITIONS_METHODS } from "../lib/desktop-rpc-agent-definitions.ts";
import { DesktopAgentDefinitionsBridge, type AgentDefinitionsLocationFactory } from "../lib/desktop-agent-definitions-service.ts";
import { DESKTOP_STATUS_EVENTS, DESKTOP_STATUS_METHODS } from "../lib/desktop-rpc-status.ts";
import { DesktopStatusBridge } from "../lib/desktop-status-service.ts";
import { DESKTOP_BACKGROUND_SUBAGENTS_EVENTS, DESKTOP_BACKGROUND_SUBAGENTS_METHODS } from "../lib/desktop-rpc-background-subagents.ts";
import { DesktopBackgroundSubagentsBridge } from "../lib/desktop-background-subagents-service.ts";
import { DESKTOP_PROFILE_BINDING_EVENTS, DESKTOP_PROFILE_BINDING_METHODS, DesktopProfileBindingBridge } from "../lib/desktop-rpc-profile-binding.ts";
import { DESKTOP_AUTH_EVENTS, DESKTOP_AUTH_METHODS } from "../lib/desktop-rpc-auth.ts";
import { DesktopAuthBridge } from "../lib/desktop-auth-service.ts";
import { isInteractiveRpcHost } from "../lib/rpc-host.ts";
import type { DesktopChangeTimers, DesktopDirectoryWatch } from "../lib/desktop-rpc-config-watch.ts";

/** Test seams for external-change detection; production uses `fs.watch` and real timers. */
export interface DesktopRpcExtensionOptions {
	watch?: DesktopDirectoryWatch;
	timers?: DesktopChangeTimers;
	/** Test seams for `get_update_status`; production reads the real update sources. */
	updateSources?: UpdateSourcesFactory;
	updateTimeoutMs?: number;
	/** Test seam for `list_agent_definitions`; production uses the session's discovery roots. */
	agentDefinitionsLocation?: AgentDefinitionsLocationFactory;
}

function publisher(ctx: ExtensionContext): DesktopRpcPublish {
	// Extract the UI once: Pi invalidates a captured ctx after a session switch,
	// but an extracted raw object stays usable, so a switch-retired instance can
	// still answer the requests that reach it during the replacement.
	const ui = ctx.ui;
	return (line) => {
		try {
			ui.setWidget(DESKTOP_RPC_WIDGET, [line]);
		} catch {
			throw new Error("Desktop RPC transport unavailable");
		}
	};
}

export default function desktopRpc(pi: ExtensionAPI, options: DesktopRpcExtensionOptions = {}) {
	// Permission control always delegates to the existing Gentle AI session owner;
	// config reads and writes delegate to the existing store owners; subscription
	// usage delegates to the existing usage owner; design canvas reads delegate
	// to the existing design owner; background jobs list/cancel/output delegate to the
	// existing parent-session job registry and monitor controller; subagents
	// list/cancel delegate to the existing parent-session TaskStore and
	// AgentRunner; profile applies delegate to the existing `/gentle:profiles`
	// owner and its own apply actions; session sections delegate to the live
	// feed projection (`extensions/gentle-desktop-feed.ts`); sessions list/switch
	// delegate to Pi's own `SessionManager` and the command context's
	// `switchSession`; changed files and per-file diffs delegate to the existing
	// `/gentle:changes` tracker; review (RDD) mode reads and changes delegate to
	// the `/gentle:review-mode` owner and its native CLI adapter; cross-session
	// usage stats delegate to the existing `/gentle:stats` owner and its one
	// cached loader; update status reads Gentle Shell's own channel and version
	// resolution and Pi's own package update check, keeping refresh results in
	// memory only. None has a store of its own.
	const changeTimers = options.timers === undefined ? {} : { timers: options.timers };
	const permissions = new DesktopPermissionBridge(pi, undefined, changeTimers);
	const config = new DesktopConfigBridge({}, { ...changeTimers, ...(options.watch === undefined ? {} : { watch: options.watch }) });
	const usage = new DesktopUsageBridge(pi);
	const design = new DesktopDesignBridge(pi);
	const jobs = new DesktopJobsBridge(pi);
	const agents = new DesktopAgentsBridge(pi);
	const profiles = new DesktopProfilesBridge(pi);
	const sessions = new DesktopSessionBridge(pi);
	const sessionList = new DesktopSessionsBridge();
	// The requestId of the command being dispatched. The router calls the domain
	// synchronously from `handle`, so the sessions slice reads it before any
	// await; a switch needs it to answer from the replacement session.
	let dispatchingRequestId: string | null = null;
	// The publisher of the running session, and the one kept after a switch tore
	// this instance down. Pi can still dispatch a command to a replaced instance
	// (its ctx is stale by then); that command is answered `session_switching`.
	let activePublish: DesktopRpcPublish | undefined;
	let retiredPublish: DesktopRpcPublish | undefined;
	const changes = new DesktopChangesBridge(pi);
	const review = new DesktopReviewBridge(pi);
	const stats = new DesktopStatsBridge(pi);
	const updates = new DesktopUpdatesBridge({
		...(options.updateSources === undefined ? {} : { sources: options.updateSources }),
		...(options.updateTimeoutMs === undefined ? {} : { timeoutMs: options.updateTimeoutMs }),
	});
	const packageStatus = new DesktopStatusBridge(pi);
	const auth = new DesktopAuthBridge();
	const profileBinding = new DesktopProfileBindingBridge(pi);
	const backgroundSubagents = new DesktopBackgroundSubagentsBridge(pi);
	const agentDefinitions = new DesktopAgentDefinitionsBridge(options.agentDefinitionsLocation === undefined ? {} : { location: options.agentDefinitionsLocation });
	const domain: DesktopRpcDomain = (method, params) => {
		// Captured before any await: a background-subagents write dispatched before a
		// session reset must not run under the replacement session.
		const backgroundGeneration = backgroundSubagents.dispatchGeneration();
		const sessionsOutcome = sessionList.handle(method, params, dispatchingRequestId);
		if (sessionsOutcome !== undefined) return sessionsOutcome;
		// Config is the only synchronous bridge; permission, usage, design, jobs,
		// profiles, agents, changes, review, stats, and updates answers are awaited in fall-through order, so an unknown
		// method still resolves to the router's `unsupported_method` instead of an
		// early `undefined`.
		const configOutcome = config.handle(method, params);
		if (configOutcome !== undefined) return configOutcome;
		// Agent definitions are a synchronous file read as well.
		const definitionsOutcome = agentDefinitions.handle(method, params);
		if (definitionsOutcome !== undefined) return definitionsOutcome;
		return (async () => {
			const permissionOutcome = await permissions.handle(method, params);
			if (permissionOutcome !== undefined) return permissionOutcome;
			const usageOutcome = await usage.handle(method, params);
			if (usageOutcome !== undefined) return usageOutcome;
			const designOutcome = await design.handle(method, params);
			if (designOutcome !== undefined) return designOutcome;
			const jobsOutcome = await jobs.handle(method, params);
			if (jobsOutcome !== undefined) return jobsOutcome;
			const profilesOutcome = await profiles.handle(method, params);
			if (profilesOutcome !== undefined) return profilesOutcome;
			const bindingOutcome = await profileBinding.handle(method, params);
			if (bindingOutcome !== undefined) return bindingOutcome;
			const agentsOutcome = await agents.handle(method, params);
			if (agentsOutcome !== undefined) return agentsOutcome;
			const changesOutcome = await changes.handle(method, params);
			if (changesOutcome !== undefined) return changesOutcome;
			const reviewOutcome = await review.handle(method, params);
			if (reviewOutcome !== undefined) return reviewOutcome;
			const statsOutcome = await stats.handle(method, params);
			if (statsOutcome !== undefined) return statsOutcome;
			const statusOutcome = await packageStatus.handle(method, params);
			if (statusOutcome !== undefined) return statusOutcome;
			const authOutcome = await auth.handle(method, params);
			if (authOutcome !== undefined) return authOutcome;
			const backgroundOutcome = await backgroundSubagents.handle(method, params, backgroundGeneration);
			if (backgroundOutcome !== undefined) return backgroundOutcome;
			return updates.handle(method, params);
		})();
	};
	const events = [...DESKTOP_CONFIG_EVENTS, DESKTOP_PERMISSION_EVENT, ...DESKTOP_USAGE_EVENTS, ...DESKTOP_DESIGN_EVENTS, ...DESKTOP_JOBS_EVENTS, ...DESKTOP_PROFILES_EVENTS, ...DESKTOP_AGENTS_EVENTS, ...DESKTOP_SESSIONS_EVENTS, ...DESKTOP_CHANGES_EVENTS, ...DESKTOP_REVIEW_EVENTS, ...DESKTOP_STATS_EVENTS, ...DESKTOP_UPDATES_EVENTS, ...DESKTOP_AGENT_DEFINITIONS_EVENTS, ...DESKTOP_STATUS_EVENTS, ...DESKTOP_BACKGROUND_SUBAGENTS_EVENTS, ...DESKTOP_PROFILE_BINDING_EVENTS, ...DESKTOP_AUTH_EVENTS];
	const router = new DesktopRpcRouter(
		["capabilities", "get_snapshot", ...DESKTOP_CONFIG_METHODS, ...DESKTOP_PERMISSION_METHODS, ...DESKTOP_USAGE_METHODS, ...DESKTOP_DESIGN_METHODS, ...DESKTOP_JOBS_METHODS, ...DESKTOP_PROFILES_METHODS, ...DESKTOP_AGENTS_METHODS, ...DESKTOP_SESSIONS_METHODS, ...DESKTOP_CHANGES_METHODS, ...DESKTOP_REVIEW_METHODS, ...DESKTOP_STATS_METHODS, ...DESKTOP_UPDATES_METHODS, ...DESKTOP_AGENT_DEFINITIONS_METHODS, ...DESKTOP_STATUS_METHODS, ...DESKTOP_BACKGROUND_SUBAGENTS_METHODS, ...DESKTOP_PROFILE_BINDING_METHODS, ...DESKTOP_AUTH_METHODS],
		// `session_snapshot` is advertised only while the feed owner seam is wired.
		() => (sessions.wired ? [...events, ...DESKTOP_SESSION_EVENTS] : events),
		() => config.snapshotState(),
		domain,
		(params) => sessions.snapshot(params),
	);
	// While a `switch_session` is in flight, every other request is answered at
	// once with a retryable `session_switching`: Pi's RPC loop dispatches
	// prompts concurrently, and an answer that settled after the teardown would
	// otherwise be dropped with the old session.
	router.setGate(() => (sessionList.switchInFlight() ? SESSION_SWITCHING : undefined));

	pi.on("session_start", (_event, ctx) => {
		permissions.reset();
		config.reset();
		usage.reset();
		design.reset();
		jobs.reset();
		profiles.reset();
		agents.reset();
		sessions.reset();
		sessionList.reset();
		changes.reset();
		review.reset();
		stats.reset();
		updates.reset();
		agentDefinitions.reset();
		packageStatus.reset();
		backgroundSubagents.reset();
		profileBinding.reset();
		auth.reset();
		router.stop();
		activePublish = undefined;
		retiredPublish = undefined;
		if (!isInteractiveRpcHost(ctx.mode)) return;
		design.attach(ctx);
		jobs.attach(ctx);
		agents.attach(ctx);
		sessions.attach(ctx);
		activePublish = publisher(ctx);
		router.start(activePublish);
		// Header-driven usage snapshots (Claude's 5h/7d windows, Codex SSE
		// headers) become ordered `rate_limit` events through the router.
		usage.wire((event, data) => router.emit(event, data));
		// Agent-driven canvas transitions become ordered `design_canvas` events;
		// subscribe eagerly so canvas work that happens before any Desktop
		// request still reaches the app.
		design.wire((event, data) => router.emit(event, data));
		void design.start();
		// Agent-driven background-job registry changes become ordered `jobs_update`
		// events; subscribe eagerly so a job started or stopped before any Desktop
		// request still reaches the app.
		jobs.wire((event, data) => router.emit(event, data));
		void jobs.start();
		// Agent-driven TaskStore transitions become ordered `agents_update` events;
		// subscribe eagerly so a subagent started or settled before any Desktop
		// request still reaches the app.
		agents.wire((event, data) => router.emit(event, data));
		void agents.start();
		// Feed-published session state becomes ordered `session_snapshot` events
		// carrying only the changed sections, on the feed's own tiers.
		sessions.wire((event, data) => router.emit(event, data));
		void sessions.start();
		// Changes made outside Desktop RPC (`/gentle:mode`, `/gentle:profiles`, an
		// editor, another `pi` process) become `source: "external"` events. Both are
		// best effort: the permission side follows the owner's observer, the config
		// side watches the owner files' directories; a missing owner or a watcher that
		// cannot be created leaves the channel working without these events. The
		// session_start/session_shutdown resets above dispose them.
		permissions.attach(ctx);
		void permissions.wire((event, data) => router.emit(event, data));
		config.attach(ctx);
		config.wire((event, data) => router.emit(event, data));
		// Binding writes made outside Desktop RPC (the /gentle:profiles screen, a
		// resume restoring the record) become `profile_binding_changed` events.
		profileBinding.attach(ctx);
		profileBinding.wire((event, data) => router.emit(event, data));
	});

	pi.on("session_shutdown", () => {
		// A switch is tearing this session down: answer every request still
		// waiting on an owner before the router stops, so none is lost. Only the
		// switch itself is kept; the replacement session answers it.
		const switching = sessionList.switchInFlight();
		if (switching) {
			router.abandonPending(SESSION_SWITCHING, (requestId) => requestId === switching.requestId);
			retiredPublish = activePublish;
		}
		activePublish = undefined;
		permissions.reset();
		config.reset();
		usage.reset();
		design.reset();
		jobs.reset();
		profiles.reset();
		agents.reset();
		sessions.reset();
		sessionList.reset();
		changes.reset();
		review.reset();
		stats.reset();
		updates.reset();
		agentDefinitions.reset();
		packageStatus.reset();
		backgroundSubagents.reset();
		profileBinding.reset();
		auth.reset();
		router.stop();
	});

	pi.registerCommand(DESKTOP_RPC_COMMAND, {
		description: "Handle a versioned Gentle Desktop RPC request",
		async handler(args, ctx) {
			if (retiredPublish) {
				// This instance was replaced by a switch: never touch the stale ctx.
				try {
					retiredPublish(desktopSessionsErrorLine(desktopRequestId(args), SESSION_SWITCHING));
				} catch {
					/* transport failures are never retried as a second response */
				}
				return;
			}
			if (!isInteractiveRpcHost(ctx.mode)) return;
			permissions.attach(ctx);
			config.attach(ctx);
			usage.attach(ctx);
			design.attach(ctx);
			jobs.attach(ctx);
			profiles.attach(ctx);
			agents.attach(ctx);
			sessions.attach(ctx);
			sessionList.attach(ctx);
			changes.attach(ctx);
			review.attach(ctx);
			stats.attach(ctx);
			updates.attach(ctx);
			agentDefinitions.attach(ctx);
			packageStatus.attach(ctx);
			backgroundSubagents.attach(ctx);
			profileBinding.attach(ctx);
			auth.attach(ctx);
			dispatchingRequestId = desktopRequestId(args);
			let pending: void | Promise<void>;
			try {
				pending = router.handle(args);
			} finally {
				dispatchingRequestId = null;
			}
			await pending;
		},
	});
}
