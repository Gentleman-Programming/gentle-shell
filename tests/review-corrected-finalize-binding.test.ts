import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { assertReviewLastEventClosureBinding, decodeReviewLastEventClosureV1, type ReviewStatusV3 } from "../lib/review-integration-v2.ts";

const CAPTURED_FIXTURES = join(process.cwd(), "tests", "fixtures", "devbinary");

function captured(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(CAPTURED_FIXTURES, name), "utf8")) as Record<string, unknown>;
}

test("captured correction-required result preserves the provider status continuation", () => {
	const fixture = captured("last-event-capture-result-correction-required.captured.json");
	const closure = decodeReviewLastEventClosureV1(fixture);
	assert.equal(closure.operation, "review/capture-result");
	assert.equal(closure.state, "correction_required");
	assert.match(closure.storeRevision, /^sha256:[a-f0-9]{64}$/);
	assert.equal(closure.statusContinuation?.operation, "review.status");
	assert.deepEqual(
		closure.statusContinuation?.arguments.map((argument) => argument.token),
		[
			"--cwd=/tmp/repository",
			"--contract=gentle-ai.review-integration/v2",
			"--next-transition=true",
			"--lineage=review-afeed0d5a9aa24a1",
			"--agent=pi",
		],
	);
	assert.deepEqual(closure.statusContinuation?.raw, fixture.status_continuation);
});

test("correction status continuation stays bound to its enclosing closure and provider target", () => {
	const mismatch = `sha256:${"b".repeat(64)}`;
	const cases = [
		{
			name: "missing binding lineage",
			mutate: (binding: Record<string, unknown>) => { delete binding.lineage_id; },
			error: /lineage does not match its enclosing closure/,
		},
		{
			name: "different binding lineage",
			mutate: (binding: Record<string, unknown>) => { binding.lineage_id = "review-different"; },
			error: /lineage does not match its enclosing closure/,
		},
		{
			name: "missing binding revision",
			mutate: (binding: Record<string, unknown>) => { delete binding.revision; },
			error: /revision does not match its enclosing closure/,
		},
		{
			name: "different binding revision",
			mutate: (binding: Record<string, unknown>) => { binding.revision = mismatch; },
			error: /revision does not match its enclosing closure/,
		},
	];
	for (const scenario of cases) {
		const fixture = captured("last-event-capture-result-correction-required.captured.json");
		const continuation = fixture.status_continuation as Record<string, unknown>;
		scenario.mutate(continuation.binding as Record<string, unknown>);
		assert.throws(() => decodeReviewLastEventClosureV1(fixture), scenario.error, scenario.name);
	}

	const argumentMismatch = captured("last-event-capture-result-correction-required.captured.json");
	const continuation = argumentMismatch.status_continuation as Record<string, unknown>;
	const argumentsList = continuation.arguments as Array<Record<string, unknown>>;
	const lineageArgument = argumentsList.find((argument) => argument.name === "lineage")!;
	lineageArgument.value = "review-different";
	lineageArgument.token = "--lineage=review-different";
	assert.throws(() => decodeReviewLastEventClosureV1(argumentMismatch), /lineage argument does not match its enclosing closure/);

	const closure = decodeReviewLastEventClosureV1(captured("last-event-capture-result-correction-required.captured.json"));
	assert.throws(
		() => assertReviewLastEventClosureBinding(closure, { lineageId: closure.lineageId, targetIdentity: mismatch }),
		/status continuation target does not match its provider binding/,
	);
});

test("correction-required result and refuter closures require one status continuation", () => {
	for (const name of [
		"last-event-capture-result-correction-required.captured.json",
		"last-event-capture-refuter-correction-required.captured.json",
	]) {
		const fixture = captured(name);
		delete fixture.status_continuation;
		assert.throws(() => decodeReviewLastEventClosureV1(fixture), /requires status_continuation/, name);
	}
});

test("closures outside result or refuter correction-required forbid a status continuation", () => {
	const approved = captured("last-event-capture-result-approved.captured.json");
	approved.status_continuation = captured("last-event-capture-result-correction-required.captured.json").status_continuation;
	assert.throws(() => decodeReviewLastEventClosureV1(approved), /status_continuation is only valid/, "approved result closure");
});

test("current capture fails closed when fresh STATUS no longer offers the corrected candidate binding", async () => {
	const lineageId = "corrected-candidate";
	const sha = `sha256:${"a".repeat(64)}`;
	const binding = {
		name: "provider_targeted_validator",
		schema: "https://gentle-ai.dev/schema/review/targeted-validator/v1",
		captureOperation: "review.capture-validation",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "target", value: sha, token: `--target=${sha}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
	};
	let captureCalls = 0;
	const native = {
		targetStatus: async () => ({
			contract: "gentle-ai.review-integration/v2",
			applicability: "current_target",
			authority: { version: "compact-v2", lineageId, state: "correction_required", generation: 1, revision: sha },
			receipt: { status: "expected_missing" },
			action: "stop",
			replayability: "not_replayable",
			targetIdentity: sha,
			projection: { schema: "gentle-ai.review-candidate-projection/v1", kind: "current-changes", projection: "workspace", baseTree: "b".repeat(40), initialReviewTree: "b".repeat(40), currentCandidateTree: "c".repeat(40), pathsDigest: sha, paths: ["corrected.ts"], intendedUntracked: [], intendedUntrackedProof: sha, initialSnapshotIdentity: sha, currentSnapshotIdentity: sha },
			repair: { schema: "gentle-ai.review-authority-repair-assessment/v1", status: "unsupported", counts: { lineages: 0, compactLineages: 0, legacyLineages: 0, events: 0, bytes: 0, eligibleCandidates: 0, unsupportedLineages: 0, conflicts: 0 }, supportedOperations: [], authorizationSchema: "gentle-ai.review-repair-authorization/v1" },
			candidates: [],
			nextTransition: { kind: "stop", reasonCode: "corrected_candidate_unavailable" },
			raw: { schema: "gentle-ai.review-integration.status/v5" },
		} as unknown as ReviewStatusV3),
		captureProviderRole: async () => { captureCalls += 1; throw new Error("must not capture"); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(binding) }, process.cwd(), native);
	assert.equal(result.outcome, "capture-binding-rejected");
	assert.equal(result.mutation_outcome, "none");
	assert.equal(captureCalls, 0);
});
