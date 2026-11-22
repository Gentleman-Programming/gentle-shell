// Gentle Desktop session-profile binding slice: which profile this session
// routes its subagents with, a change event, and a clear.
//
// The read is the single rule launch, status, and the Desktop feed already use
// (`resolveSessionProfile`), so the answer always agrees with what a launch
// would do, including a binding chosen in the terminal or restored on resume.
// The event follows every write to the binding store
// (`observeSessionProfileBindings`). The clear is the `/gentle:profiles clear`
// owner action, reached through the profiles owner service.
//
// Publishing a profile to the repository is not here: that is the repository
// pin, written with `set_config` store `pins` (`{ source: "repo", profile }`).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "./agent-home.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { discoverDesktopProfilesService } from "./desktop-rpc-profiles.ts";
import { observeSessionProfileBindings } from "./session-profile-binding.ts";
import { resolveSessionProfile, type SessionProfileResolution } from "./session-profile-freeze.ts";
import { resolveSessionWorktree, type WorktreeIdentity, type WorktreeResolver } from "./session-worktree-registry.ts";

export const DESKTOP_PROFILE_BINDING_METHODS = ["get_profile_binding", "clear_profile_binding"] as const;
export const DESKTOP_PROFILE_BINDING_EVENT = "profile_binding_changed";
export const DESKTOP_PROFILE_BINDING_EVENTS = [DESKTOP_PROFILE_BINDING_EVENT] as const;

export const INVALID_PROFILE_BINDING_PARAMS = { code: "invalid_request", message: "Invalid profile binding parameters" } as const;
export const PROFILE_BINDING_UNAVAILABLE = { code: "profiles_unavailable", message: "The session profile is not available in this session" } as const;
export const PROFILE_BINDING_BUSY = { code: "profile_apply_busy", message: "A profile apply is in progress" } as const;

/**
 * `explicit`: chosen for this session; `inherited`: the profile the session
 * started with (frozen at its start); `follow`: follows the shared layers live
 * (`GENTLE_PI_PROFILE_FOLLOW`); `live`: a child session reading the layers.
 */
export type DesktopProfileBindingKind = "explicit" | "inherited" | "follow" | "live";
export type DesktopProfileBindingOrigin = "session" | "local" | "repo" | "global";

export interface DesktopProfileBinding {
	kind: DesktopProfileBindingKind;
	/** The profile routing this session's launches, or `null` for the routing without a profile. */
	profile: string | null;
	/** Where it comes from: `session` for an explicit choice, else the layer that supplied it. */
	origin: DesktopProfileBindingOrigin | null;
}

/** The clear outcome the profiles owner reports. */
export type DesktopProfileClearResult = { status: "cleared" | "unchanged" | "not_cleared" | "busy" };

export function projectProfileBinding(resolution: SessionProfileResolution): DesktopProfileBinding {
	if (resolution.kind === "explicit") return { kind: "explicit", profile: resolution.name, origin: "session" };
	const profile = resolution.profile;
	if (!profile) return { kind: resolution.kind, profile: null, origin: null };
	const origin = profile.origin === "local" || profile.origin === "repo" || profile.origin === "global" ? profile.origin : null;
	return { kind: resolution.kind, profile: profile.name, origin };
}

export interface ProfileBindingReaderOptions {
	env?: NodeJS.ProcessEnv;
	configHome?: string;
	resolveWorktree?: WorktreeResolver;
}

/** Reads one session's binding with the same inputs the Desktop feed uses. */
export function readDesktopProfileBinding(cwd: string, sessionId: string, options: ProfileBindingReaderOptions = {}): DesktopProfileBinding {
	const env = options.env ?? process.env;
	let identity: WorktreeIdentity | undefined;
	try { identity = (options.resolveWorktree ?? resolveSessionWorktree)(cwd, cwd); } catch { identity = undefined; }
	const configHome = options.configHome ?? gentlePiConfigHome(env);
	return projectProfileBinding(resolveSessionProfile({ sessionId, cwd, configHome, resolveWorktree: () => identity, env }));
}

type Emit = (event: string, data: Record<string, unknown>) => void;

/**
 * The Desktop domain slice for the session-profile binding. A reset (session
 * replacement or shutdown) drops the bound context and the observer.
 */
export class DesktopProfileBindingBridge {
	private readonly pi: ExtensionAPI;
	private readonly options: ProfileBindingReaderOptions;
	private readonly discover: typeof discoverDesktopProfilesService;
	private host: ExtensionContext | undefined;
	private generation = 0;
	private unobserve: (() => void) | undefined;
	private lastEmitted: string | undefined;
	/** Desktop clears in flight; while any runs, its store writes are reported once, as `desktop`. */
	private clearing = 0;
	/** The emitter `wire` received; used to publish writes a failed clear suppressed. */
	private emit: Emit | undefined;

	constructor(pi: ExtensionAPI, options: ProfileBindingReaderOptions & { discover?: typeof discoverDesktopProfilesService } = {}) {
		this.pi = pi;
		const { discover, ...reader } = options;
		this.options = reader;
		this.discover = discover ?? discoverDesktopProfilesService;
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.generation += 1;
		this.host = undefined;
		this.unobserve?.();
		this.unobserve = undefined;
		this.lastEmitted = undefined;
		this.clearing = 0;
		this.emit = undefined;
	}

	private sessionOf(host: ExtensionContext): { cwd: string; sessionId: string } | undefined {
		try {
			const sessionId = host.sessionManager?.getSessionId?.();
			const cwd = host.sessionManager?.getCwd?.() ?? host.cwd;
			return typeof sessionId === "string" && sessionId.length > 0 && typeof cwd === "string" && cwd.length > 0 ? { cwd, sessionId } : undefined;
		} catch {
			return undefined;
		}
	}

	private read(host: ExtensionContext): DesktopProfileBinding | undefined {
		const session = this.sessionOf(host);
		if (!session) return undefined;
		try {
			return readDesktopProfileBinding(session.cwd, session.sessionId, this.options);
		} catch {
			return undefined;
		}
	}

	/** Subscribe to binding writes; an external change to this session's binding becomes one event. */
	wire(emit: Emit): void {
		this.unobserve?.();
		this.emit = emit;
		this.unobserve = observeSessionProfileBindings((sessionId) => {
			if (this.clearing > 0) return;
			const host = this.host;
			if (!host || this.sessionOf(host)?.sessionId !== sessionId) return;
			this.emitIfChanged(host, emit, "external");
		});
		const host = this.host;
		const current = host ? this.read(host) : undefined;
		this.lastEmitted = current === undefined ? undefined : JSON.stringify(current);
	}

	private emitIfChanged(host: ExtensionContext, emit: Emit, source: "desktop" | "external"): DesktopProfileBinding | undefined {
		const binding = this.read(host);
		if (!binding) return undefined;
		const key = JSON.stringify(binding);
		if (key === this.lastEmitted) return binding;
		this.lastEmitted = key;
		try { emit(DESKTOP_PROFILE_BINDING_EVENT, { ...binding, source }); } catch { /* a closed transport never throws back */ }
		return binding;
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "get_profile_binding" && method !== "clear_profile_binding") return undefined;
		if (Object.keys(params).length > 0) return { ok: false, error: INVALID_PROFILE_BINDING_PARAMS };
		const host = this.host;
		if (!host) return { ok: false, error: PROFILE_BINDING_UNAVAILABLE };
		if (method === "get_profile_binding") {
			const binding = this.read(host);
			return binding ? { ok: true, data: { ...binding } } : { ok: false, error: PROFILE_BINDING_UNAVAILABLE };
		}
		return this.clear(host);
	}

	/**
	 * A clear that ends without a Desktop change (busy or failing) reports
	 * nothing itself, so any binding write it suppressed while it ran is
	 * published now, once, as `external`. Skipped while another clear still runs.
	 */
	private reconcileSuppressed(host: ExtensionContext, generation: number): void {
		if (this.clearing > 0 || generation !== this.generation || !this.emit) return;
		this.emitIfChanged(host, this.emit, "external");
	}

	private async clear(host: ExtensionContext): Promise<DesktopRpcOutcome> {
		const generation = this.generation;
		const before = this.read(host);
		if (!before) return { ok: false, error: PROFILE_BINDING_UNAVAILABLE };
		const service = await this.discover(this.pi, host).catch(() => undefined);
		try {
			if (!service || typeof (service as { clear?: unknown }).clear !== "function" || generation !== this.generation) return { ok: false, error: PROFILE_BINDING_UNAVAILABLE };
			let result: DesktopProfileClearResult;
			this.clearing += 1;
			try {
				result = await (service as unknown as { clear(): Promise<DesktopProfileClearResult> }).clear();
			} catch {
				if (generation === this.generation) this.clearing = Math.max(0, this.clearing - 1);
				this.reconcileSuppressed(host, generation);
				return { ok: false, error: PROFILE_BINDING_UNAVAILABLE };
			}
			if (generation === this.generation) this.clearing = Math.max(0, this.clearing - 1);
			if (generation !== this.generation) return { ok: false, error: PROFILE_BINDING_UNAVAILABLE };
			if (result?.status === "busy") {
				this.reconcileSuppressed(host, generation);
				return { ok: false, error: PROFILE_BINDING_BUSY };
			}
			const status = result?.status === "cleared" || result?.status === "unchanged" || result?.status === "not_cleared" ? result.status : "not_cleared";
			const after = this.read(host) ?? before;
			const changed = JSON.stringify(after) !== JSON.stringify(before);
			const data = { status, changed, binding: after };
			if (!changed) return { ok: true, data };
			this.lastEmitted = JSON.stringify(after);
			return { ok: true, data, event: { name: DESKTOP_PROFILE_BINDING_EVENT, data: { ...after, source: "desktop" } } };
		} finally {
			try { service?.dispose(); } catch { /* owner teardown is best-effort */ }
		}
	}
}
