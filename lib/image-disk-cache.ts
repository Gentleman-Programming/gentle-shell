import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, basename, join } from "node:path";

// Pasted images normally live only in memory (see lib/image-attachments.ts).
// This module is the opt-in disk cache: it gives tools that need a filesystem
// path somewhere to look, without ever putting a path in the prompt.
//
// Privacy contract:
// - the directory is per session and private (0700), every file is 0600;
// - the whole session directory is removed on shutdown;
// - a startup sweep removes session directories left behind by a crash.
// Nothing here is on by default: the caller decides whether to build a cache.

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

/** Files this cache owns. The sweep only ever touches directories holding them. */
const OWN_FILE = /^image-\d+\.(png|jpg|webp|gif)$/;

/** `${XDG_CACHE_HOME:-~/.cache}/gentle-shell/images`, where sessions are created. */
export function defaultCacheRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const xdg = env.XDG_CACHE_HOME;
	// XDG says a relative value must be ignored: a cache path that depends on the
	// working directory cannot be handed to a tool as an absolute file path.
	const base = xdg && xdg.trim() && isAbsolute(xdg) ? xdg : join(home, ".cache");
	return join(base, "gentle-shell", "images");
}

/**
 * Reduce a session id to one path segment. Taking the last segment first means
 * a crafted id such as `../../etc` lands inside the root instead of above it.
 */
function safeSegment(id: string): string {
	const last = id.split(/[\\/]/).filter((part) => part.length > 0 && part !== "." && part !== "..").pop();
	const cleaned = (last ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
	return cleaned.length > 0 ? cleaned : "session";
}

export interface ImageDiskCacheOptions {
	root?: string;
	sessionId: string;
}

export class ImageDiskCache {
	readonly directory: string;

	constructor(options: ImageDiskCacheOptions) {
		const root = options.root ?? defaultCacheRoot();
		this.directory = join(root, safeSegment(options.sessionId));
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		} catch {
			// A cache that cannot be created is a cache that does nothing.
		}
	}

	/** Write one image, returning its path, or undefined when the disk refuses. */
	write(id: number, bytes: Uint8Array, mimeType: string): string | undefined {
		const extension = EXT_BY_MIME[mimeType];
		if (!extension) return undefined;
		try {
			const path = join(this.directory, `image-${id}.${extension}`);
			writeFileSync(path, bytes, { mode: 0o600 });
			return path;
		} catch {
			return undefined;
		}
	}

	/** Remove this session's directory; other sessions are never touched. */
	dispose(): void {
		try {
			rmSync(this.directory, { recursive: true, force: true });
		} catch {
			// Nothing to do: the next sweep will try again.
		}
	}

	/**
	 * Remove session directories whose own files are all older than `maxAgeMs`.
	 * Directories without this cache's files are left alone, so a wrong root
	 * cannot delete somebody else's data. Returns how many were removed.
	 */
	static sweepStale(root: string, maxAgeMs: number, now = Date.now()): number {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			return 0;
		}

		let removed = 0;
		for (const entry of entries) {
			const directory = join(root, entry);
			let all: string[];
			try {
				if (!statSync(directory).isDirectory()) continue;
				all = readdirSync(directory);
			} catch {
				continue;
			}
			const files = all.filter((file) => OWN_FILE.test(file));
			if (files.length === 0) continue; // not ours
			// A directory holding anything this cache did not write is somebody
			// else's too, so the sweep leaves it alone.
			if (files.length !== all.length) continue;

			let newest = 0;
			for (const file of files) {
				try {
					newest = Math.max(newest, statSync(join(directory, file)).mtimeMs);
				} catch {
					// a file that vanished cannot keep the directory alive
				}
			}
			if (now - newest <= maxAgeMs) continue;

			try {
				rmSync(directory, { recursive: true, force: true });
				removed += 1;
			} catch {
				// leave it for the next sweep
			}
		}
		return removed;
	}
}

/** `image-<id>.<ext>`, exported for callers that need to recognise a cached file. */
export function isCachedImageFile(name: string): boolean {
	return OWN_FILE.test(basename(name));
}
