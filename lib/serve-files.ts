// Files on the server for `gentle-shell serve`: list, stat, read, write,
// mkdir, rename, remove, filename search and change streams, so a client
// can browse and edit a project that lives on the server. Paths are absolute
// server paths; every operation runs as the server user, so `sessions:operate`
// is that user's file authority (the same as a session's own tools).

import { randomBytes } from "node:crypto";
import { constants as fsConstants, realpathSync, statSync, watch, type FSWatcher, type Stats } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, opendir, readlink, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, sep } from "node:path";
import type { Principal } from "./serve-auth.ts";
import { absolutePath, fsHttpError, HttpError, need, readJsonBody, realDirectory, receiveBodyToFile, SECURITY_HEADERS, sendJson, sseEvent, startSse } from "./serve-http.ts";

export const SERVE_FS_LIMITS = {
	/** Entries one `list` returns; `truncated` past this. */
	listEntries: 5000,
	/** Bytes one `read` returns. */
	readBytes: 8 * 1024 * 1024,
	/** Bytes one `write` accepts. */
	writeBytes: 64 * 1024 * 1024,
	searchDefault: 100,
	searchMax: 1000,
	/** Directory entries one search looks at, and how long it may walk. */
	searchVisit: 200_000,
	searchMs: 5_000,
	/** Quiet time before a batch of changes is sent, and the longest a change waits. */
	watchDebounceMs: 150,
	watchMaxDelayMs: 1_000,
	watchersPerDevice: 32,
	/** Paths one change batch names; past this it says `overflow` (rescan). */
	watchBatchPaths: 1000,
	smallBodyBytes: 16 * 1024,
};

/** Folders a search never enters. */
const SEARCH_SKIP: Record<string, true> = { ".git": true, "node_modules": true };

export type EntryKind = "file" | "dir" | "symlink" | "other";

function kindOf(stats: Stats): EntryKind {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isDirectory()) return "dir";
	if (stats.isFile()) return "file";
	return "other";
}

/** A validator for a file's version: size and modification time (µs). */
export function fileEtag(stats: Stats): string {
	return `"${stats.size.toString(36)}-${Math.round(stats.mtimeMs * 1000).toString(36)}"`;
}

async function linkKind(path: string): Promise<"file" | "dir" | "other" | null> {
	try {
		const target = await stat(path);
		return target.isDirectory() ? "dir" : target.isFile() ? "file" : "other";
	} catch {
		return null; // dangling
	}
}

/**
 * Scores a filename against a lowercase query: exact name 100, name prefix 80,
 * name substring 60, relative path substring 40, the query's characters in
 * order in the name 10; 0 is no match.
 */
export function searchScore(name: string, relativePath: string, needle: string): number {
	const lower = name.toLowerCase();
	if (lower === needle) return 100;
	if (lower.startsWith(needle)) return 80;
	if (lower.includes(needle)) return 60;
	if (relativePath.toLowerCase().replaceAll("\\", "/").includes(needle)) return 40;
	let at = 0;
	for (const ch of lower) if (ch === needle[at]) at += 1;
	return at === needle.length ? 10 : 0;
}

interface Watch {
	deviceId: string;
	res: ServerResponse;
	watcher: FSWatcher;
	pending: Set<string>;
	firstAt: number;
	timer?: NodeJS.Timeout;
}

export interface FileServiceOptions {
	limits?: Partial<typeof SERVE_FS_LIMITS>;
	now?: () => number;
	log?: (line: string) => void;
}

export class FileService {
	private readonly limits: typeof SERVE_FS_LIMITS;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly watches = new Set<Watch>();
	/** The server user's home, symlinks resolved: never removed or renamed, nor any folder above it. */
	private readonly home: string;

	constructor(options: FileServiceOptions = {}) {
		this.limits = { ...SERVE_FS_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		let home = homedir();
		try { home = realpathSync(home); } catch { /* keep as is */ }
		this.home = home;
	}

	/** Answers `/api/fs/*`; false for any other path. */
	async route(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL, principal: Principal | undefined): Promise<boolean> {
		if (!path.startsWith("/api/fs/")) return false;
		const op = path.slice("/api/fs/".length);
		const expect = (wanted: string) => { if (method !== wanted) throw new HttpError(405, "method_not_allowed", `Use ${wanted}`); };
		switch (op) {
			case "list": expect("GET"); need(principal, "sessions:read"); await this.list(res, url); return true;
			case "stat": expect("GET"); need(principal, "sessions:read"); await this.stat(res, url); return true;
			case "read": expect("GET"); need(principal, "sessions:read"); await this.read(req, res, url); return true;
			case "search": expect("GET"); need(principal, "sessions:read"); await this.search(res, url); return true;
			case "watch": expect("GET"); this.watch(req, res, url, need(principal, "sessions:read")); return true;
			case "write": expect("PUT"); need(principal, "sessions:operate"); await this.write(req, res, url); return true;
			case "mkdir": expect("POST"); need(principal, "sessions:operate"); await this.mkdir(req, res); return true;
			case "rename": expect("POST"); need(principal, "sessions:operate"); await this.rename(req, res); return true;
			case "remove": expect("POST"); need(principal, "sessions:operate"); await this.remove(req, res); return true;
			default: throw new HttpError(404, "not_found", "Not found");
		}
	}

	private async list(res: ServerResponse, url: URL): Promise<void> {
		const dirPath = absolutePath(url.searchParams.get("path"));
		const names: string[] = [];
		let truncated = false;
		try {
			const dir = await opendir(dirPath);
			for await (const entry of dir) {
				if (names.length >= this.limits.listEntries) { truncated = true; break; }
				names.push(entry.name);
			}
		} catch (error) {
			throw fsHttpError(error, dirPath);
		}
		const entries: Array<{ name: string; kind: EntryKind; size: number; mtime: number; linkKind?: string | null }> = [];
		for (let i = 0; i < names.length; i += 128) {
			const batch = await Promise.all(names.slice(i, i + 128).map(async (name) => {
				const full = join(dirPath, name);
				try {
					const stats = await lstat(full);
					const kind = kindOf(stats);
					return { name, kind, size: stats.size, mtime: Math.floor(stats.mtimeMs), ...(kind === "symlink" ? { linkKind: await linkKind(full) } : {}) };
				} catch {
					return undefined; // removed while listing
				}
			}));
			for (const entry of batch) if (entry) entries.push(entry);
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		sendJson(res, 200, { path: dirPath, entries, truncated });
	}

	private async stat(res: ServerResponse, url: URL): Promise<void> {
		const path = absolutePath(url.searchParams.get("path"));
		let stats: Stats;
		try { stats = await lstat(path); } catch (error) { throw fsHttpError(error, path); }
		const kind = kindOf(stats);
		let real: string | undefined;
		try { real = await realpath(path); } catch { /* dangling link */ }
		const followed = kind === "symlink" && real !== undefined ? await stat(real).catch(() => undefined) : undefined;
		sendJson(res, 200, {
			path,
			name: basename(path),
			kind,
			size: stats.size,
			mtime: Math.floor(stats.mtimeMs),
			mode: stats.mode & 0o7777,
			...(kind === "file" ? { etag: fileEtag(stats) } : {}),
			...(kind === "symlink" ? { linkTarget: await readlink(path).catch(() => null), linkKind: await linkKind(path) } : {}),
			...(followed?.isFile() ? { etag: fileEtag(followed), size: followed.size } : {}),
			...(real === undefined ? {} : { realPath: real }),
		});
	}

	private async read(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const path = absolutePath(url.searchParams.get("path"));
		const offset = wholeNumber(url.searchParams.get("offset"), "offset") ?? 0;
		const asked = wholeNumber(url.searchParams.get("length"), "length");
		// O_NONBLOCK: opening a FIFO never waits for a writer.
		const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)).catch((error: unknown) => { throw fsHttpError(error, path); });
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) throw new HttpError(400, "not_a_file", `${path} is not a regular file`);
			const etag = fileEtag(stats);
			const headers = { ETag: etag, "Last-Modified": new Date(stats.mtimeMs).toUTCString(), "X-File-Size": String(stats.size), "X-File-Mtime": String(Math.floor(stats.mtimeMs)) };
			const inm = req.headers["if-none-match"];
			const ims = req.headers["if-modified-since"];
			const unchanged = typeof inm === "string" ? inm.split(",").some((tag) => tag.trim() === etag)
				: typeof ims === "string" && Number.isFinite(Date.parse(ims)) && Math.floor(stats.mtimeMs / 1000) * 1000 <= Date.parse(ims);
			if (unchanged) {
				res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
				return void res.end();
			}
			const length = Math.max(0, Math.min(asked ?? this.limits.readBytes, this.limits.readBytes, stats.size - offset));
			const buffer = Buffer.allocUnsafe(length);
			let got = 0;
			while (got < length) {
				const { bytesRead } = await handle.read(buffer, got, length - got, offset + got);
				if (bytesRead === 0) break;
				got += bytesRead;
			}
			res.writeHead(200, { ...SECURITY_HEADERS, ...headers, "Content-Type": "application/octet-stream", "Content-Length": got, "X-Offset": String(offset),
				"X-Truncated": offset + got < stats.size ? "1" : "0" });
			res.end(got === length ? buffer : buffer.subarray(0, got));
		} finally {
			await handle.close();
		}
	}

	private async write(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const target = absolutePath(url.searchParams.get("path"));
		const createOnly = url.searchParams.get("create_only") === "1" || url.searchParams.get("create_only") === "true";
		// A save through a symlink replaces the file it points to and keeps the link.
		let real: string;
		let existing: Stats | undefined;
		try {
			real = await realpath(target);
			existing = await stat(real);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fsHttpError(error, target);
			if (await lstat(target).then((s) => s.isSymbolicLink(), () => false)) throw new HttpError(409, "dangling_symlink", `${target} is a link to a file that does not exist`);
			const parent = await realpath(dirname(target)).catch((e: unknown) => { throw fsHttpError(e, dirname(target)); });
			real = join(parent, basename(target));
		}
		if (existing && createOnly) throw new HttpError(409, "exists", `${target} already exists`);
		if (existing && !existing.isFile()) throw new HttpError(400, "not_a_file", `${target} is not a regular file`);
		const ifMatch = req.headers["if-match"];
		if (typeof ifMatch === "string" && (!existing || !ifMatch.split(",").some((tag) => tag.trim() === fileEtag(existing)))) {
			throw new HttpError(412, "changed", `${target} changed since it was read`);
		}
		const temp = join(dirname(real), `.${basename(real)}.gs-${randomBytes(6).toString("hex")}.tmp`);
		const mode = existing ? existing.mode & 0o7777 : 0o666;
		try {
			await receiveBodyToFile(req, temp, this.limits.writeBytes, mode).catch((error: unknown) => { throw fsHttpError(error, target); });
			if (existing) await chmod(temp, mode);
			if (createOnly) {
				try {
					await link(temp, real);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "exists", `${target} already exists`);
					// No hard links here (some network and FAT volumes): an exclusive copy.
					await copyFile(temp, real, fsConstants.COPYFILE_EXCL).catch((e: unknown) => { throw fsHttpError(e, target); });
				}
			} else {
				await rename(temp, real).catch((error: unknown) => { throw fsHttpError(error, target); });
			}
		} finally {
			await rm(temp, { force: true });
		}
		const stats = await stat(real);
		sendJson(res, existing ? 200 : 201, { path: target, size: stats.size, mtime: Math.floor(stats.mtimeMs), etag: fileEtag(stats), created: !existing });
	}

	private async mkdir(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJsonBody(req, this.limits.smallBodyBytes);
		const path = absolutePath(body.path);
		const first = await mkdir(path, { recursive: true }).catch((error: unknown) => { throw fsHttpError(error, path); });
		sendJson(res, first === undefined ? 200 : 201, { path, created: first !== undefined });
	}

	/** The entry itself (its folder's symlinks resolved, the last component kept), refused when it is a root, the home or a folder above it. */
	private async entry(path: string): Promise<string> {
		const root = parse(path).root;
		const canonical = path === root ? root : join(await realpath(dirname(path)).catch((e: unknown) => { throw fsHttpError(e, path); }), basename(path));
		if (canonical === parse(canonical).root || canonical === this.home || this.home.startsWith(canonical.endsWith(sep) ? canonical : canonical + sep)) {
			throw new HttpError(403, "protected_path", `${path} is the file system root, the home folder or a folder that holds it`);
		}
		return canonical;
	}

	private async rename(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJsonBody(req, this.limits.smallBodyBytes);
		const from = absolutePath(body.from, "from");
		const to = absolutePath(body.to, "to");
		const source = await this.entry(from);
		const dest = await this.entry(to);
		const sourceStats = await lstat(source).catch((error: unknown) => { throw fsHttpError(error, from); });
		if (body.overwrite !== true) {
			const there = await lstat(dest).catch(() => undefined);
			// The same entry (a case-only rename on a case-insensitive volume) is not a clash.
			if (there && !(there.ino === sourceStats.ino && there.dev === sourceStats.dev)) throw new HttpError(409, "exists", `${to} already exists`);
		}
		await rename(source, dest).catch((error: unknown) => { throw fsHttpError(error, to); });
		sendJson(res, 200, { from, to });
	}

	private async remove(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJsonBody(req, this.limits.smallBodyBytes);
		const path = absolutePath(body.path);
		const canonical = await this.entry(path);
		const stats = await lstat(canonical).catch((error: unknown) => { throw fsHttpError(error, path); });
		try {
			if (stats.isDirectory()) {
				if (body.recursive === true) await rm(canonical, { recursive: true });
				else await rmdir(canonical);
			} else {
				await unlink(canonical);
			}
		} catch (error) {
			throw fsHttpError(error, path);
		}
		sendJson(res, 200, { removed: path });
	}

	private async search(res: ServerResponse, url: URL): Promise<void> {
		const root = realDirectory(url.searchParams.get("root"));
		const q = url.searchParams.get("q") ?? "";
		if (q.length === 0 || q.length > 256 || q.includes("\0")) throw new HttpError(400, "invalid_query", "q must be 1-256 characters");
		const limit = Math.min(wholeNumber(url.searchParams.get("limit"), "limit") ?? this.limits.searchDefault, this.limits.searchMax);
		const needle = q.toLowerCase();
		const deadline = this.now() + this.limits.searchMs;
		const matches: Array<{ path: string; name: string; kind: EntryKind; score: number }> = [];
		const queue = [root];
		let visited = 0;
		let truncated = false;
		walk: while (queue.length > 0) {
			const dir = queue.shift()!;
			let handle;
			try { handle = await opendir(dir); } catch { continue; }
			for await (const entry of handle) {
				visited += 1;
				if (visited > this.limits.searchVisit || this.now() > deadline) { truncated = true; break walk; }
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (Object.hasOwn(SEARCH_SKIP, entry.name)) continue;
					queue.push(full);
				}
				const score = searchScore(entry.name, relative(root, full), needle);
				if (score > 0) matches.push({ path: full, name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other", score });
			}
		}
		matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
		sendJson(res, 200, { root, results: matches.slice(0, limit), truncated });
	}

	private watch(req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal): void {
		const path = absolutePath(url.searchParams.get("path"));
		let stats: Stats;
		try {
			stats = statSync(path);
		} catch (error) {
			throw fsHttpError(error, path);
		}
		const own = [...this.watches].filter((w) => w.deviceId === principal.deviceId).length;
		if (own >= this.limits.watchersPerDevice) throw new HttpError(429, "too_many_watchers", `At most ${this.limits.watchersPerDevice} change streams per device`);
		const isDir = stats.isDirectory();
		let watcher: FSWatcher;
		let recursive = isDir;
		try {
			try {
				watcher = watch(path, { recursive });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw error;
				recursive = false;
				watcher = watch(path);
			}
		} catch (error) {
			throw fsHttpError(error, path);
		}
		const base = isDir ? path : dirname(path);
		const entry: Watch = { deviceId: principal.deviceId, res, watcher, pending: new Set(), firstAt: 0 };
		this.watches.add(entry);
		startSse(req, res);
		res.write(`retry: 3000\n\n${sseEvent("ready", { path, recursive })}`);
		const flush = () => {
			entry.timer = undefined;
			const paths = [...entry.pending];
			entry.pending.clear();
			if (paths.length === 0) return;
			res.write(sseEvent("changes", paths.length > this.limits.watchBatchPaths ? { paths: [], overflow: true } : { paths }));
		};
		watcher.on("change", (_type, filename) => {
			const name = filename === null || filename === undefined ? "" : filename.toString();
			if (entry.pending.size === 0) entry.firstAt = this.now();
			entry.pending.add(name === "" ? path : isDir ? join(base, name) : path);
			clearTimeout(entry.timer);
			const wait = Math.max(0, Math.min(this.limits.watchDebounceMs, entry.firstAt + this.limits.watchMaxDelayMs - this.now()));
			entry.timer = setTimeout(flush, wait);
		});
		watcher.on("error", (error) => {
			res.end(sseEvent("error", { message: error.message }));
		});
		res.on("close", () => this.stopWatch(entry));
		this.log(`watch ${path} for ${principal.deviceId}${recursive ? " (recursive)" : ""}`);
	}

	private stopWatch(entry: Watch): void {
		if (!this.watches.delete(entry)) return;
		clearTimeout(entry.timer);
		entry.watcher.close();
		if (!entry.res.writableEnded) entry.res.end();
	}

	heartbeat(): void {
		for (const entry of this.watches) entry.res.write(": ping\n\n");
	}

	/** Ends a device's change streams (revoked). */
	closeDevice(deviceId: string): void {
		for (const entry of [...this.watches]) if (entry.deviceId === deviceId) this.stopWatch(entry);
	}

	closeAll(): void {
		for (const entry of [...this.watches]) this.stopWatch(entry);
	}
}

function wholeNumber(raw: string | null, name: string): number | undefined {
	if (raw === null || raw === "") return undefined;
	if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, `invalid_${name}`, `${name} must be a whole number`);
	return Number(raw);
}
