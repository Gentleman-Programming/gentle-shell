import {
	isKeyRelease,
	matchesKey,
	type KeybindingsManager,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface ReviewConsentAction {
	readonly label: string;
	readonly effect: string;
}

export interface ReviewConsentContent {
	readonly headline: string;
	readonly reason: string;
	readonly value: string;
	readonly risk: string;
	readonly target: string;
	readonly projection: string;
	readonly evidence: readonly string[];
	readonly ownership: string;
	readonly offPathNote: string;
	readonly offPathCommand: string;
	readonly actions: readonly [ReviewConsentAction, ReviewConsentAction, ReviewConsentAction];
}

export interface ReviewConsentComponentTheme {
	fg(color: "accent" | "dim" | "mdHeading" | "muted", text: string): string;
	bold(text: string): string;
}

export interface ReviewConsentComponentOptions {
	readonly content: ReviewConsentContent;
	readonly theme: ReviewConsentComponentTheme;
	readonly keybindings: KeybindingsManager | undefined;
	readonly terminalRows: () => number;
	readonly onSelect: (index: number) => void;
	readonly onCancel: () => void;
}

type LineKind = "body" | "header" | "action";
interface Line { text: string; kind: LineKind; action?: number; }

function wrap(prefix: string, text: string, width: number): string[] {
	if (width <= prefix.length) return wrapTextWithAnsi(prefix + text, width);
	const indent = " ".repeat(prefix.length);
	return wrapTextWithAnsi(text, width - prefix.length).map((line, index) => index === 0 ? prefix + line : indent + line);
}

export class ReviewConsentComponent {
	private readonly options: ReviewConsentComponentOptions;
	private selected = 0;
	private mode: "actions" | "details" = "actions";
	private detailsScroll = 0;
	private actionScroll = 0;
	private actionLines: Line[] = [];
	private actionRanges: Array<{ start: number; end: number }> = [];
	private details: Line[] = [];
	private bodyHeight = 1;
	private contextHeight = 1;
	private actionHeight = 1;
	private renderedWidth: number | undefined;
	private renderedRows: number | undefined;
	private canConfirm = false;

	constructor(options: ReviewConsentComponentOptions) {
		this.options = options;
	}

	getActionOptions(): readonly string[] {
		return this.options.content.actions.map((action, index) => `${index + 1}. ${action.label}\nEffect: ${action.effect}`);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.matches(data, "tui.select.cancel")) return this.options.onCancel();
		if (data === "d" || data === "D") {
			this.mode = this.mode === "actions" ? "details" : "actions";
			this.detailsScroll = 0;
			this.canConfirm = false;
			return;
		}
		if (this.matches(data, "tui.select.confirm")) {
			if (this.mode === "actions" && this.canConfirm) this.options.onSelect(this.selected);
			return;
		}
		if (this.mode === "actions") {
			if (this.matches(data, "tui.select.up")) this.moveSelection(-1);
			else if (this.matches(data, "tui.select.down")) this.moveSelection(1);
			return;
		}
		if (this.matches(data, "tui.select.up") || matchesKey(data, "pageUp")) this.detailsScroll -= this.matches(data, "tui.select.up") ? 1 : this.step();
		else if (this.matches(data, "tui.select.down") || matchesKey(data, "pageDown")) this.detailsScroll += this.matches(data, "tui.select.down") ? 1 : this.step();
		this.canConfirm = false;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const rows = Math.max(1, this.options.terminalRows());
		if (this.renderedWidth !== safeWidth || this.renderedRows !== rows) {
			this.renderedWidth = safeWidth;
			this.renderedRows = rows;
			this.canConfirm = false;
		}
		const actions = this.buildActions(safeWidth);
		this.actionLines = actions.lines;
		this.actionRanges = actions.ranges;
		this.details = this.buildDetails(safeWidth);
		if (this.mode === "details") return this.renderDetailsScreen(safeWidth, rows);
		if (rows < 8) return this.renderCompact(safeWidth, rows);
		this.bodyHeight = rows;
		return this.renderScreen(safeWidth).slice(0, rows);
	}

	invalidate(): void {}

	private renderScreen(width: number): string[] {
		const title = wrapTextWithAnsi("Review consent", width).map((line) => this.options.theme.fg("mdHeading", this.options.theme.bold(line)));
		const wrappedHeadline = wrapTextWithAnsi(this.options.content.headline, width);
		const question = this.options.content.headline === "Review consent" || wrappedHeadline.length > 2 ? [] : wrappedHeadline;
		const reason = wrapTextWithAnsi(this.options.content.reason, width);
		const footer = wrapTextWithAnsi("↑↓ choose · Enter confirm · Esc cancel · D details", width).map((line) => this.options.theme.fg("dim", line));
		const primary = [...title, ...question, ...this.actionLines.map((line) => this.style(line)), "", ...footer];
		const lines = [...title, ...question, ...reason, ...this.actionLines.map((line) => this.style(line)), "", ...footer];
		const height = Math.min(20, this.bodyHeight);
		if (lines.length > height) {
			if (primary.length <= height) {
				this.canConfirm = true;
				return primary;
			}
			this.canConfirm = false;
			return [...title, ...this.safeActions(width).map((line) => this.style(line))];
		}
		this.canConfirm = true;
		return lines;
	}

	private renderDetailsScreen(width: number, rows: number): string[] {
		const title = wrapTextWithAnsi("Details (read-only)", width).map((line) => this.options.theme.fg("mdHeading", this.options.theme.bold(line)));
		const footer = wrapTextWithAnsi("PgUp/PgDn · D return · Esc", width).map((line) => this.options.theme.fg("dim", line));
		const height = rows - title.length - footer.length;
		if (height < 1) return wrapTextWithAnsi("Details; resize; D return; Esc cancel.", width).slice(0, rows);
		this.contextHeight = height;
		this.detailsScroll = Math.max(0, Math.min(this.detailsScroll, Math.max(0, this.details.length - height)));
		return [...title, ...this.renderDetails(height), ...footer];
	}

	private renderActions(width: number, height: number): string[] {
		const range = this.actionRanges[this.selected];
		if (!range || range.end - range.start + 1 > height) {
			this.canConfirm = false;
			return this.safeActions(width).slice(0, height).map((line) => this.style(line));
		}
		if (range.start < this.actionScroll) this.actionScroll = range.start;
		if (range.end >= this.actionScroll + height) this.actionScroll = range.end - height + 1;
		this.actionScroll = Math.max(0, Math.min(this.actionScroll, Math.max(0, this.actionLines.length - height)));
		this.canConfirm = range.start >= this.actionScroll && range.end < this.actionScroll + height;
		return this.actionLines.slice(this.actionScroll, this.actionScroll + height).map((line) => this.style(line));
	}

	private renderDetails(height: number): string[] {
		this.detailsScroll = Math.max(0, Math.min(this.detailsScroll, Math.max(0, this.details.length - height)));
		return this.details.slice(this.detailsScroll, this.detailsScroll + height).map((line) => this.style(line));
	}

	private renderCompact(width: number, rows: number): string[] {
		this.canConfirm = false;
		return this.safeActions(width).slice(0, rows).map((line) => this.style(line));
	}

	private renderTiny(width: number, rows: number): string[] {
		this.canConfirm = false;
		return wrapTextWithAnsi("Resize; Esc cancel; Enter off.", width).slice(0, rows);
	}

	private buildActions(width: number): { lines: Line[]; ranges: Array<{ start: number; end: number }> } {
		const lines: Line[] = [];
		const ranges: Array<{ start: number; end: number }> = [];
		const add = (prefix: string, text: string, kind: LineKind = "body", action?: number) => {
			for (const value of wrap(prefix, text, width)) lines.push({ text: value, kind, action });
		};
		for (const [index, action] of this.options.content.actions.entries()) {
			const start = lines.length;
			add(`${index === this.selected ? "→ " : "  "}${index + 1}. `, action.label, "action", index);
			ranges.push({ start, end: lines.length - 1 });
		}
		lines.push({ text: "", kind: "body" });
		add("Effect: ", this.options.content.actions[this.selected].effect, "action", this.selected);
		return { lines, ranges };
	}

	private safeActions(width: number): Line[] {
		return [
			...wrap("", "Resize; Esc cancel; Enter off.", width).map((text) => ({ text, kind: "body" as const })),
			...wrap("", `Action ${this.selected + 1}/3 needs its full effect.`, width).map((text) => ({ text, kind: "action" as const, action: this.selected })),
			...wrap("", "D opens details.", width).map((text) => ({ text, kind: "body" as const })),
		];
	}

	private buildDetails(width: number): Line[] {
		const lines: Line[] = [];
		const add = (prefix: string, text: string, kind: LineKind = "body") => {
			for (const value of wrap(prefix, text, width)) lines.push({ text: value, kind });
		};
		add("Provider headline: ", this.options.content.headline);
		add("Reason: ", this.options.content.reason);
		add("Value: ", this.options.content.value);
		add("Risk: ", this.options.content.risk);
		add("Target: ", this.options.content.target);
		add("Projection: ", this.options.content.projection);
		add("", "Risk evidence:");
		for (const item of this.options.content.evidence) add("  - ", item);
		add("Ownership: ", this.options.content.ownership);
		add("Off-path note: ", this.options.content.offPathNote);
		add("Off-path command: ", this.options.content.offPathCommand);
		add("", "Action consequences (read-only):", "header");
		for (const action of this.options.content.actions) {
			add("Action: ", action.label);
			add("Effect: ", action.effect);
			lines.push({ text: "", kind: "body" });
		}
		return lines;
	}

	private moveSelection(delta: number): void {
		this.selected = Math.max(0, Math.min(2, this.selected + delta));
		this.canConfirm = false;
	}

	private style(line: Line): string {
		if (line.kind === "header") return this.options.theme.fg("accent", this.options.theme.bold(line.text));
		if (line.kind === "action" && line.action === this.selected) return this.options.theme.fg("accent", line.text);
		return line.text;
	}

	private step(): number {
		return Math.max(1, this.contextHeight - 1);
	}

	private matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean {
		if (this.options.keybindings) return this.options.keybindings.matches(data, binding);
		const key = binding === "tui.select.up" ? "up"
			: binding === "tui.select.down" ? "down"
				: binding === "tui.select.confirm" ? "enter" : "escape";
		return matchesKey(data, key);
	}
}
