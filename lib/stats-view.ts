import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { formatElapsed } from "./agents-widget.ts";
import { formatCost, formatTokens } from "./shell-bar.ts";
import { paintHoverable } from "./shell-hover.ts";
import { aggregateStats, daysBetween, shiftDay, STATS_RANGE, STATS_SCOPE, weekdayOf, type CurrentSessionStats, type SessionRecord, type StatsRange, type StatsScope, type StatsSummary, type TokenTotals } from "./stats-collector.ts";

// Gentle Stats overlay: historical usage from local Pi sessions in three
// tabs. Overview is a weekday-by-week heatmap plus headline figures, Models
// splits tokens and cost per model, Session describes the live session. All
// colors come from theme roles so the panel follows the active Gentle theme.

export interface StatsViewTheme {
	fg(role: string, text: string): string;
}

export interface StatsViewDeps {
	theme: StatsViewTheme;
	rows: number | (() => number);
	cwd: string;
	now(): number;
	dayKey?: (ms: number) => string;
	load(): Promise<readonly SessionRecord[]>;
	current(): CurrentSessionStats;
	onClose(): void;
	requestRender(): void;
}

export const STATS_TAB = {
	OVERVIEW: "overview",
	MODELS: "models",
	SESSION: "session",
} as const;
export type StatsTab = (typeof STATS_TAB)[keyof typeof STATS_TAB];

const TABS: ReadonlyArray<{ id: StatsTab; label: string }> = [
	{ id: STATS_TAB.OVERVIEW, label: "Overview" },
	{ id: STATS_TAB.MODELS, label: "Models" },
	{ id: STATS_TAB.SESSION, label: "Session" },
];
const RANGES: readonly StatsRange[] = [STATS_RANGE.ALL, STATS_RANGE.WEEK, STATS_RANGE.MONTH];
const RANGE_LABEL: Record<StatsRange, string> = { [STATS_RANGE.ALL]: "All time", [STATS_RANGE.WEEK]: "Last 7 days", [STATS_RANGE.MONTH]: "Last 30 days" };
const SCOPE_LABEL: Record<StatsScope, string> = { [STATS_SCOPE.ALL]: "All projects", [STATS_SCOPE.PROJECT]: "This project" };

const ROLE = {
	FRAME: "border",
	TITLE: "customMessageLabel",
	ACTIVE: "accent",
	INACTIVE: "muted",
	LABEL: "muted",
	VALUE: "text",
	META: "dim",
	KEY: "accent",
	KEY_TEXT: "dim",
	HEAT: "accent",
	HEAT_IDLE: "borderMuted",
	BAR_EMPTY: "borderMuted",
	ADDED: "toolDiffAdded",
	REMOVED: "toolDiffRemoved",
	ERROR: "error",
} as const;

const TITLE = "✿ Stats";
const CLOSE_BUTTON = "[× Close]";
const CLOSE_BUTTON_NARROW = "[×]";
const FOOTNOTE = "Local Pi sessions on this machine · subagent runs not included";
const LOADING = "Loading local sessions…";
const KEYS = [
	["tab", "view", "tab"],
	["r", "range", "range"],
	["s", "scope", "scope"],
	["q", "close", "close"],
] as const;
const HINT_GAP = "   ";
// The frame draws "│ " before the fitted content of every body row.
const CONTENT_OFFSET = 2;
const LABEL_WIDTH = 16;
const TWO_COLUMN_MIN = 64;
const HEATMAP_WEEKS = 52;
const HEATMAP_LABEL_WIDTH = 4;
const HEAT_CELL = 2;
const HEAT_IDLE = "·";
const HEAT_SHADES = ["░", "▒", "▓", "█"];
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
// Don Quixote runs to roughly 430k words, about 500k tokens: a playful yardstick, not a measurement.
const DON_QUIXOTE_TOKENS = 500_000;

type Action = `tab:${StatsTab}` | "tab" | "range" | "scope" | "close";

interface Span {
	row: number;
	start: number;
	end: number;
	action: Action;
}

type LoadState = { kind: "loading" } | { kind: "ready"; sessions: readonly SessionRecord[] } | { kind: "error"; message: string };

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function padLeft(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function monthDay(day: string): string {
	const [, month, date] = day.split("-").map(Number);
	return `${MONTHS[month - 1]} ${date}`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function percent(share: number): string {
	return `${Math.round(share * 100)}%`;
}

export function tokenBreakdown(totals: TokenTotals): string {
	return `in ${formatTokens(totals.input)} · out ${formatTokens(totals.output)} · cache read ${formatTokens(totals.cacheRead)} · cache write ${formatTokens(totals.cacheWrite)}`;
}

export function literaryComparison(tokens: number): string {
	const ratio = tokens / DON_QUIXOTE_TOKENS;
	if (ratio >= 1) return `✿ That's ~${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}x the tokens in Don Quixote.`;
	const share = ratio * 100;
	return `✿ That's ~${share >= 10 ? Math.round(share) : share.toFixed(1)}% of the tokens in Don Quixote.`;
}

export class StatsView {
	private readonly deps: StatsViewDeps;
	private tab: StatsTab = STATS_TAB.OVERVIEW;
	private range: StatsRange = STATS_RANGE.ALL;
	private scope: StatsScope = STATS_SCOPE.ALL;
	private state: LoadState = { kind: "loading" };
	private summary: { key: string; stats: StatsSummary } | undefined;
	private spans: Span[] = [];
	private layout: { width: number; height: number } | undefined;
	private hovered: Action | undefined;
	private closed = false;

	constructor(deps: StatsViewDeps) {
		this.deps = deps;
	}

	/** Load (or reload) the session records; never rejects. */
	async load(): Promise<void> {
		this.state = { kind: "loading" };
		this.summary = undefined;
		try {
			this.state = { kind: "ready", sessions: await this.deps.load() };
		} catch (error) {
			this.state = { kind: "error", message: error instanceof Error ? error.message : String(error) };
		}
		this.summary = undefined;
		if (!this.closed) this.deps.requestRender();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (data === "q" || matchesKey(data, Key.escape)) return this.close();
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) this.shiftTab(1);
		else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) this.shiftTab(-1);
		else if (data === "1" || data === "2" || data === "3") this.setTab(TABS[Number(data) - 1].id);
		else if (data === "r") this.cycleRange();
		else if (data === "s") this.toggleScope();
		else return;
		this.deps.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const layout = this.layout;
		const span = layout && event.width === layout.width && event.height === layout.height
			? this.spans.find((candidate) => candidate.row === event.y && event.x >= candidate.start && event.x < candidate.end)
			: undefined;
		if (event.type === "move" && event.button === "none") {
			if (span?.action === this.hovered) return span ? { handled: true } : undefined;
			this.hovered = span?.action;
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left" || !span) return undefined;
		this.run(span.action);
		return { handled: true, render: true };
	}

	invalidate(): void {
		this.layout = undefined;
		this.spans = [];
		this.hovered = undefined;
	}

	dispose(): void {
		this.closed = true;
	}

	render(width: number): string[] {
		const height = Math.max(0, typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows);
		const theme = this.deps.theme;
		const inner = Math.max(0, width - 2);
		const content = Math.max(0, width - 4);
		this.spans = [];
		const frame = (line: string) => `${theme.fg(ROLE.FRAME, "│")} ${fit(line, content)} ${theme.fg(ROLE.FRAME, "│")}`;
		const body = this.body(content);
		const room = Math.max(0, height - 5);
		const shown = body.slice(0, room);
		while (shown.length < room) shown.push("");
		const lines = [
			this.top(width),
			frame(this.tabsLine(content, 1)),
			...shown.map(frame),
			frame(theme.fg(ROLE.META, FOOTNOTE)),
			frame(this.footer(content, height - 2)),
			theme.fg(ROLE.FRAME, `╰${rule(inner)}╯`),
		].slice(0, height);
		this.layout = { width, height: lines.length };
		return lines;
	}

	private top(width: number): string {
		const theme = this.deps.theme;
		const close = width >= 60 ? CLOSE_BUTTON : CLOSE_BUTTON_NARROW;
		const fill = width - 8 - visibleWidth(TITLE) - close.length;
		if (fill < 1) return theme.fg(ROLE.FRAME, "╭─ ") + fit(theme.fg(ROLE.TITLE, TITLE), Math.max(0, width - 5)) + theme.fg(ROLE.FRAME, " ╮");
		this.spans.push({ row: 0, start: width - 3 - close.length, end: width - 3, action: "close" });
		return theme.fg(ROLE.FRAME, "╭─ ") + theme.fg(ROLE.TITLE, TITLE) + theme.fg(ROLE.FRAME, ` ${rule(fill)} `) +
			paintHoverable(theme, close, this.hovered === "close", ROLE.KEY) + theme.fg(ROLE.FRAME, " ─╮");
	}

	private tabsLine(width: number, row: number): string {
		const theme = this.deps.theme;
		let plain = "";
		let painted = "";
		const spans: Span[] = [];
		for (const { id, label } of TABS) {
			if (plain) { plain += " "; painted += " "; }
			const text = id === this.tab ? `[${label}]` : ` ${label} `;
			const action: Action = `tab:${id}`;
			spans.push({ row, start: CONTENT_OFFSET + plain.length, end: CONTENT_OFFSET + plain.length + text.length, action });
			plain += text;
			painted += paintHoverable(theme, text, this.hovered === action, id === this.tab ? ROLE.ACTIVE : ROLE.INACTIVE);
		}
		if (plain.length <= width) this.spans.push(...spans);
		const filters = this.tab === STATS_TAB.SESSION ? "This session" : `${RANGE_LABEL[this.range]} · ${SCOPE_LABEL[this.scope]}`;
		const gap = width - plain.length - filters.length;
		return gap >= 2 ? painted + " ".repeat(gap) + theme.fg(ROLE.META, filters) : painted;
	}

	private footer(width: number, row: number): string {
		const theme = this.deps.theme;
		const plainWidth = KEYS.reduce((sum, [key, label]) => sum + key.length + 1 + label.length, 0) + HINT_GAP.length * (KEYS.length - 1);
		let cursor = CONTENT_OFFSET;
		const parts: string[] = [];
		for (const [key, label, action] of KEYS) {
			const text = `${key} ${label}`;
			if (plainWidth <= width) this.spans.push({ row, start: cursor, end: cursor + text.length, action });
			cursor += text.length + HINT_GAP.length;
			parts.push(this.hovered === action ? paintHoverable(theme, text, true) : `${theme.fg(ROLE.KEY, key)} ${theme.fg(ROLE.KEY_TEXT, label)}`);
		}
		return parts.join(HINT_GAP);
	}

	private body(width: number): string[] {
		if (this.tab === STATS_TAB.SESSION) return ["", ...this.sessionTab(width)];
		const theme = this.deps.theme;
		if (this.state.kind === "loading") return ["", theme.fg(ROLE.META, LOADING)];
		if (this.state.kind === "error") return ["", theme.fg(ROLE.ERROR, `Could not read local sessions: ${this.state.message}`)];
		const stats = this.stats(this.state.sessions);
		if (stats.sessions === 0) {
			const hint = this.range === STATS_RANGE.ALL && this.scope === STATS_SCOPE.ALL ? "." : " for this view · press r or s to widen it.";
			return ["", theme.fg(ROLE.META, `No usage recorded yet${hint}`)];
		}
		return ["", ...(this.tab === STATS_TAB.MODELS ? this.modelsTab(stats, width) : this.overviewTab(stats, width))];
	}

	private stats(sessions: readonly SessionRecord[]): StatsSummary {
		const key = `${this.range}|${this.scope}`;
		if (this.summary?.key !== key) {
			this.summary = { key, stats: aggregateStats(sessions, { range: this.range, scope: this.scope, cwd: this.deps.cwd, now: this.deps.now(), dayKey: this.deps.dayKey }) };
		}
		return this.summary.stats;
	}

	private overviewTab(stats: StatsSummary, width: number): string[] {
		const theme = this.deps.theme;
		const pairs: Array<[string, string]> = [
			["Favorite model", stats.models[0]?.model ?? "—"],
			["Total tokens", formatTokens(stats.totals.total)],
			["Sessions", String(stats.sessions)],
			["Longest session", stats.longestSession ? formatElapsed(stats.longestSession.durationMs) : "—"],
			["Active days", `${stats.activeDays}/${stats.daysInRange}`],
			["Longest streak", plural(stats.longestStreak, "day")],
			["Most active day", stats.mostActiveDay ? monthDay(stats.mostActiveDay.day) : "—"],
			["Current streak", plural(stats.currentStreak, "day")],
		];
		return [
			...this.heatmap(stats, width),
			"",
			...this.grid(pairs, width),
			this.field("Tokens", tokenBreakdown(stats.totals)),
			this.field("Cost", formatCost(stats.totals.cost)),
			"",
			theme.fg(ROLE.ACTIVE, literaryComparison(stats.totals.total)),
		];
	}

	private heatmap(stats: StatsSummary, width: number): string[] {
		const theme = this.deps.theme;
		const { today, firstDay } = stats;
		const mondayOffset = (day: string) => (weekdayOf(day) + 6) % 7;
		const lastMonday = shiftDay(today, -mondayOffset(today));
		const needed = this.range === STATS_RANGE.ALL ? HEATMAP_WEEKS : Math.ceil((daysBetween(shiftDay(firstDay, -mondayOffset(firstDay)), today) + 1) / 7);
		const columns = Math.max(1, Math.min(needed, Math.floor((width - HEATMAP_LABEL_WIDTH) / HEAT_CELL)));
		const mondays = Array.from({ length: columns }, (_, column) => shiftDay(lastMonday, -7 * (columns - 1 - column)));
		const max = Math.max(0, ...Object.values(stats.days));
		const months = Array.from({ length: HEATMAP_LABEL_WIDTH + columns * HEAT_CELL }, () => " ");
		let previousMonth = "";
		let freeFrom = 0;
		mondays.forEach((monday, column) => {
			const month = monday.slice(0, 7);
			const at = HEATMAP_LABEL_WIDTH + column * HEAT_CELL;
			if (month !== previousMonth && at >= freeFrom && at + 3 <= months.length) {
				MONTHS[Number(month.slice(5)) - 1].split("").forEach((char, offset) => { months[at + offset] = char; });
				freeFrom = at + 4;
			}
			previousMonth = month;
		});
		const rows = WEEKDAY_LABELS.map((label, weekday) => {
			const cells = mondays.map((monday) => {
				const day = shiftDay(monday, weekday);
				if (day > today || (this.range !== STATS_RANGE.ALL && day < firstDay)) return " ".repeat(HEAT_CELL);
				const tokens = stats.days[day];
				if (tokens === undefined) return theme.fg(ROLE.HEAT_IDLE, HEAT_IDLE) + " ";
				const level = max > 0 ? Math.min(HEAT_SHADES.length, Math.max(1, Math.ceil((HEAT_SHADES.length * tokens) / max))) : 1;
				return theme.fg(ROLE.HEAT, HEAT_SHADES[level - 1]) + " ";
			});
			return theme.fg(ROLE.META, label.padEnd(HEATMAP_LABEL_WIDTH)) + cells.join("");
		});
		const legend = " ".repeat(HEATMAP_LABEL_WIDTH) + theme.fg(ROLE.META, "Less ") + [theme.fg(ROLE.HEAT_IDLE, HEAT_IDLE), ...HEAT_SHADES.map((shade) => theme.fg(ROLE.HEAT, shade))].join(" ") + theme.fg(ROLE.META, " More");
		return [theme.fg(ROLE.META, months.join("").trimEnd()), ...rows, legend];
	}

	private modelsTab(stats: StatsSummary, width: number): string[] {
		const theme = this.deps.theme;
		const nameWidth = Math.min(28, Math.max(5, ...stats.models.map((model) => model.model.length)));
		const tail = 4 + 2 + 7 + 2 + 8 + 2 + 5;
		const barWidth = Math.max(4, Math.min(24, width - nameWidth - tail - 2));
		const header = theme.fg(ROLE.LABEL, `${fit("Model", nameWidth)} ${fit("Share", barWidth + 5)}  ${padLeft("Tokens", 7)}  ${padLeft("Cost", 8)}  ${padLeft("Msgs", 5)}`);
		const rows = stats.models.map((model) => {
			const filled = Math.round(model.share * barWidth);
			const bar = theme.fg(ROLE.ACTIVE, BAR_FILLED.repeat(filled)) + theme.fg(ROLE.BAR_EMPTY, BAR_EMPTY.repeat(barWidth - filled));
			return `${theme.fg(ROLE.VALUE, fit(model.model, nameWidth))} ${bar} ${padLeft(percent(model.share), 4)}  ${padLeft(formatTokens(model.tokens), 7)}  ${padLeft(formatCost(model.cost), 8)}  ${padLeft(String(model.messages), 5)}`;
		});
		return [header, ...rows, "", theme.fg(ROLE.META, `${formatTokens(stats.totals.total)} tokens · ${formatCost(stats.totals.cost)} across ${plural(stats.sessions, "session")}`)];
	}

	private sessionTab(_width: number): string[] {
		const theme = this.deps.theme;
		const current = this.deps.current();
		const lines = current.lines
			? `${theme.fg(ROLE.ADDED, `+${current.lines.added}`)} ${theme.fg(ROLE.REMOVED, `−${current.lines.removed}`)}`
			: theme.fg(ROLE.META, "no captured file changes");
		return [
			this.field("Model", current.model ?? "—"),
			this.field("Cost", formatCost(current.totals.cost)),
			this.field("Duration", formatElapsed(current.durationMs)),
			this.field("Messages", String(current.messages)),
			this.field("Tokens", `${formatTokens(current.totals.total)} total · ${tokenBreakdown(current.totals)}`),
			this.field("Lines", lines),
			"",
			theme.fg(ROLE.META, "Wall time since the session's first entry; range and scope do not apply here."),
		];
	}

	private field(label: string, value: string): string {
		return this.deps.theme.fg(ROLE.LABEL, label.padEnd(LABEL_WIDTH)) + this.deps.theme.fg(ROLE.VALUE, value);
	}

	private grid(pairs: ReadonlyArray<[string, string]>, width: number): string[] {
		if (width < TWO_COLUMN_MIN) return pairs.map(([label, value]) => this.field(label, value));
		const column = Math.floor(width / 2);
		const rows: string[] = [];
		for (let index = 0; index < pairs.length; index += 2) {
			const [left, right] = [pairs[index], pairs[index + 1]];
			rows.push(fit(this.field(left[0], left[1]), column) + (right ? this.field(right[0], right[1]) : ""));
		}
		return rows;
	}

	private run(action: Action): void {
		if (action === "close") return this.close();
		if (action === "tab") this.shiftTab(1);
		else if (action === "range") this.cycleRange();
		else if (action === "scope") this.toggleScope();
		else this.setTab(action.slice("tab:".length) as StatsTab);
		this.deps.requestRender();
	}

	private shiftTab(delta: number): void {
		const index = TABS.findIndex((tab) => tab.id === this.tab);
		this.setTab(TABS[(index + delta + TABS.length) % TABS.length].id);
	}

	private setTab(tab: StatsTab): void {
		this.tab = tab;
		this.hovered = undefined;
	}

	private cycleRange(): void {
		this.range = RANGES[(RANGES.indexOf(this.range) + 1) % RANGES.length];
	}

	private toggleScope(): void {
		this.scope = this.scope === STATS_SCOPE.ALL ? STATS_SCOPE.PROJECT : STATS_SCOPE.ALL;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.spans = [];
		this.deps.onClose();
	}
}
