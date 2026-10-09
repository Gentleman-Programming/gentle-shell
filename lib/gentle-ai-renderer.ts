import { keyHint, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type GentleAiTimingLookup } from "./gentle-ai-elapsed-store.ts";
import { CARD_TONE, cardBodyRows, cardBottom, cardInnerWidth, cardLine, cardTop, floatRows, type Card, type CardTheme, type CardTone } from "./shell-card.ts";
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
	/** Wall-clock ms of the first LIVE non-terminal observation — replays never
	 * stamp a start — and of the terminal freeze, so a replayed row still shows
	 * the true call duration. */
	startedAt?: number;
	endedAt?: number;
	/** The row's single pending live-duration wake-up. Every render used to stack
	 * another untracked timer; a terminal render must leave none behind. */
	pendingTimer?: ReturnType<typeof setTimeout>;
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
	/** pi's stable id for this tool execution; keys the durable timing lookup. */
	toolCallId?: string;
	/** Durable timing source (session entries). pi's row `state` is render-local,
	 * so only this survives the fresh state a historical replay constructs. */
	elapsedTiming?: GentleAiTimingLookup;
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

// The title reads like the quiet read card: a short name, then the operation
// as its argument. Review operations are `rdd <op>`; any other binary call
// is `gentle-ai <op>`.
const REVIEW_PREFIX = "review";
const REVIEW_TITLE = "rdd";
const BINARY_TITLE = "gentle-ai";
const SEPARATOR = " · ";
// The binary keeps its rose as a colored emoji (2 cells, no text-presentation
// selector); Gentle Shell notices keep the flower.
const CARD_GLYPH = "\u{1F339}";
const DETAIL_ROLE = "dim";
const passthroughTheme: CardTheme = { fg: (_color, text) => text };

// The running/failed state stays visible until the call completes.
function callTitle(status: LifecycleStatus, operationPath: string): string {
	const review = operationPath === REVIEW_PREFIX || operationPath.startsWith(`${REVIEW_PREFIX} `);
	const name = review ? REVIEW_TITLE : BINARY_TITLE;
	const operation = review ? operationPath.slice(REVIEW_PREFIX.length).trim() : operationPath;
	const argument = [status === LIFECYCLE_STATUS.COMPLETED ? "" : status, operation].filter((part) => part.length > 0).join(SEPARATOR);
	return argument.length > 0 ? `${name} ${argument}` : name;
}

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
	private card: Card = { title: REVIEW_TITLE, body: [], tone: CARD_TONE.WARNING, glyph: CARD_GLYPH };
	private theme: GentleAiRenderTheme = passthroughTheme;
	private detail: string | undefined;
	private hint: string | undefined;
	private elapsed = "";
	private open = true;

	update(status: LifecycleStatus, operationPath: string, theme: GentleAiRenderTheme, detail?: string, hint?: string, elapsed?: string): void {
		this.card = { title: callTitle(status, operationPath), body: [], tone: STATUS_TONE[status], glyph: CARD_GLYPH };
		this.theme = theme;
		this.detail = detail;
		this.hint = hint;
		this.elapsed = elapsed ?? "";
		this.open = status === LIFECYCLE_STATUS.RUNNING || status === LIFECYCLE_STATUS.PREPARING;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		// The command detail belongs to the heading; the result below owns the body.
		return floatRows(this.card.tone, this.theme, width, (inner) => ({
			head: [cardTop(this.card, this.theme, inner, this.hint), ...(this.detail ? [cardLine(this.theme.fg(DETAIL_ROLE, this.detail), this.card.tone, this.theme, inner)] : [])],
			bottom: this.open ? cardBottom(this.card.tone, this.theme, inner, this.elapsed || undefined) : undefined,
		}));
	}

	invalidate(): void {}
}

// JSON envelopes collapse to one human line built from these fields, in this
// order, looked up at the top level and then inside `result`. Each group
// contributes its first present value. Schemas, hashes, bindings and command
// strings are never listed, so they never reach the summary.
const SUMMARY_FIELD_GROUPS: readonly (readonly string[])[] = [
	["status", "state"],
	["outcome"],
	["risk", "risk_tier", "riskLevel"],
	["action", "provider_action"],
	["next_transition.reason_code", "nextTransition.reasonCode", "next_transition", "nextTransition", "reason_code", "reasonCode", "diagnostics.error_code"],
	["diagnostics.message", "diagnostics.stderr", "error.message", "error", "reasons.0.detail", "reason", "message"],
];
const HASH_PATTERN = /^(?:sha256:)?[0-9a-f]{32,}$/i;

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		return isJsonObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function fieldAt(source: Record<string, unknown>, path: string): unknown {
	let value: unknown = source;
	for (const key of path.split(".")) {
		if (Array.isArray(value)) value = value[Number(key)];
		else if (isJsonObject(value)) value = value[key];
		else return undefined;
	}
	return value;
}

// One readable clause: first line, first sentence part, no nested "Error: "
// prefixes, and no control characters decoded from JSON escapes.
function summaryValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const clause = sanitizeTerminalText(value).split("\n")[0]!.split("; ")[0]!
		.replace(/(^|: )\w*Error: /g, "$1").replace(/\s+/g, " ").trim();
	return clause.length > 0 && !HASH_PATTERN.test(clause) ? clause : undefined;
}

export function summarizeJsonEnvelope(envelope: Record<string, unknown>): string {
	const scopes = isJsonObject(envelope.result) ? [envelope, envelope.result] : [envelope];
	const parts: string[] = [];
	for (const group of SUMMARY_FIELD_GROUPS) {
		const found = scopes.flatMap((scope) => group.map((path) => summaryValue(fieldAt(scope, path)))).find((part) => part !== undefined);
		if (found !== undefined && !parts.includes(found)) parts.push(found);
	}
	if (parts.length > 0) return parts.join(SEPARATOR);
	const count = Object.keys(envelope).length;
	return `${count} ${count === 1 ? "field" : "fields"}`;
}

// The result rows: complete output when expanded, a useful bounded preview
// when collapsed (the call card carries the expand key), and
// always the bottom rule that closes the frame. The rail follows the outcome:
// amber while partial, green when done, red on error. A JSON envelope
// collapses to one summary row and expands pretty-printed.
export class GentleAiResultCard {
	private readonly text: string;
	private readonly envelope: Record<string, unknown> | undefined;
	private readonly expanded: boolean;
	private readonly tone: CardTone;
	private readonly theme: GentleAiRenderTheme;
	private readonly partial: boolean;
	private readonly elapsed: string;

	constructor(text: string, expanded: boolean, tone: CardTone, theme: GentleAiRenderTheme, partial = false, elapsed = "") {
		this.envelope = parseJsonObject(text);
		this.text = this.envelope !== undefined && expanded ? JSON.stringify(this.envelope, null, 2) : text;
		this.expanded = expanded;
		this.tone = tone;
		this.theme = theme;
		this.partial = partial;
		this.elapsed = elapsed;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const role = this.tone === CARD_TONE.ERROR ? "error" : "toolOutput";
		// A partial result sits under a running call card, which still closes the
		// frame; there, the call's closing row already separates the body.
		return floatRows(this.tone, this.theme, width, (inner) => ({
			body: this.body(inner, role),
			bottom: this.partial ? undefined : cardBottom(this.tone, this.theme, inner, this.elapsed || undefined),
			afterHeading: !this.partial,
		}));
	}

	private body(width: number, role: string): string[] {
		if (this.envelope !== undefined && !this.expanded) {
			const summary = truncateToWidth(summarizeJsonEnvelope(this.envelope), cardInnerWidth(width), "…");
			return [cardLine(this.theme.fg(role, summary), this.tone, this.theme, width)];
		}
		const rows = this.text.length > 0 ? this.text.split("\n") : [];
		const useful = this.expanded ? rows : rows.filter((row) => stripAnsi(row).trim().length > 0);
		return cardBodyRows(useful.map((row) => this.theme.fg(role, row)), this.tone, this.theme, width, {
			expanded: this.expanded, previewRows: 3,
		});
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
	const isError = context?.isError ?? options.isError ?? false;
	const tone = isError ? CARD_TONE.ERROR : options.isPartial ? CARD_TONE.WARNING : CARD_TONE.SUCCESS;
	const state = getGentleAiRenderState(context?.state);
	// The frozen duration rides the closing rule, right-aligned.
	let elapsed: string | undefined;
	if (state?.startedAt !== undefined && state.endedAt !== undefined) elapsed = formatElapsed(state.endedAt - state.startedAt);
	if (state && options.isPartial !== true) {
		const changed = state.finished !== true || state.failed !== isError;
		state.finished = true;
		state.failed = isError;
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
	// Durable timestamps live in session entries; the row state is render-local
	// and a replay constructs a fresh one. Seed from the durable record for this
	// tool call; without one the stamps stay unset and the card stays honest.
	if (state && state.startedAt === undefined && state.endedAt === undefined && typeof context?.toolCallId === "string") {
		const durable = context.elapsedTiming?.lookup(context.toolCallId);
		// Only a complete start+end record restores: a start-only record has no
		// honest duration, and seeding its start would make a replayed card tick
		// against the replay clock instead of the execution that ended long ago.
		if (durable?.endedAt !== undefined) {
			state.startedAt = durable.startedAt;
			state.endedAt = durable.endedAt;
		}
	}
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
			// Only a live terminal observation may freeze the end (pi never raises
			// executionStarted on replayed rows): a replayed start-only record would
			// otherwise grow an invented end at replay time.
			if (state.startedAt !== undefined && context?.executionStarted === true) state.endedAt ??= now;
		} else if ((status === LIFECYCLE_STATUS.RUNNING && context?.argsComplete === true) || context?.executionStarted === true) {
			// Stamp only on live evidence: a live running row carries argsComplete
			// (true), while a replayed row omits it entirely — an unexplained RUNNING
			// on a historical row must not fabricate a start. executionStarted never
			// fires on replays.
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
	// At most one pending timer per row: frequent renders must not stack
	// independent invalidation chains, and none may outlive the terminal render.
	if (state) {
		if (state.pendingTimer !== undefined) clearTimeout(state.pendingTimer);
		if ((status === LIFECYCLE_STATUS.RUNNING || status === LIFECYCLE_STATUS.PREPARING) && state.startedAt !== undefined && state.endedAt === undefined) {
			state.pendingTimer = setTimeout(() => {
				state.pendingTimer = undefined;
				context?.invalidate?.();
			}, 1000);
			state.pendingTimer.unref?.();
		} else {
			state.pendingTimer = undefined;
		}
	}
	return component;
}
