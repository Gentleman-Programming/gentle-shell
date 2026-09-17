import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Gentle Shell changes: the working tree against HEAD, new files included.
// Git is the source of truth; this module turns raw `git diff --numstat` and
// `git status --porcelain -z` output into a model and renders the widget.

export const CHANGE_STATUS = {
	MODIFIED: "modified",
	ADDED: "added",
	DELETED: "deleted",
	RENAMED: "renamed",
	UNTRACKED: "untracked",
} as const;

export type ChangeStatus = (typeof CHANGE_STATUS)[keyof typeof CHANGE_STATUS];

export interface ChangedFile {
	path: string;
	added: number;
	deleted: number;
	status: ChangeStatus;
	countsUnavailable?: string;
	diffRevision?: string;
}

export interface ChangesModel {
	files: ChangedFile[];
	added: number;
	deleted: number;
	notice?: string;
}

export interface ChangesSnapshot {
	numstat: string;
	porcelain: string;
}

export interface ChangesTheme {
	fg(color: string, text: string): string;
}

interface NumstatEntry {
	path: string;
	added: number;
	deleted: number;
}

export const CHANGES_COMMAND = "/gentle:changes";
const WIDGET_GLYPH = "✎";
const STATUS_BY_CODE: Record<string, ChangeStatus> = {
	A: CHANGE_STATUS.ADDED,
	D: CHANGE_STATUS.DELETED,
	R: CHANGE_STATUS.RENAMED,
	C: CHANGE_STATUS.ADDED,
	"?": CHANGE_STATUS.UNTRACKED,
};
const RENAME_BRACES = /\{([^{}]*) => ([^{}]*)\}/g;
const HAS_RENAME_BRACES = /\{[^{}]* => [^{}]*\}/;
const RENAME_ARROW = " => ";

export function emptyChanges(): ChangesModel {
	return { files: [], added: 0, deleted: 0 };
}

function renamedPath(path: string): string {
	if (HAS_RENAME_BRACES.test(path)) return path.replace(RENAME_BRACES, "$2").replace(/\/\//g, "/");
	const arrow = path.indexOf(RENAME_ARROW);
	return arrow === -1 ? path : path.slice(arrow + RENAME_ARROW.length);
}

function count(value: string): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function parseNumstat(text: string): NumstatEntry[] {
	const entries: NumstatEntry[] = [];
	for (const line of text.split("\n")) {
		const [added, deleted, ...rest] = line.split("\t");
		if (added === undefined || deleted === undefined || rest.length === 0) continue;
		entries.push({ path: renamedPath(rest.join("\t")), added: count(added), deleted: count(deleted) });
	}
	return entries;
}

export function parsePorcelain(text: string): Map<string, ChangeStatus> {
	const statuses = new Map<string, ChangeStatus>();
	const records = text.split("\0").filter((record) => record.length > 0);
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		const code = record.slice(0, 2);
		const path = record.slice(3);
		const status = STATUS_BY_CODE[code[0]] ?? STATUS_BY_CODE[code[1]] ?? CHANGE_STATUS.MODIFIED;
		statuses.set(path, status);
		if (code[0] === "R" || code[0] === "C") index += 1;
	}
	return statuses;
}

export function snapshotChanges(snapshot: ChangesSnapshot): ChangedFile[] {
	const counts = new Map(parseNumstat(snapshot.numstat).map((entry) => [entry.path, entry]));
	const files: ChangedFile[] = [];
	for (const [path, status] of parsePorcelain(snapshot.porcelain)) {
		const entry = counts.get(path);
		files.push({ path, added: entry?.added ?? 0, deleted: entry?.deleted ?? 0, status });
	}
	return files;
}

export function changesModel(changed: ChangedFile[]): ChangesModel {
	const files = [...changed].sort((a, b) => a.path.localeCompare(b.path));
	return {
		files,
		added: files.reduce((total, file) => total + file.added, 0),
		deleted: files.reduce((total, file) => total + file.deleted, 0),
	};
}

export function changesSummary(model: ChangesModel): string {
	const noun = model.files.length === 1 ? "file" : "files";
	return `${model.files.length} ${noun} · +${model.added} −${model.deleted}${model.files.some(file => file.countsUnavailable) ? " · partial counts" : ""}${model.notice ? " · capture limit reached" : ""}`;
}

// One line: summary, the files joined by dots, and the command pushed to
// the right edge. The file list goes first when the terminal is narrow.
export function renderChangesWidget(model: ChangesModel, theme: ChangesTheme, width: number): string[] {
	if (model.files.length === 0) return [];
	const noun = model.files.length === 1 ? "file" : "files";
	const dot = theme.fg("muted", "·");
	const head = `${theme.fg("accent", WIDGET_GLYPH)} ${theme.fg("text", `${model.files.length} ${noun}`)} ${dot} ${theme.fg("success", `+${model.added}`)} ${theme.fg("error", `−${model.deleted}`)}${model.files.some(file => file.countsUnavailable) ? " · partial counts" : ""}${model.notice ? ` ${dot} ${theme.fg("warning", "capture limit reached")}` : ""}`;
	const hint = theme.fg("dim", CHANGES_COMMAND);
	const list = model.files.map((file) => theme.fg("muted", file.path)).join(` ${dot} `);
	const left = `${head} ${dot} ${list}`;
	const gap = width - visibleWidth(left) - visibleWidth(hint);
	if (gap >= 2) return [`${left}${" ".repeat(gap)}${hint}`];
	const headGap = width - visibleWidth(head) - visibleWidth(hint);
	if (headGap >= 2) return [`${head}${" ".repeat(headGap)}${hint}`];
	return [truncateToWidth(head, width, "…")];
}

export interface GitResult {
	stdout: string;
	code: number;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;
export type LineCounter = (path: string) => Promise<number>;

export interface WorktreeChanges {
	root: string;
	branch?: string;
	model: ChangesModel;
}

// -z avoids Git's quoting of paths containing whitespace or newlines.
export function parseWorktrees(text: string): Array<{ root: string; branch?: string }> {
	return text.split("\0\0").flatMap((record) => {
		const fields = record.split("\0");
		const root = fields.find((field) => field.startsWith("worktree "))?.slice(9);
		if (!root || fields.some((field) => field === "bare" || field.startsWith("prunable"))) return [];
		const branch = fields.find((field) => field.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
		return [branch ? { root, branch } : { root }];
	});
}

export class WorktreeChangesTracker {
	worktrees: WorktreeChanges[] = [];
	private inFlight: Promise<ChangesModel> | undefined;
	private readonly discover: GitRunner;
	private readonly gitForRoot: (root: string) => GitRunner;
	private readonly linesForRoot: (root: string) => LineCounter;
	private readonly registeredRoots: () => readonly string[];

	constructor(discover: GitRunner, gitForRoot: (root: string) => GitRunner, linesForRoot: (root: string) => LineCounter = () => noLines, registeredRoots: () => readonly string[] = () => []) {
		this.discover = discover;
		this.gitForRoot = gitForRoot;
		this.linesForRoot = linesForRoot;
		this.registeredRoots = registeredRoots;
	}

	get model(): ChangesModel {
		return changesModel(this.worktrees.flatMap((tree) => tree.model.files.map((file) => ({
			...file,
			path: this.worktrees.length === 1 ? file.path : `${tree.root}/${file.path}`,
		}))));
	}

	async start(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<ChangesModel> {
		// A scan can take longer than the polling interval in a large clone.
		// Share it rather than extending it indefinitely with queued polls.
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.capture();
		try {
			return await this.inFlight;
		} finally {
			this.inFlight = undefined;
		}
	}

	private async capture(): Promise<ChangesModel> {
		const result = await this.discover(["worktree", "list", "--porcelain", "-z"]).catch(() => ({ code: 128, stdout: "" }));
		const trees: WorktreeChanges[] = [];
		const metadata = new Map((result.code === 0 ? parseWorktrees(result.stdout) : []).map((tree) => [tree.root, tree]));
		// Discovery labels registered roots; it never grants visibility to siblings.
		const roots = new Set(this.registeredRoots());
		for (const root of roots) {
			const tree = metadata.get(root) ?? { root };
			try {
				const tracker = new ChangesTracker(this.gitForRoot(tree.root), this.linesForRoot(tree.root));
				await tracker.start();
				if (tracker.model.files.length) trees.push({ ...tree, model: tracker.model });
			} catch {
				// Linked roots can disappear between discovery and status.
			}
		}
		const latest = new Set(this.registeredRoots());
		// A root admitted during status must not wait for a later poll (which may
		// be disabled). Ordinary overlapping polls still share exactly one scan.
		if (latest.size !== roots.size || [...latest].some((root) => !roots.has(root))) return this.capture();
		this.worktrees = trees;
		return this.model;
	}
}

const noLines: LineCounter = async () => 0;

const NUMSTAT_ARGS = ["diff", "--numstat", "HEAD"];
const PORCELAIN_ARGS = ["status", "--porcelain=v1", "--untracked-files=all", "-z"];

// Tracks working-tree changes. Concurrent refreshes coalesce: one git
// round-trip runs at a time and a refresh requested meanwhile triggers
// exactly one more.
export class ChangesTracker {
	private readonly git: GitRunner;
	private readonly countLines: LineCounter;
	private current: ChangesModel = emptyChanges();
	private available = false;
	private inFlight: Promise<ChangesModel> | undefined;
	private queued = false;

	constructor(git: GitRunner, countLines: LineCounter = noLines) {
		this.git = git;
		this.countLines = countLines;
	}

	get model(): ChangesModel {
		return this.current;
	}

	async start(): Promise<void> {
		const files = await this.capture();
		this.available = files !== undefined;
		this.current = files ? changesModel(files) : emptyChanges();
	}

	async refresh(): Promise<ChangesModel> {
		if (!this.available) return this.current;
		if (this.inFlight) {
			this.queued = true;
			return this.inFlight;
		}
		this.inFlight = this.runRefresh();
		try {
			return await this.inFlight;
		} finally {
			this.inFlight = undefined;
		}
	}

	private async runRefresh(): Promise<ChangesModel> {
		do {
			this.queued = false;
			const files = await this.capture();
			if (files) this.current = changesModel(files);
		} while (this.queued);
		return this.current;
	}

	private async capture(): Promise<ChangedFile[] | undefined> {
		const [numstat, porcelain] = await Promise.all([this.git(NUMSTAT_ARGS), this.git(PORCELAIN_ARGS)]);
		if (porcelain.code !== 0) return undefined;
		const files = snapshotChanges({ numstat: numstat.stdout, porcelain: porcelain.stdout });
		// Untracked files never appear in numstat; count their lines directly.
		for (const file of files) {
			if (file.status === CHANGE_STATUS.UNTRACKED) file.added = await this.countLines(file.path).catch(() => 0);
		}
		return files;
	}
}
