// Gentle Desktop sessions bridge: lists sessions and switches by id through
// the owner Pi already provides in-process. `SessionManager.list`, `listAll`,
// and `findById` read and resolve sessions with the runtime's own session
// directory (custom `sessionDir` included, read from the live session
// manager), and the bound command context's `switchSession` performs the
// switch. There is no second scanner, index, or cache here; the shapes are
// defined by `lib/desktop-rpc-sessions.ts`.

import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	desktopSessionsResponseLine,
	pageDesktopSessions,
	parseListSessionsParams,
	parseSwitchSessionParams,
	SESSION_NOT_FOUND,
	SESSION_SWITCH_FAILED,
	SESSIONS_UNAVAILABLE,
	type DesktopListSessionsParams,
	type DesktopSessionInfoLike,
	type DesktopSessionsScope,
	type DesktopSwitchSessionParams,
} from "./desktop-rpc-sessions.ts";
import { DESKTOP_RPC_WIDGET, type DesktopRpcOutcome } from "./desktop-rpc.ts";

/** The part of Pi's static `SessionManager` this slice calls. */
export interface DesktopSessionsOwner {
	list(cwd: string, sessionDir?: string): Promise<readonly DesktopSessionInfoLike[]>;
	listAll(sessionDir?: string): Promise<readonly DesktopSessionInfoLike[]>;
	findById(cwd: string, id: string, sessionDir?: string): string | undefined;
}

/** True only when the installed Pi exposes every owner call this slice needs. */
export function isDesktopSessionsOwnerShape(value: unknown): value is DesktopSessionsOwner {
	if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
	const owner = value as Partial<DesktopSessionsOwner>;
	return [owner.list, owner.listAll, owner.findById].every((fn) => typeof fn === "function");
}

/** Where the live runtime keeps sessions, read from its own session manager. */
interface SessionLocation {
	cwd: string;
	sessionDir: string;
	/** `undefined` when the installed Pi cannot say whether the directory is the default one. */
	usesDefault: boolean | undefined;
	currentId: string;
}

type CommandHost = Pick<ExtensionCommandContext, "cwd" | "sessionManager"> & Partial<Pick<ExtensionCommandContext, "switchSession">>;

interface DesktopSessionsBridgeOptions {
	owner?: unknown;
}

function location(host: CommandHost): SessionLocation | undefined {
	// `usesDefaultSessionDir` is on Pi's live session manager but not on the
	// read-only type extensions receive; read every getter defensively.
	const manager = host.sessionManager as unknown as Record<string, unknown> | undefined;
	if (!manager || typeof manager !== "object") return undefined;
	const call = (name: string): unknown => {
		const fn = manager[name];
		if (typeof fn !== "function") return undefined;
		return fn.call(manager);
	};
	try {
		const cwd = call("getCwd") ?? host.cwd;
		const sessionDir = call("getSessionDir");
		const currentId = call("getSessionId");
		const usesDefault = call("usesDefaultSessionDir");
		if (typeof cwd !== "string" || cwd.length === 0) return undefined;
		if (typeof sessionDir !== "string" || sessionDir.length === 0) return undefined;
		return {
			cwd,
			sessionDir,
			usesDefault: typeof usesDefault === "boolean" ? usesDefault : undefined,
			currentId: typeof currentId === "string" ? currentId : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * The Desktop domain slice for `list_sessions` and `switch_session`. It is
 * session-scoped: a reset (session replacement or shutdown) unbinds the
 * command context and drops late outcomes.
 */
export class DesktopSessionsBridge {
	private readonly owner: unknown;
	private host: CommandHost | undefined;
	private generation = 0;
	/** The switch dispatched and not yet settled; at most one per session. */
	private inFlight: { requestId: string | null } | undefined;

	constructor(options: DesktopSessionsBridgeOptions = {}) {
		this.owner = "owner" in options ? options.owner : SessionManager;
	}

	/** The command context of this Desktop session; bound per `/gentle:desktop` command. */
	attach(context: CommandHost): void {
		this.host = context;
	}

	/** Session start/shutdown: the previous session's command context is stale. */
	reset(): void {
		this.generation += 1;
		this.host = undefined;
		this.inFlight = undefined;
	}

	/**
	 * The switch currently in flight, from its dispatch until it settles or the
	 * session is torn down. While it is set, the extension refuses every other
	 * Desktop request with `session_switching` so none can be lost in the
	 * teardown.
	 */
	switchInFlight(): { requestId: string | null } | undefined {
		return this.inFlight;
	}

	/**
	 * `undefined` for methods this slice does not own, so the extension can
	 * fall through to the next domain. `requestId` correlates the response a
	 * successful switch publishes from the replacement session.
	 */
	handle(method: string, params: Record<string, unknown>, requestId: string | null): Promise<DesktopRpcOutcome> | undefined {
		if (method === "list_sessions") return this.list(params);
		if (method === "switch_session") return this.switch(params, requestId);
		return undefined;
	}

	/** Parse before any owner work, then read the bound host's session location. */
	private prepare<T>(parse: () => T | { error: { code: string; message: string } }): { parsed: T; host: CommandHost; where: SessionLocation; owner: DesktopSessionsOwner } | { outcome: DesktopRpcOutcome } {
		const host = this.host;
		if (!host) return { outcome: { ok: false, error: SESSIONS_UNAVAILABLE } };
		const parsed = parse();
		if (parsed && typeof parsed === "object" && "error" in parsed) return { outcome: { ok: false, error: parsed.error } };
		const owner = this.owner;
		const where = location(host);
		if (!isDesktopSessionsOwnerShape(owner) || !where) return { outcome: { ok: false, error: SESSIONS_UNAVAILABLE } };
		return { parsed: parsed as T, host, where, owner };
	}

	/**
	 * The same calls Pi's own `/resume` selector makes: the current project is
	 * `list(cwd, sessionDir)`, and all projects is `listAll()` for the default
	 * directory or `listAll(sessionDir)` for a custom one.
	 */
	private read(owner: DesktopSessionsOwner, where: SessionLocation, scope: DesktopSessionsScope): Promise<readonly DesktopSessionInfoLike[]> | undefined {
		if (scope === "project") return owner.list(where.cwd, where.sessionDir);
		if (where.usesDefault === undefined) return undefined;
		return where.usesDefault ? owner.listAll() : owner.listAll(where.sessionDir);
	}

	private async list(params: Record<string, unknown>): Promise<DesktopRpcOutcome> {
		const prepared = this.prepare<DesktopListSessionsParams>(() => parseListSessionsParams(params));
		if ("outcome" in prepared) return prepared.outcome;
		const { parsed, where, owner } = prepared;
		const generation = this.generation;
		let infos: readonly DesktopSessionInfoLike[];
		try {
			const pending = this.read(owner, where, parsed.scope);
			if (!pending) return { ok: false, error: SESSIONS_UNAVAILABLE };
			infos = await pending;
		} catch {
			// Owner failures can carry session paths; none of it crosses the contract.
			return { ok: false, error: SESSIONS_UNAVAILABLE };
		}
		if (generation !== this.generation || !Array.isArray(infos)) return { ok: false, error: SESSIONS_UNAVAILABLE };
		return { ok: true, data: pageDesktopSessions(infos, where.currentId, parsed) as unknown as Record<string, unknown> };
	}

	/** `findById` for the project; for all projects, the exact id in Pi's all-sessions listing. */
	private async resolve(owner: DesktopSessionsOwner, where: SessionLocation, parsed: DesktopSwitchSessionParams): Promise<string | undefined | null> {
		const local = owner.findById(where.cwd, parsed.id, where.sessionDir);
		if (typeof local === "string" && local.length > 0) return local;
		if (parsed.scope === "project") return undefined;
		const pending = this.read(owner, where, "all");
		if (!pending) return null;
		const match = (await pending).find((info) => info && info.id === parsed.id) as { path?: unknown } | undefined;
		return typeof match?.path === "string" && match.path.length > 0 ? match.path : undefined;
	}

	private async switch(params: Record<string, unknown>, requestId: string | null): Promise<DesktopRpcOutcome> {
		const prepared = this.prepare<DesktopSwitchSessionParams>(() => parseSwitchSessionParams(params));
		if ("outcome" in prepared) return prepared.outcome;
		const { parsed, host, where, owner } = prepared;
		// Switching to the active session changes nothing and asks Pi for nothing.
		if (parsed.id === where.currentId) return { ok: true, data: { id: parsed.id, changed: false } };
		const switchSession = host.switchSession;
		if (typeof switchSession !== "function") return { ok: false, error: SESSIONS_UNAVAILABLE };
		// Marked synchronously at dispatch, before any await, so a request the
		// RPC loop dispatches right after this one is already refused.
		const token = { requestId };
		this.inFlight = token;
		try {
			return await this.performSwitch(switchSession, host, where, owner, parsed, requestId);
		} finally {
			if (this.inFlight === token) this.inFlight = undefined;
		}
	}

	private async performSwitch(
		switchSession: NonNullable<CommandHost["switchSession"]>,
		host: CommandHost,
		where: SessionLocation,
		owner: DesktopSessionsOwner,
		parsed: DesktopSwitchSessionParams,
		requestId: string | null,
	): Promise<DesktopRpcOutcome> {
		const generation = this.generation;
		let sessionPath: string | undefined | null;
		try {
			sessionPath = await this.resolve(owner, where, parsed);
		} catch {
			return { ok: false, error: SESSIONS_UNAVAILABLE };
		}
		if (generation !== this.generation || sessionPath === null) return { ok: false, error: SESSIONS_UNAVAILABLE };
		if (sessionPath === undefined) return { ok: false, error: SESSION_NOT_FOUND };

		const data = { id: parsed.id, changed: true };
		let result: { cancelled?: unknown } | undefined;
		try {
			result = await switchSession.call(host, sessionPath, {
				// Pi tears this session down (`session_shutdown` stops this router),
				// starts the replacement (whose router starts at sequence 0), and
				// only then runs this callback with a context bound to the new
				// session. The old router can no longer answer, so the response is
				// published here, correlated by the original requestId.
				withSession: async (next) => {
					if (generation === this.generation || requestId === null) return;
					try {
						next.ui.setWidget(DESKTOP_RPC_WIDGET, [desktopSessionsResponseLine(requestId, data)]);
					} catch {
						/* transport failures are never retried as a second response */
					}
				},
			});
		} catch {
			// Pi refused the switch (for example the session's working directory is
			// gone). Its error names paths; only a fixed message crosses.
			return { ok: false, error: SESSION_SWITCH_FAILED };
		}
		if (result && result.cancelled === true) return { ok: true, data: { id: parsed.id, changed: false, cancelled: true } };
		// After a real replacement the router that would publish this outcome was
		// stopped with the old session, so it is dropped; the replacement context
		// already answered. If no replacement happened, the router answers here.
		return { ok: true, data };
	}
}
