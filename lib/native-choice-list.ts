import {
	Box,
	Container,
	KeybindingsManager,
	isKeyRelease,
	matchesKey,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { NativePointerScope } from "./native-pointer-region.ts";

export interface NativeChoiceItem {
	id: string;
	label: string;
	description?: string;
}

export interface NativeChoiceListTheme {
	selectedPrefix(text: string): string;
	selectedText(text: string): string;
	description(text: string): string;
	hoverBackground(text: string): string;
}

export interface NativeChoiceListOptions {
	/** Require a prior completed click on the same row; keyboard confirmation is unchanged. */
	confirmOnSecondClick?: boolean;
}

interface Row<T extends NativeChoiceItem> {
	item: T;
	text: Text;
	box: Box;
}

export class NativeChoiceList<T extends NativeChoiceItem> extends Container {
	onSelect?: (item: T) => void;
	onCancel?: () => void;
	private readonly rows: Row<T>[] = [];
	private readonly items: readonly T[];
	private readonly theme: NativeChoiceListTheme;
	private readonly keybindings: KeybindingsManager | undefined;
	private selected = 0;
	private pointerSelected: string | undefined;
	private readonly confirmOnSecondClick: boolean;
	private hovered: string | undefined;
	private disabled = false;
	private readonly pointerScope = new NativePointerScope();
	private renderedWidth: number | undefined;

	constructor(
		items: readonly T[], theme: NativeChoiceListTheme, keybindings?: KeybindingsManager,
		options: NativeChoiceListOptions = {},
	) {
		super();
		this.items = items;
		this.theme = theme;
		this.keybindings = keybindings;
		this.confirmOnSecondClick = options.confirmOnSecondClick ?? false;
		for (const item of items) this.addRow(item);
		this.refreshRows();
	}

	getSelectedItem(): T | undefined {
		return this.items[this.selected];
	}

	setSelectedIndex(index: number): void {
		this.pointerSelected = undefined;
		const next = Math.max(0, Math.min(this.items.length - 1, index));
		if (next === this.selected) return;
		this.selected = next;
		this.refreshRows();
	}

	/** Refresh rendered rows after callers update the existing item records. */
	refreshItems(): void {
		this.refreshRows();
	}

	clearHover(): boolean {
		if (!this.hovered) return false;
		this.hovered = undefined;
		this.refreshRows();
		return true;
	}

	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
		this.pointerSelected = undefined;
		this.pointerScope.setDisabled(disabled);
		if (disabled) this.clearHover();
	}

	createMouseObserver(requestRender: () => void) {
		return this.pointerScope.createMouseObserver(requestRender);
	}

	override handleMouse(event: TuiMouseEvent) {
		const result = super.handleMouse(event);
		if (result || this.disabled || event.type !== "wheel" || !event.wheelDelta) return result;
		const before = this.selected;
		this.setSelectedIndex(this.selected + (event.wheelDelta < 0 ? -1 : 1));
		return {
			handled: true as const,
			render: before !== this.selected,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	handleInput(data: string): void {
		if (this.disabled || isKeyRelease(data)) return;
		if (this.matches(data, "tui.select.up")) this.setSelectedIndex(this.selected - 1);
		else if (this.matches(data, "tui.select.down")) this.setSelectedIndex(this.selected + 1);
		else if (this.matches(data, "tui.select.confirm")) {
			this.pointerSelected = undefined;
			const item = this.getSelectedItem();
			if (item) this.onSelect?.(item);
		}
		else if (this.matches(data, "tui.select.cancel")) this.onCancel?.();
	}

	override render(width: number): string[] {
		if (this.renderedWidth !== width) {
			this.renderedWidth = width;
			this.pointerScope.invalidate();
		}
		return super.render(width);
	}

	override invalidate(): void {
		this.renderedWidth = undefined;
		this.pointerScope.invalidate();
		super.invalidate();
	}

	private addRow(item: T): void {
		const text = new Text("", 1, 0);
		const box = new Box(0, 0, (value) => this.hovered === item.id ? this.theme.hoverBackground(value) : value);
		box.addChild(text);
		this.rows.push({ item, text, box });
		this.addChild(this.pointerScope.wrap(box, {
			onHover: (event) => this.handleRowMouse(item, event),
			onLeave: () => this.clearHover(),
			onPress: (event) => this.handleRowMouse(item, event),
			onClick: (event) => this.handleRowMouse(item, event),
		}));
	}

	private handleRowMouse(item: T, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disabled) return undefined;
		if (event.type === "move" && event.button === "none") {
			const changed = this.setHover(item.id);
			return { handled: true, render: changed };
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press") {
			if (this.pointerSelected !== item.id) this.pointerSelected = undefined;
			const changed = this.selectItem(item.id);
			return { handled: true, focus: true, render: changed };
		}
		if (event.type === "click") {
			const confirm = !this.confirmOnSecondClick || this.pointerSelected === item.id;
			const changed = this.selectItem(item.id);
			this.pointerSelected = confirm ? undefined : item.id;
			if (confirm) this.onSelect?.(item);
			return { handled: true, render: changed };
		}
		return undefined;
	}

	private matches(
		data: string,
		binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
	): boolean {
		if (this.keybindings?.matches) return this.keybindings.matches(data, binding);
		const key = binding === "tui.select.up" ? "up"
			: binding === "tui.select.down" ? "down"
				: binding === "tui.select.confirm" ? "enter" : "escape";
		return matchesKey(data, key);
	}

	private selectItem(id: string): boolean {
		const index = this.items.findIndex((item) => item.id === id);
		if (index === -1 || index === this.selected) return false;
		this.selected = index;
		this.refreshRows();
		return true;
	}

	private setHover(id: string): boolean {
		if (this.hovered === id) return false;
		this.hovered = id;
		this.refreshRows();
		return true;
	}

	private refreshRows(): void {
		for (const [index, row] of this.rows.entries()) {
			const prefix = index === this.selected ? this.theme.selectedPrefix("→ ") : "  ";
			const label = index === this.selected ? this.theme.selectedText(row.item.label) : row.item.label;
			const text = row.item.description
				? `${prefix}${label}\n   ${this.theme.description(row.item.description)}`
				: `${prefix}${label}`;
			row.text.setText(text);
			row.box.invalidate();
		}
	}
}
