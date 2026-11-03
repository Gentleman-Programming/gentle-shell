import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GAUGE_CELLS, gaugeTone, paintGauge, renderGauge, type GaugePaint, type GaugeTone } from "./shell-gauge.ts";
import { renderUsageBar, selectUsageLimit, type ProviderUsage, type UsageWindow } from "./shell-usage.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { HOVER_ROLE } from "./shell-hover.ts";
import { CARD_TONE, floatRows, paintSurfaceRow, panelInnerWidth, renderCard, surfaceOpener } from "./shell-card.ts";
import { clipPanelText, fitPanelLine, PANEL_ROW_INDENT, PANEL_SURFACE_ROLE, renderPanelHeader, renderPanelRow } from "./shell-panel.ts";
import { REVIEW_SCOPE_UNAVAILABLE, REVIEW_SIDEBAR_LABELS, type ReviewSidebarSnapshot } from "./review-sidebar-state.ts";
import type { VisualSettings } from "./visual-customization-policy.ts";
import { renderChangesWidget, type ChangesModel } from "./shell-changes.ts";
import type { RunningJobDisplay } from "./jobs-sidebar-state.ts";
import { JOB_GLYPH } from "./background-jobs-tools.ts";

type Presentation = Pick<VisualSettings, "density" | "visibility">;
type HeaderPresentation = Presentation & Partial<Pick<VisualSettings, "headerPlacement" | "statusPlacement">>;

export { gaugeTone, renderGauge, type GaugeTone };

// Gentle Shell status bar: one line of segments that replaces pi's built-in
// three-line footer. Everything here is pure so the bar can be rendered and
// verified without a live TUI.

export interface ShellBarModel {
	review?: ReviewSidebarSnapshot;
	jobs?: RunningJobDisplay[];
	profile?: string;
	changes?: { files: number; added: number; deleted: number };
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
	/** The permission mode published under its own status key, shown once in the status bar. */
	permission?: { mode: string; detail?: string };
	/** Statuses for the rail's Integrations: `statuses` without the permission keys. */
	integrations?: string[];
}

// The live header row above the fullscreen rail: session identity plus the
// live counters. Only the structured jobs count may join context/cost when
// Status is absent; opaque extension statuses and working state stay excluded.
export interface ShellHeaderModel {
	jobs?: number;
	cwd: string;
	branch: string | null;
	dirty: number | undefined;
	modelId: string;
	effort: string | undefined;
	profile?: string;
	contextPercent: number | null;
	costTotal: number;
	subscription: boolean;
	// The active provider's subscription usage, shown as its own segment after
	// cost. Unlike the sidebar's old per-model usage table, this is one
	// compact line — the same windows the compact bar already meters.
	usage: ProviderUsage | undefined;
}

export function buildShellHeaderModel(model: ShellBarModel, showJobs = false): ShellHeaderModel {
	const { cwd, branch, dirty, modelId, effort, profile, contextPercent, costTotal, subscription, usage } = model;
	return { cwd, branch, dirty, modelId, effort, profile, contextPercent, costTotal, subscription, usage,
		...(showJobs && model.jobs?.length ? { jobs: model.jobs.length } : {}) };
}

export function shellJobsCount(count: number): string {
	return `${JOB_GLYPH} ${count} job${count === 1 ? "" : "s"}`;
}

/** A column span (`[start, end)`, in the rendered line's visible columns) a click must land in to hit the usage segment. */
export interface HeaderUsageSpan {
	start: number;
	end: number;
}

export interface ShellHeaderResult {
	text: string;
	usageSpan?: HeaderUsageSpan;
}

export interface ShellHeaderChrome {
	rows: string[];
	headerRow: number;
	usageSpan?: HeaderUsageSpan;
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

export const SHELL_BAR_BRAND = "✿ gentle shell";
export const SHELL_BAR_SEPARATOR = "⟡";
export const SHELL_BAR_GAUGE_CELLS = GAUGE_CELLS;
const RIGHT_PADDING = 2;
const COMPACT_BRANCH_WIDTH = 15;

export function shellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return false;
	const value = env.GENTLE_PI_SHELL?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}

// Herdr's native Pi detection matches Pi's standard loader row ("⠋ Working...").
// Inside a Herdr pane keep that row, which Pi shows only during real activity,
// so detection works without a local manifest override.
export function keepNativeWorkingRow(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && env.GENTLE_PI_AGENTS_CHILD !== "1";
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(total: number, subscription = false): string {
	const amount = total >= 1 ? total.toFixed(2) : total.toFixed(3);
	return subscription ? `$${amount} sub` : `$${amount}`;
}

// Extensions may paint their status themselves (pi-mcp-adapter does); the bar
// owns the palette, so their escapes go and the text takes the status role.
function sanitizeStatus(text: string): string {
	return sanitizeTerminalText(text.replace(/[\r\n\t]/g, " ")).replace(/ +/g, " ").trim();
}

// Shared by the compact bar, the sidebar Status card, and the fullscreen
// header row, so the three surfaces never drift on how they paint the same
// facts.
function locationSegment(model: Pick<ShellBarModel, "cwd" | "branch" | "dirty">, theme: ShellBarTheme): string {
	const dirty = model.dirty ? ` ${theme.fg(ROLE.DIRTY, `±${model.dirty}`)}` : "";
	return model.branch
		? `${theme.fg(ROLE.PATH, model.cwd)} ${theme.fg(ROLE.BRANCH, model.branch)}${dirty}`
		: theme.fg(ROLE.PATH, model.cwd) + dirty;
}

function executionSegment(modelId: string, effort: string | undefined, theme: ShellBarTheme): string {
	return effort
		? `${theme.fg(ROLE.MODEL, modelId)} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(ROLE.EFFORT, effort)}`
		: theme.fg(ROLE.MODEL, modelId);
}

function contextSegment(contextPercent: number | null, theme: ShellBarTheme, paint?: GaugePaint): string {
	const percentText = contextPercent === null ? "?%" : `${Math.round(contextPercent)}%`;
	return `${theme.fg(ROLE.LABEL, "ctx")} ${paintGauge(contextPercent, theme, GAUGE_CELLS, paint)} ${theme.fg(ROLE.VALUE, percentText)}`;
}

function costSegment(costTotal: number, subscription: boolean, theme: ShellBarTheme): string {
	return theme.fg(ROLE.VALUE, formatCost(costTotal, subscription));
}

function buildSegments(model: ShellBarModel, theme: ShellBarTheme, presentation?: Presentation, paint?: GaugePaint): string[] {
	const location = locationSegment(model, theme);
	const modelSegment = executionSegment(model.modelId, model.effort, theme);
	const context = contextSegment(model.contextPercent, theme, paint);
	const cost = costSegment(model.costTotal, model.subscription, theme);
	const usage = model.usage ? renderUsageBar(model.usage, theme, model.modelId, paint) : undefined;
	const statuses = model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status)));
	return [
		...(presentation?.density === "minimal" ? [] : [theme.fg(ROLE.BRAND, SHELL_BAR_BRAND)]),
		location,
		...(presentation?.visibility.modelDetails === false ? [] : [modelSegment]),
		...(presentation?.visibility.usageCost === false ? [] : [context, cost, ...(usage ? [usage] : [])]),
		...(model.jobs?.length ? [theme.fg(ROLE.STATUS, shellJobsCount(model.jobs.length))] : []),
		...statuses,
	];
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
// The fullscreen rail's Status, drawn as panel sections (design/shell-rework/02-proposal.html):
// Changes, Review (only with current-session RDD evidence) and Integrations.
// Location, model and profile live in the header row, so they never repeat
// here. Opaque integration statuses wrap so none of their meaning is clipped,
// and the optional key hints close the rail.
export function renderShellSidebarBar(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation, hints?: string, options: StatusSectionsOptions = {}): string[] {
	return renderShellStatusSections(model, theme, width, presentation, hints, options).lines;
}

export type StatusSection = "session" | "changes" | "review" | "integrations";
export type StatusTarget = { row: number; kind: "toggle"; section: StatusSection } | { row: number; kind: "open-changes" };
export interface StatusSectionsOptions {
	/** Keep the session name (no title row shows it). */
	session?: boolean;
	/** Sections folded to their header. */
	collapsed?: ReadonlySet<StatusSection>;
	/** The pointer is over this section's header, or over the Changes row. */
	hovered?: StatusSection | "open-changes";
}

/** The rail Status with its click targets: section headers collapse them and the Changes row opens /gentle:changes. */
export function renderShellStatusSections(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation, hints?: string, options: StatusSectionsOptions = {}): { lines: string[]; targets: StatusTarget[] } {
	const label = (text: string) => theme.fg(ROLE.LABEL, text);
	const wrapped = (text: string, role: string) => wrapTextWithAnsi(text, Math.max(1, width - PANEL_ROW_INDENT)).map((line) => renderPanelRow(width, theme.fg(role, line)));
	type Section = { key?: StatusSection; header?: string; rows: string[]; openChangesRow?: number };
	const sections: Section[] = [];
	const header = (key: StatusSection, title: string, count?: string, countRole?: string) => renderPanelHeader(theme, width, { title, count, countRole, open: !options.collapsed?.has(key), hovered: options.hovered === key });
	// Without the top title row (header below the input) the session name has no
	// other home, so the rail keeps it.
	if (options.session && model.sessionName) {
		sections.push({ key: "session", header: header("session", "Session"), rows: wrapped(sanitizeStatus(model.sessionName), ROLE.VALUE) });
	}
	if (presentation?.visibility.changes !== false) {
		const changes = model.changes;
		const command = options.hovered === "open-changes" ? theme.fg(HOVER_ROLE, "/gentle:changes") : label("/gentle:changes");
		sections.push({
			key: "changes",
			header: header("changes", "Changes", changes?.files ? `${changes.files} ${changes.files === 1 ? "file" : "files"}` : "clean"),
			rows: [renderPanelRow(width, changes?.files ? `${theme.fg("success", `+${changes.added}`)} ${theme.fg("error", `−${changes.deleted}`)}` : label("no captured changes"), command)],
			openChangesRow: 0,
		});
	}
	if (model.review && presentation?.visibility.rdd !== false) {
		const needsYou = model.review.state === "consent";
		sections.push({
			key: "review",
			header: header("review", "Review", needsYou ? "needs you" : undefined, "warning"),
			rows: [
				...wrapped(REVIEW_SIDEBAR_LABELS[model.review.state], needsYou ? "warning" : ROLE.VALUE),
				// Unknown scope is an internal sentinel, not something the user acts on.
				...(model.review.scope !== REVIEW_SCOPE_UNAVAILABLE ? wrapped(sanitizeStatus(model.review.scope), ROLE.LABEL) : []),
			],
		});
	}
	// The status bar shows the permission mode once; Integrations only says
	// what it means, so neither the mode nor its banner repeats here.
	const integrations = model.integrations ?? model.statuses;
	const permission = model.permission?.detail ? wrapTextWithAnsi(`${label("permissions")} ${theme.fg(ROLE.STATUS, sanitizeStatus(model.permission.detail))}`, Math.max(1, width - PANEL_ROW_INDENT)).map((line) => renderPanelRow(width, line)) : [];
	const count = integrations.length + (permission.length ? 1 : 0);
	sections.push({
		key: "integrations",
		header: header("integrations", "Integrations", count ? String(count) : "none"),
		rows: [...permission, ...(integrations.length ? integrations.flatMap((status) => wrapped(sanitizeStatus(status), ROLE.STATUS)) : permission.length ? [] : [renderPanelRow(width, label("no status reported"))])],
	});
	if (hints) sections.push({ rows: [renderPanelRow(width, label(hints))] });
	const gap = !presentation || presentation.density === "comfortable" ? [" ".repeat(Math.max(0, width))] : [];
	const lines: string[] = [];
	const targets: StatusTarget[] = [];
	sections.forEach((section, index) => {
		if (index) lines.push(...gap);
		if (section.key && section.header) {
			targets.push({ row: lines.length, kind: "toggle", section: section.key });
			lines.push(section.header);
			if (options.collapsed?.has(section.key)) return;
		}
		if (section.openChangesRow !== undefined) targets.push({ row: lines.length + section.openChangesRow, kind: "open-changes" });
		lines.push(...section.rows);
	});
	return { lines, targets };
}

// The wide fullscreen chrome (design/shell-rework/02-proposal.html): a title row
// with the project identity above the transcript and the rail, and one status
// bar row below them. Both sit on the rail's panel surface.
const STATUS_BAR_DIVIDER = "│";
const paintChromeRow = (theme: ShellBarTheme, row: string) => paintSurfaceRow(row, surfaceOpener(theme, PANEL_SURFACE_ROLE));

/** `✿ name  path` left, the session name and profile right; the path gives way first, so the profile always shows. */
export function renderShellTitleRow(model: ShellBarModel, theme: ShellBarTheme, width: number, options: { model?: boolean } = {}): string {
	const target = Math.max(0, Math.floor(width));
	const name = model.cwd.split("/").filter((part) => part.length > 0).pop() ?? model.cwd;
	const left = `${theme.fg(ROLE.BRAND, "✿")} ${theme.fg(ROLE.VALUE, theme.bold(name))}  ${theme.fg(ROLE.PATH, model.cwd)}`;
	// Mobile: the narrow status bar leaves the model out, so the title row carries it.
	const right = options.model
		? executionSegment(model.modelId, model.effort, theme)
		: [model.sessionName ? theme.fg(ROLE.VALUE, sanitizeStatus(model.sessionName)) : "", model.profile ? theme.fg(ROLE.LABEL, sanitizeStatus(model.profile)) : ""]
			.filter(Boolean).join(theme.fg(ROLE.SEPARATOR, " · "));
	return paintChromeRow(theme, ` ${fitPanelLine(left, right, Math.max(0, target - 2))} `);
}

/**
 * The status bar: branch, dirty count and a non-default permission mode on
 * the left; model · effort, context, cost and usage on the right. Usage gives
 * way first (gauges, secondary windows, the segment), then the model; the
 * usage segment stays the click target that opens the usage view.
 */
export function renderShellStatusBar(model: ShellBarModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, paint?: GaugePaint, extras: { jobs?: boolean } = {}): ShellHeaderChrome {
	const target = Math.max(0, Math.floor(width));
	const divider = ` ${theme.fg(ROLE.SEPARATOR, STATUS_BAR_DIVIDER)} `;
	const join = (segments: string[]) => segments.filter(Boolean).join(divider);
	const dirty = model.dirty ? theme.fg(ROLE.DIRTY, `±${model.dirty}`) : "";
	const branch = [model.branch ? theme.fg(ROLE.BRANCH, model.branch) : "", dirty].filter(Boolean).join(" ");
	const mode = model.permission && model.permission.mode !== "NORMAL" ? theme.fg("warning", theme.bold(sanitizeStatus(model.permission.mode))) : "";
	// Without a rail (mobile) the running jobs keep their compact count here.
	const runningJobs = extras.jobs ? (model.jobs?.filter((job) => job.status === undefined).length ?? 0) : 0;
	const tail = join([mode, runningJobs ? theme.fg(ROLE.STATUS, shellJobsCount(runningJobs)) : ""]);
	const left = join([branch, tail]);
	const showCounters = presentation?.visibility.usageCost !== false;
	const exec = presentation?.visibility.modelDetails === false ? "" : executionSegment(model.modelId, model.effort, theme);
	const counters = showCounters ? [contextSegment(model.contextPercent, theme, paint), costSegment(model.costTotal, model.subscription, theme)] : [];
	const windows = model.usage ? (selectUsageLimit(model.usage, model.modelId)?.windows ?? []) : [];
	const stages: Array<UsageStage | undefined> = showCounters ? ["full", "text", "primary", undefined] : [undefined];
	const attempts = [...stages.map((stage) => ({ stage, withExec: true })), { stage: undefined, withExec: false }];
	for (const { stage, withExec } of attempts) {
		const usage = stage ? usageSegmentText(windows, theme, stage, usageHint, paint) : "";
		const right = join([withExec ? exec : "", ...counters, usage]);
		const room = target - 2;
		if (visibleWidth(left) + (right ? RIGHT_PADDING : 0) + visibleWidth(right) > room) continue;
		const row = ` ${left}${" ".repeat(room - visibleWidth(left) - visibleWidth(right))}${right} `;
		const usageSpan = usage ? { start: target - 1 - visibleWidth(usage), end: target - 1 } : undefined;
		return { rows: [paintChromeRow(theme, row)], headerRow: 0, ...(usageSpan ? { usageSpan } : {}) };
	}
	// Still too wide (a phone, a long branch): the branch gives way before the
	// context and cost, which give way last, context after cost.
	const room = Math.max(0, target - 2);
	const tailWidth = tail ? visibleWidth(tail) + (branch ? visibleWidth(divider) : 0) : 0;
	for (const right of [join(counters), counters[0] ?? "", ""]) {
		const leftRoom = room - visibleWidth(right) - (right ? RIGHT_PADDING : 0);
		const branchRoom = leftRoom - tailWidth;
		if (branch && branchRoom < 4 && right) continue;
		const fitted = join([branch ? clipPanelText(branch, Math.max(1, branchRoom)) : "", tail]);
		if (visibleWidth(fitted) > leftRoom && right) continue;
		return { rows: [paintChromeRow(theme, ` ${fitPanelLine(fitted, right, room)} `)], headerRow: 0 };
	}
	return { rows: [paintChromeRow(theme, ` ${fitPanelLine(left, "", room)} `)], headerRow: 0 };
}

const HEADER_BRAND = "✿ Gentle Shell";

// Narrower than the width, widest first: dropping the profile, then the
// effort, then the whole location keeps the brand and the model alive.
// Once location goes, restore effort if it fits before trying model-only
// alongside the right-aligned counters.
function headerLeftStages(model: ShellHeaderModel, theme: ShellBarTheme, showModelDetails: boolean): string[][] {
	const brand = theme.fg(ROLE.BRAND, theme.bold(HEADER_BRAND));
	const location = locationSegment(model, theme);
	if (!showModelDetails) return [[brand, location], [brand]];
	const withEffort = executionSegment(model.modelId, model.effort, theme);
	const modelOnly = executionSegment(model.modelId, undefined, theme);
	const withProfile = model.profile ? `${withEffort} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(ROLE.MODEL, sanitizeStatus(model.profile))}` : withEffort;
	return [
		[brand, location, withProfile],
		[brand, location, withEffort],
		[brand, location, modelOnly],
		...(model.effort ? [[brand, withEffort]] : []),
		[brand, modelOnly],
		[brand],
	];
}

const USAGE_LABEL_ROLE = ROLE.LABEL;
const USAGE_HINT_ROLE = "dim";

function usageWindowText(window: UsageWindow, theme: ShellBarTheme, withGauge: boolean, paint?: GaugePaint): string {
	const percent = `${Math.round(window.usedPercent)}%`;
	const parts = [
		...(window.label.length > 0 ? [theme.fg(ROLE.LABEL, window.label)] : []),
		...(withGauge ? [paintGauge(window.usedPercent, theme, GAUGE_CELLS, paint)] : []),
		theme.fg(ROLE.VALUE, percent),
	];
	return parts.join(" ");
}

// Three degrading shapes for the same windows, narrowest last: every window
// with its gauge, every window as text only, or just the first window as
// text only. A provider with no usage data at all has no windows to shape,
// so all three collapse to the bare "usage" label plus the shortcut hint.
type UsageStage = "full" | "text" | "primary";
function usageSegmentText(windows: UsageWindow[], theme: ShellBarTheme, stage: UsageStage, hint: string | undefined, paint?: GaugePaint): string {
	const label = theme.fg(USAGE_LABEL_ROLE, "usage");
	const shown = stage === "primary" ? windows.slice(0, 1) : windows;
	const body = shown.map((window) => usageWindowText(window, theme, stage === "full", paint)).join(` ${theme.fg(ROLE.LABEL, "·")} `);
	const head = body.length > 0 ? `${label} ${body}` : label;
	return hint ? `${head} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(USAGE_HINT_ROLE, hint)}` : head;
}

// The float header is a full-width INFO background bar with a two-column
// inset on each side, closed below by the header edge line. floatRows paints
// the background inside one-column transparent margins; those margin cells
// are painted too, so the bar reaches both edges. Undefined for neon, a width
// under the float minimum, or a theme without a background.
function floatHeaderRow(theme: ShellBarTheme, width: number, content: (width: number) => string): string | undefined {
	const painted = floatHeaderPaint(theme, width, content);
	if (painted === undefined) return undefined;
	const { inner, open } = painted;
	// The background spans the full width: the margin cells are painted too, so
	// the bar reaches both edges with no frame on its sides.
	const side = `${open} `;
	return `${side}${inner.slice(open.length, -BG_RESET.length)}${side}${BG_RESET}`;
}

function fitHeaderContent(text: string, width: number): string {
	const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderShellHeaderBar(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, paint?: GaugePaint): ShellHeaderResult {
	const targetWidth = Math.max(0, Math.floor(width));
	let content: ShellHeaderResult | undefined;
	let contentWidth = targetWidth;
	const row = floatHeaderRow(theme, targetWidth, (inner) => {
		contentWidth = inner;
		content = headerContent(model, theme, inner, usageHint, presentation, paint);
		return content.text;
	});
	if (row === undefined || !content) return headerContent(model, theme, width, usageHint, presentation, paint);
	const { usageSpan } = content;
	// The inset splits evenly around the content, so its left share is where
	// the content's columns start.
	const offset = (targetWidth - contentWidth) / 2;
	return usageSpan ? { text: row, usageSpan: { start: usageSpan.start + offset, end: usageSpan.end + offset } } : { text: row };
}

/** Shared geometry for the rail header and the below-editor header widget. */
export function renderShellHeaderChrome(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, paint?: GaugePaint): ShellHeaderChrome {
	const { text, usageSpan } = renderShellHeaderBar(model, theme, width, usageHint, presentation, paint);
	const targetWidth = Math.max(0, Math.floor(width));
	const painted = floatHeaderPaint(theme, targetWidth, () => "");
	const rule = renderShellHeaderRule(theme, targetWidth);
	if (painted === undefined) return { rows: [text, rule], headerRow: 0, usageSpan };
	const padding = `${painted.open}${" ".repeat(targetWidth)}${BG_RESET}`;
	if (presentation?.headerPlacement === "below-input") {
		// A lower one-eighth block hugs the painted padding in the next row.
		const upperEdge = theme.fg(HEADER_RULE_ROLE, "▁".repeat(targetWidth));
		return { rows: [upperEdge, padding, text, padding], headerRow: 2, usageSpan };
	}
	return { rows: [padding, text, padding, rule], headerRow: 1, usageSpan };
}

/** The usage segment is interactive only on the content row, never padding or the edge. */
export function shellHeaderUsageHit(chrome: ShellHeaderChrome, x: number, y: number): boolean {
	const { usageSpan } = chrome;
	return y === chrome.headerRow && usageSpan !== undefined && x >= usageSpan.start && x < usageSpan.end;
}

function headerContent(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, paint?: GaugePaint): ShellHeaderResult {
	const targetWidth = Math.max(0, Math.floor(width));
	const jobs = model.jobs ? theme.fg(ROLE.STATUS, shellJobsCount(model.jobs)) : undefined;
	const ctxCost = joinSegments([
		...(jobs ? [jobs] : []),
		...(presentation?.visibility.usageCost === false ? [] : [contextSegment(model.contextPercent, theme, paint), costSegment(model.costTotal, model.subscription, theme)]),
	], theme);
	const windows = model.usage ? (selectUsageLimit(model.usage, model.modelId)?.windows ?? []) : [];
	const leftStages = headerLeftStages(model, theme, presentation?.visibility.modelDetails !== false)
		.map((stage) => presentation?.density === "minimal" ? stage.slice(1) : stage);
	const minimalLeft = Math.max(0, leftStages.length - 2); // brand + bare model id, before dropping the model too
	// One flat, ordered cascade — never a per-stage nested search — so the
	// left group fully degrades (profile → effort → location → restored effort) before usage
	// ever gives anything up, and usage fully degrades (gauges → secondary
	// windows → the whole segment) before ctx/cost is touched: every window
	// with its gauge, then text-only, then the first window only, then gone.
	// Unlike the compact bar's usage meter (hidden with no data), this is a
	// standing, clickable affordance — even with nothing to report it still
	// reads "usage" plus the shortcut hint, unless disabled, width permitting.
	const usageStages: Array<UsageStage | undefined> = presentation?.visibility.usageCost === false ? [undefined] : ["full", "text", "primary", undefined];
	const attempts: Array<{ leftIndex: number; usageStage: UsageStage | undefined }> = [
		...leftStages.slice(0, minimalLeft).map((_, leftIndex) => ({ leftIndex, usageStage: usageStages[0] })),
		...usageStages.map((usageStage) => ({ leftIndex: minimalLeft, usageStage })),
		{ leftIndex: leftStages.length - 1, usageStage: undefined },
	];
	for (const { leftIndex, usageStage } of attempts) {
		const usageText = usageStage ? usageSegmentText(windows, theme, usageStage, usageHint, paint) : undefined;
		const right = usageText ? joinSegments([ctxCost, usageText], theme) : ctxCost;
		const left = joinSegments(leftStages[leftIndex]!, theme);
		if (visibleWidth(left) + (right ? RIGHT_PADDING : 0) + visibleWidth(right) > targetWidth) continue;
		const text = left + " ".repeat(targetWidth - visibleWidth(left) - visibleWidth(right)) + right;
		if (!usageText) return { text };
		const usageStart = visibleWidth(left) + (targetWidth - visibleWidth(left) - visibleWidth(right)) + visibleWidth(ctxCost) + visibleWidth(` ${SHELL_BAR_SEPARATOR} `);
		return { text, usageSpan: { start: usageStart, end: usageStart + visibleWidth(usageText) } };
	}
	const brand = presentation?.density === "minimal" ? "" : theme.fg(ROLE.BRAND, theme.bold(HEADER_BRAND));
	if (jobs && visibleWidth(jobs) <= targetWidth) {
		const left = visibleWidth(brand) + RIGHT_PADDING + visibleWidth(jobs) <= targetWidth ? brand : "";
		return { text: left + " ".repeat(targetWidth - visibleWidth(left) - visibleWidth(jobs)) + jobs };
	}
	return { text: visibleWidth(brand) <= targetWidth ? brand : "" };
}

// A single owner supplies real captured filenames, not ShellBarModel's totals.
// Undefined keeps every legacy surface alive for style/width/theme transitions.
export function renderShellBelowInputFloat(model: ShellBarModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, changes?: ChangesModel, paint?: GaugePaint): ShellHeaderChrome | undefined {
	if (presentation?.headerPlacement !== "below-input") return undefined;
	const targetWidth = Math.max(0, Math.floor(width));
	if (floatHeaderPaint(theme, targetWidth, () => "") === undefined) return undefined;
	const chrome = renderShellHeaderChrome(buildShellHeaderModel(model, presentation.statusPlacement === "hidden"), theme, targetWidth, usageHint, presentation, paint);
	// The row exists only while files are actually tracked; an unborn-only root
	// is silence here (/gentle:changes explains the state on demand).
	const changesRow = Boolean(changes && changes.files.length > 0) && presentation.visibility.changes !== false
		? floatHeaderRow(theme, targetWidth, (inner) => renderChangesWidget(changes, theme, inner)[0] ?? "")
		: undefined;
	const statuses = presentation.statusPlacement === "hidden" ? [] : [
		...(model.jobs?.length ? [shellJobsCount(model.jobs.length)] : []),
		...model.statuses.map(sanitizeStatus).filter(Boolean),
	];
	const statusRow = statuses.length
		? floatHeaderRow(theme, targetWidth, () => joinSegments(statuses.map((status) => theme.fg(ROLE.STATUS, status)), theme))
		: undefined;
	return {
		rows: [
			chrome.rows[0]!,
			chrome.rows[1]!,
			...(changesRow ? [changesRow] : []),
			chrome.rows[2]!,
			...(statusRow ? [statusRow] : []),
			chrome.rows[3]!,
		],
		headerRow: changesRow ? 3 : 2,
		usageSpan: chrome.usageSpan,
	};
}

// The bottom bar when it is the only status row of a narrow fullscreen
// terminal (the header sits below the input and steps aside). It reuses the
// header row's own cascade, so context, cost and usage outlive the location
// on small screens, and keeps extension statuses on a second line instead of
// dropping them the way the header deliberately does.
export function renderShellBottomOnlyBar(model: ShellBarModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, changes?: ChangesModel, paint?: GaugePaint): string[] {
	const grouped = renderShellBelowInputFloat(model, theme, width, usageHint, presentation, changes, paint);
	if (grouped) return grouped.rows;
	const headerModel = buildShellHeaderModel(model, true);
	// Neon, missing backgrounds and sub-minimum widths keep the old row count.
	const rows = [headerContent(headerModel, theme, width, usageHint, presentation, paint).text];
	const statuses = model.statuses.map(sanitizeStatus).filter((status) => status.length > 0).map((status) => theme.fg(ROLE.STATUS, status));
	return statuses.length ? [...rows, truncateToWidth(joinSegments(statuses, theme), Math.max(0, Math.floor(width)), "…")] : rows;
}

// The rule row painted directly under the header bar: one full-width horizontal
// line in the same theme role as the editor frame (PROMPT_FRAME_ROLE in
// extensions/gentle-shell.ts), so the status row and the prompt read as one
// panel. It exists only while the fullscreen sidebar is active — when the
// sidebar is not shown the header rail never renders and the rule goes away
// with it.
const HEADER_RULE_CHAR = "─";
const HEADER_RULE_ROLE = "border";
const HEADER_EDGE_CHAR = "▔";
const BG_RESET = "\x1b[49m";

// Paints the header content with floatRows and returns the row without its
// transparent margins plus the background opener. The painted row is
// `<open> <content> <reset>`; the opener has no spaces, so the first space ends
// it. Undefined when the float style does not apply.
function floatHeaderPaint(theme: ShellBarTheme, width: number, content: (width: number) => string): { inner: string; open: string } | undefined {
	let floated = false;
	const [row] = floatRows(CARD_TONE.INFO, theme, width, (inner) => {
		floated = inner !== width;
		return floated ? { body: [` ${fitHeaderContent(content(inner - 2), inner - 2)} `] } : {};
	});
	if (!floated || row === undefined) return undefined;
	const inner = row.slice(1, -1);
	return { inner, open: inner.slice(0, inner.indexOf(" ")) };
}

// In the float style the rule closes the hanging header tab with an upper
// one-eighth block line. Box-drawing lines sit mid-cell: a transparent `└──┘`
// leaves half an unpainted row under the tab, and a painted one overshoots it.
// `▔` hugs the top of its cell, so the line touches the tab's background
// exactly. The edge stays transparent beneath the painted bottom padding.
export function renderShellHeaderRule(theme: ShellBarTheme, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (floatHeaderPaint(theme, targetWidth, () => "") !== undefined) return theme.fg(HEADER_RULE_ROLE, HEADER_EDGE_CHAR.repeat(targetWidth));
	return theme.fg(HEADER_RULE_ROLE, HEADER_RULE_CHAR.repeat(targetWidth));
}

export function renderShellBar(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation, paint?: GaugePaint): string[] {
	let segments = buildSegments(model, theme, presentation, paint);
	const right = model.sessionName ? theme.fg(ROLE.SESSION, model.sessionName) : undefined;

	let left = joinSegments(segments, theme);
	if (right && visibleWidth(left) + RIGHT_PADDING + visibleWidth(right) <= width) {
		const padding = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
		return [left + padding + right];
	}

	if (visibleWidth(left) > width) {
		segments = buildSegments(compactModel(model), theme, presentation);
		left = joinSegments(segments, theme);
	}
	while (segments.length > 1 && visibleWidth(left) > width) {
		segments.pop();
		left = joinSegments(segments, theme);
	}
	return [truncateToWidth(left, width, "…")];
}
