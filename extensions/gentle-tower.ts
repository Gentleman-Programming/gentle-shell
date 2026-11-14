// Gentle Tower publisher: every top-level Gentle Shell session keeps one private
// snapshot of itself in the tower hub, so the web tower can draw it as a floor.
// Read-only: it reuses the existing todo replay, session stats, ODD phase and
// the desktop agents adapter; it owns no state of its own beyond the file.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startTowerServer, type TowerServer } from "../lib/tower-server.ts";
import { discoverDesktopAgentsService } from "../lib/desktop-agents-service.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { collectSessionStats } from "../lib/shell-stats.ts";
import { replayTodo, TODO_PROGRESS_EVENT } from "../lib/shell-todo.ts";
import { removeTowerSnapshot, towerHubDir, writeTowerSnapshot } from "../lib/tower-hub.ts";
import { buildTowerSnapshot, type TowerAgentInput, type TowerTodo } from "../lib/tower-snapshot.ts";

type AgentsService = Awaited<ReturnType<typeof discoverDesktopAgentsService>>;

export interface TowerPublisherOptions {
	env?: NodeJS.ProcessEnv;
	debounceMs?: number;
	now?: () => number;
	/** Built web app folder (defaults to the package's web/tower/dist). */
	webDir?: string;
	/** Opens the tower URL; defaults to the system browser. */
	openUrl?: (url: string) => void;
}

export interface TowerHandle {
	close(): Promise<void>;
}

const DEFAULT_WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "tower", "dist");

function openInBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* the URL is also shown */ }
}

export function createTowerPublisher(pi: ExtensionAPI, options: TowerPublisherOptions = {}): TowerHandle | undefined {
	const env = options.env ?? process.env;
	if (env.GENTLE_PI_AGENTS_CHILD === "1" || env.GENTLE_TOWER === "off") return undefined;
	const dir = towerHubDir(env);
	const webDir = options.webDir ?? DEFAULT_WEB_DIR;
	const openUrl = options.openUrl ?? openInBrowser;
	let server: Promise<TowerServer> | undefined;
	const debounceMs = options.debounceMs ?? 300;
	const now = options.now ?? Date.now;
	let ctx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let agents: AgentsService;
	let stopObserving: (() => void) | undefined;

	const publish = () => {
		timer = undefined;
		if (!ctx || !sessionId) return;
		try {
			const branch = ctx.sessionManager.getBranch() as readonly unknown[];
			const stats = collectSessionStats(branch);
			const usage = ctx.getContextUsage?.();
			const listed = (agents?.read().agents ?? []) as unknown as TowerAgentInput[];
			writeTowerSnapshot(dir, buildTowerSnapshot({
				sessionId,
				sessionName: ctx.sessionManager.getSessionName(),
				cwd: ctx.sessionManager.getCwd(),
				modelId: ctx.model?.id,
				effort: ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
				context: usage ? { percent: usage.percent, contextWindow: usage.contextWindow } : undefined,
				stats,
				todos: replayTodo(branch).tasks as TowerTodo[],
				agents: listed,
				phase: oddPhaseRegistry.get(sessionId),
				now: now(),
			}));
		} catch {
			// The tower is a view: a failed write never disturbs the session.
		}
	};
	const schedule = () => {
		if (!ctx) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(publish, debounceMs);
	};
	const stop = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		stopObserving?.();
		stopObserving = undefined;
		agents?.dispose();
		agents = undefined;
	};

	pi.on("session_start", async (_event, c) => {
		stop();
		ctx = c;
		sessionId = c.sessionManager.getSessionId();
		schedule();
		const found = await discoverDesktopAgentsService(pi, c);
		if (ctx !== c) { found?.dispose(); return; }
		agents = found;
		stopObserving = found?.observe(() => schedule());
		schedule();
	});
	for (const name of ["turn_end", "agent_end", "tool_execution_end", "model_select"] as const) {
		pi.on(name as "turn_end", (_event, c) => { ctx = c; schedule(); });
	}
	pi.events.on(TODO_PROGRESS_EVENT, () => schedule());
	pi.on("session_shutdown", () => {
		const id = sessionId;
		stop();
		ctx = undefined;
		sessionId = undefined;
		if (id) { try { removeTowerSnapshot(dir, id); } catch { /* best effort */ } }
	});

	pi.registerCommand("gentle:tower", {
		description: "Open the Gentle Tower: every Gentle Shell session as a floor, in your browser",
		handler: async (_args, c) => {
			if (!existsSync(join(webDir, "index.html"))) {
				c.ui.notify(`Gentle Tower: the web app is not built (${webDir}). Run: pnpm build:tower`, "warning");
				return;
			}
			server ??= startTowerServer({ hubDir: dir, webDir, token: randomBytes(24).toString("base64url") });
			try {
				const s = await server;
				c.ui.notify(`Gentle Tower: ${s.url}`, "info");
				openUrl(s.url);
			} catch (error) {
				server = undefined;
				c.ui.notify(`Gentle Tower could not start: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	return {
		close: async () => { const s = server; server = undefined; if (s) await (await s).close(); },
	};
}

export default function gentleTower(pi: ExtensionAPI): void {
	createTowerPublisher(pi);
}
