import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeJsonFileAtomicallySync } from "./agent-profiles.ts";
import { ADOPT_SLUG, ADOPT_TOKEN, ActiveSessionClient, ActiveSessionClientError, SessionPresenceRegistry, type AdoptRequest } from "./agents-session-transport.ts";
import { fleetRole } from "./fleet-role.ts";
import { discoverOrchestrators } from "./orchestrator-discovery.ts";
import { sanitizeDisplayLabel } from "./orchestrator-presence.ts";
import { WindowsActiveSessionClient, WindowsSessionPresenceRegistry } from "./windows-session-transport.ts";

// Fleet adoption (odd/tasks/fleet-orchestrator.md S8, L59-L60). The human picks
// a running interactive Gentle Shell session in the fleet TUI; the fleet sends
// it an adopt request over the session transport. The target answers at once,
// finishes its current turn, writes a hand-off and shuts itself down; the
// fleet respawns it headless on the same session file only once the hand-off
// exists and the target process has exited, so one file never has two writers.
//
// The request carries only an opaque token: the target derives the hand-off
// path under its own agent home, so a peer can never choose where it writes.
// The hand-off goes through three states: accepted (with the target's pid,
// before the ack), refused (with a reason), ready (after the turn).

export const ADOPT_POLL_MS = 500;
export const ADOPT_TURN_TIMEOUT_MS = 30 * 60_000;
export const ADOPT_EXIT_TIMEOUT_MS = 30_000;
const DIR_MODE = 0o700;
const MEMBER_NAME_MAX = 32;
const REASON_MAX = 300;

export type AdoptHandoff =
	| { state: "accepted"; pid: number; label: string }
	| { state: "refused"; reason: string }
	| { state: "ready"; pid: number; label: string; sessionFile: string; sessionDir: string; cwd: string };
export type ReadyHandoff = Extract<AdoptHandoff, { state: "ready" }>;

const sameUser = (uid: number) => typeof process.getuid !== "function" || uid === process.getuid();

/** `<agentHome>/gentle-fleet/adopt/<token>.json`, or undefined for a token outside the strict pattern. */
export function adoptHandoffPath(agentHome: string, token: string): string | undefined {
	return typeof token === "string" && ADOPT_TOKEN.test(token) ? join(agentHome, "gentle-fleet", "adopt", `${token}.json`) : undefined;
}

// Each level is created owner-only when missing and must be a real directory
// of this user: a symlink anywhere below the agent home is refused.
function handoffDirectory(agentHome: string, create: boolean): boolean {
	for (const path of [join(agentHome, "gentle-fleet"), join(agentHome, "gentle-fleet", "adopt")]) {
		if (create && !existsSync(path)) {
			try { mkdirSync(path, { mode: DIR_MODE }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; }
		}
		let stat;
		try { stat = lstatSync(path); } catch { return false; }
		if (stat.isSymbolicLink() || !stat.isDirectory() || !sameUser(stat.uid)) return false;
	}
	return true;
}

/** False when the token is invalid or the path is unsafe; nothing is written then. */
export function writeAdoptHandoff(agentHome: string, token: string, handoff: AdoptHandoff): boolean {
	const path = adoptHandoffPath(agentHome, token);
	if (!path || !handoffDirectory(agentHome, true)) return false;
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile() || !sameUser(stat.uid)) return false;
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
	try { writeJsonFileAtomicallySync(path, `${JSON.stringify(handoff)}\n`); return true; } catch { return false; }
}

const positivePid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isText = (value: unknown): value is string => typeof value === "string";

export function readAdoptHandoff(agentHome: string, token: string): AdoptHandoff | undefined {
	const path = adoptHandoffPath(agentHome, token);
	if (!path || !handoffDirectory(agentHome, false)) return undefined;
	let value: Record<string, unknown>;
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile() || !sameUser(stat.uid)) return undefined;
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch { return undefined; }
	if (!value || typeof value !== "object") return undefined;
	if (value.state === "refused" && isText(value.reason)) return { state: "refused", reason: value.reason };
	if (value.state === "accepted" && positivePid(value.pid) && isText(value.label)) return { state: "accepted", pid: value.pid, label: value.label };
	if (value.state === "ready" && positivePid(value.pid) && isText(value.label) && isText(value.sessionFile) && isAbsolute(value.sessionFile)
		&& isText(value.sessionDir) && isText(value.cwd) && isAbsolute(value.cwd)) {
		return { state: "ready", pid: value.pid, label: value.label, sessionFile: value.sessionFile, sessionDir: value.sessionDir, cwd: value.cwd };
	}
	return undefined;
}

/** Why this session cannot become a fleet member, or undefined when it can. */
export function adoptRefusal(session: { mode: string; hasUI: boolean; env: Record<string, string | undefined>; sessionFile?: string }): string | undefined {
	if (session.env.GENTLE_PI_AGENTS_CHILD === "1") return "this is a subagent session";
	const role = fleetRole(session.env);
	if (role) return `this session is a fleet ${role}`;
	if (session.mode !== "tui" || !session.hasUI) return `this is not an interactive terminal session (${session.mode} mode)`;
	if (!session.sessionFile) return "this is an ephemeral session without a session file";
	if (!existsSync(session.sessionFile)) return "this session has no saved conversation yet";
	return undefined;
}

type TargetContext = Pick<ExtensionContext, "mode" | "hasUI" | "isIdle" | "shutdown"> & {
	ui: Pick<ExtensionContext["ui"], "notify">;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getSessionDir" | "getCwd"> & { getSessionName?(): string | undefined };
};

export interface AdoptionTargetOptions {
	agentHome: string;
	env: Record<string, string | undefined>;
	schedule(fn: () => void, ms: number): () => void;
	pid?: number;
	pollMs?: number;
}

/**
 * The adopted side, in the target's gentle-agents. accept() answers within the
 * transport's callback deadline; the hand-off and shutdown wait for idle, so
 * the current turn always finishes and is never aborted.
 */
export class AdoptionTarget {
	private readonly options: AdoptionTargetOptions;
	private pending: { token: string; ctx: TargetContext; label: string; cancelTimer?: () => void } | undefined;

	constructor(options: AdoptionTargetOptions) {
		this.options = options;
	}

	accept(request: AdoptRequest, ctx: TargetContext | undefined): boolean {
		if (!ADOPT_TOKEN.test(request.token) || !ADOPT_SLUG.test(request.fleetSlug)) return false;
		const refuse = (reason: string) => { writeAdoptHandoff(this.options.agentHome, request.token, { state: "refused", reason }); return false; };
		if (!ctx) return refuse("this session is not ready");
		if (this.pending) return refuse("another fleet is adopting this session");
		let sessionFile: string | undefined, label: string;
		try {
			sessionFile = ctx.sessionManager.getSessionFile();
			label = sanitizeDisplayLabel(ctx.sessionManager.getSessionName?.() ?? "") || sanitizeDisplayLabel(ctx.sessionManager.getCwd().split(/[\\/]/).filter(Boolean).at(-1) ?? "") || "session";
		} catch { return refuse("this session is not ready"); }
		const reason = adoptRefusal({ mode: ctx.mode, hasUI: ctx.hasUI, env: this.options.env, sessionFile });
		if (reason) return refuse(reason);
		if (!writeAdoptHandoff(this.options.agentHome, request.token, { state: "accepted", pid: this.pid, label })) return false;
		this.pending = { token: request.token, ctx, label };
		try { ctx.ui.notify(`Adopted by fleet ${request.fleetSlug}: this window will close after the current turn`, "warning"); } catch { /* the notice is cosmetic */ }
		// Never synchronous: the acceptance ack goes out before any shutdown.
		this.arm();
		return true;
	}

	/** The session changed or closed first: the fleet reads why and spawns nothing. */
	cancel(reason: string): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		pending.cancelTimer?.();
		writeAdoptHandoff(this.options.agentHome, pending.token, { state: "refused", reason: reason.slice(0, REASON_MAX) });
	}

	private get pid(): number {
		return this.options.pid ?? process.pid;
	}

	private arm(): void {
		const pending = this.pending;
		if (!pending) return;
		pending.cancelTimer = this.options.schedule(() => this.check(pending), this.options.pollMs ?? ADOPT_POLL_MS);
	}

	private check(pending: NonNullable<AdoptionTarget["pending"]>): void {
		if (this.pending !== pending) return;
		pending.cancelTimer = undefined;
		let idle: boolean;
		try { idle = pending.ctx.isIdle(); } catch { this.cancel("the session closed before the hand-off"); return; }
		if (!idle) { this.arm(); return; }
		const manager = pending.ctx.sessionManager;
		let handoff: AdoptHandoff;
		try {
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) { this.cancel("the session lost its session file before the hand-off"); return; }
			handoff = { state: "ready", pid: this.pid, label: pending.label, sessionFile, sessionDir: manager.getSessionDir(), cwd: manager.getCwd() };
		} catch { this.cancel("the session closed before the hand-off"); return; }
		if (!writeAdoptHandoff(this.options.agentHome, pending.token, handoff)) {
			this.cancel("the hand-off could not be written");
			try { pending.ctx.ui.notify("Gentle Fleet adoption failed: the hand-off could not be written; this window stays open.", "error"); } catch { /* cosmetic */ }
			return;
		}
		// Finished: this session's own shutdown must not overwrite the hand-off.
		this.pending = undefined;
		pending.ctx.shutdown();
	}
}

/** True while a process with this pid exists (another user's process counts). */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const duration = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

export interface WatchAdoptionOptions {
	agentHome: string;
	token: string;
	/** The target's pid from its accepted hand-off. */
	pid: number;
	schedule(fn: () => void, ms: number): () => void;
	onReady(handoff: ReadyHandoff): void;
	onFailed(reason: string): void;
	alive?(pid: number): boolean;
	now?(): number;
	pollMs?: number;
	turnTimeoutMs?: number;
	exitTimeoutMs?: number;
}

/**
 * The fleet side: one bounded poll timer at a time until the hand-off is ready
 * and the target process is gone. Exactly one of onReady/onFailed runs, unless
 * the returned cancel runs first.
 */
export function watchAdoption(options: WatchAdoptionOptions): () => void {
	const alive = options.alive ?? isProcessAlive;
	const now = options.now ?? Date.now;
	const turnTimeout = options.turnTimeoutMs ?? ADOPT_TURN_TIMEOUT_MS;
	const exitTimeout = options.exitTimeoutMs ?? ADOPT_EXIT_TIMEOUT_MS;
	const started = now();
	let readyAt: number | undefined;
	let cancelTimer: (() => void) | undefined;
	let done = false;
	const finish = (outcome: () => void) => {
		done = true;
		cancelTimer = undefined;
		outcome();
	};
	const tick = () => {
		cancelTimer = undefined;
		if (done) return;
		const handoff = readAdoptHandoff(options.agentHome, options.token);
		if (handoff?.state === "refused") return finish(() => options.onFailed(handoff.reason));
		if (handoff?.state === "ready") {
			if (handoff.pid !== options.pid) return finish(() => options.onFailed("the hand-off names another process"));
			if (!alive(handoff.pid)) return finish(() => options.onReady(handoff));
			readyAt ??= now();
			if (now() - readyAt > exitTimeout) return finish(() => options.onFailed(`the session wrote its hand-off but did not exit within ${duration(exitTimeout)}`));
		} else if (!alive(options.pid)) {
			// It may have written the hand-off right before exiting.
			const last = readAdoptHandoff(options.agentHome, options.token);
			if (last?.state === "ready" && last.pid === options.pid) return finish(() => options.onReady(last));
			return finish(() => options.onFailed(last?.state === "refused" ? last.reason : "the session closed without a hand-off"));
		} else if (now() - started > turnTimeout) {
			return finish(() => options.onFailed(`the session did not finish its turn within ${duration(turnTimeout)}`));
		}
		cancelTimer = options.schedule(tick, options.pollMs ?? ADOPT_POLL_MS);
	};
	cancelTimer = options.schedule(tick, options.pollMs ?? ADOPT_POLL_MS);
	return () => {
		done = true;
		cancelTimer?.();
		cancelTimer = undefined;
	};
}

const MEMBER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A fleet member name from the session label, unique among `taken`. */
export function adoptedMemberName(label: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MEMBER_NAME_MAX - 3).replace(/-+$/, "");
	const root = MEMBER_NAME.test(base) ? base : "adopted";
	if (!used.has(root)) return root;
	for (let index = 2; ; index++) {
		const name = `${root}-${index}`;
		if (!used.has(name)) return name;
	}
}

export interface AdoptCandidate {
	sessionId: string;
	/** Display-only, sanitized; empty when the peer publishes none. */
	label: string;
	workspace: string;
}

/** The fleet's side of the session transport: who is open, and the adopt request itself. */
export interface AdoptTransport {
	candidates(fleetSessionId: string): Promise<AdoptCandidate[]>;
	/** True when the target accepted; false when it refused or does not know the request. */
	send(fleetSessionId: string, recipientSessionId: string, request: AdoptRequest): Promise<boolean>;
}

export function createAdoptTransport(agentHome: string, platform: NodeJS.Platform = process.platform): AdoptTransport {
	const open = () => platform === "win32" ? WindowsSessionPresenceRegistry.create(agentHome) : SessionPresenceRegistry.create(agentHome);
	const close = async (registry: SessionPresenceRegistry | WindowsSessionPresenceRegistry) => {
		if (registry instanceof WindowsSessionPresenceRegistry) await registry.close().catch(() => {});
	};
	return {
		async candidates(fleetSessionId) {
			const registry = await open();
			try {
				const activations = await registry.listActivations(fleetSessionId);
				return discoverOrchestrators(agentHome, activations).map(peer => ({ sessionId: peer.sessionId, label: peer.label ?? peer.legacyLabel ?? "", workspace: peer.workspace ?? "" }));
			} finally { await close(registry); }
		},
		async send(fleetSessionId, recipientSessionId, request) {
			const registry = await open();
			const client = registry instanceof WindowsSessionPresenceRegistry ? new WindowsActiveSessionClient(registry, fleetSessionId) : new ActiveSessionClient(registry, fleetSessionId);
			try {
				await client.sendAdopt(recipientSessionId, request);
				return true;
			} catch (error) {
				if (error instanceof ActiveSessionClientError && (error.code === "remote_rejected" || error.code === "invalid_ack")) return false;
				throw error;
			} finally {
				client.close();
				await close(registry);
			}
		},
	};
}
