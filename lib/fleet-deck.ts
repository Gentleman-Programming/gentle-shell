import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { FleetLedgerState } from "./fleet-ledger.ts";
import { attentionQueue, fleetStatus, lensRows, nextDensity, objectiveProgress, type AttentionQueue, type FleetDensity, type FleetLens, type FleetViewDialog, type FleetViewSnapshot, type FocalItem } from "./fleet-view.ts";
import { renderFocalBar, renderHintLine, renderLensBar, renderLensPanel, renderObjectiveStrip, renderStatusLine, type FleetHintContext, type FleetViewTheme } from "./fleet-view-render.ts";
import { withOverlayRepaint } from "./overlay-repaint.ts";
import { sidebarPart, type SidebarRail } from "./shell-sidebar.ts";

// The fleet controller's calm deck (odd/tasks/fleet-orchestrator.md T5-U2,
// design/fleet-tui/05-calm-deck.html) on Pi's extension UI surfaces: objective
// strip and focal bar in a widget above the input, the lens panel as the
// "fleet" sidebar part (the fullscreen rail when it fits, else above the
// input), status and hint lines below the input, the zoom as a full-screen
// overlay, and the keys through one raw terminal input listener. The view
// model and renderers are lib/fleet-view*.ts; this file only wires them.

export const DECK_WIDGET_KEY = "gentle-fleet";
export const DECK_LENS_WIDGET_KEY = "gentle-fleet-lens";
export const DECK_STATUS_WIDGET_KEY = "gentle-fleet-status";
// Above the input, without the rail, the lens panel stays a glance.
const BOTTOM_PANEL_LINES = 8;
const ZOOM_OVERLAY = { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } } as const;
const DIGITS = ["1", "2", "3", "4"] as const;
const FUNCTION_LENSES = [["f1", "flows"], ["f2", "map"], ["f3", "costs"], ["f4", "log"]] as const;
const LETTER_LENSES = [["f", "flows"], ["m", "map"], ["$", "costs"], ["l", "log"]] as const;
const HELP = "Fleet deck keys: F1-F4 lenses, F5 zoom, alt+m density, tab the focal bar (empty input), then 1-4 choose, f m $ l lenses, z zoom, ? help, tab back.";

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
		documentPath: ledger.documentPath,
	};
}

export interface FleetDeckOptions {
	snapshot(): FleetViewSnapshot;
	/** Acts on the human's choice for the focal item; returns a notice when nothing was done. */
	answer(item: FocalItem, option: number): string | undefined;
	/** The relay's own dialog is open: it has the focus, but tab and 1-4 still reach the deck. */
	relayOpen(): boolean;
}

type DeckUi = Pick<ExtensionUIContext, "setWidget" | "onTerminalInput" | "getEditorText" | "custom" | "notify">;
type Consumed = { consume: true } | undefined;
const CONSUMED = { consume: true } as const;

// The prompt editor (Pi's Editor, or a CustomEditor such as Gentle Shell's)
// has the focus: dialogs and overlays are containers without these methods.
function editorFocused(tui: TUI | undefined): boolean {
	const focused = (tui as { getFocusedComponent?(): unknown } | undefined)?.getFocusedComponent?.() as { getText?: unknown; isShowingAutocomplete?: () => boolean } | null | undefined;
	return typeof focused?.getText === "function" && typeof focused.isShowingAutocomplete === "function" && !focused.isShowingAutocomplete();
}

export class FleetDeck {
	lens: FleetLens = "flows";
	density: FleetDensity = "light";
	private focal = false;
	private closeZoom: (() => void) | undefined;
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

	mount(ui: DeckUi): () => void {
		this.ui = ui;
		const host = (tui: TUI) => { this.tui = tui; };
		ui.setWidget(DECK_LENS_WIDGET_KEY, (tui, theme) => {
			host(tui);
			const rail: SidebarRail = { render: width => this.lensLines(width, theme as never, true), invalidate() {}, digest: () => `${this.revision}:${this.lens}:${this.density}:${this.focal}` };
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
			for (const key of [DECK_LENS_WIDGET_KEY, DECK_WIDGET_KEY, DECK_STATUS_WIDGET_KEY]) ui.setWidget(key, undefined);
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

	private empty(snapshot: FleetViewSnapshot): boolean {
		return snapshot.title === null && snapshot.members.length === 0;
	}

	private focalLines(width: number, theme: FleetViewTheme): string[] {
		const { snapshot, queue } = this.view();
		if (this.empty(snapshot)) return [];
		return [...renderObjectiveStrip(objectiveProgress(snapshot), queue, width, theme), ...renderFocalBar(queue, width, theme)];
	}

	private panel(width: number, theme: FleetViewTheme): string[] {
		const { snapshot, queue } = this.view();
		return [...renderLensBar(this.lens, width, theme), ...renderLensPanel(lensRows(this.lens, this.density, snapshot, queue), width, theme)];
	}

	private lensLines(width: number, theme: FleetViewTheme, rail: boolean): string[] {
		if (this.empty(this.view().snapshot)) return [];
		const lines = this.panel(width, theme);
		if (rail || lines.length <= BOTTOM_PANEL_LINES) return lines;
		return [...lines.slice(0, BOTTOM_PANEL_LINES - 1), theme.fg("muted", `… ${lines.length - BOTTOM_PANEL_LINES + 1} more lines · F5 zooms the lens`)];
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
				// Escape also leaves; z and F5 arrive through the input listener.
				handleInput: data => { if (matchesKey(data, "escape")) this.closeZoom?.(); },
			};
			return zoom;
		}, ZOOM_OVERLAY).catch(() => {}).finally(() => {
			// Closed some other way (session switch): forget it.
			if (mine && this.closeZoom === mine) this.closeZoom = undefined;
		});
		return CONSUMED;
	}

	private choose(item: FocalItem, option: number): void {
		this.focal = false;
		const notice = this.options.answer(item, option);
		if (notice) this.ui?.notify(notice, "warning");
		else if (!item.dialogId) this.chosen.add(chosenKey(item));
		this.invalidate();
	}

	/** Raw terminal input, before the focused component sees it. */
	handleInput(data: string): Consumed {
		if (isKeyRelease(data)) return undefined;
		const lens = FUNCTION_LENSES.find(([key]) => matchesKey(data, key));
		if (lens) return this.setLens(lens[1]);
		if (matchesKey(data, "alt+m")) {
			this.density = nextDensity(this.density);
			this.invalidate();
			return CONSUMED;
		}
		if (matchesKey(data, "f5")) return this.toggleZoom();
		// Letters act only outside the input: in the zoom or the focal bar.
		if (this.closeZoom || this.focal) {
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
			if (focal.kind !== "nothing" && digit >= 0) {
				if (digit < focal.options.length) this.choose(focal, digit);
				return CONSUMED;
			}
			// tab returns to the conversation; any other key types there.
			this.focal = false;
			this.invalidate();
			return matchesKey(data, "tab") ? CONSUMED : undefined;
		}
		// Pi's tab (autocomplete) keeps every other case: a draft, no focal item, another dialog.
		if (matchesKey(data, "tab") && focal.kind !== "nothing" && this.ui?.getEditorText() === "" && (editorFocused(this.tui) || this.options.relayOpen())) {
			this.focal = true;
			this.invalidate();
			return CONSUMED;
		}
		return undefined;
	}
}

const chosenKey = (item: FocalItem) => `${item.id}@${item.at ?? ""}`;
