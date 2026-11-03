import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CARD_GLYPH, CARD_TONE, renderCard } from "./shell-card.ts";
import { paintGauge } from "./shell-gauge.ts";
import { type AttentionQueue, type FleetDensity, type FleetLens, type FleetObjectiveProgress, type FleetStatus, type LensCell, type LensRow, type LensView } from "./fleet-view.ts";

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
	const parts = !progress.stated ? [`${theme.fg(SECONDARY_ROLE, "◎")} ${theme.fg("text", "No objective yet — tell the fleet what you want to achieve")}`] : [
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

// alt+1-4 pick a tab from anywhere; letters only in the focal bar and the zoom.
const LENS_TABS: [FleetLens, string][] = [["flows", " Flows "], ["map", " Map "], ["costs", " Costs "], ["log", " Log "]];
const TABS_HINT = "alt+1-4";
const BORDER_ROLE = "border";

/** A tab bar: the active tab selected in accent, the others muted, then a rule underlining the active one. */
export function renderLensBar(lens: FleetLens, width: number, theme: FleetViewTheme): string[] {
	const target = Math.max(0, Math.floor(width));
	const selected = (label: string) => {
		const text = theme.bold(theme.fg(FOCAL_ROLE, label));
		return theme.bg ? theme.bg("selectedBg", text) : text;
	};
	const tabs = LENS_TABS.map(([key, label]) => (key === lens ? selected(label) : theme.fg(SECONDARY_ROLE, label))).join("");
	const rule = LENS_TABS.map(([key, label]) => (key === lens ? theme.fg(FOCAL_ROLE, "━".repeat(label.length)) : theme.fg(BORDER_ROLE, "─".repeat(label.length)))).join("");
	const tabsWidth = visibleWidth(tabs);
	const rest = theme.fg(BORDER_ROLE, "─".repeat(Math.max(0, target - tabsWidth)));
	return [fit(spread(tabs, theme.fg(SECONDARY_ROLE, TABS_HINT), target), target), fit(rule + rest, target)];
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

const centered = (text: string, width: number) => " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;

/**
 * The fleet column, the whole fullscreen rail (05, T5-U3): a border edge and
 * one column of padding on every row; the title, the objective with a slim
 * gauge once there is one, the tab bar, then the lens. With a height it fills
 * it, and an empty lens's line sits in the middle of the space left.
 */
export function renderFleetColumn(lens: FleetLens, view: LensView, progress: FleetObjectiveProgress, width: number, theme: FleetViewTheme, height?: number): string[] {
	const inner = Math.max(0, Math.floor(width) - 2);
	const top = [theme.bold(theme.fg("text", `${CARD_GLYPH} Fleet`))];
	if (progress.stated) top.push(theme.fg("text", progress.title), `${paintGauge(progress.percent, theme, GAUGE_WIDTH, QUIET_GAUGE)} ${theme.fg(SECONDARY_ROLE, `${progress.frontsDone} of ${progress.frontsTotal} fronts`)}`);
	top.push("", ...renderLensBar(lens, inner, theme), "");
	const body = view.empty !== null && height !== undefined
		? [...view.head.map((line) => theme.fg(SECONDARY_ROLE, line)), ...Array.from({ length: Math.max(0, Math.floor((height - top.length - view.head.length) / 2) - 1) }, () => ""), theme.fg(SECONDARY_ROLE, centered(view.empty, inner))]
		: renderLensPanel(view, inner, theme);
	const rows = [...top, ...body];
	if (height !== undefined) while (rows.length < height) rows.push("");
	const edge = theme.fg(BORDER_ROLE, "│");
	return rows.map((row) => `${edge} ${padTo(fit(row, inner), inner)}`);
}

const WELCOME_EXAMPLES = [
	"Ship team workspaces for Inkwell: API, web app and docs",
	"Run my YouTube channel this week: script, edit, publish shorts",
	"Move the billing service to the new payments API, with a rollback plan",
];

/** Before the objective: what the fleet does, what to type, and the keys (lib/shell-card.ts card). */
export function renderWelcomeCard(width: number, theme: FleetViewTheme): string[] {
	const body = [
		"Describe the objective; the fleet splits it into fronts and runs a member for each.",
		"",
		theme.fg(SECONDARY_ROLE, "Try:"),
		...WELCOME_EXAMPLES.map((example) => `${theme.fg(SECONDARY_ROLE, "›")} ${example}`),
		"",
		theme.fg(SECONDARY_ROLE, "enter send · alt+1-4 lenses · alt+z zoom · alt+m detail · alt+w agents"),
	];
	return renderCard({ title: "Start a fleet", body, tone: CARD_TONE.INFO, glyph: CARD_GLYPH }, theme, width, { expanded: true }).map((line) => fit(line, width));
}

export interface LensPanelOptions {
	/** Groups shown as one header line; defaults to the groups 05 folds. */
	collapsed?: ReadonlySet<string>;
}

/** Head lines, then attention-first groups with one row per member; with no members, the lens's empty line. */
export function renderLensPanel(view: LensView, width: number, theme: FleetViewTheme, options: LensPanelOptions = {}): string[] {
	if (view.empty !== null) return [...view.head.map((line) => theme.fg(SECONDARY_ROLE, line)), ...(view.head.length ? [""] : []), theme.fg(SECONDARY_ROLE, centered(view.empty, width))].map((line) => fit(line, width));
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
	const parts = [`${status.live} of ${status.members} members live`, status.queue, ...(status.permission ? [status.permission] : [])];
	// Spend shows outside the costs lens only in power density.
	if (density === "power") parts.push(status.budgetUsd ? `$${status.spentUsd.toFixed(2)} of $${status.budgetUsd.toFixed(2)}` : `$${status.spentUsd.toFixed(2)} spent`);
	return [spread(fitParts(parts.map((part) => theme.fg("text", part)), theme.fg(SECONDARY_ROLE, SEP), width), theme.fg(SECONDARY_ROLE, `lens ${lens}${SEP}density ${density}`), width)];
}


export function renderHintLine(context: FleetHintContext, queue: AttentionQueue, density: FleetDensity, width: number, theme: FleetViewTheme): string[] {
	const key = (k: string, words: string) => `${theme.fg("text", k)} ${theme.fg(SECONDARY_ROLE, words)}`;
	const more = key("alt+m", "detail");
	const options = Math.min(OPTION_KEYS_MAX, queue.focal.options.length) || 1;
	const parts = {
		input: [...(queue.focal.kind === "nothing" ? [] : [key("tab", queue.focal.tag.toLowerCase())]), key("enter", "send"), key("alt+1-4", "lenses"), key("alt+z", "zoom"), more, key("alt+w", "agents"), key("@name", "talk to one member")],
		focal: [key(`1-${options}`, "choose"), key("tab", "back to the conversation"), key("f m $ l", "lenses"), key("z", "zoom"), key("w", "agents"), key("?", "help")],
		lens: [key("f m $ l", "switch lens"), key("z", "zoom"), more],
		zoom: [key("z", "back to the conversation"), key("f m $ l", "switch lens"), key("w", "agents")],
	}[context];
	return [fitParts(parts, "   ", width)];
}
