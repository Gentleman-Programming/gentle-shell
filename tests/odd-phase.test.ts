import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOddPhase, oddPhaseLabel, oddPhaseRegistry, ODD_PHASES, OddPhaseRegistry } from "../lib/odd-phase.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// Bounded, explicit ODD phase signal reported by the orchestrator. There is
// no Pi runtime event for ODD phases, so this module never infers a phase
// from tool use or assistant prose (see AGENTS.md CodeGraph/ODD contract).

test("ODD_PHASES is the fixed orchestrator-reportable vocabulary covering every ODD protocol step (deciding covers both step 3 and step 4)", () => {
	assert.deepEqual(ODD_PHASES, ["authorizing", "exploring", "researching", "deciding", "planning", "implementing", "checking", "closing"]);
});

test("isOddPhase accepts only the bounded vocabulary", () => {
	for (const phase of ODD_PHASES) assert.equal(isOddPhase(phase), true);
	assert.equal(isOddPhase("coding"), false);
	assert.equal(isOddPhase(""), false);
	assert.equal(isOddPhase(undefined), false);
	assert.equal(isOddPhase(42), false);
});

test("oddPhaseLabel renders the working-style ellipsis label for every ODD_PHASES member", () => {
	for (const phase of ODD_PHASES) assert.equal(oddPhaseLabel(phase), `${phase}…`);
});

test("OddPhaseRegistry.report stores a valid phase for a session and label() renders it", () => {
	const registry = new OddPhaseRegistry();
	assert.equal(registry.report("session-a", "exploring"), "exploring");
	assert.equal(registry.get("session-a"), "exploring");
	assert.equal(registry.label("session-a"), "exploring…");
});

test("OddPhaseRegistry.clear resets a session's phase directly", () => {
	const registry = new OddPhaseRegistry();
	registry.report("session-a", "checking");
	registry.clear("session-a");
	assert.equal(registry.get("session-a"), undefined);
	assert.equal(registry.label("session-a"), undefined);
});

test("OddPhaseRegistry scopes phases per session; one session never sees another's report", () => {
	const registry = new OddPhaseRegistry();
	registry.report("session-a", "exploring");
	registry.report("session-b", "checking");
	assert.equal(registry.get("session-a"), "exploring");
	assert.equal(registry.get("session-b"), "checking");
	registry.clear("session-a");
	assert.equal(registry.get("session-a"), undefined);
	assert.equal(registry.get("session-b"), "checking", "clearing one session must not affect another");
});

test("OddPhaseRegistry ignores reports and reads without a session id", () => {
	const registry = new OddPhaseRegistry();
	assert.equal(registry.report(undefined, "exploring"), undefined);
	assert.equal(registry.get(undefined), undefined);
	assert.equal(registry.label(undefined), undefined);
	registry.clear(undefined);
});

test("OddPhaseRegistry.report requests a redraw through the registered callback for that session", () => {
	const registry = new OddPhaseRegistry();
	let renders = 0;
	registry.setRenderRequest("session-a", () => { renders += 1; });
	registry.report("session-a", "authorizing");
	assert.equal(renders, 1);
	registry.report("session-a", "planning");
	assert.equal(renders, 2);
});

test("OddPhaseRegistry.report without a session id never requests a redraw", () => {
	const registry = new OddPhaseRegistry();
	let renders = 0;
	registry.setRenderRequest(undefined, () => { renders += 1; });
	registry.report(undefined, "authorizing");
	assert.equal(renders, 0);
});

test("OddPhaseRegistry.clear requests a redraw only when a phase actually existed", () => {
	const registry = new OddPhaseRegistry();
	let renders = 0;
	registry.setRenderRequest("session-a", () => { renders += 1; });
	registry.clear("session-a");
	assert.equal(renders, 0, "clearing an already-empty phase must not request a needless redraw");
	registry.report("session-a", "checking");
	renders = 0;
	registry.clear("session-a");
	assert.equal(renders, 1);
});

test("OddPhaseRegistry never calls another session's render-request callback", () => {
	const registry = new OddPhaseRegistry();
	let rendersA = 0;
	let rendersB = 0;
	registry.setRenderRequest("session-a", () => { rendersA += 1; });
	registry.setRenderRequest("session-b", () => { rendersB += 1; });
	registry.report("session-a", "exploring");
	assert.equal(rendersA, 1);
	assert.equal(rendersB, 0);
});

test("OddPhaseRegistry.clearRenderRequest stops future redraw requests for that session", () => {
	const registry = new OddPhaseRegistry();
	let renders = 0;
	registry.setRenderRequest("session-a", () => { renders += 1; });
	registry.clearRenderRequest("session-a");
	registry.report("session-a", "deciding");
	assert.equal(renders, 0);
});

test("OddPhaseRegistry report/clear without a registered render-request callback is a safe no-op", () => {
	const registry = new OddPhaseRegistry();
	assert.doesNotThrow(() => {
		registry.report("session-a", "closing");
		registry.clear("session-a");
	});
});

interface RegisteredTool {
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function gentleOddPhaseTool(): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	createGentleAiExtension({ nativeReviewCli: null } as unknown as Parameters<typeof createGentleAiExtension>[0])({
		on() {},
		registerTool(definition: RegisteredTool & { name: string }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const tool = tools.get("gentle_odd_phase");
	assert.ok(tool, "gentle_odd_phase must be registered");
	return tool;
}

function toolContext(sessionId: string | undefined): ExtensionContext {
	return { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

test("gentle_odd_phase reports a valid phase for the calling session and returns details", async () => {
	const tool = gentleOddPhaseTool();
	const ctx = toolContext("tool-session-a");
	try {
		const result = await tool.execute("call-1", { phase: "researching" }, undefined, undefined, ctx);
		assert.deepEqual((result as { details?: unknown }).details, { phase: "researching" });
		assert.equal(oddPhaseRegistry.get("tool-session-a"), "researching");
	} finally {
		oddPhaseRegistry.clear("tool-session-a");
	}
});

test("gentle_odd_phase 'clear' leaves the current phase mid-turn", async () => {
	const tool = gentleOddPhaseTool();
	const ctx = toolContext("tool-session-b");
	try {
		await tool.execute("call-1", { phase: "implementing" }, undefined, undefined, ctx);
		const result = await tool.execute("call-2", { phase: "clear" }, undefined, undefined, ctx);
		assert.deepEqual((result as { details?: unknown }).details, { phase: undefined });
		assert.equal(oddPhaseRegistry.get("tool-session-b"), undefined);
	} finally {
		oddPhaseRegistry.clear("tool-session-b");
	}
});

test("gentle_odd_phase throws (never falsely returns success) for a phase outside the bounded vocabulary", async () => {
	// Pi's own contract: only a thrown error sets isError: true; a returned
	// value never does, regardless of an isError property on it
	// (docs/extensions.md "Signaling errors").
	const tool = gentleOddPhaseTool();
	const ctx = toolContext("tool-session-c");
	try {
		await assert.rejects(
			() => tool.execute("call-1", { phase: "refactoring" }, undefined, undefined, ctx),
			/Invalid ODD phase/,
		);
		assert.equal(oddPhaseRegistry.get("tool-session-c"), undefined);
	} finally {
		oddPhaseRegistry.clear("tool-session-c");
	}
});

test("gentle_odd_phase preserves the prior reported phase when given an invalid token; only 'clear' resets it", async () => {
	const tool = gentleOddPhaseTool();
	const ctx = toolContext("tool-session-d");
	try {
		await tool.execute("call-1", { phase: "checking" }, undefined, undefined, ctx);
		await assert.rejects(() => tool.execute("call-2", { phase: "refactoring" }, undefined, undefined, ctx));
		assert.equal(oddPhaseRegistry.get("tool-session-d"), "checking", "an invalid token must never wipe the previously reported phase");
	} finally {
		oddPhaseRegistry.clear("tool-session-d");
	}
});

test("gentle_odd_phase throws, not falsely succeeds, when there is no active session for a valid phase", async () => {
	const tool = gentleOddPhaseTool();
	const ctx = toolContext(undefined);
	await assert.rejects(
		() => tool.execute("call-1", { phase: "implementing" }, undefined, undefined, ctx),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.doesNotMatch(error.message, /Invalid ODD phase/, "the phase itself was valid; the failure is the missing session, not an invalid token");
			return true;
		},
	);
});

test("gentle_odd_phase throws for an invalid token even with no active session", async () => {
	const tool = gentleOddPhaseTool();
	const ctx = toolContext(undefined);
	await assert.rejects(() => tool.execute("call-1", { phase: "refactoring" }, undefined, undefined, ctx));
});
