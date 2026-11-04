import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { NativePointerRegion } from "../lib/native-pointer-region.ts";
import { paintHoverable, type HoverTheme } from "../lib/shell-hover.ts";
import {
	DEFAULT_STAR_PROMPT_STATE,
	DISMISS_CHORD,
	PROMPTS_BEFORE_ASKING,
	STAR_CHORD,
	STAR_PROMPT_IDLE_MS,
	STAR_PROMPT_REPOSITORY_URLS,
	STAR_PROMPT_VISIBLE_MS,
	ghStar,
	ghStarred,
	matchesStarPromptChord,
	openRepositoryInBrowser,
	readStarPromptState,
	shouldOfferStarPrompt,
	writeStarPromptState,
	type GhOutcome,
	type StarPromptState,
} from "../lib/star-prompt.ts";

type Unsubscribe = () => void;
type Timer = { cancel: () => void };

export interface StarPromptDeps {
	configHome?: string;
	readState?: (configHome: string) => { state: StarPromptState; unusable: boolean };
	writeState?: (configHome: string, state: StarPromptState) => void;
	/** Schedules the idle/visible waits; returns a canceller. Defaults to setTimeout. */
	schedule?: (ms: number, fn: () => void) => Timer;
	now?: () => number;
	ghStarred?: () => Promise<GhOutcome>;
	ghStar?: () => Promise<GhOutcome>;
	openRepository?: (url: string) => Promise<{ opened: boolean; error?: string }>;
	/** Skips offering entirely (headless environments). */
	headless?: boolean;
}

interface SessionRuntime {
	state: StarPromptState;
	unusable: boolean;
	offeredThisSession: boolean;
	agentRunning: boolean;
	visible: boolean;
	waitingIdle: boolean;
	lastInputAt: number;
}

const STATUS_KEY = "star-prompt";
const OFFER_TEXT = `Enjoying Gentle Shell? Ctrl+G stars both Gentleman-Programming repos (${STAR_PROMPT_REPOSITORY_URLS.map((url) => url.replace("https://", "")).join(" and ")}) on GitHub, Alt+D never asks again`;

const STAR_BUTTON = "[star]";
/** Longest first: the row shows the longest wording that fits whole, so no word
 * is ever cut, and the [star] button keeps working even when none fits. */
const OFFER_WORDINGS = [
	OFFER_TEXT,
	"Enjoying Gentle Shell? Ctrl+G stars gentle-shell and gentle-ai on GitHub, Alt+D never asks again",
	"Enjoying Gentle Shell? Ctrl+G stars us on GitHub, Alt+D never asks again",
	"Ctrl+G stars us on GitHub, Alt+D never asks again",
	"Ctrl+G star, Alt+D dismiss",
	"Ctrl+G star",
];

/** The one-row offer below the editor: the green offer text in the longest
 * wording that fits, then the [star] button right-aligned like the changes
 * row's /gentle:changes hint, with the shell's shared hover treatment.
 * Clicking it does exactly what Ctrl+G does. Mouse reports only arrive in
 * fullscreen; elsewhere the chords keep working. */
function offerRow(theme: HoverTheme, tui: { requestRender(): void }, onStar: () => void): Component & { handleMouse(event: TuiMouseEvent): unknown; dispose(): void } {
	let hovered = false;
	let buttonStart = -1;
	const row: Component = {
		render(width) {
			const buttonWidth = visibleWidth(STAR_BUTTON);
			if (width < buttonWidth) {
				buttonStart = -1;
				return [""];
			}
			const room = width - buttonWidth - 1;
			const text = OFFER_WORDINGS.find((wording) => visibleWidth(wording) <= room) ?? "";
			buttonStart = width - buttonWidth;
			const gap = " ".repeat(buttonStart - visibleWidth(text));
			return [`${text ? theme.fg("success", text) : ""}${gap}${paintHoverable(theme, STAR_BUTTON, hovered, "accent")}`];
		},
		invalidate() {
			hovered = false;
		},
	};
	const onButton = (event: TuiMouseEvent) => buttonStart >= 0 && event.x >= buttonStart && event.x < buttonStart + visibleWidth(STAR_BUTTON);
	const region = new NativePointerRegion(row, {
		onHover(event) {
			// The region spans the whole row, but only the button is clickable, so a
			// move over the offer text clears hover like leaving the row would.
			const next = onButton(event);
			if (next === hovered) return { handled: true };
			hovered = next;
			return { handled: true, render: true };
		},
		onLeave() {
			if (!hovered) return;
			hovered = false;
			tui.requestRender();
		},
		onClick(event) {
			if (event.button !== "left" || !onButton(event)) return undefined;
			onStar();
			return { handled: true, render: true };
		},
	});
	return {
		render: (width) => region.render(width),
		invalidate: () => region.invalidate(),
		handleMouse: (event) => region.handleMouse(event),
		dispose: () => region.dispose(),
	};
}

function defaultSchedule(ms: number, fn: () => void): Timer {
	const id = setTimeout(fn, ms);
	return { cancel: () => clearTimeout(id) };
}

/** Non-blocking GitHub star offer, cloned from t3code's GitHubStarPrompt courtesies:
 * asks only engaged users (after 5 sent prompts), only while idle with no agent
 * running, at most once per session, and never again after any dismissal — and
 * when state cannot be persisted it never asks at all. The star chord (or the
 * [star] button) stars through the authenticated gh account after that explicit
 * action, and opens the repository URLs only when gh cannot star. */
export function createStarPromptExtension(pi: ExtensionAPI, deps: StarPromptDeps = {}): void {
	const configHome = deps.configHome ?? gentlePiConfigHome();
	const schedule = deps.schedule ?? defaultSchedule;
	const now = deps.now ?? (() => Date.now());
	const runGhStarred = deps.ghStarred ?? (() => ghStarred());
	const runGhStar = deps.ghStar ?? (() => ghStar());
	const openRepository = deps.openRepository ?? ((url: string) => openRepositoryInBrowser(url));

	let runtime: SessionRuntime | undefined;
	let unsubscribeInput: Unsubscribe | undefined;
	let idleTimer: Timer | undefined;
	let visibleTimer: Timer | undefined;

	const readCurrent = (): SessionRuntime => {
		if (runtime) return runtime;
		const read = deps.readState ? deps.readState(configHome) : readStarPromptState(configHome);
		runtime = {
			state: read.state,
			unusable: read.unusable,
			offeredThisSession: false,
			agentRunning: false,
			visible: false,
			waitingIdle: false,
			lastInputAt: now(),
		};
		return runtime;
	};

	const clearTimers = () => {
		if (idleTimer) {
			idleTimer.cancel();
			idleTimer = undefined;
		}
		if (visibleTimer) {
			visibleTimer.cancel();
			visibleTimer = undefined;
		}
	};

	const hide = (ctx: ExtensionContext) => {
		clearTimers();
		if (runtime) runtime.visible = false;
		ctx.ui.setWidget(STATUS_KEY, undefined);
	};

	const persist = (ctx: ExtensionContext, next: StarPromptState): boolean => {
		try {
			if (deps.writeState) deps.writeState(configHome, next);
			else writeStarPromptState(configHome, next);
		} catch {
			// A dismissal that cannot be saved must disable asking (t3code courtesy).
			if (runtime) runtime.unusable = true;
			hide(ctx);
			return false;
		}
		if (runtime) runtime.state = next;
		return true;
	};

	const finishSession = () => {
		clearTimers();
		if (unsubscribeInput) {
			unsubscribeInput();
			unsubscribeInput = undefined;
		}
		runtime = undefined;
	};

	const starNow = async (ctx: ExtensionContext) => {
		const current = readCurrent();
		hide(ctx);
		current.offeredThisSession = true;
		if (await runGhStar() === "yes") {
			persist(ctx, { ...current.state, dismissed: true });
			ctx.ui.notify("Thanks for the stars! They really help both repos grow.", "info");
			return;
		}
		// Unknown or failed gh: fall through to the browser so the chord never dead-ends.
		const results = await Promise.all(STAR_PROMPT_REPOSITORY_URLS.map((url) => openRepository(url)));
		if (results.every((result) => result.opened)) persist(ctx, { ...current.state, dismissed: true });
		else ctx.ui.notify(`Could not open the browser (${results.find((r) => !r.opened)?.error ?? "unknown error"}). Star us at ${STAR_PROMPT_REPOSITORY_URLS.join(" and ")}`, "info");
	};

	const dismissForever = (ctx: ExtensionContext) => {
		const current = readCurrent();
		current.offeredThisSession = true;
		hide(ctx);
		persist(ctx, { ...current.state, dismissed: true });
	};

	const handleTerminalInput = (ctx: ExtensionContext) => (data: string): { consume?: boolean; data?: string } | undefined => {
		const current = readCurrent();
		current.lastInputAt = now();
		if (current.visible) {
			if (matchesStarPromptChord(data, STAR_CHORD)) {
				void starNow(ctx);
				return { consume: true };
			}
			if (matchesStarPromptChord(data, DISMISS_CHORD)) {
				dismissForever(ctx);
				return { consume: true };
			}
		}
		// Activity alone restarts the idle wait; typing is never consumed.
		if (!current.visible && idleTimer) armIdle(ctx, current);
		return undefined;
	};

	const offer = (ctx: ExtensionContext) => {
		const current = readCurrent();
		if (!shouldOfferStarPrompt({
			sent: current.state.sent,
			dismissed: current.state.dismissed,
			unusable: current.unusable,
			offeredThisSession: current.offeredThisSession,
			agentRunning: current.agentRunning,
		})) {
			return;
		}
		if (current.waitingIdle) return;
		current.waitingIdle = true;
		current.lastInputAt = now();
		if (!unsubscribeInput) unsubscribeInput = ctx.ui.onTerminalInput(handleTerminalInput(ctx));
		void runGhStarred().then((starred) => {
			if (runtime !== current) return;
			current.waitingIdle = false;
			if (starred === "yes") {
				current.offeredThisSession = true;
				persist(ctx, { ...current.state, dismissed: true });
				return;
			}
			if (starred === "unknown") {
				current.offeredThisSession = true;
				return;
			}
			// A pending idle wait (or a visible offer) already covers this session.
			if (idleTimer || current.visible) return;
			armIdle(ctx, current);
		});
	};

	/** One idle wait: when it fires still idle and uncontended, the footer shows the offer. */
	const armIdle = (ctx: ExtensionContext, current: SessionRuntime) => {
		if (idleTimer) idleTimer.cancel();
		idleTimer = schedule(STAR_PROMPT_IDLE_MS, () => {
			idleTimer = undefined;
			if (runtime !== current || current.agentRunning || current.visible || current.waitingIdle) return;
			if (now() - current.lastInputAt < STAR_PROMPT_IDLE_MS) {
				// A near-simultaneous keystroke won the race: wait out the new idle window.
				armIdle(ctx, current);
				return;
			}
			current.visible = true;
			// The success green of added lines in the changes view, so the offer stands out.
			ctx.ui.setWidget(STATUS_KEY, (tui, theme) => offerRow(theme, tui, () => void starNow(ctx)), { placement: "belowEditor" });
			visibleTimer = schedule(STAR_PROMPT_VISIBLE_MS, () => {
				if (runtime !== current) return;
				current.visible = false;
				current.offeredThisSession = true;
				ctx.ui.setWidget(STATUS_KEY, undefined);
			});
		});
	};

	pi.on("session_start", () => {
		finishSession();
		if (deps.headless) return;
		readCurrent();
	});
	pi.on("session_shutdown", () => {
		finishSession();
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const current = readCurrent();
		current.state = { ...current.state, sent: current.state.sent + 1 };
		current.lastInputAt = now();
		try {
			if (deps.writeState) deps.writeState(configHome, current.state);
			else writeStarPromptState(configHome, current.state);
		} catch {
			// A counter that cannot persist means no future dismissal can either.
			current.unusable = true;
		}
	});

	pi.on("agent_start", () => {
		readCurrent().agentRunning = true;
	});
	pi.on("agent_end", (_event, ctx) => {
		const current = readCurrent();
		current.agentRunning = false;
		offer(ctx);
	});
}

export const STAR_PROMPT_THRESHOLD = PROMPTS_BEFORE_ASKING;
export const STAR_PROMPT_DEFAULTS = DEFAULT_STAR_PROMPT_STATE;

export default function gentleStarPrompt(pi: ExtensionAPI): void {
	createStarPromptExtension(pi);
}
