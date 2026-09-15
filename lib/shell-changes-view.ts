import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { basename } from "node:path";
import { CHANGE_STATUS, changesSummary, type ChangedFile, type ChangesModel, type WorktreeChanges } from "./shell-changes.ts";

// Gentle Shell changes overlay: a framed two-pane view with the working
// tree's changed files on the left and the selected file's diff on the right.
// Git access is injected so the component renders without a repository.

export interface ChangesViewTheme {
	fg(color: string, text: string): string;
}

export interface ChangesViewDeps {
	theme: ChangesViewTheme;
	rows: number | (() => number);
	loadDiff(file: ChangedFile): Promise<string>;
	onOpen(file: ChangedFile): void;
	onClose(): void;
	requestRender(): void;
	backLabel?: string;
}

const ROLE = {
	FRAME: "border",
	TITLE: "customMessageLabel",
	SELECTED: "accent",
	PATH: "text",
	PATH_IDLE: "muted",
	ADDED: "success",
	REMOVED: "error",
	HUNK: "customMessageLabel",
	KEY: "accent",
	KEY_TEXT: "dim",
	EMPTY: "dim",
} as const;

const HEADER_PREFIXES = ["diff --git", "index ", "--- ", "+++ ", "new file mode", "deleted file mode", "similarity index", "rename from", "rename to", "Binary files"];
const LIST_MAX_WIDTH = 36;
const LIST_RATIO = 0.35;
const CHROME_ROWS = 3;
const MIN_BODY_ROWS = 1;
const EMPTY_DIFF = "no diff for this file";
const CLEAN_TREE = "working tree is clean";
const KEYS = [
	["j/k", "file"],
	["ctrl+j/k", "scroll"],
	["o", "open in editor"],
	["esc", "close"],
] as const;

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

export function colorDiff(text: string, theme: ChangesViewTheme): string[] {
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "" || HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
		if (line.startsWith("@@")) lines.push(theme.fg(ROLE.HUNK, line));
		else if (line.startsWith("+")) lines.push(theme.fg("toolDiffAdded", line));
		else if (line.startsWith("-")) lines.push(theme.fg("toolDiffRemoved", line));
		else lines.push(theme.fg("toolDiffContext", line));
	}
	return lines;
}

const FILE_STATUS = {
	[CHANGE_STATUS.MODIFIED]: "M",
	[CHANGE_STATUS.ADDED]: "A",
	[CHANGE_STATUS.DELETED]: "D",
	[CHANGE_STATUS.RENAMED]: "R",
	[CHANGE_STATUS.UNTRACKED]: "??",
} as const;

function fileCounts(file: ChangedFile, theme: ChangesViewTheme): string {
	if (file.countsUnavailable) return theme.fg("dim", "counts unavailable");
	return `${theme.fg(ROLE.ADDED, `+${file.added}`)} ${theme.fg(ROLE.REMOVED, `-${file.deleted}`)}`;
}

function fileLabel(file: ChangedFile, theme: ChangesViewTheme, role: string): string {
	return `${theme.fg(role, `${FILE_STATUS[file.status]} ${displayText(file.path)}`)}  ${fileCounts(file, theme)}`;
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

// Both standalone files and the worktree accordion use the original frame.
function renderPanes(width: number, rows: number, theme: ChangesViewTheme, title: string, leftLine: (row: number) => string, rightLines: string[], keys: string): string[] {
	const inner = Math.max(8, width - 2);
	const listWidth = Math.min(LIST_MAX_WIDTH, Math.floor(inner * LIST_RATIO));
	const diffWidth = inner - listWidth - 4;
	const titleText = truncateToWidth(title, inner - 4, "…");
	const top = theme.fg(ROLE.FRAME, "╭─ ") + theme.fg(ROLE.TITLE, titleText) + theme.fg(ROLE.FRAME, ` ${rule(inner - visibleWidth(titleText) - 3)}╮`);
	const body: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const left = fit(leftLine(row), listWidth);
		const right = fit(rightLines[row] ?? "", diffWidth);
		body.push(`${theme.fg(ROLE.FRAME, "│")} ${left} ${theme.fg(ROLE.FRAME, "│")} ${right}${theme.fg(ROLE.FRAME, "│")}`);
	}
	const keysLine = `${theme.fg(ROLE.FRAME, "│")} ${fit(keys, inner - 2)} ${theme.fg(ROLE.FRAME, "│")}`;
	const bottom = theme.fg(ROLE.FRAME, `╰${rule(inner)}╯`);
	return [top, ...body, keysLine, bottom].map((line) => truncateToWidth(line, width));
}

interface PointerLayout {
	width: number;
	height: number;
	bodyRows: number;
	listStart: number;
	listEnd: number;
	diffStart: number;
	diffEnd: number;
}

function pointerLayout(width: number, bodyRows: number): PointerLayout {
	const inner = Math.max(8, width - 2);
	const listWidth = Math.min(LIST_MAX_WIDTH, Math.floor(inner * LIST_RATIO));
	const diffWidth = inner - listWidth - 4;
	return { width, height: bodyRows + CHROME_ROWS, bodyRows, listStart: 2, listEnd: 2 + listWidth, diffStart: 5 + listWidth, diffEnd: 5 + listWidth + diffWidth };
}

function displayText(text: string): string {
	return sanitizeTerminalText(text).replace(/[\t\n]/g, " ");
}

function fingerprint(file: ChangedFile): string {
	return `${file.status}:${file.added}:${file.deleted}:${file.diffRevision ?? ""}:${file.countsUnavailable ?? ""}`;
}

export interface WorktreeChangesViewDeps {
	theme: ChangesViewTheme;
	rows: number | (() => number);
	loadDiff(root: string, file: ChangedFile): Promise<string>;
	onOpen(root: string, file: ChangedFile): void;
	onClose(): void;
	onRefresh(): void;
	requestRender(): void;
}

interface WorktreeRow {
	tree: WorktreeChanges;
	file?: ChangedFile;
}

function rowKey(row: WorktreeRow): string {
	return JSON.stringify([row.tree.root, row.file?.path ?? null]);
}

// The accordion owns navigation; standalone file views still own lazy previews.
export class WorktreeChangesView {
	private trees: WorktreeChanges[];
	private readonly deps: WorktreeChangesViewDeps;
	private selected = 0;
	private listOffset = 0;
	private pointerLayout: PointerLayout | undefined;
	private disposed = false;
	private leftPressActive = false;
	private readonly expanded = new Set<string>();
	private readonly previews = new Map<string, { fingerprint: string; view: ChangesView }>();

	constructor(trees: WorktreeChanges[], deps: WorktreeChangesViewDeps) {
		this.trees = trees;
		this.deps = deps;
	}

	private visibleRows(): WorktreeRow[] {
		return this.trees.flatMap((tree) => [{ tree }, ...(this.expanded.has(tree.root) ? tree.model.files.map((file) => ({ tree, file })) : [])]);
	}

	update(trees: WorktreeChanges[]): void {
		this.leftPressActive = false;
		if (this.disposed) return;
		this.pointerLayout = undefined;
		const before = this.visibleRows()[this.selected];
		this.trees = trees;
		for (const root of this.expanded) if (!trees.some((tree) => tree.root === root)) this.expanded.delete(root);
		const files = new Map(trees.flatMap((tree) => tree.model.files.map((file) => [rowKey({ tree, file }), fingerprint(file)])));
		for (const [key, preview] of this.previews) {
			if (files.get(key) !== preview.fingerprint) {
				preview.view.dispose();
				this.previews.delete(key);
			}
		}
		const rows = this.visibleRows();
		let index = before ? rows.findIndex((row) => rowKey(row) === rowKey(before)) : -1;
		if (index < 0 && before) index = rows.findIndex((row) => row.tree.root === before.tree.root);
		this.selected = index < 0 ? Math.max(0, Math.min(this.selected, rows.length - 1)) : index;
		this.ensurePreview();
		this.deps.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (data === "r") return this.deps.onRefresh();
		if (matchesKey(data, Key.escape) || data === "q") return this.deps.onClose();
		const rows = this.visibleRows();
		const row = rows[this.selected];
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("j")) || matchesKey(data, Key.ctrl("k"))) {
			if (row?.file) this.previews.get(rowKey(row))?.view.handleInput(data);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.max(0, Math.min(rows.length - 1, this.selected + 1));
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (row && (matchesKey(data, Key.left) || matchesKey(data, Key.backspace))) {
			if (row.file) this.selected = rows.findIndex((item) => item.tree.root === row.tree.root && !item.file);
			else this.expanded.delete(row.tree.root);
		} else if (row && !row.file && (matchesKey(data, Key.enter) || data === " " || matchesKey(data, Key.right))) {
			if (this.expanded.has(row.tree.root)) this.expanded.delete(row.tree.root);
			else this.expanded.add(row.tree.root);
		} else if (row?.file && (data === "o" || matchesKey(data, Key.enter))) this.deps.onOpen(row.tree.root, row.file);
		this.ensureSelectedVisible();
		this.ensurePreview();
		this.deps.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed) return { handled: true, render: false };
		if (event.type === "release") {
			if (this.leftPressActive && (event.button === "left" || event.button === "none")) {
				this.leftPressActive = false;
				return { handled: true, render: false };
			}
			return undefined;
		}
		if (event.type === "press" && event.button !== "left") return undefined;
		const layout = this.pointerLayout;
		if (!layout || event.width !== layout.width || event.height !== layout.height) return { handled: true, render: false };
		const inBody = event.y >= 1 && event.y <= layout.bodyRows;
		const inFiles = inBody && event.x >= layout.listStart && event.x < layout.listEnd;
		const inDiff = inBody && event.x >= layout.diffStart && event.x < layout.diffEnd;
		if (event.type === "wheel") {
			if (inFiles) return { handled: true, render: this.scrollList(event.wheelDelta ?? 0, layout.bodyRows) };
			if (inDiff) {
				const row = this.visibleRows()[this.selected];
				return { handled: true, render: row?.file ? Boolean(this.previews.get(rowKey(row))?.view.scrollDiffBy(event.wheelDelta ?? 0, layout.bodyRows)) : false };
			}
			return undefined;
		}
		if (!inFiles) return undefined;
		if (event.type === "press") {
			if (event.button !== "left") return undefined;
			this.leftPressActive = true;
			return { handled: true, capture: true, render: false };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const index = this.listOffset + event.y - 1;
		if (index < 0 || index >= this.visibleRows().length) return { handled: true, render: false };
		const changed = index !== this.selected;
		this.selected = index;
		this.ensurePreview();
		this.deps.requestRender();
		return { handled: true, render: changed };
	}

	render(width: number): string[] {
		const theme = this.deps.theme;
		const rows = this.visibleRows();
		const height = this.bodyRows();
		this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, rows.length - height)));
		const selected = rows[this.selected];
		const preview = selected?.file ? this.previews.get(rowKey(selected))?.view.previewLines() ?? [] : [selected ? displayText(selected.tree.root) : "No dirty worktrees.", selected ? changesSummary(selected.tree.model) : "", selected ? "Expand a group and select a file." : ""];
		const leftLine = (index: number) => {
			const row = rows[index + this.listOffset];
			if (!row) return "";
			const active = index + this.listOffset === this.selected;
			const marker = active ? theme.fg(ROLE.SELECTED, "▸") : " ";
			const text = row.file ? `  ${fileLabel(row.file, theme, active ? ROLE.SELECTED : ROLE.PATH_IDLE)}` : theme.fg(active ? ROLE.SELECTED : ROLE.PATH_IDLE, `${this.expanded.has(row.tree.root) ? "▾" : "▸"} ${displayText(row.tree.branch ?? "detached")} · ${displayText(basename(row.tree.root))}`);
			return `${marker} ${text}`;
		};
		const keys = theme.fg(ROLE.KEY_TEXT, "j/k select   enter toggle/open   ← parent/fold   ctrl+j/k scroll   r refresh   esc close");
		this.pointerLayout = pointerLayout(width, height);
		return renderPanes(width, height, theme, `✎ Changes · ${this.trees.length} worktrees`, leftLine, preview, keys);
	}

	invalidate(): void {
		this.leftPressActive = false;
		this.pointerLayout = undefined;
		for (const preview of this.previews.values()) preview.view.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.leftPressActive = false;
		this.pointerLayout = undefined;
		for (const preview of this.previews.values()) preview.view.dispose();
		this.previews.clear();
	}

	private bodyRows(): number {
		const rows = typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows;
		return Math.max(MIN_BODY_ROWS, rows - CHROME_ROWS);
	}

	private scrollList(delta: number, rows: number): boolean {
		const next = Math.max(0, Math.min(Math.max(0, this.visibleRows().length - rows), this.listOffset + Math.trunc(delta)));
		if (next === this.listOffset) return false;
		this.listOffset = next;
		return true;
	}

	private ensureSelectedVisible(): void {
		const height = this.bodyRows();
		if (this.selected < this.listOffset) this.listOffset = this.selected;
		else if (this.selected >= this.listOffset + height) this.listOffset = this.selected - height + 1;
		this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, this.visibleRows().length - height)));
	}

	private ensurePreview(): void {
		const row = this.visibleRows()[this.selected];
		if (!row?.file || this.previews.has(rowKey(row))) return;
		const { tree, file } = row;
		this.previews.set(rowKey(row), {
			fingerprint: fingerprint(file),
			view: new ChangesView({ files: [file], added: file.added, deleted: file.deleted }, {
				...this.deps,
				rows: () => typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows,
				loadDiff: (target) => this.deps.loadDiff(tree.root, target),
				onOpen: (target) => this.deps.onOpen(tree.root, target),
			}),
		});
	}
}

export class ChangesView {
	private model: ChangesModel;
	private readonly deps: ChangesViewDeps;
	private selected = 0;
	private fileScroll = 0;
	private diffScroll = 0;
	private pointerLayout: PointerLayout | undefined;
	private disposed = false;
	private leftPressActive = false;
	private readonly diffs = new Map<string, string[]>();

	constructor(model: ChangesModel, deps: ChangesViewDeps) {
		this.model = model;
		this.deps = deps;
		this.loadSelected();
	}

	// Replace the model while open: keep the selection by path and drop cached
	// diffs for files whose counts moved so they reload.
	update(model: ChangesModel): void {
		this.leftPressActive = false;
		if (this.disposed) return;
		this.pointerLayout = undefined;
		const selectedPath = this.model.files[this.selected]?.path;
		const before = new Map(this.model.files.map((file) => [file.path, fingerprint(file)]));
		for (const file of model.files) {
			if (before.get(file.path) !== fingerprint(file)) this.diffs.delete(file.path);
		}
		for (const path of this.diffs.keys()) {
			if (!model.files.some((file) => file.path === path)) this.diffs.delete(path);
		}
		this.model = model;
		const index = model.files.findIndex((file) => file.path === selectedPath);
		const selectionChanged = index === -1;
		this.selected = selectionChanged ? Math.max(0, Math.min(this.selected, model.files.length - 1)) : index;
		this.fileScroll = this.clampFileScroll(this.fileScroll, this.bodyRows());
		if (selectionChanged) this.ensureSelectedVisible();
		this.loadSelected();
		this.deps.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.leftPressActive = false;
		this.pointerLayout = undefined;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.escape) || data === "q") {
			this.deps.onClose();
			return;
		}
		// ctrl+j arrives as a bare line feed, which pi also reads as enter, so
		// the scroll keys are checked before the open key; a real Enter is CR.
		if (data === "j" || matchesKey(data, Key.down)) this.select(this.selected + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.select(this.selected - 1);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("j"))) this.scrollBy(this.bodyRows());
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("k"))) this.scrollBy(-this.bodyRows());
		else if (data === "o" || matchesKey(data, Key.enter)) {
			const file = this.model.files[this.selected];
			if (file) this.deps.onOpen(file);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed) return { handled: true, render: false };
		if (event.type === "release") {
			if (this.leftPressActive && (event.button === "left" || event.button === "none")) {
				this.leftPressActive = false;
				return { handled: true, render: false };
			}
			return undefined;
		}
		if (event.type === "press" && event.button !== "left") return undefined;
		const layout = this.pointerLayout;
		if (!layout || event.width !== layout.width || event.height !== layout.height) return { handled: true, render: false };
		const inBody = event.y >= 1 && event.y <= layout.bodyRows;
		const inFiles = inBody && event.x >= layout.listStart && event.x < layout.listEnd;
		const inDiff = inBody && event.x >= layout.diffStart && event.x < layout.diffEnd;
		if (event.type === "wheel") {
			if (inFiles) return { handled: true, render: this.scrollFiles(event.wheelDelta ?? 0, layout.bodyRows) };
			if (inDiff) return { handled: true, render: this.scrollDiff(event.wheelDelta ?? 0, layout.bodyRows) };
			return undefined;
		}
		if (!inFiles) return undefined;
		if (event.type === "press") {
			if (event.button !== "left") return undefined;
			this.leftPressActive = true;
			return { handled: true, capture: true, render: false };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const index = this.fileScroll + event.y - 1;
		if (index < 0 || index >= this.model.files.length) return { handled: true, render: false };
		const changed = index !== this.selected;
		this.select(index);
		return { handled: true, render: changed };
	}

	render(width: number): string[] {
		const theme = this.deps.theme;
		const rows = this.bodyRows();
		this.fileScroll = this.clampFileScroll(this.fileScroll, rows);
		const keys = KEYS.map(([key, label]) => `${theme.fg(ROLE.KEY, key)} ${theme.fg(ROLE.KEY_TEXT, key === "esc" ? (this.deps.backLabel ?? label) : label)}`).join("   ");
		this.pointerLayout = pointerLayout(width, rows);
		return renderPanes(width, rows, theme, `✎ Changes · ${changesSummary(this.model)}`, (row) => this.fileLine(row), this.visibleDiff(rows), keys);
	}

	invalidate(): void {
		this.leftPressActive = false;
		this.pointerLayout = undefined;
	}

	previewLines(): string[] {
		return this.visibleDiff(this.bodyRows());
	}

	private bodyRows(): number {
		const rows = typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows;
		return Math.max(MIN_BODY_ROWS, rows - CHROME_ROWS);
	}

	private fileLine(row: number): string {
		const index = this.fileScroll + row;
		const file = this.model.files[index];
		if (!file) return "";
		const theme = this.deps.theme;
		const marker = index === this.selected ? theme.fg(ROLE.SELECTED, "▸") : " ";
		return `${marker} ${fileLabel(file, theme, index === this.selected ? ROLE.PATH : ROLE.PATH_IDLE)}`;
	}

	private visibleDiff(rows: number): string[] {
		const file = this.model.files[this.selected];
		if (!file) return [this.deps.theme.fg(ROLE.EMPTY, CLEAN_TREE)];
		const lines = this.diffs.get(file.path);
		if (!lines) return [];
		if (lines.length === 0) return [this.deps.theme.fg(ROLE.EMPTY, EMPTY_DIFF)];
		this.diffScroll = Math.min(this.diffScroll, Math.max(0, lines.length - rows));
		return lines.slice(this.diffScroll, this.diffScroll + rows);
	}

	private select(index: number): void {
		const next = Math.max(0, Math.min(this.model.files.length - 1, index));
		if (next === this.selected) return;
		this.selected = next;
		this.diffScroll = 0;
		this.ensureSelectedVisible();
		this.loadSelected();
		this.deps.requestRender();
	}

	private scrollBy(delta: number): void {
		this.scrollDiffBy(delta, this.bodyRows());
		this.deps.requestRender();
	}

	scrollDiffBy(delta: number, rows = this.bodyRows()): boolean {
		return this.scrollDiff(delta, rows);
	}

	private scrollFiles(delta: number, rows: number): boolean {
		const next = this.clampFileScroll(this.fileScroll + Math.trunc(delta), rows);
		if (next === this.fileScroll) return false;
		this.fileScroll = next;
		return true;
	}

	private scrollDiff(delta: number, rows: number): boolean {
		const file = this.model.files[this.selected];
		const lines = file ? this.diffs.get(file.path) : undefined;
		if (!lines) return false;
		const next = Math.max(0, Math.min(Math.max(0, lines.length - rows), this.diffScroll + Math.trunc(delta)));
		if (next === this.diffScroll) return false;
		this.diffScroll = next;
		return true;
	}

	private clampFileScroll(scroll: number, rows: number): number {
		return Math.max(0, Math.min(Math.max(0, this.model.files.length - rows), scroll));
	}

	private ensureSelectedVisible(): void {
		const rows = this.bodyRows();
		if (this.selected < this.fileScroll) this.fileScroll = this.selected;
		else if (this.selected >= this.fileScroll + rows) this.fileScroll = this.selected - rows + 1;
		this.fileScroll = this.clampFileScroll(this.fileScroll, rows);
	}

	private loadSelected(): void {
		const file = this.model.files[this.selected];
		if (!file || this.diffs.has(file.path)) return;
		void this.deps.loadDiff(file).then(
			(text) => {
				if (this.disposed) return;
				this.diffs.set(file.path, colorDiff(text, this.deps.theme));
				this.deps.requestRender();
			},
			() => {
				if (this.disposed) return;
				this.diffs.set(file.path, []);
				this.deps.requestRender();
			},
		);
	}
}
