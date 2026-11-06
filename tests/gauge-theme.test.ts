import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGaugePaintCache, gaugePaintFor, resolveGaugePaint } from "../lib/gauge-theme.ts";
import { paintGauge } from "../lib/shell-gauge.ts";

// Issue #2222: reserved `vars` keys (`gauge.*`) give the gauges their own
// roles and glyphs; everything else falls back. `vars` is the only open map
// in Pi's theme schema, and these tests run every fixture through the same
// validation the theme loader applies.

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

function withThemeSource(body: unknown): string {
	const directory = mkdtempSync(join(tmpdir(), "gauge-theme-"));
	const path = join(directory, "Theme.json");
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
}

const BASE_THEME = {
	name: "Test",
	colors: { accent: "magenta", warning: "yellow", error: "red", border: "cyan", success: "green", syntaxString: "blue" },
};

test("resolveGaugePaint reads token references and glyphs from the gauge vars", () => {
	const path = withThemeSource({
		...BASE_THEME,
		vars: { "gauge.ok": "success", "gauge.warning": "syntaxString", "gauge.error": "error", "gauge.empty": "border", "gauge.filled": "█", "gauge.emptyGlyph": "░" },
	});
	const paint = resolveGaugePaint(path);
	assert.deepEqual(paint, { ok: "success", warning: "syntaxString", error: "error", empty: "border", filled: "█", emptyGlyph: "░" });
	assert.equal(paintGauge(45, taggedTheme, 8, paint), `<success>████</success><border>░░░░</border>`);
});

test("a theme without gauge vars resolves no paint", () => {
	assert.equal(resolveGaugePaint(withThemeSource(BASE_THEME)), undefined);
	assert.equal(resolveGaugePaint(withThemeSource({ ...BASE_THEME, vars: { brand: "#ff0000" } })), undefined);
});

test("invalid entries fall back per role and glyphs must be single visible characters", () => {
	const path = withThemeSource({
		...BASE_THEME,
		vars: { "gauge.ok": 300, "gauge.warning": "noSuchToken", "gauge.error": "error", "gauge.filled": "██", "gauge.emptyGlyph": "" },
	});
	assert.deepEqual(resolveGaugePaint(path), { error: "error" });
});

test("gauge colors accept direct hex, okhsl, 256 indexes, and vars references", () => {
	const path = withThemeSource({
		name: "Test",
		colors: { accent: "brand" },
		vars: { brand: "#ff0000", "gauge.ok": "#22c55e", "gauge.warning": "brand", "gauge.error": 196, "gauge.empty": "okhsl(70 0.1 0.5)" },
	});
	const paint = resolveGaugePaint(path);
	assert.equal(paint?.ok, "\x1b[38;2;34;197;94m");
	assert.equal(paint?.warning, "\x1b[38;2;255;0;0m");
	assert.match(paint?.error ?? "", /^\x1b\[38;5;196m$/);
	assert.match(paint?.empty ?? "", /^\x1b\[38;2;\d+;\d+;\d+m$/);
});

test("direct colors use the same color grammar themes use everywhere: 3-digit hex, oklch, and case-insensitive okhsl", () => {
	const path = withThemeSource({
		name: "Test",
		colors: {},
		vars: { "gauge.ok": "#f00", "gauge.warning": "OKHSL(120 50% 50%)", "gauge.error": "oklch(0.7 0.1 200)", "gauge.empty": "okhsl(bogus)" },
	});
	const paint = resolveGaugePaint(path);
	assert.equal(paint?.ok, "\x1b[38;2;255;0;0m");
	assert.match(paint?.warning ?? "", /^\x1b\[38;2;\d+;\d+;\d+m$/);
	assert.match(paint?.error ?? "", /^\x1b\[38;2;\d+;\d+;\d+m$/);
	assert.equal(paint?.empty, undefined);
});

test("glyphs must occupy exactly one terminal column", () => {
	const path = withThemeSource({
		...BASE_THEME,
		vars: { "gauge.filled": "０", "gauge.emptyGlyph": "\u200b" },
	});
	assert.deepEqual(resolveGaugePaint(path), {});
});

test("paintGauge paints raw ANSI roles directly and token roles through the theme", () => {
	const raw = { ok: "\x1b[38;2;34;197;94m" };
	assert.equal(paintGauge(45, taggedTheme, 8, raw), "\x1b[38;2;34;197;94m▰▰▰▰\x1b[39m<border>▱▱▱▱</border>");
	assert.equal(paintGauge(45, taggedTheme, 8, { ok: "success" }), "<success>▰▰▰▰</success><border>▱▱▱▱</border>");
});

test("paintGauge tolerates regex metacharacters in theme-authored glyphs", () => {
	assert.equal(paintGauge(50, taggedTheme, 4, { emptyGlyph: "*" }), "<accent>▰▰</accent><border>**</border>");
	assert.equal(paintGauge(50, taggedTheme, 4, { emptyGlyph: "." }), "<accent>▰▰</accent><border>..</border>");
	assert.equal(paintGauge(100, taggedTheme, 4, { filled: "(" }), "<error>((((</error><border></border>");
});

test("a malformed theme file throws for the raw resolver and is swallowed by the memoized one", () => {
	assert.throws(() => resolveGaugePaint(withThemeSource("not json")));
	assert.equal(gaugePaintFor(withThemeSource("not json")), undefined);
});

test("gaugePaintFor memoizes by stat and picks up file changes", () => {
	const path = withThemeSource(BASE_THEME);
	try {
		clearGaugePaintCache();
		assert.equal(gaugePaintFor(path), undefined);
		assert.equal(gaugePaintFor(undefined), undefined);
		writeFileSync(path, JSON.stringify({ ...BASE_THEME, vars: { "gauge.ok": "success", "gauge.filled": "█" } }));
		// Same-second writes are not enough: touch mtime explicitly.
		utimesSync(path, new Date(), new Date(Date.now() + 5_000));
		assert.deepEqual(gaugePaintFor(path), { ok: "success", filled: "█" });
	} finally {
		clearGaugePaintCache();
		rmSync(join(path, ".."), { recursive: true, force: true });
	}
});
