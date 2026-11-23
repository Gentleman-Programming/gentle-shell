import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_THEME_COLOR_KEYS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"selectedBg",
	"userMessageBg",
	"userMessageText",
	"customMessageBg",
	"customMessageText",
	"customMessageLabel",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
] as const;

interface PackageJsonPiManifest {
	theme?: string;
	themes?: string[];
}

interface PackageJson {
	files?: string[];
	pi?: PackageJsonPiManifest;
}

interface DrakoncThemeJson {
	name?: string;
	vars?: Record<string, unknown>;
	colors?: Record<string, unknown>;
	export?: Record<string, unknown>;
}

function resolveThemeColor(theme: DrakoncThemeJson, colorKey: string): unknown {
	const colorRef = theme.colors?.[colorKey];

	if (typeof colorRef !== "string") {
		return colorRef;
	}

	return theme.vars?.[colorRef] ?? colorRef;
}

function assertResolvedThemeColor(
	theme: DrakoncThemeJson,
	colorKey: string,
	expected: string,
): void {
	assert.equal(resolveThemeColor(theme, colorKey), expected, colorKey);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

test("package manifest exposes bundled themes to Pi discovery", () => {
	const packageJson = readJson<PackageJson>(join(PACKAGE_ROOT, "package.json"));

	assert.ok(
		packageJson.pi?.themes?.includes("./themes"),
		"package.json must expose ./themes so Pi can list bundled themes in Settings",
	);
	assert.ok(
		packageJson.files?.includes("themes/"),
		"package files must include themes/ so the bundled theme ships in npm packages",
	);
	assert.equal(
		packageJson.pi?.theme,
		undefined,
		"package manifest must not auto-apply the bundled theme",
	);
});

test("bundled Drakoncman-Sexy Pi theme is available under its exact name", () => {
	const theme = readJson<DrakoncThemeJson>(
		join(PACKAGE_ROOT, "themes", "Drakoncman-Sexy.json"),
	);

	assert.equal(theme.name, "Drakoncman-Sexy");
});

test("bundled Drakoncman-Cute Pi theme is available under its exact name", () => {
	const theme = readJson<DrakoncThemeJson>(
		join(PACKAGE_ROOT, "themes", "Drakoncman-Cute.json"),
	);

	assert.equal(theme.name, "Drakoncman-Cute");
});

test("bundled Drakoncman-Sexy Pi theme defines complete brand and semantic color mappings", () => {
	const theme = readJson<DrakoncThemeJson>(
		join(PACKAGE_ROOT, "themes", "Drakoncman-Sexy.json"),
	);
	const colors = theme.colors ?? {};

	assert.deepEqual(
		REQUIRED_THEME_COLOR_KEYS.filter((key) => !(key in colors)),
		[],
	);
	assert.deepEqual(
		["scrollbarThumb", "searchMatchBg", "searchMatchText", "thinkingMax"].filter(
			(key) => !(key in colors),
		),
		[],
	);

	assertResolvedThemeColor(theme, "accent", "#F43888");
	assert.equal(colors.borderAccent, "activePink");
	assertResolvedThemeColor(theme, "borderAccent", "#FF4F9A");
	assertResolvedThemeColor(theme, "selectedBg", "#28121E");
	assertResolvedThemeColor(theme, "text", "#F6EFF3");
	assertResolvedThemeColor(theme, "success", "#D2CBD0");
	assertResolvedThemeColor(theme, "warning", "#F2B86D");
	assertResolvedThemeColor(theme, "error", "#FF718F");
	assertResolvedThemeColor(theme, "muted", "#A78E9B");
	assertResolvedThemeColor(theme, "dim", "#76616B");
	assertResolvedThemeColor(theme, "toolPendingBg", "#100A0F");
	assertResolvedThemeColor(theme, "toolSuccessBg", "#151316");
	assertResolvedThemeColor(theme, "toolErrorBg", "#261019");
	assertResolvedThemeColor(theme, "toolTitle", "#E0C27A");
	assertResolvedThemeColor(theme, "customMessageLabel", "#E0C27A");
	assert.equal(colors.mdCodeBlockBorder, "muted");
	assertResolvedThemeColor(theme, "mdCodeBlockBorder", "#A78E9B");
	assert.equal(colors.mdQuoteBorder, "deepPink");
	assertResolvedThemeColor(theme, "mdQuoteBorder", "#BF0F50");
	assert.equal(colors.mdLink, "activePink");
	assertResolvedThemeColor(theme, "mdLink", "#FF4F9A");
	assert.equal(colors.mdListBullet, "activePink");
	assertResolvedThemeColor(theme, "mdListBullet", "#FF4F9A");
	assertResolvedThemeColor(theme, "toolDiffAdded", "#A9C7EE");
	assert.equal(colors.syntaxKeyword, "deepPink");
	assertResolvedThemeColor(theme, "syntaxKeyword", "#BF0F50");
	assertResolvedThemeColor(theme, "syntaxFunction", "#C49BFF");
	assert.equal(colors.syntaxOperator, "activePink");
	assertResolvedThemeColor(theme, "syntaxOperator", "#FF4F9A");
	assertResolvedThemeColor(theme, "syntaxString", "#E0C27A");
	assertResolvedThemeColor(theme, "syntaxNumber", "#D7A0B8");
	assertResolvedThemeColor(theme, "syntaxType", "#A9C7EE");
	assert.equal(colors.thinkingXhigh, "activePink");
	assertResolvedThemeColor(theme, "thinkingXhigh", "#FF4F9A");
	assert.equal(colors.thinkingMax, "accent");
	assertResolvedThemeColor(theme, "thinkingMax", "#F43888");
	assert.equal(theme.export?.pageBg, "bg");
	assert.equal(theme.export?.cardBg, "bgElement");
	assert.equal(theme.export?.infoBg, "infoBg");
});

test("bundled Drakoncman-Cute Pi theme defines complete brand and restrained color mappings", () => {
	const theme = readJson<DrakoncThemeJson>(
		join(PACKAGE_ROOT, "themes", "Drakoncman-Cute.json"),
	);
	const colors = theme.colors ?? {};

	assert.deepEqual(
		REQUIRED_THEME_COLOR_KEYS.filter((key) => !(key in colors)),
		[],
	);
	assert.deepEqual(
		["scrollbarThumb", "searchMatchBg", "searchMatchText", "thinkingMax"].filter(
			(key) => !(key in colors),
		),
		[],
	);

	assertResolvedThemeColor(theme, "accent", "#F095C8");
	assertResolvedThemeColor(theme, "searchMatchBg", "#C96AA2");
	assert.equal(colors.borderAccent, "activePink");
	assertResolvedThemeColor(theme, "borderAccent", "#FFB1DD");
	assertResolvedThemeColor(theme, "selectedBg", "#28121E");
	assertResolvedThemeColor(theme, "text", "#F6EFF3");
	assertResolvedThemeColor(theme, "success", "#B4E7C7");
	assertResolvedThemeColor(theme, "warning", "#F2B86D");
	assertResolvedThemeColor(theme, "error", "#FF718F");
	assertResolvedThemeColor(theme, "muted", "#A78E9B");
	assertResolvedThemeColor(theme, "dim", "#76616B");
	assert.equal(colors.thinkingText, "softRose");
	assertResolvedThemeColor(theme, "thinkingText", "#D7A0B8");
	assertResolvedThemeColor(theme, "toolPendingBg", "#100A0F");
	assertResolvedThemeColor(theme, "toolSuccessBg", "#151316");
	assertResolvedThemeColor(theme, "toolErrorBg", "#261019");
	assertResolvedThemeColor(theme, "toolTitle", "#E0C27A");
	assertResolvedThemeColor(theme, "customMessageLabel", "#E0C27A");
	assert.equal(colors.mdCodeBlockBorder, "muted");
	assertResolvedThemeColor(theme, "mdCodeBlockBorder", "#A78E9B");
	assert.equal(colors.mdQuoteBorder, "deepPink");
	assertResolvedThemeColor(theme, "mdQuoteBorder", "#C96AA2");
	assert.equal(colors.mdLink, "accent");
	assertResolvedThemeColor(theme, "mdLink", "#F095C8");
	assert.equal(colors.mdListBullet, "accent");
	assertResolvedThemeColor(theme, "mdListBullet", "#F095C8");
	assertResolvedThemeColor(theme, "toolDiffAdded", "#B4E7C7");
	assert.equal(colors.syntaxKeyword, "accent");
	assertResolvedThemeColor(theme, "syntaxKeyword", "#F095C8");
	assertResolvedThemeColor(theme, "syntaxFunction", "#A9C7EE");
	assert.equal(colors.syntaxOperator, "sky");
	assertResolvedThemeColor(theme, "syntaxOperator", "#C4DAF6");
	assertResolvedThemeColor(theme, "syntaxString", "#B4E7C7");
	assertResolvedThemeColor(theme, "syntaxNumber", "#F2B86D");
	assertResolvedThemeColor(theme, "syntaxType", "#E0C27A");
	assert.equal(colors.thinkingXhigh, "accent");
	assertResolvedThemeColor(theme, "thinkingXhigh", "#F095C8");
	assert.equal(colors.thinkingMax, "activePink");
	assertResolvedThemeColor(theme, "thinkingMax", "#FFB1DD");
	assert.equal(theme.export?.pageBg, "bg");
	assert.equal(theme.export?.cardBg, "bgElement");
	assert.equal(theme.export?.infoBg, "infoBg");
});

test("bundled Pi theme is named exactly Drakonc and defines all required colors", () => {
	const theme = readJson<DrakoncThemeJson>(
		join(PACKAGE_ROOT, "themes", "Drakonc.json"),
	);

	assert.equal(theme.name, "Drakonc");
	const colors = theme.colors ?? {};
	assert.deepEqual(
		REQUIRED_THEME_COLOR_KEYS.filter((key) => !(key in colors)),
		[],
	);
});

test("bundled Pi theme maps roles to the Drakonc brand palette", () => {
	const theme = readJson<DrakoncThemeJson>(
		join(PACKAGE_ROOT, "themes", "Drakonc.json"),
	);
	const vars = theme.vars ?? {};
	const colors = theme.colors ?? {};

	assert.equal(vars.bg, "#0d1526", "el fondo es el azul de marca");
	assert.equal(vars.bgPanel, "#121d31", "los paneles comparten el fondo de marca");
	assert.equal(vars.bgElement, "#17233a", "las tarjetas se separan del fondo");
	assert.equal(vars.bgSubtle, "#121d31", "las superficies secundarias son paneles");
	assert.equal(vars.text, "#e6edf7", "el texto es el claro de marca");
	assert.equal(vars.muted, "#a9b7ca", "el texto atenuado conserva contraste");
	assert.equal(vars.dim, "#8593a8", "el texto tenue conserva contraste");
	assert.equal(vars.border, "#334158", "el borde es el azul grisáceo de marca");
	assert.equal(vars.borderSubtle, "#334158", "no quedan bordes rosados heredados");
	assert.equal(vars.accent, "#ff4d5e", "el acento es el rojo eléctrico de marca");
	assert.equal(vars.deepPink, "#bc3548", "el rojo oscuro deriva del acento");
	assert.equal(vars.activePink, "#ff7782", "el rojo activo deriva del acento");
	assert.equal(vars.champagne, "#ff8993", "el rojo claro deriva del acento");
	assert.equal(vars.warning, "#F2B86D", "el aviso se mantiene legible");
	assert.equal(vars.error, "#FF718F", "el error se mantiene legible");
	assert.equal(vars.mint, "#B4E7C7", "el éxito se mantiene legible");
	assert.equal(vars.selection, "#24304a", "la selección es azul de marca");
	assert.equal(vars.toolSuccessBg, "#172c2b");
	assert.equal(vars.toolErrorBg, "#2e1a20", "el error de herramienta deja el rosa heredado");
	assert.equal(vars.toolPendingBg, "#121d31");
	assert.equal(vars.infoBg, "#121d31");

	assert.equal(colors.accent, "accent");
	assert.equal(colors.border, "border");
	assert.equal(colors.text, "text");
	assert.equal(colors.borderAccent, "activePink");
	assert.equal(colors.selectedBg, "selection");
	assert.equal(colors.searchMatchBg, "deepPink");
	assert.equal(colors.mdLink, "accent");
	assert.equal(colors.mdQuoteBorder, "deepPink");
	assert.equal(colors.mdListBullet, "accent");
	assert.equal(colors.syntaxKeyword, "accent");
	assert.equal(colors.thinkingXhigh, "accent");
	assert.equal(colors.thinkingMax, "activePink");
	assert.equal(colors.toolTitle, "champagne");
	assert.equal(colors.customMessageLabel, "champagne");

	assertResolvedThemeColor(theme, "accent", "#ff4d5e");
	assertResolvedThemeColor(theme, "text", "#e6edf7");
	assertResolvedThemeColor(theme, "muted", "#a9b7ca");
	assertResolvedThemeColor(theme, "dim", "#8593a8");
	assertResolvedThemeColor(theme, "border", "#334158");
	assertResolvedThemeColor(theme, "borderAccent", "#ff7782");
	assertResolvedThemeColor(theme, "selectedBg", "#24304a");
	assertResolvedThemeColor(theme, "error", "#FF718F");
	assertResolvedThemeColor(theme, "warning", "#F2B86D");
	assertResolvedThemeColor(theme, "success", "#B4E7C7");
	assertResolvedThemeColor(theme, "mdLink", "#ff4d5e");
	assertResolvedThemeColor(theme, "mdQuoteBorder", "#bc3548");
	assertResolvedThemeColor(theme, "syntaxKeyword", "#ff4d5e");
	assertResolvedThemeColor(theme, "thinkingXhigh", "#ff4d5e");
	// El prompt del usuario tiene superficie propia: no puede confundirse con el fondo.
	assert.notEqual(resolveThemeColor(theme, "userMessageBg"), vars.bg);
	assertResolvedThemeColor(theme, "toolPendingBg", "#121d31");
	assert.equal(theme.export?.pageBg, "bg");
	assert.equal(theme.export?.cardBg, "bgElement");
	assert.equal(theme.export?.infoBg, "infoBg");
});
