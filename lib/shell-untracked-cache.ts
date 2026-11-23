import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const VERSION = 1;
const SAVE_DELAY_MS = 1_000;

export interface CountedFile {
	size: number;
	mtimeMs: number;
	added: number;
}

type Snapshot = ReadonlyMap<string, CountedFile>;
type RootCache = { file?: string; pending?: Snapshot; saving?: Promise<void>; failed?: boolean };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countedFile(value: unknown): value is CountedFile {
	return record(value)
		&& typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
		&& typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs)
		&& typeof value.added === "number" && Number.isSafeInteger(value.added) && value.added >= 0 && value.added <= value.size;
}

async function readSnapshot(file: string) {
	const data: unknown = JSON.parse(await readFile(file, "utf8"));
	if (!record(data) || data.version !== VERSION || !record(data.entries)) return;
	const entries = new Map<string, CountedFile>();
	let malformed = false;
	for (const path of Object.keys(data.entries)) {
		const entry = data.entries[path];
		if (path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..") || !countedFile(entry)) {
			malformed = true;
			continue;
		}
		entries.set(path, entry);
	}
	return { entries, malformed };
}

// Resolve existing symlinks without creating any directories for a clean root.
async function realCacheDirectory(directory: string): Promise<string> {
	try {
		return await realpath(directory);
	} catch (error) {
		const parent = dirname(directory);
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === directory) throw error;
		return join(await realCacheDirectory(parent), basename(directory));
	}
}

async function writeSnapshot(file: string, entries: Snapshot): Promise<void> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	// mkdir's mode only applies to a directory it creates. The snapshot names
	// the user's untracked paths: an existing directory loses its group and
	// other access first (the owner's own bits are never widened), and nothing
	// is written when that cannot be done (a failed save is simply no cache).
	if (process.platform !== "win32") {
		const directory = dirname(file);
		const mode = (await stat(directory)).mode & 0o777;
		if (mode & 0o077) await chmod(directory, mode & 0o700);
	}
	// Concurrent processes can independently publish complete snapshots. The
	// last rename wins; each count is still revalidated by size and mtime.
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, JSON.stringify({ version: VERSION, entries: Object.fromEntries(entries) }), { mode: 0o600, flag: "wx" });
		await rename(temp, file);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}

/** A best-effort cache for completed scans, never a source of file inventory. */
export function createShellUntrackedCache(directory: string) {
	const roots = new Map<string, RootCache>();
	let cacheDirectory: Promise<string> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

	async function savePending() {
		await Promise.all([...roots.values()].map(async (state) => {
			const { file, pending, saving } = state;
			if (state.failed || !file || !pending) return saving;
			state.pending = undefined;
			const next = Promise.resolve(saving).then(async () => {
				if (state.failed) return;
				try {
					await writeSnapshot(file, pending);
				} catch {
					// Don't turn idle continuation into repeated writes to a broken
					// cache directory. Try this root again in the next session.
					state.failed = true;
					state.pending = undefined;
				}
			});
			state.saving = next;
			await next;
			if (state.saving === next) state.saving = undefined;
		}));
	}

	return {
		async load(root: string) {
			if (closed || roots.has(root)) return;
			const state: RootCache = {};
			roots.set(root, state);
			try {
				cacheDirectory ??= realCacheDirectory(resolve(directory));
				const [realRoot, realDirectory] = await Promise.all([realpath(root), cacheDirectory]);
				const fromRoot = relative(realRoot, realDirectory);
				if (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)) return;
				const key = createHash("sha256").update(realRoot).digest("hex");
				state.file = join(realDirectory, `${key}.json`);
				return await readSnapshot(state.file);
			} catch {
				return;
			}
		},
		remember(root: string, entries: Snapshot) {
			const state = roots.get(root);
			if (closed || !state?.file || state.failed) return;
			state.pending = entries;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				void savePending();
			}, SAVE_DELAY_MS);
			timer.unref?.();
		},
		async close() {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			await savePending();
		},
	};
}
