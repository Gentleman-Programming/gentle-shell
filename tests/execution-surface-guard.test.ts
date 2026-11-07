import assert from "node:assert/strict";
import test from "node:test";
import { EXTERNAL_FALLBACK_PROHIBITED, evaluateExecutionSurfaceTool } from "../lib/execution-surface-guard.ts";

// gentle-shell#379: a tool call that asks to open an external project pane is
// classified by its own input property, never by the tool name.

const reason = (toolName: string) => `Gentle AI blocked an execution-surface escalation. code=${EXTERNAL_FALLBACK_PROHIBITED} tool=${toolName} property=openProjectPaneIfMissing next=Run the work through subagent_* or the native Agent in the current runtime; if neither is available, stop and tell the user.`;

test("the stable code names the external fallback prohibition", () => {
	assert.equal(EXTERNAL_FALLBACK_PROHIBITED, "gentle-ai.execution-surface.external-fallback-prohibited");
});

for (const [label, input] of [
	["absent", { action: "send", cwd: "/tmp/other" }],
	["false", { action: "send", cwd: "/tmp/other", openProjectPaneIfMissing: false }],
	["non-object input", "openProjectPaneIfMissing"],
	["undefined input", undefined],
] as const) {
	test(`an ${label} openProjectPaneIfMissing leaves the call untouched`, () => {
		assert.equal(evaluateExecutionSurfaceTool("intercom", input), undefined);
	});
}

for (const [label, value] of [
	["true", true],
	["the string \"yes\"", "yes"],
	["the number 1", 1],
	["null", null],
	["an object", {}],
] as const) {
	test(`openProjectPaneIfMissing set to ${label} is blocked with the stable code`, () => {
		const result = evaluateExecutionSurfaceTool("synthetic_surface", { action: "ask", cwd: "/secret/repo", message: "leak me", openProjectPaneIfMissing: value });
		assert.deepEqual(result, { block: true, reason: reason("synthetic_surface") });
		assert.equal(result?.reason?.includes("/secret/repo"), false, "the reason never echoes input paths");
		assert.equal(result?.reason?.includes("leak me"), false, "the reason never echoes input content");
	});
}
