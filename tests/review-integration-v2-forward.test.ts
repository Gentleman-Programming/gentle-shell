import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	REVIEW_ACKNOWLEDGED_SCHEMA,
	decodeReviewAcknowledgedV1,
	decodeReviewCapabilitiesV2,
	decodeReviewConsentV2,
	decodeReviewConsentV3,
	decodeReviewFailureV2,
	decodeReviewLastEventClosureV1,
	decodeReviewNextTransitionV3,
	decodeReviewRepairV2,
	decodeReviewResultArtifactV2,
	decodeReviewStartV3,
	decodeReviewStartV4,
	decodeReviewStatusV3,
	ReviewNativeContractTooOldError,
} from "../lib/review-integration-v2.ts";
import { capabilitiesV26 } from "./support/capabilities-v26.ts";
import { statusV9 } from "./support/status-v9.ts";
import { NativeReviewCliV216, type ExecFileAdapter } from "../lib/native-review-cli.ts";

const DEV_FIXTURES = join(process.cwd(), "tests", "fixtures", "devbinary");
const V2_FIXTURES = join(process.cwd(), "contracts", "review-integration", "v2", "fixtures");
const CAPTURED_DIGEST = "ffc91d8fa79c869aba9aa3d1ec80edebb5b1744e5a06fef75d4c8b73c0e46bc1";

type JsonObject = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);
const sha = (fill: string): string => `sha256:${fill.repeat(64)}`;

function fixture(root: string, name: string): unknown {
	return JSON.parse(readFileSync(join(root, name), "utf8"));
}

function currentStatusFixture(name: string): Record<string, unknown> {
	const body = statusV9(structuredClone(fixture(DEV_FIXTURES, name)) as Record<string, unknown>);
	if (body.action === "finalize") {
		body.action = "stop";
		const transition = body.next_transition as Record<string, unknown> | undefined;
		if (transition?.kind === "execute") {
			delete body.next_transition;
			delete body.forecast;
		}
	}
	return body;
}

function initialIntendedUntrackedStatusV6(): JsonObject {
	const body = currentStatusFixture("status-v5.captured.json");
	const projection = body.projection as JsonObject;
	const schema = "gentle-ai.review-intended-untracked-selection/v1";
	body.schema = "gentle-ai.review-integration.status/v9";
	body.forecast = {
		horizon: "partial", steps: [{ step: 1, kind: "collect", reason_code: "intended_untracked_selection_required", description: "initial intended-untracked selection required" }],
	};
	body.next_transition = {
		kind: "collect",
		reason_code: "intended_untracked_selection_required",
		collect: { inputs: [{
			name: "intended_untracked_selection", schema, capture_operation: "external.select_intended_untracked",
			arguments: [
				["target_identity", body.target_identity], ["projection", "workspace"], ["base_tree", projection.base_tree],
				["candidate_tree", projection.current_candidate_tree], ["eligible_paths_json", '["docs/selected.md"]'], ["expected_untracked_inventory", sha("e")],
			].map(([name, value]) => ({ name, value })),
			submission: {
				operation_token: "status",
				argument_tokens: ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", "--intended-untracked-selection={{value}}"],
				value: { slot: "intended_untracked_selection", domain: "schema_bound_json", schema, substitution_location: 4 },
			},
		}] },
	};
	return body;
}

test("captured capabilities derived to the supported capabilities/v2.6 retain their schema identity", () => {
	const capabilities = decodeReviewCapabilitiesV2(capabilitiesV26(fixture(DEV_FIXTURES, "capabilities-v2.2.captured.json") as JsonObject), CAPTURED_DIGEST);
	assert.equal(capabilities.packageVersion, "2.4.0-rc.8+fix.verify-attestation-recovery");
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.capabilities/v2.6"), true);
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.status/v6"), true);
});

test("historical v3 status is refused as older than the supported v9 without rewriting fixture bytes", () => {
	assert.throws(
		() => decodeReviewStatusV3(fixture(V2_FIXTURES, "status.fixture.json")),
		(error: unknown) => error instanceof ReviewNativeContractTooOldError
			&& error.message === "gentle-ai native review status/v3 is older than the supported v9 (gentle-ai v4.6.0); update gentle-ai or remove the dev-binary override",
	);
});

test("v5 STATUS rejects malformed receipt status, identity, and extra fields", () => {
	const unsupported = currentStatusFixture("status-v5.captured.json");
	(unsupported.receipt as JsonObject).status = "retired";
	assert.throws(() => decodeReviewStatusV3(unsupported), /status\.receipt\.status/);

	const invalidIdentity = currentStatusFixture("status-v5.captured.json");
	(invalidIdentity.receipt as JsonObject).identity = "not-a-sha256";
	assert.throws(() => decodeReviewStatusV3(invalidIdentity), /status\.receipt\.identity/);

	const extra = currentStatusFixture("status-v5.captured.json");
	(extra.receipt as JsonObject).unexpected = true;
	assert.throws(() => decodeReviewStatusV3(extra), /status\.receipt\.unexpected is not allowed/);
});

test("non compact-v2 STATUS authority fails the ordinary strict decode", () => {
	const body = currentStatusFixture("status-v5-capture-result-submission.captured.json");
	(body.authority as JsonObject).version = "legacy-v1";
	delete body.frozen;
	delete body.authority_target_identity;
	assert.throws(() => decodeReviewStatusV3(body), /status\.authority\.version/);
});

test("captured terminal closure decodes without a compatibility status projection", () => {
	const closure = decodeReviewLastEventClosureV1(
		fixture(DEV_FIXTURES, "last-event-capture-result-approved.captured.json"),
	);
	assert.equal(closure.operation, "review/capture-result");
	assert.equal(closure.state, "approved");
});

test("capabilities reject a protocol minor that disagrees with their exact identity", () => {
	const mutated = capabilitiesV26(fixture(DEV_FIXTURES, "capabilities-v2.2.captured.json") as JsonObject);
	(mutated.protocol as Record<string, unknown>).minor = 5;
	assert.throws(() => decodeReviewCapabilitiesV2(mutated, CAPTURED_DIGEST), /protocol/);
});

test("captured v5 STATUS preserves its provider forecast and collect binding", () => {
	const decoded = decodeReviewStatusV3(currentStatusFixture("status-v5.captured.json"));
	assert.equal(decoded.forecast?.horizon, "partial");
	assert.equal(decoded.nextTransition?.kind, "collect");
	assert.equal(decoded.nextTransition?.collect?.inputs[0]?.captureOperation, "external.select_base_ref");
});

test("captured v5 STATUS retains its opaque repository context reference", () => {
	const decoded = decodeReviewStatusV3(currentStatusFixture("status-v5-repository-context.captured.json"));
	assert.match(decoded.repositoryContext?.handle ?? "", /^rctx1_[0-9a-f]{64}$/);
	assert.equal(decoded.repositoryContext?.targetIdentity, decoded.targetIdentity);
});

test("the singular v5 capture-result submission normalizes to one typed value", () => {
	const decoded = decodeReviewStatusV3(currentStatusFixture("status-v5-capture-result-submission.captured.json"));
	const input = decoded.nextTransition?.collect?.inputs[0];
	assert.equal(input?.captureOperation, "review.capture-result");
	assert.deepEqual(input?.submission?.values, [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", schema: "https://gentle-ai.dev/schema/review/reviewer/v1", substitutionLocation: 7 }]);
});

test("the singular capture-result form rejects competing legacy values", () => {
	const body = currentStatusFixture("status-v5-capture-result-submission.captured.json");
	const input = (((body.next_transition as Record<string, unknown>).collect as Record<string, unknown>).inputs as Record<string, unknown>[])[0]!;
	const submission = input.submission as Record<string, unknown>;
	submission.values = [submission.value];
	assert.throws(() => decodeReviewStatusV3(body), /value/);
});

test("consent/v3 accepts the Pi runtime only when its exact agent binding matches", () => {
	const captured = fixture(DEV_FIXTURES, "consent-v3.captured.json") as Record<string, unknown>;
	const piConsent = decodeReviewConsentV3({ ...captured, agent: "pi" }, "pi");
	assert.equal(piConsent.agent, "pi");
	assert.throws(() => decodeReviewConsentV3(captured, "pi"), /consent\.agent/);
});

test("consent identities remain cross-decoder incompatible", () => {
	const v3 = fixture(DEV_FIXTURES, "consent-v3.captured.json");
	const v2 = fixture(V2_FIXTURES, "consent.fixture.json");
	assert.throws(() => decodeReviewConsentV2(v3), /agent|schema/);
	assert.throws(() => decodeReviewConsentV3(v2), /agent|schema/);
});

test("captured granted START keeps its repository-context event binding", () => {
	const start = decodeReviewStartV3(fixture(DEV_FIXTURES, "start-v3-consent-granted.captured.json"));
	assert.equal(start.state, "reviewing");
	assert.match(start.repositoryContext?.eventId ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("result artifacts retain mutually exclusive reference and path locators", () => {
	const reference = decodeReviewResultArtifactV2(fixture(DEV_FIXTURES, "result-artifact-v2.captured.json"));
	const path = decodeReviewResultArtifactV2(fixture(DEV_FIXTURES, "result-artifact-v2-path.captured.json"));
	assert.match(reference.reference ?? "", /^rart1_[0-9a-f]{64}$/);
	assert.equal(reference.path, undefined);
	assert.equal(path.reference, undefined);
	assert.equal(path.sha256, reference.sha256);
});

test("result artifacts reject a second locator", () => {
	const body = structuredClone(fixture(DEV_FIXTURES, "result-artifact-v2.captured.json")) as Record<string, unknown>;
	body.path = "/store/reviewer-results/00-review-reliability.json";
	assert.throws(() => decodeReviewResultArtifactV2(body), /exactly one/);
});

test("nonuniform role capture closures retain their exact upstream operation identities", () => {
	assert.equal(decodeReviewLastEventClosureV1(fixture(DEV_FIXTURES, "last-event-capture-refuter-approved.captured.json")).operation, "review.capture-refuter");
	assert.equal(decodeReviewLastEventClosureV1(fixture(DEV_FIXTURES, "last-event-capture-validation-approved.captured.json")).operation, "review/capture-validation");
});

test("a v5 forecast requires the next transition and a coherent horizon", () => {
	const orphanForecast = currentStatusFixture("status-v5.captured.json");
	delete orphanForecast.next_transition;
	assert.throws(() => decodeReviewStatusV3(orphanForecast), /forecast/);
	const wrongHorizon = currentStatusFixture("status-v5.captured.json");
	(wrongHorizon.forecast as JsonObject).horizon = "terminal";
	assert.throws(() => decodeReviewStatusV3(wrongHorizon), /horizon/);
	const badStep = currentStatusFixture("status-v5.captured.json");
	((badStep.forecast as JsonObject).steps as JsonObject[])[0]!.step = 2;
	assert.throws(() => decodeReviewStatusV3(badStep), /step/);
});

test("a v5 provider role task input decodes and is confined to external.run_provider_role", () => {
	const body = currentStatusFixture("status-v5.captured.json");
	const transition = body.next_transition as JsonObject;
	const input = ((transition.collect as JsonObject).inputs as JsonObject[])[0]!;
	input.name = "refuter_batch";
	input.schema = "https://gentle-ai.dev/schema/review/refuter/v1";
	input.capture_operation = "external.run_provider_role";
	input.provider_task = { agent: "review-refuter", role: "refuter", prompt: "GENTLE_AI_REVIEW_BINDING {}" };
	const decoded = decodeReviewStatusV3(body);
	assert.deepEqual(decoded.nextTransition?.collect?.inputs[0]?.providerTask, { agent: "review-refuter", role: "refuter", prompt: "GENTLE_AI_REVIEW_BINDING {}" });
	const missing = clone(body);
	delete ((((missing.next_transition as JsonObject).collect as JsonObject).inputs as JsonObject[])[0]!).provider_task;
	assert.throws(() => decodeReviewStatusV3(missing), /provider_task/);
});

test("consent/v3 keeps every v2 semantic guard and rejects agents outside the fixed runtime contract", () => {
	const base = fixture(DEV_FIXTURES, "consent-v3.captured.json") as JsonObject;
	for (const agent of ["kilocode", "future-runtime", ""] as const) {
		assert.throws(() => decodeReviewConsentV3({ ...clone(base), agent }), /agent/);
	}
	const swapped = clone(base);
	swapped.choices = [...(swapped.choices as JsonObject[])].reverse();
	assert.throws(() => decodeReviewConsentV3(swapped), /answer/);
	const wrongTarget = clone(base);
	wrongTarget.target_identity = sha("d");
	assert.throws(() => decodeReviewConsentV3(wrongTarget), /target|invocation/);
});

test("start/v3 repository context event fields stay optional and exact", () => {
	const pinned = decodeReviewStartV3(fixture(V2_FIXTURES, "start.fixture.json"));
	assert.equal(pinned.repositoryContext?.eventId, undefined);
	assert.equal(pinned.repositoryContext?.outcome, undefined);
	const badEvent = clone(fixture(DEV_FIXTURES, "start-v3-consent-granted.captured.json") as JsonObject);
	(badEvent.repository_context as JsonObject).event_id = "not-a-digest";
	assert.throws(() => decodeReviewStartV3(badEvent), /event_id/);
	const badOutcome = clone(fixture(DEV_FIXTURES, "start-v3-consent-granted.captured.json") as JsonObject);
	(badOutcome.repository_context as JsonObject).outcome = "unheard-of";
	assert.throws(() => decodeReviewStartV3(badOutcome), /outcome/);
});

test("a result artifact rejects unknown keys and weakened bindings", () => {
	const base = fixture(DEV_FIXTURES, "result-artifact-v2.captured.json") as JsonObject;
	const extra = clone(base);
	extra.unadvertised = true;
	assert.throws(() => decodeReviewResultArtifactV2(extra), /not allowed/);
	const wrongCapability = clone(base);
	wrongCapability.capability = "review.result_artifact";
	assert.throws(() => decodeReviewResultArtifactV2(wrongCapability), /capability/);
	const foreignLocator = clone(base);
	foreignLocator.reference = `rref1_${"b".repeat(64)}`;
	assert.throws(() => decodeReviewResultArtifactV2(foreignLocator), /reference/);
});

function reviewingStartV4(action: "created" | "replayed" = "created"): JsonObject {
	const body = clone(fixture(DEV_FIXTURES, "start-v3-consent-granted.captured.json") as JsonObject);
	body.schema = "gentle-ai.review-integration.start/v4";
	body.action = action;
	const targetIdentity = (body.repository_context as JsonObject).target_identity as string;
	const baseTree = body.base_tree as string;
	body.next_transition = {
		kind: "execute",
		reason_code: "review_status_required",
		execute: {
			operation: "review.status",
			arguments: [
				{ name: "contract", value: "gentle-ai.review-integration/v2", token: "--contract=gentle-ai.review-integration/v2" },
				{ name: "next-transition", value: "true", token: "--next-transition=true" },
				{ name: "lineage", value: body.lineage_id, token: `--lineage=${body.lineage_id}` },
				{ name: "agent", value: "pi", token: "--agent=pi" },
				{ name: "base-ref", value: baseTree, token: `--base-ref=${baseTree}` },
				{ name: "committed-only", value: "true", token: "--committed-only=true" },
			],
			preconditions: [],
			binding: { target_identity: targetIdentity },
		},
	};
	const execute = (body.next_transition as JsonObject).execute as JsonObject;
	execute.selector_arguments = (execute.arguments as JsonObject[]).slice(-2).map(clone);
	return body;
}

test("capabilities/v2.6 (gentle-ai v4.6.0) is the only supported advertisement and keeps the status/v6 floor", () => {
	const v26 = capabilitiesV26(fixture(DEV_FIXTURES, "capabilities-v2.2.captured.json") as JsonObject);
	v26.schemas = [...(v26.schemas as string[]), "gentle-ai.review-integration.status/v7", "gentle-ai.review-integration.status/v8", "gentle-ai.review-integration.status/v9"];
	const decoded = decodeReviewCapabilitiesV2(v26, CAPTURED_DIGEST);
	assert.equal(decoded.schemas.has("gentle-ai.review-integration.start/v4"), true);
	assert.equal(decoded.schemas.has("gentle-ai.review-integration.start/v3"), false);
	assert.equal(decoded.schemas.has("gentle-ai.review-integration.status/v6"), true);
	// The negotiated floor is status/v6; status/v7-v9 are additive and never required.
	assert.equal(decoded.schemas.has("gentle-ai.review-integration.status/v9"), false);
	const withoutAdditive = clone(v26);
	withoutAdditive.schemas = (withoutAdditive.schemas as string[]).filter((schema) => !/status\/v[789]$/.test(schema));
	assert.equal(decodeReviewCapabilitiesV2(withoutAdditive, CAPTURED_DIGEST).schemas.has("gentle-ai.review-integration.status/v6"), true);
	const missingStatusV6 = clone(v26);
	missingStatusV6.schemas = (missingStatusV6.schemas as string[]).filter((schema) => schema !== "gentle-ai.review-integration.status/v6");
	assert.throws(() => decodeReviewCapabilitiesV2(missingStatusV6, CAPTURED_DIGEST), /status\/v6/);
	// The three identities retired in v2.3 are not required.
	const retiredSchemas = ["gentle-ai.review-final-verification-incident/v1", "gentle-ai.review-receipt/v2", "gentle-ai.review-verification-evidence/v2"];
	for (const schema of retiredSchemas) assert.equal(decoded.schemas.has(schema), false);
});

test("capabilities older than v2.6 are refused with the actionable minimum-version message", () => {
	const base = fixture(DEV_FIXTURES, "capabilities-v2.2.captured.json") as JsonObject;
	for (const [identity, label] of [["capabilities/v2", "capabilities/v2"], ["capabilities/v2.1", "capabilities/v2.1"], ["capabilities/v2.2", "capabilities/v2.2"], ["capabilities/v2.3", "capabilities/v2.3"], ["capabilities/v2.4", "capabilities/v2.4"], ["capabilities/v2.5", "capabilities/v2.5"]]) {
		const older = capabilitiesV26(base);
		older.schema = `gentle-ai.review-integration.${identity}`;
		assert.throws(
			() => decodeReviewCapabilitiesV2(older, CAPTURED_DIGEST),
			(error: unknown) => error instanceof ReviewNativeContractTooOldError
				&& error.message === `gentle-ai native review ${label} is older than the supported v2.6 (gentle-ai v4.6.0); update gentle-ai or remove the dev-binary override`,
			identity,
		);
	}
	// A schema that is not a capabilities minor at all stays an ordinary schema error.
	const unknown = capabilitiesV26(base);
	unknown.schema = "gentle-ai.review-integration.capabilities/v3";
	assert.throws(() => decodeReviewCapabilitiesV2(unknown, CAPTURED_DIGEST), (error: unknown) => error instanceof TypeError && !(error instanceof ReviewNativeContractTooOldError) && /schema/.test(error.message));
});

// status/v9 (gentle-ai v4.6.0) is the only supported status identity; its
// host-mediated role submission lives in next_transition.collect.inputs and is
// covered by tests/review-integration-v2.test.ts's "v9 host-mediated" tests.
test("status/v9 decodes with its exact identity and the eligible untracked inventory", () => {
	const v9 = initialIntendedUntrackedStatusV6();
	v9.eligible_untracked_inventory = sha("e");
	const decoded = decodeReviewStatusV3(v9);
	assert.equal(decoded.raw.schema, "gentle-ai.review-integration.status/v9");
	assert.equal(decoded.eligibleUntrackedInventory, sha("e"));
});

test("status older than v9 is refused with the actionable minimum-version message", () => {
	for (const version of [3, 5, 6, 7, 8]) {
		const older = initialIntendedUntrackedStatusV6();
		older.schema = `gentle-ai.review-integration.status/v${version}`;
		assert.throws(
			() => decodeReviewStatusV3(older),
			(error: unknown) => error instanceof ReviewNativeContractTooOldError
				&& error.message === `gentle-ai native review status/v${version} is older than the supported v9 (gentle-ai v4.6.0); update gentle-ai or remove the dev-binary override`,
			`status/v${version}`,
		);
	}
	// An identity that is not an older status minor stays an ordinary schema error.
	const unknown = initialIntendedUntrackedStatusV6();
	unknown.schema = "gentle-ai.review-integration.status/v10";
	assert.throws(() => decodeReviewStatusV3(unknown), (error: unknown) => error instanceof TypeError && !(error instanceof ReviewNativeContractTooOldError) && /schema/.test(error.message));
});

test("status/v6 decodes and enforces the intended-untracked selection submission", () => {
	const decoded = decodeReviewStatusV3(initialIntendedUntrackedStatusV6());
	const input = decoded.nextTransition?.collect?.inputs[0];
	assert.deepEqual([input?.schema, input?.captureOperation, input?.arguments, input?.submission], [
		"gentle-ai.review-intended-untracked-selection/v1", "external.select_intended_untracked", [
			{ name: "target_identity", value: decoded.targetIdentity }, { name: "projection", value: "workspace" },
			{ name: "base_tree", value: decoded.projection.baseTree }, { name: "candidate_tree", value: decoded.projection.currentCandidateTree },
			{ name: "eligible_paths_json", value: '["docs/selected.md"]' }, { name: "expected_untracked_inventory", value: sha("e") },
		], {
			operationToken: "status",
			argumentTokens: ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", "--intended-untracked-selection={{value}}"],
			values: [{ slot: "intended_untracked_selection", domain: "schema_bound_json", schema: "gentle-ai.review-intended-untracked-selection/v1", substitutionLocation: 4 }],
		},
	]);
	const submission = (body: JsonObject) => (((body.next_transition as JsonObject).collect as JsonObject).inputs as JsonObject[])[0]!.submission as JsonObject;
	const cases: Array<[string, (value: JsonObject) => void, RegExp]> = [
		["operation", (value) => { value.operation_token = "start"; }, /operation/],
		["competing values", (value) => { value.values = [clone(value.value)]; }, /value/],
		["slot", (value) => { delete (value.value as JsonObject).slot; }, /slot/],
		["schema", (value) => { (value.value as JsonObject).schema = "gentle-ai.review-intended-untracked-selection/v2"; }, /schema/],
		["placeholder", (value) => { (value.argument_tokens as string[])[4] = "--intended-untracked-selection={{selection}}"; }, /value|substitution/],
		["location", (value) => { (value.value as JsonObject).substitution_location = 3; }, /substitution/],
	];
	for (const [name, mutate, pattern] of cases) {
		const body = initialIntendedUntrackedStatusV6();
		mutate(submission(body));
		assert.throws(() => decodeReviewStatusV3(body), pattern, name);
	}
	const collectInput = (body: JsonObject) => (((body.next_transition as JsonObject).collect as JsonObject).inputs as JsonObject[])[0]!;
	const artifactSubject = { schema: "gentle-ai.review-artifact-subject/v2", subject_hash: sha("a"), lineage_id: "review-test", authority_revision: sha("b"), target_identity: sha("c"), base_tree: "a".repeat(40), candidate_tree: "b".repeat(40), changed_path_manifest_sha256: sha("d"), lens: "review-risk", selected_order: 0 };
	const incompatibleCaptures: ReadonlyArray<readonly [string, JsonObject]> = [
		["review.capture-result", { schema: "https://gentle-ai.dev/schema/review/reviewer/v1", artifact_subject: artifactSubject, base_tree: "a".repeat(40), candidate_tree: "b".repeat(40), changed_path_manifest: [{ path: "x.ts", status: "M", old_mode: "100644", new_mode: "100644", deleted: false, type_changed: false, mode_only: false, intended_untracked: false }] }],
		["review.capture-correction-plan", { schema: "gentle-ai.review-correction-plan/v1" }],
	];
	for (const [captureOperation, fields] of incompatibleCaptures) {
		const body = initialIntendedUntrackedStatusV6();
		Object.assign(collectInput(body), { capture_operation: captureOperation, ...fields });
		assert.throws(() => decodeReviewStatusV3(body), /operation_token/, captureOperation);
	}

	const mismatchedBindings: ReadonlyArray<readonly [string, string]> = [
		["name", "renamed_selection"],
		["schema", "gentle-ai.review-intended-untracked-selection/v0"],
	];
	for (const [field, value] of mismatchedBindings) {
		const body = initialIntendedUntrackedStatusV6();
		collectInput(body)[field] = value;
		assert.throws(() => decodeReviewStatusV3(body), /intended_untracked_selection binding/, field);
	}
});

function queuedTargetStatusAdapter(): { adapter: ExecFileAdapter; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push([...request.arguments]);
			return { stdout: JSON.stringify(currentStatusFixture("status-v5.captured.json")), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

function targetStatusClient(adapter: ExecFileAdapter): NativeReviewCliV216 {
	return new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024);
}

const SUBMITTED_PROVIDER_TOKENS = ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", "--intended-untracked-selection={{value}}"];

test("targetStatus appends the forwarded base-ref/committed-only pair after intended-untracked submission tokens", async () => {
	const queue = queuedTargetStatusAdapter();
	await targetStatusClient(queue.adapter).targetStatus({
		cwd: "/repo",
		baseRef: "deadbeef",
		committedOnly: true,
		intendedUntrackedSelection: { argumentTokens: SUBMITTED_PROVIDER_TOKENS, value: '{"selection":true}' },
	});
	assert.deepEqual(queue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--base-ref", "deadbeef", "--committed-only",
	]);
});

test("targetStatus leaves the intended-untracked submission argv unchanged when no baseRef is forwarded", async () => {
	const queue = queuedTargetStatusAdapter();
	await targetStatusClient(queue.adapter).targetStatus({
		cwd: "/repo",
		intendedUntrackedSelection: { argumentTokens: SUBMITTED_PROVIDER_TOKENS, value: '{"selection":true}' },
	});
	assert.deepEqual(queue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
	]);
});

test("targetStatus rejects a forwarded baseRef that conflicts with a base-ref the submission already carries", async () => {
	const queue = queuedTargetStatusAdapter();
	const tokensWithBaseRef = [...SUBMITTED_PROVIDER_TOKENS, "--base-ref=cafebabe"];
	await assert.rejects(
		() => targetStatusClient(queue.adapter).targetStatus({
			cwd: "/repo", baseRef: "deadbeef", committedOnly: true,
			intendedUntrackedSelection: { argumentTokens: tokensWithBaseRef, value: '{"selection":true}' },
		}),
		TypeError,
	);
	assert.equal(queue.calls.length, 0);

	// Same value on both sides is not a conflict, but the submission still lacks
	// --committed-only: T3 appends it so the selector stays complete.
	const sameValueQueue = queuedTargetStatusAdapter();
	await targetStatusClient(sameValueQueue.adapter).targetStatus({
		cwd: "/repo", baseRef: "cafebabe", committedOnly: true,
		intendedUntrackedSelection: { argumentTokens: tokensWithBaseRef, value: '{"selection":true}' },
	});
	assert.deepEqual(sameValueQueue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--base-ref=cafebabe",
		"--committed-only",
	]);
});

test("targetStatus appends --committed-only when the submission's same base-ref is missing it, and skips it when already present", async () => {
	const missingQueue = queuedTargetStatusAdapter();
	const tokensWithBaseRefOnly = [...SUBMITTED_PROVIDER_TOKENS, "--base-ref", "cafebabe"];
	await targetStatusClient(missingQueue.adapter).targetStatus({
		cwd: "/repo", baseRef: "cafebabe", committedOnly: true,
		intendedUntrackedSelection: { argumentTokens: tokensWithBaseRefOnly, value: '{"selection":true}' },
	});
	assert.deepEqual(missingQueue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--base-ref", "cafebabe",
		"--committed-only",
	]);

	const presentQueue = queuedTargetStatusAdapter();
	const tokensWithBoth = [...SUBMITTED_PROVIDER_TOKENS, "--base-ref=cafebabe", "--committed-only=true"];
	await targetStatusClient(presentQueue.adapter).targetStatus({
		cwd: "/repo", baseRef: "cafebabe", committedOnly: true,
		intendedUntrackedSelection: { argumentTokens: tokensWithBoth, value: '{"selection":true}' },
	});
	assert.deepEqual(presentQueue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--base-ref=cafebabe", "--committed-only=true",
	]);

	const committedOnlyQueue = queuedTargetStatusAdapter();
	const tokensWithCommittedOnly = [...SUBMITTED_PROVIDER_TOKENS, "--committed-only"];
	await targetStatusClient(committedOnlyQueue.adapter).targetStatus({
		cwd: "/repo", baseRef: "cafebabe", committedOnly: true,
		intendedUntrackedSelection: { argumentTokens: tokensWithCommittedOnly, value: '{"selection":true}' },
	});
	assert.deepEqual(committedOnlyQueue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--committed-only",
		"--base-ref", "cafebabe",
	]);
});

test("targetStatus forwards --lineage on the submitted branch, skips a matching value, and rejects a conflicting one", async () => {
	const forwardedQueue = queuedTargetStatusAdapter();
	await targetStatusClient(forwardedQueue.adapter).targetStatus({
		cwd: "/repo", lineageId: "review-abc123",
		intendedUntrackedSelection: { argumentTokens: SUBMITTED_PROVIDER_TOKENS, value: '{"selection":true}' },
	});
	assert.deepEqual(forwardedQueue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--lineage", "review-abc123",
	]);

	const sameValueQueue = queuedTargetStatusAdapter();
	const tokensWithLineage = [...SUBMITTED_PROVIDER_TOKENS, "--lineage=review-abc123"];
	await targetStatusClient(sameValueQueue.adapter).targetStatus({
		cwd: "/repo", lineageId: "review-abc123",
		intendedUntrackedSelection: { argumentTokens: tokensWithLineage, value: '{"selection":true}' },
	});
	assert.deepEqual(sameValueQueue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--lineage=review-abc123",
	]);

	const conflictQueue = queuedTargetStatusAdapter();
	await assert.rejects(
		() => targetStatusClient(conflictQueue.adapter).targetStatus({
			cwd: "/repo", lineageId: "review-other",
			intendedUntrackedSelection: { argumentTokens: tokensWithLineage, value: '{"selection":true}' },
		}),
		TypeError,
	);
	assert.equal(conflictQueue.calls.length, 0);
});

test("targetStatus forwards base-ref and lineage together on the submitted branch, base-ref first", async () => {
	const queue = queuedTargetStatusAdapter();
	await targetStatusClient(queue.adapter).targetStatus({
		cwd: "/repo", baseRef: "deadbeef", committedOnly: true, lineageId: "review-abc123",
		intendedUntrackedSelection: { argumentTokens: SUBMITTED_PROVIDER_TOKENS, value: '{"selection":true}' },
	});
	assert.deepEqual(queue.calls[0], [
		"review", "status", "--cwd", "/repo",
		"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", '--intended-untracked-selection={"selection":true}',
		"--base-ref", "deadbeef", "--committed-only",
		"--lineage", "review-abc123",
	]);
});

test("targetStatus rejects a dangling or empty --base-ref/--lineage in the submitted tokens", async () => {
	for (const tokens of [
		[...SUBMITTED_PROVIDER_TOKENS, "--base-ref"],
		[...SUBMITTED_PROVIDER_TOKENS, "--base-ref="],
		[...SUBMITTED_PROVIDER_TOKENS, "--lineage"],
		[...SUBMITTED_PROVIDER_TOKENS, "--lineage="],
	]) {
		const queue = queuedTargetStatusAdapter();
		await assert.rejects(
			() => targetStatusClient(queue.adapter).targetStatus({
				cwd: "/repo",
				intendedUntrackedSelection: { argumentTokens: tokens, value: '{"selection":true}' },
			}),
			TypeError,
			JSON.stringify(tokens),
		);
		assert.equal(queue.calls.length, 0, JSON.stringify(tokens));
	}
});

test("targetStatus rejects ambiguous or malformed provider selectors before executing STATUS", async () => {
	for (const tokens of [
		[...SUBMITTED_PROVIDER_TOKENS, "--committed-only=false"],
		[...SUBMITTED_PROVIDER_TOKENS, "--committed-only=garbage"],
		[...SUBMITTED_PROVIDER_TOKENS, "--committed-only=true", "--committed-only=true"],
		[...SUBMITTED_PROVIDER_TOKENS, "--committed-only", "--committed-only=true"],
		[...SUBMITTED_PROVIDER_TOKENS, "--base-ref=deadbeef", "--base-ref", "deadbeef"],
		[...SUBMITTED_PROVIDER_TOKENS, "--lineage=review-a", "--lineage", "review-a"],
		[...SUBMITTED_PROVIDER_TOKENS, "--base-ref", "--lineage=review-a"],
		[...SUBMITTED_PROVIDER_TOKENS, "--lineage", "--base-ref=deadbeef"],
	]) {
		const queue = queuedTargetStatusAdapter();
		await assert.rejects(() => targetStatusClient(queue.adapter).targetStatus({
			cwd: "/repo", intendedUntrackedSelection: { argumentTokens: tokens, value: '{"selection":true}' },
		}), TypeError, JSON.stringify(tokens));
		assert.equal(queue.calls.length, 0, JSON.stringify(tokens));
	}
});

test("START/v4 accepts only its reviewing status continuation and preserves v3 strictness", () => {
	for (const action of ["created", "replayed"] as const) {
		const start = reviewingStartV4(action);
		const decoded = decodeReviewStartV4(start);
		assert.equal(decoded.nextTransition?.execute?.operation, "review.status");
		assert.deepEqual(decoded.nextTransition?.execute?.arguments, [
			{ name: "contract", value: "gentle-ai.review-integration/v2", token: "--contract=gentle-ai.review-integration/v2" },
			{ name: "next-transition", value: "true", token: "--next-transition=true" },
			{ name: "lineage", value: decoded.lineageId, token: `--lineage=${decoded.lineageId}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "base-ref", value: decoded.baseTree, token: `--base-ref=${decoded.baseTree}` },
			{ name: "committed-only", value: "true", token: "--committed-only=true" },
		]);
		assert.deepEqual(decoded.nextTransition?.execute?.selectorArguments, [
			{ name: "base-ref", value: decoded.baseTree, token: `--base-ref=${decoded.baseTree}` },
			{ name: "committed-only", value: "true", token: "--committed-only=true" },
		]);
	}

	const v3 = reviewingStartV4();
	v3.schema = "gentle-ai.review-integration.start/v3";
	assert.throws(() => decodeReviewStartV3(v3), /next_transition is not allowed/);

	const wrongOperation = reviewingStartV4();
	((wrongOperation.next_transition as JsonObject).execute as JsonObject).operation = "review.start";
	assert.throws(() => decodeReviewStartV4(wrongOperation), /review.status/);
});

test("START/v4 falls back to the frozen overlay target when repository_context is absent", () => {
	// A replayed reviewing START must not carry repository_context, so the
	// binding assert has to derive the frozen target from the overlay identity.
	const start = reviewingStartV4("replayed");
	const execute = (start.next_transition as JsonObject).execute as JsonObject;
	const targetIdentity = (start.repository_context as JsonObject).target_identity as string;
	delete start.repository_context;
	start.target_mode = "base-workspace-overlay";
	start.target_identity = targetIdentity;
	const arguments_ = execute.arguments as JsonObject[];
	const committedOnly = arguments_.find((argument) => argument.name === "committed-only")!;
	committedOnly.name = "workspace-overlay";
	committedOnly.token = "--workspace-overlay=true";
	execute.selector_arguments = arguments_.slice(-2).map(clone);
	const decoded = decodeReviewStartV4(start);
	assert.equal(decoded.targetIdentity, targetIdentity);
	assert.equal(decoded.repositoryContext, undefined);
	assert.equal(decoded.nextTransition?.execute?.binding.targetIdentity, targetIdentity);

	const unbound = reviewingStartV4("replayed");
	delete unbound.repository_context;
	assert.throws(() => decodeReviewStartV4(unbound), /repository_context is required/);
});

test("START/v4 rejects status vectors that drift from frozen bindings", () => {
	const bindingTarget = reviewingStartV4();
	(((bindingTarget.next_transition as JsonObject).execute as JsonObject).binding as JsonObject).target_identity = sha("d");
	assert.throws(() => decodeReviewStartV4(bindingTarget), /binding/);

	for (const [name, value] of [["lineage", "review-other"], ["base-ref", "a".repeat(40)]] as const) {
		const start = reviewingStartV4();
		const arguments_ = ((start.next_transition as JsonObject).execute as JsonObject).arguments as JsonObject[];
		arguments_.find((argument) => argument.name === name)!.value = value;
		assert.throws(() => decodeReviewStartV4(start), /binding/);
	}

	for (const [name, value, token] of [["projection", "staged", "--projection=staged"], ["target", sha("d"), `--target=${sha("d")}`]] as const) {
		const start = reviewingStartV4();
		const arguments_ = ((start.next_transition as JsonObject).execute as JsonObject).arguments as JsonObject[];
		arguments_.push({ name, value, token });
		assert.throws(() => decodeReviewStartV4(start), /binding/);
	}

	const bindingLineage = reviewingStartV4();
	(((bindingLineage.next_transition as JsonObject).execute as JsonObject).binding as JsonObject).lineage_id = "review-other";
	assert.throws(() => decodeReviewStartV4(bindingLineage), /binding/);

	const outerTarget = reviewingStartV4();
	outerTarget.target_mode = "base-workspace-overlay";
	outerTarget.target_identity = sha("d");
	assert.throws(() => decodeReviewStartV4(outerTarget), /binding/);

	const artifactTarget = reviewingStartV4();
	(artifactTarget.artifact_subjects as JsonObject[])[0]!.target_identity = sha("d");
	assert.throws(() => decodeReviewStartV4(artifactTarget), /binding/);

	const duplicate = reviewingStartV4();
	const arguments_ = ((duplicate.next_transition as JsonObject).execute as JsonObject).arguments as JsonObject[];
	arguments_.push(clone(arguments_.find((argument) => argument.name === "lineage")!));
	assert.throws(() => decodeReviewStartV4(duplicate), /binding/);
});

test("START/v4 rejects incomplete or incoherent provider-owned status selectors", () => {
	const execute = (start: JsonObject) => (start.next_transition as JsonObject).execute as JsonObject;
	const rows = (start: JsonObject, field: "arguments" | "selector_arguments") => execute(start)[field] as JsonObject[];
	for (const change of [
		(start: JsonObject) => delete execute(start).selector_arguments,
		(start: JsonObject) => rows(start, "selector_arguments").splice(1, 1),
		(start: JsonObject) => {
			for (const field of ["arguments", "selector_arguments"] as const) rows(start, field).find((row) => row.name === "committed-only")!.value = "false";
		},
		(start: JsonObject) => rows(start, "selector_arguments")[1]!.token = "--committed-only",
	]) {
		const start = reviewingStartV4();
		change(start);
		assert.throws(() => decodeReviewStartV4(start), /selector|binding/);
	}
	for (const [name, value] of [["contract", "other"], ["next-transition", "false"], ["lineage", "review-other"], ["agent", "other"]] as const) {
		const missing = reviewingStartV4();
		rows(missing, "arguments").splice(rows(missing, "arguments").findIndex((row) => row.name === name), 1);
		assert.throws(() => decodeReviewStartV4(missing), /binding/);
		const wrong = reviewingStartV4();
		rows(wrong, "arguments").find((row) => row.name === name)!.value = value;
		assert.throws(() => decodeReviewStartV4(wrong), /binding/);
	}
	const controlToken = reviewingStartV4(); rows(controlToken, "arguments")[0]!.token = "--contract=other";
	assert.throws(() => decodeReviewStartV4(controlToken), /binding/);
});

test("START/v4 closed approval keeps acknowledgement but forbids a continuation", () => {
	const closed = clone(fixture(DEV_FIXTURES, "start-v3-zero-lens-closed.captured.json") as JsonObject);
	closed.schema = "gentle-ai.review-integration.start/v4";
	closed.acknowledgement = { provider_owned: true };
	assert.deepEqual(decodeReviewStartV4(closed).raw.acknowledgement, { provider_owned: true });

	closed.next_transition = (reviewingStartV4().next_transition as JsonObject);
	assert.throws(() => decodeReviewStartV4(closed), /closed approved zero-lens START cannot carry next_transition/);
});

// ---------------------------------------------------------------------------
// review-acknowledged/v1 — gentle-ai #3947: the exact acknowledgement burn
// prints one typed envelope instead of nothing. Provenance:
// tests/fixtures/devbinary/review-acknowledged.provenance.md.
// ---------------------------------------------------------------------------

const ACKNOWLEDGED_FIXTURE = "review-acknowledged-v1.captured.json";

function acknowledgedFixture(): JsonObject {
	return clone(fixture(DEV_FIXTURES, ACKNOWLEDGED_FIXTURE) as JsonObject);
}

test("review-acknowledged/v1 decodes the captured burn envelope exactly", () => {
	const raw = acknowledgedFixture();
	const decoded = decodeReviewAcknowledgedV1(raw);
	assert.deepEqual(decoded, {
		schema: "gentle-ai.review-acknowledged/v1",
		operation: "review/acknowledge-approved",
		action: "acknowledged",
		lineageId: "review-3ec95251db75f626",
		targetIdentity: "sha256:b505dcd8d82395c053c9786935e11e0e235cbdecca4f1f46f98c768ea6248d3d",
		consumedRevision: "sha256:9732b1c3526bfecd3851093239241145c970cc126acea59bfaf14133214b60ee",
		authority: "burned",
		raw,
	});
	assert.equal(decodeReviewAcknowledgedV1(raw, { lineageId: decoded.lineageId, targetIdentity: decoded.targetIdentity, revision: decoded.consumedRevision }).authority, "burned");
	assert.equal(REVIEW_ACKNOWLEDGED_SCHEMA, "gentle-ai.review-acknowledged/v1");
});

test("review-acknowledged/v1 rejects identity drift, foreign fields, and a binding that names another burn", () => {
	const cases: Array<[string, (body: JsonObject) => void, RegExp]> = [
		["schema", (body) => { body.schema = "gentle-ai.review-acknowledged/v2"; }, /schema/],
		["operation", (body) => { body.operation = "review.acknowledge-approved"; }, /operation/],
		["action", (body) => { body.action = "replayed"; }, /action/],
		["authority", (body) => { body.authority = "retained"; }, /authority/],
		["unknown key", (body) => { body.receipt = { status: "created" }; }, /receipt/],
		["missing consumed revision", (body) => { delete body.consumed_revision; }, /consumed_revision/],
		["malformed target", (body) => { body.target_identity = "b505dcd8"; }, /target_identity/],
		["malformed lineage", (body) => { body.lineage_id = "Review_3ec95251"; }, /lineage_id/],
	];
	for (const [name, mutate, pattern] of cases) {
		const body = acknowledgedFixture();
		mutate(body);
		assert.throws(() => decodeReviewAcknowledgedV1(body), pattern, name);
	}
	const raw = acknowledgedFixture();
	assert.throws(() => decodeReviewAcknowledgedV1(raw, { lineageId: "review-other" }), /lineage/);
	assert.throws(() => decodeReviewAcknowledgedV1(raw, { targetIdentity: sha("b") }), /target/);
	assert.throws(() => decodeReviewAcknowledgedV1(raw, { revision: sha("c") }), /revision/);
	assert.throws(() => decodeReviewAcknowledgedV1(null), /object/);
	assert.throws(() => decodeReviewAcknowledgedV1("{}"), /object/);
});

test("review-acknowledged/v1 is disjoint from every prior captured identity in both directions", () => {
	const priorFixtures = readdirSync(DEV_FIXTURES).filter((name) => name.endsWith(".json") && name !== ACKNOWLEDGED_FIXTURE);
	assert.ok(priorFixtures.length >= 15, "the prior captured corpus must be present");
	for (const name of priorFixtures) {
		assert.throws(() => decodeReviewAcknowledgedV1(fixture(DEV_FIXTURES, name)), /schema|object/, `${name} must not decode as an acknowledgement`);
	}
	const acknowledged = acknowledgedFixture();
	const priorDecoders: Array<[string, (value: unknown) => unknown]> = [
		["status/v3", decodeReviewStatusV3],
		["start/v3", decodeReviewStartV3],
		["start/v4", decodeReviewStartV4],
		["capabilities/v2", (value) => decodeReviewCapabilitiesV2(value, CAPTURED_DIGEST)],
		["consent/v2", decodeReviewConsentV2],
		["consent/v3", decodeReviewConsentV3],
		["last-event-closure/v1", decodeReviewLastEventClosureV1],
		["result-artifact/v2", decodeReviewResultArtifactV2],
		["failure/v2", decodeReviewFailureV2],
		["next-transition/v3", decodeReviewNextTransitionV3],
		["repair/v2", decodeReviewRepairV2],
	];
	for (const [name, decoder] of priorDecoders) {
		assert.throws(() => decoder(clone(acknowledged)), `${name} must reject the acknowledged envelope`);
	}
});

// Producer-shaped projection: gentle-ai d521b5e, target_status.go and
// last-event-closure.schema.json#/properties/escalation (not a live capture).
function escalatedStatusV7(): JsonObject {
	const body = currentStatusFixture("status-v5-capture-result-submission.captured.json");
	body.schema = "gentle-ai.review-integration.status/v9";
	(body.authority as JsonObject).state = "escalated";
	body.action = "stop";
	body.replayability = "manual_action_required";
	body.next_transition = { kind: "stop", reason_code: "escalated" };
	delete body.forecast;
	body.escalation = { cause: "unknown_causality", finding_ids: ["R1"] };
	return body;
}

test("v7 escalation is typed metadata and preserves native stop authority", () => {
	const body = escalatedStatusV7();
	const decoded = decodeReviewStatusV3(body);
	assert.deepEqual(decoded.escalation, { cause: "unknown_causality", findingIds: ["R1"] });
	delete body.escalation;
	const older = decodeReviewStatusV3(body);
	assert.deepEqual({ ...decoded, escalation: undefined, raw: undefined }, { ...older, escalation: undefined, raw: undefined });
	assert.equal(decoded.action, "stop");
	assert.equal(decoded.authority?.state, "escalated");
	assert.deepEqual(decoded.nextTransition, { kind: "stop", reasonCode: "escalated" });
});

test("v7 escalation strictly decodes all causes and optional refuter evidence", () => {
	for (const cause of ["unknown_causality", "insufficient_evidence", "missing_refuter_outcome", "targeted_validator_rejected", "correction_budget_exceeded", "unresolved_severe_findings"]) {
		const body = escalatedStatusV7();
		const rows = ["corroborated", "refuted", "inconclusive"].map((outcome) => ({ finding_id: "R2", outcome, proof: "observed evidence" }));
		body.escalation = { cause, finding_ids: [], refuter_outcomes: rows };
		assert.deepEqual(decodeReviewStatusV3(body).escalation, { cause, findingIds: [], refuterOutcomes: rows.map(({ finding_id, ...row }) => ({ findingId: finding_id, ...row })) });
	}
	for (const escalation of [null, undefined, [], {}, { cause: "future", finding_ids: [] }, { cause: "unknown_causality" }, { cause: "unknown_causality", finding_ids: [""] }, { cause: "unknown_causality", finding_ids: "R1" }, { cause: "unknown_causality", finding_ids: [], extra: true }]) {
		assert.throws(() => decodeReviewStatusV3({ ...escalatedStatusV7(), escalation }), /status\.escalation/);
	}
	for (const refuter_outcomes of [null, undefined, {}, [null], [{}], [{ finding_id: "R1", outcome: "future", proof: "proof" }], [{ finding_id: "", outcome: "refuted", proof: "proof" }], [{ finding_id: "R1", outcome: "refuted", proof: "" }], [{ finding_id: "R1", outcome: "refuted", proof: "proof", extra: true }]]) {
		assert.throws(() => decodeReviewStatusV3({ ...escalatedStatusV7(), escalation: { cause: "missing_refuter_outcome", finding_ids: ["R1"], refuter_outcomes } }), /refuter_outcomes/);
	}
});

test("START/v4 accepts every risk reason code and signal the published start schema allows", () => {
	// gentle-ai publishes dangerous_sink (code and signal) and agent_escalation
	// (code and signal) in start-v4.schema.json; a high-risk START that names
	// them must decode instead of failing as schema-incompatible (#5374).
	const start = reviewingStartV4();
	start.risk_reasons = [
		{ code: "dangerous_sink", signal: "dangerous_sink", path: "auth/session.py" },
		{ code: "hot_path", signal: "auth", path: "auth/session.py" },
		{ code: "process_boundary", signal: "shell_process", path: "auth/session.py" },
		{ code: "agent_escalation", signal: "agent_escalation" },
	];
	const decoded = decodeReviewStartV4(start);
	assert.deepEqual(decoded.riskReasons.map((reason) => reason.code), ["dangerous_sink", "hot_path", "process_boundary", "agent_escalation"]);
	assert.deepEqual(decoded.riskReasons.map((reason) => reason.signal), ["dangerous_sink", "auth", "shell_process", "agent_escalation"]);

	const unknown = reviewingStartV4();
	unknown.risk_reasons = [{ code: "code_from_a_newer_cli" }];
	assert.throws(() => decodeReviewStartV4(unknown), /risk_reasons\[0\]\.code is unsupported/);
});

// A base-diff target keeps its selector in the intended-untracked submission
// (provider-issued, exact forms only), so re-entering STATUS resolves the same
// target instead of the workspace candidate.
const PROVIDER_PREFIX = ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi"];
const SELECTION_TOKEN = "--intended-untracked-selection={{value}}";
const TREE = "a".repeat(40);

function intendedUntrackedSubmissionStatus(selector: readonly string[], location?: number): JsonObject {
	const body = initialIntendedUntrackedStatusV6();
	const input = ((body.next_transition as JsonObject).collect as JsonObject).inputs as JsonObject[];
	const submission = input[0]!.submission as JsonObject;
	const tokens = [...PROVIDER_PREFIX, ...selector, SELECTION_TOKEN];
	submission.argument_tokens = tokens;
	(submission.value as JsonObject).substitution_location = location ?? tokens.length - 1;
	return body;
}

function decodedSubmissionTokens(body: JsonObject, boundSelectionLineage?: string): readonly string[] {
	const decoded = decodeReviewStatusV3(body, { boundSelectionLineage });
	const input = decoded.nextTransition?.kind === "collect" ? decoded.nextTransition.collect?.inputs[0] : undefined;
	return input?.submission?.argumentTokens ?? [];
}

test("status/v6 intended-untracked submission accepts the workspace and provider-issued base-diff selectors", () => {
	assert.deepEqual(decodedSubmissionTokens(intendedUntrackedSubmissionStatus(["--projection=workspace"])), [...PROVIDER_PREFIX, "--projection=workspace", SELECTION_TOKEN]);
	for (const scope of ["--committed-only=true", "--workspace-overlay=true"]) {
		const selector = [`--base-ref=${TREE}`, scope];
		assert.deepEqual(decodedSubmissionTokens(intendedUntrackedSubmissionStatus(selector)), [...PROVIDER_PREFIX, ...selector, SELECTION_TOKEN]);
	}
	assert.deepEqual(decodedSubmissionTokens(intendedUntrackedSubmissionStatus([`--base-ref=${"b".repeat(64)}`, "--committed-only=true"])).length, 6);
});

test("status/v6 intended-untracked submission rejects any other selector or substitution location", () => {
	for (const selector of [
		["--projection=staged"],
		["--base-ref=HEAD", "--committed-only=true"],
		[`--base-ref=${TREE}`],
		["--committed-only=true"],
		[],
		[`--base-ref=${TREE}`, "--committed-only=true", "--projection=workspace"],
	]) {
		assert.throws(() => decodeReviewStatusV3(intendedUntrackedSubmissionStatus(selector)), /argument_tokens|substitution/, selector.join(" "));
	}
	assert.throws(() => decodeReviewStatusV3(intendedUntrackedSubmissionStatus([`--base-ref=${TREE}`, "--committed-only=true"], 4)), /substitution_location/);
});

test("#6221 STATUS accepts the exact workspace and committed bound tuples without rewriting their bytes", () => {
	for (const selector of [["--projection=workspace"], [`--base-ref=${TREE}`, "--committed-only=true"]]) {
		const tokens = ["--lineage=review-6221", ...selector];
		const body = boundUntrackedSubmissionStatus(tokens);
		assert.throws(() => decodeReviewStatusV3(body), /argument_tokens/, "unnegotiated v9 keeps its original closed tuple");
		assert.throws(() => decodedSubmissionTokens(body, "review-other"), /argument_tokens/, "the explicitly requested lineage must match the returned authority");
		assert.deepEqual(decodedSubmissionTokens(body, "review-6221"), [...PROVIDER_PREFIX, ...tokens, SELECTION_TOKEN]);
	}
});

function boundUntrackedSubmissionStatus(selector: readonly string[], location?: number): JsonObject {
	const body = intendedUntrackedSubmissionStatus(selector, location);
	body.applicability = "current_target";
	body.authority = { version: "compact-v2", lineage_id: "review-6221", state: "escalated", generation: 1, revision: sha("d") };
	body.frozen = { tier: "medium", original_changed_lines: 4, correction_budget: 2 };
	(body.projection as JsonObject).base_tree = TREE;
	if (selector.some(token => token.startsWith("--base-ref="))) (body.projection as JsonObject).kind = "base-diff";
	const input = ((body.next_transition as JsonObject).collect as JsonObject).inputs as JsonObject[];
	(input[0]!.arguments as JsonObject[])[2]!.value = TREE;
	return body;
}

test("#6221 STATUS rejects bound tuples with invalid lineage, target selector or JSON index", () => {
	for (const selector of [
		["--lineage=review-other", "--projection=workspace"],
		["--projection=workspace", "--lineage=review-6221"],
		["--lineage=review-6221", "--lineage=review-6221"],
		["--lineage", "review-6221", "--projection=workspace"],
		["--lineage=review-6221", "--projection=staged"],
		["--lineage=review-6221", `--base-ref=${"b".repeat(40)}`, "--committed-only=true"],
	]) assert.throws(() => decodedSubmissionTokens(boundUntrackedSubmissionStatus(selector), "review-6221"), /argument_tokens/, selector.join(" "));
	const workspace = ["--lineage=review-6221", "--projection=workspace"];
	assert.throws(() => decodedSubmissionTokens(intendedUntrackedSubmissionStatus(workspace), "review-6221"), /argument_tokens/);
	assert.throws(() => decodedSubmissionTokens(boundUntrackedSubmissionStatus(workspace, 4), "review-6221"), /substitution_location/);
	assert.throws(() => decodedSubmissionTokens(boundUntrackedSubmissionStatus(["--lineage=review-6221", `--base-ref=${TREE}`, "--committed-only=true"], 5), "review-6221"), /substitution_location/);
});

test("targetStatus runs a provider-issued base-diff submission as issued instead of re-forwarding the request base-ref", async () => {
	const queue = queuedTargetStatusAdapter();
	const tokens = [...PROVIDER_PREFIX, `--base-ref=${TREE}`, "--committed-only=true", SELECTION_TOKEN];
	await targetStatusClient(queue.adapter).targetStatus({
		cwd: "/repo", baseRef: "deadbeef", committedOnly: true,
		intendedUntrackedSelection: { argumentTokens: tokens, value: '{"selection":true}' },
	});
	assert.deepEqual(queue.calls[0], [
		"review", "status", "--cwd", "/repo",
		...PROVIDER_PREFIX, `--base-ref=${TREE}`, "--committed-only=true", '--intended-untracked-selection={"selection":true}',
	]);
});
