import { isKeyRelease } from "@earendil-works/pi-tui";

// Hold-Space detection for push-to-talk dictation (S1). With Pi's keyboard
// flags a terminal reports Space as plain text and never reports its release,
// so a hold is recognized from OS key auto-repeat, and a release from a gap in
// that repeat. Auto-repeat has a cadence that typing does not: a long initial
// delay (macOS at least about 225 ms, X11 660 ms by default), then short,
// regular repeats. Spaces typed by hand, even fast or in an indent, lack the
// long first gap or the regular short ones, so they never confirm a hold.
//
// Pi's input listeners can consume a chunk or replace it, but cannot inject
// input later, so a held-back space could never be typed again exactly as the
// user typed it. Every space therefore goes to the editor untouched: a tap, a
// double space or a space followed by a letter types exactly as without this
// feature. A hold is confirmed only after a first gap of auto-repeat delay and
// `holdRepeats` short, regular repeats, each verified to have added exactly one
// space to the draft. The following repeats are then rewritten into Backspace,
// through the editor's own key path, until the spaces the hold typed are gone
// (one is kept as a separator when the hold followed a word), and later
// repeats are consumed. A draft
// that changes in any other way (Vim NORMAL mode, where Space is a motion;
// autocomplete; another key) stops the run or the erase and never removes
// anything else.

export interface PushToTalkConfig {
	firstRepeatWindowMs: number;
	minFirstGapMs: number;
	maxRepeatGapMs: number;
	maxRepeatSpread: number;
	minDelayRatio: number;
	holdRepeats: number;
	releaseGapFactor: number;
	minReleaseGapMs: number;
	maxReleaseGapMs: number;
}

export const PUSH_TO_TALK_DEFAULTS: Readonly<PushToTalkConfig> = Object.freeze({
	// The first gap (first space to first repeat) must fall within
	// [minFirstGapMs, firstRepeatWindowMs]: the OS initial repeat delay.
	firstRepeatWindowMs: 1000,
	minFirstGapMs: 180,
	// Each repeat gap is at most this long, and the slowest of the last
	// `holdRepeats` gaps is at most `maxRepeatSpread` times the fastest.
	maxRepeatGapMs: 250,
	maxRepeatSpread: 1.6,
	// The first gap is at least this many times the slowest repeat gap, so an
	// evenly paced run of typed spaces is not auto-repeat.
	minDelayRatio: 1.5,
	holdRepeats: 3,
	// No repeat for this many observed repeat intervals, clamped, is a release.
	releaseGapFactor: 2.5,
	minReleaseGapMs: 150,
	maxReleaseGapMs: 400,
});

export interface PushToTalkTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
	// Runs after input that is already queued (setImmediate in production).
	defer(callback: () => void): void;
}

export type PushToTalkOptions = Partial<PushToTalkConfig> & { timers?: PushToTalkTimers };

export interface PushToTalkHandlers {
	// The current editor draft, read before the chunk reaches the editor.
	readDraft(): string;
	// A hold was detected; returns true when a dictation started. While it
	// returns false the spaces keep typing and the next repeat asks again.
	onHold(): boolean;
	// Space was released after a started hold.
	onRelease(): void;
}

export type PushToTalkInputResult = { consume?: boolean; data?: string } | undefined;

const SPACE = " ";
const BACKSPACE = "\x7f";

// Where `after` is `before` with exactly `count` spaces inserted at one place,
// or -1. With spaces next to the insertion the place is ambiguous; this is the
// rightmost one, which is right when typing at the end of the draft.
export function addedSpacesAt(before: string, after: string, count: number): number {
	if (after.length !== before.length + count) return -1;
	let index = 0;
	while (index < before.length && before[index] === after[index]) index++;
	return after.slice(index, index + count) === SPACE.repeat(count) && after.slice(index + count) === before.slice(index) ? index : -1;
}

export const addedSpaces = (before: string, after: string, count: number): boolean => addedSpacesAt(before, after, count) >= 0;

type Phase =
	| { kind: "idle" }
	// Spaces typed so far in this press, verified against the draft before it.
	| { kind: "run"; before: string; typed: number; last: number; firstGap?: number; gaps: number[] }
	// `erase` spaces left to remove; `keep` (0 or 1) stays as a separator.
	| { kind: "holding"; before: string; erase: number; keep: number; releaseGapMs: number };

const IDLE: Phase = { kind: "idle" };

export class SpaceHoldDetector {
	private phase: Phase = IDLE;
	private timer: unknown;
	private disposed = false;
	private readonly handlers: PushToTalkHandlers;
	private readonly config: PushToTalkConfig;
	private readonly timers: PushToTalkTimers;

	constructor(handlers: PushToTalkHandlers, options: PushToTalkOptions = {}) {
		this.handlers = handlers;
		const { timers, ...config } = options;
		this.config = { ...PUSH_TO_TALK_DEFAULTS, ...config, holdRepeats: Math.max(1, config.holdRepeats ?? PUSH_TO_TALK_DEFAULTS.holdRepeats) };
		this.timers = timers ?? {
			setTimeout: (callback, ms) => setTimeout(callback, ms),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			now: () => performance.now(),
			defer: (callback) => { setImmediate(callback); },
		};
	}

	get holding(): boolean {
		return this.phase.kind === "holding";
	}

	handleInput(data: string): PushToTalkInputResult {
		if (this.disposed || isKeyRelease(data)) return undefined;
		if (data !== SPACE) {
			if (this.phase.kind === "holding") this.phase.erase = 0;
			else this.reset();
			return undefined;
		}
		const phase = this.phase;
		if (phase.kind === "holding") return this.whileHolding();
		const now = this.timers.now();
		const draft = this.draft();
		if (draft === undefined) {
			this.reset();
			return undefined;
		}
		// A space that does not continue an auto-repeat run starts a new one:
		// earlier spaces become part of the draft before it and are never erased.
		if (phase.kind === "idle" || !this.continues(phase, draft, now - phase.last)) return this.startRun(draft, now);
		const gap = now - phase.last;
		phase.last = now;
		if (phase.firstGap === undefined) phase.firstGap = gap;
		else phase.gaps = [...phase.gaps, gap].slice(-this.config.holdRepeats);
		if (this.isAutoRepeat(phase) && this.askHold()) {
			const at = addedSpacesAt(phase.before, draft, phase.typed);
			// After a word, the first hold space stays as the separator.
			const keep = at > 0 && !/\s/.test(phase.before[at - 1]!) ? 1 : 0;
			const interval = Math.max(...phase.gaps);
			const { releaseGapFactor, minReleaseGapMs, maxReleaseGapMs } = this.config;
			const releaseGapMs = Math.min(maxReleaseGapMs, Math.max(minReleaseGapMs, Math.round(interval * releaseGapFactor)));
			this.phase = { kind: "holding", before: phase.before, erase: phase.typed - keep, keep, releaseGapMs };
			return this.whileHolding();
		}
		if (this.disposed) return undefined;
		phase.typed++;
		this.schedule(this.config.maxRepeatGapMs, () => this.reset());
		return undefined;
	}

	// Leaves a hold (or a run) without reporting a release.
	end(): void {
		this.reset();
	}

	dispose(): void {
		this.reset();
		this.disposed = true;
	}

	private startRun(before: string, now: number): PushToTalkInputResult {
		this.phase = { kind: "run", before, typed: 1, last: now, gaps: [] };
		this.schedule(this.config.firstRepeatWindowMs, () => this.reset());
		return undefined;
	}

	// Whether this space can be the next auto-repeat of the run.
	private continues(phase: Extract<Phase, { kind: "run" }>, draft: string, gap: number): boolean {
		if (!addedSpaces(phase.before, draft, phase.typed)) return false;
		if (phase.firstGap === undefined) return gap >= this.config.minFirstGapMs && gap <= this.config.firstRepeatWindowMs;
		return gap <= this.config.maxRepeatGapMs;
	}

	private isAutoRepeat(phase: Extract<Phase, { kind: "run" }>): boolean {
		const { holdRepeats, maxRepeatSpread, minDelayRatio } = this.config;
		if (phase.firstGap === undefined || phase.gaps.length < holdRepeats) return false;
		const slowest = Math.max(...phase.gaps);
		const fastest = Math.min(...phase.gaps);
		return slowest <= Math.max(fastest, 1) * maxRepeatSpread && phase.firstGap >= slowest * minDelayRatio;
	}

	private whileHolding(): PushToTalkInputResult {
		const phase = this.phase;
		if (phase.kind !== "holding") return undefined;
		this.schedule(phase.releaseGapMs, () => this.maybeRelease());
		const draft = this.draft();
		if (phase.erase > 0 && draft !== undefined && addedSpaces(phase.before, draft, phase.erase + phase.keep)) {
			phase.erase--;
			return { data: BACKSPACE };
		}
		phase.erase = 0;
		return { consume: true };
	}

	// The release timer can fire before input that queued up while the event
	// loop was blocked; deciding after that input means a late repeat wins.
	private maybeRelease(): void {
		const phase = this.phase;
		this.timers.defer(() => {
			// A repeat in between rescheduled the timer; end() or dispose() left the hold.
			if (this.phase !== phase || this.timer !== undefined || this.disposed) return;
			this.release();
		});
	}

	private release(): void {
		this.phase = IDLE;
		try {
			this.handlers.onRelease();
		} catch {
			/* the owner reports its own failures */
		}
	}

	private askHold(): boolean {
		try {
			return this.handlers.onHold() === true;
		} catch {
			return false;
		}
	}

	private draft(): string | undefined {
		try {
			return this.handlers.readDraft();
		} catch {
			return undefined;
		}
	}

	private schedule(ms: number, callback: () => void): void {
		this.clear();
		if (this.disposed) return;
		this.timer = this.timers.setTimeout(() => {
			this.timer = undefined;
			callback();
		}, ms);
	}

	private clear(): void {
		if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
		this.timer = undefined;
	}

	private reset(): void {
		this.clear();
		this.phase = IDLE;
	}
}
