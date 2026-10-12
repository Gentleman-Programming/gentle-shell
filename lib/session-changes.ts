import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { changesModel, type ChangedFile, type GitRunner, type WorktreeChanges } from "./shell-changes.ts";

export const SESSION_CHANGE_ENTRY = "gentle-pi.session-change/v1";
export const SESSION_CHANGE_EVENT = "gentle-pi:session-change";
export const SESSION_CHANGE_RELAY = "gentle-pi:child-session-change";
export const MAX_CHANGE_BYTES = 64 * 1024;
const MAX_RECORDS = 256;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 2000;
export type ChangeSnapshot = { kind: "text"; text: string } | { kind: "absent" } | { kind: "unavailable"; reason: string };
export interface SessionChangeEvidence {
	id: string;
	root: string;
	path: string;
	before: ChangeSnapshot;
	after: ChangeSnapshot;
}
type Entry = { type?: string; customType?: string; data?: unknown };
interface FileState { before: ChangeSnapshot; after: ChangeSnapshot; unavailable?: string; diff?: string }

const unavailable = (reason: string): ChangeSnapshot => ({ kind: "unavailable", reason });
export function textSnapshot(text: string): ChangeSnapshot {
	if (Buffer.byteLength(text) > MAX_CHANGE_BYTES || text.split("\n", MAX_LINES + 1).length > MAX_LINES) return unavailable("File exceeds the session diff limit.");
	if (text.includes("\0")) return unavailable("Binary file; line counts unavailable.");
	return { kind: "text", text };
}

/** Read only the named mutation target. Never traverse, follow symlinks, or open a FIFO for blocking I/O. */
export async function readChangeSnapshot(path: string): Promise<ChangeSnapshot> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_CHANGE_BYTES) return unavailable("Nonregular or large file; diff unavailable.");
		const buffer = Buffer.alloc(MAX_CHANGE_BYTES + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== stat.size) return unavailable("File changed while its snapshot was being read.");
		return textSnapshot(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : unavailable("Snapshot unavailable.");
	} finally { await file?.close().catch(() => {}); }
}

function validSnapshot(value: unknown): value is ChangeSnapshot {
	if (!value || typeof value !== "object") return false;
	const v = value as ChangeSnapshot;
	return v.kind === "absent" || (v.kind === "text" && typeof v.text === "string" && textSnapshot(v.text).kind === "text") ||
		(v.kind === "unavailable" && typeof v.reason === "string" && v.reason.length <= 200);
}
export function isSessionChangeEvidence(value: unknown): value is SessionChangeEvidence {
	if (!value || typeof value !== "object") return false;
	const v = value as SessionChangeEvidence;
	return typeof v.id === "string" && v.id.length > 0 && v.id.length <= 256 &&
		typeof v.root === "string" && isAbsolute(v.root) && v.root.length <= 4096 &&
		typeof v.path === "string" && v.path.length > 0 && v.path.length <= 4096 &&
		!isAbsolute(v.path) && !/[\0\r\n]/.test(v.root + v.path) &&
		!v.path.split(/[\\/]/).some(part => part === ".." || part === ".git") &&
		validSnapshot(v.before) && validSnapshot(v.after);
}
export const sameSnapshot = (a: ChangeSnapshot, b: ChangeSnapshot): boolean =>
	a.kind === b.kind && (a.kind === "absent" || (a.kind === "text" && b.kind === "text" && a.text === b.text));
const snapshotText = (value: ChangeSnapshot) => value.kind === "text" ? value.text : "";
const shown = (state: FileState) => Boolean(state.unavailable) || !sameSnapshot(state.before, state.after);
const gitPath = (path: string) => path.replace(/\\/g, "/");

/** Paths Git still reports as differing from HEAD, including both names of a rename or copy. */
function porcelainPaths(stdout: string): Set<string> {
	const records = stdout.split("\0");
	const paths = new Set<string>();
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.length < 4) continue;
		paths.add(record.slice(3));
		if (/[RC]/.test(record.slice(0, 2)) && i + 1 < records.length) paths.add(records[++i]);
	}
	return paths;
}

export class SessionChanges {
	private readonly seen = new Set<string>();
	private readonly files = new Map<string, Map<string, FileState>>();
	private bytes = 0;
	private announced = false;
	notice: string | undefined;
	readonly sessionId: string;
	private cached: WorktreeChanges[] | undefined;
	/** Captured entries Git last saw matching HEAD; hidden, never discarded. */
	private readonly settled = new Map<string, Set<string>>();
	private reconciling: Promise<void> | undefined;
	constructor(sessionId: string, entries: readonly Entry[] = []) { this.sessionId = sessionId; this.restore(entries); }

	restore(entries: readonly Entry[]): void {
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SESSION_CHANGE_ENTRY) continue;
			const data = entry.data as { sessionId?: string; evidence?: unknown } | undefined;
			if (data?.sessionId === this.sessionId && isSessionChangeEvidence(data.evidence)) this.record(data.evidence);
		}
	}
	record(evidence: SessionChangeEvidence): boolean {
		if (!isSessionChangeEvidence(evidence) || this.seen.has(evidence.id)) return false;
		const bytes = Buffer.byteLength(JSON.stringify(evidence));
		if (this.seen.size >= MAX_RECORDS || this.bytes + bytes > MAX_SESSION_BYTES) {
			this.notice = "Session change capture limit reached; additional changes are not displayed.";
			return false;
		}
		this.seen.add(evidence.id);
		this.bytes += bytes;
		if (sameSnapshot(evidence.before, evidence.after)) return false;
		let files = this.files.get(evidence.root);
		if (!files) this.files.set(evidence.root, files = new Map());
		const previous = files.get(evidence.path);
		const state: FileState = { before: previous?.before ?? structuredClone(evidence.before), after: structuredClone(evidence.after) };
		state.unavailable = previous?.unavailable;
		if (previous && !sameSnapshot(previous.after, evidence.before)) state.unavailable = "Snapshot continuity lost (external or unobserved edit); session diff unavailable.";
		if (evidence.before.kind === "unavailable") state.unavailable ??= evidence.before.reason;
		if (evidence.after.kind === "unavailable") state.unavailable ??= evidence.after.reason;
		// Keep the final state even after an own revert, to detect later external edits.
		this.patch(evidence.path, state);
		files.set(evidence.path, state);
		this.settled.get(evidence.root)?.delete(evidence.path);
		this.cached = undefined;
		return true;
	}
	private changed(root: string): ChangedFile[] {
		const settled = this.settled.get(root);
		return [...(this.files.get(root) ?? [])].flatMap(([path, state]) => {
			if (!shown(state) || settled?.has(path)) return [];
			const patch = this.patch(path, state);
			const patchLines = patch.split("\n");
			const firstHunk = patchLines.findIndex(line => line.startsWith("@@"));
			const lines = firstHunk < 0 ? [] : patchLines.slice(firstHunk + 1);
			return [{
				path, diffRevision: createHash("sha256").update(patch).digest("hex"), status: state.before.kind === "absent" ? "added" as const : state.after.kind === "absent" ? "deleted" as const : "modified" as const,
				added: state.unavailable ? 0 : lines.filter(line => line.startsWith("+")).length,
				deleted: state.unavailable ? 0 : lines.filter(line => line.startsWith("-")).length,
				...(state.unavailable ? { countsUnavailable: state.unavailable } : {}),
			}];
		});
	}
	private patch(path: string, state: FileState): string {
		if (state.unavailable) return state.unavailable;
		return state.diff ??= generateUnifiedPatch(path, snapshotText(state.before), snapshotText(state.after));
	}
	get worktrees(): WorktreeChanges[] {
		return this.cached ??= [...this.files.keys()].map(root => ({ root, model: changesModel(this.changed(root)) })).filter(tree => tree.model.files.length > 0);
	}
	get model() {
		const trees = this.worktrees;
		return { ...changesModel(trees.flatMap(tree => tree.model.files.map(file => ({ ...file, path: trees.length === 1 ? file.path : tree.root + "/" + file.path })))), ...(this.notice ? { notice: this.notice } : {}) };
	}
	/** Return the capture-limit notice once, for a single user notification. The `notice` field stays set. */
	takeNotice(): string | undefined {
		if (!this.notice || this.announced) return undefined;
		this.announced = true;
		return this.notice;
	}
	/** Without Git this only returns the captured model. With Git, first reconcile it against HEAD. */
	async refresh(gitForRoot?: (root: string) => GitRunner) {
		if (gitForRoot) await (this.reconciling ??= this.reconcile(gitForRoot).finally(() => { this.reconciling = undefined; }));
		return this.model;
	}
	/**
	 * Hide captured files whose content matches HEAD again (committed or reverted outside the agent).
	 * Git only removes or restores captured entries; paths it reports beyond them are never attributed.
	 * A failed status leaves the root exactly as it was.
	 */
	private async reconcile(gitForRoot: (root: string) => GitRunner): Promise<void> {
		await Promise.all([...this.files].map(async ([root, files]) => {
			const candidates = [...files].filter(([, state]) => shown(state));
			if (candidates.length === 0) return;
			let result: Awaited<ReturnType<GitRunner>>;
			try {
				result = await gitForRoot(root)(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--", ...candidates.map(([path]) => ":(literal)" + gitPath(path))]);
			} catch { return; }
			if (result.code !== 0) return;
			const dirty = porcelainPaths(result.stdout);
			let settled = this.settled.get(root);
			if (!settled) this.settled.set(root, settled = new Set());
			for (const [path, state] of candidates) {
				// Evidence recorded while Git ran is newer than its answer.
				if (files.get(path) !== state) continue;
				if (dirty.has(gitPath(path))) settled.delete(path); else settled.add(path);
			}
			this.cached = undefined;
		}));
	}
	loadDiff(root: string, file: ChangedFile): string {
		const state = this.files.get(root)?.get(file.path);
		return state ? this.patch(file.path, state) : "No captured agent diff for this file.";
	}
}
