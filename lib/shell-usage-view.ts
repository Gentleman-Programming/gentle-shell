import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { VimListKeys, vimListIndex } from "./vim-list-keys.ts";
import { renderUsagePanel, type ActiveProvider, type UsagePanelScope, type UsageSourceRegistry, type UsageStore, type UsageTheme } from "./shell-usage.ts";
import type { GaugePaint } from "./shell-gauge.ts";
import { paintHoverable } from "./shell-hover.ts";

// Gentle Shell subscriptions overlay: a framed panel over the usage store.
// It reads the store on every render, so a refresh only needs to record.

export interface UsageViewDeps {
	theme: UsageTheme;
	now(): number;
	active(): ActiveProvider | undefined;
	// Optional: lets the panel resolve the pending note of a provider whose
	// usage source was registered at runtime instead of built in.
	registry?(): UsageSourceRegistry | undefined;
	// Optional: the targeted routing scope. Without it the panel draws every
	// provider the store holds; with it, exactly the targeted providers, in
	// scope order, explaining the ones without data.
	scope?(): UsagePanelScope | undefined;
	// Optional: gauge-specific theme roles resolved from the installed theme
	// source; without it the panel paints with the shared roles.
	gauge?(): GaugePaint | undefined;
	onRefresh(): Promise<void>;
	onClose(): void;
	requestRender(): void;
	// Body rows the framed panel can show at once (top/keys/bottom excluded);
	// without it the panel renders every row and scroll keys stay inert.
	viewportRows?(): number;
}

const TITLE = "✿ Subscriptions";
const REFRESHING = "✿ Subscriptions · refreshing…";
const FRAME_ROLE = "border";
const TITLE_ROLE = "customMessageLabel";
const KEY_ROLE = "accent";
const KEY_TEXT_ROLE = "dim";
const KEYS = [
	["r", "refresh"],
	["esc", "close"],
	["j/k", "scroll"],
] as const;

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

// Column offset of the footer's hint text within the rendered line: the
// frame draws "│ " before the fitted content starts.
const HINT_CONTENT_OFFSET = 2;
const HINT_GAP = "   ";

type HintAction = "refresh" | "close";

interface HintSpan {
	start: number;
	end: number;
	action: HintAction;
}

interface PointerLayout {
	width: number;
	height: number;
	row: number;
	spans: HintSpan[];
}

export class UsageView {
	private readonly store: UsageStore;
	private readonly deps: UsageViewDeps;
	private refreshing = false;
	private pointer: PointerLayout | undefined;
	private hoveredHint: HintAction | undefined;
	private scroll = 0;
	private readonly listKeys = new VimListKeys();
	private bodyRows = 0;

	constructor(store: UsageStore, deps: UsageViewDeps) {
		this.store = store;
		this.deps = deps;
	}

	handleInput(data: string): void {
		const jump = this.listKeys.action(data);
		if (jump === "pending") return;
		// The scroll offset is the "row" here: 0..maxScroll, paged by the viewport.
		if (jump) { this.scrollTo(vimListIndex(jump, this.scroll, this.maxScroll() + 1, this.pageRows())); return; }
		if (matchesKey(data, Key.escape) || data === "q") {
			this.deps.onClose();
			return;
		}
		if (data === "r") { this.refresh(); return; }
		if (data === "j" || matchesKey(data, Key.down)) { this.scrollBy(1); return; }
		if (data === "k" || matchesKey(data, Key.up)) { this.scrollBy(-1); return; }
		if (matchesKey(data, Key.pageDown)) { this.scrollBy(this.pageRows()); return; }
		if (matchesKey(data, Key.pageUp)) { this.scrollBy(-this.pageRows()); return; }
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scroll + delta);
	}

	private maxScroll(): number {
		const viewport = this.deps.viewportRows?.();
		return viewport === undefined ? 0 : Math.max(0, this.bodyRows - viewport);
	}

	private scrollTo(target: number): void {
		if (this.deps.viewportRows === undefined) return;
		const next = Math.min(this.maxScroll(), Math.max(0, target));
		if (next === this.scroll) return;
		this.scroll = next;
		this.deps.requestRender();
	}

	private pageRows(): number {
		return Math.max(1, this.deps.viewportRows?.() ?? 1);
	}

	// A failing usage fetch is the store's problem to report (its rows already
	// carry the last error); the panel only clears its "refreshing" state. The
	// rejection must never leave this method: an unhandled rejection is fatal
	// to the whole shell on current Node. Public so the overlay can dispatch
	// its opening refresh instead of making the open wait for it.
	refresh(): void {
		if (this.refreshing) return;
		this.refreshing = true;
		this.deps.requestRender();
		const settle = () => {
			this.refreshing = false;
			this.deps.requestRender();
		};
		try {
			this.deps.onRefresh().then(settle, settle);
		} catch {
			settle();
		}
	}

	render(width: number): string[] {
		const theme = this.deps.theme;
		const inner = width - 2;
		const title = this.refreshing ? REFRESHING : TITLE;
		const top = theme.fg(FRAME_ROLE, "╭─ ") + theme.fg(TITLE_ROLE, title) + theme.fg(FRAME_ROLE, ` ${rule(inner - visibleWidth(title) - 3)}╮`);
		const body = renderUsagePanel(this.store.all(), theme, inner - 2, this.deps.now(), this.deps.active(), this.deps.registry?.(), this.deps.scope?.(), this.deps.gauge?.()).map(
			(line) => `${theme.fg(FRAME_ROLE, "│")} ${fit(line, inner - 2)} ${theme.fg(FRAME_ROLE, "│")}`,
		);
		// The scroll hint is keyboard help only: it has no action and no clickable span.
		const hints = KEYS.map(([key, label]) => ({ key, label, text: `${key} ${label}`, action: (key === "r" ? "refresh" : key === "esc" ? "close" : undefined) as HintAction | undefined }));
		// The hovered hint paints entirely in the shared hover role (key and
		// label together, one color) instead of its ordinary two-role split --
		// the same treatment every other clickable surface uses.
		const keys = hints
			.map(({ key, label, action }) =>
				action && this.hoveredHint === action ? paintHoverable(theme, `${key} ${label}`, true) : `${theme.fg(KEY_ROLE, key)} ${theme.fg(KEY_TEXT_ROLE, label)}`,
			)
			.join(HINT_GAP);
		const keysLine = `${theme.fg(FRAME_ROLE, "│")} ${fit(keys, inner - 2)} ${theme.fg(FRAME_ROLE, "│")}`;
		const bottom = theme.fg(FRAME_ROLE, `╰${rule(inner)}╯`);
		const viewport = this.deps.viewportRows?.();
		this.bodyRows = body.length;
		this.scroll = Math.min(this.scroll, this.maxScroll());
		const visible = viewport === undefined ? body : body.slice(this.scroll, this.scroll + viewport);
		const lines = [top, ...visible, keysLine, bottom];
		this.pointer = this.hintLayout(width, lines.length, visible.length + 1, hints, inner - 2);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move" && event.button === "none") {
			const layout = this.pointer;
			const action = layout && event.width === layout.width && event.height === layout.height && event.y === layout.row
				? layout.spans.find((candidate) => event.x >= candidate.start && event.x < candidate.end)?.action
				: undefined;
			if (action === this.hoveredHint) return action ? { handled: true } : undefined;
			this.hoveredHint = action;
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const layout = this.pointer;
		if (!layout || event.width !== layout.width || event.height !== layout.height || event.y !== layout.row) return undefined;
		const span = layout.spans.find((candidate) => event.x >= candidate.start && event.x < candidate.end);
		if (!span) return undefined;
		if (span.action === "close") {
			this.deps.onClose();
			return { handled: true, render: true };
		}
		this.refresh();
		return { handled: true, render: true };
	}

	invalidate(): void {
		this.pointer = undefined;
		this.hoveredHint = undefined;
	}

	// Spans are only registered when the hints text fits without truncation:
	// past that point `fit` clips it with an ellipsis and per-hint columns no
	// longer line up with the plain "key label" text used here.
	private hintLayout(width: number, height: number, row: number, hints: Array<{ text: string; action?: HintAction }>, contentWidth: number): PointerLayout | undefined {
		const plainWidth = hints.reduce((total, hint) => total + hint.text.length, 0) + HINT_GAP.length * Math.max(0, hints.length - 1);
		if (plainWidth > contentWidth) return undefined;
		const spans: HintSpan[] = [];
		let cursor = HINT_CONTENT_OFFSET;
		for (const hint of hints) {
			const start = cursor;
			const end = start + hint.text.length;
			if (hint.action) spans.push({ start, end, action: hint.action });
			cursor = end + HINT_GAP.length;
		}
		return { width, height, row, spans };
	}
}
