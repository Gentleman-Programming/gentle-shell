export const REVIEW_INTEGRATION_CONTRACT = "gentle-ai.review-integration/v2";

export const REVIEW_INTEGRATION_OPERATION = {
	REPAIR: "review.repair",
	START: "review.start",
	STATUS: "review.status",
} as const;
export type ReviewIntegrationOperation = (typeof REVIEW_INTEGRATION_OPERATION)[keyof typeof REVIEW_INTEGRATION_OPERATION];

// Retained enums/unions, identity-neutral: copied verbatim from lib/review-integration-v1.ts.
export const REVIEW_AUTHORITY_APPLICABILITY = {
	CURRENT_TARGET: "current_target",
	UNRELATED: "unrelated",
	AMBIGUOUS: "ambiguous",
	CORRUPTED: "corrupted",
	NOT_EVALUATED: "not_evaluated",
} as const;
export type ReviewAuthorityApplicability = (typeof REVIEW_AUTHORITY_APPLICABILITY)[keyof typeof REVIEW_AUTHORITY_APPLICABILITY];

export const REVIEW_REPLAYABILITY = {
	NOT_REPLAYABLE: "not_replayable",
	EXACT_REPLAY_SAFE: "exact_replay_safe",
	STATUS_REQUIRED: "status_required",
	MANUAL_ACTION_REQUIRED: "manual_action_required",
} as const;
export type ReviewReplayability = (typeof REVIEW_REPLAYABILITY)[keyof typeof REVIEW_REPLAYABILITY];

export const REVIEW_MUTATION_OUTCOME = {
	NOT_STARTED: "not_started",
	UNKNOWN: "unknown",
	COMMITTED: "committed",
} as const;
export type ReviewMutationOutcome = (typeof REVIEW_MUTATION_OUTCOME)[keyof typeof REVIEW_MUTATION_OUTCOME];

export const REVIEW_PROJECTION = {
	STAGED: "staged",
	WORKSPACE: "workspace",
} as const;
export type ReviewProjection = (typeof REVIEW_PROJECTION)[keyof typeof REVIEW_PROJECTION];

export const REVIEW_PROJECTION_KIND = {
	CURRENT_CHANGES: "current-changes",
	BASE_DIFF: "base-diff",
	BASE_WORKSPACE_OVERLAY: "base-workspace-overlay",
	EXACT_REVISION: "exact-revision",
	FIX_DIFF: "fix-diff",
} as const;
export type ReviewProjectionKind = (typeof REVIEW_PROJECTION_KIND)[keyof typeof REVIEW_PROJECTION_KIND];

export const REVIEW_AUTHORITY_VERSION = {
	COMPACT_V2: "compact-v2",
	LEGACY_V1: "legacy-v1",
} as const;
export type ReviewAuthorityVersion = (typeof REVIEW_AUTHORITY_VERSION)[keyof typeof REVIEW_AUTHORITY_VERSION];

// Widened by protocol v2: `correction_required` and `validating` are new
// start/status states introduced by the negotiated correction lifecycle.
export const REVIEW_START_STATE = {
	UNREVIEWED: "unreviewed",
	REVIEWING: "reviewing",
	JUDGES_CONFIRMED: "judges_confirmed",
	FINDINGS_FROZEN: "findings_frozen",
	EVIDENCE_CLASSIFIED: "evidence_classified",
	FIX_REQUIRED: "fix_required",
	FIXING: "fixing",
	FIX_VALIDATING: "fix_validating",
	CORRECTION_REQUIRED: "correction_required",
	VALIDATING: "validating",
	READY_FINAL_VERIFICATION: "ready_final_verification",
	FINAL_VERIFYING: "final_verifying",
	APPROVED: "approved",
	ESCALATED: "escalated",
	INVALIDATED: "invalidated",
} as const;
export type ReviewStartState = (typeof REVIEW_START_STATE)[keyof typeof REVIEW_START_STATE];

const START_ACTIONS = ["created", "resumed", "closed", "blocked-scope-action"] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const REVIEW_LENSES = ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const;
const RISK_REASON_CODES = ["configuration_change", "empty_content", "executable_change", "executable_mode", "hot_path", "large_change", "non_executable_only", "process_boundary", "process_scan_limit", "service_token", "shell_source"] as const;
const RISK_SIGNALS = ["auth", "update", "security", "payments", "permissions", "shell_process"] as const;
// "collect" and "execute" are the v2 envelope's projection of a live
// transaction whose next_transition is mandatory: the root action names the
// transition kind instead of reading as a terminal stop.
const STATUS_ACTIONS = ["start", "recover", "maintainer_action", "select_lineage", "repair_authority", "stop", "collect", "execute"] as const;
const RECEIPT_STATUSES = ["expected_missing", "present", "publication_pending", "not_applicable"] as const;
type ReviewReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const REVIEW_STATUS_ACTION_DISPOSITION = {
	SCOPE_CHANGED: "scope_changed",
	INVALIDATED: "invalidated",
	ESCALATED: "escalated",
} as const;
export type ReviewStatusActionDisposition = (typeof REVIEW_STATUS_ACTION_DISPOSITION)[keyof typeof REVIEW_STATUS_ACTION_DISPOSITION];
const REQUIRED_OPERATIONS = Object.freeze(Object.values(REVIEW_INTEGRATION_OPERATION));
// Typed failures are accepted only for the supported start, status, repair,
// and last-event capture operations. Retired lifecycle verbs fail closed.
const FAILURE_OPERATIONS = Object.freeze([
	...REQUIRED_OPERATIONS,
	"review.capture-result",
	"review.capture-correction-plan",
	"review.capture-refuter",
	"review.capture-validation",
] as const);
const REQUIRED_GATES = Object.freeze(["post-apply", "pre-commit", "pre-push", "pre-pr", "release"] as const);
const REQUIRED_PROJECTIONS = Object.freeze(Object.values(REVIEW_PROJECTION));
// The schema floor shared by every accepted capabilities identity. Each minor
// then adds its own capabilities/consent/status identities below: the provider
// swaps those three advertisements as the protocol minor advances (v2.1 moved
// consent to v3; v2.2 moved status to v5), ground-truthed against the vendored
// capabilities[-v2.1|-v2.2].schema.json contracts on gentle-ai main and a live
// v2.2 capture from a main-line dev build.
const REQUIRED_SCHEMAS_COMMON = Object.freeze([
	"gentle-ai.review-admitted-result/v2",
	"gentle-ai.review-artifact-subject/v2",
	"gentle-ai.review-authority-repair-assessment/v1",
	"gentle-ai.review-authority-status/v1",
	"gentle-ai.review-gate-request/v1",
	"gentle-ai.review-integration.failure/v2",
	"gentle-ai.review-final-verification-incident/v1",
	"gentle-ai.review-integration.operation/v2",
	"gentle-ai.review-integration.projection/v1",
	"gentle-ai.review-integration.repair/v2",
	"gentle-ai.review-receipt/v1",
	"gentle-ai.review-receipt/v2",
	"gentle-ai.review-result-artifact/v2",
	"gentle-ai.review-targeted-validation-request/v1",
	"gentle-ai.review-verification-evidence/v2",
	"https://gentle-ai.dev/schema/review/refuter/v1",
	"https://gentle-ai.dev/schema/review/reviewer/v1",
	"https://gentle-ai.dev/schema/review/validator/v1",
] as const);
// The v2.3 provider contract (first advertised by the pinned v2.5.0-rc.3
// runtime) retired exact_receipt_replay, five_delivery_gates, and
// sdd_receipt_binding from the mandatory feature set and
// exact_gate_receipt_discovery, one_shot_final_verification_retry, and
// outcome_bound_verification_evidence from the optional set; none of them is
// consumed by Pi's negotiated v2 lane. Earlier minors keep their frozen
// requirement sets unchanged.
const REQUIRED_MANDATORY_FEATURES_V23 = Object.freeze([
	"compact_v2_authority",
	"immutable_snapshot",
	"legacy_v1_target_scoped_read_only",
	"repository_independent_capabilities",
	"restart_safe_projection",
	"target_scoped_status",
	"uniform_failure_envelope",
] as const);
// v2.3 (first advertised by the pinned v2.5.0-rc.3 provider) retired three
// v1-era identities from its advertisement. Pi never decodes those envelopes
// on the negotiated v2 lane, so the v2.3 requirement list is the exact set the
// v2.3 provider contract defines; earlier minors keep the full common list.
// The load-time length assertion keeps this filter honest: if the common-list
// identifier form ever drifts away from these bare identifiers, the module
// fails loudly instead of silently requiring schemas the provider retired.
const RETIRED_SCHEMAS_V23: readonly string[] = Object.freeze([
	"gentle-ai.review-final-verification-incident/v1",
	"gentle-ai.review-receipt/v2",
	"gentle-ai.review-verification-evidence/v2",
]);
const REQUIRED_SCHEMAS_COMMON_V23 = Object.freeze(REQUIRED_SCHEMAS_COMMON.filter((schema) => !RETIRED_SCHEMAS_V23.includes(schema)));
if (REQUIRED_SCHEMAS_COMMON_V23.length !== REQUIRED_SCHEMAS_COMMON.length - RETIRED_SCHEMAS_V23.length) {
	throw new TypeError("v2.3 retired-schema filter must remove exactly the retired identities from the common schema list");
}
const CAPABILITIES_SCHEMA_IDENTITIES: Readonly<Record<string, { protocolMinor: number; requiredSchemas: readonly string[]; requiredMandatoryFeatures?: readonly string[]; optionalFeatureFloor?: number }>> = Object.freeze({
	"gentle-ai.review-integration.capabilities/v2": Object.freeze({
		protocolMinor: 0,
		requiredSchemas: Object.freeze([...REQUIRED_SCHEMAS_COMMON, "gentle-ai.review-integration.capabilities/v2", "gentle-ai.review-integration.consent/v2", "gentle-ai.review-integration.start/v3", "gentle-ai.review-integration.status/v3"]),
	}),
	"gentle-ai.review-integration.capabilities/v2.1": Object.freeze({
		protocolMinor: 1,
		requiredSchemas: Object.freeze([...REQUIRED_SCHEMAS_COMMON, "gentle-ai.review-integration.capabilities/v2.1", "gentle-ai.review-integration.consent/v3", "gentle-ai.review-integration.start/v3", "gentle-ai.review-integration.status/v3"]),
	}),
	"gentle-ai.review-integration.capabilities/v2.2": Object.freeze({
		protocolMinor: 2,
		requiredSchemas: Object.freeze([...REQUIRED_SCHEMAS_COMMON, "gentle-ai.review-integration.capabilities/v2.2", "gentle-ai.review-integration.consent/v3", "gentle-ai.review-integration.start/v3", "gentle-ai.review-integration.status/v5"]),
	}),
	"gentle-ai.review-integration.capabilities/v2.3": Object.freeze({
		protocolMinor: 3,
		requiredSchemas: Object.freeze([...REQUIRED_SCHEMAS_COMMON_V23, "gentle-ai.review-integration.capabilities/v2.3", "gentle-ai.review-integration.consent/v3", "gentle-ai.review-integration.start/v4", "gentle-ai.review-integration.status/v5"]),
		requiredMandatoryFeatures: REQUIRED_MANDATORY_FEATURES_V23,
		optionalFeatureFloor: 14,
	}),
	"gentle-ai.review-integration.capabilities/v2.4": Object.freeze({
		protocolMinor: 4,
		requiredSchemas: Object.freeze([...REQUIRED_SCHEMAS_COMMON_V23, "gentle-ai.review-integration.capabilities/v2.4", "gentle-ai.review-integration.consent/v3", "gentle-ai.review-integration.start/v4", "gentle-ai.review-integration.status/v6", "gentle-ai.review-intended-untracked-selection/v1"]),
		requiredMandatoryFeatures: REQUIRED_MANDATORY_FEATURES_V23,
		optionalFeatureFloor: 14,
	}),
	// Ground-truthed against the published v2.6.0 binary: capabilities/v2.5
	// advertises the same required surface as v2.4 (status/v6 is still
	// advertised for compatibility) plus the new status/v7 schema, which is a
	// superset-checked addition, not a requirement -- decodeReviewStatusV3
	// accepts v7 as an additive extension of v6, so the required-schema floor
	// stays unchanged. The v2.6.0 binary advertised 15 optional features
	// (floor stays at 14, its established minimum).
	"gentle-ai.review-integration.capabilities/v2.5": Object.freeze({
		protocolMinor: 5,
		requiredSchemas: Object.freeze([...REQUIRED_SCHEMAS_COMMON_V23, "gentle-ai.review-integration.capabilities/v2.5", "gentle-ai.review-integration.consent/v3", "gentle-ai.review-integration.start/v4", "gentle-ai.review-integration.status/v6", "gentle-ai.review-intended-untracked-selection/v1"]),
		requiredMandatoryFeatures: REQUIRED_MANDATORY_FEATURES_V23,
		optionalFeatureFloor: 14,
	}),
	// Ground-truthed against the published v3.4.0 binary: capabilities/v2.6
	// advertises the same required surface as v2.5 (status/v6 is still
	// advertised for compatibility) plus the status/v7 and status/v8 schemas,
	// which are superset-checked additions, not requirements --
	// decodeReviewStatusV3 already accepts v7/v8/v9 as additive extensions of
	// v6, so the required-schema floor stays unchanged. `review assess` also
	// gained review_due/review_due_reason/next_transition, which is unrelated
	// to this negotiated capabilities surface. The v3.4.0 binary advertised
	// 15 optional features, same as v2.5's binary (floor stays at 14, its
	// established minimum).
	"gentle-ai.review-integration.capabilities/v2.6": Object.freeze({
		protocolMinor: 6,
		requiredSchemas: Object.freeze([...REQUIRED_SCHEMAS_COMMON_V23, "gentle-ai.review-integration.capabilities/v2.6", "gentle-ai.review-integration.consent/v3", "gentle-ai.review-integration.start/v4", "gentle-ai.review-integration.status/v6", "gentle-ai.review-intended-untracked-selection/v1"]),
		requiredMandatoryFeatures: REQUIRED_MANDATORY_FEATURES_V23,
		optionalFeatureFloor: 14,
	}),
});
const OPTIONAL_FEATURE_NAMES = Object.freeze([
	"base_ref_workspace_overlay",
	"bounded_process_waits",
	"classified_authority_repair",
	"exact_gate_receipt_discovery",
	"native_frozen_candidate_context",
	"native_low_risk_verification",
	"native_next_transition",
	"one_shot_final_verification_retry",
	"opaque_repository_context",
	"outcome_bound_verification_evidence",
	"provider_artifact_admission",
	"provider_bound_native_git_context",
	"provider_targeted_validation_request",
	"recovered_correction_evidence",
	"risk_reasons",
	"scope_change_diagnostics",
	"validating_result_reopen",
] as const);
const FEATURE_NAMES = Object.freeze([
	"base_ref_workspace_overlay",
	"bounded_process_waits",
	"classified_authority_repair",
	"compact_v2_authority",
	"exact_gate_receipt_discovery",
	"exact_receipt_replay",
	"five_delivery_gates",
	"immutable_snapshot",
	"legacy_v1_target_scoped_read_only",
	"native_frozen_candidate_context",
	"native_low_risk_verification",
	"native_next_transition",
	"one_shot_final_verification_retry",
	"opaque_repository_context",
	"outcome_bound_verification_evidence",
	"provider_artifact_admission",
	"provider_bound_native_git_context",
	"provider_targeted_validation_request",
	"recovered_correction_evidence",
	"repository_independent_capabilities",
	"restart_safe_projection",
	"risk_reasons",
	"scope_change_diagnostics",
	"sdd_receipt_binding",
	"target_scoped_status",
	"uniform_failure_envelope",
	"validating_result_reopen",
] as const);
const REQUIRED_MANDATORY_FEATURES = Object.freeze(FEATURE_NAMES.filter((name) => !(OPTIONAL_FEATURE_NAMES as readonly string[]).includes(name)));

type StartAction = (typeof START_ACTIONS)[number];
type RiskLevel = (typeof RISK_LEVELS)[number];
type ReviewLens = (typeof REVIEW_LENSES)[number];
type RiskReasonCode = (typeof RISK_REASON_CODES)[number];
type RiskSignal = (typeof RISK_SIGNALS)[number];
type ReviewStatusAction = (typeof STATUS_ACTIONS)[number];

export interface ReviewFeatureV2 {
	name: (typeof FEATURE_NAMES)[number];
	supported: boolean;
	requires: readonly string[];
}

export interface ReviewCapabilitiesV2 {
	contract: typeof REVIEW_INTEGRATION_CONTRACT;
	packageVersion: string;
	buildId: string;
	executableDigest: string;
	operations: ReadonlySet<string>;
	gates: ReadonlySet<string>;
	projections: ReadonlySet<string>;
	schemas: ReadonlySet<string>;
	mandatoryFeatures: ReadonlySet<string>;
	optionalFeatures: ReadonlySet<string>;
	raw: Readonly<Record<string, unknown>>;
}

export interface ReviewRiskReasonV2 {
	code: RiskReasonCode;
	signal?: RiskSignal;
	path?: string;
	oldMode?: string;
	newMode?: string;
}

export interface ChangedPathEntry {
	readonly path: string;
	readonly status: "A" | "D" | "M" | "T";
	readonly oldMode: string;
	readonly newMode: string;
	readonly deleted: boolean;
	readonly typeChanged: boolean;
	readonly modeOnly: boolean;
	readonly intendedUntracked: boolean;
	readonly generated?: true;
}

export interface ReviewArtifactSubjectV2 {
	schema: "gentle-ai.review-artifact-subject/v2";
	subjectHash: string;
	lineageId: string;
	authorityRevision: string;
	targetIdentity: string;
	baseTree: string;
	candidateTree: string;
	changedPathManifestSha256: string;
	lens: ReviewLens;
	selectedOrder: number;
	correctionTargetIdentity?: string;
}

export interface ReviewRepositoryContextV2 {
	capability: "review.opaque_repository_context";
	handle: string;
	revision: string;
	targetIdentity: string;
	// Optional additive members on the same start/v3 identity (gentle-ai main,
	// Go `ReviewRepositoryContextReference` with `omitempty`): the compact
	// effects event this context applied and its recorded outcome. Ground
	// truth is the captured granted start from a 2.4.0-main binary
	// (tests/fixtures/devbinary/start-v3-consent-granted.captured.json); the
	// published start.schema.json is narrower than the emitter here.
	eventId?: string;
	outcome?: ReviewRepositoryContextOutcomeV1;
}

const REPOSITORY_CONTEXT_OUTCOMES = ["applied", "pending", "blocked_conflict", "durability_limited"] as const;
export type ReviewRepositoryContextOutcomeV1 = (typeof REPOSITORY_CONTEXT_OUTCOMES)[number];

export interface ReviewStartV3 {
	contract: typeof REVIEW_INTEGRATION_CONTRACT;
	action: StartAction;
	lensesRequired: boolean;
	lineageId: string;
	state: ReviewStartState;
	riskLevel: RiskLevel;
	selectedLenses: readonly ReviewLens[];
	projection: ReviewProjection;
	changedFiles: number;
	changedLines: number;
	correctionBudget: number;
	riskReasons: readonly ReviewRiskReasonV2[];
	artifactSubjects: readonly ReviewArtifactSubjectV2[];
	targetMode?: "base-workspace-overlay";
	targetIdentity?: string;
	baseTree?: string;
	candidateTree?: string;
	changedPathManifest?: readonly ChangedPathEntry[];
	repositoryContext?: ReviewRepositoryContextV2;
	raw: Readonly<Record<string, unknown>>;
}

export interface ReviewStartV4 extends Omit<ReviewStartV3, "action"> {
	action: "created" | "replayed" | "closed" | "blocked-scope-action";
	nextTransition?: ReviewNextTransitionV3;
}

export interface ReviewProjectionDescriptorV1 {
	schema: "gentle-ai.review-integration.projection/v1";
	kind: ReviewProjectionKind;
	projection: ReviewProjection;
	baseTree: string;
	initialReviewTree: string;
	currentCandidateTree: string;
	pathsDigest: string;
	paths: readonly string[];
	intendedUntracked: readonly string[];
	intendedUntrackedProof: string;
	initialSnapshotIdentity: string;
	currentSnapshotIdentity: string;
}

export interface ReviewStatusAuthorityV1 {
	version: ReviewAuthorityVersion;
	lineageId: string;
	state: string;
	generation: number;
	revision: string;
}

export interface ReviewStatusReceiptV1 {
	status: ReviewReceiptStatus;
	identity?: string;
}

export interface ReviewStatusFrozenV1 {
	tier: RiskLevel;
	originalChangedLines: number;
	correctionBudget: number;
	/** Digest of the frozen changed-path manifest; binds manifest-less capture inputs (gentle-ai#3922). */
	changedPathManifestSha256?: string;
}

export interface ReviewStatusReconciliationV1 {
	required: true;
}

export interface ReviewTransitionArgumentV3 {
	name: string;
	value: string;
	token?: string;
}

export interface ReviewNextTransitionExecuteV3 {
	operation: string;
	arguments: readonly ReviewTransitionArgumentV3[];
	selectorArguments?: readonly ReviewTransitionArgumentV3[];
	preconditions: readonly ReviewTransitionArgumentV3[];
	binding: { targetIdentity: string; lineageId?: string; revision?: string };
	command?: string;
}

// Provider-owned completing form for a host-mediated capture slot
// (gentle-pi#311 P4). The provider issues the exact operation and argument
// tokens that submit the captured bytes; the host substitutes only the
// artifact location into the declared {{value}} slot and never synthesizes
// or filters the form itself.
export interface ReviewCaptureSubmissionValueV1 {
	slot: string;
	domain: string;
	substitutionLocation: number;
	/**
	 * status/v5 only: the artifact schema the substituted value must satisfy.
	 * NEW optional member carried by the singular wire `value` form the live
	 * 2.4.0-main binary emits for the materialize capture-result slot
	 * (captured 2026-08-16 from 2.4.0-main.b1afef46); the legacy `values`
	 * array rows never carry it and existing consumers stay untouched.
	 */
	schema?: string;
	minimum?: number;
	maximum?: number;
}

export interface ReviewCaptureSubmissionV1 {
	operationToken: string;
	argumentTokens: readonly string[];
	values: readonly ReviewCaptureSubmissionValueV1[];
}

// The two non-lens provider role capture operations (gentle-pi#311 P4-roles;
// provider side gentle-ai#3264). An older gentle-ai still renders each one as
// a self-contained authority-advancing vector: binding tokens plus
// `--agent=pi --execute=true`, with NO submission descriptor — executing the
// exact rendered tokens makes Go materialize the role prompt, run its own
// locked-down pi subprocess, and admit the verdict itself.
//
// gentle-ai's v9 contract makes both roles host-mediated exactly like a lens
// materialize slot instead (gentle-pi#311 P3): the collect input carries
// `--materialize=true` (never alongside `--execute`) plus a provider-owned
// `submission` descriptor, and the host completes the frozen prompt
// in-process and submits the result through that exact descriptor. The two
// wire forms are mutually exclusive on one input; see the gating in
// decodeCollectInput below. The known operation set is closed — an unknown
// role capture operation is never executed either way.
export const REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION = {
	CAPTURE_REFUTER: "review.capture-refuter",
	CAPTURE_VALIDATION: "review.capture-validation",
} as const;
export type ReviewProviderRoleCaptureOperation = (typeof REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION)[keyof typeof REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION];
export const REVIEW_PROVIDER_ROLE_CAPTURE_OPERATIONS = Object.freeze(Object.values(REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION));

// status/v5 structural surfaces. Pi has no consumer for these yet; they are
// decoded strictly (exact key sets per the vendored status-v5.schema.json and
// correction-plan-request.schema.json on gentle-ai main) and carried through
// so a v5 provider payload is never rejected for being newer than v3.
export interface ReviewForecastStepV1 {
	step: 1;
	kind: "execute" | "collect" | "stop";
	reasonCode: string;
	description: string;
}

export interface ReviewForecastV1 {
	horizon: "partial" | "terminal";
	steps: readonly ReviewForecastStepV1[];
}

export interface ReviewProviderTaskV1 {
	agent: "review-refuter" | "review-validator";
	role: "refuter" | "targeted-validator";
	prompt: string;
}

export interface ReviewCorrectionPlanFindingV1 {
	id: string;
	lens: "risk" | "resilience" | "readability" | "reliability";
	location: string;
	severity: "BLOCKER" | "CRITICAL";
	claim: string;
	proofRefs: readonly string[];
	evidence: string;
	evidenceClass: "deterministic" | "inferential";
	causalDisposition: "introduced" | "behavior-activated" | "worsened";
}

export interface ReviewCorrectionPlanRequestV1 {
	schema: "gentle-ai.review-correction-plan-request/v1";
	requestHash: string;
	lineageId: string;
	expectedRevision: string;
	targetIdentity: string;
	correctionBudget: number;
	fixFindingIds: readonly string[];
	findings: readonly ReviewCorrectionPlanFindingV1[];
}

export interface ReviewTargetedValidationFindingV1 {
	id: string;
	lens: "risk" | "resilience" | "readability" | "reliability";
	location: string;
	severity: "BLOCKER" | "CRITICAL";
	claim: string;
	proofRefs: readonly string[];
	evidenceClass: "deterministic" | "inferential";
	causalDisposition: "introduced" | "behavior-activated" | "worsened";
}

export interface ReviewTargetedValidationClassificationV1 {
	findingId: string;
	// The provider's FindingEvidence carries severity as an omitempty field, so
	// a classification may or may not name one. Rejecting it made every
	// targeted-validation STATUS that carried one undecodable.
	severity?: string;
	class: "deterministic" | "inferential";
	causalDisposition: "introduced" | "behavior-activated" | "worsened";
	proof: string;
}

export interface ReviewTargetedValidationRequestV1 {
	schema: "gentle-ai.review-targeted-validation-request/v1";
	requestHash: string;
	lineageId: string;
	expectedRevision: string;
	targetIdentity: string;
	fixFindingIds: readonly string[];
	policyContent: string;
	fixFindings: readonly ReviewTargetedValidationFindingV1[];
	fixClassifications: readonly ReviewTargetedValidationClassificationV1[];
	projection: ReviewProjection;
	correctionCandidateTree: string;
	correctionTargetIdentity: string;
	correctionPaths: readonly string[];
	correctionPathsDigest: string;
}

export interface ReviewCollectInputV3 {
	name: string;
	schema: string;
	captureOperation: string;
	arguments: readonly ReviewTransitionArgumentV3[];
	artifactSubject?: ReviewArtifactSubjectV2;
	baseTree?: string;
	candidateTree?: string;
	changedPathManifest?: readonly ChangedPathEntry[];
	submission?: ReviewCaptureSubmissionV1;
	/** status/v5 only: the self-contained external.run_provider_role task. */
	providerTask?: ReviewProviderTaskV1;
	/** status/v5 only: the provider-owned request for a Go-owned targeted validator. */
	validationRequest?: ReviewTargetedValidationRequestV1;
}

// gentle-pi#627: the exact `gentle-ai sync` invocation that resolves a stale
// managed-asset set (STATUS next_transition stop, and START's preflight
// failure envelope both carry this same shape).
export interface ReviewManagedAssetsContinuationV1 {
	operation: "sync";
	command: string;
	agent?: string;
	staleAssets?: readonly string[];
}

// gentle-pi#638: one selected lens slot the host declared unachievable
// through the native capture-unachievable verb, mirrored from Go's
// ReviewUnachievableLensSlot (internal/cli/review_next_transition.go). The
// withdraw form is deliberately narrower than a full execute transition:
// it is the literally runnable retraction command for exactly this slot, so
// a restart that never saw the collect offer can still take the declaration
// back from the stop alone.
export interface ReviewUnachievableLensWithdrawV3 {
	operation: "review.capture-unachievable";
	command: string;
	arguments: readonly ReviewTransitionArgumentV3[];
	binding: { targetIdentity: string; lineageId?: string; revision?: string };
}

export interface ReviewUnachievableLensSlotV3 {
	lens: string;
	selectedOrder: number;
	subjectHash: string;
	reason: string;
	detail?: string;
	withdraw: ReviewUnachievableLensWithdrawV3;
}

export interface ReviewNextTransitionV3 {
	kind: "execute" | "collect" | "stop";
	reasonCode: string;
	execute?: ReviewNextTransitionExecuteV3;
	collect?: { inputs: readonly ReviewCollectInputV3[] };
	/** status/v5 only: the bounded correction plan request. */
	correctionRequest?: ReviewCorrectionPlanRequestV1;
	/** stop only, reason_code managed_assets_outdated: the sync continuation. */
	continuation?: ReviewManagedAssetsContinuationV1;
	/** stop only, reason_code unachievable_lens_slot: one entry per declared slot. */
	unachievableLensSlots?: readonly ReviewUnachievableLensSlotV3[];
}

const ESCALATION_CAUSES = ["unknown_causality", "insufficient_evidence", "missing_refuter_outcome", "targeted_validator_rejected", "correction_budget_exceeded", "unresolved_severe_findings"] as const;
const ESCALATION_REFUTER_OUTCOMES = ["corroborated", "refuted", "inconclusive"] as const;
export interface ReviewEscalationRefuterOutcomeV1 {
	findingId: string;
	outcome: (typeof ESCALATION_REFUTER_OUTCOMES)[number];
	proof: string;
}
export interface ReviewEscalationV1 {
	cause: (typeof ESCALATION_CAUSES)[number];
	findingIds: readonly string[];
	refuterOutcomes?: readonly ReviewEscalationRefuterOutcomeV1[];
}

export interface ReviewStatusV3 {
	/** Optional v7 diagnostic evidence, never routing or reconstructed authority. */
	escalation?: ReviewEscalationV1;
	contract: typeof REVIEW_INTEGRATION_CONTRACT;
	applicability: Exclude<ReviewAuthorityApplicability, "not_evaluated">;
	authority?: ReviewStatusAuthorityV1;
	/** status/v5 compatibility metadata; it is decoded but never used as routing authority. */
	receipt?: ReviewStatusReceiptV1;
	action: ReviewStatusAction;
	actionDisposition?: ReviewStatusActionDisposition;
	replayability: ReviewReplayability;
	frozen?: ReviewStatusFrozenV1;
	reconciliation?: ReviewStatusReconciliationV1;
	targetIdentity: string;
	authorityTargetIdentity?: string;
	projection: ReviewProjectionDescriptorV1;
	repair: AuthorityRepairAssessmentV1;
	candidates: readonly string[];
	nextTransition?: ReviewNextTransitionV3;
	/** status/v5 only: the descriptive, non-routing transition preview. */
	forecast?: ReviewForecastV1;
	/**
	 * status/v5 only: the opaque repository-context reference the live
	 * 2.4.0-main binary publishes once a reviewing lineage has bound one.
	 * NEW struct member — captured 2026-08-16 from 2.4.0-main.b1afef46; the
	 * published status-v5.schema.json omits it (capture is authoritative).
	 */
	repositoryContext?: ReviewRepositoryContextV2;
	/** status/v5 only: the provider-owned request mirrored by the targeted-validator collect input. */
	validationRequest?: ReviewTargetedValidationRequestV1;
	/** status/v7 only: the eligible untracked-path inventory digest, absent on the `staged` projection. */
	eligibleUntrackedInventory?: string;
	raw: Readonly<Record<string, unknown>>;
}

export interface ReviewConsentChoiceV2 {
	answer: "granted" | "declined";
	label: string;
	effect: string;
	invocation: string;
}

export interface ReviewConsentV2 {
	schema: "gentle-ai.review-integration.consent/v2";
	contract: typeof REVIEW_INTEGRATION_CONTRACT;
	operation: "review.start";
	action: "consent_required";
	blocking: true;
	targetIdentity: string;
	projection: ReviewProjection;
	riskLevel: "medium" | "high";
	changedFiles: number;
	changedLines: number;
	headline: string;
	reason: string;
	value: string;
	riskEvidence: readonly string[];
	choices: readonly [ReviewConsentChoiceV2, ReviewConsentChoiceV2];
	offPath: { note: string; command: "gentle-ai review mode disable" };
	raw: Readonly<Record<string, unknown>>;
}

// consent/v3 (gentle-ai >= 2.3.0, capabilities/v2.1+): the same per-candidate
// blocking question with one net-new required member, the provider-fixed
// `agent` runtime binding. Everything shared with v2 keeps its exact shape so
// consumers of either identity read one structural surface.
export const REVIEW_CONSENT_AGENT_V3 = {
	CLAUDE_CODE: "claude-code",
	OPENCODE: "opencode",
	CODEX: "codex",
	PI: "pi",
} as const;
export type ReviewConsentAgentV3 = (typeof REVIEW_CONSENT_AGENT_V3)[keyof typeof REVIEW_CONSENT_AGENT_V3];

export interface ReviewConsentV3 extends Omit<ReviewConsentV2, "schema"> {
	schema: "gentle-ai.review-integration.consent/v3";
	agent: ReviewConsentAgentV3;
}

// Either accepted consent identity. Consumers that relay the envelope (rather
// than decode it) accept both; each decoder still admits exactly one schema.
export type ReviewConsentEnvelope = ReviewConsentV2 | ReviewConsentV3;

const FAILURE_REQUIRED_INPUTS = [
	"lineage_id",
	"change",
	"expected_binding_revision",
	"predecessor_lineage_id",
	"expected_predecessor_revision",
	"successor_lineage_id",
	"disposition",
	"reason",
	"actor",
	"maintainer_authorization",
	"base_ref",
] as const;
export type ReviewFailureRequiredInputV2 = (typeof FAILURE_REQUIRED_INPUTS)[number];
const FAILURE_NEXT_ACTIONS = ["correct_request", "retry", "retry_with_bounded_backoff", "review.status", "review.repair", "explicit-maintainer-action", "stop"] as const;
export type ReviewFailureNextActionV2 = (typeof FAILURE_NEXT_ACTIONS)[number];
// Known cause_category values: the vendored failure.schema.json enum plus
// "incomplete_store_entry", which the v2.1.8 emitter produces beyond that enum.
// cause_category is diagnostic metadata (nothing routes on it), so unknown
// snake_case values are tolerated for forward compatibility.
const FAILURE_CAUSE_CATEGORIES = ["inventory_io_or_layout", "lock_ambiguous", "reset_residue", "record_or_graph_invalid", "inventory_incomplete", "incomplete_store_entry"] as const;
export type ReviewFailureCauseCategoryV2 = (typeof FAILURE_CAUSE_CATEGORIES)[number] | (string & {});

export interface ReviewFailureTargetEvidenceV1 {
	candidateTree: string;
	pathsDigest: string;
}

export interface ReviewFailureScopeChangeV1 {
	expected: ReviewFailureTargetEvidenceV1;
	actual: ReviewFailureTargetEvidenceV1;
	differingPathCount: number;
	differingPathsDigest: string;
	predecessorLineageId: string;
	predecessorRevision: string;
	recoveryOperation: "review.recover";
	recoveryRequiredInputs: readonly string[];
}

export interface ReviewFailureBindingRevisionV1 {
	expected: string;
	current: string;
}

export interface ReviewFailureContextV2 {
	scopeChange?: ReviewFailureScopeChangeV1;
	bindingRevision?: ReviewFailureBindingRevisionV1;
}

export type ReviewFailureOperation = ReviewIntegrationOperation | "review.capture-result" | "review.capture-correction-plan" | "review.capture-refuter" | "review.capture-validation";

export interface ReviewFailureV2 {
	schema: "gentle-ai.review-integration.failure/v2";
	contract: typeof REVIEW_INTEGRATION_CONTRACT;
	operation: ReviewFailureOperation;
	phase: "preflight" | "pre_native" | "native_running" | "native_committed" | "reconciliation";
	code: string;
	message: string;
	mutationOutcome: ReviewMutationOutcome;
	authorityApplicability: ReviewAuthorityApplicability;
	retrySafe: boolean;
	replayability: ReviewReplayability;
	lineageId?: string;
	requestDigest?: string;
	progressIdentity?: string;
	requiredInputs: readonly ReviewFailureRequiredInputV2[];
	nextAction: ReviewFailureNextActionV2;
	causeCategory?: ReviewFailureCauseCategoryV2;
	cause?: string;
	context?: ReviewFailureContextV2;
	/** code=managed_assets_outdated only: the sync continuation (gentle-pi#627). */
	continuation?: ReviewManagedAssetsContinuationV1;
	raw: Readonly<Record<string, unknown>>;
}

export const REVIEW_ADVISORY_FINDING_SEVERITY = {
	BLOCKER: "BLOCKER",
	CRITICAL: "CRITICAL",
	WARNING: "WARNING",
	SUGGESTION: "SUGGESTION",
} as const;
export type ReviewAdvisoryFindingSeverity = (typeof REVIEW_ADVISORY_FINDING_SEVERITY)[keyof typeof REVIEW_ADVISORY_FINDING_SEVERITY];

export const REVIEW_ADVISORY_FINDING_DISPOSITION = {
	INFORMATIONAL: "informational",
	FOLLOW_UP: "follow_up",
	REFUTED: "refuted",
} as const;
export type ReviewAdvisoryFindingDisposition = (typeof REVIEW_ADVISORY_FINDING_DISPOSITION)[keyof typeof REVIEW_ADVISORY_FINDING_DISPOSITION];

export interface ReviewAdvisoryFindingV1 {
	id: string;
	lens?: string;
	location?: string;
	severity: ReviewAdvisoryFindingSeverity;
	disposition: ReviewAdvisoryFindingDisposition;
}

export interface ReviewAdvisoryFindingsV1 {
	statement: string;
	findings: readonly ReviewAdvisoryFindingV1[];
}

export interface AuthorityRepairAssessmentCandidateV1 {
	lineageId: string;
	revision: string;
	chainIdentity: string;
	eventCount: number;
	aliasEventCount: number;
	operations: readonly ("review/complete-fix" | "review/validate-fix")[];
}

export interface AuthorityRepairAssessmentCountsV1 {
	lineages: number;
	compactLineages: number;
	legacyLineages: number;
	events: number;
	bytes: number;
	eligibleCandidates: number;
	unsupportedLineages: number;
	conflicts: number;
}

export interface AuthorityRepairAssessmentV1 {
	schema: "gentle-ai.review-authority-repair-assessment/v1";
	status: "eligible" | "unsupported" | "ambiguous" | "conflicting" | "truncated";
	class?: "legacy_v1_historical_alias";
	cause?: "unsupported_historical_v1_operation_alias";
	disposition?: "quarantine-approved-historical-alias";
	repositoryBinding?: string;
	candidate?: AuthorityRepairAssessmentCandidateV1;
	counts: AuthorityRepairAssessmentCountsV1;
	supportedOperations: readonly ["review/complete-fix", "review/validate-fix"];
	authorizationSchema: "gentle-ai.review-repair-authorization/v1";
}

export interface ReviewRepairProviderInputsV2 {
	class: "legacy_v1_historical_alias";
	lineageId: string;
	expectedRevision: string;
	cause: "unsupported_historical_v1_operation_alias";
	disposition: "quarantine-approved-historical-alias";
	repositoryBinding: string;
	authorizationSchema: "gentle-ai.review-repair-authorization/v1";
}

export interface ReviewRepairExecutionV2 {
	status: "committed";
	class: "legacy_v1_historical_alias";
	lineageId: string;
	revision: string;
	chainIdentity: string;
	cause: "unsupported_historical_v1_operation_alias";
	disposition: "quarantine-approved-historical-alias";
	assessmentDigest: string;
	requestDigest: string;
	recordIdentity: string;
}

export interface ReviewRepairV2 {
	schema: "gentle-ai.review-integration.repair/v2";
	contract: typeof REVIEW_INTEGRATION_CONTRACT;
	operation: "review.repair";
	mode: "preflight" | "execute";
	assessment: AuthorityRepairAssessmentV1;
	providerInputs?: ReviewRepairProviderInputsV2;
	requiredInputs: readonly ("actor" | "reason" | "maintainer_authorization")[];
	execution?: ReviewRepairExecutionV2;
	raw: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Primitives — ported verbatim from lib/review-integration-v1.ts. exactRecord's
// exact-key discipline (allowAdditional = false by default) is the single
// highest-risk thing to port faithfully: losing it means Pi silently accepts
// malformed v2 payloads.
// ---------------------------------------------------------------------------

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactRecord(value: unknown, label: string, required: readonly string[], optional: readonly string[] = [], allowAdditional = false): Record<string, unknown> {
	const body = record(value, label);
	for (const key of required) {
		if (!Object.hasOwn(body, key)) throw new TypeError(`${label}.${key} is required`);
	}
	const allowed = new Set([...required, ...optional]);
	if (!allowAdditional) for (const key of Object.keys(body)) if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not allowed`);
	return body;
}

function text(value: unknown, label: string, options: { minimum?: number; maximum?: number; pattern?: RegExp } = {}): string {
	const minimum = options.minimum ?? 0;
	if (typeof value !== "string" || value.length < minimum || (options.maximum !== undefined && value.length > options.maximum) || (options.pattern !== undefined && !options.pattern.test(value))) {
		throw new TypeError(`${label} is invalid`);
	}
	return value;
}

function nonempty(value: unknown, label: string): string {
	return text(value, label, { minimum: 1 });
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
	return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum?: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
		throw new TypeError(`${label} must be an integer in range`);
	}
	return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${label} is unsupported`);
	return value as T;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const body = value as Record<string, unknown>;
		return `{${Object.keys(body).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(body[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function array<T>(value: unknown, label: string, decodeItem: (entry: unknown, label: string) => T, options: { minimum?: number; maximum?: number; unique?: boolean } = {}): readonly T[] {
	if (!Array.isArray(value) || value.length < (options.minimum ?? 0) || (options.maximum !== undefined && value.length > options.maximum)) {
		throw new TypeError(`${label} has an invalid length`);
	}
	const decoded = value.map((entry, index) => decodeItem(entry, `${label}[${index}]`));
	if (options.unique && new Set(decoded.map(canonicalJson)).size !== decoded.length) throw new TypeError(`${label} must not contain duplicates`);
	return decoded;
}

function stringArray(value: unknown, label: string, options: { minimum?: number; maximum?: number; unique?: boolean; pattern?: RegExp } = {}): readonly string[] {
	return array(value, label, (entry, itemLabel) => text(entry, itemLabel, { minimum: 1, pattern: options.pattern }), options);
}

function enumArray<T extends string>(value: unknown, values: readonly T[], label: string, options: { minimum?: number; maximum?: number; unique?: boolean } = {}): readonly T[] {
	return array(value, label, (entry, itemLabel) => enumeration(entry, values, itemLabel), options);
}

function sha256(value: unknown, label: string): string {
	return text(value, label, { pattern: /^sha256:[0-9a-f]{64}$/ });
}

function gitTree(value: unknown, label: string): string {
	return text(value, label, { pattern: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/ });
}

function lineage(value: unknown, label: string): string {
	return text(value, label, { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ });
}

function safePath(value: unknown, label: string): string {
	return text(value, label, { minimum: 1, pattern: /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/ });
}

// v2 constant identity: every v2 payload pins one `const` schema, so unlike
// v1's requireVersionedIdentity there is no minor-driven revision to resolve.
function requireIdentity(value: Record<string, unknown>, schema: string, operation?: string): void {
	if (value.schema !== schema) throw new TypeError(`schema must be ${schema}`);
	if (value.contract !== REVIEW_INTEGRATION_CONTRACT) throw new TypeError(`contract must be ${REVIEW_INTEGRATION_CONTRACT}`);
	if (operation !== undefined && value.operation !== operation) throw new TypeError(`operation must be ${operation}`);
}

function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
	if (actual.length !== expected.length || expected.some((value) => !actual.includes(value))) throw new TypeError(`${label} does not match the required integration surface`);
}

// An advertised surface is a superset promise, not an exact manifest — see
// lib/review-integration-v1.ts's identical comment for the v2.2.0 lesson this
// codifies: demanding an exact match rejects a compatible provider release.
function assertSupersetOf(actual: readonly string[], required: readonly string[], label: string): void {
	const advertised = new Set(actual);
	const missing = required.filter((value) => !advertised.has(value));
	if (missing.length > 0) throw new TypeError(`${label} omits the required integration surface: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Capabilities/v2
// ---------------------------------------------------------------------------

function decodeFeature(value: unknown, label: string): ReviewFeatureV2 {
	const feature = exactRecord(value, label, ["name", "supported", "requires"]);
	return {
		name: enumeration(feature.name, FEATURE_NAMES, `${label}.name`),
		supported: boolean(feature.supported, `${label}.supported`),
		requires: stringArray(feature.requires, `${label}.requires`, { unique: true }),
	};
}

function decodeOptionalFeature(value: unknown, label: string): { name: string; supported: boolean; requires: readonly string[] } {
	const feature = exactRecord(value, label, ["name", "supported", "requires"]);
	return {
		name: nonempty(feature.name, `${label}.name`),
		supported: boolean(feature.supported, `${label}.supported`),
		requires: stringArray(feature.requires, `${label}.requires`, { unique: true }),
	};
}

export function decodeReviewCapabilitiesV2(value: unknown, verifiedExecutableDigest: string): ReviewCapabilitiesV2 {
	const requiredFields = ["schema", "contract", "protocol", "package", "build", "executable", "operations", "gates", "projections", "schemas", "features", "compatibility"] as const;
	const body = exactRecord(value, "capabilities", requiredFields, ["bootstrap"]);
	// Additive minor acceptance: each accepted schema identity keeps its own
	// exact protocol minor and required-schema floor; v2 stays exactly as it
	// was, and an unknown identity is rejected before anything else.
	const identity = CAPABILITIES_SCHEMA_IDENTITIES[typeof body.schema === "string" ? body.schema : ""];
	if (identity === undefined) throw new TypeError(`schema must be one of ${Object.keys(CAPABILITIES_SCHEMA_IDENTITIES).join(", ")}`);
	requireIdentity(body, body.schema as string);

	const protocol = exactRecord(body.protocol, "capabilities.protocol", ["major", "minor"]);
	if (protocol.major !== 2 || protocol.minor !== identity.protocolMinor) throw new TypeError("incompatible review integration protocol");

	const packageIdentity = exactRecord(body.package, "capabilities.package", ["name", "version", "release_channel"]);
	if (packageIdentity.name !== "gentle-ai") throw new TypeError("capabilities package identity mismatch");
	const packageVersion = nonempty(packageIdentity.version, "capabilities.package.version");
	enumeration(packageIdentity.release_channel, ["development", "prerelease", "stable"] as const, "capabilities.package.release_channel");

	const build = exactRecord(body.build, "capabilities.build", ["id", "go_version", "module_version", "vcs", "vcs_revision", "vcs_time", "vcs_modified"]);
	const buildId = sha256(build.id, "capabilities.build.id");
	nonempty(build.go_version, "capabilities.build.go_version");
	for (const field of ["module_version", "vcs", "vcs_revision", "vcs_time"] as const) text(build[field], `capabilities.build.${field}`);
	enumeration(build.vcs_modified, ["true", "false", "unknown"] as const, "capabilities.build.vcs_modified");

	const executable = exactRecord(body.executable, "capabilities.executable", ["sha256", "evidence", "verification"]);
	const selfReportedDigest = sha256(executable.sha256, "capabilities.executable.sha256");
	if (executable.evidence !== "self-reported" || executable.verification !== "compare-with-published-manifest") throw new TypeError("capabilities executable evidence is incompatible");
	const normalizedVerifiedDigest = sha256(verifiedExecutableDigest.startsWith("sha256:") ? verifiedExecutableDigest : `sha256:${verifiedExecutableDigest}`, "verified executable digest");
	if (selfReportedDigest !== normalizedVerifiedDigest) throw new TypeError("review provider executable digest mismatch");

	const advertisedOperations = stringArray(body.operations, "capabilities.operations", { minimum: REQUIRED_OPERATIONS.length, unique: true });
	// Gates and projections are, like operations and schemas, a superset promise
	// rather than an exact manifest: a compatible provider release may advertise
	// an additional gate or projection name beyond the required floor. Decode as
	// a plain string array (not `enumArray` against the known enum) so an
	// unknown addition is not rejected before assertSupersetOf can even run.
	const advertisedGates = stringArray(body.gates, "capabilities.gates", { minimum: REQUIRED_GATES.length, unique: true });
	const advertisedProjections = stringArray(body.projections, "capabilities.projections", { minimum: REQUIRED_PROJECTIONS.length, unique: true });
	const advertisedSchemas = stringArray(body.schemas, "capabilities.schemas", { minimum: identity.requiredSchemas.length, unique: true });
	assertSupersetOf(advertisedOperations, REQUIRED_OPERATIONS, "capabilities operations");
	assertSupersetOf(advertisedGates, REQUIRED_GATES, "capabilities gates");
	assertSupersetOf(advertisedProjections, REQUIRED_PROJECTIONS, "capabilities projections");
	assertSupersetOf(advertisedSchemas, identity.requiredSchemas, "capabilities schemas");

	const features = exactRecord(body.features, "capabilities.features", ["mandatory", "optional"]);
	const requiredMandatoryFeatures = identity.requiredMandatoryFeatures ?? REQUIRED_MANDATORY_FEATURES;
	const mandatory = array(features.mandatory, "capabilities.features.mandatory", (entry, label) => decodeFeature(entry, label), { minimum: requiredMandatoryFeatures.length });
	const optional = array(features.optional, "capabilities.features.optional", (entry, label) => decodeOptionalFeature(entry, label), { minimum: identity.optionalFeatureFloor ?? 17, unique: true });
	const mandatoryNames = mandatory.map((feature) => feature.name);
	const optionalNames = optional.map((feature) => feature.name);
	assertExactSet(mandatoryNames, requiredMandatoryFeatures, "mandatory capabilities");
	if (new Set(optionalNames).size !== optionalNames.length) throw new TypeError("optional capabilities contain duplicate names");
	if (optionalNames.some((name) => mandatoryNames.includes(name as ReviewFeatureV2["name"]))) throw new TypeError("mandatory and optional capabilities overlap");
	if (mandatory.some((feature) => !feature.supported)) throw new TypeError("mandatory capability is unsupported");

	const compatibility = exactRecord(body.compatibility, "capabilities.compatibility", ["minimum_protocol_major", "maximum_protocol_major", "additive_minor_policy", "unknown_mandatory", "unknown_optional", "modes", "legacy_window"]);
	if (compatibility.minimum_protocol_major !== 2 || compatibility.maximum_protocol_major !== 2 || compatibility.additive_minor_policy !== "optional-fields-only" || compatibility.unknown_mandatory !== "reject" || compatibility.unknown_optional !== "ignore") {
		throw new TypeError("incompatible capability evolution policy");
	}
	const modes = enumArray(compatibility.modes, Object.values(REVIEW_AUTHORITY_VERSION), "capabilities.compatibility.modes", { minimum: 2, maximum: 2 });
	if (modes[0] !== REVIEW_AUTHORITY_VERSION.COMPACT_V2 || modes[1] !== REVIEW_AUTHORITY_VERSION.LEGACY_V1) throw new TypeError("capabilities compatibility modes are out of order");
	const legacyWindow = exactRecord(compatibility.legacy_window, "capabilities.compatibility.legacy_window", ["mode", "state", "read_only", "deprecation_started", "removal", "minimum_compatibility_releases"]);
	if (legacyWindow.mode !== REVIEW_AUTHORITY_VERSION.LEGACY_V1) throw new TypeError("capabilities legacy window mode is incompatible");
	enumeration(legacyWindow.state, ["pre-fence", "active", "deprecated", "expired"] as const, "capabilities.compatibility.legacy_window.state");
	boolean(legacyWindow.read_only, "capabilities.compatibility.legacy_window.read_only");
	boolean(legacyWindow.deprecation_started, "capabilities.compatibility.legacy_window.deprecation_started");
	nonempty(legacyWindow.removal, "capabilities.compatibility.legacy_window.removal");
	integer(legacyWindow.minimum_compatibility_releases, "capabilities.compatibility.legacy_window.minimum_compatibility_releases", 1);

	if (body.bootstrap !== undefined) {
		const bootstrap = exactRecord(body.bootstrap, "capabilities.bootstrap", ["command", "target_selector_variants", "required_feature", "unsupported_outcome", "parent_only"]);
		if (bootstrap.command !== "gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --next-transition") throw new TypeError("capabilities.bootstrap.command is unsupported");
		array(bootstrap.target_selector_variants, "capabilities.bootstrap.target_selector_variants", (entry, label) => {
			const selector = exactRecord(entry, label, ["target_type", "arguments"]);
			enumeration(selector.target_type, ["staged", "base_ref", "workspace_overlay_base_ref", "workspace_overlay_base_tree"] as const, `${label}.target_type`);
			stringArray(selector.arguments, `${label}.arguments`, { minimum: 2 });
			return selector;
		}, { minimum: 4, maximum: 4 });
		if (bootstrap.required_feature !== "native_next_transition") throw new TypeError("capabilities.bootstrap.required_feature is unsupported");
		if (bootstrap.unsupported_outcome !== "unsupported-capability") throw new TypeError("capabilities.bootstrap.unsupported_outcome is unsupported");
		if (bootstrap.parent_only !== true) throw new TypeError("capabilities.bootstrap.parent_only must be true");
	}

	return {
		contract: REVIEW_INTEGRATION_CONTRACT,
		packageVersion,
		buildId,
		executableDigest: selfReportedDigest,
		operations: new Set(REQUIRED_OPERATIONS),
		gates: new Set(REQUIRED_GATES),
		projections: new Set(REQUIRED_PROJECTIONS),
		schemas: new Set(identity.requiredSchemas),
		mandatoryFeatures: new Set(mandatoryNames),
		optionalFeatures: new Set(optional.filter((feature) => feature.supported && (FEATURE_NAMES as readonly string[]).includes(feature.name)).map((feature) => feature.name)),
		raw: body,
	};
}

// ---------------------------------------------------------------------------
// artifact-subject/v2
// ---------------------------------------------------------------------------

function decodeArtifactSubject(value: unknown, label: string): ReviewArtifactSubjectV2 {
	const body = exactRecord(value, label, ["schema", "subject_hash", "lineage_id", "authority_revision", "target_identity", "base_tree", "candidate_tree", "changed_path_manifest_sha256", "lens", "selected_order"], ["correction_target_identity"]);
	if (body.schema !== "gentle-ai.review-artifact-subject/v2") throw new TypeError(`${label}.schema must be gentle-ai.review-artifact-subject/v2`);
	return {
		schema: "gentle-ai.review-artifact-subject/v2",
		subjectHash: sha256(body.subject_hash, `${label}.subject_hash`),
		lineageId: lineage(body.lineage_id, `${label}.lineage_id`),
		authorityRevision: sha256(body.authority_revision, `${label}.authority_revision`),
		targetIdentity: sha256(body.target_identity, `${label}.target_identity`),
		baseTree: gitTree(body.base_tree, `${label}.base_tree`),
		candidateTree: gitTree(body.candidate_tree, `${label}.candidate_tree`),
		changedPathManifestSha256: sha256(body.changed_path_manifest_sha256, `${label}.changed_path_manifest_sha256`),
		lens: enumeration(body.lens, REVIEW_LENSES, `${label}.lens`),
		selectedOrder: integer(body.selected_order, `${label}.selected_order`, 0, 3),
		...(body.correction_target_identity === undefined ? {} : { correctionTargetIdentity: sha256(body.correction_target_identity, `${label}.correction_target_identity`) }),
	};
}

export function decodeReviewArtifactSubjectV2(value: unknown): ReviewArtifactSubjectV2 {
	return decodeArtifactSubject(value, "artifact_subject");
}

function decodeChangedPathEntry(value: unknown, label: string): ChangedPathEntry {
	const body = exactRecord(value, label, ["path", "status", "old_mode", "new_mode", "deleted", "type_changed", "mode_only", "intended_untracked"], ["generated"]);
	if (body.generated !== undefined && body.generated !== true) throw new TypeError(`${label}.generated must be true when present`);
	return {
		path: nonempty(body.path, `${label}.path`),
		status: enumeration(body.status, ["A", "D", "M", "T"] as const, `${label}.status`),
		oldMode: text(body.old_mode, `${label}.old_mode`, { pattern: /^[0-7]{6}$/ }),
		newMode: text(body.new_mode, `${label}.new_mode`, { pattern: /^[0-7]{6}$/ }),
		deleted: boolean(body.deleted, `${label}.deleted`),
		typeChanged: boolean(body.type_changed, `${label}.type_changed`),
		modeOnly: boolean(body.mode_only, `${label}.mode_only`),
		intendedUntracked: boolean(body.intended_untracked, `${label}.intended_untracked`),
		...(body.generated === undefined ? {} : { generated: true }),
	};
}

// ---------------------------------------------------------------------------
// start/v3
// ---------------------------------------------------------------------------

export function decodeReviewStartV3(value: unknown, overlayIdentitySatisfiesRepositoryContext = false): ReviewStartV3 {
	const overlayFields = ["target_mode", "target_identity", "base_tree", "candidate_tree"] as const;
	const body = exactRecord(value, "start", [
		"schema", "contract", "operation", "action", "lenses_required", "lineage_id", "state", "risk_level",
		"selected_lenses", "projection", "changed_files", "changed_lines", "correction_budget", "risk_reasons", "artifact_subjects",
	], [...overlayFields, "changed_path_manifest", "repository_context", "acknowledgement"]);
	requireIdentity(body, "gentle-ai.review-integration.start/v3", REVIEW_INTEGRATION_OPERATION.START);

	// dependentRequired binds base_tree<->candidate_tree bidirectionally, and
	// separately binds target_mode<->target_identity bidirectionally with both
	// requiring base_tree+candidate_tree. The two pairs are independent: a
	// selected_lenses START can carry base_tree/candidate_tree without ever
	// carrying target_mode/target_identity.
	if ((body.base_tree === undefined) !== (body.candidate_tree === undefined)) throw new TypeError("start.base_tree and start.candidate_tree must appear together");
	const baseTree = body.base_tree === undefined ? undefined : gitTree(body.base_tree, "start.base_tree");
	const candidateTree = body.candidate_tree === undefined ? undefined : gitTree(body.candidate_tree, "start.candidate_tree");

	if ((body.target_mode === undefined) !== (body.target_identity === undefined)) throw new TypeError("start.target_mode and start.target_identity must appear together");
	if (body.target_mode !== undefined && (baseTree === undefined || candidateTree === undefined)) throw new TypeError("start.target_mode and start.target_identity require base_tree and candidate_tree");
	const targetMode = body.target_mode === undefined ? undefined : enumeration(body.target_mode, ["base-workspace-overlay"] as const, "start.target_mode");
	const targetIdentity = body.target_identity === undefined ? undefined : sha256(body.target_identity, "start.target_identity");

	if (body.changed_path_manifest !== undefined && (baseTree === undefined || candidateTree === undefined)) {
		throw new TypeError("start.changed_path_manifest requires base_tree and candidate_tree");
	}

	const action = enumeration(body.action, START_ACTIONS, "start.action");
	const state = enumeration(body.state, Object.values(REVIEW_START_STATE), "start.state");
	const selectedLenses = enumArray(body.selected_lenses, REVIEW_LENSES, "start.selected_lenses", { maximum: 4, unique: true });

	if (selectedLenses.length >= 1 && (body.base_tree === undefined || body.candidate_tree === undefined || body.changed_path_manifest === undefined)) {
		throw new TypeError("start with selected_lenses requires base_tree, candidate_tree, and changed_path_manifest");
	}

	const reviewingCreatedOrResumed = (action === "created" || action === "resumed") && state === REVIEW_START_STATE.REVIEWING;
	// START/v4 may render the frozen target as the overlay identity instead of
	// repository_context; absence is only excused when that identity is present.
	const requiresRepositoryContext = reviewingCreatedOrResumed && !(overlayIdentitySatisfiesRepositoryContext && targetIdentity !== undefined);
	if (requiresRepositoryContext && body.repository_context === undefined) throw new TypeError("start.repository_context is required when action is created/resumed and state is reviewing");
	if (!reviewingCreatedOrResumed && body.repository_context !== undefined) throw new TypeError("start.repository_context is only valid when action is created/resumed and state is reviewing");

	let repositoryContext: ReviewRepositoryContextV2 | undefined;
	if (body.repository_context !== undefined) {
		const source = exactRecord(body.repository_context, "start.repository_context", ["capability", "handle", "revision", "target_identity"], ["event_id", "outcome"]);
		if (source.capability !== "review.opaque_repository_context") throw new TypeError("start.repository_context.capability is unsupported");
		repositoryContext = {
			capability: "review.opaque_repository_context",
			handle: text(source.handle, "start.repository_context.handle", { pattern: /^rctx[12]_[0-9a-f]{64}$/ }),
			revision: sha256(source.revision, "start.repository_context.revision"),
			targetIdentity: sha256(source.target_identity, "start.repository_context.target_identity"),
			...(source.event_id === undefined ? {} : { eventId: sha256(source.event_id, "start.repository_context.event_id") }),
			...(source.outcome === undefined ? {} : { outcome: enumeration(source.outcome, REPOSITORY_CONTEXT_OUTCOMES, "start.repository_context.outcome") }),
		};
	}

	const riskReasons = array(body.risk_reasons, "start.risk_reasons", (entry, label): ReviewRiskReasonV2 => {
		const reason = exactRecord(entry, label, ["code"], ["signal", "path", "old_mode", "new_mode"]);
		return {
			code: enumeration(reason.code, RISK_REASON_CODES, `${label}.code`),
			...(reason.signal === undefined ? {} : { signal: enumeration(reason.signal, RISK_SIGNALS, `${label}.signal`) }),
			...(reason.path === undefined ? {} : { path: nonempty(reason.path, `${label}.path`) }),
			...(reason.old_mode === undefined ? {} : { oldMode: text(reason.old_mode, `${label}.old_mode`, { pattern: /^[0-7]{6}$/ }) }),
			...(reason.new_mode === undefined ? {} : { newMode: text(reason.new_mode, `${label}.new_mode`, { pattern: /^[0-7]{6}$/ }) }),
		};
	}, { minimum: 1, unique: true });

	const artifactSubjects = array(body.artifact_subjects, "start.artifact_subjects", (entry, label) => decodeArtifactSubject(entry, label), { maximum: 4 });

	return {
		contract: REVIEW_INTEGRATION_CONTRACT,
		action,
		lensesRequired: boolean(body.lenses_required, "start.lenses_required"),
		lineageId: nonempty(body.lineage_id, "start.lineage_id"),
		state,
		riskLevel: enumeration(body.risk_level, RISK_LEVELS, "start.risk_level"),
		selectedLenses,
		projection: enumeration(body.projection, REQUIRED_PROJECTIONS, "start.projection"),
		changedFiles: integer(body.changed_files, "start.changed_files"),
		changedLines: integer(body.changed_lines, "start.changed_lines"),
		correctionBudget: integer(body.correction_budget, "start.correction_budget", 0, 200),
		riskReasons,
		artifactSubjects,
		...(targetMode === undefined ? {} : { targetMode }),
		...(targetIdentity === undefined ? {} : { targetIdentity }),
		...(baseTree === undefined ? {} : { baseTree }),
		...(candidateTree === undefined ? {} : { candidateTree }),
		...(body.changed_path_manifest === undefined ? {} : { changedPathManifest: array(body.changed_path_manifest, "start.changed_path_manifest", decodeChangedPathEntry, { unique: true }) }),
		...(repositoryContext === undefined ? {} : { repositoryContext }),
		raw: body,
	};
}

function assertReviewStartV4StatusBinding(execute: ReviewNextTransitionExecuteV3, start: ReviewStartV3): void {
	const expectedTargetIdentity = start.repositoryContext?.targetIdentity ?? start.targetIdentity;
	const targetIdentityConflicts = expectedTargetIdentity === undefined || execute.binding.targetIdentity !== expectedTargetIdentity
		|| (start.targetIdentity !== undefined && start.targetIdentity !== expectedTargetIdentity)
		|| start.artifactSubjects.some((subject) => subject.targetIdentity !== expectedTargetIdentity);
	if (targetIdentityConflicts) throw new TypeError("START/v4 status target identity binding conflicts with frozen START");
	if (execute.binding.lineageId !== undefined && execute.binding.lineageId !== start.lineageId) {
		throw new TypeError("START/v4 status lineage binding conflicts with frozen START");
	}
	const optionalSelectors: Readonly<Record<string, string | undefined>> = {
		"base-ref": start.baseTree,
		"base-tree": start.baseTree,
		projection: start.projection,
		target: expectedTargetIdentity,
	};
	const argumentsByName = new Map<string, string>();
	for (const argument of execute.arguments) {
		if (argumentsByName.has(argument.name)) throw new TypeError(`START/v4 status arguments duplicate ${argument.name} binding`);
		argumentsByName.set(argument.name, argument.value);
		if (Object.hasOwn(optionalSelectors, argument.name) && argument.value !== optionalSelectors[argument.name]) throw new TypeError(`START/v4 status ${argument.name} binding conflicts with frozen START`);
	}
	if (argumentsByName.get("lineage") !== start.lineageId) throw new TypeError("START/v4 status requires exactly one lineage binding for the frozen START");
	if (execute.arguments.find((argument) => argument.name === "lineage")?.token !== `--lineage=${start.lineageId}`) throw new TypeError("START/v4 status lineage binding conflicts with frozen START");
	for (const [name, value] of [["contract", REVIEW_INTEGRATION_CONTRACT], ["next-transition", "true"], ["agent", "pi"]]) {
		if (argumentsByName.get(name) !== value || execute.arguments.find((argument) => argument.name === name)?.token !== `--${name}=${value}`) throw new TypeError(`START/v4 status ${name} binding conflicts with frozen START`);
	}
	const selectorArguments = execute.selectorArguments;
	if (selectorArguments === undefined || selectorArguments.length === 0) throw new TypeError("START/v4 status selector arguments are required");
	const selectorsByName = new Map<string, ReviewTransitionArgumentV3>();
	for (const selector of selectorArguments) {
		const full = execute.arguments.find((argument) => argument.name === selector.name);
		if (selectorsByName.has(selector.name) || full === undefined || full.value !== selector.value || full.token !== selector.token) throw new TypeError(`START/v4 status selector ${selector.name} binding conflicts with full arguments`);
		selectorsByName.set(selector.name, selector);
	}
	const selector = (name: string, value: string): void => {
		if (selectorsByName.get(name)?.value !== value || selectorsByName.get(name)?.token !== `--${name}=${value}` || execute.arguments.find((argument) => argument.name === name)?.token !== `--${name}=${value}`) throw new TypeError(`START/v4 status selector ${name} binding conflicts with frozen START`);
	};
	const baseRef = argumentsByName.get("base-ref");
	if (start.targetMode === "base-workspace-overlay") {
		if (baseRef !== start.baseTree || argumentsByName.has("committed-only")) throw new TypeError("START/v4 status workspace overlay binding conflicts with frozen START");
		selector("base-ref", start.baseTree!); selector("workspace-overlay", "true");
	} else if (baseRef !== undefined) {
		if (baseRef !== start.baseTree || argumentsByName.has("workspace-overlay")) throw new TypeError("START/v4 status committed range binding conflicts with frozen START");
		selector("base-ref", start.baseTree!); selector("committed-only", "true");
	} else {
		if (argumentsByName.has("committed-only") || argumentsByName.has("workspace-overlay")) throw new TypeError("START/v4 status current projection binding conflicts with frozen START");
		selector("projection", start.projection);
	}
}

export function decodeReviewStartV4(value: unknown): ReviewStartV4 {
	const overlayFields = ["target_mode", "target_identity", "base_tree", "candidate_tree"] as const;
	const body = exactRecord(value, "start", [
		"schema", "contract", "operation", "action", "lenses_required", "lineage_id", "state", "risk_level",
		"selected_lenses", "projection", "changed_files", "changed_lines", "correction_budget", "risk_reasons", "artifact_subjects",
	], [...overlayFields, "changed_path_manifest", "repository_context", "acknowledgement", "next_transition"]);
	requireIdentity(body, "gentle-ai.review-integration.start/v4", REVIEW_INTEGRATION_OPERATION.START);
	const action = enumeration(body.action, ["created", "replayed", "closed", "blocked-scope-action"] as const, "start.action");
	const v3Action = action === "replayed" ? "resumed" : action;
	const nextTransition = body.next_transition === undefined ? undefined : decodeReviewNextTransitionV3(body.next_transition);
	const reviewing = (action === "created" || action === "replayed") && body.state === REVIEW_START_STATE.REVIEWING;
	if (reviewing && nextTransition?.kind !== "execute") throw new TypeError("reviewing created/replayed START requires next_transition.execute");
	if (reviewing && nextTransition.execute?.operation !== "review.status") throw new TypeError("reviewing created/replayed START next_transition.execute.operation must be review.status");
	const closedApprovedZeroLens = action === "closed" && body.state === REVIEW_START_STATE.APPROVED && Array.isArray(body.selected_lenses) && body.selected_lenses.length === 0;
	if (closedApprovedZeroLens && nextTransition !== undefined) throw new TypeError("closed approved zero-lens START cannot carry next_transition");
	const v3Body = { ...body };
	delete v3Body.next_transition;
	const decoded = decodeReviewStartV3({ ...v3Body, schema: "gentle-ai.review-integration.start/v3", action: v3Action }, true);
	if (reviewing) assertReviewStartV4StatusBinding(nextTransition!.execute!, decoded);
	return { ...decoded, action, ...(nextTransition === undefined ? {} : { nextTransition }), raw: body };
}

// ---------------------------------------------------------------------------
// projection/v1 — reused verbatim; the v2 capabilities schema still advertises
// gentle-ai.review-integration.projection/v1, so renaming this decoder would
// be the same kind of lie the module rename is meant to remove.
// ---------------------------------------------------------------------------

export function decodeReviewProjectionV1(value: unknown): ReviewProjectionDescriptorV1 {
	const projection = exactRecord(value, "status.projection", ["schema", "kind", "projection", "base_tree", "initial_review_tree", "current_candidate_tree", "paths_digest", "paths", "intended_untracked", "intended_untracked_proof", "initial_snapshot_identity", "current_snapshot_identity"]);
	if (projection.schema !== "gentle-ai.review-integration.projection/v1") throw new TypeError("status.projection schema is incompatible");
	return {
		schema: "gentle-ai.review-integration.projection/v1",
		kind: enumeration(projection.kind, Object.values(REVIEW_PROJECTION_KIND), "status.projection.kind"),
		projection: enumeration(projection.projection, REQUIRED_PROJECTIONS, "status.projection.projection"),
		baseTree: gitTree(projection.base_tree, "status.projection.base_tree"),
		initialReviewTree: gitTree(projection.initial_review_tree, "status.projection.initial_review_tree"),
		currentCandidateTree: gitTree(projection.current_candidate_tree, "status.projection.current_candidate_tree"),
		pathsDigest: sha256(projection.paths_digest, "status.projection.paths_digest"),
		paths: array(projection.paths, "status.projection.paths", safePath, { unique: true }),
		intendedUntracked: array(projection.intended_untracked, "status.projection.intended_untracked", safePath, { unique: true }),
		intendedUntrackedProof: sha256(projection.intended_untracked_proof, "status.projection.intended_untracked_proof"),
		initialSnapshotIdentity: sha256(projection.initial_snapshot_identity, "status.projection.initial_snapshot_identity"),
		currentSnapshotIdentity: sha256(projection.current_snapshot_identity, "status.projection.current_snapshot_identity"),
	};
}

// ---------------------------------------------------------------------------
// authority-repair-assessment/v1 — net-new. Consumed as status.repair AND
// repair.assessment.
// ---------------------------------------------------------------------------

function decodeAuthorityRepairAssessmentCounts(value: unknown, label: string): AuthorityRepairAssessmentCountsV1 {
	const body = exactRecord(value, label, ["lineages", "compact_lineages", "legacy_lineages", "events", "bytes", "eligible_candidates", "unsupported_lineages", "conflicts"]);
	return {
		lineages: integer(body.lineages, `${label}.lineages`, 0, 256),
		compactLineages: integer(body.compact_lineages, `${label}.compact_lineages`, 0, 256),
		legacyLineages: integer(body.legacy_lineages, `${label}.legacy_lineages`, 0, 256),
		events: integer(body.events, `${label}.events`, 0, 1024),
		bytes: integer(body.bytes, `${label}.bytes`, 0, 8_388_608),
		eligibleCandidates: integer(body.eligible_candidates, `${label}.eligible_candidates`, 0, 256),
		unsupportedLineages: integer(body.unsupported_lineages, `${label}.unsupported_lineages`, 0, 1024),
		conflicts: integer(body.conflicts, `${label}.conflicts`, 0, 1024),
	};
}

export function decodeAuthorityRepairAssessmentV1(value: unknown): AuthorityRepairAssessmentV1 {
	const label = "assessment";
	const body = exactRecord(value, label, ["schema", "status", "counts", "supported_operations", "authorization_schema"], ["class", "cause", "disposition", "repository_binding", "candidate"]);
	if (body.schema !== "gentle-ai.review-authority-repair-assessment/v1") throw new TypeError(`${label}.schema must be gentle-ai.review-authority-repair-assessment/v1`);
	const status = enumeration(body.status, ["eligible", "unsupported", "ambiguous", "conflicting", "truncated"] as const, `${label}.status`);

	const eligibleFields = ["class", "cause", "disposition", "repository_binding", "candidate"] as const;
	const eligiblePresent = eligibleFields.filter((field) => body[field] !== undefined);
	if (status === "eligible") {
		if (eligiblePresent.length !== eligibleFields.length) throw new TypeError(`${label} eligible status requires class, cause, disposition, repository_binding, and candidate`);
	} else if (eligiblePresent.length > 0) {
		throw new TypeError(`${label} non-eligible status cannot expose class, cause, disposition, repository_binding, or candidate`);
	}
	if (body.class !== undefined && body.class !== "legacy_v1_historical_alias") throw new TypeError(`${label}.class is unsupported`);
	if (body.cause !== undefined && body.cause !== "unsupported_historical_v1_operation_alias") throw new TypeError(`${label}.cause is unsupported`);
	if (body.disposition !== undefined && body.disposition !== "quarantine-approved-historical-alias") throw new TypeError(`${label}.disposition is unsupported`);

	let candidate: AuthorityRepairAssessmentCandidateV1 | undefined;
	if (body.candidate !== undefined) {
		const source = exactRecord(body.candidate, `${label}.candidate`, ["lineage_id", "revision", "chain_identity", "event_count", "alias_event_count", "operations"]);
		candidate = {
			lineageId: lineage(source.lineage_id, `${label}.candidate.lineage_id`),
			revision: sha256(source.revision, `${label}.candidate.revision`),
			chainIdentity: sha256(source.chain_identity, `${label}.candidate.chain_identity`),
			eventCount: integer(source.event_count, `${label}.candidate.event_count`, 2, 1024),
			aliasEventCount: integer(source.alias_event_count, `${label}.candidate.alias_event_count`, 1, 1024),
			operations: enumArray(source.operations, ["review/complete-fix", "review/validate-fix"] as const, `${label}.candidate.operations`, { minimum: 1, maximum: 2, unique: true }),
		};
	}

	const counts = decodeAuthorityRepairAssessmentCounts(body.counts, `${label}.counts`);
	if (status === "eligible" && (counts.eligibleCandidates !== 1 || counts.unsupportedLineages !== 0 || counts.conflicts !== 0)) {
		throw new TypeError(`${label}.counts is incompatible with eligible status`);
	}

	const supportedOperations = array(body.supported_operations, `${label}.supported_operations`, (entry, entryLabel) => enumeration(entry, ["review/complete-fix", "review/validate-fix"] as const, entryLabel), { minimum: 2, maximum: 2 });
	if (supportedOperations[0] !== "review/complete-fix" || supportedOperations[1] !== "review/validate-fix") throw new TypeError(`${label}.supported_operations is out of order`);
	if (body.authorization_schema !== "gentle-ai.review-repair-authorization/v1") throw new TypeError(`${label}.authorization_schema must be gentle-ai.review-repair-authorization/v1`);

	return {
		schema: "gentle-ai.review-authority-repair-assessment/v1",
		status,
		...(body.class === undefined ? {} : { class: "legacy_v1_historical_alias" as const }),
		...(body.cause === undefined ? {} : { cause: "unsupported_historical_v1_operation_alias" as const }),
		...(body.disposition === undefined ? {} : { disposition: "quarantine-approved-historical-alias" as const }),
		...(body.repository_binding === undefined ? {} : { repositoryBinding: sha256(body.repository_binding, `${label}.repository_binding`) }),
		...(candidate === undefined ? {} : { candidate }),
		counts,
		supportedOperations: supportedOperations as readonly ["review/complete-fix", "review/validate-fix"],
		authorizationSchema: "gentle-ai.review-repair-authorization/v1",
	};
}

// ---------------------------------------------------------------------------
// next-transition/v3 — net-new; unlike v1's decodeNextTransition (void),
// this decoder returns a typed value so callers can read the manifest-bound
// collect inputs and the execute binding.
// ---------------------------------------------------------------------------

const NEXT_TRANSITION_OPERATIONS = ["review.start", "review.status", "review.recover", "review.repair", "review.acknowledge-approved"] as const;

function decodeTransitionArguments(value: unknown, label: string): readonly ReviewTransitionArgumentV3[] {
	return array(value, label, (entry, entryLabel) => {
		const argument = exactRecord(entry, entryLabel, ["name", "value"], ["token"]);
		const name = text(argument.name, `${entryLabel}.name`, { minimum: 1, pattern: /^[a-z0-9_-]+$/ });
		const argumentValue = text(argument.value, `${entryLabel}.value`, { minimum: 1 });
		const token = argument.token === undefined ? undefined : text(argument.token, `${entryLabel}.token`, { minimum: 1 });
		return { name, value: argumentValue, ...(token === undefined ? {} : { token }) };
	});
}

function decodeCaptureSubmission(value: unknown, label: string, v5: boolean, v6: boolean, captureOperation: string): ReviewCaptureSubmissionV1 {
	// status/v6 adds the provider-owned intended-untracked selection form.
	if (v6 && captureOperation === "external.select_intended_untracked" && typeof value === "object" && value !== null && (value as Record<string, unknown>).operation_token === "status") {
		const submission = exactRecord(value, label, ["operation_token", "argument_tokens", "value"]);
		const expectedTokens = [
			"--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi",
			"--projection=workspace", "--intended-untracked-selection={{value}}",
		] as const;
		const operationToken = enumeration(submission.operation_token, ["status"] as const, `${label}.operation_token`);
		const argumentTokens = stringArray(submission.argument_tokens, `${label}.argument_tokens`, { minimum: expectedTokens.length, maximum: expectedTokens.length });
		if (argumentTokens.some((token, index) => token !== expectedTokens[index])) throw new TypeError(`${label}.argument_tokens substitution binding is invalid`);
		const row = exactRecord(submission.value, `${label}.value`, ["slot", "domain", "schema", "substitution_location"]);
		return {
			operationToken,
			argumentTokens,
			values: [{
				slot: enumeration(row.slot, ["intended_untracked_selection"] as const, `${label}.value.slot`),
				domain: enumeration(row.domain, ["schema_bound_json"] as const, `${label}.value.domain`),
				schema: enumeration(row.schema, ["gentle-ai.review-intended-untracked-selection/v1"] as const, `${label}.value.schema`),
				substitutionLocation: integer(row.substitution_location, `${label}.value.substitution_location`, 4, 4),
			}],
		};
	}
	// status/v5: the live 2.4.0-main binary emits the materialize
	// capture-result submission as a SINGULAR `value` object carrying a
	// `schema` key (captured 2026-08-16 from 2.4.0-main.b1afef46; the
	// emitter has been singular since gentle-ai f1a95179). The form is
	// closed to that exact captured shape and normalizes into the typed
	// one-entry values array the host relay already consumes. A payload
	// carrying both wire forms at once matches no captured shape and falls
	// through to the legacy decoder, which rejects the unknown `value` key.
	//
	// gentle-ai's v9 contract renders the same singular-value shape for the
	// two host-mediated provider role operations (capture-refuter,
	// capture-validation): they carry a `schema` key exactly like
	// capture-result, since both bind one artifact-path-or-stdin value, never
	// the correction-plan's numeric bounds (gentle-pi#311 P3).
	if (v5 && typeof value === "object" && value !== null && "value" in value && !("values" in value)) {
		const submission = exactRecord(value, label, ["operation_token", "argument_tokens", "value"]);
		const operationToken = enumeration(submission.operation_token, ["capture-result", "capture-correction-plan", "capture-refuter", "capture-validation"] as const, `${label}.operation_token`);
		const argumentTokens = stringArray(submission.argument_tokens, `${label}.argument_tokens`, { minimum: 1 });
		const bindsArtifactSchema = operationToken === "capture-result" || operationToken === "capture-refuter" || operationToken === "capture-validation";
		const row = bindsArtifactSchema
			? exactRecord(submission.value, `${label}.value`, ["slot", "domain", "schema", "substitution_location"])
			: exactRecord(submission.value, `${label}.value`, ["slot", "domain", "minimum", "maximum", "substitution_location"]);
		return {
			operationToken,
			argumentTokens,
			values: [{
				slot: operationToken === "capture-result"
					? enumeration(row.slot, ["reviewer_result"] as const, `${label}.value.slot`)
					: operationToken === "capture-correction-plan"
					? enumeration(row.slot, ["correction_lines"] as const, `${label}.value.slot`)
					: operationToken === "capture-refuter"
					? enumeration(row.slot, ["provider_refuter"] as const, `${label}.value.slot`)
					: enumeration(row.slot, ["provider_targeted_validator"] as const, `${label}.value.slot`),
				domain: nonempty(row.domain, `${label}.value.domain`),
				...(row.schema === undefined ? {} : { schema: nonempty(row.schema, `${label}.value.schema`) }),
				...(row.minimum === undefined ? {} : { minimum: integer(row.minimum, `${label}.value.minimum`, 1, 200) }),
				...(row.maximum === undefined ? {} : { maximum: integer(row.maximum, `${label}.value.maximum`, 1, 200) }),
				substitutionLocation: integer(row.substitution_location, `${label}.value.substitution_location`, 0, argumentTokens.length - 1),
			}],
		};
	}
	const submission = exactRecord(value, label, ["operation_token", "argument_tokens", "values"]);
	const operationToken = text(submission.operation_token, `${label}.operation_token`, { minimum: 1, pattern: /^[a-z0-9-]+$/ });
	const argumentTokens = stringArray(submission.argument_tokens, `${label}.argument_tokens`, { minimum: 1 });
	const values = array(submission.values, `${label}.values`, (entry, entryLabel) => {
		const row = exactRecord(entry, entryLabel, ["slot", "domain", "substitution_location"]);
		return {
			slot: nonempty(row.slot, `${entryLabel}.slot`),
			domain: nonempty(row.domain, `${entryLabel}.domain`),
			substitutionLocation: integer(row.substitution_location, `${entryLabel}.substitution_location`, 0, argumentTokens.length - 1),
		};
	}, { minimum: 1 });
	return { operationToken, argumentTokens, values };
}

// v5-only structural decoders, exact to the vendored status-v5.schema.json
// and correction-plan-request.schema.json on gentle-ai main.

function decodeProviderTask(value: unknown, label: string): ReviewProviderTaskV1 {
	const task = exactRecord(value, label, ["agent", "role", "prompt"]);
	return {
		agent: enumeration(task.agent, ["review-refuter", "review-validator"] as const, `${label}.agent`),
		role: enumeration(task.role, ["refuter", "targeted-validator"] as const, `${label}.role`),
		prompt: nonempty(task.prompt, `${label}.prompt`),
	};
}

function decodeCorrectionPlanRequestV1(value: unknown, label: string): ReviewCorrectionPlanRequestV1 {
	const body = exactRecord(value, label, ["schema", "request_hash", "lineage_id", "expected_revision", "target_identity", "correction_budget", "fix_finding_ids", "findings"]);
	if (body.schema !== "gentle-ai.review-correction-plan-request/v1") throw new TypeError(`${label}.schema must be gentle-ai.review-correction-plan-request/v1`);
	return {
		schema: "gentle-ai.review-correction-plan-request/v1",
		requestHash: sha256(body.request_hash, `${label}.request_hash`),
		lineageId: lineage(body.lineage_id, `${label}.lineage_id`),
		expectedRevision: sha256(body.expected_revision, `${label}.expected_revision`),
		targetIdentity: sha256(body.target_identity, `${label}.target_identity`),
		correctionBudget: integer(body.correction_budget, `${label}.correction_budget`, 1, 200),
		fixFindingIds: stringArray(body.fix_finding_ids, `${label}.fix_finding_ids`, { minimum: 1, unique: true }),
		findings: array(body.findings, `${label}.findings`, (entry, entryLabel) => {
			const finding = exactRecord(entry, entryLabel, ["id", "lens", "location", "severity", "claim", "proof_refs", "evidence", "evidence_class", "causal_disposition"]);
			return {
				id: nonempty(finding.id, `${entryLabel}.id`),
				lens: enumeration(finding.lens, ["risk", "resilience", "readability", "reliability"] as const, `${entryLabel}.lens`),
				location: nonempty(finding.location, `${entryLabel}.location`),
				severity: enumeration(finding.severity, ["BLOCKER", "CRITICAL"] as const, `${entryLabel}.severity`),
				claim: nonempty(finding.claim, `${entryLabel}.claim`),
				proofRefs: stringArray(finding.proof_refs, `${entryLabel}.proof_refs`, { minimum: 1 }),
				evidence: nonempty(finding.evidence, `${entryLabel}.evidence`),
				evidenceClass: enumeration(finding.evidence_class, ["deterministic", "inferential"] as const, `${entryLabel}.evidence_class`),
				causalDisposition: enumeration(finding.causal_disposition, ["introduced", "behavior-activated", "worsened"] as const, `${entryLabel}.causal_disposition`),
			};
		}, { minimum: 1 }),
	};
}

export function decodeReviewTargetedValidationRequestV1(value: unknown, label = "targeted_validation_request"): ReviewTargetedValidationRequestV1 {
	const body = exactRecord(value, label, [
		"schema", "request_hash", "lineage_id", "expected_revision", "target_identity", "fix_finding_ids", "policy_content", "fix_findings", "fix_classifications",
		"projection", "correction_candidate_tree", "correction_target_identity", "correction_paths", "correction_paths_digest",
	]);
	if (body.schema !== "gentle-ai.review-targeted-validation-request/v1") throw new TypeError(`${label}.schema must be gentle-ai.review-targeted-validation-request/v1`);
	const fixFindingIds = stringArray(body.fix_finding_ids, `${label}.fix_finding_ids`, { minimum: 1, unique: true });
	const fixFindings = array(body.fix_findings, `${label}.fix_findings`, (entry, entryLabel): ReviewTargetedValidationFindingV1 => {
		const finding = exactRecord(entry, entryLabel, ["id", "lens", "location", "severity", "claim", "proof_refs", "evidence_class", "causal_disposition"]);
		return {
			id: nonempty(finding.id, `${entryLabel}.id`),
			lens: enumeration(finding.lens, ["risk", "resilience", "readability", "reliability"] as const, `${entryLabel}.lens`),
			location: nonempty(finding.location, `${entryLabel}.location`),
			severity: enumeration(finding.severity, ["BLOCKER", "CRITICAL"] as const, `${entryLabel}.severity`),
			claim: nonempty(finding.claim, `${entryLabel}.claim`),
			proofRefs: stringArray(finding.proof_refs, `${entryLabel}.proof_refs`, { minimum: 1 }),
			evidenceClass: enumeration(finding.evidence_class, ["deterministic", "inferential"] as const, `${entryLabel}.evidence_class`),
			causalDisposition: enumeration(finding.causal_disposition, ["introduced", "behavior-activated", "worsened"] as const, `${entryLabel}.causal_disposition`),
		};
	}, { minimum: 1 });
	const fixClassifications = array(body.fix_classifications, `${label}.fix_classifications`, (entry, entryLabel): ReviewTargetedValidationClassificationV1 => {
		const classification = exactRecord(entry, entryLabel, ["finding_id", "class", "causal_disposition", "proof"], ["severity"]);
		const severity = classification.severity === undefined ? undefined : nonempty(classification.severity, `${entryLabel}.severity`);
		return {
			findingId: nonempty(classification.finding_id, `${entryLabel}.finding_id`),
			...(severity === undefined ? {} : { severity }),
			class: enumeration(classification.class, ["deterministic", "inferential"] as const, `${entryLabel}.class`),
			causalDisposition: enumeration(classification.causal_disposition, ["introduced", "behavior-activated", "worsened"] as const, `${entryLabel}.causal_disposition`),
			proof: nonempty(classification.proof, `${entryLabel}.proof`),
		};
	}, { minimum: 1 });
	const findingIds = fixFindings.map((finding) => finding.id);
	const classificationFindingIds = fixClassifications.map((classification) => classification.findingId);
	assertExactSet(findingIds, fixFindingIds, `${label}.fix_findings`);
	assertExactSet(classificationFindingIds, fixFindingIds, `${label}.fix_classifications`);
	return {
		schema: "gentle-ai.review-targeted-validation-request/v1",
		requestHash: sha256(body.request_hash, `${label}.request_hash`),
		lineageId: lineage(body.lineage_id, `${label}.lineage_id`),
		expectedRevision: sha256(body.expected_revision, `${label}.expected_revision`),
		targetIdentity: sha256(body.target_identity, `${label}.target_identity`),
		fixFindingIds,
		policyContent: nonempty(body.policy_content, `${label}.policy_content`),
		fixFindings,
		fixClassifications,
		projection: enumeration(body.projection, REQUIRED_PROJECTIONS, `${label}.projection`),
		correctionCandidateTree: gitTree(body.correction_candidate_tree, `${label}.correction_candidate_tree`),
		correctionTargetIdentity: sha256(body.correction_target_identity, `${label}.correction_target_identity`),
		correctionPaths: stringArray(body.correction_paths, `${label}.correction_paths`, { minimum: 1, unique: true }),
		correctionPathsDigest: sha256(body.correction_paths_digest, `${label}.correction_paths_digest`),
	};
}

export function decodeReviewForecastV1(value: unknown, label = "status.forecast"): ReviewForecastV1 {
	const body = exactRecord(value, label, ["horizon", "steps"]);
	const horizon = enumeration(body.horizon, ["partial", "terminal"] as const, `${label}.horizon`);
	const steps = array(body.steps, `${label}.steps`, (entry, entryLabel) => {
		const step = exactRecord(entry, entryLabel, ["step", "kind", "reason_code", "description"]);
		if (step.step !== 1) throw new TypeError(`${entryLabel}.step must be 1`);
		return {
			step: 1 as const,
			kind: enumeration(step.kind, ["execute", "collect", "stop"] as const, `${entryLabel}.kind`),
			reasonCode: text(step.reason_code, `${entryLabel}.reason_code`, { minimum: 1, pattern: /^[a-z0-9_]+$/ }),
			description: nonempty(step.description, `${entryLabel}.description`),
		};
	}, { minimum: 1, maximum: 1 });
	// The published horizon-to-step invariant: a stop head is terminal, any
	// other head is partial.
	if ((horizon === "terminal") !== (steps[0]!.kind === "stop")) throw new TypeError(`${label}.horizon does not match its step kind`);
	return { horizon, steps };
}

// The two v5 reason codes whose transitions must carry the correction plan
// request; every other reason code must not.
const CORRECTION_REQUEST_REASON_CODES = Object.freeze(["correction_plan_required", "corrected_candidate_unavailable"] as const);
// v5 capture operations that must carry a submission descriptor.
const V5_SUBMISSION_CAPTURE_OPERATIONS = Object.freeze(["review.capture-correction-plan"] as const);

function decodeCollectInput(value: unknown, label: string, v5: boolean, v6: boolean, v9: boolean): ReviewCollectInputV3 {
	const input = exactRecord(value, label, ["name", "schema", "capture_operation", "arguments"], ["artifact_subject", "base_tree", "candidate_tree", "changed_path_manifest", "submission", ...(v5 ? ["provider_task", "validation_request"] : [])]);
	const name = text(input.name, `${label}.name`, { minimum: 1, pattern: /^[a-z0-9_]+$/ });
	const schema = nonempty(input.schema, `${label}.schema`);
	const captureOperation = nonempty(input.capture_operation, `${label}.capture_operation`);
	const argumentsList = decodeTransitionArguments(input.arguments, `${label}.arguments`);

	// v5-only surfaces (vendored status-v5.schema.json): the provider role task
	// rides exactly the external.run_provider_role vector, and the finalize/
	// capture-evidence submission descriptor forms ride their own vectors.
	if (v5) {
		if (captureOperation === "external.run_provider_role") {
			if (input.provider_task === undefined) throw new TypeError(`${label}.provider_task is required for external.run_provider_role`);
		} else if (input.provider_task !== undefined) {
			throw new TypeError(`${label}.provider_task is only valid for external.run_provider_role`);
		}
		if ((V5_SUBMISSION_CAPTURE_OPERATIONS as readonly string[]).includes(captureOperation)) {
			if (input.submission === undefined) throw new TypeError(`${label}.submission is required for ${captureOperation}`);
			if (captureOperation === "review.capture-correction-plan" && schema !== "gentle-ai.review-correction-plan/v1") throw new TypeError(`${label}.schema must be gentle-ai.review-correction-plan/v1`);
		}
	}

	const intendedUntracked = v6
		&& name === "intended_untracked_selection"
		&& schema === "gentle-ai.review-intended-untracked-selection/v1"
		&& captureOperation === "external.select_intended_untracked";
	if (captureOperation === "external.select_intended_untracked" && (name !== "intended_untracked_selection" || schema !== "gentle-ai.review-intended-untracked-selection/v1")) {
		throw new TypeError(`${label} external.select_intended_untracked requires the intended_untracked_selection binding`);
	}
	if (intendedUntracked) {
		const expectedNames = ["target_identity", "projection", "base_tree", "candidate_tree", "eligible_paths_json", "expected_untracked_inventory"] as const;
		if (argumentsList.length !== expectedNames.length || argumentsList.some((argument, index) => argument.name !== expectedNames[index] || argument.token !== undefined)) {
			throw new TypeError(`${label}.arguments must preserve the exact intended-untracked metadata binding`);
		}
		sha256(argumentsList[0]!.value, `${label}.arguments[0].value`);
		enumeration(argumentsList[1]!.value, ["workspace"] as const, `${label}.arguments[1].value`);
		gitTree(argumentsList[2]!.value, `${label}.arguments[2].value`);
		gitTree(argumentsList[3]!.value, `${label}.arguments[3].value`);
		const eligiblePathsJson = argumentsList[4]!.value;
		let eligiblePaths: unknown;
		try { eligiblePaths = JSON.parse(eligiblePathsJson); } catch { throw new TypeError(`${label}.arguments[4].value must be canonical JSON`); }
		if (!Array.isArray(eligiblePaths) || eligiblePaths.length === 0 || eligiblePaths.some((path) => {
			if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\\") || path.includes("\0")) return true;
			const segments = path.split("/");
			return segments.some((segment) => segment === "" || segment === "." || segment === "..");
		}) || new Set(eligiblePaths).size !== eligiblePaths.length || JSON.stringify(eligiblePaths) !== eligiblePathsJson) {
			throw new TypeError(`${label}.arguments[4].value must contain unique canonical repository-relative paths`);
		}
		sha256(argumentsList[5]!.value, `${label}.arguments[5].value`);
	}

	// gentle-pi#311 P4-roles / P3: the two non-lens provider role capture
	// operations render either wire form on one input, never both at once.
	// An older gentle-ai renders a SELF-CONTAINED authority-advancing vector
	// (binding tokens + --agent=pi --execute=true, no submission): executing
	// the exact rendered tokens makes Go materialize the role prompt, run its
	// own locked-down pi subprocess, and admit the raw verdict. gentle-ai's
	// v9 contract instead renders a HOST-MEDIATED form: the same binding
	// tokens plus --materialize=true (never --execute) and a provider-owned
	// submission descriptor, exactly like a lens capture-result materialize
	// slot — the host completes the frozen prompt in-process and submits
	// through that descriptor.
	const isRoleCaptureOperation = (REVIEW_PROVIDER_ROLE_CAPTURE_OPERATIONS as readonly string[]).includes(captureOperation);
	if (captureOperation === REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION.CAPTURE_REFUTER && schema !== "https://gentle-ai.dev/schema/review/refuter/v1") {
		throw new TypeError(`${label}.schema must be https://gentle-ai.dev/schema/review/refuter/v1`);
	}
	if (captureOperation === REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION.CAPTURE_VALIDATION && schema !== "https://gentle-ai.dev/schema/review/validator/v1") {
		throw new TypeError(`${label}.schema must be https://gentle-ai.dev/schema/review/validator/v1`);
	}
	const targetedValidatorInput = v5
		&& name === "provider_targeted_validator"
		&& captureOperation === REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION.CAPTURE_VALIDATION
		&& schema === "https://gentle-ai.dev/schema/review/validator/v1";
	if (input.validation_request !== undefined && !targetedValidatorInput) {
		throw new TypeError(`${label}.validation_request is only valid for the v5 provider-targeted-validator capture input`);
	}
	if (targetedValidatorInput && input.validation_request === undefined) {
		throw new TypeError(`${label}.validation_request is required for the v5 provider-targeted-validator capture input`);
	}
	const validationRequest = input.validation_request === undefined
		? undefined
		: decodeReviewTargetedValidationRequestV1(input.validation_request, `${label}.validation_request`);
	if (validationRequest !== undefined) {
		const providerArgument = (argumentName: string): string => {
			const matches = argumentsList.filter((argument) => argument.name === argumentName);
			if (matches.length !== 1) throw new TypeError(`${label}.arguments must carry exactly one ${argumentName} binding`);
			return matches[0]!.value;
		};
		if (providerArgument("lineage") !== validationRequest.lineageId) throw new TypeError(`${label}.arguments lineage must bind validation_request.lineage_id`);
		if (providerArgument("expected-revision") !== validationRequest.expectedRevision) throw new TypeError(`${label}.arguments expected-revision must bind validation_request.expected_revision`);
		if (providerArgument("target") !== validationRequest.correctionTargetIdentity) throw new TypeError(`${label}.arguments target must bind validation_request.correction_target_identity`);
		if (providerArgument("request-hash") !== validationRequest.requestHash) throw new TypeError(`${label}.arguments request-hash must bind validation_request.request_hash`);
	}
	if (isRoleCaptureOperation && input.submission !== undefined) {
		// A submission descriptor only ever rides the v9 host-mediated form
		// (gentle-ai's v9 provider contract; the sibling branch ahead of the
		// currently-released v8). A v8-or-earlier provider (status/v3..v8) never
		// renders one, even if it happened to carry a submission-shaped payload,
		// so this is gated on v9 specifically — not on v5, which v8 already
		// satisfies. Within a v9 payload the discriminator is exactly the
		// materialize slot's --materialize=true with no --execute, the same one
		// a lens capture-result materialize slot already uses. Mixing a
		// submission with the old self-contained --execute=true vector, or with
		// neither flag, is a malformed vector.
		if (!v9) {
			throw new TypeError(`${label}.submission requires the v9 provider contract for the host-mediated ${captureOperation} form`);
		}
		const argumentNamed = (argumentName: string): string | undefined => {
			const matches = argumentsList.filter((argument) => argument.name === argumentName);
			return matches.length === 1 ? matches[0]!.value : undefined;
		};
		if (argumentNamed("materialize") !== "true") {
			throw new TypeError(`${label}.submission requires --materialize=true on the host-mediated ${captureOperation} form`);
		}
		if (argumentNamed("execute") !== undefined) {
			throw new TypeError(`${label} must not carry --execute alongside a submission descriptor on ${captureOperation}`);
		}
	}

	if (captureOperation === "review.capture-result") {
		// changed_path_manifest is optional here: the artifact subject's
		// changed_path_manifest_sha256 already binds the frozen manifest, and
		// gentle-ai stops inlining one copy per lens (gentle-ai#3922).
		if (input.artifact_subject === undefined || input.base_tree === undefined || input.candidate_tree === undefined) {
			throw new TypeError(`${label} requires artifact_subject, base_tree, and candidate_tree`);
		}
		if (schema !== "https://gentle-ai.dev/schema/review/reviewer/v1") throw new TypeError(`${label}.schema must be https://gentle-ai.dev/schema/review/reviewer/v1`);
	} else if (input.artifact_subject !== undefined || input.base_tree !== undefined || input.candidate_tree !== undefined || input.changed_path_manifest !== undefined) {
		throw new TypeError(`${label} carries capture-result fields without review.capture-result`);
	}
	const submissionOperations: readonly string[] = v5
		? ["review.capture-result", "review.capture-correction-plan", ...(v6 ? ["external.select_intended_untracked"] : [])]
		: ["review.capture-result"];
	// Role operations are gated above by the materialize/execute discriminator
	// instead of this allowlist: an older gentle-ai's self-contained vector
	// legitimately carries no submission regardless of v5/v6, so they cannot
	// simply join the list the way every other submission-carrying operation
	// does.
	if (input.submission !== undefined && !isRoleCaptureOperation && !submissionOperations.includes(captureOperation)) {
		throw new TypeError(v5 ? `${label}.submission is only valid for ${submissionOperations.join(", ")}` : `${label}.submission is only valid for review.capture-result`);
	}
	if (intendedUntracked && input.submission === undefined) throw new TypeError(`${label}.submission is required for external.select_intended_untracked`);

	const submission = input.submission === undefined
		? undefined
		: decodeCaptureSubmission(input.submission, `${label}.submission`, v5, v6, captureOperation);

	return {
		name,
		schema,
		captureOperation,
		arguments: argumentsList,
		...(input.artifact_subject === undefined ? {} : { artifactSubject: decodeArtifactSubject(input.artifact_subject, `${label}.artifact_subject`) }),
		...(input.base_tree === undefined ? {} : { baseTree: gitTree(input.base_tree, `${label}.base_tree`) }),
		...(input.candidate_tree === undefined ? {} : { candidateTree: gitTree(input.candidate_tree, `${label}.candidate_tree`) }),
		...(input.changed_path_manifest === undefined ? {} : { changedPathManifest: array(input.changed_path_manifest, `${label}.changed_path_manifest`, decodeChangedPathEntry, { unique: true }) }),
		...(submission === undefined ? {} : { submission }),
		...(v5 && input.provider_task !== undefined ? { providerTask: decodeProviderTask(input.provider_task, `${label}.provider_task`) } : {}),
		...(validationRequest === undefined ? {} : { validationRequest }),
	};
}

// gentle-pi#627: gentle-ai's managed-assets continuation (STATUS next_transition
// stop reason_code=managed_assets_outdated, and START's preflight failure
// envelope) names the exact `gentle-ai sync` invocation that resolves a stale
// managed-asset set without abandoning the frozen candidate. Decoded verbatim
// from internal/cli/review_operation_contract.go's ReviewManagedAssetsContinuation.
export function decodeReviewManagedAssetsContinuationV1(value: unknown, label: string): ReviewManagedAssetsContinuationV1 {
	const body = exactRecord(value, label, ["operation", "command"], ["agent", "stale_assets"]);
	const operation = enumeration(body.operation, ["sync"] as const, `${label}.operation`);
	const command = nonempty(body.command, `${label}.command`);
	const agent = body.agent === undefined ? undefined : nonempty(body.agent, `${label}.agent`);
	const staleAssets = body.stale_assets === undefined ? undefined : stringArray(body.stale_assets, `${label}.stale_assets`, { minimum: 1 });
	return { operation, command, ...(agent === undefined ? {} : { agent }), ...(staleAssets === undefined ? {} : { staleAssets }) };
}

export function decodeReviewNextTransitionV3(value: unknown, options: { v5?: boolean; v6?: boolean; v9?: boolean } = {}): ReviewNextTransitionV3 {
	// v9 (gentle-ai's next contract, ahead of the currently-released v8) is
	// the only rung this sub-decoder distinguishes beyond v6: v7 and v8 add
	// nothing to next_transition/collect-input decoding (v8 only extended the
	// reviewer-result transition for OpenCode provider tasks at the top
	// status level), so they decode on the exact v6 surface here.
	const v9 = options.v9 === true;
	const v6 = options.v6 === true || v9;
	const v5 = options.v5 === true || v6;
	const transition = exactRecord(value, "next_transition", ["kind", "reason_code"], ["execute", "collect", ...(v5 ? ["correction_request"] : []), "continuation", "unachievable_lens_slots"]);
	const kind = enumeration(transition.kind, ["execute", "collect", "stop"] as const, "next_transition.kind");
	const reasonCode = text(transition.reason_code, "next_transition.reason_code", { minimum: 1, pattern: /^[a-z0-9_]+$/ });
	const continuation = transition.continuation === undefined ? undefined : decodeReviewManagedAssetsContinuationV1(transition.continuation, "next_transition.continuation");
	// gentle-pi#627: continuation is optional on every status version an older
	// gentle-ai may emit a managed_assets_outdated stop with no continuation at
	// all, and decode must not refuse the whole envelope for that. When present
	// it is only valid on a stop with this exact reason_code.
	if (continuation !== undefined && !(kind === "stop" && reasonCode === "managed_assets_outdated")) throw new TypeError("next_transition.continuation is only valid for a stop transition with reason_code managed_assets_outdated");

	// gentle-pi#638: the unachievable stop names one entry per declared slot, each carrying its complete withdraw command (schemas/status-v7.schema.json, the stop variant). Like the continuation, the field is only valid on its own exact stop reason code, and an entry is refused rather than silently dropped when the provider drifts.
	let unachievableLensSlots: readonly ReviewUnachievableLensSlotV3[] | undefined;
	if (transition.unachievable_lens_slots !== undefined) {
		if (!(kind === "stop" && reasonCode === "unachievable_lens_slot")) throw new TypeError("next_transition.unachievable_lens_slots is only valid for a stop transition with reason_code unachievable_lens_slot");
		unachievableLensSlots = array(transition.unachievable_lens_slots, "next_transition.unachievable_lens_slots", decodeUnachievableLensSlot, { minimum: 1 });
	}

	// status/v5: the bounded correction plan request rides exactly its two
	// reason codes and never any other (vendored status-v5.schema.json).
	let correctionRequest: ReviewCorrectionPlanRequestV1 | undefined;
	if (v5) {
		const required = (CORRECTION_REQUEST_REASON_CODES as readonly string[]).includes(reasonCode);
		if (required && transition.correction_request === undefined) throw new TypeError(`next_transition.correction_request is required for ${reasonCode}`);
		if (!required && transition.correction_request !== undefined) throw new TypeError(`next_transition.correction_request is only valid for ${CORRECTION_REQUEST_REASON_CODES.join(", ")}`);
		if (transition.correction_request !== undefined) correctionRequest = decodeCorrectionPlanRequestV1(transition.correction_request, "next_transition.correction_request");
	}

	if (kind === "execute") {
		// `command` is an optional, ready-to-paste rendering of `arguments` (the
		// exact same binding as a single shell-ready string) — observed live
		// against a real v2.2.2 review run but absent from the mirrored fixture,
		// which only exercises the `collect` variant of this envelope. Carried
		// through untyped-but-validated rather than dropped, matching how this
		// module already treats every other provider-owned convenience field.
		// status-v2.schema.json $defs.transition_execution declares optional
		// `command`, `selector_arguments`, AND `artifacts`. Declaring only the
		// first rejected two real transitions -- captured_results_ready carries
		// artifacts, approved_receipt_ready carries selector_arguments -- while
		// every native call had already succeeded and authority had advanced.
		const execute = exactRecord(transition.execute, "next_transition.execute", ["operation", "arguments", "preconditions", "binding"], ["command", "selector_arguments", "artifacts"]);
		const operation = enumeration(execute.operation, NEXT_TRANSITION_OPERATIONS, "next_transition.execute.operation");
		const argumentsList = decodeTransitionArguments(execute.arguments, "next_transition.execute.arguments");
		const selectorArguments = execute.selector_arguments === undefined ? undefined : decodeTransitionArguments(execute.selector_arguments, "next_transition.execute.selector_arguments");
		const preconditions = decodeTransitionArguments(execute.preconditions, "next_transition.execute.preconditions");
		// The schema gives `binding` no declared properties and no required list:
		// it is an OPEN object. Closing it here made Pi stricter than the
		// contract it implements and rejected the provider's repository_context.
		// target_identity stays required because Pi reads it.
		const binding = exactRecord(execute.binding, "next_transition.execute.binding", ["target_identity"], ["lineage_id", "revision"], true);
		const targetIdentity = sha256(binding.target_identity, "next_transition.execute.binding.target_identity");
		const lineageId = binding.lineage_id === undefined ? undefined : lineage(binding.lineage_id, "next_transition.execute.binding.lineage_id");
		const revision = binding.revision === undefined ? undefined : sha256(binding.revision, "next_transition.execute.binding.revision");
		const command = execute.command === undefined ? undefined : nonempty(execute.command, "next_transition.execute.command");
		const decodedExecute: ReviewNextTransitionExecuteV3 = { operation, arguments: argumentsList, ...(selectorArguments === undefined ? {} : { selectorArguments }), preconditions, binding: { targetIdentity, ...(lineageId === undefined ? {} : { lineageId }), ...(revision === undefined ? {} : { revision }) }, ...(command === undefined ? {} : { command }) };
		if (operation === "review.acknowledge-approved") assertReviewApprovedAcknowledgementExecuteV1(decodedExecute);
		if (transition.collect !== undefined) throw new TypeError("next_transition.collect is incompatible with execute");
		return { kind, reasonCode, execute: decodedExecute, ...(correctionRequest === undefined ? {} : { correctionRequest }) };
	}
	if (kind === "collect") {
		const collect = exactRecord(transition.collect, "next_transition.collect", ["inputs"]);
		const inputs = array(collect.inputs, "next_transition.collect.inputs", (entry, label) => decodeCollectInput(entry, label, v5, v6, v9), { minimum: 1 });
		if (transition.execute !== undefined) throw new TypeError("next_transition.execute is incompatible with collect");
		return { kind, reasonCode, collect: { inputs }, ...(correctionRequest === undefined ? {} : { correctionRequest }) };
	}
	if (transition.execute !== undefined || transition.collect !== undefined) throw new TypeError("next_transition stop cannot carry a transition");
	return { kind, reasonCode, ...(correctionRequest === undefined ? {} : { correctionRequest }), ...(continuation === undefined ? {} : { continuation }), ...(unachievableLensSlots === undefined ? {} : { unachievableLensSlots }) };
}

// Mirrors NATIVE_REVIEW_UNACHIEVABLE_LENS_DETAIL_LIMIT (lib/native-review-cli.ts) and Go's 512-byte CAPTURE_UNACHIEVABLE detail bound.
export const REVIEW_INTEGRATION_UNACHIEVABLE_LENS_DETAIL_LIMIT = 512;

function decodeUnachievableLensSlot(value: unknown, label: string): ReviewUnachievableLensSlotV3 {
	const body = exactRecord(value, label, ["lens", "selected_order", "subject_hash", "reason", "withdraw"], ["detail"]);
	const lens = nonempty(body.lens, `${label}.lens`);
	const selectedOrder = integer(body.selected_order, `${label}.selected_order`);
	const subjectHash = sha256(body.subject_hash, `${label}.subject_hash`);
	const reason = nonempty(body.reason, `${label}.reason`);
	const detail = body.detail === undefined ? undefined : nonempty(body.detail, `${label}.detail`);
	// gentle-pi#822: Go refuses a CAPTURE_UNACHIEVABLE detail above 512 UTF-8 bytes, so the stop decoder mirrors the same bound — measured in bytes, not UTF-16 code units — and a STATUS stop can never carry a detail this client would have refused to declare.
	if (detail !== undefined && Buffer.byteLength(detail, "utf8") > REVIEW_INTEGRATION_UNACHIEVABLE_LENS_DETAIL_LIMIT) throw new TypeError(`${label}.detail exceeds ${REVIEW_INTEGRATION_UNACHIEVABLE_LENS_DETAIL_LIMIT} bytes`);
	const withdraw = exactRecord(body.withdraw, `${label}.withdraw`, ["operation", "command", "arguments", "binding"]);
	const operation = enumeration(withdraw.operation, ["review.capture-unachievable"] as const, `${label}.withdraw.operation`);
	const command = nonempty(withdraw.command, `${label}.withdraw.command`);
	const arguments_ = decodeTransitionArguments(withdraw.arguments, `${label}.withdraw.arguments`);
	// Withdrawal is a single affirmative native action, never an optional or
	// negatable provider argument. The general token and command checks below
	// then prove its exact --withdraw=true rendering is the complete vector.
	const withdrawArguments = arguments_.filter((argument) => argument.name === "withdraw");
	if (withdrawArguments.length !== 1) throw new TypeError(`${label}.withdraw.arguments withdraw must appear exactly once`);
	if (withdrawArguments[0]!.value !== "true") throw new TypeError(`${label}.withdraw.arguments withdraw must be true`);
	// The binding keeps the execute branch's open-record discipline: the Go shape is target_identity plus optional lineage_id, revision, and repository_context, and closing it here would make Pi stricter than the contract it implements.
	const binding = exactRecord(withdraw.binding, `${label}.withdraw.binding`, ["target_identity"], ["lineage_id", "revision", "repository_context"], true);
	const targetIdentity = sha256(binding.target_identity, `${label}.withdraw.binding.target_identity`);
	const lineageId = binding.lineage_id === undefined ? undefined : lineage(binding.lineage_id, `${label}.withdraw.binding.lineage_id`);
	const revision = binding.revision === undefined ? undefined : sha256(binding.revision, `${label}.withdraw.binding.revision`);
	// gentle-pi#822: the withdraw form names the slot identity twice — as named arguments and as the binding object — and the two renderings must agree before the slot decodes. Strict equality also enforces both-or-neither on the optional lineage and revision fields, so a partially rendered binding never slips through and restart cannot withdraw a different slot. Each identity argument must appear EXACTLY once: a first-match lookup let a duplicate {name} entry smuggle a second value past the identity checks.
	const withdrawIdentityArgument = (name: string): ReviewTransitionArgumentV3 | undefined => {
		const matches = arguments_.filter((argument) => argument.name === name);
		if (matches.length > 1) throw new TypeError(`${label}.withdraw.arguments ${name} must appear exactly once`);
		return matches[0];
	};
	const withdrawRequestHash = withdrawIdentityArgument("request-hash");
	if (withdrawRequestHash?.value !== subjectHash) throw new TypeError(`${label}.withdraw.arguments request-hash does not match the slot subject_hash`);
	const withdrawTarget = withdrawIdentityArgument("target");
	if (withdrawTarget?.value !== targetIdentity) throw new TypeError(`${label}.withdraw.arguments target does not match the withdraw binding target_identity`);
	const withdrawLineage = withdrawIdentityArgument("lineage");
	if (withdrawLineage?.value !== lineageId) throw new TypeError(`${label}.withdraw.arguments lineage does not match the withdraw binding lineage_id`);
	const withdrawExpectedRevision = withdrawIdentityArgument("expected-revision");
	if (withdrawExpectedRevision?.value !== revision) throw new TypeError(`${label}.withdraw.arguments expected-revision does not match the withdraw binding revision`);
	// gentle-pi#822: command is executable authority, not a display hint. Every
	// provider-issued argument token must be the canonical --name=value rendering,
	// and command must render the canonical operation plus those tokens exactly in
	// order. This rejects omitted tokens, a second command, suffixes, and shell
	// payloads rather than merely finding identity-token substrings.
	const tokens = arguments_.map((argument, index) => {
		if (argument.token === undefined) throw new TypeError(`${label}.withdraw.arguments[${index}].token is required`);
		const expectedToken = `--${argument.name}=${argument.value}`;
		if (argument.token !== expectedToken) throw new TypeError(`${label}.withdraw.arguments[${index}].token must exactly render its name and value`);
		return argument.token;
	});
	const expectedCommand = `gentle-ai review capture-unachievable ${tokens.join(" ")}`;
	if (command !== expectedCommand) throw new TypeError(`${label}.withdraw.command must exactly render the canonical operation and withdraw arguments`);
	return { lens, selectedOrder, subjectHash, reason, ...(detail === undefined ? {} : { detail }), withdraw: { operation, command, arguments: arguments_, binding: { targetIdentity, ...(lineageId === undefined ? {} : { lineageId }), ...(revision === undefined ? {} : { revision }) } } };
}

// ---------------------------------------------------------------------------
// eligibility — decoded for validation, discarded (not exposed on the typed
// status/finalize shapes), matching lib/review-integration-v1.ts's pattern.
// Unlike v1's decoder, this one accepts disposition+binding for BOTH
// review.recover and review.retry_final_verification, matching the mirrored
// status-v2.schema.json action_eligibility definition v2 also $refs.
// ---------------------------------------------------------------------------

const ELIGIBLE_ACTIONS = ["stop", "review.start", "review.recover", "review.repair"] as const;
const FORBIDDEN_ACTIONS = ["review.abandon", "review.invalidate", "review.quarantine-legacy", "review.reclaim", "review.reconcile-authority", "review.reconcile-authority-batch", "review.recover", "review.repair", "review.start"] as const;

function decodeEligibility(value: unknown, label: string): void {
	const eligibility = exactRecord(value, label, ["allowed_actions", "forbidden_actions"]);
	array(eligibility.allowed_actions, `${label}.allowed_actions`, (entry, entryLabel) => {
		const action = exactRecord(entry, entryLabel, ["action", "reason_code", "required_inputs"], ["disposition", "binding"]);
		const selected = enumeration(action.action, ELIGIBLE_ACTIONS, `${entryLabel}.action`);
		text(action.reason_code, `${entryLabel}.reason_code`, { minimum: 1, pattern: /^[a-z0-9_]+$/ });
		array(action.required_inputs, `${entryLabel}.required_inputs`, (input, inputLabel) => text(input, inputLabel, { minimum: 1, pattern: /^[a-z0-9_]+$/ }), { unique: true });
		if (selected === "review.recover") {
			const binding = exactRecord(action.binding, `${entryLabel}.binding`, ["lineage_id", "revision", "target_identity"]);
			enumeration(action.disposition, Object.values(REVIEW_STATUS_ACTION_DISPOSITION), `${entryLabel}.disposition`);
			lineage(binding.lineage_id, `${entryLabel}.binding.lineage_id`);
			sha256(binding.revision, `${entryLabel}.binding.revision`);
			sha256(binding.target_identity, `${entryLabel}.binding.target_identity`);
		} else if (action.disposition !== undefined || action.binding !== undefined) {
			throw new TypeError(`${entryLabel} recovery fields require review.recover`);
		}
		return action;
	}, { minimum: 1, maximum: 1 });
	array(eligibility.forbidden_actions, `${label}.forbidden_actions`, (entry, entryLabel) => {
		const action = exactRecord(entry, entryLabel, ["action", "reason_code"]);
		enumeration(action.action, FORBIDDEN_ACTIONS, `${entryLabel}.action`);
		text(action.reason_code, `${entryLabel}.reason_code`, { minimum: 1, pattern: /^[a-z0-9_]+$/ });
		return action;
	});
}

// ---------------------------------------------------------------------------
// status/v3
// ---------------------------------------------------------------------------

export function decodeReviewStatusV3(value: unknown): ReviewStatusV3 {
	// Additive forward acceptance: status/v5 (gentle-ai main; ground-truthed
	// against a live capture and the vendored status-v5.schema.json) is the v3
	// key set plus the optional forecast and the v5-only next_transition
	// surfaces. status/v6 adds the intended-untracked selection; status/v7
	// (gentle-ai v2.6.0, advertised through capabilities/v2.5 alongside v6)
	// adds optional `eligible_untracked_inventory` and escalation metadata,
	// so it is decoded on the v6 surface. status/v8 (gentle-ai main, PR #4765;
	// the current released contract) only extended the reviewer-result
	// transition for OpenCode provider tasks -- no new top-level key -- so it
	// decodes on the exact v7 surface too. status/v9 (the sibling gentle-ai
	// branch's contract, ahead of the released v8) adds nothing at this top
	// level either: its one addition is the host-mediated role `submission`
	// on a next_transition.collect input (gentle-pi#311 P3), gated on v9 in
	// decodeCollectInput, not here. v3 keeps rejecting every
	// v5/v6/v7/v8/v9-only field.
	const schema = typeof value === "object" && value !== null ? (value as Record<string, unknown>).schema : undefined;
	const v9 = schema === "gentle-ai.review-integration.status/v9";
	const v8 = v9 || schema === "gentle-ai.review-integration.status/v8";
	const v7 = v8 || schema === "gentle-ai.review-integration.status/v7";
	const v6 = v7 || schema === "gentle-ai.review-integration.status/v6";
	const v5 = v6 || schema === "gentle-ai.review-integration.status/v5";
	const body = exactRecord(value, "status", [
		"schema", "contract", "operation", "applicability", "action", "replayability", "target_identity", "projection", "repair", "candidates",
	], ["authority", "frozen", "action_disposition", "eligibility", "next_transition", "authority_target_identity", ...(v5 ? ["receipt", "forecast", "repository_context", "validation_request"] : []), ...(v7 ? ["eligible_untracked_inventory", "escalation"] : [])]);
	requireIdentity(body, v9 ? "gentle-ai.review-integration.status/v9" : v8 ? "gentle-ai.review-integration.status/v8" : v7 ? "gentle-ai.review-integration.status/v7" : v6 ? "gentle-ai.review-integration.status/v6" : v5 ? "gentle-ai.review-integration.status/v5" : "gentle-ai.review-integration.status/v3", REVIEW_INTEGRATION_OPERATION.STATUS);

	const applicability = enumeration(body.applicability, ["current_target", "unrelated", "ambiguous", "corrupted"] as const, "status.applicability");
	let receipt: ReviewStatusReceiptV1 | undefined;
	if (body.receipt !== undefined) {
		const source = exactRecord(body.receipt, "status.receipt", ["status"], ["identity"]);
		receipt = {
			status: enumeration(source.status, RECEIPT_STATUSES, "status.receipt.status"),
			...(source.identity === undefined ? {} : { identity: sha256(source.identity, "status.receipt.identity") }),
		};
	}
	let authority: ReviewStatusAuthorityV1 | undefined;
	if (body.authority !== undefined) {
		const source = exactRecord(body.authority, "status.authority", ["version", "lineage_id", "state", "generation", "revision"]);
		authority = {
			version: enumeration(source.version, Object.values(REVIEW_AUTHORITY_VERSION), "status.authority.version"),
			lineageId: lineage(source.lineage_id, "status.authority.lineage_id"),
			state: nonempty(source.state, "status.authority.state"),
			generation: integer(source.generation, "status.authority.generation", 1),
			revision: sha256(source.revision, "status.authority.revision"),
		};
	}
	if (applicability === REVIEW_AUTHORITY_APPLICABILITY.CURRENT_TARGET && authority === undefined) throw new TypeError("current_target status requires authority");
	if (applicability !== REVIEW_AUTHORITY_APPLICABILITY.CURRENT_TARGET && (authority !== undefined || body.frozen !== undefined || body.authority_target_identity !== undefined)) {
		throw new TypeError("non-current status cannot expose authority, frozen, or authority_target_identity");
	}

	let frozen: ReviewStatusFrozenV1 | undefined;
	if (body.frozen !== undefined) {
		const source = exactRecord(body.frozen, "status.frozen", ["tier", "original_changed_lines", "correction_budget"], ["changed_path_manifest_sha256"]);
		frozen = {
			tier: enumeration(source.tier, RISK_LEVELS, "status.frozen.tier"),
			originalChangedLines: integer(source.original_changed_lines, "status.frozen.original_changed_lines"),
			correctionBudget: integer(source.correction_budget, "status.frozen.correction_budget", 0, 200),
			...(source.changed_path_manifest_sha256 === undefined ? {} : { changedPathManifestSha256: sha256(source.changed_path_manifest_sha256, "status.frozen.changed_path_manifest_sha256") }),
		};
	}
	if (authority?.version === REVIEW_AUTHORITY_VERSION.COMPACT_V2 && frozen === undefined) throw new TypeError("compact-v2 status requires frozen metadata");
	if (authority?.version === REVIEW_AUTHORITY_VERSION.LEGACY_V1 && (frozen !== undefined || body.authority_target_identity !== undefined)) throw new TypeError("legacy status cannot expose frozen metadata or authority_target_identity");
	if (authority?.version === REVIEW_AUTHORITY_VERSION.LEGACY_V1 && receipt !== undefined && receipt.status !== "expected_missing" && receipt.status !== "present") {
		throw new TypeError("legacy status receipt is incompatible");
	}

	const action = enumeration(body.action, STATUS_ACTIONS, "status.action");
	const actionDisposition = body.action_disposition === undefined ? undefined : enumeration(body.action_disposition, Object.values(REVIEW_STATUS_ACTION_DISPOSITION), "status.action_disposition");
	if (action === "recover" && actionDisposition === undefined) throw new TypeError("recover status requires action_disposition");
	if (action !== "recover" && actionDisposition !== undefined) throw new TypeError("status.action_disposition is only valid for the recover action");
	if (body.eligibility !== undefined) decodeEligibility(body.eligibility, "status.eligibility");
	const nextTransition = body.next_transition === undefined ? undefined : decodeReviewNextTransitionV3(body.next_transition, { v5, v6, v9 });
	const validationRequest = v5 && body.validation_request !== undefined
		? decodeReviewTargetedValidationRequestV1(body.validation_request, "status.validation_request")
		: undefined;
	if (validationRequest !== undefined) {
		const collectInputs = nextTransition?.kind === "collect" ? nextTransition.collect?.inputs ?? [] : [];
		const matchingInputs = collectInputs.filter((input) => input.validationRequest !== undefined);
		if (matchingInputs.length !== 1 || canonicalJson(matchingInputs[0]!.validationRequest) !== canonicalJson(validationRequest)) {
			throw new TypeError("status.validation_request must exactly match the provider-targeted-validator collect input");
		}
	}
	// status/v5 dependentRequired: a forecast previews the transition head, so
	// it can only accompany an actual next_transition.
	const forecast = v5 && body.forecast !== undefined ? decodeReviewForecastV1(body.forecast) : undefined;
	if (forecast !== undefined && nextTransition === undefined) throw new TypeError("status.forecast requires status.next_transition");
	const replayability = enumeration(body.replayability, Object.values(REVIEW_REPLAYABILITY), "status.replayability");

	// status/v5 additive top-level repository context reference (captured
	// 2026-08-16 from 2.4.0-main.b1afef46; missing from the published
	// status-v5.schema.json, so the live capture is authoritative). Same
	// reference shape as start/v3's repository_context.
	let repositoryContext: ReviewRepositoryContextV2 | undefined;
	if (body.repository_context !== undefined) {
		const source = exactRecord(body.repository_context, "status.repository_context", ["capability", "handle", "revision", "target_identity"], ["event_id", "outcome"]);
		if (source.capability !== "review.opaque_repository_context") throw new TypeError("status.repository_context.capability is unsupported");
		repositoryContext = {
			capability: "review.opaque_repository_context",
			handle: text(source.handle, "status.repository_context.handle", { pattern: /^rctx[12]_[0-9a-f]{64}$/ }),
			revision: sha256(source.revision, "status.repository_context.revision"),
			targetIdentity: sha256(source.target_identity, "status.repository_context.target_identity"),
			...(source.event_id === undefined ? {} : { eventId: sha256(source.event_id, "status.repository_context.event_id") }),
			...(source.outcome === undefined ? {} : { outcome: enumeration(source.outcome, REPOSITORY_CONTEXT_OUTCOMES, "status.repository_context.outcome") }),
		};
	}

	let escalation: ReviewEscalationV1 | undefined;
	if (Object.hasOwn(body, "escalation")) {
		const label = "status.escalation";
		const source = exactRecord(body.escalation, label, ["cause", "finding_ids"], ["refuter_outcomes"]);
		escalation = {
			cause: enumeration(source.cause, ESCALATION_CAUSES, `${label}.cause`),
			findingIds: stringArray(source.finding_ids, `${label}.finding_ids`),
		};
		if (Object.hasOwn(source, "refuter_outcomes")) escalation.refuterOutcomes = array(source.refuter_outcomes, `${label}.refuter_outcomes`, (entry, itemLabel) => {
			const row = exactRecord(entry, itemLabel, ["finding_id", "outcome", "proof"]);
			return {
				findingId: nonempty(row.finding_id, `${itemLabel}.finding_id`),
				outcome: enumeration(row.outcome, ESCALATION_REFUTER_OUTCOMES, `${itemLabel}.outcome`),
				proof: nonempty(row.proof, `${itemLabel}.proof`),
			};
		});
	}

	// status/v7 top-level optional digest (gentle-ai v2.6.0): resolves #4066's
	// closed loop where `sdd-attempt finish` named a digest status never
	// published. Absent on the `staged` projection, which never resolves an
	// inventory, so it stays structurally optional rather than a required v7
	// field.
	const eligibleUntrackedInventory = v7 && body.eligible_untracked_inventory !== undefined
		? sha256(body.eligible_untracked_inventory, "status.eligible_untracked_inventory")
		: undefined;

	return {
		contract: REVIEW_INTEGRATION_CONTRACT,
		applicability,
		...(authority === undefined ? {} : { authority }),
		...(receipt === undefined ? {} : { receipt }),
		action,
		...(actionDisposition === undefined ? {} : { actionDisposition }),
		replayability,
		...(frozen === undefined ? {} : { frozen }),
		targetIdentity: sha256(body.target_identity, "status.target_identity"),
		...(body.authority_target_identity === undefined ? {} : { authorityTargetIdentity: sha256(body.authority_target_identity, "status.authority_target_identity") }),
		projection: decodeReviewProjectionV1(body.projection),
		repair: decodeAuthorityRepairAssessmentV1(body.repair),
		candidates: stringArray(body.candidates, "status.candidates", { unique: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ }),
		...(nextTransition === undefined ? {} : { nextTransition }),
		...(forecast === undefined ? {} : { forecast }),
		...(repositoryContext === undefined ? {} : { repositoryContext }),
		...(validationRequest === undefined ? {} : { validationRequest }),
		...(escalation === undefined ? {} : { escalation }),
		...(eligibleUntrackedInventory === undefined ? {} : { eligibleUntrackedInventory }),
		raw: body,
	};
}

// ---------------------------------------------------------------------------
// consent/v2 — net-new. The typed per-candidate blocking consent question
// emitted by negotiated v2 START when the caller declared --consent relay.
// ---------------------------------------------------------------------------

function decodeConsentChoice(value: unknown, label: string, answer: "granted" | "declined"): ReviewConsentChoiceV2 {
	const body = exactRecord(value, label, ["answer", "label", "effect", "invocation"]);
	if (body.answer !== answer) throw new TypeError(`${label}.answer must be ${answer}`);
	return {
		answer,
		label: nonempty(body.label, `${label}.label`),
		effect: nonempty(body.effect, `${label}.effect`),
		invocation: text(body.invocation, `${label}.invocation`, { pattern: new RegExp(`^gentle-ai review start --contract gentle-ai\\.review-integration/v2 .* --consent ${answer}$`) }),
	};
}

// The semantic surface shared verbatim by both accepted consent identities.
// Every label and guard predates consent/v3, so the v2 decode stays
// byte-identical (test-locked) while v3 adds only its own identity gate.
function decodeConsentSemantics(body: Record<string, unknown>): Omit<ReviewConsentV2, "schema" | "raw"> {
	if (body.action !== "consent_required") throw new TypeError("consent.action must be consent_required");
	if (body.blocking !== true) throw new TypeError("consent.blocking must be true");

	const targetIdentity = sha256(body.target_identity, "consent.target_identity");
	const choicesArray = body.choices;
	if (!Array.isArray(choicesArray) || choicesArray.length !== 2) throw new TypeError("consent.choices must have exactly 2 items");
	const granted = decodeConsentChoice(choicesArray[0], "consent.choices[0]", "granted");
	const declined = decodeConsentChoice(choicesArray[1], "consent.choices[1]", "declined");
	for (const choice of [granted, declined]) {
		if (!choice.invocation.includes(` --target ${targetIdentity} `)) throw new TypeError(`consent choice ${choice.answer} invocation must bind consent.target_identity`);
	}

	const offPathSource = exactRecord(body.off_path, "consent.off_path", ["note", "command"]);
	if (offPathSource.command !== "gentle-ai review mode disable") throw new TypeError("consent.off_path.command is unsupported");

	return {
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.start",
		action: "consent_required",
		blocking: true,
		targetIdentity,
		projection: enumeration(body.projection, REQUIRED_PROJECTIONS, "consent.projection"),
		riskLevel: enumeration(body.risk_level, ["medium", "high"] as const, "consent.risk_level"),
		changedFiles: integer(body.changed_files, "consent.changed_files"),
		changedLines: integer(body.changed_lines, "consent.changed_lines"),
		headline: nonempty(body.headline, "consent.headline"),
		reason: nonempty(body.reason, "consent.reason"),
		value: nonempty(body.value, "consent.value"),
		riskEvidence: stringArray(body.risk_evidence, "consent.risk_evidence"),
		choices: [granted, declined],
		offPath: { note: nonempty(offPathSource.note, "consent.off_path.note"), command: "gentle-ai review mode disable" },
	};
}

const CONSENT_KEYS_V2 = Object.freeze([
	"schema", "contract", "operation", "action", "blocking", "target_identity", "projection", "risk_level", "changed_files", "changed_lines", "headline", "reason", "value", "risk_evidence", "choices", "off_path",
] as const);

export function decodeReviewConsentV2(value: unknown): ReviewConsentV2 {
	const body = exactRecord(value, "consent", CONSENT_KEYS_V2);
	requireIdentity(body, "gentle-ai.review-integration.consent/v2", "review.start");
	return {
		schema: "gentle-ai.review-integration.consent/v2",
		...decodeConsentSemantics(body),
		raw: body,
	};
}

// consent/v3 (gentle-ai >= 2.3.0): the v2 surface plus the required, fixed
// `agent` runtime binding. Ground truth is the captured envelope from a
// 2.4.0-main binary (tests/fixtures/devbinary/consent-v3.captured.json) plus
// gentle-ai main contracts/review-integration/v2/schemas/consent-v3.schema.json.
// The choice-invocation shape deliberately stays the shared v2 pattern: the
// published v3 schema demands an `--agent claude-code` token that the live
// emitter omits when the caller declared no --agent, so the capture is
// authoritative and Pi replays whichever provider-owned invocation arrived.
export function decodeReviewConsentV3(value: unknown, expectedAgent?: ReviewConsentAgentV3): ReviewConsentV3 {
	const body = exactRecord(value, "consent", [...CONSENT_KEYS_V2, "agent"]);
	requireIdentity(body, "gentle-ai.review-integration.consent/v3", "review.start");
	const agent = enumeration(body.agent, Object.values(REVIEW_CONSENT_AGENT_V3), "consent.agent") as ReviewConsentAgentV3;
	if (expectedAgent !== undefined && agent !== expectedAgent) throw new TypeError("consent.agent does not match the expected runtime binding");
	return {
		schema: "gentle-ai.review-integration.consent/v3",
		agent,
		...decodeConsentSemantics(body),
		raw: body,
	};
}

// ---------------------------------------------------------------------------
// failure/v2
// ---------------------------------------------------------------------------

function decodeOptionalSha256(value: unknown, label: string): string {
	if (value === "") return "";
	return sha256(value, label);
}

function decodeFailureBindingRevision(value: unknown, label: string): ReviewFailureBindingRevisionV1 {
	const body = exactRecord(value, label, ["expected", "current"]);
	return { expected: decodeOptionalSha256(body.expected, `${label}.expected`), current: decodeOptionalSha256(body.current, `${label}.current`) };
}

function decodeFailureTargetEvidence(value: unknown, label: string): ReviewFailureTargetEvidenceV1 {
	const evidence = exactRecord(value, label, ["candidate_tree", "paths_digest"]);
	return {
		candidateTree: gitTree(evidence.candidate_tree, `${label}.candidate_tree`),
		pathsDigest: sha256(evidence.paths_digest, `${label}.paths_digest`),
	};
}

function decodeFailureScopeChange(value: unknown, label: string): ReviewFailureScopeChangeV1 {
	const scope = exactRecord(value, label, ["expected", "actual", "differing_path_count", "differing_paths_digest", "predecessor_lineage_id", "predecessor_revision", "recovery_operation", "recovery_required_inputs"]);
	if (scope.recovery_operation !== "review.recover") throw new TypeError(`${label}.recovery_operation is unsupported`);
	const recoveryInputs = stringArray(scope.recovery_required_inputs, `${label}.recovery_required_inputs`, { minimum: 6, maximum: 6 });
	const expectedRecoveryInputs = ["predecessor_lineage_id", "expected_predecessor_revision", "successor_lineage_id", "disposition", "reason", "actor"];
	if (recoveryInputs.some((input, index) => input !== expectedRecoveryInputs[index])) throw new TypeError(`${label}.recovery_required_inputs is unsupported`);
	return {
		expected: decodeFailureTargetEvidence(scope.expected, `${label}.expected`),
		actual: decodeFailureTargetEvidence(scope.actual, `${label}.actual`),
		differingPathCount: integer(scope.differing_path_count, `${label}.differing_path_count`, 0, 1_000_000),
		differingPathsDigest: sha256(scope.differing_paths_digest, `${label}.differing_paths_digest`),
		predecessorLineageId: lineage(scope.predecessor_lineage_id, `${label}.predecessor_lineage_id`),
		predecessorRevision: sha256(scope.predecessor_revision, `${label}.predecessor_revision`),
		recoveryOperation: "review.recover",
		recoveryRequiredInputs: recoveryInputs,
	};
}

// The mirrored gate_context is `oneOf` [scope_change, binding_revision]. v1's
// decoder only ever implemented scope_change; this decoder implements both
// branches so a legitimate binding_revision failure payload is not rejected.
function decodeFailureContext(value: unknown, label: string): ReviewFailureContextV2 {
	const context = exactRecord(value, label, [], ["scope_change", "binding_revision"]);
	const hasScope = context.scope_change !== undefined;
	const hasBinding = context.binding_revision !== undefined;
	if (hasScope === hasBinding) throw new TypeError(`${label} requires exactly one of scope_change or binding_revision`);
	return {
		...(hasScope ? { scopeChange: decodeFailureScopeChange(context.scope_change, `${label}.scope_change`) } : {}),
		...(hasBinding ? { bindingRevision: decodeFailureBindingRevision(context.binding_revision, `${label}.binding_revision`) } : {}),
	};
}

export function decodeReviewFailureV2(value: unknown): ReviewFailureV2 {
	const body = exactRecord(value, "failure", [
		"schema", "contract", "operation", "phase", "code", "message", "mutation_outcome", "authority_applicability", "retry_safe", "replayability", "required_inputs", "next_action",
	], ["lineage_id", "request_digest", "progress_identity", "cause_category", "cause", "context", "continuation"]);
	requireIdentity(body, "gentle-ai.review-integration.failure/v2");
	const operation = enumeration(body.operation, FAILURE_OPERATIONS, "failure.operation");
	const code = text(body.code, "failure.code", { pattern: /^[a-z0-9]+(?:_[a-z0-9]+)*$/ });

	if (body.progress_identity !== undefined) {
		if (body.lineage_id === undefined || body.request_digest === undefined) throw new TypeError("failure.progress_identity requires lineage_id and request_digest");
		if (operation !== REVIEW_INTEGRATION_OPERATION.REPAIR) throw new TypeError("failure.progress_identity requires operation review.repair");
	}
	if (body.request_digest !== undefined && operation === REVIEW_INTEGRATION_OPERATION.REPAIR && body.progress_identity === undefined) {
		throw new TypeError("failure.request_digest with review.repair requires progress_identity");
	}
	// gentle-pi#627: continuation is optional on every version — an older
	// gentle-ai may emit managed_assets_outdated with no continuation, and
	// decode must not refuse the whole envelope for that. When present it is
	// only valid on this exact code.
	if (body.continuation !== undefined && code !== "managed_assets_outdated") throw new TypeError("failure.continuation is only valid for code managed_assets_outdated");

	return {
		schema: "gentle-ai.review-integration.failure/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation,
		phase: enumeration(body.phase, ["preflight", "pre_native", "native_running", "native_committed", "reconciliation"] as const, "failure.phase"),
		code,
		message: text(body.message, "failure.message", { minimum: 1, maximum: 240, pattern: /^[^\r\n]+$/ }),
		mutationOutcome: enumeration(body.mutation_outcome, Object.values(REVIEW_MUTATION_OUTCOME), "failure.mutation_outcome"),
		authorityApplicability: enumeration(body.authority_applicability, Object.values(REVIEW_AUTHORITY_APPLICABILITY), "failure.authority_applicability"),
		retrySafe: boolean(body.retry_safe, "failure.retry_safe"),
		replayability: enumeration(body.replayability, Object.values(REVIEW_REPLAYABILITY), "failure.replayability"),
		...(body.lineage_id === undefined ? {} : { lineageId: lineage(body.lineage_id, "failure.lineage_id") }),
		...(body.request_digest === undefined ? {} : { requestDigest: sha256(body.request_digest, "failure.request_digest") }),
		...(body.progress_identity === undefined ? {} : { progressIdentity: sha256(body.progress_identity, "failure.progress_identity") }),
		requiredInputs: enumArray(body.required_inputs, FAILURE_REQUIRED_INPUTS, "failure.required_inputs", { unique: true }),
		nextAction: enumeration(body.next_action, FAILURE_NEXT_ACTIONS, "failure.next_action"),
		...(body.cause_category === undefined ? {} : { causeCategory: text(body.cause_category, "failure.cause_category", { minimum: 1, pattern: /^[a-z0-9]+(?:_[a-z0-9]+)*$/ }) }),
		...(body.cause === undefined ? {} : { cause: text(body.cause, "failure.cause", { minimum: 1, maximum: 4000, pattern: /^[^\r\n]+$/ }) }),
		...(body.context === undefined ? {} : { context: decodeFailureContext(body.context, "failure.context") }),
		...(body.continuation === undefined ? {} : { continuation: decodeReviewManagedAssetsContinuationV1(body.continuation, "failure.continuation") }),
		raw: body,
	};
}

// ---------------------------------------------------------------------------
// operation/v2
// ---------------------------------------------------------------------------

export function decodeReviewAdvisoryFindingsV1(value: unknown, label: string): ReviewAdvisoryFindingsV1 {
	const body = exactRecord(value, label, ["statement", "findings"]);
	return {
		statement: nonempty(body.statement, `${label}.statement`),
		findings: array(body.findings, `${label}.findings`, (entry, itemLabel) => {
			const finding = exactRecord(entry, itemLabel, ["id", "severity", "disposition"], ["lens", "location"]);
			return {
				id: nonempty(finding.id, `${itemLabel}.id`),
				...(finding.lens === undefined ? {} : { lens: nonempty(finding.lens, `${itemLabel}.lens`) }),
				...(finding.location === undefined ? {} : { location: nonempty(finding.location, `${itemLabel}.location`) }),
				severity: enumeration(finding.severity, Object.values(REVIEW_ADVISORY_FINDING_SEVERITY), `${itemLabel}.severity`),
				disposition: enumeration(finding.disposition, Object.values(REVIEW_ADVISORY_FINDING_DISPOSITION), `${itemLabel}.disposition`),
			};
		}, { minimum: 1 }),
	};
}

// ---------------------------------------------------------------------------
// repair/v2 — net-new. Encodes the two conditional allOf invariants from v1
// repair.schema.json:53-157: execute mode requires execution (and forbids
// provider_inputs / non-empty required_inputs); an eligible preflight
// assessment requires provider_inputs and required_inputs exactly
// [actor, reason, maintainer_authorization] in that order.
// ---------------------------------------------------------------------------

export function decodeReviewRepairV2(value: unknown): ReviewRepairV2 {
	const body = exactRecord(value, "repair", ["schema", "contract", "operation", "mode", "assessment", "required_inputs"], ["provider_inputs", "execution"]);
	requireIdentity(body, "gentle-ai.review-integration.repair/v2", "review.repair");
	const mode = enumeration(body.mode, ["preflight", "execute"] as const, "repair.mode");
	const assessment = decodeAuthorityRepairAssessmentV1(body.assessment);
	const requiredInputs = enumArray(body.required_inputs, ["actor", "reason", "maintainer_authorization"] as const, "repair.required_inputs", { maximum: 3, unique: true });

	if (mode === "execute") {
		if (body.execution === undefined) throw new TypeError("repair execute mode requires execution");
		if (body.provider_inputs !== undefined) throw new TypeError("repair execute mode cannot expose provider_inputs");
		if (requiredInputs.length !== 0) throw new TypeError("repair execute mode requires an empty required_inputs");
	} else if (body.execution !== undefined) {
		throw new TypeError("repair.execution is only valid for execute mode");
	}

	let providerInputs: ReviewRepairProviderInputsV2 | undefined;
	if (mode === "preflight" && assessment.status === "eligible") {
		if (body.provider_inputs === undefined) throw new TypeError("eligible preflight repair requires provider_inputs");
		if (requiredInputs.length !== 3 || requiredInputs[0] !== "actor" || requiredInputs[1] !== "reason" || requiredInputs[2] !== "maintainer_authorization") {
			throw new TypeError("eligible preflight repair requires required_inputs exactly [actor, reason, maintainer_authorization] in order");
		}
		const source = exactRecord(body.provider_inputs, "repair.provider_inputs", ["class", "lineage_id", "expected_revision", "cause", "disposition", "repository_binding", "authorization_schema"]);
		if (source.class !== "legacy_v1_historical_alias") throw new TypeError("repair.provider_inputs.class is unsupported");
		if (source.cause !== "unsupported_historical_v1_operation_alias") throw new TypeError("repair.provider_inputs.cause is unsupported");
		if (source.disposition !== "quarantine-approved-historical-alias") throw new TypeError("repair.provider_inputs.disposition is unsupported");
		if (source.authorization_schema !== "gentle-ai.review-repair-authorization/v1") throw new TypeError("repair.provider_inputs.authorization_schema is unsupported");
		providerInputs = {
			class: "legacy_v1_historical_alias",
			lineageId: lineage(source.lineage_id, "repair.provider_inputs.lineage_id"),
			expectedRevision: sha256(source.expected_revision, "repair.provider_inputs.expected_revision"),
			cause: "unsupported_historical_v1_operation_alias",
			disposition: "quarantine-approved-historical-alias",
			repositoryBinding: sha256(source.repository_binding, "repair.provider_inputs.repository_binding"),
			authorizationSchema: "gentle-ai.review-repair-authorization/v1",
		};
	} else if (mode === "preflight") {
		if (body.provider_inputs !== undefined) throw new TypeError("repair.provider_inputs is only valid for an eligible preflight assessment");
		if (requiredInputs.length !== 0) throw new TypeError("non-eligible preflight repair requires an empty required_inputs");
	}

	let execution: ReviewRepairExecutionV2 | undefined;
	if (body.execution !== undefined) {
		const source = exactRecord(body.execution, "repair.execution", ["status", "class", "lineage_id", "revision", "chain_identity", "cause", "disposition", "assessment_digest", "request_digest", "record_identity"]);
		if (source.status !== "committed") throw new TypeError("repair.execution.status must be committed");
		if (source.class !== "legacy_v1_historical_alias") throw new TypeError("repair.execution.class is unsupported");
		if (source.cause !== "unsupported_historical_v1_operation_alias") throw new TypeError("repair.execution.cause is unsupported");
		if (source.disposition !== "quarantine-approved-historical-alias") throw new TypeError("repair.execution.disposition is unsupported");
		execution = {
			status: "committed",
			class: "legacy_v1_historical_alias",
			lineageId: lineage(source.lineage_id, "repair.execution.lineage_id"),
			revision: sha256(source.revision, "repair.execution.revision"),
			chainIdentity: sha256(source.chain_identity, "repair.execution.chain_identity"),
			cause: "unsupported_historical_v1_operation_alias",
			disposition: "quarantine-approved-historical-alias",
			assessmentDigest: sha256(source.assessment_digest, "repair.execution.assessment_digest"),
			requestDigest: sha256(source.request_digest, "repair.execution.request_digest"),
			recordIdentity: sha256(source.record_identity, "repair.execution.record_identity"),
		};
	}

	return {
		schema: "gentle-ai.review-integration.repair/v2",
		contract: REVIEW_INTEGRATION_CONTRACT,
		operation: "review.repair",
		mode,
		assessment,
		...(providerInputs === undefined ? {} : { providerInputs }),
		requiredInputs,
		...(execution === undefined ? {} : { execution }),
		raw: body,
	};
}

// ---------------------------------------------------------------------------
// result-artifact/v2 — the `review capture-result` admission answer
// ---------------------------------------------------------------------------

// The provider's admitted-reviewer-result envelope, printed by `review
// capture-result` when a reviewer result is admitted and re-discovered by
// STATUS artifact discovery. Unlike the negotiated envelopes above it carries
// no `contract`/`operation` identity pair — the schema constant plus the
// capability constant are its complete identity (vendored ground truth:
// contracts/review-integration/v1/schemas/result-artifact-v2.schema.json,
// confirmed against a live 2.4.0-main capture; the v2.2.3 pinned emitter
// shares the exact same struct). Exactly one locator is present: a
// provider-owned store `path`, or the opaque `rart1_` `reference` minted for
// repository-context captures.
export interface ReviewResultArtifactV2 {
	schema: "gentle-ai.review-result-artifact/v2";
	capability: "review.native_result_artifact";
	sha256: string;
	lineageId: string;
	targetIdentity: string;
	lens: (typeof REVIEW_LENSES)[number];
	selectedOrder: number;
	subjectHash: string;
	admissionDecision: "completed";
	path?: string;
	reference?: string;
	raw: Record<string, unknown>;
}

export function decodeReviewResultArtifactV2(value: unknown): ReviewResultArtifactV2 {
	const body = exactRecord(value, "result_artifact", ["schema", "capability", "sha256", "lineage_id", "target_identity", "lens", "selected_order", "subject_hash", "admission_decision"], ["path", "reference"]);
	if (body.schema !== "gentle-ai.review-result-artifact/v2") throw new TypeError("result_artifact.schema must be gentle-ai.review-result-artifact/v2");
	if (body.capability !== "review.native_result_artifact") throw new TypeError("result_artifact.capability must be review.native_result_artifact");
	if (body.admission_decision !== "completed") throw new TypeError("result_artifact.admission_decision must be completed");
	if ((body.path === undefined) === (body.reference === undefined)) throw new TypeError("result_artifact must carry exactly one of path or reference");
	return {
		schema: "gentle-ai.review-result-artifact/v2",
		capability: "review.native_result_artifact",
		sha256: sha256(body.sha256, "result_artifact.sha256"),
		lineageId: lineage(body.lineage_id, "result_artifact.lineage_id"),
		targetIdentity: sha256(body.target_identity, "result_artifact.target_identity"),
		lens: enumeration(body.lens, REVIEW_LENSES, "result_artifact.lens"),
		selectedOrder: integer(body.selected_order, "result_artifact.selected_order", 0, 3),
		subjectHash: sha256(body.subject_hash, "result_artifact.subject_hash"),
		admissionDecision: "completed",
		...(body.path === undefined ? {} : { path: nonempty(body.path, "result_artifact.path") }),
		...(body.reference === undefined ? {} : { reference: text(body.reference, "result_artifact.reference", { pattern: /^rart1_[0-9a-f]{64}$/ }) }),
		raw: body,
	};
}

// Terminal capture answers are emitted directly by the native provider. Pi
// validates their closed shape and identity, then treats all lifecycle meaning
// as opaque provider-owned state.
export const REVIEW_LAST_EVENT_CLOSURE_SCHEMA = "gentle-ai.review-last-event-closure/v1";
export const REVIEW_LAST_EVENT_CLOSURE_OPERATION = {
	CAPTURE_RESULT: "review/capture-result",
	CAPTURE_CORRECTION_PLAN: "review.capture-correction-plan",
	CAPTURE_REFUTER: "review.capture-refuter",
	CAPTURE_VALIDATION: "review/capture-validation",
} as const;
export type ReviewLastEventClosureOperation = (typeof REVIEW_LAST_EVENT_CLOSURE_OPERATION)[keyof typeof REVIEW_LAST_EVENT_CLOSURE_OPERATION];

const REVIEW_LAST_EVENT_TERMINAL_STATES = ["approved", "correction_required", "escalated"] as const;
export type ReviewLastEventClosureState = (typeof REVIEW_LAST_EVENT_TERMINAL_STATES)[number];

const REVIEW_STATUS_CONTINUATION_OPERATION = {
	STATUS: "review.status",
} as const;

export interface ReviewStatusContinuationBindingV1 {
	targetIdentity: string;
	lineageId?: string;
	revision?: string;
	repositoryContext?: string;
}

export interface ReviewStatusContinuationArtifactV1 {
	schema: "gentle-ai.review-result-artifact/v2";
	capability: "review.native_result_artifact";
	sha256: string;
	lineageId: string;
	targetIdentity: string;
	lens: string;
	selectedOrder: number;
	subjectHash: string;
	admissionDecision: "completed";
}

export interface ReviewStatusContinuationV1 {
	operation: typeof REVIEW_STATUS_CONTINUATION_OPERATION.STATUS;
	arguments: readonly ReviewTransitionArgumentV3[];
	selectorArguments?: readonly ReviewTransitionArgumentV3[];
	preconditions: readonly ReviewTransitionArgumentV3[];
	binding: ReviewStatusContinuationBindingV1;
	artifacts?: readonly ReviewStatusContinuationArtifactV1[];
	command?: string;
	raw: Record<string, unknown>;
}

const REVIEW_APPROVED_ACKNOWLEDGEMENT_OPERATION = "review.acknowledge-approved" as const;

// The exact ordered argument names the provider renders for one approved
// acknowledgement. The list is closed and positional on the wire, so decoding
// by position is what proves the relay is replaying the provider's own
// invocation rather than one the host assembled.
const REVIEW_APPROVED_ACKNOWLEDGEMENT_ARGUMENTS = ["cwd", "lineage", "target", "expected-revision", "token"] as const;

export interface ReviewApprovedAcknowledgementBindingV1 {
	lineageId: string;
	revision: string;
	targetIdentity: string;
	repositoryContext?: string;
}

export interface ReviewApprovedAcknowledgementV1 {
	operation: typeof REVIEW_APPROVED_ACKNOWLEDGEMENT_OPERATION;
	command: string;
	arguments: readonly ReviewTransitionArgumentV3[];
	preconditions: readonly ReviewTransitionArgumentV3[];
	binding: ReviewApprovedAcknowledgementBindingV1;
	raw: Record<string, unknown>;
}

export interface ReviewApprovedAcknowledgementExecuteExpectationV1 { cwd?: string; lineageId?: string; targetIdentity?: string; revision?: string; }

export type ReviewApprovedAcknowledgementExecuteTokensV1 = readonly [string, string, string, string, string];

interface ReviewApprovedAcknowledgementExecuteShapeV1 { tokens: ReviewApprovedAcknowledgementExecuteTokensV1; values: readonly [string, string, string, string, string]; lineageId: string; targetIdentity: string; revision: string; }

function assertReviewApprovedAcknowledgementExecuteShapeV1(execute: ReviewNextTransitionExecuteV3): ReviewApprovedAcknowledgementExecuteShapeV1 {
	if (execute.operation !== REVIEW_APPROVED_ACKNOWLEDGEMENT_OPERATION) throw new TypeError(`acknowledgement.execute.operation must be ${REVIEW_APPROVED_ACKNOWLEDGEMENT_OPERATION}`);
	if (execute.command === undefined) throw new TypeError("acknowledgement.execute.command is required");
	text(execute.command, "acknowledgement.execute.command", { minimum: 1, pattern: /^gentle-ai review acknowledge-approved(?: |$)/ });
	if (execute.arguments.length !== REVIEW_APPROVED_ACKNOWLEDGEMENT_ARGUMENTS.length) throw new TypeError(`acknowledgement.execute.arguments must carry exactly ${REVIEW_APPROVED_ACKNOWLEDGEMENT_ARGUMENTS.length} provider-issued arguments`);
	const values = execute.arguments.map((argument, index) => { const name = REVIEW_APPROVED_ACKNOWLEDGEMENT_ARGUMENTS[index]!; if (argument.name !== name) throw new TypeError(`acknowledgement.execute.arguments[${index}].name must be ${name}`); const value = nonempty(argument.value, `acknowledgement.execute.arguments[${index}].value`); if (nonempty(argument.token, `acknowledgement.execute.arguments[${index}].token`) !== `--${name}=${value}`) throw new TypeError(`acknowledgement.execute.arguments[${index}].token must exactly match ${name}`); return value; });
	if (execute.preconditions.length !== 1 || execute.preconditions[0]?.name !== "state" || execute.preconditions[0]?.value !== "approved") throw new TypeError("acknowledgement.execute.preconditions must be the single approved state precondition");
	return { tokens: execute.arguments.map((argument) => argument.token!) as ReviewApprovedAcknowledgementExecuteTokensV1, values: values as readonly [string, string, string, string, string], lineageId: lineage(execute.binding.lineageId, "acknowledgement.execute.binding.lineage_id"), targetIdentity: sha256(execute.binding.targetIdentity, "acknowledgement.execute.binding.target_identity"), revision: sha256(execute.binding.revision, "acknowledgement.execute.binding.revision") };
}

/**
 * Proves that an approved-acknowledgement execute vector is the exact closed,
 * provider-issued burn invocation. Callers can additionally bind its values to
 * their own current STATUS before invoking the returned tokens.
 */
export function assertReviewApprovedAcknowledgementExecuteV1(
	execute: ReviewNextTransitionExecuteV3,
	expected: ReviewApprovedAcknowledgementExecuteExpectationV1 = {},
): ReviewApprovedAcknowledgementExecuteTokensV1 {
	const shape = assertReviewApprovedAcknowledgementExecuteShapeV1(execute);
	if (shape.values[1] !== shape.lineageId) throw new TypeError("acknowledgement lineage argument does not match its binding");
	if (shape.values[2] !== shape.targetIdentity) throw new TypeError("acknowledgement target argument does not match its binding");
	if (shape.values[3] !== shape.revision) throw new TypeError("acknowledgement revision argument does not match its binding");
	if (expected.cwd !== undefined && shape.values[0] !== expected.cwd) throw new TypeError("acknowledgement.execute.cwd does not match the current target");
	if (expected.lineageId !== undefined && shape.lineageId !== expected.lineageId) throw new TypeError("acknowledgement.execute.lineage does not match the current target");
	if (expected.targetIdentity !== undefined && shape.targetIdentity !== expected.targetIdentity) throw new TypeError("acknowledgement.execute.target does not match the current target");
	if (expected.revision !== undefined && shape.revision !== expected.revision) throw new TypeError("acknowledgement.execute.revision does not match the current target"); return shape.tokens;
}

// ---------------------------------------------------------------------------
// review-acknowledged/v1 — the answer the burn prints (gentle-ai #3947)
// ---------------------------------------------------------------------------

// Until gentle-ai #3947 a successful `review acknowledge-approved` burned its
// authority in silence and a host could only infer the burn from a later
// STATUS offering a fresh START. From main commit bc9f74d2 the command prints
// exactly this envelope on success. Like result-artifact/v2 it carries no
// `contract`: the schema constant plus the slash-form operation are its whole
// identity, so requireIdentity (which demands the contract pair) does not
// apply. Every published release up to v2.5.0-rc.3 still prints nothing; the
// native client owns that distinction, this decoder only ever sees bytes.
export const REVIEW_ACKNOWLEDGED_SCHEMA = "gentle-ai.review-acknowledged/v1" as const;
const REVIEW_ACKNOWLEDGED_OPERATION = "review/acknowledge-approved" as const;

export interface ReviewAcknowledgedV1 {
	schema: typeof REVIEW_ACKNOWLEDGED_SCHEMA;
	operation: typeof REVIEW_ACKNOWLEDGED_OPERATION;
	action: "acknowledged";
	lineageId: string;
	targetIdentity: string;
	consumedRevision: string;
	authority: "burned";
	raw: Record<string, unknown>;
}

/** The binding the caller already holds from STATUS; the envelope must name exactly that burn. */
export interface ReviewAcknowledgedExpectationV1 {
	lineageId?: string;
	targetIdentity?: string;
	revision?: string;
}

export function decodeReviewAcknowledgedV1(value: unknown, expected: ReviewAcknowledgedExpectationV1 = {}): ReviewAcknowledgedV1 {
	if (record(value, "acknowledged").schema !== REVIEW_ACKNOWLEDGED_SCHEMA) throw new TypeError(`schema must be ${REVIEW_ACKNOWLEDGED_SCHEMA}`);
	const body = exactRecord(value, "acknowledged", ["schema", "operation", "action", "lineage_id", "target_identity", "consumed_revision", "authority"]);
	if (body.operation !== REVIEW_ACKNOWLEDGED_OPERATION) throw new TypeError(`acknowledged.operation must be ${REVIEW_ACKNOWLEDGED_OPERATION}`);
	if (body.action !== "acknowledged") throw new TypeError("acknowledged.action must be acknowledged");
	if (body.authority !== "burned") throw new TypeError("acknowledged.authority must be burned");
	const decoded: ReviewAcknowledgedV1 = {
		schema: REVIEW_ACKNOWLEDGED_SCHEMA,
		operation: REVIEW_ACKNOWLEDGED_OPERATION,
		action: "acknowledged",
		lineageId: lineage(body.lineage_id, "acknowledged.lineage_id"),
		targetIdentity: sha256(body.target_identity, "acknowledged.target_identity"),
		consumedRevision: sha256(body.consumed_revision, "acknowledged.consumed_revision"),
		authority: "burned",
		raw: body,
	};
	if (expected.lineageId !== undefined && decoded.lineageId !== expected.lineageId) throw new TypeError("acknowledged.lineage_id does not name the acknowledged lineage");
	if (expected.targetIdentity !== undefined && decoded.targetIdentity !== expected.targetIdentity) throw new TypeError("acknowledged.target_identity does not name the acknowledged target");
	if (expected.revision !== undefined && decoded.consumedRevision !== expected.revision) throw new TypeError("acknowledged.consumed_revision does not name the consumed revision");
	return decoded;
}

const REVIEW_LAST_EVENT_FINDING_SEVERITIES = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"] as const;
const REVIEW_LAST_EVENT_EVIDENCE_CLASSES = ["deterministic", "inferential", "insufficient"] as const;
const REVIEW_LAST_EVENT_CAUSAL_DISPOSITIONS = ["introduced", "behavior-activated", "worsened", "pre-existing", "base-only", "unknown"] as const;

export interface ReviewLastEventReviewerFindingV1 {
	id: string;
	lens: string;
	location: string;
	severity: (typeof REVIEW_LAST_EVENT_FINDING_SEVERITIES)[number];
	claim: string;
	proofRefs: readonly string[];
	evidenceClass?: (typeof REVIEW_LAST_EVENT_EVIDENCE_CLASSES)[number];
	causalDisposition?: (typeof REVIEW_LAST_EVENT_CAUSAL_DISPOSITIONS)[number];
}

export interface ReviewLastEventReviewerResultV1 {
	lens: string;
	findings: readonly ReviewLastEventReviewerFindingV1[];
	evidence: readonly string[];
	resultHash: string;
}

export interface ReviewLastEventClosureV1 {
	schema: typeof REVIEW_LAST_EVENT_CLOSURE_SCHEMA;
	operation: ReviewLastEventClosureOperation;
	lineageId: string;
	state: ReviewLastEventClosureState;
	storeRevision: string;
	action?: string;
	targetIdentity?: string;
	requestHash?: string;
	correctionLines?: number;
	advisoryFindings?: ReviewAdvisoryFindingsV1;
	reviewerResults?: readonly ReviewLastEventReviewerResultV1[];
	statusContinuation?: ReviewStatusContinuationV1;
	acknowledgement?: ReviewApprovedAcknowledgementV1;
	// Set when the provider sent an acknowledgement this decoder could not
	// read. It is deliberately distinct from an absent one: the host must be
	// able to tell "approved, nothing to run" from "approved, and the thing
	// that ends this is present but unreadable here".
	acknowledgementUndecodable?: true;
}

export interface ReviewLastEventClosureBinding {
	lineageId: string;
	targetIdentity?: string;
	requestHash?: string;
}

function decodeReviewStatusContinuationArtifactV1(value: unknown, label: string): ReviewStatusContinuationArtifactV1 {
	const artifact = exactRecord(value, label, ["schema", "capability", "sha256", "lineage_id", "target_identity", "lens", "selected_order", "subject_hash", "admission_decision"]);
	if (artifact.schema !== "gentle-ai.review-result-artifact/v2") throw new TypeError(`${label}.schema must be gentle-ai.review-result-artifact/v2`);
	if (artifact.capability !== "review.native_result_artifact") throw new TypeError(`${label}.capability must be review.native_result_artifact`);
	if (artifact.admission_decision !== "completed") throw new TypeError(`${label}.admission_decision must be completed`);
	return {
		schema: "gentle-ai.review-result-artifact/v2",
		capability: "review.native_result_artifact",
		sha256: sha256(artifact.sha256, `${label}.sha256`),
		lineageId: lineage(artifact.lineage_id, `${label}.lineage_id`),
		targetIdentity: sha256(artifact.target_identity, `${label}.target_identity`),
		lens: nonempty(artifact.lens, `${label}.lens`),
		selectedOrder: integer(artifact.selected_order, `${label}.selected_order`, 0),
		subjectHash: sha256(artifact.subject_hash, `${label}.subject_hash`),
		admissionDecision: "completed",
	};
}

// decodeReviewApprovedAcknowledgementV1 retains the closure-specific wire
// boundary with the shared shape validator; its semantic binding stays outside
// the defensive closure catch in the exported assertion.
function decodeReviewApprovedAcknowledgementV1(value: unknown, label: string): ReviewApprovedAcknowledgementV1 {
	const body = exactRecord(value, label, ["operation", "command", "arguments", "preconditions", "binding"]);
	const argumentsList = decodeTransitionArguments(body.arguments, `${label}.arguments`);
	const preconditions = decodeTransitionArguments(body.preconditions, `${label}.preconditions`);
	const sourceBinding = exactRecord(body.binding, `${label}.binding`, ["lineage_id", "revision", "target_identity"], ["repository_context"]);
	const repositoryContext = sourceBinding.repository_context === undefined
		? undefined
		: text(sourceBinding.repository_context, `${label}.binding.repository_context`, { pattern: /^rctx[12]_[0-9a-f]{64}$/ });
	const acknowledgement = {
		operation: body.operation,
		command: body.command,
		arguments: argumentsList,
		preconditions,
		binding: {
			lineageId: sourceBinding.lineage_id,
			revision: sourceBinding.revision,
			targetIdentity: sourceBinding.target_identity,
			...(repositoryContext === undefined ? {} : { repositoryContext }),
		},
	} as unknown as ReviewNextTransitionExecuteV3;
	const shape = assertReviewApprovedAcknowledgementExecuteShapeV1(acknowledgement);
	return {
		operation: REVIEW_APPROVED_ACKNOWLEDGEMENT_OPERATION,
		command: acknowledgement.command!,
		arguments: argumentsList,
		preconditions,
		binding: {
			lineageId: shape.lineageId,
			revision: shape.revision,
			targetIdentity: shape.targetIdentity,
			...(repositoryContext === undefined ? {} : { repositoryContext }),
		},
		raw: body,
	};
}

function decodeReviewStatusContinuationV1(value: unknown): ReviewStatusContinuationV1 {
	const body = exactRecord(value, "last_event_closure.status_continuation", ["operation", "arguments", "preconditions", "binding"], ["command", "selector_arguments", "artifacts"]);
	if (body.operation !== REVIEW_STATUS_CONTINUATION_OPERATION.STATUS) throw new TypeError("last_event_closure.status_continuation.operation must be review.status");
	const argumentsList = decodeTransitionArguments(body.arguments, "last_event_closure.status_continuation.arguments");
	if (argumentsList.some((argument) => argument.token === undefined)) throw new TypeError("last_event_closure.status_continuation.arguments require exact tokens");
	const preconditions = decodeTransitionArguments(body.preconditions, "last_event_closure.status_continuation.preconditions");
	if (preconditions.length === 0) throw new TypeError("last_event_closure.status_continuation.preconditions requires at least one entry");
	const sourceBinding = exactRecord(body.binding, "last_event_closure.status_continuation.binding", ["target_identity"], ["lineage_id", "revision", "repository_context"]);
	const lineageId = sourceBinding.lineage_id === undefined ? undefined : lineage(sourceBinding.lineage_id, "last_event_closure.status_continuation.binding.lineage_id");
	const revision = sourceBinding.revision === undefined ? undefined : sha256(sourceBinding.revision, "last_event_closure.status_continuation.binding.revision");
	const repositoryContext = sourceBinding.repository_context === undefined
		? undefined
		: text(sourceBinding.repository_context, "last_event_closure.status_continuation.binding.repository_context", { pattern: /^rctx[12]_[0-9a-f]{64}$/ });
	const selectorArguments = body.selector_arguments === undefined
		? undefined
		: decodeTransitionArguments(body.selector_arguments, "last_event_closure.status_continuation.selector_arguments");
	const artifacts = body.artifacts === undefined
		? undefined
		: array(body.artifacts, "last_event_closure.status_continuation.artifacts", decodeReviewStatusContinuationArtifactV1);
	const command = body.command === undefined
		? undefined
		: text(body.command, "last_event_closure.status_continuation.command", { minimum: 1, pattern: /^gentle-ai review [a-z][a-z-]*/ });
	return {
		operation: REVIEW_STATUS_CONTINUATION_OPERATION.STATUS,
		arguments: argumentsList,
		...(selectorArguments === undefined ? {} : { selectorArguments }),
		preconditions,
		binding: {
			targetIdentity: sha256(sourceBinding.target_identity, "last_event_closure.status_continuation.binding.target_identity"),
			...(lineageId === undefined ? {} : { lineageId }),
			...(revision === undefined ? {} : { revision }),
			...(repositoryContext === undefined ? {} : { repositoryContext }),
		},
		...(artifacts === undefined ? {} : { artifacts }),
		...(command === undefined ? {} : { command }),
		raw: body,
	};
}

function decodeReviewLastEventReviewerFindingV1(value: unknown, label: string): ReviewLastEventReviewerFindingV1 {
	const finding = exactRecord(value, label, ["id", "lens", "location", "severity", "claim", "proof_refs"], ["evidence_class", "causal_disposition"]);
	const evidenceClass = finding.evidence_class === undefined
		? undefined
		: enumeration(finding.evidence_class, REVIEW_LAST_EVENT_EVIDENCE_CLASSES, `${label}.evidence_class`);
	const causalDisposition = finding.causal_disposition === undefined
		? undefined
		: enumeration(finding.causal_disposition, REVIEW_LAST_EVENT_CAUSAL_DISPOSITIONS, `${label}.causal_disposition`);
	return {
		id: nonempty(finding.id, `${label}.id`),
		lens: nonempty(finding.lens, `${label}.lens`),
		location: nonempty(finding.location, `${label}.location`),
		severity: enumeration(finding.severity, REVIEW_LAST_EVENT_FINDING_SEVERITIES, `${label}.severity`),
		claim: nonempty(finding.claim, `${label}.claim`),
		proofRefs: stringArray(finding.proof_refs, `${label}.proof_refs`, { minimum: 1 }),
		...(evidenceClass === undefined ? {} : { evidenceClass }),
		...(causalDisposition === undefined ? {} : { causalDisposition }),
	};
}

function decodeReviewLastEventReviewerResultV1(value: unknown, label: string): ReviewLastEventReviewerResultV1 {
	const result = exactRecord(value, label, ["lens", "findings", "evidence", "result_hash"]);
	return {
		lens: nonempty(result.lens, `${label}.lens`),
		findings: array(result.findings, `${label}.findings`, decodeReviewLastEventReviewerFindingV1),
		evidence: stringArray(result.evidence, `${label}.evidence`),
		resultHash: sha256(result.result_hash, `${label}.result_hash`),
	};
}

export function decodeReviewLastEventClosureV1(value: unknown): ReviewLastEventClosureV1 {
	const body = exactRecord(value, "last_event_closure", ["schema", "operation", "lineage_id", "state", "store_revision"], ["target_identity", "request_hash", "correction_lines", "action", "advisory_findings", "reviewer_results", "status_continuation", "acknowledgement"]);
	if (body.schema !== REVIEW_LAST_EVENT_CLOSURE_SCHEMA) throw new TypeError(`last_event_closure.schema must be ${REVIEW_LAST_EVENT_CLOSURE_SCHEMA}`);
	const operation = enumeration(body.operation, Object.values(REVIEW_LAST_EVENT_CLOSURE_OPERATION), "last_event_closure.operation") as ReviewLastEventClosureOperation;
	const state = enumeration(body.state, REVIEW_LAST_EVENT_TERMINAL_STATES, "last_event_closure.state") as ReviewLastEventClosureState;
	const shared = {
		schema: REVIEW_LAST_EVENT_CLOSURE_SCHEMA,
		operation,
		lineageId: lineage(body.lineage_id, "last_event_closure.lineage_id"),
		state,
		storeRevision: sha256(body.store_revision, "last_event_closure.store_revision"),
	};
	if (operation === REVIEW_LAST_EVENT_CLOSURE_OPERATION.CAPTURE_CORRECTION_PLAN) {
		if (body.reviewer_results !== undefined) throw new TypeError("last_event_closure reviewer_results requires approved state");
		if (body.action !== undefined || body.advisory_findings !== undefined || body.status_continuation !== undefined) throw new TypeError("last_event_closure correction-plan cannot carry action, advisory_findings, or status_continuation");
		if (state !== "correction_required") throw new TypeError("last_event_closure correction-plan requires correction_required state");
		return {
			...shared,
			targetIdentity: sha256(body.target_identity, "last_event_closure.target_identity"),
			requestHash: sha256(body.request_hash, "last_event_closure.request_hash"),
			correctionLines: integer(body.correction_lines, "last_event_closure.correction_lines", 1, 200),
		};
	}
	if (body.target_identity !== undefined || body.request_hash !== undefined || body.correction_lines !== undefined) throw new TypeError("last_event_closure terminal capture cannot carry correction-plan fields");
	const requiresStatusContinuation = state === "correction_required" && (
		operation === REVIEW_LAST_EVENT_CLOSURE_OPERATION.CAPTURE_RESULT || operation === REVIEW_LAST_EVENT_CLOSURE_OPERATION.CAPTURE_REFUTER
	);
	if (requiresStatusContinuation && body.status_continuation === undefined) throw new TypeError("last_event_closure requires status_continuation for correction-required result or refuter capture");
	if (!requiresStatusContinuation && body.status_continuation !== undefined) throw new TypeError("last_event_closure status_continuation is only valid for correction-required result or refuter capture");
	const statusContinuation = body.status_continuation === undefined ? undefined : decodeReviewStatusContinuationV1(body.status_continuation);
	if (statusContinuation !== undefined) {
		if (statusContinuation.binding.lineageId !== shared.lineageId) {
			throw new TypeError("last_event_closure status continuation lineage does not match its enclosing closure");
		}
		if (statusContinuation.binding.revision !== shared.storeRevision) {
			throw new TypeError("last_event_closure status continuation revision does not match its enclosing closure");
		}
		const lineageArguments = statusContinuation.arguments.filter((argument) => argument.name === "lineage");
		if (lineageArguments.length !== 1 || lineageArguments[0]?.value !== shared.lineageId || lineageArguments[0]?.token !== `--lineage=${shared.lineageId}`) {
			throw new TypeError("last_event_closure status continuation lineage argument does not match its enclosing closure");
		}
	}
	// Only an approved closure may carry the continuation that burns its
	// authority: any other state offering an acknowledgement would be inviting
	// a burn the provider never authorized.
	//
	// It stays optional because the pinned installer binary predates it. A
	// provider that emits one is decoded strictly; a provider that does not is
	// still the contract this build ships against. Requiring it belongs with
	// the pin bump that makes it always present.
	// Decoded defensively on purpose. This decoder pins the acknowledgement to a
	// closed positional shape, and the same patch that added it already shows
	// what strictness costs when the provider moves: rejecting one omitempty
	// field made every targeted-validation STATUS that carried it undecodable.
	// Here the blast radius would be worse than a lost field. Throwing would
	// fail the whole approved closure, so the host would lose the approval
	// outcome AND the only invocation that burns the authority, leaving the
	// lineage approved and un-burnable at once. An unreadable continuation
	// degrades to a flag; everything else about the approval still arrives.
	let acknowledgement: ReviewApprovedAcknowledgementV1 | undefined;
	let acknowledgementUndecodable = false;
	if (body.acknowledgement !== undefined) {
		try {
			acknowledgement = decodeReviewApprovedAcknowledgementV1(body.acknowledgement, "last_event_closure.acknowledgement");
		} catch {
			acknowledgement = undefined;
			acknowledgementUndecodable = true;
		}
	}
	if (acknowledgementUndecodable && state !== "approved") {
		throw new TypeError("last_event_closure acknowledgement requires approved state");
	}
	if (acknowledgement !== undefined) {
		if (state !== "approved") throw new TypeError("last_event_closure acknowledgement requires approved state");
		assertReviewApprovedAcknowledgementExecuteV1(acknowledgement, { lineageId: shared.lineageId, revision: shared.storeRevision });
	}
	const action = nonempty(body.action, "last_event_closure.action");
	const advisoryFindings = body.advisory_findings === undefined
		? undefined
		: decodeReviewAdvisoryFindingsV1(body.advisory_findings, "last_event_closure.advisory_findings");
	if (advisoryFindings !== undefined && state !== "approved") throw new TypeError("last_event_closure advisory_findings requires approved state");
	const reviewerResults = body.reviewer_results === undefined
		? undefined
		: array(body.reviewer_results, "last_event_closure.reviewer_results", decodeReviewLastEventReviewerResultV1);
	if (reviewerResults !== undefined && state !== "approved") throw new TypeError("last_event_closure reviewer_results requires approved state");
	return {
		...shared,
		action,
		...(advisoryFindings === undefined ? {} : { advisoryFindings }),
		...(reviewerResults === undefined ? {} : { reviewerResults }),
		...(statusContinuation === undefined ? {} : { statusContinuation }),
		...(acknowledgement === undefined ? {} : { acknowledgement }),
		...(acknowledgementUndecodable ? { acknowledgementUndecodable: true as const } : {}),
	};
}

export function assertReviewLastEventClosureBinding(
	closure: ReviewLastEventClosureV1,
	binding: ReviewLastEventClosureBinding,
): void {
	if (closure.lineageId !== binding.lineageId) throw new TypeError("last_event_closure lineage does not match its provider binding");
	if (binding.targetIdentity !== undefined && closure.targetIdentity !== undefined && closure.targetIdentity !== binding.targetIdentity) {
		throw new TypeError("last_event_closure target does not match its provider binding");
	}
	if (binding.targetIdentity !== undefined && closure.statusContinuation !== undefined && closure.statusContinuation.binding.targetIdentity !== binding.targetIdentity) {
		throw new TypeError("last_event_closure status continuation target does not match its provider binding");
	}
	if (binding.requestHash !== undefined && closure.requestHash !== undefined && closure.requestHash !== binding.requestHash) {
		throw new TypeError("last_event_closure request hash does not match its provider binding");
	}
}
