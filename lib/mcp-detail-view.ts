import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CARD_TONE, renderCard, type CardTheme } from "./shell-card.ts";
import { normalizeMcpRow, type McpDetailAction, type McpDetailActionId } from "./mcp-sidebar.ts";

export type McpDetailResult = { type: "run"; action: McpDetailActionId } | { type: "close" };

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
	tools: McpDetailTool[];
}

type Screen = { kind: "server" } | { kind: "tool"; index: number };
type Selectable = { kind: "tool"; index: number } | { kind: "action"; index: number } | { kind: "back" };

const BACK_LABEL = "← Back";

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
			if (this.screen.kind === "tool") {
				this.openServer();
				return;
			}
			this.finish({ type: "close" });
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
		// Rows render as `<label> — <detail>` inside the card frame (or a `▸ `
		// marker without a background); match the full label so "Disable"
		// never shadows "Disable in this project".
		const text = normalizeMcpRow(row);
		const index = this.selectables().findIndex((selectable) => {
			const label = this.selectableLabel(selectable);
			return label !== "" && (text === label || text.startsWith(`${label} —`));
		});
		if (index < 0) return undefined;
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

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const body = this.screen.kind === "tool" ? this.toolBody(inner) : this.serverBody(inner);
		return renderCard(
			{ title: `MCP server ${this.info.name}`, body, tone: CARD_TONE.INFO },
			this.theme,
			width,
			{ expanded: true },
		);
	}

	private selectables(): Selectable[] {
		if (this.screen.kind === "tool") return [{ kind: "back" }];
		return [
			...this.info.tools.map((_, index): Selectable => ({ kind: "tool", index })),
			...this.actions.map((_, index): Selectable => ({ kind: "action", index })),
		];
	}

	private selectableLabel(selectable: Selectable | undefined): string {
		if (selectable?.kind === "tool") return this.info.tools[selectable.index]?.name ?? "";
		if (selectable?.kind === "action") return this.actions[selectable.index]?.label ?? "";
		if (selectable?.kind === "back") return BACK_LABEL;
		return "";
	}

	private serverBody(inner: number): string[] {
		const current = this.selectables()[this.selected];
		const row = (selectable: Selectable, text: string): string =>
			current !== undefined && sameSelectable(current, selectable) ? this.highlight(text, inner) : text;
		return [
			`State: ${this.info.statusLabel} · ${this.info.toolCount} ${this.info.toolCount === 1 ? "tool" : "tools"} · ${this.info.scopeLabel}`,
			this.info.source,
			"",
			"Tools",
			...(this.info.tools.length === 0 ? ["  (none connected)"] : []),
			...this.info.tools.map((tool, index) =>
				row({ kind: "tool", index }, `${tool.name} — ${firstLine(tool.description)}`),
			),
			"",
			...this.actions.map((action, index) => row({ kind: "action", index }, `${action.label} — ${action.hint}`)),
			"",
			"↑/↓ move · enter open/run · esc back/close",
			"live status · reconnect · sign in: /mcp",
		];
	}

	private toolBody(inner: number): string[] {
		const tool = this.info.tools[this.screen.kind === "tool" ? this.screen.index : -1];
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
		if (selectable?.kind === "tool") {
			this.screen = { kind: "tool", index: selectable.index };
			this.selected = 0;
			return;
		}
		if (selectable?.kind === "back") {
			this.openServer();
			return;
		}
		const action = selectable?.kind === "action" ? this.actions[selectable.index] : undefined;
		if (action) this.finish({ type: "run", action: action.id });
	}

	private openServer(): void {
		this.screen = { kind: "server" };
		this.selected = 0;
	}

	private finish(result: McpDetailResult): void {
		if (this.completed) return;
		this.completed = true;
		this.done(result);
	}

	private highlight(text: string, inner: number): string {
		const clipped = truncateToWidth(text, inner, "…");
		const padded = clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		return this.theme.bg?.("selectedBg", padded) ?? this.theme.fg("accent", `▸ ${text}`);
	}
}

export type { TUI };

function firstLine(description: string): string {
	return description.split("\n")[0] ?? "";
}

function sameSelectable(a: Selectable, b: Selectable): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "tool" && b.kind === "tool") return a.index === b.index;
	if (a.kind === "action" && b.kind === "action") return a.index === b.index;
	return true;
}
