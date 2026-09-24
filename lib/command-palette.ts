import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./terminal-theme.ts";

// Command palette: a pure, curated, grouped overlay component for
// `/gentle:commands` and its `alt+k` shortcut (see
// extensions/gentle-shell.ts). It only knows about plain groups of items
// (command + label, plus an optional description used for ranking and an
// optional shortcut hint), never about the Pi extension API, so it can be
// fully exercised without a running agent session. The curated catalog
// itself lives in lib/command-palette-catalog.ts.

export interface CommandPaletteItem {
	command: string;
	label: string;
	description?: string;
	shortcut?: string;
}

export interface CommandPaletteGroup {
	title: string;
	items: CommandPaletteItem[];
}

export type CommandPaletteResult = { type: "run"; name: string } | { type: "close" };

export interface CommandPaletteTheme {
	fg(color: string, text: string): string;
	/** Optional: when present, the selected row is drawn as a full-width
	 * highlighted bar via bg("selectedBg", ...) instead of a `▸` marker. */
	bg?(color: string, text: string): string;
}

// stripAnsi comes from ./terminal-theme.ts (identical intent: strip ANSI/OSC
// escape sequences before measuring or comparing text). sanitizeTerminalText
// stays a local copy on purpose: the shared lib/terminal-theme.ts version
// deletes control characters, but this palette escapes them into a visible
// "\xNN" form instead (same regex as the local copy in
// extensions/gentle-agents.ts), so a stray control byte in a label,
// shortcut, or description is never silently dropped.
function sanitizeTerminalText(value: string): string {
	return value.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, (control) => `\\x${control.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function isSubsequence(query: string, text: string): boolean {
	let index = 0;
	for (const char of text) {
		if (index < query.length && char === query[index]) index += 1;
	}
	return index === query.length;
}

function rankItem(item: CommandPaletteItem, lowerQuery: string): number | undefined {
	const label = item.label.toLowerCase();
	if (label.startsWith(lowerQuery)) return 0;
	if (label.includes(lowerQuery)) return 1;
	if (isSubsequence(lowerQuery, label)) return 2;
	if (item.command.toLowerCase().includes(lowerQuery)) return 3;
	if (item.description && item.description.toLowerCase().includes(lowerQuery)) return 4;
	return undefined;
}

/**
 * Rank each group's items against a query: 0 label starts with query, 1
 * label contains, 2 label matches as a subsequence, 3 command name
 * contains, 4 description contains. Matching is case-insensitive and the
 * query is trimmed; ties keep input order within a group (stable sort).
 * Groups are never reordered relative to each other, and a group left with
 * no matching item is dropped entirely. An empty or whitespace-only query
 * returns every group unchanged.
 */
export function rankPaletteGroups(groups: readonly CommandPaletteGroup[], query: string): CommandPaletteGroup[] {
	const trimmed = query.trim();
	if (!trimmed) return groups.map((group) => ({ title: group.title, items: [...group.items] }));
	const lower = trimmed.toLowerCase();
	const result: CommandPaletteGroup[] = [];
	for (const group of groups) {
		const ranked: { item: CommandPaletteItem; rank: number }[] = [];
		for (const item of group.items) {
			const rank = rankItem(item, lower);
			if (rank !== undefined) ranked.push({ item, rank });
		}
		if (ranked.length === 0) continue;
		ranked.sort((a, b) => a.rank - b.rank);
		result.push({ title: group.title, items: ranked.map((entry) => entry.item) });
	}
	return result;
}

type Tone = "border" | "muted" | "text" | "title" | "accent";

const TONE_COLOR: Record<Tone, string> = {
	border: "border",
	muted: "muted",
	text: "text",
	title: "accent",
	accent: "accent",
};

// Two border glyphs ("│ " and " │") plus the padding space on each side.
const CARD_PADDING = 4;
const CARD_BORDER_ROWS = 2;
// Fixed content rows outside the grouped match list: header, query/search,
// a blank row, a blank row before the footer, and the footer itself.
const CHROME_ROWS = 5;
const SCROLL_INDICATOR_ROWS = 2;
// The card never shrinks below this many total lines, and otherwise fills
// up to this fraction of the terminal's rows (see render()). There is no
// fixed row cap here: that belongs to the models panel only.
const MIN_TOTAL_ROWS = 12;
const HEIGHT_RATIO = 0.85;
const DEFAULT_ROWS = 40;

type PaletteRow = { kind: "title"; text: string } | { kind: "blank" } | { kind: "item"; item: CommandPaletteItem; itemIndex: number };

function buildRows(groups: readonly CommandPaletteGroup[]): PaletteRow[] {
	const rows: PaletteRow[] = [];
	let itemIndex = 0;
	groups.forEach((group, groupIndex) => {
		if (groupIndex > 0) rows.push({ kind: "blank" });
		rows.push({ kind: "title", text: group.title });
		for (const item of group.items) {
			rows.push({ kind: "item", item, itemIndex });
			itemIndex += 1;
		}
	});
	return rows;
}

function countItems(groups: readonly CommandPaletteGroup[]): number {
	return groups.reduce((sum, group) => sum + group.items.length, 0);
}

function itemAt(groups: readonly CommandPaletteGroup[], index: number): CommandPaletteItem | undefined {
	let cursor = 0;
	for (const group of groups) {
		if (index < cursor + group.items.length) return group.items[index - cursor];
		cursor += group.items.length;
	}
	return undefined;
}

export class CommandPalette {
	private query = "";
	private selected = 0;
	private completed = false;
	private readonly groups: readonly CommandPaletteGroup[];
	private readonly done: (result: CommandPaletteResult) => void;
	private readonly theme: CommandPaletteTheme | undefined;
	private readonly rowsFn: () => number;

	constructor(groups: readonly CommandPaletteGroup[], done: (result: CommandPaletteResult) => void, theme?: CommandPaletteTheme, rows: () => number = () => DEFAULT_ROWS) {
		this.groups = groups;
		this.done = done;
		this.theme = theme;
		this.rowsFn = rows;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.completed || isKeyRelease(data)) return;
		// A bare line feed ("\n") is both ctrl+j and, on non-Kitty terminals,
		// a synonym for Enter: check the scroll/move keys first so ctrl+j
		// always scrolls instead of running the highlighted command (same
		// ordering as lib/shell-changes-view.ts).
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+j")) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+k")) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.finish({ type: "close" });
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const item = itemAt(this.matches(), this.selected);
			if (item) this.finish({ type: "run", name: item.command });
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) this.setQuery(this.query.slice(0, -1));
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			if (this.query.length > 0) this.setQuery("");
			return;
		}
		if (this.isSingleBmpPrintable(data)) this.setQuery(this.query + data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - CARD_PADDING);
		const maxTotalLines = Math.max(MIN_TOTAL_ROWS, Math.floor(this.rowsFn() * HEIGHT_RATIO));
		return this.renderCard(this.renderBody(innerWidth, maxTotalLines), innerWidth);
	}

	/**
	 * True for a single Basic-Multilingual-Plane printable character.
	 * Multi-character input (a paste delivered as one `handleInput` call)
	 * and astral characters (surrogate pairs, where `data.length === 2`)
	 * are ignored on purpose: the palette only appends one keystroke at a
	 * time, and a raw terminal paste is not a single keystroke.
	 */
	private isSingleBmpPrintable(data: string): boolean {
		if (data.length !== 1) return false;
		const codePoint = data.codePointAt(0) ?? 0;
		return codePoint >= 0x20 && codePoint !== 0x7f;
	}

	private setQuery(query: string): void {
		this.query = query;
		this.selected = 0;
	}

	private moveSelection(delta: number): void {
		const total = countItems(this.matches());
		if (total === 0) return;
		this.selected = Math.max(0, Math.min(total - 1, this.selected + delta));
	}

	private matches(): CommandPaletteGroup[] {
		return rankPaletteGroups(this.groups, this.query);
	}

	private finish(result: CommandPaletteResult): void {
		if (this.completed) return;
		this.completed = true;
		this.done(result);
	}

	private renderBody(width: number, maxTotalLines: number): string[] {
		const lines: string[] = [];
		lines.push(this.renderHeaderRow(width));
		lines.push(this.query.length > 0 ? this.renderLine(`› ${this.query}`, width) : this.renderLine("› Search", width, "muted"));
		lines.push("");
		const groups = this.matches();
		if (groups.length === 0) {
			lines.push(this.renderLine(`No commands match "${this.query}"`, width, "muted"));
		} else {
			const budget = Math.max(1, maxTotalLines - CARD_BORDER_ROWS - CHROME_ROWS);
			lines.push(...this.renderGroups(groups, width, budget));
		}
		lines.push("");
		lines.push(this.renderLine("type to search • ↑/↓ move • enter run • esc close", width, "muted"));
		return lines;
	}

	private renderHeaderRow(width: number): string {
		const left = this.renderText("Commands", "title");
		const right = this.renderText("esc", "muted");
		return this.justifyToWidth(left, right, width);
	}

	private renderGroups(groups: CommandPaletteGroup[], width: number, budget: number): string[] {
		const rows = buildRows(groups);
		const selected = Math.max(0, Math.min(countItems(groups) - 1, this.selected));
		if (rows.length <= budget) return rows.map((row) => this.renderRow(row, width, selected));
		const windowSize = Math.max(1, budget - SCROLL_INDICATOR_ROWS);
		const selectedRowIndex = Math.max(0, rows.findIndex((row) => row.kind === "item" && row.itemIndex === selected));
		const start = Math.max(0, Math.min(selectedRowIndex - Math.floor(windowSize / 2), Math.max(0, rows.length - windowSize)));
		const end = Math.min(rows.length, start + windowSize);
		const result: string[] = [];
		if (start > 0) result.push(this.renderLine(`  ↑ ${start} more`, width, "muted"));
		for (let i = start; i < end; i++) {
			const row = rows[i];
			if (row) result.push(this.renderRow(row, width, selected));
		}
		if (end < rows.length) result.push(this.renderLine(`  ↓ ${rows.length - end} more`, width, "muted"));
		return result;
	}

	private renderRow(row: PaletteRow, width: number, selected: number): string {
		if (row.kind === "blank") return "";
		if (row.kind === "title") return this.renderLine(row.text, width, "accent");
		return this.renderItemRow(row.item, row.itemIndex === selected, width);
	}

	private renderItemRow(item: CommandPaletteItem, focused: boolean, width: number): string {
		const canHighlightBg = focused && this.theme?.bg !== undefined;
		const label = sanitizeTerminalText(item.label);
		const shortcut = item.shortcut ? sanitizeTerminalText(item.shortcut) : "";
		if (canHighlightBg) {
			const plainRow = this.justifyToWidth(`  ${label}`, shortcut, width);
			return this.theme?.bg?.("selectedBg", plainRow) ?? plainRow;
		}
		const prefix = focused ? this.renderText("▸ ", "accent") : "  ";
		const prefixWidth = visibleWidth(stripAnsi(prefix));
		const availableWidth = Math.max(0, width - prefixWidth);
		const labelStyled = this.renderText(label, "text");
		const shortcutStyled = shortcut ? this.renderText(shortcut, "muted") : "";
		return `${prefix}${this.justifyToWidth(labelStyled, shortcutStyled, availableWidth)}`;
	}

	/** Left-align `left`, right-align `right`, and pad to exactly `width`
	 * (display columns) so a caller can wrap the whole result in a
	 * full-width background highlight without a ragged tail. */
	private justifyToWidth(left: string, right: string, width: number): string {
		const leftWidth = visibleWidth(stripAnsi(left));
		const rightWidth = visibleWidth(stripAnsi(right));
		const minGap = right ? 1 : 0;
		const gap = Math.max(minGap, width - leftWidth - rightWidth);
		const used = leftWidth + gap + rightWidth;
		const trailingPad = Math.max(0, width - used);
		return `${left}${" ".repeat(gap)}${right}${" ".repeat(trailingPad)}`;
	}

	private renderCard(lines: string[], innerWidth: number): string[] {
		const horizontal = "─".repeat(innerWidth + 2);
		const border = (text: string) => this.renderText(text, "border");
		return [border(`╭${horizontal}╮`), ...lines.map((content) => `${border("│")} ${this.fitStyledLine(content, innerWidth)} ${border("│")}`), border(`╰${horizontal}╯`)];
	}

	private fitStyledLine(content: string, width: number): string {
		const visible = visibleWidth(stripAnsi(content));
		if (visible > width) return truncateToWidth(content, Math.max(1, width), "…", true);
		return `${content}${" ".repeat(Math.max(0, width - visible))}`;
	}

	private renderLine(text = "", width: number, tone?: Tone): string {
		const safe = truncateToWidth(sanitizeTerminalText(text), Math.max(1, width), "…", true);
		return tone ? this.renderText(safe, tone) : safe;
	}

	private renderText(text: string, tone: Tone): string {
		const safe = sanitizeTerminalText(text);
		if (!this.theme) return safe;
		return this.theme.fg(TONE_COLOR[tone], safe);
	}
}

/**
 * Shortcut for `/gentle:commands`. Reads GENTLE_PI_COMMANDS_KEY: unset
 * defaults to "alt+k" (ctrl+k is reserved by Pi's editor for
 * delete-to-line-end, so an extension shortcut on it is skipped); an empty
 * value or "off" (case-insensitive) disables the shortcut; anything else is
 * used as-is (trimmed). Same shape as changesShortcut in
 * extensions/gentle-shell.ts.
 */
export function commandsKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_COMMANDS_KEY?.trim();
	if (value === undefined) return "alt+k";
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}
