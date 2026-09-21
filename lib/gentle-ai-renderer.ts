import { keyHint, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CARD_TONE, cardBottom, cardInnerWidth, cardLine, cardTop, type Card, type CardTheme, type CardTone } from "./shell-card.ts";
import { formatElapsed } from "./agents-widget.ts";
import { sanitizeTerminalText, stripAnsi } from "./terminal-theme.ts";

// Gentle AI tool cards: every call into the gentle-ai binary and every
// gentle_review tool draws the same card as the other Gentle notices. The
// call component owns the top rule; the result component closes the frame.

export interface GentleAiRenderTheme extends CardTheme {
	bg?(color: string, text: string): string;
}

export interface GentleAiRenderState {
	lifecycleComponent?: boolean;
	genericLocked?: boolean;
	/** Set by the result renderer once a final result exists, so a replayed
	 * call (which pi never marks as started) still shows its outcome. */
	finished?: boolean;
	failed?: boolean;
	/** Wall-clock ms of the first non-terminal observation and of the terminal
	 * freeze, so a replayed row still shows the true call duration. */
	startedAt?: number;
	endedAt?: number;
}

export interface GentleAiRenderContext {
	argsComplete?: boolean;
	executionStarted?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	lastComponent?: unknown;
	state?: unknown;
	invalidate?: () => void;
}

const LIFECYCLE_STATUS = {
	PREPARING: "preparing",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
} as const;

type LifecycleStatus = (typeof LIFECYCLE_STATUS)[keyof typeof LIFECYCLE_STATUS];

const STATUS_TONE: Record<LifecycleStatus, CardTone> = {
	[LIFECYCLE_STATUS.PREPARING]: CARD_TONE.WARNING,
	[LIFECYCLE_STATUS.RUNNING]: CARD_TONE.WARNING,
	[LIFECYCLE_STATUS.COMPLETED]: CARD_TONE.SUCCESS,
	[LIFECYCLE_STATUS.FAILED]: CARD_TONE.ERROR,
};

const CARD_TITLE = "Gentle AI";
// The binary keeps its rose; Gentle Shell notices keep the flower.
const CARD_GLYPH = "\u{1F339}\uFE0E";
const DETAIL_ROLE = "dim";
const HIDDEN_ROLE = "dim";
const passthroughTheme: CardTheme = { fg: (_color, text) => text };

export function getGentleAiRenderState(state: unknown): GentleAiRenderState | undefined {
	if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
	const rowState = state as Record<string, unknown>, existing = rowState.gentleAiRender;
	if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as GentleAiRenderState;
	return (rowState.gentleAiRender = {} as GentleAiRenderState);
}

// The call row: the top rule, with the expand key at its right end once the
// tool finished, and the command when expanded. pi renders the result
// component right below it, and that one closes the frame.
// The call card owns the top rule. While the execution is still running it
// also closes the frame, because no result row exists yet; once a final
// result is in, the result card closes it instead.
export class GentleAiCallCard {
	private card: Card = { title: CARD_TITLE, body: [], tone: CARD_TONE.WARNING };
	private theme: GentleAiRenderTheme = passthroughTheme;
	private detail: string | undefined;
	private hint: string | undefined;
	private elapsed = "";
	private open = true;

	update(status: LifecycleStatus, operationPath: string, theme: GentleAiRenderTheme, detail?: string, hint?: string, elapsed?: string): void {
		this.card = { title: CARD_TITLE, subtitle: `${status} · ${operationPath}`, body: [], tone: STATUS_TONE[status], glyph: CARD_GLYPH };
		this.theme = theme;
		this.detail = detail;
		this.hint = hint;
		this.elapsed = elapsed ?? "";
		this.open = status === LIFECYCLE_STATUS.RUNNING || status === LIFECYCLE_STATUS.PREPARING;
	}

	render(width: number): string[] {
		const lines = [cardTop(this.card, this.theme, width, this.hint)];
		if (this.detail) lines.push(cardLine(this.theme.fg(DETAIL_ROLE, this.detail), this.card.tone, this.theme, width));
		if (this.open) lines.push(cardBottom(this.card.tone, this.theme, width, this.elapsed || undefined));
		return lines;
	}

	invalidate(): void {}
}

// The result rows: the body when expanded, a count-only line when collapsed
// (the call card carries the expand key and the text stays hidden), and
// always the bottom rule that closes the frame. The rail follows the outcome:
// amber while partial, green when done, red on error.
export class GentleAiResultCard {
	private readonly text: string;
	private readonly expanded: boolean;
	private readonly tone: CardTone;
	private readonly theme: GentleAiRenderTheme;
	private readonly partial: boolean;
	private readonly elapsed: string;

	constructor(text: string, expanded: boolean, tone: CardTone, theme: GentleAiRenderTheme, partial = false, elapsed = "") {
		this.text = text;
		this.expanded = expanded;
		this.tone = tone;
		this.theme = theme;
		this.partial = partial;
		this.elapsed = elapsed;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.text.length > 0) {
			if (this.expanded) {
				const innerWidth = cardInnerWidth(width);
				for (const raw of this.text.split("\n")) {
					for (const line of raw === "" ? [""] : wrapTextWithAnsi(raw, innerWidth)) lines.push(cardLine(line, this.tone, this.theme, width));
				}
			} else {
				const count = this.text.split("\n").length;
				lines.push(cardLine(this.theme.fg(HIDDEN_ROLE, `${count} ${count === 1 ? "line" : "lines"}`), this.tone, this.theme, width));
			}
		}
		// A partial result sits under a running call card, which still closes the frame.
		if (!this.partial) lines.push(cardBottom(this.tone, this.theme, width, this.elapsed || undefined));
		return lines;
	}

	invalidate(): void {}
}

export interface GentleAiResultRenderOptions {
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
}

export function renderGentleAiResult(
	result: AgentToolResult<unknown>,
	options: GentleAiResultRenderOptions,
	theme: GentleAiRenderTheme = passthroughTheme,
	context?: GentleAiRenderContext,
): GentleAiResultCard {
	const textItems = result.content.flatMap((content) => (content.type === "text" ? [sanitizeTerminalText(content.text)] : []));
	const text = textItems.some((item) => item.length > 0) ? textItems.join("\n") : "";
	const tone = options.isError ? CARD_TONE.ERROR : options.isPartial ? CARD_TONE.WARNING : CARD_TONE.SUCCESS;
	const state = getGentleAiRenderState(context?.state);
	// The frozen duration rides the closing rule, right-aligned.
	let elapsed: string | undefined;
	if (state?.startedAt !== undefined && state.endedAt !== undefined) elapsed = formatElapsed(state.endedAt - state.startedAt);
	if (state && options.isPartial !== true) {
		const changed = state.finished !== true || state.failed !== (options.isError === true);
		state.finished = true;
		state.failed = options.isError === true;
		// pi's invalidate re-runs the tool display synchronously; called from
		// inside this render it would nest a second call+result pair into the
		// same container. Deferring it keeps one frame per execution.
		if (changed) queueMicrotask(() => context?.invalidate?.());
	}
	return new GentleAiResultCard(text, options.expanded === true, tone, theme, options.isPartial === true, elapsed ?? "");
}

export function renderGentleAiLifecycleCall(
	operationPath: string,
	theme: GentleAiRenderTheme,
	context?: GentleAiRenderContext,
	detail?: string,
	now: number = Date.now(),
): GentleAiCallCard {
	// A finished execution is completed even when pi replays it without
	// argsComplete (session reload); preparing only applies before it starts.
	const state = getGentleAiRenderState(context?.state);
	const finished = (context?.executionStarted === true && context.isPartial !== true) || state?.finished === true;
	const failed = context?.isError === true || state?.failed === true;
	const status: LifecycleStatus = failed
		? LIFECYCLE_STATUS.FAILED
		: finished
			? LIFECYCLE_STATUS.COMPLETED
			: context?.argsComplete === false
				? LIFECYCLE_STATUS.PREPARING
				: LIFECYCLE_STATUS.RUNNING;
	if (state) {
		if (status === LIFECYCLE_STATUS.COMPLETED || status === LIFECYCLE_STATUS.FAILED) {
			// A terminal observation without a start (replayed call, session reload)
			// has no true duration — leaving both unset keeps the card honest.
			if (state.startedAt !== undefined) state.endedAt ??= now;
		} else {
			state.startedAt ??= now;
		}
	}
	// Elapsed is live from the first observation: every re-render recomputes it
	// from now, and the terminal freeze keeps the final value stable.
	const elapsed = state?.startedAt === undefined ? "" : formatElapsed((state.endedAt ?? now) - state.startedAt);
	// Hint: the expand key only — the elapsed lives on the bottom rule.
	const expandHint = finished ? stripAnsi(keyHint("app.tools.expand", context?.expanded ? "to collapse" : "to expand")) : undefined;
	const hint = [expandHint].filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
	const component = context?.lastComponent instanceof GentleAiCallCard && (!state || state.lifecycleComponent === true)
		? context.lastComponent
		: new GentleAiCallCard();
	if (state) state.lifecycleComponent = true;
	component.update(status, operationPath, theme, detail ? sanitizeTerminalText(detail) : undefined, hint, elapsed);
	// While the call runs, wake the row once a second so the live duration ticks.
	if (status === LIFECYCLE_STATUS.RUNNING || status === LIFECYCLE_STATUS.PREPARING) {
		const timer = setTimeout(() => context?.invalidate?.(), 1000);
		timer.unref?.();
	}
	return component;
}
