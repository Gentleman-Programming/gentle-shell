import type { ProjectMapCapabilityV1, ProjectMapV1 } from "./shell-project-map-schema.ts";

/**
 * The display order of the derived card's rows.
 *
 * A capability's label carries the functional-point code it was declared with (`FP-9 — …`), but the
 * identifier is normalized from the title *after* the separator, so the code never reaches the
 * canonical order. The artifact stays canonical by identifier — this module reorders only the
 * projection the card, the `show` notification and the selection keys read, so that a reader walks
 * `FP-0, FP-1, FP-2, …` instead of an alphabetical accident of the titles.
 *
 * This is a projection, never a source of truth: it reads `outcome` and returns a new map. It
 * changes no field of any capability, and a map it did not reorder is returned byte-comparable.
 */

/**
 * The code a label declares: the head before the first separator, or the whole label when the label
 * carries no separator — the same reading `splitWorkUnitLabel` uses to name a work unit.
 */
function labelCode(outcome: string): string {
	const separator = outcome.indexOf("—");
	return separator === -1 ? outcome.trim() : outcome.slice(0, separator).trim();
}

/**
 * Whether a label head is a functional-point code: no whitespace, at least one digit, and the digits
 * that close it are exactly the code's numeric tail (`FP-0`, `FP-1-2`, `T1`, `HOR-2`). A head that
 * ends in a letter is a sub-element's code, not a row's, so it is not a row code here either.
 */
function isRowCode(code: string): boolean {
	return code.length > 0 && !/\s/u.test(code) && /^\S*?\d+(?:-\d+)*$/u.test(code);
}

/** Exact numeric comparison of two digit runs, immune to float precision and to leading zeros. */
function compareDigitRuns(left: string, right: string): number {
	const trimmedLeft = left.replace(/^0+(?=\d)/u, "");
	const trimmedRight = right.replace(/^0+(?=\d)/u, "");
	if (trimmedLeft.length !== trimmedRight.length) return trimmedLeft.length < trimmedRight.length ? -1 : 1;
	return trimmedLeft < trimmedRight ? -1 : trimmedLeft > trimmedRight ? 1 : 0;
}

/** Natural comparison: digit runs are numbers, everything else is compared by code point. */
function compareNatural(left: string, right: string): number {
	const leftParts = left.match(/\d+|\D+/gu) ?? [];
	const rightParts = right.match(/\d+|\D+/gu) ?? [];
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;
		const bothDigits = /^\d+$/u.test(leftPart) && /^\d+$/u.test(rightPart);
		const compared = bothDigits ? compareDigitRuns(leftPart, rightPart) : leftPart < rightPart ? -1 : 1;
		if (compared !== 0) return compared;
	}
	return 0;
}

/**
 * Orders two capabilities for display. Coded rows come first, in natural code order; a tie — two
 * documents declaring the same code, which the map reports as a collision — keeps identifier order so
 * the result stays deterministic. Uncoded rows follow, in identifier order, because a list of one's
 * own order beats an invented one.
 */
export function compareCapabilitiesForDisplay(left: ProjectMapCapabilityV1, right: ProjectMapCapabilityV1): number {
	const leftCode = labelCode(left.outcome);
	const rightCode = labelCode(right.outcome);
	const leftIsCode = isRowCode(leftCode);
	const rightIsCode = isRowCode(rightCode);
	if (leftIsCode !== rightIsCode) return leftIsCode ? -1 : 1;
	if (leftIsCode && rightIsCode) {
		const compared = compareNatural(leftCode, rightCode);
		if (compared !== 0) return compared;
	}
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** The map as the display reads it: same facts, rows in functional-point order. */
export function orderCapabilitiesForDisplay(map: ProjectMapV1): ProjectMapV1 {
	return { ...map, capabilities: [...map.capabilities].sort(compareCapabilitiesForDisplay) };
}
