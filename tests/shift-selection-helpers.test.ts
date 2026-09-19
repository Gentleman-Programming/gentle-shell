/**
 * Unit tests for the pure helpers exported by extensions/shift-selection-extension/index.ts.
 * Complements tests/shift-selection-editor.test.ts (behavioral tests through handleInput/render).
 */
import { describe, test } from "node:test";
import { clamp, escapeSequenceLength, isSgrReset, withReverseSpan } from "../extensions/shift-selection-extension/index.ts";
import assert from "node:assert/strict";

// Minimal bun-style expect over node:assert so the ported suite stays 1:1
// with the original bun:test sources.
function expect(actual: unknown): {
	toBe: (expected: unknown) => void;
	toEqual: (expected: unknown) => void;
	toContain: (fragment: string) => void;
	toBeNull: () => void;
	toBeUndefined: () => void;
	toBeDefined: () => void;
	toHaveLength: (length: number) => void;
	toBeGreaterThan: (minimum: number) => void;
	toBeGreaterThanOrEqual: (minimum: number) => void;
	not: {
		toBe: (expected: unknown) => void;
		toEqual: (expected: unknown) => void;
		toContain: (fragment: string) => void;
		toBeNull: () => void;
		toThrow: () => void;
	};
} {
	const check = (positive: boolean) => ({
		toBe: (expected: unknown) => {
			if (positive) assert.strictEqual(actual, expected);
			else assert.notStrictEqual(actual, expected);
		},
		toEqual: (expected: unknown) => {
			if (positive) assert.deepStrictEqual(actual, expected);
			else assert.notDeepStrictEqual(actual, expected);
		},
		toContain: (fragment: string) => {
			const hit = Array.isArray(actual)
				? actual.includes(fragment as unknown as never)
				: typeof actual === "string" && actual.includes(fragment);
			const message = `expected ${JSON.stringify(actual)} ${positive ? "to contain" : "not to contain"} ${JSON.stringify(fragment)}`;
			assert.ok(positive ? hit : !hit, message);
		},
		toBeNull: () => {
			if (positive) assert.strictEqual(actual, null);
			else assert.notStrictEqual(actual, null);
		},
		toBeUndefined: () => {
			if (positive) assert.strictEqual(actual, undefined);
			else assert.notStrictEqual(actual, undefined);
		},
		toBeDefined: () => {
			if (positive) assert.notStrictEqual(actual, undefined);
			else assert.strictEqual(actual, undefined);
		},
		toHaveLength: (length: number) => {
			const actualLength = (actual as unknown as { length?: number })?.length;
			const message = `expected length ${String(actualLength)} ${positive ? "to be" : "not to be"} ${length}`;
			assert.ok(positive ? actualLength === length : actualLength !== length, message);
		},
		toBeGreaterThanOrEqual: (minimum: number) => {
			const hit = typeof actual === "number" && actual >= minimum;
			assert.ok(positive ? hit : !hit, `expected ${String(actual)} to be at least ${minimum}`);
		},
		toBeGreaterThan: (minimum: number) => {
			const hit = typeof actual === "number" && actual > minimum;
			assert.ok(positive ? hit : !hit, `expected ${String(actual)} to be greater than ${minimum}`);
		},
	});
	const positive = check(true);
	return {
		...positive,
		not: {
			...check(false),
			toThrow: () => {
				assert.doesNotThrow(() => (actual as unknown as () => void)());
			},
		},
	};
}



describe("clamp", () => {
	test("returns the value when inside the range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});

	test("clamps below the lower bound", () => {
		expect(clamp(-3, 0, 10)).toBe(0);
	});

	test("clamps above the upper bound", () => {
		expect(clamp(99, 0, 10)).toBe(10);
	});

	test("keeps exact bounds", () => {
		expect(clamp(0, 0, 10)).toBe(0);
		expect(clamp(10, 0, 10)).toBe(10);
	});
});

describe("isSgrReset", () => {
	test("true for the full reset sequence", () => {
		expect(isSgrReset("\x1b[0m")).toBe(true);
	});

	test("true for the empty-parameter reset", () => {
		expect(isSgrReset("\x1b[m")).toBe(true);
	});

	test("true for a leading-zero multi-parameter reset (reset, then more attributes)", () => {
		expect(isSgrReset("\x1b[0;31m")).toBe(true);
	});

	test("false for other SGR sequences", () => {
		expect(isSgrReset("\x1b[31m")).toBe(false);
		expect(isSgrReset("\x1b[1m")).toBe(false);
		expect(isSgrReset("\x1b[7m")).toBe(false);
		expect(isSgrReset("\x1b[38;5;9m")).toBe(false);
	});

	test("false for truncated or non-SGR input", () => {
		expect(isSgrReset("\x1b[0")).toBe(false);
		expect(isSgrReset("0m")).toBe(false);
		expect(isSgrReset("")).toBe(false);
	});
});

describe("escapeSequenceLength", () => {
	test("CSI sequence ending in a letter final byte", () => {
		expect(escapeSequenceLength("\x1b[7mabc", 0)).toBe(4);
		expect(escapeSequenceLength("\x1b[1;2H", 0)).toBe(6);
		expect(escapeSequenceLength("x\x1b[3~y", 1)).toBe(4);
	});

	test("unterminated CSI consumes the rest of the string", () => {
		expect(escapeSequenceLength("\x1b[12", 0)).toBe(4);
		expect(escapeSequenceLength("\x1b[", 0)).toBe(2);
	});

	test("OSC terminated by BEL", () => {
		expect(escapeSequenceLength("\x1b]0;title\x07rest", 0)).toBe(10);
	});

	test("OSC terminated by ST (ESC backslash)", () => {
		expect(escapeSequenceLength("\x1b]0;t\x1b\\rest", 0)).toBe(7);
	});

	test("OSC with both terminators uses the earliest", () => {
		expect(escapeSequenceLength("\x1b]a\x07b\x1b\\", 0)).toBe(4);
	});

	test("unterminated OSC/APC consumes the rest of the string", () => {
		expect(escapeSequenceLength("\x1b]83;CURSOR", 0)).toBe(11);
	});

	test("two-byte escape (ESC + one char)", () => {
		expect(escapeSequenceLength("\x1bXab", 0)).toBe(2);
	});
});

describe("withReverseSpan", () => {
	test("full span wraps the whole row", () => {
		expect(withReverseSpan("abc", 0, 3)).toBe("\x1b[7mabc\x1b[27m");
	});

	test("partial span wraps only the covered code units", () => {
		expect(withReverseSpan("abc", 1, 2)).toBe("a\x1b[7mb\x1b[27mc");
	});

	test("start past the row end leaves the row untouched", () => {
		expect(withReverseSpan("abc", 5, 9)).toBe("abc");
	});

	test("end past the row end closes at end of row", () => {
		expect(withReverseSpan("abc", 1, 99)).toBe("a\x1b[7mbc\x1b[27m");
	});

	test("empty span emits adjacent open and reset markers", () => {
		expect(withReverseSpan("abc", 1, 1)).toBe("a\x1b[7m\x1b[27mbc");
	});

	test("escape sequences pass through without consuming code units", () => {
		expect(withReverseSpan("\x1b[31mabc\x1b[0m", 1, 2)).toBe("\x1b[31ma\x1b[7mb\x1b[27mc\x1b[0m");
	});

	test("re-arms reverse after a nested SGR reset inside the span", () => {
		expect(withReverseSpan("a\x1b[0mb", 0, 3)).toBe("\x1b[7ma\x1b[0m\x1b[7mb\x1b[27m");
	});

	test("re-arms reverse after a leading-zero multi-parameter reset inside the span", () => {
		// Derived from the algorithm: reverse opens at cu 0 before "a"; the embedded
		// ESC[0;31m passes through and (first param 0 = full reset) is followed immediately
		// by a re-armed ESC[7m; "b"/"c" consume code units 2-3 and the span closes with
		// SGR 27 at the end of the row.
		expect(withReverseSpan("a\x1b[0;31mbc", 0, 4)).toBe("\x1b[7ma\x1b[0;31m\x1b[7mbc\x1b[27m");
	});

	test("attributes set before the span survive after it (SGR 27 close, no full reset)", () => {
		expect(withReverseSpan("\x1b[1;31mabcdef\x1b[0m", 2, 4)).toBe("\x1b[1;31mab\x1b[7mcd\x1b[27mef\x1b[0m");
	});

	test("emoji surrogate pair stays inside the span (code-unit offsets)", () => {
		// 🌍 is a surrogate pair: "a🌍b" is 4 UTF-16 code units, so [0,4) spans the whole row.
		expect(withReverseSpan("a🌍b", 0, 4)).toBe("\x1b[7ma🌍b\x1b[27m");
		// [1,3) covers exactly the two surrogate code units: the pair stays inside the reverse
		// span with no reset between the two code units.
		expect(withReverseSpan("a🌍b", 1, 3)).toBe("a\x1b[7m🌍\x1b[27mb");
	});
});
