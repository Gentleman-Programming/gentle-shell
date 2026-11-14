import { sanitizeTerminalText } from "./terminal-theme.ts";
import { decodeKittyPrintable, isKeyRelease, matchesKey, Key, sliceByColumn, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { VisualProfile } from "./visual-profiles.ts";
import { CARD_PADDING, renderPaletteCard, renderPaletteSelection } from "./command-palette.ts";
import { stripAnsi } from "./terminal-theme.ts";
import { paintHoverable } from "./shell-hover.ts";

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

/** Category-aware footer; the audio card advertises audio keys, never the visual profiles pane. */
function footerHint(category: string, navOnly: boolean, previewLines: number, keyhint?: string, setting = false, applyOnMove = true): string {
	if (navOnly) return "↑/↓ categories · → open · Esc close";
	if (setting && category === "Notifications") return keyhint ?? "←/→ choose · Enter apply · Tab panes · Esc close";
	if (setting) return applyOnMove ? "↑/↓ settings · ←/→ change · Tab categories · p profiles · Esc close" : "←/→ choose · Enter apply · ↑/↓ settings · Tab panes · Esc close";
	if (category === "Notifications") return keyhint ?? "Tab panes · Enter change · p test · Esc close";
	if (category === "Keymaps") return keyhint ?? "Enter assign · Tab panes · Esc close";
	return previewLines ? "←/→ or Tab panes · ↑/↓ move · Enter apply · p profiles · Esc close" : "Preview omitted · ←/→ panes · ↑/↓ move · Enter apply · Esc close";
}

/** A row is interactive only while its `visible()` check passes; a throwing check fails closed. */
function rowVisible(row: CustomizeRow): boolean {
	if (!row.visible) return true;
	try { return row.visible() !== false; } catch { return false; }
}

type LineEntry = { first: number; count: number; setting?: string };

interface PointerHit {
	id: string;
	x: number;
	end: number;
	y: number;
	text?: string;
	activate(): void;
}
interface HoveredHit {
	id: string;
	x: number;
	end: number;
	y: number;
	text: string;
}
interface PointerFrame {
	width: number;
	height: number;
	available: number;
	profile: boolean;
	category: string;
	rows: CustomizeRow[];
	hits: PointerHit[];
}
interface ChoiceSpan {
	start: number;
	end: number;
	index: number;
	step?: number;
}
interface SettingLine {
	text: string;
	nameEnd: number;
	spans: ChoiceSpan[];
}

/** Only complete, painted consent labels are pointer targets. */
function confirmationHits(hits: PointerHit[], lines: readonly string[], firstRow: number, answer: (yes: boolean) => void): void {
	const instruction = "y yes · any other key cancel";
	const start = lines.join("").lastIndexOf(instruction);
	if (start < 0) return;
	let offset = 0;
	lines.forEach((line, index) => {
		for (const [label, position, yes] of [["y yes", start, true], ["cancel", start + instruction.length - "cancel".length, false]] as const) {
			const at = position - offset;
			if (at < 0 || at + label.length > line.length) continue;
			const x = 2 + visibleWidth(line.slice(0, at));
			hits.push({ id: yes ? "confirm:yes" : "confirm:cancel", x, end: x + visibleWidth(label), y: firstRow + index, activate: () => answer(yes) });
		}
		offset += line.length;
	});
}

export type CustomizeCategory = "Animations" | "Banner" | "Themes" | "Editor" | "History" | "Notifications" | "Layout" | "Cards" | "Sections" | "Keymaps" | "Profiles" | "Reset";

export interface CustomizeRow {
	category?: CustomizeCategory;
	label: string | (() => string);
	children?: CustomizeRow[];
	inert?: boolean;
	indent?: number;
	/** Read-only representation of the highlighted choice, never an application; `sample` may span lines. */
	preview?: () => { title: string; sample: string };
	/**
	 * One value of a setting. Consecutive rows of the same `setting` render as one
	 * line with their values inline. Layout choices apply on ←/→; set applyOnMove
	 * to false for preview-first, permission or privacy settings that need Enter.
	 */
	choice?: { setting: string; value: string; current(): boolean; hint?: string; applyOnMove?: boolean };
	/** When present and it returns false the row is hidden from its category; an exception fails closed. */
	visible?: () => boolean;
	/** Audio-footer hint for this row; omitted rows use the category default (never advertising `f WAV`). */
	keyhint?: string;
	/** Runs on Enter/Space. May await the inline bridge for a row-scoped edit or consent. */
	action(inline: CustomizeInline): void | Promise<void>;
	/** Row-scoped shortcuts, checked before panel shortcuts. Return `true` for a synchronous
	 *  consumption, or a Promise for an asynchronous task (e.g. the inline WAV field) the view
	 *  must keep busy until it settles so overlapping keys/actions cannot write stale state. */
	key?(data: string, inline: CustomizeInline): boolean | Promise<unknown>;
}
/** Minimal in-card bridge so a row never opens a nested native dialog. */
export interface CustomizeInline {
	/** Opens an inline field on the highlighted row; resolves on submit or undefined when cancelled. */
	input(request: { prompt: string; value: string }): Promise<string | undefined>;
	/** Waits for the next raw key press on the highlighted row; resolves undefined on Esc or when the prompt is not fully visible. */
	capture(prompt: string): Promise<string | undefined>;
	/** Opens an inline confirmation; resolves true only after an explicit, fully visible yes. */
	confirm(message: string): Promise<boolean>;
	/** Set once the owning card is disposed; a row must never persist after this. */
	disposed: boolean;
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
	private pointerFrame?: PointerFrame;
	private hovered?: HoveredHit;
	private error?: string;
	private childRows?: CustomizeRow[];
	private childReturnIndex = 0;
	private profileOpen = false;
	private profileIndex = 0;
	private profileInput?: string;
	private profileWidth?: number;
	private profileInputVisible = false;
	private confirmation?: { action: "replace" | "apply" | "delete" | "reset"; name?: string; fingerprint?: string };
	private confirmationVisible = false;
	private profileBusy = false;
	private inlineInput?: { prompt: string; value: string; resolve: (value: string | undefined) => void; visible: boolean };
	private inlineConfirm?: { message: string; resolve: (value: boolean) => void; visible: boolean };
	private inlineCapture?: { prompt: string; resolve: (value: string | undefined) => void; visible: boolean };
	private readonly inline: CustomizeInline = {
		input: request => this.openInlineInput(request),
		capture: prompt => this.openInlineCapture(prompt),
		confirm: message => this.openInlineConfirm(message),
		disposed: false,
	};
	/** Header and diagnostic context for the active pane; Notifications is explicitly audio. */
	title(): string { return (this.categories[this.categoryIndex] ?? "Settings") === "Notifications" ? "Audio notifications" : "Customization"; }
	/** Ends the interaction and resolves any pending inline field/consent as cancelled. */
	dispose(): void { this.closed = true; this.clearPointer(); this.inline.disposed = true; this.cancelInline(); }
	private cancelInline(): void {
		const input = this.inlineInput;
		if (input) { this.inlineInput = undefined; input.resolve(undefined); }
		const confirm = this.inlineConfirm;
		if (confirm) { this.inlineConfirm = undefined; confirm.resolve(false); }
		const capture = this.inlineCapture;
		if (capture) { this.inlineCapture = undefined; capture.resolve(undefined); }
	}
	private openInlineCapture(prompt: string): Promise<string | undefined> {
		if (this.closed) return Promise.resolve(undefined);
		return new Promise(resolve => { this.inlineCapture = { prompt, resolve, visible: false }; });
	}
	/** The next key answers the capture; Esc, or a prompt the card could not show, cancels it. */
	private handleInlineCapture(data: string): void {
		const capture = this.inlineCapture!;
		// Same guard as the inline confirmation: a resize that hides the prompt cancels it.
		const area = this.previewCapacity();
		capture.visible = area !== undefined && !area.navOnly && area.lines > 0
			&& this.wrapInline(`${capture.prompt} · Esc cancel`, area.inner, area.lines) !== undefined;
		this.inlineCapture = undefined;
		capture.resolve(matchesKey(data, Key.escape) || !capture.visible ? undefined : data);
		this.options.requestRender();
	}
	private openInlineInput(request: { prompt: string; value: string }): Promise<string | undefined> {
		if (this.closed) return Promise.resolve(undefined);
		return new Promise(resolve => { this.inlineInput = { prompt: request.prompt, value: request.value, resolve, visible: false }; });
	}
	private openInlineConfirm(message: string): Promise<boolean> {
		if (this.closed) return Promise.resolve(false);
		return new Promise(resolve => { this.inlineConfirm = { message, resolve, visible: false }; });
	}
	/** Runs one exclusive row task, keeping `busy` set until it settles so no stale write can win. */
	private withBusy(run: () => void | Promise<unknown>): void {
		if (this.busy) return;
		this.busy = true;
		try {
			void Promise.resolve(run()).catch((error: unknown) => {
				this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
			}).finally(() => { this.busy = false; this.clearPointer(); if (!this.closed) this.options.requestRender(); });
		} catch (error) {
			this.busy = false;
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}
	/** Wraps an inline prompt into at most `capacity` fully visible lines. */
	private wrapInline(text: string, inner: number, capacity: number): string[] | undefined {
		if (capacity < 1 || inner < 1) return undefined;
		const lines: string[] = [];
		let remaining = text;
		while (remaining.length) {
			if (lines.length >= capacity) return undefined;
			if (visibleWidth(remaining) <= inner) { lines.push(remaining); return lines; }
			let chunk = "";
			for (const { segment } of graphemes.segment(remaining)) {
				if (visibleWidth(chunk + segment) > inner) break;
				chunk += segment;
			}
			if (!chunk) return undefined;
			lines.push(chunk);
			remaining = remaining.slice(chunk.length);
		}
		return lines.length ? lines : undefined;
	}
	/** Recomputes the inline area from the live terminal height, never from stale render state. */
	private previewCapacity(): { inner: number; lines: number; navOnly: boolean } | undefined {
		const width = this.mainWidth;
		if (width === undefined || width <= 0) return undefined;
		const available = this.options.rowsAvailable?.() ?? 24;
		const height = Number.isFinite(available) ? Math.max(0, Math.min(24, Math.floor(available))) : 0;
		if (width < CARD_PADDING + 1 || height < 4) return undefined;
		const navOnly = width < 60 && this.pane === "categories" && this.categories.length > 1;
		return { inner: width - CARD_PADDING, lines: height >= 11 ? 3 : height >= 8 ? 1 : 0, navOnly };
	}
	private handleInlineInput(data: string): void {
		const field = this.inlineInput!;
		if (matchesKey(data, Key.escape)) { this.inlineInput = undefined; field.resolve(undefined); }
		else if (data.startsWith("\x1b[200~")) {
			const pasted = pastedText(data);
			if (pasted !== undefined) field.value = appendInput(field.value, pasted);
		} else if (matchesKey(data, Key.enter) || data.endsWith("\r") && safeText(data.slice(0, -1))) {
			if (!matchesKey(data, Key.enter)) field.value = appendInput(field.value, data.slice(0, -1));
			// Guard against a resize that hides the field before this Enter: an unseen value never submits.
			const area = this.previewCapacity();
			field.visible = area !== undefined && !area.navOnly
				&& this.wrapInline(`${field.prompt}: ${field.value}▏`, area.inner, area.lines) !== undefined;
			if (field.visible) { this.inlineInput = undefined; field.resolve(field.value); }
		} else if (matchesKey(data, Key.backspace) || data === "\x7f") field.value = dropLastGrapheme(field.value);
		else { const text = decodeKittyPrintable(data) ?? data; if (safeText(text)) field.value = appendInput(field.value, text); }
		this.options.requestRender();
	}
	private handleInlineConfirm(data: string): void {
		const confirm = this.inlineConfirm!;
		const area = this.previewCapacity();
		confirm.visible = area !== undefined && !area.navOnly && area.lines > 0
			&& this.wrapInline(`${confirm.message} y yes · any other key cancel`, area.inner, area.lines) !== undefined;
		this.inlineConfirm = undefined;
		confirm.resolve(matchesKey(data, "y") && confirm.visible);
		this.options.requestRender();
	}
	openProfiles(): void { this.clearPointer(); this.profileOpen = true; this.error = undefined; this.options.requestRender(); }
	private profileAction(action: () => void | Promise<void>): void {
		if (this.profileBusy) return;
		this.profileBusy = true;
		try {
			void Promise.resolve(action()).catch((error: unknown) => {
				this.error = error instanceof Error ? error.message : String(error);
				this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
			}).finally(() => { this.profileBusy = false; this.clearPointer(); this.options.requestRender(); });
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
		return (this.childRows ?? this.options.rows.filter(row => (row.category ?? "Settings") === this.categories[this.categoryIndex])).filter(rowVisible);
	}

	/** The category's lines: a plain row, or every consecutive choice of one setting. */
	private lineEntries(rows: readonly CustomizeRow[]): LineEntry[] {
		const entries: LineEntry[] = [];
		rows.forEach((row, index) => {
			const last = entries.at(-1);
			if (row.choice && last?.setting === row.choice.setting && last.first + last.count === index) last.count++;
			else entries.push({ first: index, count: 1, setting: row.choice?.setting });
		});
		return entries;
	}
	private lineOf(entries: readonly LineEntry[], index: number): number {
		return Math.max(0, entries.findIndex(entry => index >= entry.first && index < entry.first + entry.count));
	}
	/** A setting line is entered on its current value. */
	private landOn(rows: readonly CustomizeRow[], entry: LineEntry | undefined): number {
		if (!entry) return 0;
		if (!entry.setting) return entry.first;
		for (let i = entry.first; i < entry.first + entry.count; i++) {
			try { if (rows[i]!.choice!.current()) return i; } catch { /* An unreadable value lands on the first choice. */ }
		}
		return entry.first;
	}
	private enterControls(): void {
		this.pane = "controls";
		const category = this.categories[this.categoryIndex]!;
		const rows = this.categoryRows();
		const entries = this.lineEntries(rows);
		this.controls.set(category, this.landOn(rows, entries[this.lineOf(entries, Math.min(this.controls.get(category) ?? 0, Math.max(0, rows.length - 1)))]));
	}
	/** The last render showed the controls (not the "Enlarge terminal" fallback), so a key may apply one. */
	private controlsShown(): boolean {
		return this.mainWidth !== undefined && this.mainWidth >= CARD_PADDING + 3 && (this.options.rowsAvailable?.() ?? 24) >= 4;
	}
	/** Moves the selection to the first row whose label contains `label`, without applying it. */
	focus(label: string): boolean {
		const previous = this.categoryIndex;
		for (let index = 0; index < this.categories.length; index++) {
			this.categoryIndex = index;
			const found = this.categoryRows().findIndex(row => (typeof row.label === "function" ? row.label() : row.label).includes(label));
			if (found >= 0) {
				this.clearPointer();
				this.pane = "controls";
				this.controls.set(this.categories[index]!, found);
				this.options.requestRender();
				return true;
			}
		}
		this.categoryIndex = previous;
		return false;
	}

	private clearPointer(): void {
		this.pointerFrame = undefined;
		this.hovered = undefined;
	}

	/** Install only painted hits and retain hover solely across an identical target and geometry. */
	private installPointerFrame(lines: string[], next: PointerFrame): string[] {
		const previous = this.pointerFrame;
		for (const hit of next.hits) hit.text = stripAnsi(sliceByColumn(lines[hit.y]!, hit.x, hit.end - hit.x, true));
		const hover = this.hovered;
		const sameFrame = previous && previous.width === next.width && previous.height === next.height
			&& previous.available === next.available && previous.profile === next.profile && previous.category === next.category
			&& previous.rows.length === next.rows.length && previous.rows.every((row, index) => row === next.rows[index]);
		const hit = hover && sameFrame && next.hits.find(item => item.id === hover.id && item.x === hover.x
			&& item.end === hover.end && item.y === hover.y && item.text === hover.text);
		if (!hit) this.hovered = undefined;
		const paintHit = (target: PointerHit, hovered: boolean, idleRole?: string) => {
			const line = lines[target.y]!;
			// Keep existing background and neighboring colors; recolor only the hit's painted cells.
			// Column slices omit codes after the last cell, including the border's reset.
			const trailingSgr = line.match(/(?:\x1b\[[0-9;:]*m)+$/)?.[0] ?? "";
			lines[target.y] = sliceByColumn(line, 0, target.x, true)
				+ paintHoverable(this.options.theme, target.text!, hovered, idleRole)
				+ sliceByColumn(line, target.end, next.width - target.end, true) + trailingSgr;
		};
		// The surrounding confirmation is already warning-colored. Give its actionable
		// cells an idle text role so the warning hover is a visible change.
		for (const target of next.hits) if (target.id.startsWith("confirm:")) paintHit(target, target === hit, "text");
		if (hit && !hit.id.startsWith("confirm:")) paintHit(hit, true);
		this.pointerFrame = next;
		return lines;
	}

	/** Mouse coordinates are local to the rendered card, including its border. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const moving = event.type === "move" && event.button === "none";
		if (!moving && (event.button !== "left" || (event.type !== "press" && event.type !== "click"))) return undefined;
		const frame = this.pointerFrame;
		const available = this.options.rowsAvailable?.() ?? 24;
		const height = Number.isFinite(available) ? Math.max(0, Math.min(24, Math.floor(available))) : 0;
		let valid = Boolean(frame && event.width === frame.width && event.height === frame.height && height === frame.available
			&& this.profileOpen === frame.profile && (this.categories[this.categoryIndex] ?? "Settings") === frame.category);
		if (valid && frame && !frame.profile) {
			const rows = this.categoryRows();
			valid = rows.length === frame.rows.length && rows.every((row, index) => row === frame.rows[index]);
		}
		if (!valid || !frame) {
			if (!moving) return undefined;
			const changed = this.hovered !== undefined;
			this.clearPointer();
			return changed ? { handled: true, render: true } : undefined;
		}
		const hit = frame.hits.find(item => item.y === event.y && event.x >= item.x && event.x < item.end);
		if (moving) {
			const target = (this.busy && !this.inlineConfirm || this.profileBusy) ? undefined : hit;
			const previous = this.hovered;
			const changed = target ? !previous || previous.id !== target.id || previous.x !== target.x || previous.end !== target.end
				|| previous.y !== target.y || previous.text !== target.text : previous !== undefined;
			this.hovered = target && target.text !== undefined ? { id: target.id, x: target.x, end: target.end, y: target.y, text: target.text } : undefined;
			return { handled: true, render: changed };
		}
		if (!hit) return undefined;
		if (event.type === "press") return { handled: true, capture: true, render: false };
		this.clearPointer();
		hit.activate();
		if (!this.closed) this.options.requestRender();
		return { handled: true, render: true };
	}

	handleInput(data: string): void {
		if (this.closed || isKeyRelease(data)) return;
		const hovered = this.hovered !== undefined;
		this.clearPointer();
		if (hovered) this.options.requestRender();
		if (this.inlineInput) { this.handleInlineInput(data); return; }
		if (this.inlineConfirm) { this.handleInlineConfirm(data); return; }
		if (this.inlineCapture) { this.handleInlineCapture(data); return; }
		if (this.profileOpen && this.options.profiles) { this.handleProfiles(data); return; }
		if (matchesKey(data, Key.escape) && this.childRows) { this.childRows = undefined; this.controls.set(this.categories[this.categoryIndex]!, this.childReturnIndex); this.pane = "controls"; this.options.requestRender(); return; }
		if (matchesKey(data, Key.escape)) { this.dispose(); this.options.onClose(); return; }
		const rows = this.categoryRows();
		const length = this.pane === "categories" ? this.categories.length : rows.length;
		if (length) {
			this.selected = Math.min(this.controls.get(this.categories[this.categoryIndex]!) ?? 0, Math.max(0, rows.length - 1));
			// Row shortcuts outrank panel shortcuts (Notifications `p` previews instead of opening profiles).
			if (this.pane === "controls" && !this.busy) {
				let consumed = false;
				try {
					const keyed = rows[this.selected]?.key?.(data, this.inline);
					if (keyed !== undefined && keyed !== false) {
						consumed = true;
						// An async key (local WAV field + validation) owns the card until it settles.
						if (typeof (keyed as Promise<unknown>).then === "function") this.withBusy(() => keyed as Promise<unknown>);
					}
				} catch (error) {
					consumed = true;
					this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
				}
				if (consumed) { this.options.requestRender(); return; }
			}
		}
		// Notifications rows own `p` for a per-event preview. When no event row is
		// selected the panel must consume it instead of opening visual profiles.
		if (matchesKey(data, "p") && this.pane === "controls" && (this.categories[this.categoryIndex] ?? "Settings") === "Notifications") { this.options.requestRender(); return; }
		if (!this.childRows && this.options.profiles && matchesKey(data, "p")) { this.openProfiles(); return; }
		if (this.childRows && matchesKey(data, Key.tab)) return;
		if (!length) return;
		const entries = this.lineEntries(rows);
		const line = this.lineOf(entries, this.selected);
		const entry = entries[line];
		const category = this.categories[this.categoryIndex]!;
		// Walk inline values; live choices apply immediately, deferred choices wait for Enter.
		// Moving left past the first value returns to the categories.
		const step = this.pane === "controls" && entry?.setting ? matchesKey(data, Key.left) ? -1 : matchesKey(data, Key.right) ? 1 : 0 : 0;
		if (step === -1 && this.selected === entry!.first) { if (!this.childRows) this.pane = "categories"; }
		else if (step) {
			const next = this.selected + step;
			// Same guard as Enter: never apply a value the card is too small to show.
			if (next >= entry!.first && next < entry!.first + entry!.count && !this.busy && this.controlsShown()) {
				this.controls.set(category, next);
				if (rows[next]!.choice?.applyOnMove !== false) this.withBusy(() => rows[next]!.action(this.inline));
			}
		} else if (!this.childRows && (matchesKey(data, Key.left) || matchesKey(data, Key.tab) && this.pane === "controls")) this.pane = "categories";
		else if (!this.childRows && (matchesKey(data, Key.right) || matchesKey(data, Key.tab) && this.pane === "categories")) this.enterControls();
		else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.pane === "categories") this.categoryIndex = (this.categoryIndex + length - 1) % length;
			else this.controls.set(category, this.landOn(rows, entries[(line + entries.length - 1) % entries.length]));
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.pane === "categories") this.categoryIndex = (this.categoryIndex + 1) % length;
			else this.controls.set(category, this.landOn(rows, entries[(line + 1) % entries.length]));
		} else if ((matchesKey(data, Key.enter) || matchesKey(data, Key.space)) && this.pane === "categories") this.enterControls();
		else if ((matchesKey(data, Key.enter) || matchesKey(data, Key.space)) && !this.busy && this.controlsShown() && rows[this.selected]) {
			this.activateRow(rows[this.selected]!);
		}
		this.options.requestRender();
	}

	private activateRow(row: CustomizeRow): void {
		if (row.inert) return;
		if (row.children) { this.childReturnIndex = this.controls.get(this.categories[this.categoryIndex]!) ?? 0; this.childRows = row.children; this.pane = "controls"; this.controls.set(this.categories[this.categoryIndex]!, 0); this.clearPointer(); return; }
		this.withBusy(() => row.action(this.inline));
	}

	/** One setting with its values inline (● current, ○ other); too wide, only the selected value with arrows. */
	private renderSettingLine(rows: readonly CustomizeRow[], entry: LineEntry, width: number, nameWidth: number, focused: boolean, theme: CustomizeViewOptions["theme"]): SettingLine {
		const choices = rows.slice(entry.first, entry.first + entry.count).map(row => row.choice!);
		const isCurrent = (choice: NonNullable<CustomizeRow["choice"]>) => { try { return choice.current(); } catch { return false; } };
		const name = sanitizeTerminalText(entry.setting!);
		const lead = `${name}${" ".repeat(Math.max(0, nameWidth - visibleWidth(name)))}  `;
		const shown = focused ? rows[this.selected]?.choice ?? choices[0]! : choices.find(isCurrent) ?? choices[0]!;
		// ● marks the current value; on the focused line › marks the cursor when it is elsewhere.
		const mark = (choice: NonNullable<CustomizeRow["choice"]>) => {
			const cursor = focused && choice === shown && !isCurrent(choice);
			const text = `${isCurrent(choice) ? "●" : cursor ? "›" : "○"} ${sanitizeTerminalText(choice.value)}`;
			return theme.fg(isCurrent(choice) || cursor ? "accent" : "muted", text);
		};
		let body = choices.map(mark).join("  ");
		const bodyStart = 2 + visibleWidth(lead);
		const spans: ChoiceSpan[] = [];
		if (bodyStart + visibleWidth(body) > width) {
			const value = sanitizeTerminalText(shown.value);
			const index = choices.indexOf(shown);
			const compact = `‹ ${value} ›`;
			body = `${theme.fg("accent", compact)} ${theme.fg("muted", `${index + 1}/${choices.length}`)}`;
			// Truncation replaces the last column with an ellipsis: never expose a
			// partial value or arrows that would step from an unseen identity.
			const limit = bodyStart + visibleWidth(body) > width ? width - 1 : width;
			if (bodyStart + visibleWidth(compact) <= limit) {
				if (index > 0) spans.push({ start: bodyStart, end: bodyStart + 1, index, step: -1 });
				spans.push({ start: bodyStart + 2, end: bodyStart + 2 + visibleWidth(value), index });
				if (index + 1 < choices.length) spans.push({ start: bodyStart + 3 + visibleWidth(value), end: bodyStart + 4 + visibleWidth(value), index, step: 1 });
			}
		} else {
			let start = bodyStart;
			choices.forEach((choice, index) => {
				const length = visibleWidth(`○ ${sanitizeTerminalText(choice.value)}`);
				spans.push({ start, end: start + length, index });
				start += length + 2;
			});
		}
		const text = truncateToWidth(`${focused ? theme.fg("accent", "▸ ") : "  "}${theme.fg(focused ? "text" : "muted", lead)}${body}`, width, "…");
		const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
		return { text: focused && theme.bg ? theme.bg("selectedBg", padded) : padded, nameEnd: Math.min(width, 2 + visibleWidth(name)), spans };
	}

	render(width: number): string[] {
		if (this.profileOpen && this.options.profiles) {
			if (width <= 0) { this.confirmationVisible = false; this.clearPointer(); return []; }
			return this.renderProfiles(width);
		}
		this.mainWidth = width;
		if (width <= 0) { this.confirmationVisible = false; this.clearPointer(); return []; }
		const available = this.options.rowsAvailable?.() ?? 24;
		const height = Number.isFinite(available) ? Math.max(0, Math.min(24, Math.floor(available))) : 0;
		if (!height) { this.clearPointer(); return []; }
		// A card needs two border rows. At extreme dimensions keep the old
		// read-only heading rather than letting invisible controls be activated.
		if (width < CARD_PADDING + 1 || height < 4) {
			this.clearPointer();
			return Array.from({ length: Math.min(height, 2) }, (_, i) => truncateToWidth(i ? "Enlarge terminal" : this.title(), width, ""));
		}
		const inner = width - CARD_PADDING;
		const category = this.categories[this.categoryIndex] ?? "Settings";
		const rows = this.categoryRows();
		const narrow = width < 60;
		const navOnly = narrow && this.pane === "categories" && this.categories.length > 1;
		const leftWidth = narrow ? 0 : Math.min(20, Math.max(14, Math.floor(inner * 0.28)));
		const rightWidth = inner - leftWidth - (leftWidth ? 3 : 0);
		const previewLines = height >= 18 ? 6 : height >= 11 ? 3 : height >= 8 ? 1 : 0;
		const showHeading = height >= 6;
		const showTopGap = height >= 12;
		const showBottomGap = height >= 9;
		const chrome = 1 + Number(showHeading) * 2 + Number(showTopGap) + Number(showBottomGap);
		const contentHeight = Math.max(1, height - 2 - chrome - previewLines);
		this.selected = Math.min(this.controls.get(category) ?? 0, Math.max(0, rows.length - 1));
		const entries = this.lineEntries(rows);
		const line = this.lineOf(entries, this.selected);
		const focusedSetting = this.pane === "controls" && entries[line]?.setting ? rows[this.selected]?.choice : undefined;
		const position = navOnly ? this.categoryIndex : line;
		const listLength = navOnly ? this.categories.length : entries.length;
		const nameWidth = Math.min(20, Math.max(0, ...entries.map(entry => entry.setting ? visibleWidth(entry.setting) : 0)));
		const start = Math.min(Math.max(0, position - contentHeight + 1), Math.max(0, listLength - contentHeight));
		const navStart = Math.min(Math.max(0, this.categoryIndex - contentHeight + 1), Math.max(0, this.categories.length - contentHeight));
		const paint = (text: string, size: number, role = "text") => {
			const clipped = truncateToWidth(text, Math.max(0, size), "…");
			return this.options.theme.fg(role, clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped))));
		};
		const join = (left: string, right: string) => leftWidth ? `${left}${" ".repeat(Math.max(0, leftWidth - visibleWidth(stripAnsi(left))))} ${paint("│", 1, "border")} ${right}` : right;
		const heading = this.childRows ? "Tabs · Esc back" : navOnly ? "Categories · choose a category →" : `${category} · ${rows.length ? `${line + 1}/${entries.length}` : "empty"}`;
		const lines: string[] = [paint(this.title(), inner, "accent")];
		const hits: PointerHit[] = [];
		const modal = Boolean(this.inlineInput || this.inlineConfirm || this.inlineCapture);
		const categoryHit = (name: string, index: number, x: number, y: number, size: number) => {
			const end = x + Math.min(visibleWidth(name), Math.max(0, size));
			if (!modal && !this.childRows && end > x) hits.push({ id: `category:${index}`, x, end, y, activate: () => {
				if (this.busy) return;
				this.categoryIndex = index;
				this.pane = "categories";
				if (narrow) this.enterControls();
			} });
		};
		const select = (index: number, apply: boolean) => {
			if (this.busy) return;
			this.pane = "controls";
			this.controls.set(category, index);
			if (apply) this.activateRow(rows[index]!);
		};
		// Commands uses a header, grouped section labels, whitespace and a footer.
		if (showHeading) lines.push(join(leftWidth ? paint("CATEGORIES", leftWidth, "accent") : "", paint(heading, rightWidth, "accent")));
		if (showTopGap) lines.push("");
		for (let i = 0; i < contentHeight; i++) {
			const nav = this.categories[navStart + i];
			const left = nav ? renderPaletteSelection(nav, leftWidth, navStart + i === this.categoryIndex, this.pane === "categories" ? this.options.theme : { fg: this.options.theme.fg.bind(this.options.theme) }) : "";
			const entry = navOnly ? undefined : entries[start + i];
			const row = entry ? rows[entry.first] : undefined;
			const item = navOnly ? this.categories[start + i] : row ? typeof row.label === "function" ? row.label() : row.label : undefined;
			const rowTheme = navOnly || this.pane === "controls" ? this.options.theme : { fg: this.options.theme.fg.bind(this.options.theme) };
			const setting = entry?.setting ? this.renderSettingLine(rows, entry, rightWidth, nameWidth, start + i === position, rowTheme) : undefined;
			const focused = start + i === position;
			const nestedTheme = row?.indent ? { ...rowTheme, fg: (role: string, text: string) => rowTheme.fg(role === "text" ? (focused ? "text" : "muted") : role, text) } : rowTheme;
			const right = setting?.text ?? (item ? renderPaletteSelection(`${" ".repeat(Math.min(8, Math.max(0, row?.indent ?? 0)))}${item}`, rightWidth, focused, nestedTheme) : rows.length ? "" : paint("No settings available", rightWidth, "muted"));
			const y = lines.length + 1; // card adds its top border
			const rightX = 2 + (leftWidth ? leftWidth + 3 : 0);
			if (leftWidth && nav) categoryHit(nav, navStart + i, 4, y, leftWidth - 2);
			if (navOnly && item) categoryHit(item, start + i, rightX + 2, y, rightWidth - 2);
			else if (!modal && entry && row) {
				if (setting) {
					if (setting.nameEnd > 2) hits.push({ id: `setting:${entry.first}`, x: rightX + 2, end: rightX + setting.nameEnd, y, activate: () => select(this.landOn(rows, entry), false) });
					for (const span of setting.spans) hits.push({ id: `choice:${entry.first}:${span.index}:${span.step ?? 0}`, x: rightX + span.start, end: rightX + span.end, y, activate: () => {
						if (this.busy) return;
						select(entry.first + span.index, span.step === undefined);
						if (span.step) this.handleInput(span.step < 0 ? "\x1b[D" : "\x1b[C");
					} });
				} else if (!row.inert) {
					const end = rightX + visibleWidth(stripAnsi(right).trimEnd());
					if (end > rightX + 2) hits.push({ id: `row:${entry.first}`, x: rightX + 2, end, y, activate: () => select(entry.first, true) });
				}
			}
			lines.push(join(left, right));
		}
		if (this.inlineConfirm) {
			const shows = !navOnly && previewLines > 0 ? this.wrapInline(`${this.inlineConfirm.message} y yes · any other key cancel`, inner, previewLines) : undefined;
			this.inlineConfirm.visible = shows !== undefined;
			if (shows) {
				confirmationHits(hits, shows, lines.length + 1, yes => this.handleInput(yes ? "y" : "n"));
				for (const line of shows) lines.push(paint(line, inner, "warning"));
			}
			else if (previewLines > 0) lines.push(paint("Confirmation needs more space · enlarge terminal", inner, "warning"));
		} else if (this.inlineCapture) {
			const shows = !navOnly && previewLines > 0 ? this.wrapInline(`${this.inlineCapture.prompt} · Esc cancel`, inner, previewLines) : undefined;
			this.inlineCapture.visible = shows !== undefined;
			if (shows) for (const line of shows) lines.push(paint(line, inner, "accent"));
			else if (previewLines > 0) lines.push(paint("Key capture needs more space · enlarge terminal", inner, "warning"));
		} else if (this.inlineInput) {
			const field = `${this.inlineInput.prompt}: ${this.inlineInput.value}▏`;
			const shows = !navOnly ? this.wrapInline(field, inner, previewLines) : undefined;
			this.inlineInput.visible = shows !== undefined;
			if (shows) {
				for (const line of shows) lines.push(paint(line, inner, "accent"));
				if (shows.length < previewLines) lines.push(paint("Enter confirm · Esc cancel", inner, "muted"));
			} else if (previewLines > 0) {
				lines.push(paint(`Needs ${visibleWidth(field) + CARD_PADDING} columns for one line · Esc cancel`, inner, "warning"));
			}
		} else if (previewLines >= 3) {
			let preview: ReturnType<NonNullable<CustomizeRow["preview"]>> | undefined;
			try { if (!navOnly) preview = rows[this.selected]?.preview?.(); } catch { /* Never substitute the active theme for an unreadable source. */ }
			lines.push("");
			// The focused setting says what it does; the preview below shows the highlighted value.
			const headline = focusedSetting?.hint ? `${focusedSetting.setting} — ${focusedSetting.hint}` : preview ? `Preview · ${preview.title}` : "Preview unavailable";
			lines.push(paint(navOnly ? "→ controls · Esc close" : headline, inner, "accent"));
			const sample = navOnly ? [""] : (preview?.sample ?? "No read-only sample for this choice").split("\n");
			for (let i = 0; i < previewLines - 2; i++) lines.push(paint(sample[i] ?? "", inner, "muted"));
		} else if (previewLines === 1) lines.push(paint(navOnly ? "→ controls · Esc close" : "Preview omitted · enlarge terminal", inner, "muted"));
		if (showBottomGap) lines.push("");
		if (showHeading) lines.push(paint(this.childRows ? "↑/↓ move · ←/→ change · Esc back" : `Click · ${footerHint(category, navOnly, previewLines, rows[this.selected]?.keyhint, focusedSetting !== undefined, focusedSetting?.applyOnMove !== false)}`, inner, "muted"));
		// The top-right close hint mirrors Commands without consuming another row.
		const title = this.title();
		lines[0] = paint(title + " ".repeat(Math.max(1, inner - visibleWidth(title) - 3)) + "esc", inner, "accent");
		const frame = renderPaletteCard(lines.slice(0, height - 2), width, this.options.theme);
		return this.installPointerFrame(frame, { width, height: frame.length, available: height, profile: false, category, rows, hits: hits.filter(hit => hit.y < frame.length - 1) });
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
		if (height < 3 || inner < 1) { this.confirmationVisible = false; this.clearPointer(); return this.detailFrame(["Visual profiles", "Enlarge terminal"], width, height); }
		let items: VisualProfile[];
		try { items = this.options.profiles!.list(); } catch (error) {
			this.confirmationVisible = false;
			this.clearPointer();
			return this.detailFrame([this.options.theme.fg("accent", "Visual profiles"), `Profiles unavailable: ${error instanceof Error ? error.message : String(error)}`, "Esc back"], width, height);
		}
		this.profileIndex = Math.min(this.profileIndex, Math.max(0, items.length - 1));
		const selected = items[this.profileIndex];
		const choice = this.confirmation;
		const promptLines = choice ? this.confirmationLines(choice, inner, capacity) : undefined;
		this.confirmationVisible = promptLines !== undefined;
		const hits: PointerHit[] = [];
		if (promptLines) confirmationHits(hits, promptLines, 1, yes => this.handleInput(yes ? "y" : "n"));
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
		const frame = this.detailFrame(lines, width, height);
		return this.installPointerFrame(frame, { width, height: frame.length, available: height, profile: true, category: this.categories[this.categoryIndex] ?? "Settings", rows: [], hits: hits.filter(hit => hit.y < frame.length - 1) });
	}

	invalidate(): void { this.clearPointer(); this.options.requestRender(); }
}
