import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	NATIVE_REVIEW_LEGACY_ALIAS_REPAIR,
	NATIVE_REVIEW_LEGACY_QUARANTINE,
	NativeReviewCliError,
	NativeReviewCliV216,
	nativeReviewAbandonAuthorization,
	nativeReviewLegacyAliasRepairAuthorization,
	nativeReviewLegacyQuarantineAuthorization,
	nativeReviewReconcileAuthorization,
	type ExecFileAdapter,
} from "../lib/native-review-cli.ts";

interface QueuedResult { stdout: string; exitCode?: number; }

function queuedAdapter(results: readonly QueuedResult[]): {
	adapter: ExecFileAdapter;
	calls: Array<{ arguments: readonly string[]; cwd: string }>;
} {
	const queue = [...results];
	const calls: Array<{ arguments: readonly string[]; cwd: string }> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push({ arguments: request.arguments, cwd: request.cwd });
			const result = queue.shift();
			if (result === undefined) throw new Error("unexpected native invocation");
			return { stdout: result.stdout, stderr: "", exitCode: result.exitCode ?? 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

function client(adapter: ExecFileAdapter): NativeReviewCliV216 {
	return new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai");
}

const SHA = `sha256:${"a".repeat(64)}`;

// Recovery and maintenance commands retain their published legacy wire forms.
// These records are intentionally opaque: Pi validates command bindings, then
// relays the provider's audit record without reinterpreting authority state.
test("native reclaim and recover preserve their exact authority bindings", async () => {
	const queue = queuedAdapter([
		{ stdout: JSON.stringify({ schema: "gentle-ai.review-reclaim-audit/v1", lineage: "stuck", actor: "maintainer", reason: "incomplete" }) },
		{ stdout: JSON.stringify({ schema: "gentle-ai.review-recovery/v1", predecessor_lineage: "stuck", successor_lineage: "recovered" }) },
	]);
	const review = client(queue.adapter);
	assert.equal((await review.reclaim({ cwd: "/repo", lineage: "stuck", actor: "maintainer", reason: "incomplete" })).record.lineage, "stuck");
	assert.equal((await review.recover({
		cwd: "/repo",
		predecessorLineage: "stuck",
		expectedPredecessorRevision: "revision-1",
		successorLineage: "recovered",
		disposition: "invalidated",
		actor: "maintainer",
		reason: "recovery required",
		maintainerAuthorization: "approved\nbinding",
	})).record.successor_lineage, "recovered");
	assert.deepEqual(queue.calls.map((call) => call.arguments), [
		["review", "reclaim", "--cwd", "/repo", "--lineage", "stuck", "--actor", "maintainer", "--reason", "incomplete"],
		["review", "recover", "--cwd", "/repo", "--predecessor-lineage", "stuck", "--expected-predecessor-revision", "revision-1", "--successor-lineage", "recovered", "--disposition", "invalidated", "--actor", "maintainer", "--reason", "recovery required", "--maintainer-authorization", "approved\nbinding"],
	]);
});

test("native abandon carries the exact discarded-work authorization and audit record", async () => {
	const request = {
		cwd: "/repo",
		lineage: "abandoned",
		expectedRevision: "revision-1",
		snapshotIdentity: SHA,
		capturedLensResults: ["00-risk.json"],
		findingsPresent: true,
		actor: "maintainer",
		reason: "discard candidate",
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify({ operation: "review/abandon", record: { schema: "gentle-ai.review-reclaim-audit/v1", lineage_id: "abandoned", status: "committed" } }) }]);
	const result = await client(queue.adapter).abandon({ ...request, maintainerAuthorization: nativeReviewAbandonAuthorization(request) });
	assert.equal(result.record.status, "committed");
	assert.deepEqual(queue.calls[0]?.arguments.slice(0, 10), ["review", "abandon", "--cwd", "/repo", "--lineage", "abandoned", "--expected-revision", "revision-1", "--actor", "maintainer"]);
});

// gentle-ai 0ed9225f ("close on the last causal event") removed evidence records
// from CompactDiscardedWorkSummary, so the native v2 gate verifies an exact
// EIGHT-line binding with no evidence_records_present line. The facade-side
// derivation must match that contract byte-for-byte or native rejects every
// abandoned binding (issue #466).
test("nativeReviewAbandonAuthorization renders the native eight-line v2 binding", () => {
	const binding = nativeReviewAbandonAuthorization({
		lineage: "review-abc",
		expectedRevision: "revision-9",
		snapshotIdentity: "snapshot-1",
		capturedLensResults: ["00-risk.json", "01-refuter.json"],
		findingsPresent: true,
		actor: "maintainer",
		reason: "operator_disposition",
	});
	assert.equal(binding, [
		"gentle-ai.review-abandon-authorization/v2",
		"lineage=review-abc",
		"revision=revision-9",
		"snapshot_identity=snapshot-1",
		"reason=operator_disposition",
		"captured_lens_results=00-risk.json,01-refuter.json",
		"findings_present=true",
		"actor=maintainer",
	].join("\n"));
});

test("native quarantine retains published legacy-v1 maintenance compatibility", async () => {
	const request = {
		cwd: "/repo",
		repository: "/repo",
		lineage: "legacy-freeze",
		expectedRevision: SHA,
		diagnostic: NATIVE_REVIEW_LEGACY_QUARANTINE.DIAGNOSTIC,
		disposition: NATIVE_REVIEW_LEGACY_QUARANTINE.DISPOSITION,
		actor: "maintainer",
		reason: "quarantine malformed freeze",
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify({ operation: "review/quarantine-legacy", record: { schema: "gentle-ai.review-reclaim-audit/v1", lineage_id: "legacy-freeze", status: "committed" } }) }]);
	const result = await client(queue.adapter).quarantineLegacy({ ...request, maintainerAuthorization: nativeReviewLegacyQuarantineAuthorization(request) });
	assert.equal(result.record.lineage_id, "legacy-freeze");
	assert.deepEqual(queue.calls[0]?.arguments.slice(0, 8), ["review", "quarantine-legacy", "--cwd", "/repo", "--lineage", "legacy-freeze", "--expected-revision", SHA]);
});

test("native reconciliation accepts only its exact predecessor and successor binding", async () => {
	const request = {
		cwd: "/repo",
		predecessorLineage: "predecessor",
		expectedPredecessorRevision: "predecessor-revision",
		successorLineage: "successor",
		expectedSuccessorRevision: "successor-revision",
		actor: "maintainer",
		reason: "repair authority edge",
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify({ operation: "review/reconcile-authority", record: { schema: "gentle-ai.review-reconcile-audit/v1", predecessor_lineage: "predecessor", successor_lineage: "successor", outcome: "quarantined" } }) }]);
	const result = await client(queue.adapter).reconcileAuthority({ ...request, maintainerAuthorization: nativeReviewReconcileAuthorization(request) });
	assert.equal(result.record.successor_lineage, "successor");
	assert.deepEqual(queue.calls[0]?.arguments.slice(0, 12), ["review", "reconcile-authority", "--cwd", "/repo", "--predecessor-lineage", "predecessor", "--expected-predecessor-revision", "predecessor-revision", "--successor-lineage", "successor", "--expected-successor-revision", "successor-revision"]);
});

test("native maintenance rejects tampered authority authorization before launch", async () => {
	const queue = queuedAdapter([]);
	await assert.rejects(
		() => client(queue.adapter).reconcileAuthority({
			cwd: "/repo",
			predecessorLineage: "predecessor",
			expectedPredecessorRevision: "predecessor-revision",
			successorLineage: "successor",
			expectedSuccessorRevision: "successor-revision",
			actor: "maintainer",
			reason: "repair authority edge",
			maintainerAuthorization: "tampered",
		}),
		/exact target and revision binding/,
	);
	assert.equal(queue.calls.length, 0);
});

test("native authority inventory remains a strict read-only maintenance surface", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify({
		schema: "gentle-ai.review-authority-status/v1",
		operation: "review/status",
		repository: process.cwd(),
		complete: true,
		authoritative: true,
		status: "active",
		entries: [{ version: "compact-v2", path: ".git/gentle-ai/reviews/current.json", status: "active", lineage_id: "current", state: "reviewing", revision: "revision-1", problems: [] }],
		locks: [],
		diagnostics: [],
	}) }]);
	const inventory = await client(queue.adapter).reviewStatus({ cwd: process.cwd() });
	assert.equal(inventory.authoritative, true);
	assert.equal(inventory.entries[0]?.lineageId, "current");
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "status", "--cwd", process.cwd()]);
});

test("negotiated repair replays only provider-published inputs after a strict preflight", async () => {
	const preflight = JSON.parse(readFileSync(join(process.cwd(), "contracts", "review-integration", "v1", "fixtures", "repair-preflight.fixture.json"), "utf8")) as Record<string, unknown>;
	preflight.schema = "gentle-ai.review-integration.repair/v2";
	preflight.contract = "gentle-ai.review-integration/v2";
	const execute = structuredClone(preflight) as Record<string, unknown>;
	execute.mode = "execute";
	delete execute.provider_inputs;
	execute.required_inputs = [];
	execute.execution = {
		status: "committed",
		class: "legacy_v1_historical_alias",
		lineage_id: "historical-alias",
		revision: `sha256:${"1".repeat(64)}`,
		chain_identity: `sha256:${"2".repeat(64)}`,
		cause: "unsupported_historical_v1_operation_alias",
		disposition: "quarantine-approved-historical-alias",
		assessment_digest: `sha256:${"3".repeat(64)}`,
		request_digest: `sha256:${"4".repeat(64)}`,
		record_identity: `sha256:${"5".repeat(64)}`,
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify(preflight) }, { stdout: JSON.stringify(execute) }]);
	const result = await client(queue.adapter).repair({ cwd: "/repo", actor: "maintainer", reason: "repair alias", maintainerAuthorization: "approved" });
	assert.equal(result.execution?.status, "committed");
	assert.deepEqual(queue.calls.map((call) => call.arguments.slice(0, 8)), [
		["review", "repair", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo", "--mode", "preflight"],
		["review", "repair", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo", "--mode", "execute"],
	]);
});

test("native repair-legacy-alias keeps the historical fixed binding and rejects a tampered one before launch", async () => {
	const request = {
		cwd: "/repo",
		repository: "/repo",
		lineage: "historical-alias",
		expectedRevision: SHA,
		diagnostic: NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DIAGNOSTIC,
		disposition: NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DISPOSITION,
		actor: "maintainer",
		reason: "repair historical alias",
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify({ operation: "review/repair-legacy-alias", record: { schema: "gentle-ai.review-repair-audit/v1", lineage_id: request.lineage, status: "committed" } }) }]);
	const result = await client(queue.adapter).repairLegacyAlias({ ...request, maintainerAuthorization: nativeReviewLegacyAliasRepairAuthorization(request) });
	assert.equal(result.record.lineage_id, request.lineage);
	assert.deepEqual(queue.calls[0]?.arguments.slice(0, 10), ["review", "repair-legacy-alias", "--cwd", "/repo", "--lineage", request.lineage, "--expected-revision", SHA, "--diagnostic", request.diagnostic]);
	const rejected = queuedAdapter([]);
	await assert.rejects(() => client(rejected.adapter).repairLegacyAlias({ ...request, maintainerAuthorization: "tampered" }), /exact repository, lineage, revision/);
	assert.equal(rejected.calls.length, 0);
});

test("native recovery operations reject malformed canonical inputs before a process can mutate", async () => {
	const queue = queuedAdapter([]);
	await assert.rejects(() => client(queue.adapter).recover({
		cwd: "/repo", predecessorLineage: " predecessor", expectedPredecessorRevision: "revision", successorLineage: "successor", disposition: "invalidated", actor: "maintainer", reason: "reason",
	}), /predecessorLineage/);
	await assert.rejects(() => client(queue.adapter).reclaim({ cwd: "/repo", lineage: "lineage\n", actor: "maintainer", reason: "reason" }), /lineage/);
	assert.equal(queue.calls.length, 0);
});

test("native RECOVER rejects malformed or unacknowledged committed selectors before launch", async () => {
	const queue = queuedAdapter([]);
	const request = { cwd: "/repo", predecessorLineage: "predecessor", expectedPredecessorRevision: "revision-1", successorLineage: "successor", disposition: "invalidated" as const, actor: "maintainer", reason: "recover authority" };
	for (const selectors of [
		{ baseRef: " base", committedOnly: true },
		{ baseRef: "base\u0000", committedOnly: true },
		{ baseRef: "base" },
		{ baseRef: "base", committedOnly: false },
		{ committedOnly: true },
		{ committedOnly: false },
	]) {
		await assert.rejects(() => client(queue.adapter).recover({ ...request, ...selectors }), /Native RECOVER (baseRef|committedOnly)/);
	}
	assert.equal(queue.calls.length, 0);
});

test("partial maintenance failures preserve the provider audit record and unknown mutation outcome", async () => {
	const request = {
		cwd: "/repo", lineage: "abandoned", expectedRevision: "revision-1", snapshotIdentity: SHA,
		capturedLensResults: ["00-risk.json"], findingsPresent: true, actor: "maintainer", reason: "discard candidate",
	};
	const queue = queuedAdapter([{ exitCode: 1, stdout: JSON.stringify({ operation: "review/abandon", record: { schema: "gentle-ai.review-reclaim-audit/v1", lineage_id: request.lineage, status: "partial" } }) }]);
	await assert.rejects(
		() => client(queue.adapter).abandon({ ...request, maintainerAuthorization: nativeReviewAbandonAuthorization(request) }),
		(error: unknown) => error instanceof NativeReviewCliError && error.mutationOutcome === "unknown" && error.auditRecord?.status === "partial",
	);
	assert.equal(queue.calls.length, 1);
});

test("RESET requests native reclaim inputs rather than inventing authority values", async () => {
	const native = { reclaim: async () => { throw new Error("must not reclaim"); } } as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "reset", input: JSON.stringify({ lineage: "only-lineage" }) }, process.cwd(), native);
	assert.equal(result.outcome, "native-input-required");
	assert.deepEqual(result.missing_input, ["actor", "reason"]);
	assert.equal(result.mutation_outcome, "none");
});

test("RECOVER rejects caller-authored authorization before status, UI, or native mutation", async () => {
	let statusCalls = 0;
	const native = {
		targetStatus: async () => { statusCalls += 1; throw new Error("must not read status"); },
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({
		operation: "recover",
		input: JSON.stringify({ predecessorLineage: "predecessor", expectedPredecessorRevision: "revision", successorLineage: "successor", disposition: "invalidated", actor: "maintainer", reason: "recover", maintainerAuthorization: "caller-authored" }),
	}, process.cwd(), native);
	assert.equal(result.outcome, "native-recovery-caller-authorization-rejected");
	assert.equal(statusCalls, 0);
	assert.equal(result.mutation_outcome, "none");
});

test("RECONCILE_AUTHORITY returns exact missing-input guidance before native mutation", async () => {
	const native = { reconcileAuthority: async () => { throw new Error("must not reconcile"); } } as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "reconcile-authority", input: JSON.stringify({ predecessorLineage: "predecessor" }) }, process.cwd(), native);
	assert.equal(result.outcome, "native-input-required");
	assert.deepEqual(result.missing_input, ["expectedPredecessorRevision", "successorLineage", "expectedSuccessorRevision", "actor", "reason"]);
	assert.equal(result.mutation_outcome, "none");
});

test("native abandon rejects a legacy authorization before process launch", async () => {
	const request = {
		cwd: "/repo",
		lineage: "abandoned",
		expectedRevision: "revision-1",
		snapshotIdentity: SHA,
		capturedLensResults: ["00-risk.json"],
		findingsPresent: true,
		actor: "maintainer",
		reason: "discard candidate",
	};
	const queue = queuedAdapter([]);
	await assert.rejects(
		() => client(queue.adapter).abandon({ ...request, maintainerAuthorization: "gentle-ai.review-abandon-authorization/v1" }),
		/exact lineage, revision, snapshot, reason, discarded-work, and actor binding/,
	);
	assert.equal(queue.calls.length, 0);
});

function recoveryStatus(options: {
	lineageId?: string;
	revision?: string;
	targetIdentity?: string;
	disposition?: "scope_changed" | "invalidated" | "escalated";
	action?: "recover" | "start";
} = {}) {
	return {
		action: options.action ?? "recover",
		actionDisposition: options.disposition ?? "invalidated",
		authority: { lineageId: options.lineageId ?? "predecessor", revision: options.revision ?? "revision-1" },
		targetIdentity: options.targetIdentity ?? SHA,
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as import("../lib/review-integration-v2.ts").ReviewStatusV3;
}

function registeredController(nativeReviewCli: import("../lib/native-review-cli.ts").NativeReviewCli) {
	const tools = new Map<string, { execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ details?: unknown }> }>();
	createGentleAiExtension({ nativeReviewCli })({
		on() {},
		registerTool(definition: { name: string; execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ details?: unknown }> }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	return controller;
}

function interactiveContext(confirm: boolean): ExtensionContext {
	return { cwd: process.cwd(), hasUI: true, ui: { confirm: async () => confirm } } as unknown as ExtensionContext;
}

test("maintenance cancellation preserves the exact signal and unknown mutation outcome", async () => {
	const controller = new AbortController();
	const request = {
		cwd: "/repo", lineage: "abandoned", expectedRevision: "revision-1", snapshotIdentity: SHA,
		capturedLensResults: ["00-risk.json"], findingsPresent: true,
		actor: "maintainer", reason: "discard candidate",
	};
	const adapter: ExecFileAdapter = async (call) => {
		assert.equal(call.signal, controller.signal);
		const error = new Error("cancelled");
		error.name = "AbortError";
		throw error;
	};
	await assert.rejects(
		() => client(adapter).abandon({ ...request, maintainerAuthorization: nativeReviewAbandonAuthorization(request), signal: controller.signal }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === "cancelled" && error.mutationOutcome === "unknown" && error.nextAction === "review.status",
	);
	const reconcile = {
		cwd: "/repo", predecessorLineage: "predecessor", expectedPredecessorRevision: "revision-1",
		successorLineage: "successor", expectedSuccessorRevision: "revision-2", actor: "maintainer", reason: "repair edge",
	};
	await assert.rejects(
		() => client(adapter).reconcileAuthority({ ...reconcile, maintainerAuthorization: nativeReviewReconcileAuthorization(reconcile), signal: controller.signal }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === "cancelled" && error.mutationOutcome === "unknown" && error.nextAction === "review.status",
	);
});

test("RECOVER derives a provider-bound authorization, rechecks it, and fails closed on every drift", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async () => recoveryStatus(),
		recover: async (request: Record<string, unknown>) => { requests.push(request); return { record: { schema: "gentle-ai.review-recovery/v1", lineage: "successor" } }; },
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	const input = { predecessorLineage: "predecessor", expectedPredecessorRevision: "revision-1", successorLineage: "successor", disposition: "invalidated", actor: "maintainer", reason: "recover authority" };
	const result = await __testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify(input) }, process.cwd(), native, undefined, undefined, interactiveContext(true));
	assert.equal(result.mutation_outcome, "committed");
	assert.equal(requests.length, 1);
	assert.match(String(requests[0]?.maintainerAuthorization), /^gentle-ai\.review-recovery-authorization\/v1\npredecessor_lineage=predecessor\npredecessor_revision=revision-1\ntarget_identity=/);

	const wrongDisposition = await __testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify({ ...input, disposition: "escalated" }) }, process.cwd(), native, undefined, undefined, interactiveContext(true));
	assert.equal(wrongDisposition.outcome, "native-recovery-disposition-mismatch");
	assert.equal(wrongDisposition.mutation_outcome, "none");

	for (const status of [
		recoveryStatus({ lineageId: "foreign" }),
		recoveryStatus({ revision: "revision-2" }),
		recoveryStatus({ action: "start" }),
	]) {
		const blocked = await __testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify(input) }, process.cwd(), {
			targetStatus: async () => status,
			recover: async () => { throw new Error("must not recover"); },
		} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli, undefined, undefined, interactiveContext(true));
		assert.equal(blocked.outcome, "native-recovery-status-mismatch");
		assert.equal(blocked.mutation_outcome, "none");
	}

	let reads = 0;
	const changed = await __testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify(input) }, process.cwd(), {
		targetStatus: async () => (++reads === 1 ? recoveryStatus() : recoveryStatus({ targetIdentity: `sha256:${"b".repeat(64)}` })),
		recover: async () => { throw new Error("must not recover"); },
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli, undefined, undefined, interactiveContext(true));
	assert.equal(changed.outcome, "native-recovery-authority-changed");
	assert.equal(changed.mutation_outcome, "none");
});

test("approved RECOVER preserves the frozen committed-range selector from both STATUS reads", async () => {
	const baseCommit = "1".repeat(40);
	const providerBaseTree = "2".repeat(40);
	const statuses: Array<Record<string, unknown>> = [];
	const queue = queuedAdapter([{ stdout: JSON.stringify({ schema: "gentle-ai.review-recovery/v1" }) }]);
	const review = client(queue.adapter);
	const native = {
		targetStatus: async (request: Record<string, unknown>) => { statuses.push(request); return recoveryStatus(); },
		recover: review.recover.bind(review),
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	const views = {
		hasProjection: (lineage: string, cwd: string) => lineage === "predecessor" && cwd === process.cwd(),
		resolveProjection: () => ({ committedOnly: true, baseCommit, providerBaseTree }),
	} as unknown as NonNullable<Parameters<typeof __testing.executeReviewControllerOperation>[4]>;
	const input = { predecessorLineage: "predecessor", expectedPredecessorRevision: "revision-1", successorLineage: "successor", disposition: "invalidated", actor: "maintainer", reason: "recover authority" };
	const result = await __testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify(input) }, process.cwd(), native, undefined, views, interactiveContext(true));
	assert.equal(result.mutation_outcome, "committed");
	assert.equal(statuses.length, 2);
	for (const status of statuses) {
		assert.equal(status.baseRef, providerBaseTree);
		assert.equal(status.committedOnly, true);
	}
	const args = queue.calls[0]!.arguments;
	assert.ok(args.includes("--base-ref"), "RECOVER must carry the STATUS base selector");
	assert.equal(args[args.indexOf("--base-ref") + 1], providerBaseTree);
	assert.ok(args.includes("--committed-only"));
	assert.ok(args.includes("--maintainer-authorization"));
});

test("RECOVER, RESET, and RECONCILE keep provider inputs and failures authority-scoped", async () => {
	const recoverMissing = await __testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify({ predecessorLineage: "predecessor", disposition: "not-a-disposition" }) }, process.cwd(), {
		recover: async () => { throw new Error("must not recover"); },
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli);
	assert.deepEqual(recoverMissing.missing_input, ["expectedPredecessorRevision", "successorLineage", "disposition", "actor", "reason"]);

	const resetUnavailable = await __testing.executeReviewControllerOperation({ operation: "reset", input: JSON.stringify({ lineage: "stuck", actor: "maintainer", reason: "incomplete" }) }, process.cwd(), null);
	assert.equal(resetUnavailable.outcome, "native-recovery-unavailable");

	const reconciliation = { predecessorLineage: "predecessor", expectedPredecessorRevision: "revision-1", successorLineage: "successor", expectedSuccessorRevision: "revision-2", actor: "maintainer", reason: "repair edge" };
	const completed = await __testing.executeReviewControllerOperation({ operation: "reconcile-authority", input: JSON.stringify(reconciliation) }, process.cwd(), {
		reconcileAuthority: async (request: Record<string, unknown>) => ({ record: { schema: "gentle-ai.review-reconcile-audit/v1", successor: request.successorLineage } }),
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli);
	assert.equal(completed.mutation_outcome, "committed");
	assert.deepEqual(completed.result, { schema: "gentle-ai.review-reconcile-audit/v1", successor: "successor" });

	for (const error of [
		new NativeReviewCliError("cancelled", "review/reconcile-authority", true, true, "cancelled"),
		new NativeReviewCliError("non_zero", "review/reconcile-authority", true, true, "partial", undefined, { schema: "gentle-ai.review-reconcile-audit/v1", status: "partial" }),
	]) {
		const failed = await __testing.executeReviewControllerOperation({ operation: "reconcile-authority", input: JSON.stringify(reconciliation) }, process.cwd(), {
			reconcileAuthority: async () => { throw error; },
		} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli);
		assert.equal(failed.outcome, "native-operation-failed");
		assert.equal(failed.mutation_outcome, "unknown");
		assert.equal(failed.next_action, "review.status");
	}
});

test("destructive maintenance remains UI-gated and derives authorization at the public controller boundary", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const native = {
		reclaim: async (request: Record<string, unknown>) => { calls.push(request); return { record: { schema: "gentle-ai.review-reclaim-audit/v1" } }; },
		reconcileAuthority: async (request: Record<string, unknown>) => { calls.push(request); return { record: { schema: "gentle-ai.review-reconcile-audit/v1" } }; },
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	const controller = registeredController(native);
	const reset = { operation: "reset", input: JSON.stringify({ repositoryId: "repo", commonDirHash: "a".repeat(64), inventoryHash: "b".repeat(64), confirmation: "DESTROY REVIEW AUTHORITY repo", lineage: "stuck", actor: "maintainer", reason: "incomplete" }) };
	await assert.rejects(controller.execute("headless", reset, undefined, undefined, { ...interactiveContext(true), hasUI: false } as ExtensionContext), /interactive Pi UI.*fails closed/i);
	await assert.rejects(controller.execute("declined", reset, undefined, undefined, interactiveContext(false)), /not explicitly authorized/);
	const approved = await controller.execute("approved", reset, undefined, undefined, interactiveContext(true));
	assert.equal((approved.details as { mutation_outcome?: string }).mutation_outcome, "committed");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.lineage, "stuck");
	await assert.rejects(
		controller.execute("missing-challenge", { operation: "reset", input: JSON.stringify({ commonDirHash: "a".repeat(64), inventoryHash: "b".repeat(64), confirmation: "DESTROY REVIEW AUTHORITY repo", lineage: "stuck", actor: "maintainer", reason: "incomplete" }) }, undefined, undefined, interactiveContext(true)),
		/requires an exact string repositoryId/,
	);

	const reconciliation = await controller.execute("reconcile", { operation: "reconcile-authority", input: JSON.stringify({ predecessorLineage: "predecessor", expectedPredecessorRevision: "revision-1", successorLineage: "successor", expectedSuccessorRevision: "revision-2", actor: "maintainer", reason: "repair edge" }) }, undefined, undefined, interactiveContext(true));
	assert.equal((reconciliation.details as { mutation_outcome?: string }).mutation_outcome, "committed");
	assert.match(String(calls[1]?.maintainerAuthorization), /^gentle-ai\.review-reconcile-authorization\/v1\npredecessor_lineage=predecessor\npredecessor_revision=revision-1\nsuccessor_lineage=successor\nsuccessor_revision=revision-2/);
});

test("RECOVER requires a live UI decision and RECOVER_LOCK requires its owner binding", async () => {
	const input = { predecessorLineage: "predecessor", expectedPredecessorRevision: "revision-1", successorLineage: "successor", disposition: "invalidated", actor: "maintainer", reason: "recover authority" };
	const native = {
		targetStatus: async () => recoveryStatus(),
		recover: async () => ({ record: { schema: "gentle-ai.review-recovery/v1" } }),
		reclaim: async () => ({ record: { schema: "gentle-ai.review-reclaim-audit/v1" } }),
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	await assert.rejects(
		__testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify(input) }, process.cwd(), native),
		/fresh explicit authorization through the interactive Pi UI/,
	);
	await assert.rejects(
		__testing.executeReviewControllerOperation({ operation: "recover", input: JSON.stringify(input) }, process.cwd(), native, undefined, undefined, interactiveContext(false)),
		/not explicitly authorized/,
	);
	await assert.rejects(
		__testing.executeReviewControllerOperation({ operation: "recover-lock", input: JSON.stringify({ lineage: "stuck", actor: "maintainer", reason: "stale" }) }, process.cwd(), native),
		/ownerHash/,
	);
	const missingReclaim = await __testing.executeReviewControllerOperation({ operation: "recover-lock", input: JSON.stringify({ ownerHash: "a".repeat(64) }) }, process.cwd(), native);
	assert.deepEqual(missingReclaim.missing_input, ["lineage", "actor", "reason"]);
	const recovered = await __testing.executeReviewControllerOperation({ operation: "recover-lock", input: JSON.stringify({ ownerHash: "a".repeat(64), lineage: "stuck", actor: "maintainer", reason: "stale" }) }, process.cwd(), native);
	assert.equal(recovered.mutation_outcome, "committed");
});

test("REPAIR_LEGACY_ALIAS derives its immutable target from fresh native inventory", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const native = {
		reviewStatus: async () => ({
			repository: "/canonical/repository",
			complete: true,
			entries: [{ version: "legacy-v1", status: "invalid", lineageId: "legacy-alias", revision: SHA, problems: [NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DIAGNOSTIC] }],
		}),
		repairLegacyAlias: async (request: Record<string, unknown>) => { calls.push(request); return { record: { schema: "gentle-ai.review-repair-audit/v1" } }; },
	} as unknown as import("../lib/native-review-cli.ts").NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "repair-legacy-alias", input: JSON.stringify({ lineage: "legacy-alias", actor: "maintainer", reason: "repair alias" }) }, process.cwd(), native, undefined, undefined, interactiveContext(true));
	assert.equal(result.mutation_outcome, "committed");
	assert.equal(calls[0]?.repository, "/canonical/repository");
	assert.equal(calls[0]?.expectedRevision, SHA);
	assert.match(String(calls[0]?.maintainerAuthorization), /^gentle-ai\.review-legacy-alias-repair-authorization\/v1\nrepository=\/canonical\/repository/);
	const injected = await __testing.executeReviewControllerOperation({ operation: "repair-legacy-alias", input: JSON.stringify({ lineage: "legacy-alias", actor: "maintainer", reason: "repair alias", repository: "/injected" }) }, process.cwd(), native, undefined, undefined, interactiveContext(true));
	assert.equal(injected.outcome, "native-input-invalid");
});
