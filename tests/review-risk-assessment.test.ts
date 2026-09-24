import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NATIVE_REVIEW_MODE_SOURCE,
	NativeReviewCliError,
	NativeReviewCliV216,
	type ExecFileAdapter,
	type NativeReviewCli,
	type NativeReviewAssessRequest,
} from "../lib/native-review-cli.ts";
import {
	decodeReviewAssessmentV1,
	isSmallWriterProfile,
	resolveWriterProfile,
	verificationPlan,
	REVIEW_ASSESSMENT_SCHEMA,
	VERIFICATION_TIER,
	RDD_LINE,
	WRITER_PROFILE,
	NATIVE_REVIEW_OUTCOME,
	type VerificationTier,
	type RddLine,
	type WriterProfile,
	type NativeReviewOutcome,
} from "../lib/review-risk-assessment.ts";

// ---------------------------------------------------------------------------
// gentle-pi#662: decoder for the native `gentle-ai review assess` envelope
// (gentle-ai#4295, landing in parallel -- stubbed here, never invoked as a
// real process).
// ---------------------------------------------------------------------------

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: REVIEW_ASSESSMENT_SCHEMA,
		risk: "medium",
		reasons: [{ code: "touches-auth-path", path: "lib/auth.ts", detail: "matches a high-risk path token" }],
		changed_paths: 2,
		changed_lines: 14,
		candidate: { kind: "current-changes" },
		...overrides,
	};
}

test("decodeReviewAssessmentV1 accepts a well-formed gentle-ai.review-assessment/v1 envelope", () => {
	const decoded = decodeReviewAssessmentV1(validEnvelope());
	assert.equal(decoded.schema, REVIEW_ASSESSMENT_SCHEMA);
	assert.equal(decoded.risk, "medium");
	assert.deepEqual(decoded.reasons, [{ code: "touches-auth-path", path: "lib/auth.ts", detail: "matches a high-risk path token" }]);
	assert.equal(decoded.changedPaths, 2);
	assert.equal(decoded.changedLines, 14);
	assert.deepEqual(decoded.candidate, { kind: "current-changes", baseRef: undefined });
});

test("decodeReviewAssessmentV1 accepts a base-diff candidate with base_ref", () => {
	const decoded = decodeReviewAssessmentV1(validEnvelope({ candidate: { kind: "base-diff", base_ref: "origin/main" } }));
	assert.deepEqual(decoded.candidate, { kind: "base-diff", baseRef: "origin/main" });
});

test("decodeReviewAssessmentV1 accepts passive and high risk values", () => {
	assert.equal(decodeReviewAssessmentV1(validEnvelope({ risk: "passive", reasons: [] })).risk, "passive");
	assert.equal(decodeReviewAssessmentV1(validEnvelope({ risk: "high" })).risk, "high");
});

test("decodeReviewAssessmentV1 rejects a wrong schema", () => {
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ schema: "gentle-ai.review-assessment/v2" })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ schema: undefined })), TypeError);
});

test("decodeReviewAssessmentV1 rejects an unrecognized risk value", () => {
	for (const risk of ["low", "critical", "", 1, null, undefined]) {
		assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ risk })), TypeError, `risk ${JSON.stringify(risk)} must be rejected`);
	}
});

test("decodeReviewAssessmentV1 rejects a malformed shape", () => {
	assert.throws(() => decodeReviewAssessmentV1(null), TypeError);
	assert.throws(() => decodeReviewAssessmentV1("gentle-ai.review-assessment/v1"), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ reasons: "none" })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ reasons: [{ code: "x" }] })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ changed_paths: -1 })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ changed_lines: 1.5 })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ candidate: { kind: "unknown-kind" } })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ candidate: { kind: "current-changes", base_ref: "" } })), TypeError);
});

// ---------------------------------------------------------------------------
// verificationPlan: every (rdd, risk, profile) combination from gentle-pi#662.
// ---------------------------------------------------------------------------

const RISKS: readonly VerificationTier[] = [VERIFICATION_TIER.PASSIVE, VERIFICATION_TIER.MEDIUM, VERIFICATION_TIER.HIGH, VERIFICATION_TIER.UNASSESSABLE];
const RDD_LINES: readonly RddLine[] = [RDD_LINE.ON, RDD_LINE.OFF, RDD_LINE.UNKNOWN];
const PROFILES: readonly WriterProfile[] = [WRITER_PROFILE.SMALL, WRITER_PROFILE.LARGE];
const NON_CLOSED_OUTCOMES: readonly NativeReviewOutcome[] = [NATIVE_REVIEW_OUTCOME.DECLINED, NATIVE_REVIEW_OUTCOME.UNAVAILABLE, NATIVE_REVIEW_OUTCOME.UNKNOWN];

test("verificationPlan: rdd on + closed, passive risk -> structural readback only regardless of writer profile", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.PASSIVE, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
		assert.equal(plan.structuralReadbackOnly, true);
		assert.equal(plan.writerSelfVerification, false);
		assert.equal(plan.independentVerifier, false);
	}
});

test("verificationPlan: rdd on + closed, medium/high/unassessable risk -> writer self-verification, no independent verifier", () => {
	for (const risk of [VERIFICATION_TIER.MEDIUM, VERIFICATION_TIER.HIGH, VERIFICATION_TIER.UNASSESSABLE]) {
		for (const writerProfile of PROFILES) {
			const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
			assert.equal(plan.writerSelfVerification, true, `rdd on+closed, risk ${risk}, profile ${writerProfile}`);
			assert.equal(plan.structuralReadbackOnly, false);
			assert.equal(plan.independentVerifier, false, `the closed native review is the independent check under rdd on for risk ${risk}`);
		}
	}
});

// ---------------------------------------------------------------------------
// gentle-pi#668: the `on` branch holds only while the native review reaches a
// terminal (`closed`) outcome for this candidate. A decline, an unavailable
// review, or an unknown/omitted outcome falls back to the exact same
// risk-gated path as `off` -- declining a review is candidate-scoped and
// never lowers the bar below the RDD-off path.
// ---------------------------------------------------------------------------

test("verificationPlan: rdd on + non-closed outcome behaves exactly like rdd off for every risk/profile combination", () => {
	for (const outcome of NON_CLOSED_OUTCOMES) {
		for (const risk of RISKS) {
			for (const writerProfile of PROFILES) {
				const off = verificationPlan({ rddLine: RDD_LINE.OFF, risk, writerProfile });
				const onFallback = verificationPlan({ rddLine: RDD_LINE.ON, risk, writerProfile, nativeReviewOutcome: outcome });
				assert.equal(onFallback.writerSelfVerification, off.writerSelfVerification, `outcome ${outcome}, risk ${risk}, profile ${writerProfile}`);
				assert.equal(onFallback.structuralReadbackOnly, off.structuralReadbackOnly, `outcome ${outcome}, risk ${risk}, profile ${writerProfile}`);
				assert.equal(onFallback.independentVerifier, off.independentVerifier, `outcome ${outcome}, risk ${risk}, profile ${writerProfile}`);
			}
		}
	}
});

test("verificationPlan: an omitted nativeReviewOutcome under rdd on defaults to unknown (fail closed), exactly like rdd off", () => {
	for (const risk of RISKS) {
		for (const writerProfile of PROFILES) {
			const off = verificationPlan({ rddLine: RDD_LINE.OFF, risk, writerProfile });
			const omitted = verificationPlan({ rddLine: RDD_LINE.ON, risk, writerProfile });
			assert.equal(omitted.writerSelfVerification, off.writerSelfVerification);
			assert.equal(omitted.structuralReadbackOnly, off.structuralReadbackOnly);
			assert.equal(omitted.independentVerifier, off.independentVerifier);
		}
	}
});

test("verificationPlan: on+closed+medium+large -> no verifier", () => {
	const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.LARGE, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
	assert.equal(plan.independentVerifier, false);
	assert.equal(plan.writerSelfVerification, true);
});

test("verificationPlan: on+declined+medium+large -> no verifier (medium, large)", () => {
	const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.LARGE, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
	assert.equal(plan.independentVerifier, false);
	assert.equal(plan.writerSelfVerification, true);
});

test("verificationPlan: on+declined+medium+small -> verifier", () => {
	const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.SMALL, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
	assert.equal(plan.independentVerifier, true);
});

test("verificationPlan: on+declined+high -> verifier", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.HIGH, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
		assert.equal(plan.independentVerifier, true);
	}
});

test("verificationPlan: on+unavailable+high -> verifier", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.HIGH, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.UNAVAILABLE });
		assert.equal(plan.independentVerifier, true);
	}
});

test("verificationPlan: on+unknown (omitted)+high -> verifier", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.HIGH, writerProfile });
		assert.equal(plan.independentVerifier, true);
	}
});

test("verificationPlan: on+declined+passive -> structural readback", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.PASSIVE, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
		assert.equal(plan.structuralReadbackOnly, true);
		assert.equal(plan.writerSelfVerification, false);
		assert.equal(plan.independentVerifier, false);
	}
});

test("verificationPlan: off+closed+high -> verifier (outcome ignored)", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.OFF, risk: VERIFICATION_TIER.HIGH, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
		assert.equal(plan.independentVerifier, true);
		assert.equal(plan.writerSelfVerification, true);
	}
});

test("verificationPlan: off/unknown lines ignore nativeReviewOutcome entirely", () => {
	for (const rddLine of [RDD_LINE.OFF, RDD_LINE.UNKNOWN]) {
		for (const risk of RISKS) {
			for (const writerProfile of PROFILES) {
				const withoutOutcome = verificationPlan({ rddLine, risk, writerProfile });
				for (const outcome of Object.values(NATIVE_REVIEW_OUTCOME)) {
					const withOutcome = verificationPlan({ rddLine, risk, writerProfile, nativeReviewOutcome: outcome });
					assert.deepEqual(withOutcome, withoutOutcome, `rddLine ${rddLine}, risk ${risk}, profile ${writerProfile}, outcome ${outcome}`);
				}
			}
		}
	}
});

for (const rddLine of [RDD_LINE.OFF, RDD_LINE.UNKNOWN]) {
	test(`verificationPlan: rdd ${rddLine}, passive risk -> structural readback only, no verifier, no tests`, () => {
		for (const writerProfile of PROFILES) {
			const plan = verificationPlan({ rddLine, risk: VERIFICATION_TIER.PASSIVE, writerProfile });
			assert.equal(plan.structuralReadbackOnly, true);
			assert.equal(plan.writerSelfVerification, false);
			assert.equal(plan.independentVerifier, false);
		}
	});

	test(`verificationPlan: rdd ${rddLine}, medium risk -> independent verifier only for a small writer profile`, () => {
		const large = verificationPlan({ rddLine, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.LARGE });
		assert.equal(large.writerSelfVerification, true);
		assert.equal(large.structuralReadbackOnly, false);
		assert.equal(large.independentVerifier, false);

		const small = verificationPlan({ rddLine, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.SMALL });
		assert.equal(small.writerSelfVerification, true);
		assert.equal(small.structuralReadbackOnly, false);
		assert.equal(small.independentVerifier, true, "the small-model bias raises medium to high for verification purposes");
	});

	test(`verificationPlan: rdd ${rddLine}, high or unassessable risk -> writer self-verification plus independent verifier, always`, () => {
		for (const risk of [VERIFICATION_TIER.HIGH, VERIFICATION_TIER.UNASSESSABLE]) {
			for (const writerProfile of PROFILES) {
				const plan = verificationPlan({ rddLine, risk, writerProfile });
				assert.equal(plan.writerSelfVerification, true, `rdd ${rddLine}, risk ${risk}, profile ${writerProfile}`);
				assert.equal(plan.structuralReadbackOnly, false);
				assert.equal(plan.independentVerifier, true, `rdd ${rddLine}, risk ${risk}, profile ${writerProfile}`);
			}
		}
	});
}

test("verificationPlan: an unknown rdd line never lowers a tier relative to off", () => {
	for (const risk of RISKS) {
		for (const writerProfile of PROFILES) {
			const off = verificationPlan({ rddLine: RDD_LINE.OFF, risk, writerProfile });
			const unknown = verificationPlan({ rddLine: RDD_LINE.UNKNOWN, risk, writerProfile });
			assert.equal(unknown.writerSelfVerification, off.writerSelfVerification);
			assert.equal(unknown.structuralReadbackOnly, off.structuralReadbackOnly);
			assert.equal(unknown.independentVerifier, off.independentVerifier);
		}
	}
});

test("verificationPlan: reason is a non-empty distinctive string for every branch", () => {
	for (const rddLine of RDD_LINES) {
		for (const risk of RISKS) {
			for (const writerProfile of PROFILES) {
				const plan = verificationPlan({ rddLine, risk, writerProfile });
				assert.ok(plan.reason.length > 20, `reason too short for ${rddLine}/${risk}/${writerProfile}`);
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Small-writer-profile predicate.
// ---------------------------------------------------------------------------

test("isSmallWriterProfile: true when the resolved effort is low", () => {
	assert.equal(isSmallWriterProfile({ thinking: "low" }), true);
});

test("isSmallWriterProfile: true when the resolved model id carries mini as a whole token, case-insensitively", () => {
	assert.equal(isSmallWriterProfile({ model: { id: "gpt-5-mini" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "Claude-Mini-Fast" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "openai/gpt-5.4-mini" } }), true, "a path-delimited mini token must still match");
	assert.equal(isSmallWriterProfile({ model: { id: "o4-mini" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "claude-mini" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "mini-high" } }), true, "mini at the start of the id must still match");
});

test("isSmallWriterProfile: false for a model id where mini is only a bare substring (gemini)", () => {
	assert.equal(isSmallWriterProfile({ model: { id: "gemini" } }), false, "gemini must never match on the mini substring");
	assert.equal(isSmallWriterProfile({ model: { id: "gemini-2.5-pro" } }), false);
	assert.equal(isSmallWriterProfile({ model: { id: "gemini-2.5-flash" } }), false);
});

test("isSmallWriterProfile: false for a large model with medium/high effort", () => {
	assert.equal(isSmallWriterProfile({ model: { id: "claude-opus-4" }, thinking: "high" }), false);
	assert.equal(isSmallWriterProfile({ model: { id: "claude-sonnet-5" }, thinking: "medium" }), false);
	assert.equal(isSmallWriterProfile({ model: { id: "gemini-2.5-pro" }, thinking: "high" }), false);
});

test("isSmallWriterProfile: true (fail closed) when the profile is undefined, empty, or carries only an unrecognized effort with no model id", () => {
	assert.equal(isSmallWriterProfile(undefined), true, "an unknown/omitted profile must fail closed to small, not default to large");
	assert.equal(isSmallWriterProfile({}), true);
	assert.equal(isSmallWriterProfile({ thinking: undefined }), true, "matches how the omitted-input caller shape resolves (thinking key present but undefined)");
});

test("isSmallWriterProfile: false when effort alone is known and not low, even without a model id", () => {
	assert.equal(isSmallWriterProfile({ thinking: "high" }), false, "an explicitly recorded non-low effort is a known-large signal, not an unknown profile");
});

test("resolveWriterProfile maps the predicate to the small/large verificationPlan input", () => {
	assert.equal(resolveWriterProfile({ thinking: "low" }), WRITER_PROFILE.SMALL);
	assert.equal(resolveWriterProfile({ model: { id: "o-mini" } }), WRITER_PROFILE.SMALL);
	assert.equal(resolveWriterProfile({ model: { id: "claude-sonnet-5" }, thinking: "high" }), WRITER_PROFILE.LARGE);
	assert.equal(resolveWriterProfile({ model: { id: "gemini-2.5-pro" }, thinking: "high" }), WRITER_PROFILE.LARGE, "gemini must resolve large, never small on the substring");
});

test("resolveWriterProfile: an unknown or omitted profile fails closed to small, never large", () => {
	assert.equal(resolveWriterProfile(undefined), WRITER_PROFILE.SMALL);
	assert.equal(resolveWriterProfile({}), WRITER_PROFILE.SMALL);
});

// ---------------------------------------------------------------------------
// Tool-level fail-closed path: the `gentle_review` tool's `assess` operation
// (`extensions/gentle-ai.ts`, gentle-pi#662) must treat a native CLI without
// the `assess` verb (an older binary) or a rejected `assess` call (a process
// failure) the same way -- risk "unassessable", which `verificationPlan`
// treats as `high`. `assess` is exposed as a `gentle_review` operation, not a
// dedicated tool, so the fixed `gentle_*` tool registry stays unchanged.

function reviewControllerTool(nativeReviewCli: Partial<NativeReviewCli> | null): { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ content: readonly { type: string; text: string }[]; details: unknown }> } {
	const tools = new Map<string, any>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: nativeReviewCli as NativeReviewCli | null })(pi);
	const tool = tools.get("gentle_review");
	assert.ok(tool, "gentle_review must be registered");
	return tool;
}

const ctx = { cwd: process.cwd() } as ExtensionContext;

test("gentle_review assess: an older binary without the assess verb fails closed to high", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "off", cloneLocal: "off", effective: "off", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		// assess intentionally absent: pre-gentle-ai#4295 binary.
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-1", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; plan: { writerSelfVerification: boolean; independentVerifier: boolean; structuralReadbackOnly: boolean } };
	assert.equal(details.risk, VERIFICATION_TIER.UNASSESSABLE);
	assert.equal(details.rddLine, "off");
	assert.equal(details.plan.writerSelfVerification, true);
	assert.equal(details.plan.independentVerifier, true);
	assert.equal(details.plan.structuralReadbackOnly, false);
	const highEquivalent = verificationPlan({ rddLine: "off", risk: VERIFICATION_TIER.HIGH, writerProfile: WRITER_PROFILE.LARGE });
	assert.equal(details.plan.writerSelfVerification, highEquivalent.writerSelfVerification, "unassessable must verify exactly like high");
	assert.equal(details.plan.independentVerifier, highEquivalent.independentVerifier, "unassessable must verify exactly like high");
	assert.equal(details.plan.structuralReadbackOnly, highEquivalent.structuralReadbackOnly, "unassessable must verify exactly like high");
	assert.equal(JSON.parse(result.content[0].text).risk, VERIFICATION_TIER.UNASSESSABLE);
});

test("gentle_review assess: a rejected assess call fails closed to high, and RDD status read failure fails closed to unknown", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => {
			throw new Error("native review mode is unavailable");
		},
		assess: async () => {
			throw new Error("native process failed");
		},
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-2", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; reasons: readonly { code: string }[]; plan: { independentVerifier: boolean; writerSelfVerification: boolean } };
	assert.equal(details.risk, VERIFICATION_TIER.UNASSESSABLE);
	assert.equal(details.rddLine, "unknown", "an unresolved RDD status must fail closed to unknown, never on or off");
	assert.equal(details.reasons[0]?.code, "native-assess-unavailable");
	assert.equal(details.plan.writerSelfVerification, true);
	assert.equal(details.plan.independentVerifier, true);
});

test("gentle_review assess: a successful native assessment is reflected directly in the returned plan", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({
			schema: REVIEW_ASSESSMENT_SCHEMA,
			risk: "passive",
			reasons: [],
			changedPaths: 1,
			changedLines: 3,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-3", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; plan: { structuralReadbackOnly: boolean } };
	assert.equal(details.risk, "passive");
	assert.equal(details.rddLine, "on");
	assert.equal(details.plan.structuralReadbackOnly, true);
});

test("gentle_review assess: baseRef without committedOnly is rejected", async () => {
	const tool = reviewControllerTool({});
	await assert.rejects(
		() => tool.execute("call-4", { operation: "assess", input: JSON.stringify({ baseRef: "origin/main" }) }, undefined, undefined, ctx),
		/committedOnly/,
	);
});

test("gentle_review assess: writerModelId/writerEffort in input select the writer profile, and an omitted profile fails closed to small", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "off", cloneLocal: "off", effective: "off", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({
			schema: REVIEW_ASSESSMENT_SCHEMA,
			risk: "medium",
			reasons: [],
			changedPaths: 1,
			changedLines: 10,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	};
	const tool = reviewControllerTool(nativeReviewCli);

	// Omitted profile + medium + off -> fails closed to small -> independent
	// verifier true (this is the fix for the fail-open finding: an omitted
	// profile must never resolve as permissively as a known large model).
	const omitted = await tool.execute("call-5", { operation: "assess" }, undefined, undefined, ctx);
	assert.equal((omitted.details as { writerProfile: string }).writerProfile, "small");
	assert.equal((omitted.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, true, "an omitted writer profile must fail closed to small, not default to large");

	// Explicit large profile + medium + off -> independent verifier false.
	const explicitLarge = await tool.execute(
		"call-6",
		{ operation: "assess", input: JSON.stringify({ writerModelId: "claude-sonnet-5", writerEffort: "high" }) },
		undefined,
		undefined,
		ctx,
	);
	assert.equal((explicitLarge.details as { writerProfile: string }).writerProfile, "large");
	assert.equal((explicitLarge.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, false, "an explicitly recorded large profile must not be forced into the small-model bias");

	const small = await tool.execute("call-7", { operation: "assess", input: JSON.stringify({ writerEffort: "low" }) }, undefined, undefined, ctx);
	assert.equal((small.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, true, "a low-effort writer profile must trigger the small-model bias");

	// A gemini model id must resolve large, never small on the bare "mini" substring.
	const gemini = await tool.execute("call-8", { operation: "assess", input: JSON.stringify({ writerModelId: "gemini-2.5-pro", writerEffort: "high" }) }, undefined, undefined, ctx);
	assert.equal((gemini.details as { writerProfile: string }).writerProfile, "large", "gemini-2.5-pro must never be tiered as a small model");
	assert.equal((gemini.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, false);
});

test("gentle_review assess: an explicit nativeReviewOutcome:\"declined\" input falls back to the risk-gated plan even when RDD is on (gentle-pi#668)", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({
			schema: REVIEW_ASSESSMENT_SCHEMA,
			risk: "high",
			reasons: [],
			changedPaths: 3,
			changedLines: 40,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-9", { operation: "assess", input: JSON.stringify({ nativeReviewOutcome: "declined" }) }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; outcome_source: string; plan: { writerSelfVerification: boolean; independentVerifier: boolean; structuralReadbackOnly: boolean } };
	assert.equal(details.risk, "high");
	assert.equal(details.rddLine, "on", "the rendered RDD line still reads on -- only the verification plan falls back");
	assert.equal(details.outcome_source, "explicit");
	assert.equal(details.plan.writerSelfVerification, true);
	assert.equal(details.plan.independentVerifier, true, "a declined review for this candidate must re-enable the risk-gated independent verifier");
	assert.equal(details.plan.structuralReadbackOnly, false);
});

test("gentle_review assess: an unrecognized nativeReviewOutcome value is rejected", async () => {
	const tool = reviewControllerTool({});
	await assert.rejects(
		() => tool.execute("call-10", { operation: "assess", input: JSON.stringify({ nativeReviewOutcome: "approved" }) }, undefined, undefined, ctx),
		/nativeReviewOutcome/,
	);
});

// gentle-pi#668 correction: keyed per candidate (repository + target
// identity), never repository alone; `closed` is never written to the memo.
function assessOnNativeCli(currentTargetIdentity: () => string): Partial<NativeReviewCli> {
	return {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "high", reasons: [], changedPaths: 1, changedLines: 5, candidate: { kind: "current-changes", baseRef: undefined } }),
		targetStatus: (async () => ({ applicability: "current_target", targetIdentity: currentTargetIdentity() })) as NativeReviewCli["targetStatus"],
	};
}

test("gentle_review assess: derivation is bound to the exact candidate recorded, closed can only ever be passed explicitly (gentle-pi#668 correction)", async (t) => {
	t.after(() => __testing.clearNativeReviewOutcomeMemoForTesting());
	__testing.clearNativeReviewOutcomeMemoForTesting();
	let current = "target-a";
	const tool = reviewControllerTool(assessOnNativeCli(() => current));

	// Nothing recorded for candidate A yet -> unknown, risk-gated.
	const before = (await tool.execute("call-11", { operation: "assess" }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean } };
	assert.equal(before.nativeReviewOutcome, "unknown");
	assert.equal(before.outcome_source, "unknown");
	assert.equal(before.plan.independentVerifier, true);

	// Candidate A recorded declined -> assess for A derives it.
	__testing.recordNativeReviewOutcome(ctx.cwd, "target-a", "declined");
	const forA = (await tool.execute("call-12", { operation: "assess" }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean } };
	assert.equal(forA.nativeReviewOutcome, "declined");
	assert.equal(forA.outcome_source, "derived");
	assert.equal(forA.plan.independentVerifier, true, "a derived decline re-enables the independent verifier for the matching candidate");

	// Candidate B (different current target) never inherits A's decline --
	// and since closed is never written, an acknowledged A can never leak a
	// closed derivation into B either.
	current = "target-b";
	const forB = (await tool.execute("call-13", { operation: "assess" }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean } };
	assert.equal(forB.nativeReviewOutcome, "unknown", "candidate B must never inherit candidate A's recorded outcome");
	assert.equal(forB.outcome_source, "unknown");
	assert.equal(forB.plan.independentVerifier, true);

	// Explicit input always wins, and is the only way to reach "closed".
	const closed = (await tool.execute("call-14", { operation: "assess", input: JSON.stringify({ nativeReviewOutcome: "closed" }) }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean; writerSelfVerification: boolean } };
	assert.equal(closed.nativeReviewOutcome, "closed");
	assert.equal(closed.outcome_source, "explicit");
	assert.equal(closed.plan.writerSelfVerification, true);
	assert.equal(closed.plan.independentVerifier, false, "an explicit closed outcome restores the on-path: no separate verifier");
});

test("gentle_review assess never requires a lineageId (unlike most other operations)", async () => {
	const tool = reviewControllerTool({});
	// Would throw "Review controller requires a lineageId" if ASSESS were not
	// exempted from that check.
	await assert.doesNotReject(() => tool.execute("call-7", { operation: "assess" }, undefined, undefined, ctx));
});

// ---------------------------------------------------------------------------
// Native reader (`NativeReviewCliV216.assess`, `lib/native-review-cli.ts`):
// mirrors reviewMode's wiring -- bounded subprocess, typed decode, fail closed
// on a non-zero exit or an "unknown command" older binary.
// ---------------------------------------------------------------------------

interface QueuedResult {
	stdout: string;
	stderr?: string;
	exitCode?: number;
}

function queuedAdapter(results: readonly QueuedResult[]): { adapter: ExecFileAdapter; calls: Array<{ arguments: readonly string[]; cwd: string }> } {
	const queue = [...results];
	const calls: Array<{ arguments: readonly string[]; cwd: string }> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push({ arguments: request.arguments, cwd: request.cwd });
			const result = queue.shift();
			if (result === undefined) throw new Error("unexpected native invocation");
			return { stdout: result.stdout, stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

function nativeClient(adapter: ExecFileAdapter): NativeReviewCliV216 {
	return new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024);
}

test("gentle_review assess: stderr-only refusal preserves safe actionable diagnostics and fails closed", async () => {
	const queue = queuedAdapter([{ stdout: "", stderr: "untracked scope declaration required; use --untracked-scope=exclude or select; token=hidden-secret", exitCode: 1 }]);
	const client = nativeClient(queue.adapter);
	const tool = reviewControllerTool({ assess: client.assess.bind(client) });
	const result = await tool.execute("refusal", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; reasons: { code: string; detail: string }[]; plan: { independentVerifier: boolean } };
	assert.equal(details.risk, "unassessable");
	assert.equal(details.plan.independentVerifier, true);
	assert.equal(details.reasons[0].code, NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT);
	assert.match(details.reasons[0].detail, /untracked scope declaration required/);
	assert.match(details.reasons[0].detail, /--untracked-scope=exclude/);
	assert.doesNotMatch(JSON.stringify(result), /hidden-secret/);
});

test("gentle_review assess: diagnostic projection is bounded and redacts paths and environment assignments", async () => {
	const queue = queuedAdapter([{ stdout: "", stderr: "untracked declaration required /private/project/file C:\\private\\project\\file PRIVATE_PROJECT=hidden-project token=hidden-token " + "x".repeat(6000), exitCode: 1 }]);
	const client = nativeClient(queue.adapter);
	const tool = reviewControllerTool({ assess: client.assess.bind(client) });
	const result = await tool.execute("private-refusal", { operation: "assess" }, undefined, undefined, ctx);
	const serialized = JSON.stringify(result);
	const detail = (result.details as { reasons: { detail: string }[] }).reasons[0].detail;
	assert.match(detail, /untracked declaration required/);
	assert.ok(detail.length < 4300);
	assert.doesNotMatch(serialized, /hidden-project|hidden-token|private.project|\/package\//);
});

for (const [shape, sensitive] of [
	["lowercase environment", "private_project=hidden-project"],
	["quoted environment", 'private_project="hidden project value"'],
	["credential argument", "--password hidden-credential"],
	["quoted credential argument", '--api-key "hidden credential value"'],
	["POSIX path with spaces", "/private/hidden project/hidden file.ts"],
	["quoted POSIX path", '"/private/hidden project/hidden file.ts"'],
	["Windows path with spaces", String.raw`C:\private\hidden project\hidden file.ts`],
	["quoted Windows path", String.raw`"C:\private\hidden project\hidden file.ts"`],
]) {
	test(`assess diagnostic redacts ${shape} without losing provider guidance`, async () => {
		const queue = queuedAdapter([{ stdout: "", stderr: `${sensitive}\nuntracked scope declaration required; use --untracked-scope=exclude or select`, exitCode: 1 }]);
		const client = nativeClient(queue.adapter);
		const result = await reviewControllerTool({ assess: client.assess.bind(client) }).execute("private-shape", { operation: "assess" }, undefined, undefined, ctx);
		const details = result.details as { risk: string; reasons: { code: string; detail: string }[] };
		assert.equal(details.risk, "unassessable");
		assert.equal(details.reasons[0].code, NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT);
		assert.doesNotMatch(JSON.stringify(result), /hidden|private_project| project|file\.ts|\/private\//);
		assert.match(details.reasons[0].detail, /untracked scope declaration required; use --untracked-scope=exclude or select/);
		assert.ok(details.reasons[0].detail.length < 4300);
	});
}

for (const selection of [
	{ untrackedScope: "exclude", expectedUntrackedInventory: "inventory-v1" },
	{ untrackedScope: "select", expectedUntrackedInventory: "inventory-v1", intendedUntracked: ["new/file.ts", "notes.md"] },
] as const) {
	test(`native and facade assess forward explicit ${selection.untrackedScope} without choosing scope`, async () => {
		const queue = queuedAdapter([{ stdout: JSON.stringify(validEnvelope()) }, { stdout: JSON.stringify(validEnvelope()) }]);
		const client = nativeClient(queue.adapter);
		await client.assess({ cwd: process.cwd(), ...selection });
		const tool = reviewControllerTool({ assess: client.assess.bind(client) });
		const result = await tool.execute("selected", { operation: "assess", input: JSON.stringify({ ...selection, baseRef: "origin/main", committedOnly: true }) }, undefined, undefined, ctx);
		assert.equal((result.details as { risk: string }).risk, "medium");
		const flags = [`--untracked-scope=${selection.untrackedScope}`, "--expected-untracked-inventory=inventory-v1", ...(selection.untrackedScope === "select" ? selection.intendedUntracked.map((path) => `--intended-untracked=${path}`) : [])];
		assert.deepEqual(queue.calls[0].arguments, ["review", "assess", "--cwd", process.cwd(), ...flags, "--json"]);
		assert.deepEqual(queue.calls[1].arguments, ["review", "assess", "--cwd", process.cwd(), "--base-ref", "origin/main", "--committed-only", ...flags, "--json"]);
	});
}

test("native and facade assess reject invalid declarations before launching", async () => {
	const invalid = [
		{ untrackedScope: "exclude" },
		{ expectedUntrackedInventory: "inventory" },
		{ intendedUntracked: ["file.ts"] },
		{ untrackedScope: "all", expectedUntrackedInventory: "inventory" },
		{ untrackedScope: "exclude", expectedUntrackedInventory: "inventory", intendedUntracked: ["file.ts"] },
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory" },
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: [] },
		...[null, 42, "", " inventory", "inventory\n", "inv\u0000entory"].map((expectedUntrackedInventory) => ({ untrackedScope: "exclude", expectedUntrackedInventory })),
		...["/absolute", "C:\\absolute", "dir\\file", ".", "..", "../file", "dir/../file", "dir/./file", "dir//file", "dir/", " file", "file\n"].map((path) => ({ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: [path] })),
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: ["file", "file"] },
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: "file" },
	];
	for (const selection of invalid) {
		const queue = queuedAdapter([]);
		const client = nativeClient(queue.adapter);
		await assert.rejects(() => client.assess({ cwd: process.cwd(), ...selection } as NativeReviewAssessRequest), TypeError);
		const tool = reviewControllerTool({ assess: client.assess.bind(client) });
		await assert.rejects(() => tool.execute("invalid", { operation: "assess", input: JSON.stringify(selection) }, undefined, undefined, ctx));
		assert.equal(queue.calls.length, 0);
	}
});

test("facade assess leaves absent declarations to native and preserves stale-inventory refusal", async () => {
	for (const selection of [{}, { untrackedScope: "exclude", expectedUntrackedInventory: "stale-inventory" }]) {
		const queue = queuedAdapter([{ stdout: "", stderr: "untracked inventory changed; inspect and declare the current inventory", exitCode: 1 }]);
		const client = nativeClient(queue.adapter);
		const tool = reviewControllerTool({ assess: client.assess.bind(client) });
		const result = await tool.execute("stale", { operation: "assess", input: JSON.stringify(selection) }, undefined, undefined, ctx);
		const details = result.details as { risk: string; reasons: { detail: string }[] };
		assert.equal(details.risk, "unassessable");
		assert.match(details.reasons[0].detail, /inventory changed/);
		if (!("untrackedScope" in selection)) assert.deepEqual(queue.calls[0].arguments, ["review", "assess", "--cwd", process.cwd(), "--json"]);
	}
});

test("native assess: decodes a well-formed envelope and sends the exact plain-versioned argv", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "medium", reasons: [], changed_paths: 1, changed_lines: 2, candidate: { kind: "current-changes" } }) }]);
	const result = await nativeClient(queue.adapter).assess!({ cwd: process.cwd() });
	assert.equal(result.risk, "medium");
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "assess", "--cwd", process.cwd(), "--json"]);
});

test("native assess: passes baseRef/committedOnly through as --base-ref and --committed-only", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "high", reasons: [], changed_paths: 5, changed_lines: 500, candidate: { kind: "base-diff", base_ref: "origin/main" } }) }]);
	await nativeClient(queue.adapter).assess!({ cwd: process.cwd(), baseRef: "origin/main", committedOnly: true });
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "assess", "--cwd", process.cwd(), "--base-ref", "origin/main", "--committed-only", "--json"]);
});

test("native assess: baseRef requires explicit committedOnly acknowledgement", async () => {
	const queue = queuedAdapter([]);
	await assert.rejects(() => nativeClient(queue.adapter).assess!({ cwd: process.cwd(), baseRef: "origin/main" }), TypeError);
	assert.equal(queue.calls.length, 0, "an invalid request must never reach the subprocess");
});

test("native assess: a non-zero exit (an older binary reporting an unknown command) fails closed with a native error, never a synthesized result", async () => {
	// An older binary without the `assess` verb reports its "unknown command"
	// diagnostic on stderr with nothing on stdout, or writes the same message
	// to stdout instead -- either way the wrapper rejects rather than
	// returning a synthesized envelope; the specific error code depends only
	// on which stream carried the message.
	const emptyStdout = queuedAdapter([{ stdout: "", stderr: "unknown command \"assess\" for \"gentle-ai review\"", exitCode: 1 }]);
	await assert.rejects(
		() => nativeClient(emptyStdout.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT,
	);

	const textOnStdout = queuedAdapter([{ stdout: "unknown command \"assess\" for \"gentle-ai review\"", exitCode: 1 }]);
	await assert.rejects(
		() => nativeClient(textOnStdout.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && [NATIVE_REVIEW_ERROR_CODE.MALFORMED_JSON, NATIVE_REVIEW_ERROR_CODE.NON_ZERO].includes(error.code),
	);
});

test("native assess: a wrong schema or unrecognized risk value fails closed as schema-incompatible", async () => {
	const wrongSchema = queuedAdapter([{ stdout: JSON.stringify({ schema: "gentle-ai.review-assessment/v2", risk: "medium", reasons: [], changed_paths: 0, changed_lines: 0, candidate: { kind: "current-changes" } }) }]);
	await assert.rejects(
		() => nativeClient(wrongSchema.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
	);

	const badRisk = queuedAdapter([{ stdout: JSON.stringify({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "critical", reasons: [], changed_paths: 0, changed_lines: 0, candidate: { kind: "current-changes" } }) }]);
	await assert.rejects(
		() => nativeClient(badRisk.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
	);
});
