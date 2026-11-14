// Gentle Tower publisher: every top-level Gentle Shell session keeps one private
// snapshot of itself in the tower hub, so the web tower can draw it as a floor.
// Read-only: it reuses the existing todo replay, session stats, ODD phase and
// the desktop agents adapter; it owns no state of its own beyond the file.

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
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
import { consumeTowerActions, type TowerSessionAction } from "../lib/tower-actions.ts";
import { launchInTerminal } from "../lib/tower-launch.ts";
import { discoverYoloUiAdapter } from "../lib/yolo-session-policy.ts";
import { artifactsFromBranch, buildTowerSnapshot, latestAssistantText, type TowerAgentInput, type TowerTodo } from "../lib/tower-snapshot.ts";

type AgentsService = Awaited<ReturnType<typeof discoverDesktopAgentsService>>;

export interface TowerPublisherOptions {
	env?: NodeJS.ProcessEnv;
	debounceMs?: number;
	now?: () => number;
	/** Built web app folder (defaults to the package's web/tower/dist). */
	webDir?: string;
	/** Opens the tower URL; defaults to the system browser. */
	openUrl?: (url: string) => void;
	/** How often the session checks its action inbox. */
	inboxMs?: number;
	/** Runs `gentle-ai <args>` and returns stdout (injectable for tests). */
	reviewCli?: (args: string[], cwd: string) => Promise<string>;
}

const LIVE_HELPER = new Set(["queued", "running", "waiting"]);
const QUESTION_EVENTS = ["gentle-pi:ask-user-question:blocked", "gentle-pi:ask-user-choice:blocked"];
/** Strictness order: the web may only move a floor down this list, never up. */
const MODE_RANK: Record<string, number> = { normal: 0, auto: 1, yolo: 2, "super-yolo": 3 };

function runGentleAi(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => execFile("gentle-ai", args, { cwd, timeout: 15000, maxBuffer: 256 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
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
	let yolo: Awaited<ReturnType<typeof discoverYoloUiAdapter>>;
	let permission: string | undefined;
	let review: "on" | "off" | undefined;
	let waiting = false;
	let notice: { text: string; ok: boolean; at: number } | undefined;
	let inbox: ReturnType<typeof setInterval> | undefined;
	let busy = false;
	const reviewCli = options.reviewCli ?? runGentleAi;

	const publish = () => {
		timer = undefined;
		if (!ctx || !sessionId) return;
		try {
			const branch = ctx.sessionManager.getBranch() as readonly unknown[];
			const stats = collectSessionStats(branch);
			const usage = ctx.getContextUsage?.();
			// The agents service keeps finished tasks as history; only live helpers are on the floor.
			const listed = ((agents?.read().agents ?? []) as unknown as TowerAgentInput[]).filter((a) => LIVE_HELPER.has(String(a.status)));
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
				permission,
				review,
				waiting,
				notice,
				said: latestAssistantText(branch),
				models: stats.models.map((m) => ({ model: m.model, cost: m.cost, tokens: m.tokens })),
				artifacts: artifactsFromBranch(branch, ctx.sessionManager.getCwd()),
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
	const refreshPermission = async () => {
		try { const snap = await yolo?.readSnapshot?.(); if (snap && snap.mode !== permission) { permission = snap.mode; schedule(); } } catch { /* unknown */ }
	};
	const refreshReview = async (cwd: string) => {
		try {
			const status = JSON.parse(await reviewCli(["review", "mode", "status", "--json"], cwd))?.status?.effective;
			const next = status === "on" || status === "off" ? status : undefined;
			if (next !== review) { review = next; schedule(); }
		} catch { /* gentle-ai missing: no switch */ }
	};
	const say = (text: string, ok: boolean) => { notice = { text, ok, at: now() }; schedule(); };
	const execute = async (action: TowerSessionAction, c: ExtensionContext) => {
		switch (action.type) {
			case "message":
				pi.sendUserMessage(action.text, c.isIdle?.() ? undefined : { deliverAs: "followUp" });
				return say("Message delivered", true);
			case "cancel-helper": {
				const helper = agents?.read().agents.find((a) => a.id === action.helperId);
				if (!agents || !helper) return say("That helper is no longer running", false);
				await agents.cancel(action.helperId);
				return say(`Stopped ${String(helper.agent).replace(/^gentle-ai-/, "")}`, true);
			}
			case "permission": {
				await refreshPermission();
				if (!yolo?.setMode || permission === undefined) return say("Permissions are not available in this session", false);
				if (MODE_RANK[action.mode] > MODE_RANK[permission]) return say(`Raising permissions to ${action.mode} is only possible from the terminal`, false);
				const ok = await yolo.setMode(action.mode as never);
				await refreshPermission();
				return say(ok ? `Permissions: ${action.mode}` : "Permissions unchanged", ok);
			}
			case "review": {
				const cwd = c.sessionManager.getCwd();
				try { await reviewCli(["review", "mode", action.enabled ? "enable" : "disable"], cwd); } catch { return say("Could not change review mode", false); }
				await refreshReview(cwd);
				return say(`Review mode ${action.enabled ? "on" : "off"}`, true);
			}
		}
	};
	const drainInbox = async () => {
		if (busy || !ctx || !sessionId) return;
		busy = true;
		const c = ctx;
		try { for (const action of consumeTowerActions(dir, sessionId)) await execute(action, c); }
		catch { /* a bad action never disturbs the session */ }
		finally { busy = false; }
	};
	const stop = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (inbox) clearInterval(inbox);
		inbox = undefined;
		yolo?.dispose();
		yolo = undefined;
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
		inbox = setInterval(() => void drainInbox(), options.inboxMs ?? 600);
		inbox.unref?.();
		void refreshReview(c.sessionManager.getCwd());
		const [found, adapter] = await Promise.all([discoverDesktopAgentsService(pi, c), discoverYoloUiAdapter(pi, c)]);
		if (ctx !== c) { found?.dispose(); adapter?.dispose(); return; }
		agents = found;
		yolo = adapter;
		stopObserving = found?.observe(() => schedule());
		await refreshPermission();
		schedule();
	});
	for (const name of ["turn_end", "agent_end", "tool_execution_end", "model_select"] as const) {
		pi.on(name as "turn_end", (_event, c) => { ctx = c; schedule(); });
	}
	pi.events.on(TODO_PROGRESS_EVENT, () => schedule());
	for (const name of QUESTION_EVENTS) pi.events.on(name, (data) => { waiting = (data as { active?: boolean })?.active === true; schedule(); });
	pi.on("turn_end", () => { void refreshPermission(); });
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
			server ??= startTowerServer({ hubDir: dir, webDir, token: randomBytes(24).toString("base64url"), engramUrl: env.ENGRAM_URL || "http://127.0.0.1:7437",
				onNewFloor: (cwd, prompt) => launchInTerminal({ cwd, node: process.execPath, launcher: join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gentle-shell.mjs"), ...(prompt ? { prompt } : {}) }) });
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
