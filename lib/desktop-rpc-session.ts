// Gentle Desktop session-state slice (#3319): the pure contract shared by the
// Desktop bridge (`lib/desktop-session-service.ts`) and the owner seam inside
// `extensions/gentle-desktop-feed.ts`.
//
// The feed extension already computes the whole session projection the TUI
// sidebar and the Herdr feed show (`buildDesktopFeedSnapshot`). This module
// keeps no second copy of that state: it names the sections `get_snapshot`
// may carry, parses the request strictly, and turns one feed snapshot into the
// wire-safe sections — no identity block, no process data, no absolute path.

import { createHash } from "node:crypto";
import type { DesktopFeedSnapshot } from "./desktop-feed.ts";

export const DESKTOP_SESSION_EVENT = "session_snapshot";
/** Advertised only while the feed owner seam is wired for the session. */
export const DESKTOP_SESSION_EVENTS = [DESKTOP_SESSION_EVENT] as const;

// The versioned owner-service discovery seam (the session analogue of
// `gentle:desktop:jobs-service`). The schema string guards the adapter against
// drift; the bridge ignores any responder whose shape does not match.
export const DESKTOP_SESSION_SERVICE_SCHEMA = "gentle-pi.desktop-session-service/v1";
export const DESKTOP_SESSION_SERVICE_CHANNEL = "gentle:desktop:session-service";

/** The feed sections a client may request, in their canonical wire order. */
export const DESKTOP_SESSION_SECTIONS = [
	"project",
	"model",
	"context",
	"cost",
	"usage",
	"profiles",
	"permission",
	"todo",
	"changes",
	"agents",
	"jobs",
	"review",
	"stats",
	"activity",
	"pendingQuestion",
	"commands",
] as const;

export type DesktopSessionSection = typeof DESKTOP_SESSION_SECTIONS[number];
export type DesktopSessionSections = Partial<Record<DesktopSessionSection, unknown>>;

/**
 * The owner-service adapter the bridge discovers. `read` builds the bound
 * session's live feed snapshot (undefined when that session is not live);
 * `observe` reports each snapshot the feed publishes on its own tiers.
 */
export interface DesktopSessionService {
	schema: typeof DESKTOP_SESSION_SERVICE_SCHEMA;
	read(): DesktopFeedSnapshot | undefined;
	observe(onSnapshot: (snapshot: DesktopFeedSnapshot) => void): () => void;
	dispose(): void;
}

export const INVALID_SESSION_PARAMS = { code: "invalid_request", message: "Invalid session snapshot sections" } as const;
export const SESSION_UNAVAILABLE = { code: "session_unavailable", message: "Session state owner unavailable for this session" } as const;

const KNOWN = new Set<string>(DESKTOP_SESSION_SECTIONS);

/**
 * `get_snapshot` params. Without a `sections` key the request is the legacy
 * read, byte-for-byte (its params were never inspected). With one, the params
 * are exactly `{ sections: [unique known names, at least one] }`.
 */
export function parseSessionSnapshotParams(params: Record<string, unknown>):
	| { legacy: true }
	| { sections: DesktopSessionSection[] }
	| { error: { code: string; message: string } } {
	if (!Object.hasOwn(params, "sections")) return { legacy: true };
	const keys = Object.keys(params);
	const sections = params.sections;
	if (keys.length !== 1 || !Array.isArray(sections) || sections.length === 0 || sections.length > DESKTOP_SESSION_SECTIONS.length) {
		return { error: INVALID_SESSION_PARAMS };
	}
	const seen = new Set<string>();
	for (const name of sections) {
		if (typeof name !== "string" || !KNOWN.has(name) || seen.has(name)) return { error: INVALID_SESSION_PARAMS };
		seen.add(name);
	}
	return { sections: sections as DesktopSessionSection[] };
}

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopSessionServiceShape(value: unknown): value is DesktopSessionService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopSessionService>;
	if (adapter.schema !== DESKTOP_SESSION_SERVICE_SCHEMA) return false;
	return [adapter.read, adapter.observe, adapter.dispose].every((fn) => typeof fn === "function");
}

/** An opaque, stable label for a worktree root: never the path itself. */
export function desktopSessionRootLabel(root: string): string {
	return `root-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

/** A drive-qualified or rooted path (POSIX `/`, Windows `C:`, `\`, or UNC `\\`). */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:|[\\/])/;
/** A bare drive designator: `C:` once trailing separators are gone. */
const DRIVE_ONLY = /^[a-zA-Z]:$/;

/** The last path segment, whichever separator the platform used. */
function baseName(path: string): string {
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

function projectSection(project: DesktopFeedSnapshot["project"]) {
	const name = baseName(project.cwd);
	// A filesystem root (`/`) or a drive root (`C:\`) names no project.
	return { name: name.length > 0 && !DRIVE_ONLY.test(name) ? name : null, branch: project.branch, dirty: project.dirty };
}

/**
 * A worktree root normalized for prefix matching, or undefined for a root
 * that would relativize everything (`/`, a bare drive). Windows-style roots
 * (a drive letter or a backslash) compare case-insensitively, as the
 * filesystem does; POSIX roots stay case-sensitive.
 */
function matchableRoot(root: string): { prefix: string; fold: boolean } | undefined {
	const trimmed = root.replaceAll("\\", "/").replace(/\/+$/, "");
	if (trimmed.length === 0 || DRIVE_ONLY.test(trimmed)) return undefined;
	const fold = /^[a-zA-Z]:/.test(root) || root.includes("\\");
	return { prefix: `${fold ? trimmed.toLowerCase() : trimmed}/`, fold };
}

/**
 * Changes without a path: each worktree root becomes its opaque label, and
 * each file path is made relative to the worktree that holds it (several
 * worktrees prefix the combined model's paths with their absolute root). A
 * path no worktree holds keeps only its file name. A root of `/` or a bare
 * drive gets no label and holds no file, so it never relativizes every path.
 */
function changesSection(changes: DesktopFeedSnapshot["changes"]) {
	if (!changes) return null;
	const label = (root: string) => (matchableRoot(root) ? desktopSessionRootLabel(root) : null);
	const roots = changes.worktrees
		.flatMap((tree) => {
			const match = matchableRoot(tree.root);
			return match ? [{ ...match, label: desktopSessionRootLabel(tree.root) }] : [];
		})
		.sort((left, right) => right.prefix.length - left.prefix.length);
	const single = changes.worktrees.length === 1 ? label(changes.worktrees[0]!.root) : null;
	// A lone `/` or drive-root worktree: its relative paths are root-relative, so only the name crosses.
	const unlabeled = changes.worktrees.length === 1 && single === null;
	const locate = (path: string): { path: string; root: string | null } => {
		const normalized = path.replaceAll("\\", "/");
		const folded = normalized.toLowerCase();
		for (const { prefix, fold, label: rootLabel } of roots) {
			if ((fold ? folded : normalized).startsWith(prefix)) return { path: normalized.slice(prefix.length), root: rootLabel };
		}
		if (ABSOLUTE_PATH.test(path) || unlabeled) return { path: baseName(path), root: null };
		return { path, root: single };
	};
	return {
		files: changes.files.map((file) => ({ ...locate(file.path), status: file.status, added: file.added, deleted: file.deleted })),
		summary: { ...changes.summary },
		worktrees: changes.worktrees.map((tree) => ({ root: label(tree.root), branch: tree.branch, files: tree.files })),
		truncated: changes.truncated,
	};
}

/** A detached copy of a section that carries no path (the feed already bounded it). */
const copy = <T>(value: T): T => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);

function section(snapshot: DesktopFeedSnapshot, name: DesktopSessionSection): unknown {
	switch (name) {
		case "project": return projectSection(snapshot.project);
		case "changes": return changesSection(snapshot.changes);
		default: return copy(snapshot[name]);
	}
}

/**
 * The wire-safe sections of one feed snapshot, in canonical order. The
 * identity block (session file, cwd, real cwd, pid, ppid, ancestors, agent
 * dir) is never read; `project.cwd` becomes its basename `project.name`;
 * worktree roots become opaque labels. Arrays keep the feed's caps.
 */
export function projectDesktopSessionSections(snapshot: DesktopFeedSnapshot, names: readonly DesktopSessionSection[]): DesktopSessionSections {
	const wanted = new Set(names);
	const out: DesktopSessionSections = {};
	for (const name of DESKTOP_SESSION_SECTIONS) {
		if (wanted.has(name)) out[name] = section(snapshot, name);
	}
	return out;
}

/**
 * The comparison key of one projected section: what counts as a change for
 * `session_snapshot`. A job's elapsed time moves on every flush and is
 * derived from `startedAt`, so it is not a change (as in the feed's digest).
 */
export function desktopSessionSectionKey(name: DesktopSessionSection, value: unknown): string {
	if (name === "jobs" && value && typeof value === "object") {
		const jobs = value as { running?: Array<Record<string, unknown>>; recent?: Array<Record<string, unknown>> };
		const strip = (list: Array<Record<string, unknown>> | undefined) => (list ?? []).map(({ elapsedMs: _elapsed, ...job }) => job);
		return JSON.stringify({ running: strip(jobs.running), recent: strip(jobs.recent) });
	}
	return JSON.stringify(value ?? null);
}
