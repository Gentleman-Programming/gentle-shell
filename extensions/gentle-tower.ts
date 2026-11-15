// Gentle Tower publisher: every top-level Gentle Shell session keeps one private
// snapshot of itself in the tower hub, so the web tower can draw it as a floor.
// Read-only: it reuses the existing todo replay, session stats, ODD phase and
// the desktop agents adapter; it owns no state of its own beyond the file.

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TowerServer } from "../lib/tower-server.ts";
import { openInBrowser, openTowerServer, TOWER_WEB_DIR, TowerNotBuiltError } from "../lib/tower-open.ts";
import { discoverDesktopAgentsService } from "../lib/desktop-agents-service.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { collectSessionStats } from "../lib/shell-stats.ts";
import { replayTodo, TODO_PROGRESS_EVENT } from "../lib/shell-todo.ts";
import { removeTowerSnapshot, towerHubDir, writeTowerSnapshot } from "../lib/tower-hub.ts";
import { consumeTowerActions, type TowerSessionAction } from "../lib/tower-actions.ts";
import { discoverYoloUiAdapter } from "../lib/yolo-session-policy.ts";
import { artifactsFromBranch, buildTowerSnapshot, chatFromBranch, latestAssistantText, type TowerAgentInput, type TowerTodo } from "../lib/tower-snapshot.ts";

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
	/** Longest wait for one call into another extension while running a web action. */
	actionTimeoutMs?: number;
}

const LIVE_HELPER = new Set(["queued", "running", "waiting"]);
const QUESTION_EVENTS = ["gentle-pi:ask-user-question:blocked", "gentle-pi:ask-user-choice:blocked"];
/** Strictness order: the web moves a floor down at once; up only with approval in its terminal. */
const MODE_RANK: Record<string, number> = { normal: 0, auto: 1, yolo: 2, "super-yolo": 3 };

/** Rejects when `work` does not settle in time, so one hung call cannot hold the inbox forever. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), ms); });
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const ACTION_LABEL: Record<TowerSessionAction["type"], string> = { message: "deliver the message", "cancel-helper": "stop the helper", permission: "change permissions", review: "change review mode" };

function runGentleAi(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => execFile("gentle-ai", args, { cwd, timeout: 15000, maxBuffer: 256 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
}

export interface TowerHandle {
	close(): Promise<void>;
}


export function createTowerPublisher(pi: ExtensionAPI, options: TowerPublisherOptions = {}): TowerHandle | undefined {
	const env = options.env ?? process.env;
	if (env.GENTLE_PI_AGENTS_CHILD === "1" || env.GENTLE_TOWER === "off") return undefined;
	const dir = towerHubDir(env);
	const webDir = options.webDir ?? TOWER_WEB_DIR;
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
	const actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
	/** Notices of the inbox batch being run; published together when it ends. */
	let batch: Array<{ text: string; ok: boolean }> | undefined;
	/** A message of the running inbox batch reached the session. */
	let delivered = false;

	const publish = () => {
		timer = undefined;
		if (!ctx || !sessionId) return;
		try {
			const branch = ctx.sessionManager.getBranch() as readonly unknown[];
			const stats = collectSessionStats(branch);
			const usage = ctx.getContextUsage?.();
			// The agents service keeps finished tasks as history; only live helpers are on the floor.
			const listed = ((agents?.read().agents ?? []) as unknown as TowerAgentInput[]).filter((a) => LIVE_HELPER.has(String(a.status)));
			writeTowerSnapshot(dir, { pid: process.pid, ...buildTowerSnapshot({
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
				chat: chatFromBranch(branch),
				models: stats.models.map((m) => ({ model: m.model, cost: m.cost, tokens: m.tokens })),
				artifacts: artifactsFromBranch(branch, ctx.sessionManager.getCwd()),
				now: now(),
			}) });
		} catch {
			// The tower is a view: a failed write never disturbs the session.
		}
	};
	const schedule = () => {
		if (!ctx) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(publish, debounceMs);
	};
	/** Reads the session's current mode; undefined when it cannot be read (failed, timed out, or no mode). */
	const readMode = async (): Promise<string | undefined> => {
		try {
			const snap = yolo?.readSnapshot ? await within(yolo.readSnapshot(), actionTimeoutMs, "Permissions") : undefined;
			return typeof snap?.mode === "string" ? snap.mode : undefined;
		} catch { return undefined; }
	};
	/** An unreadable mode is shown as unknown, never as the last one seen. */
	/** Re-reads the mode, updates the published one, and returns this read's own value. */
	const refreshPermission = async (): Promise<string | undefined> => {
		if (!yolo?.readSnapshot) return undefined;
		const mode = await readMode();
		if (mode !== permission) { permission = mode; schedule(); }
		return mode;
	};
	const refreshReview = async (cwd: string) => {
		try {
			const status = JSON.parse(await reviewCli(["review", "mode", "status", "--json"], cwd))?.status?.effective;
			const next = status === "on" || status === "off" ? status : undefined;
			if (next !== review) { review = next; schedule(); }
		} catch { /* gentle-ai missing: no switch */ }
	};
	const say = (text: string, ok: boolean) => {
		if (batch) { batch.push({ text, ok }); return; }
		notice = { text, ok, at: now() };
		schedule();
	};
	const execute = async (action: TowerSessionAction, c: ExtensionContext) => {
		switch (action.type) {
			case "message":
				// The message shows in the conversation itself; a standalone "delivered" line only confused.
				pi.sendUserMessage(action.text, c.isIdle?.() ? undefined : { deliverAs: "followUp" });
				delivered = true;
				return;
			case "cancel-helper": {
				const helper = agents?.read().agents.find((a) => a.id === action.helperId);
				if (!agents || !helper) return say("That helper is no longer running", false);
				await within(Promise.resolve(agents.cancel(action.helperId)), actionTimeoutMs, "The helper");
				return say(`Stopped ${String(helper.agent).replace(/^gentle-ai-/, "")}`, true);
			}
			case "permission": {
				if (!yolo?.setMode || !yolo.readSnapshot) return say("Permissions are not available in this session", false);
				// Fail closed: the raise-or-lower decision needs the mode the session is in now, never a cached one.
				// Decide on this action's own read: a late result of an earlier write may rewrite the shared value meanwhile.
				const from = await refreshPermission();
				if (from === undefined) return say("Permissions unchanged: could not read the current mode", false);
				const raise = !(action.mode in MODE_RANK) || !(from in MODE_RANK) || MODE_RANK[action.mode] > MODE_RANK[from];
				if (raise) {
					// A higher permission always passes through the human, in this session's own terminal.
					// Not bounded on purpose: the person may take as long as they need to decide.
					if (c.hasUI !== true || typeof c.ui?.confirm !== "function") return say(`Raising permissions to ${action.mode} needs the terminal: this session cannot ask`, false);
					let approved = false;
					try { approved = (await c.ui.confirm("Gentle Tower", `The tower asks to raise this session's permissions from ${from} to ${action.mode}. Allow?`)) === true; } catch { approved = false; }
					if (!approved) return say(`Raising permissions to ${action.mode} was declined in the terminal`, false);
				}
				const applied = `Permissions: ${action.mode}${raise ? " (approved in the terminal)" : ""}`;
				const write = Promise.resolve(yolo.setMode(action.mode as never));
				const owner = sessionId;
				let ok: boolean;
				try { ok = await within(write, actionTimeoutMs, "Permissions"); }
				catch {
					// A late write can still land: say what the session is in now, and report the real result once it settles.
					// Contexts are per event, so the session id (not the ctx object) tells whether it is still this session.
					void write.then(() => undefined, () => undefined).then(async () => {
						if (sessionId !== owner) return;
						const now = await refreshPermission();
						if (sessionId !== owner) return;
						say(now === action.mode ? applied : `Permissions unchanged: the session is in ${now ?? "an unknown mode"}`, now === action.mode);
					});
					const now = await refreshPermission();
					if (now === action.mode) return say(applied, true);
					return say(`Permissions: the change to ${action.mode} is still pending; the session is in ${now ?? "an unknown mode"}`, false);
				}
				await refreshPermission();
				if (!ok) return say("Permissions unchanged", false);
				return say(applied, true);
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
		batch = [];
		delivered = false;
		try {
			// Each action stands alone: one failure is reported and the rest still run.
			for (const action of consumeTowerActions(dir, sessionId)) {
				try { await execute(action, c); }
				catch (error) { say(`Could not ${ACTION_LABEL[action.type]}: ${error instanceof Error ? error.message : String(error)}`, false); }
			}
		} catch { /* an unreadable inbox never disturbs the session */ }
		finally {
			const done = batch;
			batch = undefined;
			busy = false;
			if (done.length) say(done.map((n) => n.text).join(" · "), done.every((n) => n.ok));
			// A message that went through clears an older failure, so it does not read as this one's.
			else if (delivered && notice) { notice = undefined; schedule(); }
		}
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
		// The tower this session opened ends with it.
		const opened = server;
		server = undefined;
		void opened?.then((s) => s.close()).catch(() => undefined);
	});

	pi.registerCommand("gentle:tower", {
		description: "Open the Gentle Tower: every Gentle Shell session as a floor, in your browser",
		handler: async (_args, c) => {
			// Same startup as `gentle-shell tower`: hub, web app, token, presence, new floors.
			server ??= openTowerServer(env, { webDir });
			try {
				const s = await server;
				c.ui.notify(`Gentle Tower: ${s.url}`, "info");
				openUrl(s.url);
			} catch (error) {
				server = undefined;
				if (error instanceof TowerNotBuiltError) return c.ui.notify(error.message, "warning");
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
