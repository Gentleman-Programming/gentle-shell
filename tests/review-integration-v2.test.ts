import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	REVIEW_INTEGRATION_CONTRACT,
	REVIEW_START_STATE,
	decodeAuthorityRepairAssessmentV1,
	decodeReviewArtifactSubjectV2,
	decodeReviewCapabilitiesV2,
	decodeReviewConsentV2,
	decodeReviewFailureV2,
	decodeReviewNextTransitionV3,
	decodeReviewProjectionV1,
	decodeReviewRepairV2,
	decodeReviewStartV3,
	decodeReviewStatusV3,
} from "../lib/review-integration-v2.ts";

const fixtureRoot = join(process.cwd(), "contracts", "review-integration", "v2", "fixtures");
const devFixtureRoot = join(process.cwd(), "tests", "fixtures", "devbinary");
const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as T;
const devFixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(devFixtureRoot, name), "utf8")) as T;
const executableDigest = "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705";
const digest = `sha256:${"a".repeat(64)}`;

type JsonObject = Record<string, unknown>;
type Decoder = (value: unknown) => unknown;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function assertRequired(decoder: Decoder, source: JsonObject, fields: readonly string[]): void {
	for (const field of fields) {
		const candidate = clone(source);
		delete candidate[field];
		assert.throws(() => decoder(candidate), new RegExp(`${field}.*required|required.*${field}`), field);
	}
}

function assertNestedRequired(decoder: Decoder, source: JsonObject, path: readonly string[], fields: readonly string[]): void {
	for (const field of fields) {
		const candidate = clone(source);
		let target = candidate;
		for (const segment of path) target = target[segment] as JsonObject;
		delete target[field];
		assert.throws(() => decoder(candidate), /required/, `${path.join(".")}.${field}`);
	}
}

function assertAdditionalProperty(decoder: Decoder, source: JsonObject, path: readonly string[] = []): void {
	const candidate = clone(source);
	let target = candidate;
	for (const segment of path) target = target[segment] as JsonObject;
	target.unadvertised = true;
	assert.throws(() => decoder(candidate), /not allowed/, path.length === 0 ? "top-level" : path.join("."));
}

test("current review integration fixtures decode", () => {
	assert.equal(decodeReviewCapabilitiesV2(fixture("capabilities.fixture.json"), executableDigest).contract, REVIEW_INTEGRATION_CONTRACT);
	assert.equal(decodeReviewStartV3(fixture("start.fixture.json")).riskLevel, "high");
	assert.equal(decodeReviewConsentV2(fixture("consent.fixture.json")).action, "consent_required");
});

test("capabilities enforce every required top-level and nested property", () => {
	const source = fixture<JsonObject>("capabilities.fixture.json");
	const decode: Decoder = (value) => decodeReviewCapabilitiesV2(value, executableDigest);
	assertRequired(decode, source, ["schema", "contract", "protocol", "package", "build", "executable", "operations", "gates", "projections", "schemas", "features", "compatibility"]);
	assertNestedRequired(decode, source, ["protocol"], ["major", "minor"]);
	assertNestedRequired(decode, source, ["package"], ["name", "version", "release_channel"]);
	assertNestedRequired(decode, source, ["build"], ["id", "go_version", "module_version", "vcs", "vcs_revision", "vcs_time", "vcs_modified"]);
	assertNestedRequired(decode, source, ["executable"], ["sha256", "evidence", "verification"]);
	assertNestedRequired(decode, source, ["features"], ["mandatory", "optional"]);
	assertNestedRequired(decode, source, ["compatibility"], ["minimum_protocol_major", "maximum_protocol_major", "additive_minor_policy", "unknown_mandatory", "unknown_optional", "modes", "legacy_window"]);
});

test("capabilities reject additional properties at every exact object boundary", () => {
	const source = fixture<JsonObject>("capabilities.fixture.json");
	const decode: Decoder = (value) => decodeReviewCapabilitiesV2(value, executableDigest);
	for (const path of [[], ["protocol"], ["package"], ["build"], ["executable"], ["features"], ["compatibility"], ["compatibility", "legacy_window"]] as const) {
		assertAdditionalProperty(decode, source, path);
	}
});

test("capabilities reject an incompatible protocol identity", () => {
	const source = fixture<JsonObject>("capabilities.fixture.json");
	const decode: Decoder = (value) => decodeReviewCapabilitiesV2(value, executableDigest);
	const wrongMajor = clone(source);
	(wrongMajor.protocol as JsonObject).major = 1;
	assert.throws(() => decode(wrongMajor), /incompatible/);
	const wrongMinor = clone(source);
	(wrongMinor.protocol as JsonObject).minor = 1;
	assert.throws(() => decode(wrongMinor), /incompatible/);
	assert.throws(() => decode({ ...clone(source), schema: "gentle-ai.review-integration.capabilities/v1" }), /schema/);
});

test("START enforces required, exact, and enum-bounded payloads", () => {
	const source = fixture<JsonObject>("start.fixture.json");
	assertRequired(decodeReviewStartV3, source, ["schema", "contract", "operation", "action", "lenses_required", "lineage_id", "state", "risk_level", "selected_lenses", "projection", "changed_files", "changed_lines", "correction_budget", "risk_reasons", "artifact_subjects"]);
	assertAdditionalProperty(decodeReviewStartV3, source);
	for (const state of Object.values(REVIEW_START_STATE)) {
		const candidate = clone(source);
		candidate.state = state;
		if (state === "reviewing") continue; // fixture is action=created, state=reviewing already requires repository_context which is present
		assert.throws(() => decodeReviewStartV3(candidate), /repository_context|state/);
	}
});

test("start/v3 transports the published selected_lenses wire contract without Pi-owned risk policy", () => {
	const captured = devFixture<JsonObject>("start-v3-zero-lens-closed.captured.json");
	const decoded = decodeReviewStartV3(captured);
	assert.equal(decoded.action, "closed");
	assert.equal(decoded.lensesRequired, false);
	assert.deepEqual(decoded.selectedLenses, []);

	for (const riskLevel of ["medium", "high"] as const) {
		const noLens = clone(captured);
		noLens.risk_level = riskLevel;
		assert.doesNotThrow(() => decodeReviewStartV3(noLens));
	}

	const nullLenses = clone(captured);
	nullLenses.selected_lenses = null;
	assert.throws(() => decodeReviewStartV3(nullLenses), /selected_lenses.*invalid length/);

	const unknownLens = clone(captured);
	unknownLens.selected_lenses = ["review-future"];
	assert.throws(() => decodeReviewStartV3(unknownLens), /selected_lenses.*unsupported/);

	const tooManyLenses = clone(captured);
	tooManyLenses.selected_lenses = ["review-risk", "review-resilience", "review-readability", "review-reliability", "review-future"];
	assert.throws(() => decodeReviewStartV3(tooManyLenses), /selected_lenses.*invalid length/);

	const duplicateLenses = clone(captured);
	duplicateLenses.selected_lenses = ["review-risk", "review-risk"];
	assert.throws(() => decodeReviewStartV3(duplicateLenses), /selected_lenses.*duplicates/);

	const wrongSchema = clone(captured);
	wrongSchema.schema = "gentle-ai.review-integration.start/v2";
	assert.throws(() => decodeReviewStartV3(wrongSchema), /schema/);

	const invalidAction = clone(captured);
	invalidAction.action = "dispatch-locally";
	assert.throws(() => decodeReviewStartV3(invalidAction), /action.*unsupported/);

	const invalidLensesRequired = clone(captured);
	invalidLensesRequired.lenses_required = "false";
	assert.throws(() => decodeReviewStartV3(invalidLensesRequired), /lenses_required/);
});

test("historical status fixture with a receipt is rejected after receipt retirement", () => {
	// This archived fixture is pinned for schema-rejection coverage only. Its
	// bytes retain the retired receipt surface and must never regain authority.
	assert.throws(() => decodeReviewStatusV3(fixture("status.fixture.json")), /receipt.*not allowed/);
});

test("projection enforces every required property and rejects additional keys", () => {
	const source = (fixture<JsonObject>("status.fixture.json").projection as JsonObject);
	assertRequired(decodeReviewProjectionV1, source, ["schema", "kind", "projection", "base_tree", "initial_review_tree", "current_candidate_tree", "paths_digest", "paths", "intended_untracked", "intended_untracked_proof", "initial_snapshot_identity", "current_snapshot_identity"]);
	assertAdditionalProperty(decodeReviewProjectionV1, source);
});

test("failure enforces exact keys, enums, and identifiers", () => {
	const source: JsonObject = {
		schema: "gentle-ai.review-integration.failure/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.capture-result",
		phase: "pre_native",
		code: "gate_scope_changed",
		message: "the target scope changed since START",
		mutation_outcome: "not_started",
		authority_applicability: "current_target",
		retry_safe: true,
		replayability: "manual_action_required",
		required_inputs: [],
		next_action: "explicit-maintainer-action",
	};
	assert.equal(decodeReviewFailureV2(source).code, "gate_scope_changed");
	assertRequired(decodeReviewFailureV2, source, ["schema", "contract", "operation", "phase", "code", "message", "mutation_outcome", "authority_applicability", "retry_safe", "replayability", "required_inputs", "next_action"]);
	assertAdditionalProperty(decodeReviewFailureV2, source);
	const badCode = clone(source);
	badCode.code = "Bad-Code";
	assert.throws(() => decodeReviewFailureV2(badCode), /code/);
});

test("failure with code managed_assets_outdated decodes its continuation, degrades without one, and forbids it elsewhere", () => {
	const source: JsonObject = {
		schema: "gentle-ai.review-integration.failure/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.start",
		phase: "preflight",
		code: "managed_assets_outdated",
		message: "the managed asset set is stale",
		mutation_outcome: "not_started",
		authority_applicability: "current_target",
		retry_safe: true,
		replayability: "manual_action_required",
		required_inputs: [],
		next_action: "explicit-maintainer-action",
		continuation: { operation: "sync", command: "gentle-ai sync --agent claude-code", agent: "claude-code", stale_assets: ["orchestration/claude-code.md"] },
	};
	assert.deepEqual(decodeReviewFailureV2(source).continuation, { operation: "sync", command: "gentle-ai sync --agent claude-code", agent: "claude-code", staleAssets: ["orchestration/claude-code.md"] });

	const missingCommand = clone(source);
	delete (missingCommand.continuation as JsonObject).command;
	assert.throws(() => decodeReviewFailureV2(missingCommand), /command.*required|required.*command/);

	// an older gentle-ai may emit managed_assets_outdated with no continuation
	// at all; decode must not refuse the whole envelope for that
	const missingContinuation = clone(source);
	delete missingContinuation.continuation;
	assert.equal(decodeReviewFailureV2(missingContinuation).continuation, undefined);

	const unexpectedContinuation: JsonObject = { ...clone(source), code: "gate_scope_changed" };
	assert.throws(() => decodeReviewFailureV2(unexpectedContinuation), /continuation is only valid/);

	// an envelope without continuation, on a code that does not require one, is unchanged
	const withoutContinuation = clone(source);
	withoutContinuation.code = "gate_scope_changed";
	delete withoutContinuation.continuation;
	assert.equal(decodeReviewFailureV2(withoutContinuation).continuation, undefined);
});

test("net-new decoders: consent, next-transition, and artifact-subject reject malformed payloads", () => {
	const consentSource = fixture<JsonObject>("consent.fixture.json");
	assertRequired(decodeReviewConsentV2, consentSource, ["schema", "contract", "operation", "action", "blocking", "target_identity", "projection", "risk_level", "changed_files", "changed_lines", "headline", "reason", "value", "risk_evidence", "choices", "off_path"]);
	assertAdditionalProperty(decodeReviewConsentV2, consentSource);

	const transitionSource = ((fixture<JsonObject>("status.fixture.json").next_transition) as JsonObject);
	assertRequired(decodeReviewNextTransitionV3, transitionSource, ["kind", "reason_code"]);
	assertAdditionalProperty(decodeReviewNextTransitionV3, transitionSource);

	const artifactSubjectSource = (((fixture<JsonObject>("start.fixture.json").artifact_subjects) as JsonObject[])[0]);
	assertRequired(decodeReviewArtifactSubjectV2, artifactSubjectSource, ["schema", "subject_hash", "lineage_id", "authority_revision", "target_identity", "base_tree", "candidate_tree", "changed_path_manifest_sha256", "lens", "selected_order"]);
	assertAdditionalProperty(decodeReviewArtifactSubjectV2, artifactSubjectSource);
});

function repairAssessment(status: "eligible" | "unsupported" = "unsupported"): JsonObject {
	if (status === "unsupported") {
		return {
			schema: "gentle-ai.review-authority-repair-assessment/v1",
			status: "unsupported",
			counts: { lineages: 0, compact_lineages: 0, legacy_lineages: 0, events: 0, bytes: 0, eligible_candidates: 0, unsupported_lineages: 0, conflicts: 0 },
			supported_operations: ["review/complete-fix", "review/validate-fix"],
			authorization_schema: "gentle-ai.review-repair-authorization/v1",
		};
	}
	return {
		schema: "gentle-ai.review-authority-repair-assessment/v1",
		status: "eligible",
		class: "legacy_v1_historical_alias",
		cause: "unsupported_historical_v1_operation_alias",
		disposition: "quarantine-approved-historical-alias",
		repository_binding: digest,
		candidate: {
			lineage_id: "review-legacy-fixture",
			revision: digest,
			chain_identity: digest,
			event_count: 3,
			alias_event_count: 1,
			operations: ["review/complete-fix"],
		},
		counts: { lineages: 1, compact_lineages: 0, legacy_lineages: 1, events: 3, bytes: 128, eligible_candidates: 1, unsupported_lineages: 0, conflicts: 0 },
		supported_operations: ["review/complete-fix", "review/validate-fix"],
		authorization_schema: "gentle-ai.review-repair-authorization/v1",
	};
}

test("authority repair assessment decodes eligible and unsupported statuses", () => {
	assert.equal(decodeAuthorityRepairAssessmentV1(repairAssessment("unsupported")).status, "unsupported");
	assert.equal(decodeAuthorityRepairAssessmentV1(repairAssessment("eligible")).status, "eligible");
	const missingClass = repairAssessment("eligible");
	delete missingClass.class;
	assert.throws(() => decodeAuthorityRepairAssessmentV1(missingClass), /requires class/);
});

test("repair execute-without-execution is rejected", () => {
	const executeMissingExecution: JsonObject = {
		schema: "gentle-ai.review-integration.repair/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.repair",
		mode: "execute",
		assessment: repairAssessment("unsupported"),
		required_inputs: [],
	};
	assert.throws(() => decodeReviewRepairV2(executeMissingExecution), /execution/);
});

test("capabilities enforce the exact mandatory feature set while accepting a superset of advertised operations", () => {
	const source = fixture<JsonObject>("capabilities.fixture.json");
	const decode = (value: unknown) => decodeReviewCapabilitiesV2(value, executableDigest);
	const decoded = decode(source) as { mandatoryFeatures: ReadonlySet<string>; operations: ReadonlySet<string> };
	assert.equal(decoded.mandatoryFeatures.has("compact_v2_authority"), true);
	assert.equal(decoded.operations.has("review.repair"), true);

	const extraMandatory = clone(source);
	((extraMandatory.features as JsonObject).mandatory as JsonObject[]).push({ name: "risk_reasons", supported: true, requires: [] });
	assert.throws(() => decode(extraMandatory), /mandatory/);

	// operations is a superset promise: an extra advertised operation beyond the
	// required set must not be rejected.
	const extraOperation = clone(source);
	(extraOperation.operations as string[]).push("review.future_operation");
	assert.doesNotThrow(() => decode(extraOperation));

	// mandatory features must stay an exact match: a known-but-optional feature
	// name added to the mandatory list must still be rejected. This is the
	// contract boundary (unknown_mandatory: "reject") and must not regress when
	// gates/projections become additive-tolerant below.
	const extraMandatoryUnknownAddition = clone(source);
	((extraMandatoryUnknownAddition.features as JsonObject).mandatory as JsonObject[]).push({ name: "bounded_process_waits", supported: true, requires: [] });
	assert.throws(() => decode(extraMandatoryUnknownAddition), /mandatory/);
});

test("capabilities gates and projections accept an additive superset beyond the required floor", () => {
	const source = fixture<JsonObject>("capabilities.fixture.json");
	const decode = (value: unknown) => decodeReviewCapabilitiesV2(value, executableDigest);

	const extraGate = clone(source);
	(extraGate.gates as string[]).push("future-gate");
	const decodedExtraGate = decode(extraGate) as { gates: ReadonlySet<string> };
	assert.equal(decodedExtraGate.gates.has("future-gate"), false, "an unknown advertised gate must not leak into internal use");
	for (const gate of ["post-apply", "pre-commit", "pre-push", "pre-pr", "release"]) {
		assert.equal(decodedExtraGate.gates.has(gate), true, gate);
	}
	assert.equal(decodedExtraGate.gates.size, 5);

	const extraProjection = clone(source);
	(extraProjection.projections as string[]).push("future-projection");
	const decodedExtraProjection = decode(extraProjection) as { projections: ReadonlySet<string> };
	assert.equal(decodedExtraProjection.projections.has("future-projection"), false, "an unknown advertised projection must not leak into internal use");
	for (const projection of ["staged", "workspace"]) {
		assert.equal(decodedExtraProjection.projections.has(projection), true, projection);
	}
	assert.equal(decodedExtraProjection.projections.size, 2);
});

test("capabilities gates and projections still enforce the required floor", () => {
	const source = fixture<JsonObject>("capabilities.fixture.json");
	const decode = (value: unknown) => decodeReviewCapabilitiesV2(value, executableDigest);

	const missingGate = clone(source);
	missingGate.gates = (missingGate.gates as string[]).filter((gate) => gate !== "release");
	assert.throws(() => decode(missingGate), /gates/);

	const missingProjection = clone(source);
	missingProjection.projections = (missingProjection.projections as string[]).filter((projection) => projection !== "workspace");
	assert.throws(() => decode(missingProjection), /projections/);
});

test("START independently binds base/candidate tree and the target-mode overlay pair", () => {
	const source = fixture<JsonObject>("start.fixture.json");
	const decoded = decodeReviewStartV3(source);
	assert.equal(decoded.baseTree, source.base_tree);
	assert.equal(decoded.candidateTree, source.candidate_tree);
	assert.equal(decoded.targetMode, undefined, "the fixture never sets target_mode");

	const partialOverlay = clone(source);
	delete partialOverlay.target_identity;
	(partialOverlay as JsonObject).target_mode = "base-workspace-overlay";
	assert.throws(() => decodeReviewStartV3(partialOverlay), /target_mode.*target_identity|together/);

	const droppedManifest = clone(source);
	delete droppedManifest.changed_path_manifest;
	assert.throws(() => decodeReviewStartV3(droppedManifest), /selected_lenses|changed_path_manifest/);

	const manifestWithoutTrees = clone(source);
	delete manifestWithoutTrees.base_tree;
	delete manifestWithoutTrees.candidate_tree;
	delete manifestWithoutTrees.selected_lenses;
	(manifestWithoutTrees as JsonObject).selected_lenses = [];
	assert.throws(() => decodeReviewStartV3(manifestWithoutTrees), /changed_path_manifest/);
});

test("failure context accepts scope_change or binding_revision but rejects both or neither", () => {
	const base: JsonObject = {
		schema: "gentle-ai.review-integration.failure/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.capture-result",
		phase: "pre_native",
		code: "gate_scope_changed",
		message: "the target scope changed since START",
		mutation_outcome: "not_started",
		authority_applicability: "current_target",
		retry_safe: true,
		replayability: "manual_action_required",
		required_inputs: ["predecessor_lineage_id", "expected_predecessor_revision", "successor_lineage_id", "disposition", "reason", "actor"],
		next_action: "explicit-maintainer-action",
		context: {
			binding_revision: { expected: digest, current: "" },
		},
	};
	const decoded = decodeReviewFailureV2(base);
	assert.equal(decoded.context?.bindingRevision?.current, "");

	const neither = clone(base);
	neither.context = {};
	assert.throws(() => decodeReviewFailureV2(neither), /exactly one/);

	const both = clone(base);
	both.context = { binding_revision: { expected: digest, current: digest }, scope_change: (both.context as JsonObject) };
	assert.throws(() => decodeReviewFailureV2(both), /exactly one|not allowed/);
});

test("consent rejects a swapped choice order, invalid answer domain, or invocation outside the frozen target", () => {
	const source = fixture<JsonObject>("consent.fixture.json");
	const swapped = clone(source);
	swapped.choices = [(source.choices as JsonObject[])[1], (source.choices as JsonObject[])[0]];
	assert.throws(() => decodeReviewConsentV2(swapped), /answer/);

	const badAnswer = clone(source);
	(badAnswer.choices as JsonObject[])[0].answer = "yes";
	assert.throws(() => decodeReviewConsentV2(badAnswer), /answer/);

	const badInvocation = clone(source);
	(badInvocation.choices as JsonObject[])[0].invocation = "gentle-ai review start --contract gentle-ai.review-integration/v1 --consent granted";
	assert.throws(() => decodeReviewConsentV2(badInvocation), /invocation/);

	const differentTarget = clone(source);
	(differentTarget.choices as JsonObject[])[0].invocation = String((differentTarget.choices as JsonObject[])[0].invocation)
		.replace(String(differentTarget.target_identity), `sha256:${"b".repeat(64)}`);
	assert.throws(() => decodeReviewConsentV2(differentTarget), /target|invocation/);
});

test("next_transition decodes an execute variant and rejects a stop that carries a transition", () => {
	const execute: JsonObject = {
		kind: "execute",
		reason_code: "fresh_target_ready",
		execute: {
			operation: "review.start",
			arguments: [{ name: "lineage", value: "review-fixture", token: "--lineage=review-fixture" }],
			preconditions: [{ name: "clean", value: "true" }],
			binding: { target_identity: digest },
		},
	};
	const decoded = decodeReviewNextTransitionV3(execute);
	assert.equal(decoded.execute?.operation, "review.start");
	assert.equal(decoded.execute?.arguments[0]?.token, "--lineage=review-fixture");

	const stopWithExecute = clone(execute);
	stopWithExecute.kind = "stop";
	assert.throws(() => decodeReviewNextTransitionV3(stopWithExecute), /stop cannot carry/);
});

// gentle-pi#627: gentle-ai reports a stale managed-asset set as a typed stop
// carrying the exact `gentle-ai sync` invocation that resolves it.
function managedAssetsContinuation(overrides: Partial<JsonObject> = {}): JsonObject {
	return { operation: "sync", command: "gentle-ai sync --agent claude-code", agent: "claude-code", stale_assets: ["orchestration/claude-code.md"], ...overrides };
}

test("next_transition stop decodes a managed_assets_outdated continuation and rejects a malformed one", () => {
	const stop: JsonObject = { kind: "stop", reason_code: "managed_assets_outdated", continuation: managedAssetsContinuation() };
	const decoded = decodeReviewNextTransitionV3(stop);
	assert.deepEqual(decoded.continuation, { operation: "sync", command: "gentle-ai sync --agent claude-code", agent: "claude-code", staleAssets: ["orchestration/claude-code.md"] });

	const bare: JsonObject = { kind: "stop", reason_code: "managed_assets_outdated", continuation: { operation: "sync", command: "gentle-ai sync" } };
	assert.deepEqual(decodeReviewNextTransitionV3(bare).continuation, { operation: "sync", command: "gentle-ai sync" });

	const missingCommand = clone(stop);
	delete (missingCommand.continuation as JsonObject).command;
	assert.throws(() => decodeReviewNextTransitionV3(missingCommand), /command.*required|required.*command/);

	const emptyCommand = clone(stop);
	(emptyCommand.continuation as JsonObject).command = "";
	assert.throws(() => decodeReviewNextTransitionV3(emptyCommand), /command/);

	// an older gentle-ai may emit this stop with no continuation at all; decode
	// must not refuse the whole envelope for that
	const missingForReasonCode = { kind: "stop", reason_code: "managed_assets_outdated" };
	assert.equal(decodeReviewNextTransitionV3(missingForReasonCode).continuation, undefined);

	const unexpectedOnOtherReasonCode = { kind: "stop", reason_code: "rdd_disabled", continuation: managedAssetsContinuation() };
	assert.throws(() => decodeReviewNextTransitionV3(unexpectedOnOtherReasonCode), /continuation is only valid/);

	// envelopes without continuation stay unchanged
	const plainStop = decodeReviewNextTransitionV3({ kind: "stop", reason_code: "rdd_disabled" });
	assert.equal(plainStop.continuation, undefined);
});

// gentle-pi#638: after the host relay declares a selected lens slot
// unachievable through the native capture-unachievable verb, gentle-ai's
// STATUS stops with reason_code unachievable_lens_slot and carries one entry
// per declared slot, each naming the complete withdraw command
// (contracts/review-integration/v2/schemas/status-v7.schema.json, the stop
// variant). A restart that never saw the collect offer must still be able to
// retract the declaration from the stop alone, so the withdraw binding is
// decoded, never dropped.
function unachievableSlot(overrides: Partial<JsonObject> = {}): JsonObject {
	return {
		lens: "review-risk",
		selected_order: 0,
		subject_hash: digest,
		reason: "relay_transport_bound_exceeded",
		withdraw: {
			operation: "review.capture-unachievable",
			command: `gentle-ai review capture-unachievable --lineage=review-fixture --expected-revision=${digest} --target=${digest} --repository-context=rctx1_${"e".repeat(64)} --request-hash=${digest} --withdraw=true`,
			arguments: [
				{ name: "lineage", value: "review-fixture", token: "--lineage=review-fixture" },
				{ name: "expected-revision", value: digest, token: `--expected-revision=${digest}` },
				{ name: "target", value: digest, token: `--target=${digest}` },
				{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
				{ name: "request-hash", value: digest, token: `--request-hash=${digest}` },
				{ name: "withdraw", value: "true", token: "--withdraw=true" },
			],
			binding: { lineage_id: "review-fixture", revision: digest, target_identity: digest, repository_context: `rctx1_${"e".repeat(64)}` },
		},
		...overrides,
	};
}

test("next_transition stop decodes unachievable_lens_slots and their withdraw bindings only on that reason code", () => {
	const stop: JsonObject = { kind: "stop", reason_code: "unachievable_lens_slot", unachievable_lens_slots: [unachievableSlot()] };
	const decoded = decodeReviewNextTransitionV3(stop);
	assert.equal(decoded.kind, "stop");
	assert.equal(decoded.reasonCode, "unachievable_lens_slot");
	const slot = decoded.unachievableLensSlots?.[0];
	assert.equal(slot?.lens, "review-risk");
	assert.equal(slot?.selectedOrder, 0);
	assert.equal(slot?.subjectHash, digest);
	assert.equal(slot?.reason, "relay_transport_bound_exceeded");
	assert.equal(slot?.detail, undefined);
	assert.equal(slot?.withdraw.operation, "review.capture-unachievable");
	assert.deepEqual(slot?.withdraw.arguments.map((argument) => argument.token), ["--lineage=review-fixture", `--expected-revision=${digest}`, `--target=${digest}`, `--repository-context=rctx1_${"e".repeat(64)}`, `--request-hash=${digest}`, "--withdraw=true"]);
	assert.equal(slot?.withdraw.binding.targetIdentity, digest);
	assert.equal(slot?.withdraw.command, `gentle-ai review capture-unachievable --lineage=review-fixture --expected-revision=${digest} --target=${digest} --repository-context=rctx1_${"e".repeat(64)} --request-hash=${digest} --withdraw=true`);

	// detail is the one optional field the schema declares
	const detailed = decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [unachievableSlot({ detail: "killed after 2256004ms against a 2256000ms relay bound" })] });
	assert.equal(detailed.unachievableLensSlots?.[0]?.detail, "killed after 2256004ms against a 2256000ms relay bound");

	// malformed entries are refused: a negative selected_order, a slot missing
	// its withdraw form, a foreign withdraw operation, or an empty array
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [unachievableSlot({ selected_order: -1 })] }), /selected_order/);
	const withoutWithdraw = unachievableSlot();
	delete withoutWithdraw.withdraw;
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [withoutWithdraw] }), /withdraw.*required|required.*withdraw/);
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [unachievableSlot({ withdraw: { ...(unachievableSlot().withdraw as JsonObject), operation: "review.capture-result" } })] }), /operation/);
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [] }), /length/);

	// the slots are only valid on their own exact stop reason code
	assert.throws(() => decodeReviewNextTransitionV3({ kind: "stop", reason_code: "rdd_disabled", unachievable_lens_slots: [unachievableSlot()] }), /unachievable_lens_slots is only valid/);
	// an execute or collect transition never carries them
	assert.throws(() => decodeReviewNextTransitionV3({ kind: "execute", reason_code: "fresh_target_ready", execute: { operation: "review.start", arguments: [{ name: "lineage", value: "review-fixture" }], preconditions: [], binding: { target_identity: digest } }, unachievable_lens_slots: [unachievableSlot()] }), /unachievable_lens_slots is only valid/);
	// plain stops stay unchanged
	assert.equal(decodeReviewNextTransitionV3({ kind: "stop", reason_code: "rdd_disabled" }).unachievableLensSlots, undefined);
});

// gentle-pi#822: the withdraw form names the slot identity twice — as named arguments and as the binding object — and a slot whose two renderings disagree never decodes, so restart cannot withdraw a different slot.
test("next_transition stop refuses an unachievable slot whose withdraw arguments disagree with its identity", () => {
	const stop: JsonObject = { kind: "stop", reason_code: "unachievable_lens_slot", unachievable_lens_slots: [unachievableSlot()] };
	const drift = (name: string, value: string): JsonObject => {
		const drifted = unachievableSlot();
		const withdraw = drifted.withdraw as JsonObject;
		withdraw.arguments = (withdraw.arguments as unknown[]).map((argument) => (argument as JsonObject).name === name ? { ...(argument as JsonObject), value } : argument);
		return drifted;
	};
	for (const [name, value] of [["request-hash", `sha256:${"b".repeat(64)}`], ["target", `sha256:${"c".repeat(64)}`], ["lineage", "review-fixture-drifted"], ["expected-revision", `sha256:${"d".repeat(64)}`]] as const) {
		assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [drift(name, value)] }), new RegExp(`${name} does not match`), name);
	}
	// the pristine fixture still decodes with both renderings agreeing
	assert.doesNotThrow(() => decodeReviewNextTransitionV3(stop));
});

// gentle-pi#822: identity arguments appear exactly once, and the rendered
// command is an exact, ordered rendering of every validated provider token.
// Substring checks would accept a missing non-identity token, repeated command,
// suffix, or shell payload despite the command no longer naming this slot alone.
test("next_transition stop refuses duplicate identities and non-exact withdraw commands", () => {
	const stop: JsonObject = { kind: "stop", reason_code: "unachievable_lens_slot", unachievable_lens_slots: [unachievableSlot()] };
	const duplicated = unachievableSlot();
	const duplicatedWithdraw = duplicated.withdraw as JsonObject;
	duplicatedWithdraw.arguments = [...(duplicatedWithdraw.arguments as unknown[]), { name: "lineage", value: "review-fixture-smuggled", token: "--lineage=review-fixture-smuggled" }];
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [duplicated] }), /withdraw\.arguments lineage must appear exactly once/);

	const canonical = `gentle-ai review capture-unachievable --lineage=review-fixture --expected-revision=${digest} --target=${digest} --repository-context=rctx1_${"e".repeat(64)} --request-hash=${digest} --withdraw=true`;
	for (const [name, command] of [
		["omitted token", canonical.replace(" --withdraw=true", "")],
		["duplicate command", `gentle-ai review capture-unachievable ${canonical}`],
		["extra suffix", `${canonical} --surplus=true`],
		["shell payload", `${canonical} && printf injected`],
	] as const) {
		const malformed = unachievableSlot();
		(malformed.withdraw as JsonObject).command = command;
		assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [malformed] }), /withdraw\.command must exactly render/, name);
	}
	assert.doesNotThrow(() => decodeReviewNextTransitionV3(stop));
});

// gentle-pi#822 (CodeRabbit finding): withdrawal is a narrowly scoped, runnable
// retraction. Its one affirmative flag is part of the exact native vector, not
// just another provider-defined argument that a malformed STATUS can omit or
// negate while still rendering a plausible command.
test("next_transition stop requires exactly one canonical --withdraw=true argument", () => {
	const stop: JsonObject = { kind: "stop", reason_code: "unachievable_lens_slot", unachievable_lens_slots: [unachievableSlot()] };
	const canonicalCommand = (slot: JsonObject): string => {
		const withdraw = slot.withdraw as JsonObject;
		return `gentle-ai review capture-unachievable ${(withdraw.arguments as JsonObject[]).map((argument) => String(argument.token)).join(" ")}`;
	};

	const omitted = unachievableSlot();
	const omittedWithdraw = omitted.withdraw as JsonObject;
	omittedWithdraw.arguments = (omittedWithdraw.arguments as JsonObject[]).filter((argument) => argument.name !== "withdraw");
	omittedWithdraw.command = canonicalCommand(omitted);
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [omitted] }), /withdraw must appear exactly once/);

	const falseValue = unachievableSlot();
	const falseWithdraw = falseValue.withdraw as JsonObject;
	falseWithdraw.arguments = (falseWithdraw.arguments as JsonObject[]).map((argument) => argument.name === "withdraw"
		? { ...argument, value: "false", token: "--withdraw=false" }
		: argument);
	falseWithdraw.command = canonicalCommand(falseValue);
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [falseValue] }), /withdraw must be true/);

	const noncanonicalToken = unachievableSlot();
	const tokenWithdraw = noncanonicalToken.withdraw as JsonObject;
	tokenWithdraw.arguments = (tokenWithdraw.arguments as JsonObject[]).map((argument) => argument.name === "withdraw"
		? { ...argument, token: "--withdraw true" }
		: argument);
	tokenWithdraw.command = canonicalCommand(noncanonicalToken);
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [noncanonicalToken] }), /token must exactly render/);

	const duplicate = unachievableSlot();
	const duplicateWithdraw = duplicate.withdraw as JsonObject;
	duplicateWithdraw.arguments = [...duplicateWithdraw.arguments as JsonObject[], { name: "withdraw", value: "true", token: "--withdraw=true" }];
	duplicateWithdraw.command = canonicalCommand(duplicate);
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [duplicate] }), /withdraw must appear exactly once/);
});

// gentle-pi#822 (CodeRabbit finding): Go bounds the CAPTURE_UNACHIEVABLE detail at 512 UTF-8 bytes (native-review-cli.ts enforces the same limit when declaring), so the transition decoder mirrors that bound — measured in bytes, not UTF-16 code units — and a STATUS stop can never carry a detail this client would have refused to declare.
test("next_transition stop bounds an unachievable slot detail at 512 UTF-8 bytes", () => {
	const stop: JsonObject = { kind: "stop", reason_code: "unachievable_lens_slot", unachievable_lens_slots: [unachievableSlot()] };
	// exactly 512 one-byte characters still decodes
	assert.equal(decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [unachievableSlot({ detail: "a".repeat(512) })] }).unachievableLensSlots?.[0]?.detail, "a".repeat(512));
	// exactly 512 bytes of two-byte characters still decodes: 256 × 2
	assert.equal(decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [unachievableSlot({ detail: "é".repeat(256) })] }).unachievableLensSlots?.[0]?.detail, "é".repeat(256));
	// 257 two-byte characters are 514 bytes
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [unachievableSlot({ detail: "é".repeat(257) })] }), /detail exceeds 512 bytes/);
	// 171 three-byte characters are 513 bytes
	assert.throws(() => decodeReviewNextTransitionV3({ ...stop, unachievable_lens_slots: [unachievableSlot({ detail: "世".repeat(171) })] }), /detail exceeds 512 bytes/);
	// an absent detail still decodes as undefined
	assert.equal(decodeReviewNextTransitionV3(stop).unachievableLensSlots?.[0]?.detail, undefined);
});

function approvedAcknowledgementTransition(): JsonObject {
	return {
		kind: "execute",
		reason_code: "approved_acknowledgement_required",
		execute: {
			operation: "review.acknowledge-approved",
			command: "gentle-ai review acknowledge-approved --provider-vector",
			arguments: [
				{ name: "cwd", value: "/provider/repository", token: "--cwd=/provider/repository" },
				{ name: "lineage", value: "review-fixture", token: "--lineage=review-fixture" },
				{ name: "target", value: digest, token: `--target=${digest}` },
				{ name: "expected-revision", value: digest, token: `--expected-revision=${digest}` },
				{ name: "token", value: "provider-issued-once", token: "--token=provider-issued-once" },
			],
			preconditions: [{ name: "state", value: "approved", token: "--state=approved" }],
			binding: { lineage_id: "review-fixture", target_identity: digest, revision: digest },
		},
	};
}

test("acknowledgement execute rejects decoy bindings, closed-vector drift, and malformed approval", () => {
	const valid = approvedAcknowledgementTransition();
	assert.equal(decodeReviewNextTransitionV3(valid).execute?.operation, "review.acknowledge-approved");
	const cases: Array<[string, (candidate: JsonObject) => void]> = [
		["decoy target", (candidate) => { const argument = ((candidate.execute as JsonObject).arguments as JsonObject[])[2]!; argument.value = `sha256:${"b".repeat(64)}`; argument.token = `--target=${argument.value}`; }],
		["mismatched expected revision", (candidate) => { const argument = ((candidate.execute as JsonObject).arguments as JsonObject[])[3]!; argument.value = `sha256:${"c".repeat(64)}`; argument.token = `--expected-revision=${argument.value}`; }],
		["wrong argument order", (candidate) => { ((candidate.execute as JsonObject).arguments as JsonObject[]).reverse(); }],
		["wrong argument name", (candidate) => { const argument = ((candidate.execute as JsonObject).arguments as JsonObject[])[0]!; argument.name = "repository"; argument.token = `--repository=${argument.value}`; }],
		["malformed approved precondition", (candidate) => { ((candidate.execute as JsonObject).preconditions as JsonObject[])[0]!.value = "burned"; }],
		["token value mismatch", (candidate) => { ((candidate.execute as JsonObject).arguments as JsonObject[])[4]!.token = "--token=other"; }],
	];
	for (const [name, mutate] of cases) {
		const candidate = clone(valid);
		mutate(candidate);
		assert.throws(() => decodeReviewNextTransitionV3(candidate), /acknowledgement|arguments|preconditions|binding/, name);
	}
});

test("repair decodes a committed execute result and rejects a non-eligible preflight carrying provider_inputs", () => {
	const executed: JsonObject = {
		schema: "gentle-ai.review-integration.repair/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.repair",
		mode: "execute",
		assessment: repairAssessment("eligible"),
		required_inputs: [],
		execution: {
			status: "committed",
			class: "legacy_v1_historical_alias",
			lineage_id: "review-legacy-fixture",
			revision: digest,
			chain_identity: digest,
			cause: "unsupported_historical_v1_operation_alias",
			disposition: "quarantine-approved-historical-alias",
			assessment_digest: digest,
			request_digest: digest,
			record_identity: digest,
		},
	};
	assert.equal(decodeReviewRepairV2(executed).execution?.status, "committed");

	const nonEligibleWithInputs: JsonObject = {
		schema: "gentle-ai.review-integration.repair/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.repair",
		mode: "preflight",
		assessment: repairAssessment("unsupported"),
		provider_inputs: {
			class: "legacy_v1_historical_alias",
			lineage_id: "review-legacy-fixture",
			expected_revision: digest,
			cause: "unsupported_historical_v1_operation_alias",
			disposition: "quarantine-approved-historical-alias",
			repository_binding: digest,
			authorization_schema: "gentle-ai.review-repair-authorization/v1",
		},
		required_inputs: [],
	};
	assert.throws(() => decodeReviewRepairV2(nonEligibleWithInputs), /provider_inputs is only valid/);
});

test("artifact-subject accepts an optional correction_target_identity", () => {
	const source = ((fixture<JsonObject>("start.fixture.json").artifact_subjects) as JsonObject[])[0];
	const withCorrection = clone(source);
	withCorrection.correction_target_identity = digest;
	const decoded = decodeReviewArtifactSubjectV2(withCorrection);
	assert.equal(decoded.correctionTargetIdentity, digest);
	assert.equal(decodeReviewArtifactSubjectV2(source).correctionTargetIdentity, undefined);
});

test("repair eligible preflight with wrong required_inputs order is rejected", () => {
	const wrongOrder: JsonObject = {
		schema: "gentle-ai.review-integration.repair/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.repair",
		mode: "preflight",
		assessment: repairAssessment("eligible"),
		provider_inputs: {
			class: "legacy_v1_historical_alias",
			lineage_id: "review-legacy-fixture",
			expected_revision: digest,
			cause: "unsupported_historical_v1_operation_alias",
			disposition: "quarantine-approved-historical-alias",
			repository_binding: digest,
			authorization_schema: "gentle-ai.review-repair-authorization/v1",
		},
		required_inputs: ["reason", "actor", "maintainer_authorization"],
	};
	assert.throws(() => decodeReviewRepairV2(wrongOrder), /required_inputs/);
});

// Three decode defects the after-bench found by driving the real v2.2.2 binary.
// Every native call exited 0 and authority advanced; Pi threw locally on the
// RESPONSE. The mirrored fixture never caught them because it only exercises
// the `collect` transition kind, so no `execute` payload was ever decoded.
//
// The authority here is contracts/review-integration/v1/schemas/status-v2.schema.json
// $defs.transition_execution, which declares optional `command`,
// `selector_arguments`, and `artifacts`, and a `binding` with NO declared
// properties and no required list -- an OPEN object. Pi had closed execute to
// `command` alone and binding to three keys, making it stricter than the
// contract it implements.

test("next_transition.execute accepts the optional selector_arguments and artifacts the schema declares", () => {
	const base = {
		kind: "execute" as const,
		reason_code: "fresh_target_ready",
		execute: {
			operation: "review.start",
			command: "gentle-ai review start --lineage=review-96f29cbd865e77a9",
			arguments: [{ name: "lineage", value: "review-96f29cbd865e77a9", token: "--lineage=review-96f29cbd865e77a9" }],
			preconditions: [{ name: "target_identity", value: "sha256:" + "9".repeat(64) }],
			binding: { target_identity: "sha256:" + "9".repeat(64) },
		},
	};

	assert.doesNotThrow(() => decodeReviewNextTransitionV3(base));
	assert.doesNotThrow(() => decodeReviewNextTransitionV3({ ...base, execute: { ...base.execute, artifacts: [{ name: "start-record", path: "review-start.json" }] } }));
	assert.doesNotThrow(() => decodeReviewNextTransitionV3({ ...base, execute: { ...base.execute, selector_arguments: [{ name: "projection", value: "workspace", token: "--projection=workspace" }] } }));
});

// gentle-pi#311 P4-roles: the two Go-owned non-lens provider role capture
// operations render SELF-CONTAINED vectors (binding tokens + --agent=pi
// --execute=true). Their schemas are pinned, and a submission descriptor on
// either one is a contract violation because it would hand the caller a way
// to author the verdict.
test("next_transition decodes the self-contained provider role capture vectors strictly", () => {
	const roleInput = (name: string, captureOperation: string, schema: string, extra: Record<string, unknown> = {}) => ({
		kind: "collect",
		reason_code: "provider_refuter_required",
		collect: { inputs: [{
			name,
			schema,
			capture_operation: captureOperation,
			arguments: [
				{ name: "lineage", value: "review-fixture", token: "--lineage=review-fixture" },
				{ name: "expected-revision", value: digest, token: `--expected-revision=${digest}` },
				{ name: "target", value: digest, token: `--target=${digest}` },
				{ name: "repository-context", value: `rctx1_${"c".repeat(64)}`, token: `--repository-context=rctx1_${"c".repeat(64)}` },
				{ name: "agent", value: "pi", token: "--agent=pi" },
				{ name: "execute", value: "true", token: "--execute=true" },
			],
			...extra,
		}] },
	});

	const decodeRoleTransition = (value: unknown) => decodeReviewNextTransitionV3(value, { v5: true });
	const refuter = roleInput("provider_refuter", "review.capture-refuter", "https://gentle-ai.dev/schema/review/refuter/v1");
	const decodedRefuter = decodeRoleTransition(refuter);
	assert.equal(decodedRefuter.collect?.inputs[0]?.captureOperation, "review.capture-refuter");
	assert.equal(decodedRefuter.collect?.inputs[0]?.arguments.at(-1)?.token, "--execute=true");

	assert.throws(
		() => decodeRoleTransition(roleInput("provider_refuter", "review.capture-refuter", "https://gentle-ai.dev/schema/review/reviewer/v1")),
		/schema must be https:\/\/gentle-ai\.dev\/schema\/review\/refuter\/v1/,
	);
	// This fixture decodes on the v5 surface only (no v9): a submission
	// descriptor on a role input is rejected for lacking the v9 provider
	// contract, before the materialize/execute discriminator is even read.
	assert.throws(
		() => decodeRoleTransition(roleInput("provider_refuter", "review.capture-refuter", "https://gentle-ai.dev/schema/review/refuter/v1", {
			submission: { operation_token: "capture-refuter", argument_tokens: ["--input={{value}}"], values: [{ slot: "{{value}}", domain: "artifact-path", substitution_location: 0 }] },
		})),
		/submission requires the v9 provider contract/,
	);

	const validator = roleInput("provider_targeted_validator", "review.capture-validation", "https://gentle-ai.dev/schema/review/validator/v1");
	assert.throws(
		() => decodeRoleTransition(validator),
		/validation_request is required/,
	);

	assert.throws(
		() => decodeRoleTransition(roleInput("provider_targeted_validator", "review.capture-validation", "https://gentle-ai.dev/schema/review/refuter/v1")),
		/schema must be https:\/\/gentle-ai\.dev\/schema\/review\/validator\/v1/,
	);
});

// gentle-ai's v9 contract makes the same two role operations host-mediated
// exactly like a lens materialize slot: the input carries a submission
// descriptor alongside --materialize=true (never --execute), and the host
// completes the frozen prompt in-process and submits through that
// descriptor instead of executing a Go-owned pi subprocess.
test("next_transition decodes the v9 host-mediated provider role submission form", () => {
	const materializeArguments = [
		{ name: "lineage", value: "review-fixture", token: "--lineage=review-fixture" },
		{ name: "expected-revision", value: digest, token: `--expected-revision=${digest}` },
		{ name: "target", value: digest, token: `--target=${digest}` },
		{ name: "repository-context", value: `rctx1_${"c".repeat(64)}`, token: `--repository-context=rctx1_${"c".repeat(64)}` },
		{ name: "agent", value: "pi", token: "--agent=pi" },
		{ name: "materialize", value: "true", token: "--materialize=true" },
	];
	const roleInput = (name: string, captureOperation: string, schema: string, extra: Record<string, unknown> = {}) => ({
		kind: "collect",
		reason_code: "provider_refuter_required",
		collect: { inputs: [{ name, schema, capture_operation: captureOperation, arguments: materializeArguments, ...extra }] },
	});
	// This decoder path is gated on v9 specifically -- the sibling gentle-ai
	// branch's contract, ahead of the currently-released v8 -- not on v5,
	// which v8 (and v6/v7) already satisfy.
	const decodeRoleTransition = (value: unknown) => decodeReviewNextTransitionV3(value, { v9: true });
	const refuterSubmission = {
		operation_token: "capture-refuter",
		argument_tokens: [...materializeArguments.map((argument) => argument.token), "--input={{value}}"],
		value: { slot: "provider_refuter", domain: "artifact_path_or_stdin", schema: "https://gentle-ai.dev/schema/review/refuter/v1", substitution_location: materializeArguments.length },
	};

	const refuter = roleInput("provider_refuter", "review.capture-refuter", "https://gentle-ai.dev/schema/review/refuter/v1", { submission: refuterSubmission });
	const decodedSubmission = decodeRoleTransition(refuter).collect?.inputs[0]?.submission;
	assert.equal(decodedSubmission?.operationToken, "capture-refuter");
	assert.equal(decodedSubmission?.argumentTokens.length, materializeArguments.length + 1);
	assert.deepEqual(decodedSubmission?.values, [{
		slot: "provider_refuter",
		domain: "artifact_path_or_stdin",
		schema: "https://gentle-ai.dev/schema/review/refuter/v1",
		substitutionLocation: materializeArguments.length,
	}]);

	// The exact same payload under v8 (or any earlier non-v9 rung) is
	// rejected: v8 only extended the reviewer-result transition for OpenCode
	// provider tasks and never renders a role submission descriptor.
	assert.throws(
		() => decodeReviewNextTransitionV3(refuter, { v6: true }),
		/submission requires the v9 provider contract/,
	);

	// A submission descriptor with no --materialize=true (and no --execute
	// either) matches neither wire form.
	assert.throws(
		() => decodeRoleTransition(roleInput("provider_refuter", "review.capture-refuter", "https://gentle-ai.dev/schema/review/refuter/v1", {
			submission: refuterSubmission,
			arguments: materializeArguments.filter((argument) => argument.name !== "materialize"),
		})),
		/submission requires --materialize=true/,
	);

	// --execute alongside a submission descriptor mixes both wire forms on
	// one input, which is never valid.
	assert.throws(
		() => decodeRoleTransition(roleInput("provider_refuter", "review.capture-refuter", "https://gentle-ai.dev/schema/review/refuter/v1", {
			submission: refuterSubmission,
			arguments: [...materializeArguments, { name: "execute", value: "true", token: "--execute=true" }],
		})),
		/must not carry --execute alongside a submission descriptor/,
	);

	// The targeted-validator's host-mediated form still requires its
	// validation_request, exactly like the self-contained vector.
	const validatorSubmission = {
		operation_token: "capture-validation",
		argument_tokens: [...materializeArguments.map((argument) => argument.token), "--input={{value}}"],
		value: { slot: "provider_targeted_validator", domain: "artifact_path_or_stdin", schema: "https://gentle-ai.dev/schema/review/validator/v1", substitution_location: materializeArguments.length },
	};
	assert.throws(
		() => decodeRoleTransition(roleInput("provider_targeted_validator", "review.capture-validation", "https://gentle-ai.dev/schema/review/validator/v1", { submission: validatorSubmission })),
		/validation_request is required/,
	);
});

test("v5 targeted-validator collect inputs carry the exact provider-owned validation request", () => {
	const requestHash = `sha256:${"a".repeat(64)}`;
	const expectedRevision = `sha256:${"b".repeat(64)}`;
	const targetIdentity = `sha256:${"c".repeat(64)}`;
	const correctionTargetIdentity = `sha256:${"d".repeat(64)}`;
	const correctionPathsDigest = `sha256:${"e".repeat(64)}`;
	const validationRequest = {
		schema: "gentle-ai.review-targeted-validation-request/v1",
		request_hash: requestHash,
		lineage_id: "review-fixture",
		expected_revision: expectedRevision,
		target_identity: targetIdentity,
		fix_finding_ids: ["R1-001"],
		policy_content: "Gentle AI native bounded review policy.",
		fix_findings: [{
			id: "R1-001",
			lens: "risk",
			location: "selected.txt:1",
			severity: "BLOCKER",
			claim: "the selected relay input must be corrected before delivery",
			proof_refs: ["selected.txt:1"],
			evidence_class: "deterministic",
			causal_disposition: "introduced",
		}],
		fix_classifications: [{
			finding_id: "R1-001",
			class: "deterministic",
			causal_disposition: "introduced",
			proof: "selected.txt:1",
		}],
		projection: "workspace",
		correction_candidate_tree: "f".repeat(40),
		correction_target_identity: correctionTargetIdentity,
		correction_paths: ["selected.txt"],
		correction_paths_digest: correctionPathsDigest,
	};
	const input = {
		name: "provider_targeted_validator",
		schema: "https://gentle-ai.dev/schema/review/validator/v1",
		capture_operation: "review.capture-validation",
		arguments: [
			{ name: "lineage", value: "review-fixture", token: "--lineage=review-fixture" },
			{ name: "expected-revision", value: expectedRevision, token: `--expected-revision=${expectedRevision}` },
			{ name: "target", value: correctionTargetIdentity, token: `--target=${correctionTargetIdentity}` },
			{ name: "repository-context", value: `rctx1_${"f".repeat(64)}`, token: `--repository-context=rctx1_${"f".repeat(64)}` },
			{ name: "request-hash", value: requestHash, token: `--request-hash=${requestHash}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
		validation_request: validationRequest,
	};
	const transition = { kind: "collect" as const, reason_code: "targeted_validation_required", collect: { inputs: [input] } };
	const decoded = decodeReviewNextTransitionV3(transition, { v5: true });
	const decodedRequest = decoded.collect?.inputs[0]?.validationRequest;
	assert.equal(decodedRequest?.requestHash, requestHash);
	assert.equal(decodedRequest?.correctionTargetIdentity, correctionTargetIdentity);
	assert.deepEqual(decodedRequest?.correctionPaths, ["selected.txt"]);
	assert.equal(decodedRequest?.policyContent, validationRequest.policy_content);
	assert.deepEqual(decodedRequest?.fixFindings, [{
		id: "R1-001",
		lens: "risk",
		location: "selected.txt:1",
		severity: "BLOCKER",
		claim: "the selected relay input must be corrected before delivery",
		proofRefs: ["selected.txt:1"],
		evidenceClass: "deterministic",
		causalDisposition: "introduced",
	}]);
	assert.deepEqual(decodedRequest?.fixClassifications, [{
		findingId: "R1-001",
		class: "deterministic",
		causalDisposition: "introduced",
		proof: "selected.txt:1",
	}]);
	assert.deepEqual(decoded.collect?.inputs[0]?.arguments, input.arguments, "provider-rendered arguments must remain unchanged");

	// The same validation_request rides the v9 host-mediated form too: swap
	// --execute=true for --materialize=true and add the provider-owned
	// submission descriptor.
	const materializeArguments = input.arguments.map((argument) => argument.name === "execute" ? { name: "materialize", value: "true", token: "--materialize=true" } : argument);
	const hostMediatedInput = {
		...input,
		arguments: materializeArguments,
		submission: {
			operation_token: "capture-validation",
			argument_tokens: [...materializeArguments.map((argument) => argument.token), "--input={{value}}"],
			value: { slot: "provider_targeted_validator", domain: "artifact_path_or_stdin", schema: "https://gentle-ai.dev/schema/review/validator/v1", substitution_location: materializeArguments.length },
		},
	};
	const hostMediatedTransition = { kind: "collect" as const, reason_code: "targeted_validation_required", collect: { inputs: [hostMediatedInput] } };
	const decodedHostMediated = decodeReviewNextTransitionV3(hostMediatedTransition, { v9: true });
	assert.equal(decodedHostMediated.collect?.inputs[0]?.submission?.operationToken, "capture-validation");
	assert.deepEqual(decodedHostMediated.collect?.inputs[0]?.submission?.values, [{
		slot: "provider_targeted_validator",
		domain: "artifact_path_or_stdin",
		schema: "https://gentle-ai.dev/schema/review/validator/v1",
		substitutionLocation: materializeArguments.length,
	}]);
	assert.equal(decodedHostMediated.collect?.inputs[0]?.validationRequest?.requestHash, requestHash);

	// The identical v8 surface (v6/v7/v8 all decode collect inputs alike)
	// rejects the same host-mediated submission: only v9 renders it.
	assert.throws(
		() => decodeReviewNextTransitionV3(hostMediatedTransition, { v6: true }),
		/submission requires the v9 provider contract/,
	);

	const missingRequest = clone(transition);
	delete (missingRequest.collect.inputs[0] as JsonObject).validation_request;
	assert.throws(() => decodeReviewNextTransitionV3(missingRequest, { v5: true }), /validation_request is required/);

	const mismatchedRequestHash = clone(transition);
	((mismatchedRequestHash.collect.inputs[0] as JsonObject).validation_request as JsonObject).request_hash = `sha256:${"0".repeat(64)}`;
	assert.throws(() => decodeReviewNextTransitionV3(mismatchedRequestHash, { v5: true }), /request-hash/);

	const refuter = clone(transition);
	const refuterInput = refuter.collect.inputs[0] as JsonObject;
	refuterInput.name = "provider_refuter";
	refuterInput.schema = "https://gentle-ai.dev/schema/review/refuter/v1";
	refuterInput.capture_operation = "review.capture-refuter";
	assert.throws(() => decodeReviewNextTransitionV3(refuter, { v5: true }), /validation_request.*targeted-validator/);

	const malformedRequest = clone(transition);
	((malformedRequest.collect.inputs[0] as JsonObject).validation_request as JsonObject).unadvertised = true;
	assert.throws(() => decodeReviewNextTransitionV3(malformedRequest, { v5: true }), /not allowed/);

	const weakenedRequest = clone(transition);
	((weakenedRequest.collect.inputs[0] as JsonObject).validation_request as JsonObject).policy_content = "";
	assert.throws(() => decodeReviewNextTransitionV3(weakenedRequest, { v5: true }), /policy_content/);
});

test("status.frozen carries the optional frozen manifest digest", () => {
	const current = devFixture<JsonObject>("status-v5-repository-context.captured.json");
	delete current.receipt;
	if (current.action === "finalize") {
		current.action = "stop";
		delete current.next_transition;
		delete current.forecast;
	}
	assert.equal(typeof (current.frozen as JsonObject | undefined)?.tier, "string", "the captured status carries frozen");
	const digest = `sha256:${"ab".repeat(32)}`;
	(current.frozen as JsonObject).changed_path_manifest_sha256 = digest;
	assert.equal(decodeReviewStatusV3(current).frozen?.changedPathManifestSha256, digest);
	(current.frozen as JsonObject).changed_path_manifest_sha256 = "not-a-digest";
	assert.throws(() => decodeReviewStatusV3(current), /changed_path_manifest_sha256/);
	delete (current.frozen as JsonObject).changed_path_manifest_sha256;
	assert.equal(decodeReviewStatusV3(current).frozen?.changedPathManifestSha256, undefined);
});

test("a capture-result collect input decodes without changed_path_manifest, which the artifact subject digest already binds", () => {
	const status = fixture<JsonObject>("status.fixture.json");
	const transition = clone((status.next_transition ?? {}) as JsonObject);
	const inputs = ((transition.collect as JsonObject | undefined)?.inputs ?? []) as JsonObject[];
	const captureInput = inputs.find((input) => input.capture_operation === "review.capture-result");
	assert.ok(captureInput, "the status fixture carries a capture-result collect input");
	assert.doesNotThrow(() => decodeReviewNextTransitionV3(transition, { v5: true, v6: true }), "with the manifest");
	delete captureInput.changed_path_manifest;
	const decoded = decodeReviewNextTransitionV3(transition, { v5: true, v6: true });
	const decodedInput = decoded.collect?.inputs.find((input) => input.captureOperation === "review.capture-result");
	assert.ok(decodedInput?.artifactSubject?.changedPathManifestSha256, "the digest on the artifact subject is the binding");
	assert.equal(decodedInput?.changedPathManifest, undefined);
	delete captureInput.artifact_subject;
	assert.throws(() => decodeReviewNextTransitionV3(transition, { v5: true, v6: true }), /requires artifact_subject, base_tree, and candidate_tree/);
});

test("status enforces authority/frozen/receipt conditionals and decodes the required repair field", () => {
	const current = devFixture<JsonObject>("status-v5-repository-context.captured.json");
	delete current.receipt;
	if (current.action === "finalize") {
		current.action = "stop";
		delete current.next_transition;
		delete current.forecast;
	}
	const decoded = decodeReviewStatusV3(current);
	assert.equal(decoded.repair.status, "unsupported");
	assert.equal(decoded.authority?.state, "reviewing");
	for (const action of ["collect", "execute"]) {
		const projected = clone(current);
		projected.action = action;
		assert.equal(decodeReviewStatusV3(projected).action, action, "a live transaction's root action names its mandated transition kind");
	}

	const missingAuthority = clone(current);
	delete missingAuthority.authority;
	assert.throws(() => decodeReviewStatusV3(missingAuthority), /requires authority/);

	const compactMissingFrozen = clone(current);
	delete compactMissingFrozen.frozen;
	assert.throws(() => decodeReviewStatusV3(compactMissingFrozen), /requires frozen/);
});

test("next_transition.execute.binding stays open, as its schema declares no properties", () => {
	const withContext = {
		kind: "execute" as const,
		reason_code: "fresh_target_ready",
		execute: {
			operation: "review.start",
			arguments: [{ name: "lineage", value: "review-fixture", token: "--lineage=review-fixture" }],
			preconditions: [{ name: "target_identity", value: `sha256:${"8".repeat(64)}` }],
			binding: { target_identity: `sha256:${"8".repeat(64)}`, repository_context: `rctx1_${"c".repeat(64)}` },
		},
	};
	assert.doesNotThrow(() => decodeReviewNextTransitionV3(withContext));
});
