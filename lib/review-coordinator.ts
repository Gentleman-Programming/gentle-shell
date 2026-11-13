/** Host orchestration of one ordinary native review. All authority stays in the existing facade. */
export type ReviewCoordinatorTool = "gentle_review" | "gentle_review_capture" | "gentle_review_capture_group";
type Body = Record<string, unknown>;
const record = (value: unknown): Body => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Body : {};
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// odd/tasks/review-one-call.md S5: what each finding says, in the reviewer's
// own words. Each id is looked up in `findings` by exact id and its claim is
// copied unchanged, cut at the last whole character within
// REVIEW_FINDING_CLAIM_MAX_BYTES. Claims are added in `ids` order until the
// next one would pass REVIEW_FINDING_CLAIMS_MAX_BYTES in total; the rest get no
// entry. An id with no matching finding, or with more than one, is omitted.
// Beside them, `truncated` lists the ids whose kept claim is a cut prefix and
// `omitted` the ids whose one matching claim the total limit left out, so
// neither passes for a whole claim. Reviewer text is untrusted: nothing routes
// on it. Shared by the facade's approved closure (advisory findings) and the
// run's correction request (correction findings).
export const REVIEW_FINDING_CLAIM_MAX_BYTES = 1024;
export const REVIEW_FINDING_CLAIMS_MAX_BYTES = 8192;

function withinUtf8Bytes(text: string, maximum: number): string {
	if (Buffer.byteLength(text) <= maximum) return text;
	let kept = "", bytes = 0;
	for (const character of text) {
		bytes += Buffer.byteLength(character);
		if (bytes > maximum) break;
		kept += character;
	}
	return kept;
}

export function boundedFindingClaims(ids: readonly string[], findings: readonly { id: string; claim: string }[]): { claims: Record<string, string>; truncated: string[]; omitted: string[] } | undefined {
	const entries: [string, string][] = [];
	const truncated: string[] = [], omitted: string[] = [];
	let total = 0;
	for (const id of ids) {
		const matches = findings.filter((finding) => finding.id === id);
		if (matches.length !== 1) continue;
		const claim = withinUtf8Bytes(matches[0]!.claim, REVIEW_FINDING_CLAIM_MAX_BYTES);
		if (omitted.length > 0 || total + Buffer.byteLength(claim) > REVIEW_FINDING_CLAIMS_MAX_BYTES) { omitted.push(id); continue; }
		total += Buffer.byteLength(claim);
		entries.push([id, claim]);
		if (claim !== matches[0]!.claim) truncated.push(id);
	}
	// fromEntries defines own data properties, so no id can reach a prototype.
	return entries.length === 0 ? undefined : { claims: Object.fromEntries(entries), truncated, omitted };
}

// The provider fields of a correction-request finding relayed in
// correction_findings, unchanged. The claim travels bounded in
// correction_finding_claims; evidence and proof references stay in the relayed
// STATUS envelope.
const CORRECTION_FINDING_REQUIRED = ["id", "lens", "location", "severity"] as const;
const CORRECTION_FINDING_OPTIONAL = ["evidence_class", "causal_disposition"] as const;

/** Relay keys for a correction request's findings, or none when any entry is malformed. Never routed on. */
function correctionFindingKeys(request: unknown): Body {
	const findings = record(request).findings;
	if (!Array.isArray(findings) || findings.length === 0) return {};
	const plain = (value: unknown): value is Body => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
	if (!findings.every((finding) => plain(finding) && [...CORRECTION_FINDING_REQUIRED, "claim"].every((key) => Object.hasOwn(finding, key) && nonempty(finding[key]))
		&& CORRECTION_FINDING_OPTIONAL.every((key) => !Object.hasOwn(finding, key) || typeof finding[key] === "string"))) return {};
	const entries = findings as Body[];
	const listed = entries.map((finding) => Object.fromEntries([...CORRECTION_FINDING_REQUIRED, ...CORRECTION_FINDING_OPTIONAL]
		.filter((key) => Object.hasOwn(finding, key)).map((key) => [key, finding[key]])));
	const bounded = boundedFindingClaims(entries.map((finding) => finding.id as string), entries as { id: string; claim: string }[]);
	return { correction_findings: listed,
		...(bounded === undefined ? {} : { correction_finding_claims: bounded.claims,
			...(bounded.truncated.length === 0 ? {} : { correction_finding_claims_truncated: bounded.truncated }),
			...(bounded.omitted.length === 0 ? {} : { correction_finding_claims_omitted: bounded.omitted }) }) };
}

// The provider fields of a non-blocking finding relayed in
// non_blocking_findings, unchanged; the claim travels bounded in
// non_blocking_finding_claims.
const NON_BLOCKING_FINDING_REQUIRED = ["id", "severity", "disposition"] as const;
const NON_BLOCKING_FINDING_OPTIONAL = ["lens", "location"] as const;
const NON_BLOCKING_FINDING_FIELDS = ["id", "lens", "location", "severity", "disposition"] as const;
export const NON_BLOCKING_FINDINGS_MAX_BYTES = 16 * 1024;

/**
 * The run's nested provider record without the raw `non_blocking_findings`
 * (L19): the bounded top-level keys are the only copy. Nothing else changes.
 */
function withoutRawNonBlockingFindings(result: Body): Body {
	const nested = result.result;
	if (nested === null || typeof nested !== "object" || Array.isArray(nested) || !Object.hasOwn(nested, "non_blocking_findings")) return result;
	const { non_blocking_findings: _raw, ...rest } = nested as Body;
	return { ...result, result: rest };
}

/**
 * Relay keys for STATUS `non_blocking_findings` (gentle-ai#6088), or none when
 * the provider sent no such key or any part of it is malformed. An empty
 * provider list is the provider's answer ("none") and is relayed as such.
 * Never routed on.
 */
function nonBlockingFindingKeys(status: unknown): Body {
	const native = record(status);
	if (!Object.hasOwn(native, "non_blocking_findings")) return {};
	const value = native.non_blocking_findings;
	const plain = (entry: unknown): entry is Body => entry !== null && typeof entry === "object" && !Array.isArray(entry) && [Object.prototype, null].includes(Object.getPrototypeOf(entry));
	if (!plain(value) || !nonempty(value.statement) || !Array.isArray(value.findings)) return {};
	const findings = value.findings as unknown[];
	if (!findings.every((finding) => plain(finding) && NON_BLOCKING_FINDING_REQUIRED.every((key) => Object.hasOwn(finding, key) && nonempty(finding[key]))
		&& Object.hasOwn(finding, "claim") && typeof finding.claim === "string"
		&& NON_BLOCKING_FINDING_OPTIONAL.every((key) => !Object.hasOwn(finding, key) || nonempty(finding[key])))) return {};
	// The list is bounded too (L19): findings are listed in provider order until
	// the next one would bring the list past NON_BLOCKING_FINDINGS_MAX_BYTES of
	// JSON; the rest are only counted. Claims are bounded over the listed ones.
	const listed: Body[] = [];
	let listBytes = 2;
	for (const finding of findings as Body[]) {
		const entry = Object.fromEntries(NON_BLOCKING_FINDING_FIELDS.filter((key) => Object.hasOwn(finding, key)).map((key) => [key, finding[key]]));
		const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + (listed.length === 0 ? 0 : 1);
		if (listBytes + entryBytes > NON_BLOCKING_FINDINGS_MAX_BYTES) break;
		listBytes += entryBytes;
		listed.push(entry);
	}
	const omittedCount = findings.length - listed.length;
	const entries = (findings as Body[]).slice(0, listed.length);
	const bounded = boundedFindingClaims(entries.map((finding) => finding.id as string), entries as { id: string; claim: string }[]);
	// Statement text shares the per-claim UTF-8 cap; the host marks a cut prefix explicitly.
	const statement = withinUtf8Bytes(value.statement, REVIEW_FINDING_CLAIM_MAX_BYTES);
	return { non_blocking_findings: { statement, findings: listed,
		...(statement === value.statement ? {} : { statement_truncated: true }) },
		...(omittedCount === 0 ? {} : { non_blocking_findings_omitted_count: omittedCount }),
		...(bounded === undefined ? {} : { non_blocking_finding_claims: bounded.claims,
			...(bounded.truncated.length === 0 ? {} : { non_blocking_finding_claims_truncated: bounded.truncated }),
			...(bounded.omitted.length === 0 ? {} : { non_blocking_finding_claims_omitted: bounded.omitted }) }) };
}

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
	/**
	 * True to continue past an informational reviewer-run forecast: after the
	 * host displayed all of it, or when the host has no display and the forecast
	 * is only recorded in the result. Absent or false stops with "forecast".
	 */
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

/** Follow bounded native continuations while retaining informational reviewer facts. */
export async function runReviewCoordinator(value: unknown, deps: ReviewCoordinatorDeps): Promise<Body> {
 const input = parseReviewCoordinatorInput(value);
 const now = deps.now ?? (() => performance.now());
 const began = now();
 const steps: Body[] = [];
 const forecasts: Body[] = [];
 const reviewerRuns: Body[] = [];
 const workspace = input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot };
 const selector = input.baseRef === undefined ? {} : { baseRef: input.baseRef, committedOnly: true };
 const selectorInput = input.baseRef === undefined ? {} : { input: JSON.stringify(selector) };
 let lineage = input.lineageId;
 let target: string | undefined;
 let started = false;
 const captured = new Set<string>();
 // advisory_findings of the latest admitted closure. The provider emits the key
 // only on an approved closure; once captured, every result this run returns
 // carries it (closed or stopped), so the parent holds it before any resume:
 // a resume that goes straight to the acknowledgement cannot recover it, since
 // neither bound STATUS nor the ACK envelope carries it. Never routed on.
 let closureFindings: { value: unknown } | undefined;
 // The facade's advisory_finding_claims of that same closure (each advisory id's
 // reviewer claim), relayed beside advisory_findings only; never routed on.
 let closureClaims: { value: unknown } | undefined;
 // The facade's marks on those claims: ids whose claim is a cut prefix, and ids
 // whose claim the per-closure limit left out. Relayed with the claims only.
 let closureClaimMarks: Body = {};
 // The correction request's findings and their bounded claims, once STATUS
 // asked for a correction plan: carried by every result after it. Never routed on.
 let correctionKeys: Body = {};
 // The provider's non-blocking findings of the STATUS that stopped the run on
 // a correction request or a stop (escalated). Never routed on.
 let nonBlockingKeys: Body = {};
 // That closure's capture envelope, kept unread for cancelled only while the
 // retained closure carries advisory_findings.
 let pendingCapture: Body | undefined;
 const checkCancelled = () => {
  if (deps.signal?.aborted) throw Object.assign(new Error("Review coordinator cancelled"), { name: "AbortError" });
 };
 const acknowledged = (body: Body) => body.outcome === "native-approved-acknowledgement-completed"
  && body.status === "closed" && body.authority === "burned";
 /** Record facade timing and evidence without changing routing or native authority. */
 const invoke = async (tool: ReviewCoordinatorTool, parameters: Body) => {
  checkCancelled();
  const start = now();
  const result = await deps.invoke(tool, { ...workspace, ...parameters });
  if (result.outcome === "reviewer-model-run-forecast") forecasts.push(structuredClone(result));
  if (tool !== "gentle_review" && result.outcome !== "reviewer-model-run-forecast") {
   // Informational snapshots only: never route or total SDK cost from these.
   // The transition limit bounds retention to this invocation. A group's new
   // all-prepared records supersede its submitted-only legacy reviewers array.
   const relay = record(result.host_relay);
   if (Array.isArray(relay.reviewer_runs) && relay.reviewer_runs.length > 0) reviewerRuns.push(...structuredClone(relay.reviewer_runs.map(record)));
   else if (relay.reviewer !== undefined) {
    const facts = Object.fromEntries(["lens", "order", "subject_hash", "role", "prompt_bytes", "result_bytes"]
     .filter(key => relay[key] !== undefined).map(key => [key, relay[key]]));
    reviewerRuns.push(structuredClone({ ...facts, reviewer: relay.reviewer }));
   } else if (record(result.failure).reviewer !== undefined) reviewerRuns.push(structuredClone({ reviewer: record(result.failure).reviewer }));
  }
  steps.push({ tool, operation: parameters.operation, elapsed_ms: now() - start,
   request_bytes: Buffer.byteLength(JSON.stringify({ ...workspace, ...parameters })), response_bytes: Buffer.byteLength(JSON.stringify(result)) });
  // A capture closure carrying advisory_findings is checked after the outcome
  // gate below, so a cancellation racing with it keeps the findings; any later
  // abort ends in cancelled through runReviewCoordinator's catch.
  if (!acknowledged(result) && !(tool !== "gentle_review" && Object.hasOwn(record(result.closure), "advisory_findings"))) checkCancelled();
  return result;
 };
 // The run's own inputs without a selection: after selection-required the
 // caller resumes the run with these plus the chosen untracked selection, so
 // START keeps the requested lenses and request context.
 const { untrackedScope: _scope, intendedUntracked: _paths, ...resumeInput } = structuredClone(input);
 const finish = (outcome: string, result: Body) => ({ schema: "gentle-pi.review-coordinator-experiment/v1", outcome, result: withoutRawNonBlockingFindings(result), forecasts, reviewer_runs: reviewerRuns,
  ...(closureFindings !== undefined ? { advisory_findings: closureFindings.value } : {}),
  ...(closureFindings !== undefined && closureClaims !== undefined ? { advisory_finding_claims: closureClaims.value, ...closureClaimMarks } : {}),
  ...structuredClone(correctionKeys),
  ...structuredClone(nonBlockingKeys),
  ...(outcome === "selection-required" ? { resume_input: resumeInput } : {}),
  ...(lineage === undefined ? {} : { lineage_id: lineage }), metrics: { elapsed_ms: now() - began, facade_calls: steps.length, steps } });
 const status = () => invoke("gentle_review", { operation: "status", lineageId: lineage, ...selectorInput });
 const drive = async (): Promise<Body> => {
 let details: Body;
 if (lineage === undefined) {
  const assessment = await invoke("gentle_review", { operation: "assess", ...selectorInput });
  if (assessment.reviewDue === false && input.requestContextPath !== undefined) return finish("request-context-requires-fresh-review", assessment);
  if (assessment.reviewDue !== true) return finish(assessment.reviewDue === false ? "not-due" : "assessment-unavailable", assessment);
  details = await invoke("gentle_review", { operation: "inspect", ...selectorInput,
   ...(input.untrackedScope === undefined ? {} : { untrackedScope: input.untrackedScope }),
   ...(input.intendedUntracked === undefined ? {} : { intendedUntracked: input.intendedUntracked }) });
 } else details = await status();
 for (let count = 0; count < 24; count++) {
  // Only STATUS/INSPECT supplies routing. Capture response state and native
  // reason codes never participate in host decisions.
  checkCancelled();
  const native = record(details.result);
  const offeredLineage = native.lineage_id ?? record(native.authority).lineage_id;
  if (nonempty(offeredLineage)) {
   if (input.requestContextPath !== undefined && !started) return finish("request-context-requires-fresh-review", details);
   if (lineage !== undefined && lineage !== offeredLineage) return finish("binding-drift", details);
   lineage = offeredLineage;
  }
  if (nonempty(native.target_identity)) {
   if (target !== undefined && target !== native.target_identity) return finish("binding-drift", details);
   target = native.target_identity;
  }
  if (details.failure !== undefined || details.native_failure !== undefined || details.reconciliation !== undefined || details.reconciliation_failure !== undefined) return finish("blocked", details);
  const transition = record(native.next_transition);
  if (transition.kind === "stop") {
   // Read for relay only, after the routing decision above.
   nonBlockingKeys = nonBlockingFindingKeys(native);
   return finish("stopped", details);
  }
  if (transition.kind === "execute") {
   const operation = record(transition.execute).operation;
   if (operation === "review.start") {
    if (started || lineage !== undefined) return finish("blocked", details);
    started = true;
    details = await invoke("gentle_review", { operation: "start", input: JSON.stringify({ mode: "ordinary", ...selector,
     ...(input.requestContextPath === undefined ? {} : { requestContextPath: input.requestContextPath }),
     ...(input.lenses === undefined ? {} : { lenses: input.lenses, lensesReason: input.lensesReason }) }) });
    if (details.outcome === "native-review-consent-required") return finish("consent-required", details);
    const issued = record(details.result).lineage_id;
    if (!nonempty(issued)) return finish("blocked", details);
    lineage = issued;
   } else if (operation === "review.acknowledge-approved") {
    if (lineage === undefined || target === undefined) return finish("blocked", details);
    const ack = await invoke("gentle_review", { operation: "acknowledge-approved", lineageId: lineage });
    // The facade verifies the native ACK. Preserve that terminal envelope;
    // never query STATUS/ASSESS or replay authority after its burn.
    return finish(acknowledged(ack) && ack.lineage_id === lineage && ack.target_identity === target ? "closed" : "blocked", ack);
   } else if (operation !== "review.status") return finish("handoff", details);
   details = await status();
   continue;
  }
  if (transition.kind !== "collect") return finish("blocked", details);
  const entries = Array.isArray(details.collectBindings) ? details.collectBindings.map(record) : [];
  // Native explicitly supplies the authored correction request. Do not derive
  // host routing metadata from submission domains or inspect opaque bindings.
  if (transition.correction_request !== undefined) {
   // Read for relay only, after the routing decision above. The correction
   // fields are returned only beside the provider's answer to the
   // non-blocking question (L21): without it, a parent holding only the
   // findings to correct would never learn the non-blocking ones, so the
   // result stays as before T11 and the parent reads the review as it did.
   nonBlockingKeys = nonBlockingFindingKeys(native);
   if (Object.hasOwn(nonBlockingKeys, "non_blocking_findings")) correctionKeys = correctionFindingKeys(transition.correction_request);
   return finish("input-required", details);
  }
  // The facade's own pre-lineage intended-untracked selection (selectionBinding
  // and nextStep, no collectBindings): the parent chooses, never the run. The
  // facade's nextStep names the single selection operation, which would start
  // without this run's intent, so only resume_input names the way on; the
  // selectionBinding stays because its eligible paths are what the choice is
  // made from.
  if (entries.length === 0 && typeof details.selectionBinding === "string") {
   const { nextStep: _singleOperation, ...selection } = details;
   // Without a caller root, name the root INSPECT resolved, so a resume from a
   // session in another workspace still reviews the one this selection is for.
   if (input.workspaceRoot === undefined && nonempty(details.workspace_root)) resumeInput.workspaceRoot = details.workspace_root;
   return finish("selection-required", selection);
  }
  if (entries.length === 0) return finish("input-required", details);
  if (lineage === undefined || target === undefined) return finish("blocked", details);
  const bindings = entries.map(entry => entry.collectBinding);
  if (!bindings.every(nonempty)) return finish("blocked", details);
  if (new Set(bindings).size !== bindings.length || bindings.some(binding => captured.has(binding))) return finish("repeated-capture", details);
  bindings.forEach(binding => captured.add(binding));
  const tool = bindings.length === 1 ? "gentle_review_capture" : "gentle_review_capture_group";
  const parameters = bindings.length === 1 ? { lineageId: lineage, collectBinding: bindings[0] } : { lineageId: lineage, collectBindings: bindings };
  let capture = await invoke(tool, parameters);
  if (capture.outcome === "reviewer-model-run-forecast") {
   if (await deps.presentForecast?.(capture) !== true) return finish("forecast", capture);
   capture = await invoke(tool, { ...parameters, reviewerRunAcknowledged: true });
  }
  // A group whose every reviewer result was admitted without a closing event
  // reports native-reviewer-group-status-reconciled after the facade's own
  // bound STATUS confirmed lineage and target and offered no further reviewer
  // capture (gentle_review_capture_group). Like any accepted capture, the next
  // step comes only from the bound STATUS read below. Drift, an uncertain
  // submission or a failed reconciliation carries another outcome or a
  // failure/reconciliation field and stays blocked.
  const reconciledGroup = tool === "gentle_review_capture_group" && capture.outcome === "native-reviewer-group-status-reconciled" && capture.status === "reconciled";
  // An older provider's self-contained role vector (--execute=true): Go ran the
  // refuter or validator and admitted it, returning the role artifact instead
  // of a closure. Like an admitted reviewer result, bound STATUS routes next.
  const capturedRole = tool === "gentle_review_capture" && capture.outcome === "native-provider-role-captured" && capture.status === "captured";
  if (!(["native-last-event-closure", "native-reviewer-result-captured"].includes(String(capture.outcome)) || reconciledGroup || capturedRole)
   || capture.failure !== undefined || capture.reconciliation !== undefined
   || capture.native_failure !== undefined || capture.reconciliation_failure !== undefined) {
   checkCancelled();
   return finish("blocked", capture);
  }
  if (Object.hasOwn(capture, "closure")) {
   // Read only these keys' presence and value; closure state and variants stay unread.
   const closure = record(capture.closure);
   closureFindings = Object.hasOwn(closure, "advisory_findings") ? { value: structuredClone(closure.advisory_findings) } : undefined;
   // Relayed only as a plain object of strings; any other shape is dropped.
   const claims = closure.advisory_finding_claims;
   const plainStrings = claims !== null && typeof claims === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(claims))
    && Object.values(claims).every(value => typeof value === "string");
   closureClaims = closureFindings !== undefined && Object.hasOwn(closure, "advisory_finding_claims") && plainStrings ? { value: structuredClone(claims) } : undefined;
   // Each mark is relayed only as an array of strings; any other shape is dropped.
   closureClaimMarks = Object.fromEntries(["advisory_finding_claims_truncated", "advisory_finding_claims_omitted"]
    .filter(key => Array.isArray(closure[key]) && (closure[key] as unknown[]).every(id => typeof id === "string"))
    .map(key => [key, structuredClone(closure[key])]));
   pendingCapture = closureFindings === undefined ? undefined : capture;
  }
  checkCancelled();
  details = await status();
 }
 return finish("transition-limit", details);
 };
 try {
  return await drive();
 } catch (error) {
  // Cancelled after an admitted approved closure with findings, before the
  // acknowledgement completed (which returns closed above): return its findings
  // and dispatch nothing more; resuming by lineageId reaches the acknowledgement.
  // Without such a closure, or for a failure other than the abort, rethrow.
  // The abort itself is an AbortError-named error (checkCancelled, the facade's
  // reviewCancellation, the native CLI's own abort, the signal's default
  // reason) or the signal's own reason (a custom reason, such as a timeout,
  // that a facade wait rejects with); any other error is a real failure.
  const abort = deps.signal?.aborted === true
   && ((error instanceof Error || error instanceof DOMException) && error.name === "AbortError" || error === deps.signal.reason);
  if (pendingCapture === undefined || !abort) throw error;
  // The capture's status ("closed") and state ("approved") describe the
  // capture, not the run, which is neither closed nor acknowledged: drop them.
  const { status: _status, state: _state, closure, ...envelope } = pendingCapture;
  const { state: _closureState, ...pending } = record(closure);
  return finish("cancelled", { ...envelope, closure: pending });
 }
}
