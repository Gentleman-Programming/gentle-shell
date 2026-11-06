import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { agentStatus, createAgentStatusStore, type AgentStatus } from "../lib/agent-status.ts";
import { activeTodoTitle, herdrAgentLabel } from "../lib/herdr-activity.ts";
import { HERDR_TASK_SUMMARY_CHANGED, resolveHerdrTaskSummarySettings } from "../lib/herdr-task-summary-policy.ts";
import { NOTIFICATION_ATTENTION_EVENT } from "../lib/notification-events.ts";
import { replayTodo } from "../lib/shell-todo.ts";

// One-second watch plus a nine-second deadline leaves room for tick alignment.
const REFRESH_MS = 9000;
// A refused or failing store waits before the next attempt instead of retrying every tick.
const RETRY_MS = 30_000;

interface Options {
	env?: NodeJS.ProcessEnv;
	gentlePiConfigHome?: string;
	now?: () => number;
	watch?: (tick: () => void) => () => void;
	schedule?: (flush: () => void) => () => void;
	store?: (home: string, session: string) => { write: (value: AgentStatus) => boolean; remove: () => void };
}
export function createAgentStatusExtension(options: Options = {}) {
	return (pi: ExtensionAPI): void => {
		const env = options.env ?? process.env;
		if (env.GENTLE_PI_AGENTS_CHILD === "1") return;
		const home = resolve(options.gentlePiConfigHome ?? gentlePiConfigHome(env));
		const now = options.now ?? Date.now;
		let owner: string | undefined;
		let ctx: ExtensionContext;
		let store: ReturnType<typeof createAgentStatusStore> | ReturnType<NonNullable<Options["store"]>> | undefined;
		let working = false; let taskActive = false; let blocked = 0; let enabled = true;
		let tasks: unknown = []; let last = ""; let refreshed = -Infinity; let retryAt = -Infinity;
		let cancel: (() => void) | undefined; let stop: (() => void) | undefined;
		let subscriptions: Array<() => void> = [];
		const owns = (context: ExtensionContext) => owner !== undefined && context.sessionManager.getSessionId() === owner;
		const flush = () => {
			cancel = undefined;
			if (!owner || !store) return;
			const title = enabled && taskActive ? activeTodoTitle(tasks) : null;
			const input = { agent: herdrAgentLabel(env), session: owner, pid: process.pid, cwd: ctx.cwd,
				state: blocked > 0 ? "blocked" as const : working ? "working" as const : "idle" as const,
				task: title ? { title } : null };
			const key = JSON.stringify(input); const time = now();
			if (time < retryAt || (key === last && time - refreshed < REFRESH_MS)) return;
			let written = false;
			try { written = store.write(agentStatus(input, time)); } catch { /* Retry after backoff. */ }
			if (written) { last = key; refreshed = time; retryAt = -Infinity; } else retryAt = time + RETRY_MS;
		};
		const publish = () => {
			if (!owner || cancel) return;
			cancel = (options.schedule ?? ((fn) => {
				const timer = setTimeout(fn, 0); timer.unref(); return () => clearTimeout(timer);
			}))(flush);
		};
		const close = () => {
			cancel?.(); cancel = undefined; stop?.(); stop = undefined;
			for (const unsubscribe of subscriptions) unsubscribe(); subscriptions = [];
			try { store?.remove(); } catch { /* Never break shutdown. */ }
			store = undefined; owner = undefined;
		};
		pi.on("session_start", (_event, context) => {
			close();
			if (context.mode !== "tui" || !context.hasUI) return;
			ctx = context; owner = ctx.sessionManager.getSessionId();
			if (!owner) return;
			try { store = (options.store ?? createAgentStatusStore)(home, owner); } catch { owner = undefined; return; }
			working = ctx.isIdle() === false; taskActive = working; blocked = 0; last = ""; refreshed = -Infinity; retryAt = -Infinity;
			tasks = replayTodo(ctx.sessionManager.getBranch()).tasks;
			enabled = resolveHerdrTaskSummarySettings({ gentlePiConfigHome: home }).settings.enabled;
			subscriptions = [pi.events.on(NOTIFICATION_ATTENTION_EVENT, (data: unknown) => {
				const event = data as { active?: boolean } | undefined;
				blocked = event?.active ? blocked + 1 : Math.max(0, blocked - 1); publish();
			}), pi.events.on(HERDR_TASK_SUMMARY_CHANGED, (data: unknown) => {
				const event = data as { configHome?: unknown } | undefined;
				if (typeof event?.configHome !== "string" || resolve(event.configHome) !== home) return;
				const next = resolveHerdrTaskSummarySettings({ gentlePiConfigHome: home });
				if (next.malformed || next.readError) return;
				enabled = next.settings.enabled; publish();
			})];
			stop = (options.watch ?? ((tick) => {
				const timer = setInterval(tick, 1000); timer.unref(); return () => clearInterval(timer);
			}))(() => { if (now() - refreshed >= REFRESH_MS) { cancel?.(); flush(); } });
			publish();
		});
		pi.on("agent_start", (_event, context) => { if (owns(context)) { working = true; taskActive = true; publish(); } });
		pi.on("agent_settled", (_event, context) => {
			if (!owns(context)) return;
			taskActive = false; if (context.isIdle() === true) working = false; publish();
		});
		pi.on("session_tree", (_event, context) => {
			if (!owns(context)) return;
			taskActive = false; tasks = replayTodo(context.sessionManager.getBranch()).tasks; publish();
		});
		pi.on("tool_execution_end", (event, context) => {
			if (!owns(context) || event.toolName !== "todo" || event.isError) return;
			const details = (event.result as { details?: { gentleTodo?: { tasks?: unknown }; error?: unknown } })?.details;
			if (details && Object.hasOwn(details, "gentleTodo") && !details.error) { tasks = details.gentleTodo?.tasks; publish(); }
		});
		pi.on("session_shutdown", (_event, context) => { if (owns(context)) close(); });
	};
}
export default createAgentStatusExtension();
