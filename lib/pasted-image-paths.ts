import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { sniffImageMimeType, type ClipboardImage } from "./clipboard-image.ts";

// Some terminals hand an image over as a path instead of clipboard bytes.
// Herdr does this for a terminal on another machine: the desktop app and
// `herdr --remote` write the clipboard image to a temp file there and paste
// its path (`herdr-paste-*.png`, `client-N-clipboard-*.png`). Dropping an image
// on a Herdr pane, or copying files in a file manager, arrives the same way:
// quoted paths. A paste made only of image paths becomes chips like a
// clipboard image, so the model sees the picture instead of a path string.

const MAX_PASTED_PATHS = 8;
const MAX_PASTED_BYTES = 64 * 1024 * 1024;
const IMAGE_PATH_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

export interface PastedImagePathOptions {
	/** Test seam: read a file's bytes. */
	readFile?(path: string): Uint8Array;
	/** Test seam: does a regular file exist at this path? */
	isFile?(path: string): boolean;
	/** Test seam: the home directory `~/` expands to. */
	home?: string;
}

/**
 * Whitespace-separated shell-like tokens. Herdr quotes each dropped file with
 * single quotes and escapes an embedded quote as `'\''`; terminals that paste
 * several files quote them the same way. Newlines separate tokens too.
 */
export function parsePathTokens(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (/\s/.test(char)) {
			if (started) { tokens.push(current); current = ""; started = false; }
			continue;
		}
		started = true;
		if (char === "'") {
			// Close, escaped quote, reopen (`'\''`) is one literal quote.
			for (index += 1; index < text.length; index += 1) {
				if (text[index] !== "'") { current += text[index]; continue; }
				if (text[index + 1] === "\\" && text[index + 2] === "'" && text[index + 3] === "'") {
					current += "'";
					index += 3;
					continue;
				}
				break;
			}
			continue;
		}
		if (char === '"') {
			for (index += 1; index < text.length; index += 1) {
				if (text[index] === "\\" && (text[index + 1] === '"' || text[index + 1] === "\\")) { current += text[index + 1]; index += 1; continue; }
				if (text[index] === '"') break;
				current += text[index];
			}
			continue;
		}
		if (char === "\\" && index + 1 < text.length) { current += text[index + 1]; index += 1; continue; }
		current += char;
	}
	if (started) tokens.push(current);
	return tokens;
}

/** Absolute path for one token, or undefined when it cannot name a local file. */
function resolveToken(token: string, home: string): string | undefined {
	if (/[\u0000-\u001f\u007f]/.test(token)) return undefined;
	let path = token;
	if (path.startsWith("file://")) {
		try { path = decodeURIComponent(path.slice("file://".length)); } catch { return undefined; }
	}
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = `${home}${path.slice(1)}`;
	return isAbsolute(path) ? path : undefined;
}

/**
 * Images from a paste whose entire text is image paths, in paste order.
 * Anything else — text, a sentence that mentions a path, a missing or
 * unsupported file — returns [] so Pi's own paste handler runs unchanged.
 */
export function readPastedImagePaths(text: string, options: PastedImagePathOptions = {}): ClipboardImage[] {
	const tokens = parsePathTokens(text);
	if (tokens.length === 0 || tokens.length > MAX_PASTED_PATHS) return [];
	const home = options.home ?? homedir();
	const readFile = options.readFile ?? ((path: string) => readFileSync(path));
	const isFile = options.isFile ?? ((path: string) => {
		try { return statSync(path).isFile(); } catch { return false; }
	});
	const images: ClipboardImage[] = [];
	for (const token of tokens) {
		const path = resolveToken(token, home);
		if (!path || !IMAGE_PATH_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) return [];
		if (!isFile(path)) return [];
		let bytes: Uint8Array;
		try { bytes = readFile(path); } catch { return []; }
		if (bytes.length === 0 || bytes.length > MAX_PASTED_BYTES) return [];
		// The extension only narrows the candidates; the bytes decide the type.
		const mimeType = sniffImageMimeType(bytes);
		if (!mimeType) return [];
		images.push({ bytes, mimeType });
	}
	return images;
}
