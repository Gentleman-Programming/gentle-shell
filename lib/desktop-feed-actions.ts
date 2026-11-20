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
// terminal like a person would. Consent prompts have no action at all, and a
// provider consent or maintenance authorization the agent relays through an
// ask tool is answered in the terminal only. `abort_turn` (T10) is the TUI's
// Esc Esc: the session's own abort, and only while its agent works.
//
// T11 (S10): a session that runs outside Herdr app has no terminal the desktop
// can type into, so two more paths go through the inbox, with the same
// authority as its editor: `send_prompt` hands the text to pi as if typed and
// submitted (steering while the agent works, as Enter does in the TUI), never
// while a question, prompt or consent is open, and only for plain text, prompt
// templates and skills: pi's built-in commands, extension commands (TUI code
// with their own authority, /gentle:mode among them) and `!` shell lines stay
// in that session's terminal. `answer_question { via: "session" }` answers an
// ask tool question through the tool's own handle (lib/desktop-feed-answers.ts)
// under the same rules as the key path.
//
// Any process of the same user can write the inbox, the agent's own tools
// included (the guard in extensions/gentle-ai.ts denies the folder to the
// agent's file and shell tools, but a shell can always spell a path some other
// way, and a detached process outlives the turn). So a permission ESCALATION is
// refused when its file was written while the agent, a background job or a
// subagent of this session could act, or within 2 s after, and is otherwise
// applied only after the human confirms it in the session's own UI; lowering
// the mode and stopping work are always accepted.
//
// S12: `refresh_usage` is the TUI usage panel's `r` (the usage owner's forced
// refresh, as desktop RPC `refresh_subscription_usage`), and `apply_profile` is
// /gentle:profiles' "Use in this session" (its own apply, as desktop RPC
// `apply_profile` with mode `session`; never the global default). A profile
// changes which models the agent and its subagents run, so, like an escalation,
// it is refused when its file was written while the session could act.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { clipText, DESKTOP_FEED_BUILTIN_COMMANDS, type DesktopFeedTimers } from "./desktop-feed.ts";
import { desktopFeedFile, desktopFeedName, desktopFeedProcessGone } from "./desktop-feed-store.ts";
import { isPermissionMode } from "./permission-mode-policy.ts";

export const DESKTOP_ACTION_SCHEMA = "gentle-shell.desktop-action/v1";
export const DESKTOP_ACTION_RESULT_SCHEMA = "gentle-shell.desktop-action-result/v1";
export const DESKTOP_ACTION_KINDS = ["set_permission_mode", "cancel_job", "cancel_subagent", "answer_question", "abort_turn", "send_prompt", "refresh_usage", "apply_profile"] as const;
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
	/** Longest prompt a `send_prompt` carries (its file stays under `bytes`). */
	prompt: 4_000,
	/** A folder without a live snapshot is swept once it is this old (a crashed session). */
	orphanMs: 10 * 60_000,
	sweepEntries: 256,
	/** An escalation written this long after the session's activity ended is still refused. */
	activityGraceMs: 2_000,
	/**
	 * How far a file's time may lag the activity clock: Linux stamps files with
	 * its coarse clock (up to a tick behind Date.now), and some filesystems keep
	 * whole seconds (FAT: 2 s). A file stamped this long before a busy span may
	 * have been written in it, so it counts as busy.
	 */
	fileClockLagMs: 2_000,
	/** How long the session UI waits for the human to confirm an escalation. */
	confirmMs: 60_000,
	/** Activity spans remembered; older ones count as busy. */
	activitySpans: 64,
	/** Non-regular inbox entries remembered so they are never reprocessed. */
	ignored: 64,
	/** Text of a tool result read for a provider decision envelope. */
	scanChars: 256 * 1024,
} as const;

/** The session's pid, written in its inbox so the sweep can tell a live session. */
export const DESKTOP_ACTION_OWNER_FILE = ".owner";

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
			if (!onlyKeys(args, ["toolCallId", "option", "text", "via"]) || !nonEmpty(args.toolCallId)) return false;
			if (args.via !== undefined && args.via !== "session") return false;
			const option = args.option !== undefined;
			const text = args.text !== undefined;
			if (option === text) return false;
			if (option) return Number.isInteger(args.option) && (args.option as number) >= 0 && (args.option as number) < 64;
			return nonEmpty(args.text, DESKTOP_ACTION_LIMITS.text) && !/[\u0000-\u001f\u007f]/.test(args.text);
		}
		case "abort_turn":
			return onlyKeys(args, []);
		case "send_prompt":
			// Typed text: new lines and tabs, never another control character.
			return onlyKeys(args, ["text"]) && nonEmpty(args.text, DESKTOP_ACTION_LIMITS.prompt) && args.text.trim().length > 0
				&& !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(args.text);
		case "refresh_usage":
			// The RPC's own params: the whole scope, or exactly one provider.
			return onlyKeys(args, ["provider"]) && (args.provider === undefined || nonEmpty(args.provider, 128));
		case "apply_profile":
			// The RPC's bounds (128 characters); the owner checks the name and the token.
			return onlyKeys(args, ["name", "confirmation"]) && nonEmpty(args.name, 128) && (args.confirmation === undefined || nonEmpty(args.confirmation, 128));
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
	let args = record(data.args);
	// Typed text from Windows line ends: CRLF is one new line, as the editor takes it.
	if (kind === "send_prompt" && args && typeof args.text === "string") args = { ...args, text: args.text.replace(/\r\n/g, "\n") };
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
	/** A provider consent or maintenance authorization relayed by the agent: terminal only. */
	provider: boolean;
}

// Provider-owned decisions (assets/orchestrator-prompts.md): review consent
// envelopes, their bindings, and maintenance/repair authorizations. Matching
// more than needed only sends a question to the terminal.
const PROVIDER_DECISION = /gentle-ai\.review-integration\.consent\/|gentle-ai\.review-repair-authorization\/|native-review-consent-required|\bconsent_required\b|\bconsent_?binding\b|maintainer_authorization|explicit-maintainer-action|--consent\s+(?:granted|declined)\b/i;
// A relayed consent's option tokens are the envelope's own answers.
const CONSENT_TOKENS = new Set(["granted", "declined"]);

/** Whether a tool result (or any value) carries a provider decision envelope; reads a bounded amount. */
export function providerDecisionIn(value: unknown): boolean {
	let budget: number = DESKTOP_ACTION_LIMITS.scanChars;
	const seen = new Set<unknown>();
	const visit = (item: unknown, depth: number): boolean => {
		if (budget <= 0 || depth > 8) return false;
		if (typeof item === "string") {
			const text = item.length > budget ? item.slice(0, budget) : item;
			budget -= text.length;
			return PROVIDER_DECISION.test(text);
		}
		if (item === null || typeof item !== "object" || seen.has(item)) return false;
		seen.add(item);
		if (Array.isArray(item)) return item.some((entry) => visit(entry, depth + 1));
		return Object.entries(item as Record<string, unknown>).some(([key, entry]) => visit(key, depth + 1) || visit(entry, depth + 1));
	};
	try { return visit(value, 0); } catch { return true; }
}

/** Whether an ask call's own text or option tokens are a relayed provider decision. */
function relayedDecision(input: Record<string, unknown>): boolean {
	const options = [input.options, ...(Array.isArray(input.questions) ? input.questions.map((question) => record(question)?.options) : [])]
		.flatMap((list) => (Array.isArray(list) ? list : []));
	if (options.some((option) => { const value = record(option)?.value; return typeof value === "string" && CONSENT_TOKENS.has(value.trim().toLowerCase()); })) return true;
	return providerDecisionIn(input);
}

/**
 * The shape of an ask tool call from its arguments, or undefined for any other
 * tool. `relayed`: the session saw a provider decision envelope in this turn's
 * tool results, so this question is the agent relaying it.
 */
export function questionShape(toolName: string, toolCallId: string, args: unknown, relayed = false): DesktopActionQuestion | undefined {
	const input = record(args) ?? {};
	if (toolName === "ask_user_choice") {
		const options = Array.isArray(input.options) ? input.options.length : 0;
		return { toolCallId, tool: toolName, options, custom: input.allowCustomResponse === true, questions: 1, multi: false, provider: relayed || relayedDecision(input) };
	}
	if (toolName === "ask_user_question") {
		const questions = Array.isArray(input.questions) ? input.questions : [];
		const first = record(questions[0]) ?? {};
		const options = Array.isArray(first.options) ? first.options.length : 0;
		// The questionnaire view always offers its free-text row after the options.
		return { toolCallId, tool: toolName, options, custom: true, questions: questions.length, multi: first.multiSelect === true, provider: relayed || relayedDecision(input) };
	}
	return undefined;
}

/** Whether the desktop may pick an answer for this question (else: the terminal). */
export function answerableFromDesktop(question: DesktopActionQuestion): boolean {
	return !question.provider && question.questions === 1 && !question.multi && question.options >= 1;
}

const TERMINAL_ONLY: DesktopActionError = { code: "answer_in_terminal", message: "Answer this question in the Terminal view" };

/**
 * The keys that pick an answer in the real list: both lists (NativeChoiceList,
 * the questionnaire view) clamp the cursor, so one "up" per row reaches the
 * first row from anywhere, then "down" to the row and "enter". A free-text
 * answer opens the list's own editor; the text is then typed like any input.
 */
export function answerKeys(question: DesktopActionQuestion, answer: { option?: number; text?: string }): { keys: string[] } | { error: DesktopActionError } {
	if (!answerableFromDesktop(question)) return { error: TERMINAL_ONLY };
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
	/** Whether the session's agent is working now (abort_turn's guard). */
	working(): boolean;
	/** The session's own abort, the one its TUI's Esc Esc runs. */
	abortTurn(): void;
	/** The session's permission mode now, if known. */
	permissionMode(): string | undefined;
	/** Whether the agent, a background job or a subagent could act at `time` (file clock), or 2 s after. */
	busyAt(time: number): boolean;
	/** Asks the human in the session's own UI; absent without an interactive UI. */
	confirmEscalation?(from: string | undefined, to: string): Promise<boolean>;
	/** Whether a question, an extension prompt or a consent is open now (send_prompt's guard, T11). */
	questionOpen?(): boolean;
	/** Where pi's registry says a slash command comes from, if it has one. */
	commandSource?(name: string): string | undefined;
	/**
	 * Submits `text` as if typed in the session's editor (`expand`: prompt templates and skills).
	 * While pi compacts (it refuses prompts then) the session holds it for after, as the TUI
	 * editor does (`after: "compaction"`), or answers `compacting` when it already holds one.
	 */
	sendPrompt?(text: string, expand: boolean): { queued: boolean; after?: "compaction" } | { compacting: true };
	/** Answers the open ask tool question through the tool's own handle; false without one. */
	answerQuestion?(toolCallId: string, answer: { option?: number; text?: string }): boolean;
	/** The usage owner's forced refresh (the TUI panel's r), for the whole scope or one provider (S12). */
	refreshUsage?(provider: string | undefined): Promise<DesktopRpcOutcome | undefined>;
	/** /gentle:profiles' "Use in this session" through its own apply (S12). */
	applyProfile?(name: string, confirmation: string | undefined): Promise<DesktopRpcOutcome | undefined>;
}

/** pi's built-in commands: the interactive editor runs them, so they stay in the terminal. */
const PI_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
	...DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => command.name),
	"quit", "exit", "settings", "scoped-models", "hotkeys", "debug", "arminsayshi", "dementedelves",
]);
const TERMINAL_COMMAND = fail("terminal_command", "Open that session's terminal to run /commands.");
const TERMINAL_SHELL = fail("terminal_command", "Open that session's terminal to run ! shell commands.");
const QUESTION_OPEN = fail("question_open", "Answer the open question first.");
const NO_PROMPTS = fail("unsupported", "This session takes no prompts from the desktop. Update Gentle Shell and restart it.");
const SESSION_COMPACTING = fail("session_compacting", "Pi is compacting this session and already holds one prompt for after it; send this one when compaction ends.");
const ANSWER_IN_SESSION_TERMINAL = fail("answer_in_terminal", "Answer this question in that session's terminal.");

/** send_prompt (T11): plain text, prompt templates and skills, as the editor would submit them. */
function sendPrompt(text: string, owners: DesktopActionOwners): DesktopActionOutcome {
	if (!owners.sendPrompt) return NO_PROMPTS;
	if (owners.questionOpen?.() === true) return QUESTION_OPEN;
	const prompt = text.trim();
	if (prompt.startsWith("!")) return TERMINAL_SHELL;
	let expand = false;
	if (prompt.startsWith("/")) {
		const name = prompt.slice(1).split(/\s/, 1)[0] ?? "";
		const source = PI_BUILTIN_COMMANDS.has(name) ? "builtin" : name ? owners.commandSource?.(name) : undefined;
		if (source === "prompt" || source === "skill") expand = true;
		// Anything pi runs as code (a built-in, an extension command) stays in the terminal;
		// a "/word" no command owns is plain text, as in the editor.
		else if (source !== undefined) return TERMINAL_COMMAND;
	}
	const sent = owners.sendPrompt(prompt, expand);
	if ("compacting" in sent) return SESSION_COMPACTING;
	return { ok: true, data: { queued: sent.queued, ...(sent.after === "compaction" ? { after: sent.after } : {}) } };
}

// ---- Permission escalation ----

const PERMISSION_RANK: Record<string, number> = { normal: 0, auto: 1, yolo: 2, "super-yolo": 3 };

/** Whether `to` is less restrictive than `from`; an unknown current mode counts as `normal`. */
export function isPermissionEscalation(from: string | undefined, to: string): boolean {
	return (PERMISSION_RANK[to] ?? Number.POSITIVE_INFINITY) > (PERMISSION_RANK[from ?? "normal"] ?? 0);
}

export interface DesktopActivityTimeline {
	/** Records whether the session is busy now. */
	set(busy: boolean): void;
	/** Busy at `time`, or within the grace after; anything before the timeline started counts as busy. */
	busyAt(time: number): boolean;
}

/**
 * When the session's agent, background jobs or subagents could act, on the
 * file clock (`clock`, real time). Bounded: forgotten spans count as busy.
 */
export function createDesktopActivityTimeline(clock: () => number = Date.now, graceMs: number = DESKTOP_ACTION_LIMITS.activityGraceMs, lagMs: number = DESKTOP_ACTION_LIMITS.fileClockLagMs): DesktopActivityTimeline {
	const spans: Array<{ start: number; end: number | undefined }> = [];
	let knownFrom = clock();
	return {
		set(busy: boolean): void {
			const last = spans[spans.length - 1];
			const open = last !== undefined && last.end === undefined;
			if (busy === open) return;
			const now = clock();
			if (busy) spans.push({ start: now, end: undefined });
			else last!.end = now;
			while (spans.length > DESKTOP_ACTION_LIMITS.activitySpans) {
				const dropped = spans.shift()!;
				knownFrom = Math.max(knownFrom, (dropped.end ?? now) + graceMs + 1);
			}
		},
		busyAt(time: number): boolean {
			const now = clock();
			const at = Math.min(time, now);
			if (!Number.isFinite(at) || at < knownFrom) return true;
			// The real write happened between `at` and `at + lagMs` (never after now):
			// busy when any of that window meets a span or its grace.
			const latest = Math.min(at + lagMs, now);
			return spans.some((span) => latest >= span.start && (span.end === undefined || at <= span.end + graceMs));
		},
	};
}

const NO_OWNER = fail("unsupported", "This session cannot run this action. Update Gentle Shell and restart it.");

const ESCALATION_WHILE_BUSY = fail("escalation_while_busy", "Raising the permission mode is refused while the agent, a background job or a subagent is running, or within 2 s after; try again when the session is idle.");

const NEEDS_CONFIRMATION = fail("escalation_needs_confirmation", "Raising the permission mode needs your confirmation in the session's Terminal; it was not confirmed.");

const OWNER_FAILED = fail("owner_failed", "The session could not run this action");

function fromOwner(outcome: DesktopRpcOutcome | undefined): DesktopActionOutcome {
	if (!outcome) return OWNER_FAILED;
	if ("error" in outcome) return { ok: false, error: { code: clipText(outcome.error.code, 64), message: clipText(outcome.error.message) } };
	// The owner's event is for the RPC stream; the snapshot already follows the owner.
	return { ok: true, data: outcome.data };
}

/**
 * Runs a parsed action through the one owner its kind names. `writtenAt` is
 * when its file was last written (fstat, the file clock); without it the
 * session's state now decides. `onPending` runs before an escalation waits for
 * the human's confirmation.
 */
export async function runDesktopAction(action: DesktopAction, owners: DesktopActionOwners, writtenAt?: number, onPending?: () => void): Promise<DesktopActionOutcome> {
	try {
		switch (action.kind) {
			case "set_permission_mode": {
				const mode = action.args.mode as string;
				const from = owners.permissionMode();
				if (isPermissionEscalation(from, mode)) {
					if (owners.busyAt(writtenAt ?? Date.now())) return ESCALATION_WHILE_BUSY;
					if (!owners.confirmEscalation) return NEEDS_CONFIRMATION;
					onPending?.();
					if ((await owners.confirmEscalation(from, mode)) !== true) return NEEDS_CONFIRMATION;
				}
				return fromOwner(await owners.setPermissionMode(mode));
			}
			case "cancel_job":
				return fromOwner(await owners.cancelJob(action.args.id as string));
			case "cancel_subagent":
				return fromOwner(await owners.cancelSubagent(action.args.id as string));
			case "answer_question": {
				const open = owners.question();
				const toolCallId = action.args.toolCallId as string;
				if (!open || open.toolCallId !== toolCallId) return fail("question_mismatch", "That question is no longer open");
				const text = action.args.text as string | undefined;
				const option = action.args.option as number | undefined;
				const keys = answerKeys(open, { option, text });
				if ("error" in keys) return { ok: false, error: keys.error };
				if (action.args.via === "session") {
					// T11: no terminal to press keys in; the tool's own handle answers it.
					const answer = text !== undefined ? { text } : { option: option as number };
					if (owners.answerQuestion?.(toolCallId, answer) !== true) return ANSWER_IN_SESSION_TERMINAL;
					return { ok: true, data: { toolCallId, answered: true } };
				}
				return { ok: true, data: { toolCallId, keys: keys.keys, ...(text !== undefined ? { text } : {}) } };
			}
			case "abort_turn":
				if (!owners.working()) return fail("not_working", "The agent is not working");
				owners.abortTurn();
				return { ok: true, data: { aborted: true } };
			case "send_prompt":
				return sendPrompt(action.args.text as string, owners);
			case "refresh_usage":
				if (!owners.refreshUsage) return NO_OWNER;
				return fromOwner(await owners.refreshUsage(action.args.provider as string | undefined));
			case "apply_profile":
				// Same as /gentle:profiles in the TUI: allowed while the session works; the owner decides.
				if (!owners.applyProfile) return NO_OWNER;
				return fromOwner(await owners.applyProfile(action.args.name as string, action.args.confirmation as string | undefined));
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

/**
 * Removes what a session folder holds, then the folder: links and files are
 * unlinked (never followed), owned subfolders are cleared the same way, a few
 * levels deep at most.
 */
function clearDirectory(dir: string, depth = 0): void {
	try {
		safeDirectory(dir);
		for (const name of fs.readdirSync(dir).slice(0, DESKTOP_ACTION_LIMITS.sweepEntries)) {
			try {
				const path = join(dir, name);
				const stat = fs.lstatSync(path);
				if (stat.isDirectory() && !stat.isSymbolicLink()) { if (depth < 3) clearDirectory(path, depth + 1); }
				else fs.unlinkSync(path);
			} catch { /* best effort */ }
		}
		fs.rmdirSync(dir);
	} catch { /* missing, unsafe or not empty */ }
}

/** The pid a session recorded in its inbox, if the marker is a small private file. */
function recordedPid(file: string): unknown {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || stat.size > 4096) return undefined;
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown; identity?: { pid?: unknown } } | null;
		return value?.pid ?? value?.identity?.pid;
	} catch { return undefined; }
}

/**
 * A session killed without its shutdown leaves its inbox and outbox behind. A
 * later session start removes the folders that have not changed for
 * `orphanMs` and whose session is proven gone: the pid it recorded in its
 * inbox (or, for a folder without one, in its snapshot) no longer runs, or it
 * has neither. A live session's folders stay however long it is idle.
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
				const marker = join(agentDir, "desktop", "inbox", name, DESKTOP_ACTION_OWNER_FILE);
				const snapshot = desktopFeedFile(agentDir, name);
				if (fs.existsSync(marker) || fs.existsSync(snapshot)) {
					const pid = recordedPid(fs.existsSync(marker) ? marker : snapshot);
					if (!desktopFeedProcessGone(pid)) continue;
				}
				clearDirectory(dir);
			} catch { /* never touch what cannot be proven an orphan */ }
		}
	}
}

/** mtime can be set back by its writer; ctime cannot: the later of the two. */
type Read = { kind: "text"; text: string; mtimeMs: number; writtenAt: number } | { kind: "rejected"; error: DesktopActionError } | { kind: "gone" };

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
		return { kind: "text", text: buffer.subarray(0, length).toString("utf8"), mtimeMs: stat.mtimeMs, writtenAt: Math.max(stat.mtimeMs, stat.ctimeMs) };
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
	/** Entries that could not be removed (a non-empty folder): name → identity, skipped while unchanged. */
	const ignored = new Map<string, string>();
	const identity = (path: string): string | undefined => {
		try { const stat = fs.lstatSync(path); return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`; } catch { return undefined; }
	};
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

	// A refused entry is unlinked; an empty folder is removed; anything that
	// stays is remembered so the next scans skip it instead of answering again.
	const discard = (name: string, path: string) => {
		try { fs.unlinkSync(path); return; } catch { /* a folder, or gone */ }
		try { fs.rmdirSync(path); return; } catch { /* not empty, or gone */ }
		const id = identity(path);
		if (id === undefined) return;
		ignored.set(name, id);
		while (ignored.size > DESKTOP_ACTION_LIMITS.ignored) ignored.delete(ignored.keys().next().value!);
	};

	const armRetry = () => {
		if (retry !== undefined || closed) return;
		retry = options.timers.set(() => { retry = undefined; scan(); }, DESKTOP_ACTION_LIMITS.retryMs);
	};

	const handle = async (name: string): Promise<void> => {
		const path = join(inbox, name);
		const stem = name.slice(0, -".json".length);
		const answerId = SAFE_ID.test(stem) ? stem : undefined;
		if (ignored.has(name)) {
			if (ignored.get(name) === identity(path)) return;
			ignored.delete(name);
		}
		const read = readActionFile(path);
		if (read.kind === "gone") return;
		if (read.kind === "rejected") {
			discard(name, path);
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
		const outcome = await runDesktopAction(action, options.owners, read.writtenAt, () => writeResult(action.id, action.kind, { ok: true, data: { pending: "confirmation" } }));
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
				writeOwnerMarker(inbox);
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

/** `{ pid }` of this process in the inbox (exclusive temp file, then rename), for the orphan sweep. */
function writeOwnerMarker(inbox: string): void {
	const candidate = join(inbox, `.${randomUUID()}.tmp`);
	const fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try {
		try { fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`); } finally { fs.closeSync(fd); }
		fs.renameSync(candidate, join(inbox, DESKTOP_ACTION_OWNER_FILE));
	} catch (error) {
		try { fs.unlinkSync(candidate); } catch { /* best effort */ }
		throw error;
	}
}

/** A complete JSON object ends with "}" (and a newline at most). */
function looksComplete(text: string): boolean {
	return /}\s*$/.test(text);
}
