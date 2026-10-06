import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	admitSecurityFindingsFromOutput,
	type AdmissionContext,
	promoteSecurityFindingWithReceipt,
} from "../lib/security-finding-admission.ts";
import type { SecurityFindingRecord } from "../lib/security-finding-lifecycle.ts";
import type { SecurityExecutionReceipt } from "../lib/security-execution-receipt.ts";

const TEST_FILE = "/home/reaan/Contrib/gentle-shell/tests/fixtures/sec-sample.test.ts";
const TEST_NAME = "rejects unauthenticated mutation";
const GOOD_SHA = "a".repeat(64);

function makeRedReceipt(overrides: { testName?: string; ptSha?: string } = {}): SecurityExecutionReceipt {
	return {
		id: "11111111-2222-4333-8444-555555555555", timestamp: new Date().toISOString(),
		runner: "node:test", supported: true, callerMetadata: {},
		targetedTest: { file: TEST_FILE, testName: overrides.testName ?? TEST_NAME },
		provenance: { testContentSha256: GOOD_SHA, postTestContentSha256: overrides.ptSha ?? GOOD_SHA, observedRevision: "unavailable" },
		processExit: { code: 1, signal: null },
		execution: { observedOutcome: "fail_assertion", eventsObserved: 2, truncated: false, failureType: "testCodeFailure", assertionFailure: { code: "ERR_ASSERTION", message: "Expected 403 got 200", operator: "strictEqual", actual: 200, expected: 403 } },
		verdict: { isAssertionRed: false, isGreen: false, failClosed: true, validationState: "unvalidated_capture" },
	};
}

function makeGreenReceipt(): SecurityExecutionReceipt {
	return {
		id: "22222222-3333-4444-9555-666666666666", timestamp: new Date().toISOString(),
		runner: "node:test", supported: true, callerMetadata: {},
		targetedTest: { file: TEST_FILE, testName: TEST_NAME },
		provenance: { testContentSha256: GOOD_SHA, postTestContentSha256: GOOD_SHA, observedRevision: "unavailable" },
		processExit: { code: 0, signal: null },
		execution: { observedOutcome: "pass", eventsObserved: 2, truncated: false },
		verdict: { isAssertionRed: false, isGreen: false, failClosed: true, validationState: "unvalidated_capture" },
	};
}

const CTX: AdmissionContext = { targetedTest: { file: TEST_FILE, testName: TEST_NAME } };

function findingJson(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({ findings: [{ id: "SEC-001", cwe: "CWE-284", severity: "MEDIUM", title: "Profile mutation without auth", category: "authorization", description: "Endpoint allows unauthenticated mutation", analystIdentity: "gentle-ai-security", ...overrides }] });
}

function admitOne(overrides: Record<string, unknown> = {}): SecurityFindingRecord {
	const r = admitSecurityFindingsFromOutput(findingJson(overrides), CTX);
	const rec = r.admitted[0];
	if (!rec) throw new Error("Precondition: expected an admitted finding");
	return rec;
}

// ---------------------------------------------------------------------------
// parsing and hypothesis minting
// ---------------------------------------------------------------------------
describe("admitSecurityFindingsFromOutput — parsing and hypothesis minting", () => {
	it("admits valid JSON finding as hypothesis state with correct fields", () => {
		const result = admitSecurityFindingsFromOutput(findingJson(), CTX);
		assert.equal(result.admitted.length, 1);
		assert.equal(result.rejected.length, 0);
		const rec = result.admitted[0] as SecurityFindingRecord;
		assert.equal(rec.state, "hypothesis");
		assert.equal(rec.id, "SEC-001");
		assert.equal(rec.severity, "MEDIUM");
		assert.equal(rec.cwe, "CWE-284");
		assert.equal(rec.analystIdentity, "gentle-ai-security");
		assert.equal(rec.targetedTest.file, TEST_FILE);
		assert.equal(rec.targetedTest.testName, TEST_NAME);
	});

	it("admits finding extracted from fenced JSON code block in analyst narrative", () => {
		const fenced = `Analysis text.\n\`\`\`json\n${findingJson()}\n\`\`\`\nTrailing notes.`;
		const result = admitSecurityFindingsFromOutput(fenced, CTX);
		assert.equal(result.admitted.length, 1);
		assert.equal(result.admitted[0]?.state, "hypothesis");
	});

	it("admits multiple findings from one output, all as hypothesis", () => {
		const multi = JSON.stringify({ findings: [
			{ id: "SEC-002", cwe: "CWE-89", severity: "CRITICAL", title: "SQLi", category: "injection", description: "d1", analystIdentity: "a" },
			{ id: "SEC-003", cwe: "CWE-22", severity: "LOW",      title: "Path traversal", category: "path-traversal", description: "d2", analystIdentity: "a" },
		] });
		const result = admitSecurityFindingsFromOutput(multi, CTX);
		assert.equal(result.admitted.length, 2);
		for (const rec of result.admitted) assert.equal(rec.state, "hypothesis");
	});
});

// ---------------------------------------------------------------------------
// rejection of invalid output
// ---------------------------------------------------------------------------
describe("admitSecurityFindingsFromOutput — rejection of invalid output", () => {
	it("rejects completely unparseable plain text with no JSON", () => {
		const result = admitSecurityFindingsFromOutput("plain prose, no structured data", CTX);
		assert.equal(result.admitted.length, 0);
		assert.ok(result.rejected.length > 0 || result.parseError !== undefined);
	});

	it("rejects JSON object missing the findings array", () => {
		const result = admitSecurityFindingsFromOutput(JSON.stringify({ summary: "no findings key" }), CTX);
		assert.equal(result.admitted.length, 0);
	});

	for (const missingField of ["id", "title", "severity", "description", "analystIdentity"] as const) {
		it(`rejects finding missing required field: ${missingField}`, () => {
			const base: Record<string, unknown> = { id: "SEC-X", cwe: "CWE-284", severity: "MEDIUM", title: "T", category: "c", description: "d", analystIdentity: "a" };
			delete base[missingField];
			const result = admitSecurityFindingsFromOutput(JSON.stringify({ findings: [base] }), CTX);
			assert.equal(result.admitted.length, 0);
			assert.equal(result.rejected.length, 1);
		});
	}

	it("rejects finding with an invalid severity value", () => {
		const result = admitSecurityFindingsFromOutput(findingJson({ severity: "EXTREME" }), CTX);
		assert.equal(result.admitted.length, 0);
		assert.equal(result.rejected.length, 1);
	});

	it("partially admits valid findings and rejects invalid ones in the same output", () => {
		const mixed = JSON.stringify({ findings: [
			{ id: "SEC-GOOD", cwe: "CWE-89", severity: "HIGH", title: "Valid", category: "injection", description: "d", analystIdentity: "a" },
			{ cwe: "CWE-22", severity: "LOW", description: "No id or title", analystIdentity: "a" },
		] });
		const result = admitSecurityFindingsFromOutput(mixed, CTX);
		assert.equal(result.admitted.length, 1);
		assert.equal(result.rejected.length, 1);
		assert.equal(result.admitted[0]?.state, "hypothesis");
	});
});

// ---------------------------------------------------------------------------
// state bypass prevention
// ---------------------------------------------------------------------------
describe("admitSecurityFindingsFromOutput — prevents pre-verified state bypass", () => {
	for (const claimedState of ["verified", "remediated", "locked"] as const) {
		it(`refusing to mint a finding claiming '${claimedState}' — must be hypothesis or rejected`, () => {
			const result = admitSecurityFindingsFromOutput(findingJson({ state: claimedState }), CTX);
			if (result.admitted.length > 0) {
				assert.equal(result.admitted[0]?.state, "hypothesis", `Finding claiming '${claimedState}' must be force-downgraded to 'hypothesis'`);
			} else {
				assert.equal(result.rejected.length, 1, `Finding claiming '${claimedState}' must be rejected if not force-downgraded`);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// hypothesis to verified
// ---------------------------------------------------------------------------
describe("promoteSecurityFindingWithReceipt — hypothesis to verified", () => {
	it("promotes MEDIUM finding to verified with valid RED receipt", () => {
		const rec = admitOne();
		const updated = promoteSecurityFindingWithReceipt(rec, "verified", { receipt: makeRedReceipt() });
		assert.equal(updated.state, "verified");
		assert.equal(updated.history.length, rec.history.length + 1);
	});

	it("promotes HIGH finding to verified with valid RED receipt and independent confirmation", () => {
		const rec = admitOne({ severity: "HIGH" });
		const updated = promoteSecurityFindingWithReceipt(rec, "verified", {
			receipt: makeRedReceipt(),
			independentConfirmation: { confirmedBy: "verifier-2", verifierRole: "verifier", timestamp: new Date().toISOString() },
		});
		assert.equal(updated.state, "verified");
	});

	it("rejects promotion when receipt is valid_green (not valid_red)", () => {
		const rec = admitOne();
		assert.throws(() => promoteSecurityFindingWithReceipt(rec, "verified", { receipt: makeGreenReceipt() }),
			(err: unknown) => err instanceof Error && err.message.toLowerCase().includes("red"));
	});

	it("rejects promotion when receipt has setup failure (invalid receipt)", () => {
		const rec = admitOne();
		const bad: SecurityExecutionReceipt = { ...makeRedReceipt(), execution: { observedOutcome: "fail_setup", eventsObserved: 1, truncated: false, failureType: "testContextFailure", failureReason: "Cannot find module" } };
		assert.throws(() => promoteSecurityFindingWithReceipt(rec, "verified", { receipt: bad }), Error);
	});

	it("rejects promotion when receipt targets a different test (target mismatch)", () => {
		const rec = admitOne();
		assert.throws(() => promoteSecurityFindingWithReceipt(rec, "verified", { receipt: makeRedReceipt({ testName: "different test" }) }),
			(err: unknown) => err instanceof Error && err.message.toLowerCase().includes("mismatch"));
	});

	it("rejects promotion of HIGH finding when independent confirmation is absent", () => {
		const rec = admitOne({ severity: "HIGH" });
		assert.throws(() => promoteSecurityFindingWithReceipt(rec, "verified", { receipt: makeRedReceipt() }),
			(err: unknown) => err instanceof Error && err.message.toLowerCase().includes("independent confirmation"));
	});

	it("rejects promotion of HIGH finding when same analyst self-confirms", () => {
		const rec = admitOne({ severity: "HIGH" });
		assert.throws(() => promoteSecurityFindingWithReceipt(rec, "verified", {
			receipt: makeRedReceipt(),
			independentConfirmation: { confirmedBy: "gentle-ai-security", verifierRole: "verifier", timestamp: new Date().toISOString() },
		}), (err: unknown) => err instanceof Error && (err.message.toLowerCase().includes("own finding") || err.message.toLowerCase().includes("cannot independently confirm") || err.message.toLowerCase().includes("self")));
	});

	it("rejects promotion when receipt content hash has drifted", () => {
		const rec = admitOne();
		assert.throws(() => promoteSecurityFindingWithReceipt(rec, "verified", { receipt: makeRedReceipt({ ptSha: "b".repeat(64) }) }), Error);
	});
});

// ---------------------------------------------------------------------------
// verified to remediated
// ---------------------------------------------------------------------------
describe("promoteSecurityFindingWithReceipt — verified to remediated", () => {
	function makeVerified(): SecurityFindingRecord {
		return promoteSecurityFindingWithReceipt(admitOne({ id: "SEC-P02", severity: "MEDIUM" }), "verified", { receipt: makeRedReceipt() });
	}

	it("promotes verified finding to remediated with valid GREEN receipt", () => {
		const verified = makeVerified();
		const remediated = promoteSecurityFindingWithReceipt(verified, "remediated", { receipt: makeGreenReceipt() });
		assert.equal(remediated.state, "remediated");
		assert.equal(remediated.history.length, verified.history.length + 1);
	});

	it("rejects remediation when receipt is valid_red (not valid_green)", () => {
		const verified = makeVerified();
		assert.throws(() => promoteSecurityFindingWithReceipt(verified, "remediated", { receipt: makeRedReceipt() }),
			(err: unknown) => err instanceof Error && err.message.toLowerCase().includes("green"));
	});

	it("rejects illegal jump from verified to locked (must pass through remediated)", () => {
		assert.throws(() => promoteSecurityFindingWithReceipt(makeVerified(), "locked", { mutationReceipt: makeRedReceipt(), mutationDescription: "jump" }), Error);
	});
});

// ---------------------------------------------------------------------------
// remediated to locked
// ---------------------------------------------------------------------------
describe("promoteSecurityFindingWithReceipt — remediated to locked", () => {
	function makeRemediated(): SecurityFindingRecord {
		const rec = admitOne({ id: "SEC-P03", severity: "LOW" });
		const verified = promoteSecurityFindingWithReceipt(rec, "verified", { receipt: makeRedReceipt() });
		return promoteSecurityFindingWithReceipt(verified, "remediated", { receipt: makeGreenReceipt() });
	}

	it("promotes remediated finding to locked with valid isolated mutation RED receipt", () => {
		const remediated = makeRemediated();
		const locked = promoteSecurityFindingWithReceipt(remediated, "locked", { mutationReceipt: makeRedReceipt(), mutationDescription: "Reverted defense patch" });
		assert.equal(locked.state, "locked");
		assert.equal(locked.history.length, remediated.history.length + 1);
	});

	it("rejects lock promotion when mutation receipt is valid_green", () => {
		assert.throws(() => promoteSecurityFindingWithReceipt(makeRemediated(), "locked", { mutationReceipt: makeGreenReceipt(), mutationDescription: "Should fail" }), Error);
	});

	it("cannot transition from locked state (terminal)", () => {
		const locked = promoteSecurityFindingWithReceipt(makeRemediated(), "locked", { mutationReceipt: makeRedReceipt(), mutationDescription: "Reverted defense" });
		assert.equal(locked.state, "locked");
		assert.throws(() => promoteSecurityFindingWithReceipt(locked, "verified", { receipt: makeRedReceipt() }), Error);
	});
});
