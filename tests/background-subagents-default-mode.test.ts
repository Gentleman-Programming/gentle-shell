import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_MODE } from "../lib/agents-config.ts";
import { resolveDefaultSubagentMode } from "../extensions/gentle-agents.ts";

// ---------------------------------------------------------------------------
// resolveDefaultSubagentMode: the runtime default for subagent_run when
// neither an explicit params.mode nor an agent-defined mode was given.
//
// Background is a runtime default only when the background-subagents policy
// is "on" AND the parent can receive background results. Print mode exits
// before a parent session exists to deliver a background result to, so it
// must keep the configured default even when the policy is on (see the
// `ctx.mode === "print"` guard in gentle-agents.ts `launch`).
// ---------------------------------------------------------------------------

test("policy on + interactive parent -> background", () => {
	assert.equal(
		resolveDefaultSubagentMode({
			configuredDefault: AGENT_MODE.TASK,
			policy: "on",
			parentMode: "interactive",
		}),
		AGENT_MODE.BACKGROUND,
	);
});

test("policy on + rpc parent -> background", () => {
	assert.equal(
		resolveDefaultSubagentMode({
			configuredDefault: AGENT_MODE.TASK,
			policy: "on",
			parentMode: "rpc",
		}),
		AGENT_MODE.BACKGROUND,
	);
});

test("policy on + print parent -> configured default (task), never background", () => {
	assert.equal(
		resolveDefaultSubagentMode({
			configuredDefault: AGENT_MODE.TASK,
			policy: "on",
			parentMode: "print",
		}),
		AGENT_MODE.TASK,
	);
});

test("policy off -> configured default regardless of parent mode", () => {
	for (const parentMode of ["interactive", "rpc", "print", undefined]) {
		assert.equal(
			resolveDefaultSubagentMode({
				configuredDefault: AGENT_MODE.TASK,
				policy: "off",
				parentMode,
			}),
			AGENT_MODE.TASK,
			`parentMode ${String(parentMode)} must not change an off policy`,
		);
	}
});

test("configured default background + policy off -> background (the configured default wins when the policy is off)", () => {
	assert.equal(
		resolveDefaultSubagentMode({
			configuredDefault: AGENT_MODE.BACKGROUND,
			policy: "off",
			parentMode: "interactive",
		}),
		AGENT_MODE.BACKGROUND,
	);
});

test("configured default background + policy on + interactive -> background (both agree)", () => {
	assert.equal(
		resolveDefaultSubagentMode({
			configuredDefault: AGENT_MODE.BACKGROUND,
			policy: "on",
			parentMode: "interactive",
		}),
		AGENT_MODE.BACKGROUND,
	);
});

test("parentMode undefined with policy on is treated as not print -> background", () => {
	assert.equal(
		resolveDefaultSubagentMode({
			configuredDefault: AGENT_MODE.TASK,
			policy: "on",
			parentMode: undefined,
		}),
		AGENT_MODE.BACKGROUND,
	);
});

// Explicit request mode always wins over the resolved default: this is
// asserted at the wiring site (extensions/gentle-agents.ts `run` and
// `continue` tools), not inside this pure helper, which has no notion of
// "explicit" at all — it is called only when params.mode and agent.mode are
// both absent. tests/agents-integration.test.ts does not currently exercise
// subagent_run with a fake child process, so that wiring-level assertion is
// not covered by an automated test in this change; it is covered by reading
// the call site, where `params.mode ?? agent.mode ?? resolveDefaultSubagentMode(...)`
// short-circuits on any explicit value before this helper is ever invoked.
