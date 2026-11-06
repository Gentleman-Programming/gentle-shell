import assert from "node:assert/strict";
import test from "node:test";
import { sessionToMarkdown } from "../lib/agents-transcript.ts";

// Gentle Agents transcript: session JSONL in, readable markdown out.

const session = [
	JSON.stringify({ type: "session", version: 3, id: "x" }),
	JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-terra" }),
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Map lib/." }] } }),
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls  lib" } }] } }),
	JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: Array.from({ length: 45 }, (_, index) => `f${index}.ts`).join("\n") }] } }),
	JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "grep", isError: true, content: [{ type: "text", text: "\x1b[31mno matches\x1b[0m" }] } }),
	"not json",
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Three files.\n" }] } }),
].join("\n");

test("sessionToMarkdown writes user, tool calls with results, and assistant text, dropping thinking and noise", () => {
	const markdown = sessionToMarkdown(session, { title: "explore · map lib", maxOutputLines: 40 });
	assert.match(markdown, /^# explore · map lib\n\n## User\n\nMap lib\/\.\n\n### ▸ bash ls lib\n\n<!-- bash -->\n```\n… 5 earlier lines omitted\nf5\.ts\n/);
	assert.match(markdown, /<!-- grep error -->\n```\nno matches\n```/);
	assert.match(markdown, /## Assistant\n\nThree files\.\n$/);
	assert.doesNotMatch(markdown, /secret/);
	assert.equal(sessionToMarkdown(""), "# Subagent transcript\n");
});

test("sessionToMarkdown widens the fence when the output itself contains backticks", () => {
	const line = JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "```ts\nlet a = 1\n```" }] } });
	assert.match(sessionToMarkdown(line), /````\n```ts\nlet a = 1\n```\n````/);
});
