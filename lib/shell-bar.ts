import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GAUGE_CELLS, gaugeTone, paintGauge, renderGauge, type GaugeTone } from "./shell-gauge.ts";
import { renderUsageBar, type ProviderUsage } from "./shell-usage.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { CARD_TONE, cardInnerWidth, renderCard } from "./shell-card.ts";

export { gaugeTone, renderGauge, type GaugeTone };

// Gentle Shell status bar: one line of segments that replaces pi's built-in
// three-line footer. Everything here is pure so the bar can be rendered and
// verified without a live TUI.

export interface ShellBarModel {
	profile?: string;
	cwd: string;
	branch: string | null;
	dirty: number | undefined;
	sessionName: string | undefined;
	modelId: string;
	effort: string | undefined;
	contextPercent: number | null;
	contextWindow: number;
	costTotal: number;
	subscription: boolean;
	usage: ProviderUsage | undefined;
	statuses: string[];
}

export interface ShellBarTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

// Theme roles the bar paints with. Keys are pi theme colors; the Gentle themes
// map them to the rose palette (accent = rose, syntaxFunction = powder blue).
const ROLE = {
	BRAND: "accent",
	SEPARATOR: "dim",
	PATH: "muted",
	BRANCH: "text",
	DIRTY: "warning",
	MODEL: "text",
	EFFORT: "syntaxFunction",
	LABEL: "muted",
	VALUE: "text",
	STATUS: "muted",
	SESSION: "dim",
} as const;

export const SHELL_BAR_BRAND = "✿ gentle-pi";
export const SHELL_BAR_SEPARATOR = "⟡";
export const SHELL_BAR_GAUGE_CELLS = GAUGE_CELLS;
const RIGHT_PADDING = 2;
const COMPACT_BRANCH_WIDTH = 15;

export function shellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return false;
	const value = env.GENTLE_PI_SHELL?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(total: number, subscription: boolean): string {
	const amount = total >= 1 ? total.toFixed(2) : total.toFixed(3);
	return subscription ? `$${amount} sub` : `$${amount}`;
}

// Extensions may paint their status themselves (pi-mcp-adapter does); the bar
// owns the palette, so their escapes go and the text takes the status role.
function sanitizeStatus(text: string): string {
	return sanitizeTerminalText(text.replace(/[\r\n\t]/g, " ")).replace(/ +/g, " ").trim();
}

function buildSegments(model: ShellBarModel, theme: ShellBarTheme): string[] {
	const dirty = model.dirty ? ` ${theme.fg(ROLE.DIRTY, `±${model.dirty}`)}` : "";
	const location = model.branch
		? `${theme.fg(ROLE.PATH, model.cwd)} ${theme.fg(ROLE.BRANCH, model.branch)}${dirty}`
		: theme.fg(ROLE.PATH, model.cwd) + dirty;
	const modelSegment = model.effort
		? `${theme.fg(ROLE.MODEL, model.modelId)} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(ROLE.EFFORT, model.effort)}`
		: theme.fg(ROLE.MODEL, model.modelId);
	const percentText = model.contextPercent === null ? "?%" : `${Math.round(model.contextPercent)}%`;
	const context = `${theme.fg(ROLE.LABEL, "ctx")} ${paintGauge(model.contextPercent, theme)} ${theme.fg(ROLE.VALUE, percentText)}`;
	const cost = theme.fg(ROLE.VALUE, formatCost(model.costTotal, model.subscription));
	const usage = model.usage ? renderUsageBar(model.usage, theme) : undefined;
	const statuses = model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status)));
	return [theme.fg(ROLE.BRAND, SHELL_BAR_BRAND), location, modelSegment, context, cost, ...(usage ? [usage] : []), ...statuses];
}

// When the line overflows, the location gives way first: the path shrinks to
// its last segment and a long branch is clipped, so the trailing statuses
// (MCP servers, extension notices) survive on ordinary terminal widths.
function compactModel(model: ShellBarModel): ShellBarModel {
	const cwd = model.cwd.split("/").filter((part) => part.length > 0).pop() ?? model.cwd;
	const branch = model.branch && visibleWidth(model.branch) > COMPACT_BRANCH_WIDTH ? clipText(model.branch, COMPACT_BRANCH_WIDTH) : model.branch;
	return { ...model, cwd, branch };
}

// Plain clip: pi's truncateToWidth wraps the result in resets, which would end
// up inside a painted segment.
function clipText(text: string, max: number): string {
	let clipped = "";
	for (const char of text) {
		if (visibleWidth(clipped + char) > max - 1) break;
		clipped += char;
	}
	return `${clipped}…`;
}

function joinSegments(segments: string[], theme: ShellBarTheme): string {
	return segments.join(` ${theme.fg(ROLE.SEPARATOR, SHELL_BAR_SEPARATOR)} `);
}

// Sidebar groups use structured fields, never positional compact-bar segments
// or inferred meanings from opaque extension status strings.
export function renderShellSidebarBar(model: ShellBarModel, theme: ShellBarTheme, width: number): string[] {
	const value = (text: string) => theme.fg(ROLE.VALUE, theme.bold(text));
	const label = (text: string) => theme.fg(ROLE.LABEL, text);
	const dirty = model.dirty ? theme.fg(ROLE.DIRTY, `±${model.dirty}`) : "";
	const branch = model.branch ? `${label("Branch")} ${value(model.branch)}` : "";
	const percent = model.contextPercent === null ? "?%" : `${Math.round(model.contextPercent)}%`;
	const capacity = label(`${formatTokens(model.contextWindow)} tokens`);
	const usage = model.usage ? renderUsageBar(model.usage, theme) : undefined;
	const groups: Array<{ title: string; lines: string[] }> = [
		{
			title: "Project",
			lines: [
				value(model.cwd),
				...((branch || dirty) ? [[branch, dirty].filter(Boolean).join(" ")] : []),
				...(model.sessionName ? [`${label("Session")} ${value(model.sessionName)}`] : []),
			],
		},
		{
			title: "Model",
			lines: [
				value(model.modelId),
				...(model.effort ? [`${label("Effort")} ${theme.fg(ROLE.EFFORT, model.effort)}`] : []),
				...(model.profile ? [`${label("Profile")} ${value(sanitizeStatus(model.profile))}`] : []),
			],
		},
		{
			title: "Context",
			lines: [`${paintGauge(model.contextPercent, theme)} ${value(percent)}  ${capacity}`],
		},
		{
			title: "Usage",
			lines: [`${label("Cost")} ${value(formatCost(model.costTotal, model.subscription))}`, ...(usage ? [usage] : [])],
		},
		...(model.statuses.length ? [{ title: "Integrations", lines: model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status))) }] : []),
	];
	// Pre-wrap values before indenting so Unicode/ANSI continuation lines keep
	// the same inset without consuming the card's right border.
	const innerWidth = cardInnerWidth(width);
	const inset = Math.min(1, innerWidth - 1);
	const body = groups.flatMap((group, index) => [
		...(index ? [""] : []),
		label(group.title),
		...group.lines.flatMap((line) => wrapTextWithAnsi(line, innerWidth - inset).map((part) => " ".repeat(inset) + part)),
	]);
	return renderCard({ title: "Status", body, tone: CARD_TONE.INFO }, theme, width, { expanded: true });
}

export function renderShellBar(model: ShellBarModel, theme: ShellBarTheme, width: number): string[] {
	let segments = buildSegments(model, theme);
	const right = model.sessionName ? theme.fg(ROLE.SESSION, model.sessionName) : undefined;

	let left = joinSegments(segments, theme);
	if (right && visibleWidth(left) + RIGHT_PADDING + visibleWidth(right) <= width) {
		const padding = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
		return [left + padding + right];
	}

	if (visibleWidth(left) > width) {
		segments = buildSegments(compactModel(model), theme);
		left = joinSegments(segments, theme);
	}
	while (segments.length > 1 && visibleWidth(left) > width) {
		segments.pop();
		left = joinSegments(segments, theme);
	}
	return [truncateToWidth(left, width, "…")];
}
