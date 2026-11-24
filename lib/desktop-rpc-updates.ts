// Gentle Desktop update-status slice: the pure contract shared by the Desktop
// bridge (`lib/desktop-updates-service.ts`) and the update sources it reads
// (`lib/update-status.ts`).
//
// Nothing here reaches the network or the filesystem. The sources supply what
// Gentle Shell's own channel and version resolution and Pi's own package
// update check already know; this module only parses the request and projects
// those facts into the safe, bounded Desktop shape. It never decides that
// something is up to date without a successful lookup.

export const DESKTOP_UPDATES_METHODS = ["get_update_status"] as const;
/** Update status is an explicit read: this slice advertises no event. */
export const DESKTOP_UPDATES_EVENTS = [] as const;

export const INVALID_UPDATES_PARAMS = { code: "invalid_request", message: "Invalid update status parameters" } as const;
export const UPDATES_UNAVAILABLE = { code: "updates_unavailable", message: "Update status unavailable" } as const;

/** Upper bound on the package rows one answer carries. */
export const DESKTOP_UPDATES_LIMITS = { packages: 100 } as const;
/** Longest package name the wire carries; longer names are cut. */
export const DESKTOP_UPDATES_NAME_LIMIT = 128;
/** Longest version string the wire carries; longer values are dropped as unknown. */
export const DESKTOP_UPDATES_VERSION_LIMIT = 64;

/**
 * How this Gentle Shell was installed, from the existing resolvers: a bundled
 * prefix (`runningBundledPrefix`), gentle-pi loaded as a Pi package
 * (`npm:gentle-pi`, the way the Gentle AI managed stack declares it), or the
 * release/main channel record `gentle-shell upgrade` keeps (`readChannel`).
 * `unknown` when the channel record cannot be read.
 */
export type ShellChannel = "release" | "main" | "bundled" | "gentle-ai-managed" | "unknown";
export type ItemState = "update_available" | "up_to_date" | "unknown";
/**
 * Pi's package check only says which packages have a newer version, and it
 * treats a failed lookup like "no update". So a package it did not list is
 * `no_update_reported`, never `up_to_date`; `skipped` is a package Pi never
 * checks (pinned, local, or not installed); `unknown` means not checked yet,
 * offline, or the check failed or timed out.
 */
export type PackageState = "update_available" | "no_update_reported" | "skipped" | "unknown";
export type PackageKind = "npm" | "git" | "local" | "unknown";

/** Fixed command text per kind of install; never built from user input. */
export const SHELL_UPDATE_COMMANDS: Readonly<Record<ShellChannel, string | null>> = Object.freeze({
	release: "gentle-shell upgrade",
	main: "gentle-shell upgrade --channel main",
	bundled: "gentle-shell upgrade",
	"gentle-ai-managed": "gentle-shell update --extensions",
	unknown: null,
});
export const PI_UPDATE_COMMAND = "gentle-shell update";
export const PACKAGES_UPDATE_COMMAND = "gentle-shell update --extensions";

export interface DesktopUpdatesQuery {
	refresh: boolean;
}

export interface DesktopShellUpdate {
	current: string | null;
	latest: string | null;
	channel: ShellChannel;
	state: ItemState;
	command: string | null;
	checkedAt: string | null;
}

export interface DesktopPiUpdate {
	current: string | null;
	latest: string | null;
	state: ItemState;
	command: string;
	checkedAt: string | null;
}

export interface DesktopPackageUpdate {
	name: string;
	kind: PackageKind;
	scope: "user" | "project";
	current: string | null;
	/** Pi's check reports that a newer version exists, not which one: always null today. */
	latest: string | null;
	pinned: boolean | null;
	state: PackageState;
}

export interface DesktopPackagesUpdate {
	/** False when Pi's configured-package listing could not be read. */
	available: boolean;
	items: DesktopPackageUpdate[];
	truncated: boolean;
	command: string;
	checkedAt: string | null;
}

/** The `get_update_status` answer. */
export interface DesktopUpdateStatus {
	/** True only when this answer ran a check (`refresh: true`, not offline). */
	refreshed: boolean;
	/** `PI_OFFLINE` is set: no lookup runs, and nothing is reported as up to date by a check. */
	offline: boolean;
	gentleShell: DesktopShellUpdate;
	pi: DesktopPiUpdate;
	packages: DesktopPackagesUpdate;
}

/** `get_update_status` params: only an optional boolean `refresh`. */
export function parseUpdateStatusParams(params: Record<string, unknown>): DesktopUpdatesQuery | { error: { code: string; message: string } } {
	if (Object.keys(params).some((key) => key !== "refresh")) return { error: INVALID_UPDATES_PARAMS };
	if (!("refresh" in params)) return { refresh: false };
	if (typeof params.refresh !== "boolean") return { error: INVALID_UPDATES_PARAMS };
	return { refresh: params.refresh };
}

/** A version string safe for the wire, or null. */
export function boundedVersion(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > DESKTOP_UPDATES_VERSION_LIMIT || /[\s\\/]/.test(trimmed)) return null;
	return trimmed;
}

/**
 * A package display name safe for the wire: Pi's own display name (npm name,
 * or `host/path` for git), or the last segment of a local path. Anything
 * that still looks like a path, URL, or credential is replaced by `unknown`.
 */
export function packageDisplayName(kind: PackageKind, name: string | undefined): string {
	if (typeof name !== "string") return "unknown";
	let value = name.trim();
	if (kind === "local") value = value.split(/[\\/]+/).filter((segment) => segment.length > 0).at(-1) ?? "";
	if (value.length === 0 || value.includes("://") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return "unknown";
	// A git display name is `host/path`; userinfo never belongs in it.
	if (kind === "git" && value.split("/")[0]!.includes("@")) return "unknown";
	return value.length > DESKTOP_UPDATES_NAME_LIMIT ? value.slice(0, DESKTOP_UPDATES_NAME_LIMIT) : value;
}

/** Bounds the package rows, keeping their order, and reports the cut. */
export function boundPackages(items: readonly DesktopPackageUpdate[]): { items: DesktopPackageUpdate[]; truncated: boolean } {
	return { items: items.slice(0, DESKTOP_UPDATES_LIMITS.packages), truncated: items.length > DESKTOP_UPDATES_LIMITS.packages };
}

export const isoTime = (ms: number | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
