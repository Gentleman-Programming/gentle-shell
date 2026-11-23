import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// Paleta de marca: fondo #0d1526, texto #e6edf7 y rojo eléctrico #ff4d5e sobre los temas
// empaquetados (Pi y Herdr) y sobre Tower. El contraste WCAG 2.x de cada rol de texto es >= 4.5:1.

const BG = "#0d1526";
const TEXT = "#e6edf7";
const ACCENT = "#ff4d5e";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = <T>(path: string) => JSON.parse(read(path)) as T;
const same = (value: unknown, expected: string) => String(value).toLowerCase() === expected;

/** Luminancia relativa de un color #rrggbb (WCAG 2.x). */
function luminance(hex: string): number {
	const h = hex.replace("#", "");
	const channel = (at: number) => {
		const c = parseInt(h.slice(at, at + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Razón de contraste WCAG entre dos colores opacos. */
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

function assertContrast(role: string, color: string, background: string = BG): void {
	const value = contrast(color, background);
	assert.ok(
		value >= 4.5,
		`${role} ${color} sobre ${background}: ${value.toFixed(2)}:1, se exige 4.5:1`,
	);
}

interface PiTheme {
	name?: string;
	vars?: Record<string, string>;
	colors?: Record<string, string>;
}

test("el tema Drakonc usa el fondo, el texto y el acento de marca, con estado legible", () => {
	const theme = readJson<PiTheme>("themes/Drakonc.json");
	const vars = theme.vars ?? {};
	const colors = theme.colors ?? {};
	const resolve = (key: string): string | undefined => {
		const ref = colors[key];
		return ref === undefined ? undefined : vars[ref] ?? ref;
	};

	assert.equal(theme.name, "Drakonc");
	assert.ok(same(vars.bg, BG), `el fondo del tema debe ser ${BG}: ${vars.bg}`);
	assert.ok(same(vars.text, TEXT), `el texto del tema debe ser ${TEXT}: ${vars.text}`);
	assert.ok(same(vars.accent, ACCENT), `el acento del tema debe ser ${ACCENT}: ${vars.accent}`);

	const roles = [
		["texto", "text"],
		["acento", "accent"],
		["aviso", "warning"],
		["error", "error"],
	] as const;
	for (const [role, key] of roles) {
		const value = resolve(key);
		assert.ok(value, `${role}: el tema define colors.${key}`);
		assert.ok(/^#[0-9a-f]{6}$/i.test(value), `${role}: ${key} es un color #rrggbb (${value})`);
		assertContrast(role, value);
	}
});

interface HerdrTheme {
	background: string;
	foreground: string;
	ansi: string[];
	colors: Record<string, string>;
}

test("el tema oscuro de Herdr usa la paleta de marca, con estado legible", () => {
	const theme = readJson<HerdrTheme>("herdr/themes/drakonc-shell-dark.json");
	const colors = theme.colors;

	assert.ok(same(colors.background, BG) && same(colors.canvas, BG), "fondo y lienzo de marca");
	assert.ok(same(colors.foreground, TEXT), `el texto debe ser ${TEXT}: ${colors.foreground}`);
	assert.ok(same(colors.accent, ACCENT), `el acento debe ser ${ACCENT}: ${colors.accent}`);
	assert.ok(same(colors.solid, ACCENT), "el botón sólido usa el acento de marca");

	assertContrast("texto", colors.foreground);
	assertContrast("texto atenuado", colors.muted);
	assertContrast("acento", colors.accent);
	assertContrast("aviso", colors.blocked);
	assert.ok(theme.ansi[1], "el ANSI rojo del terminal existe");
	assertContrast("error", theme.ansi[1]);
	assertContrast("texto sobre el acento", colors.accent_foreground, colors.accent);
});

test("Tower pinta el fondo, el texto y los acentos con la paleta de marca", () => {
	const css = read("web/tower/src/style.css");
	const token = (name: string): string => {
		const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
		assert.ok(value, `style.css declara --${name}`);
		return value;
	};

	assert.match(css, /body \{ background: #0d1526; color: var\(--text\);/, "el fondo de página es de marca");
	assert.ok(same(token("text"), TEXT), `--text debe ser ${TEXT}: ${token("text")}`);
	assert.ok(same(token("accent"), ACCENT) && same(token("accent-strong"), ACCENT), "el acento es el rojo de marca");

	assertContrast("texto", token("text"));
	assertContrast("texto atenuado", token("muted"));
	assertContrast("acento", token("accent"));
	assertContrast("éxito", token("ok"));
	assertContrast("aviso", token("warn"));
	assertContrast("error", css.match(/#ff718f/i)?.[0] ?? "#ff718f");

	// El arte heredado no conserva el rosa: el neón del lienzo es la familia del rojo de marca.
	const art = read("web/tower/src/art.ts");
	const family = art.match(/export const C = \{([^}]*)\}/)?.[1] ?? "";
	assert.match(family, /neon: "#ff4d5e"/, "C.neon es el acento de marca");
	assert.match(family, /acc: "#bc3548"/, "C.acc es el rojo oscuro derivado");
	assert.match(family, /accS: "#ff8993"/, "C.accS es el rojo claro derivado");
	assert.match(family, /ink: "#0d1526"/, "C.ink es el fondo de marca");
});

test("ninguna fuente de Tower conserva el rosa heredado", () => {
	const dir = new URL("../web/tower/src/", import.meta.url);
	const files = readdirSync(dir).filter((name) => /\.(ts|css)$/.test(name));
	assert.ok(files.length > 0, "Tower tiene fuentes que revisar");
	const inherited = /#(?:ff76c3|f095c8|ffb1dd|ff5f9a|c2456f)\b/i;
	for (const name of files) {
		const text = readFileSync(new URL(name, dir), "utf8");
		const match = text.match(inherited);
		assert.equal(match, null, `${name} conserva el color heredado ${match?.[0] ?? ""}`);
	}
});
