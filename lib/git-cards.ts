import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PANEL_ROW_INDENT, renderPanelHeader, renderPanelRow } from "./shell-panel.ts";
import { ChangesTracker, type ChangesModel, type FileRevision, type GitRunner, type LineCounter } from "./shell-changes.ts";
import { renderSidebarGitGraph, SidebarGitFrameCache, SidebarGitHistory, type GraphTheme, type SidebarGitGraph } from "./sidebar-git-graph.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// Gentle Shell Git cards: the two GIT-tab cards (history and changes) as one
// root-keyed state machine. Every root keeps its own capture, so a MAIN/WORKTREE
// switch paints the last good frame until the newly selected root's history and
// diff have answered and only then swaps, with a single publish. That mirrors
// SidebarTree.setRoot, where a switch never flashes a loading frame over the
// content the user was reading.

export type GitCardsSettings = { history: boolean; diff: boolean };

export type GitCardsDeps = {
	/** The bounded Git runner for one root; the caller owns the buffer bound. */
	git(root: string): GitRunner;
	untrackedLines(root: string): LineCounter;
	fileRevision(root: string): FileRevision | undefined;
	/** Ask the host to repaint after the painted cards actually changed. */
	publish(): void;
};

const PLACEHOLDER_HISTORY: SidebarGitGraph = { state: "pending" };

/** One root's painted cards plus the readers that feed them. */
type Card = {
	root: string;
	graph: SidebarGitGraph;
	revision: number;
	frame: SidebarGitFrameCache;
	model?: ChangesModel;
	statusRead: boolean;
	history?: SidebarGitHistory;
	tracker?: ChangesTracker;
	start?: Promise<void>;
	historyLoaded: boolean;
	diffLoaded: boolean;
	historyEpoch: number;
	diffEpoch: number;
	/** The card has been on screen at least once, so its cached frame is a last-good frame. */
	painted: boolean;
};

export class SidebarGitCards {
	private readonly deps: GitCardsDeps;
	private settings: GitCardsSettings;
	private readonly cards = new Map<string, Card>();
	private selected = "";
	private painted?: string;
	/** The selected root the previous frame is still painted for. */
	private pending?: string;
	private active = false;
	private disposed = false;
	private published = "";

	constructor(deps: GitCardsDeps, settings: GitCardsSettings) {
		this.deps = deps;
		this.settings = { history: settings.history, diff: settings.diff };
	}

	/** The root the selector names; the host owns what the selector paints. */
	get selectedRoot(): string {
		return this.selected;
	}

	/** The root whose cards are on screen: the last good frame during a deferred switch. */
	get paintedRoot(): string | undefined {
		return this.painted;
	}

	get graph(): SidebarGitGraph {
		return this.paintedCard()?.graph ?? PLACEHOLDER_HISTORY;
	}

	get model(): ChangesModel | undefined {
		return this.paintedCard()?.model;
	}

	get statusRead(): boolean {
		return this.paintedCard()?.statusRead ?? false;
	}

	/** Everything the painted cards depend on; the host folds it into its rail digest. */
	digest(): string {
		const card = this.paintedCard();
		return JSON.stringify([this.painted, card?.revision, card?.model?.digest, card?.statusRead, card && (card.painted || card.diffLoaded), this.settings.history, this.settings.diff]);
	}

	configure(settings: GitCardsSettings): void {
		const history = settings.history !== this.settings.history;
		const diff = settings.diff !== this.settings.diff;
		this.settings = { history: settings.history, diff: settings.diff };
		if (this.disposed || !this.active || (!history && !diff)) return;
		const card = this.cards.get(this.selected);
		if (!card) return;
		// Only the toggled card restarts: a history toggle never starts a scan,
		// and a diff toggle never re-reads history.
		if (history) this.loadHistory(card, this.settings.history);
		if (diff) this.loadDiff(card, this.settings.diff);
		this.settle(card);
	}

	/** The GIT tab was entered with `root` selected. */
	enter(root: string): void {
		if (this.disposed) return;
		this.active = true;
		this.selected = root;
		const card = this.card(root);
		if (this.painted === root) { this.load(card); return; }
		if (this.painted === undefined) { this.painted = root; this.pending = root; this.load(card); this.publish(); return; }
		this.switchTo(card);
	}

	/** The GIT tab was left: readers stop, painted frames stay for the next entry. */
	leave(): void {
		if (!this.active) return;
		this.active = false;
		this.pending = undefined;
		for (const card of this.cards.values()) this.stop(card);
	}

	/** The selector named another root. */
	select(root: string): void {
		if (this.disposed || !this.active || root === this.selected) return;
		this.stop(this.cards.get(this.selected));
		this.selected = root;
		const previous = this.painted;
		if (previous !== undefined && previous !== root) this.stop(this.cards.get(previous));
		this.pending = undefined;
		this.switchTo(this.card(root));
	}

	/** Steady-state history refresh (turn end). */
	refreshHistory(): Promise<void> {
		if (this.disposed || !this.active || !this.settings.history) return Promise.resolve();
		return this.cards.get(this.selected)?.history?.refresh() ?? Promise.resolve();
	}

	/** Steady-state diff refresh (turn end), after the selected root's first scan. */
	async refreshDiff(): Promise<void> {
		if (this.disposed || !this.active || !this.settings.diff) return;
		const card = this.cards.get(this.selected);
		if (!card) return;
		const epoch = card.diffEpoch;
		await card.start;
		if (epoch !== card.diffEpoch || !this.live(card)) return;
		const tracker = card.tracker;
		if (!tracker) return;
		const model = await tracker.refresh();
		if (epoch !== card.diffEpoch || !this.live(card)) return;
		if (model.digest === card.model?.digest && tracker.statusRead === card.statusRead) return;
		card.model = model;
		card.statusRead = tracker.statusRead;
		this.settle(card);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.active = false;
		this.pending = undefined;
		for (const card of this.cards.values()) this.stop(card);
		this.cards.clear();
	}

	/** The history card's rows for the painted root. */
	historyRows(theme: GraphTheme, width: number, viewport: number, offset = 0, collapsed = false, hovered = false): string[] {
		const card = this.paintedCard();
		if (!card) return renderSidebarGitGraph(PLACEHOLDER_HISTORY, theme, width, viewport, offset, collapsed, hovered);
		return card.frame.render(card.graph, card.revision, theme, width, viewport, offset, collapsed, hovered);
	}

	/** The changes card's rows for the painted root. */
	changesRows(theme: GraphTheme, width: number, viewport: number, offset = 0, collapsed = false, hovered = false): string[] {
		const card = this.paintedCard();
		const files = card?.model?.files ?? [];
		const statusRead = card?.statusRead ?? false;
		const rows = [renderPanelHeader(theme, width, { title: "Changes", count: `${files.length}`, open: !collapsed, hovered })];
		// The tinted surface paints per occupied cell: BODY rows fill the full
		// width via renderPanelRow (the transparent card path strips that indent).
		// The header never goes through it: the card chrome parses the leading
		// glyph from an exact-width header row, and an indent would turn it into
		// the default ✿ glyph with a clipped count.
		const fit = (row: string) => renderPanelRow(width, row);
		if (collapsed || viewport <= 1) return rows;
		// The shared tracker does not distinguish failed numstat or binary counts
		// from zero, so its sums are necessarily provisional.
		rows.push(fit(card?.model && statusRead
			? truncateToWidth(`${theme.fg("success", `+${card.model.added}`)} ${theme.fg("error", `-${card.model.deleted}`)} ${theme.fg("muted", "· partial counts")}`, width, "…")
			: theme.fg("muted", card && (card.painted || card.diffLoaded) ? "Counts unavailable" : "Loading changes…")));
		if (viewport > 2 && !files.length && statusRead) { rows.push(fit(theme.fg("muted", "No changes."))); return rows; }
		for (const file of files.slice(offset, offset + Math.max(0, viewport - 2))) {
			const status = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" }[file.status];
			const path = sanitizeTerminalText(file.path).replace(/[\r\n\t]/g, " ");
			// A file row only names counts that exist: no -0, no +0, and an untracked
			// or empty row carries no numbers at all. The header keeps the full totals.
			const parts: string[] = [];
			if (file.added > 0) parts.push(theme.fg("success", `+${file.added}`));
			if (file.deleted > 0) parts.push(theme.fg("error", `-${file.deleted}`));
			const counts = parts.join(" ");
			// The [diff] tag is the row's right column, flush against the margin on
			// every row: fitPanelLine pins it to the right edge and gives the file
			// text only what remains, so the tag can never drift or overflow.
			const right = `${counts ? `${counts} ` : ""}${theme.fg("accent", "[diff]")}`;
			const room = Math.max(1, width - PANEL_ROW_INDENT - visibleWidth(status) - 2 - visibleWidth(right));
			const label = truncateToWidth(path, room, "…");
			const slash = label.lastIndexOf("/");
			const painted = slash < 0 ? theme.fg("text", label) : theme.fg("muted", label.slice(0, slash + 1)) + theme.fg("text", label.slice(slash + 1));
			rows.push(renderPanelRow(width, `${theme.fg("accent", status)} ${painted}`, right));
		}
		return rows;
	}

	private paintedCard(): Card | undefined {
		return this.painted === undefined ? undefined : this.cards.get(this.painted);
	}

	private card(root: string): Card {
		let card = this.cards.get(root);
		if (!card) {
			card = { root, graph: PLACEHOLDER_HISTORY, revision: 0, frame: new SidebarGitFrameCache(), statusRead: false, historyLoaded: false, diffLoaded: false, historyEpoch: 0, diffEpoch: 0, painted: false };
			this.cards.set(root, card);
		}
		return card;
	}

	private live(card: Card): boolean {
		return !this.disposed && this.active && this.selected === card.root;
	}

	/** A root with a cached frame paints it at once; a root never painted is read first. */
	private switchTo(card: Card): void {
		this.load(card);
		if (card.painted || this.complete(card)) { this.show(card); this.publish(); return; }
		this.pending = card.root;
	}

	private show(card: Card): void {
		this.painted = card.root;
		card.painted = card.painted || this.complete(card);
	}

	private load(card: Card): void {
		this.loadHistory(card, this.settings.history);
		this.loadDiff(card, this.settings.diff);
	}

	private stop(card: Card | undefined): void {
		if (!card) return;
		card.history?.setActive(false);
		card.historyEpoch++;
		card.diffEpoch++;
	}

	private loadHistory(card: Card, on: boolean): void {
		card.history?.setActive(false);
		card.historyEpoch++;
		card.historyLoaded = !on;
		if (!on) return;
		const epoch = card.historyEpoch;
		const history = new SidebarGitHistory(
			async args => epoch === card.historyEpoch && this.live(card) ? this.deps.git(card.root)(args) : { code: 128, stdout: "" },
			async () => card.model?.digest,
			() => {
				if (epoch !== card.historyEpoch) return;
				card.historyLoaded = true;
				if (JSON.stringify(history.graph) !== JSON.stringify(card.graph)) {
					card.graph = history.graph;
					card.revision++;
				}
				this.settle(card);
			},
		);
		card.history = history;
		history.setActive(true);
	}

	private loadDiff(card: Card, on: boolean): void {
		card.diffEpoch++;
		card.tracker = undefined;
		card.start = undefined;
		card.diffLoaded = !on;
		if (!on) return;
		const epoch = card.diffEpoch;
		const tracker = new ChangesTracker(
			async args => epoch === card.diffEpoch && this.live(card) ? this.deps.git(card.root)(args) : { code: 128, stdout: "" },
			this.deps.untrackedLines(card.root),
			this.deps.fileRevision(card.root),
		);
		card.tracker = tracker;
		card.start = tracker.start().then(() => {
			if (epoch !== card.diffEpoch) return;
			card.model = tracker.model;
			card.statusRead = tracker.statusRead;
			card.diffLoaded = true;
			this.settle(card);
		}).catch(() => {
			if (epoch !== card.diffEpoch) return;
			card.statusRead = false;
			card.diffLoaded = true;
			this.settle(card);
		});
	}

	private complete(card: Card): boolean {
		return (!this.settings.history || card.historyLoaded) && (!this.settings.diff || card.diffLoaded);
	}

	/**
	 * A load answered. While a switch is deferred nothing paints; once both
	 * loads answered the frame swaps with one publish.
	 */
	private settle(card: Card): void {
		if (!this.live(card)) return;
		if (this.pending === card.root) {
			if (!this.complete(card)) return;
			this.pending = undefined;
			this.show(card);
			this.publish();
			return;
		}
		if (this.painted === card.root) {
			if (this.complete(card)) card.painted = true;
			this.publish();
		}
	}

	/** Publish only what would repaint differently, so loads coalesce into one frame. */
	private publish(): void {
		const digest = this.digest();
		if (digest === this.published) return;
		this.published = digest;
		this.deps.publish();
	}
}
