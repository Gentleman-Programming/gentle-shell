// Actual registered facade executors over an in-memory native authority fixture.
// No real approval, native CLI, reviewer network call or candidate freeze occurs.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createGentleAiExtension, __testing } from "../../extensions/gentle-ai.ts";
import { decodeReviewStatusV3, type ReviewCollectInputV3, type ReviewStatusV3 } from "../../lib/review-integration-v2.ts";
import type { NativeReviewCli } from "../../lib/native-review-cli.ts";
import type { ReviewHostRelayRequest } from "../../lib/review-host-relay.ts";

type Body = Record<string, any>;
export interface CoordinatorRuntimeOptions {
	/** The host has a UI; false models print/RPC sessions with no human display. */
	hasUI?: boolean;
	/** Provider `advisory_findings` carried by the approved last-event closure. */
	advisoryFindings?: unknown;
	/** Provider `reviewer_results` carried by the approved last-event closure. */
	reviewerResults?: unknown;
	/** Effective native review mode per read; the fixture defaults to on. */
	mode?: (read: number, nativeCalls: readonly string[]) => "on" | "off";
	/**
	 * "refuter": a two-lens reviewer group whose findings need the refuter. The
	 * group's submissions return no closure, so the facade reconciles it through
	 * STATUS; STATUS then offers one host-mediated refuter slot, whose capture
	 * returns the approved closure. "refuter-reoffers-group": the same, except
	 * that every STATUS after the reconciliation offers the same group again.
	 */
	scenario?: "single" | "refuter" | "refuter-reoffers-group";
}
const GROUP_LENSES = ["review-risk", "review-reliability"] as const;
export function createCoordinatorRuntime(cwd: string, variant: "baseline" | "coordinator", options: CoordinatorRuntimeOptions = {}) {
	cwd = realpathSync(cwd);
	const scenario = options.scenario ?? "single";
	const raw = JSON.parse(readFileSync(new URL("../fixtures/devbinary/status-v5-capture-result-submission.captured.json", import.meta.url), "utf8"));
	raw.action = "stop";
	const reviewing = decodeReviewStatusV3(raw);
	const lineage = reviewing.authority!.lineageId!;
	const target = reviewing.targetIdentity;
	const revision = reviewing.authority!.revision;
	const arguments_ = [["cwd", cwd], ["lineage", lineage], ["target", target], ["expected-revision", revision], ["token", "fixture-only"]].map(([name, value]) => ({ name, value, token: `--${name}=${value}` }));
	const execute = { operation: "review.acknowledge-approved", command: "gentle-ai review acknowledge-approved --fixture-only", arguments: arguments_, preconditions: [{ name: "state", value: "approved" }], binding: { lineageId: lineage, targetIdentity: target, revision } };
	const approved = { ...reviewing, authority: { ...reviewing.authority!, state: "approved" }, nextTransition: { kind: "execute", reasonCode: "approved_acknowledgement_required", execute }, raw: { ...raw, authority: { ...raw.authority, state: "approved" }, next_transition: { kind: "execute", reason_code: "approved_acknowledgement_required", execute } } };
	// The captured reviewer input, cloned once per group lens with its own order and subject.
	const groupStatus = (submitted: number): ReviewStatusV3 => {
		const copy = structuredClone(raw);
		const source = copy.next_transition.collect.inputs[0];
		copy.next_transition.collect.inputs = GROUP_LENSES.map((lens, order) => {
			const input = structuredClone(source);
			const subjectHash = `sha256:${String(order + 1).repeat(64)}`;
			for (const argument of input.arguments) {
				argument.value = argument.name === "lens" ? lens : argument.name === "order" ? String(order) : argument.name === "subject-hash" ? subjectHash : argument.value;
				argument.token = `--${argument.name}=${argument.value}`;
			}
			input.submission.argument_tokens = [...input.arguments.filter((argument: Body) => argument.name !== "agent" && argument.name !== "materialize").map((argument: Body) => argument.token), "--input={{value}}"];
			Object.assign(input.artifact_subject, { subject_hash: subjectHash, lens, selected_order: order });
			return input;
		}).slice(submitted);
		return decodeReviewStatusV3(copy);
	};
	// A host-mediated refuter slot as the v9 provider renders it (decoded form).
	const roleArguments = reviewing.nextTransition!.collect!.inputs[0]!.arguments.filter((argument) => ["lineage", "expected-revision", "target", "repository-context"].includes(argument.name));
	const refuterInput = {
		name: "provider_refuter", schema: "https://gentle-ai.dev/schema/review/refuter/v1", captureOperation: "review.capture-refuter",
		arguments: [...roleArguments, { name: "agent", value: "pi", token: "--agent=pi" }, { name: "materialize", value: "true", token: "--materialize=true" }],
		submission: { operationToken: "capture-refuter", argumentTokens: [...roleArguments.map((argument) => argument.token!), "--agent=pi", "--input={{value}}"],
			values: [{ slot: "provider_refuter", domain: "artifact_path_or_stdin", substitutionLocation: roleArguments.length + 1 }] },
	} as unknown as ReviewCollectInputV3;
	const refuting = { ...reviewing, nextTransition: { kind: "collect", reasonCode: "provider_refuter_required", collect: { inputs: [refuterInput] } },
		raw: { ...raw, next_transition: { kind: "collect", reason_code: "provider_refuter_required" } } } as unknown as ReviewStatusV3;
	const approvedClosure = (operation: string) => JSON.stringify({ schema: "gentle-ai.review-last-event-closure/v1", operation, lineage_id: lineage, state: "approved", action: "fixture approval; not real authority", store_revision: revision,
		...(options.advisoryFindings === undefined ? {} : { advisory_findings: options.advisoryFindings }),
		...(options.reviewerResults === undefined ? {} : { reviewer_results: options.reviewerResults }) });
	let state = "reviewing";
	let groupSubmitted = 0;
	let reconciledReads = 0;
	const nativeCalls: string[] = [];
	let modeReads = 0;
	let candidateReads = 0;
	let relayRuns = 0;
	const tools = new Map<string, any>();
	const native = {
		reviewMode: async () => {
			const effective = options.mode?.(++modeReads, nativeCalls) ?? "on";
			return { operation: "status", scope: "clone", status: { global: effective, cloneLocal: "", effective, source: "global" } };
		},
		targetStatus: async () => {
			assert.notEqual(state, "burned", "no STATUS after burn");
			nativeCalls.push(`status:${state}`);
			if (state === "approved") return approved;
			if (scenario === "single") return reviewing;
			if (state === "refuting") {
				// The facade's own post-group reconciliation reads STATUS first.
				if (scenario === "refuter-reoffers-group" && reconciledReads++ > 0) return groupStatus(0);
				return refuting;
			}
			return groupStatus(groupSubmitted);
		},
		acknowledgeApproved: async () => {
			assert.equal(state, "approved");
			nativeCalls.push("acknowledge"); state = "burned";
			return { schema: "gentle-ai.review-acknowledged/v1", lineageId: lineage, targetIdentity: target, consumedRevision: revision };
		},
		assess: async () => {
			candidateReads++;
			return { schema: "gentle-ai.review-assessment/v1", risk: "passive", reasons: [], changedPaths: 1, changedLines: 1,
				candidate: { kind: "current-changes", consumed: state === "burned" } };
		},
	} as unknown as NativeReviewCli;
	const lensOf = (request: ReviewHostRelayRequest) => request.captureArgumentTokens.find((token) => token.startsWith("--lens="))?.slice("--lens=".length);
	__testing.setReviewHostRelayRunnerForTesting(async (request) => {
		relayRuns++;
		if (scenario === "single") {
			assert.equal(state, "reviewing");
			nativeCalls.push("capture:recorded-output"); state = "approved";
			const submission = approvedClosure("review/capture-result");
			return { submission, promptByteLength: 0, resultByteLength: Buffer.byteLength(submission) };
		}
		assert.equal(state, "refuting");
		assert.equal(request.routingKey, "review-refuter");
		nativeCalls.push("capture-refuter"); state = "approved";
		const submission = approvedClosure("review.capture-refuter");
		return { submission, promptByteLength: 0, resultByteLength: Buffer.byteLength(submission) };
	});
	__testing.setReviewHostRelayGroupRunnersForTesting(async (requests) => {
		relayRuns += requests.length;
		return requests.map((request) => ({ request, promptByteLength: 0, resultByteLength: 0 }));
	}, async (prepared) => {
		assert.equal(state, "reviewing");
		nativeCalls.push(`capture-result:${lensOf(prepared.request)}`);
		if (++groupSubmitted === GROUP_LENSES.length) state = "refuting";
		// An admitted reviewer result that is not the last event: no closure.
		return { submission: "{}", promptByteLength: 0, resultByteLength: 2 };
	});
	createGentleAiExtension({ nativeReviewCli: native, candidateViews: null,
		// The coordinator is registered by default; "0" is its explicit opt-out.
		processEnv: { ...(variant === "coordinator" ? {} : { GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "0" }), GENTLE_AI_TELEMETRY: "0" },
	})({ on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as never);
	const forecasts: Body[] = [];
	const context = { cwd, hasUI: options.hasUI ?? true, sessionManager: { getSessionId: () => "fixture-live-driver", getBranch: () => [], getSessionFile: () => undefined }, modelRegistry: undefined };
	const facadeCalls: { name: string; parameters: Body; elapsed_ms: number }[] = [];
	return { tools, lineage, target, nativeCalls, facadeCalls, forecasts,
		async invoke(name: string, parameters: Body) {
			const tool = tools.get(name); assert.ok(tool, `registered tool ${name}`);
			const began = performance.now();
			const result = await tool.execute("fixture-call", parameters, undefined, (update: any) => forecasts.push(update.details), context);
			facadeCalls.push({ name, parameters, elapsed_ms: performance.now() - began });
			return result.details as Body;
		},
		closed: () => state === "burned",
		modeReads: () => modeReads,
		relayRuns: () => relayRuns,
		candidateReads: () => candidateReads,
		close: () => { __testing.setReviewHostRelayRunnerForTesting(); __testing.setReviewHostRelayGroupRunnersForTesting(); },
	};
}
