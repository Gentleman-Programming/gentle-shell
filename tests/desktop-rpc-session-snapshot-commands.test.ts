import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDesktopFeedSnapshot, DESKTOP_FEED_BUILTIN_COMMANDS, type DesktopFeedInput } from "../lib/desktop-feed.ts";
import { projectDesktopSessionSections } from "../lib/desktop-rpc-session.ts";

// get_snapshot { sections: ["commands"] } and session_snapshot carry the feed's own
// commands section: `rpc` reaches the wire next to an unchanged `terminal`.

function input(commands: DesktopFeedInput["commands"]): DesktopFeedInput {
	return {
		now: Date.UTC(2026, 10, 14, 12, 0, 0),
		identity: { sessionId: "sess-1", sessionFile: undefined, sessionName: undefined, cwd: "/home/dev/work/gentle-shell", realCwd: undefined, pid: 100, ppid: 99, ancestors: [], mode: "rpc", agentDir: "/agent", env: {} },
		branch: undefined,
		model: undefined,
		thinkingLevel: undefined,
		subscription: false,
		profile: { name: undefined, tier: undefined },
		context: undefined,
		usage: undefined,
		permission: undefined,
		todo: { tasks: [], nextId: 1, updatedTurn: 0 },
		changes: undefined,
		agents: undefined,
		jobs: undefined,
		review: undefined,
		stats: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, toolCalls: 0, toolErrors: 0, spanMs: 0, cacheHitRate: null, models: [] },
		activity: { working: false, blocked: 0, blockedLabel: undefined, streaming: false, phase: undefined },
		pendingQuestion: undefined,
		commands,
	} as DesktopFeedInput;
}

test("S4: the commands section projects `rpc` and keeps `terminal` for every item", () => {
	const snapshot = buildDesktopFeedSnapshot(input([
		{ name: "gentle:status", description: "notify only", source: "extension" },
		{ name: "gentle:panel", description: "ui.custom sheet", source: "extension" },
		{ name: "third-party:thing", description: "undeclared", source: "extension" },
		{ name: "review", description: "template", source: "prompt" },
	]));
	const { commands } = projectDesktopSessionSections(snapshot, ["commands"]);
	assert.deepEqual(commands, snapshot.commands, "no separate whitelist drops a field");
	assert.deepEqual(commands!.items.slice(DESKTOP_FEED_BUILTIN_COMMANDS.length), [
		{ name: "gentle:status", description: "notify only", args: null, terminal: true, rpc: true, source: "extension" },
		{ name: "gentle:panel", description: "ui.custom sheet", args: null, terminal: true, rpc: false, source: "extension" },
		{ name: "third-party:thing", description: "undeclared", args: null, terminal: true, rpc: false, source: "extension" },
		{ name: "review", description: "template", args: null, terminal: false, rpc: true, source: "prompt" },
	]);
	assert.equal(commands!.items.find((item) => item.name === "new")!.rpc, true);
	assert.equal(commands!.items.find((item) => item.name === "resume")!.rpc, false);
});
