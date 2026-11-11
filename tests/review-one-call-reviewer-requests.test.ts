import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { GENTLE_AI_DEV_BINARY_ENV } from "../lib/gentle-ai-binary.ts";
import type { InProcessReviewerDeps, InProcessReviewerRegistry, InProcessReviewerRequest } from "../lib/inprocess-reviewer.ts";
import { prepareReviewHostRelaySlot, type ReviewHostRelayRequest } from "../lib/review-host-relay.ts";
import { createCoordinatorRuntime, type CoordinatorRuntimeOptions } from "./support/review-coordinator-runtime.ts";

// odd/tasks/review-one-call.md T8 (S6, S7): a reviewer run launched by one
// gentle_review_run call receives exactly the request the same reviewer run
// receives when the parent calls status and the capture tools one by one.
//
// Seams: the facade's own host relay runners (activeReviewHostRelayRunner for a
// single slot or the refuter, activeReviewHostRelayReviewerGroupRunner for a
// lens group). Behind them this test runs the production
// runReviewHostRelayReviewerGroup and prepareReviewHostRelaySlot; only the
// provider's prompt materializer (a fixture executable named by the dev-binary
// override) and the reviewer completion (prepareReviewHostRelaySlot's
// runReviewer argument) are fixtures. The materializer prints every argument,
// its working directory and its whole environment, so the "prompt" the
// reviewer receives changes whenever anything the provider receives changes.

const ROUTING = {
	"review-risk": { model: "fixture/risk-model", thinking: "high", tier: "fast" },
	"review-reliability": { model: "fixture/reliability-model", thinking: "low" },
	"review-refuter": { model: "fixture/refuter-model", thinking: "medium" },
};
const MATERIALIZER = [
	"#!/bin/sh",
	"printf 'fixture materialized prompt; not real review content\\n'",
	"printf 'cwd=%s\\n' \"$(pwd -P)\"",
	"for argument in \"$@\"; do printf 'arg=%s\\n' \"$argument\"; done",
	"env | LC_ALL=C sort",
	"",
].join("\n");

let root: string | undefined;
let repo = "";
const previous: Record<string, string | undefined> = {};
before(() => {
	root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-reviewer-requests-")));
	repo = join(root, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "candidate.ts"), "export const value = 1;\n");
	const config = join(root, "config");
	mkdirSync(config);
	writeFileSync(join(config, "models.json"), `${JSON.stringify(ROUTING, null, 2)}\n`);
	const agentHome = join(root, "agent");
	mkdirSync(agentHome);
	const materializer = join(root, "gentle-ai-materializer");
	writeFileSync(materializer, MATERIALIZER);
	chmodSync(materializer, 0o755);
	const environment = { GENTLE_PI_CONFIG_HOME: config, GENTLE_PI_AGENT_HOME: agentHome, [GENTLE_AI_DEV_BINARY_ENV]: materializer };
	for (const [key, value] of Object.entries(environment)) { previous[key] = process.env[key]; process.env[key] = value; }
});
after(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

// One registry object stands for ctx.modelRegistry; the relay only resolves the model through it.
const registry: InProcessReviewerRegistry = {
	find: (provider, id) => ({ provider, id, api: "fixture", name: id, baseUrl: "http://invalid.local", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1024 }) as never,
	getApiKeyAndHeaders: async () => ({ ok: true }),
};

/**
 * Deep copy for comparison. Normalized, because each is generated per call and
 * cannot be equal by identity: an AbortSignal (each direct tool call has its
 * own; one run passes its one signal to every internal call), the per-launch
 * onEvidence callback, and Buffers (compared by their UTF-8 text). The model
 * registry and completeSimple become labels only after an identity check.
 */
function normalize(value: unknown): unknown {
	if (value instanceof AbortSignal) return `<AbortSignal aborted=${value.aborted}>`;
	if (Buffer.isBuffer(value)) return { utf8: value.toString("utf8") };
	if (value === registry) return "<ctx.modelRegistry>";
	if (value === completeSimple) return "<completeSimple>";
	if (typeof value === "function") return `<function ${value.name || "anonymous"}>`;
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).map((key) => [key, normalize((value as Record<string, unknown>)[key])]));
	return value;
}

interface Launch { relayRequest: unknown; preparedRequest?: unknown; reviewerRequest?: unknown; reviewerDeps?: unknown }

async function drive(path: "direct" | "run", scenario: NonNullable<CoordinatorRuntimeOptions["scenario"]>, hasUI: boolean) {
	const launches: Launch[] = [];
	const events: string[] = [];
	const relayPrepare = async (request: ReviewHostRelayRequest) => {
		const launch: Launch = { relayRequest: normalize(request) };
		launches.push(launch);
		events.push(`start:${request.routingKey}`);
		try {
			const prepared = await prepareReviewHostRelaySlot(request, async (reviewerRequest: InProcessReviewerRequest, deps: InProcessReviewerDeps) => {
				launch.reviewerRequest = normalize(reviewerRequest);
				launch.reviewerDeps = normalize(deps);
				return { kind: "text", text: `fixture reviewer result for ${reviewerRequest.routingKey}; not real review output`, reviewerModel: reviewerRequest.selection };
			});
			launch.preparedRequest = normalize(prepared.request);
			return prepared;
		} finally { events.push(`end:${request.routingKey}`); }
	};
	const runtime = createCoordinatorRuntime(repo, "coordinator", { scenario, hasUI, relayPrepare, modelRegistry: registry, transport: "sse" });
	try {
		const lineageId = runtime.lineage;
		const signal = () => new AbortController().signal;
		let steps: string[];
		let outcome: unknown;
		if (path === "run") {
			const result = await runtime.invoke("gentle_review_run", { lineageId }, signal());
			outcome = result.outcome;
			steps = result.metrics.steps.map((step: { tool: string; operation?: string }) => step.operation === undefined ? step.tool : `${step.tool}:${step.operation}`);
			assert.equal(result.forecasts.length, scenario === "refuter" ? 2 : 1);
		} else {
			// A parent on main: STATUS, the capture forecast, the acknowledged capture, STATUS, ..., acknowledgement.
			steps = [];
			const call = async (tool: string, parameters: Record<string, unknown>) => {
				steps.push(tool === "gentle_review" ? `${tool}:${parameters.operation}` : tool);
				return await runtime.invoke(tool, parameters, signal());
			};
			let status = await call("gentle_review", { operation: "status", lineageId });
			for (let count = 0; count < 4; count++) {
				const transition = status.result.next_transition;
				if (transition.kind === "execute" && transition.execute.operation === "review.acknowledge-approved") break;
				const bindings = status.collectBindings.map((entry: { collectBinding: string }) => entry.collectBinding);
				const [tool, parameters] = bindings.length === 1
					? ["gentle_review_capture", { lineageId, collectBinding: bindings[0] }]
					: ["gentle_review_capture_group", { lineageId, collectBindings: bindings }];
				assert.equal((await call(tool, parameters)).outcome, "reviewer-model-run-forecast");
				await call(tool, { ...parameters, reviewerRunAcknowledged: true });
				status = await call("gentle_review", { operation: "status", lineageId });
			}
			const ack = await call("gentle_review", { operation: "acknowledge-approved", lineageId });
			outcome = ack.status === "closed" && ack.authority === "burned" ? "closed" : ack.outcome;
		}
		assert.equal(outcome, "closed", `${path} ${scenario}`);
		assert.ok(runtime.closed());
		const providerOperations = runtime.nativeRequests.map(({ operation, request }) => ({ operation, request: normalize(request) }));
		return { launches, events, steps, providerOperations };
	} finally { runtime.close(); }
}

const fieldsOf = (records: unknown[]) => [...new Set(records.flatMap((record) => record === undefined ? [] : Object.keys(record as object)))].sort();

for (const scenario of ["single", "group", "refuter"] as const) {
	test(`T8: ${scenario}: every reviewer request of one gentle_review_run equals the parent-driven one, with and without a UI`, async (t) => {
		const direct = await drive("direct", scenario, true);
		const expectedSteps = {
			single: ["gentle_review:status", "gentle_review_capture", "gentle_review_capture", "gentle_review:status", "gentle_review:acknowledge-approved"],
			group: ["gentle_review:status", "gentle_review_capture_group", "gentle_review_capture_group", "gentle_review:status", "gentle_review:acknowledge-approved"],
			refuter: ["gentle_review:status", "gentle_review_capture_group", "gentle_review_capture_group", "gentle_review:status", "gentle_review_capture", "gentle_review_capture", "gentle_review:status", "gentle_review:acknowledge-approved"],
		}[scenario];
		assert.deepEqual(direct.steps, expectedSteps);
		const lenses = { single: ["review-reliability"], group: ["review-risk", "review-reliability"], refuter: ["review-risk", "review-reliability", "review-refuter"] }[scenario];
		// The routing in effect is the configured one, so model, thinking and tier are compared with values.
		assert.deepEqual(direct.launches.map((launch) => (launch.reviewerRequest as Record<string, unknown>).selection), lenses.map((lens) => ROUTING[lens as keyof typeof ROUTING].model));
		for (const launch of direct.launches) {
			assert.ok(launch.reviewerRequest !== undefined && launch.preparedRequest !== undefined, "each launch reached the reviewer completion");
			// The prompt is what the materializer received: its arguments, directory and environment.
			const prompt = ((launch.reviewerRequest as { prompt: { utf8: string } }).prompt).utf8;
			assert.match(prompt, /^fixture materialized prompt/);
			assert.ok(prompt.includes(`cwd=${repo}\n`) && prompt.includes("arg=--lineage=") && prompt.includes("GENTLE_PI_CONFIG_HOME="), prompt);
		}
		if (scenario !== "single") {
			// The two lenses start before either finishes, in provider order.
			const groupEvents = direct.events.filter((event) => !event.endsWith("review-refuter"));
			assert.deepEqual(groupEvents.slice(0, 2), ["start:review-risk", "start:review-reliability"]);
		}
		for (const hasUI of [true, false]) {
			const run = await drive("run", scenario, hasUI);
			const label = `${scenario}, run ${hasUI ? "with" : "without"} a UI`;
			assert.deepEqual(run.steps, direct.steps, `${label}: facade steps`);
			assert.deepEqual(run.launches, direct.launches, `${label}: reviewer requests in launch order`);
			assert.deepEqual(run.events.filter((event) => event.startsWith("start:")), direct.events.filter((event) => event.startsWith("start:")), `${label}: launch order`);
			if (scenario !== "single") assert.deepEqual(run.events.slice(0, 2), ["start:review-risk", "start:review-reliability"], `${label}: concurrent group launch`);
			// The run reads the user-owned review switch (S6) before each facade
			// step; a parent's direct calls do not. These reads reach no reviewer.
			const modeReads = run.providerOperations.filter(({ operation }) => operation === "review-mode");
			assert.deepEqual(modeReads, run.steps.map(() => ({ operation: "review-mode", request: { cwd: repo, operation: "status", signal: "<AbortSignal aborted=false>" } })), `${label}: one switch read per facade step`);
			assert.equal(direct.providerOperations.some(({ operation }) => operation === "review-mode"), false);
			assert.deepEqual(run.providerOperations.filter(({ operation }) => operation !== "review-mode"), direct.providerOperations, `${label}: provider operations and arguments`);
		}
		t.diagnostic(`relay request fields: ${fieldsOf(direct.launches.map((launch) => launch.relayRequest)).join(", ")}`);
		t.diagnostic(`prepared request fields: ${fieldsOf(direct.launches.map((launch) => launch.preparedRequest)).join(", ")}`);
		t.diagnostic(`reviewer request fields: ${fieldsOf(direct.launches.map((launch) => launch.reviewerRequest)).join(", ")}`);
		t.diagnostic(`reviewer deps fields: ${fieldsOf(direct.launches.map((launch) => launch.reviewerDeps)).join(", ")}`);
		t.diagnostic(`provider operations: ${direct.providerOperations.map(({ operation, request }) => `${operation}(${Object.keys(request as object).join(",")})`).join(" > ")}`);
		t.diagnostic(`events: ${direct.events.join(" ")}`);
	});
}
