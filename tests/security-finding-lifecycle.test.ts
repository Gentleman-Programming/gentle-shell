import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createSecurityFinding,
	type SecurityFindingRecord,
	SecurityFindingTransitionError,
	transitionSecurityFinding,
} from "../lib/security-finding-lifecycle.ts";
import type { SecurityExecutionReceipt } from "../lib/security-execution-receipt.ts";

function makeSyntheticReceipt(overrides: {
	observedOutcome?: "pass" | "fail_assertion" | "fail_setup";
	testName?: string;
	tSha?: string;
	ptSha?: string;
}): SecurityExecutionReceipt {
	const tSha = overrides.tSha ?? "a".repeat(64);
	const ptSha = overrides.ptSha ?? tSha;
	const outcome = overrides.observedOutcome ?? "fail_assertion";
	const isPass = outcome === "pass";

	return {
		id: "11111111-2222-4333-8444-555555555555",
		timestamp: new Date().toISOString(),
		runner: "node:test",
		supported: true,
		callerMetadata: {},
		targetedTest: {
			file: "/home/reaan/Contrib/gentle-shell/tests/fixtures/sec-sample.test.ts",
			testName: overrides.testName ?? "rejects unauthenticated mutation",
		},
		provenance: {
			testContentSha256: tSha,
			postTestContentSha256: ptSha,
			observedRevision: "unavailable",
		},
		processExit: {
			code: isPass ? 0 : 1,
			signal: null,
		},
		execution: {
			observedOutcome: outcome,
			eventsObserved: 2,
			truncated: false,
			failureType: isPass ? undefined : "testCodeFailure",
			assertionFailure: isPass
				? undefined
				: {
						code: "ERR_ASSERTION",
						message: "Expected 403 but got 200",
						operator: "strictEqual",
						actual: 200,
						expected: 403,
					},
		},
		verdict: {
			isAssertionRed: false,
			isGreen: false,
			failClosed: true,
			validationState: "unvalidated_capture",
		},
	};
}

describe("SecurityFindingLifecycle State Machine", () => {
	const defaultParams = {
		id: "SEC-001",
		cwe: "CWE-284",
		severity: "MEDIUM" as const,
		claim: "Endpoint allows unauthorized modification of user profile",
		targetLocation: "lib/api/profile.ts:45",
		targetedTest: {
			file: "/home/reaan/Contrib/gentle-shell/tests/fixtures/sec-sample.test.ts",
			testName: "rejects unauthenticated mutation",
		},
		analystIdentity: "analyst-agent-1",
	};

	it("creates a finding in initial 'hypothesis' state", () => {
		const finding = createSecurityFinding(defaultParams);
		assert.equal(finding.state, "hypothesis");
		assert.equal(finding.id, "SEC-001");
		assert.equal(finding.severity, "MEDIUM");
		assert.equal(finding.history.length, 1);
		assert.equal(finding.history[0]?.toState, "hypothesis");
	});

	it("transitions from hypothesis to refuted (terminal)", () => {
		const finding = createSecurityFinding(defaultParams);
		const updated = transitionSecurityFinding(finding, {
			toState: "refuted",
			evidence: {
				kind: "refutation",
				reason: "Auth middleware verified at route declaration",
				controlsInspected: ["lib/middleware/auth.ts"],
			},
			actor: "security-analyst",
		});
		assert.equal(updated.state, "refuted");
		assert.equal(updated.history.length, 2);

		assert.throws(
			() =>
				transitionSecurityFinding(updated, {
					toState: "verified",
					evidence: {
						kind: "verification",
						receipt: makeSyntheticReceipt({}),
					},
				}),
			SecurityFindingTransitionError,
		);
	});

	it("transitions from hypothesis to advisory (terminal)", () => {
		const finding = createSecurityFinding(defaultParams);
		const updated = transitionSecurityFinding(finding, {
			toState: "advisory",
			evidence: {
				kind: "advisory",
				reason: "Static design flaw without direct exploitability",
				architecturalRisk: "Lack of rate limiting on sensitive route",
			},
		});
		assert.equal(updated.state, "advisory");

		assert.throws(
			() =>
				transitionSecurityFinding(updated, {
					toState: "remediated",
					evidence: {
						kind: "remediation",
						receipt: makeSyntheticReceipt({ observedOutcome: "pass" }),
					},
				}),
			SecurityFindingTransitionError,
		);
	});

	it("transitions from hypothesis to verified with valid RED receipt", () => {
		const finding = createSecurityFinding(defaultParams);
		const receipt = makeSyntheticReceipt({
			observedOutcome: "fail_assertion",
			failureType: "testCodeFailure",
			code: "ERR_ASSERTION",
		});
		const verified = transitionSecurityFinding(finding, {
			toState: "verified",
			evidence: {
				kind: "verification",
				receipt,
			},
		});
		assert.equal(verified.state, "verified");
	});

	it("requires independent confirmation for HIGH and CRITICAL findings when transitioning to verified", () => {
		const highFinding = createSecurityFinding({
			...defaultParams,
			severity: "HIGH",
		});
		const receipt = makeSyntheticReceipt({});

		// Missing independent confirmation -> fails
		assert.throws(
			() =>
				transitionSecurityFinding(highFinding, {
					toState: "verified",
					evidence: {
						kind: "verification",
						receipt,
					},
				}),
			(err: any) =>
				err instanceof SecurityFindingTransitionError &&
				err.message.includes("Independent confirmation required"),
		);

		// Confirmation by the same analyst -> fails
		assert.throws(
			() =>
				transitionSecurityFinding(highFinding, {
					toState: "verified",
					evidence: {
						kind: "verification",
						receipt,
						independentConfirmation: {
							confirmedBy: "analyst-agent-1",
							verifierRole: "verifier",
							timestamp: new Date().toISOString(),
						},
					},
				}),
			(err: any) =>
				err instanceof SecurityFindingTransitionError &&
				err.message.includes("cannot independently confirm own finding"),
		);

		// Valid independent confirmation by different verifier -> succeeds
		const verified = transitionSecurityFinding(highFinding, {
			toState: "verified",
			evidence: {
				kind: "verification",
				receipt,
				independentConfirmation: {
					confirmedBy: "independent-verifier-2",
					verifierRole: "verifier",
					timestamp: new Date().toISOString(),
				},
			},
		});
		assert.equal(verified.state, "verified");
	});

	it("rejects non-assertion failures, setup failures, and harness errors for verified transition", () => {
		const finding = createSecurityFinding(defaultParams);

		// Setup failure
		assert.throws(
			() =>
				transitionSecurityFinding(finding, {
					toState: "verified",
					evidence: {
						kind: "verification",
						receipt: makeSyntheticReceipt({ observedOutcome: "fail_setup" }),
					},
				}),
			SecurityFindingTransitionError,
		);

		// Drifted test hash
		assert.throws(
			() =>
				transitionSecurityFinding(finding, {
					toState: "verified",
					evidence: {
						kind: "verification",
						receipt: makeSyntheticReceipt({
							tSha: "a".repeat(64),
							ptSha: "b".repeat(64),
						}),
					},
				}),
			SecurityFindingTransitionError,
		);

		// Mismatched test name or file
		assert.throws(
			() =>
				transitionSecurityFinding(finding, {
					toState: "verified",
					evidence: {
						kind: "verification",
						receipt: makeSyntheticReceipt({ testName: "other test" }),
					},
				}),
			SecurityFindingTransitionError,
		);
	});

	it("transitions through full lifecycle: hypothesis -> verified -> remediated -> locked", () => {
		const finding = createSecurityFinding(defaultParams);

		// 1. Hypothesis -> Verified
		const verified = transitionSecurityFinding(finding, {
			toState: "verified",
			evidence: {
				kind: "verification",
				receipt: makeSyntheticReceipt({ observedOutcome: "fail_assertion" }),
			},
		});
		assert.equal(verified.state, "verified");

		// 2. Verified -> Remediated (with GREEN receipt)
		const remediated = transitionSecurityFinding(verified, {
			toState: "remediated",
			evidence: {
				kind: "remediation",
				receipt: makeSyntheticReceipt({
					observedOutcome: "pass",
					exitCode: 0,
				}),
			},
		});
		assert.equal(remediated.state, "remediated");

		// 3. Remediated -> Locked (with isolated mutation RED receipt)
		const locked = transitionSecurityFinding(remediated, {
			toState: "locked",
			evidence: {
				kind: "lock",
				mutationReceipt: makeSyntheticReceipt({
					observedOutcome: "fail_assertion",
				}),
				mutationDescription: "Reverted defense patch to ensure test fails",
			},
		});
		assert.equal(locked.state, "locked");

		// Terminal: cannot transition out of locked
		assert.throws(
			() =>
				transitionSecurityFinding(locked, {
					toState: "hypothesis",
					evidence: {
						kind: "refutation",
						reason: "Attempted revert",
						controlsInspected: [],
					},
				}),
			SecurityFindingTransitionError,
		);
	});

	it("rejects illegal skip/backward transitions", () => {
		const finding = createSecurityFinding(defaultParams);

		// Cannot jump hypothesis -> remediated
		assert.throws(
			() =>
				transitionSecurityFinding(finding, {
					toState: "remediated",
					evidence: {
						kind: "remediation",
						receipt: makeSyntheticReceipt({ observedOutcome: "pass" }),
					},
				}),
			SecurityFindingTransitionError,
		);

		// Cannot jump hypothesis -> locked
		assert.throws(
			() =>
				transitionSecurityFinding(finding, {
					toState: "locked",
					evidence: {
						kind: "lock",
						mutationReceipt: makeSyntheticReceipt({}),
						mutationDescription: "Jump",
					},
				}),
			SecurityFindingTransitionError,
		);
	});
});
