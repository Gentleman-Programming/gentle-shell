// Reply-language anchor (full-delegation-mode-conflicts S9).
//
// The primary session replies in the human's language, while subagent results,
// wakes, job notices and summaries are English and reach the model with the user
// role. A prompt rule ("reply in the language of the human's own last message")
// did not hold on its own: in a long session that message sits far up the
// transcript, and after compaction it is gone. So the harness records the human's
// own text and, when the model is about to answer right after an automated
// message, adds one anchor that quotes the start of it. No language detection:
// the human's words carry their language.
//
// The anchor is added only when the context's tail is automated, never mid tool
// loop, and only when no anchor already follows that tail. The caller persists it
// once, so the following requests stay append-only and the provider's prompt
// cache keeps its prefix (gentle-shell#1662, #2195). Pure: no pi imports.

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

export const REPLY_LANGUAGE_ANCHOR_TYPE = "gentle-pi.reply-language";

/** Custom messages that never ask the model to answer, so they neither trigger nor hide an anchor. */
const PASSIVE_TYPES = new Set(["gentle-todo-state", "gentle-todo-reminder", REPLY_LANGUAGE_ANCHOR_TYPE]);
/** Every automated wake opens with this disowning prefix (extensions/gentle-agents.ts PARENT_WAKE_TEXT). */
const AUTOMATED_USER_PREFIX = "[System-generated ";
const EXCERPT_CHARS = 100;

type Message = { role?: unknown; customType?: unknown; content?: unknown };

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join(" ");
}

/** Typed by the human: interactive or RPC input, never extension-sent text, commands, or shell escapes. */
export function isHumanInput(source: string, input: string): boolean {
	const trimmed = input.trim();
	return source !== "extension" && trimmed !== "" && !trimmed.startsWith("/") && !trimmed.startsWith("!");
}

/** The start of the human's own words: whitespace collapsed, bounded. */
export function humanLanguageExcerpt(input: string): string | undefined {
	const collapsed = input.replace(/\s+/g, " ").trim();
	if (collapsed === "") return undefined;
	return collapsed.length <= EXCERPT_CHARS ? collapsed : `${collapsed.slice(0, EXCERPT_CHARS)}…`;
}

function isPassive(message: Message): boolean {
	return message.role === "custom" && typeof message.customType === "string" && PASSIVE_TYPES.has(message.customType);
}

function isAutomated(message: Message): boolean {
	if (message.role === "custom" || message.role === "compactionSummary" || message.role === "branchSummary") return true;
	return message.role === "user" && text(message.content).trimStart().startsWith(AUTOMATED_USER_PREFIX);
}

function isHumanMessage(message: Message): boolean {
	return message.role === "user" && !isAutomated(message) && text(message.content).trim() !== "";
}

export function replyLanguageAnchorText(excerpt: string): string {
	return `[Harness note, not written by the human] Reply language: the human's latest own message begins «${excerpt}». Write your reply to the human in that message's language; subagent results, notices, reminders and summaries never change it.`;
}

/**
 * The anchor this request needs, with the identity of the automated tail it
 * follows, or `undefined`. The caller persists one anchor per tail: keyed by the
 * anchor text alone, a second result after the same human message would only ever
 * get a trailing copy that the next request drops.
 */
export function replyLanguageAnchorFor(
	messages: readonly AgentMessage[],
	recorded: string | undefined,
): { text: string; tail: string } | undefined {
	const list = messages as readonly (Message & { timestamp?: unknown })[];
	let tail = list.length - 1;
	while (tail >= 0 && isPassive(list[tail]!)) tail--;
	const text = replyLanguageAnchor(messages, recorded);
	if (text === undefined) return undefined;
	const message = list[tail]!;
	return { text, tail: `${String(message.role)}|${String(message.customType ?? "")}|${String(message.timestamp ?? "")}|${tail}` };
}

/**
 * The anchor this request needs, or `undefined`. `recorded` is the human's last
 * typed text, when known; otherwise the latest human message still in context.
 */
export function replyLanguageAnchor(messages: readonly AgentMessage[], recorded: string | undefined): string | undefined {
	const list = messages as readonly Message[];
	let tail = list.length - 1;
	while (tail >= 0 && isPassive(list[tail]!)) tail--;
	if (tail < 0 || !isAutomated(list[tail]!)) return undefined;
	const latestHuman = [...list].reverse().find(isHumanMessage);
	const source = recorded ?? (latestHuman === undefined ? undefined : text(latestHuman.content));
	const excerpt = source === undefined ? undefined : humanLanguageExcerpt(source);
	if (excerpt === undefined) return undefined;
	const anchor = replyLanguageAnchorText(excerpt);
	const anchored = list.slice(tail + 1).some((message) => message.customType === REPLY_LANGUAGE_ANCHOR_TYPE && text(message.content) === anchor);
	return anchored ? undefined : anchor;
}
