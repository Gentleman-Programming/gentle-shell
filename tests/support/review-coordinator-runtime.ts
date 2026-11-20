// Actual registered facade executors over an in-memory native authority fixture.
// No real approval, native CLI, reviewer network call or candidate freeze occurs.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createGentleAiExtension, __testing } from "../../extensions/gentle-ai.ts";
import { decodeReviewStatusV3, type ReviewCollectInputV3, type ReviewStatusV3 } from "../../lib/review-integration-v2.ts";
import type { NativeReviewCli } from "../../lib/native-review-cli.ts";
import { runReviewHostRelayReviewerGroup, type ReviewHostRelayPreparationRunner, type ReviewHostRelayRequest } from "../../lib/review-host-relay.ts";

type Body = Record<string, any>;
export interface CoordinatorRuntimeOptions {
	/** The host has a UI; false models print/RPC sessions with no human display. */
	hasUI?: boolean;
	/** Provider `advisory_findings` carried by the approved last-event closure. */
	advisoryFindings?: unknown;
	/** Provider `reviewer_results` carried by the approved last-event closure. */
	reviewerResults?: unknown;
	/** Provider `findings` of the STATUS correction request (scenario "correction"). */
	correctionFindings?: unknown;
	/** Effective native review mode per read; the fixture defaults to on. */
	mode?: (read: number, nativeCalls: readonly string[]) => "on" | "off";
	/**
	 * "refuter": a two-lens reviewer group whose findings need the refuter. The
	 * group's submissions return no closure, so the facade reconciles it through
	 * STATUS; STATUS then offers one host-mediated refuter slot, whose capture
	 * returns the approved closure. "refuter-reoffers-group": the same, except
	 * that every STATUS after the reconciliation offers the same group again.
	 * "group": the same two-lens group, whose last submission returns the
	 * approved closure (a lens-only review).
	 * "untracked-selection": a fresh review is due, and pre-lineage STATUS asks
	 * for the intended-untracked selection (status/v7); a STATUS that carries the
	 * selection submission offers START, and native START records its request
	 * and fails. "provider-role": the "refuter" group, after which STATUS offers
	 * an older provider's self-contained refuter vector (--execute=true) whose
	 * capture returns the provider-role artifact, not a closure.
	 * "correction": STATUS asks for a correction plan (correction_plan_required)
	 * with a correction request carrying `correctionFindings`. "escalated":
	 * STATUS stops (native_stop_required) with the provider's escalation.
	 */
	scenario?: "single" | "group" | "refuter" | "refuter-reoffers-group" | "untracked-selection" | "provider-role" | "correction" | "escalated";
	/** Passed to every tool execute as its abort signal. */
	signal?: AbortSignal;
	/** Called right after a reviewer submission made the fixture's closure approved. */
	onApproved?: () => void;
	/** Called on every native STATUS read, after it is recorded, with the fixture's state; may throw. */
	onStatus?: (state: string) => void;
	/** The session's working directory when it differs from the repository root `cwd`. */
	sessionCwd?: string;
	/**
	 * Prepares each reviewer run instead of the fixture's stub preparation: the
	 * group seam then runs the production `runReviewHostRelayReviewerGroup`
	 * with it, and the single seam calls it before the fixture's submission.
	 * Submissions stay the fixture's own.
	 */
	relayPrepare?: ReviewHostRelayPreparationRunner;
	/** `ctx.modelRegistry` handed to the facade; the fixture defaults to none. */
	modelRegistry?: unknown;
	/** Pi's effective transport setting (`pi.getSettings().transport`). */
	transport?: string;
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
	// An older provider's self-contained refuter vector: Go runs the role itself.
	const roleVectorInput = {
		name: "provider_refuter", schema: "https://gentle-ai.dev/schema/review/refuter/v1", captureOperation: "review.capture-refuter",
		arguments: [...roleArguments, { name: "agent", value: "pi", token: "--agent=pi" }, { name: "execute", value: "true", token: "--execute=true" }],
	} as unknown as ReviewCollectInputV3;
	const roleVector = { ...refuting, nextTransition: { kind: "collect", reasonCode: "provider_role_required", collect: { inputs: [roleVectorInput] } },
		raw: { ...raw, next_transition: { kind: "collect", reason_code: "provider_role_required" } } } as unknown as ReviewStatusV3;
	// A pre-lineage STATUS that asks the parent to choose intended untracked files.
	const selectionInput = {
		name: "intended_untracked_selection", schema: "gentle-ai.review-intended-untracked-selection/v1", captureOperation: "external.select_intended_untracked",
		arguments: [
			{ name: "target_identity", value: target }, { name: "projection", value: "workspace" },
			{ name: "base_tree", value: reviewing.projection.baseTree }, { name: "candidate_tree", value: reviewing.projection.currentCandidateTree },
			{ name: "eligible_paths_json", value: JSON.stringify(["untracked.md"]) }, { name: "expected_untracked_inventory", value: target },
		],
		submission: { operationToken: "status", argumentTokens: ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", "--intended-untracked-selection={{value}}"],
			values: [{ slot: "intended_untracked_selection", domain: "schema_bound_json", schema: "gentle-ai.review-intended-untracked-selection/v1", substitutionLocation: 4 }] },
	} as unknown as ReviewCollectInputV3;
	const selecting = { ...reviewing, authority: undefined, nextTransition: { kind: "collect", reasonCode: "intended_untracked_selection_required", collect: { inputs: [selectionInput] } },
		raw: { schema: "gentle-ai.review-integration.status/v7", target_identity: target, next_transition: { kind: "collect", reason_code: "intended_untracked_selection_required", collect: { inputs: [] } } } } as unknown as ReviewStatusV3;
	// The pre-lineage STATUS once the selection is submitted: START is offered.
	const startReady = { ...reviewing, authority: undefined, applicability: "unrelated", action: "start",
		nextTransition: { kind: "execute", reasonCode: "start_required", execute: { operation: "review.start", command: "gentle-ai review start --fixture-only", arguments: [], preconditions: [] } },
		raw: { schema: "gentle-ai.review-integration.status/v7", target_identity: target, next_transition: { kind: "execute", reason_code: "start_required", execute: { operation: "review.start" } } } } as unknown as ReviewStatusV3;
	// A STATUS asking for the correction plan, with the provider's correction request.
	const correctionRequest = { schema: "gentle-ai.review-correction-plan-request/v1", request_hash: `sha256:${"c".repeat(64)}`, lineage_id: lineage, expected_revision: revision,
		target_identity: target, correction_budget: 10, fix_finding_ids: ["B1"], findings: options.correctionFindings };
	const correcting = { ...reviewing, nextTransition: { kind: "collect", reasonCode: "correction_plan_required", collect: reviewing.nextTransition!.collect },
		raw: { ...raw, next_transition: { kind: "collect", reason_code: "correction_plan_required", correction_request: correctionRequest } } } as unknown as ReviewStatusV3;
	// A STATUS stop on an escalated review, with the provider's escalation diagnostic.
	const escalation = { cause: "unknown_causality", finding_ids: ["B1"], refuter_outcomes: [{ finding_id: "B1", outcome: "corroborated", proof: "Fixture refuter proof; not real review output." }] };
	const escalated = { ...reviewing, nextTransition: { kind: "stop", reasonCode: "native_stop_required" },
		raw: { ...raw, authority: { ...raw.authority, state: "escalated" }, escalation, next_transition: { kind: "stop", reason_code: "native_stop_required" } } } as unknown as ReviewStatusV3;
	const startRequests: Body[] = [];
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
	// Every provider request as received (shallow copies; a signal stays live).
	const nativeRequests: { operation: string; request: unknown }[] = [];
	const tools = new Map<string, any>();
	const native = {
		reviewMode: async (request: unknown) => {
			nativeRequests.push({ operation: "review-mode", request: { ...(request as Body) } });
			const effective = options.mode?.(++modeReads, nativeCalls) ?? "on";
			return { operation: "status", scope: "clone", status: { global: effective, cloneLocal: "", effective, source: "global" } };
		},
		targetStatus: async (request: Body) => {
			nativeRequests.push({ operation: "target-status", request: { ...request } });
			assert.notEqual(state, "burned", "no STATUS after burn");
			nativeCalls.push(`status:${state}`);
			options.onStatus?.(state);
			if (state === "approved") return approved;
			if (scenario === "untracked-selection") return request.intendedUntrackedSelection === undefined ? selecting : startReady;
			if (scenario === "correction") return correcting;
			if (scenario === "escalated") return escalated;
			if (scenario === "single") return reviewing;
			if (state === "refuting") {
				if (scenario === "provider-role") return roleVector;
				// The facade's own post-group reconciliation reads STATUS first.
				if (scenario === "refuter-reoffers-group" && reconciledReads++ > 0) return groupStatus(0);
				return refuting;
			}
			return groupStatus(groupSubmitted);
		},
		start: async (request: Body) => {
			nativeCalls.push("start");
			const { signal: _signal, ...recorded } = request;
			startRequests.push(structuredClone(recorded));
			throw new Error("fixture START records its request and fails");
		},
		captureProviderRole: async (request: Body) => {
			assert.equal(state, "refuting");
			assert.equal(request.captureOperation, "review.capture-refuter");
			nativeCalls.push("capture-provider-role"); state = "approved";
			return { schema: "gentle-ai.review-provider-role-capture/v1", lineageId: lineage, targetIdentity: target, role: "refuter", captured: true };
		},
		acknowledgeApproved: async (request: unknown) => {
			nativeRequests.push({ operation: "acknowledge-approved", request: { ...(request as Body) } });
			assert.equal(state, "approved");
			nativeCalls.push("acknowledge"); state = "burned";
			return { schema: "gentle-ai.review-acknowledged/v1", lineageId: lineage, targetIdentity: target, consumedRevision: revision };
		},
		assess: async () => {
			candidateReads++;
			if (scenario === "untracked-selection") {
				nativeCalls.push("assess");
				return { schema: "gentle-ai.review-assessment/v1", risk: "high", reasons: [], changedPaths: 1, changedLines: 1, reviewDue: true, reviewDueReason: "high_risk",
					candidate: { kind: "current-changes", consumed: false } };
			}
			return { schema: "gentle-ai.review-assessment/v1", risk: "passive", reasons: [], changedPaths: 1, changedLines: 1,
				candidate: { kind: "current-changes", consumed: state === "burned" } };
		},
	} as unknown as NativeReviewCli;
	const lensOf = (request: ReviewHostRelayRequest) => request.captureArgumentTokens.find((token) => token.startsWith("--lens="))?.slice("--lens=".length);
	__testing.setReviewHostRelayRunnerForTesting(async (request) => {
		relayRuns++;
		const promptByteLength = options.relayPrepare === undefined ? 0 : (await options.relayPrepare(request)).promptByteLength;
		if (scenario === "single") {
			assert.equal(state, "reviewing");
			nativeRequests.push({ operation: "capture:recorded-output", request: { captureArgumentTokens: [...request.captureArgumentTokens], submission: structuredClone(request.submission) } });
			nativeCalls.push("capture:recorded-output"); state = "approved";
			options.onApproved?.();
			const submission = approvedClosure("review/capture-result");
			return { submission, promptByteLength, resultByteLength: Buffer.byteLength(submission) };
		}
		assert.equal(state, "refuting");
		assert.equal(request.routingKey, "review-refuter");
		nativeRequests.push({ operation: "capture-refuter", request: { captureArgumentTokens: [...request.captureArgumentTokens], submission: structuredClone(request.submission) } });
		nativeCalls.push("capture-refuter"); state = "approved";
		options.onApproved?.();
		const submission = approvedClosure("review.capture-refuter");
		return { submission, promptByteLength, resultByteLength: Buffer.byteLength(submission) };
	});
	__testing.setReviewHostRelayGroupRunnersForTesting(async (requests) => {
		relayRuns += requests.length;
		if (options.relayPrepare !== undefined) return await runReviewHostRelayReviewerGroup(requests, options.relayPrepare);
		return requests.map((request) => ({ request, promptByteLength: 0, resultByteLength: 0 }));
	}, async (prepared) => {
		assert.equal(state, "reviewing");
		nativeRequests.push({ operation: "capture-result", request: { captureArgumentTokens: [...prepared.request.captureArgumentTokens], submission: structuredClone(prepared.request.submission) } });
		nativeCalls.push(`capture-result:${lensOf(prepared.request)}`);
		if (++groupSubmitted === GROUP_LENSES.length) {
			if (scenario === "group") {
				state = "approved";
				const submission = approvedClosure("review/capture-result");
				return { submission, promptByteLength: prepared.promptByteLength, resultByteLength: Buffer.byteLength(submission) };
			}
			state = "refuting";
		}
		// An admitted reviewer result that is not the last event: no closure.
		return { submission: "{}", promptByteLength: prepared.promptByteLength, resultByteLength: 2 };
	});
	createGentleAiExtension({ nativeReviewCli: native, candidateViews: null,
		// The coordinator is registered by default; "0" is its explicit opt-out.
		processEnv: { ...(variant === "coordinator" ? {} : { GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "0" }), GENTLE_AI_TELEMETRY: "0" },
	})({ on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool),
		...(options.transport === undefined ? {} : { getSettings: () => ({ transport: options.transport }) }) } as never);
	const forecasts: Body[] = [];
	const context = { cwd: options.sessionCwd ?? cwd, hasUI: options.hasUI ?? true, sessionManager: { getSessionId: () => "fixture-live-driver", getBranch: () => [], getSessionFile: () => undefined }, modelRegistry: options.modelRegistry };
	const facadeCalls: { name: string; parameters: Body; elapsed_ms: number }[] = [];
	return { tools, lineage, target, nativeCalls, nativeRequests, facadeCalls, forecasts, startRequests,
		async invoke(name: string, parameters: Body, signal: AbortSignal | undefined = options.signal) {
			const tool = tools.get(name); assert.ok(tool, `registered tool ${name}`);
			const began = performance.now();
			const result = await tool.execute("fixture-call", parameters, signal, (update: any) => forecasts.push(update.details), context);
			facadeCalls.push({ name, parameters, elapsed_ms: performance.now() - began });
			return result.details as Body;
		},
		/** Moves the session to another working directory, as a later turn in another workspace would. */
		moveSession: (next: string) => { context.cwd = next; },
		closed: () => state === "burned",
		modeReads: () => modeReads,
		relayRuns: () => relayRuns,
		candidateReads: () => candidateReads,
		close: () => { __testing.setReviewHostRelayRunnerForTesting(); __testing.setReviewHostRelayGroupRunnersForTesting(); },
	};
}
