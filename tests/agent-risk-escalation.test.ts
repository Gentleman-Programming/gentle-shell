import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { NATIVE_REVIEW_MODE_SOURCE, type NativeReviewCli } from "../lib/native-review-cli.ts";
import {
	decodeAgentRiskEscalation,
	escalatedRisk,
	HIGH_RISK_ITEMS,
	REVIEW_ASSESSMENT_SCHEMA,
	VERIFICATION_TIER,
} from "../lib/review-risk-assessment.ts";

// gentle-shell#1494 S6: the agent may raise a candidate's risk to high by
// citing one item of the shared high-risk list, never lower it. The raise
// travels inside the existing assess call; no new operation.

test("the high-risk list has exactly the six items of the always-on Task Size section", () => {
	assert.deepEqual(Object.keys(HIGH_RISK_ITEMS).map(Number), [1, 2, 3, 4, 5, 6]);
	assert.equal(HIGH_RISK_ITEMS[2], "security");
	assert.equal(HIGH_RISK_ITEMS[6], "no test would catch a regression");
});

test("decodeAgentRiskEscalation accepts an item from 1 to 6 with a non-empty reason", () => {
	assert.deepEqual(decodeAgentRiskEscalation({ item: 2, reason: "weakens the permission check in utils.ts" }), {
		item: 2,
		reason: "weakens the permission check in utils.ts",
	});
});

test("decodeAgentRiskEscalation rejects unknown items, empty or oversized reasons, and extra fields", () => {
	for (const bad of [
		{ item: 0, reason: "x" },
		{ item: 7, reason: "x" },
		{ item: 2.5, reason: "x" },
		{ item: "2", reason: "x" },
		{ item: 2, reason: "   " },
		{ item: 2, reason: "x".repeat(501) },
		{ item: 2, reason: "x", tier: "low" },
		{ item: 2 },
		null,
		"high",
	]) {
		assert.throws(() => decodeAgentRiskEscalation(bad), /escalate/, `must reject ${JSON.stringify(bad)}`);
	}
});

test("escalatedRisk raises passive and medium to high and never lowers", () => {
	const escalation = { item: 3 as const, reason: "changes a published export" };
	assert.equal(escalatedRisk(VERIFICATION_TIER.PASSIVE, escalation), VERIFICATION_TIER.HIGH);
	assert.equal(escalatedRisk(VERIFICATION_TIER.MEDIUM, escalation), VERIFICATION_TIER.HIGH);
	assert.equal(escalatedRisk(VERIFICATION_TIER.HIGH, escalation), VERIFICATION_TIER.HIGH);
	assert.equal(escalatedRisk(VERIFICATION_TIER.UNASSESSABLE, escalation), VERIFICATION_TIER.UNASSESSABLE);
	for (const tier of Object.values(VERIFICATION_TIER)) assert.equal(escalatedRisk(tier, undefined), tier);
});

function assessTool(): { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ details: unknown }> } {
	const tools = new Map<string, any>();
	const pi = { on() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "off", cloneLocal: "off", effective: "off", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({
			schema: REVIEW_ASSESSMENT_SCHEMA,
			risk: "medium",
			reasons: [],
			changedPaths: 1,
			changedLines: 3,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	};
	createGentleAiExtension({ nativeReviewCli: nativeReviewCli as NativeReviewCli })(pi);
	return tools.get("gentle_review");
}

const ctx = { cwd: process.cwd() } as ExtensionContext;

test("gentle_review assess: an agent escalation raises a medium candidate to high and records why", async () => {
	const tool = assessTool();
	const input = JSON.stringify({ writerModelId: "openai/gpt-6.1-sol", writerEffort: "high", escalate: { item: 2, reason: "weakens the permission check in utils.ts" } });
	const { details } = await tool.execute("esc-1", { operation: "assess", input }, undefined, undefined, ctx);
	const plan = details as { risk: string; nativeRisk: string; agentEscalation: { item: number; label: string; reason: string }; plan: { independentVerifier: boolean } };
	assert.equal(plan.nativeRisk, "medium");
	assert.equal(plan.risk, VERIFICATION_TIER.HIGH);
	assert.deepEqual(plan.agentEscalation, { item: 2, label: "security", reason: "weakens the permission check in utils.ts", applied: true });
	assert.equal(plan.plan.independentVerifier, true, "a raised candidate always gets the independent verifier");
});

test("gentle_review assess: without an escalation the native tier stands", async () => {
	const tool = assessTool();
	const input = JSON.stringify({ writerModelId: "openai/gpt-6.1-sol", writerEffort: "high" });
	const { details } = await tool.execute("esc-2", { operation: "assess", input }, undefined, undefined, ctx);
	const plan = details as { risk: string; nativeRisk: string; agentEscalation?: unknown; plan: { independentVerifier: boolean } };
	assert.equal(plan.risk, "medium");
	assert.equal(plan.nativeRisk, "medium");
	assert.equal(plan.agentEscalation, undefined);
	assert.equal(plan.plan.independentVerifier, false);
});

test("gentle_review assess: a malformed escalation is rejected instead of ignored", async () => {
	const tool = assessTool();
	await assert.rejects(
		() => tool.execute("esc-3", { operation: "assess", input: JSON.stringify({ escalate: { item: 9, reason: "x" } }) }, undefined, undefined, ctx),
		/escalate/,
	);
});

test("the rule text tells the agent when and how to escalate, and that it never lowers", async () => {
	const { readFileSync } = await import("node:fs");
	const verification = readFileSync(new URL("../assets/orchestrator-verification.md", import.meta.url), "utf8");
	const tracking = readFileSync(new URL("../assets/orchestrator-tracking.md", import.meta.url), "utf8");
	const extension = readFileSync(new URL("../extensions/gentle-ai.ts", import.meta.url), "utf8");
	assert.match(verification, /"escalate": \{"item": <1-6>, "reason": "<one line>"\}/);
	assert.match(verification, /never lowers a tier/);
	assert.match(tracking, /assess `escalate` field \(`orchestrator-verification\.md`\); never lower one/);
	assert.match(extension, /\{"escalate":\{"item":1-6,"reason":"<one line>"\}\}/);
});

test("gentle_review assess: agentEscalation says whether the escalation changed the tier", async () => {
	const tool = assessTool();
	const input = JSON.stringify({ escalate: { item: 4, reason: "reorders an async write" } });
	const { details } = await tool.execute("esc-5", { operation: "assess", input }, undefined, undefined, ctx);
	assert.equal((details as { agentEscalation: { applied: boolean } }).agentEscalation.applied, true, "medium raised to high is applied");
});
