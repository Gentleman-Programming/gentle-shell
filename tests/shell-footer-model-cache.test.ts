import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellBarModel } from "../extensions/gentle-shell.ts";

// gentle-shell#1681: in fullscreen the footer and header rail digests rebuild
// the footer model every frame. The session-derived values (context usage and
// cost) walk the whole session, so they are reused until the session or the
// model changes, keyed on Pi's cheap leaf id and entry count.

interface FakeEntry {
	type: string;
	id: string;
	message?: { role: string; usage?: { cost?: { total?: number } } };
}

function assistant(id: string, cost: number): FakeEntry {
	return { type: "message", id, message: { role: "assistant", usage: { cost: { total: cost } } } };
}

function fakeSession({ entryCount = true }: { entryCount?: boolean } = {}) {
	const calls = { usage: 0, entries: 0, name: 0 };
	const entries: FakeEntry[] = [assistant("a1", 0.5), assistant("a2", 0.25)];
	let leafId: string | null = "a2";
	let sessionName: string | undefined = "Release notes";
	const model = { provider: "openai", id: "gpt-5.5", reasoning: true, contextWindow: 200_000 };
	const sessionManager: Record<string, unknown> = {
		getCwd: () => "/repo",
		getSessionName: () => {
			calls.name += 1;
			return sessionName;
		},
		getLeafId: () => leafId,
		getEntries: () => {
			calls.entries += 1;
			return entries.slice();
		},
	};
	if (entryCount) sessionManager.getEntryCount = () => entries.length;
	const state = { model };
	const ctx = {
		sessionManager,
		get model() {
			return state.model;
		},
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => {
			calls.usage += 1;
			const tokens = entries.length * 1000;
			return { tokens, contextWindow: state.model.contextWindow, percent: (tokens / state.model.contextWindow) * 100 };
		},
	} as unknown as ExtensionContext;
	const pi = { getThinkingLevel: () => "medium" } as unknown as ExtensionAPI;
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	return {
		calls,
		build: () => buildShellBarModel(pi, ctx, footerData, { home: "/home/alan" }),
		append(entry: FakeEntry) {
			entries.push(entry);
			leafId = entry.id;
		},
		rename(name: string) {
			// Pi records a rename as an appended session_info entry.
			entries.push({ type: "session_info", id: `info-${entries.length}` });
			sessionName = name;
		},
		setLeaf(id: string | null) {
			leafId = id;
		},
		setModel(next: Partial<typeof model>) {
			state.model = { ...state.model, ...next };
		},
	};
}

test("an unchanged session and model walk the session once across repeated builds", () => {
	const session = fakeSession();
	const first = session.build();
	for (let frame = 0; frame < 5; frame += 1) assert.deepEqual(session.build(), first);
	assert.equal(session.calls.usage, 1);
	assert.equal(session.calls.entries, 1);
	assert.equal(session.calls.name, 1);
	assert.equal(first.costTotal, 0.75);
	assert.equal(first.contextPercent, 1);
});

test("an append refreshes context usage and cost", () => {
	const session = fakeSession();
	session.build();
	session.append(assistant("a3", 1));
	const built = session.build();
	assert.equal(built.costTotal, 1.75);
	assert.equal(built.contextPercent, 1.5);
	assert.equal(session.calls.usage, 2);
	assert.equal(session.calls.entries, 2);
});

test("a leaf change refreshes the session-derived values", () => {
	const session = fakeSession();
	session.build();
	session.setLeaf("a1");
	session.build();
	assert.equal(session.calls.usage, 2);
	assert.equal(session.calls.entries, 2);
});

test("a model or context-window change refreshes context usage", () => {
	const session = fakeSession();
	session.build();
	session.setModel({ id: "gpt-5.5-mini" });
	assert.equal(session.build().modelId, "gpt-5.5-mini");
	assert.equal(session.calls.usage, 2);
	session.setModel({ provider: "anthropic" });
	session.build();
	assert.equal(session.calls.usage, 3);
	session.setModel({ contextWindow: 100_000 });
	const built = session.build();
	assert.equal(session.calls.usage, 4);
	assert.equal(built.contextWindow, 100_000);
	assert.equal(built.contextPercent, 2);
});

test("without getEntryCount every build recomputes", () => {
	const session = fakeSession({ entryCount: false });
	session.build();
	session.build();
	session.build();
	assert.equal(session.calls.usage, 3);
	assert.equal(session.calls.entries, 3);
});

test("a rename refreshes the cached session name", () => {
	const session = fakeSession();
	assert.equal(session.build().sessionName, "Release notes");
	session.rename("Hotfix");
	assert.equal(session.build().sessionName, "Hotfix");
	assert.equal(session.calls.name, 2);
});
