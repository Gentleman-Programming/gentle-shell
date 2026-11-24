import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { CHANGE_STATUS, DIFF_MAX_BYTES, FILE_WORK_CONCURRENCY, eachLimited, type ChangedFile, type UntrackedLineCounts } from "./shell-changes.ts";
import { createShellUntrackedCache, type CountedFile } from "./shell-untracked-cache.ts";

// At the low end of the scan budget range to limit cold I/O on external disks.
// Files are at most 1 MiB each; a deferred file always fits in a fresh budget.
export const SHELL_UNTRACKED_SCAN_BYTES = 64 * 1024 * 1024;
// Git's buffer_is_binary checks for NUL in the first 8000 bytes.
const BINARY_HEADER_BYTES = 8000;

interface FileInfo {
	isFile(): boolean;
	size: number;
	mtimeMs: number;
}

interface ShellUntrackedLineIo {
	lstat(path: string): Promise<FileInfo>;
	read(path: string, limit: number, start: number, expected: FileInfo): Promise<Buffer>;
}

const fileIo: ShellUntrackedLineIo = {
	lstat,
	async read(path, limit, start, expected) {
		// A path can change after lstat. Don't follow a replacement symlink or
		// block opening a FIFO; check the opened file and bound the actual read.
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size !== expected.size || info.mtimeMs !== expected.mtimeMs) return Buffer.alloc(0);
			const bytes = Buffer.allocUnsafe(limit);
			let offset = 0;
			while (offset < limit) {
				const { bytesRead } = await file.read(bytes, offset, limit - offset, start + offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			return bytes.subarray(0, offset);
		} finally {
			await file.close();
		}
	},
};

interface CountCandidate {
	root: string;
	file: ChangedFile;
	live: Map<string, CountedFile>;
	last?: CountedFile;
}

function countNewlines(bytes: Buffer): number {
	let lines = 0;
	for (let index = 0; index < bytes.length; index++) if (bytes[index] === 0x0a) lines++;
	return lines;
}

function countsChanged(previous: ReadonlyMap<string, CountedFile> | undefined, live: ReadonlyMap<string, CountedFile>): boolean {
	if (!previous) return live.size > 0;
	if (previous.size !== live.size) return true;
	for (const [path, entry] of live) if (previous.get(path) !== entry) return true;
	return false;
}

/** One cache per session tracker. An injected test budget must fit each fixture file. */
export function shellUntrackedLines(io: ShellUntrackedLineIo = fileIo, budget = SHELL_UNTRACKED_SCAN_BYTES, directory?: string): UntrackedLineCounts {
	const byRoot = new Map<string, Map<string, CountedFile>>();
	const cache = directory ? createShellUntrackedCache(directory) : undefined;
	return {
		close: cache?.close,
		retainRoots(roots) {
			for (const root of byRoot.keys()) if (!roots.has(root)) byRoot.delete(root);
		},
		beginScan() {
			let remaining = budget;
			// Reads in flight hold a reservation that a failure gives back: a file
			// that does not fit waits for them before it is deferred to a later scan.
			let inFlight = 0;
			let waiters: Array<() => void> = [];
			const settled = () => { const waiting = waiters; waiters = []; for (const wake of waiting) wake(); };
			const reserve = async (length: number): Promise<boolean> => {
				while (length > remaining) {
					if (inFlight === 0) return false;
					await new Promise<void>((resolve) => waiters.push(resolve));
				}
				remaining -= length;
				// Held from here, not from the read's start: another file must see it.
				inFlight++;
				return true;
			};
			return async (inventories) => {
				const uncounted: CountCandidate[] = [];
				const counted: CountCandidate[] = [];
				const snapshots = await Promise.all(inventories.map(({ root }) => byRoot.has(root) ? undefined : cache?.load(root)));
				const liveByRoot = new Map<string, { live: Map<string, CountedFile>; known?: Map<string, CountedFile>; malformed?: boolean }>();
				for (const [index, { root, files }] of inventories.entries()) {
					const loaded = snapshots[index];
					const known = byRoot.get(root) ?? loaded?.entries;
					const live = new Map<string, CountedFile>();
					liveByRoot.set(root, { live, known, malformed: loaded?.malformed });
					for (const file of files) {
						if (file.status !== CHANGE_STATUS.UNTRACKED) continue;
						const last = known?.get(file.path);
						(last ? counted : uncounted).push({ root, file, live, last });
					}
				}
				const count = async ({ root, file, live, last }: CountCandidate) => {
					const path = join(root, file.path);
					const info = await io.lstat(path).catch(() => undefined);
					file.added = 0;
					if (!info) {
						if (last) live.set(file.path, last);
						return;
					}
					const { size, mtimeMs } = info;
					file.diffRevision = `${size}:${mtimeMs}`;
					if (!info.isFile() || size > DIFF_MAX_BYTES) return;
					if (last?.size === size && last.mtimeMs === mtimeMs) {
						file.added = last.added;
						live.set(file.path, last);
						return;
					}
					const defer = () => {
						file.countsUnavailable = "Untracked line count pending";
						if (last) {
							file.added = last.added;
							live.set(file.path, last);
						}
					};
					if (size > 0) {
						// Reserve each range before awaiting it so concurrent files
						// cannot overspend. Binaries never reserve or read the tail.
						const read = async (length: number, offset: number) => {
							try {
								const bytes = await io.read(path, length, offset, info).catch(() => undefined);
								// A failed or short read gives back what it did not use, so
								// unreadable files cannot use up the budget on every scan.
								remaining += length - (bytes?.length ?? 0);
								return bytes?.length === length ? bytes : undefined;
							} finally {
								inFlight--;
								settled();
							}
						};
						const headLength = Math.min(BINARY_HEADER_BYTES, size);
						if (!(await reserve(headLength))) return defer();
						const head = await read(headLength, 0);
						// A read error is a zero for this scan, not pending or cached.
						if (!head) return;
						if (!head.includes(0)) {
							const tailLength = size - headLength;
							let end = head;
							if (tailLength > 0) {
								if (!(await reserve(tailLength))) return defer();
								const tail = await read(tailLength, headLength);
								if (!tail) return;
								end = tail;
							}
							file.added = countNewlines(head) + (end === head ? 0 : countNewlines(end)) + (end[end.length - 1] === 0x0a ? 0 : 1);
						}
					}
					live.set(file.path, { size, mtimeMs, added: file.added });
				};
				// Start with files that have no answer across all registered roots,
				// so even a constantly edited file cannot starve a deferred one.
				await eachLimited(uncounted, FILE_WORK_CONCURRENCY, count);
				await eachLimited(counted, FILE_WORK_CONCURRENCY, count);
				// A successful inventory is authoritative: forget paths no longer in it.
				for (const [root, { live, known, malformed }] of liveByRoot) {
					byRoot.set(root, live);
					if (cache && (malformed || countsChanged(known, live))) cache.remember(root, live);
				}
			};
		},
	};
}
