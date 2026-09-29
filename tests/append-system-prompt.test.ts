import assert from "node:assert/strict";
import test from "node:test";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";

// gentle-shell#1485: pi-claude-bridge forwards only the structured
// systemPromptOptions parts of before_agent_start, so extensions must mutate
// options.appendSystemPrompt instead of returning a replacement systemPrompt.

test("appends to an empty appendSystemPrompt, stripped of a leading blank line", () => {
	const options = { appendSystemPrompt: "" };
	appendSystemPromptOnce(options, "\n\nHarness block");
	assert.equal(options.appendSystemPrompt, "Harness block");
});

test("appends after existing content with a blank-line separator", () => {
	const options = { appendSystemPrompt: "user APPEND_SYSTEM.md content" };
	appendSystemPromptOnce(options, "\n\nHarness block");
	assert.equal(options.appendSystemPrompt, "user APPEND_SYSTEM.md content\n\nHarness block");
});

test("is idempotent: the same text is never appended twice to the same options object", () => {
	const options = { appendSystemPrompt: "" };
	appendSystemPromptOnce(options, "\n\nHarness block");
	appendSystemPromptOnce(options, "\n\nHarness block");
	assert.equal(options.appendSystemPrompt, "Harness block");
	assert.equal(options.appendSystemPrompt.split("Harness block").length - 1, 1);
});

test("two different callers accumulate without erasing each other", () => {
	const options = { appendSystemPrompt: "" };
	appendSystemPromptOnce(options, "\n\nGentle AI harness");
	appendSystemPromptOnce(options, "\n\nTodo list block");
	assert.equal(options.appendSystemPrompt, "Gentle AI harness\n\nTodo list block");
});

test("empty or blank text is a no-op", () => {
	const options = { appendSystemPrompt: "kept" };
	appendSystemPromptOnce(options, "");
	appendSystemPromptOnce(options, "\n\n");
	assert.equal(options.appendSystemPrompt, "kept");
});

test("a missing options object never throws", () => {
	assert.doesNotThrow(() => appendSystemPromptOnce(undefined, "\n\nHarness block"));
	assert.doesNotThrow(() => appendSystemPromptOnce(null, "\n\nHarness block"));
});
