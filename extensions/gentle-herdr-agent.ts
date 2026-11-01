import net from "node:net";
import { posix, win32 } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HERDR_REPORTER_ENV } from "../lib/gentle-shell-launcher.ts";
import { herdrAgentLabel, herdrDetected } from "../lib/herdr-activity.ts";

// Gentle Shell's own Herdr agent integration (gentle-shell#2705). Herdr's
// managed Pi bridge always reports `agent: "pi"`, so the launcher stops
// loading it and sets HERDR_REPORTER_ENV; this extension then reports the
// same lifecycle under Herdr's documented custom-agent contract: its own
// stable source (never `herdr:`) and its own agent name. One reporter per pane.
const SOURCE = "gentle-shell";

type AgentState = "working" | "blocked" | "idle";
type HerdrRequest = { id: string; method: string; params: Record<string, unknown> };

interface HerdrAgentOptions {
	env?: NodeJS.ProcessEnv;
	send?: (request: HerdrRequest) => Promise<void>;
}

/** Same socket framing and retry budget as Herdr's bridge; failures never block Pi. */
function socketTransport(env: NodeJS.ProcessEnv): (request: HerdrRequest) => Promise<void> {
	const socketPath = env.HERDR_SOCKET_PATH!;
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const attempt = (request: HerdrRequest, timeoutMs: number) => new Promise<boolean>((resolve) => {
		let done = false;
		const socket = net.createConnection(endpoint);
		const finish = (delivered: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			socket.destroy();
			resolve(delivered);
		};
		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		const timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
	});
	return async (request) => {
		if (!(await attempt(request, 500))) await attempt(request, 1500);
	};
}

export function createHerdrAgentExtension(options: HerdrAgentOptions = {}) {
	return (pi: ExtensionAPI): void => {
		const env = options.env ?? process.env;
		if (env[HERDR_REPORTER_ENV] !== "1" || env.GENTLE_PI_AGENTS_CHILD === "1" || !herdrDetected(env)) return;
		const agent = herdrAgentLabel(env);
		const paneId = env.HERDR_PANE_ID!;
		const send = options.send ?? socketTransport(env);
		let seq = Date.now() * 1000;
		let sessionRef: Record<string, string> | undefined;
		let rootSession = false;
		let agentActive = false;
		let blockedCount = 0;
		let blockedMessage: string | undefined;
		let last: { state: AgentState; message?: string } | undefined;
		let queued: { state: AgentState; message?: string; seq: number } | undefined;
		let inFlight = false;
		const request = (method: string, params: Record<string, unknown>): HerdrRequest => ({
			id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method,
			params: { pane_id: paneId, source: SOURCE, agent, ...params, ...sessionRef },
		});

		// Prefer the session file, as Herdr's bridge does; fall back to the id.
		const updateSessionRef = (ctx: ExtensionContext) => {
			let file: unknown;
			let id: unknown;
			try { file = ctx.sessionManager?.getSessionFile?.(); } catch { file = undefined; }
			try { id = ctx.sessionManager?.getSessionId?.(); } catch { id = undefined; }
			sessionRef = typeof file === "string" && (posix.isAbsolute(file) || win32.isAbsolute(file))
				? { agent_session_path: file }
				: typeof id === "string" && id.length > 0 ? { agent_session_id: id } : undefined;
		};
		const reportSession = (sessionStartSource?: string) => sessionRef
			? send(request("pane.report_agent_session", { seq: ++seq, session_start_source: sessionStartSource })).catch(() => {})
			: Promise.resolve();
		// One report in flight, only the latest state queued behind it.
		const drain = async () => {
			if (inFlight) return;
			inFlight = true;
			try {
				while (queued) {
					const next = queued;
					queued = undefined;
					await send(request("pane.report_agent", { state: next.state, message: next.message, seq: next.seq })).catch(() => {});
				}
			} finally {
				inFlight = false;
				if (queued) void drain();
			}
		};
		const publish = (force = false) => {
			const next = blockedCount > 0 ? { state: "blocked" as const, message: blockedMessage }
				: { state: agentActive ? "working" as const : "idle" as const, message: undefined };
			if (!force && next.state === last?.state && next.message === last?.message) return;
			last = next;
			queued = { ...next, seq: ++seq };
			void drain();
		};

		pi.events.on("herdr:blocked", (data: unknown) => {
			if (!rootSession) return;
			const event = data as { active?: boolean; label?: string } | undefined;
			if (!event?.active) {
				blockedCount = Math.max(0, blockedCount - 1);
				if (blockedCount === 0) blockedMessage = undefined;
			} else {
				blockedCount += 1;
				blockedMessage = event.label;
			}
			publish();
		});
		pi.on("session_start", async (event, ctx) => {
			// TUI only: RPC still reports hasUI, so mode is the reliable gate.
			if (ctx.mode !== "tui") return;
			rootSession = true;
			updateSessionRef(ctx);
			await reportSession((event as { reason?: string } | undefined)?.reason);
			// A reload can replace this extension mid-run without another agent_start.
			agentActive = ctx.isIdle?.() === false;
			publish(true);
		});
		pi.on("agent_start", (_event, ctx) => {
			if (!rootSession) return;
			updateSessionRef(ctx);
			void reportSession();
			agentActive = true;
			publish();
		});
		pi.on("agent_settled", (_event, ctx) => {
			if (!rootSession || ctx.isIdle?.() !== true) return;
			agentActive = false;
			publish();
		});
	};
}

export default createHerdrAgentExtension();
