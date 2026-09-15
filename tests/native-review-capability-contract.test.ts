import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_CLI_CONTRACTS } from "../lib/native-review-cli.ts";

// Organic RDD parity: the four organic-parity capability columns exist on every
// shipped NATIVE_CLI_CONTRACTS row. Every row through the pinned "2.1.11"
// reports them false. "2.2.0" is the first capability-true row and it lights
// only what was demonstrated to reach a negotiated consumer, per Design
// Decision #1 ("Future row policy").
//
// A row describes what the NATIVE CLI puts on the wire, never what Pi manages
// to show. `riskEvidence` and `hint` stay false on 2.2.0 even though a Pi
// operator now sees both, because Pi derives them from `risk_reasons` and
// `changed_files` rather than receiving them: the closed `start/v2` schema
// omits the fields. Lighting the row would tell a future reader the envelope
// carries something it does not.

const ORGANIC_PARITY_CAPABILITIES = ["mode", "riskEvidence", "hint", "delivery"] as const;
const DARK_VERSIONS = ["2.1.4", "2.1.5", "2.1.6", "2.1.7", "2.1.8", "2.1.9", "2.1.10", "2.1.11"] as const;

test("every row through the pinned 2.1.11 reports the organic-parity capability columns false", () => {
	for (const version of DARK_VERSIONS) {
		const contract = NATIVE_CLI_CONTRACTS[version] as Record<string, boolean>;
		for (const capability of ORGANIC_PARITY_CAPABILITIES) {
			assert.equal(
				Object.hasOwn(contract, capability) ? contract[capability] : false,
				false,
				`${version}.${capability} must be false or absent`,
			);
		}
	}
});

test("the 2.1.11 row explicitly reports all four organic-parity capabilities false", () => {
	const contract = NATIVE_CLI_CONTRACTS["2.1.11"] as Record<string, boolean>;
	assert.equal(contract.mode, false);
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.equal(contract.delivery, false);
});

test("2.2.0 lights only the two capabilities its negotiated envelope demonstrably carries", () => {
	// Ground-truthed against the released v2.2.0 binary: the kill switch and
	// delivery disposition reach the negotiated path, while `risk_evidence` and
	// `hint` appear only in the plain envelope. See
	// tests/native-risk-evidence-parity.test.ts for the captured evidence.
	const contract = NATIVE_CLI_CONTRACTS["2.2.0"] as Record<string, boolean>;
	assert.equal(contract.mode, true);
	assert.equal(contract.delivery, true);
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
});

test("2.2.1 repeats 2.2.0 because the lane Pi speaks did not move", () => {
	// Ground-truthed against the released v2.2.1 binary. On
	// review-integration/v1 it advertises capabilities/v1.5 (protocol minor 5),
	// but the negotiated start envelope is still the closed `start/v2`, so
	// `risk_evidence` and `hint` still cannot arrive. v2.2.1 does publish a
	// second contract, review-integration/v2, whose `start/v3` carries frozen
	// base/candidate trees -- but Pi does not negotiate it yet, and a row
	// describes the lane in use, not the lane available.
	const contract = NATIVE_CLI_CONTRACTS["2.2.1"] as Record<string, boolean>;
	assert.equal(contract.mode, true);
	assert.equal(contract.delivery, true);
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.2.0"] as Record<string, boolean>);
});

test("2.2.2 repeats 2.2.1 because the lane Pi speaks still did not move", () => {
	// Ground-truthed against the released v2.2.2 binary: on
	// review-integration/v1 it advertises capabilities/v1.5 and the negotiated
	// start envelope is still the closed `start/v2`, so risk_evidence and hint
	// still cannot arrive on the lane Pi negotiates.
	const contract = NATIVE_CLI_CONTRACTS["2.2.2"] as Record<string, boolean>;
	assert.equal(contract.mode, true);
	assert.equal(contract.delivery, true);
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.2.1"] as Record<string, boolean>);
});

test("2.2.3 repeats 2.2.2 because Pi's consumed capability columns did not move", () => {
	// Ground-truthed against the released v2.2.3 binary: the v2 lane reports
	// protocol 2.0, the same eight negotiated operations, and the same START
	// fields represented by this table.
	const contract = NATIVE_CLI_CONTRACTS["2.2.3"] as Record<string, boolean>;
	assert.equal(contract.mode, true);
	assert.equal(contract.delivery, true);
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.2.2"] as Record<string, boolean>);
});

test("2.4.0 repeats 2.2.3 because the START envelope Pi consumes still omits risk_evidence and hint", () => {
	// Ground-truthed against the published v2.4.0 linux_amd64 release binary
	// (sha256:0be4467... , captured 2026-08-17), not against a main build:
	//
	//   mode      `gentle-ai review mode status --json` still answers
	//             `gentle-ai.rdd-mode-status/v1`. The RESOLVED value moved --
	//             an unconfigured install now reports effective "off" with
	//             source "default" instead of "on" -- but that is a decision
	//             the envelope carries, not a capability it lost.
	//   delivery  `review validate --gate pre-commit` still answers
	//             `gentle-ai.review-gate-result/v1` with
	//             `delivery: "disabled/unmanaged"` at exit 0. Under opt-in RDD
	//             this is now the DEFAULT delivery answer for an install that
	//             never enabled review, so the column matters more, not less.
	//
	// riskEvidence and hint stay dark for exactly the reason the 2.2.0 comment
	// gives, re-proven rather than inherited: the negotiated
	// `gentle-ai.review-integration.start/v3` envelope captured from this
	// binary carries `risk_reasons: [{ code: "non_executable_only" }]` and no
	// `risk_evidence` and no `hint`. `risk_evidence` does appear in v2.4.0, but
	// only on the `gentle-ai.review-integration.consent/v3` blocking envelope,
	// which is a different envelope on a different branch of START and is not
	// what these columns describe.
	const contract = NATIVE_CLI_CONTRACTS["2.4.0"] as Record<string, boolean>;
	assert.equal(contract.mode, true);
	assert.equal(contract.delivery, true);
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.2.3"] as Record<string, boolean>);
});

test("2.5.0-rc.3 repeats 2.4.0 because the negotiated lane Pi consumes is unchanged", () => {
	// Ground-truthed by driving the exact v2.5.0-rc.3 tagged build through the
	// gentle-ai-bench driven journey corpus (exit 0), which exercises the
	// start/status/capture/validate/mode/delivery lifecycles Pi consumes. The
	// lane now advertises capabilities/v2.3 and the reviewing START is the
	// `start/v4` continuation envelope that #499 already decodes; the closed
	// fields Pi reads did not change. riskEvidence and hint stay dark: still
	// not proven to reach the negotiated START path Pi consumes.
	const contract = NATIVE_CLI_CONTRACTS["2.5.0-rc.3"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.4.0"] as Record<string, boolean>);
});

test("2.5.0 repeats 2.5.0-rc.3 because the stable lane Pi consumes is unchanged", () => {
	// Ground-truthed against the published v2.5.0 binary installed from its
	// signed archive: the v2 lane advertises capabilities/v2.4 and answers
	// status/v6, consent/v3, and the `start/v4` continuation, all already
	// decoded. The closed fields Pi reads did not change between rc.3 and
	// stable. riskEvidence and hint stay dark: still not proven to reach the
	// negotiated START path Pi consumes.
	const contract = NATIVE_CLI_CONTRACTS["2.5.0"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.5.0-rc.3"] as Record<string, boolean>);
});

test("2.6.0 repeats 2.5.0 because the negotiated lane Pi consumes is unchanged", () => {
	// Ground-truthed against the published v2.6.0 binary installed from its
	// signed archive: the v2 lane advertises capabilities/v2.5 and answers
	// status/v7, consent/v3, and the `start/v4` continuation, all already
	// decoded. `review mode status --json` and `review validate --gate
	// pre-commit` were re-run against the binary and still answer
	// `gentle-ai.rdd-mode-status/v1` and `gentle-ai.review-gate-result/v1`
	// respectively. Declining the consent/v3 prompt during `review start`
	// still surfaces `risk_evidence` only on that blocking envelope, not on
	// the negotiated `start/v4` continuation, so riskEvidence and hint stay
	// dark: still not proven to reach the negotiated START path Pi consumes.
	const contract = NATIVE_CLI_CONTRACTS["2.6.0"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.5.0"] as Record<string, boolean>);
});

test("2.7.0 repeats 2.6.0 because the negotiated lane Pi consumes is unchanged", () => {
	// Ground-truthed against the published v2.7.0 binary installed from its
	// signed archive: the v2 lane still advertises capabilities/v2.5 and
	// answers status/v7, consent/v3, and the `start/v4` continuation, all
	// already decoded. `review mode status --json` and `review validate --gate
	// pre-commit` were re-run against the binary and still answer
	// `gentle-ai.rdd-mode-status/v1` and `gentle-ai.review-gate-result/v1`
	// respectively. riskEvidence and hint stay dark: still not proven to reach
	// the negotiated START path Pi consumes.
	const contract = NATIVE_CLI_CONTRACTS["2.7.0"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.6.0"] as Record<string, boolean>);
});

test("2.8.0 repeats 2.7.0 because the negotiated lane Pi consumes is unchanged", () => {
	// Ground-truthed against the published v2.8.0 linux/amd64 binary from its
	// signed release archive: capabilities/v2.5 still advertises protocol minor
	// 5 with status/v7, consent/v3, and start/v4 schemas. riskEvidence and hint
	// remain dark because neither is proven to reach Pi's negotiated START path.
	const contract = NATIVE_CLI_CONTRACTS["2.8.0"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.7.0"] as Record<string, boolean>);
});

test("2.8.1 repeats 2.8.0 because the negotiated lane Pi consumes is unchanged", () => {
	// v2.8.1 only changed runtime telemetry model attribution (gentle-ai#4536);
	// the closed fields Pi consumes did not change between 2.8.0 and 2.8.1, so
	// this row repeats 2.8.0. riskEvidence and hint remain dark because neither
	// is proven to reach Pi's negotiated START path.
	const contract = NATIVE_CLI_CONTRACTS["2.8.1"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.8.0"] as Record<string, boolean>);
});

test("2.8.2 repeats 2.8.1 because the negotiated lane Pi consumes is unchanged", () => {
	// v2.8.2 only shipped OpenCode SDD preflight plugin fixes, community-tools
	// RTK acquisition, and Claude Code Stop telemetry (no review/SDD contract
	// changes); the closed fields Pi consumes did not change between 2.8.1 and
	// 2.8.2, so this row repeats 2.8.1. riskEvidence and hint remain dark
	// because neither is proven to reach Pi's negotiated START path.
	const contract = NATIVE_CLI_CONTRACTS["2.8.2"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.8.1"] as Record<string, boolean>);
});

test("2.9.0 repeats 2.8.2 because the negotiated lane Pi consumes is unchanged", () => {
	// v2.9.0 shipped RTK opt-in Community Tool integration (#4560,
	// installer/sync/TUI only), SDD attempt-ledger fixes (#4564, #4567,
	// #4569), sync telemetry-runtime symlinked root (#4565), OpenCode
	// reviewer Task wrapper decoding (#4545), and Engram protocol asset
	// wording (#4179). Diffing contracts/review-integration/v2 and
	// contracts/review-provider-contract between the v2.8.2 and v2.9.0 tags
	// in the gentle-ai source tree showed zero byte changes, so this row
	// repeats 2.8.2. riskEvidence and hint remain dark because neither is
	// proven to reach Pi's negotiated START path.
	const contract = NATIVE_CLI_CONTRACTS["2.9.0"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.8.2"] as Record<string, boolean>);
});

test("2.9.1 repeats 2.9.0 because the negotiated lane Pi consumes is unchanged", () => {
	// v2.9.1 shipped restoring compatible OpenCode review consent (#4584) and
	// deriving Claude Code SDD dispatch authority from the session transcript
	// (#4575, #4551). Diffing contracts/review-integration/v2 and
	// contracts/review-provider-contract between the v2.9.0 and v2.9.1 tags
	// in the gentle-ai source tree showed zero byte changes, so this row
	// repeats 2.9.0. riskEvidence and hint remain dark because neither is
	// proven to reach Pi's negotiated START path.
	const contract = NATIVE_CLI_CONTRACTS["2.9.1"] as Record<string, boolean>;
	assert.equal(contract.riskEvidence, false);
	assert.equal(contract.hint, false);
	assert.deepEqual(contract, NATIVE_CLI_CONTRACTS["2.9.0"] as Record<string, boolean>);
});

test("no shipped version key was added beyond the pin bump", () => {
	// Rows are promises to consumers, so a new key only ever appears in a
	// dedicated commit alongside a pin bump, never as a side effect. v2.2.4 and
	// v2.3.0 shipped upstream while Pi stayed on 2.2.3 and were never pinned,
	// so they get no row: a row asserts ground truth measured against a binary
	// Pi actually ran, and the table only has to be ascending, not gapless.
	assert.deepEqual(Object.keys(NATIVE_CLI_CONTRACTS), [...DARK_VERSIONS, "2.2.0", "2.2.1", "2.2.2", "2.2.3", "2.4.0", "2.5.0-rc.3", "2.5.0", "2.6.0", "2.7.0", "2.8.0", "2.8.1", "2.8.2", "2.9.0", "2.9.1"]);
});
