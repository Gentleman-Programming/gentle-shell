// Context pruning test suite: rolling window protection for historical tool outputs.
import assert from "node:assert/strict";
import test from "node:test";
import {
	type ContextPruningOptions,
	DEFAULT_MAX_RETAINED_CHARS,
	DEFAULT_RECENT_TURNS_TO_KEEP,
	isProtectedToolResult,
	isSyntheticSubagentNotification,
	PROTECTED_TOOL_NAMES,
	pruneContextMessages,
} from "../lib/context-pruning.ts";

function createUserMessage(text: string) {
	return { role: "user", content: text };
}

function createAssistantMessage(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function createToolResultMessage(options: {
	toolName?: string;
	toolCallId?: string;
	content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
	isError?: boolean;
}) {
	const {
		toolName = "bash",
		toolCallId = "call_1",
		content = [{ type: "text", text: "ok" }],
		isError = false,
	} = options;
	return {
		role: "toolResult",
		toolName,
		toolCallId,
		content,
		isError,
	};
}

test("empty or short conversation returns unchanged", () => {
	// Empty array
	const empty: any[] = [];
	const emptyResult = pruneContextMessages(empty);
	assert.deepEqual(emptyResult, []);

	// No user turns (only system or assistant)
	const sys = { role: "system", content: "You are an assistant" };
	const noUserMessages = [sys];
	const noUserResult = pruneContextMessages(noUserMessages);
	assert.equal(noUserResult.length, 1);
	assert.equal(noUserResult[0], sys);

	// Single user turn with verbose tool result (< 2 user turns, so it is within recent turns)
	const verboseOutput = "line\n".repeat(100); // 500 chars, 101 lines
	const user1 = createUserMessage("First user prompt");
	const assistant1 = createAssistantMessage("Running tool");
	const tool1 = createToolResultMessage({
		content: [{ type: "text", text: verboseOutput }],
	});

	const singleTurn = [user1, assistant1, tool1];
	const singleTurnResult = pruneContextMessages(singleTurn);
	assert.equal(singleTurnResult.length, 3);
	// Tool result in the only turn is recent, so it is preserved by reference
	assert.equal(singleTurnResult[0], user1);
	assert.equal(singleTurnResult[1], assistant1);
	assert.equal(singleTurnResult[2], tool1);

	// Two user turns: both are within default recentTurnsToKeep (2)
	const user2 = createUserMessage("Second user prompt");
	const assistant2 = createAssistantMessage("Running second tool");
	const tool2 = createToolResultMessage({
		content: [{ type: "text", text: verboseOutput }],
	});

	const twoTurns = [user1, assistant1, tool1, user2, assistant2, tool2];
	const twoTurnsResult = pruneContextMessages(twoTurns);
	assert.equal(twoTurnsResult.length, 6);
	assert.equal(twoTurnsResult[2], tool1);
	assert.equal(twoTurnsResult[5], tool2);
});

test("preserves toolResults in recent turns intact (recentTurnsToKeep = 2)", () => {
	const verboseText = "output line\n".repeat(50); // 600 chars

	const user1 = createUserMessage("Turn 1 user");
	const tool1 = createToolResultMessage({
		content: [{ type: "text", text: verboseText }],
	});
	const user2 = createUserMessage("Turn 2 user");
	const tool2 = createToolResultMessage({
		content: [{ type: "text", text: verboseText }],
	});
	const user3 = createUserMessage("Turn 3 user");
	const tool3 = createToolResultMessage({
		content: [{ type: "text", text: verboseText }],
	});

	const messages = [user1, tool1, user2, tool2, user3, tool3];
	const result = pruneContextMessages(messages, { recentTurnsToKeep: 2, maxRetainedChars: 400 });

	// Turn 1 is older: tool1 is pruned
	assert.notEqual(result[1], tool1);

	// Turn 2 and Turn 3 are in the recent window: tool2 and tool3 must remain untouched (same reference)
	assert.equal(result[3], tool2);
	assert.equal(result[5], tool3);

	// Unmodified messages must preserve their reference
	assert.equal(result[0], user1);
	assert.equal(result[2], user2);
	assert.equal(result[4], user3);
});

test("prunes verbose toolResults from older turns while keeping recent turns intact", () => {
	const verboseLines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
	const origLen = verboseLines.length;
	const lineCount = 80;

	const user1 = createUserMessage("turn 1");
	const tool1 = createToolResultMessage({
		content: [{ type: "text", text: verboseLines }],
	});
	const user2 = createUserMessage("turn 2");
	const user3 = createUserMessage("turn 3");
	const tool3 = createToolResultMessage({
		content: [{ type: "text", text: verboseLines }],
	});

	const messages = [user1, tool1, user2, user3, tool3];
	const result = pruneContextMessages(messages, { maxRetainedChars: 400 });

	// tool1 in turn 1 is pruned
	const prunedTool1 = result[1] as any;
	assert.equal(prunedTool1.role, "toolResult");
	assert.equal(prunedTool1.toolName, "bash");
	assert.equal(prunedTool1.isError, false);
	assert.equal(
		prunedTool1.content[0].text,
		`[Output omitted from LLM context: ${origLen} chars, ${lineCount} lines. Preserved in session history.]`,
	);

	// tool3 in recent turn 3 remains unchanged
	assert.equal(result[4], tool3);

	// Also tests string content representation
	const toolWithString = createToolResultMessage({
		content: verboseLines,
	});
	const messagesString = [user1, toolWithString, user2, user3];
	const resultString = pruneContextMessages(messagesString, { maxRetainedChars: 400 });
	const prunedToolString = resultString[1] as any;
	assert.equal(
		prunedToolString.content,
		`[Output omitted from LLM context: ${origLen} chars, ${lineCount} lines. Preserved in session history.]`,
	);
});

test("short toolResults in older turns (< maxRetainedChars) are not pruned", () => {
	const shortOutput = "short tool output: all good"; // ~27 chars
	const user1 = createUserMessage("turn 1");
	const tool1 = createToolResultMessage({
		content: [{ type: "text", text: shortOutput }],
	});
	const user2 = createUserMessage("turn 2");
	const user3 = createUserMessage("turn 3");

	const messages = [user1, tool1, user2, user3];
	const result = pruneContextMessages(messages);

	// tool1 has < 400 chars, so it remains unmodified (same reference)
	assert.equal(result[1], tool1);

	// Custom maxRetainedChars option
	const mediumText = "a".repeat(100);
	const toolMedium = createToolResultMessage({
		content: [{ type: "text", text: mediumText }],
	});
	const messagesMedium = [user1, toolMedium, user2, user3];

	// With threshold = 50, mediumText (100) is pruned
	const prunedMedium = pruneContextMessages(messagesMedium, { maxRetainedChars: 50 });
	assert.notEqual(prunedMedium[1], toolMedium);

	// With threshold = 200, mediumText (100) is NOT pruned
	const keptMedium = pruneContextMessages(messagesMedium, { maxRetainedChars: 200 });
	assert.equal(keptMedium[1], toolMedium);
});

test("retains error excerpts when a pruned toolResult has isError: true", () => {
	const errorText = [
		"TypeError: Cannot read properties of undefined (reading 'foo')",
		"    at processFile (file:///app/index.ts:42:15)",
		"    at async run (file:///app/index.ts:100:5)",
		...Array.from({ length: 40 }, (_, i) => `    at stackFrame${i} (node:internal:1:1)`),
	].join("\n");
	const origLen = errorText.length;
	const lines = errorText.split("\n").length;

	const user1 = createUserMessage("turn 1");
	const tool1 = createToolResultMessage({
		content: [{ type: "text", text: errorText }],
		isError: true,
	});
	const user2 = createUserMessage("turn 2");
	const user3 = createUserMessage("turn 3");

	const messages = [user1, tool1, user2, user3];
	const result = pruneContextMessages(messages, { maxRetainedChars: 400 });

	const prunedTool1 = result[1] as any;
	assert.equal(prunedTool1.isError, true);
	const text = prunedTool1.content[0].text;

	assert.ok(
		text.startsWith(`[Output omitted from LLM context: ${origLen} chars, ${lines} lines. Error summary:`),
	);
	assert.ok(text.endsWith(". Full output preserved in session history.]"));
	assert.ok(text.includes("TypeError: Cannot read properties of undefined (reading 'foo')"));
	assert.ok(text.includes("at processFile (file:///app/index.ts:42:15)"));
	// Lines beyond the first 1-2 should not be in the excerpt
	assert.ok(!text.includes("stackFrame30"));

	// Long single-line error bounded to ~150 chars
	const longErrorLine = "Error: " + "E".repeat(300) + "\n" + "more error lines\n".repeat(30);
	const toolLongError = createToolResultMessage({
		content: [{ type: "text", text: longErrorLine }],
		isError: true,
	});
	const messagesLongError = [user1, toolLongError, user2, user3];
	const resultLongError = pruneContextMessages(messagesLongError, { maxRetainedChars: 400 });
	const prunedLongErrorText = (resultLongError[1] as any).content[0].text;
	assert.ok(prunedLongErrorText.includes("Error summary: "));
	assert.ok(prunedLongErrorText.endsWith(". Full output preserved in session history.]"));
});

test("respects enabled: false and GENTLE_PI_CONTEXT_PRUNING=off to bypass pruning", () => {
	const verboseText = "long output\n".repeat(400);
	const user1 = createUserMessage("turn 1");
	const tool1 = createToolResultMessage({
		content: [{ type: "text", text: verboseText }],
	});
	const user2 = createUserMessage("turn 2");
	const user3 = createUserMessage("turn 3");
	const messages = [user1, tool1, user2, user3];

	// Disabled via options
	const resultDisabled = pruneContextMessages(messages, { enabled: false });
	assert.equal(resultDisabled[1], tool1);

	// Disabled via environment GENTLE_PI_CONTEXT_PRUNING=off
	const originalEnv = process.env.GENTLE_PI_CONTEXT_PRUNING;
	try {
		process.env.GENTLE_PI_CONTEXT_PRUNING = "off";
		const resultEnvOff = pruneContextMessages(messages);
		assert.equal(resultEnvOff[1], tool1);

		process.env.GENTLE_PI_CONTEXT_PRUNING = "false";
		const resultEnvFalse = pruneContextMessages(messages);
		assert.equal(resultEnvFalse[1], tool1);

		process.env.GENTLE_PI_CONTEXT_PRUNING = "0";
		const resultEnvZero = pruneContextMessages(messages);
		assert.equal(resultEnvZero[1], tool1);

		// Explicit enabled: true overrides environment disable
		const resultOverride = pruneContextMessages(messages, { enabled: true });
		assert.notEqual(resultOverride[1], tool1);
	} finally {
		if (originalEnv === undefined) {
			delete process.env.GENTLE_PI_CONTEXT_PRUNING;
		} else {
			process.env.GENTLE_PI_CONTEXT_PRUNING = originalEnv;
		}
	}
});

test("triangulation: recentTurnsToKeep customization (0 and 1)", () => {
	const verboseText = "long line\n".repeat(50);
	const user1 = createUserMessage("turn 1");
	const tool1 = createToolResultMessage({ content: [{ type: "text", text: verboseText }] });
	const user2 = createUserMessage("turn 2");
	const tool2 = createToolResultMessage({ content: [{ type: "text", text: verboseText }] });

	const messages = [user1, tool1, user2, tool2];

	// recentTurnsToKeep = 1: turn 1 pruned, turn 2 kept
	const opts1: ContextPruningOptions = { recentTurnsToKeep: 1, maxRetainedChars: 400 };
	const res1 = pruneContextMessages(messages, opts1);
	assert.notEqual(res1[1], tool1);
	assert.equal(res1[3], tool2);

	// recentTurnsToKeep = 0: both turn 1 and turn 2 pruned
	const res0 = pruneContextMessages(messages, { recentTurnsToKeep: 0, maxRetainedChars: 400 });
	assert.notEqual(res0[1], tool1);
	assert.notEqual(res0[3], tool2);
});

test("triangulation: preserves non-text parts and does not mutate originals", () => {
	const verboseText = "log output\n".repeat(60);
	const imagePart = { type: "image", data: "base64data", mimeType: "image/png" };
	const originalContent = [{ type: "text", text: verboseText }, imagePart];
	const tool = createToolResultMessage({ content: originalContent });

	const messages = [
		createUserMessage("turn 1"),
		tool,
		createUserMessage("turn 2"),
		createUserMessage("turn 3"),
	];

	const res = pruneContextMessages(messages, { maxRetainedChars: 400 });
	const prunedTool = res[1] as any;

	// Original object was not mutated
	assert.equal((tool.content as any)[0].text, verboseText);
	assert.equal((tool.content as any)[1], imagePart);

	// Pruned object contains updated text part and preserved image part
	assert.equal(prunedTool.content.length, 2);
	assert.ok(prunedTool.content[0].text.startsWith("[Output omitted from LLM context:"));
	assert.equal(prunedTool.content[1], imagePart);
});

test("DEFAULT_MAX_RETAINED_CHARS is 4000: normal 1500-char outputs are retained while >4000-char dumps are pruned", () => {
	assert.equal(DEFAULT_MAX_RETAINED_CHARS, 4_000);
	assert.equal(DEFAULT_RECENT_TURNS_TO_KEEP, 2);

	const normalOutput = "x".repeat(1_500);
	const hugeDump = "d".repeat(4_500);

	const toolNormal = createToolResultMessage({
		toolName: "read",
		content: [{ type: "text", text: normalOutput }],
	});
	const toolHuge = createToolResultMessage({
		toolName: "bash",
		content: [{ type: "text", text: hugeDump }],
	});

	const messages = [
		createUserMessage("turn 1"),
		toolNormal,
		toolHuge,
		createUserMessage("turn 2"),
		createUserMessage("turn 3"),
	];

	const result = pruneContextMessages(messages);
	// 1500 chars is <= 4000 default threshold -> preserved by reference
	assert.equal(result[1], toolNormal);
	// 4500 chars is > 4000 default threshold -> pruned
	assert.notEqual(result[2], toolHuge);
	assert.ok((result[2] as any).content[0].text.startsWith("[Output omitted from LLM context: 4500 chars"));
});

test("PROTECTED_TOOL_NAMES are never pruned regardless of size or age", () => {
	const largePayload = "p".repeat(6_000);
	const protectedTools = [
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
	];

	for (const name of protectedTools) {
		assert.ok(PROTECTED_TOOL_NAMES.has(name), `${name} must be in PROTECTED_TOOL_NAMES`);
		const msgWithToolName = createToolResultMessage({
			toolName: name,
			content: [{ type: "text", text: largePayload }],
		});
		assert.equal(isProtectedToolResult(msgWithToolName), true);

		const msgWithNameField = {
			role: "toolResult",
			name,
			content: [{ type: "text", text: largePayload }],
		};
		assert.equal(isProtectedToolResult(msgWithNameField), true);

		const messages = [
			createUserMessage("turn 1"),
			msgWithToolName,
			msgWithNameField,
			createUserMessage("turn 2"),
			createUserMessage("turn 3"),
		];
		const pruned = pruneContextMessages(messages, { maxRetainedChars: 100 });
		assert.equal(pruned[1], msgWithToolName, `${name} (toolName) must never be pruned`);
		assert.equal(pruned[2], msgWithNameField, `${name} (name) must never be pruned`);
	}

	assert.equal(isProtectedToolResult(createToolResultMessage({ toolName: "bash" })), false);
});

test("synthetic background subagent notifications do not count as human turns", () => {
	const finishedNotif = createUserMessage('Subagent gentle-ai-worker (task abc, "implement feature") finished.\nResult summary...');
	const timedOutNotif = createUserMessage("Subagent gentle-ai-explore (task def, \"scan repo\") timed out.");
	const failedNotif = createUserMessage("Subagent worker (task xyz) failed: exit code 1");
	const realUser1 = createUserMessage("Human turn 1");
	const realUser2 = createUserMessage("Human turn 2");

	assert.equal(isSyntheticSubagentNotification(finishedNotif), true);
	assert.equal(isSyntheticSubagentNotification(timedOutNotif), true);
	assert.equal(isSyntheticSubagentNotification(failedNotif), true);
	assert.equal(isSyntheticSubagentNotification(realUser1), false);
	assert.equal(isSyntheticSubagentNotification({ role: "assistant", content: "Subagent worker (task abc) finished." }), false);

	const largeOutput = "z".repeat(5_000);
	const toolInHumanTurn1 = createToolResultMessage({
		toolName: "bash",
		content: [{ type: "text", text: largeOutput }],
	});

	// 2 real human turns + 3 synthetic subagent notifications after them.
	// With recentTurnsToKeep = 2, realUser1 is still within the last 2 human turns!
	const messages = [
		realUser1,
		toolInHumanTurn1,
		finishedNotif,
		timedOutNotif,
		realUser2,
		failedNotif,
	];

	const result = pruneContextMessages(messages, { recentTurnsToKeep: 2 });
	assert.equal(
		result[1],
		toolInHumanTurn1,
		"synthetic subagent completion messages must not push realUser1 out of the recent 2-turn window",
	);
});

test("pruneContextMessages is idempotent across repeated invocations", () => {
	const largeOutput = "line content\n".repeat(400); // > 4000 chars
	const tool1 = createToolResultMessage({
		toolName: "bash",
		content: [{ type: "text", text: largeOutput }],
	});
	const messages = [
		createUserMessage("turn 1"),
		tool1,
		createUserMessage("turn 2"),
		createUserMessage("turn 3"),
	];

	// Pass 1 prunes tool1 (even with tiny maxRetainedChars = 10 so replacement string > 10 chars)
	const pass1 = pruneContextMessages(messages, { maxRetainedChars: 10 });
	assert.notEqual(pass1[1], tool1);
	const pass1Text = (pass1[1] as any).content[0].text;
	assert.ok(pass1Text.startsWith("[Output omitted from LLM context:"));

	// Pass 2 on already-pruned messages must return identical object references
	const pass2 = pruneContextMessages(pass1, { maxRetainedChars: 10 });
	assert.equal(pass2[1], pass1[1]);
	assert.equal((pass2[1] as any).content[0].text, pass1Text);
});

