import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendSystemPromptOnce, type AppendableSystemPromptOptions } from "./append-system-prompt.ts";
import { captureReviewSessionIdentity, sameReviewSessionIdentity, type ReviewSessionIdentity } from "./review-session-standing-permission.ts";

export const YOLO_STATUS_KEY = "gentle:yolo";
export const YOLO_STATUS_TEXT = "🚀 YOLO ON 🔥 — destructive confirmations remain";
export const YOLO_DIRECTIVE = `<gentle-yolo-session>
YOLO session standing permission is ON, explicitly activated by the human for this live primary session and Git clone.
Qualify the default commit, push and PR confirmation clauses: for ordinary already-scoped implementation, checks, commits, non-force pushes and PR creation, this activation supplies standing permission instead of repeated permission questions. Make ordinary reversible implementation choices without needless interviews.
This does NOT override explicit human restrictions, repository policy, project trust, configured confirmations or blocks, or the authorized task scope. Ask before scope expansion, privacy-sensitive disclosure, genuinely unresolved consequential product choices, or ambiguous destinations or credentials. Never invent destinations or credentials.
Destructive/data-loss confirmations remain mandatory and independent. Never auto-answer ask_user tools, provider consent, maintenance/recovery authorization or opaque-token decisions. Review standing permission and RDD are unchanged. Children remain bounded by their delegated task; they receive no independent delivery grant or YOLO inheritance.
</gentle-yolo-session>`;

/** Separate from review grants; no registry, entries, configuration or environment enable switch. */
export class YoloSessionPolicy {
	private grant: ReviewSessionIdentity | undefined;
	private generation = 0;

	get epoch(): number { return this.generation; }
	get enabled(): boolean { return this.grant !== undefined; }

	reset(): void {
		this.generation += 1;
		this.grant = undefined;
	}

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

/** Private trusted-extension discovery, never a model/tool or serialized authority event. */
const HOST_UI_CHANNEL = "gentle:yolo:host-ui";
const DISCOVERY_TIMEOUT_MS = 100;
export interface YoloUiAdapter {
	read(): Promise<YoloDisplay>;
	toggle(): Promise<void>;
	observe(refresh: () => void): () => void;
	dispose(): void;
}
interface HostUiRequest {
	context: ExtensionContext;
	respond(adapter: YoloUiAdapter): void;
}
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
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		try { pi.events.emit(HOST_UI_CHANNEL, { context, respond } satisfies HostUiRequest); }
		catch { settled = true; clearTimeout(timer); resolve(undefined); }
	});
}

export interface YoloSessionController {
	active(context: ExtensionContext): Promise<boolean>;
	humanAction(action: HumanAction, context: ExtensionContext, current?: () => boolean): Promise<boolean>;
	reset(context: ExtensionContext): void;
}

/** Register only a human slash command, never a tool, flag or persisted setting. */
export function registerYoloSessionPolicy(pi: ExtensionAPI, env: NodeJS.ProcessEnv): YoloSessionController {
	const policy = new YoloSessionPolicy();
	let ownerGeneration = 0;
	let publishedEpoch = policy.epoch;
	const observers = new Set<() => void>();
	const publish = (context: ExtensionContext, active: boolean): void => {
		// Display is not authority. Widgets survive shells that hide the status rail.
		try { context.ui.setStatus(YOLO_STATUS_KEY, active ? YOLO_STATUS_TEXT : undefined); } catch { /* nonblocking */ }
		try { context.ui.setWidget(YOLO_STATUS_KEY, active ? [YOLO_STATUS_TEXT] : undefined); } catch { /* nonblocking */ }
		// Repeated state reads publish indicators, but only a policy transition
		// wakes observers. active -> publish -> observer -> read thus terminates.
		if (publishedEpoch === policy.epoch) return;
		publishedEpoch = policy.epoch;
		for (const refresh of [...observers]) { try { refresh(); } catch { /* display only */ } }
	};
	const capture = async (context: ExtensionContext): Promise<ReviewSessionIdentity | undefined> => {
		try {
			const cwd = context.cwd;
			const identity = await captureReviewSessionIdentity(context, env);
			// Git lookup awaits: a replacement manager ID must not activate stale scope.
			return cwd === context.cwd && identity?.sessionManager === context.sessionManager &&
				identity?.sessionId === context.sessionManager.getSessionId() ? identity : undefined;
		} catch { return undefined; }
	};
	const active = async (context: ExtensionContext): Promise<boolean> => {
		const epoch = policy.epoch;
		const identity = policy.enabled ? await capture(context) : undefined;
		if (epoch !== policy.epoch) return false;
		const enabled = policy.active(identity);
		publish(context, enabled);
		return enabled;
	};
	// The owning extension calls this from its existing lifecycle hooks, including
	// reload. Keep their cardinality and ordering intact for SDK and legacy hosts.
	const reset = (context: ExtensionContext): void => {
		ownerGeneration += 1;
		policy.reset();
		publish(context, false);
		observers.clear();
	};
	// Binds an interaction to the session that opened it: a reload, replacement,
	// or cwd change while the human is deciding must not act on the new scope.
	const bindCurrent = (context: ExtensionContext, disposed = () => false): (() => boolean) => {
		const generation = ownerGeneration;
		const manager = context.sessionManager, sessionId = manager.getSessionId(), cwd = context.cwd;
		return () => {
			try { return !disposed() && generation === ownerGeneration && manager === context.sessionManager &&
				sessionId === manager.getSessionId() && cwd === context.cwd && context.hasUI; }
			catch { return false; } // SDK contexts throw after runtime replacement.
		};
	};
	// Both entry points execute this operation, including off/pending-on races.
	// Resolves false only when the interaction stopped being current, so the
	// caller can report the discarded choice; a superseding action stays silent.
	const humanAction = async (action: HumanAction, context: ExtensionContext, current = () => true): Promise<boolean> => {
		if (!current()) return false;
		if (action === HUMAN_ACTION.off) {
			policy.reset(); publish(context, false); context.ui.notify("YOLO OFF", "info");
			return true;
		}
		const wasEnabled = policy.enabled;
		policy.reset();
		publish(context, false);
		const epoch = policy.epoch;
		const identity = await capture(context);
		const enable = action === HUMAN_ACTION.on || !wasEnabled;
		if (!current()) return false;
		if (epoch !== policy.epoch) return true;
		const changed = policy.set(enable, identity, epoch);
		const enabled = changed && policy.active(identity);
		publish(context, enabled);
		context.ui.notify(enabled ? YOLO_STATUS_TEXT : enable
			? "YOLO OFF — activation requires an interactive primary TUI session and an identifiable Git clone."
			: "YOLO OFF", enabled || !enable ? "info" : "warning");
		return true;
	};
	// Legacy minimal hosts can run the command without an inter-extension bus;
	// they simply cannot expose the menu adapter.
	pi.events?.on?.(HOST_UI_CHANNEL, (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const request = payload as Partial<HostUiRequest>;
		if (typeof request.respond !== "function" || !request.context) return;
		const context = request.context;
		try {
			let disposed = false;
			const subscriptions = new Set<() => void>();
			const current = bindCurrent(context, () => disposed);
			const read = async (): Promise<YoloDisplay> => {
				if (!current()) return YOLO_DISPLAY.unavailable;
				const epoch = policy.epoch;
				const identity = await capture(context);
				if (!current()) return YOLO_DISPLAY.unavailable;
				if (epoch !== policy.epoch) return read(); // observe the winning off/on, never an old ON.
				const enabled = policy.active(identity);
				publish(context, enabled);
				return identity ? enabled ? YOLO_DISPLAY.on : YOLO_DISPLAY.off : YOLO_DISPLAY.unavailable;
			};
			request.respond({
				read,
				toggle: async () => { await humanAction(HUMAN_ACTION.toggle, context, current); },
				observe: (refresh) => {
					if (!current()) return () => {};
					subscriptions.add(refresh); observers.add(refresh);
					return () => { subscriptions.delete(refresh); observers.delete(refresh); };
				},
				dispose: () => {
					disposed = true;
					for (const refresh of subscriptions) observers.delete(refresh);
					subscriptions.clear();
				},
			});
		} catch { /* Missing or obsolete trusted host context: discovery expires closed. */ }
	});
	pi.registerCommand("gentle:yolo", {
		description: "Session-only ordinary development/delivery permission (enable|disable|status); no argument opens a menu. Destructive confirmations remain.",
		handler: async (args, context) => {
			let action = args.trim() || "status";
			let current = () => true;
			// Headless callers keep the status fallback: an empty argument never grants.
			if (!args.trim() && context.hasUI && typeof context.ui.select === "function") {
				current = bindCurrent(context);
				const state = await active(context) ? YOLO_DISPLAY.on : YOLO_DISPLAY.off;
				const selected = await context.ui.select(`🚀 Gentle YOLO 🔥 — full speed, destructive actions still ask (current: ${state})`, ["enable", "disable", "status"]);
				if (selected === undefined) return;
				action = selected;
			}
			if (action !== "enable" && action !== "disable" && action !== "status") {
				context.ui.notify("Use /gentle:yolo enable|disable|status. State unchanged.", "warning");
				return;
			}
			if (action === "status") {
				context.ui.notify(await active(context) ? YOLO_STATUS_TEXT : "YOLO OFF", "info");
				return;
			}
			if (await humanAction(action === "enable" ? HUMAN_ACTION.on : HUMAN_ACTION.off, context, current)) return;
			try { context.ui.notify("YOLO unchanged — the session changed while the menu was open.", "warning"); }
			catch { /* SDK contexts throw after runtime replacement. */ }
		},
	});
	return { active, humanAction, reset };
}
