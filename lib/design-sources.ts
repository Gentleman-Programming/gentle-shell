import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

// Design sources (S13): the files a design-system sync reads, found by a
// bounded, deterministic walk of the project, so the gentle_design tool can
// say whether design/system.md is missing or older than them.
//
// A design source is:
// - tailwind.config.{js,cjs,mjs,ts};
// - a .css/.scss/.pcss file that contains `@theme`, or declares a custom
//   property (`--name:`) in the first block of a `:root` or `[data-theme…]`
//   rule (comments are ignored; nested blocks are not parsed);
// - a .json/.js/.ts/.css file whose name contains "token" (any case);
// - theme.{js,ts} that exports something (`export` or `module.exports`) and
//   has a `colors:`/`colours:` (or `=`) key, a heuristic for a color theme.
//
// The walk visits entries in name order, never follows symlinks, skips
// dependency, build and VCS directories, every dot-directory and the root
// design/ (the sync's own output), enters at most maxDepth directory levels,
// stops after maxFiles files, and reads at most maxBytes of each file.

export const DESIGN_SOURCE_LIMITS = { maxDepth: 6, maxFiles: 5000, maxBytes: 256 * 1024 } as const;

const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const TAILWIND_CONFIG = /^tailwind\.config\.(?:js|cjs|mjs|ts)$/;
// "tokens" as a whole word of the base name (tokens.json, design-tokens.ts,
// theme.tokens.css), never auth or tokenizer files (token.ts, refreshToken.ts)
// and never tests.
const TOKEN_FILE = /^(?:.*[.\-_])?tokens(?:[.\-_].*)?\.(?:json|js|ts|css)$/i;
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/i;
const STYLESHEET = /\.(?:css|scss|pcss)$/;
const THEME_FILE = /^theme\.(?:js|ts)$/;
const CUSTOM_PROPERTY_IN_THEME_BLOCK = /(?::root|\[data-theme[^\]]*\])[^{};]*\{[^}]*--[\w-]+\s*:/;

// One read buffer for the whole synchronous walk; readHead copies out of it.
const HEAD = Buffer.allocUnsafe(DESIGN_SOURCE_LIMITS.maxBytes);

function readHead(path: string): string {
	const fd = openSync(path, "r");
	try {
		const buffer = HEAD;
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, length);
			if (read === 0) break;
			length += read;
		}
		return buffer.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
}

function isDesignSource(name: string, path: string): boolean {
	if (TAILWIND_CONFIG.test(name) || (TOKEN_FILE.test(name) && !TEST_FILE.test(name))) return true;
	if (STYLESHEET.test(name)) {
		const css = readHead(path).replace(/\/\*[\s\S]*?\*\//g, "");
		return css.includes("@theme") || CUSTOM_PROPERTY_IN_THEME_BLOCK.test(css);
	}
	if (THEME_FILE.test(name)) {
		const source = readHead(path);
		return /\bexport\b|module\.exports/.test(source) && /\bcolou?rs\s*[:=]/.test(source);
	}
	return false;
}

function entries(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	} catch {
		// An unreadable or vanished directory has no sources.
		return [];
	}
}

/** Repository-relative paths (with "/") of the project's design sources, sorted. */
export function detectDesignSources(cwd: string): string[] {
	const found: string[] = [];
	let files = 0;
	const walk = (dir: string, relative: string, depth: number): boolean => {
		for (const entry of entries(dir)) {
			// Dirent types come from lstat, so a symlink is neither a file nor a directory here.
			const path = join(dir, entry.name);
			const rel = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name) || (depth === 0 && entry.name === "design")) continue;
				if (depth + 1 > DESIGN_SOURCE_LIMITS.maxDepth) continue;
				if (!walk(path, rel, depth + 1)) return false;
			} else if (entry.isFile()) {
				if (++files > DESIGN_SOURCE_LIMITS.maxFiles) return false;
				try {
					if (isDesignSource(entry.name, path)) found.push(rel);
				} catch {
					// A file that cannot be read is not a source.
				}
			}
		}
		return true;
	};
	walk(cwd, "", 0);
	return found.sort();
}

function mtime(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/** The sources modified after design/system.md; none when that file is missing. */
export function staleDesignSources(cwd: string, sources: readonly string[]): string[] {
	const system = mtime(join(cwd, "design", "system.md"));
	if (system === undefined) return [];
	return sources.filter((source) => {
		const changed = mtime(join(cwd, source));
		return changed !== undefined && changed > system;
	});
}
