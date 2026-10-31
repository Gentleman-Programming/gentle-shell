import { declaredHighRiskItem, isVerifierLaunch } from "./verifier-admission.ts";

// odd/tasks/verifier-settle-reminder.md (#2652): verifier admission only gates a launch that happens, so a run could
// declare `Risk: item N` in its final message and settle without ever attempting the independent verifier. At settle,
// such a primary run gets one visible reminder and one continuation; the declaration uses the admission grammar and
// any `gentle-ai-verify` launch attempt in the same user prompt, admitted or rejected, counts as an attempt.
export const VERIFIER_SETTLE_REMINDER_TYPE = "gentle-pi.verifier-settle-reminder";

export function verifierSettleReminderText(item: number): string {
	return `Verification reminder: your final message declares \`Risk: item ${item}\`, but no independent verifier was launched for this prompt. Now launch \`gentle-ai-verify\` with the \`Risk: item ${item}\` line in its \`task\`. A user's visual or manual approval does not replace technical verification. If verification is unavailable, close with **Needs your decision** naming the missing proof.`;
}

// The text of the last assistant message, or undefined when the run has none.
export function finalAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return undefined;
		return content
			.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
			.map(part => part.text)
			.join("");
	}
	return undefined;
}

interface PromptState {
	verifierAttempted: boolean;
	reminded: boolean;
}

// Per session, the state of the current user prompt. A continuation starts a new agent run within the same prompt, so
// only a new user prompt resets it; that is what keeps the reminder to one per prompt.
export function createVerifierSettleReminders<K>() {
	const prompts = new Map<K, PromptState>();
	const state = (key: K): PromptState => {
		let current = prompts.get(key);
		if (!current) {
			current = { verifierAttempted: false, reminded: false };
			prompts.set(key, current);
		}
		return current;
	};
	return {
		userPrompt(key: K): void {
			prompts.set(key, { verifierAttempted: false, reminded: false });
		},
		// Record before admission runs, so a rejected launch still counts as attempted.
		toolCall(key: K, toolName: string, input: unknown): void {
			if (toolName === "subagent_run" && isVerifierLaunch(input)) state(key).verifierAttempted = true;
		},
		// The reminder to append at this settle, or undefined when none is due.
		beforeSettle(key: K, finalText: string | undefined): string | undefined {
			const current = state(key);
			if (current.reminded || current.verifierAttempted || finalText === undefined) return undefined;
			const item = declaredHighRiskItem(finalText);
			if (item === undefined) return undefined;
			current.reminded = true;
			return verifierSettleReminderText(item);
		},
	};
}
