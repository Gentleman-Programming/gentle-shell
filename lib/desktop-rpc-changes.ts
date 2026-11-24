// Gentle Desktop changes slice: the pure contract shared by the Desktop bridge
// (`lib/desktop-changes-service.ts`) and the owner seam inside
// `extensions/gentle-shell.ts`.
//
// Nothing here runs Git or reads a file. It names the wire shapes, projects
// the owner's `WorktreeChangesTracker` groups into the safe Desktop shape (an
// opaque root id and a display label, never an absolute path), bounds one
// file's diff text, and defines the strict param parsers. The owner (the same
// tracker `/gentle:changes` reads, and the shared `loadFileDiff` arguments in
// `lib/change-diff.ts`) stays the single source of truth.

import { DESKTOP_FEED_LIMITS } from "./desktop-feed.ts";
import { CHANGE_STATUS, type ChangeStatus, type GitResult, type WorktreeChanges } from "./shell-changes.ts";
import { fileDiffAnswered } from "./change-diff.ts";

export const DESKTOP_CHANGES_METHODS = ["get_changes", "get_change_diff"] as const;
/** Both methods are reads: nothing changes, so no event is advertised. */
export const DESKTOP_CHANGES_EVENTS = [] as const;

export const DESKTOP_CHANGES_SERVICE_SCHEMA = "gentle-pi.desktop-changes-service/v1";
export const DESKTOP_CHANGES_SERVICE_CHANNEL = "gentle:desktop:changes-service";

/** Same bound as the desktop feed's `changes` section. */
export const DESKTOP_CHANGES_FILE_LIMIT = DESKTOP_FEED_LIMITS.changes;
/** Upper bound on one `get_change_diff` answer's diff text, in UTF-8 bytes. */
export const DESKTOP_CHANGE_DIFF_MAX_BYTES = 256 * 1024;
/** Longest root id or path a request may name; anything longer cannot be in the set. */
export const DESKTOP_CHANGE_PATH_MAX = 4096;
/** Shown when a root's directory name cannot serve as a label. */
export const DESKTOP_CHANGE_ROOT_FALLBACK_LABEL = "repository";

export interface DesktopChangeRoot {
	id: string;
	label: string;
}

export interface DesktopChangedFile {
	root: string;
	path: string;
	status: ChangeStatus;
	added: number;
	deleted: number;
	/** The current count is not yet available; added may be zero or stale. */
	countsPending?: true;
}

export interface DesktopChangesRead {
	roots: DesktopChangeRoot[];
	files: DesktopChangedFile[];
	truncated: boolean;
	/** Some counts are still pending, including files beyond the list cap. */
	countsPending?: true;
}

export interface DesktopChangeDiff {
	root: string;
	path: string;
	diff: string;
	truncated: boolean;
}

/** An owner diff answer: the bounded text, a request outside the change set, or Git failing. */
export type DesktopChangeDiffOutcome =
	| { kind: "ok"; diff: string; truncated: boolean }
	| { kind: "not_found" }
	| { kind: "unavailable" };

/**
 * The owner-service adapter the bridge discovers. `read` answers `undefined`
 * when there is no tracked worktree or Git failed. Every method is defensive:
 * after `dispose()` it answers unavailable rather than speaking into a
 * replaced session.
 */
export interface DesktopChangesService {
	schema: typeof DESKTOP_CHANGES_SERVICE_SCHEMA;
	read(): Promise<DesktopChangesRead | undefined>;
	diff(root: string, path: string): Promise<DesktopChangeDiffOutcome>;
	dispose(): void;
}

export const INVALID_CHANGES_PARAMS = { code: "invalid_request", message: "Invalid changes parameters" } as const;
export const CHANGES_UNAVAILABLE = { code: "changes_unavailable", message: "Changes are unavailable for this session" } as const;
export const CHANGE_NOT_FOUND = { code: "not_found", message: "No changed file with that root and path in this session" } as const;

const STATUSES = new Set<string>(Object.values(CHANGE_STATUS));

/**
 * The label a root may show: its last directory name. Never the absolute
 * path; a filesystem root or a bare drive has no usable name and gets the
 * fixed fallback.
 */
export function desktopChangeRootLabel(root: string): string {
	const name = root.split(/[\\/]+/).filter((part) => part.length > 0).pop() ?? "";
	if (name.length === 0 || /^[A-Za-z]:$/.test(name) || /[\0\r\n]/.test(name)) return DESKTOP_CHANGE_ROOT_FALLBACK_LABEL;
	return name;
}

/**
 * A request path that could ever be in a change set: Git reports paths
 * relative to their root. Absolute paths (POSIX, drive, UNC), `..`
 * segments, and control characters can never match and are refused before
 * the owner is asked. This is defense in depth; the owner's exact match on
 * its own file list is the confinement.
 */
export function isPlausibleChangePath(path: string): boolean {
	if (path.length === 0 || path.length > DESKTOP_CHANGE_PATH_MAX) return false;
	if (/[\0-\x1f\x7f]/.test(path)) return false;
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
	return !path.split(/[\\/]/).some((part) => part === "..");
}

/**
 * The bounded `get_changes` projection: roots in the owner's group order,
 * files in path order within each root, capped at the feed's file limit
 * across all roots. `idFor` gives each root its opaque session-scoped id.
 */
export function projectDesktopChanges(worktrees: readonly WorktreeChanges[], idFor: (root: string) => string): DesktopChangesRead {
	const roots: DesktopChangeRoot[] = [];
	const files: DesktopChangedFile[] = [];
	let total = 0;
	let countsPending = false;
	for (const tree of worktrees) {
		const id = idFor(tree.root);
		roots.push({ id, label: desktopChangeRootLabel(tree.root) });
		for (const file of tree.model.files) {
			total += 1;
			const pending = Boolean(file.countsUnavailable);
			if (pending) countsPending = true;
			if (files.length >= DESKTOP_CHANGES_FILE_LIMIT) continue;
			files.push({ root: id, path: file.path, status: file.status, added: finite(file.added), deleted: finite(file.deleted), ...(pending ? { countsPending: true } : {}) });
		}
	}
	return { roots, files, truncated: total > DESKTOP_CHANGES_FILE_LIMIT, ...(countsPending ? { countsPending: true } : {}) };
}

function finite(value: number): number {
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Bound diff text to DESKTOP_CHANGE_DIFF_MAX_BYTES of UTF-8. A cut lands on
 * the last whole line inside the bound when there is one, and otherwise on a
 * character boundary, so the answer never ends in half a code point.
 */
export function capDesktopDiff(text: string, maxBytes = DESKTOP_CHANGE_DIFF_MAX_BYTES): { diff: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { diff: text, truncated: false };
	const window = bytes.subarray(0, maxBytes);
	const newline = window.lastIndexOf(0x0a);
	if (newline >= 0) return { diff: window.subarray(0, newline + 1).toString("utf8"), truncated: true };
	let end = maxBytes;
	// Step back over continuation bytes, then drop the incomplete lead byte.
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return { diff: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * The Desktop view of one Git diff answer, from the same run the panel reads:
 * the text capped at the Desktop bound, `truncated` when either the runner's
 * own bound or this one cut it. `undefined` when Git failed or timed out.
 */
export function projectDesktopDiff(result: GitResult): { diff: string; truncated: boolean } | undefined {
	if (result.timedOut) return undefined;
	if (!result.truncated && !fileDiffAnswered(result)) return undefined;
	const capped = capDesktopDiff(result.stdout);
	return { diff: capped.diff, truncated: capped.truncated || result.truncated === true };
}

/** `get_changes` params must be an empty object. */
export function parseGetChangesParams(params: Record<string, unknown>): { ok: true } | { error: { code: string; message: string } } {
	return Object.keys(params).length === 0 ? { ok: true } : { error: INVALID_CHANGES_PARAMS };
}

/**
 * `get_change_diff` params are exactly `{ root: string, path: string }`.
 * Any other shape is `invalid_request`; string values that name nothing in
 * the change set are the owner's `not_found`, never a different code.
 */
export function parseGetChangeDiffParams(params: Record<string, unknown>): { root: string; path: string } | { error: { code: string; message: string } } {
	const keys = Object.keys(params).sort();
	if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "root" || typeof params.root !== "string" || typeof params.path !== "string") {
		return { error: INVALID_CHANGES_PARAMS };
	}
	return { root: params.root, path: params.path };
}

/**
 * Defensive validation of the owner's `get_changes` answer. It crosses the
 * event bus, so it is rebuilt from the named fields only: a root label that
 * looks like an absolute path, a file whose root id is not listed, or an
 * implausible path makes the whole answer unusable.
 */
export function parseDesktopChangesRead(value: unknown): DesktopChangesRead | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.roots) || !Array.isArray(raw.files) || typeof raw.truncated !== "boolean") return undefined;
	if (raw.countsPending !== undefined && raw.countsPending !== true) return undefined;
	const roots: DesktopChangeRoot[] = [];
	for (const entry of raw.roots) {
		if (!entry || typeof entry !== "object") return undefined;
		const root = entry as Record<string, unknown>;
		if (typeof root.id !== "string" || root.id.length === 0 || root.id.length > DESKTOP_CHANGE_PATH_MAX) return undefined;
		if (typeof root.label !== "string" || desktopChangeRootLabel(root.label) !== root.label) return undefined;
		roots.push({ id: root.id, label: root.label });
	}
	const ids = new Set(roots.map((root) => root.id));
	if (raw.files.length > DESKTOP_CHANGES_FILE_LIMIT) return undefined;
	const files: DesktopChangedFile[] = [];
	for (const entry of raw.files) {
		if (!entry || typeof entry !== "object") return undefined;
		const file = entry as Record<string, unknown>;
		if (typeof file.root !== "string" || !ids.has(file.root)) return undefined;
		if (typeof file.path !== "string" || !isPlausibleChangePath(file.path)) return undefined;
		if (typeof file.status !== "string" || !STATUSES.has(file.status)) return undefined;
		if (!isCount(file.added) || !isCount(file.deleted)) return undefined;
		if (file.countsPending !== undefined && file.countsPending !== true) return undefined;
		files.push({ root: file.root, path: file.path, status: file.status as ChangeStatus, added: file.added, deleted: file.deleted, ...(file.countsPending === true ? { countsPending: true } : {}) });
	}
	return { roots, files, truncated: raw.truncated, ...(raw.countsPending === true ? { countsPending: true } : {}) };
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopChangesServiceShape(value: unknown): value is DesktopChangesService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopChangesService>;
	if (adapter.schema !== DESKTOP_CHANGES_SERVICE_SCHEMA) return false;
	return [adapter.read, adapter.diff, adapter.dispose].every((fn) => typeof fn === "function");
}
