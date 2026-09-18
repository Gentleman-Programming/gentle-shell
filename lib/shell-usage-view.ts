import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { renderUsagePanel, type ActiveProvider, type UsageStore, type UsageTheme } from "./shell-usage.ts";
import { HOVER_ROLE } from "./shell-hover.ts";

// Gentle Shell subscriptions overlay: a framed panel over the usage store.
// It reads the store on every render, so a refresh only needs to record.

export interface UsageViewDeps {
	theme: UsageTheme;
	now(): number;
	active(): ActiveProvider | undefined;
	onRefresh(): Promise<void>;
	onClose(): void;
	requestRender(): void;
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

	constructor(store: UsageStore, deps: UsageViewDeps) {
		this.store = store;
		this.deps = deps;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.deps.onClose();
			return;
		}
		if (data === "r") this.refresh();
	}

	// A failing usage fetch is the store's problem to report (its rows already
	// carry the last error); the panel only clears its "refreshing" state. The
	// rejection must never leave this method: an unhandled rejection is fatal
	// to the whole shell on current Node.
	private refresh(): void {
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
		const body = renderUsagePanel(this.store.all(), theme, inner - 2, this.deps.now(), this.deps.active()).map(
			(line) => `${theme.fg(FRAME_ROLE, "│")} ${fit(line, inner - 2)} ${theme.fg(FRAME_ROLE, "│")}`,
		);
		const hints = KEYS.map(([key, label]) => ({ key, label, text: `${key} ${label}`, action: (key === "r" ? "refresh" : "close") as HintAction }));
		// The hovered hint paints entirely in the shared hover role (key and
		// label together, one color) instead of its ordinary two-role split --
		// the same treatment every other clickable surface uses.
		const keys = hints
			.map(({ key, label, action }) => (this.hoveredHint === action ? theme.fg(HOVER_ROLE, `${key} ${label}`) : `${theme.fg(KEY_ROLE, key)} ${theme.fg(KEY_TEXT_ROLE, label)}`))
			.join(HINT_GAP);
		const keysLine = `${theme.fg(FRAME_ROLE, "│")} ${fit(keys, inner - 2)} ${theme.fg(FRAME_ROLE, "│")}`;
		const bottom = theme.fg(FRAME_ROLE, `╰${rule(inner)}╯`);
		const lines = [top, ...body, keysLine, bottom];
		this.pointer = this.hintLayout(width, lines.length, body.length + 1, hints, inner - 2);
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
	private hintLayout(width: number, height: number, row: number, hints: Array<{ text: string }>, contentWidth: number): PointerLayout | undefined {
		const plainWidth = hints.reduce((total, hint) => total + hint.text.length, 0) + HINT_GAP.length * Math.max(0, hints.length - 1);
		if (plainWidth > contentWidth) return undefined;
		const spans: HintSpan[] = [];
		let cursor = HINT_CONTENT_OFFSET;
		for (let index = 0; index < KEYS.length; index += 1) {
			const [key] = KEYS[index]!;
			const text = hints[index]!.text;
			const start = cursor;
			const end = start + text.length;
			spans.push({ start, end, action: key === "r" ? "refresh" : "close" });
			cursor = end + HINT_GAP.length;
		}
		return { width, height, row, spans };
	}
}
