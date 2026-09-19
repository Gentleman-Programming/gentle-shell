import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { REVIEW_HOST_RELAY_FAILURE, ReviewHostRelayError } from "../lib/review-host-relay.ts";
import { NativeReviewIntegrationError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import type { ReviewHostRelayRequest } from "../lib/review-host-relay.ts";

// Third field failure on the recovered-lineage defect (2026-08-16, gentle-pi
// main 402f9f77 + gentle-ai 2.4.0-main.20278905): STATUS recognises the
// lineage, the Pi RELAY never runs, no lens is launched, zero mutations.
//
// Measured against the live binary on a faithful reproduction (linked
// worktree, uncommitted tracked files, externally recovered successor):
//
//   agent-less STATUS  -> collect input arguments:
//       lineage, expected-revision, target, repository-context, lens, order,
//       subject-hash                      (no agent, no materialize, no submission)
//   `--agent pi` STATUS -> the same input PLUS agent=pi, materialize=true and
//       the provider submission (operation_token=capture-result)
//
// The adapter's negotiated targetStatus never sent `--agent pi`, so the
// provider never offered the materialize-marked relay slot,
// reviewHostRelaySlots() returned 0 for every real lineage, and the host relay
// was unreachable. The prior fixes all exercised dispatch-shaped slots.
//
// Binaries older than v2.4.0 do not define `--agent` on `review status` and
// refuse it outright, so the agent is probed rather than version-sniffed and
// the typed refusal must reach the user instead of being swallowed.

const SHA = `sha256:${"1".repeat(64)}`;
const TRANSPORT_REFUSAL_CODE = "immutable_review_transport_unsupported";

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-relay-transport-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Relay", "-c", "user.email=relay@example.invalid", "commit", "-m", "base"], { cwd });
	return cwd;
}

function collectInput(lineageId: string, materialize: boolean): ReviewCollectInputV3 {
	const binding = [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
		{ name: "lens", value: "review-reliability", token: "--lens=review-reliability" },
		{ name: "order", value: "0", token: "--order=0" },
		{ name: "subject-hash", value: SHA, token: `--subject-hash=${SHA}` },
	];
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: materialize
			? [...binding, { name: "agent", value: "pi", token: "--agent=pi" }, { name: "materialize", value: "true", token: "--materialize=true" }]
			: binding,
		artifactSubject: {
			schema: "gentle-ai.review-artifact-subject/v2",
			subjectHash: SHA,
			lineageId,
			authorityRevision: SHA,
			targetIdentity: SHA,
			baseTree: "3".repeat(40),
			candidateTree: "4".repeat(40),
			changedPathManifestSha256: SHA,
			lens: "review-reliability",
			selectedOrder: 0,
		},
		...(materialize
			? {
				submission: {
					operationToken: "capture-result",
					argumentTokens: [...binding.map((argument) => argument.token), "--input={{value}}"],
					values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: binding.length }],
				},
			}
			: {}),
	} as unknown as ReviewCollectInputV3;
}

function recoveredStatus(lineageId: string, materialize: boolean): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewer_results_required", generation: 2, revision: SHA },
		action: "stop",
		replayability: "not_replayable",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-integration.projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: "3".repeat(40),
			initialReviewTree: "4".repeat(40),
			currentCandidateTree: "4".repeat(40),
			pathsDigest: SHA,
			paths: ["app.ts"],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "reviewer_results_required", collect: { inputs: [collectInput(lineageId, materialize)] } },
		raw: { schema: "gentle-ai.review-integration.status/v5", action: "stop", lineage_id: lineageId },
	} as unknown as ReviewStatusV3;
}

/**
 * Mirrors the MEASURED live provider: the materialize-marked relay slot is
 * offered only when the caller asks for the pi agent.
 */
function transportAwareNative(options: { refusalCode?: string } = {}): {
	native: NativeReviewCli;
	agents: Array<string | undefined>;
} {
	const agents: Array<string | undefined> = [];
	const native = {
		targetStatus: async (request: { lineageId?: string; agent?: string }) => {
			agents.push(request.agent);
			if (request.agent === "pi" && options.refusalCode !== undefined) {
				throw new NativeReviewIntegrationError({
					schema: "gentle-ai.review-integration.failure/v2",
					contract: "gentle-ai.review-integration/v2",
					operation: "review.status",
					phase: "pre_native",
					code: options.refusalCode,
					message: "supported immutable review runtimes: claude-code, opencode, codex",
					mutationOutcome: "none",
					authorityApplicability: "current_target",
					retrySafe: true,
					replayability: "not_replayable",
					nextAction: "stop",
					raw: {},
				} as never);
			}
			return recoveredStatus(request.lineageId ?? "relay-lineage", request.agent === "pi");
		},
	} as unknown as NativeReviewCli;
	return { native, agents };
}

async function runCapture(cwd: string, native: NativeReviewCli, lineageId: string, input: Record<string, unknown> = { reviewerRunAcknowledged: true }): Promise<Record<string, unknown>> {
	return await __testing.executeReviewCaptureOperation(
		{ lineageId, collectBinding: JSON.stringify(collectInput(lineageId, true)), ...input },
		cwd, native, undefined, new CandidateViewRegistry(),
	) as Record<string, unknown>;
}


async function runStatus(cwd: string, native: NativeReviewCli, lineageId: string): Promise<Record<string, unknown>> {
	return await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId },
		cwd, native, undefined, new CandidateViewRegistry(),
	) as Record<string, unknown>;
}

test("the negotiated status asks for the pi agent so the provider offers its materialize relay slot", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-recovered-successor";
	const { native, agents } = transportAwareNative();
	const relayed: ReviewHostRelayRequest[] = [];
	__testing.setReviewHostRelayRunnerForTesting(async (request: ReviewHostRelayRequest) => {
		relayed.push(request);
		return { promptByteLength: 128, resultByteLength: 64, submission: '{"admission_decision":"completed"}' };
	});

	const result = await runCapture(cwd, native, lineageId);

	assert.equal(agents.at(0), "pi", "the successful Pi route starts with pi-bound STATUS negotiation");
	assert.ok(agents.every((agent) => agent === "pi"), "the selected capture performs no post-success agent-less STATUS re-query");
	assert.equal(relayed.length, 1, "the materialize-marked slot must reach the host relay");
	assert.ok(relayed[0]!.captureArgumentTokens.includes("--materialize=true"));
	assert.ok(relayed[0]!.submission !== undefined, "the provider submission drives the completing form");
	const hostRelay = result.host_relay as { transport: string } | undefined;
	assert.ok(hostRelay !== undefined, "the envelope reports the one relay capture");
	assert.equal(hostRelay.transport, "pi_host_relay");
});

// gentle-pi#311 P2 (superseding gentle-shell#1136 / #1158): the lens's
// user-owned completion selection (agent model routing config) rides the
// relay request alongside the live model registry; there is no extension
// allowlist and no ambient default model to fall back to.
test("capture forwards the lens's user-owned selection and thinking level to the relay request", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const configHome = mkdtempSync(join(tmpdir(), "gentle-pi-relay-config-"));
	const cwd = repository(t);
	t.after(() => rmSync(configHome, { recursive: true, force: true }));
	writeFileSync(join(configHome, "models.json"), JSON.stringify({ "review-reliability": { model: "minimax/MiniMax-M3", thinking: "high" } }), "utf8");
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	});
	const { native } = transportAwareNative();
	const relayed: ReviewHostRelayRequest[] = [];
	__testing.setReviewHostRelayRunnerForTesting(async (request: ReviewHostRelayRequest) => {
		relayed.push(request);
		return { promptByteLength: 128, resultByteLength: 64, submission: '{"admission_decision":"completed"}' };
	});

	await runCapture(cwd, native, "selection-lineage");
	assert.equal(relayed.length, 1);
	assert.equal(relayed[0]!.selection, "minimax/MiniMax-M3", "the lens's routing entry must name the completion's selection");
	assert.equal(relayed[0]!.thinking, "high");
	assert.equal(relayed[0]!.routingKey, "review-reliability");
});

// gentle-pi#311 P2 decision (flagged for confirmation): the in-process path
// has no ambient default model. A routing entry with no configured model used
// to launch the child selection-free (inheriting pi's own default); the real
// relay now refuses it typed instead, since there is no child to inherit a
// default from (lib/review-host-relay.ts's own tests exercise that refusal
// through the real, unfaked runner). This extension layer only forwards
// whatever the routing config yields — it never validates the selection
// itself — so with the runner faked here the request still reaches it, and
// its `selection` field is simply absent.
test("capture forwards no selection when the lens has no configured model, leaving the missing-model refusal to the relay", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const configHome = mkdtempSync(join(tmpdir(), "gentle-pi-relay-config-empty-"));
	const cwd = repository(t);
	t.after(() => rmSync(configHome, { recursive: true, force: true }));
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	});
	const { native } = transportAwareNative();
	const relayed: ReviewHostRelayRequest[] = [];
	__testing.setReviewHostRelayRunnerForTesting(async (request: ReviewHostRelayRequest) => {
		relayed.push(request);
		return { promptByteLength: 128, resultByteLength: 64, submission: '{"admission_decision":"completed"}' };
	});

	await runCapture(cwd, native, "default-lineage");
	assert.equal(relayed.length, 1);
	assert.equal(relayed[0]!.selection, undefined);
	assert.equal(relayed[0]!.routingKey, "review-reliability");
});

test("a relayed empty-output failure carries the child's own evidence in the failure report", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const { native } = transportAwareNative();
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_EMPTY_OUTPUT, "pi", "pi subprocess produced no assistant text (stdout kind: no-assistant-text; a tool call was attempted)", {
			reviewerEvidence: { stdoutKind: "no-assistant-text", reviewerModel: "nan/deepseek-v4-flash", toolCallAttempted: true },
		});
	});

	const result = await runCapture(cwd, native, "evidence-lineage");
	assert.equal(result.outcome, "pi-host-relay-transport-failure");
	const failure = result.failure as { reviewer?: { stdoutKind?: string; reviewerModel?: string; toolCallAttempted?: boolean } } | undefined;
	assert.ok(failure !== undefined, "the envelope carries the failure report");
	assert.equal(failure.reviewer?.stdoutKind, "no-assistant-text");
	assert.equal(failure.reviewer?.reviewerModel, "nan/deepseek-v4-flash");
	assert.equal(failure.reviewer?.toolCallAttempted, true);
});

test("capture forecasts the reviewer model run once and spends nothing until it is acknowledged", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "forecast-lineage";
	const { native } = transportAwareNative();
	let launches = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		launches += 1;
		return { promptByteLength: 128, resultByteLength: 64, submission: '{"admission_decision":"completed"}' };
	});

	// An unacknowledged capture must forecast, never spend.
	const forecast = await runCapture(cwd, native, lineageId, {});
	assert.equal(launches, 0, "no reviewer model run may start before the forecast is acknowledged");
	assert.equal(forecast.status, "blocked");
	assert.equal(forecast.outcome, "reviewer-model-run-forecast");
	assert.equal(forecast.mutation_performed, false);
	assert.equal(forecast.mutation_outcome, "none");
	const cost = forecast.cost_forecast as { transport: string; model_runs: number; lenses: readonly string[] };
	assert.equal(cost.transport, "pi_host_relay");
	assert.equal(cost.model_runs, 1, "one model run per outstanding lens, forecast once before launch");
	assert.deepEqual(cost.lenses, ["review-reliability"]);

	// The acknowledged capture runs exactly the forecast work.
	const acknowledged = await runCapture(cwd, native, lineageId, { reviewerRunAcknowledged: true });
	assert.equal(launches, 1, "the acknowledged capture runs the forecast model run");
	assert.equal(acknowledged.status, "captured");
});

test("a provider that refuses the pi transport blocks immediately without an agent-less lifecycle fallback", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "legacy-transport-lineage";
	const { native, agents } = transportAwareNative({ refusalCode: TRANSPORT_REFUSAL_CODE });
	let relayCalls = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		relayCalls += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});

	const result = await runCapture(cwd, native, lineageId);

	assert.deepEqual(agents, ["pi"], "the refusal path issues one pi-bound STATUS and never falls back to an agent-less STATUS");
	assert.equal(relayCalls, 0, "a refused transport must not launch a relay capture");
	const transport = result.relay_transport as { supported: boolean; code: string; message: string } | undefined;
	assert.ok(transport !== undefined, "the blocked envelope must report the typed transport refusal");
	assert.equal(transport.supported, false);
	assert.equal(transport.code, TRANSPORT_REFUSAL_CODE);
	assert.match(transport.message, /immutable review runtimes/i);
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-transport-unavailable");
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.match(String(result.next_action), /support.*--agent pi/i);
	assert.doesNotMatch(JSON.stringify(result), /no current controller-owned candidate view/);
	assert.doesNotMatch(JSON.stringify(result), /"status":"(?:approved|allowed)"/);
});

test("a transport refusal names the runnable wrapper continuation, never a raw CLI command as the only exit", async (t) => {
	// #535: a provider-printed raw `gentle-ai review ...` continuation is a dead
	// end in this runtime — Pi is not in the provider's immutable review runtime
	// list — so the refusal envelope itself must name the exit that runs in this
	// surface: the gentle_review / gentle_review_capture wrapper tools. The
	// provider's diagnostic stays intact as evidence alongside the runnable exit.
	const captureCwd = repository(t);
	const { native: captureNative } = transportAwareNative({ refusalCode: TRANSPORT_REFUSAL_CODE });
	const capture = await runCapture(captureCwd, captureNative, "continuation-capture-lineage");
	__testing.clearReviewTransportProbeForTesting(captureNative);
	assert.equal(capture.outcome, "pi-host-relay-transport-unavailable");
	const captureNextAction = String(capture.next_action);
	assert.match(captureNextAction, /gentle_review \{"operation":"inspect"\}/, "the capture refusal re-enters negotiated STATUS through the wrapper controller");
	assert.match(captureNextAction, /gentle_review_capture/, "the capture refusal names the wrapper resubmission, not a CLI command");
	assert.doesNotMatch(captureNextAction, /gentle-ai review/, "a raw `gentle-ai review ...` invocation is not a runnable exit in this runtime");
	assert.deepEqual(capture.wrapper_continuation, { tool: "gentle_review", operation: "inspect", then: "gentle_review_capture" });
	assert.match(String((capture.relay_transport as { message: string }).message), /immutable review runtimes/i, "the provider diagnostic remains intact in the envelope");

	const statusCwd = repository(t);
	const { native: statusNative } = transportAwareNative({ refusalCode: TRANSPORT_REFUSAL_CODE });
	const status = await runStatus(statusCwd, statusNative, "continuation-status-lineage");
	__testing.clearReviewTransportProbeForTesting(statusNative);
	assert.equal(status.outcome, "pi-host-relay-transport-unavailable");
	const statusNextAction = String(status.next_action);
	assert.match(statusNextAction, /gentle_review \{"operation":"inspect"\}/, "the controller refusal re-enters negotiated STATUS through the wrapper controller");
	assert.doesNotMatch(statusNextAction, /gentle-ai review/, "a raw `gentle-ai review ...` invocation is not a runnable exit in this runtime");
	assert.deepEqual(status.wrapper_continuation, { tool: "gentle_review", operation: "inspect" });
});

test("a remembered pi transport refusal remains blocked without re-probing or lifecycle continuation", async (t) => {
	const cwd = repository(t);
	const { native, agents } = transportAwareNative({ refusalCode: TRANSPORT_REFUSAL_CODE });
	const first = await runCapture(cwd, native, "probe-lineage");
	const second = await runCapture(cwd, native, "probe-lineage");
	assert.equal(first.outcome, "pi-host-relay-transport-unavailable");
	assert.equal(second.outcome, "pi-host-relay-transport-unavailable");
	assert.deepEqual(agents, ["pi"], "a cached refusal must not re-probe or issue an agent-less STATUS");
	__testing.clearReviewTransportProbeForTesting(native);
});

test("every typed Pi transport refusal code fails closed", async (t) => {
	const refusalCodes = [
		"immutable_review_transport_unsupported",
		"unsupported_agent",
		"unknown_flag",
	];
	for (const refusalCode of refusalCodes) {
		const cwd = repository(t);
		const { native, agents } = transportAwareNative({ refusalCode });
		const result = await runCapture(cwd, native, `refusal-${refusalCode}`);
		assert.equal(result.status, "blocked", `${refusalCode} must be blocked`);
		assert.equal(result.outcome, "pi-host-relay-transport-unavailable", `${refusalCode} must use the unavailable envelope`);
		assert.equal((result.relay_transport as { code: string }).code, refusalCode);
		assert.deepEqual(agents, ["pi"], `${refusalCode} must not fall back to agent-less STATUS`);
		__testing.clearReviewTransportProbeForTesting(native);
	}
});

test("typed status errors outside the Pi transport refusal set remain native errors", async (t) => {
	const cwd = repository(t);
	const { native, agents } = transportAwareNative({ refusalCode: "provider_unavailable" });
	const result = await runCapture(cwd, native, "non-transport-status-error");
	assert.deepEqual(agents, ["pi"], "a non-transport error must not be retried as an agent-less lifecycle STATUS");
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, undefined, "a non-transport error must not be coerced into a transport refusal envelope");
	assert.ok("native_failure" in result, "the native error envelope must remain available to the caller");
	assert.equal(result.relay_transport, undefined);
});

test("ordinary STATUS inspection uses the Pi public collect-binding route", async (t) => {
	const cwd = repository(t);
	const { native, agents } = transportAwareNative();
	const result = await runStatus(cwd, native, "ordinary-status-lineage");
	assert.deepEqual(agents, ["pi"], "ordinary STATUS must request the Pi public collect-binding route");
	assert.equal(result.operation, "status");
});
