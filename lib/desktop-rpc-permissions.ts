import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverYoloUiAdapter, YOLO_DISPLAY, type YoloUiAdapter } from "./yolo-session-policy.ts";
import { isPermissionMode, type PermissionMode } from "./permission-mode-policy.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	createDesktopDebouncer,
	DESKTOP_CHANGE_DEBOUNCE_MS,
	realDesktopChangeTimers,
	type DesktopChangeTimers,
	type DesktopDebouncer,
} from "./desktop-rpc-config-watch.ts";

export const DESKTOP_PERMISSION_METHODS = ["get_permission_mode", "set_permission_mode"] as const;
export const DESKTOP_PERMISSION_EVENT = "permission_mode_changed";

const UNAVAILABLE = { code: "permission_unavailable", message: "Permission owner unavailable for this session" } as const;
const DENIED = { code: "permission_denied", message: "Permission mode unchanged for this session" } as const;
const INVALID_PARAMS = { code: "invalid_request", message: "Invalid permission mode parameters" } as const;
const INVALID_MODE = { code: "invalid_request", message: "Unknown permission mode" } as const;
const DEFAULT_UNCHANGED = { code: "default_unchanged", message: "Default permission mode unchanged" } as const;

type PermissionState = { mode: PermissionMode; defaultMode: PermissionMode };

export type DesktopPermissionEmit = (event: string, data: Record<string, unknown>) => void;

export interface DesktopPermissionWatchOptions {
	timers?: DesktopChangeTimers;
	debounceMs?: number;
}

function sameState(left: PermissionState, right: PermissionState): boolean {
	return left.mode === right.mode && left.defaultMode === right.defaultMode;
}

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
 *
 * Once wired for an interactive RPC host, the bridge subscribes to the owner's
 * existing observer (`observe`, the same one the desktop feed uses). Each owner
 * notification restarts a short debounce window; when it closes, the bridge
 * re-reads the owner and emits `permission_mode_changed` with
 * `source: "external"` only when the state differs from the last state this
 * channel reported. Desktop requests record what they reported, and an observer
 * window that closes while a Desktop change is in flight is deferred until it
 * finishes, so a Desktop change is never echoed as an external one.
 */
export class DesktopPermissionBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverYoloUiAdapter;
	private adapter: YoloUiAdapter | undefined;
	private discovering: Promise<YoloUiAdapter | undefined> | undefined;
	private host: ExtensionContext | undefined;
	private generation = 0;
	private readonly debouncer: DesktopDebouncer;
	private emit: DesktopPermissionEmit | undefined;
	private unobserve: (() => void) | undefined;
	/** The last state this channel reported, and a counter bumped on every report. */
	private reported: PermissionState | undefined;
	private reportEpoch = 0;
	private setsInFlight = 0;
	private refreshDeferred = false;

	constructor(
		pi: ExtensionAPI,
		discover: typeof discoverYoloUiAdapter = discoverYoloUiAdapter,
		watch: DesktopPermissionWatchOptions = {},
	) {
		this.pi = pi;
		this.discover = discover;
		this.debouncer = createDesktopDebouncer(
			watch.timers ?? realDesktopChangeTimers,
			watch.debounceMs ?? DESKTOP_CHANGE_DEBOUNCE_MS,
			() => void this.refresh(),
		);
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Session start/shutdown: the owner adapter of a previous session is invalid. */
	reset(): void {
		this.generation += 1;
		const adapter = this.adapter;
		const unobserve = this.unobserve;
		this.adapter = undefined;
		this.discovering = undefined;
		this.host = undefined;
		this.emit = undefined;
		this.unobserve = undefined;
		this.reported = undefined;
		this.reportEpoch += 1;
		this.setsInFlight = 0;
		this.refreshDeferred = false;
		this.debouncer.cancel();
		try {
			unobserve?.();
		} catch {
			/* display-only owner teardown */
		}
		try {
			adapter?.dispose();
		} catch {
			/* display-only owner teardown */
		}
	}

	/**
	 * Interactive RPC hosts only, after `attach`: subscribe to the owner observer
	 * and record the current state as the baseline, so wiring never emits by
	 * itself. A missing owner simply leaves the session without external events.
	 */
	async wire(emit: DesktopPermissionEmit): Promise<void> {
		const context = this.host;
		if (!context) return;
		this.emit = emit;
		const generation = this.generation;
		try {
			const adapter = await this.owner(context);
			if (generation !== this.generation || !adapter || this.unobserve) return;
			this.unobserve = adapter.observe(() => this.debouncer.schedule());
			const epoch = this.reportEpoch;
			const state = await this.read(context);
			if (generation !== this.generation || epoch !== this.reportEpoch || !state) return;
			this.report(state);
		} catch {
			// A failing owner leaves this session without external permission
			// events; nothing reaches the caller or the process as a rejection.
			if (generation !== this.generation) return;
			this.emit = undefined;
			this.debouncer.cancel();
			const unobserve = this.unobserve;
			this.unobserve = undefined;
			try {
				unobserve?.();
			} catch {
				/* display-only owner teardown */
			}
		}
	}

	private report(state: PermissionState): void {
		this.reported = state;
		this.reportEpoch += 1;
	}

	/** Debounced owner notification: emit only a state this channel has not reported. */
	private async refresh(): Promise<void> {
		const context = this.host;
		const emit = this.emit;
		if (!context || !emit) return;
		if (this.setsInFlight > 0) {
			this.refreshDeferred = true;
			return;
		}
		const generation = this.generation;
		const epoch = this.reportEpoch;
		const state = await this.read(context);
		// A newer report (a Desktop request, or a reset) owns the state now.
		if (generation !== this.generation || epoch !== this.reportEpoch || !state) return;
		if (this.setsInFlight > 0) {
			this.refreshDeferred = true;
			return;
		}
		const previous = this.reported;
		this.report(state);
		if (!previous || sameState(previous, state)) return;
		try {
			emit(DESKTOP_PERMISSION_EVENT, {
				mode: state.mode,
				previous_mode: previous.mode,
				default_mode: state.defaultMode,
				persisted: state.defaultMode !== previous.defaultMode,
				source: "external",
			});
		} catch {
			/* a closed transport never throws back into the owner observer */
		}
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		const context = this.host;
		if (!context) return { ok: false, error: UNAVAILABLE };
		if (method === "get_permission_mode") {
			if (Object.keys(params).length > 0) return { ok: false, error: INVALID_PARAMS };
			const state = await this.read(context);
			if (!state) return { ok: false, error: UNAVAILABLE };
			this.report(state);
			return { ok: true, data: { mode: state.mode, default_mode: state.defaultMode } };
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
		try {
			if (!adapter || typeof adapter.readSnapshot !== "function") return undefined;
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
		const generation = this.generation;
		this.setsInFlight += 1;
		try {
			return await this.apply(context, { mode: parsed.mode, persist: parsed.persist });
		} finally {
			if (generation === this.generation) {
				this.setsInFlight -= 1;
				if (this.setsInFlight === 0 && this.refreshDeferred) {
					this.refreshDeferred = false;
					this.debouncer.schedule();
				}
			}
		}
	}

	private async apply(context: ExtensionContext, parsed: { mode: PermissionMode; persist: boolean }): Promise<DesktopRpcOutcome> {
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
		// Recorded before the response leaves: the owner notified its observers
		// while applying this request, and that window must find nothing new.
		this.report(after);
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
