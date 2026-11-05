/** Experimental host orchestration. All authority stays in the existing facade. */
export type ReviewCoordinatorTool = "gentle_review" | "gentle_review_capture" | "gentle_review_capture_group";
type Body = Record<string, unknown>;
const record = (value: unknown): Body => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Body : {};
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export interface ReviewCoordinatorInput {
	workspaceRoot?: string;
	baseRef?: string;
	committedOnly?: true;
	lineageId?: string;
	lenses?: string[];
	lensesReason?: string;
	requestContextPath?: string;
	untrackedScope?: "exclude" | "select";
	intendedUntracked?: string[];
}

export interface ReviewCoordinatorDeps {
	invoke(tool: ReviewCoordinatorTool, parameters: Body): Promise<Body>;
	/** Native read-only assessment, bound to the retained review selector. Never STATUS. */
	confirmCurrentCandidate?(lineageId: string): Promise<{ consumed?: boolean }>;
	/** True only after the host has displayed the entire informational forecast. */
	presentForecast?(details: Body): Promise<boolean>;
	signal?: AbortSignal;
	now?: () => number;
}

export function parseReviewCoordinatorInput(value: unknown): ReviewCoordinatorInput {
	const input = record(value);
	if (input !== value) throw new Error("Review coordinator input must be an object");
	const allowed = ["workspaceRoot", "baseRef", "committedOnly", "lineageId", "lenses", "lensesReason", "requestContextPath", "untrackedScope", "intendedUntracked"];
	if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("Unsupported review coordinator input");
	for (const key of ["workspaceRoot", "baseRef", "lineageId", "lensesReason"]) {
		if (input[key] !== undefined && !nonempty(input[key])) throw new Error(`${key} must be nonempty`);
	}
	if ((input.baseRef !== undefined) !== (input.committedOnly === true) || (input.committedOnly !== undefined && input.committedOnly !== true)) throw new Error("baseRef requires committedOnly: true and vice versa");
	if ((input.lenses !== undefined) !== (input.lensesReason !== undefined)) throw new Error("lenses and lensesReason must be supplied together");
	if (input.requestContextPath !== undefined && (!nonempty(input.requestContextPath) || input.requestContextPath.trim() !== input.requestContextPath || input.requestContextPath.includes("\0"))) throw new Error("Invalid requestContextPath");
	if (input.requestContextPath !== undefined && input.lineageId !== undefined) throw new Error("requestContextPath requires a fresh review; existing lineage intent is immutable");
	if (input.lenses !== undefined && (!Array.isArray(input.lenses) || input.lenses.length < 1 || input.lenses.length > 4 || !input.lenses.every((lens) => ["risk", "resilience", "readability", "reliability"].includes(lens)) || new Set(input.lenses).size !== input.lenses.length)) throw new Error("Invalid review lenses");
	if (input.untrackedScope !== undefined && !["exclude", "select"].includes(String(input.untrackedScope))) throw new Error("Invalid untrackedScope");
	if (input.untrackedScope === "select" && (!Array.isArray(input.intendedUntracked) || !input.intendedUntracked.every(nonempty))) throw new Error("select requires intendedUntracked");
	if (input.intendedUntracked !== undefined && input.untrackedScope !== "select") throw new Error("intendedUntracked requires select");
	return input as ReviewCoordinatorInput;
}

export async function runReviewCoordinator(value: unknown, deps: ReviewCoordinatorDeps): Promise<Body> {
	const input = parseReviewCoordinatorInput(value);
	const now = deps.now ?? (() => performance.now());
	const began = now();
	const steps: Body[] = [];
	let scopeCheck: Body | undefined;
	const workspace = input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot };
	const selector = input.baseRef === undefined ? {} : { baseRef: input.baseRef, committedOnly: true };
	const selectorInput = input.baseRef === undefined ? {} : { input: JSON.stringify(selector) };
	let lineage = input.lineageId;
	let target: string | undefined;
	let started = false;
	const capturedBindings = new Set<string>();
	let validationAttempted = false;
	const checkCancelled = () => {
		if (deps.signal?.aborted) throw Object.assign(new Error("Review coordinator cancelled"), { name: "AbortError" });
	};
	const invoke = async (tool: ReviewCoordinatorTool, parameters: Body) => {
		checkCancelled();
		const start = now();
		const result = await deps.invoke(tool, { ...workspace, ...parameters });
		steps.push({ tool, operation: parameters.operation, elapsed_ms: now() - start,
			request_bytes: Buffer.byteLength(JSON.stringify({ ...workspace, ...parameters })), response_bytes: Buffer.byteLength(JSON.stringify(result)) });
		if (!(parameters.operation === "acknowledge-approved" && result.status === "closed" && result.authority === "burned")) checkCancelled();
		return result;
	};
	const finish = (outcome: string, result: Body) => ({
		schema: "gentle-pi.review-coordinator-experiment/v1", outcome, result,
		...(lineage === undefined ? {} : { lineage_id: lineage }),
		...(scopeCheck === undefined ? {} : { current_candidate: scopeCheck }),
		metrics: { elapsed_ms: now() - began, facade_calls: steps.length, steps },
	});
	const finishAcknowledgement = async (burn: Body) => {
		// A confirmed burn is evidence about the frozen target, not a proof that
		// the working candidate stayed unchanged until this response. Keep that
		// envelope intact even when the readback fails or cancellation races it.
		scopeCheck = { status: "unconfirmed" };
		if (!lineage || !deps.confirmCurrentCandidate || deps.signal?.aborted) return finish("closed-scope-unconfirmed", burn);
		const start = now();
		try {
			const current = await deps.confirmCurrentCandidate(lineage);
			scopeCheck = { status: current.consumed === true ? "reviewed" : current.consumed === false ? "unreviewed" : "unconfirmed", elapsed_ms: now() - start };
			return finish(current.consumed === true ? "closed" : current.consumed === false ? "candidate-changed-after-close" : "closed-scope-unconfirmed", burn);
		} catch {
			scopeCheck = { status: "unconfirmed", elapsed_ms: now() - start };
			return finish("closed-scope-unconfirmed", burn);
		}
	};
	const boundStatus = () => invoke("gentle_review", { operation: "status", lineageId: lineage, ...selectorInput });
	let details: Body;
	if (lineage === undefined) {
		const assessment = await invoke("gentle_review", { operation: "assess", ...selectorInput });
		if (assessment.reviewDue === false && input.requestContextPath !== undefined) return finish("request-context-requires-fresh-review", assessment);
		if (assessment.reviewDue !== true) return finish(assessment.reviewDue === false ? "not-due" : "assessment-unavailable", assessment);
		details = await invoke("gentle_review", { operation: "inspect", ...selectorInput,
			...(input.untrackedScope === undefined ? {} : { untrackedScope: input.untrackedScope }),
			...(input.intendedUntracked === undefined ? {} : { intendedUntracked: input.intendedUntracked }) });
	} else details = await boundStatus();
	// A bound covers at most one ordinary transaction. Unknown routes and all
	// maintenance operations return to the caller. Never parse binding strings.
	for (let transitions = 0; transitions < 24; transitions++) {
		checkCancelled();
		const native = record(details.result);
		const closure = record(details.closure);
		const authority = record(native.authority);
		const offeredLineage = native.lineage_id ?? authority.lineage_id ?? details.lineage_id ?? closure.lineage_id;
		if (nonempty(offeredLineage)) {
			if (input.requestContextPath !== undefined && !started) return finish("request-context-requires-fresh-review", details);
			if (lineage !== undefined && lineage !== offeredLineage) return finish("binding-drift", details);
			lineage = offeredLineage;
		}
		const offeredTarget = native.target_identity ?? details.target_identity ?? closure.target_identity;
		if (nonempty(offeredTarget)) {
			if (target !== undefined && target !== offeredTarget) return finish("binding-drift", details);
			target = offeredTarget;
		}
		if (details.outcome === "native-approved-acknowledgement-completed" && details.status === "closed" && details.authority === "burned") return finishAcknowledgement(details);
		if (details.outcome === "native-review-consent-required") return finish("consent-required", details);
		const state = native.state ?? authority.state ?? details.state ?? closure.state;
		const transition = record(native.next_transition ?? details.next_transition);
		const entries = Array.isArray(details.collectBindings) ? details.collectBindings : [];
		// Go can keep correction_required while offering validation of an edited
		// candidate. Resume only that single typed slot; never parse its binding
		// or author a correction plan from the host.
		const validationOffered = input.lineageId !== undefined && transition.kind === "collect"
			&& transition.reason_code === "targeted_validation_required" && entries.length === 1
			&& record(entries[0]).captureOperation === "review.capture-validation";
		if ((state === "correction_required" || state === "validating") && !validationOffered) return finish("correction-required", details);
		if (validationOffered && validationAttempted) return finish("repeated-capture", details);
		if (state === "declined" || native.action === "declined") return finish("declined", details);
		// Failure/reconciliation envelopes are evidence to surface, never a route
		// to replay or silently continue, even if they embed a usable STATUS.
		if (details.failure !== undefined || details.native_failure !== undefined || details.reconciliation !== undefined || details.reconciliation_failure !== undefined) return finish("blocked", details);
		const execute = record(transition.execute);
		if (transition.kind === "execute" && execute.operation === "review.start") {
			if (started || lineage !== undefined || details.status !== "ready" || target === undefined) return finish("blocked", details);
			started = true;
			details = await invoke("gentle_review", { operation: "start", input: JSON.stringify({ mode: "ordinary", ...selector,
				...(input.requestContextPath === undefined ? {} : { requestContextPath: input.requestContextPath }),
				...(input.lenses === undefined ? {} : { lenses: input.lenses, lensesReason: input.lensesReason }) }) });
			if (record(details.result).lineage_id !== undefined) details = await boundStatusAfterStart(details);
			continue;
		}
		if (transition.kind === "execute" && execute.operation === "review.acknowledge-approved") {
			if (lineage === undefined || target === undefined) return finish("blocked", details);
			details = await invoke("gentle_review", { operation: "acknowledge-approved", lineageId: lineage });
			// No STATUS, retry or second acknowledgement after this call.
			return details.outcome === "native-approved-acknowledgement-completed" && details.status === "closed" && details.authority === "burned" && details.target_identity === target
				? finishAcknowledgement(details) : finish("blocked", details);
		}
		if (transition.kind === "collect" && Array.isArray(details.collectBindings) && details.collectBindings.length > 0 && lineage !== undefined && target !== undefined) {
			const bindings = details.collectBindings.map((entry) => record(entry).collectBinding);
			if (!bindings.every(nonempty)) return finish("blocked", details);
			if (bindings.some((binding) => capturedBindings.has(binding))) return finish("repeated-capture", details);
			for (const binding of bindings) capturedBindings.add(binding);
			if (validationOffered) validationAttempted = true;
			const tool = bindings.length === 1 ? "gentle_review_capture" : "gentle_review_capture_group";
			const parameters = bindings.length === 1 ? { lineageId: lineage, collectBinding: bindings[0] } : { lineageId: lineage, collectBindings: bindings };
			const projected = record(record(entries[0]).forecast);
			const cost = record(projected.cost_forecast);
			const useProjected = validationOffered && projected.outcome === "reviewer-model-run-forecast"
				&& cost.transport === "pi_host_relay" && cost.model_runs === 1
				&& Array.isArray(cost.roles) && cost.roles.length === 1 && cost.roles[0] === "review-validator";
			if (useProjected && await deps.presentForecast?.(projected) !== true) return finish("forecast", projected);
			// The acknowledged capture still rechecks current native mode, session
			// and exact binding. A projected forecast grants no execution authority.
			let capture = await invoke(tool, { ...parameters, ...(useProjected ? { reviewerRunAcknowledged: true } : {}) });
			if (capture.outcome === "reviewer-model-run-forecast") {
				if (useProjected) return finish("forecast", capture);
				if (await deps.presentForecast?.(capture) !== true) return finish("forecast", capture);
				capture = await invoke(tool, { ...parameters, reviewerRunAcknowledged: true });
			}
			if (capture.outcome === "native-last-event-closure") {
				const capturedClosure = record(capture.closure);
				if ((capturedClosure.lineage_id !== undefined && capturedClosure.lineage_id !== lineage) || (capturedClosure.target_identity !== undefined && capturedClosure.target_identity !== target)) return finish("binding-drift", capture);
				if (record(capture.closure).state === "approved") {
					// Obtain the exact currently offered facade acknowledgement. Do not
					// execute a command extracted from a text next_action field.
					details = await boundStatus();
				} else details = capture;
			} else if (capture.outcome === "native-reviewer-result-captured") details = await boundStatus();
			else return finish("blocked", capture);
			continue;
		}
		// START can directly return its lineage without a ready-to-run transition.
		if (details.operation === "start" && lineage !== undefined && details.outcome === undefined) {
			details = await boundStatus();
			continue;
		}
		return finish("blocked", details);
	}
	return finish("transition-limit", details);

	async function boundStatusAfterStart(startResult: Body): Promise<Body> {
		const offered = record(startResult.result).lineage_id;
		if (!nonempty(offered)) return startResult;
		lineage = offered;
		return boundStatus();
	}
}
