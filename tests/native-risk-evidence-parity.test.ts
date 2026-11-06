import assert from "node:assert/strict";
import test from "node:test";
import { nativeRiskEvidencePhrases } from "../lib/native-review-cli.ts";

// gentle-ai's negotiated `start/v2` envelope is a closed schema, so it cannot
// carry the `risk_evidence` phrases its plain sibling emits. Pi renders them
// from `risk_reasons`, which start/v2 does carry, and that makes Pi a second
// surface for a vocabulary whose Go home (internal/cli/review_mode.go) is
// documented as the single phrasing source precisely so surfaces cannot drift.
//
// These cases are field truth, not hand-written expectations: each pair was
// captured from the real gentle-ai v2.2.0 binary run twice over one candidate,
// once plain for `risk_evidence` and once negotiated for `risk_reasons`. If a
// future gentle-ai changes a phrase, this fails instead of Pi quietly showing
// an operator a sentence the CLI stopped saying.
const FIELD_CAPTURED_V220 = [
	{
		name: "hot path, auth signal",
		riskLevel: "high",
		riskReasons: [{ code: "hot_path", signal: "auth", path: "auth/login.go" }],
		riskEvidence: ["authentication in auth/login.go"],
	},
	{
		name: "hot path, payments signal",
		riskLevel: "high",
		riskReasons: [{ code: "hot_path", signal: "payments", path: "billing/payments.go" }],
		riskEvidence: ["payments in billing/payments.go"],
	},
	{
		name: "medium risk leads with the consolidated-review reason",
		riskLevel: "medium",
		riskReasons: [{ code: "configuration_change", path: "config.yaml" }],
		riskEvidence: [
			"this change is not purely passive documentation, so it gets one consolidated review.",
			"a configuration change in config.yaml",
		],
	},
	{
		name: "multiple reasons keep native order",
		riskLevel: "high",
		riskReasons: [
			{ code: "executable_mode", signal: "permissions", path: "run.sh", old_mode: "000000", new_mode: "100755" },
			{ code: "process_boundary", signal: "shell_process", path: "run.sh" },
			{ code: "shell_source", signal: "shell_process", path: "run.sh" },
		],
		riskEvidence: [
			"an executable permission change in run.sh",
			"code that starts other processes in run.sh",
			"shell scripting in run.sh",
		],
	},
] as const;

for (const scenario of FIELD_CAPTURED_V220) {
	test(`derived risk evidence matches native v2.2.0: ${scenario.name}`, () => {
		assert.deepEqual(
			nativeRiskEvidencePhrases(scenario.riskLevel, scenario.riskReasons as unknown as Record<string, unknown>[]),
			scenario.riskEvidence,
		);
	});
}

test("low risk speaks no evidence at all", () => {
	assert.deepEqual(nativeRiskEvidencePhrases("low", [{ code: "hot_path", signal: "auth", path: "a.go" }]), []);
});

test("an unrecognized reason code renders nothing rather than guessing", () => {
	// Degrading to silence keeps Pi from inventing a phrase for a reason a
	// newer gentle-ai understands and this mirror does not.
	assert.deepEqual(nativeRiskEvidencePhrases("high", [{ code: "reason_from_a_newer_cli", path: "x.go" }]), []);
});

test("an unrecognized hot-path signal still names the path", () => {
	// The Go signal switch has no silent default: it degrades to a generic
	// subject so the operator still learns which file drove the tier.
	assert.deepEqual(
		nativeRiskEvidencePhrases("high", [{ code: "hot_path", signal: "signal_from_a_newer_cli", path: "x.go" }]),
		["a sensitive area in x.go"],
	);
});

test("an empty file is named before it is described", () => {
	assert.deepEqual(
		nativeRiskEvidencePhrases("high", [{ code: "empty_content", path: "blank.txt" }]),
		["blank.txt, an empty file whose type cannot be determined from its content"],
	);
});

test("a reason with no path contributes no phrase", () => {
	assert.deepEqual(nativeRiskEvidencePhrases("high", [{ code: "empty_content" }]), []);
});

// Field truth from gentle-ai main (4.1.0-dev): one committed high-risk
// candidate's consent/v3 `risk_evidence` beside its START/v4 `risk_reasons`.
test("dangerous sink and agent escalation reasons render the gentle-ai phrases", () => {
	assert.deepEqual(
		nativeRiskEvidencePhrases("high", [
			{ code: "dangerous_sink", signal: "dangerous_sink", path: "auth/session.py" },
			{ code: "hot_path", signal: "auth", path: "auth/session.py" },
			{ code: "process_boundary", signal: "shell_process", path: "auth/session.py" },
		]),
		[
			"a dangerous code pattern in auth/session.py",
			"authentication in auth/session.py",
			"code that starts other processes in auth/session.py",
		],
	);
	assert.deepEqual(
		nativeRiskEvidencePhrases("high", [{ code: "agent_escalation", signal: "agent_escalation" }]),
		["the agent that made this change flagged it as high risk"],
	);
});
