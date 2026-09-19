/**
 * Focused tests for ensureEditorHomeEndKeybindings: the guarded keybindings.json merge
 * (create / merge / skip customizations / unchanged / backup) with isolated per-test config
 * dirs under the OS temp directory (cleaned up best-effort in afterEach).
 */
import { afterEach, describe, test } from "node:test";
import { tmpdir } from "node:os";
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


import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureEditorHomeEndKeybindings } from "../extensions/shift-selection-extension/index.ts";

const REPO_TMP = tmpdir();

let configDir: string | undefined;

/** Fresh isolated config dir per test; `content` optionally seeds keybindings.json. */
function setupConfig(content?: string): string {
	mkdirSync(REPO_TMP, { recursive: true });
	configDir = mkdtempSync(join(REPO_TMP, "keybindings-test-"));
	const path = join(configDir, "keybindings.json");
	if (content !== undefined) writeFileSync(path, content, "utf-8");
	return path;
}

afterEach(() => {
	if (configDir !== undefined) {
		try {
			rmSync(configDir, { recursive: true, force: true });
		} catch {
			// best-effort teardown only: never fail the suite over tmp/ cleanup
		}
		configDir = undefined;
	}
});

describe("ensureEditorHomeEndKeybindings", () => {
	test("creates the file when absent with exactly the two targets, 2-space indent, trailing newline", () => {
		const path = setupConfig();
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("created");
		expect(result.error).toBeUndefined();
		expect(result.backedUp).toBeUndefined();
		expect(result.skippedCustom).toBeUndefined();
		const raw = readFileSync(path, "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw)).toEqual({ "tui.altScreen.top": "ctrl+home", "tui.altScreen.bottom": "ctrl+end" });
		// 2-space indentation: the serialized document must round-trip byte-identically.
		expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
	});

	test("merges into an existing config, preserving unrelated keys", () => {
		const initial = { "tui.altScreen.searchPrevious": "ctrl+shift+enter", "tui.altScreen.top": "home" };
		const path = setupConfig(`${JSON.stringify(initial, null, "\t")}\n`);
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("updated");
		expect(result.skippedCustom).toBeUndefined();
		expect(result.backedUp).toBeUndefined();
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed).toEqual({
			"tui.altScreen.searchPrevious": "ctrl+shift+enter",
			"tui.altScreen.top": "ctrl+home",
			"tui.altScreen.bottom": "ctrl+end",
		});
	});

	test("skips deliberate customizations and still sets the missing sibling key", () => {
		const initial = { "tui.altScreen.top": "ctrl+shift+home" };
		const path = setupConfig(`${JSON.stringify(initial, null, "\t")}\n`);
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("updated");
		expect(result.skippedCustom).toEqual(["tui.altScreen.top"]);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed["tui.altScreen.top"]).toBe("ctrl+shift+home");
		expect(parsed["tui.altScreen.bottom"]).toBe("ctrl+end");
	});

	test("treats the array-form pi default as replaceable and an explicitly disabled [] as custom", () => {
		const initial = { "tui.altScreen.top": ["home"], "tui.altScreen.bottom": [] };
		const path = setupConfig(`${JSON.stringify(initial, null, "\t")}\n`);
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("updated");
		expect(result.skippedCustom).toEqual(["tui.altScreen.bottom"]);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed["tui.altScreen.top"]).toBe("ctrl+home");
		expect(parsed["tui.altScreen.bottom"]).toEqual([]);
	});

	test("returns unchanged and leaves the file bytes untouched when both keys are already at target", () => {
		const initial = { "tui.altScreen.top": "ctrl+home", "tui.altScreen.bottom": "ctrl+end" };
		const path = setupConfig(`${JSON.stringify(initial, null, "\t")}\n`);
		const before = readFileSync(path);
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("unchanged");
		expect(result.backedUp).toBeUndefined();
		const after = readFileSync(path);
		expect(after.equals(before)).toBe(true);
	});

	test("treats a mixed-type array as custom and preserves it verbatim (no lossy filtering)", () => {
		const initial = { "tui.altScreen.top": ["home", 42] };
		const path = setupConfig(`${JSON.stringify(initial, null, "\t")}\n`);
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("updated");
		expect(result.skippedCustom).toEqual(["tui.altScreen.top"]);
		expect(result.backedUp).toBeUndefined();
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed["tui.altScreen.top"]).toEqual(["home", 42]);
		// The other managed action is still set to its target.
		expect(parsed["tui.altScreen.bottom"]).toBe("ctrl+end");
	});

	test("strips a UTF-8 BOM before parsing instead of classifying the file broken", () => {
		const initial = {
			"tui.altScreen.searchPrevious": "ctrl+shift+enter",
			"tui.altScreen.top": "home",
			"tui.altScreen.bottom": "end",
		};
		const path = setupConfig(`\uFEFF${JSON.stringify(initial, null, "\t")}\n`);
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("updated");
		expect(result.backedUp).toBeUndefined();
		const names = readdirSync(configDir as string);
		expect(names.some((name) => name.includes(".broken-"))).toBe(false);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed["tui.altScreen.searchPrevious"]).toBe("ctrl+shift+enter");
		expect(parsed["tui.altScreen.top"]).toBe("ctrl+home");
		expect(parsed["tui.altScreen.bottom"]).toBe("ctrl+end");
	});

	test("backs up unparseable JSON to a sibling .broken-*.bak and still writes the targets", () => {
		const garbage = "{not json";
		const path = setupConfig(garbage);
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("updated");
		expect(result.error).toBeUndefined();
		expect(typeof result.backedUp).toBe("string");
		const dir = configDir as string;
		const backupName = readdirSync(dir).find((name) => /^keybindings\.json\.broken-\d+-\d+\.bak$/.test(name));
		expect(backupName).toBeDefined();
		// Timestamp-pid shape: pid must be a positive integer (uniqueness across concurrent writers).
		const pid = Number((backupName as string).match(/^keybindings\.json\.broken-\d+-(\d+)\.bak$/)?.[1]);
		expect(pid).toBe(process.pid);
		// The backup preserves the exact original bytes; the original path now holds the targets.
		expect(readFileSync(join(dir, backupName as string), "utf-8")).toBe(garbage);
		expect(result.backedUp).toBe(join(dir, backupName as string));
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed).toEqual({ "tui.altScreen.top": "ctrl+home", "tui.altScreen.bottom": "ctrl+end" });
	});

	test("does not throw and reports error status when the config path sits in a nonexistent directory", () => {
		const dir = setupConfig();
		const path = join(dir, "missing", "keybindings.json");
		const result = ensureEditorHomeEndKeybindings(path);
		expect(result.status).toBe("error");
		expect(typeof result.error).toBe("string");
		expect(result.error?.length ?? 0).toBeGreaterThan(0);
	});

	test("returns error status without throwing when the config path is an existing directory", () => {
		// setupConfig() returns the keybindings.json FILE path; the directory itself is configDir.
		setupConfig();
		const result = ensureEditorHomeEndKeybindings(configDir as string);
		expect(result.status).toBe("error");
		expect(typeof result.error).toBe("string");
		expect(result.error?.length ?? 0).toBeGreaterThan(0);
	});

	test("second consecutive run on a fresh path is unchanged with identical bytes", () => {
		const path = setupConfig();
		const first = ensureEditorHomeEndKeybindings(path);
		expect(first.status).toBe("created");
		const afterFirst = readFileSync(path);
		const second = ensureEditorHomeEndKeybindings(path);
		expect(second.status).toBe("unchanged");
		expect(readFileSync(path).equals(afterFirst)).toBe(true);
	});
});
