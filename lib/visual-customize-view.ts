import { decodeKittyPrintable, isKeyRelease, matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { VisualProfile } from "./visual-profiles.ts";
import { CARD_PADDING, renderPaletteCard, renderPaletteSelection } from "./command-palette.ts";
import { stripAnsi } from "./terminal-theme.ts";

const MAX_INPUT_CODEPOINTS = 512;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function safeText(text: string): boolean {
	return [...text].every((character) => character === "\u200c" || character === "\u200d" || !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(character));
}

function appendInput(current: string, addition: string): string {
	if (!safeText(addition)) return current;
	return current + [...addition].slice(0, Math.max(0, MAX_INPUT_CODEPOINTS - [...current].length)).join("");
}

// Pi 0.85.1's terminal forwards bracketed paste as one wrapped input event
// to custom overlays. Only unwrap a complete frame, never terminal controls.
function pastedText(data: string): string | undefined {
	const start = "\x1b[200~", end = "\x1b[201~";
	if (!data.startsWith(start) || !data.endsWith(end)) return undefined;
	const text = data.slice(start.length, -end.length);
	return safeText(text) ? text : undefined;
}

function dropLastGrapheme(text: string): string {
	const segments = [...graphemes.segment(text)];
	return segments.length ? text.slice(0, segments[segments.length - 1]!.index) : text;
}

export type CustomizeCategory = "Animations" | "Banner" | "Themes" | "Editor" | "Layout" | "Sections" | "Profiles" | "Reset";

export interface CustomizeRow {
	category?: CustomizeCategory;
	label: string | (() => string);
	/** Read-only representation of the highlighted choice, never an application. */
	preview?: () => { title: string; sample: string };
	action(): void | Promise<void>;
}
export interface ProfileActions {
	list(): VisualProfile[];
	save(name: string, replace: boolean): void | Promise<void>;
	apply(name: string): void | Promise<void>;
	delete(name: string): void | Promise<void>;
	reset(): void | Promise<void>;
}
export interface CustomizeViewOptions {
	profiles?: ProfileActions;
	rows: CustomizeRow[];
	theme: { fg(color: string, text: string): string; bg?(color: string, text: string): string };
	requestRender(): void;
	rowsAvailable?: () => number;
	onError?: (error: Error) => void;
	onClose(): void;
}

/** One interaction per instance; the selection survives updates to store-backed labels. */
export class VisualCustomizeView {
	private selected = 0;
	private mainWidth?: number;
	private categoryIndex = 0;
	private pane: "categories" | "controls";
	private readonly categories: string[];
	private readonly controls = new Map<string, number>();
	private closed = false;
	private busy = false;
	private readonly options: CustomizeViewOptions;
	private error?: string;
	private profileOpen = false;
	private profileIndex = 0;
	private profileInput?: string;
	private profileWidth?: number;
	private profileInputVisible = false;
	private confirmation?: { action: "replace" | "apply" | "delete" | "reset"; name?: string; fingerprint?: string };
	private confirmationVisible = false;
	private profileBusy = false;
	openProfiles(): void { this.profileOpen = true; this.error = undefined; this.options.requestRender(); }
	private profileAction(action: () => void | Promise<void>): void {
		if (this.profileBusy) return;
		this.profileBusy = true;
		try {
			void Promise.resolve(action()).catch((error: unknown) => {
				this.error = error instanceof Error ? error.message : String(error);
				this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
			}).finally(() => { this.profileBusy = false; this.options.requestRender(); });
		} catch (error) {
			this.profileBusy = false;
			this.error = error instanceof Error ? error.message : String(error);
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}
	private confirmationLines(choice: NonNullable<VisualCustomizeView["confirmation"]>, inner: number, capacity: number): string[] | undefined {
		const prompt = `Confirm ${choice.action} ${choice.name ?? "catalog"}? y yes · any other key cancel`;
		const lines: string[] = [];
		if (visibleWidth(prompt) <= inner) lines.push(prompt);
		else {
			lines.push(`Confirm ${choice.action}`);
			let remaining = `${choice.name ?? "catalog"}?`;
			while (remaining.length && inner > 0) {
				let chunk = "";
				for (const { segment } of graphemes.segment(remaining)) {
					if (visibleWidth(chunk + segment) > inner) break;
					chunk += segment;
				}
				if (!chunk) return undefined;
				lines.push(chunk);
				remaining = remaining.slice(chunk.length);
			}
			if (remaining.length) return undefined;
			lines.push("y yes · any other key cancel");
		}
		return lines.length <= capacity && lines.every(line => visibleWidth(line) <= inner) ? lines : undefined;
	}
	private handleProfiles(data: string): void {
		const profiles = this.options.profiles!;
		if (matchesKey(data, Key.escape)) {
			if (this.profileInput !== undefined) this.profileInput = undefined;
			else if (this.confirmation) { this.confirmation = undefined; this.confirmationVisible = false; }
			else this.profileOpen = false;
		} else if (this.profileInput !== undefined) {
			if (data.startsWith("\x1b[200~")) {
				const pasted = pastedText(data);
				if (pasted !== undefined) this.profileInput = appendInput(this.profileInput, pasted);
			} else if (matchesKey(data, Key.enter) || data.endsWith("\r") && safeText(data.slice(0, -1))) {
				if (!matchesKey(data, Key.enter)) this.profileInput = appendInput(this.profileInput, data.slice(0, -1));
				// A resize or error may hide an open field. Never save a value that
				// cannot fit in the current profile card at its last rendered width.
				if (this.profileWidth !== undefined) this.renderProfiles(this.profileWidth);
				if (this.profileInputVisible) {
					const name = this.profileInput;
					this.profileInput = undefined;
					this.profileInputVisible = false;
					this.profileAction(() => profiles.save(name, false));
				}
			} else if (matchesKey(data, Key.backspace) || data === "\x7f") this.profileInput = dropLastGrapheme(this.profileInput);
			else { const text = decodeKittyPrintable(data) ?? data; if (safeText(text)) this.profileInput = appendInput(this.profileInput, text); }
		} else if (this.confirmation) {
			const choice = this.confirmation;
			const width = this.profileWidth;
			const size = width === undefined ? undefined : this.detailSize(width);
			const visible = this.confirmationVisible && size !== undefined && size.height >= 3 && size.inner >= 1
				&& this.confirmationLines(choice, size.inner, size.capacity) !== undefined;
			this.confirmation = undefined;
			this.confirmationVisible = false;
			if (matchesKey(data, "y") && visible) {
				if (choice.action === "reset") this.profileAction(() => profiles.reset());
				else if (choice.name) {
					const name = choice.name;
					try {
						const current = profiles.list().find(item => item.name === name);
						if (!current || JSON.stringify(current) !== choice.fingerprint) this.error = "Profile changed; choose again.";
						else this.profileAction(() => choice.action === "replace" ? profiles.save(name, true) : choice.action === "apply" ? profiles.apply(name) : profiles.delete(name));
					} catch (error) { this.error = error instanceof Error ? error.message : String(error); }
				}
			}
		} else if (!this.profileBusy) {
			let items: VisualProfile[];
			try { items = profiles.list(); } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.options.requestRender(); return; }
			if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.profileIndex = (this.profileIndex + items.length - 1) % (items.length || 1);
			else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.profileIndex = (this.profileIndex + 1) % (items.length || 1);
			else if (matchesKey(data, "s")) { this.profileInput = ""; this.profileInputVisible = false; }
			else if (matchesKey(data, "z")) { this.confirmation = { action: "reset" }; this.confirmationVisible = false; }
			else if (items.length && (matchesKey(data, "r") || matchesKey(data, "a") || matchesKey(data, "d"))) {
				const target = items[this.profileIndex]!;
				this.confirmation = { action: matchesKey(data, "r") ? "replace" : matchesKey(data, "a") ? "apply" : "delete", name: target.name, fingerprint: JSON.stringify(target) };
				this.confirmationVisible = false;
			}
		}
		this.options.requestRender();
	}
	constructor(options: CustomizeViewOptions) {
		this.options = options;
		this.categories = [...new Set(options.rows.map(row => row.category ?? "Settings"))];
		this.pane = options.rows.some(row => row.category) ? "categories" : "controls";
	}

	private categoryRows(): CustomizeRow[] {
		return this.options.rows.filter(row => (row.category ?? "Settings") === this.categories[this.categoryIndex]);
	}

	handleInput(data: string): void {
		if (this.closed || isKeyRelease(data)) return;
		if (this.profileOpen && this.options.profiles) { this.handleProfiles(data); return; }
		if (matchesKey(data, Key.escape)) { this.closed = true; this.options.onClose(); return; }
		if (this.options.profiles && matchesKey(data, "p")) { this.openProfiles(); return; }
		const rows = this.categoryRows();
		const length = this.pane === "categories" ? this.categories.length : rows.length;
		if (!length) return;
		this.selected = Math.min(this.controls.get(this.categories[this.categoryIndex]!) ?? 0, Math.max(0, rows.length - 1));
		if (matchesKey(data, Key.left) || matchesKey(data, Key.tab) && this.pane === "controls") this.pane = "categories";
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab) && this.pane === "categories") this.pane = "controls";
		else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.pane === "categories") this.categoryIndex = (this.categoryIndex + length - 1) % length;
			else this.controls.set(this.categories[this.categoryIndex]!, (this.selected + length - 1) % length);
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.pane === "categories") this.categoryIndex = (this.categoryIndex + 1) % length;
			else this.controls.set(this.categories[this.categoryIndex]!, (this.selected + 1) % length);
		} else if ((matchesKey(data, Key.enter) || matchesKey(data, Key.space)) && this.pane === "categories") this.pane = "controls";
		else if ((matchesKey(data, Key.enter) || matchesKey(data, Key.space)) && !this.busy &&
			this.mainWidth !== undefined && this.mainWidth >= CARD_PADDING + 3 &&
			(this.options.rowsAvailable?.() ?? 24) >= 4 && rows[this.selected]) {
			this.busy = true;
			try {
				void Promise.resolve(rows[this.selected]?.action()).catch((error: unknown) => {
					this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
				}).finally(() => { this.busy = false; if (!this.closed) this.options.requestRender(); });
			} catch (error) {
				this.busy = false;
				this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		}
		this.options.requestRender();
	}

	render(width: number): string[] {
		if (this.profileOpen && this.options.profiles) {
			if (width <= 0) { this.confirmationVisible = false; return []; }
			return this.renderProfiles(width);
		}
		this.mainWidth = width;
		if (width <= 0) { this.confirmationVisible = false; return []; }
		const available = this.options.rowsAvailable?.() ?? 24;
		const height = Number.isFinite(available) ? Math.max(0, Math.min(24, Math.floor(available))) : 0;
		if (!height) return [];
		// A card needs two border rows. At extreme dimensions keep the old
		// read-only heading rather than letting invisible controls be activated.
		if (width < CARD_PADDING + 1 || height < 4) return Array.from({ length: Math.min(height, 2) }, (_, i) => truncateToWidth(i ? "Enlarge terminal" : "Visual customization", width, ""));
		const inner = width - CARD_PADDING;
		const category = this.categories[this.categoryIndex] ?? "Settings";
		const rows = this.categoryRows();
		const narrow = width < 60;
		const navOnly = narrow && this.pane === "categories" && this.categories.length > 1;
		const leftWidth = narrow ? 0 : Math.min(20, Math.max(14, Math.floor(inner * 0.28)));
		const rightWidth = inner - leftWidth - (leftWidth ? 3 : 0);
		const previewLines = height >= 11 ? 3 : height >= 8 ? 1 : 0;
		const showHeading = height >= 6;
		const showTopGap = height >= 12;
		const showBottomGap = height >= 9;
		const chrome = 1 + Number(showHeading) * 2 + Number(showTopGap) + Number(showBottomGap);
		const contentHeight = Math.max(1, height - 2 - chrome - previewLines);
		this.selected = Math.min(this.controls.get(category) ?? 0, Math.max(0, rows.length - 1));
		const position = navOnly ? this.categoryIndex : this.selected;
		const listLength = navOnly ? this.categories.length : rows.length;
		const start = Math.min(Math.max(0, position - contentHeight + 1), Math.max(0, listLength - contentHeight));
		const navStart = Math.min(Math.max(0, this.categoryIndex - contentHeight + 1), Math.max(0, this.categories.length - contentHeight));
		const paint = (text: string, size: number, role = "text") => {
			const clipped = truncateToWidth(text, Math.max(0, size), "…");
			return this.options.theme.fg(role, clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped))));
		};
		const join = (left: string, right: string) => leftWidth ? `${left}${" ".repeat(Math.max(0, leftWidth - visibleWidth(stripAnsi(left))))} ${paint("│", 1, "border")} ${right}` : right;
		const heading = navOnly ? "Categories · choose a category →" : `${category} · ${rows.length ? `${this.selected + 1}/${rows.length}` : "empty"}`;
		const lines: string[] = [paint("Visual customization", inner, "accent")];
		// Commands uses a header, grouped section labels, whitespace and a footer.
		if (showHeading) lines.push(join(leftWidth ? paint("CATEGORIES", leftWidth, "accent") : "", paint(heading, rightWidth, "accent")));
		if (showTopGap) lines.push("");
		for (let i = 0; i < contentHeight; i++) {
			const nav = this.categories[navStart + i];
			const left = nav ? renderPaletteSelection(nav, leftWidth, navStart + i === this.categoryIndex, this.pane === "categories" ? this.options.theme : { fg: this.options.theme.fg.bind(this.options.theme) }) : "";
			const row = rows[start + i];
			const item = navOnly ? this.categories[start + i] : row ? typeof row.label === "function" ? row.label() : row.label : undefined;
			const right = item ? renderPaletteSelection(item, rightWidth, start + i === position, navOnly || this.pane === "controls" ? this.options.theme : { fg: this.options.theme.fg.bind(this.options.theme) }) : rows.length ? "" : paint("No settings available", rightWidth, "muted");
			lines.push(join(left, right));
		}
		if (previewLines === 3) {
			let preview: ReturnType<NonNullable<CustomizeRow["preview"]>> | undefined;
			try { if (!navOnly) preview = rows[this.selected]?.preview?.(); } catch { /* Never substitute the active theme for an unreadable source. */ }
			lines.push("");
			lines.push(paint(navOnly ? "→ controls · Esc close" : preview ? `Preview · ${preview.title}` : "Preview unavailable", inner, "accent"));
			lines.push(paint(navOnly ? "" : preview?.sample ?? "No read-only sample for this choice", inner, "muted"));
		} else if (previewLines === 1) lines.push(paint(navOnly ? "→ controls · Esc close" : "Preview omitted · enlarge terminal", inner, "muted"));
		if (showBottomGap) lines.push("");
		if (showHeading) lines.push(paint(navOnly ? "↑/↓ categories · → open · Esc close" : previewLines ? "←/→ or Tab panes · ↑/↓ move · Enter apply · p profiles · Esc close" : "Preview omitted · ←/→ panes · ↑/↓ move · Enter apply · Esc close", inner, "muted"));
		// The top-right close hint mirrors Commands without consuming another row.
		lines[0] = paint("Visual customization" + " ".repeat(Math.max(1, inner - visibleWidth("Visual customization") - 3)) + "esc", inner, "accent");
		return renderPaletteCard(lines.slice(0, height - 2), width, this.options.theme);
	}
	private detailSize(width: number): { height: number; inner: number; capacity: number } {
		const available = this.options.rowsAvailable?.() ?? 24;
		const height = Number.isFinite(available) ? Math.max(0, Math.min(24, Math.floor(available))) : 0;
		return { height, inner: Math.max(0, width - CARD_PADDING), capacity: Math.max(0, height - 2) };
	}

	private detailFrame(lines: string[], width: number, height: number): string[] {
		if (!height || width <= 0) return [];
		if (width < CARD_PADDING + 1 || height < 3) return lines.slice(0, height).map(line => truncateToWidth(stripAnsi(line), width, ""));
		return renderPaletteCard(lines.slice(0, height - 2), width, this.options.theme);
	}

	private renderProfiles(width: number): string[] {
		this.profileWidth = width;
		this.profileInputVisible = false;
		const { height, inner, capacity } = this.detailSize(width);
		if (height < 3 || inner < 1) { this.confirmationVisible = false; return this.detailFrame(["Visual profiles", "Enlarge terminal"], width, height); }
		let items: VisualProfile[];
		try { items = this.options.profiles!.list(); } catch (error) {
			this.confirmationVisible = false;
			return this.detailFrame([this.options.theme.fg("accent", "Visual profiles"), `Profiles unavailable: ${error instanceof Error ? error.message : String(error)}`, "Esc back"], width, height);
		}
		this.profileIndex = Math.min(this.profileIndex, Math.max(0, items.length - 1));
		const selected = items[this.profileIndex];
		const choice = this.confirmation;
		const promptLines = choice ? this.confirmationLines(choice, inner, capacity) : undefined;
		this.confirmationVisible = promptLines !== undefined;
		const lines: string[] = promptLines ? promptLines.map(line => this.options.theme.fg("warning", line)) : choice ? [this.options.theme.fg("warning", "Confirmation unavailable · Esc back")] : [];
		// Input outranks the error, header and preview on tiny terminals.
		const input = this.profileInput !== undefined ? `New profile name: ${this.profileInput}▏` : undefined;
		if (input && lines.length < capacity) {
			this.profileInputVisible = visibleWidth(input) <= inner;
			lines.push(this.options.theme.fg("accent", input));
		}
		if (lines.length < capacity) lines.push(this.options.theme.fg("accent", "Visual profiles (preview only)"));
		if (lines.length < capacity) lines.push(selected ? renderPaletteSelection(`${this.profileIndex + 1}/${items.length}: ${selected.name}`, inner, true, this.options.theme) : this.options.theme.fg("muted", "No saved profiles"));
		const details = selected ? [
			`Theme: ${selected.themeName}`,
			`Animation: ${selected.animationPolicy} · Banner: rose ${selected.banner.showRose ? "on" : "off"}, logo ${selected.banner.showTextLogo ? "on" : "off"}, ${selected.banner.color}`,
			`Layout: ${selected.visual.statusPlacement} · ${selected.visual.headerPlacement} · ${selected.visual.density}`,
			`Sections: ${Object.entries(selected.visual.visibility).map(([key, value]) => `${key}:${value ? "on" : "off"}`).join(" · ")}`,
		] : [];
		const tail = this.error ? [`Error: ${this.error}`] : [];
		const footer = "↑/↓ select · s save current · r replace · a apply · d delete · z reset catalog · Esc back";
		const free = Math.max(0, capacity - lines.length - tail.length - 1);
		lines.push(...details.slice(0, free).map(line => this.options.theme.fg("text", line)));
		for (const line of tail) if (lines.length < capacity) lines.push(this.options.theme.fg(line.startsWith("Error:") ? "error" : "accent", line));
		if (lines.length < capacity) lines.push(this.options.theme.fg("muted", footer));
		return this.detailFrame(lines, width, height);
	}

	invalidate(): void { this.options.requestRender(); }
}
