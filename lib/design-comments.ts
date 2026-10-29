import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { extname, join, sep } from "node:path";

// The single owner of design/<slug>/comments.json (S9). The canvas server and
// the agent tool both write through this module, so every write to one file
// runs in a per-file in-process queue, re-reads the file just before writing,
// and replaces it atomically with a temp file + rename. A file this module
// cannot parse is reported and never overwritten.

export const DESIGN_COMMENTS_FILE = "comments.json";
export const MAX_DESIGN_COMMENTS = 500;
export const DESIGN_COMMENT_LIMITS = Object.freeze({ comment: 2000, selector: 500, excerpt: 300 });

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_ATTEMPTS = 8;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** One screenshot per comment, stored as design/<slug>/.screenshots/<id>.<ext>. */
export const MAX_DESIGN_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const DESIGN_SCREENSHOTS_DIR = ".screenshots";
export const DESIGN_SCREENSHOT_TYPES: Readonly<Record<string, string>> = Object.freeze({
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
});
const SCREENSHOT_PATH = /^\.screenshots\/[A-Za-z0-9_-]{1,32}\.(png|jpg|webp|gif)$/;

export type DesignCommentStatus = "open" | "resolved";

export type StoredDesignComment = {
	id: string;
	file: string;
	selector: string;
	excerpt: string;
	comment: string;
	createdAt: string;
	status: DesignCommentStatus;
	sentAt: string | null;
	resolvedAt: string | null;
	/** `.screenshots/<id>.<ext>`, relative to the design directory; absent when the comment has none. */
	screenshot?: string;
};

export type DesignCommentsDocument = { version: 1; comments: StoredDesignComment[] };

export type DesignScreenshotInput = { mimeType: string; data: Buffer };

export type DesignCommentInput = { file: string; selector: string; excerpt: string; comment: string; screenshot?: DesignScreenshotInput };

export type DesignScreenshot = { path: string; mimeType: string; data: Buffer };

export type DesignCommentsErrorCode = "not-found" | "invalid-file" | "invalid-input" | "limit" | "id-exhausted";

export class DesignCommentsError extends Error {
	readonly code: DesignCommentsErrorCode;
	constructor(code: DesignCommentsErrorCode, message: string) {
		super(message);
		this.name = "DesignCommentsError";
		this.code = code;
	}
}

export interface DesignCommentStoreDeps {
	now?: () => Date;
	randomId?: () => string;
}

export interface DesignCommentStore {
	/** The design's comments; a missing comments.json is an empty document. */
	read(slug: string): Promise<DesignCommentsDocument>;
	add(slug: string, input: DesignCommentInput): Promise<StoredDesignComment>;
	setStatus(slug: string, ids: readonly string[], status: DesignCommentStatus): Promise<{ updated: StoredDesignComment[]; unknown: string[] }>;
	/** Stamps sentAt on comments that have none yet. */
	markSent(slug: string, ids: readonly string[]): Promise<StoredDesignComment[]>;
	listOpen(slug: string, file?: string): Promise<StoredDesignComment[]>;
	/** The screenshot of comment `id`, or undefined when there is no such comment, it has none, or the file is gone. */
	readScreenshot(slug: string, id: string): Promise<DesignScreenshot | undefined>;
}

// Keyed by the real path of each design file (comments.json, handoffs.json),
// shared by every store in this process.
const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task queued for `key`, the real path of the file it writes. */
export function serializeDesignWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const run = previous.then(task, task);
	const settled = run.then(() => undefined, () => undefined);
	queues.set(key, settled);
	void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
	return run;
}

function within(root: string, target: string): boolean {
	return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/**
 * Real `<root>/<slug>/<name>` path of a design-owned file, refusing a slug that
 * escapes the real design root and a `name` that is not a regular file (a link
 * would make the atomic rename replace the link, not its target). `notFound`
 * builds the caller's typed error from the message.
 */
export async function locateDesignFile(designRoot: string, slug: string, name: string, notFound: (message: string) => Error): Promise<{ dir: string; path: string }> {
	const missing = notFound(`No design "${slug}" in design/.`);
	if (typeof slug !== "string" || !SLUG.test(slug)) throw missing;
	let root: string;
	let dir: string;
	try {
		root = await realpath(designRoot);
		dir = await realpath(join(root, slug));
	} catch (error) {
		if (isMissing(error)) throw missing;
		throw error;
	}
	if (!within(root, dir) || !(await lstat(dir)).isDirectory()) throw missing;
	const path = join(dir, name);
	try {
		if (!(await lstat(path)).isFile()) throw notFound(`design/${slug}/${name} must be a regular file.`);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	return { dir, path };
}

/** The UTF-8 content of `path`, or undefined when it does not exist; `tooLarge` is thrown past `maxBytes`. */
export async function readDesignFile(path: string, maxBytes: number, tooLarge: () => Error): Promise<string | undefined> {
	try {
		const handle = await open(path, "r");
		try {
			if ((await handle.stat()).size > maxBytes) throw tooLarge();
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** Replaces `<dir>/<name>` (at `path`) atomically: a synced temp file in the same directory, then rename. */
export async function replaceDesignFile(dir: string, path: string, name: string, content: string | Buffer): Promise<void> {
	const temp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
	const handle = await open(temp, "wx", 0o644);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}

/** A relative `.html` path of plain segments, such as `sub/01-a.html`. */
export function isArtboardPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
	const parts = value.split("/");
	if (parts.some((part) => part === "" || part.startsWith(".") || /[\\\0:]/.test(part) || /[\u0000-\u001f\u007f]/.test(part))) return false;
	return extname(parts[parts.length - 1]).toLowerCase() === ".html";
}

/**
 * `value` cut to at most `max` UTF-16 code units, the unit every comment limit
 * uses, dropping a surrogate pair whole rather than splitting it.
 */
export function truncateUtf16(value: string, max: number): string {
	const cut = value.length > max ? value.slice(0, max) : value;
	// A trailing high surrogate is half a pair, whether this cut or the canvas's split it.
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function isDesignCommentId(value: unknown): value is string {
	return typeof value === "string" && ID.test(value);
}

function inputProblem(input: DesignCommentInput): string | undefined {
	if (!input || typeof input !== "object") return "a comment must be an object";
	if (!isArtboardPath(input.file)) return "file must be a relative .html path inside the design";
	if (typeof input.selector !== "string" || input.selector.length < 1 || input.selector.length > DESIGN_COMMENT_LIMITS.selector) return `selector must have 1 to ${DESIGN_COMMENT_LIMITS.selector} characters`;
	if (typeof input.excerpt !== "string" || input.excerpt.length > DESIGN_COMMENT_LIMITS.excerpt) return `excerpt must have at most ${DESIGN_COMMENT_LIMITS.excerpt} characters`;
	if (typeof input.comment !== "string" || input.comment.length < 1 || input.comment.length > DESIGN_COMMENT_LIMITS.comment) return `comment must have 1 to ${DESIGN_COMMENT_LIMITS.comment} characters`;
	return undefined;
}

function hasSignature(data: Buffer, mimeType: string): boolean {
	const ascii = (start: number, end: number) => data.subarray(start, end).toString("latin1");
	if (mimeType === "image/png") return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
	if (mimeType === "image/gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
	if (mimeType === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
	return false;
}

function screenshotProblem(screenshot: DesignScreenshotInput): string | undefined {
	if (!screenshot || typeof screenshot !== "object") return "screenshot must be an object";
	if (typeof screenshot.mimeType !== "string" || !Object.hasOwn(DESIGN_SCREENSHOT_TYPES, screenshot.mimeType)) return "screenshot must be a PNG, JPEG, WebP or GIF image";
	if (!Buffer.isBuffer(screenshot.data) || screenshot.data.length === 0) return "screenshot is empty";
	if (screenshot.data.length > MAX_DESIGN_SCREENSHOT_BYTES) return `screenshot must be at most ${MAX_DESIGN_SCREENSHOT_BYTES} bytes`;
	if (!hasSignature(screenshot.data, screenshot.mimeType)) return `screenshot content is not ${screenshot.mimeType}`;
	return undefined;
}

function isTimestamp(value: unknown): boolean {
	return typeof value === "string" && value.length <= 64;
}

function parseDocument(raw: string): DesignCommentsDocument {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new DesignCommentsError("invalid-file", "comments.json is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesignCommentsError("invalid-file", "comments.json must be a JSON object");
	const record = value as Record<string, unknown>;
	if (record.version !== 1) throw new DesignCommentsError("invalid-file", "comments.json version must be 1");
	if (!Array.isArray(record.comments)) throw new DesignCommentsError("invalid-file", "comments.json comments must be an array");
	const seen = new Set<string>();
	const comments = record.comments.map((entry: unknown, index: number): StoredDesignComment => {
		const where = `comments[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new DesignCommentsError("invalid-file", `${where} must be an object`);
		const item = entry as Record<string, unknown>;
		if (!isDesignCommentId(item.id) || seen.has(item.id)) throw new DesignCommentsError("invalid-file", `${where}.id must be a unique id of letters, digits, _ or -`);
		seen.add(item.id);
		const problem = inputProblem(item as unknown as DesignCommentInput);
		if (problem) throw new DesignCommentsError("invalid-file", `${where}: ${problem}`);
		if (!isTimestamp(item.createdAt)) throw new DesignCommentsError("invalid-file", `${where}.createdAt must be a string`);
		if (item.status !== "open" && item.status !== "resolved") throw new DesignCommentsError("invalid-file", `${where}.status must be "open" or "resolved"`);
		for (const key of ["sentAt", "resolvedAt"] as const) {
			if (item[key] !== null && !isTimestamp(item[key])) throw new DesignCommentsError("invalid-file", `${where}.${key} must be a string or null`);
		}
		if (item.screenshot !== undefined && (typeof item.screenshot !== "string" || !SCREENSHOT_PATH.test(item.screenshot))) {
			throw new DesignCommentsError("invalid-file", `${where}.screenshot must be a .screenshots/<id>.<png|jpg|webp|gif> path`);
		}
		const comment: StoredDesignComment = {
			id: item.id,
			file: item.file as string,
			selector: item.selector as string,
			excerpt: item.excerpt as string,
			comment: item.comment as string,
			createdAt: item.createdAt as string,
			status: item.status,
			sentAt: item.sentAt as string | null,
			resolvedAt: item.resolvedAt as string | null,
		};
		if (typeof item.screenshot === "string") comment.screenshot = item.screenshot;
		return comment;
	});
	return { version: 1, comments };
}

function defaultRandomId(): string {
	return Array.from(randomBytes(8), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

export function createDesignCommentStore(designRoot: string, deps: DesignCommentStoreDeps = {}): DesignCommentStore {
	const now = deps.now ?? (() => new Date());
	const randomId = deps.randomId ?? defaultRandomId;

	/** Real comments.json path inside `<root>/<slug>`, refusing any escape or a non-file comments.json. */
	function locate(slug: string): Promise<{ dir: string; path: string }> {
		return locateDesignFile(designRoot, slug, DESIGN_COMMENTS_FILE, (message) => new DesignCommentsError("not-found", message));
	}

	async function load(path: string): Promise<DesignCommentsDocument> {
		const raw = await readDesignFile(path, MAX_FILE_BYTES, () => new DesignCommentsError("invalid-file", "comments.json is too large"));
		return raw === undefined ? { version: 1, comments: [] } : parseDocument(raw);
	}

	function save(dir: string, path: string, document: DesignCommentsDocument): Promise<void> {
		return replaceDesignFile(dir, path, DESIGN_COMMENTS_FILE, `${JSON.stringify(document, null, 2)}\n`);
	}

	/** Read-modify-write in the file's queue; `change` sets `write: false` when nothing changed. */
	async function mutate<T>(slug: string, change: (document: DesignCommentsDocument) => { result: T; write: boolean }): Promise<T> {
		const { dir, path } = await locate(slug);
		return serializeDesignWrite(path, async () => {
			const document = await load(path);
			const { result, write } = change(document);
			if (write) await save(dir, path, document);
			return result;
		});
	}

	/**
	 * `<dir>/.screenshots` when it is a real directory (never a link), created when
	 * `create` is set; undefined when it is missing and not created.
	 */
	async function screenshotsDir(dir: string, slug: string, create: boolean): Promise<string | undefined> {
		const shots = join(dir, DESIGN_SCREENSHOTS_DIR);
		const refused = new DesignCommentsError("invalid-file", `design/${slug}/${DESIGN_SCREENSHOTS_DIR} must be a directory`);
		try {
			if (!(await lstat(shots)).isDirectory()) throw refused;
			return shots;
		} catch (error) {
			if (error === refused || !isMissing(error)) throw error;
		}
		if (!create) return undefined;
		await mkdir(shots).catch((error: NodeJS.ErrnoException) => { if (error?.code !== "EEXIST") throw error; });
		if (!(await lstat(shots)).isDirectory()) throw refused;
		return shots;
	}

	async function read(slug: string): Promise<DesignCommentsDocument> {
		return load((await locate(slug)).path);
	}

	return {
		read,

		async add(slug, input) {
			const problem = inputProblem(input) ?? (input.screenshot === undefined ? undefined : screenshotProblem(input.screenshot));
			if (problem) throw new DesignCommentsError("invalid-input", problem);
			const { dir, path } = await locate(slug);
			return serializeDesignWrite(path, async () => {
				const document = await load(path);
				if (document.comments.length >= MAX_DESIGN_COMMENTS) {
					throw new DesignCommentsError("limit", `design/${slug} already has ${MAX_DESIGN_COMMENTS} comments, the most a design can hold. Delete resolved comments from comments.json to add more.`);
				}
				const taken = new Set(document.comments.map((comment) => comment.id));
				let id: string | undefined;
				for (let attempt = 0; attempt < ID_ATTEMPTS && id === undefined; attempt++) {
					const candidate = randomId();
					if (isDesignCommentId(candidate) && !taken.has(candidate)) id = candidate;
				}
				if (id === undefined) throw new DesignCommentsError("id-exhausted", "No unique comment id could be generated.");
				const comment: StoredDesignComment = {
					id,
					file: input.file,
					selector: input.selector,
					excerpt: input.excerpt,
					comment: input.comment,
					createdAt: now().toISOString(),
					status: "open",
					sentAt: null,
					resolvedAt: null,
				};
				let image: string | undefined;
				if (input.screenshot) {
					const name = `${id}.${DESIGN_SCREENSHOT_TYPES[input.screenshot.mimeType]}`;
					const shots = (await screenshotsDir(dir, slug, true))!;
					image = join(shots, name);
					await replaceDesignFile(shots, image, name, input.screenshot.data);
					comment.screenshot = `${DESIGN_SCREENSHOTS_DIR}/${name}`;
				}
				document.comments.push(comment);
				try {
					await save(dir, path, document);
				} catch (error) {
					if (image) await unlink(image).catch(() => {});
					throw error;
				}
				return comment;
			});
		},

		async setStatus(slug, ids, status) {
			if (status !== "open" && status !== "resolved") throw new DesignCommentsError("invalid-input", 'status must be "open" or "resolved"');
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new DesignCommentsError("invalid-input", "ids must be an array of strings");
			return mutate(slug, (document) => {
				const wanted = new Set(ids);
				const updated: StoredDesignComment[] = [];
				let write = false;
				for (const comment of document.comments) {
					if (!wanted.has(comment.id)) continue;
					if (comment.status !== status) {
						comment.status = status;
						comment.resolvedAt = status === "resolved" ? now().toISOString() : null;
						write = true;
					}
					updated.push(comment);
				}
				const found = new Set(updated.map((comment) => comment.id));
				return { result: { updated, unknown: [...wanted].filter((id) => !found.has(id)) }, write };
			});
		},

		async markSent(slug, ids) {
			return mutate(slug, (document) => {
				const wanted = new Set(ids);
				const updated: StoredDesignComment[] = [];
				for (const comment of document.comments) {
					if (!wanted.has(comment.id) || comment.sentAt !== null) continue;
					comment.sentAt = now().toISOString();
					updated.push(comment);
				}
				return { result: updated, write: updated.length > 0 };
			});
		},

		async readScreenshot(slug, id) {
			const { dir, path } = await locate(slug);
			const stored = (await load(path)).comments.find((comment) => comment.id === id);
			if (!stored?.screenshot) return undefined;
			const shots = await screenshotsDir(dir, slug, false);
			if (!shots) return undefined;
			const name = stored.screenshot.slice(DESIGN_SCREENSHOTS_DIR.length + 1);
			const target = join(shots, name);
			const ext = extname(name).slice(1);
			const mimeType = Object.keys(DESIGN_SCREENSHOT_TYPES).find((type) => DESIGN_SCREENSHOT_TYPES[type] === ext)!;
			try {
				if (!(await lstat(target)).isFile()) return undefined;
				const handle = await open(target, "r");
				try {
					const info = await handle.stat();
					if (!info.isFile() || info.size > MAX_DESIGN_SCREENSHOT_BYTES) return undefined;
					return { path: stored.screenshot, mimeType, data: await handle.readFile() };
				} finally {
					await handle.close();
				}
			} catch (error) {
				if (isMissing(error)) return undefined;
				throw error;
			}
		},

		async listOpen(slug, file) {
			const { comments } = await read(slug);
			return comments.filter((comment) => comment.status === "open" && (file === undefined || comment.file === file));
		},
	};
}
