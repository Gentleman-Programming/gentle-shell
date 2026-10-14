import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CARD_TONE, panelInnerWidth, renderCard, type CardTheme } from "./shell-card.ts";
import { normalizeMcpRow, type McpDetailAction, type McpDetailActionId } from "./mcp-sidebar.ts";

export type McpDetailResult = { type: "run"; action: Exclude<McpDetailActionId, "tools"> } | { type: "close" };

export interface McpDetailTool {
	name: string;
	description: string;
}

export interface McpDetailInfo {
	name: string;
	statusLabel: string;
	toolCount: number;
	scopeLabel: string;
	source: string;
	enabled: boolean;
	tools: McpDetailTool[];
}

type Screen = { kind: "server" } | { kind: "tools" } | { kind: "tool"; index: number };
type Selectable = { kind: "tools" } | { kind: "tool"; index: number } | { kind: "action"; index: number } | { kind: "back" };

const BACK_LABEL = "← Back";
const DISABLED_TOOLS_NOTICE = "This MCP server is disabled — enable it first to see its tools.";
const CONNECTING_TOOLS_NOTICE = "No tools connected yet — they appear here once the server connects.";

export class McpDetailView {
	private selected = 0;
	private completed = false;
	private screen: Screen = { kind: "server" };
	private readonly info: McpDetailInfo;
	private readonly actions: McpDetailAction[];
	private readonly done: (result: McpDetailResult) => void;
	private readonly theme: CardTheme;

	constructor(
		info: McpDetailInfo,
		actions: McpDetailAction[],
		done: (result: McpDetailResult) => void,
		theme: CardTheme,
	) {
		this.info = info;
		this.actions = actions;
		this.done = done;
		this.theme = theme;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.completed || isKeyRelease(data)) return;
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+j")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+k")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.screen.kind === "server") {
				this.finish({ type: "close" });
				return;
			}
			this.up();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.activate(this.selectables()[this.selected]);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const lines = this.render(event.width);
		const row = lines[event.y];
		if (row === undefined) return undefined;
		const text = normalizeMcpRow(row);
		const index = this.selectables().findIndex((selectable) => {
			const label = this.selectableLabel(selectable);
			return label !== "" && (text === label || text.startsWith(`${label} —`));
		});
		if (index >= 0) {
			if (event.type === "move") {
				if (index === this.selected) return { handled: true };
				this.selected = index;
				return { handled: true, render: true };
			}
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.selected = index;
			this.activate(this.selectables()[index]);
			return { handled: true };
		}
		// Footer hints act with the mouse exactly as labeled.
		if (event.type === "click" && event.button === "left") {
			if (text.includes("esc back")) {
				this.up();
				return { handled: true, render: true };
			}
			if (text.includes("esc close")) {
				this.finish({ type: "close" });
				return { handled: true };
			}
		}
		return undefined;
	}

	render(width: number): string[] {
		// Selectable rows are always truncated to one physical line in every
		// state: hovering must restyle, never reflow, or the rows below jump
		// and the overlay repaints over stale content.
		const fit = Math.max(1, panelInnerWidth(this.theme, width, CARD_TONE.INFO));
		const body = this.screen.kind === "tool" ? this.toolBody(fit) : this.screen.kind === "tools" ? this.toolsBody(fit) : this.serverBody(fit);
		return renderCard(
			{ title: `MCP server ${this.info.name}`, body, tone: CARD_TONE.INFO },
			this.theme,
			width,
			{ expanded: true },
		);
	}

	private selectables(): Selectable[] {
		if (this.screen.kind === "tool") return [{ kind: "back" }];
		if (this.screen.kind === "tools") {
			return [{ kind: "back" }, ...this.info.tools.map((_, index): Selectable => ({ kind: "tool", index }))];
		}
		return this.actions.map((action): Selectable =>
			action.id === "tools" ? { kind: "tools" } : { kind: "action", index: this.actions.indexOf(action) },
		);
	}

	private selectableLabel(selectable: Selectable | undefined): string {
		if (selectable?.kind === "tool") return this.info.tools[selectable.index]?.name ?? "";
		if (selectable?.kind === "action") return this.actions[selectable.index]?.label ?? "";
		if (selectable?.kind === "tools") return this.actions.find((action) => action.id === "tools")?.label ?? "";
		if (selectable?.kind === "back") return BACK_LABEL;
		return "";
	}

	private serverBody(inner: number): string[] {
		const current = this.selectables()[this.selected];
		const row = (selectable: Selectable, text: string): string => {
			const line = singleLine(text, inner);
			return current !== undefined && sameSelectable(current, selectable) ? this.highlight(line, inner) : line;
		};
		return [
			`State: ${this.info.statusLabel} · ${this.info.toolCount} ${this.info.toolCount === 1 ? "tool" : "tools"} · ${this.info.scopeLabel}`,
			this.info.source,
			"",
			...this.actions.map((action): string => {
				const selectable: Selectable = action.id === "tools"
					? { kind: "tools" }
					: { kind: "action", index: this.actions.indexOf(action) };
				return row(selectable, `${action.label} — ${action.hint}`);
			}),
			"",
			"↑/↓ move · enter open/run · esc close",
		];
	}

	private toolsBody(inner: number): string[] {
		const current = this.selectables()[this.selected];
		const rows: string[] = [
			current !== undefined && current.kind === "back" ? this.highlight(BACK_LABEL, inner) : BACK_LABEL,
			"",
			`Tools of ${this.info.name}`,
		];
		if (!this.info.enabled) {
			rows.push(DISABLED_TOOLS_NOTICE);
		} else if (this.info.tools.length === 0) {
			rows.push(CONNECTING_TOOLS_NOTICE);
		} else {
			for (const [index, tool] of this.info.tools.entries()) {
				const text = singleLine(`${tool.name} — ${firstLine(tool.description)}`, inner);
				rows.push(current !== undefined && sameSelectable(current, { kind: "tool", index }) ? this.highlight(text, inner) : text);
			}
		}
		rows.push("", "↑/↓ move · enter open · esc back");
		return rows;
	}

	private toolBody(inner: number): string[] {
		const tool = this.screen.kind === "tool" ? this.info.tools[this.screen.index] : undefined;
		return [
			this.selected === 0 ? this.highlight(BACK_LABEL, inner) : BACK_LABEL,
			"",
			tool?.name ?? "",
			"",
			...(tool ? wrapTextWithAnsi(tool.description, inner) : []),
			"",
			"↑/↓ move · enter back · esc back",
		];
	}

	private move(delta: number): void {
		const total = this.selectables().length;
		if (total === 0) return;
		this.selected = Math.max(0, Math.min(total - 1, this.selected + delta));
	}

	private activate(selectable: Selectable | undefined): void {
		if (selectable?.kind === "tools") {
			this.screen = { kind: "tools" };
			this.selected = 0;
			return;
		}
		if (selectable?.kind === "tool") {
			this.screen = { kind: "tool", index: selectable.index };
			this.selected = 0;
			return;
		}
		if (selectable?.kind === "back") {
			this.up();
			return;
		}
		const action = selectable?.kind === "action" ? this.actions[selectable.index] : undefined;
		if (action && action.id !== "tools") this.finish({ type: "run", action: action.id });
	}

	private up(): void {
		this.screen = this.screen.kind === "tool" ? { kind: "tools" } : { kind: "server" };
		this.selected = 0;
	}

	private finish(result: McpDetailResult): void {
		if (this.completed) return;
		this.completed = true;
		this.done(result);
	}

	private highlight(text: string, inner: number): string {
		const fit = Math.max(1, inner);
		const bar = this.theme.bg?.("selectedBg", text + " ".repeat(Math.max(0, fit - visibleWidth(text))));
		// Without a selection background the `▸ ` marker costs two cells:
		// truncating for it keeps the highlighted row on one line too.
		return bar ?? this.theme.fg("accent", `▸ ${truncateToWidth(text, Math.max(1, fit - 2), "…")}`);
	}
}

export type { TUI };

function firstLine(description: string): string {
	return description.split("\n")[0] ?? "";
}

function singleLine(text: string, fit: number): string {
	return truncateToWidth(text, Math.max(1, fit), "…");
}

function sameSelectable(a: Selectable, b: Selectable): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "tool" && b.kind === "tool") return a.index === b.index;
	if (a.kind === "action" && b.kind === "action") return a.index === b.index;
	return true;
}
