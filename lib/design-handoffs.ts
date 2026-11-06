import { isArtboardPath, locateDesignFile, readDesignFile, replaceDesignFile, serializeDesignWrite } from "./design-comments.ts";

// The single owner of design/<slug>/handoffs.json (S15): the handoff state of
// each artboard and the design's chosen artboard. The canvas server (Implement
// this), the command and the gentle_design tool all write through this module,
// in the same per-file in-process queue as comments.json, re-reading the file
// before every write and replacing it with a temp file + rename. A file this
// module cannot parse is reported and never overwritten.

export const DESIGN_HANDOFFS_FILE = "handoffs.json";
export const DESIGN_HANDOFF_NOTE_LIMIT = 1000;
export const DESIGN_PREVIEW_URL_LIMIT = 2048;
const MAX_HANDOFFS = 256;
const MAX_FILE_BYTES = 1024 * 1024;
/** The hosts a preview may name: the loopback interface only, as the URL parser normalizes them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The ODD feature document a design links to (S10): a repository-relative `odd/tasks/<name>.md`. */
export const DESIGN_FEATURE_PATH = /^odd\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export type DesignHandoffStatus = "sent" | "in_progress" | "implemented";

export type DesignHandoff = {
	status: DesignHandoffStatus;
	/** The agent was busy when it was sent, so it waits as a follow-up. */
	queued: boolean;
	sentAt: string;
	startedAt: string | null;
	implementedAt: string | null;
	feature?: string;
	note?: string;
	previewUrl?: string;
};

export type DesignHandoffsDocument = { version: 1; chosen: string | null; handoffs: Record<string, DesignHandoff> };

/** What markSent replaced, so a failed delivery can put it back. */
export type DesignHandoffSent = { file: string; entry: DesignHandoff; previousEntry: DesignHandoff | undefined; previousChosen: string | null };

export type DesignHandoffsErrorCode = "not-found" | "invalid-file" | "invalid-input" | "invalid-preview-url" | "limit";

export class DesignHandoffsError extends Error {
	readonly code: DesignHandoffsErrorCode;
	constructor(code: DesignHandoffsErrorCode, message: string) {
		super(message);
		this.name = "DesignHandoffsError";
		this.code = code;
	}
}

export interface DesignHandoffStoreDeps {
	now?: () => Date;
}

export interface DesignHandoffStore {
	/** The design's handoffs; a missing handoffs.json is an empty document. */
	read(slug: string): Promise<DesignHandoffsDocument>;
	/** A new handoff of `file`: status sent, its timestamps reset, and `file` becomes the chosen artboard. */
	markSent(slug: string, file: string, options: { queued: boolean; feature?: string }): Promise<DesignHandoffSent>;
	/**
	 * The agent's progress on `file`. `note` and `previewUrl` become exactly what this call passes.
	 * An artboard with no handoff yet is recorded as handed off now and becomes the chosen one.
	 */
	setStatus(slug: string, file: string, status: Exclude<DesignHandoffStatus, "sent">, options: { note?: string; previewUrl?: string }): Promise<DesignHandoff>;
	/** Marks the handoff `sent` recorded as queued, unless it changed since; true when it was updated. */
	markQueued(slug: string, sent: DesignHandoffSent): Promise<boolean>;
	/** Puts back what `sent` replaced, unless the handoff changed since; true when it was restored. */
	revertSent(slug: string, sent: DesignHandoffSent): Promise<boolean>;
}

/**
 * Why `value` cannot be a preview URL, or undefined when it can: an http(s) URL
 * of the loopback interface (localhost, 127.0.0.1 or [::1], any port), without
 * credentials, whitespace or control characters, at most 2048 characters.
 */
export function designPreviewUrlProblem(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return "previewUrl must be a non-empty string";
	if (value.length > DESIGN_PREVIEW_URL_LIMIT) return `previewUrl must have at most ${DESIGN_PREVIEW_URL_LIMIT} characters`;
	// The URL parser silently drops tabs and newlines and trims spaces; refuse them instead.
	if (/[\s\u0000-\u001f\u007f]/.test(value)) return "previewUrl must not contain whitespace or control characters";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "previewUrl must be an absolute URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "previewUrl must use http or https";
	if (url.username || url.password) return "previewUrl must not carry credentials";
	if (!LOOPBACK_HOSTS.has(url.hostname)) return "previewUrl must point at localhost, 127.0.0.1 or [::1]";
	if (url.href.length > DESIGN_PREVIEW_URL_LIMIT) return `previewUrl must have at most ${DESIGN_PREVIEW_URL_LIMIT} characters`;
	return undefined;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function noteProblem(value: unknown): string | undefined {
	if (typeof value !== "string") return "note must be a string";
	if (value.length > DESIGN_HANDOFF_NOTE_LIMIT) return `note must have at most ${DESIGN_HANDOFF_NOTE_LIMIT} characters`;
	return undefined;
}

function normalizeNote(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

/** The entry with its keys in a stable order and no absent optional keys. */
function entryOf(fields: DesignHandoff): DesignHandoff {
	const entry: DesignHandoff = {
		status: fields.status,
		queued: fields.queued,
		sentAt: fields.sentAt,
		startedAt: fields.startedAt,
		implementedAt: fields.implementedAt,
	};
	if (fields.feature !== undefined) entry.feature = fields.feature;
	if (fields.note !== undefined) entry.note = fields.note;
	if (fields.previewUrl !== undefined) entry.previewUrl = fields.previewUrl;
	return entry;
}

function sameEntry(a: DesignHandoff | undefined, b: DesignHandoff | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function invalid(message: string): DesignHandoffsError {
	return new DesignHandoffsError("invalid-file", message);
}

function parseEntry(where: string, value: unknown): DesignHandoff {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${where} must be an object`);
	const item = value as Record<string, unknown>;
	if (item.status !== "sent" && item.status !== "in_progress" && item.status !== "implemented") throw invalid(`${where}.status must be "sent", "in_progress" or "implemented"`);
	if (typeof item.queued !== "boolean") throw invalid(`${where}.queued must be true or false`);
	if (!isTimestamp(item.sentAt)) throw invalid(`${where}.sentAt must be a timestamp`);
	for (const key of ["startedAt", "implementedAt"] as const) {
		if (item[key] !== null && !isTimestamp(item[key])) throw invalid(`${where}.${key} must be a timestamp or null`);
	}
	if (item.feature !== undefined && !(typeof item.feature === "string" && DESIGN_FEATURE_PATH.test(item.feature))) throw invalid(`${where}.feature must be a relative odd/tasks/<name>.md path`);
	if (item.note !== undefined) {
		const problem = noteProblem(item.note);
		if (problem) throw invalid(`${where}.${problem}`);
	}
	if (item.previewUrl !== undefined) {
		const problem = designPreviewUrlProblem(item.previewUrl);
		if (problem) throw invalid(`${where}.${problem}`);
	}
	return entryOf(item as unknown as DesignHandoff);
}

function parseDocument(raw: string): DesignHandoffsDocument {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw invalid("handoffs.json is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("handoffs.json must be a JSON object");
	const record = value as Record<string, unknown>;
	if (record.version !== 1) throw invalid("handoffs.json version must be 1");
	if (!record.handoffs || typeof record.handoffs !== "object" || Array.isArray(record.handoffs)) throw invalid("handoffs.json handoffs must be an object");
	const entries = Object.entries(record.handoffs as Record<string, unknown>);
	if (entries.length > MAX_HANDOFFS) throw invalid(`handoffs.json may hold at most ${MAX_HANDOFFS} handoffs`);
	// Keys are artboard paths ending in .html, so no key can name an Object prototype member.
	const handoffs: Record<string, DesignHandoff> = {};
	for (const [file, entry] of entries) {
		if (!isArtboardPath(file)) throw invalid(`handoffs.json key ${JSON.stringify(file)} must be a relative .html artboard path`);
		handoffs[file] = parseEntry(`handoffs[${JSON.stringify(file)}]`, entry);
	}
	const chosen = record.chosen ?? null;
	if (chosen === null) return { version: 1, chosen: null, handoffs };
	if (typeof chosen !== "string" || !Object.hasOwn(handoffs, chosen)) throw invalid("handoffs.json chosen must be null or an artboard with a handoff");
	return { version: 1, chosen, handoffs };
}

export function createDesignHandoffStore(designRoot: string, deps: DesignHandoffStoreDeps = {}): DesignHandoffStore {
	const now = deps.now ?? (() => new Date());

	function locate(slug: string): Promise<{ dir: string; path: string }> {
		return locateDesignFile(designRoot, slug, DESIGN_HANDOFFS_FILE, (message) => new DesignHandoffsError("not-found", message));
	}

	async function load(path: string): Promise<DesignHandoffsDocument> {
		const raw = await readDesignFile(path, MAX_FILE_BYTES, () => invalid("handoffs.json is too large"));
		return raw === undefined ? { version: 1, chosen: null, handoffs: {} } : parseDocument(raw);
	}

	/** Read-modify-write in the file's queue; `change` sets `write: false` when nothing changed. */
	async function mutate<T>(slug: string, change: (document: DesignHandoffsDocument) => { result: T; write: boolean }): Promise<T> {
		const { dir, path } = await locate(slug);
		return serializeDesignWrite(path, async () => {
			const document = await load(path);
			const { result, write } = change(document);
			if (write) await replaceDesignFile(dir, path, DESIGN_HANDOFFS_FILE, `${JSON.stringify(document, null, 2)}\n`);
			return result;
		});
	}

	function checkFile(file: unknown): asserts file is string {
		if (!isArtboardPath(file)) throw new DesignHandoffsError("invalid-input", "file must be a relative .html path inside the design");
	}

	function checkRoom(document: DesignHandoffsDocument, slug: string, file: string): void {
		if (!Object.hasOwn(document.handoffs, file) && Object.keys(document.handoffs).length >= MAX_HANDOFFS) {
			throw new DesignHandoffsError("limit", `design/${slug} already has ${MAX_HANDOFFS} handoffs, the most a design can hold.`);
		}
	}

	return {
		async read(slug) {
			return load((await locate(slug)).path);
		},

		async markSent(slug, file, options) {
			checkFile(file);
			if (!options || typeof options.queued !== "boolean") throw new DesignHandoffsError("invalid-input", "queued must be true or false");
			if (options.feature !== undefined && !(typeof options.feature === "string" && DESIGN_FEATURE_PATH.test(options.feature))) {
				throw new DesignHandoffsError("invalid-input", "feature must be a relative odd/tasks/<name>.md path");
			}
			return mutate(slug, (document) => {
				checkRoom(document, slug, file);
				const previousEntry = Object.hasOwn(document.handoffs, file) ? document.handoffs[file] : undefined;
				const previousChosen = document.chosen;
				const entry = entryOf({ status: "sent", queued: options.queued, sentAt: now().toISOString(), startedAt: null, implementedAt: null, feature: options.feature });
				document.handoffs[file] = entry;
				document.chosen = file;
				return { result: { file, entry, previousEntry, previousChosen }, write: true };
			});
		},

		async setStatus(slug, file, status, options) {
			checkFile(file);
			if (status !== "in_progress" && status !== "implemented") throw new DesignHandoffsError("invalid-input", 'status must be "in_progress" or "implemented"');
			const { note, previewUrl } = options ?? {};
			if (note !== undefined) {
				const problem = noteProblem(note);
				if (problem) throw new DesignHandoffsError("invalid-input", problem);
			}
			let preview: string | undefined;
			if (previewUrl !== undefined) {
				const problem = designPreviewUrlProblem(previewUrl);
				if (problem) throw new DesignHandoffsError("invalid-preview-url", problem);
				preview = new URL(previewUrl).href;
			}
			const cleanNote = note === undefined ? undefined : normalizeNote(note) || undefined;
			return mutate(slug, (document) => {
				checkRoom(document, slug, file);
				const stamp = now().toISOString();
				const current = Object.hasOwn(document.handoffs, file) ? document.handoffs[file] : undefined;
				const base = current ?? { status, queued: false, sentAt: stamp, startedAt: null, implementedAt: null };
				const entry = entryOf({
					...base,
					status,
					startedAt: status === "in_progress" ? stamp : base.startedAt,
					implementedAt: status === "implemented" ? stamp : null,
					note: cleanNote,
					previewUrl: preview,
				});
				document.handoffs[file] = entry;
				// Progress on an artboard nobody handed off is itself the choice of that artboard.
				if (!current) document.chosen = file;
				return { result: entry, write: true };
			});
		},

		async markQueued(slug, sent) {
			return mutate(slug, (document) => {
				const current = Object.hasOwn(document.handoffs, sent.file) ? document.handoffs[sent.file] : undefined;
				if (!sameEntry(current, sent.entry) || sent.entry.queued) return { result: false, write: false };
				document.handoffs[sent.file] = entryOf({ ...sent.entry, queued: true });
				return { result: true, write: true };
			});
		},

		async revertSent(slug, sent) {
			return mutate(slug, (document) => {
				const current = Object.hasOwn(document.handoffs, sent.file) ? document.handoffs[sent.file] : undefined;
				if (!sameEntry(current, sent.entry)) return { result: false, write: false };
				if (sent.previousEntry) document.handoffs[sent.file] = sent.previousEntry;
				else delete document.handoffs[sent.file];
				if (document.chosen === sent.file) document.chosen = sent.previousChosen !== null && Object.hasOwn(document.handoffs, sent.previousChosen) ? sent.previousChosen : null;
				return { result: true, write: true };
			});
		},
	};
}

export type DesignHandoffDelivery = { queued: boolean } | void | undefined;

/**
 * Records the handoff of `file` (sent, and chosen) BEFORE `deliver` sends it, so
 * the agent can never update a handoff that is not on disk yet. The delivery says
 * whether it was queued behind a busy agent; a failed delivery takes the record back.
 */
export async function sendDesignHandoff(
	store: DesignHandoffStore,
	handoff: { slug: string; file: string; feature?: string },
	deliver: () => DesignHandoffDelivery | Promise<DesignHandoffDelivery>,
): Promise<{ queued: boolean }> {
	const sent = await store.markSent(handoff.slug, handoff.file, { queued: false, feature: handoff.feature });
	let delivery: DesignHandoffDelivery;
	try {
		delivery = await deliver();
	} catch (error) {
		await store.revertSent(handoff.slug, sent).catch(() => {});
		throw error;
	}
	const queued = typeof delivery === "object" && delivery !== null && delivery.queued === true;
	// The handoff is already delivered; a failure to note the queue must not report it as failed.
	if (queued) await store.markQueued(handoff.slug, sent).catch(() => false);
	return { queued };
}
