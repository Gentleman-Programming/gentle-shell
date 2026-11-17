// Gentle Desktop sessions slice: the pure contract shared by the Desktop
// bridge (`lib/desktop-sessions-service.ts`) and its tests.
//
// Nothing here reads a session file or switches a session. It only names the
// wire shapes, validates params, projects Pi's own `SessionInfo` into the safe
// Desktop entry, and pages the owner's list. The owner is Pi itself: its
// `SessionManager.list`/`listAll`/`findById` resolve and read sessions, and the
// command context's `switchSession` performs the switch. This module is a
// projection, not a second session scanner or index.

import { DESKTOP_RPC_SCHEMA } from "./desktop-rpc.ts";

export const DESKTOP_SESSIONS_METHODS = ["list_sessions", "switch_session"] as const;
/** The slice emits no event: a switch replaces the session, and the new router starts its own sequence. */
export const DESKTOP_SESSIONS_EVENTS = [] as const;

export const DESKTOP_SESSIONS_DEFAULT_LIMIT = 20;
export const DESKTOP_SESSIONS_MAX_LIMIT = 50;
export const DESKTOP_SESSIONS_FIRST_MESSAGE_MAX = 200;
export const DESKTOP_SESSIONS_NAME_MAX = 200;
const MAX_ID_LENGTH = 256;
const MAX_CURSOR_LENGTH = 512;
const UNKNOWN_PROJECT = "unknown";

export type DesktopSessionsScope = "project" | "all";

/**
 * The safe wire window for one session. Only these fields exist on the wire:
 * Pi's session id, the user-given name, the last-activity time, the message
 * count, a bounded first user message, the project's display name, and
 * whether it is the active session. Never a file path, a cwd, a parent
 * session path, or the full message text.
 */
export interface DesktopSessionEntry {
	id: string;
	name?: string;
	modified: number;
	messageCount?: number;
	firstMessage: string;
	project: string;
	current: boolean;
}

/** The subset of Pi's `SessionInfo` this slice reads. Everything else is ignored. */
export interface DesktopSessionInfoLike {
	id: unknown;
	cwd?: unknown;
	name?: unknown;
	modified?: unknown;
	messageCount?: unknown;
	firstMessage?: unknown;
}

export interface DesktopListSessionsParams {
	scope: DesktopSessionsScope;
	limit: number;
	cursor?: DesktopSessionsCursor;
}

export interface DesktopSwitchSessionParams {
	id: string;
	scope: DesktopSessionsScope;
}

/** Keyset position: the last entry of the previous page in newest-first order. */
export interface DesktopSessionsCursor {
	modified: number;
	id: string;
}

type ParamError = { error: { code: string; message: string } };

export const INVALID_SESSIONS_PARAMS = { code: "invalid_request", message: "Invalid sessions parameters" } as const;
export const SESSIONS_UNAVAILABLE = { code: "sessions_unavailable", message: "Sessions owner unavailable for this session" } as const;
export const SESSION_SWITCH_FAILED = { code: "sessions_unavailable", message: "The session could not be opened" } as const;
/** Every request that arrives while a switch is in flight; retry after the switch answers. */
export const SESSION_SWITCHING = { code: "session_switching", message: "A session switch is in progress; retry after it answers" } as const;
export const SESSION_NOT_FOUND ={ code: "not_found", message: "No session with that id in the requested scope" } as const;

function isScope(value: unknown): value is DesktopSessionsScope {
	return value === "project" || value === "all";
}

/** Bound display text by UTF-16 length without splitting a surrogate pair; a cut is marked with an ellipsis. */
export function boundDisplayText(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	let cut = collapsed.slice(0, max - 1);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return `${cut.trimEnd()}…`;
}

/** The project's display name: the last segment of the session's cwd, never the path itself. */
export function sessionProjectName(cwd: unknown): string {
	if (typeof cwd !== "string") return UNKNOWN_PROJECT;
	const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
	const last = segments[segments.length - 1];
	// A bare drive root such as `C:` names no project.
	if (last === undefined || /^[A-Za-z]:$/.test(last)) return UNKNOWN_PROJECT;
	return last;
}

function modifiedMs(value: unknown): number | undefined {
	const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : NaN;
	return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * The whitelisted projection of one owner `SessionInfo`. Every field is rebuilt
 * from the named members only, so `path`, `cwd`, `parentSessionPath`, and
 * `allMessagesText` can never reach the Desktop payload. An entry without a
 * usable id or time is dropped rather than projected into a malformed one.
 */
export function projectDesktopSession(info: DesktopSessionInfoLike, currentId: string): DesktopSessionEntry | undefined {
	if (!info || typeof info !== "object") return undefined;
	if (typeof info.id !== "string" || info.id.length === 0 || info.id.length > MAX_ID_LENGTH) return undefined;
	const modified = modifiedMs(info.modified);
	if (modified === undefined) return undefined;
	const name = typeof info.name === "string" && info.name.trim().length > 0 ? boundDisplayText(info.name, DESKTOP_SESSIONS_NAME_MAX) : undefined;
	const messageCount = typeof info.messageCount === "number" && Number.isInteger(info.messageCount) && info.messageCount >= 0 ? info.messageCount : undefined;
	// Fixed key order keeps responses byte-stable for clients that diff them.
	return {
		id: info.id,
		...(name !== undefined ? { name } : {}),
		modified,
		...(messageCount !== undefined ? { messageCount } : {}),
		firstMessage: typeof info.firstMessage === "string" ? boundDisplayText(info.firstMessage, DESKTOP_SESSIONS_FIRST_MESSAGE_MAX) : "",
		project: sessionProjectName(info.cwd),
		current: info.id === currentId,
	};
}

/** Newest first; equal times fall back to id order so the keyset cursor is total. */
function compareEntries(left: DesktopSessionEntry, right: DesktopSessionEntry): number {
	if (left.modified !== right.modified) return right.modified - left.modified;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isAfterCursor(entry: DesktopSessionEntry, cursor: DesktopSessionsCursor): boolean {
	return compareEntries(entry, { ...entry, modified: cursor.modified, id: cursor.id }) > 0;
}

export function encodeSessionsCursor(cursor: DesktopSessionsCursor): string {
	return Buffer.from(JSON.stringify([cursor.modified, cursor.id]), "utf8").toString("base64url");
}

export function decodeSessionsCursor(value: string): DesktopSessionsCursor | undefined {
	if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
		const [modified, id] = parsed;
		if (typeof modified !== "number" || !Number.isFinite(modified) || modified < 0) return undefined;
		if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return undefined;
		return { modified, id };
	} catch {
		return undefined;
	}
}

/**
 * One bounded page of the owner's list, newest first. The cursor is a keyset
 * position (last time + id), so sessions created between pages never shift or
 * repeat entries the client already has.
 */
export function pageDesktopSessions(
	infos: readonly DesktopSessionInfoLike[],
	currentId: string,
	params: DesktopListSessionsParams,
): { sessions: DesktopSessionEntry[]; nextCursor?: string } {
	const cursor = params.cursor;
	const entries = infos
		.map((info) => projectDesktopSession(info, currentId))
		.filter((entry): entry is DesktopSessionEntry => entry !== undefined)
		.sort(compareEntries)
		.filter((entry) => cursor === undefined || isAfterCursor(entry, cursor));
	const sessions = entries.slice(0, params.limit);
	const last = sessions[sessions.length - 1];
	if (entries.length > params.limit && last) {
		return { sessions, nextCursor: encodeSessionsCursor({ modified: last.modified, id: last.id }) };
	}
	return { sessions };
}

/**
 * `list_sessions` params: optional `scope` (`project` | `all`, default
 * `project`), optional integer `limit` 1–50 (default 20), and an optional
 * opaque `cursor`. Any other key or value is a typed `invalid_request` before
 * any owner work happens.
 */
export function parseListSessionsParams(params: Record<string, unknown>): DesktopListSessionsParams | ParamError {
	for (const key of Object.keys(params)) {
		if (key !== "scope" && key !== "limit" && key !== "cursor") return { error: INVALID_SESSIONS_PARAMS };
	}
	if (params.scope !== undefined && !isScope(params.scope)) return { error: INVALID_SESSIONS_PARAMS };
	const limit = params.limit ?? DESKTOP_SESSIONS_DEFAULT_LIMIT;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > DESKTOP_SESSIONS_MAX_LIMIT) {
		return { error: INVALID_SESSIONS_PARAMS };
	}
	const parsed: DesktopListSessionsParams = { scope: (params.scope as DesktopSessionsScope | undefined) ?? "project", limit };
	if (params.cursor !== undefined) {
		if (typeof params.cursor !== "string") return { error: INVALID_SESSIONS_PARAMS };
		const cursor = decodeSessionsCursor(params.cursor);
		if (!cursor) return { error: INVALID_SESSIONS_PARAMS };
		parsed.cursor = cursor;
	}
	return parsed;
}

/**
 * `switch_session` params: a non-empty `id` plus an optional `scope` naming
 * where the id is resolved (default `project`, the same scope `list_sessions`
 * defaults to). A path-shaped request (`sessionPath`) or any other key is a
 * typed `invalid_request`.
 */
export function parseSwitchSessionParams(params: Record<string, unknown>): DesktopSwitchSessionParams | ParamError {
	for (const key of Object.keys(params)) {
		if (key !== "id" && key !== "scope") return { error: INVALID_SESSIONS_PARAMS };
	}
	if (typeof params.id !== "string" || params.id.length === 0 || params.id.length > MAX_ID_LENGTH) return { error: INVALID_SESSIONS_PARAMS };
	if (params.scope !== undefined && !isScope(params.scope)) return { error: INVALID_SESSIONS_PARAMS };
	return { id: params.id, scope: (params.scope as DesktopSessionsScope | undefined) ?? "project" };
}

/**
 * A success response line in the router's exact shape. A switch replaces the
 * session, which stops the old router before Pi returns; the replacement
 * context publishes this line instead, correlated by the original requestId.
 */
export function desktopSessionsResponseLine(requestId: string, data: Record<string, unknown>): string {
	return JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, kind: "response", requestId, ok: true, data });
}

/** A failure response line in the router's exact shape, for an instance whose router a switch already stopped. */
export function desktopSessionsErrorLine(requestId: string | null, error: { code: string; message: string }): string {
	return JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, kind: "response", requestId, ok: false, error: { code: error.code, message: error.message } });
}

/** The correlation id of a raw `/gentle:desktop` request, or `null` when it has none. */
export function desktopRequestId(raw: string): string | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const requestId = (value as Record<string, unknown>).requestId;
		return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128 ? requestId : null;
	} catch {
		return null;
	}
}
