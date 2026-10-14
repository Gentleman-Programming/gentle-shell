import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/history-search.ts";
import type { SessionEntry } from "../extensions/history-search.ts";

const { collectBashCommands } = __testing;

function bashExecutionEntry(command: string): SessionEntry {
	return {
		type: "message",
		message: { role: "bashExecution", command },
	};
}

function assistantBashEntry(command: string): SessionEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "running..." },
				{
					type: "toolCall",
					name: "bash",
					arguments: { command },
				},
			],
		},
	};
}

function assistantNonBashEntry(): SessionEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					name: "read",
					arguments: { path: "/tmp/x" },
				},
			],
		},
	};
}

function malformedToolCallEntry(): SessionEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "bash", arguments: {} },
				{ type: "toolCall", name: "bash" },
				{ type: "toolCall" },
			],
		},
	};
}

test("collects commands from bashExecution role messages", () => {
	const entries: SessionEntry[] = [
		bashExecutionEntry("ls -la"),
		bashExecutionEntry("pwd"),
	];
	const commands = collectBashCommands(entries);
	assert.deepEqual(commands, ["ls -la", "pwd"]);
});

test("collects commands from assistant toolCall blocks where name === 'bash'", () => {
	const entries: SessionEntry[] = [
		assistantBashEntry("npm test"),
		assistantBashEntry("git status"),
	];
	const commands = collectBashCommands(entries);
	assert.deepEqual(commands, ["npm test", "git status"]);
});

test("mixes bashExecution and assistant-toolCall sources in session order", () => {
	const entries: SessionEntry[] = [
		bashExecutionEntry("ls"),
		assistantBashEntry("pwd"),
		bashExecutionEntry("echo hi"),
	];
	assert.deepEqual(collectBashCommands(entries), ["ls", "pwd", "echo hi"]);
});

test("skips assistant toolCall blocks that are not bash", () => {
	const entries: SessionEntry[] = [
		assistantNonBashEntry(),
		bashExecutionEntry("real"),
	];
	assert.deepEqual(collectBashCommands(entries), ["real"]);
});

test("skips malformed bash blocks (missing arguments.command)", () => {
	const entries: SessionEntry[] = [malformedToolCallEntry()];
	assert.deepEqual(collectBashCommands(entries), []);
});

test("returns empty array for empty entries", () => {
	assert.deepEqual(collectBashCommands([]), []);
});

test("skips entries whose type is not 'message'", () => {
	const entries = [
		{ type: "compaction", summary: "..." },
		bashExecutionEntry("pwd"),
	] as unknown as SessionEntry[];
	assert.deepEqual(collectBashCommands(entries), ["pwd"]);
});
