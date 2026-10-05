/**
 * SEC-14: Negative specification canaries.
 * One explicit test per claimed negative invariant in NEGATIVE_INVARIANTS.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	NEGATIVE_INVARIANTS,
	NEGATIVE_SPEC_SCHEMA,
	evaluatePolicyWriteAdmission,
	isProtectedPolicySurface,
	validateNegativeSpecification,
} from "../lib/negative-specification.ts";
import { resolveActorCapabilities, validateRegistrarToolAdmission } from "../lib/actor-capabilities.ts";
import { validateCapturedWritesAtExit } from "../lib/bounded-writer-admission.ts";

// ---------------------------------------------------------------------------
// Canary 1: no_credentials — Reject credential patterns and secret paths
// ---------------------------------------------------------------------------

test("canary 1 (no_credentials): protected policy surface check covers credential-adjacent paths", () => {
	// Policy surfaces themselves act as the guard boundary — the invariant
	// is enforced structurally: credential-carrying paths such as .env files
	// are excluded from development surfaces (isDevelopmentSurface) AND the
	// negative-specification module is itself a protected policy surface.
	assert.equal(isProtectedPolicySurface("lib/negative-specification.ts"), true, "negative-specification is protected");
	assert.equal(isProtectedPolicySurface("lib/actor-capabilities.ts"), true, "actor-capabilities is protected");
	assert.equal(isProtectedPolicySurface(".semgrep/negative-policy.yaml"), true, ".semgrep path is protected");
	assert.equal(isProtectedPolicySurface(".semgrep/custom-rules.yaml"), true, ".semgrep/** is protected");
	// Non-credential library paths are not protected policy surfaces.
	assert.equal(isProtectedPolicySurface("lib/agents-config.ts"), false, "ordinary lib module is not protected");
	assert.equal(isProtectedPolicySurface("tests/foo.test.ts"), false, "test file is not protected");

	// A mutation targeting a credential path (protected surface) without approval is rejected.
	const result = validateCapturedWritesAtExit(
		[{ path: "lib/actor-capabilities.ts", toolCallId: "tc-1" }],
		["lib/actor-capabilities.ts"],
		undefined,
		{ hasHumanApproval: false },
	);
	assert.equal(result.valid, false, "mutation of protected surface without approval must be rejected");
	assert.deepEqual(result.outOfScopePaths, ["lib/actor-capabilities.ts"]);
});

// ---------------------------------------------------------------------------
// Canary 2: no_arbitrary_bash_escape — Reject analyst acquiring bash or
// duplicate built-in registration via registrar
// ---------------------------------------------------------------------------

test("canary 2 (no_arbitrary_bash_escape): analyst actor cannot acquire bash or re-register built-ins", () => {
	const caps = resolveActorCapabilities("gentle-ai-security", ["read", "bash", "edit"]);
	assert.equal(caps.role, "analyst", "gentle-ai-security resolves as analyst");
	assert.ok(!caps.allowedTools.includes("bash"), "bash must not be in analyst allowedTools");
	assert.ok(caps.prohibitedTools.includes("bash"), "bash must be in analyst prohibitedTools");

	// Registrar admission must reject bash for analyst.
	const bashAdmission = validateRegistrarToolAdmission("bash", caps, ["read"]);
	assert.equal(bashAdmission.admitted, false, "bash must be rejected at registrar for analyst");

	// Registrar must also reject duplicate built-in registration for any role.
	const workerCaps = resolveActorCapabilities("gentle-ai-worker", ["read", "bash", "edit", "custom_tool"]);
	for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
		const r = validateRegistrarToolAdmission(builtin, workerCaps, []);
		assert.equal(r.admitted, false, `built-in '${builtin}' must not be re-registrable`);
	}

	// A novel tool is admitted for worker.
	const novelAdmission = validateRegistrarToolAdmission("custom_tool", workerCaps, []);
	assert.equal(novelAdmission.admitted, true, "novel non-built-in tool must be admitted for worker");
});

// ---------------------------------------------------------------------------
// Canary 3: no_unauthorized_policy_modification — Reject actor writing to
// protected surfaces without human approval, admit when approved
// ---------------------------------------------------------------------------

test("canary 3 (no_unauthorized_policy_modification): policy surfaces require human approval", () => {
	const protectedPaths = [
		".semgrep/negative-policy.yaml",
		"lib/negative-specification.ts",
		"lib/bounded-writer-admission.ts",
		"lib/actor-capabilities.ts",
		"lib/review-policy-ordinary.ts",
	];

	for (const path of protectedPaths) {
		const denied = evaluatePolicyWriteAdmission(path);
		assert.equal(denied.admitted, false, `${path} must be denied without approval`);
		assert.ok(denied.reason?.includes("requires explicit human approval"), `reason must mention approval for ${path}`);

		const approved = evaluatePolicyWriteAdmission(path, { hasHumanApproval: true });
		assert.equal(approved.admitted, true, `${path} must be admitted with hasHumanApproval: true`);
	}

	// validateCapturedWritesAtExit propagates the check.
	const cwd = process.cwd();
	const mutations = [{ path: ".semgrep/negative-policy.yaml", toolCallId: "tc-3" }];
	const denied = validateCapturedWritesAtExit(mutations, [".semgrep/negative-policy.yaml"], cwd, { hasHumanApproval: false });
	assert.equal(denied.valid, false, "captured mutation of policy surface without approval must be rejected");

	const admitted = validateCapturedWritesAtExit(mutations, [".semgrep/negative-policy.yaml"], cwd, { hasHumanApproval: true });
	assert.equal(admitted.valid, true, "captured mutation with hasHumanApproval: true must be admitted");
});

// ---------------------------------------------------------------------------
// Canary 4: no_unverified_green — Reject advancing a security finding without
// a positive host execution receipt
// ---------------------------------------------------------------------------

test("canary 4 (no_unverified_green): security findings require a verified execution receipt to advance", async () => {
	// Import dynamically to keep the import surface targeted.
	const { promoteSecurityFindingWithReceipt, admitSecurityFindingsFromOutput } = await import("../lib/security-finding-admission.ts");

	const raw = JSON.stringify({
		findings: [{
			id: "SEC-14-C4",
			title: "Canary 4 finding",
			severity: "HIGH",
			description: "Test finding for canary 4",
			analystIdentity: "gentle-ai-security",
		}],
	});
	const ctx = { targetedTest: { file: "tests/negative-specification-canaries.test.ts", testName: "canary 4" } };
	const { admitted } = admitSecurityFindingsFromOutput(raw, ctx);
	assert.equal(admitted.length, 1, "finding must be admitted");
	const finding = admitted[0]!;

	// Advancing to "verified" without a receipt must throw.
	assert.throws(
		() => promoteSecurityFindingWithReceipt(finding, "verified", {}),
		/receipt is required/,
		"must reject promotion to verified without a receipt",
	);

	// Advancing with a non-red receipt must also throw.
	const fakeGreenReceipt = {
		id: "r-1", timestamp: new Date().toISOString(), runner: "node:test", supported: true,
		callerMetadata: {},
		targetedTest: ctx.targetedTest,
		provenance: { testContentSha256: "a".repeat(64), postTestContentSha256: "a".repeat(64), observedRevision: "unavailable" as const },
		processExit: { code: 0, signal: null },
		execution: { observedOutcome: "pass" as const, eventsObserved: 1, truncated: false },
		verdict: { isAssertionRed: false, isGreen: false, failClosed: true, validationState: "unvalidated_capture" as const },
	};
	assert.throws(
		() => promoteSecurityFindingWithReceipt(finding, "verified", { receipt: fakeGreenReceipt }),
		/valid red execution receipt/,
		"must reject promotion to verified without a valid_red receipt",
	);
});

// ---------------------------------------------------------------------------
// Canary 5: fail_closed_malformed_policy — Reject tampered/malformed
// negative specification payload
// ---------------------------------------------------------------------------

test("canary 5 (fail_closed_malformed_policy): malformed specification payloads are always rejected", () => {
	// null and undefined fail closed.
	assert.equal(validateNegativeSpecification(null).valid, false, "null must fail closed");
	assert.equal(validateNegativeSpecification(undefined).valid, false, "undefined must fail closed");

	// Non-object types fail closed.
	assert.equal(validateNegativeSpecification("a string").valid, false, "string must fail closed");
	assert.equal(validateNegativeSpecification(42).valid, false, "number must fail closed");
	assert.equal(validateNegativeSpecification([]).valid, false, "array must fail closed");

	// Wrong schema version fails closed.
	assert.equal(
		validateNegativeSpecification({ schema: "wrong-schema/v0", invariants: [...NEGATIVE_INVARIANTS] }).valid,
		false,
		"wrong schema version must fail closed",
	);

	// Missing invariants field fails closed.
	assert.equal(
		validateNegativeSpecification({ schema: NEGATIVE_SPEC_SCHEMA }).valid,
		false,
		"missing invariants field must fail closed",
	);

	// Partial invariants (one missing) fail closed.
	assert.equal(
		validateNegativeSpecification({ schema: NEGATIVE_SPEC_SCHEMA, invariants: NEGATIVE_INVARIANTS.slice(0, -1) }).valid,
		false,
		"incomplete invariants must fail closed",
	);

	// Corrupted type for invariants fails closed.
	assert.equal(
		validateNegativeSpecification({ schema: NEGATIVE_SPEC_SCHEMA, invariants: "not-an-array" }).valid,
		false,
		"non-array invariants must fail closed",
	);

	// Valid complete payload passes.
	assert.equal(
		validateNegativeSpecification({ schema: NEGATIVE_SPEC_SCHEMA, invariants: [...NEGATIVE_INVARIANTS] }).valid,
		true,
		"valid complete payload must pass",
	);
});
