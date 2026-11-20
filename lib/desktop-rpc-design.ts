// Gentle Desktop design-canvas slice: the pure contract shared by the Desktop
// bridge (`lib/desktop-design-service.ts`) and the owner seam inside
// `extensions/gentle-design.ts`.
//
// Nothing here opens a server, opens a browser, or reaches the network. It
// only names the wire shapes, projects the owner's actual canvas state into
// the safe Desktop projection, and keeps the tokenized canvas URL a capability
// that is never a bare field. The owner (the single `DesignCanvas` returned by
// `createDesignCanvas`, plus `listDesigns`) stays the single source of truth;
// this module is a projection, not a second store, port, or canvas.

export const DESKTOP_DESIGN_METHODS = ["get_design_canvas"] as const;
export const DESKTOP_DESIGN_EVENT = "design_canvas";
/** Advertised only because the owner seam records the transitions this event carries. */
export const DESKTOP_DESIGN_EVENTS = [DESKTOP_DESIGN_EVENT] as const;

// The versioned owner-service discovery seam (the design analogue of the usage
// `gentle:desktop:usage-service` adapter). The schema string guards the adapter
// against drift; the bridge ignores any responder whose shape does not match.
export const DESKTOP_DESIGN_SERVICE_SCHEMA = "gentle-pi.desktop-design-service/v1";
export const DESKTOP_DESIGN_SERVICE_CHANNEL = "gentle:desktop:design-service";

export type DesktopDesignTransition = "open" | "refresh" | "stop";

/** A design under `<cwd>/design`, as the owner's `listDesigns` already reports it. */
export interface DesktopDesignEntry {
	slug: string;
	title: string;
	/** design.json modification time in milliseconds. */
	mtime: number;
}

/**
 * The sanitized owner state: whether a canvas server is running, the slug it
 * last showed (null for the system-only root), and how many canvas pages are
 * connected. Never a URL, token, port, or server detail.
 */
export interface DesktopDesignOwnerState {
	running: boolean;
	slug: string | null;
	connectedClients: number;
}

/**
 * An actual owner open/refresh/stop transition, carrying the sanitized
 * post-transition state. `url` is present only when the observer explicitly
 * subscribed with `includeUrl` (the same capability policy as the read).
 */
export interface DesktopDesignOwnerTransition extends DesktopDesignOwnerState {
	transition: DesktopDesignTransition;
	url?: string;
}

/** The `get_design_canvas` response: owner state plus the designs the owner lists. */
export interface DesktopDesignCanvasData extends DesktopDesignOwnerState {
	designs: DesktopDesignEntry[];
	/** The tokenized canvas URL; present only after `includeUrl: true` and trust. */
	url?: string;
}

/**
 * The owner-service adapter the bridge discovers. Every method is defensive:
 * after `dispose()` it answers empty/no-op rather than speaking into a
 * replaced session.
 */
export interface DesktopDesignService {
	schema: typeof DESKTOP_DESIGN_SERVICE_SCHEMA;
	read(): Promise<DesktopDesignOwnerState>;
	/** The tokenized URL the running canvas last showed, or undefined. A capability. */
	url(): string | undefined;
	listDesigns(): DesktopDesignEntry[];
	/** Subscribe to actual open/refresh/stop transitions. `includeUrl` adds the URL. */
	observe(options: { includeUrl?: boolean }, onTransition: (transition: DesktopDesignOwnerTransition) => void): () => void;
	dispose(): void;
}

export const INVALID_DESIGN_PARAMS = { code: "invalid_request", message: "Invalid design canvas parameters" } as const;
export const DESIGN_UNAVAILABLE = { code: "design_unavailable", message: "Design canvas owner unavailable for this session" } as const;

/**
 * `get_design_canvas` params: either empty (omit the URL) or exactly
 * `{ includeUrl: boolean }`. Anything else is a typed `invalid_request` before
 * any owner work happens.
 */
export function parseDesignCanvasParams(
	params: Record<string, unknown>,
): { includeUrl: boolean } | { error: { code: string; message: string } } {
	const keys = Object.keys(params);
	if (keys.length === 0) return { includeUrl: false };
	if (keys.length !== 1 || keys[0] !== "includeUrl" || typeof params.includeUrl !== "boolean") {
		return { error: INVALID_DESIGN_PARAMS };
	}
	return { includeUrl: params.includeUrl };
}

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopDesignServiceShape(value: unknown): value is DesktopDesignService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopDesignService>;
	if (adapter.schema !== DESKTOP_DESIGN_SERVICE_SCHEMA) return false;
	return [adapter.read, adapter.url, adapter.listDesigns, adapter.observe, adapter.dispose].every((fn) => typeof fn === "function");
}

/**
 * True only for a well-shaped owner state. The owner's answer crosses the event
 * bus, so its shape is never trusted beyond the fields the bridge projects:
 * `running` boolean, `slug` null or a non-empty string, `connectedClients` a
 * non-negative integer. Anything else is junk the bridge answers
 * `design_unavailable` for rather than projecting into a malformed success.
 */
export function isValidDesktopDesignOwnerState(value: unknown): value is DesktopDesignOwnerState {
	if (!value || typeof value !== "object") return false;
	const state = value as Record<string, unknown>;
	if (typeof state.running !== "boolean") return false;
	if (state.slug !== null && (typeof state.slug !== "string" || state.slug.length === 0)) return false;
	return typeof state.connectedClients === "number" && Number.isInteger(state.connectedClients) && state.connectedClients >= 0;
}

/**
 * Projects one owner design list, rebuilding each entry with only the named
 * fields (`slug`, `title`, `mtime`) so a foreign `token`, `url`, or path member
 * is dropped rather than echoed. Returns `undefined` for a non-array or any
 * malformed entry, which the bridge treats as an unavailable owner instead of a
 * malformed success.
 */
export function parseDesktopDesignEntries(value: unknown): DesktopDesignEntry[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries: DesktopDesignEntry[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return undefined;
		const raw = entry as Record<string, unknown>;
		if (typeof raw.slug !== "string" || raw.slug.length === 0) return undefined;
		if (typeof raw.title !== "string") return undefined;
		if (typeof raw.mtime !== "number" || !Number.isFinite(raw.mtime) || raw.mtime < 0) return undefined;
		entries.push({ slug: raw.slug, title: raw.title, mtime: raw.mtime });
	}
	return entries;
}
