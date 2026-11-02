import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { FleetLedgerState } from "./fleet-ledger.ts";
import { attentionQueue, fleetStatus, lensRows, nextDensity, objectiveProgress, type AttentionQueue, type FleetDensity, type FleetLens, type FleetViewDialog, type FleetViewSnapshot, type FocalItem } from "./fleet-view.ts";
import { renderFleetColumn, renderFocalBar, renderHintLine, renderLensBar, renderLensPanel, renderObjectiveStrip, renderStatusLine, renderWelcomeCard, type FleetHintContext, type FleetViewTheme } from "./fleet-view-render.ts";
import { withOverlayRepaint } from "./overlay-repaint.ts";
import { sidebarPart, type SidebarRail } from "./shell-sidebar.ts";

// The fleet controller's calm deck (odd/tasks/fleet-orchestrator.md T5-U2/U3,
// design/fleet-tui/05-calm-deck.html) on Pi's extension UI surfaces: the
// welcome card, then the objective strip, as the "fleet-top" part (heading
// the conversation column while the fullscreen rail paints, else above the
// input), the focal bar above the input, the fleet column as the "fleet" part
// (the whole rail when it fits, else the lens panel above the input), status
// and hint lines below the input, the zoom as a full-screen overlay, and the
// keys through one raw terminal input listener. It renders from the first
// frame, empty fleet included. The view model and renderers are
// lib/fleet-view*.ts; this file only wires them.

export const DECK_WIDGET_KEY = "gentle-fleet";
export const DECK_TOP_WIDGET_KEY = "gentle-fleet-top";
export const DECK_LENS_WIDGET_KEY = "gentle-fleet-lens";
export const DECK_STATUS_WIDGET_KEY = "gentle-fleet-status";
// Above the input, without the rail, the lens panel stays a glance.
const BOTTOM_PANEL_LINES = 8;
// One column of padding where the strip heads the conversation column.
const TOP_INSET = " ";
const ZOOM_OVERLAY = { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } } as const;
const DIGITS = ["1", "2", "3", "4"] as const;
// From anywhere (lib/fleet-view.ts FLEET_VIEW_KEYS); no function keys.
const GLOBAL_LENSES = [["alt+1", "flows"], ["alt+2", "map"], ["alt+3", "costs"], ["alt+4", "log"]] as const;
const LETTER_LENSES = [["f", "flows"], ["m", "map"], ["$", "costs"], ["l", "log"]] as const;
const HELP = "Fleet deck keys: alt+1-4 lenses, alt+z zoom, alt+m density, tab the focal bar (empty input), then 1-4 choose, f m $ l lenses, z zoom, ? help, tab or esc back.";

/** What the controller tracks live per member, beyond the ledger record. */
export interface DeckLiveMember {
	lastTool?: string;
	prefixTokens?: number;
	usage: { cacheRead: number };
	dialogs: ReadonlyArray<{ id: string; method: string; title: string; message?: string; options?: string[]; protected?: unknown }>;
}

export interface FleetSnapshotInput {
	ledger: Readonly<FleetLedgerState>;
	live(name: string): DeckLiveMember | undefined;
	/** When code saw the dialog arrive. */
	arrivedAt(dialog: DeckLiveMember["dialogs"][number]): string | undefined;
	budgets: { fleetUsd?: number; memberUsd?: number };
	controller?: { tokens: number; cost: number };
	/** The controller's live permission mode. */
	permission?: string;
	/** Members waiting on the resume question of a reopened fleet. */
	resume?: readonly string[];
}

/** The view model's snapshot: the ledger plus the live extras the ledger does not keep. */
export function buildFleetSnapshot(input: FleetSnapshotInput): FleetViewSnapshot {
	const { ledger } = input;
	return {
		title: ledger.title,
		objective: ledger.objective,
		members: ledger.members.map(record => {
			const live = input.live(record.name);
			const dialogs = (live?.dialogs ?? []).map((dialog): FleetViewDialog => ({
				id: dialog.id, method: dialog.method, title: dialog.title, message: dialog.message, options: dialog.options,
				relayed: Boolean(dialog.protected), at: input.arrivedAt(dialog),
			}));
			return { ...record, lastTool: live?.lastTool, prefixTokens: live?.prefixTokens, cacheRead: live?.usage.cacheRead, dialogs };
		}),
		log: ledger.log,
		escalations: ledger.escalations.map(entry => ({ member: entry.member, title: entry.title, message: entry.message, options: entry.options, method: entry.method, dialogId: entry.dialogId, at: entry.at })),
		budgets: { fleetUsd: input.budgets.fleetUsd ?? null, memberUsd: input.budgets.memberUsd ?? null },
		...(input.controller ? { controller: input.controller } : {}),
		...(input.permission ? { permission: input.permission } : {}),
		...(input.resume?.length ? { resume: { members: [...input.resume] } } : {}),
		documentPath: ledger.documentPath,
	};
}

export interface FleetDeckOptions {
	snapshot(): FleetViewSnapshot;
	/** Acts on the human's choice for the focal item; returns a notice when nothing was done. */
	answer(item: FocalItem, option: number): string | undefined;
	/**
	 * The relay's own select/confirm dialog, as focused when it opened, or
	 * undefined. With that dialog focused, tab and 1-4 still reach the deck.
	 */
	relayDialog(): unknown;
}

type DeckUi = Pick<ExtensionUIContext, "setWidget" | "onTerminalInput" | "getEditorText" | "custom" | "notify">;
type Consumed = { consume: true } | undefined;
const CONSUMED = { consume: true } as const;

const focusedIn = (tui: TUI | undefined): unknown => (tui as { getFocusedComponent?(): unknown } | undefined)?.getFocusedComponent?.();

// The prompt editor (Pi's Editor, or a CustomEditor such as Gentle Shell's)
// has the focus: dialogs and overlays are containers without these methods.
function isEditor(component: unknown): boolean {
	const focused = component as { getText?: unknown; isShowingAutocomplete?: () => boolean } | null | undefined;
	return typeof focused?.getText === "function" && typeof focused.isShowingAutocomplete === "function" && !focused.isShowingAutocomplete();
}

export class FleetDeck {
	lens: FleetLens = "flows";
	density: FleetDensity = "light";
	private focal = false;
	// The component focused when the focal bar took the keys (the editor or the
	// relay dialog). Any other focus at a keystroke ends focal mode: a dialog
	// opened on top gets every key, never a deck answer.
	private focalOwner: unknown;
	private closeZoom: (() => void) | undefined;
	private zoom: Component | undefined;
	private revision = 0;
	private built: { revision: number; snapshot: FleetViewSnapshot; queue: AttentionQueue } | undefined;
	// Blocker and review choices go to the fleet; they leave the queue at once.
	private readonly chosen = new Set<string>();
	private tui: TUI | undefined;
	private ui: DeckUi | undefined;
	private readonly options: FleetDeckOptions;

	constructor(options: FleetDeckOptions) {
		this.options = options;
	}

	/** State changed: the next frame rebuilds once; Pi coalesces the render requests. */
	invalidate(): void {
		this.revision += 1;
		this.tui?.requestRender();
	}

	/** The component that has the keys now. */
	focused(): unknown {
		return focusedIn(this.tui);
	}

	mount(ui: DeckUi): () => void {
		this.ui = ui;
		const host = (tui: TUI) => { this.tui = tui; };
		const digest = () => `${this.revision}:${this.lens}:${this.density}:${this.focal}`;
		ui.setWidget(DECK_TOP_WIDGET_KEY, (tui, theme) => {
			host(tui);
			const strip = { render: (width: number) => this.stripLines(width, theme as never), invalidate() {} };
			// Heading the conversation column: padded, with one blank row below.
			const top: SidebarRail = { render: width => [...this.stripLines(width - TOP_INSET.length, theme as never).map(line => TOP_INSET + line), ""], invalidate() {}, digest };
			return sidebarPart(tui, "fleet-top", strip, top);
		}, { placement: "aboveEditor" });
		ui.setWidget(DECK_LENS_WIDGET_KEY, (tui, theme) => {
			host(tui);
			// The layout gives the whole-rail lens card its height to fill.
			const rail: SidebarRail = { render: width => this.lensLines(width, theme as never, true), fill: (width, height) => this.lensLines(width, theme as never, true, height), invalidate() {}, digest };
			return sidebarPart(tui, "fleet", { render: width => this.lensLines(width, theme as never, false), invalidate() {} }, rail);
		}, { placement: "aboveEditor" });
		ui.setWidget(DECK_WIDGET_KEY, (tui, theme) => {
			host(tui);
			return { render: width => this.focalLines(width, theme as never), invalidate() {} };
		}, { placement: "aboveEditor" });
		ui.setWidget(DECK_STATUS_WIDGET_KEY, (tui, theme) => {
			host(tui);
			return { render: width => this.statusLines(width, theme as never), invalidate() {} };
		}, { placement: "belowEditor" });
		const stopInput = ui.onTerminalInput(data => {
			try { return this.handleInput(data); } catch { return undefined; }
		});
		return () => {
			stopInput();
			this.closeZoom?.();
			for (const key of [DECK_TOP_WIDGET_KEY, DECK_LENS_WIDGET_KEY, DECK_WIDGET_KEY, DECK_STATUS_WIDGET_KEY]) ui.setWidget(key, undefined);
			this.ui = undefined;
			this.tui = undefined;
		};
	}

	private view() {
		if (this.built?.revision !== this.revision) {
			const snapshot = this.options.snapshot();
			this.built = { revision: this.revision, snapshot, queue: this.queue(snapshot) };
		}
		return this.built;
	}

	private queue(snapshot: FleetViewSnapshot): AttentionQueue {
		const queue = attentionQueue(snapshot);
		const items = queue.items.filter(item => !this.chosen.has(chosenKey(item)));
		if (items.length === queue.items.length) return queue;
		const nothing = attentionQueue({ ...snapshot, members: [], escalations: [] }).focal;
		return { focal: items[0] ?? nothing, more: Math.max(0, items.length - 1), items };
	}

	// Before the objective, the welcome card (plus the focal line if something
	// already needs the human); then the objective strip.
	private stripLines(width: number, theme: FleetViewTheme): string[] {
		const { snapshot, queue } = this.view();
		const progress = objectiveProgress(snapshot);
		const strip = renderObjectiveStrip(progress, queue, width, theme);
		if (progress.stated) return strip;
		return [...renderWelcomeCard(width, theme), ...(queue.focal.kind === "nothing" ? [] : strip.slice(1))];
	}

	private focalLines(width: number, theme: FleetViewTheme): string[] {
		return renderFocalBar(this.view().queue, width, theme);
	}

	private panel(width: number, theme: FleetViewTheme): string[] {
		const { snapshot, queue } = this.view();
		return [...renderLensBar(this.lens, width, theme), ...renderLensPanel(lensRows(this.lens, this.density, snapshot, queue), width, theme)];
	}

	private lensLines(width: number, theme: FleetViewTheme, rail: boolean, height?: number): string[] {
		if (rail) {
			const { snapshot, queue } = this.view();
			return renderFleetColumn(this.lens, lensRows(this.lens, this.density, snapshot, queue), objectiveProgress(snapshot), width, theme, height);
		}
		const lines = this.panel(width, theme);
		if (lines.length <= BOTTOM_PANEL_LINES) return lines;
		return [...lines.slice(0, BOTTOM_PANEL_LINES - 1), theme.fg("muted", `… ${lines.length - BOTTOM_PANEL_LINES + 1} more lines · alt+z zooms the lens`)];
	}

	private statusLines(width: number, theme: FleetViewTheme): string[] {
		const { snapshot, queue } = this.view();
		const context: FleetHintContext = this.closeZoom ? "zoom" : this.focal ? "focal" : "input";
		return [...renderStatusLine(fleetStatus(snapshot, queue), this.lens, this.density, width, theme), ...renderHintLine(context, queue, this.density, width, theme)];
	}

	private setLens(lens: FleetLens): Consumed {
		this.lens = lens;
		this.invalidate();
		return CONSUMED;
	}

	private toggleZoom(): Consumed {
		if (this.closeZoom) {
			this.closeZoom();
			return CONSUMED;
		}
		const ui = this.ui;
		if (!ui) return undefined;
		let mine: (() => void) | undefined;
		void ui.custom<undefined>((tui, theme, _keybindings, done) => {
			const close = withOverlayRepaint(tui, done);
			mine = this.closeZoom = () => {
				this.closeZoom = undefined;
				this.zoom = undefined;
				close(undefined);
				this.invalidate();
			};
			this.invalidate();
			const zoom: Component = {
				render: width => {
					const rows = Math.max(3, tui.terminal?.rows ?? 40);
					const lines = [...this.panel(width, theme as never), "", ...this.statusLines(width, theme as never)];
					return lines.length <= rows ? lines : [...lines.slice(0, rows - 1), theme.fg("muted", `… ${lines.length - rows + 1} more lines`)];
				},
				invalidate() {},
				// Escape also leaves; z and alt+z arrive through the input listener.
				handleInput: data => { if (matchesKey(data, "escape")) this.closeZoom?.(); },
			};
			this.zoom = zoom;
			return zoom;
		}, ZOOM_OVERLAY).catch(() => {}).finally(() => {
			// Closed some other way (session switch): forget it.
			if (mine && this.closeZoom === mine) {
				this.closeZoom = undefined;
				this.zoom = undefined;
			}
		});
		return CONSUMED;
	}

	private leaveFocal(): void {
		this.focal = false;
		this.focalOwner = undefined;
		this.invalidate();
	}

	private choose(item: FocalItem, option: number): void {
		this.focal = false;
		this.focalOwner = undefined;
		const notice = this.options.answer(item, option);
		if (notice) this.ui?.notify(notice, "warning");
		else if (!item.dialogId) this.chosen.add(chosenKey(item));
		this.invalidate();
	}

	/** Raw terminal input, before the focused component sees it. */
	handleInput(data: string): Consumed {
		if (isKeyRelease(data)) return undefined;
		const lens = GLOBAL_LENSES.find(([key]) => matchesKey(data, key));
		if (lens) return this.setLens(lens[1]);
		if (matchesKey(data, "alt+m")) {
			this.density = nextDensity(this.density);
			this.invalidate();
			return CONSUMED;
		}
		if (matchesKey(data, "alt+z")) return this.toggleZoom();
		const focused = this.focused();
		// Focal mode lasts only while the component that had the keys when it
		// began still has them: a dialog or overlay opened on top, or a closed
		// relay dialog, ends it and the key goes on untouched.
		if (this.focal && (focused !== this.focalOwner || (!isEditor(this.focalOwner) && this.options.relayDialog() !== this.focalOwner))) {
			this.leaveFocal();
			return undefined;
		}
		// Letters act only outside the input: in the focused zoom or the focal bar.
		const zoomFocused = this.closeZoom !== undefined && this.zoom !== undefined && focused === this.zoom;
		if (zoomFocused || this.focal) {
			const letter = LETTER_LENSES.find(([key]) => matchesKey(data, key));
			if (letter) return this.setLens(letter[1]);
			if (matchesKey(data, "z")) return this.toggleZoom();
			if (matchesKey(data, "?")) {
				this.ui?.notify(HELP, "info");
				return CONSUMED;
			}
		}
		if (this.closeZoom) return undefined;
		const { focal } = this.view().queue;
		if (this.focal) {
			const digit = DIGITS.findIndex(key => matchesKey(data, key));
			if (focal.kind !== "nothing" && digit >= 0 && digit < focal.options.length) {
				this.choose(focal, digit);
				return CONSUMED;
			}
			// tab and escape return to the conversation (escape is not Pi's
			// interrupt here); any other key, a digit past the options included,
			// types there.
			this.leaveFocal();
			return matchesKey(data, "tab") || matchesKey(data, "escape") ? CONSUMED : undefined;
		}
		// Pi's tab (autocomplete) keeps every other case: a draft, no focal item, another dialog.
		const relay = this.options.relayDialog();
		if (matchesKey(data, "tab") && focal.kind !== "nothing" && this.ui?.getEditorText() === "" && (isEditor(focused) || (relay !== undefined && focused === relay))) {
			this.focal = true;
			this.focalOwner = focused;
			this.invalidate();
			return CONSUMED;
		}
		return undefined;
	}
}

const chosenKey = (item: FocalItem) => `${item.id}@${item.at ?? ""}`;
