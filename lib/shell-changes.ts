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
// One selected file's diff is the only bounded thing in Changes: past either
// limit the panel shows DIFF_TOO_LARGE instead of buffering and coloring it.
export const DIFF_MAX_BYTES = 1024 * 1024;
export const DIFF_MAX_LINES = 20_000;
export const DIFF_TOO_LARGE = "Diff too large — press o to open in editor.";
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
		// A trailing "/" is Git's own marker for an embedded repository (a
		// nested .git directory, e.g. an inner repo inside an outer one) or an
		// excluded directory -- never an individual file. Even with
		// --untracked-files=all, Git reports these as one directory-shaped line
		// instead of expanding into files, so keeping it would show a phantom
		// changed "file" on whatever ancestor repository contains the nested one.
		if (!path.endsWith("/")) statuses.set(path, STATUS_BY_CODE[code[0]] ?? STATUS_BY_CODE[code[1]] ?? CHANGE_STATUS.MODIFIED);
		if (code[0] === "R" || code[0] === "C") index += 1;
	}
	return statuses;
}

export function snapshotChanges(snapshot: ChangesSnapshot): ChangedFile[] {
	const counts = new Map(parseNumstat(snapshot.numstat).map((entry) => [entry.path, entry]));
	const files: ChangedFile[] = [];
	for (const [path, status] of parsePorcelain(snapshot.porcelain)) {
		// Dependency backups are local artifacts; tracked files remain visible.
		if (status === CHANGE_STATUS.UNTRACKED && /(?:^|\/)node_modules\.backup-[^/]+\//.test(path)) continue;
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
	return `${model.files.length} ${noun} · +${model.added} −${model.deleted}${model.files.some(file => file.countsUnavailable) ? " · partial counts" : ""}`;
}

// One line: summary, the files joined by dots, and the command pushed to
// the right edge. The file list goes first when the terminal is narrow.
export function renderChangesWidget(model: ChangesModel, theme: ChangesTheme, width: number): string[] {
	if (model.files.length === 0) return [];
	const noun = model.files.length === 1 ? "file" : "files";
	const dot = theme.fg("muted", "·");
	const head = `${theme.fg("accent", WIDGET_GLYPH)} ${theme.fg("text", `${model.files.length} ${noun}`)} ${dot} ${theme.fg("success", `+${model.added}`)} ${theme.fg("error", `−${model.deleted}`)}${model.files.some(file => file.countsUnavailable) ? " · partial counts" : ""}`;
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
	/** The runner stopped reading at its output bound; stdout is partial. */
	truncated?: boolean;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;
export type LineCounter = (path: string) => Promise<number>;
/** A cheap content identity (e.g. size and mtime) so same-count edits refresh their diff. */
export type FileRevision = (path: string) => Promise<string | undefined>;

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

// A root the view shows as-is when its own HEAD could not be determined at
// all -- distinct from "detached", which means git answered and there really
// is no branch. Exported so callers and tests share one literal.
export const UNKNOWN_BRANCH = "unknown";

// Resolve a foreign clone's own HEAD directly instead of assuming "detached":
// a real branch name, "no commits yet" for an unborn branch (a branch ref
// that exists but has no commit), or undefined for a genuine detached HEAD
// (the caller falls back to "detached" in that case). A GitRunner that
// cannot even ask -- it rejects, e.g. because the root was removed or git
// itself is unavailable -- rejects here too, on purpose: that is a real
// failure to distinguish from git successfully reporting "no branch", and
// callers must not fold the two into the same undefined result.
export async function foreignRootBranch(git: GitRunner): Promise<string | undefined> {
	const symbolic = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = symbolic.code === 0 ? symbolic.stdout.trim() : "";
	if (!branch) return undefined;
	const verified = await git(["rev-parse", "--verify", "-q", "HEAD"]);
	return verified.code === 0 ? branch : "no commits yet";
}

// /gentle:changes: one group per registered root holding its working tree
// against HEAD. A root whose Git fails (timed out, rejected) has no group but
// is listed in failedRoots: a failed scan is never reported as a clean root.
export class WorktreeChangesTracker {
	worktrees: WorktreeChanges[] = [];
	failedRoots: string[] = [];
	scannedRootCount = 0;
	private inFlight: Promise<ChangesModel> | undefined;
	private readonly discover: GitRunner;
	private readonly gitForRoot: (root: string) => GitRunner;
	private readonly linesForRoot: (root: string) => LineCounter;
	private readonly registeredRoots: () => readonly string[];
	private readonly revisionForRoot: (root: string) => FileRevision | undefined;

	constructor(discover: GitRunner, gitForRoot: (root: string) => GitRunner, linesForRoot: (root: string) => LineCounter = () => noLines, registeredRoots: () => readonly string[] = () => [], revisionForRoot: (root: string) => FileRevision | undefined = () => undefined) {
		this.discover = discover;
		this.gitForRoot = gitForRoot;
		this.linesForRoot = linesForRoot;
		this.registeredRoots = registeredRoots;
		this.revisionForRoot = revisionForRoot;
	}

	private modelOf: WorktreeChanges[] | undefined;
	private combined: ChangesModel = emptyChanges();

	// Footers read this every frame; rebuild only when a scan replaced the trees.
	get model(): ChangesModel {
		if (this.modelOf !== this.worktrees) {
			this.modelOf = this.worktrees;
			this.combined = changesModel(this.worktrees.flatMap((tree) => tree.model.files.map((file) => ({
				...file,
				path: this.worktrees.length === 1 ? file.path : `${tree.root}/${file.path}`,
			}))));
		}
		return this.combined;
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
		// Discovery labels registered roots; it never grants visibility to siblings.
		const roots = new Set(this.registeredRoots());
		// No root to scan means no Git at all, not even branch discovery.
		if (roots.size === 0) {
			this.worktrees = [];
			this.failedRoots = [];
			this.scannedRootCount = 0;
			return this.model;
		}
		const result = await this.discover(["worktree", "list", "--porcelain", "-z"]).catch(() => ({ code: 128, stdout: "" }));
		const metadata = new Map((result.code === 0 ? parseWorktrees(result.stdout) : []).map((tree) => [tree.root, tree]));
		// Roots scan in parallel so one slow root does not delay the others.
		const failed: string[] = [];
		const scanned = await Promise.all([...roots].map(async (root): Promise<WorktreeChanges | undefined> => {
			const known = metadata.get(root);
			try {
				const tracker = new ChangesTracker(this.gitForRoot(root), this.linesForRoot(root), this.revisionForRoot(root));
				await tracker.start();
				if (!tracker.statusRead) {
					failed.push(root);
					return undefined;
				}
				if (!tracker.model.files.length) return undefined;
				// A root missing from this discovery scan belongs to a different Git
				// clone entirely (e.g. an inner repository nested inside an outer
				// one) -- worktree list can never describe a foreign clone, so ask
				// it directly instead of defaulting to "detached". A root the scan
				// DID describe is trusted as-is: its own "detached" marker (or lack
				// of a branch) is already accurate for that clone. The direct ask
				// can fail on its own (root gone, git unavailable) without the
				// change scan above failing -- that must label the root
				// UNKNOWN_BRANCH, not drop real, already-captured changes.
				const branch = known ? known.branch : await foreignRootBranch(this.gitForRoot(root)).catch(() => UNKNOWN_BRANCH);
				return { root, ...(branch ? { branch } : {}), model: tracker.model };
			} catch {
				// A root the caller stops registering mid-scan (e.g. a removed
				// worktree) triggers the rescan below without it, not a failure.
				failed.push(root);
				return undefined;
			}
		}));
		const trees = scanned.filter((tree): tree is WorktreeChanges => tree !== undefined);
		const latest = new Set(this.registeredRoots());
		// A root admitted during status must not wait for a later poll (which may
		// be disabled). Ordinary overlapping polls still share exactly one scan.
		if (latest.size !== roots.size || [...latest].some((root) => !roots.has(root))) return this.capture();
		this.worktrees = trees;
		this.failedRoots = failed;
		this.scannedRootCount = roots.size;
		return this.model;
	}
}

const noLines: LineCounter = async () => 0;

// Per-file line counts and revision lookups are file IO: a large change set
// runs this many files at a time instead of one by one or all at once.
export const FILE_WORK_CONCURRENCY = 8;

async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await work(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const NUMSTAT_ARGS = ["diff", "--numstat", "HEAD"];
const PORCELAIN_ARGS = ["status", "--porcelain=v1", "--untracked-files=all", "-z"];

// Tracks working-tree changes. Concurrent refreshes coalesce: one git
// round-trip runs at a time and a refresh requested meanwhile triggers
// exactly one more.
export class ChangesTracker {
	private readonly git: GitRunner;
	private readonly countLines: LineCounter;
	private readonly revision: FileRevision | undefined;
	private current: ChangesModel = emptyChanges();
	private available = false;
	private inFlight: Promise<ChangesModel> | undefined;
	private queued = false;

	constructor(git: GitRunner, countLines: LineCounter = noLines, revision?: FileRevision) {
		this.git = git;
		this.countLines = countLines;
		this.revision = revision;
	}

	get model(): ChangesModel {
		return this.current;
	}

	/** False when the last start could not read `git status`. */
	get statusRead(): boolean {
		return this.available;
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
		await eachLimited(files, FILE_WORK_CONCURRENCY, async (file) => {
			const [added, revision] = await Promise.all([
				file.status === CHANGE_STATUS.UNTRACKED ? this.countLines(file.path).catch(() => 0) : undefined,
				this.revision?.(file.path).catch(() => undefined),
			]);
			if (added !== undefined) file.added = added;
			if (revision) file.diffRevision = revision;
		});
		return files;
	}
}
