import { isKeyRelease, matchesKey, visibleWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CARD_TONE, renderCard, type CardTheme } from "./shell-card.ts";
import { stripAnsi } from "./terminal-theme.ts";
import type { McpDetailAction, McpDetailActionId } from "./mcp-sidebar.ts";

export type McpDetailResult = { type: "run"; action: McpDetailActionId } | { type: "close" };

export interface McpDetailInfo {
	name: string;
	statusLabel: string;
	toolCount: number;
	scopeLabel: string;
	source: string;
	tools: string[];
}

const MAX_TOOLS = 12;

export class McpDetailView {
	private selected = 0;
	private completed = false;
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const lines = this.render(event.width);
		const row = lines[event.y];
		if (row === undefined) return undefined;
		const text = stripAnsi(row);
		const index = this.actions.findIndex((action) => text.includes(action.label));
		if (index < 0) return undefined;
		if (event.type === "move") {
			if (index === this.selected) return { handled: true };
			this.selected = index;
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.selected = index;
		const action = this.actions[index];
		if (action) this.finish({ type: "run", action: action.id });
		return { handled: true };
	}

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
			this.finish({ type: "close" });
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const action = this.actions[this.selected];
			if (action) this.finish({ type: "run", action: action.id });
		}
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const body: string[] = [
			`State: ${this.info.statusLabel} · ${this.info.toolCount} ${this.info.toolCount === 1 ? "tool" : "tools"} · ${this.info.scopeLabel}`,
			this.info.source,
			"",
			"Tools",
			...this.info.tools.slice(0, MAX_TOOLS),
			...(this.info.tools.length > MAX_TOOLS ? [`… ${this.info.tools.length - MAX_TOOLS} more`] : []),
			"",
			...this.actions.map((action, index) => this.actionRow(action, index, inner)),
			"",
			"↑/↓ move · enter run · esc close",
		];
		return renderCard(
			{ title: `MCP server ${this.info.name}`, body, tone: CARD_TONE.INFO },
			this.theme,
			width,
			{ expanded: true },
		);
	}

	private move(delta: number): void {
		if (this.actions.length === 0) return;
		this.selected = Math.max(0, Math.min(this.actions.length - 1, this.selected + delta));
	}

	private finish(result: McpDetailResult): void {
		if (this.completed) return;
		this.completed = true;
		this.done(result);
	}

	private actionRow(action: McpDetailAction, index: number, inner: number): string {
		const focused = index === this.selected;
		const marker = focused ? "▸ " : "  ";
		const row = `${marker}${action.label} — ${action.hint}`;
		if (!focused) return row;
		const padded = row + " ".repeat(Math.max(0, inner - visibleWidth(row)));
		return this.theme.bg?.("selectedBg", padded) ?? this.theme.fg("accent", row);
	}
}

export type { TUI };
