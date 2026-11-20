import { randomBytes } from "node:crypto";
import { isArtboardPath, locateDesignFile, readDesignFile, replaceDesignFile, serializeDesignWrite, truncateUtf16 } from "./design-comments.ts";
import type { DesignHandoffDelivery } from "./design-handoffs.ts";

// The single owner of design/<slug>/parts.json (canvas-implement-part): the parts of artboards handed to the session
// one at a time ("Implement only this"), each with the agent's progress. Unlike handoffs.json it never chooses an
// artboard, so the other directions stay open. The canvas server and the gentle_design tool write through this module,
// in the same per-file queue as comments.json and handoffs.json, re-reading the file before every write and replacing
// it with a temp file + rename. A file this module cannot parse is reported and never overwritten.
// "Remove" on the canvas (removeSent) clears a part the agent never reported: only a part still `sent` (queued or not),
// so a part the agent took up or finished keeps its record; every refusal leaves the file byte for byte.
// The file holds at most 1 MiB: the serialized document is measured before the file is replaced, so a write that would
// pass it is refused (`too-large`) and the previous file, which Remove can still repair, stays as it was.

export const DESIGN_PARTS_FILE = "parts.json";
/** The most parts one design keeps. */
export const DESIGN_PARTS_MAX = 100;
export const DESIGN_PART_SELECTOR_LIMIT = 500;
export const DESIGN_PART_EXCERPT_LIMIT = 300;
/** The user's note on the part, like a comment. */
export const DESIGN_PART_INSTRUCTION_LIMIT = 2000;
/** The agent's progress note, like a handoff's. */
export const DESIGN_PART_NOTE_LIMIT = 1000;
const MAX_FILE_BYTES = 1024 * 1024;
const PART_ID = /^[a-z0-9]{1,32}$/;

export type DesignPartStatus = "sent" | "in_progress" | "implemented";

export type DesignPart = {
	id: string;
	file: string;
	selector: string;
	excerpt: string;
	/** The user's note: what of the element to build, or how. Absent when none. */
	instruction?: string;
	status: DesignPartStatus;
	/** The agent was busy when it was sent, so it waits as a follow-up. */
	queued: boolean;
	sentAt: string;
	startedAt: string | null;
	implementedAt: string | null;
	/** The agent's last progress note. */
	note?: string;
};

export type DesignPartsDocument = { version: 1; parts: DesignPart[] };

export type DesignPartInput = { file: string; selector: string; excerpt: string; instruction: string };

/**
 * `not-sent`: removeSent was asked for a part the agent already reported (in_progress or implemented).
 * `too-large`: the write would make parts.json larger than 1 MiB; nothing was written.
 */
export type DesignPartsErrorCode = "not-found" | "invalid-file" | "invalid-input" | "limit" | "not-sent" | "too-large";

export class DesignPartsError extends Error {
	readonly code: DesignPartsErrorCode;
	constructor(code: DesignPartsErrorCode, message: string) {
		super(message);
		this.name = "DesignPartsError";
		this.code = code;
	}
}

export interface DesignPartStoreDeps {
	now?: () => Date;
	randomId?: () => string;
}

export interface DesignPartStore {
	/** The design's parts; a missing parts.json is an empty document. */
	read(slug: string): Promise<DesignPartsDocument>;
	/** A new part, status sent and not queued, appended after the others. */
	add(slug: string, input: DesignPartInput): Promise<DesignPart>;
	/** The agent's progress on part `id` of `file`; `note` becomes exactly what this call passes. */
	setStatus(slug: string, file: string, id: string, status: Exclude<DesignPartStatus, "sent">, options: { note?: string }): Promise<DesignPart>;
	/** Marks a still-sent part as queued; true when it was updated. */
	markQueued(slug: string, id: string): Promise<boolean>;
	/** Removes part `id` (a delivery that failed); true when it was there. */
	remove(slug: string, id: string): Promise<boolean>;
	/**
	 * The canvas "Remove": takes part `id` out when it is still `sent` (queued or not) and answers it. An unknown id is
	 * `not-found`, a part in progress or implemented is `not-sent`, a malformed id is `invalid-input`; none writes.
	 */
	removeSent(slug: string, id: string): Promise<DesignPart>;
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
const normalizeText = (value: string) => value.replace(/\r\n?/g, "\n").trim();

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function invalid(message: string): DesignPartsError {
	return new DesignPartsError("invalid-file", message);
}

/** The part with its keys in a stable order and no absent optional keys. */
function partOf(fields: DesignPart): DesignPart {
	return {
		id: fields.id,
		file: fields.file,
		selector: fields.selector,
		excerpt: fields.excerpt,
		...(fields.instruction !== undefined ? { instruction: fields.instruction } : {}),
		status: fields.status,
		queued: fields.queued,
		sentAt: fields.sentAt,
		startedAt: fields.startedAt,
		implementedAt: fields.implementedAt,
		...(fields.note !== undefined ? { note: fields.note } : {}),
	};
}

function parsePart(where: string, value: unknown): DesignPart {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${where} must be an object`);
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || !PART_ID.test(item.id)) throw invalid(`${where}.id must be 1 to 32 lowercase letters or digits`);
	if (!isArtboardPath(item.file)) throw invalid(`${where}.file must be a relative .html artboard path`);
	if (typeof item.selector !== "string" || item.selector.length < 1 || item.selector.length > DESIGN_PART_SELECTOR_LIMIT) throw invalid(`${where}.selector must have 1 to ${DESIGN_PART_SELECTOR_LIMIT} characters`);
	if (typeof item.excerpt !== "string" || item.excerpt.length > DESIGN_PART_EXCERPT_LIMIT) throw invalid(`${where}.excerpt must be text of at most ${DESIGN_PART_EXCERPT_LIMIT} characters`);
	if (item.instruction !== undefined && (typeof item.instruction !== "string" || item.instruction.length > DESIGN_PART_INSTRUCTION_LIMIT)) throw invalid(`${where}.instruction must be text of at most ${DESIGN_PART_INSTRUCTION_LIMIT} characters`);
	if (item.status !== "sent" && item.status !== "in_progress" && item.status !== "implemented") throw invalid(`${where}.status must be "sent", "in_progress" or "implemented"`);
	if (typeof item.queued !== "boolean") throw invalid(`${where}.queued must be true or false`);
	if (!isTimestamp(item.sentAt)) throw invalid(`${where}.sentAt must be a timestamp`);
	for (const key of ["startedAt", "implementedAt"] as const) {
		if (item[key] !== null && !isTimestamp(item[key])) throw invalid(`${where}.${key} must be a timestamp or null`);
	}
	if (item.note !== undefined && (typeof item.note !== "string" || item.note.length > DESIGN_PART_NOTE_LIMIT)) throw invalid(`${where}.note must be text of at most ${DESIGN_PART_NOTE_LIMIT} characters`);
	return partOf(item as unknown as DesignPart);
}

function parseDocument(raw: string): DesignPartsDocument {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw invalid("parts.json is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("parts.json must be a JSON object");
	const record = value as Record<string, unknown>;
	if (record.version !== 1) throw invalid("parts.json version must be 1");
	if (!Array.isArray(record.parts)) throw invalid("parts.json parts must be a list");
	if (record.parts.length > DESIGN_PARTS_MAX) throw invalid(`parts.json may hold at most ${DESIGN_PARTS_MAX} parts`);
	const parts = record.parts.map((part, index) => parsePart(`parts[${index}]`, part));
	if (new Set(parts.map((part) => part.id)).size !== parts.length) throw invalid("parts.json ids must be unique");
	return { version: 1, parts };
}

export function createDesignPartStore(designRoot: string, deps: DesignPartStoreDeps = {}): DesignPartStore {
	const now = deps.now ?? (() => new Date());
	const randomId = deps.randomId ?? (() => randomBytes(6).toString("hex"));

	function locate(slug: string): Promise<{ dir: string; path: string }> {
		return locateDesignFile(designRoot, slug, DESIGN_PARTS_FILE, (message) => new DesignPartsError("not-found", message));
	}

	async function load(path: string): Promise<DesignPartsDocument> {
		const raw = await readDesignFile(path, MAX_FILE_BYTES, () => invalid("parts.json is too large"));
		return raw === undefined ? { version: 1, parts: [] } : parseDocument(raw);
	}

	/** Read-modify-write in the file's queue; `change` sets `write: false` when nothing changed. */
	async function mutate<T>(slug: string, change: (document: DesignPartsDocument) => { result: T; write: boolean }): Promise<T> {
		const { dir, path } = await locate(slug);
		return serializeDesignWrite(path, async () => {
			const document = await load(path);
			const { result, write } = change(document);
			if (!write) return result;
			const content = `${JSON.stringify(document, null, 2)}\n`;
			const size = Buffer.byteLength(content);
			if (size > MAX_FILE_BYTES) throw new DesignPartsError("too-large", `design/${slug}/${DESIGN_PARTS_FILE} would grow to ${size} bytes, past the 1 MiB it can hold; nothing was written.`);
			await replaceDesignFile(dir, path, DESIGN_PARTS_FILE, content);
			return result;
		});
	}

	return {
		async read(slug) {
			return load((await locate(slug)).path);
		},

		async add(slug, input) {
			if (!isArtboardPath(input?.file)) throw new DesignPartsError("invalid-input", "file must be a relative .html path inside the design");
			const selector = typeof input.selector === "string" ? collapse(input.selector) : "";
			if (selector.length < 1 || selector.length > DESIGN_PART_SELECTOR_LIMIT) throw new DesignPartsError("invalid-input", `selector must have 1 to ${DESIGN_PART_SELECTOR_LIMIT} characters`);
			if (typeof input.excerpt !== "string") throw new DesignPartsError("invalid-input", "excerpt must be text");
			const excerpt = truncateUtf16(collapse(input.excerpt), DESIGN_PART_EXCERPT_LIMIT).trim();
			if (typeof input.instruction !== "string") throw new DesignPartsError("invalid-input", "instruction must be text");
			const instruction = normalizeText(input.instruction);
			if (instruction.length > DESIGN_PART_INSTRUCTION_LIMIT) throw new DesignPartsError("invalid-input", `instruction must have at most ${DESIGN_PART_INSTRUCTION_LIMIT} characters`);
			return mutate(slug, (document) => {
				if (document.parts.length >= DESIGN_PARTS_MAX) throw new DesignPartsError("limit", `design/${slug} already has ${DESIGN_PARTS_MAX} parts, the most a design can hold.`);
				let id = randomId();
				while (document.parts.some((part) => part.id === id)) id = randomId();
				const part = partOf({ id, file: input.file, selector, excerpt, instruction: instruction || undefined, status: "sent", queued: false, sentAt: now().toISOString(), startedAt: null, implementedAt: null });
				document.parts.push(part);
				return { result: part, write: true };
			});
		},

		async setStatus(slug, file, id, status, options) {
			if (status !== "in_progress" && status !== "implemented") throw new DesignPartsError("invalid-input", 'status must be "in_progress" or "implemented"');
			const { note } = options ?? {};
			if (note !== undefined && (typeof note !== "string" || note.length > DESIGN_PART_NOTE_LIMIT)) throw new DesignPartsError("invalid-input", `note must have at most ${DESIGN_PART_NOTE_LIMIT} characters`);
			const cleanNote = note === undefined ? undefined : normalizeText(note) || undefined;
			return mutate(slug, (document) => {
				const index = document.parts.findIndex((part) => part.id === id);
				if (index < 0) throw new DesignPartsError("not-found", `No part "${id}" in design/${slug}/parts.json.`);
				const current = document.parts[index];
				if (current.file !== file) throw new DesignPartsError("invalid-input", `Part "${id}" belongs to ${current.file}, not ${file}.`);
				const stamp = now().toISOString();
				const part = partOf({
					...current,
					status,
					// A repeated in_progress report keeps the first start; taking up a sent or implemented part starts it again.
					startedAt: status === "in_progress" ? (current.status === "in_progress" ? current.startedAt ?? stamp : stamp) : current.startedAt,
					implementedAt: status === "implemented" ? stamp : null,
					note: cleanNote,
				});
				document.parts[index] = part;
				return { result: part, write: true };
			});
		},

		async markQueued(slug, id) {
			return mutate(slug, (document) => {
				const index = document.parts.findIndex((part) => part.id === id);
				if (index < 0 || document.parts[index].status !== "sent" || document.parts[index].queued) return { result: false, write: false };
				document.parts[index] = partOf({ ...document.parts[index], queued: true });
				return { result: true, write: true };
			});
		},

		async remove(slug, id) {
			return mutate(slug, (document) => {
				const index = document.parts.findIndex((part) => part.id === id);
				if (index < 0) return { result: false, write: false };
				document.parts.splice(index, 1);
				return { result: true, write: true };
			});
		},

		async removeSent(slug, id) {
			if (typeof id !== "string" || !PART_ID.test(id)) throw new DesignPartsError("invalid-input", "id must be 1 to 32 lowercase letters or digits");
			return mutate(slug, (document) => {
				const index = document.parts.findIndex((part) => part.id === id);
				if (index < 0) throw new DesignPartsError("not-found", `No part "${id}" in design/${slug}/parts.json.`);
				const part = document.parts[index];
				if (part.status !== "sent") throw new DesignPartsError("not-sent", `Part "${id}" is ${part.status}, not sent; only a sent part can be removed.`);
				document.parts.splice(index, 1);
				return { result: part, write: true };
			});
		},
	};
}

/**
 * Records the part BEFORE `deliver` sends it, so the agent can report on a part that is on disk; the delivery says
 * whether it was queued behind a busy agent, and a failed delivery takes the part back.
 */
export async function sendDesignPart(
	store: DesignPartStore,
	slug: string,
	input: DesignPartInput,
	deliver: (part: DesignPart) => DesignHandoffDelivery | Promise<DesignHandoffDelivery>,
): Promise<{ part: DesignPart; queued: boolean }> {
	const part = await store.add(slug, input);
	let delivery: DesignHandoffDelivery;
	try {
		delivery = await deliver(part);
	} catch (error) {
		await store.remove(slug, part.id).catch(() => false);
		throw error;
	}
	const queued = typeof delivery === "object" && delivery !== null && delivery.queued === true;
	// Already delivered: a failure to note the queue must not report the part as failed.
	if (queued) await store.markQueued(slug, part.id).catch(() => false);
	return { part: queued ? { ...part, queued: true } : part, queued };
}
