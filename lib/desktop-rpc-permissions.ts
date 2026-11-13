import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverYoloUiAdapter, YOLO_DISPLAY, type YoloUiAdapter } from "./yolo-session-policy.ts";
import { isPermissionMode, type PermissionMode } from "./permission-mode-policy.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";

export const DESKTOP_PERMISSION_METHODS = ["get_permission_mode", "set_permission_mode"] as const;
export const DESKTOP_PERMISSION_EVENT = "permission_mode_changed";

const UNAVAILABLE = { code: "permission_unavailable", message: "Permission owner unavailable for this session" } as const;
const DENIED = { code: "permission_denied", message: "Permission mode unchanged for this session" } as const;
const INVALID_PARAMS = { code: "invalid_request", message: "Invalid permission mode parameters" } as const;
const INVALID_MODE = { code: "invalid_request", message: "Unknown permission mode" } as const;
const DEFAULT_UNCHANGED = { code: "default_unchanged", message: "Default permission mode unchanged" } as const;

type PermissionState = { mode: PermissionMode; defaultMode: PermissionMode };

function parseSetParams(params: Record<string, unknown>): { mode: unknown; persist: boolean } | undefined {
	for (const key of Object.keys(params)) {
		if (key !== "mode" && key !== "persist") return undefined;
	}
	if (typeof params.mode !== "string") return undefined;
	if (params.persist !== undefined && typeof params.persist !== "boolean") return undefined;
	return { mode: params.mode, persist: params.persist === true };
}

/**
 * Desktop's permission surface over the existing YoloSessionController owner.
 *
 * The owner is reached only through its published `gentle:yolo:host-ui` adapter:
 * the same controller that answers `/gentle:mode`, so there is no parallel mode
 * store, no second file reader, and no filesystem watcher. Every mutation is
 * validated by the owner (interactive host, live session identity, atomic save);
 * this bridge only shapes owner results into the Desktop RPC contract.
 */
export class DesktopPermissionBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverYoloUiAdapter;
	private adapter: YoloUiAdapter | undefined;
	private discovering: Promise<YoloUiAdapter | undefined> | undefined;
	private host: ExtensionContext | undefined;
	private generation = 0;

	constructor(pi: ExtensionAPI, discover: typeof discoverYoloUiAdapter = discoverYoloUiAdapter) {
		this.pi = pi;
		this.discover = discover;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Session start/shutdown: the owner adapter of a previous session is invalid. */
	reset(): void {
		this.generation += 1;
		const adapter = this.adapter;
		this.adapter = undefined;
		this.discovering = undefined;
		this.host = undefined;
		try {
			adapter?.dispose();
		} catch {
			/* display-only owner teardown */
		}
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		const context = this.host;
		if (!context) return { ok: false, error: UNAVAILABLE };
		if (method === "get_permission_mode") {
			if (Object.keys(params).length > 0) return { ok: false, error: INVALID_PARAMS };
			const state = await this.read(context);
			return state ? { ok: true, data: { mode: state.mode, default_mode: state.defaultMode } } : { ok: false, error: UNAVAILABLE };
		}
		if (method === "set_permission_mode") return this.set(context, params);
		return undefined;
	}

	private async owner(context: ExtensionContext): Promise<YoloUiAdapter | undefined> {
		if (this.adapter) return this.adapter;
		if (!this.discovering) {
			// A discovery that outlives a reset belongs to the replaced session: its
			// adapter is disposed and never cached, like the other Desktop bridges.
			const generation = this.generation;
			const discovering: Promise<YoloUiAdapter | undefined> = Promise.resolve()
				.then(() => this.discover(this.pi, context))
				.then((adapter) => {
					if (generation !== this.generation) {
						try {
							adapter?.dispose();
						} catch {
							/* display-only owner teardown */
						}
						return undefined;
					}
					this.adapter = adapter ?? undefined;
					return adapter;
				})
				.catch(() => undefined)
				.finally(() => {
					if (this.discovering === discovering) this.discovering = undefined;
				});
			this.discovering = discovering;
		}
		return this.discovering;
	}

	private async read(context: ExtensionContext): Promise<PermissionState | undefined> {
		const adapter = await this.owner(context);
		if (!adapter || typeof adapter.readSnapshot !== "function") return undefined;
		try {
			const snapshot = await adapter.readSnapshot();
			if (!snapshot || snapshot.yolo === YOLO_DISPLAY.unavailable) return undefined;
			if (!isPermissionMode(snapshot.mode) || !isPermissionMode(snapshot.defaultMode)) return undefined;
			return { mode: snapshot.mode, defaultMode: snapshot.defaultMode };
		} catch {
			return undefined;
		}
	}

	private async set(context: ExtensionContext, params: Record<string, unknown>): Promise<DesktopRpcOutcome> {
		const parsed = parseSetParams(params);
		if (!parsed) return { ok: false, error: INVALID_PARAMS };
		if (!isPermissionMode(parsed.mode)) return { ok: false, error: INVALID_MODE };
		const adapter = await this.owner(context);
		if (!adapter || typeof adapter.setMode !== "function") return { ok: false, error: UNAVAILABLE };
		const before = await this.read(context);
		if (!before) return { ok: false, error: UNAVAILABLE };

		let applied = false;
		try {
			applied = await adapter.setMode(parsed.mode);
		} catch {
			applied = false;
		}
		if (!applied) return { ok: false, error: DENIED };

		// Persistence is a separate, explicitly requested owner write. A failure
		// never rolls the live session change back.
		let persisted = false;
		let persistFailed = false;
		if (parsed.persist) {
			try {
				persisted = typeof adapter.saveDefault === "function" ? await adapter.saveDefault(parsed.mode) : false;
			} catch {
				persisted = false;
			}
			persistFailed = !persisted;
		}

		// The response reports only what the owner confirms. If the session was
		// replaced or revoked meanwhile, echoing the request could claim a mode the
		// owner is not enforcing.
		const after = await this.read(context);
		if (!after) return { ok: false, error: UNAVAILABLE };
		const mode = after.mode;
		const defaultMode = after.defaultMode;
		const changed = mode !== before.mode || defaultMode !== before.defaultMode;
		const data: Record<string, unknown> = { mode, default_mode: defaultMode, persisted, changed };
		if (persistFailed) data.persist_error = { ...DEFAULT_UNCHANGED };
		const outcome: DesktopRpcOutcome = { ok: true, data };
		if (!changed) return outcome;
		return {
			...outcome,
			event: {
				name: DESKTOP_PERMISSION_EVENT,
				data: {
					mode,
					previous_mode: before.mode,
					default_mode: defaultMode,
					persisted,
					source: "desktop",
				},
			},
		};
	}
}
