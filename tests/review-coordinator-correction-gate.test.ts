import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import { NativeReviewCliV216, type ExecFileAdapter } from "../lib/native-review-cli.ts";

// odd/tasks/review-one-call.md T11 (S5), L21: the run returns the correction
// fields at the top level only when the provider answered the non-blocking
// question; otherwise its correction result is what it was before T11.

type Body = Record<string, any>;
// A real contracted v2 STATUS (correction_required, correction_plan_required)
// from a locally built gentle-ai at gentle-ai#6088 (e7720e6f4), on a scratch
// lineage with one synthetic CRITICAL to correct and one synthetic WARNING;
// captured without the opt-in. Fixture text only; not real review output.
const STATUS: Body = JSON.parse("{\"schema\":\"gentle-ai.review-integration.status/v9\",\"contract\":\"gentle-ai.review-integration/v2\",\"operation\":\"review.status\",\"applicability\":\"current_target\",\"authority\":{\"version\":\"compact-v2\",\"lineage_id\":\"review-0d8b087fff7b6eed\",\"state\":\"correction_required\",\"generation\":1,\"revision\":\"sha256:a7ddf6edace20fa270507183a2a60dbedd3ab6b41f03d0462e9228c80d9c7672\"},\"action\":\"collect\",\"replayability\":\"manual_action_required\",\"frozen\":{\"tier\":\"medium\",\"original_changed_lines\":1,\"correction_budget\":1},\"target_identity\":\"sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\",\"projection\":{\"schema\":\"gentle-ai.review-integration.projection/v1\",\"kind\":\"current-changes\",\"projection\":\"workspace\",\"base_tree\":\"a0b17eb7f8eba95c76ff14a4d2cce51b601e76f2\",\"initial_review_tree\":\"1c46f89a3ac76bcd75f1b1afaef64a6dc089c6df\",\"current_candidate_tree\":\"1c46f89a3ac76bcd75f1b1afaef64a6dc089c6df\",\"paths_digest\":\"sha256:85fde7c14a0bab6e322280540f42e1a3475f31abba2454770081982d81532c0b\",\"paths\":[\"a.ts\"],\"intended_untracked\":[],\"intended_untracked_proof\":\"sha256:b97229718d4c7fe50a8892eb474ae5aa6491697bccb400e3e31dbaca4894d2f3\",\"initial_snapshot_identity\":\"sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\",\"current_snapshot_identity\":\"sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\"},\"eligible_untracked_inventory\":\"sha256:0fc9c89f9fb57a5340cb06a0d61707dbf4d16b8d18d78a55fd8c28d114b47735\",\"repair\":{\"schema\":\"gentle-ai.review-authority-repair-assessment/v1\",\"status\":\"unsupported\",\"counts\":{\"lineages\":0,\"compact_lineages\":0,\"legacy_lineages\":0,\"events\":0,\"bytes\":0,\"eligible_candidates\":0,\"unsupported_lineages\":0,\"conflicts\":0},\"supported_operations\":[\"review/complete-fix\",\"review/validate-fix\"],\"authorization_schema\":\"gentle-ai.review-repair-authorization/v1\"},\"candidates\":[],\"forecast\":{\"horizon\":\"partial\",\"steps\":[{\"step\":1,\"kind\":\"collect\",\"reason_code\":\"correction_plan_required\",\"description\":\"Correction plan required to resolve review findings\"}]},\"next_transition\":{\"kind\":\"collect\",\"reason_code\":\"correction_plan_required\",\"collect\":{\"inputs\":[{\"name\":\"correction_lines\",\"schema\":\"gentle-ai.review-correction-plan/v1\",\"capture_operation\":\"review.capture-correction-plan\",\"arguments\":[{\"name\":\"lineage\",\"value\":\"review-0d8b087fff7b6eed\",\"token\":\"--lineage=review-0d8b087fff7b6eed\"},{\"name\":\"expected-revision\",\"value\":\"sha256:358845cd62d643d9a7b747d8a96891e154f22506e2f4a495ee46bd602e73f020\",\"token\":\"--expected-revision=sha256:358845cd62d643d9a7b747d8a96891e154f22506e2f4a495ee46bd602e73f020\"},{\"name\":\"target\",\"value\":\"sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\",\"token\":\"--target=sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\"},{\"name\":\"repository-context\",\"value\":\"rctx2_16252ab07879c5e12cc36ca2c2051415bdb3af5ce6f1d55457f5cdde6d18753a\",\"token\":\"--repository-context=rctx2_16252ab07879c5e12cc36ca2c2051415bdb3af5ce6f1d55457f5cdde6d18753a\"},{\"name\":\"request-hash\",\"value\":\"sha256:71d2f500490dd020938d25102ed69bf71abfa672dbad70f13ae4e6689a8ea732\",\"token\":\"--request-hash=sha256:71d2f500490dd020938d25102ed69bf71abfa672dbad70f13ae4e6689a8ea732\"}],\"submission\":{\"operation_token\":\"capture-correction-plan\",\"argument_tokens\":[\"--lineage=review-0d8b087fff7b6eed\",\"--expected-revision=sha256:358845cd62d643d9a7b747d8a96891e154f22506e2f4a495ee46bd602e73f020\",\"--target=sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\",\"--request-hash=sha256:71d2f500490dd020938d25102ed69bf71abfa672dbad70f13ae4e6689a8ea732\",\"--repository-context=rctx2_16252ab07879c5e12cc36ca2c2051415bdb3af5ce6f1d55457f5cdde6d18753a\",\"--correction-lines={{value}}\"],\"value\":{\"slot\":\"correction_lines\",\"domain\":\"positive_correction_lines\",\"minimum\":1,\"maximum\":2,\"substitution_location\":5}}}]},\"correction_request\":{\"schema\":\"gentle-ai.review-correction-plan-request/v1\",\"request_hash\":\"sha256:71d2f500490dd020938d25102ed69bf71abfa672dbad70f13ae4e6689a8ea732\",\"lineage_id\":\"review-0d8b087fff7b6eed\",\"expected_revision\":\"sha256:358845cd62d643d9a7b747d8a96891e154f22506e2f4a495ee46bd602e73f020\",\"target_identity\":\"sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\",\"correction_budget\":2,\"fix_finding_ids\":[\"R3-001\"],\"findings\":[{\"id\":\"R3-001\",\"lens\":\"reliability\",\"location\":\"a.ts:2\",\"severity\":\"CRITICAL\",\"claim\":\"Fixture: the added export breaks the reader; not real review output.\",\"proof_refs\":[\"the changed line deterministically causes the reproduced failure\"],\"evidence\":\"the changed line deterministically causes the reproduced failure\",\"evidence_class\":\"deterministic\",\"causal_disposition\":\"introduced\"}]}},\"repository_context\":{\"capability\":\"review.opaque_repository_context\",\"handle\":\"rctx2_16252ab07879c5e12cc36ca2c2051415bdb3af5ce6f1d55457f5cdde6d18753a\",\"revision\":\"sha256:358845cd62d643d9a7b747d8a96891e154f22506e2f4a495ee46bd602e73f020\",\"target_identity\":\"sha256:83e0f87755b27e526b27f89d986374c0b1415a7851718f2ce1aa800bb68e371f\"}}");
// The same STATUS's non_blocking_findings with --non-blocking-findings (the
// rest of the body is identical); statement treated as opaque text.
const NON_BLOCKING: Body = JSON.parse("{\"statement\":\"Every finding listed here is non-blocking: it is not a finding to correct and not an unresolved finding that stopped this review, and it needs no correction in this review. A `follow_up` finding is separate later work; a `refuted` finding needs none.\",\"findings\":[{\"id\":\"R3-W01\",\"lens\":\"reliability\",\"location\":\"a.ts:2\",\"severity\":\"WARNING\",\"disposition\":\"informational\",\"claim\":\"Fixture warning claim; not real review output.\"}]}");
const lineage: string = STATUS.authority.lineage_id;

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-correction-gate-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
execFileSync("git", ["init", "-q"], { cwd: scratch });
writeFileSync(join(scratch, "a.ts"), "export const a = 1;\n");
const executable = join(scratch, "gentle-ai-fixture");
writeFileSync(executable, "fixture provider; never executed");
const mode = JSON.stringify({ schema: "gentle-ai.review-mode/v1", operation: "status", scope: "both", status: { schema: "gentle-ai.rdd-mode-status/v1", global: "on", clone_local: "", effective: "on", source: "global", revision: `sha256:${"f".repeat(64)}` } });
const refusal = { schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2", operation: "review.status", phase: "preflight",
	code: "invalid_request", message: "The negotiated review request is invalid.", mutation_outcome: "not_started", authority_applicability: "not_evaluated",
	retry_safe: true, replayability: "not_replayable", required_inputs: [], next_action: "correct_request", cause: "flag provided but not defined: -non-blocking-findings" };

type Provider = "answers" | "answers-empty" | "refuses" | "silent";
/** answers: the flag adds the key; answers-empty: the key with no findings; refuses: the pinned provider's refusal; silent: accepts the flag and sends no key. */
function host(kind: Provider) {
	const statusCalls: boolean[] = [];
	const adapter: ExecFileAdapter = async (request) => {
		const args = request.arguments;
		const reply = (body: unknown, exitCode = 0) => ({ stdout: JSON.stringify(body), stderr: exitCode === 0 ? "" : "Error: The negotiated review request is invalid. [invalid_request]\n", exitCode, signal: null, timedOut: false, outputLimitExceeded: false });
		if (args[0] === "review" && args[1] === "mode") return { ...reply(undefined), stdout: mode };
		if (args[0] !== "review" || args[1] !== "status") throw new Error(`unexpected native invocation: ${args.join(" ")}`);
		const flagged = args.includes("--non-blocking-findings");
		statusCalls.push(flagged);
		if (flagged && kind === "refuses") return reply(refusal, 1);
		const body = structuredClone(STATUS);
		if (flagged && kind === "answers") body.non_blocking_findings = structuredClone(NON_BLOCKING);
		if (flagged && kind === "answers-empty") body.non_blocking_findings = { ...structuredClone(NON_BLOCKING), findings: [] };
		return reply(body);
	};
	// One executable per provider kind: a refusal is remembered per binary.
	const binary = join(scratch, `gentle-ai-${kind}-${Math.random().toString(36).slice(2)}`);
	writeFileSync(binary, `fixture provider ${kind} ${binary}`);
	const tools = new Map<string, any>();
	createGentleAiExtension({ nativeReviewCli: new NativeReviewCliV216(adapter, binary, 30_000, 8 * 1024 * 1024), candidateViews: null, processEnv: { GENTLE_AI_TELEMETRY: "0" } })(
		{ on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as never);
	const context = { cwd: scratch, hasUI: false, sessionManager: { getSessionId: () => "fixture-gate", getBranch: () => [], getSessionFile: () => undefined } };
	return { statusCalls, run: async () => {
		try {
			const result = await tools.get("gentle_review_run").execute("fixture-call", { lineageId: lineage }, undefined, undefined, context);
			return result.details as Body;
		} finally { __testing.setReviewHostRelayRunnerForTesting(); __testing.setReviewHostRelayGroupRunnersForTesting(); }
	} };
}

const CORRECTION_KEYS = ["correction_findings", "correction_finding_claims", "correction_finding_claims_truncated", "correction_finding_claims_omitted"];
const NON_BLOCKING_KEYS = ["non_blocking_findings", "non_blocking_finding_claims", "non_blocking_finding_claims_truncated", "non_blocking_finding_claims_omitted", "non_blocking_findings_omitted_count"];
const request = STATUS.next_transition.correction_request;

test("the provider answered: the correction fields and the non-blocking fields come back together", async () => {
	const provider = host("answers");
	const details = await provider.run();
	assert.equal(details.outcome, "input-required", JSON.stringify(details).slice(0, 300));
	assert.deepEqual(provider.statusCalls, [true]);
	assert.deepEqual(details.correction_findings, request.findings.map(({ id, lens, location, severity, evidence_class, causal_disposition }: Body) => ({ id, lens, location, severity, evidence_class, causal_disposition })));
	assert.deepEqual(details.correction_finding_claims, Object.fromEntries(request.findings.map((finding: Body) => [finding.id, finding.claim])));
	assert.deepEqual(details.non_blocking_findings, { statement: NON_BLOCKING.statement, findings: NON_BLOCKING.findings.map(({ claim: _claim, ...finding }: Body) => finding) });
	assert.deepEqual(details.non_blocking_finding_claims, Object.fromEntries(NON_BLOCKING.findings.map((finding: Body) => [finding.id, finding.claim])));
	assert.equal(Object.hasOwn(details.result.result, "non_blocking_findings"), false);
});

test("the provider answered with an empty list: the correction fields come back with the empty answer", async () => {
	const provider = host("answers-empty");
	const details = await provider.run();
	assert.equal(details.outcome, "input-required");
	assert.equal(details.correction_findings.length, request.findings.length);
	assert.deepEqual(Object.keys(details.correction_finding_claims), request.findings.map((finding: Body) => finding.id));
	assert.deepEqual(details.non_blocking_findings, { statement: NON_BLOCKING.statement, findings: [] });
	assert.equal(Object.hasOwn(details, "non_blocking_finding_claims"), false);
});

for (const kind of ["refuses", "silent"] as const) {
	test(`the provider did not answer (${kind}): no top-level correction or non-blocking field; the nested record is the provider's STATUS`, async () => {
		const provider = host(kind);
		const details = await provider.run();
		assert.equal(details.outcome, "input-required");
		assert.deepEqual(provider.statusCalls, kind === "refuses" ? [true, false] : [true]);
		for (const key of [...CORRECTION_KEYS, ...NON_BLOCKING_KEYS]) assert.equal(Object.hasOwn(details, key), false, `${kind}: ${key}`);
		const { collect: _collect, ...transition } = STATUS.next_transition;
		assert.deepEqual(details.result.result, { ...STATUS, next_transition: transition }, `${kind}: the relayed STATUS keeps the correction request`);
		assert.deepEqual(Object.keys(details).sort(), ["forecasts", "lineage_id", "metrics", "outcome", "result", "reviewer_runs", "schema"], `${kind}: the pre-T11 result keys`);
	});
}
