import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { WRITER_CONTEXT_BACKSTOP_TOKENS } from "../lib/bounded-writer-admission.ts";
import {
	EvidenceBudgetGuard,
	EXPLORE_READ_BUDGET_THRESHOLD,
	READ_THRASHING_THRESHOLD,
	ReadThrashingGuard,
	rejectContextBackstopInlineMutation,
	TURN_TOOL_CALL_LIMIT,
	TurnToolCallGuard,
} from "../lib/inline-runaway-guard.ts";

test("Context backstop blocks inline development edits when tokens reach backstop", () => {
	// Tokens below 150k: allowed
	assert.equal(
		rejectContextBackstopInlineMutation(
			{ toolName: "edit", input: { path: "src/persistence.rs" } },
			{ contextTokens: 100_000 },
		),
		undefined,
	);

	// Tokens at or above 150k on code surface: blocked
	const blockedEdit = rejectContextBackstopInlineMutation(
		{ toolName: "edit", input: { path: "src/persistence.rs" } },
		{ contextTokens: WRITER_CONTEXT_BACKSTOP_TOKENS },
	);
	assert.ok(blockedEdit?.block, "must block edit past 150k");
	assert.match(blockedEdit.reason, /Context backstop reached/);
	assert.match(blockedEdit.reason, /delegate this unit of work to gentle-ai-worker/);

	const blockedWrite = rejectContextBackstopInlineMutation(
		{ toolName: "write", input: { path: "tests/pr5_persistence.rs" } },
		{ contextTokens: 180_000 },
	);
	assert.ok(blockedWrite?.block, "must block write past 150k");

	// Non-development surfaces (odd/tasks, docs, tracking) remain permitted
	assert.equal(
		rejectContextBackstopInlineMutation(
			{ toolName: "edit", input: { path: "odd/tasks/crypto-hardening.md" } },
			{ contextTokens: 200_000 },
		),
		undefined,
		"must allow editing odd/tasks tracking docs past 150k",
	);

	assert.equal(
		rejectContextBackstopInlineMutation(
			{ toolName: "write", input: { path: "docs/architecture.md" } },
			{ contextTokens: 200_000 },
		),
		undefined,
		"must allow editing docs past 150k",
	);

	// Non-mutation tools (read, bash) are not blocked by this check
	assert.equal(
		rejectContextBackstopInlineMutation(
			{ toolName: "read", input: { path: "src/persistence.rs" } },
			{ contextTokens: 200_000 },
		),
		undefined,
	);
});

test("EvidenceBudgetGuard blocks extensive inline multi-file exploration", () => {
	const guard = new EvidenceBudgetGuard();

	// Reading up to threshold files is allowed
	for (let i = 1; i <= EXPLORE_READ_BUDGET_THRESHOLD; i++) {
		assert.equal(guard.checkRead({ toolName: "read", input: { path: `src/mod${i}.rs` } }), undefined);
	}

	// 6th distinct file: blocked, forces gentle-ai-explore
	const blocked = guard.checkRead({ toolName: "read", input: { path: "src/mod6.rs" } });
	assert.ok(blocked?.block, "must block 6th distinct source read");
	assert.match(blocked.reason, /Evidence-budget rule triggered/);
	assert.match(blocked.reason, /MUST be delegated to gentle-ai-explore/);

	// Docs and odd/tasks tracking files are exempt
	assert.equal(guard.checkRead({ toolName: "read", input: { path: "odd/tasks/feature.md" } }), undefined);
	assert.equal(guard.checkRead({ toolName: "read", input: { path: "docs/README.md" } }), undefined);

	// Record delegation clears the guard
	guard.recordDelegation();
	assert.equal(guard.checkRead({ toolName: "read", input: { path: "src/mod1.rs" } }), undefined);
});

test("ReadThrashingGuard blocks repeated micro-fragmented reads on the same file", () => {
	const guard = new ReadThrashingGuard();
	const microRead = { toolName: "read", input: { path: "src/persistence.rs", offset: 320, limit: 50 } };

	// Reads up to threshold - 1: allowed
	for (let i = 0; i < READ_THRASHING_THRESHOLD - 1; i++) {
		assert.equal(guard.checkRead(microRead), undefined, `read ${i + 1} should be allowed`);
	}

	// Next read reaching threshold: blocked
	const blocked = guard.checkRead(microRead);
	assert.ok(blocked?.block, "incremental read reaching threshold should be blocked");
	assert.match(blocked.reason, /Read thrashing detected/);
	assert.match(blocked.reason, /src\/persistence\.rs/);

	// After recording a mutation to that file, counter is reset
	guard.recordMutation("src/persistence.rs");
	assert.equal(guard.checkRead(microRead), undefined, "should be allowed again after mutation");

	// Reset clears all counters
	for (let i = 0; i < READ_THRASHING_THRESHOLD - 1; i++) {
		guard.checkRead(microRead);
	}
	guard.reset();
	assert.equal(guard.checkRead(microRead), undefined, "should be allowed after reset");
});

test("TurnToolCallGuard bounds runaway turns without delegation", () => {
	const guard = new TurnToolCallGuard();

	// First N calls: allowed
	for (let i = 0; i < TURN_TOOL_CALL_LIMIT; i++) {
		assert.equal(guard.checkCall({ toolName: "bash" }), undefined);
	}

	assert.equal(guard.isBudgetExceeded(), false);

	// Next call: blocked
	const blocked = guard.checkCall({ toolName: "bash" });
	assert.ok(blocked?.block, "should block call exceeding limit");
	assert.match(blocked.reason, /Turn tool budget exceeded/);
	assert.equal(guard.isBudgetExceeded(), true);

	// Meta-tools and memory do not count and are never blocked
	assert.equal(guard.checkCall({ toolName: "todo" }), undefined);
	assert.equal(guard.checkCall({ toolName: "gentle_odd_phase" }), undefined);
	assert.equal(guard.checkCall({ toolName: "mem_save", input: { title: "x", content: "y" } }), undefined);

	// Non-development tracking docs/tasks do not count and are never blocked
	assert.equal(guard.checkCall({ toolName: "write", input: { path: "odd/tasks/feature.md", content: "# Spec" } }), undefined);
	assert.equal(guard.checkCall({ toolName: "edit", input: { path: "docs/readme.md" } }), undefined);

	// ResetTurn resets callCount but keeps isBudgetExceeded sticky until delegation
	guard.resetTurn();
	assert.equal(guard.isBudgetExceeded(), true);
	// In the new turn, normal calls are permitted up to limit
	assert.equal(guard.checkCall({ toolName: "bash" }), undefined);

	// Delegating clears the exceeded state
	guard.recordDelegation();
	assert.equal(guard.isBudgetExceeded(), false);

	// Reset restores budget completely
	guard.reset();
	assert.equal(guard.checkCall({ toolName: "bash" }), undefined);
	assert.equal(guard.isBudgetExceeded(), false);
});

test("Gentle AI tool_call hook intercepts context backstop, evidence budget, and read thrashing live", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-runaway-guard-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const processEnv = { GENTLE_PI_CONFIG_HOME: join(cwd, ".config-home") };

	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;

	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv,
		resolveTelemetryTriggerBinary: () => "/usr/bin/true",
		telemetryTriggerSpawn: (() => undefined) as never,
	})(pi);
	const toolCall = handlers.get("tool_call")!;

	const ctxAtLimit = {
		cwd,
		hasUI: false,
		ui: { confirm: async () => true },
		sessionManager: { getSessionId: () => "test-session" },
		getContextUsage: () => ({ tokens: WRITER_CONTEXT_BACKSTOP_TOKENS, contextWindow: 272_000, percent: 55 }),
	} as unknown as ExtensionContext;

	// Code mutation at 150k is blocked
	const blockedEdit = await toolCall({ toolName: "edit", input: { path: "src/engine.ts" } }, ctxAtLimit);
	assert.ok(blockedEdit?.block, "hook must block edit on dev surface at 150k");
	assert.match(blockedEdit.reason, /Context backstop reached/);

	// Tracking doc edit at 150k is permitted
	const allowedDoc = await toolCall({ toolName: "edit", input: { path: "odd/tasks/feature.md" } }, ctxAtLimit);
	assert.equal(allowedDoc, undefined, "hook must allow doc edits at 150k");

	const ctxNormal = {
		cwd,
		hasUI: false,
		ui: { confirm: async () => true },
		sessionManager: { getSessionId: () => "test-session" },
		getContextUsage: () => ({ tokens: 50_000, contextWindow: 272_000, percent: 18 }),
	} as unknown as ExtensionContext;

	// Evidence budget trigger in the hook
	for (let i = 1; i <= EXPLORE_READ_BUDGET_THRESHOLD; i++) {
		const res = await toolCall({ toolName: "read", input: { path: `src/file${i}.ts` } }, ctxNormal);
		assert.equal(res, undefined);
	}
	const blockedExplore = await toolCall({ toolName: "read", input: { path: "src/file6.ts" } }, ctxNormal);
	assert.ok(blockedExplore?.block, "hook must block 6th distinct source read");
	assert.match(blockedExplore.reason, /Evidence-budget rule triggered/);
});
