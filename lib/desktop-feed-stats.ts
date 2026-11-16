// S13: the desktop feed's session stats, folded incrementally. A pi session
// only appends entries, so each flush folds the entries added since the last
// one instead of re-walking the whole history. Per-entry rules stay in
// collectSessionStats (lib/shell-stats.ts), which folds each new slice; this
// module only adds the slices together, so the result is the same as one
// collectSessionStats over every entry.

import { collectSessionStats, type ModelStats, type SessionStats } from "./shell-stats.ts";

interface Totals {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	first: number;
	last: number;
	models: Map<string, ModelStats>;
}

const empty = (): Totals => ({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, toolCalls: 0, toolErrors: 0, first: Infinity, last: -Infinity, models: new Map() });

// The same dating rule collectSessionStats applies to every entry (for the session span).
function entryTime(entry: unknown): number {
	const timestamp = (entry as { timestamp?: unknown } | null)?.timestamp;
	if (typeof timestamp === "string") return Date.parse(timestamp);
	return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Number.NaN;
}

function add(totals: Totals, part: SessionStats): void {
	totals.cost += part.cost;
	totals.input += part.input;
	totals.output += part.output;
	totals.cacheRead += part.cacheRead;
	totals.cacheWrite += part.cacheWrite;
	totals.turns += part.turns;
	totals.toolCalls += part.toolCalls;
	totals.toolErrors += part.toolErrors;
	for (const model of part.models) {
		const known = totals.models.get(model.model);
		if (known) { known.turns += model.turns; known.tokens += model.tokens; known.cost += model.cost; }
		else totals.models.set(model.model, { ...model });
	}
}

export interface SessionStatsFold {
	/** The stats of `entries`, folding only what was appended since the last call. */
	update(entries: readonly unknown[]): SessionStats;
}

export function createSessionStatsFold(): SessionStatsFold {
	let totals = empty();
	let count = 0;
	let tail: unknown;
	let result: SessionStats | undefined;
	return {
		update(entries) {
			// Not an extension of the history folded so far (another session, a rewrite): start over.
			if (entries.length < count || (count > 0 && entries[count - 1] !== tail)) {
				totals = empty();
				count = 0;
				result = undefined;
			}
			if (result && entries.length === count) return result;
			const slice = entries.slice(count);
			// One entry at a time after the first walk: sums keep the order of a full walk, so the
			// floating-point totals are the same ones collectSessionStats gives.
			for (const part of count === 0 ? [collectSessionStats(slice)] : slice.map((entry) => collectSessionStats([entry]))) add(totals, part);
			for (const entry of slice) {
				const at = entryTime(entry);
				if (Number.isFinite(at)) {
					totals.first = Math.min(totals.first, at);
					totals.last = Math.max(totals.last, at);
				}
			}
			count = entries.length;
			tail = entries[count - 1];
			const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
			result = {
				cost: totals.cost,
				input: totals.input,
				output: totals.output,
				cacheRead: totals.cacheRead,
				cacheWrite: totals.cacheWrite,
				turns: totals.turns,
				toolCalls: totals.toolCalls,
				toolErrors: totals.toolErrors,
				spanMs: totals.last > totals.first ? totals.last - totals.first : 0,
				cacheHitRate: prompt > 0 ? totals.cacheRead / prompt : undefined,
				models: [...totals.models.values()].map((model) => ({ ...model })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
			};
			return result;
		},
	};
}
