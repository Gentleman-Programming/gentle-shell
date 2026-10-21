// Rolling window context pruning for historical tool outputs.
export const DEFAULT_MAX_RETAINED_CHARS = 4_000;
export const DEFAULT_RECENT_TURNS_TO_KEEP = 2;

export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
	"subagent_run",
	"subagent_result",
	"subagent_status",
	"subagent_list_tasks",
	"subagent_continue",
	"gentle_review",
	"gentle_review_capture",
	"gentle_review_capture_group",
	"gentle_review_scope",
	"mem_save",
	"mem_get_observation",
	"mem_search",
	"mem_context",
	"mem_timeline",
	"todo",
	"ask_user_choice",
	"ask_user_question",
	"orchestrator_session_id",
	"orchestrator_consult",
]);

export function isProtectedToolResult(message: any): boolean {
	const toolName = typeof message?.toolName === "string" ? message.toolName : typeof message?.name === "string" ? message.name : "";
	return PROTECTED_TOOL_NAMES.has(toolName);
}

const SYNTHETIC_SUBAGENT_NOTIFICATION_PATTERN = /^Subagent\s+\S+\s+\(task\s+[^)]+\)\s+(?:finished|timed out|failed)\b/i;

function getUserMessageText(message: any): string {
	if (typeof message?.content === "string") {
		return message.content;
	}
	if (Array.isArray(message?.content)) {
		const textParts = message.content.filter(
			(part: any) => part && (part.type === "text" || typeof part === "string"),
		);
		if (textParts.length > 0) {
			return textParts
				.map((part: any) => (typeof part === "string" ? part : (part.text ?? "")))
				.join("\n");
		}
	}
	if (typeof message?.text === "string") {
		return message.text;
	}
	return "";
}

export function isSyntheticSubagentNotification(message: any): boolean {
	if (!message || message.role !== "user") {
		return false;
	}
	const text = getUserMessageText(message).trim();
	return SYNTHETIC_SUBAGENT_NOTIFICATION_PATTERN.test(text);
}

export interface ContextPruningOptions {
	enabled?: boolean;
	recentTurnsToKeep?: number;
	maxRetainedChars?: number;
}

export function isContextPruningEnabled(options?: ContextPruningOptions): boolean {
	if (options?.enabled === false) return false;
	if (options?.enabled === true) return true;
	const env = process.env.GENTLE_PI_CONTEXT_PRUNING?.trim().toLowerCase();
	if (env === "off" || env === "false" || env === "0") return false;
	return true;
}

export function extractErrorExcerpt(text: string, maxChars: number = 150): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	const excerpt = lines.slice(0, 2).join("\n");
	return excerpt.length > maxChars ? excerpt.slice(0, maxChars) : excerpt;
}

function getToolResultText(message: any): string | undefined {
	if (typeof message?.content === "string") {
		return message.content;
	}
	if (Array.isArray(message?.content)) {
		const textParts = message.content.filter(
			(part: any) => part && (part.type === "text" || typeof part === "string"),
		);
		if (textParts.length > 0) {
			return textParts
				.map((part: any) => (typeof part === "string" ? part : (part.text ?? "")))
				.join("\n");
		}
	}
	if (typeof message?.text === "string") {
		return message.text;
	}
	return undefined;
}

function pruneToolResultMessage<T extends Record<string, unknown>>(
	message: T,
	replacementText: string,
): T {
	const pruned: any = { ...message };
	if (typeof message.content === "string") {
		pruned.content = replacementText;
	} else if (Array.isArray(message.content)) {
		let replaced = false;
		const newContent: any[] = [];
		for (const part of message.content) {
			if (part && part.type === "text") {
				if (!replaced) {
					newContent.push({ ...part, text: replacementText });
					replaced = true;
				}
			} else if (typeof part === "string") {
				if (!replaced) {
					newContent.push(replacementText);
					replaced = true;
				}
			} else {
				newContent.push(part);
			}
		}
		if (!replaced) {
			newContent.unshift({ type: "text", text: replacementText });
		}
		pruned.content = newContent;
	}
	if (typeof message.text === "string") {
		pruned.text = replacementText;
	}
	return pruned;
}

export function pruneContextMessages<T = any>(
	messages: readonly T[],
	options?: ContextPruningOptions,
): T[] {
	if (!isContextPruningEnabled(options) || !Array.isArray(messages) || messages.length === 0) {
		return [...messages];
	}

	const recentTurnsToKeep = options?.recentTurnsToKeep ?? DEFAULT_RECENT_TURNS_TO_KEEP;
	const maxRetainedChars = options?.maxRetainedChars ?? DEFAULT_MAX_RETAINED_CHARS;

	const userIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg: any = messages[i];
		if (msg && msg.role === "user" && !isSyntheticSubagentNotification(msg)) {
			userIndices.push(i);
		}
	}

	let recentStartIndex: number;
	if (recentTurnsToKeep <= 0) {
		recentStartIndex = messages.length;
	} else if (userIndices.length <= recentTurnsToKeep) {
		recentStartIndex = 0;
	} else {
		recentStartIndex = userIndices[userIndices.length - recentTurnsToKeep]!;
	}

	return messages.map((msg: any, index: number) => {
		if (index >= recentStartIndex) {
			return msg;
		}
		if (!msg || msg.role !== "toolResult") {
			return msg;
		}
		if (isProtectedToolResult(msg)) {
			return msg;
		}

		const origText = getToolResultText(msg);
		if (origText === undefined || origText.length <= maxRetainedChars) {
			return msg;
		}
		if (origText.startsWith("[Output omitted from LLM context:")) {
			return msg;
		}

		const origLen = origText.length;
		const lines = origText.split(/\r?\n/).length;

		let replacementText: string;
		if (msg.isError === true) {
			const errorExcerpt = extractErrorExcerpt(origText);
			replacementText = `[Output omitted from LLM context: ${origLen} chars, ${lines} lines. Error summary: ${errorExcerpt}. Full output preserved in session history.]`;
		} else {
			replacementText = `[Output omitted from LLM context: ${origLen} chars, ${lines} lines. Preserved in session history.]`;
		}

		return pruneToolResultMessage(msg, replacementText);
	});
}
