import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { sidebarState } from "./shell-sidebar.ts";
import { appendSystemPromptOnce, type AppendableSystemPromptOptions } from "./append-system-prompt.ts";
import { sameReviewSessionIdentity, resolveCanonicalGitRepositoryIdentity, type ReviewSessionIdentity } from "./review-session-standing-permission.ts";
import { realpath } from "node:fs/promises";
import { gentlePiConfigHome } from "./agent-home.ts";
import { isInteractiveMode } from "./rpc-host.ts";
import { isPermissionMode, resolvePermissionModePolicy, writePermissionModePolicy, type PermissionMode } from "./permission-mode-policy.ts";
export type { PermissionMode } from "./permission-mode-policy.ts";
export const MODE_STATUS_KEY = "gentle:mode";
export const AUTO_MODE_NOTICE = "Auto uses additional model calls with separate usage accounting; hard safety and independent consent remain.";

export const YOLO_STATUS_KEY = "gentle:yolo";
export const YOLO_STATUS_TEXT = "🚀 YOLO ON 🔥 — destructive confirmations remain";
export const SUPER_YOLO_STATUS_TEXT = "💥 SUPER YOLO ON — no permission prompts; private paths stay blocked";
export const SUPER_YOLO_DIRECTIVE = `<gentle-super-yolo-session>
SUPER YOLO session standing permission is ON, authorized by the human for this live primary session and canonical workspace. No permission questions are asked in this mode: proceed through ordinary and destructive shell work (including rm, resets, force operations and configured-guard confirmations) without confirmation dialogs, and make implementation and delivery choices directly.
The ONLY hard line is private material: never read, print, copy, transmit or commit secrets or private credentials — .env files, .ssh, keychains, *.pem/*.key/*.p12/*.pfx, secrets/ directories, cloud credential files. If a task seems to need them, stop and ask the human.
This does NOT override explicit human restrictions in the live conversation, and never auto-answers permission-mode selections, ask_user tools, provider consent, maintenance/recovery authorization or opaque-token decisions. Children remain bounded by their delegated task; they receive no independent delivery grant or Super Yolo inheritance.
</gentle-super-yolo-session>`;
export const YOLO_DIRECTIVE = `<gentle-yolo-session>
YOLO session standing permission is ON, authorized by the human for this live primary session and canonical workspace (directly or through a trusted global default).
Qualify the default commit, push and PR confirmation clauses: for ordinary already-scoped implementation, checks, commits, non-force pushes and PR creation, this activation supplies standing permission instead of repeated permission questions. Make ordinary reversible implementation choices without needless interviews.
Quoted, cited, logged or analyzed destructive text is not an execution: the mandatory destructive confirmations apply only to commands this session actually runs, never to destructive commands appearing inside issue bodies, file contents, documentation, transcripts or command output. Reading and listing non-sensitive material outside the workspace — including Gentle AI's own skills, docs and configuration — is covered by this standing permission; do not ask permission for those reads. Sensitive-path and private-credential blocks still win.
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

/** Remove our exact blocks as well as adding them: bridge options can be reused. */
export function updateYoloPrompt(options: AppendableSystemPromptOptions | null | undefined, active: boolean, superActive = false): void {
	if (!options) return;
	options.appendSystemPrompt = (options.appendSystemPrompt ?? "")
		.replace(`\n\n${YOLO_DIRECTIVE}`, "").replace(YOLO_DIRECTIVE, "")
		.replace(`\n\n${SUPER_YOLO_DIRECTIVE}`, "").replace(SUPER_YOLO_DIRECTIVE, "");
	if (superActive) appendSystemPromptOnce(options, SUPER_YOLO_DIRECTIVE);
	else if (active) appendSystemPromptOnce(options, YOLO_DIRECTIVE);
}
const MODE_CHOICES: ReadonlyArray<{ mode: PermissionMode; label: string }> = [
	{ mode: "normal", label: "normal — standard permission prompts" },
	{ mode: "auto", label: "auto — independent checks; extra model calls" },
	{ mode: "yolo", label: "yolo — scoped work; destructive actions ask" },
	{ mode: "super-yolo", label: "super-yolo — no permission prompts; private paths blocked; consent remains" },
];
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
/**
 * The above-editor YOLO banner: the same padded text Pi draws for a string
 * widget, painted nothing while the IDE chrome's status bar already shows the
 * permission mode (sidebarState(tui).statusBarShowsMode).
 */
/**
 * The banner as a widget: the terminal UI gets the component that steps aside
 * behind the status bar; every other host (RPC forwards only string widgets,
 * e.g. the desktop app) keeps the plain string widget.
 */
export function yoloBannerContent(mode: string | undefined, text: string): string[] | ReturnType<typeof yoloBanner> {
	return mode === "tui" ? yoloBanner(text) : [text];
}

function yoloBanner(text: string) {
	return (tui: TUI) => {
		const banner = new Text(text, 1, 0);
		const quiet = () => Boolean((tui as { terminal?: unknown }).terminal && sidebarState(tui).statusBarShowsMode?.());
		return { render: (width: number) => (quiet() ? [] : banner.render(width)), invalidate: () => banner.invalidate() };
	};
}
export interface YoloSessionController {
	active(context: ExtensionContext): Promise<boolean>;
	superActive(context: ExtensionContext): Promise<boolean>;
	mode(context: ExtensionContext, admission?: { toolCallId: string }): Promise<PermissionMode>;
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
const sameModeIdentity = (left: ModeIdentity, right: ModeIdentity): boolean =>
	left.manager === right.manager && left.id === right.id && left.workspace === right.workspace;
/** UI/slash authoring only. Defaults are read from the dedicated trusted user store. */
export function registerYoloSessionPolicy(pi: ExtensionAPI, env: NodeJS.ProcessEnv,
	options: { onChange?: () => void; resolveIdentity?: typeof resolveCanonicalGitRepositoryIdentity } = {}): YoloSessionController {
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
	// Identity is re-captured for every tool admission: freshness is a security
	// invariant, so cross-admission reuse is never allowed (a mid-lookup mode
	// reselection must invalidate). Within one admission the redundant mode()
	// lookups of the same tool call share at most ONE capture, keyed by that
	// admission's tool call id; a different or absent id re-captures, and a
	// generation bump or cwd change still invalidates a shared slot.
	let capturedMode: (ModeIdentity & { cwd: string; generation: number; admission: string }) | undefined;
	// Rendered strings last published for each context; identical repaints are skipped.
	const published = new WeakMap<ExtensionContext, { yolo: string | undefined; modeText: string }>();
	const primary = () => env.GENTLE_PI_AGENTS_CHILD !== "1";
	// The TUI stays the standard interactive host. The Desktop app's own RPC
	// process is the other one, and only when it sets the interactive-host marker:
	// headless RPC children keep the marker stripped, so they stay closed exactly
	// as before. This is the single host admission every mutation below reuses.
	const interactive = (ctx: ExtensionContext): boolean => {
		if (!primary() || !ctx.hasUI) return false;
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		if (mode !== undefined) return isInteractiveMode(mode, env);
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
		const yolo = liveMode === "yolo" ? YOLO_STATUS_TEXT : liveMode === "super-yolo" ? SUPER_YOLO_STATUS_TEXT : undefined;
		const modeText = `Permissions: ${liveMode.toUpperCase()}`;
		const previous = published.get(ctx);
		if (previous && previous.yolo === yolo && previous.modeText === modeText) return;
		let painted = true;
		try { ctx.ui.setStatus(YOLO_STATUS_KEY, yolo); } catch { painted = false; /* display only */ }
		try {
			const banner = yolo ? yoloBannerContent(ctx.mode, yolo) : undefined;
			if (typeof banner === "function") ctx.ui.setWidget(YOLO_STATUS_KEY, banner);
			else ctx.ui.setWidget(YOLO_STATUS_KEY, banner);
		} catch { painted = false; /* display only */ }
		try { ctx.ui.setStatus(MODE_STATUS_KEY, modeText); } catch { painted = false; /* display only */ }
		if (painted) published.set(ctx, { yolo, modeText });
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
			const clone = await (options.resolveIdentity ?? resolveCanonicalGitRepositoryIdentity)(canonical);
			if (!current()) return undefined;
			return { ...scope, workspace: clone ?? `cwd:${canonical}` };
		} catch { return undefined; }
		finally { pendingCaptures.delete(scope); }
	};
	const defaultMode = (): PermissionMode => resolvePermissionModePolicy(store).mode;
	// Preview and initialization share the same fresh-session default rule.
	const initialMode = (identity: ModeIdentity): PermissionMode =>
		seen.get(identity.manager)?.has(identity.id) ? "normal" : defaultMode();
	const mode = async (ctx: ExtensionContext, admission?: { toolCallId: string }): Promise<PermissionMode> => {
		const scope = session(ctx);
		const admissionId = admission?.toolCallId;
		let identity: ModeIdentity | undefined;
		if (admissionId !== undefined && scope && capturedMode &&
			capturedMode.admission === admissionId && capturedMode.generation === generation &&
			capturedMode.manager === scope.manager && capturedMode.id === scope.id && capturedMode.cwd === ctx.cwd) identity = capturedMode;
		if (!identity) {
			const epoch = generation;
			identity = await capture(ctx);
			if (epoch !== generation) return "normal";
		}
		if (binding && (!identity || binding.manager !== identity.manager || binding.id !== identity.id ||
			binding.workspace !== identity.workspace || (interactiveGrant && !interactive(ctx)))) {
			binding = undefined; liveMode = "normal"; interactiveGrant = false; changed(ctx);
		}
		if (!binding && identity) {
			const fresh = !seen.get(identity.manager)?.has(identity.id);
			const initial = fresh ? initialMode(identity) : "normal";
			remember(identity); binding = identity;
			if (fresh) { liveMode = initial; interactiveGrant = false; changed(ctx); }
		}
		// Record after the binding pass: internal changed() bumps above must not strand
		// a cache entry stamped with a superseded generation. Only admission-keyed
		// lookups record; the slot is overwritten when a different admission id arrives.
		if (identity && scope && admissionId !== undefined) capturedMode = { ...identity, cwd: ctx.cwd, generation, admission: admissionId };
		publish(ctx);
		return identity && binding ? liveMode : "normal";
	};
	const active = async (ctx: ExtensionContext): Promise<boolean> => await mode(ctx) === "yolo";
	const superActive = async (ctx: ExtensionContext): Promise<boolean> => await mode(ctx) === "super-yolo";
	const reset = (ctx: ExtensionContext): void => {
		ownerGeneration += 1; capturedMode = undefined;
		// Initial session_start remains fresh; shutdown/reload of an observed session revokes.
		if (binding) remember(binding);
		const scope = session(ctx);
		if (scope && [...pendingCaptures].some(pending => pending.manager === scope.manager && pending.id === scope.id)) remember(scope);
		binding = undefined; liveMode = "normal"; interactiveGrant = false;
		changed(ctx); observers.clear();
	};
	const setMode = async (requested: PermissionMode, ctx: ExtensionContext, lifetime = () => true, expectedIdentity?: ModeIdentity): Promise<boolean> => {
		if (!isPermissionMode(requested) || !interactive(ctx) || !lifetime()) return false;
		const current = bindCurrent(ctx, () => !lifetime());
		// Revoke immediately, including off versus a pending activation race.
		const scope = session(ctx); if (scope) remember(scope);
		binding = undefined; liveMode = "normal"; interactiveGrant = false; changed(ctx);
		const epoch = generation;
		const identity = await capture(ctx);
		if (!current() || epoch !== generation || !identity || (expectedIdentity && !sameModeIdentity(expectedIdentity, identity))) return false;
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
		const enable = action === HUMAN_ACTION.on || (action === HUMAN_ACTION.toggle && liveMode !== "yolo" && liveMode !== "super-yolo");
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
				return binding ? value === "yolo" || value === "super-yolo" ? YOLO_DISPLAY.on : YOLO_DISPLAY.off : YOLO_DISPLAY.unavailable;
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
		description: "Permissions: normal|auto|yolo|super-yolo|status; default normal|auto|yolo|super-yolo saves for new primary sessions.",
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
				notify(ctx, "Use /gentle:mode normal|auto|yolo|super-yolo|status or /gentle:mode default normal|auto|yolo|super-yolo. State unchanged.", true);
		},
	});
	pi.registerCommand("gentle:yolo", {
		description: "Choose a session permission mode; enable|disable|status remain available as explicit shortcuts.",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (!args.trim() && interactive(ctx) && typeof ctx.ui.select === "function") {
				const current = bindCurrent(ctx), epoch = generation;
				const stale = () => notify(ctx, "YOLO unchanged — the session changed while the menu was open.", true);
				const identity = await capture(ctx);
				if (!current() || epoch !== generation || !identity) { stale(); return; }
				// Preview the effective default without initializing authority merely by opening a dialog.
				const state = binding && sameModeIdentity(binding, identity) ? liveMode : initialMode(identity);
				const selected = await ctx.ui.select(`Permissions for this session (current: ${state.toUpperCase()})`, MODE_CHOICES.map(choice => choice.label));
				if (selected === undefined) return;
				if (!current() || epoch !== generation) { stale(); return; }
				const choice = MODE_CHOICES.find(item => item.label === selected);
				if (!choice) { notify(ctx, "YOLO unchanged — invalid menu selection.", true); return; }
				const fresh = await capture(ctx);
				if (!current() || epoch !== generation || !fresh || !sameModeIdentity(identity, fresh)) { stale(); return; }
				if (await setMode(choice.mode, ctx, current, identity)) notify(ctx, `Permissions: ${choice.mode.toUpperCase()}`);
				else stale();
				return;
			}
			if (action !== "enable" && action !== "disable" && action !== "status") {
				notify(ctx, "Use /gentle:yolo enable|disable|status. State unchanged.", true); return;
			}
			if (action === "status") {
				const state = await mode(ctx);
				notify(ctx, state === "super-yolo" ? SUPER_YOLO_STATUS_TEXT : state === "yolo" ? YOLO_STATUS_TEXT : "YOLO OFF"); return;
			}
			await humanAction(action === "enable" ? HUMAN_ACTION.on : HUMAN_ACTION.off, ctx);
		},
	});
	return { active, superActive, mode, setMode, defaultMode, saveDefault, epoch: () => generation, humanAction, reset };
}
