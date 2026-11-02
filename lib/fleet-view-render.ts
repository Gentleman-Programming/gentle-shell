import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CARD_TONE, renderCard } from "./shell-card.ts";
import { paintGauge } from "./shell-gauge.ts";
import { nextDensity, type AttentionQueue, type FleetDensity, type FleetLens, type FleetObjectiveProgress, type FleetStatus, type LensCell, type LensRow, type LensView } from "./fleet-view.ts";

// Pure renderers for the 05-calm-deck fleet TUI (odd/tasks/fleet-orchestrator.md
// T5-U1): view model in, terminal lines out, never wider than `width`. Visual
// weight (accent + bold) belongs to the focal item only; everything else uses
// `text` or the readable secondary role.

export interface FleetViewTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
	/** Pi themes have it; the active lens tab paints with `selectedBg`. */
	bg?(role: string, text: string): string;
}

export type FleetHintContext = "input" | "focal" | "lens" | "zoom";
export const FLEET_HINT_CONTEXTS: readonly FleetHintContext[] = ["input", "focal", "lens", "zoom"];

const FOCAL_ROLE = "accent";
const SECONDARY_ROLE = "muted";
// Member hues in power density (design/system.md): exact for Gentleman-Cute
// and Gentleman-Sexy; Gentle has no theme role for its third hue.
const FRONT_HUE_ROLES = ["syntaxString", "syntaxFunction", "syntaxType"];
// Gauges outside the focal item fill in `text`: accent stays the focal weight.
const QUIET_GAUGE = { ok: "text" };
const KIND_GLYPH = { decision: "◆", blocker: "✕", review: "□", nothing: "◌" } as const;
const OPTION_KEYS_MAX = 4;
const GAUGE_WIDTH = 8;
const NAME_MAX = 20;
const ROW_LEAD = 4;
const CELL_GAP = 2;
const MIN_FLEX = 8;
const SEP = " · ";

function fit(line: string, width: number): string {
	const target = Math.max(0, Math.floor(width));
	return visibleWidth(line) <= target ? line : truncateToWidth(line, target, "…");
}

const padTo = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

// Keeps the leading parts that fit whole; only a first part that cannot fit is cut.
function fitParts(parts: string[], separator: string, width: number): string {
	let line = "";
	for (const part of parts) {
		const next = line ? `${line}${separator}${part}` : part;
		if (visibleWidth(next) > width) return line || fit(part, width);
		line = next;
	}
	return line;
}

const focalText = (theme: FleetViewTheme, text: string) => theme.bold(theme.fg(FOCAL_ROLE, text));

export function renderObjectiveStrip(progress: FleetObjectiveProgress, queue: AttentionQueue, width: number, theme: FleetViewTheme): string[] {
	const parts = [
		`${theme.fg(SECONDARY_ROLE, "◎")} ${theme.fg("text", progress.title)}`,
		`${paintGauge(progress.percent, theme, GAUGE_WIDTH, QUIET_GAUGE)} ${theme.fg("text", `${progress.percent}% of the plan`)}`,
		theme.fg(SECONDARY_ROLE, `${progress.frontsDone} of ${progress.frontsTotal} fronts done`),
		...(progress.nextStep ? [theme.fg(SECONDARY_ROLE, `next: ${progress.nextStep}`)] : []),
	];
	const { focal, more } = queue;
	const second = focal.kind === "nothing"
		? fit(theme.fg(SECONDARY_ROLE, `◌ ${focal.title}. ${focal.ask}`), width)
		: fitParts([focalText(theme, `${focal.tag} → ${focal.title}`), ...(more ? [theme.fg(SECONDARY_ROLE, `then: ${more} more`)] : []), theme.fg(SECONDARY_ROLE, "tab from the input")], "  ", width);
	return [fitParts(parts, theme.fg(SECONDARY_ROLE, SEP), width), second];
}

/** The bar above the input; empty when nothing needs the user. */
export function renderFocalBar(queue: AttentionQueue, width: number, theme: FleetViewTheme): string[] {
	const { focal, more } = queue;
	if (focal.kind === "nothing") return [];
	const shown = focal.options.slice(0, OPTION_KEYS_MAX).map((option, index) => `[${index + 1}] ${option}`);
	const extra = focal.options.length - shown.length;
	const body = [focal.ask, ...(focal.why ? [theme.fg(SECONDARY_ROLE, focal.why)] : []), [...shown, ...(extra > 0 ? [`+${extra} more in the member thread`] : [])].join("   ")];
	const card = { title: theme.bold(`${focal.tag} → ${focal.title}`), glyph: KIND_GLYPH[focal.kind], tone: CARD_TONE.INFO, body };
	return renderCard(card, theme, width, { expanded: true, hint: more ? `then: ${more} more` : "last one" }).map((line) => fit(line, width));
}

const LENS_TABS: [FleetLens, string][] = [["flows", "[f]lows"], ["map", "[m]ap"], ["costs", "[$]costs"], ["log", "[l]og"]];

export function renderLensBar(lens: FleetLens, width: number, theme: FleetViewTheme): string[] {
	const tabs = LENS_TABS.map(([key, label]) => (key === lens ? (theme.bg ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg("text", label)) : theme.fg(SECONDARY_ROLE, label)));
	return [fit(`${theme.fg(SECONDARY_ROLE, "lens:")} ${tabs.join(" ")}`, width)];
}

const cellWidth = (cell: LensCell) => (cell.gauge !== undefined ? GAUGE_WIDTH : Math.max(cell.width ?? 0, visibleWidth(cell.text)));

function paintCell(cell: LensCell, width: number, last: boolean, theme: FleetViewTheme): string {
	if (cell.gauge !== undefined) return paintGauge(cell.gauge, theme, GAUGE_WIDTH, QUIET_GAUGE);
	const text = cell.width ? " ".repeat(Math.max(0, width - visibleWidth(cell.text))) + cell.text : fit(cell.text, width);
	return theme.fg(cell.role ?? "text", last ? text : padTo(text, width));
}

// Rows share positional columns so every lens lines up; the flexible column
// takes what the row leaves and is the one cut when the panel is narrow.
function columnWidths(rows: LensRow[], nameWidth: number, width: number): number[] {
	const widths: number[] = [];
	let flex = -1;
	for (const row of rows) row.cells.forEach((cell, index) => {
		widths[index] = Math.max(widths[index] ?? 0, cellWidth(cell));
		if (cell.flex) flex = index;
	});
	const used = ROW_LEAD + nameWidth + widths.reduce((sum, w) => sum + CELL_GAP + w, 0);
	if (flex >= 0 && used > width) widths[flex] = Math.max(MIN_FLEX, widths[flex] - (used - width));
	return widths;
}

function paintRow(row: LensRow, nameWidth: number, widths: number[], theme: FleetViewTheme): string {
	const glyph = theme.fg(row.tone ?? (row.state === "done" ? "success" : "text"), row.glyph);
	const name = padTo(fit(row.name, nameWidth), row.cells.length ? nameWidth : 0);
	const painted = row.focal ? focalText(theme, name) : theme.fg(row.hue === null ? "text" : FRONT_HUE_ROLES[row.hue], name);
	const cells = row.cells.map((cell, index) => `${" ".repeat(CELL_GAP)}${paintCell(cell, widths[index], index === row.cells.length - 1, theme)}`);
	return ["  ", glyph, " ", painted, ...cells].join("");
}

export interface LensPanelOptions {
	/** Groups shown as one header line; defaults to the groups 05 folds. */
	collapsed?: ReadonlySet<string>;
}

/** Head lines, then attention-first groups with one row per member. */
export function renderLensPanel(view: LensView, width: number, theme: FleetViewTheme, options: LensPanelOptions = {}): string[] {
	const nameWidth = Math.min(NAME_MAX, Math.max(4, ...view.groups.flatMap((group) => group.rows.map((row) => visibleWidth(row.name)))));
	const widths = columnWidths(view.groups.flatMap((group) => group.rows), nameWidth, width);
	const lines = view.head.map((line, index) => theme.fg(index === 1 ? "text" : SECONDARY_ROLE, line));
	for (const group of view.groups) {
		const folded = options.collapsed ? options.collapsed.has(group.key) : !group.open;
		const label = `${folded ? "▸" : "▾"} ${group.label} (${group.count})`;
		// A folded group that holds the focal member carries the mark for it.
		const head = folded && group.focal ? focalText(theme, label) : theme.fg("text", label);
		lines.push("", `${head}${group.summary ? `  ${theme.fg(SECONDARY_ROLE, group.summary)}` : ""}`);
		if (!folded) for (const row of group.rows) lines.push(paintRow(row, nameWidth, widths, theme));
	}
	return lines.map((line) => fit(line, width));
}

// The right part (lens and density) stays only when the left part leaves room for it.
function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
}

export function renderStatusLine(status: FleetStatus, lens: FleetLens, density: FleetDensity, width: number, theme: FleetViewTheme): string[] {
	const parts = [`${status.live} of ${status.members} members live`, status.queue];
	// Spend shows outside the costs lens only in power density.
	if (density === "power") parts.push(status.budgetUsd ? `$${status.spentUsd.toFixed(2)} of $${status.budgetUsd.toFixed(2)}` : `$${status.spentUsd.toFixed(2)} spent`);
	return [spread(fitParts(parts.map((part) => theme.fg("text", part)), theme.fg(SECONDARY_ROLE, SEP), width), theme.fg(SECONDARY_ROLE, `lens ${lens}${SEP}density ${density}`), width)];
}

const DENSITY_GIVES: Record<FleetDensity, string> = { light: "the current task per member", normal: "gauges, costs and front colors on every row", power: "back to the calm view" };

export function renderHintLine(context: FleetHintContext, queue: AttentionQueue, density: FleetDensity, width: number, theme: FleetViewTheme): string[] {
	const key = (k: string, words: string) => `${theme.fg("text", k)} ${theme.fg(SECONDARY_ROLE, words)}`;
	const next = nextDensity(density);
	const more = key("alt+m", `${density === "power" ? "less" : "more"} detail: ${next}, ${DENSITY_GIVES[density]}`);
	const options = Math.min(OPTION_KEYS_MAX, queue.focal.options.length) || 1;
	const parts = {
		input: [...(queue.focal.kind === "nothing" ? [] : [key("tab", queue.focal.tag.toLowerCase())]), key("enter", "send"), key("F1-F4", "lenses"), key("F5", "zoom"), more, key("@name", "talk to one member")],
		focal: [key(`1-${options}`, "choose"), key("tab", "back to the conversation"), key("f m $ l", "lenses"), key("z", "zoom"), key("?", "help")],
		lens: [key("f m $ l", "switch lens"), key("z", "zoom"), more],
		zoom: [key("z", "back to the conversation"), key("f m $ l", "switch lens")],
	}[context];
	return [fitParts(parts, "   ", width)];
}
