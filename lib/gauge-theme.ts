// Gauge theme roles from the installed theme source (issue #2222).
//
// Pi's theme schema is closed at every level (colors, export and the theme
// object itself reject unknown properties) and `theme.fg` throws on unknown
// tokens, so gauge roles cannot be theme colors or a top-level block. The
// one open map is `vars` (a free-form record of color values), so themes
// declare the roles there under reserved `gauge.` keys. Color values resolve
// like any Pi theme value: an existing theme token name (painted through
// `theme.fg`), or a direct color (hex, okhsl, or a 256-color index, painted
// as raw ANSI so the gauges alone recolor). Glyph values are literal single
// characters. Everything is optional and falls back per role to the gauge's
// historical roles, so themes without the keys — and invalid values — render
// exactly as before.

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { colorToRgb, parseColor } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { GaugePaint } from "./shell-gauge.ts";

const MAX_BYTES = 256_000;
const REFERENCE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const COLOR_KEYS = ["ok", "warning", "error", "empty"] as const;
const GLYPH_KEYS = ["filled", "emptyGlyph"] as const;
// Reserved `vars` names that carry the gauge customization, e.g. "vars": { "gauge.ok": "#22c55e" }.
const gaugeVar = (key: string): string => `gauge.${key}`;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	paint: GaugePaint | undefined;
}

// The bar and panel render many times a second, so a render pays at most one
// statSync per call; the file is opened and parsed only when the stat changes,
// and a failed resolve is cached like any other result so a malformed theme
// costs no repeated reads on the render path.
const cache = new Map<string, CacheEntry>();

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One visible terminal column, single code point, no control characters or escape sequences. */
function isGlyph(value: unknown): value is string {
	return typeof value === "string" && [...value].length === 1 && visibleWidth(value) === 1 && !/[\u0000-\u001f\u007f\x1b]/.test(value);
}

// A color entry resolves like a Pi theme value: variable references expand
// first, then either an existing theme token keeps its name (so the theme's
// own resolved ANSI applies) or the value delegates to pi-tui's `parseColor`,
// the same grammar themes use everywhere else (3 or 6 digit hex, oklch,
// case-insensitive okhsl), and becomes raw foreground ANSI. Direct colors are
// what let a theme recolor only the gauges, exactly like the issue's
// green/yellow/red statusline use case.
function resolveGaugeColor(value: unknown, colors: Record<string, unknown>, vars: Record<string, unknown>): string | undefined {
	const seen = new Set<unknown>();
	while (typeof value === "string" && REFERENCE.test(value) && Object.hasOwn(vars, value)) {
		if (seen.has(value)) return undefined;
		seen.add(value);
		value = vars[value];
	}
	if (typeof value === "string" && Object.hasOwn(colors, value)) return value;
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) return `\x1b[38;5;${value}m`;
	if (typeof value === "string") {
		try {
			const { r, g, b } = colorToRgb(parseColor(value));
			return `\x1b[38;2;${r};${g};${b}m`;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Read only the installed theme source supplied by Pi; never fall back to the active theme. */
function readThemeSource(sourcePath: string): unknown {
	const resolved = realpathSync(sourcePath);
	const fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let text: string;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Theme source unavailable or too large.");
		text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
	} finally {
		closeSync(fd);
	}
	return JSON.parse(text);
}

/**
 * Gauge roles and glyphs declared by the theme source, or undefined when the
 * theme declares none. Invalid entries are dropped individually, never
 * throwing: a bad `gaugeWarning` keeps `warning` rather than disabling the rest.
 */
export function resolveGaugePaint(sourcePath: string): GaugePaint | undefined {
	const document: unknown = readThemeSource(sourcePath);
	if (!record(document) || !record(document.vars)) return undefined;
	const vars = document.vars;
	const hasGaugeVars = COLOR_KEYS.some((key) => gaugeVar(key) in vars) || GLYPH_KEYS.some((key) => gaugeVar(key) in vars);
	if (!hasGaugeVars) return undefined;
	const colors = record(document.colors) ? document.colors : {};
	const paint: GaugePaint = {};
	for (const key of COLOR_KEYS) {
		const declared = vars[gaugeVar(key)];
		if (declared === undefined) continue;
		const value = resolveGaugeColor(declared, colors, vars);
		if (value !== undefined) paint[key] = value;
	}
	for (const key of GLYPH_KEYS) {
		const value = vars[gaugeVar(key)];
		if (isGlyph(value)) paint[key] = value;
	}
	return paint;
}

/** Memoized `resolveGaugePaint`; undefined whenever the theme source is unavailable or invalid. */
export function gaugePaintFor(sourcePath: string | undefined): GaugePaint | undefined {
	if (!sourcePath) return undefined;
	let stat;
	try {
		stat = statSync(sourcePath);
	} catch {
		// A missing source stays uncached: recreating it must take effect.
		return undefined;
	}
	const cached = cache.get(sourcePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.paint;
	// Validate the stat before any open: a path that is not a regular file (a
	// FIFO, a device) must never reach openSync, and an oversized file must
	// never reach a read. Failures resolve to the historical roles.
	let paint: GaugePaint | undefined;
	if (stat.isFile() && stat.size <= MAX_BYTES) {
		try {
			paint = resolveGaugePaint(sourcePath);
		} catch {
			paint = undefined;
		}
	}
	cache.set(sourcePath, { mtimeMs: stat.mtimeMs, size: stat.size, paint });
	return paint;
}

/** Test hook: drop every cached theme source entry. */
export function clearGaugePaintCache(): void {
	cache.clear();
}
