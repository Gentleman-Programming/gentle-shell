import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendSystemPromptOnce, type AppendableSystemPromptOptions } from "./append-system-prompt.ts";
import { sameReviewSessionIdentity, resolveCanonicalGitRepositoryIdentity, type ReviewSessionIdentity } from "./review-session-standing-permission.ts";
import { realpath } from "node:fs/promises";
import { gentlePiConfigHome } from "./agent-home.ts";
import { isPermissionMode, resolvePermissionModePolicy, writePermissionModePolicy, type PermissionMode } from "./permission-mode-policy.ts";
export type { PermissionMode } from "./permission-mode-policy.ts";
export const MODE_STATUS_KEY = "gentle:mode";
export const AUTO_MODE_NOTICE = "Auto uses additional model calls with separate usage accounting; hard safety and independent consent remain.";

export const YOLO_STATUS_KEY = "gentle:yolo";
export const YOLO_STATUS_TEXT = "🚀 YOLO ON 🔥 — destructive confirmations remain";
export const YOLO_DIRECTIVE = `<gentle-yolo-session>
YOLO session standing permission is ON, authorized by the human for this live primary session and canonical workspace (directly or through a trusted global default).
Qualify the default commit, push and PR confirmation clauses: for ordinary already-scoped implementation, checks, commits, non-force pushes and PR creation, this activation supplies standing permission instead of repeated permission questions. Make ordinary reversible implementation choices without needless interviews.
This does NOT override explicit human restrictions, repository policy, project trust, configured confirmations or blocks, or the authorized task scope. Ask before scope expansion, privacy-sensitive disclosure, genuinely unresolved consequential product choices, or ambiguous destinations or credentials. Never invent destinations or credentials.
Destructive/data-loss confirmations remain mandatory and independent. Never auto-answer ask_user tools, provider consent, maintenance/recovery authorization or opaque-token decisions. Review standing permission and RDD are unchanged. Children remain bounded by their delegated task; they receive no independent delivery grant or YOLO inheritance.
</gentle-yolo-session>`;

/** Legacy standalone API; separate from review grants and their registry. */
export class YoloSessionPolicy {
	private grant: ReviewSessionIdentity | undefined;
	private generation = 0;
	get epoch(): number { return this.generation; }
	get enabled(): boolean { return this.grant !== undefined; }
	reset(): void { this.generation += 1; this.grant = undefined; }
	set(enabled: boolean, identity: ReviewSessionIdentity | undefined, expectedEpoch = this.epoch): boolean {
		if (expectedEpoch !== this.epoch) return false;
		this.reset();
		if (!enabled) return true;
		if (identity === undefined) return false;
		this.grant = identity;
		return true;
	}
	active(identity: ReviewSessionIdentity | undefined): boolean {
		if (!this.grant) return false;
		if (identity !== undefined && sameReviewSessionIdentity(this.grant, identity)) return true;
		this.reset();
		return false;
	}
}

/** Remove our exact block as well as adding it: bridge options can be reused. */
export function updateYoloPrompt(options: AppendableSystemPromptOptions | null | undefined, active: boolean): void {
	if (!options) return;
	options.appendSystemPrompt = (options.appendSystemPrompt ?? "")
		.replace(`\n\n${YOLO_DIRECTIVE}`, "").replace(YOLO_DIRECTIVE, "");
	if (active) appendSystemPromptOnce(options, YOLO_DIRECTIVE);
}
const HUMAN_ACTION = { on: "on", off: "off", toggle: "" } as const;
type HumanAction = (typeof HUMAN_ACTION)[keyof typeof HUMAN_ACTION];
export const YOLO_DISPLAY = { on: "ON", off: "OFF", unavailable: "UNAVAILABLE" } as const;
export type YoloDisplay = (typeof YOLO_DISPLAY)[keyof typeof YOLO_DISPLAY];
const HOST_UI_CHANNEL = "gentle:yolo:host-ui";
const DISCOVERY_TIMEOUT_MS = 100;
export interface YoloUiAdapter {
	read(): Promise<YoloDisplay>;
	readMode?(): Promise<PermissionMode>;
	readSnapshot?(): Promise<{ yolo: YoloDisplay; mode: PermissionMode; defaultMode: PermissionMode }>;
	setMode?(mode: PermissionMode): Promise<boolean>;
	readDefault?(): PermissionMode;
	saveDefault?(mode: PermissionMode): Promise<boolean>;
	toggle(): Promise<void>;
	observe(refresh: () => void): () => void;
	dispose(): void;
}
interface HostUiRequest { context: ExtensionContext; respond(adapter: YoloUiAdapter): void }
function isUiAdapter(value: unknown): value is YoloUiAdapter {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<YoloUiAdapter>;
	return [adapter.read, adapter.toggle, adapter.observe, adapter.dispose].every(fn => typeof fn === "function");
}
/** emit is void (and listeners may be wrapped async); explicitly bound the callback wait. */
export function discoverYoloUiAdapter(pi: ExtensionAPI, context: ExtensionContext): Promise<YoloUiAdapter | undefined> {
	return new Promise(resolve => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isUiAdapter(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try { pi.events.emit(HOST_UI_CHANNEL, { context, respond } satisfies HostUiRequest); }
		catch { settled = true; clearTimeout(timer); resolve(undefined); }
	});
}
export interface YoloSessionController {
	active(context: ExtensionContext): Promise<boolean>;
	mode(context: ExtensionContext): Promise<PermissionMode>;
	setMode(mode: PermissionMode, context: ExtensionContext): Promise<boolean>;
	defaultMode(): PermissionMode;
	saveDefault(mode: PermissionMode, context: ExtensionContext): Promise<boolean>;
	epoch(): number;
	humanAction(action: HumanAction, context: ExtensionContext, current?: () => boolean): Promise<boolean>;
	reset(context: ExtensionContext): void;
}
interface ModeIdentity {
	manager: ExtensionContext["sessionManager"];
	id: string;
	workspace: string;
}
/** UI/slash authoring only. Defaults are read from the dedicated trusted user store. */
export function registerYoloSessionPolicy(pi: ExtensionAPI, env: NodeJS.ProcessEnv,
	options: { onChange?: () => void } = {}): YoloSessionController {
	const store = { gentlePiConfigHome: gentlePiConfigHome(env) };
	let generation = 0;
	let ownerGeneration = 0;
	let liveMode: PermissionMode = "normal";
	let binding: ModeIdentity | undefined;
	let interactiveGrant = false;
	// A same-session revocation must not replay the global elevated preference.
	const seen = new WeakMap<object, Set<string>>();
	const observers = new Set<() => void>();
	const pendingCaptures = new Set<{ manager: ModeIdentity["manager"]; id: string }>();
	const primary = () => env.GENTLE_PI_AGENTS_CHILD !== "1";
	const interactive = (ctx: ExtensionContext): boolean => {
		if (!primary() || !ctx.hasUI) return false;
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		if (mode !== undefined) return mode === "tui";
		try { return (ctx.ui.getAllThemes?.().length ?? 0) > 0; } catch { return false; }
	};
	const session = (ctx: ExtensionContext): { manager: ModeIdentity["manager"]; id: string } | undefined => {
		try {
			const manager = ctx.sessionManager, id = manager.getSessionId();
			return manager && typeof id === "string" && id.length > 0 ? { manager, id } : undefined;
		} catch { return undefined; }
	};
	const remember = (scope: { manager: object; id: string }): void => {
		const ids = seen.get(scope.manager) ?? new Set<string>(); ids.add(scope.id); seen.set(scope.manager, ids);
	};
	const publish = (ctx: ExtensionContext): void => {
		const yolo = liveMode === "yolo";
		try { ctx.ui.setStatus(YOLO_STATUS_KEY, yolo ? YOLO_STATUS_TEXT : undefined); } catch { /* display only */ }
		try { ctx.ui.setWidget(YOLO_STATUS_KEY, yolo ? [YOLO_STATUS_TEXT] : undefined); } catch { /* display only */ }
		try { ctx.ui.setStatus(MODE_STATUS_KEY, `Permissions: ${liveMode.toUpperCase()}`); } catch { /* display only */ }
	};
	const changed = (ctx: ExtensionContext): void => {
		generation += 1; publish(ctx);
		try { options.onChange?.(); } catch { /* observer is not authority */ }
		for (const refresh of [...observers]) { try { refresh(); } catch { /* display only */ } }
	};
	const notify = (ctx: ExtensionContext, message: string, warning = false): void => {
		try { ctx.ui.notify(message, warning ? "warning" : "info"); } catch { /* headless/stale UI */ }
	};
	// Capture plain identity before async filesystem work; recheck after every await.
	const bindCurrent = (ctx: ExtensionContext, disposed = () => false, requireUI = true): (() => boolean) => {
		const owner = ownerGeneration, scope = session(ctx), cwd = ctx.cwd;
		return () => {
			try {
				const now = session(ctx);
				return !disposed() && owner === ownerGeneration && !!scope && !!now &&
					scope.manager === now.manager && scope.id === now.id && cwd === ctx.cwd &&
					(!requireUI || interactive(ctx));
			} catch { return false; }
		};
	};
	const capture = async (ctx: ExtensionContext): Promise<ModeIdentity | undefined> => {
		if (!primary()) return undefined;
		const scope = session(ctx), cwd = ctx.cwd, current = bindCurrent(ctx, () => false, false);
		if (!scope) return undefined;
		pendingCaptures.add(scope);
		try {
			const canonical = await realpath(cwd);
			if (!current()) return undefined;
			const clone = await resolveCanonicalGitRepositoryIdentity(canonical);
			if (!current()) return undefined;
			return { ...scope, workspace: clone ?? `cwd:${canonical}` };
		} catch { return undefined; }
		finally { pendingCaptures.delete(scope); }
	};
	const defaultMode = (): PermissionMode => resolvePermissionModePolicy(store).mode;
	const mode = async (ctx: ExtensionContext): Promise<PermissionMode> => {
		const epoch = generation;
		const identity = await capture(ctx);
		if (epoch !== generation) return "normal";
		if (binding && (!identity || binding.manager !== identity.manager || binding.id !== identity.id ||
			binding.workspace !== identity.workspace || (interactiveGrant && !interactive(ctx)))) {
			binding = undefined; liveMode = "normal"; interactiveGrant = false; changed(ctx);
		}
		if (!binding && identity) {
			const fresh = !seen.get(identity.manager)?.has(identity.id);
			remember(identity); binding = identity;
			if (fresh) { liveMode = defaultMode(); interactiveGrant = false; changed(ctx); }
		}
		publish(ctx);
		return identity && binding ? liveMode : "normal";
	};
	const active = async (ctx: ExtensionContext): Promise<boolean> => await mode(ctx) === "yolo";
	const reset = (ctx: ExtensionContext): void => {
		ownerGeneration += 1;
		// Initial session_start remains fresh; shutdown/reload of an observed session revokes.
		if (binding) remember(binding);
		const scope = session(ctx);
		if (scope && [...pendingCaptures].some(pending => pending.manager === scope.manager && pending.id === scope.id)) remember(scope);
		binding = undefined; liveMode = "normal"; interactiveGrant = false;
		changed(ctx); observers.clear();
	};
	const setMode = async (requested: PermissionMode, ctx: ExtensionContext, lifetime = () => true): Promise<boolean> => {
		if (!isPermissionMode(requested) || !interactive(ctx) || !lifetime()) return false;
		const current = bindCurrent(ctx, () => !lifetime());
		// Revoke immediately, including off versus a pending activation race.
		const scope = session(ctx); if (scope) remember(scope);
		binding = undefined; liveMode = "normal"; interactiveGrant = false; changed(ctx);
		const epoch = generation;
		const identity = await capture(ctx);
		if (!current() || epoch !== generation || !identity) return false;
		binding = identity; remember(identity); liveMode = requested; interactiveGrant = true; changed(ctx);
		if (requested === "auto") notify(ctx, AUTO_MODE_NOTICE);
		return true;
	};
	const saveDefault = async (requested: PermissionMode, ctx: ExtensionContext, lifetime = () => true): Promise<boolean> => {
		if (!isPermissionMode(requested) || !interactive(ctx) || !lifetime()) return false;
		const current = bindCurrent(ctx, () => !lifetime()), epoch = generation;
		const identity = await capture(ctx);
		if (!identity || !current() || epoch !== generation) return false;
		// Initialize before saving, without another await that could let a superseding
		// mode action authorize this stale save. Observer reentrancy is checked too.
		if (!binding || binding.manager !== identity.manager || binding.id !== identity.id || binding.workspace !== identity.workspace) {
			liveMode = seen.get(identity.manager)?.has(identity.id) ? "normal" : defaultMode();
			binding = identity; remember(identity); interactiveGrant = false; changed(ctx);
			if (!current() || generation !== epoch + 1) return false;
		}
		try { writePermissionModePolicy(requested, store); }
		catch { notify(ctx, "Default unchanged — permission mode preference is malformed, unreadable or could not be saved.", true); return false; }
		notify(ctx, `Default ${requested.toUpperCase()} saved for next primary sessions.${requested === "auto" ? ` ${AUTO_MODE_NOTICE}` : ""}`);
		for (const refresh of [...observers]) { try { refresh(); } catch { /* display only */ } }
		return true;
	};
	const humanAction = async (action: HumanAction, ctx: ExtensionContext, current = () => true): Promise<boolean> => {
		if (!current()) return false;
		const enable = action === HUMAN_ACTION.on || (action === HUMAN_ACTION.toggle && liveMode !== "yolo");
		const pending = setMode(enable ? "yolo" : "normal", ctx, current);
		const epoch = generation; // setMode revokes synchronously, then publishes once on success.
		const result = await pending;
		if (!current()) return false;
		// Supersession is not activation failure: the winning action owns notification.
		if (generation !== epoch + (result ? 1 : 0)) return true;
		notify(ctx, result ? enable ? YOLO_STATUS_TEXT : "YOLO OFF" :
			"YOLO OFF — activation requires an interactive primary TUI session and an identifiable workspace.", !result);
		return true;
	};
	pi.events?.on?.(HOST_UI_CHANNEL, (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const request = payload as Partial<HostUiRequest>;
		if (typeof request.respond !== "function" || !request.context) return;
		const ctx = request.context;
		try {
			let disposed = false;
			const subscriptions = new Set<() => void>();
			const current = bindCurrent(ctx, () => disposed);
			const read = async (): Promise<YoloDisplay> => {
				if (!current()) return YOLO_DISPLAY.unavailable;
				const epoch = generation, value = await mode(ctx);
				if (!current()) return YOLO_DISPLAY.unavailable;
				if (epoch !== generation) return read();
				return binding ? value === "yolo" ? YOLO_DISPLAY.on : YOLO_DISPLAY.off : YOLO_DISPLAY.unavailable;
			};
			request.respond({
				read,
				readSnapshot: async () => {
					const yolo = await read();
					return { yolo, mode: current() ? liveMode : "normal", defaultMode: defaultMode() };
				},
				readMode: async () => current() ? mode(ctx) : "normal",
				setMode: async value => setMode(value, ctx, current),
				readDefault: defaultMode,
				saveDefault: async value => saveDefault(value, ctx, current),
				toggle: async () => { await humanAction(HUMAN_ACTION.toggle, ctx, current); },
				observe: refresh => {
					if (!current()) return () => {};
					subscriptions.add(refresh); observers.add(refresh);
					return () => { subscriptions.delete(refresh); observers.delete(refresh); };
				},
				dispose: () => { disposed = true; for (const refresh of subscriptions) observers.delete(refresh); subscriptions.clear(); },
			});
		} catch { /* obsolete trusted context: discovery expires closed */ }
	});
	pi.registerCommand("gentle:mode", {
		description: "Permissions: normal|auto|yolo|status; default normal|auto|yolo saves for new primary sessions.",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/);
			if (!args.trim() || args.trim() === "status") {
				notify(ctx, `Permissions: ${(await mode(ctx)).toUpperCase()} — default: ${defaultMode().toUpperCase()}`); return;
			}
			if (words.length === 2 && words[0] === "default" && isPermissionMode(words[1])) {
				await saveDefault(words[1], ctx); return;
			}
			if (words.length === 1 && isPermissionMode(words[0])) {
				if (await setMode(words[0], ctx)) notify(ctx, `Permissions: ${words[0].toUpperCase()}`);
				else notify(ctx, "Mode unchanged — interactive primary session required or the session changed.", true);
				return;
			}
			notify(ctx, "Use /gentle:mode normal|auto|yolo|status or /gentle:mode default normal|auto|yolo. State unchanged.", true);
		},
	});
	pi.registerCommand("gentle:yolo", {
		description: "Ordinary development/delivery permission (enable|disable|status); no argument opens a menu. Destructive confirmations remain.",
		handler: async (args, ctx) => {
			let action = args.trim() || "status";
			let current = () => true;
			if (!args.trim() && ctx.hasUI && typeof ctx.ui.select === "function") {
				current = bindCurrent(ctx);
				const state = await active(ctx) ? YOLO_DISPLAY.on : YOLO_DISPLAY.off;
				const selected = await ctx.ui.select(`🚀 Gentle YOLO 🔥 — full speed, destructive actions still ask (current: ${state})`, ["enable", "disable", "status"]);
				if (selected === undefined) return;
				action = selected;
			}
			if (action !== "enable" && action !== "disable" && action !== "status") {
				notify(ctx, "Use /gentle:yolo enable|disable|status. State unchanged.", true); return;
			}
			if (action === "status") { notify(ctx, await active(ctx) ? YOLO_STATUS_TEXT : "YOLO OFF"); return; }
			if (await humanAction(action === "enable" ? HUMAN_ACTION.on : HUMAN_ACTION.off, ctx, current)) return;
			notify(ctx, "YOLO unchanged — the session changed while the menu was open.", true);
		},
	});
	return { active, mode, setMode, defaultMode, saveDefault, epoch: () => generation, humanAction, reset };
}
