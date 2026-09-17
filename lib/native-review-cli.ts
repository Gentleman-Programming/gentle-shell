import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { PackageLocalGentleAiBinaryMissingError, resolveGentleAiBinary } from "./gentle-ai-binary.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "./review-relay-contract.ts";
import { decodeReviewAssessmentV1, type ReviewAssessmentV1 } from "./review-risk-assessment.ts";
import {
	REVIEW_INTEGRATION_CONTRACT,
	decodeReviewAcknowledgedV1,
	decodeReviewConsentV2,
	decodeReviewConsentV3,
	decodeReviewFailureV2,
	decodeReviewLastEventClosureV1,
	decodeReviewRepairV2,
	decodeReviewResultArtifactV2,
	decodeReviewStartV3,
	decodeReviewStartV4,
	decodeReviewStatusV3,
	type ReviewAcknowledgedExpectationV1,
	type ReviewAcknowledgedV1,
	type ReviewConsentEnvelope,
	type ReviewFailureV2,
	type ReviewRepairV2,
	type ReviewNextTransitionV3,
	type ReviewStartState,
	type ReviewStartV3,
	type ReviewStartV4,
	type ReviewStatusV3,
	type ReviewLastEventClosureV1,
} from "./review-integration-v2.ts";

const execFileAsync = promisify(execFile);

// Negotiated review/status responses can carry a complete authority inventory.
// Keep the production default large enough for that payload while retaining a
// hard 64 MiB ceiling even when GENTLE_PI_REVIEW_MAX_BUFFER_BYTES is set.
export const NATIVE_REVIEW_DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const NATIVE_REVIEW_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const NATIVE_REVIEW_MAX_BUFFER_BYTES_ENV = "GENTLE_PI_REVIEW_MAX_BUFFER_BYTES";
const NATIVE_REVIEW_MAX_BUFFER_CONFIGURATION_HINT = "Inspect native review state before any new START; GENTLE_PI_REVIEW_MAX_BUFFER_BYTES accepts a positive decimal up to 67108864.";

function resolveNativeReviewMaxBufferBytes(environment: NodeJS.ProcessEnv = process.env): number {
	const value = environment[NATIVE_REVIEW_MAX_BUFFER_BYTES_ENV];
	if (value === undefined || !/^[1-9]\d*$/.test(value)) return NATIVE_REVIEW_DEFAULT_MAX_BUFFER_BYTES;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed <= NATIVE_REVIEW_MAX_BUFFER_BYTES
		? parsed
		: NATIVE_REVIEW_DEFAULT_MAX_BUFFER_BYTES;
}

export const NATIVE_REVIEW_OPERATION = {
	START: "review/start",
	STATUS: "review/status",
	RECLAIM: "review/reclaim",
	RECOVER: "review/recover",
	ABANDON: "review/abandon",
	QUARANTINE_LEGACY: "review/quarantine-legacy",
	RECONCILE_AUTHORITY: "review/reconcile-authority",
	REPAIR_LEGACY_ALIAS: "review/repair-legacy-alias",
	MODE: "review/mode",
	ASSESS: "review/assess",
	REPAIR: "review/repair",
	CAPTURE_RESULT: "review/capture-result",
	CAPTURE_CORRECTION_PLAN: "review/capture-correction-plan",
	CAPTURE_PROVIDER_ROLE: "review/capture-provider-role",
	CAPTURE_UNACHIEVABLE: "review/capture-unachievable",
	ACKNOWLEDGE_APPROVED: "review/acknowledge-approved",
	SDD_STATUS: "sdd-status",
	SDD_CONTINUE: "sdd-continue",
} as const;
export type NativeReviewOperation = (typeof NATIVE_REVIEW_OPERATION)[keyof typeof NATIVE_REVIEW_OPERATION];

export const NATIVE_REVIEW_ERROR_CODE = {
	UNAVAILABLE: "unavailable",
	TIMEOUT: "timeout",
	NON_ZERO: "non-zero",
	SIGNAL: "signal",
	UNEXPECTED_STDERR: "unexpected-stderr",
	OUTPUT_LIMIT: "output-limit",
	EMPTY_OUTPUT: "empty-output",
	MALFORMED_JSON: "malformed-json",
	SCHEMA_INCOMPATIBLE: "schema-incompatible",
	IDENTITY_MISMATCH: "identity-mismatch",
	VERSION_INCOMPATIBLE: "version-incompatible",
	CANCELLED: "cancelled",
	PACKAGE_BINARY_MISSING: "package-local-binary-missing",
	UNSUPPORTED_TRANSITION_OPERATION: "unsupported-transition-operation",
} as const;
export type NativeReviewErrorCode = (typeof NATIVE_REVIEW_ERROR_CODE)[keyof typeof NATIVE_REVIEW_ERROR_CODE];

export interface ExecFileRequest { file: string; arguments: readonly string[]; cwd: string; timeoutMs: number | undefined; maxBufferBytes: number; signal?: AbortSignal; }
export interface ExecFileResult { stdout: string; stderr: string; exitCode: number; signal: NodeJS.Signals | null; timedOut: boolean; outputLimitExceeded: boolean; }
export type ExecFileAdapter = (request: ExecFileRequest) => Promise<ExecFileResult>;

export interface NativeReviewCli {
	start(request: NativeStartRequest): Promise<NativeStartResult>;
	reviewStatus(request: NativeReviewStatusRequest): Promise<NativeReviewStatusResult>;
	targetStatus?(request: NativeTargetStatusRequest): Promise<ReviewStatusV3>;
	answerConsent?(request: NativeReviewConsentAnswerRequest): Promise<NativeReviewConsentAnswerResult>;
	reclaim?(request: NativeReviewReclaimRequest): Promise<NativeReviewRecoveryResult>;
	recover?(request: NativeReviewRecoverRequest): Promise<NativeReviewRecoveryResult>;
	abandon?(request: NativeReviewAbandonRequest): Promise<NativeReviewRecoveryResult>;
	quarantineLegacy?(request: NativeReviewLegacyQuarantineRequest): Promise<NativeReviewRecoveryResult>;
	reconcileAuthority?(request: NativeReviewReconcileAuthorityRequest): Promise<NativeReviewRecoveryResult>;
	repairLegacyAlias?(request: NativeReviewLegacyAliasRepairRequest): Promise<NativeReviewRecoveryResult>;
	repair?(request: NativeReviewRepairRequest): Promise<ReviewRepairV2>;
	captureResult?(request: NativeReviewCaptureResultRequest): Promise<NativeReviewCaptureResultOutcome>;
	captureCorrectionPlan?(request: NativeReviewCorrectionPlanCaptureRequest): Promise<ReviewLastEventClosureV1>;
	captureProviderRole?(request: NativeReviewProviderRoleCaptureRequest): Promise<NativeReviewProviderRoleCaptureOutcome>;
	// gentle-pi#638: records the host relay's declaration that one bound selected lens slot cannot be completed under current conditions. Younger than every binary pinned in NATIVE_CLI_CONTRACTS, so the capability is gated invocation-adjacent (see isNativeReviewUnachievableVerbRefused) instead of by a contract row.
	captureUnachievableLens?(request: NativeReviewUnachievableLensCaptureRequest): Promise<NativeReviewUnachievableLensCaptureArtifact>;
	// Dark until a negotiated version reports the `mode` capability true
	// (Design Decision #7, organic-rdd-parity). Plain versioned CLI operation,
	// outside the negotiated review-integration protocol — same shape as
	// reviewStatus/reclaim above.
	reviewMode?(request: NativeReviewModeRequest): Promise<NativeReviewModeResult>;
	// Read-only risk assessment (gentle-ai#4295, landing in parallel with
	// gentle-pi#662). Same plain-versioned shape as reviewMode/reviewStatus:
	// an older binary without the verb, or any other process/decode failure,
	// rejects the returned promise -- callers fail closed to `high` risk.
	assess?(request: NativeReviewAssessRequest): Promise<ReviewAssessmentV1>;
	// Exact native SDD readiness authority for an explicitly selected phase.
	// This is intentionally separate from review/RDD gates and carries no
	// delivery or review-transaction authority.
	sddStatus?(request: NativeSddStatusRequest): Promise<NativeSddStatusV2>;
	sddContinue?(request: NativeSddStatusRequest): Promise<NativeSddStatusV2>;
}

export const NATIVE_REVIEW_MODE_OPERATION = {
	STATUS: "status",
	ENABLE: "enable",
	DISABLE: "disable",
} as const;
export type NativeReviewModeOperation = (typeof NATIVE_REVIEW_MODE_OPERATION)[keyof typeof NATIVE_REVIEW_MODE_OPERATION];

export const NATIVE_REVIEW_MODE_VALUE = {
	UNSET: "",
	ON: "on",
	OFF: "off",
} as const;
export type NativeReviewModeValue = (typeof NATIVE_REVIEW_MODE_VALUE)[keyof typeof NATIVE_REVIEW_MODE_VALUE];

export const NATIVE_REVIEW_MODE_SOURCE = {
	DEFAULT: "default",
	GLOBAL: "global",
	CLONE_LOCAL: "clone_local",
} as const;
export type NativeReviewModeSource = (typeof NATIVE_REVIEW_MODE_SOURCE)[keyof typeof NATIVE_REVIEW_MODE_SOURCE];

export const NATIVE_REVIEW_MODE_REACH = {
	MACHINE: "machine",
	THIS_BUILD: "this_build",
} as const;
export type NativeReviewModeReach = (typeof NATIVE_REVIEW_MODE_REACH)[keyof typeof NATIVE_REVIEW_MODE_REACH];

export const NATIVE_REVIEW_MODE_SCOPE = {
	GLOBAL: "global",
	CLONE: "clone",
	BOTH: "both",
} as const;
export type NativeReviewModeScope = (typeof NATIVE_REVIEW_MODE_SCOPE)[keyof typeof NATIVE_REVIEW_MODE_SCOPE];

export interface NativeSddStatusRequest {
	changeName?: string;
	workspaceRoot: string;
	signal?: AbortSignal;
}

export type NativeSddPhase = "apply" | "verify" | "archive";
export type NativeSddDependencyState = "blocked" | "ready" | "all_done";

/**
 * The native CLI owns this complete v2 record. The decoder validates the fields
 * Pi relies on and returns the original object without adding, omitting, or
 * reconciling local SDD state.
 */
export interface NativeSddStatusV2 extends Readonly<Record<string, unknown>> {
	schemaName: "gentle-ai.sdd-status";
	schemaVersion: 2;
	changeName: string | null;
	artifactStore: "openspec" | "engram" | "hybrid" | "none";
	planningHome: Readonly<Record<string, unknown>> & { mode: "repo-local"; path: string };
	changeRoot: string | null;
	actionContext: Readonly<Record<string, unknown>> & { mode: "repo-local"; workspaceRoot: string; allowedEditRoots: readonly string[] };
	dependencies: Readonly<Record<(typeof NATIVE_SDD_DEPENDENCIES)[number], NativeSddDependencyState>>;
	phaseInstructions?: Readonly<Record<(typeof NATIVE_SDD_INSTRUCTION_PHASES)[number], readonly string[]> & { remediate?: readonly string[] }>;
	blockedReasons: readonly string[];
	nextRecommended: string;
	remediationState?: { required: boolean; complete: boolean; failedEvidenceRevision: string };
}

export interface NativeReviewModeRequest {
	cwd: string;
	operation: NativeReviewModeOperation;
	signal?: AbortSignal;
}

// Read-only risk assessment request (gentle-pi#662). `baseRef` requires
// explicit `committedOnly` acknowledgement, exactly like Native START's
// baseRef/committedOnly pairing, because both select a committed range
// instead of the ambient working tree.
export interface NativeReviewAssessRequest {
	cwd: string;
	baseRef?: string;
	committedOnly?: boolean;
	signal?: AbortSignal;
}

export interface NativeReviewModeStatus {
	global: NativeReviewModeValue;
	cloneLocal: NativeReviewModeValue;
	effective: "on" | "off";
	source: NativeReviewModeSource;
	revision?: string;
	reach?: NativeReviewModeReach;
}

export interface NativeReviewModeResult {
	operation: NativeReviewModeOperation;
	scope: NativeReviewModeScope;
	status: NativeReviewModeStatus;
}

// Exact-match tolerated-stderr allowlist for START only, gated on the `mode`
// capability being true (Design Decision #6, organic-rdd-parity). Byte-exact
// against gentle-ai's headless notices (internal/cli/review_mode.go
// reviewConsentSkippedNotice and its siblings) written when the switch is on
// but no interactive terminal answered the one-time consent question — which
// is always true when Pi spawns gentle-ai without a TTY. Any other text still
// fails closed as UNEXPECTED_STDERR.
//
// Each entry is one whole line the PINNED gentle-ai may write to the console
// stream while still succeeding. That last qualifier is what keeps this list
// honest: v2.4.0 deleted reviewConsentSkippedDefaultProvenance ("Reviews are
// on by default; this was never explicitly chosen. ..."), which used to ride
// with the skip notice whenever the resolved mode source was `default`. Under
// opt-in receipt-driven development a default-source clone is refused long
// before the consent ceremony runs, so the pinned binary can no longer emit
// that line and it is removed here rather than left as dead tolerance. Multi-
// line stderr is still expected in principle — these are separate Fprintln
// calls, never one joined string — which is why membership is per line.
export const REVIEW_CONSENT_NOTICES = Object.freeze([
	"Gentle AI reviewed this change without asking, because this session has no terminal to answer on. Run 'gentle-ai review mode disable' to turn reviews off, or 'gentle-ai review mode status' to see the current setting.",
	"Gentle AI could not read an answer, so it reviewed this change and will ask again next time.",
	"Gentle AI did not recognize that answer, so it reviewed this change and will ask again next time.",
	"Review skipped for this candidate at your request. It will be offered again on the next change.",
]);

// Every non-empty line must be allowlisted. Matching the whole stderr blob as
// one string only worked while exactly one notice could appear; the moment a
// second legitimate line joined it, an otherwise successful START was reported
// as unexpected-stderr.
function stderrIsTolerated(stderr: string, tolerated: readonly string[]): boolean {
	const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	return lines.length > 0 && lines.every((line) => tolerated.includes(line));
}

// gentle-ai main narrates the negotiated STATUS forecast head to a human on
// stderr while keeping the machine envelope on stdout (reviewNarrateForecast
// in internal/cli/review_narration.go, ground-truthed live against a main-line
// dev build). The pinned release does not emit it, so this narration is
// tolerated only for negotiated STATUS while the dev-binary override is
// configured; any other stderr keeps failing closed.
const FORECAST_NARRATION_LINES = Object.freeze([
	/^Forecast horizon: (?:partial|terminal)$/,
	/^step [0-9]+: (?:execute|collect|stop); reason_code=[a-z0-9_]+; description=.+$/,
	/^Re-query STATUS after completing this partial head\.$/,
]);
function stderrIsForecastNarration(stderr: string): boolean {
	const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	return lines.length > 0 && lines.every((line) => FORECAST_NARRATION_LINES.some((pattern) => pattern.test(line)));
}

export const NATIVE_REVIEW_RECOVER_DISPOSITION = ["scope_changed", "invalidated", "escalated"] as const;
export type NativeReviewRecoverDisposition = (typeof NATIVE_REVIEW_RECOVER_DISPOSITION)[number];

export interface NativeReviewReclaimRequest {
	cwd: string;
	lineage: string;
	actor: string;
	reason: string;
	signal?: AbortSignal;
}

export interface NativeReviewRecoverRequest {
	cwd: string;
	predecessorLineage: string;
	expectedPredecessorRevision: string;
	successorLineage: string;
	disposition: NativeReviewRecoverDisposition;
	actor: string;
	reason: string;
	maintainerAuthorization?: string;
	signal?: AbortSignal;
}

export const NATIVE_REVIEW_LEGACY_QUARANTINE = {
	DIAGNOSTIC: "historical findings freeze changed unrelated transaction state",
	DISPOSITION: "quarantine-malformed-freeze-event",
} as const;

export const NATIVE_REVIEW_RECONCILE_ANOMALIES = {
	COMBINED: "unchanged_target,malformed_recovery_authorization",
} as const;

export const NATIVE_REVIEW_LEGACY_ALIAS_REPAIR = {
	DIAGNOSTIC: "unsupported historical v1 operation alias",
	DISPOSITION: "quarantine-approved-historical-alias",
} as const;
export type NativeReviewReconcileAnomalies = (typeof NATIVE_REVIEW_RECONCILE_ANOMALIES)[keyof typeof NATIVE_REVIEW_RECONCILE_ANOMALIES];

export interface NativeReviewAbandonRequest {
	cwd: string;
	lineage: string;
	expectedRevision: string;
	snapshotIdentity: string;
	capturedLensResults: readonly string[];
	findingsPresent: boolean;
	actor: string;
	reason: string;
	maintainerAuthorization: string;
	signal?: AbortSignal;
}

export interface NativeReviewLegacyQuarantineRequest {
	cwd: string;
	repository: string;
	lineage: string;
	expectedRevision: string;
	diagnostic: (typeof NATIVE_REVIEW_LEGACY_QUARANTINE)["DIAGNOSTIC"];
	disposition: (typeof NATIVE_REVIEW_LEGACY_QUARANTINE)["DISPOSITION"];
	actor: string;
	reason: string;
	maintainerAuthorization: string;
	signal?: AbortSignal;
}

export interface NativeReviewReconcileAuthorityRequest {
	cwd: string;
	predecessorLineage: string;
	expectedPredecessorRevision: string;
	successorLineage: string;
	expectedSuccessorRevision: string;
	actor: string;
	reason: string;
	anomalies?: NativeReviewReconcileAnomalies;
	maintainerAuthorization: string;
	signal?: AbortSignal;
}

export interface NativeReviewLegacyAliasRepairRequest {
	cwd: string;
	repository: string;
	lineage: string;
	expectedRevision: string;
	diagnostic: (typeof NATIVE_REVIEW_LEGACY_ALIAS_REPAIR)["DIAGNOSTIC"];
	disposition: (typeof NATIVE_REVIEW_LEGACY_ALIAS_REPAIR)["DISPOSITION"];
	actor: string;
	reason: string;
	maintainerAuthorization: string;
	signal?: AbortSignal;
}

/** Raw audited native record; Pi relays it verbatim and never reinterprets it. */
export interface NativeReviewRecoveryResult { record: Record<string, unknown>; }

// Net-new negotiated `review.repair` (contract v2). `repair(request)` always
// runs a `--mode preflight` first; only an eligible assessment is ever
// executed, using the exact provider_inputs that assessment published — Pi's
// own NATIVE_REVIEW_LEGACY_ALIAS_REPAIR constants are never a source, only a
// disagreement check (Design Decision #6, migrate-review-integration-v2).
export interface NativeReviewRepairRequest {
	cwd: string;
	actor: string;
	reason: string;
	maintainerAuthorization: string;
	signal?: AbortSignal;
}

// `capture-result` is an additive headless command, NOT a negotiated
// repository operation: it accepts no --contract, and the provider's own
// transition tokens already carry the repository context -- it takes that or
// --cwd, never both. So Pi passes the tokens through verbatim and adds only
// --input. Reconstructing them would mean re-deriving a lineage, revision,
// target, lens slot, and subject hash the provider already issued.
export interface NativeReviewCaptureResultRequest {
	readonly argumentTokens: readonly string[];
	readonly resultDocument: string;
	// Only for the compatibility path-manifest mode, when the tokens carry no
	// repository context. Supplying both is refused by the provider.
	readonly cwd?: string;
	readonly signal?: AbortSignal;
}

export interface NativeReviewAdmittedResultManifest {
	readonly schema: string;
	readonly subjectHash: string;
	readonly admissionDecision: string;
	readonly lens?: string;
	readonly path?: string;
	readonly reference?: string;
}

/** A non-final reviewer capture acknowledges an admitted artifact; final captures close natively. */
export type NativeReviewCaptureResultOutcome = NativeReviewAdmittedResultManifest | ReviewLastEventClosureV1;

// The one continuation that burns approved authority. Its tokens are rendered
// by the provider in a closed order and are relayed verbatim: Pi never builds,
// reorders, or substitutes one, because a synthesized acknowledgement would be
// Pi deciding that a review is over. `binding` is the lineage, target, and
// revision the caller already holds from STATUS: when the provider answers the
// burn with a review-acknowledged/v1 envelope (gentle-ai #3947), that envelope
// must name exactly this burn.
export interface NativeReviewAcknowledgeApprovedRequest {
	readonly argumentTokens: readonly string[];
	readonly cwd: string;
	readonly binding?: ReviewAcknowledgedExpectationV1;
	readonly signal?: AbortSignal;
}

/** `undefined` is the pinned silent burn (every release up to v2.5.0-rc.3); an envelope is the #3947 typed burn. */
export type NativeReviewAcknowledgeApprovedOutcome = ReviewAcknowledgedV1 | undefined;

export interface NativeReviewCorrectionPlanCaptureRequest {
	readonly argumentTokens: readonly string[];
	readonly correctionLines: number;
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

// gentle-pi#311 P4-roles: one Go-owned non-lens provider role capture. The
// provider renders a SELF-CONTAINED authority-advancing vector
// (`review.capture-refuter` / `review.capture-validation` with binding tokens
// plus `--agent=pi --execute=true`, no submission descriptor); Pi executes the
// exact rendered invocation verbatim, in the foreground, and Go materializes
// the role prompt, spawns its own locked-down pi subprocess, and admits the
// raw verdict. Nothing here authors, parses, or transports role output.
export const NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_SCHEMA = "gentle-ai.review-provider-role-capture/v1";

// Capture operations and their terminal closure operations are independently
// named upstream. Keep this closed mapping explicit: capture-validation is the
// intentionally nonuniform `review/capture-validation` closure operation.
export const NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_CLOSURE_OPERATION = {
	"review.capture-refuter": "review.capture-refuter",
	"review.capture-validation": "review/capture-validation",
} as const;
type NativeReviewProviderRoleCaptureOperation = keyof typeof NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_CLOSURE_OPERATION;

function isNativeReviewProviderRoleCaptureOperation(operation: string): operation is NativeReviewProviderRoleCaptureOperation {
	return Object.hasOwn(NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_CLOSURE_OPERATION, operation);
}

export interface NativeReviewProviderRoleCaptureRequest {
	/** The provider-named capture operation, e.g. `review.capture-refuter`. */
	readonly captureOperation: string;
	/** Every provider-issued argument token, verbatim, in provider order. */
	readonly argumentTokens: readonly string[];
	/** Process working directory only; never rendered into the invocation. */
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

export interface NativeReviewProviderRoleCaptureArtifact {
	readonly schema: typeof NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_SCHEMA;
	readonly lineageId: string;
	readonly targetIdentity: string;
	readonly role: string;
	readonly captured: true;
}

// gentle-pi#638: the typed declaration that one bound selected lens slot cannot be completed under current conditions. Mirrored from Go's reviewUnachievableLensCaptureArtifact (internal/cli/review_capture_unachievable.go): same schema identity, same closed field set, and the same 512-byte detail bound Go enforces, so a declaration this client refuses locally can never reach a binary that would accept it, and vice versa.
export const NATIVE_REVIEW_UNACHIEVABLE_LENS_CAPTURE_SCHEMA = "gentle-ai.review-capture-unachievable/v1";
export const NATIVE_REVIEW_UNACHIEVABLE_LENS_DETAIL_LIMIT = 512;

export interface NativeReviewUnachievableLensCaptureRequest {
	/** Exact frozen review lineage identifier of the offered slot. */
	readonly lineageId: string;
	/** Exact frozen target identity of the offered slot. */
	readonly targetIdentity: string;
	/** Exact reviewing-authority revision the collect transition offered. */
	readonly expectedRevision: string;
	/** The offered slot's subject-hash; Go resolves the lens from it. */
	readonly requestHash: string;
	/** Short machine-readable cause, e.g. relay_transport_bound_exceeded. */
	readonly reason: string;
	/** Optional bounded evidence; refused above the Go-side byte limit. */
	readonly detail?: string;
	/** Opaque provider-issued repository context the slot carried, if any. */
	readonly repositoryContext?: string;
	/** Process working directory only; never rendered into the invocation. */
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

export interface NativeReviewUnachievableLensCaptureArtifact {
	readonly schema: typeof NATIVE_REVIEW_UNACHIEVABLE_LENS_CAPTURE_SCHEMA;
	readonly lineageId: string;
	readonly targetIdentity: string;
	readonly lens: string;
	readonly selectedOrder: number;
	readonly reason: string;
	readonly recorded: true;
}

// gentle-pi#638 fail-open capability gate: `review capture-unachievable` is younger than every released binary pinned in NATIVE_CLI_CONTRACTS, so the verb is gated invocation-adjacent instead of by a capability row. An older binary renders Go's exact `unknown review command "capture-unachievable"` refusal (internal/cli/review_facade.go) on stderr with no stdout, so the invocation rejects before any decode and the captured diagnostics are the only place that text survives. Every other failure -- a typed binding-mismatch refusal, a timeout, a decode failure -- is a real outcome the caller must surface, never a capability signal. Duck-typed on purpose: the classifier must survive a duplicated module instance exactly like the error it inspects.
const NATIVE_REVIEW_UNKNOWN_UNACHIEVABLE_VERB_REFUSAL = /unknown review command "capture-unachievable"/;

export function isNativeReviewUnachievableVerbRefused(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const stderr = (error as { diagnostics?: { stderr?: unknown } }).diagnostics?.stderr;
	return typeof stderr === "string" && NATIVE_REVIEW_UNKNOWN_UNACHIEVABLE_VERB_REFUSAL.test(stderr);
}

/** Refuter and validator captures close only when they are the native last event. */
export type NativeReviewProviderRoleCaptureOutcome = NativeReviewProviderRoleCaptureArtifact | ReviewLastEventClosureV1;

export const NATIVE_UNTRACKED_SCOPE = {
	EXCLUDE: "exclude",
	SELECT: "select",
} as const;
export type NativeUntrackedScope = (typeof NATIVE_UNTRACKED_SCOPE)[keyof typeof NATIVE_UNTRACKED_SCOPE];

export interface NativeIntendedUntrackedSelectionSubmission {
	readonly argumentTokens: readonly string[];
	readonly value: string;
}
interface NativeUntrackedSelectionRequest {
	untrackedScope?: NativeUntrackedScope;
	expectedUntrackedInventory?: string;
	intendedUntracked?: readonly string[];
	intendedUntrackedSelection?: NativeIntendedUntrackedSelectionSubmission;
}

export interface NativeStartRequest extends NativeUntrackedSelectionRequest {
	cwd: string;
	baseRef?: string;
	committedOnly?: boolean;
	lineageId?: string;
	policyPath?: string;
	focus?: string;
	targetIdentity?: string;
	projection?: "workspace" | "staged";
	signal?: AbortSignal;
}
export const NATIVE_REVIEW_CONSENT_ANSWER = { GRANTED: "granted", DECLINED: "declined" } as const;
export type NativeReviewConsentAnswer = (typeof NATIVE_REVIEW_CONSENT_ANSWER)[keyof typeof NATIVE_REVIEW_CONSENT_ANSWER];
export interface NativeReviewConsentAnswerRequest { cwd: string; consent: ReviewConsentEnvelope; answer: NativeReviewConsentAnswer; signal?: AbortSignal; }
export interface NativeReviewConsentDeclinedResult {
	kind: "declined";
	targetIdentity: string;
	projection: "workspace" | "staged";
	riskLevel: "medium" | "high";
	changedFiles: number;
	changedLines: number;
	consent: "declined_this_candidate";
	raw: Readonly<Record<string, unknown>>;
}
export interface NativeReviewConsentStartedResult { kind: "started"; start: NativeStartResult; }
export type NativeReviewConsentAnswerResult = NativeReviewConsentStartedResult | NativeReviewConsentDeclinedResult;
export interface NativeReviewStatusRequest { cwd: string; signal?: AbortSignal; }
export interface NativeTargetStatusRequest extends NativeUntrackedSelectionRequest {
	cwd: string;
	lineageId?: string;
	baseRef?: string;
	committedOnly?: boolean;
	projection?: "workspace" | "staged";
	/**
	 * The immutable reviewer runtime this host provides. Measured against the
	 * live 2.4.0-main provider: the materialize-marked relay slot (agent=pi,
	 * materialize=true, plus the provider submission) is offered ONLY when the
	 * caller names its agent; an agent-less status returns a bare
	 * capture-result input the host relay cannot consume. Providers older than
	 * v2.4.0 do not define the flag and refuse it, so callers probe and fall
	 * back rather than version-sniff.
	 */
	agent?: "pi";
	signal?: AbortSignal;
}
export const NATIVE_REVIEW_AUTHORITY_STATUS = {
	CLEAN: "clean",
	ACTIVE: "active",
	APPROVED: "approved",
	ESCALATED: "escalated",
	RESET_IN_PROGRESS: "reset-in-progress",
	SUPERSEDED: "superseded",
	RECOVERED: "recovered",
	SAME_LINEAGE_MIXED_COLLISION: "same-lineage-mixed-collision",
	INVALID: "invalid",
} as const;
export type NativeReviewAuthorityStatus = (typeof NATIVE_REVIEW_AUTHORITY_STATUS)[keyof typeof NATIVE_REVIEW_AUTHORITY_STATUS];

export const NATIVE_REVIEW_AUTHORITY_ENTRY_VERSION = {
	LEGACY_V1: "legacy-v1",
	COMPACT_V2: "compact-v2",
} as const;
export type NativeReviewAuthorityEntryVersion = (typeof NATIVE_REVIEW_AUTHORITY_ENTRY_VERSION)[keyof typeof NATIVE_REVIEW_AUTHORITY_ENTRY_VERSION];

export const NATIVE_REVIEW_AUTHORITY_ENTRY_STATUS = {
	...NATIVE_REVIEW_AUTHORITY_STATUS,
	INCOMPLETE_STORE_ENTRY: "incomplete-store-entry",
	HISTORICAL_PRE_RECEIPT: "historical-pre-receipt",
	INVALIDATED: "invalidated",
} as const;
export type NativeReviewAuthorityEntryStatus = (typeof NATIVE_REVIEW_AUTHORITY_ENTRY_STATUS)[keyof typeof NATIVE_REVIEW_AUTHORITY_ENTRY_STATUS];

export const NATIVE_REVIEW_LOCK_STATUS = {
	OWNED: "owned",
	AMBIGUOUS: "ambiguous",
	// gentle-ai 2.1.8 leaves review-transactions/v2/LOCK behind after ordinary
	// successful operations and inventories it as a released (dead-owner) entry
	// (#184). This stays a closed enum: lock status routes controller blocking
	// behavior, so unknown future statuses must keep failing closed instead of
	// being tolerated like diagnostic-only metadata.
	RELEASED: "released",
} as const;
export type NativeReviewLockStatus = (typeof NATIVE_REVIEW_LOCK_STATUS)[keyof typeof NATIVE_REVIEW_LOCK_STATUS];

export const NATIVE_REVIEW_LOCK_OWNER_SCHEMA = {
	V1: "gentle-ai.review-store-lock/v1",
} as const;
export type NativeReviewLockOwnerSchema = (typeof NATIVE_REVIEW_LOCK_OWNER_SCHEMA)[keyof typeof NATIVE_REVIEW_LOCK_OWNER_SCHEMA];

export interface NativeReviewLockOwner {
	schema: NativeReviewLockOwnerSchema;
	ownerId: string;
	pid: number;
	host: string;
	acquiredAt: string;
}
export const NATIVE_REVIEW_RECOVERY_DISPOSITION = {
	SCOPE_CHANGED: "scope_changed",
	INVALIDATED: "invalidated",
	ESCALATED: "escalated",
} as const;
export type NativeReviewRecoveryDisposition = (typeof NATIVE_REVIEW_RECOVERY_DISPOSITION)[keyof typeof NATIVE_REVIEW_RECOVERY_DISPOSITION];

export interface NativeReviewRecovery {
	predecessorLineageId: string;
	predecessorRevision: string;
	disposition: NativeReviewRecoveryDisposition;
	reason: string;
	actor: string;
	recoveredAt: string;
	maintainerAuthorization?: string;
}
export interface NativeReviewDiscardedWorkSummary {
	capturedLensResults: readonly string[];
	findingsPresent: boolean;
}
export interface NativeReviewAuthorityEntry {
	version: NativeReviewAuthorityEntryVersion;
	lineageId?: string;
	path: string;
	status: NativeReviewAuthorityEntryStatus;
	state?: string;
	revision?: string;
	snapshotIdentity?: string;
	chainIdentity?: string;
	recovery?: NativeReviewRecovery;
	discardedWork?: NativeReviewDiscardedWorkSummary;
	problems: readonly string[];
}
export interface NativeReviewAuthorityLock {
	version: NativeReviewAuthorityEntryVersion;
	lineageId?: string;
	path: string;
	status: NativeReviewLockStatus;
	owner?: NativeReviewLockOwner;
	problem?: string;
}
export interface NativeReviewAuthorityDiagnostic {
	path: string;
	problem: string;
}
export interface NativeReviewStatusResult {
	repository: string;
	complete: boolean;
	authoritative: boolean;
	status: NativeReviewAuthorityStatus;
	entries: readonly NativeReviewAuthorityEntry[];
	locks: readonly NativeReviewAuthorityLock[];
	diagnostics: readonly NativeReviewAuthorityDiagnostic[];
	raw: Record<string, unknown>;
}
export const NATIVE_START_ACTION = { CREATED: "created", RESUMED: "resumed", REPLAYED: "replayed", CLOSED: "closed", BLOCKED_SCOPE_ACTION: "blocked-scope-action" } as const;
export type NativeStartAction = (typeof NATIVE_START_ACTION)[keyof typeof NATIVE_START_ACTION];
export interface NativeStartResult { lineageId: string; state: ReviewStartState; riskLevel: string; selectedLenses: readonly string[]; changedFiles: number; changedLines: number; correctionBudget: number; action: NativeStartAction; lensesRequired: boolean; riskReasons?: readonly Record<string, unknown>[]; nextTransition?: ReviewNextTransitionV3; raw?: Readonly<Record<string, unknown>>; riskEvidence?: readonly string[]; hint?: string; }
export function isCanonicalProcessString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

interface NativeUntrackedSelection {
	untrackedScope?: NativeUntrackedScope;
	expectedUntrackedInventory?: string;
	intendedUntracked?: readonly string[];
}

function isNativeUntrackedPath(value: unknown): value is string {
	return isCanonicalProcessString(value)
		&& !posix.isAbsolute(value)
		&& !win32.isAbsolute(value)
		&& !value.includes("\\")
		&& value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function nativeUntrackedSelection(request: NativeUntrackedSelectionRequest): NativeUntrackedSelection {
	const { untrackedScope, expectedUntrackedInventory, intendedUntracked } = request;
	const declared = untrackedScope !== undefined || expectedUntrackedInventory !== undefined || intendedUntracked !== undefined;
	if (!declared) return {};
	if (
		(untrackedScope !== NATIVE_UNTRACKED_SCOPE.EXCLUDE && untrackedScope !== NATIVE_UNTRACKED_SCOPE.SELECT) ||
		!isCanonicalProcessString(expectedUntrackedInventory) ||
		(intendedUntracked !== undefined && (!Array.isArray(intendedUntracked) || intendedUntracked.some((path) => !isNativeUntrackedPath(path) || intendedUntracked.indexOf(path) !== intendedUntracked.lastIndexOf(path))))
	) {
		throw new TypeError("Native untracked selection must declare one scope, one inventory digest, and unique repository-relative paths");
	}
	if (untrackedScope === NATIVE_UNTRACKED_SCOPE.EXCLUDE && (intendedUntracked?.length ?? 0) > 0) {
		throw new TypeError("Native exclude untracked selection cannot include paths");
	}
	if (untrackedScope === NATIVE_UNTRACKED_SCOPE.SELECT && (intendedUntracked?.length ?? 0) === 0) {
		throw new TypeError("Native select untracked selection requires at least one path");
	}
	return {
		untrackedScope,
		expectedUntrackedInventory,
		intendedUntracked: intendedUntracked === undefined ? undefined : [...intendedUntracked],
	};
}

function nativeUntrackedSelectionArguments(selection: NativeUntrackedSelection): readonly string[] {
	if (selection.untrackedScope === undefined) return [];
	return [
		`--untracked-scope=${selection.untrackedScope}`,
		`--expected-untracked-inventory=${selection.expectedUntrackedInventory!}`,
		...(selection.untrackedScope === NATIVE_UNTRACKED_SCOPE.SELECT
			? selection.intendedUntracked!.map((path) => `--intended-untracked=${path}`)
			: []),
	];
}

const NATIVE_RISK_LEVEL = ["low", "medium", "high"] as const;

// gentle-ai's negotiated `start/v2` envelope is a closed schema
// (`additionalProperties: false`), so the two projections its plain sibling
// carries cannot be added to it without a new contract version. Both are
// projections of facts `start/v2` already reports as required fields, so a
// negotiated caller reconstructs them here instead of ending up with a worse
// recovery story than a plain one. These are Pi-side renderings of native
// facts, never a claim that the CLI sent them: the `riskEvidence`/`hint`
// capability rows stay dark for every version whose envelope omits them.
//
// Byte-for-byte mirrors of internal/cli/review_mode.go and review_facade.go.
// `reviewConsentEvidencePhrases` is documented there as the single phrasing
// source so its surfaces cannot drift, which makes this a second surface: an
// unrecognized reason code therefore renders nothing rather than guessing, and
// nativeRiskEvidencePhrases is pinned against a gentle-ai fixture in
// tests/native-review-parity.test.ts so a vocabulary change fails loudly.
const REVIEW_EMPTY_CANDIDATE_HINT =
	"the candidate has no pending changes; already-committed work can be reviewed by rerunning review start with --base-ref <commit> naming the base to compare against";
const REVIEW_MEDIUM_RISK_REASON = "this change is not purely passive documentation, so it gets one consolidated review.";
const REVIEW_EMPTY_CONTENT_CODE = "empty_content";
const REVIEW_RISK_SUBJECT_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
	service_token: "service credentials",
	shell_source: "shell scripting",
	process_boundary: "code that starts other processes",
	process_scan_limit: "code that starts other processes",
	executable_mode: "an executable permission change",
	executable_change: "an executable change",
	configuration_change: "a configuration change",
});
const REVIEW_RISK_SUBJECT_BY_SIGNAL: Readonly<Record<string, string>> = Object.freeze({
	auth: "authentication",
	update: "the update path",
	security: "security",
	payments: "payments",
	data_exposure: "data exposure",
	data_loss: "data loss",
	permissions: "permissions",
	shell_process: "shell or process execution",
});
// The Go signal switch has no empty default: every hot_path reason speaks, and
// an unmapped signal degrades to this rather than dropping the path entirely.
const REVIEW_RISK_UNKNOWN_SIGNAL_SUBJECT = "a sensitive area";

interface NativeRiskEvidenceReason {
	readonly code?: string;
	readonly signal?: string;
	readonly path?: string;
}

function nativeRiskEvidenceSubject(reason: NativeRiskEvidenceReason): string {
	const code = typeof reason.code === "string" ? reason.code : "";
	if (code === "hot_path") {
		const signal = typeof reason.signal === "string" ? reason.signal : "";
		return REVIEW_RISK_SUBJECT_BY_SIGNAL[signal] ?? REVIEW_RISK_UNKNOWN_SIGNAL_SUBJECT;
	}
	return REVIEW_RISK_SUBJECT_BY_CODE[code] ?? "";
}

function nativeRiskEvidencePhrase(reason: NativeRiskEvidenceReason): string {
	const path = typeof reason.path === "string" ? reason.path.trim() : "";
	// An empty file is named first and described second. Every other subject
	// reads "<what changed> in <path>", which for a file with no bytes would
	// assert something about content that is not there.
	if (reason.code === REVIEW_EMPTY_CONTENT_CODE) {
		return path === "" ? "" : `${path}, an empty file whose type cannot be determined from its content`;
	}
	const subject = nativeRiskEvidenceSubject(reason);
	if (subject === "" || path === "") return subject;
	return `${subject} in ${path}`;
}

export function nativeRiskEvidencePhrases(riskLevel: string, reasons: readonly NativeRiskEvidenceReason[]): readonly string[] {
	if (riskLevel !== "high" && riskLevel !== "medium") return [];
	const phrases = reasons.map((reason) => nativeRiskEvidencePhrase(reason)).filter((phrase) => phrase !== "");
	return riskLevel === "medium" ? [REVIEW_MEDIUM_RISK_REASON, ...phrases] : phrases;
}
const NATIVE_REVIEW_LENS = ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const;
const NATIVE_START_ACTION_VALUES = Object.values(NATIVE_START_ACTION);
// The pin table is intentionally preserved unchanged while #3587 is
// unpublished. Last-event capture support is exercised through the explicit
// dev-binary override; no source-level pin or contract-row mutation is allowed.
const ORGANIC_PARITY_DARK = { mode: false, riskEvidence: false, hint: false, delivery: false } as const;

export const NATIVE_CLI_CONTRACTS = Object.freeze({
	"2.1.4": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: false, inventory: false, reclaim: false, recover: false, abandon: false, quarantineLegacy: false, reconcileAuthority: false, repairLegacyAlias: false, ...ORGANIC_PARITY_DARK }),
	"2.1.5": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: false, recover: false, abandon: false, quarantineLegacy: false, reconcileAuthority: false, repairLegacyAlias: false, ...ORGANIC_PARITY_DARK }),
	"2.1.6": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: false, recover: false, abandon: false, quarantineLegacy: false, reconcileAuthority: false, repairLegacyAlias: false, ...ORGANIC_PARITY_DARK }),
	"2.1.7": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: false, recover: false, abandon: false, quarantineLegacy: false, reconcileAuthority: false, repairLegacyAlias: false, ...ORGANIC_PARITY_DARK }),
	"2.1.8": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: false, quarantineLegacy: false, reconcileAuthority: true, repairLegacyAlias: false, ...ORGANIC_PARITY_DARK }),
	"2.1.9": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: false, ...ORGANIC_PARITY_DARK }),
	"2.1.10": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, ...ORGANIC_PARITY_DARK }),
	"2.1.11": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, ...ORGANIC_PARITY_DARK }),
	// First capability-true row, paired with the triple pin bump in this same
	// commit as Design Decision #1 requires.
	//
	// Only two of the four organic-parity columns are lit, because a capability
	// row is a promise and these are the two whose data was proven to reach the
	// negotiated path Pi actually consumes:
	//
	//   mode      `gentle-ai review mode status` answers the review-mode/v1
	//             envelope directly.
	//   delivery  the gate result carries `delivery` ("disabled/unmanaged" when
	//             the kill switch is off), verified against v2.2.0.
	//
	// riskEvidence and hint stay dark deliberately. Both exist in gentle-ai
	// v2.2.0 but only on the PLAIN start envelope; the negotiated
	// `review-integration.start/v2` that NativeReviewCliV216 decodes carries
	// `risk_reasons` instead of `risk_evidence` and omits `hint` entirely.
	// Lighting them would advertise data that cannot arrive. Closing that gap
	// needs the negotiated start envelope extended upstream, which moves a
	// byte-pinned fixture and therefore belongs to a gentle-ai release, not to
	// a Pi capability flip.
	"2.2.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// 2.2.1 repeats 2.2.0 because the wire did not move for the lane Pi speaks.
	// v2.2.1 advertises capabilities/v1.5 (protocol minor 5) on
	// review-integration/v1, but the negotiated start envelope is still the
	// closed `start/v2`, so riskEvidence and hint stay dark for the same reason
	// they are dark on 2.2.0. The release does publish a second contract,
	// review-integration/v2, whose `start/v3` carries base/candidate trees --
	// but Pi does not negotiate it yet, and a row must describe the lane in use.
	"2.2.1": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// 2.2.2 repeats 2.2.1 for the same reason, confirmed against the released
	// v2.2.2 binary rather than assumed: on review-integration/v1 it still
	// advertises capabilities/v1.5 and the negotiated start envelope is still
	// the closed `start/v2`, so riskEvidence and hint still cannot arrive.
	"2.2.2": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// Ground-truthed against the released v2.2.3 binary: the v2 lane remains
	// protocol 2.0 with the same operation set and closed START fields consumed
	// by Pi, so the existing capability columns are unchanged.
	"2.2.3": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// Ground-truthed against the released v2.4.0 binary: the v2 lane advertises
	// capabilities/v2.2 and answers status/v5 and consent/v3, all of which the
	// existing decoders already read, and the START envelope Pi consumes is
	// still `start/v3` carrying `risk_reasons` with no `risk_evidence` and no
	// `hint`, so the existing capability columns are unchanged. v2.4.0 also
	// made receipt-driven development opt-in, which changes what the mode
	// envelope reports, not whether it reports it. v2.2.4 and v2.3.0 shipped
	// while Pi stayed on 2.2.3; they were never pinned or probed, so they get
	// no row.
	"2.4.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// Ground-truthed by driving the exact v2.5.0-rc.3 tagged build through the
	// gentle-ai-bench driven journey corpus (exit 0), which exercises the
	// start/status/capture/validate/mode/delivery lifecycles Pi consumes. The
	// v2 lane advertises capabilities/v2.3 and its reviewing START is the
	// `start/v4` continuation envelope that #499 already decodes; the closed
	// fields Pi consumes are unchanged, so the columns match the 2.4.0 row.
	// riskEvidence and hint stay dark: still not proven to reach the
	// negotiated path Pi reads.
	"2.5.0-rc.3": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// Ground-truthed against the published v2.5.0 binary installed from its
	// signed archive: `review capabilities` on the v2 lane advertises
	// capabilities/v2.4 (protocol minor 4) and answers status/v6, consent/v3,
	// and the `start/v4` continuation, all of which the decoders already read.
	// The closed fields Pi consumes did not change between rc.3 and stable, so
	// the columns match the 2.5.0-rc.3 row. riskEvidence and hint stay dark:
	// still not proven to reach the negotiated START path Pi reads.
	"2.5.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// Ground-truthed against the published v2.6.0 binary installed from its
	// signed archive: `review capabilities` on the v2 lane advertises
	// capabilities/v2.5 (protocol minor 5) and answers status/v7, consent/v3,
	// and the `start/v4` continuation, all of which the decoders already read.
	// `review mode status --json` still answers `gentle-ai.rdd-mode-status/v1`
	// and `review validate --gate pre-commit` still answers
	// `gentle-ai.review-gate-result/v1` carrying `delivery`, both verified
	// against the binary. Declining the consent/v3 prompt during `review start`
	// still returns `risk_evidence` only on that blocking envelope, never on
	// the negotiated `start/v4` continuation, so riskEvidence and hint stay
	// dark for the same reason they have on every row since 2.2.0: still not
	// proven to reach the negotiated START path Pi reads. The closed fields Pi
	// consumes did not change between 2.5.0 and 2.6.0, so the columns match
	// the 2.5.0 row.
	"2.6.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// Ground-truthed against the published v2.7.0 binary installed from its
	// signed archive: `review capabilities` on the v2 lane still advertises
	// capabilities/v2.5 (protocol minor 5) and answers status/v7, consent/v3,
	// and the `start/v4` continuation, all of which the decoders already read.
	// `review mode status --json` still answers `gentle-ai.rdd-mode-status/v1`
	// and `review validate --gate pre-commit` still answers
	// `gentle-ai.review-gate-result/v1` carrying `delivery`, both verified
	// against the binary. riskEvidence and hint stay dark for the same reason
	// they have on every row since 2.2.0: still not proven to reach the
	// negotiated START path Pi reads. The closed fields Pi consumes did not
	// change between 2.6.0 and 2.7.0, so the columns match the 2.6.0 row.
	"2.7.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// Ground-truthed against the published v2.8.0 linux/amd64 binary from its
	// signed release archive. The v2 lane still advertises capabilities/v2.5
	// (protocol minor 5) with status/v7, consent/v3, and start/v4 schemas.
	// The closed fields Pi consumes did not change between 2.7.0 and 2.8.0,
	// so this row repeats 2.7.0. riskEvidence and hint remain dark because
	// neither is proven to reach the negotiated START path Pi consumes.
	"2.8.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// v2.8.1 only changed runtime telemetry model attribution (gentle-ai#4536);
	// the closed fields Pi consumes did not change between 2.8.0 and 2.8.1, so
	// this row repeats 2.8.0 exactly. riskEvidence and hint remain dark
	// because neither is proven to reach the negotiated START path Pi consumes.
	"2.8.1": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// v2.8.2 shipped OpenCode SDD preflight plugin fixes, community-tools RTK
	// acquisition, and Claude Code Stop telemetry. The provider contract semver
	// stays 1.2.0; the same pin re-mirrors bundle bytes that had drifted under
	// that semver (lens inspection.status "unavailable", targeted-validator
	// regressions/inspection members, seven Pi stop reason codes). None of
	// those touch the closed START/STATUS fields this row negotiates, so it
	// repeats 2.8.1 exactly. riskEvidence and hint remain dark because neither
	// is proven to reach the negotiated START path Pi consumes.
	"2.8.2": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// v2.9.0 shipped RTK opt-in Community Tool integration (#4560, installer/
	// sync/TUI only), SDD attempt-ledger fixes (#4564, #4567, #4569 — the
	// remediation pointer is now decided by chain equality before shape, and
	// the refusal wording changed), sync telemetry-runtime symlinked root
	// (#4565), OpenCode reviewer Task wrapper decoding (#4545), and Engram
	// protocol asset wording (#4179). Ground-truthed by diffing
	// contracts/review-integration/v2 and contracts/review-provider-contract
	// between the v2.8.2 and v2.9.0 tags in the gentle-ai source tree: zero
	// bytes changed. None of the above touch the closed START/STATUS fields
	// this row negotiates, so it repeats 2.8.2 exactly. riskEvidence and hint
	// remain dark because neither is proven to reach the negotiated START
	// path Pi consumes.
	"2.9.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// v2.9.1 shipped restoring compatible OpenCode review consent (#4584) and
	// deriving Claude Code SDD dispatch authority from the session transcript
	// (#4575, #4551). Ground-truthed by diffing contracts/review-integration/v2
	// and contracts/review-provider-contract between the v2.9.0 and v2.9.1 tags
	// in the gentle-ai source tree: zero bytes changed. Neither change touches
	// the closed START/STATUS fields this row negotiates, so it repeats 2.9.0
	// exactly. riskEvidence and hint remain dark because neither is proven to
	// reach the negotiated START path Pi consumes.
	"2.9.1": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// v3.0.0 shipped ODD as the orchestrator's mandatory default protocol and
	// integrated the simplified SDD workflow into it (gentle-ai #4642, #4644),
	// with the provider contract byte-frozen at 1.2.0. Ground-truthed by
	// diffing contracts/review-integration/v2 and
	// contracts/review-provider-contract between the v2.9.1 and v3.0.0 tags
	// in the gentle-ai source tree: zero bytes changed. Neither change touches
	// the closed START/STATUS fields this row negotiates, so it repeats 2.9.1
	// exactly. riskEvidence and hint remain dark because neither is proven to
	// reach the negotiated START path Pi consumes.
	"3.0.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// v3.0.1 moved the Go module path to github.com/gentleman-programming/gentle-ai/v3
	// with no contract change (gentle-ai #4683). Ground-truthed by diffing
	// contracts/review-integration/v2 and contracts/review-provider-contract
	// between the v3.0.0 and v3.0.1 tags in the gentle-ai source tree: zero
	// bytes changed. This row repeats 3.0.0 (and 2.9.1) exactly. riskEvidence
	// and hint remain dark because neither is proven to reach the negotiated
	// START path Pi consumes.
	"3.0.1": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
	// v3.1.0 changed the ODD orchestrator contract only (gentle-ai #4714).
	// Ground-truthed by diffing contracts/review-integration/v2 and
	// contracts/review-provider-contract between the v3.0.2 and v3.1.0 tags
	// in the gentle-ai source tree: zero bytes changed (provider contract
	// stays 1.2.0). Neither change touches the closed START/STATUS fields
	// this row negotiates, so it repeats 3.0.1 exactly. riskEvidence and hint
	// remain dark because neither is proven to reach the negotiated START
	// path Pi consumes.
	"3.1.0": Object.freeze({ start: true, finalize: true, validate: true, bindSdd: true, status: true, inventory: true, reclaim: true, recover: true, abandon: true, quarantineLegacy: true, reconcileAuthority: true, repairLegacyAlias: true, mode: true, riskEvidence: false, hint: false, delivery: true }),
});

export interface NativeReviewProcessDiagnostics {
	operation: NativeReviewOperation;
	error_code: NativeReviewErrorCode;
	exit_code?: number;
	signal?: NodeJS.Signals;
	timed_out: boolean;
	output_limit_exceeded: boolean;
	max_buffer_bytes?: number;
	configuration_hint?: string;
	stderr?: string;
}

export class NativeReviewCliError extends Error {
	readonly code: NativeReviewErrorCode;
	readonly operation: NativeReviewOperation;
	readonly launchAttempted: boolean;
	readonly mutating: boolean;
	readonly mutationOutcome: "none" | "unknown";
	readonly nextAction?: "review.status";
	readonly diagnostics: NativeReviewProcessDiagnostics;
	readonly auditRecord?: Record<string, unknown>;
	constructor(code: NativeReviewErrorCode, operation: NativeReviewOperation, launchAttempted: boolean, mutating: boolean, message: string, diagnostics?: NativeReviewProcessDiagnostics, auditRecord?: Record<string, unknown>) {
		super(message);
		this.name = "NativeReviewCliError";
		this.code = code;
		this.operation = operation;
		this.launchAttempted = launchAttempted;
		this.mutating = mutating;
		this.mutationOutcome = launchAttempted && mutating ? "unknown" : "none";
		this.nextAction = this.mutationOutcome === "unknown" ? "review.status" : undefined;
		this.diagnostics = diagnostics ?? { operation, error_code: code, timed_out: false, output_limit_exceeded: false };
		this.auditRecord = auditRecord;
	}
}

// The one central runner for every gentle-ai CLI invocation the extension
// makes. It declares the Pi host relay handshake on each spawn: gentle-ai
// refuses pi admission pre-authority without it (gentle-pi#311 P4), and a
// single injection point keeps the declaration impossible to forget on any
// individual operation.
export function gentleAiProcessEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, [GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: GENTLE_PI_REVIEW_RELAY_CONTRACT };
}

export function createNodeExecFileAdapter(): ExecFileAdapter {
	return async (request) => {
		try {
			const output = await execFileAsync(request.file, [...request.arguments], { cwd: request.cwd, encoding: "utf8", shell: false, windowsHide: true, timeout: request.timeoutMs, maxBuffer: request.maxBufferBytes, signal: request.signal, env: gentleAiProcessEnvironment() });
			return { stdout: output.stdout, stderr: output.stderr, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		} catch (error) {
			const detail = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; signal?: NodeJS.Signals; killed?: boolean };
			if (detail.code === "ENOENT" || detail.code === "EACCES" || detail.name === "AbortError") throw error;
			const outputLimitExceeded = detail.code === "ENOBUFS" || detail.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
			return { stdout: detail.stdout ?? "", stderr: detail.stderr ?? "", exitCode: typeof detail.code === "number" ? detail.code : 1, signal: detail.signal ?? null, timedOut: !outputLimitExceeded && detail.killed === true, outputLimitExceeded };
		}
	};
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
	return value as Record<string, unknown>;
}
function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	const parsed = object(value);
	const allowed = [...required, ...optional];
	if (required.some((key) => !(key in parsed)) || Object.keys(parsed).some((key) => !allowed.includes(key))) throw new Error("unexpected object shape");
	return parsed;
}
function requiredString(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw new Error("expected string"); return value; }
function stringValue(value: unknown): string { if (typeof value !== "string") throw new Error("expected string"); return value; }
function sha256Identity(value: unknown): string { const parsed = requiredString(value); if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) throw new Error("expected canonical SHA-256 identity"); return parsed; }
function booleanValue(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("expected boolean"); return value; }
function nonNegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expected safe non-negative integer"); return value; }
function positiveInteger(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("expected safe positive integer"); return value; }
function stringArray(value: unknown): readonly string[] { if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error("expected string array"); return value; }
function decodeSelectedLenses(value: unknown, riskLevel: string, lensesRequired: boolean): readonly string[] {
	if (value === null && riskLevel === "low" && !lensesRequired) return [];
	return stringArray(value);
}
function enumString(value: unknown, allowed: readonly string[]): string { const parsed = stringValue(value); if (!allowed.includes(parsed)) throw new Error("unsupported enum"); return parsed; }
const NATIVE_DIAGNOSTIC_TEXT_LIMIT = 4_096;

function sanitizeNativeDiagnosticText(value: string, limit = NATIVE_DIAGNOSTIC_TEXT_LIMIT): string {
	const normalized = value
		.replace(/\x1b](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\)/g, "[REDACTED CONTROL]")
		.replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "[REDACTED CONTROL]")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "[REDACTED CONTROL]")
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PEM]")
		.replace(/("(?:token|password|secret|api_key|apikey|authorization|cookie|private_key|access_token|github_token|[a-z0-9_-]+_token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, "$1\"[REDACTED]\"")
		.replace(/\b(Bearer)\s+[^\s]+/gi, "$1 [REDACTED]")
		.replace(/\b(token|secret|password|authorization|cookie|private_key|access_token|github_token|[a-z0-9_-]+_token|api[_-]?key)\s*([:=])\s*[^\s]+/gi, "$1$2[REDACTED]")
		.replace(/[\u0000-\u001f\u007f]/g, "");
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 14)}…[truncated]`;
}

// Rebuild diagnostics from a duplicated module instance before facade output.
export function sanitizeForeignNativeReviewDiagnostics(value: unknown): NativeReviewProcessDiagnostics | undefined {
	try {
		const raw = exactObject(value, ["operation", "error_code", "timed_out", "output_limit_exceeded"], ["exit_code", "signal", "max_buffer_bytes", "configuration_hint", "stderr"]);
		const operation = enumString(raw.operation, Object.values(NATIVE_REVIEW_OPERATION)) as NativeReviewOperation;
		const errorCode = enumString(raw.error_code, Object.values(NATIVE_REVIEW_ERROR_CODE)) as NativeReviewErrorCode;
		const signal = raw.signal === undefined ? undefined : requiredString(raw.signal);
		const maxBufferBytes = raw.max_buffer_bytes === undefined ? undefined : positiveInteger(raw.max_buffer_bytes);
		const configurationHint = raw.configuration_hint === undefined ? undefined : stringValue(raw.configuration_hint);
		if (
			(signal !== undefined && !/^SIG[A-Z0-9]{1,12}$/.test(signal)) ||
			(maxBufferBytes === undefined) !== (configurationHint === undefined) ||
			(configurationHint !== undefined && (errorCode !== NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT || configurationHint !== NATIVE_REVIEW_MAX_BUFFER_CONFIGURATION_HINT))
		) return undefined;
		return {
			operation,
			error_code: errorCode,
			...(raw.exit_code === undefined ? {} : { exit_code: nonNegativeInteger(raw.exit_code) }),
			...(signal === undefined ? {} : { signal: signal as NodeJS.Signals }),
			timed_out: booleanValue(raw.timed_out),
			output_limit_exceeded: booleanValue(raw.output_limit_exceeded),
			...(maxBufferBytes === undefined ? {} : { max_buffer_bytes: maxBufferBytes, configuration_hint: configurationHint! }),
			...(raw.stderr === undefined ? {} : { stderr: sanitizeNativeDiagnosticText(stringValue(raw.stderr)) }),
		};
	} catch { return undefined; }
}

function nativeProcessDiagnostics(operation: NativeReviewOperation, code: NativeReviewErrorCode, result?: ExecFileResult, maxBufferBytes?: number): NativeReviewProcessDiagnostics {
	const outputLimitExceeded = result?.outputLimitExceeded === true;
	return {
		operation,
		error_code: code,
		...(result === undefined ? {} : { exit_code: result.exitCode }),
		...(result?.signal === null || result?.signal === undefined ? {} : { signal: result.signal }),
		timed_out: !outputLimitExceeded && result?.timedOut === true,
		output_limit_exceeded: outputLimitExceeded,
		...(code === NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT && maxBufferBytes !== undefined
			? { max_buffer_bytes: maxBufferBytes, configuration_hint: NATIVE_REVIEW_MAX_BUFFER_CONFIGURATION_HINT }
			: {}),
		...(result?.stderr.trim() ? { stderr: sanitizeNativeDiagnosticText(result.stderr) } : {}),
	};
}

function parseJson(stdout: string, operation: NativeReviewOperation, mutating: boolean, diagnostics: NativeReviewProcessDiagnostics): Record<string, unknown> {
	if (stdout.length === 0) throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT, operation, true, mutating, "native command returned empty output", { ...diagnostics, error_code: NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT });
	try { return object(JSON.parse(stdout)); } catch { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.MALFORMED_JSON, operation, true, mutating, "native command returned malformed JSON", { ...diagnostics, error_code: NATIVE_REVIEW_ERROR_CODE.MALFORMED_JSON }); }
}
function decodeNativeMaintenanceResult(value: unknown, expectedOperation: NativeReviewOperation): NativeReviewRecoveryResult {
	const body = exactObject(value, ["operation", "record"]);
	if (body.operation !== expectedOperation) throw new Error("wrong native maintenance discriminator");
	return { record: object(body.record) };
}
function decodeLegacyReconcileAudit(value: unknown): NativeReviewRecoveryResult {
	const record = exactObject(value, ["schema", "predecessor_lineage", "successor_lineage", "outcome"]);
	if (record.schema !== "gentle-ai.review-reconcile-audit/v1") throw new Error("wrong legacy reconcile audit schema");
	for (const field of ["predecessor_lineage", "successor_lineage", "outcome"]) requiredString(record[field]);
	return { record };
}
// Unimplemented next_transition.execute.operation values must never reach
// argv synthesis. Checked against the raw pre-decode body so an operation
// gentle-pi does not implement (e.g. a future `dispose-result`) fails with a
// named, typed refusal instead of a generic schema-incompatible error, and
// before any client ever tries to build an invocation for it (Design
// Decision #6, migrate-review-integration-v2).
const NATIVE_REVIEW_SUPPORTED_TRANSITION_OPERATIONS = new Set(["review.start", "review.recover", "review.repair", "review.acknowledge-approved"]);
function assertSupportedNextTransitionOperation(body: Record<string, unknown>): void {
	const nextTransition = body.next_transition;
	if (typeof nextTransition !== "object" || nextTransition === null || Array.isArray(nextTransition)) return;
	const execute = (nextTransition as Record<string, unknown>).execute;
	if (typeof execute !== "object" || execute === null || Array.isArray(execute)) return;
	const operation = (execute as Record<string, unknown>).operation;
	if (typeof operation === "string" && !NATIVE_REVIEW_SUPPORTED_TRANSITION_OPERATIONS.has(operation)) {
		throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNSUPPORTED_TRANSITION_OPERATION, NATIVE_REVIEW_OPERATION.STATUS, false, `unsupported-transition-operation: gentle-pi does not implement the next_transition operation "${operation}"; refusing rather than synthesizing an invocation for it`);
	}
}
function decode<T>(operation: NativeReviewOperation, mutating: boolean, callback: () => T, diagnostics = nativeProcessDiagnostics(operation, NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE)): T {
	try { return callback(); } catch (error) { if (error instanceof NativeReviewCliError) throw error; throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE, operation, true, mutating, "native response is schema incompatible", { ...diagnostics, error_code: NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE }); }
}
function decodeReviewStartResponse(value: unknown): ReviewStartV3 | ReviewStartV4 {
	const body = object(value);
	return body.schema === "gentle-ai.review-integration.start/v4"
		? decodeReviewStartV4(body)
		: decodeReviewStartV3(body);
}
function decodeReleaseEvidence(value: unknown): void {
	const release = exactObject(value, ["release_tree", "configuration_hash", "generated_artifact_hash", "provenance_hash", "publication_boundary_hash", "publication_state", "evidence_freshness_hash", "evidence_freshness_state"]);
	for (const field of ["release_tree", "configuration_hash", "generated_artifact_hash", "provenance_hash", "publication_boundary_hash", "evidence_freshness_hash"]) requiredString(release[field]);
	if (release.publication_state !== "sealed" || release.evidence_freshness_state !== "current") throw new Error("invalid release evidence");
}
function decodeNonDecidingGateContext(value: unknown, expectedGate: string): NativeGateContext {
	const context = exactObject(value, ["gate"]);
	const gate = enumString(context.gate, NATIVE_GATE);
	if (gate !== expectedGate) throw new Error("native non-deciding gate context does not match the requested gate");
	return { lineageId: "", storeRevision: "", raw: context };
}
function decodeGateContext(value: unknown): NativeGateContext {
	const context = exactObject(
		value,
		["gate", "lineage_id", "generation", "base_tree", "candidate_tree", "paths_digest", "fix_delta_hash", "policy_hash", "ledger_hash", "evidence_hash", "base_relationship_valid"],
		["store_revision", "genesis_revision", "chain_identity", "bundle_digest", "external_evidence", "base_advanced_compatible", "release", "pre_pr_boundary", "denial"],
	);
	const gate = stringValue(context.gate);
	if (gate !== "" && !(NATIVE_GATE as readonly string[]).includes(gate)) throw new Error("invalid gate context gate");
	for (const field of ["lineage_id", "base_tree", "candidate_tree", "paths_digest", "fix_delta_hash", "policy_hash", "ledger_hash", "evidence_hash"]) stringValue(context[field]);
	for (const field of ["store_revision", "genesis_revision", "chain_identity", "bundle_digest"]) if (context[field] !== undefined) stringValue(context[field]);
	nonNegativeInteger(context.generation);
	booleanValue(context.base_relationship_valid);
	if (context.external_evidence !== undefined) enumString(context.external_evidence, ["invalidating", "escalating"]);
	let sanitizedContext = context;
	if (context.denial !== undefined) {
		const denial = exactObject(context.denial, ["stage", "code"]);
		const stage = sanitizeNativeDiagnosticText(requiredString(denial.stage), NATIVE_REVIEW_DENIAL_TEXT_LIMIT);
		const code = sanitizeNativeDiagnosticText(requiredString(denial.code), NATIVE_REVIEW_DENIAL_TEXT_LIMIT);
		if (!isCanonicalProcessString(stage) || !isCanonicalProcessString(code)) throw new Error("non-canonical denial evidence");
		sanitizedContext = { ...context, denial: { stage, code } };
	}
	if (context.pre_pr_boundary !== undefined) {
		const boundary = exactObject(context.pre_pr_boundary, ["source", "selector", "commit"], ["remote", "remote_ref", "remote_identity"]);
		enumString(boundary.source, ["explicit", "publication-default"]); requiredString(boundary.selector); stringValue(boundary.commit);
		for (const field of ["remote", "remote_ref", "remote_identity"]) if (boundary[field] !== undefined) requiredString(boundary[field]);
	}
	if (context.base_advanced_compatible !== undefined) {
		const proof = exactObject(context.base_advanced_compatible, ["status", "compatible", "old_base_tree", "new_base_tree", "original_patch_identity", "delivered_patch_identity", "delivered_paths_digest", "base_advance_paths_digest", "paths_disjoint", "merged_result_tree", "ci_attestation_artifact_hash", "ci_attestation_issuer", "ci_status"]);
		for (const field of ["status", "old_base_tree", "new_base_tree", "original_patch_identity", "delivered_patch_identity", "delivered_paths_digest", "base_advance_paths_digest", "merged_result_tree", "ci_attestation_artifact_hash", "ci_attestation_issuer", "ci_status"]) requiredString(proof[field]);
		booleanValue(proof.compatible); booleanValue(proof.paths_disjoint);
	}
	if (context.release !== undefined) decodeReleaseEvidence(context.release);
	return {
		lineageId: stringValue(context.lineage_id),
		storeRevision: context.store_revision === undefined ? "" : stringValue(context.store_revision),
		raw: sanitizedContext,
	};
}
function decodeNativeReviewRecovery(value: unknown): NativeReviewRecovery {
	const recovery = exactObject(value, ["predecessor_lineage_id", "predecessor_revision", "disposition", "reason", "actor", "recovered_at"], ["maintainer_authorization"]);
	return {
		predecessorLineageId: requiredString(recovery.predecessor_lineage_id),
		predecessorRevision: requiredString(recovery.predecessor_revision),
		disposition: enumString(recovery.disposition, Object.values(NATIVE_REVIEW_RECOVERY_DISPOSITION)) as NativeReviewRecoveryDisposition,
		reason: requiredString(recovery.reason),
		actor: requiredString(recovery.actor),
		recoveredAt: requiredString(recovery.recovered_at),
		...(recovery.maintainer_authorization === undefined ? {} : { maintainerAuthorization: requiredString(recovery.maintainer_authorization) }),
	};
}
function decodeNativeReviewDiscardedWorkSummary(value: unknown): NativeReviewDiscardedWorkSummary {
	const discardedWork = exactObject(value, ["captured_lens_results", "findings_present"]);
	return {
		capturedLensResults: stringArray(discardedWork.captured_lens_results),
		findingsPresent: booleanValue(discardedWork.findings_present),
	};
}
function decodeNativeReviewStatusEntry(value: unknown): NativeReviewAuthorityEntry {
	const entry = exactObject(value, ["version", "path", "status", "problems"], ["lineage_id", "state", "revision", "snapshot_identity", "chain_identity", "recovery", "discarded_work"]);
	return {
		version: enumString(entry.version, Object.values(NATIVE_REVIEW_AUTHORITY_ENTRY_VERSION)) as NativeReviewAuthorityEntryVersion,
		...(entry.lineage_id === undefined ? {} : { lineageId: requiredString(entry.lineage_id) }),
		path: requiredString(entry.path),
		status: enumString(entry.status, Object.values(NATIVE_REVIEW_AUTHORITY_ENTRY_STATUS)) as NativeReviewAuthorityEntryStatus,
		...(entry.state === undefined ? {} : { state: requiredString(entry.state) }),
		...(entry.revision === undefined ? {} : { revision: requiredString(entry.revision) }),
		...(entry.snapshot_identity === undefined ? {} : { snapshotIdentity: sha256Identity(entry.snapshot_identity) }),
		...(entry.chain_identity === undefined ? {} : { chainIdentity: requiredString(entry.chain_identity) }),
		...(entry.recovery === undefined ? {} : { recovery: decodeNativeReviewRecovery(entry.recovery) }),
		...(entry.discarded_work === undefined ? {} : { discardedWork: decodeNativeReviewDiscardedWorkSummary(entry.discarded_work) }),
		problems: stringArray(entry.problems),
	};
}
function decodeNativeReviewStatusLock(value: unknown): NativeReviewAuthorityLock {
	const lock = exactObject(value, ["version", "path", "status"], ["lineage_id", "owner", "problem"]);
	let owner: NativeReviewLockOwner | undefined;
	if (lock.owner !== undefined) {
		const decodedOwner = exactObject(lock.owner, ["schema", "owner_id", "pid", "host", "acquired_at"]);
		owner = {
			schema: enumString(decodedOwner.schema, Object.values(NATIVE_REVIEW_LOCK_OWNER_SCHEMA)) as NativeReviewLockOwnerSchema,
			ownerId: requiredString(decodedOwner.owner_id),
			pid: positiveInteger(decodedOwner.pid),
			host: requiredString(decodedOwner.host),
			acquiredAt: requiredString(decodedOwner.acquired_at),
		};
	}
	return {
		version: enumString(lock.version, Object.values(NATIVE_REVIEW_AUTHORITY_ENTRY_VERSION)) as NativeReviewAuthorityEntryVersion,
		...(lock.lineage_id === undefined ? {} : { lineageId: requiredString(lock.lineage_id) }),
		path: requiredString(lock.path),
		status: enumString(lock.status, Object.values(NATIVE_REVIEW_LOCK_STATUS)) as NativeReviewLockStatus,
		...(owner === undefined ? {} : { owner }),
		...(lock.problem === undefined ? {} : { problem: requiredString(lock.problem) }),
	};
}
function decodeNativeReviewStatusDiagnostic(value: unknown): NativeReviewAuthorityDiagnostic {
	const diagnostic = exactObject(value, ["path", "problem"]);
	return { path: requiredString(diagnostic.path), problem: requiredString(diagnostic.problem) };
}
function decodeNativeReviewModeStatus(value: unknown): NativeReviewModeStatus {
	const status = exactObject(value, ["schema", "global", "clone_local", "effective", "source"], ["revision", "reach"]);
	if (status.schema !== "gentle-ai.rdd-mode-status/v1") throw new Error("wrong review mode status schema");
	return {
		global: enumString(status.global, Object.values(NATIVE_REVIEW_MODE_VALUE)) as NativeReviewModeValue,
		cloneLocal: enumString(status.clone_local, Object.values(NATIVE_REVIEW_MODE_VALUE)) as NativeReviewModeValue,
		effective: enumString(status.effective, ["on", "off"]) as "on" | "off",
		source: enumString(status.source, Object.values(NATIVE_REVIEW_MODE_SOURCE)) as NativeReviewModeSource,
		...(status.revision === undefined ? {} : { revision: requiredString(status.revision) }),
		...(status.reach === undefined ? {} : { reach: enumString(status.reach, Object.values(NATIVE_REVIEW_MODE_REACH)) as NativeReviewModeReach }),
	};
}

function decodeNativeReviewMode(value: unknown, expectedOperation: NativeReviewModeOperation): NativeReviewModeResult {
	const body = exactObject(value, ["schema", "operation", "scope", "status"]);
	if (body.schema !== "gentle-ai.review-mode/v1" || body.operation !== expectedOperation) throw new Error("wrong review mode discriminator");
	return {
		operation: expectedOperation,
		scope: enumString(body.scope, Object.values(NATIVE_REVIEW_MODE_SCOPE)) as NativeReviewModeScope,
		status: decodeNativeReviewModeStatus(body.status),
	};
}

function decodeNativeReviewStatus(value: unknown): NativeReviewStatusResult {
	const body = exactObject(value, ["schema", "operation", "repository", "complete", "authoritative", "status", "entries", "locks", "diagnostics"]);
	if (body.schema !== "gentle-ai.review-authority-status/v1" || body.operation !== "review/status") throw new Error("wrong review status discriminator");
	const complete = booleanValue(body.complete);
	const authoritative = booleanValue(body.authoritative);
	if (authoritative && !complete) throw new Error("incomplete inventory cannot be authoritative");
	if (!Array.isArray(body.entries) || !Array.isArray(body.locks)) throw new Error("invalid native status inventory");
	return {
		repository: requiredString(body.repository),
		complete,
		authoritative,
		status: enumString(body.status, Object.values(NATIVE_REVIEW_AUTHORITY_STATUS)) as NativeReviewAuthorityStatus,
		entries: body.entries.map(decodeNativeReviewStatusEntry),
		locks: body.locks.map(decodeNativeReviewStatusLock),
		diagnostics: body.diagnostics.map(decodeNativeReviewStatusDiagnostic),
		raw: body,
	};
}
function isWindowsRepositoryPath(value: string): boolean { return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value); }
export function normalizeNativeReviewCwd(value: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return value;
	const gitBashDrive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value);
	const windowsPath = gitBashDrive === null
		? value
		: `${gitBashDrive[1]!.toUpperCase()}:/${gitBashDrive[2] ?? ""}`;
	if (!isWindowsRepositoryPath(windowsPath)) return windowsPath;
	const normalized = win32.normalize(windowsPath);
	return normalized.replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
}
async function canonicalNativeReviewCwd(value: string): Promise<string> {
	const normalized = normalizeNativeReviewCwd(value);
	try { return await realpath(normalized); }
	catch { return normalized; }
}
async function repositoryPathIdentity(value: string): Promise<string> {
	const windowsPath = isWindowsRepositoryPath(value);
	try { return `filesystem:${windowsPath ? (await realpath(value)).toLowerCase() : await realpath(value)}`; }
	catch { return `path:${windowsPath ? win32.normalize(value).toLowerCase() : posix.normalize(value)}`; }
}
async function repositoriesMatch(requested: string, returned: string): Promise<boolean> {
	return (await repositoryPathIdentity(requested)) === (await repositoryPathIdentity(returned));
}
function decodeSnapshot(value: unknown): void {
	const snapshot = exactObject(value, ["kind", "base_tree", "candidate_tree", "paths_digest", "intended_untracked", "intended_untracked_proof", "paths", "identity"], ["ledger_ids"]);
	enumString(snapshot.kind, ["current-changes", "base-diff", "commit-range", "fix-diff"]);
	for (const field of ["base_tree", "candidate_tree", "paths_digest", "intended_untracked_proof", "identity"]) requiredString(snapshot[field]);
	stringArray(snapshot.intended_untracked); stringArray(snapshot.paths);
	if (snapshot.ledger_ids !== undefined) stringArray(snapshot.ledger_ids);
}
function decodeFinding(value: unknown): void {
	const finding = exactObject(value, ["id"], ["lens", "location", "severity", "claim", "proof_refs"]);
	requiredString(finding.id);
	if (finding.lens !== undefined) enumString(finding.lens, ["risk", "resilience", "readability", "reliability"]);
	if (finding.location !== undefined) stringValue(finding.location);
	if (finding.severity !== undefined) enumString(finding.severity, ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"]);
	if (finding.claim !== undefined) stringValue(finding.claim);
	if (finding.proof_refs !== undefined) stringArray(finding.proof_refs);
}
function decodeLensResult(value: unknown): void {
	const result = exactObject(value, ["lens", "findings", "evidence", "result_hash"]);
	enumString(result.lens, NATIVE_REVIEW_LENS);
	if (!Array.isArray(result.findings)) throw new Error("invalid lens findings");
	for (const finding of result.findings) decodeFinding(finding);
	stringArray(result.evidence); requiredString(result.result_hash);
}
function decodeFindingEvidence(value: unknown): void {
	const evidence = exactObject(value, ["finding_id", "class", "proof"], ["causal_disposition"]);
	requiredString(evidence.finding_id); enumString(evidence.class, ["deterministic", "inferential", "insufficient"]); requiredString(evidence.proof);
	if (evidence.causal_disposition !== undefined) enumString(evidence.causal_disposition, ["introduced", "behavior-activated", "worsened", "pre-existing", "base-only", "unknown"]);
}
function decodeValidationCheck(value: unknown): void {
	const check = exactObject(value, ["evidence_hash", "fix_delta_hash", "passed"]);
	requiredString(check.evidence_hash); requiredString(check.fix_delta_hash); booleanValue(check.passed);
}
function decodeReviewTransaction(value: unknown): void {
	const transaction = exactObject(
		value,
		["schema", "lineage_id", "mode", "generation", "state", "snapshot", "base_tree", "paths_digest", "initial_review_tree", "final_candidate_tree", "fix_delta_hash", "policy_hash", "ledger_hash", "ledger_findings_hash", "evidence_hash", "judge_proofs", "counters", "findings", "classifications", "outcomes", "fix_finding_ids", "pending_refuter_ids", "fix_caused_findings", "follow_ups"],
		["genesis_paths", "invalidation_reason", "judge_proof_hash", "judge_agreement_hash", "release", "failed_evidence_revision", "original_criteria", "correction_regression", "risk_level", "selected_lenses", "lens_results", "original_changed_lines", "correction_budget", "proposed_correction_lines", "actual_correction_lines"],
	);
	if (transaction.schema !== "gentle-ai.review-transaction/v1") throw new Error("invalid review transaction schema");
	requiredString(transaction.lineage_id); enumString(transaction.mode, ["ordinary_4r", "ordinary_bounded", "judgment_day"]); nonNegativeInteger(transaction.generation);
	enumString(transaction.state, ["unreviewed", "reviewing", "judges_confirmed", "findings_frozen", "evidence_classified", "fix_required", "fixing", "fix_validating", "ready_final_verification", "final_verifying", "approved", "escalated", "invalidated"]);
	decodeSnapshot(transaction.snapshot);
	for (const field of ["base_tree", "paths_digest", "initial_review_tree", "final_candidate_tree", "fix_delta_hash", "policy_hash", "ledger_hash", "ledger_findings_hash", "evidence_hash"]) stringValue(transaction[field]);
	for (const field of ["genesis_paths", "fix_finding_ids", "pending_refuter_ids"]) if (transaction[field] !== undefined) stringArray(transaction[field]);
	for (const field of ["invalidation_reason", "judge_proof_hash", "judge_agreement_hash", "failed_evidence_revision"]) if (transaction[field] !== undefined) requiredString(transaction[field]);
	if (!Array.isArray(transaction.judge_proofs)) throw new Error("invalid judge proofs");
	for (const proof of transaction.judge_proofs) {
		const row = exactObject(proof, ["judge_id", "execution_hash", "result_hash", "blind", "confirmed"]);
		requiredString(row.judge_id); requiredString(row.execution_hash); requiredString(row.result_hash); booleanValue(row.blind); booleanValue(row.confirmed);
	}
	const counters = exactObject(transaction.counters, ["full_reviews", "refuter_batches", "fix_batches", "scoped_fix_validations", "final_verifications", "fix_rounds", "scoped_rejudgments", "judge_executions"], ["risk_executions", "resilience_executions", "readability_executions", "reliability_executions"]);
	for (const value of Object.values(counters)) nonNegativeInteger(value);
	for (const field of ["findings", "fix_caused_findings"]) {
		if (!Array.isArray(transaction[field])) throw new Error("invalid transaction findings");
		for (const finding of transaction[field]) decodeFinding(finding);
	}
	const classifications = object(transaction.classifications);
	for (const evidence of Object.values(classifications)) decodeFindingEvidence(evidence);
	const outcomes = object(transaction.outcomes);
	for (const outcome of Object.values(outcomes)) enumString(outcome, ["corroborated", "refuted", "inconclusive", "info"]);
	if (!Array.isArray(transaction.follow_ups)) throw new Error("invalid follow-ups");
	for (const followUp of transaction.follow_ups) {
		const row = exactObject(followUp, ["observation", "proof_refs"]);
		requiredString(row.observation); stringArray(row.proof_refs);
	}
	for (const field of ["original_criteria", "correction_regression"]) if (transaction[field] !== undefined) decodeValidationCheck(transaction[field]);
	if (transaction.release !== undefined) decodeReleaseEvidence(transaction.release);
	if (transaction.risk_level !== undefined) enumString(transaction.risk_level, NATIVE_RISK_LEVEL);
	if (transaction.selected_lenses !== undefined) for (const lens of stringArray(transaction.selected_lenses)) enumString(lens, NATIVE_REVIEW_LENS);
	if (transaction.lens_results !== undefined) {
		if (!Array.isArray(transaction.lens_results)) throw new Error("invalid lens results");
		for (const result of transaction.lens_results) decodeLensResult(result);
	}
	for (const field of ["original_changed_lines", "correction_budget", "proposed_correction_lines", "actual_correction_lines"]) if (transaction[field] !== undefined) nonNegativeInteger(transaction[field]);
}
function hasCanonicalSelectedLenses(riskLevel: string, selectedLenses: readonly string[]): boolean {
	if (new Set(selectedLenses).size !== selectedLenses.length) return false;
	if (riskLevel === "low") return selectedLenses.length === 0;
	if (riskLevel === "medium") return selectedLenses.length === 1;
	return selectedLenses.length === NATIVE_REVIEW_LENS.length
		&& NATIVE_REVIEW_LENS.every((lens) => selectedLenses.includes(lens));
}

function hasValidLensesRequired(action: NativeStartAction, state: string, riskLevel: string, lensesRequired: boolean): boolean {
	if (riskLevel === "low") return !lensesRequired;
	if (action === NATIVE_START_ACTION.CREATED) return state === "reviewing" && lensesRequired;
	if (action === NATIVE_START_ACTION.RESUMED) return !lensesRequired || state === "reviewing";
	return !lensesRequired;
}

function nativeError(code: NativeReviewErrorCode, operation: NativeReviewOperation, mutating: boolean, message: string, result?: ExecFileResult, launchAttempted = true, auditRecord?: Record<string, unknown>, maxBufferBytes?: number): NativeReviewCliError {
	return new NativeReviewCliError(code, operation, launchAttempted, mutating, message, nativeProcessDiagnostics(operation, code, result, maxBufferBytes), auditRecord);
}

interface NativeJsonExecution {
	body: Record<string, unknown>;
	exitCode: number;
	process: ExecFileResult;
}

const NATIVE_SDD_DEPENDENCIES = ["proposal", "specs", "design", "tasks", "apply", "verify", "archive"] as const;
const NATIVE_SDD_INSTRUCTION_PHASES = ["apply", "verify", "archive"] as const;
const NATIVE_SDD_NEXT_RECOMMENDATIONS = ["apply", "verify", "remediate", "archive", "archived", "resolve-blockers", "sdd-new", "select-change", "propose", "spec", "design", "tasks"] as const;
const NATIVE_SDD_DEPENDENCY_STATES = ["blocked", "ready", "all_done"] as const;

/** Strictly validates the native v2 contract while preserving its whole record. */
export function decodeNativeSddStatusV2(value: unknown, request: Pick<NativeSddStatusRequest, "changeName" | "workspaceRoot">): NativeSddStatusV2 {
	const status = object(value);
	if (status.schemaName !== "gentle-ai.sdd-status" || status.schemaVersion !== 2) throw new Error("wrong native SDD status schema");
	if ((request.changeName !== undefined && status.changeName !== request.changeName) || (status.changeName !== null && !isCanonicalProcessString(status.changeName))) throw new Error("native SDD status change identity mismatch");
	const artifactStore = enumString(status.artifactStore, ["openspec", "engram", "hybrid", "none"]);
	const planningHome = object(status.planningHome);
	if (planningHome.mode !== "repo-local" || !isCanonicalProcessString(planningHome.path)) throw new Error("invalid native SDD planning home");
	const expectedOpenSpecHome = join(request.workspaceRoot, "openspec");
	if (planningHome.path !== expectedOpenSpecHome && !((artifactStore === "engram" || artifactStore === "hybrid") && planningHome.path === "engram:sdd")) throw new Error("native SDD planning home escaped its workspace");
	if (status.changeRoot !== null && !isCanonicalProcessString(status.changeRoot)) throw new Error("invalid native SDD change root");
	const actionContext = object(status.actionContext);
	if (actionContext.mode !== "repo-local" || actionContext.workspaceRoot !== request.workspaceRoot || !isCanonicalProcessString(actionContext.workspaceRoot)) throw new Error("native SDD status workspace root mismatch");
	const allowedEditRoots = stringArray(actionContext.allowedEditRoots);
	if (!allowedEditRoots.includes(request.workspaceRoot) || allowedEditRoots.some((root) => !isAbsolute(root) || root !== join(root))) throw new Error("invalid native SDD allowed edit roots");
	const dependencies = object(status.dependencies);
	for (const phase of NATIVE_SDD_DEPENDENCIES) {
		if (enumString(dependencies[phase], NATIVE_SDD_DEPENDENCY_STATES) !== dependencies[phase]) throw new Error("invalid native SDD dependency");
	}
	if (Object.keys(dependencies).length !== NATIVE_SDD_DEPENDENCIES.length) throw new Error("native SDD dependencies have an unsupported shape");
	if (status.instructions !== undefined) throw new Error("native SDD status uses phaseInstructions, not instructions");
	if (status.phaseInstructions !== undefined) {
		const instructions = object(status.phaseInstructions);
		for (const phase of NATIVE_SDD_INSTRUCTION_PHASES) stringArray(instructions[phase]);
		// Classical SDD no longer emits a remediation phase. Keep the published
		// producer's optional legacy instructions intact without inventing them
		// for a newer producer or accepting unknown phase keys.
		const hasRemediation = Object.hasOwn(instructions, "remediate");
		if (hasRemediation) stringArray(instructions.remediate);
		if (Object.keys(instructions).length !== NATIVE_SDD_INSTRUCTION_PHASES.length + Number(hasRemediation)) throw new Error("native SDD instructions have an unsupported shape");
		if (status.nextRecommended === "remediate" && !hasRemediation) throw new Error("native SDD remediation instructions are missing");
	}
	if (status.nextRecommended === "remediate" || status.remediationState !== undefined) {
		const remediation = object(status.remediationState);
		if (typeof remediation.required !== "boolean" || typeof remediation.complete !== "boolean" || typeof remediation.failedEvidenceRevision !== "string" || (remediation.failedEvidenceRevision !== "" && !/^sha256:[0-9a-f]{64}$/.test(remediation.failedEvidenceRevision)) || (status.nextRecommended === "remediate" && (!remediation.required || remediation.complete || !remediation.failedEvidenceRevision))) throw new Error("Invalid native remediation state");
	}
	stringArray(status.blockedReasons);
	enumString(status.nextRecommended, NATIVE_SDD_NEXT_RECOMMENDATIONS);
	return status as NativeSddStatusV2;
}

class NativeReviewPlainCli {
	private readonly adapter: ExecFileAdapter;
	private readonly executable: string | (() => string);
	private readonly timeoutMs: number;
	private readonly maxBufferBytes: number;
	private readonly cleanupDirectory: (directory: string) => Promise<void>;
	constructor(adapter: ExecFileAdapter, executable: string | (() => string) = resolveGentleAiBinary, timeoutMs = 30_000, maxBufferBytes = resolveNativeReviewMaxBufferBytes(), cleanupDirectory = (directory: string) => rm(directory, { recursive: true, force: true })) {
		if (typeof executable === "string" && (!isAbsolute(executable) || executable === "gentle-ai")) throw new TypeError("Native review requires an absolute package-local executable");
		this.adapter = adapter;
		this.executable = executable;
		this.timeoutMs = timeoutMs;
		this.maxBufferBytes = maxBufferBytes;
		this.cleanupDirectory = cleanupDirectory;
	}

	private executablePath(operation: NativeReviewOperation, mutating: boolean): string {
		try {
			const executable = typeof this.executable === "string" ? this.executable : this.executable();
			if (!isAbsolute(executable) || executable === "gentle-ai") throw new TypeError("Native review requires an absolute package-local executable");
			return executable;
		}
		catch (error) {
			if (error instanceof PackageLocalGentleAiBinaryMissingError) {
				throw nativeError(NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING, operation, mutating, error.message, undefined, false);
			}
			throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNAVAILABLE, operation, mutating, "package-local native process could not start", undefined, false);
		}
	}

	// toleratedStderr is an exact-match, operation-scoped allowlist (Design
	// Decision #6, organic-rdd-parity): only START passes a non-empty list, and
	// only when the negotiated version's `mode` capability is true. A near-miss,
	// prefixed, or multi-line stderr is never tolerated — only byte-exact
	// membership in the frozen set.
	private async execute(operation: NativeReviewOperation, cwd: string, arguments_: readonly string[], mutating: boolean, signal?: AbortSignal, toleratedStderr: readonly string[] = []): Promise<NativeJsonExecution> {
		let result: ExecFileResult;
		try { result = await this.adapter({ file: this.executablePath(operation, mutating), arguments: arguments_, cwd, timeoutMs: mutating ? undefined : this.timeoutMs, maxBufferBytes: this.maxBufferBytes, signal }); }
		catch (error) {
			if (error instanceof NativeReviewCliError) throw nativeError(error.code, operation, mutating, error.message, undefined, error.launchAttempted);
			if (error instanceof Error && error.name === "AbortError") throw nativeError(NATIVE_REVIEW_ERROR_CODE.CANCELLED, operation, mutating, "native process was cancelled");
			throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNAVAILABLE, operation, mutating, "native process could not start");
		}
		const diagnostics = nativeProcessDiagnostics(operation, NATIVE_REVIEW_ERROR_CODE.NON_ZERO, result);
		if (result.outputLimitExceeded) throw nativeError(NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT, operation, mutating, "native process output exceeded limit", result, true, undefined, this.maxBufferBytes);
		if (result.timedOut) throw nativeError(NATIVE_REVIEW_ERROR_CODE.TIMEOUT, operation, mutating, "native process timed out", result);
		if (result.signal) throw nativeError(NATIVE_REVIEW_ERROR_CODE.SIGNAL, operation, mutating, "native process was signalled", result);
		const maintenancePartialFailure = [NATIVE_REVIEW_OPERATION.ABANDON, NATIVE_REVIEW_OPERATION.QUARANTINE_LEGACY, NATIVE_REVIEW_OPERATION.RECONCILE_AUTHORITY, NATIVE_REVIEW_OPERATION.REPAIR_LEGACY_ALIAS].includes(operation) && result.exitCode !== 0;
		const toleratedNotice = stderrIsTolerated(result.stderr, toleratedStderr);
		if (result.exitCode !== 0 && !maintenancePartialFailure) throw nativeError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, operation, mutating, "native process failed", result);
		if (result.stderr.trim().length > 0 && !maintenancePartialFailure && !toleratedNotice) throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR, operation, mutating, "native process wrote stderr", result);
		return { body: parseJson(result.stdout, operation, mutating, diagnostics), exitCode: result.exitCode, process: result };
	}

	async reviewStatus(request: NativeReviewStatusRequest): Promise<NativeReviewStatusResult> {
		const { body: result } = await this.execute(NATIVE_REVIEW_OPERATION.STATUS, request.cwd, ["review", "status", "--cwd", request.cwd], false, request.signal);
		const status = decode(NATIVE_REVIEW_OPERATION.STATUS, false, () => decodeNativeReviewStatus(result));
		if (!await repositoriesMatch(request.cwd, status.repository)) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.STATUS, false, "native review status repository mismatch");
		return status;
	}

	// Dark until the negotiated version reports `mode: true` (Design Decision
	// #7, organic-rdd-parity). `status` is read-only (no timeout suppression,
	// exact fixed argv per the design's data flow); `enable`/`disable` mutate
	// and always pass `--scope clone` so Pi's own kill-switch command surface
	// never mutates the operator's global gentle-ai state across other clones.
	async reviewMode(request: NativeReviewModeRequest): Promise<NativeReviewModeResult> {
		const cwd = await canonicalNativeReviewCwd(request.cwd);
		const mutating = request.operation !== NATIVE_REVIEW_MODE_OPERATION.STATUS;
		const { body } = await this.execute(
			NATIVE_REVIEW_OPERATION.MODE,
			cwd,
			["review", "mode", request.operation, "--cwd", cwd, ...(mutating ? ["--scope", "clone"] : []), "--json"],
			mutating,
			request.signal,
		);
		return decode(NATIVE_REVIEW_OPERATION.MODE, mutating, () => decodeNativeReviewMode(body, request.operation));
	}

	async reclaim(request: NativeReviewReclaimRequest): Promise<NativeReviewRecoveryResult> {
		for (const [name, value] of [["lineage", request.lineage], ["actor", request.actor], ["reason", request.reason]] as const) {
			if (!isCanonicalProcessString(value)) throw new TypeError(`Native RECLAIM ${name} must be a non-empty, trimmed, NUL-free string`);
		}
		const { body } = await this.execute(NATIVE_REVIEW_OPERATION.RECLAIM, request.cwd, ["review", "reclaim", "--cwd", request.cwd, "--lineage", request.lineage, "--actor", request.actor, "--reason", request.reason], true, request.signal);
		return { record: body };
	}

	async recover(request: NativeReviewRecoverRequest): Promise<NativeReviewRecoveryResult> {
		for (const [name, value] of [
			["predecessorLineage", request.predecessorLineage],
			["expectedPredecessorRevision", request.expectedPredecessorRevision],
			["successorLineage", request.successorLineage],
			["actor", request.actor],
			["reason", request.reason],
		] as const) {
			if (!isCanonicalProcessString(value)) throw new TypeError(`Native RECOVER ${name} must be a non-empty, trimmed, NUL-free string`);
		}
		// The maintainer authorization is an exact multi-line LF-only binding, so
		// LF is the only permitted control character.
		if (request.maintainerAuthorization !== undefined && (request.maintainerAuthorization.length === 0 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(request.maintainerAuthorization))) {
			throw new TypeError("Native RECOVER maintainerAuthorization must be a non-empty LF-only binding");
		}
		if (!(NATIVE_REVIEW_RECOVER_DISPOSITION as readonly string[]).includes(request.disposition)) throw new TypeError("Native RECOVER disposition must be scope_changed, invalidated, or escalated");
		const { body } = await this.execute(NATIVE_REVIEW_OPERATION.RECOVER, request.cwd, [
			"review", "recover", "--cwd", request.cwd,
			"--predecessor-lineage", request.predecessorLineage,
			"--expected-predecessor-revision", request.expectedPredecessorRevision,
			"--successor-lineage", request.successorLineage,
			"--disposition", request.disposition,
			"--actor", request.actor,
			"--reason", request.reason,
			...(request.maintainerAuthorization === undefined ? [] : ["--maintainer-authorization", request.maintainerAuthorization]),
		], true, request.signal);
		return { record: body };
	}

	async abandon(request: NativeReviewAbandonRequest): Promise<NativeReviewRecoveryResult> {
		for (const [name, value] of [["lineage", request.lineage], ["expectedRevision", request.expectedRevision], ["snapshotIdentity", request.snapshotIdentity], ["actor", request.actor], ["reason", request.reason]] as const) {
			if (!isCanonicalProcessString(value)) throw new TypeError(`Native ABANDON ${name} must be a non-empty, trimmed, NUL-free string`);
		}
		if (!Array.isArray(request.capturedLensResults) || request.capturedLensResults.some((entry) => !isCanonicalProcessString(entry))) throw new TypeError("Native ABANDON capturedLensResults must be an array of non-empty, trimmed, NUL-free strings");
		if (typeof request.findingsPresent !== "boolean") throw new TypeError("Native ABANDON findingsPresent must be a boolean");
		if (request.maintainerAuthorization !== nativeReviewAbandonAuthorization(request)) throw new TypeError("Native ABANDON maintainerAuthorization must match the exact lineage, revision, snapshot, reason, discarded-work, and actor binding");
		const execution = await this.execute(NATIVE_REVIEW_OPERATION.ABANDON, request.cwd, [
			"review", "abandon", "--cwd", request.cwd,
			"--lineage", request.lineage,
			"--expected-revision", request.expectedRevision,
			"--actor", request.actor,
			"--reason", request.reason,
			"--maintainer-authorization", request.maintainerAuthorization,
		], true, request.signal);
		const result = decode(NATIVE_REVIEW_OPERATION.ABANDON, true, () => decodeNativeMaintenanceResult(execution.body, NATIVE_REVIEW_OPERATION.ABANDON));
		if (execution.exitCode !== 0) throw nativeError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, NATIVE_REVIEW_OPERATION.ABANDON, true, "native authority abandonment partially failed", execution.process, true, result.record);
		return result;
	}

	async quarantineLegacy(request: NativeReviewLegacyQuarantineRequest): Promise<NativeReviewRecoveryResult> {
		for (const [name, value] of [["repository", request.repository], ["lineage", request.lineage], ["expectedRevision", request.expectedRevision], ["actor", request.actor], ["reason", request.reason]] as const) {
			if (!isCanonicalProcessString(value)) throw new TypeError(`Native QUARANTINE_LEGACY ${name} must be a non-empty, trimmed, NUL-free string`);
		}
		if (request.diagnostic !== NATIVE_REVIEW_LEGACY_QUARANTINE.DIAGNOSTIC || request.disposition !== NATIVE_REVIEW_LEGACY_QUARANTINE.DISPOSITION) throw new TypeError("Native QUARANTINE_LEGACY supports only the published malformed freeze-findings diagnostic and disposition");
		if (request.maintainerAuthorization !== nativeReviewLegacyQuarantineAuthorization(request)) throw new TypeError("Native QUARANTINE_LEGACY maintainerAuthorization must match the exact repository, lineage, revision, diagnostic, disposition, actor, and reason binding");
		const execution = await this.execute(NATIVE_REVIEW_OPERATION.QUARANTINE_LEGACY, request.cwd, [
			"review", "quarantine-legacy", "--cwd", request.cwd,
			"--lineage", request.lineage,
			"--expected-revision", request.expectedRevision,
			"--diagnostic", request.diagnostic,
			"--disposition", request.disposition,
			"--actor", request.actor,
			"--reason", request.reason,
			"--maintainer-authorization", request.maintainerAuthorization,
		], true, request.signal);
		const result = decode(NATIVE_REVIEW_OPERATION.QUARANTINE_LEGACY, true, () => decodeNativeMaintenanceResult(execution.body, NATIVE_REVIEW_OPERATION.QUARANTINE_LEGACY));
		if (execution.exitCode !== 0) throw nativeError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, NATIVE_REVIEW_OPERATION.QUARANTINE_LEGACY, true, "native legacy quarantine partially failed", execution.process, true, result.record);
		return result;
	}

	async reconcileAuthority(request: NativeReviewReconcileAuthorityRequest): Promise<NativeReviewRecoveryResult> {
		for (const [name, value] of [
			["predecessorLineage", request.predecessorLineage],
			["expectedPredecessorRevision", request.expectedPredecessorRevision],
			["successorLineage", request.successorLineage],
			["expectedSuccessorRevision", request.expectedSuccessorRevision],
			["actor", request.actor],
			["reason", request.reason],
		] as const) {
			if (!isCanonicalProcessString(value)) throw new TypeError(`Native RECONCILE_AUTHORITY ${name} must be a non-empty, trimmed, NUL-free string`);
		}
		if (request.anomalies !== undefined && request.anomalies !== NATIVE_REVIEW_RECONCILE_ANOMALIES.COMBINED) throw new TypeError("Native RECONCILE_AUTHORITY anomalies must use the published unchanged_target,malformed_recovery_authorization ordering");
		const expectedAuthorization = nativeReviewReconcileAuthorization(request);
		if (request.maintainerAuthorization !== expectedAuthorization) {
			throw new TypeError("Native RECONCILE_AUTHORITY maintainerAuthorization must match the exact target and revision binding");
		}
		const execution = await this.execute(NATIVE_REVIEW_OPERATION.RECONCILE_AUTHORITY, request.cwd, [
			"review", "reconcile-authority", "--cwd", request.cwd,
			"--predecessor-lineage", request.predecessorLineage,
			"--expected-predecessor-revision", request.expectedPredecessorRevision,
			"--successor-lineage", request.successorLineage,
			"--expected-successor-revision", request.expectedSuccessorRevision,
			"--actor", request.actor,
			"--reason", request.reason,
			"--maintainer-authorization", request.maintainerAuthorization,
		], true, request.signal);
		const result = decode(NATIVE_REVIEW_OPERATION.RECONCILE_AUTHORITY, true, () => decodeNativeMaintenanceResult(execution.body, NATIVE_REVIEW_OPERATION.RECONCILE_AUTHORITY));
		if (execution.exitCode !== 0) throw nativeError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, NATIVE_REVIEW_OPERATION.RECONCILE_AUTHORITY, true, "native authority reconciliation partially failed", execution.process, true, result.record);
		return result;
	}

	async repairLegacyAlias(request: NativeReviewLegacyAliasRepairRequest): Promise<NativeReviewRecoveryResult> {
		for (const [name, value] of [["repository", request.repository], ["lineage", request.lineage], ["expectedRevision", request.expectedRevision], ["actor", request.actor], ["reason", request.reason]] as const) {
			if (!isCanonicalProcessString(value)) throw new TypeError(`Native REPAIR_LEGACY_ALIAS ${name} must be a non-empty, trimmed, NUL-free string`);
		}
		if (request.diagnostic !== NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DIAGNOSTIC || request.disposition !== NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DISPOSITION) throw new TypeError("Native REPAIR_LEGACY_ALIAS supports only the published historical alias diagnostic and disposition");
		if (request.maintainerAuthorization !== nativeReviewLegacyAliasRepairAuthorization(request)) throw new TypeError("Native REPAIR_LEGACY_ALIAS maintainerAuthorization must match the exact repository, lineage, revision, diagnostic, disposition, actor, and reason binding");
		const execution = await this.execute(NATIVE_REVIEW_OPERATION.REPAIR_LEGACY_ALIAS, request.cwd, [
			"review", "repair-legacy-alias", "--cwd", request.cwd,
			"--lineage", request.lineage,
			"--expected-revision", request.expectedRevision,
			"--diagnostic", request.diagnostic,
			"--disposition", request.disposition,
			"--actor", request.actor,
			"--reason", request.reason,
			"--maintainer-authorization", request.maintainerAuthorization,
		], true, request.signal);
		const result = decode(NATIVE_REVIEW_OPERATION.REPAIR_LEGACY_ALIAS, true, () => decodeNativeMaintenanceResult(execution.body, NATIVE_REVIEW_OPERATION.REPAIR_LEGACY_ALIAS));
		if (execution.exitCode !== 0) throw nativeError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, NATIVE_REVIEW_OPERATION.REPAIR_LEGACY_ALIAS, true, "native historical alias repair partially failed", execution.process, true, result.record);
		return result;
	}
}

export function nativeReviewAbandonAuthorization(request: Pick<NativeReviewAbandonRequest, "lineage" | "expectedRevision" | "snapshotIdentity" | "capturedLensResults" | "findingsPresent" | "actor" | "reason">): string {
	// gentle-ai 0ed9225f removed evidence records from the discarded-work summary,
	// so the native v2 gate verifies an exact eight-line binding (schema, lineage,
	// revision, snapshot_identity, reason, captured_lens_results, findings_present,
	// actor) — there is no evidence_records_present line to derive or relay.
	return [
		"gentle-ai.review-abandon-authorization/v2",
		`lineage=${request.lineage}`,
		`revision=${request.expectedRevision}`,
		`snapshot_identity=${request.snapshotIdentity}`,
		`reason=${request.reason}`,
		`captured_lens_results=${request.capturedLensResults.join(",")}`,
		`findings_present=${request.findingsPresent}`,
		`actor=${request.actor.trim()}`,
	].join("\n");
}

export function nativeReviewLegacyQuarantineAuthorization(request: Pick<NativeReviewLegacyQuarantineRequest, "repository" | "lineage" | "expectedRevision" | "diagnostic" | "disposition" | "actor" | "reason">): string {
	return [
		"gentle-ai.review-legacy-quarantine-authorization/v1",
		`repository=${request.repository}`,
		`lineage=${request.lineage}`,
		`revision=${request.expectedRevision}`,
		`diagnostic=${request.diagnostic}`,
		`disposition=${request.disposition}`,
		`actor=${request.actor}`,
		`reason=${request.reason}`,
	].join("\n");
}

/**
 * The exact native `gentle-ai.review-recovery-authorization/v1` binding for one
 * recovery edge.
 *
 * Native `review recover` accepts a caller-supplied authorization only when it
 * reproduces this binding byte for byte, because it is copied verbatim into the
 * recovery provenance and read afterwards as a maintainer attestation. Pi
 * therefore derives it from freshly read native target status and never
 * forwards a caller-supplied one: a wrong binding is worse than an absent one,
 * since an absent field cannot lie about who approved what.
 *
 * `targetIdentity` is the live target identity the provider itself publishes in
 * the `review.recover` eligibility binding (`status.target_identity`), which is
 * the identity the successor's initial snapshot takes.
 */
export function nativeReviewRecoverAuthorization(request: Pick<NativeReviewRecoverRequest, "predecessorLineage" | "expectedPredecessorRevision" | "actor" | "reason"> & { targetIdentity: string }): string {
	return [
		"gentle-ai.review-recovery-authorization/v1",
		`predecessor_lineage=${request.predecessorLineage}`,
		`predecessor_revision=${request.expectedPredecessorRevision}`,
		`target_identity=${request.targetIdentity}`,
		`actor=${request.actor.trim()}`,
		`reason=${request.reason.trim()}`,
	].join("\n");
}

export function nativeReviewReconcileAuthorization(request: Pick<NativeReviewReconcileAuthorityRequest, "predecessorLineage" | "expectedPredecessorRevision" | "successorLineage" | "expectedSuccessorRevision" | "actor" | "reason" | "anomalies">): string {
	return [
		"gentle-ai.review-reconcile-authorization/v1",
		`predecessor_lineage=${request.predecessorLineage}`,
		`predecessor_revision=${request.expectedPredecessorRevision}`,
		`successor_lineage=${request.successorLineage}`,
		`successor_revision=${request.expectedSuccessorRevision}`,
		`actor=${request.actor}`,
		`reason=${request.reason}`,
		...(request.anomalies === NATIVE_REVIEW_RECONCILE_ANOMALIES.COMBINED ? [`anomalies=${request.anomalies}`] : []),
	].join("\n");
}

export function nativeReviewLegacyAliasRepairAuthorization(request: Pick<NativeReviewLegacyAliasRepairRequest, "repository" | "lineage" | "expectedRevision" | "diagnostic" | "disposition" | "actor" | "reason">): string {
	return [
		"gentle-ai.review-legacy-alias-repair-authorization/v1",
		`repository=${request.repository}`,
		`lineage=${request.lineage}`,
		`revision=${request.expectedRevision}`,
		`diagnostic=${request.diagnostic}`,
		`disposition=${request.disposition}`,
		`actor=${request.actor}`,
		`reason=${request.reason}`,
	].join("\n");
}

export class NativeReviewIntegrationError extends Error {
	readonly failureEnvelope: ReviewFailureV2;
	readonly mutationOutcome: ReviewFailureV2["mutationOutcome"];
	readonly nextAction: string;
	readonly launchAttempted = true;
	constructor(failure: ReviewFailureV2) {
		super(failure.message);
		this.name = "NativeReviewIntegrationError";
		this.failureEnvelope = failure;
		this.mutationOutcome = failure.mutationOutcome;
		this.nextAction = failure.nextAction;
	}
}

// Raised when negotiated START answers a consent question (`consent/v2` from
// the pinned line, `consent/v3` from gentle-ai >= 2.3.0; action:
// "consent_required") instead of `start/v3`. The provider has frozen no
// authority yet: Pi must relay this complete candidate-scoped question and may
// answer only through one of the exact invocations carried by the envelope.
export class NativeReviewConsentRequiredError extends Error {
	readonly consent: ReviewConsentEnvelope;
	readonly launchAttempted = true;
	readonly mutationOutcome = "none";
	constructor(consent: ReviewConsentEnvelope) {
		super(consent.headline);
		this.name = "NativeReviewConsentRequiredError";
		this.consent = consent;
	}
}

// Raised when the provider-issued consent invocation no longer matches the
// binding Pi is answering for. Every one of these guards runs before the
// provider is launched, so the failure is local and nothing was mutated. It
// carries its own identity precisely so callers never report it as a provider
// outage: an opaque `native-operation-failed` here sent issue #247 chasing a
// missing `--cwd` that Pi does forward.
export class NativeReviewConsentBindingError extends Error {
	readonly reason: string;
	readonly launchAttempted = false;
	readonly mutationOutcome = "none";
	constructor(reason: string, message: string) {
		super(message);
		this.name = "NativeReviewConsentBindingError";
		this.reason = reason;
	}
}

function splitNativeConsentInvocation(invocation: string): readonly string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	let started = false;
	const source = invocation.trim();
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (escaping) {
			current += character;
			escaping = false;
			started = true;
			continue;
		}
		// Provider invocations are not shell commands. Keep every path backslash
		// verbatim, including quoted UNC and drive-root paths. Outside quotes,
		// only a backslash before whitespace joins a space-containing token.
		const next = source[index + 1];
		if (character === "\\" && quote === undefined && next !== undefined && /\s/.test(next)) {
			escaping = true;
			started = true;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else current += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				words.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}
	if (quote !== undefined || escaping) throw new TypeError("Native consent invocation has invalid quoting");
	if (started) words.push(current);
	return words;
}

function exactConsentOption(arguments_: readonly string[], name: string): string {
	const values: string[] = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const token = arguments_[index]!;
		if (token === name) {
			const value = arguments_[index + 1];
			if (value === undefined) throw new NativeReviewConsentBindingError("consent-invocation-option-invalid", `Native consent invocation ${name} is missing its value`);
			values.push(value);
			index += 1;
		} else if (token.startsWith(`${name}=`)) values.push(token.slice(name.length + 1));
	}
	if (values.length !== 1) throw new NativeReviewConsentBindingError("consent-invocation-option-invalid", `Native consent invocation requires exactly one ${name}`);
	return values[0]!;
}

// A Pi consent envelope is bound to Pi only when every exact provider replay
// path carries exactly one `--agent pi` option. The outer envelope agent alone
// cannot bind an omitted, embedded, duplicated, or conflicting invocation.
function validatePiConsentChoiceAgentBindings(consent: ReviewConsentEnvelope): void {
	if (!("agent" in consent) || consent.agent !== "pi") return;
	for (const choice of consent.choices) {
		const arguments_ = splitNativeConsentInvocation(choice.invocation).slice(1);
		if (exactConsentOption(arguments_, "--agent") !== "pi") {
			throw new NativeReviewConsentBindingError("consent-invocation-agent-changed", "Native Pi consent invocation agent binding changed");
		}
	}
}

function optionalConsentLineageOption(arguments_: readonly string[]): string | undefined {
	const values: string[] = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const token = arguments_[index]!;
		if (token === "--lineage") {
			const value = arguments_[index + 1];
			if (value === undefined || value.startsWith("--")) throw new NativeReviewConsentBindingError("consent-invocation-option-invalid", "Native consent invocation --lineage is missing its value");
			values.push(value);
			index += 1;
		} else if (token.startsWith("--lineage=")) values.push(token.slice("--lineage=".length));
	}
	if (values.length > 1) throw new NativeReviewConsentBindingError("consent-invocation-option-invalid", "Native consent invocation permits at most one --lineage");
	if (values.length === 0) return undefined;
	const lineageId = values[0]!;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(lineageId)) throw new NativeReviewConsentBindingError("consent-invocation-option-invalid", "Native consent invocation --lineage is malformed");
	return lineageId;
}

interface ConsentInvocation {
	arguments_: readonly string[];
	lineageId?: string;
}

function consentInvocationArguments(request: NativeReviewConsentAnswerRequest): ConsentInvocation {
	validatePiConsentChoiceAgentBindings(request.consent);
	const choice = request.consent.choices.find((candidate) => candidate.answer === request.answer);
	if (choice === undefined) throw new NativeReviewConsentBindingError("consent-answer-unknown", "Native consent answer must be granted or declined");
	const words = splitNativeConsentInvocation(choice.invocation);
	if (words[0] !== "gentle-ai" || words[1] !== "review" || words[2] !== "start") throw new NativeReviewConsentBindingError("consent-invocation-not-start", "Native consent invocation is not a provider review START");
	const arguments_ = words.slice(1);
	if (exactConsentOption(arguments_, "--contract") !== REVIEW_INTEGRATION_CONTRACT) throw new NativeReviewConsentBindingError("consent-invocation-contract-changed", "Native consent invocation contract changed");
	const providerCwd = exactConsentOption(arguments_, "--cwd");
	const requestedCwd = normalizeNativeReviewCwd(request.cwd);
	if (normalizeNativeReviewCwd(providerCwd) !== requestedCwd) throw new NativeReviewConsentBindingError("consent-invocation-cwd-changed", "Native consent invocation repository binding changed");
	if (exactConsentOption(arguments_, "--target") !== request.consent.targetIdentity) throw new NativeReviewConsentBindingError("consent-invocation-target-changed", "Native consent invocation target binding changed");
	if (exactConsentOption(arguments_, "--projection") !== request.consent.projection) throw new NativeReviewConsentBindingError("consent-invocation-projection-changed", "Native consent invocation projection binding changed");
	const lineageId = optionalConsentLineageOption(arguments_);
	if (exactConsentOption(arguments_, "--consent") !== request.answer || arguments_.at(-1) !== request.answer) throw new NativeReviewConsentBindingError("consent-invocation-answer-changed", "Native consent invocation answer binding changed");
	return { arguments_, ...(lineageId === undefined ? {} : { lineageId }) };
}

function decodeDeclinedConsentStart(value: unknown, expected: NativeReviewConsentAnswerRequest): NativeReviewConsentDeclinedResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Native declined consent result must be an object");
	const body = value as Record<string, unknown>;
	if (body.operation !== "review/start" || body.action !== "declined" || body.consent !== "declined_this_candidate") throw new TypeError("Native declined consent result has an invalid identity");
	if (body.target_identity !== expected.consent.targetIdentity || body.projection !== expected.consent.projection || body.risk_level !== expected.consent.riskLevel) throw new TypeError("Native declined consent result target binding changed");
	if (body.lenses_required !== false || !Array.isArray(body.selected_lenses) || body.selected_lenses.length !== 0 || !Array.isArray(body.lens_bindings) || body.lens_bindings.length !== 0) throw new TypeError("Native declined consent result must create no review authority");
	if (typeof body.changed_files !== "number" || !Number.isSafeInteger(body.changed_files) || body.changed_files < 0 || typeof body.changed_lines !== "number" || !Number.isSafeInteger(body.changed_lines) || body.changed_lines < 0) throw new TypeError("Native declined consent result has invalid change counts");
	if (body.lineage_id !== "" || body.state !== "" || body.correction_budget !== 0) throw new TypeError("Native declined consent result cannot carry review authority");
	return {
		kind: "declined",
		targetIdentity: expected.consent.targetIdentity,
		projection: expected.consent.projection,
		riskLevel: expected.consent.riskLevel,
		changedFiles: body.changed_files,
		changedLines: body.changed_lines,
		consent: "declined_this_candidate",
		raw: body,
	};
}

interface NegotiatedExecution {
	body: Record<string, unknown>;
	exitCode: number;
	// True only for a zero-exit bodyless operation that printed nothing: the
	// pinned silent acknowledgement burn. A body is never synthesized for it.
	silent?: true;
}

function decodeNativeAdmittedResultManifest(value: unknown): NativeReviewAdmittedResultManifest {
	// The admission answer routes through the exact-identity forward decoder
	// (decoder-freshness discipline): the complete live envelope — identity
	// constants, binding fields, and the exactly-one-locator rule — is
	// validated before anything is handed to FINALIZE, and an unknown field
	// grown by gentle-ai main is rejected instead of silently dropped.
	const artifact = decodeReviewResultArtifactV2(value);
	return Object.freeze({
		schema: artifact.schema,
		subjectHash: artifact.subjectHash,
		admissionDecision: artifact.admissionDecision,
		lens: artifact.lens,
		...(artifact.path === undefined ? {} : { path: artifact.path }),
		...(artifact.reference === undefined ? {} : { reference: artifact.reference }),
	});
}

// gentle-pi#311 P4-roles: the strict acknowledgement for one executed
// provider role vector. The immutable verdict bytes live in the Go-owned
// compact store slot; this envelope only names the binding the capture
// proved, so anything beyond that exact shape is refused.
function decodeNativeProviderRoleCaptureArtifact(value: unknown): NativeReviewProviderRoleCaptureArtifact {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("native provider role capture artifact must be an object");
	const body = value as Record<string, unknown>;
	const allowed = new Set(["schema", "lineage_id", "target_identity", "role", "captured"]);
	for (const key of Object.keys(body)) if (!allowed.has(key)) throw new TypeError(`native provider role capture artifact carries unexpected key ${key}`);
	const text = (key: string): string => {
		const found = body[key];
		if (typeof found !== "string" || found.trim() !== found || found.length === 0) throw new TypeError(`native provider role capture artifact ${key} must be a non-empty trimmed string`);
		return found;
	};
	if (text("schema") !== NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_SCHEMA) throw new TypeError(`native provider role capture artifact schema must be ${NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_SCHEMA}`);
	const role = text("role");
	if (role !== "refuter" && role !== "targeted-validator") throw new TypeError(`native provider role capture artifact role must be refuter or targeted-validator, received ${role}`);
	if (body.captured !== true) throw new TypeError("native provider role capture artifact must report captured: true");
	return Object.freeze({
		schema: NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_SCHEMA,
		lineageId: text("lineage_id"),
		targetIdentity: text("target_identity"),
		role,
		captured: true,
	});
}

// gentle-pi#638: the recorded declaration Go prints for one unachievable slot. Closed key set, exact schema identity, and the lens Go itself resolved from the request hash -- the host never asserts which lens failed, only reads back the one the provider bound.
function decodeNativeUnachievableLensCaptureArtifact(value: unknown): NativeReviewUnachievableLensCaptureArtifact {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("native unachievable lens capture artifact must be an object");
	const body = value as Record<string, unknown>;
	const allowed = new Set(["schema", "lineage_id", "target_identity", "lens", "selected_order", "reason", "recorded"]);
	for (const key of Object.keys(body)) if (!allowed.has(key)) throw new TypeError(`native unachievable lens capture artifact carries unexpected key ${key}`);
	const text = (key: string): string => {
		const found = body[key];
		if (typeof found !== "string" || found.trim() !== found || found.length === 0) throw new TypeError(`native unachievable lens capture artifact ${key} must be a non-empty trimmed string`);
		return found;
	};
	if (text("schema") !== NATIVE_REVIEW_UNACHIEVABLE_LENS_CAPTURE_SCHEMA) throw new TypeError(`native unachievable lens capture artifact schema must be ${NATIVE_REVIEW_UNACHIEVABLE_LENS_CAPTURE_SCHEMA}`);
	if (typeof body.selected_order !== "number" || !Number.isSafeInteger(body.selected_order) || body.selected_order < 0) throw new TypeError("native unachievable lens capture artifact selected_order must be a non-negative integer");
	if (body.recorded !== true) throw new TypeError("native unachievable lens capture artifact must report recorded: true");
	return Object.freeze({ schema: NATIVE_REVIEW_UNACHIEVABLE_LENS_CAPTURE_SCHEMA, lineageId: text("lineage_id"), targetIdentity: text("target_identity"), lens: text("lens"), selectedOrder: body.selected_order, reason: text("reason"), recorded: true });
}

export class NativeReviewCliV216 implements NativeReviewCli {
	private readonly plain: NativeReviewPlainCli;
	private readonly adapter: ExecFileAdapter;
	private readonly executable: string | (() => string);
	private readonly timeoutMs: number;
	private readonly maxBufferBytes: number;
	private readonly cleanupDirectory: (directory: string) => Promise<void>;
	constructor(
		adapter: ExecFileAdapter,
		executable: string | (() => string) = resolveGentleAiBinary,
		timeoutMs = 30_000,
		maxBufferBytes = resolveNativeReviewMaxBufferBytes(),
		cleanupDirectory: (directory: string) => Promise<void> = (directory) => rm(directory, { recursive: true, force: true }),
	) {
		if (typeof executable === "string" && (!isAbsolute(executable) || executable === "gentle-ai")) throw new TypeError("Native review requires an absolute package-local executable");
		this.adapter = adapter;
		this.executable = executable;
		this.timeoutMs = timeoutMs;
		this.maxBufferBytes = maxBufferBytes;
		this.cleanupDirectory = cleanupDirectory;
		this.plain = new NativeReviewPlainCli(adapter, executable, timeoutMs, maxBufferBytes, cleanupDirectory);
	}

	private executablePath(operation: NativeReviewOperation, mutating: boolean): string {
		try {
			const path = typeof this.executable === "string" ? this.executable : this.executable();
			if (!isAbsolute(path) || path === "gentle-ai") throw new TypeError("Native review requires an absolute package-local executable");
			return path;
		} catch (error) {
			if (error instanceof PackageLocalGentleAiBinaryMissingError) throw nativeError(NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING, operation, mutating, error.message, undefined, false);
			throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNAVAILABLE, operation, mutating, "package-local native process could not start", undefined, false);
		}
	}

	private async invoke(
		operation: NativeReviewOperation,
		cwd: string,
		arguments_: readonly string[],
		mutating: boolean,
		signal: AbortSignal | undefined,
		path: string,
		toleratedStderr: readonly string[] = [],
		// A successful acknowledgement burns its authority and, on every
		// published release up to v2.5.0-rc.3, prints nothing: there is no
		// receipt left to describe. Only that shape opts out of the body, and
		// only for a zero exit. When such an operation does print, the bytes
		// are handed back as a body for the caller to decode against the one
		// identity it accepts (gentle-ai #3947); a non-zero exit still has to
		// produce its typed failure envelope like every other operation.
		expectsBody = true,
	): Promise<NegotiatedExecution> {
		let result: ExecFileResult;
		try {
			result = await this.adapter({ file: path, arguments: arguments_, cwd, timeoutMs: mutating ? undefined : this.timeoutMs, maxBufferBytes: this.maxBufferBytes, signal });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw nativeError(NATIVE_REVIEW_ERROR_CODE.CANCELLED, operation, mutating, "native process was cancelled");
			throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNAVAILABLE, operation, mutating, "native process could not start");
		}
		if (result.outputLimitExceeded) throw nativeError(NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT, operation, mutating, "native process output exceeded limit", result, true, undefined, this.maxBufferBytes);
		if (result.timedOut) throw nativeError(NATIVE_REVIEW_ERROR_CODE.TIMEOUT, operation, mutating, "native process timed out", result);
		if (result.signal) throw nativeError(NATIVE_REVIEW_ERROR_CODE.SIGNAL, operation, mutating, "native process was signalled", result);
		const diagnostics = nativeProcessDiagnostics(operation, NATIVE_REVIEW_ERROR_CODE.NON_ZERO, result);
		if (!expectsBody && result.exitCode === 0 && result.stdout.trim().length === 0) {
			if (result.stderr.trim().length > 0 && !stderrIsTolerated(result.stderr, toleratedStderr)) throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR, operation, mutating, "native process wrote stderr", result);
			return { body: {}, exitCode: result.exitCode, silent: true };
		}
		const body = parseJson(result.stdout, operation, mutating, diagnostics);
		if (result.exitCode !== 0) {
			try {
				throw new NativeReviewIntegrationError(decodeReviewFailureV2(body));
			} catch (error) {
				if (error instanceof NativeReviewIntegrationError) throw error;
				throw nativeError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, operation, mutating, "native negotiated operation failed without a valid failure envelope", result);
			}
		}
		const forecastNarrationTolerated = operation === NATIVE_REVIEW_OPERATION.STATUS && stderrIsForecastNarration(result.stderr);
		if (result.stderr.trim().length > 0 && !stderrIsTolerated(result.stderr, toleratedStderr) && !forecastNarrationTolerated) throw nativeError(NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR, operation, mutating, "native process wrote stderr", result);
		return { body, exitCode: result.exitCode };
	}

	private async negotiated(
		operation: NativeReviewOperation,
		cwd: string,
		arguments_: readonly string[],
		mutating: boolean,
		signal?: AbortSignal,
		toleratedStderr: readonly string[] = [],
	): Promise<NegotiatedExecution> {
		return this.invoke(operation, cwd, arguments_, mutating, signal, this.executablePath(operation, mutating), toleratedStderr);
	}

	async sddStatus(request: NativeSddStatusRequest): Promise<NativeSddStatusV2> {
		return this.sddProjection(request, false);
	}

	async sddContinue(request: NativeSddStatusRequest): Promise<NativeSddStatusV2> {
		if (!isCanonicalProcessString(request.changeName)) throw new TypeError("Native SDD continuation requires an exact selected change");
		return this.sddProjection(request, true);
	}

	private async sddProjection(request: NativeSddStatusRequest, mutating: boolean): Promise<NativeSddStatusV2> {
		if ((request.changeName !== undefined && !isCanonicalProcessString(request.changeName)) || !isCanonicalProcessString(request.workspaceRoot) || !isAbsolute(request.workspaceRoot)) {
			throw new TypeError("Native SDD status requires a canonical change and absolute workspace root");
		}
		const operation = mutating ? NATIVE_REVIEW_OPERATION.SDD_CONTINUE : NATIVE_REVIEW_OPERATION.SDD_STATUS;
		const execution = await this.negotiated(
			operation,
			request.workspaceRoot,
			[operation, ...(request.changeName === undefined ? [] : [request.changeName]), "--cwd", request.workspaceRoot, "--json", "--instructions"],
			mutating,
			request.signal,
		);
		return decode(operation, mutating, () => decodeNativeSddStatusV2(execution.body, request));
	}

	async start(request: NativeStartRequest): Promise<NativeStartResult> {
		if (request.baseRef !== undefined && !isCanonicalProcessString(request.baseRef)) throw new TypeError("Native START baseRef must be a non-empty, trimmed, NUL-free string");
		if (request.baseRef !== undefined && request.committedOnly !== true) throw new TypeError("Native START baseRef requires explicit committedOnly acknowledgement");
		if (request.baseRef === undefined && request.committedOnly !== undefined) throw new TypeError("Native START committedOnly requires an explicit baseRef");
		if (request.targetIdentity !== undefined && !/^sha256:[0-9a-f]{64}$/.test(request.targetIdentity)) throw new TypeError("Native START targetIdentity must be a canonical sha256 identity");
		// STATUS owns the candidate binding and renders the only executable START
		// vector. Callers may supply a previously observed identity only to detect
		// drift; Pi never rebuilds that vector from request fields.
		const projection = request.projection ?? "workspace";
		const selection = nativeUntrackedSelection(request);
		const status = await this.targetStatus({
			cwd: request.cwd,
			projection,
			...(request.baseRef === undefined ? {} : { baseRef: request.baseRef, committedOnly: true }),
			...(request.lineageId === undefined ? {} : { lineageId: request.lineageId }),
			...selection,
			...(request.intendedUntrackedSelection === undefined ? {} : { intendedUntrackedSelection: request.intendedUntrackedSelection }),
			agent: "pi",
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
		const transition = status.nextTransition?.kind === "execute" && status.nextTransition.execute?.operation === "review.start"
			? status.nextTransition.execute
			: undefined;
		if (transition === undefined) throw nativeError(NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE, NATIVE_REVIEW_OPERATION.START, false, "native STATUS did not offer an executable review.start transition", undefined, false);
		if (status.projection.projection !== projection || transition.binding.targetIdentity !== status.targetIdentity || (request.targetIdentity !== undefined && request.targetIdentity !== status.targetIdentity)) {
			throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.START, false, "native START transition target binding mismatch", undefined, false);
		}
		if (request.lineageId !== undefined && transition.binding.lineageId !== undefined && transition.binding.lineageId !== request.lineageId) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.START, false, "native START transition lineage binding mismatch", undefined, false);
		const transitionTokens = transition.arguments.map((argument) => {
			if (argument.token === undefined) throw nativeError(NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE, NATIVE_REVIEW_OPERATION.START, false, "native START transition omitted an ordered argument token", undefined, false);
			return argument.token;
		});
		const targetIdentity = status.targetIdentity;
		const execution = await this.negotiated(NATIVE_REVIEW_OPERATION.START, request.cwd, ["review", "start", ...transitionTokens], true, request.signal);
		// A negotiated v2 START may answer a consent question (action:
		// "consent_required") instead of `start/v3` when the provider needs an
		// explicit answer it cannot infer. Discriminate before decode and surface
		// the complete envelope; only the caller can map a human answer. The
		// body's own schema string selects the identity-exact decoder: the
		// pinned 2.2.x line emits consent/v2, gentle-ai >= 2.3.0 (capabilities
		// v2.1+) emits consent/v3, and any other identity fails closed inside
		// the v3 decoder's exact identity gate.
		if (execution.body.action === "consent_required") {
			const consent = decode(NATIVE_REVIEW_OPERATION.START, true, () => {
				if (execution.body.schema === "gentle-ai.review-integration.consent/v2") return decodeReviewConsentV2(execution.body);
				const decoded = decodeReviewConsentV3(execution.body, "pi");
				validatePiConsentChoiceAgentBindings(decoded);
				return decoded;
			});
			if (consent.targetIdentity !== targetIdentity || consent.projection !== projection) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.START, true, "native consent target binding mismatch");
			throw new NativeReviewConsentRequiredError(consent);
		}
		const result = decode(NATIVE_REVIEW_OPERATION.START, true, () => decodeReviewStartResponse(execution.body));
		if (request.lineageId !== undefined && result.lineageId !== request.lineageId) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.START, true, "native start lineage mismatch");
		const resultTarget = result.targetIdentity ?? result.repositoryContext?.targetIdentity;
		if (resultTarget !== undefined && resultTarget !== targetIdentity) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.START, true, "native start target mismatch");
		return {
			lineageId: result.lineageId,
			state: result.state as NativeStartResult["state"],
			riskLevel: result.riskLevel,
			selectedLenses: result.selectedLenses,
			changedFiles: result.changedFiles,
			changedLines: result.changedLines,
			correctionBudget: result.correctionBudget,
			action: result.action as NativeStartAction,
			lensesRequired: result.lensesRequired,
			riskReasons: result.riskReasons.map((reason) => ({ ...reason })),
			...("nextTransition" in result && result.nextTransition !== undefined ? { nextTransition: result.nextTransition } : {}),
			// Derived, not received. `risk_reasons` is a required start/v2 field
			// already recomputed against the authoritative frozen snapshot, so
			// these phrases describe the same candidate the lenses will review.
			...(() => {
				const evidence = nativeRiskEvidencePhrases(result.riskLevel, result.riskReasons);
				return evidence.length === 0 ? {} : { riskEvidence: evidence };
			})(),
			// Only the empty-candidate recovery is reconstructed. Its sibling
			// tells a plain caller to rerun under the negotiated contract, which
			// this client already did, so relaying it would name a step that
			// changes nothing. A committed-only start (baseRef) is already the
			// recovery, and reporting zero changes there is a real answer.
			...(result.changedFiles === 0 && request.baseRef === undefined ? { hint: REVIEW_EMPTY_CANDIDATE_HINT } : {}),
			raw: result.raw,
		};
	}

	async answerConsent(request: NativeReviewConsentAnswerRequest): Promise<NativeReviewConsentAnswerResult> {
		const invocation = consentInvocationArguments(request);
		const execution = await this.negotiated(NATIVE_REVIEW_OPERATION.START, request.cwd, invocation.arguments_, true, request.signal);
		if (request.answer === NATIVE_REVIEW_CONSENT_ANSWER.DECLINED) {
			return decode(NATIVE_REVIEW_OPERATION.START, true, () => decodeDeclinedConsentStart(execution.body, request));
		}
		const result = decode(NATIVE_REVIEW_OPERATION.START, true, () => decodeReviewStartResponse(execution.body));
		const answeredTarget = result.targetIdentity ?? result.repositoryContext?.targetIdentity;
		if (answeredTarget !== request.consent.targetIdentity) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.START, true, "native consent answer target mismatch");
		if (invocation.lineageId !== undefined && result.lineageId !== invocation.lineageId) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.START, true, "native consent answer lineage mismatch");
		return { kind: "started", start: {
			lineageId: result.lineageId,
			state: result.state as NativeStartResult["state"],
			riskLevel: result.riskLevel,
			selectedLenses: result.selectedLenses,
			changedFiles: result.changedFiles,
			changedLines: result.changedLines,
			correctionBudget: result.correctionBudget,
			action: result.action as NativeStartAction,
			lensesRequired: result.lensesRequired,
			riskReasons: result.riskReasons.map((reason) => ({ ...reason })),
			...("nextTransition" in result && result.nextTransition !== undefined ? { nextTransition: result.nextTransition } : {}),
			...(() => {
				const evidence = nativeRiskEvidencePhrases(result.riskLevel, result.riskReasons);
				return evidence.length === 0 ? {} : { riskEvidence: evidence };
			})(),
			raw: result.raw,
		} };
	}

	async targetStatus(request: NativeTargetStatusRequest): Promise<ReviewStatusV3> {
		if (request.baseRef !== undefined && !isCanonicalProcessString(request.baseRef)) throw new TypeError("Native STATUS baseRef must be a non-empty, trimmed, NUL-free string");
		if (request.baseRef !== undefined && request.committedOnly !== true) throw new TypeError("Native STATUS baseRef requires explicit committedOnly acknowledgement");
		if (request.baseRef === undefined && request.committedOnly !== undefined) throw new TypeError("Native STATUS committedOnly requires an explicit baseRef");
		const selection = nativeUntrackedSelection(request);
		const submitted = request.intendedUntrackedSelection;
		if (submitted !== undefined && submitted.argumentTokens.reduce((count, token) => count + token.split("{{value}}").length - 1, 0) !== 1) throw new TypeError("Native intended-untracked selection requires exactly one provider-issued {{value}} token");
		const statusArguments = submitted === undefined ? [
			"review", "status", "--contract", REVIEW_INTEGRATION_CONTRACT, "--cwd", request.cwd,
			"--projection", request.projection ?? "workspace",
			...nativeUntrackedSelectionArguments(selection),
			...(request.baseRef === undefined ? [] : ["--base-ref", request.baseRef, "--committed-only"]),
			...(request.lineageId === undefined ? [] : ["--lineage", request.lineageId]),
			...(request.agent === undefined ? [] : ["--agent", request.agent]),
			"--next-transition",
		] : ["review", "status", "--cwd", request.cwd, ...submitted.argumentTokens.map((token) => token.replaceAll("{{value}}", submitted.value))];
		const execution = await this.negotiated(NATIVE_REVIEW_OPERATION.STATUS, request.cwd, statusArguments, false, request.signal);
		assertSupportedNextTransitionOperation(execution.body);
		return decode(NATIVE_REVIEW_OPERATION.STATUS, false, () => decodeReviewStatusV3(execution.body));
	}

	// Net-new negotiated `review.repair`: preflight first, execute only when
	// the assessment is eligible, using exactly the provider_inputs that
	// preflight published (Design Decision #6, migrate-review-integration-v2).
	// Argv shape beyond --mode is inferred from provider_inputs' own field
	// names — no repair/v2 fixture is mirrored upstream to ground-truth it
	// against (design.md Open Questions); this is a documented risk.
	async repair(request: NativeReviewRepairRequest): Promise<ReviewRepairV2> {
		const preflightExecution = await this.negotiated(NATIVE_REVIEW_OPERATION.REPAIR, request.cwd, [
			"review", "repair", "--contract", REVIEW_INTEGRATION_CONTRACT, "--cwd", request.cwd, "--mode", "preflight",
		], false, request.signal);
		const preflight = decode(NATIVE_REVIEW_OPERATION.REPAIR, false, () => decodeReviewRepairV2(preflightExecution.body));
		if (preflight.mode !== "preflight") throw new Error("wrong repair preflight discriminator");
		if (preflight.assessment.status !== "eligible" || preflight.providerInputs === undefined) return preflight;
		const providerInputs = preflight.providerInputs;
		const executeExecution = await this.negotiated(NATIVE_REVIEW_OPERATION.REPAIR, request.cwd, [
			"review", "repair", "--contract", REVIEW_INTEGRATION_CONTRACT, "--cwd", request.cwd, "--mode", "execute",
			"--lineage", providerInputs.lineageId,
			"--expected-revision", providerInputs.expectedRevision,
			"--cause", providerInputs.cause,
			"--disposition", providerInputs.disposition,
			"--repository-binding", providerInputs.repositoryBinding,
			"--actor", request.actor,
			"--reason", request.reason,
			"--maintainer-authorization", request.maintainerAuthorization,
		], true, request.signal);
		return decode(NATIVE_REVIEW_OPERATION.REPAIR, true, () => decodeReviewRepairV2(executeExecution.body));
	}

	// `review capture-evidence`: the evidence-first correction lifecycle's
	// collection step. Confirmed argv and response shape against a real v2.2.2
	// review run (lineage review-b39d803b68a90767): exactly
	// --cwd/--lineage/--target/--expected-revision/--outcome/--input, no
	// --contract, and the verification-evidence/v2 record returned DIRECTLY —
	// not wrapped in an operation/v2 envelope. Evidence is staged through the
	// same 0o600 tmpfile discipline FINALIZE uses.
	async captureResult(request: NativeReviewCaptureResultRequest): Promise<NativeReviewCaptureResultOutcome> {
		if (request.argumentTokens.length === 0) throw new TypeError("Native CAPTURE_RESULT requires the provider-issued argument tokens");
		if (request.argumentTokens.some((token) => typeof token !== "string" || token.length === 0)) throw new TypeError("Native CAPTURE_RESULT argument tokens must all be non-empty strings");
		if (request.resultDocument.length === 0) throw new TypeError("Native CAPTURE_RESULT result document must contain at least one byte");
		const carriesContext = request.argumentTokens.some((token) => token === "--repository-context" || token.startsWith("--repository-context="));
		if (carriesContext && request.cwd !== undefined) throw new TypeError("Native CAPTURE_RESULT takes a repository context or --cwd, never both");
		const directory = await mkdtemp(join(tmpdir(), "gentle-ai-capture-result-"));
		try {
			await chmod(directory, 0o700);
			const resultFile = join(directory, "result.json");
			await writeFile(resultFile, request.resultDocument, { encoding: "utf8", mode: 0o600 });
			await chmod(resultFile, 0o600);
			const executable = this.executablePath(NATIVE_REVIEW_OPERATION.CAPTURE_RESULT, true);
			const execution = await this.invoke(NATIVE_REVIEW_OPERATION.CAPTURE_RESULT, request.cwd ?? process.cwd(), [
				"review", "capture-result",
				...request.argumentTokens,
				...(carriesContext || request.cwd === undefined ? [] : ["--cwd", request.cwd]),
				"--input", resultFile,
			], true, request.signal, executable);
			return decode(NATIVE_REVIEW_OPERATION.CAPTURE_RESULT, true, () => {
				const body = object(execution.body);
				if (body.schema === "gentle-ai.review-last-event-closure/v1") {
					const closure = decodeReviewLastEventClosureV1(body);
					if (closure.operation !== "review/capture-result") throw new TypeError("capture-result returned a closure for another operation");
					return closure;
				}
				return decodeNativeAdmittedResultManifest(body);
			});
		} finally {
			await this.cleanupDirectory(directory).catch(() => undefined);
		}
	}

	// Relays the provider-issued acknowledgement exactly as rendered. A success
	// burns the authority and its artifacts; a refusal still arrives as the
	// ordinary typed failure envelope. Two success shapes exist and both are
	// the same burn: every published release up to v2.5.0-rc.3 prints nothing
	// (resolved as `undefined`, byte-for-byte the pinned behaviour), and
	// gentle-ai #3947 prints one `gentle-ai.review-acknowledged/v1` envelope
	// naming the burned lineage, target, and consumed revision. Any other
	// output on a zero exit is schema-incompatible with the mutation outcome
	// unknown, exactly like a malformed terminal closure: the caller
	// reconciles through STATUS and never infers the burn from prose.
	async acknowledgeApproved(request: NativeReviewAcknowledgeApprovedRequest): Promise<NativeReviewAcknowledgeApprovedOutcome> {
		if (request.argumentTokens.length === 0) throw new TypeError("Native ACKNOWLEDGE_APPROVED requires the provider-issued argument tokens");
		if (request.argumentTokens.some((token) => typeof token !== "string" || token.length === 0)) throw new TypeError("Native ACKNOWLEDGE_APPROVED argument tokens must all be non-empty strings");
		if (request.argumentTokens.some((token) => token.includes("{{value}}"))) throw new TypeError("Native ACKNOWLEDGE_APPROVED argument tokens carry no caller-substituted value");
		const executable = this.executablePath(NATIVE_REVIEW_OPERATION.ACKNOWLEDGE_APPROVED, true);
		const execution = await this.invoke(NATIVE_REVIEW_OPERATION.ACKNOWLEDGE_APPROVED, request.cwd, [
			"review", "acknowledge-approved", ...request.argumentTokens,
		], true, request.signal, executable, [], false);
		if (execution.silent) return undefined;
		return decode(NATIVE_REVIEW_OPERATION.ACKNOWLEDGE_APPROVED, true, () => decodeReviewAcknowledgedV1(execution.body, request.binding ?? {}));
	}

	async captureCorrectionPlan(request: NativeReviewCorrectionPlanCaptureRequest): Promise<ReviewLastEventClosureV1> {
		if (request.argumentTokens.length === 0) throw new TypeError("Native CAPTURE_CORRECTION_PLAN requires the provider-issued argument tokens");
		if (request.argumentTokens.some((token) => typeof token !== "string" || token.length === 0)) throw new TypeError("Native CAPTURE_CORRECTION_PLAN argument tokens must all be non-empty strings");
		if (!Number.isSafeInteger(request.correctionLines) || request.correctionLines < 1 || request.correctionLines > 200) throw new TypeError("Native CAPTURE_CORRECTION_PLAN correction lines must be a positive integer up to 200");
		const valueIndex = request.argumentTokens.findIndex((token) => token.includes("{{value}}"));
		if (valueIndex < 0 || request.argumentTokens.filter((token) => token.includes("{{value}}")).length !== 1) throw new TypeError("Native CAPTURE_CORRECTION_PLAN requires exactly one provider-issued {{value}} token");
		const argumentTokens = request.argumentTokens.map((token, index) => index === valueIndex ? token.replaceAll("{{value}}", String(request.correctionLines)) : token);
		const executable = this.executablePath(NATIVE_REVIEW_OPERATION.CAPTURE_CORRECTION_PLAN, true);
		const execution = await this.invoke(NATIVE_REVIEW_OPERATION.CAPTURE_CORRECTION_PLAN, request.cwd, [
			"review", "capture-correction-plan", ...argumentTokens,
		], true, request.signal, executable);
		return decode(NATIVE_REVIEW_OPERATION.CAPTURE_CORRECTION_PLAN, true, () => {
			const closure = decodeReviewLastEventClosureV1(execution.body);
			if (closure.operation !== "review.capture-correction-plan") throw new TypeError("capture-correction-plan returned a closure for another operation");
			return closure;
		});
	}

	// gentle-pi#311 P4-roles: executes one provider-rendered self-contained
	// role capture vector exactly as rendered — one CLI invocation, verbatim
	// tokens in provider order, in the foreground. Go materializes the role
	// prompt, spawns its own locked-down pi subprocess, and admits the raw
	// verdict; Pi never adds, removes, or reorders a single token (not even
	// --cwd: the vector's --repository-context is authoritative and mutually
	// exclusive with a path). The central adapter injects the relay handshake
	// environment on this spawn like on every other gentle-ai invocation.
	async captureProviderRole(request: NativeReviewProviderRoleCaptureRequest): Promise<NativeReviewProviderRoleCaptureOutcome> {
		if (!isNativeReviewProviderRoleCaptureOperation(request.captureOperation)) throw new TypeError(`Native CAPTURE_PROVIDER_ROLE supports only review.capture-refuter and review.capture-validation, received ${JSON.stringify(request.captureOperation)}`);
		const verb = request.captureOperation.slice("review.".length);
		const expectedClosureOperation = NATIVE_REVIEW_PROVIDER_ROLE_CAPTURE_CLOSURE_OPERATION[request.captureOperation];
		if (request.argumentTokens.length === 0) throw new TypeError("Native CAPTURE_PROVIDER_ROLE requires the provider-rendered argument tokens");
		if (request.argumentTokens.some((token) => typeof token !== "string" || token.length === 0)) throw new TypeError("Native CAPTURE_PROVIDER_ROLE argument tokens must all be non-empty strings");
		const executable = this.executablePath(NATIVE_REVIEW_OPERATION.CAPTURE_PROVIDER_ROLE, true);
		const execution = await this.invoke(NATIVE_REVIEW_OPERATION.CAPTURE_PROVIDER_ROLE, request.cwd, [
			"review", verb,
			...request.argumentTokens,
		], true, request.signal, executable);
		return decode(NATIVE_REVIEW_OPERATION.CAPTURE_PROVIDER_ROLE, true, () => {
			const body = object(execution.body);
			if (body.schema === "gentle-ai.review-last-event-closure/v1") {
				const closure = decodeReviewLastEventClosureV1(body);
				if (closure.operation !== expectedClosureOperation) throw new TypeError("provider role capture returned a closure for another operation");
				return closure;
			}
			return decodeNativeProviderRoleCaptureArtifact(body);
		});
	}

	// gentle-pi#638: `gentle-ai review capture-unachievable` records one bound declaration that the exact slot the collect transition offered cannot be completed under current conditions. Unlike every other capture verb the host runs, this one reports a failure instead of a result, so it never takes the provider-issued tokens verbatim: the declaration's binding values are named fields re-derived from the slot, and Go verifies them against the frozen lineage, revision, target, and subject hash before recording anything (internal/cli/review_capture_unachievable.go). A binding that no longer matches is a typed refusal the caller surfaces, never a host-side reconstruction.
	async captureUnachievableLens(request: NativeReviewUnachievableLensCaptureRequest): Promise<NativeReviewUnachievableLensCaptureArtifact> {
		for (const [field, value] of (["lineageId", "reason"] as const).map((field) => [field, request[field]] as const)) {
			if (!isCanonicalProcessString(value)) throw new TypeError(`Native CAPTURE_UNACHIEVABLE ${field} must be a non-empty, trimmed, NUL-free string`);
		}
		// The three identity fields are digests on every slot the provider offers, so a non-sha value means the declaration binding was parsed wrong; refuse it locally instead of invoking a doomed process.
		for (const [field, value] of (["targetIdentity", "expectedRevision", "requestHash"] as const).map((field) => [field, request[field]] as const)) {
			if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`Native CAPTURE_UNACHIEVABLE ${field} must be a canonical SHA-256 identity`);
		}
		const detail = request.detail === undefined ? "" : request.detail.trim();
		// gentle-pi#822: the native limit is 512 UTF-8 bytes, not 512 UTF-16 code units — the Go side measures the encoded payload, so a multibyte detail needs Buffer.byteLength; a .length check would let 300 two-byte characters through.
		if (Buffer.byteLength(detail, "utf8") > NATIVE_REVIEW_UNACHIEVABLE_LENS_DETAIL_LIMIT) throw new TypeError(`Native CAPTURE_UNACHIEVABLE detail exceeds ${NATIVE_REVIEW_UNACHIEVABLE_LENS_DETAIL_LIMIT} bytes`);
		if (request.repositoryContext !== undefined && !isCanonicalProcessString(request.repositoryContext)) throw new TypeError("Native CAPTURE_UNACHIEVABLE repositoryContext must be a non-empty, trimmed, NUL-free string");
		const executable = this.executablePath(NATIVE_REVIEW_OPERATION.CAPTURE_UNACHIEVABLE, true);
		// gentle-pi#822: --repository-context is authoritative and mutually exclusive with a path (the captureProviderRole discipline), so --cwd rides the invocation only when no repository context names it; the process working directory stays request.cwd either way.
		const execution = await this.invoke(NATIVE_REVIEW_OPERATION.CAPTURE_UNACHIEVABLE, request.cwd, ["review", "capture-unachievable", "--lineage", request.lineageId, "--target", request.targetIdentity, "--expected-revision", request.expectedRevision, "--request-hash", request.requestHash, "--reason", request.reason, ...(detail === "" ? [] : ["--detail", detail]), ...(request.repositoryContext === undefined ? ["--cwd", request.cwd] : ["--repository-context", request.repositoryContext])], true, request.signal, executable);
		return decode(NATIVE_REVIEW_OPERATION.CAPTURE_UNACHIEVABLE, true, () => decodeNativeUnachievableLensCaptureArtifact(execution.body));
	}

	// gentle-pi#311 P5: executes one provider-rendered `review.finalize`
	// execute transition exactly as rendered. The tokens come verbatim from
	// the negotiated next_transition (e.g. `--lineage=<id>
	// --captured-results=true`); Pi assembles no reviewer, refuter, or
	// validator documents for this lane — the provider discovers its own
	// admitted role and lens slots.

	// Same misbinding class as capture-evidence (live smoke, 2026-08-16): the
	// correction PLAN and TARGETED VALIDATION collect slots render `finalize`
	// submission descriptors whose tokens are self-contained (--contract,
	// --lineage, --expected-revision, --target, --request-hash,
	// --repository-context) plus exactly one {{value}} slot. Executing anything
	// other than those rendered tokens fails the live emitter's committed-
	// intent reconciliation, so the tokens pass through verbatim with only the
	// {{value}} substitution: a literal for correction_lines, a staged 0o600
	// artifact path for a validation document.



	// Field defect (fambig, 2026-08-16): at every evidence-pending sub-state
	// the collect slot renders the identity native demands — for a correction
	// that is the fix-diff `--target`, not the live workspace snapshot — so the
	// slot's rendered submission tokens execute verbatim, with only the
	// {{outcome}} and {{input}} slots substituted. Same verbatim-token
	// discipline as captureResult; --repository-context is authoritative and
	// mutually exclusive with a path.

	async reviewStatus(request: NativeReviewStatusRequest): Promise<NativeReviewStatusResult> {
		const execution = await this.invoke(
			NATIVE_REVIEW_OPERATION.STATUS,
			request.cwd,
			["review", "status", "--cwd", request.cwd],
			false,
			request.signal,
			this.executablePath(NATIVE_REVIEW_OPERATION.STATUS, false),
		);
		const status = decode(NATIVE_REVIEW_OPERATION.STATUS, false, () => decodeNativeReviewStatus(execution.body));
		if (!await repositoriesMatch(request.cwd, status.repository)) throw nativeError(NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH, NATIVE_REVIEW_OPERATION.STATUS, false, "native review status repository mismatch");
		return status;
	}

	async reviewMode(request: NativeReviewModeRequest): Promise<NativeReviewModeResult> {
		const cwd = await canonicalNativeReviewCwd(request.cwd);
		const mutating = request.operation !== NATIVE_REVIEW_MODE_OPERATION.STATUS;
		const execution = await this.invoke(
			NATIVE_REVIEW_OPERATION.MODE,
			cwd,
			["review", "mode", request.operation, "--cwd", cwd, ...(mutating ? ["--scope", "clone"] : []), "--json"],
			mutating,
			request.signal,
			this.executablePath(NATIVE_REVIEW_OPERATION.MODE, mutating),
		);
		return decode(NATIVE_REVIEW_OPERATION.MODE, mutating, () => decodeNativeReviewMode(execution.body, request.operation));
	}

	// Read-only risk assessment (gentle-ai#4295, gentle-pi#662). Never mutates;
	// an older binary without the verb, or any other process/decode failure,
	// rejects -- callers (the `gentle_review` tool's `assess` operation) fail
	// closed to `high`.
	async assess(request: NativeReviewAssessRequest): Promise<ReviewAssessmentV1> {
		if (request.baseRef !== undefined && !isCanonicalProcessString(request.baseRef)) throw new TypeError("Native ASSESS baseRef must be a non-empty, trimmed, NUL-free string");
		if (request.baseRef !== undefined && request.committedOnly !== true) throw new TypeError("Native ASSESS baseRef requires explicit committedOnly acknowledgement");
		if (request.baseRef === undefined && request.committedOnly !== undefined) throw new TypeError("Native ASSESS committedOnly requires an explicit baseRef");
		const cwd = await canonicalNativeReviewCwd(request.cwd);
		const execution = await this.invoke(
			NATIVE_REVIEW_OPERATION.ASSESS,
			cwd,
			["review", "assess", "--cwd", cwd, ...(request.baseRef === undefined ? [] : ["--base-ref", request.baseRef, "--committed-only"]), "--json"],
			false,
			request.signal,
			this.executablePath(NATIVE_REVIEW_OPERATION.ASSESS, false),
		);
		return decode(NATIVE_REVIEW_OPERATION.ASSESS, false, () => decodeReviewAssessmentV1(execution.body));
	}

	// Recovery commands are version-gated plain CLI operations outside the
	// negotiated integration-v1 contract, exactly like reviewStatus.
	reclaim(request: NativeReviewReclaimRequest): Promise<NativeReviewRecoveryResult> {
		return this.plain.reclaim(request);
	}

	recover(request: NativeReviewRecoverRequest): Promise<NativeReviewRecoveryResult> {
		return this.plain.recover(request);
	}

	abandon(request: NativeReviewAbandonRequest): Promise<NativeReviewRecoveryResult> {
		return this.plain.abandon(request);
	}

	quarantineLegacy(request: NativeReviewLegacyQuarantineRequest): Promise<NativeReviewRecoveryResult> {
		return this.plain.quarantineLegacy(request);
	}

	reconcileAuthority(request: NativeReviewReconcileAuthorityRequest): Promise<NativeReviewRecoveryResult> {
		return this.plain.reconcileAuthority(request);
	}

	repairLegacyAlias(request: NativeReviewLegacyAliasRepairRequest): Promise<NativeReviewRecoveryResult> {
		return this.plain.repairLegacyAlias(request);
	}
}

export function createNativeReviewCli(adapter?: ExecFileAdapter, executable: string | (() => string) = resolveGentleAiBinary): NativeReviewCli {
	return new NativeReviewCliV216(adapter ?? createNodeExecFileAdapter(), executable);
}
