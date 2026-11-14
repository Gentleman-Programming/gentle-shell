// Gentle Shell Desktop actions (odd/tasks/herdr-desktop.md T7, S2/S5): the
// Herdr app mods ask a live session to act by dropping one small JSON file in
// the session's private inbox, `<agentDir>/desktop/inbox/<session>/<id>.json`;
// the session answers in `<agentDir>/desktop/outbox/<session>/<id>.json`.
//
// Authority is exactly the user's: only the user can write the 0700 inbox, and
// every action runs through the owner the desktop RPC already uses
// (DesktopPermissionBridge, DesktopJobsBridge, DesktopAgentsBridge), so each
// owner's own rules still decide. Questions are never answered here: the
// session only checks that the question the desktop shows is the one open and
// tells it which keys the real TUI list takes; the keys are pressed in the
// terminal like a person would. Consent prompts have no action at all.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { clipText, type DesktopFeedTimers } from "./desktop-feed.ts";
import { desktopFeedFile, desktopFeedName } from "./desktop-feed-store.ts";
import { isPermissionMode } from "./permission-mode-policy.ts";

export const DESKTOP_ACTION_SCHEMA = "gentle-shell.desktop-action/v1";
export const DESKTOP_ACTION_RESULT_SCHEMA = "gentle-shell.desktop-action-result/v1";
export const DESKTOP_ACTION_KINDS = ["set_permission_mode", "cancel_job", "cancel_subagent", "answer_question"] as const;
export type DesktopActionKind = (typeof DESKTOP_ACTION_KINDS)[number];

export const DESKTOP_ACTION_LIMITS = {
	/** Largest action file read. */
	bytes: 16 * 1024,
	/** An action older than this is refused, and one dated later than `futureMs` ahead. */
	staleMs: 60_000,
	futureMs: 5_000,
	/** A file that does not parse yet is waited for this long (it may still be written). */
	partialMs: 2_000,
	retryMs: 250,
	/** Files handled per scan; the rest wait for the next one. */
	perScan: 32,
	/** Ids remembered so an action never runs twice. */
	seen: 256,
	/** Answers kept in the outbox, and for how long. */
	results: 32,
	resultAgeMs: 10 * 60_000,
	/** Largest answer `data` written; a bigger one is dropped. */
	resultData: 4 * 1024,
	text: 2_000,
	/** A folder without a live snapshot is swept once it is this old (a crashed session). */
	orphanMs: 10 * 60_000,
	sweepEntries: 256,
} as const;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function desktopActionInboxDir(agentDir: string, sessionId: string): string {
	return join(agentDir, "desktop", "inbox", desktopFeedName(sessionId));
}

export function desktopActionOutboxDir(agentDir: string, sessionId: string): string {
	return join(agentDir, "desktop", "outbox", desktopFeedName(sessionId));
}

export interface DesktopAction {
	id: string;
	sessionId: string;
	kind: DesktopActionKind;
	args: Record<string, unknown>;
	createdAt: number;
}

export interface DesktopActionError { code: string; message: string }
export type DesktopActionOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: DesktopActionError };

const fail = (code: string, message: string): { ok: false; error: DesktopActionError } => ({ ok: false, error: { code, message } });
const INVALID = (detail = "Invalid desktop action") => fail("invalid_action", detail);

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const nonEmpty = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function argsValid(kind: DesktopActionKind, args: Record<string, unknown>): boolean {
	switch (kind) {
		case "set_permission_mode":
			return onlyKeys(args, ["mode"]) && isPermissionMode(args.mode);
		case "cancel_job":
		case "cancel_subagent":
			return onlyKeys(args, ["id"]) && nonEmpty(args.id);
		case "answer_question": {
			if (!onlyKeys(args, ["toolCallId", "option", "text"]) || !nonEmpty(args.toolCallId)) return false;
			const option = args.option !== undefined;
			const text = args.text !== undefined;
			if (option === text) return false;
			if (option) return Number.isInteger(args.option) && (args.option as number) >= 0 && (args.option as number) < 64;
			return nonEmpty(args.text, DESKTOP_ACTION_LIMITS.text) && !/[\u0000-\u001f\u007f]/.test(args.text);
		}
	}
}

/** Parses one action file against the session it was dropped for. */
export function parseDesktopAction(text: string, sessionId: string, now: number): { ok: true; action: DesktopAction } | { ok: false; error: DesktopActionError } {
	let value: unknown;
	try { value = JSON.parse(text); } catch { return INVALID(); }
	const data = record(value);
	if (!data || data.schema !== DESKTOP_ACTION_SCHEMA) return INVALID();
	if (!onlyKeys(data, ["schema", "id", "sessionId", "kind", "args", "createdAt"])) return INVALID();
	if (typeof data.id !== "string" || !SAFE_ID.test(data.id)) return INVALID();
	if (data.sessionId !== sessionId) return fail("wrong_session", "This action is for another session");
	if (typeof data.kind !== "string" || !(DESKTOP_ACTION_KINDS as readonly string[]).includes(data.kind)) return fail("unknown_kind", "Unknown desktop action");
	const createdAt = typeof data.createdAt === "string" ? Date.parse(data.createdAt) : Number.NaN;
	if (!Number.isFinite(createdAt)) return INVALID();
	if (now - createdAt > DESKTOP_ACTION_LIMITS.staleMs || createdAt - now > DESKTOP_ACTION_LIMITS.futureMs) return fail("stale", "This action is too old to run");
	const kind = data.kind as DesktopActionKind;
	const args = record(data.args);
	if (!args || !argsValid(kind, args)) return INVALID();
	return { ok: true, action: { id: data.id, sessionId, kind, args, createdAt } };
}

// ---- Questions ----

/** What the open ask tool's real TUI list looks like: enough to reach an option by keys. */
export interface DesktopActionQuestion {
	toolCallId: string;
	tool: "ask_user_choice" | "ask_user_question";
	/** Options of the (first) question, before the free-text row. */
	options: number;
	/** A free-text row follows the options. */
	custom: boolean;
	questions: number;
	multi: boolean;
}

/** The shape of an ask tool call from its arguments, or undefined for any other tool. */
export function questionShape(toolName: string, toolCallId: string, args: unknown): DesktopActionQuestion | undefined {
	const input = record(args) ?? {};
	if (toolName === "ask_user_choice") {
		const options = Array.isArray(input.options) ? input.options.length : 0;
		return { toolCallId, tool: toolName, options, custom: input.allowCustomResponse === true, questions: 1, multi: false };
	}
	if (toolName === "ask_user_question") {
		const questions = Array.isArray(input.questions) ? input.questions : [];
		const first = record(questions[0]) ?? {};
		const options = Array.isArray(first.options) ? first.options.length : 0;
		// The questionnaire view always offers its free-text row after the options.
		return { toolCallId, tool: toolName, options, custom: true, questions: questions.length, multi: first.multiSelect === true };
	}
	return undefined;
}

const TERMINAL_ONLY: DesktopActionError = { code: "answer_in_terminal", message: "Answer this question in the Terminal view" };

/**
 * The keys that pick an answer in the real list: both lists (NativeChoiceList,
 * the questionnaire view) clamp the cursor, so one "up" per row reaches the
 * first row from anywhere, then "down" to the row and "enter". A free-text
 * answer opens the list's own editor; the text is then typed like any input.
 */
export function answerKeys(question: DesktopActionQuestion, answer: { option?: number; text?: string }): { keys: string[] } | { error: DesktopActionError } {
	if (question.questions !== 1 || question.multi || question.options < 1) return { error: TERMINAL_ONLY };
	const rows = question.options + (question.custom ? 1 : 0);
	let row: number;
	if (answer.text !== undefined) {
		if (!question.custom) return { error: { code: "invalid_action", message: "This question takes no typed answer" } };
		row = question.options;
	} else {
		if (answer.option === undefined || answer.option >= question.options) return { error: { code: "invalid_action", message: "No such option" } };
		row = answer.option;
	}
	return { keys: [...Array<string>(rows).fill("up"), ...Array<string>(row).fill("down"), "enter"] };
}

// ---- Dispatch ----

/** The existing owners, reached through the desktop RPC bridges. */
export interface DesktopActionOwners {
	setPermissionMode(mode: string): Promise<DesktopRpcOutcome | undefined>;
	cancelJob(id: string): Promise<DesktopRpcOutcome | undefined>;
	cancelSubagent(id: string): Promise<DesktopRpcOutcome | undefined>;
	/** The ask tool question open right now, if any. */
	question(): DesktopActionQuestion | undefined;
}

const OWNER_FAILED = fail("owner_failed", "The session could not run this action");

function fromOwner(outcome: DesktopRpcOutcome | undefined): DesktopActionOutcome {
	if (!outcome) return OWNER_FAILED;
	if ("error" in outcome) return { ok: false, error: { code: clipText(outcome.error.code, 64), message: clipText(outcome.error.message) } };
	// The owner's event is for the RPC stream; the snapshot already follows the owner.
	return { ok: true, data: outcome.data };
}

/** Runs a parsed action through the one owner its kind names. */
export async function runDesktopAction(action: DesktopAction, owners: DesktopActionOwners): Promise<DesktopActionOutcome> {
	try {
		switch (action.kind) {
			case "set_permission_mode":
				return fromOwner(await owners.setPermissionMode(action.args.mode as string));
			case "cancel_job":
				return fromOwner(await owners.cancelJob(action.args.id as string));
			case "cancel_subagent":
				return fromOwner(await owners.cancelSubagent(action.args.id as string));
			case "answer_question": {
				const open = owners.question();
				const toolCallId = action.args.toolCallId as string;
				if (!open || open.toolCallId !== toolCallId) return fail("question_mismatch", "That question is no longer open");
				const text = action.args.text as string | undefined;
				const keys = answerKeys(open, { option: action.args.option as number | undefined, text });
				if ("error" in keys) return { ok: false, error: keys.error };
				return { ok: true, data: { toolCallId, keys: keys.keys, ...(text !== undefined ? { text } : {}) } };
			}
		}
	} catch {
		return OWNER_FAILED;
	}
}

// ---- Inbox ----

export interface DesktopActionInboxOptions {
	agentDir: string;
	sessionId: string;
	owners: DesktopActionOwners;
	now: () => number;
	timers: DesktopFeedTimers;
	/** Calls `onChange` when the inbox folder changes; answers a closer. */
	watch: (dir: string, onChange: () => void) => () => void;
}

export interface DesktopActionInbox {
	inbox: string;
	outbox: string;
	start(): boolean;
	scan(): void;
	close(): void;
}

/** fs.watch on the inbox folder; a failed watch leaves only the start scan. */
export function watchDesktopActionInbox(dir: string, onChange: () => void): () => void {
	try {
		const watcher = fs.watch(dir, { persistent: false }, () => onChange());
		watcher.on("error", () => { try { watcher.close(); } catch { /* already closed */ } });
		return () => { try { watcher.close(); } catch { /* already closed */ } };
	} catch {
		return () => {};
	}
}

const owned = (stat: fs.Stats) => process.platform === "win32" || stat.uid === process.getuid?.();

function privateDirectory(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw Error("unsafe-directory");
	if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

function safeDirectory(dir: string): void {
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw Error("unsafe-directory");
}

/** Removes the regular files a session folder holds, then the folder; never follows a link. */
function clearDirectory(dir: string): void {
	try {
		safeDirectory(dir);
		for (const name of fs.readdirSync(dir)) {
			try {
				const stat = fs.lstatSync(join(dir, name));
				if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(join(dir, name));
			} catch { /* best effort */ }
		}
		fs.rmdirSync(dir);
	} catch { /* missing, unsafe or not empty */ }
}

/**
 * A session killed without its shutdown leaves its inbox and outbox behind. A
 * later session start removes the folders whose session has no snapshot (the
 * snapshot sweep drops dead sessions' first) and that have not changed for
 * `orphanMs`; a session that is still starting is younger than that.
 */
export function sweepDesktopActionOrphans(agentDir: string, keepSessionId: string, now: number = Date.now()): void {
	const keep = desktopFeedName(keepSessionId);
	for (const box of ["inbox", "outbox"]) {
		const root = join(agentDir, "desktop", box);
		let names: string[];
		try {
			safeDirectory(root);
			names = fs.readdirSync(root).slice(0, DESKTOP_ACTION_LIMITS.sweepEntries);
		} catch { continue; }
		for (const name of names) {
			if (name === keep) continue;
			const dir = join(root, name);
			try {
				const stat = fs.lstatSync(dir);
				if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) continue;
				if (now - stat.mtimeMs < DESKTOP_ACTION_LIMITS.orphanMs) continue;
				if (fs.existsSync(desktopFeedFile(agentDir, name))) continue;
				clearDirectory(dir);
			} catch { /* never touch what cannot be proven an orphan */ }
		}
	}
}

type Read = { kind: "text"; text: string; mtimeMs: number } | { kind: "rejected"; error: DesktopActionError } | { kind: "gone" };

function readActionFile(path: string): Read {
	let fd: number;
	try {
		fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "gone" };
		return { kind: "rejected", error: { code: "unsafe_file", message: "Refused a linked or unreadable action file" } };
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || !owned(stat)) return { kind: "rejected", error: { code: "unsafe_file", message: "Refused an action file that is not a private regular file" } };
		if (stat.size > DESKTOP_ACTION_LIMITS.bytes) return { kind: "rejected", error: { code: "too_large", message: "Action file too large" } };
		const buffer = Buffer.alloc(DESKTOP_ACTION_LIMITS.bytes + 1);
		const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (length > DESKTOP_ACTION_LIMITS.bytes) return { kind: "rejected", error: { code: "too_large", message: "Action file too large" } };
		return { kind: "text", text: buffer.subarray(0, length).toString("utf8"), mtimeMs: stat.mtimeMs };
	} finally {
		fs.closeSync(fd);
	}
}

function boundedData(data: Record<string, unknown>): Record<string, unknown> | undefined {
	try {
		const text = JSON.stringify(data);
		return text.length <= DESKTOP_ACTION_LIMITS.resultData ? JSON.parse(text) as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

/**
 * The per-session inbox. Files are handled one at a time, in name order, and
 * each is removed once read; a file that does not parse yet and is fresh is
 * left for one more look (the writer may still be filling it). It arms a timer
 * only for such a file.
 */
export function createDesktopActionInbox(options: DesktopActionInboxOptions): DesktopActionInbox {
	const inbox = desktopActionInboxDir(options.agentDir, options.sessionId);
	const outbox = desktopActionOutboxDir(options.agentDir, options.sessionId);
	const seen: string[] = [];
	let closed = false;
	let started = false;
	let running = false;
	let again = false;
	let retry: unknown;
	let unwatch: (() => void) | undefined;

	const writeResult = (id: string, kind: string | null, outcome: DesktopActionOutcome) => {
		let temporary: string | undefined;
		try {
			safeDirectory(outbox);
			const body: Record<string, unknown> = { schema: DESKTOP_ACTION_RESULT_SCHEMA, id, sessionId: options.sessionId, kind, ok: outcome.ok };
			if ("error" in outcome) body.error = { code: clipText(outcome.error.code, 64), message: clipText(outcome.error.message) };
			else body.data = boundedData(outcome.data) ?? {};
			body.finishedAt = new Date(options.now()).toISOString();
			const target = join(outbox, `${id}.json`);
			try {
				const existing = fs.lstatSync(target);
				if (!existing.isFile() || existing.isSymbolicLink()) return;
			} catch { /* new answer */ }
			const candidate = join(outbox, `.${randomUUID()}.tmp`);
			const fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			temporary = candidate;
			try { fs.writeFileSync(fd, `${JSON.stringify(body)}\n`); } finally { fs.closeSync(fd); }
			fs.renameSync(candidate, target);
			temporary = undefined;
			prune();
		} catch { /* An answer is display data: never interrupt the session. */ }
		finally { if (temporary) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } } }
	};

	// The mod removes each answer it read; anything left is pruned by age and count.
	const prune = () => {
		// File times are the real clock's.
		const now = Date.now();
		const answers: Array<{ path: string; mtime: number }> = [];
		for (const name of fs.readdirSync(outbox)) {
			if (!name.endsWith(".json")) continue;
			try {
				const stat = fs.lstatSync(join(outbox, name));
				if (stat.isFile()) answers.push({ path: join(outbox, name), mtime: stat.mtimeMs });
			} catch { /* gone */ }
		}
		answers.sort((a, b) => b.mtime - a.mtime);
		answers.forEach((answer, index) => {
			if (index >= DESKTOP_ACTION_LIMITS.results || now - answer.mtime > DESKTOP_ACTION_LIMITS.resultAgeMs) {
				try { fs.unlinkSync(answer.path); } catch { /* gone */ }
			}
		});
	};

	const remove = (path: string) => { try { fs.unlinkSync(path); } catch { /* gone */ } };

	const armRetry = () => {
		if (retry !== undefined || closed) return;
		retry = options.timers.set(() => { retry = undefined; scan(); }, DESKTOP_ACTION_LIMITS.retryMs);
	};

	const handle = async (name: string): Promise<void> => {
		const path = join(inbox, name);
		const stem = name.slice(0, -".json".length);
		const answerId = SAFE_ID.test(stem) ? stem : undefined;
		const read = readActionFile(path);
		if (read.kind === "gone") return;
		if (read.kind === "rejected") {
			remove(path);
			if (answerId) writeResult(answerId, null, { ok: false, error: read.error });
			return;
		}
		const now = options.now();
		const parsed = parseDesktopAction(read.text, options.sessionId, now);
		if ("error" in parsed && parsed.error.code === "invalid_action" && Date.now() - read.mtimeMs < DESKTOP_ACTION_LIMITS.partialMs && !looksComplete(read.text)) {
			armRetry();
			return;
		}
		remove(path);
		if (!answerId) return;
		if ("error" in parsed) { writeResult(answerId, null, parsed); return; }
		const { action } = parsed;
		if (action.id !== answerId) { writeResult(answerId, null, INVALID("The action id does not match its file name")); return; }
		if (seen.includes(action.id)) { writeResult(answerId, action.kind, fail("duplicate", "This action already ran")); return; }
		seen.push(action.id);
		if (seen.length > DESKTOP_ACTION_LIMITS.seen) seen.shift();
		const outcome = await runDesktopAction(action, options.owners);
		if (closed) return;
		writeResult(action.id, action.kind, outcome);
	};

	const scan = () => {
		if (closed || !started) return;
		if (running) { again = true; return; }
		running = true;
		void (async () => {
			try {
				do {
					again = false;
					let names: string[];
					try {
						safeDirectory(inbox);
						names = fs.readdirSync(inbox).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort().slice(0, DESKTOP_ACTION_LIMITS.perScan);
					} catch { return; }
					for (const name of names) {
						if (closed) return;
						try { await handle(name); } catch { /* one bad file never stops the inbox */ }
					}
				} while (again && !closed);
			} finally {
				running = false;
			}
		})();
	};

	return {
		inbox,
		outbox,
		start(): boolean {
			if (started || closed) return started;
			try {
				privateDirectory(join(options.agentDir, "desktop"));
				privateDirectory(join(options.agentDir, "desktop", "inbox"));
				privateDirectory(join(options.agentDir, "desktop", "outbox"));
				privateDirectory(inbox);
				privateDirectory(outbox);
			} catch { return false; }
			started = true;
			unwatch = options.watch(inbox, scan);
			scan();
			return true;
		},
		scan,
		close(): void {
			if (closed) return;
			closed = true;
			if (retry !== undefined) { options.timers.clear(retry); retry = undefined; }
			try { unwatch?.(); } catch { /* owner teardown */ }
			if (!started) return;
			clearDirectory(inbox);
			clearDirectory(outbox);
		},
	};
}

/** A complete JSON object ends with "}" (and a newline at most). */
function looksComplete(text: string): boolean {
	return /}\s*$/.test(text);
}
