import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as source from "../lib/review-integration-v2.ts";

// odd/tasks/review-one-call.md T11 (S5), L18: STATUS `non_blocking_findings`
// (gentle-ai#6088, opt-in --non-blocking-findings) is decoded only for a
// compact-v2 authority in correction_required or escalated.

const runtime = await import(new URL("../runtime/review-integration-v2.mjs", import.meta.url).href) as typeof source;
const decoders = [["lib", source], ["runtime", runtime]] as const;
type Body = Record<string, any>;
const fixture = (name: string): Body => JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", name), "utf8"));

const nonBlocking = () => ({
	statement: "Fixture statement; not real review output.",
	findings: [
		{ id: "R3-002", lens: "reliability", location: "candidate.ts:5", severity: "CRITICAL", disposition: "follow_up", claim: "Fixture claim A; not real review output." },
		{ id: "R3-W01", severity: "WARNING", disposition: "informational", claim: "" },
		{ id: "R4-R01", lens: "resilience", severity: "BLOCKER", disposition: "refuted", claim: "Fixture claim C; not real review output." },
	],
});

/** A current compact-v2 STATUS stop in the given state (status/v9 unless named). */
function status(state: string, extra: Body = {}, schema = "gentle-ai.review-integration.status/v9"): Body {
	const raw = fixture("status-v5-capture-result-submission.captured.json");
	raw.schema = schema;
	raw.action = "stop";
	raw.authority.state = state;
	delete raw.forecast;
	raw.next_transition = { kind: "stop", reason_code: "native_stop_required" };
	return { ...raw, ...extra };
}

for (const [label, decoder] of decoders) {
	test(`${label}: a correction_required or escalated compact STATUS decodes non_blocking_findings exactly`, () => {
		for (const state of ["correction_required", "escalated"]) {
			const value = nonBlocking();
			const decoded = decoder.decodeReviewStatusV3(status(state, { non_blocking_findings: structuredClone(value) }));
			assert.deepEqual(decoded.nonBlockingFindings, value, state);
			assert.deepEqual(decoded.raw.non_blocking_findings, value, `${state}: raw keeps the key`);
			const empty = decoder.decodeReviewStatusV3(status(state, { non_blocking_findings: { statement: "Fixture statement; not real review output.", findings: [] } }));
			assert.deepEqual(empty.nonBlockingFindings, { statement: "Fixture statement; not real review output.", findings: [] }, `${state}: an empty list is the provider's answer`);
		}
	});

	test(`${label}: non_blocking_findings is rejected outside a compact correction_required or escalated authority`, () => {
		const key = { non_blocking_findings: nonBlocking() };
		for (const state of ["approved", "reviewing"]) {
			assert.throws(() => decoder.decodeReviewStatusV3(status(state, structuredClone(key))), /status\.non_blocking_findings requires a current compact-v2 authority in correction_required or escalated/, state);
		}
		const legacy = status("correction_required", structuredClone(key));
		legacy.authority.version = "legacy-v1";
		delete legacy.frozen; delete legacy.receipt; delete legacy.authority_target_identity;
		assert.throws(() => decoder.decodeReviewStatusV3(legacy), /status\.non_blocking_findings requires a current compact-v2 authority in correction_required or escalated/);
		assert.throws(() => decoder.decodeReviewStatusV3(status("correction_required", structuredClone(key), "gentle-ai.review-integration.status/v8")), /status\.non_blocking_findings is not allowed/, "only status/v9 declares the key");
	});

	test(`${label}: the non_blocking_findings key sets stay exact`, () => {
		const cases: [string, (value: Body) => void][] = [
			["unknown top-level field", (value) => { value.extra = true; }],
			["statement missing", (value) => { delete value.statement; }],
			["statement empty", (value) => { value.statement = ""; }],
			["findings not an array", (value) => { value.findings = {}; }],
			["claim missing", (value) => { delete value.findings[0].claim; }],
			["claim not a string", (value) => { value.findings[0].claim = 7; }],
			["unknown finding field", (value) => { value.findings[0].proof_refs = []; }],
			["id empty", (value) => { value.findings[0].id = ""; }],
			["severity empty", (value) => { value.findings[0].severity = ""; }],
			["lens empty", (value) => { value.findings[0].lens = ""; }],
			["disposition outside the set", (value) => { value.findings[0].disposition = "fix_required"; }],
		];
		for (const [name, mutate] of cases) {
			const value: Body = nonBlocking();
			mutate(value);
			assert.throws(() => decoder.decodeReviewStatusV3(status("correction_required", { non_blocking_findings: value })), TypeError, name);
		}
	});

	test(`${label}: a STATUS without the key decodes as before, and closures keep advisory_findings approved-only`, () => {
		const plain = decoder.decodeReviewStatusV3(status("correction_required"));
		assert.equal(Object.hasOwn(plain, "nonBlockingFindings"), false);
		assert.equal(Object.hasOwn(plain.raw, "non_blocking_findings"), false);
		const original = fixture("status-v5-capture-result-submission.captured.json");
		original.action = "stop";
		assert.equal(Object.hasOwn(decoder.decodeReviewStatusV3(original), "nonBlockingFindings"), false);
		const closure = fixture("last-event-capture-refuter-correction-required.captured.json");
		assert.equal(closure.state, "correction_required");
		for (const key of ["advisory_findings", "reviewer_results"]) {
			assert.throws(() => decoder.decodeReviewLastEventClosureV1({ ...closure, [key]: key === "advisory_findings" ? { statement: "s", findings: [{ id: "F1", severity: "WARNING", disposition: "informational" }] } : [] }), TypeError, key);
		}
		assert.throws(() => decoder.decodeReviewLastEventClosureV1({ ...closure, non_blocking_findings: nonBlocking() }), TypeError, "the closure never carries non_blocking_findings");
	});
}

for (const [label, decoder] of decoders) {
	test(`${label}: a real escalated status/v9 body with the key decodes (L19 fixture)`, () => {
		const real = fixture("status-v9-escalated-non-blocking.captured.json");
		const decoded = decoder.decodeReviewStatusV3(real);
		assert.equal(decoded.authority?.state, "escalated");
		assert.deepEqual(decoded.nonBlockingFindings, real.non_blocking_findings);
		const approved = structuredClone(real); approved.authority.state = "approved";
		assert.throws(() => decoder.decodeReviewStatusV3(approved), /requires a current compact-v2 authority/);
		const v8 = structuredClone(real); v8.schema = "gentle-ai.review-integration.status/v8";
		assert.throws(() => decoder.decodeReviewStatusV3(v8), /non_blocking_findings is not allowed/);
	});
}
