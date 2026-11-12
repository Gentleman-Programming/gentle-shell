import assert from "node:assert/strict";
import test from "node:test";
import { runReviewCoordinator, type ReviewCoordinatorTool } from "../lib/review-coordinator.ts";

// odd/tasks/review-one-call.md T11 (S5), L18: a run that stops on a correction
// request or an escalation returns the provider's non-blocking findings
// (STATUS non_blocking_findings, gentle-ai#6088) with bounded reviewer claims.

type Body = Record<string, unknown>;
interface Metrics { steps: Body[] }
const target = "sha256:" + "a".repeat(64);
const lineage = "review-fixture";
const collect = { result: { target_identity: target, authority: { lineage_id: lineage }, next_transition: { kind: "collect" } }, collectBindings: [{ collectBinding: "opaque-not-json" }] };
const approved = { result: { target_identity: target, authority: { lineage_id: lineage }, next_transition: { kind: "execute", execute: { operation: "review.acknowledge-approved" } } } };
const closed = { outcome: "native-approved-acknowledgement-completed", status: "closed", authority: "burned", target_identity: target, lineage_id: lineage };
const captured = { outcome: "native-last-event-closure" };
function backend(responses: Body[]) {
	const calls: { tool: ReviewCoordinatorTool; parameters: Body }[] = [];
	return { calls, async invoke(tool: ReviewCoordinatorTool, parameters: Body) {
		calls.push({ tool, parameters });
		assert.ok(responses.length, "no unexpected follow-up or retry");
		return responses.shift()!;
	} };
}

const blocking = { id: "B1", lens: "risk", location: "a.ts:1", severity: "CRITICAL", claim: "blocking claim", proof_refs: ["p"], evidence: "e", evidence_class: "deterministic", causal_disposition: "introduced" };
const finding = (id: string, claim: unknown, extra: Body = {}) => ({ id, lens: "readability", location: "a.ts:2", severity: "WARNING", disposition: "informational", claim, ...extra });
const set = (findings: unknown) => ({ statement: "Fixture statement; not real review output.", findings });
const correction = (nonBlocking?: unknown) => ({ ...collect, result: { ...collect.result,
	next_transition: { kind: "collect", correction_request: { request_hash: "opaque-request", findings: [blocking] } },
	...(nonBlocking === undefined ? {} : { non_blocking_findings: nonBlocking }) }, collectBindings: [{ collectBinding: "plan" }] });
const escalated = (nonBlocking?: unknown) => ({ ...collect, result: { ...collect.result, authority: { lineage_id: lineage, state: "escalated" },
	escalation: { cause: "unknown_causality", finding_ids: ["B1"] }, next_transition: { kind: "stop", reason_code: "native_stop_required" },
	...(nonBlocking === undefined ? {} : { non_blocking_findings: nonBlocking }) } });
const NON_BLOCKING_KEYS = ["non_blocking_findings", "non_blocking_finding_claims", "non_blocking_finding_claims_truncated", "non_blocking_finding_claims_omitted"];
const listed = ({ claim: _claim, ...rest }: Body) => rest;

test("a correction request returns the provider's non-blocking findings and their claims beside correction_findings", async () => {
	const findings = [finding("W1", "first claim"), finding("F2", "second claim", { severity: "CRITICAL", disposition: "follow_up", lens: undefined }), finding("R3", "third claim", { disposition: "refuted", location: undefined })]
		.map((entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)));
	const response = correction(set(structuredClone(findings)));
	const host = backend([response]);
	const result = await runReviewCoordinator({ lineageId: lineage }, host);
	assert.equal(result.outcome, "input-required"); assert.equal(host.calls.length, 1);
	const { non_blocking_findings: _raw, ...nested } = response.result;
	assert.deepEqual(result.result, { ...response, result: nested }, "the STATUS envelope is relayed with only the raw set left out (L19)");
	assert.deepEqual(result.non_blocking_findings, set(findings.map(listed)), "statement and provider fields in provider order, without the claim");
	assert.deepEqual(result.non_blocking_finding_claims, { W1: "first claim", F2: "second claim", R3: "third claim" });
	for (const key of ["non_blocking_finding_claims_truncated", "non_blocking_finding_claims_omitted"]) assert.equal(Object.hasOwn(result, key), false, key);
	assert.deepEqual(result.correction_findings, [listed({ ...blocking, evidence: undefined, proof_refs: undefined })].map((entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))));
	assert.deepEqual(result.correction_finding_claims, { B1: "blocking claim" }, "correction keys unchanged");
	for (const key of ["advisory_findings", "advisory_finding_claims"]) assert.equal(Object.hasOwn(result, key), false, key);
});

test("non-blocking claims keep the 1,024-byte cut, the 8,192-byte limit and their marks; an empty claim is a claim", async () => {
	const many = [finding("N0", "é".repeat(600)), ...Array.from({ length: 8 }, (_, i) => finding(`N${i + 1}`, "z".repeat(1024))), finding("N9", "")];
	const result = await runReviewCoordinator({ lineageId: lineage }, backend([correction(set(structuredClone(many)))]));
	assert.equal((result.non_blocking_finding_claims as Body).N0, "é".repeat(512));
	assert.deepEqual(result.non_blocking_finding_claims_truncated, ["N0"]);
	assert.deepEqual(Object.keys(result.non_blocking_finding_claims as Body), ["N0", "N1", "N2", "N3", "N4", "N5", "N6", "N7"]);
	assert.deepEqual(result.non_blocking_finding_claims_omitted, ["N8", "N9"]);
	assert.deepEqual((result.non_blocking_findings as Body).findings, many.map(listed), "every finding is listed, with or without a claim");
	const empty = await runReviewCoordinator({ lineageId: lineage }, backend([correction(set([finding("E1", "")]))]));
	assert.deepEqual(empty.non_blocking_finding_claims, { E1: "" });
});

test("an escalated stop returns the provider's non-blocking findings with claims", async () => {
	const response = escalated(set([finding("W1", "escalated claim")]));
	const result = await runReviewCoordinator({ lineageId: lineage }, backend([response]));
	assert.equal(result.outcome, "stopped");
	const { non_blocking_findings: _raw, ...nested } = response.result;
	assert.deepEqual(result.result, { ...response, result: nested }, "only the raw set is left out of the nested record (L19)");
	assert.deepEqual(result.non_blocking_findings, set([listed(finding("W1", ""))]));
	assert.deepEqual(result.non_blocking_finding_claims, { W1: "escalated claim" });
	for (const key of ["correction_findings", "correction_finding_claims"]) assert.equal(Object.hasOwn(result, key), false, key);
});

test("an empty provider list is returned as the provider's answer; no key when the provider said nothing", async () => {
	for (const response of [correction(set([])), escalated(set([]))]) {
		const result = await runReviewCoordinator({ lineageId: lineage }, backend([response]));
		assert.deepEqual(result.non_blocking_findings, set([]));
		for (const key of NON_BLOCKING_KEYS.slice(1)) assert.equal(Object.hasOwn(result, key), false, key);
	}
	for (const response of [correction(), escalated()]) {
		const result = await runReviewCoordinator({ lineageId: lineage }, backend([response]));
		for (const key of NON_BLOCKING_KEYS) assert.equal(Object.hasOwn(result, key), false, key);
	}
});

for (const [name, statement, kept, cut] of [
	["short", "Provider statement.", "Provider statement.", false],
	["exact UTF-8 boundary", "é".repeat(512), "é".repeat(512), false],
	["oversized ASCII", "x".repeat(1024 * 1024), "x".repeat(1024), true],
	["oversized astral", "😀".repeat(257), "😀".repeat(256), true],
	["partial codepoint boundary", "a".repeat(1023) + "😀", "a".repeat(1023), true],
] as const) test(`non-blocking statement: ${name}`, async () => {
	for (const responseOf of [correction, escalated]) for (const findings of [[], [finding("N1", "claim")]]) {
		const response = responseOf({ statement, findings });
		const original = structuredClone(response);
		const host = backend([response]);
		const result = await runReviewCoordinator({ lineageId: lineage }, host);
		assert.equal(Buffer.byteLength((result.non_blocking_findings as Body).statement as string), Buffer.byteLength(kept));
		assert.deepEqual(result.non_blocking_findings, { statement: kept, findings: findings.map(listed), ...(cut ? { statement_truncated: true } : {}) });
		assert.equal(result.outcome, response.result.next_transition.kind === "stop" ? "stopped" : "input-required");
		assert.deepEqual(host.calls, [{ tool: "gentle_review", parameters: { operation: "status", lineageId: lineage } }]);
		assert.deepEqual(response, original, "provider input remains untouched");
		const { non_blocking_findings: _raw, ...nested } = original.result;
		assert.deepEqual(result.result, { ...original, result: nested }, "no unbounded nested copy");
		assert.deepEqual(result.non_blocking_finding_claims, findings.length ? { N1: "claim" } : undefined);
		for (const key of ["non_blocking_findings_omitted_count", "non_blocking_finding_claims_truncated", "non_blocking_finding_claims_omitted"]) assert.equal(Object.hasOwn(result, key), false, key);
	}
});

test("a malformed non-blocking set is dropped whole and never changes the outcome", async () => {
	const proto = Object.create({ id: "N1" });
	for (const value of ["s", [], null, { statement: "", findings: [] }, { statement: "s" }, { statement: "s", findings: {} }, set([finding("N1", 3)]), set([{ ...finding("N1", "c"), id: "" }]),
		set([(({ claim: _claim, ...rest }) => rest)(finding("N1", "c"))]), set([{ ...finding("N1", "c"), disposition: 1 }]), set([{ ...finding("N1", "c"), severity: "" }]), set([proto]), set([finding("N1", "c"), "N2"])]) {
		for (const response of [correction(value), escalated(value)]) {
			const result = await runReviewCoordinator({ lineageId: lineage }, backend([response]));
			assert.equal(result.outcome, response.result.next_transition.kind === "stop" ? "stopped" : "input-required", JSON.stringify(value));
			for (const key of NON_BLOCKING_KEYS) assert.equal(Object.hasOwn(result, key), false, `${key}: ${JSON.stringify(value)}`);
		}
	}
});

test("non-blocking findings are read only from the STATUS that ends the run; the approved path is unchanged", async () => {
	// Present on a STATUS that the run continues past: never relayed.
	const continuing = { ...collect, result: { ...collect.result, non_blocking_findings: set([finding("W1", "c")]) } };
	const run = await runReviewCoordinator({ lineageId: lineage }, backend([continuing, { ...captured, closure: { advisory_findings: { statement: "s", findings: [{ id: "F1" }] }, advisory_finding_claims: { F1: "c" } } }, approved, closed]));
	assert.equal(run.outcome, "closed");
	assert.deepEqual(run.advisory_findings, { statement: "s", findings: [{ id: "F1" }] }); assert.deepEqual(run.advisory_finding_claims, { F1: "c" });
	for (const key of [...NON_BLOCKING_KEYS, "correction_findings"]) assert.equal(Object.hasOwn(run, key), false, key);
	// Nothing routes on it: the same STATUS without the key takes the same route.
	const routed = await runReviewCoordinator({ lineageId: lineage }, backend([{ ...collect }, { ...captured }, approved, closed]));
	assert.equal(routed.outcome, "closed"); assert.deepEqual((routed.metrics as Metrics).steps.map((step: Body) => step.tool), (run.metrics as Metrics).steps.map((step: Body) => step.tool));
});

test("the listed findings fit the 16 KiB JSON boundary and count the unlisted remainder", async () => {
	const base = [finding("N1", "first"), finding("N2", "second")];
	const padding = 16 * 1024 - Buffer.byteLength(JSON.stringify(base.map(listed)));
	for (const delta of [-1, 0, 1]) {
		const findings = [base[0]!, finding("N2", "second", { location: `${base[1]!.location}${"x".repeat(padding + delta)}` })];
		assert.equal(Buffer.byteLength(JSON.stringify(findings.map(listed))), 16 * 1024 + delta);
		const response = escalated(set(findings));
		const host = backend([response]);
		const result = await runReviewCoordinator({ lineageId: lineage }, host);
		const expected = delta > 0 ? findings.slice(0, 1) : findings;
		assert.equal(result.outcome, "stopped");
		assert.equal(host.calls.length, 1);
		assert.deepEqual(result.non_blocking_findings, set(expected.map(listed)));
		assert.deepEqual(result.non_blocking_finding_claims, delta > 0 ? { N1: "first" } : { N1: "first", N2: "second" });
		assert.equal(Object.hasOwn(result, "non_blocking_findings_omitted_count"), delta > 0);
		if (delta > 0) assert.equal(result.non_blocking_findings_omitted_count, 1);
		const { non_blocking_findings: _raw, ...nested } = response.result;
		assert.deepEqual(result.result, { ...response, result: nested });
	}
});
