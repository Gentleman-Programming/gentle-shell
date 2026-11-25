// Uploads for `gentle-shell serve`: a client sends a file it wants the agent
// to see (a chat attachment, a screenshot, a log) and gets back its path on
// the server, under `<agent home>/serve/uploads/<device>/<random>/<name>`.
// Uploads are owner-only and removed after 7 days.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Principal } from "./serve-auth.ts";
import { fsHttpError, need, receiveBodyToFile, sendJson } from "./serve-http.ts";

export const SERVE_UPLOAD_LIMITS = {
	bytes: 64 * 1024 * 1024,
	/** An upload older than this is removed. */
	maxAgeMs: 7 * 24 * 60 * 60_000,
	sweepMs: 60 * 60_000,
	/** UTF-8 bytes of a file name. */
	nameBytes: 200,
};

/**
 * A file name from a client: its last path component, without control
 * characters or characters Windows forbids, at most `maxBytes` UTF-8 bytes;
 * `upload` when nothing usable is left.
 */
export function cleanUploadName(raw: string | null, maxBytes = SERVE_UPLOAD_LIMITS.nameBytes): string {
	const last = (raw ?? "").split(/[/\\]/).pop() ?? "";
	let name = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
	while (Buffer.byteLength(name, "utf8") > maxBytes) name = name.slice(0, -1);
	return name === "" || name === "." || name === ".." ? "upload" : name;
}

export interface UploadStoreOptions {
	/** `<agent home>/serve/uploads`. */
	dir: string;
	limits?: Partial<typeof SERVE_UPLOAD_LIMITS>;
	now?: () => number;
	log?: (line: string) => void;
}

export class UploadStore {
	private readonly dir: string;
	private readonly limits: typeof SERVE_UPLOAD_LIMITS;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly timer: NodeJS.Timeout;

	constructor(options: UploadStoreOptions) {
		this.dir = options.dir;
		this.limits = { ...SERVE_UPLOAD_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.timer = setInterval(() => void this.sweep(), this.limits.sweepMs);
		this.timer.unref();
		void this.sweep();
	}

	/** `POST /api/uploads?name=`: the raw body becomes a new file; answers its path. */
	async upload(req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal | undefined): Promise<void> {
		const who = need(principal, "sessions:operate");
		const name = cleanUploadName(url.searchParams.get("name"));
		const folder = join(this.dir, who.deviceId, randomBytes(8).toString("hex"));
		await mkdir(folder, { recursive: true, mode: 0o700 }).catch((error: unknown) => { throw fsHttpError(error, folder); });
		const path = join(folder, name);
		try {
			const { size, sha256 } = await receiveBodyToFile(req, path, this.limits.bytes, 0o600);
			sendJson(res, 201, { path, name, size, sha256, expiresAt: new Date(this.now() + this.limits.maxAgeMs).toISOString() });
		} catch (error) {
			await rm(folder, { recursive: true, force: true });
			throw fsHttpError(error, path);
		}
	}

	/** Removes uploads older than `maxAgeMs`, then device folders left empty. */
	async sweep(): Promise<void> {
		const cutoff = this.now() - this.limits.maxAgeMs;
		const devices = await readdir(this.dir).catch(() => [] as string[]);
		for (const device of devices) {
			const deviceDir = join(this.dir, device);
			const uploads = await readdir(deviceDir).catch(() => [] as string[]);
			for (const upload of uploads) {
				const folder = join(deviceDir, upload);
				const stats = await stat(folder).catch(() => undefined);
				if (stats && stats.mtimeMs < cutoff) {
					await rm(folder, { recursive: true, force: true });
					this.log(`upload ${device}/${upload} expired`);
				}
			}
			await rmdir(deviceDir).catch(() => { /* not empty */ });
		}
	}

	close(): void {
		clearInterval(this.timer);
	}
}
