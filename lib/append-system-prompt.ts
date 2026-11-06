// gentle-shell#1485: pi-claude-bridge only forwards the structured
// systemPromptOptions parts of before_agent_start, dropping any
// handler-returned replacement systemPrompt. Extensions mutate
// options.appendSystemPrompt instead so the harness reaches every provider.
export interface AppendableSystemPromptOptions {
	appendSystemPrompt: string;
}

// Safe to call more than once with the same options object and the same
// text: a text already present is a no-op, so a handler that runs more than
// once against the same systemPromptOptions never duplicates its own block.
export function appendSystemPromptOnce(
	options: AppendableSystemPromptOptions | null | undefined,
	text: string,
): void {
	const normalized = text.replace(/^\n+/, "");
	if (!options || !normalized) return;
	const current = options.appendSystemPrompt ?? "";
	if (current.includes(normalized)) return;
	options.appendSystemPrompt = current ? `${current}\n\n${normalized}` : normalized;
}
