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

interface GentleThemeJson {
	name?: string;
	vars?: Record<string, unknown>;
	colors?: Record<string, unknown>;
	export?: Record<string, unknown>;
}

function resolveThemeColor(theme: GentleThemeJson, colorKey: string): unknown {
	const colorRef = theme.colors?.[colorKey];

	if (typeof colorRef !== "string") {
		return colorRef;
	}

	return theme.vars?.[colorRef] ?? colorRef;
}

function assertResolvedThemeColor(
	theme: GentleThemeJson,
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

test("bundled Gentleman-Sexy Pi theme is available under its exact name", () => {
	const theme = readJson<GentleThemeJson>(
		join(PACKAGE_ROOT, "themes", "Gentleman-Sexy.json"),
	);

	assert.equal(theme.name, "Gentleman-Sexy");
});

test("bundled Gentleman-Cute Pi theme is available under its exact name", () => {
	const theme = readJson<GentleThemeJson>(
		join(PACKAGE_ROOT, "themes", "Gentleman-Cute.json"),
	);

	assert.equal(theme.name, "Gentleman-Cute");
});

test("bundled Gentleman-Sexy Pi theme defines complete brand and semantic color mappings", () => {
	const theme = readJson<GentleThemeJson>(
		join(PACKAGE_ROOT, "themes", "Gentleman-Sexy.json"),
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

test("bundled Gentleman-Cute Pi theme defines complete brand and restrained color mappings", () => {
	const theme = readJson<GentleThemeJson>(
		join(PACKAGE_ROOT, "themes", "Gentleman-Cute.json"),
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

test("bundled Pi theme is named exactly Gentle and defines all required colors", () => {
	const theme = readJson<GentleThemeJson>(
		join(PACKAGE_ROOT, "themes", "Gentle.json"),
	);

	assert.equal(theme.name, "Gentle");
	const colors = theme.colors ?? {};
	assert.deepEqual(
		REQUIRED_THEME_COLOR_KEYS.filter((key) => !(key in colors)),
		[],
	);
});

test("bundled Pi theme maps roles to the subtle OpenCode gentleman theme", () => {
	const theme = readJson<GentleThemeJson>(
		join(PACKAGE_ROOT, "themes", "Gentle.json"),
	);
	const vars = theme.vars ?? {};
	const colors = theme.colors ?? {};

	assert.equal(vars.bg, "#06080f", "Pi background should match OpenCode panel background");
	assert.equal(vars.bgPanel, "#06080f", "large panel surfaces should match OpenCode panels");
	assert.equal(vars.bgElement, "#06080f", "message surfaces should match OpenCode elements");
	assert.equal(vars.bgSubtle, "#0d0f14", "secondary surfaces should use OpenCode diff context background");
	assert.equal(vars.text, "#F3F6F9", "text should match OpenCode foreground");
	assert.equal(vars.muted, "#5C6170", "muted text should match OpenCode textMuted");
	assert.equal(vars.border, "#313342", "border should match OpenCode border");
	assert.equal(vars.borderSubtle, "#232A40", "subtle borders should match OpenCode borderSubtle");
	assert.equal(vars.accent, "#E0C15A", "source accent should remain available");
	assert.equal(vars.selection, "#232A40", "selection should use OpenCode borderSubtle");
	assert.equal(vars.red, "#CB7C94", "error accent should use blur red");
	assert.equal(vars.green, "#B7CC85", "success accent should use blur green");
	assert.equal(vars.blue, "#7FB4CA", "primary roles should use OpenCode primary blue");
	assert.equal(vars.secondary, "#A3B5D6", "secondary roles should match OpenCode secondary");
	assert.equal(vars.heading, "#B5B2D0", "markdown headings should match OpenCode heading");
	assert.equal(vars.warning, "#DEBA87", "warning should match OpenCode warning");
	assert.equal(
		vars.toolSuccessBg,
		"#1a2e1a",
		"success background should match OpenCode diff added background",
	);
	assert.equal(
		vars.toolPendingBg,
		"#0d0f14",
		"pending background should match OpenCode diff context background",
	);
	assert.equal(
		vars.toolErrorBg,
		"#2e1a1a",
		"error background should match OpenCode diff removed background",
	);
	assert.equal(
		vars.infoBg,
		"#0d0f14",
		"info background should stay as subtle as OpenCode diff context background",
	);

	assert.equal(colors.accent, "blue");
	assert.equal(colors.selectedBg, "selection");
	assert.equal(colors.borderAccent, "blue");
	assert.equal(colors.userMessageBg, "bgElement");
	assert.equal(colors.customMessageBg, "bgSubtle");
	assert.notEqual(resolveThemeColor(theme, "borderAccent"), "#E0C15A");
	assert.equal(colors.thinkingText, "muted");
	assert.equal(colors.bashMode, "blue");
	assert.equal(colors.toolPendingBg, "toolPendingBg");
	assert.equal(colors.toolSuccessBg, "toolSuccessBg");
	assert.equal(colors.toolErrorBg, "toolErrorBg");
	assert.equal(colors.mdHeading, "heading");
	assert.equal(colors.mdLink, "blue");
	assert.equal(colors.mdCode, "green");
	assert.equal(colors.mdQuote, "warning");
	assert.equal(colors.mdListBullet, "blue");
	assert.equal(colors.toolTitle, "blue");
	assert.equal(colors.thinkingHigh, "blue");
	assert.equal(colors.thinkingXhigh, "secondary");
	assert.equal(colors.toolOutput, "text");
	assert.equal(theme.export?.pageBg, "bg");
	assert.equal(theme.export?.cardBg, "bgElement");

	assertResolvedThemeColor(theme, "accent", "#7FB4CA");
	assertResolvedThemeColor(theme, "border", "#313342");
	assertResolvedThemeColor(theme, "borderMuted", "#232A40");
	assertResolvedThemeColor(theme, "borderAccent", "#7FB4CA");
	assertResolvedThemeColor(theme, "selectedBg", "#232A40");
	assertResolvedThemeColor(theme, "thinkingText", "#5C6170");
	assertResolvedThemeColor(theme, "bashMode", "#7FB4CA");
	assertResolvedThemeColor(theme, "toolSuccessBg", "#1a2e1a");
	assertResolvedThemeColor(theme, "toolErrorBg", "#2e1a1a");
	assertResolvedThemeColor(theme, "toolPendingBg", "#0d0f14");
	assertResolvedThemeColor(theme, "mdHeading", "#B5B2D0");
	assertResolvedThemeColor(theme, "mdLink", "#7FB4CA");
	assertResolvedThemeColor(theme, "mdCode", "#B7CC85");
	assertResolvedThemeColor(theme, "mdQuote", "#DEBA87");
	assertResolvedThemeColor(theme, "syntaxComment", "#8394A3");
	assertResolvedThemeColor(theme, "syntaxKeyword", "#C99AD6");
	assertResolvedThemeColor(theme, "syntaxFunction", "#B99BF2");
	assertResolvedThemeColor(theme, "syntaxString", "#DFBD76");
	assertResolvedThemeColor(theme, "syntaxNumber", "#A4DAA7");
	assertResolvedThemeColor(theme, "syntaxType", "#8FB8DD");
	assertResolvedThemeColor(theme, "syntaxPunctuation", "#96A2B0");
});
