import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const FALLBACK_COLUMNS = 24;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** Read only a bounded local snapshot, never poll Herdr's CLI/socket for geometry. */
export function createActivityColumns(socket: string, now: () => number = Date.now): () => number {
	const path = isAbsolute(socket) ? join(dirname(socket), "session.json") : undefined;
	let refreshAt = -Infinity;
	let columns = FALLBACK_COLUMNS;
	return () => {
		const time = now();
		if (time < refreshAt) return columns;
		refreshAt = time + 5000;
		columns = FALLBACK_COLUMNS;
		if (!path) return columns;
		let fd: number | undefined;
		try {
			// Reject FIFOs after opening without waiting for a writer; unsupported flags are omitted.
			fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return columns;
			// One extra byte rejects files that grew after fstat, without unlimited reads.
			const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
			const size = readSync(fd, buffer, 0, buffer.length, 0);
			if (size > MAX_SNAPSHOT_BYTES) return columns;
			const snapshot = JSON.parse(buffer.toString("utf8", 0, size));
			const width: unknown = snapshot?.sidebar_width;
			if (typeof width === "number" && Number.isInteger(width) && width >= 6 && width <= 512) {
				// Divider + possible scrollbar + three-space agent detail prefix.
				columns = width - 5;
			}
		} catch { /* Missing/malformed snapshots use conservative geometry. */ }
		finally {
			try { if (fd !== undefined) closeSync(fd); } catch { /* Best effort close. */ }
		}
		return columns;
	};
}

/** Fit whole graphemes within cell, UTF-8 byte and Unicode scalar budgets. */
function fit(parts: string[], columns: number, bytes: number, characters: number, preferWords = true): number {
	let cells = 0;
	let used = 0;
	let scalars = 0;
	let count = 0;
	let space = -1;
	for (const part of parts) {
		const width = visibleWidth(part);
		const size = Buffer.byteLength(part);
		const length = Array.from(part).length;
		if (cells + width > columns || used + size > bytes || scalars + length > characters) break;
		if (part === " ") space = count;
		cells += width;
		used += size;
		scalars += length;
		count++;
	}
	if (preferWords && count < parts.length && parts[count] !== " " && space > 0) return space;
	return count;
}

/** Only the active Todo title is free text. LF is private framing, not a token. */
export function activitySummary(tasks: unknown, columns = FALLBACK_COLUMNS): string | null {
	if (!Array.isArray(tasks)) return null;
	const title: unknown = tasks.find((task) => task?.status === "in_progress")?.title;
	if (typeof title !== "string") return null;
	const clipped = title.length > 4096;
	// Bound sanitization/segmentation work, preserve ZWJ emoji but strip bidi controls.
	/* eslint-disable no-control-regex */
	const clean = stripTerminalSequences(title.slice(0, 4096))
		.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
		.replace(/\s+/g, " ").trim();
	/* eslint-enable no-control-regex */
	if (!clean) return null;
	const parts = Array.from(graphemes.segment(clean), ({ segment }) => segment);
	// The bounded sample may end inside a grapheme; never publish that fragment.
	if (clipped) parts.pop();
	columns = Number.isFinite(columns) ? Math.max(1, Math.min(512, Math.floor(columns))) : FALLBACK_COLUMNS;
	if (columns <= 2) return columns === 1 ? "…" : "◐…";
	// Herdr caps each token at 80 scalars; count our icon/indent before its trim.
	const whole = fit(parts, columns - 2, 252, 78, false);
	if (!clipped && whole === parts.length) return `◐ ${parts.join("")}`;
	// Reserve the second-row indent and ellipsis; private LF framing is not a token byte.
	let firstCount = fit(parts, columns - 2, 247, 78);
	if (!firstCount) return columns === 3 ? "◐…" : "◐ …";
	const restFits = (count: number): boolean => {
		const first = `◐ ${parts.slice(0, count).join("").trimEnd()}`;
		const rest = parts.slice(count);
		while (rest[0] === " ") rest.shift();
		return fit(rest, columns - 2, 256 - Buffer.byteLength(first) - 2, 78, false) === rest.length;
	};
	// Prefer words unless splitting one would preserve the entire two-row title.
	if (!clipped && !restFits(firstCount)) {
		const hardCount = fit(parts, columns - 2, 247, 78, false);
		if (restFits(hardCount)) firstCount = hardCount;
	}
	const first = `◐ ${parts.slice(0, firstCount).join("").trimEnd()}`;
	const rest = parts.slice(firstCount);
	while (rest[0] === " ") rest.shift();
	const bytes = 256 - Buffer.byteLength(first) - 2; // Two-space indent.
	let count = fit(rest, columns - 2, bytes, 78, false);
	const overflow = clipped || count < rest.length;
	if (overflow) count = fit(rest, columns - 3, bytes - 3, 77);
	const second = rest.slice(0, count).join("").trimEnd();
	return `${first}\n  ${second}${overflow ? "…" : ""}`;
}

export function metadataArgs(pane: string, summary: string | null, seq: number): string[] {
	const rows = summary?.split("\n") ?? [];
	const tokens = ["summary", "summary2"].flatMap((token, index) => rows[index]
		? ["--token", `${token}=${rows[index]}`] : ["--clear-token", token]);
	return ["pane", "report-metadata", pane, "--source", "gentle:activity", "--agent", "pi",
		"--seq", String(seq), "--ttl-ms", "30000", ...tokens];
}

export function metadataTransport(env: NodeJS.ProcessEnv): (summary: string | null, seq: number) => Promise<void> {
	return (summary, seq) => new Promise((resolve) => {
		// No shell, bounded output/time, and failure never blocks Pi's handlers.
		execFile(env.HERDR_BIN_PATH ?? "herdr", metadataArgs(env.HERDR_PANE_ID!, summary, seq), {
			env, timeout: 1500, maxBuffer: 4096, windowsHide: true,
		}, () => resolve());
	});
}

/** One in flight, one pending value; a clear supersedes queued active work. */
export class ActivityPublisher {
	private pending: string | null | undefined;
	private last: string | null | undefined;
	private running = false;
	private closed = false;
	private cancel: (() => void) | undefined;
	private seq = Date.now();
	private readonly send: (summary: string | null, seq: number) => Promise<void>;
	private readonly schedule: (fn: () => void) => () => void;
	constructor(send: (summary: string | null, seq: number) => Promise<void>,
		schedule: (fn: () => void) => () => void = (fn) => {
			const timer = setTimeout(fn, 150);
			timer.unref();
			return () => clearTimeout(timer);
		}) {
		this.send = send;
		this.schedule = schedule;
	}

	update(summary: string | null, force = false): void {
		if (this.closed || (!force && (this.pending !== undefined
			? summary === this.pending : !this.running && summary === this.last))) return;
		this.pending = summary;
		if (summary === null) {
			this.cancel?.();
			this.cancel = undefined;
			if (!this.running) void this.flush();
			return;
		}
		this.enqueue();
	}
	private enqueue(): void {
		if (this.running || this.cancel || this.pending === undefined) return;
		this.cancel = this.schedule(() => { this.cancel = undefined; void this.flush(); });
	}
	private async flush(): Promise<void> {
		if (this.pending === undefined) return;
		const summary = this.pending;
		this.pending = undefined;
		this.running = true;
		try { await this.send(summary, ++this.seq); this.last = summary; }
		catch { /* Best effort; a refresh retries active state. */ }
		finally { this.running = false; this.enqueue(); }
	}
	close(): void {
		if (this.closed) return;
		this.update(null, true);
		this.closed = true;
		this.cancel?.(); this.cancel = undefined;
		if (!this.running) void this.flush();
	}
}
