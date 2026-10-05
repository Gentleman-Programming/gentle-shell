import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activitySummary, ActivityPublisher, createActivityColumns, metadataTransport } from "../lib/herdr-activity.ts";
import { replayTodo, type TodoState } from "../lib/shell-todo.ts";

interface ActivityOptions {
	env?: NodeJS.ProcessEnv;
	isSocket?: (path: string) => boolean;
	send?: (summary: string | null, seq: number) => Promise<void>;
	watch?: (tick: () => void) => () => void;
	now?: () => number;
	columns?: () => number;
}

export function createHerdrActivityExtension(options: ActivityOptions = {}) {
	return (pi: ExtensionAPI): void => {
		const env = options.env ?? process.env;
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || env.HERDR_ENV !== "1" ||
			!env.HERDR_PANE_ID?.trim() || !env.HERDR_SOCKET_PATH?.trim()) return;
		const isSocket = options.isSocket ?? ((path: string) => {
			try { return statSync(path).isSocket(); } catch { return false; }
		});
		let publisher: ActivityPublisher | undefined;
		let stop: (() => void) | undefined;
		let owner: string | undefined;
		let tasks: TodoState["tasks"] = [];
		let active = false;
		let refreshAt = 0;
		const columns = options.columns ?? createActivityColumns(env.HERDR_SOCKET_PATH!, options.now);
		const owns = (ctx: ExtensionContext) => owner !== undefined && ctx.sessionManager.getSessionId() === owner;
		const publish = () => {
			if (!active || !publisher) return;
			const now = (options.now ?? Date.now)();
			publisher.update(activitySummary(tasks, columns()), now >= refreshAt);
			if (now >= refreshAt) refreshAt = now + 10000;
		};
		const idle = () => { active = false; publisher?.update(null); };
		const startSession = (ctx: ExtensionContext) => {
			idle(); stop?.(); stop = undefined;
			owner = undefined;
			if (ctx.mode !== "tui" || !ctx.hasUI || !isSocket(env.HERDR_SOCKET_PATH!)) return;
			owner = ctx.sessionManager.getSessionId();
			if (!owner) return;
			publisher ??= new ActivityPublisher(options.send ?? metadataTransport(env));
			publisher.update(null, true);
			tasks = replayTodo(ctx.sessionManager.getBranch()).tasks;
			const watch = options.watch ?? ((tick: () => void) => {
				const timer = setInterval(tick, 1000); timer.unref(); return () => clearInterval(timer);
			});
			// Refresh bounded cached geometry and TTL during long tools/model calls.
			stop = watch(publish);
		};
		pi.on("session_start", (_event, ctx) => startSession(ctx));
		pi.on("session_tree", (_event, ctx) => {
			if (!owns(ctx)) return;
			idle(); tasks = replayTodo(ctx.sessionManager.getBranch()).tasks;
		});
		pi.on("agent_start", (_event, ctx) => {
			if (!owns(ctx)) return;
			active = true; refreshAt = 0; publish();
		});
		pi.on("tool_execution_end", (event, ctx) => {
			if (!owns(ctx)) return;
			if (event.toolName !== "todo" || event.isError) return;
			const result = event.result as { details?: { gentleTodo?: TodoState; error?: unknown } };
			const state = result?.details?.gentleTodo;
			if (result?.details && Object.hasOwn(result.details, "gentleTodo") && !result.details.error) {
				tasks = Array.isArray(state?.tasks) ? state.tasks : [];
				publish();
			}
		});
		pi.on("agent_settled", (_event, ctx) => { if (owns(ctx)) idle(); });
		pi.on("session_shutdown", (_event, ctx) => {
			if (!owns(ctx)) return;
			idle(); stop?.(); stop = undefined;
			publisher?.close(); publisher = undefined; owner = undefined; tasks = [];
		});
	};
}

export default createHerdrActivityExtension();
