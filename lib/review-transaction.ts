import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ReviewMutationLockV1, type ReviewLockPlatformAdapterV1 } from "./review-lock.ts";
import { ReviewGraphObjectStoreV1 } from "./review-object-store.ts";
import { assertNoLegacyReviewAuthorityV1 } from "./review-legacy-detector.ts";
import { createReviewEventV1 } from "./review-graph-schema.ts";
import {
	resolveRepositoryAuthorityV1,
	type RepositoryAuthorityV1,
} from "./review-repository.ts";
import {
	GATE_RESULT,
	GATE_TARGET_KIND,
	PUSH_UPDATE_KIND,
	pushRemoteAdvertisesObjectV1,
	resolveConfiguredPushDestinationV1,
	resolvePushRemoteRefV1,
	type GateResult,
	type GateTargetV1,
	type PushGateTargetV1,
	type PushRefUpdateV1,
} from "./review-publication-gate.ts";
import {
	REVIEW_MODE,
	REVIEW_PROJECTION,
	type ReviewMode,
	type ReviewProjectionV1,
	type SnapshotV1,
	type ReviewSnapshotObjectStoreV1,
} from "./review-snapshot.ts";
export { REVIEW_MODE, type ReviewMode } from "./review-snapshot.ts";
import {
	REVIEW_ROUTE,
	classifyReviewRoute,
	type ReviewLens,
	type ReviewRoute,
} from "./review-triggers.ts";
import {
	applyOrdinaryFix,
	declineOrdinaryFix,
	recordOrdinaryDiscovery,
	recordOrdinaryFinalVerification,
	recordOrdinaryValidation,
	resolveOrdinaryEvidence,
	type OrdinaryDiscoveryInput,
	type OrdinaryEvidenceInput,
	type OrdinaryFinalVerificationInput,
	type OrdinaryFixInput,
	type OrdinaryValidationInput,
} from "./review-policy-ordinary.ts";
import {
	applyJudgmentDayFix,
	recordJudgmentDayDiscovery,
	recordJudgmentDayFinalVerification,
	recordJudgmentDayRejudgment,
	type JudgmentDayDiscoveryInput,
	type JudgmentDayFinalVerificationInput,
	type JudgmentDayFixInput,
	type JudgmentDayRejudgmentInput,
} from "./review-policy-judgment-day.ts";

export const REVIEW_PHASE = {
	STARTED: "started",
	DISCOVERY_COMPLETE: "discovery-complete",
	REFUTATION_COMPLETE: "refutation-complete",
	FIX_COMPLETE: "fix-complete",
	VALIDATION_COMPLETE: "validation-complete",
	FINAL_VERIFICATION: "final-verification",
	JUDGMENT_COMPLETE: "judgment-complete",
	TERMINAL: "terminal",
} as const;

export type ReviewPhase = (typeof REVIEW_PHASE)[keyof typeof REVIEW_PHASE];

export const TERMINAL_STATE = {
	APPROVED: "approved",
	ESCALATED: "escalated",
} as const;

export type TerminalState = (typeof TERMINAL_STATE)[keyof typeof TERMINAL_STATE];

export const JOURNAL_STATUS = {
	PENDING: "pending",
	COMPLETED: "completed",
} as const;

export type JournalStatus = (typeof JOURNAL_STATUS)[keyof typeof JOURNAL_STATUS];

export const FROZEN_SEVERITY = {
	BLOCKER: "BLOCKER",
	CRITICAL: "CRITICAL",
	WARNING: "WARNING",
	SUGGESTION: "SUGGESTION",
} as const;

export type FrozenSeverity =
	(typeof FROZEN_SEVERITY)[keyof typeof FROZEN_SEVERITY];

export const FROZEN_STATUS = {
	OPEN: "open",
	REFUTED: "refuted",
	INFO: "info",
} as const;

export type FrozenStatus = (typeof FROZEN_STATUS)[keyof typeof FROZEN_STATUS];

export const EVIDENCE_CLASS = {
	DETERMINISTIC: "deterministic",
	INFERENTIAL_SEVERE: "inferential-severe",
	INFO: "info",
} as const;

export type EvidenceClass =
	(typeof EVIDENCE_CLASS)[keyof typeof EVIDENCE_CLASS];

export const RESOLUTION_OUTCOME = {
	CORROBORATED: "corroborated",
	REFUTED: "refuted",
	INCONCLUSIVE: "inconclusive",
	VERIFIED: "verified",
	REGRESSION: "regression",
} as const;

export type ResolutionOutcome =
	(typeof RESOLUTION_OUTCOME)[keyof typeof RESOLUTION_OUTCOME];

export const RESOLUTION_SOURCE = {
	CONTROLLER: "controller",
	REFUTER: "refuter",
	VALIDATOR: "validator",
	JUDGE: "judge",
} as const;

export type ResolutionSource =
	(typeof RESOLUTION_SOURCE)[keyof typeof RESOLUTION_SOURCE];

export const STORE_FAULT_POINT = {
	BEFORE_HEAD_RENAME: "before-head-rename",
} as const;

export type StoreFaultPoint =
	(typeof STORE_FAULT_POINT)[keyof typeof STORE_FAULT_POINT];

export const REVIEW_OPERATION = {
	START: "start",
	FREEZE_LEDGER: "freeze-ledger",
	RESOLVE_EVIDENCE: "resolve-evidence",
	AUTHORIZE_FIX: "authorize-fix",
	VALIDATE_FIX: "validate-fix",
	VERIFY: "verify",
	GATE: "gate",
} as const;

export type ReviewOperation =
	(typeof REVIEW_OPERATION)[keyof typeof REVIEW_OPERATION];

export const REVIEW_TRANSITION = {
	ORDINARY_DISCOVERY: "ordinary-discovery",
	ORDINARY_EVIDENCE: "ordinary-evidence",
	ORDINARY_FIX: "ordinary-fix",
	ORDINARY_NO_FIX: "ordinary-no-fix",
	ORDINARY_VALIDATION: "ordinary-validation",
	ORDINARY_FINAL_VERIFICATION: "ordinary-final-verification",
	JUDGMENT_DAY_DISCOVERY: "judgment-day-discovery",
	JUDGMENT_DAY_FIX: "judgment-day-fix",
	JUDGMENT_DAY_REJUDGMENT: "judgment-day-rejudgment",
	JUDGMENT_DAY_FINAL_VERIFICATION: "judgment-day-final-verification",
} as const;

export type ReviewTransition =
	(typeof REVIEW_TRANSITION)[keyof typeof REVIEW_TRANSITION];

export interface ReviewBudgetV1 {
	review_batches: number;
	review_actors: number;
	refuter_batches: number;
	fix_batches: number;
	validator_runs: number;
	final_verifications: number;
	judgment_rounds: number;
	judge_runs: number;
}

export interface ReviewCountersV1 {
	review_batches: number;
	review_actors: number;
	refuter_batches: number;
	fix_batches: number;
	validator_runs: number;
	final_verifications: number;
	judgment_rounds: number;
	judge_runs: number;
}

export interface CanonicalFrozenRowV1 {
	id: string;
	lens: ReviewLens | "judgment-day";
	location: string;
	severity: FrozenSeverity;
	status_at_freeze: FrozenStatus;
	evidence_class: EvidenceClass;
	evidence_claim: string;
}

export interface FrozenLedgerV1 {
	schema: "gentle-ai.review-frozen-ledger/v1";
	rows: CanonicalFrozenRowV1[];
	frozen_ledger_hash: string;
}

export interface RequestJournalEntryV1 {
	operation: ReviewOperation;
	idempotency_key: string;
	request_hash: string;
	status: JournalStatus;
	authorization?: unknown;
	canonical_result?: unknown;
}

export interface GateResultV1 {
	status: GateResult;
	actor_count: 0;
	target_hash: string;
	receipt_hash: string;
	reason: string;
	child_claim?: ChildClaimV1;
}

export interface FindingResolutionV1 {
	id: string;
	outcome: ResolutionOutcome;
	source: ResolutionSource;
}

export interface ReviewFixRecordV1 {
	candidate_tree: string;
	fixed_ids: string[];
	fix_diff: string;
	fix_diff_hash: string;
	changed_paths?: string[];
}

export interface ValidationEvidenceV1 {
	original_acceptance_tests: { passed: boolean; evidence_hash: string };
	correction_regressions: Array<{ finding_id: string; evidence_hash: string; passed: boolean }>;
	original_criterion_regressions: string[];
	follow_ups: FollowUpObservationV1[];
}

export interface FollowUpObservationV1 {
	id: string;
	location: string;
	summary: string;
	evidence_hash: string;
}

export interface ReviewStateV1 {
	schema: "gentle-ai.review-state/v1";
	lineage_id: string;
	parent_lineage_id?: string;
	mode: ReviewMode;
	revision: number;
	phase: ReviewPhase;
	base_tree: string;
	complete_snapshot_tree: string;
	review_projection: ReviewProjectionV1;
	initial_review_tree: string;
	genesis_paths?: string[];
	snapshot_object_store?: ReviewSnapshotObjectStoreV1;
	current_candidate_tree: string;
	final_candidate_tree?: string;
	route: ReviewRoute;
	lenses: readonly ReviewLens[];
	policy_hash: string;
	frozen_ledger?: FrozenLedgerV1;
	evidence_hash: string;
	budget: ReviewBudgetV1;
	counters: ReviewCountersV1;
	resolutions?: FindingResolutionV1[];
	fix_record?: ReviewFixRecordV1;
	validation_evidence?: ValidationEvidenceV1;
	active_finding_ids?: string[];
	escalation_reasons?: string[];
	child_claims?: ChildClaimV1[];
	request_journal: RequestJournalEntryV1[];
	terminal_state?: TerminalState;
}

export interface CreateReviewStateInput {
	lineageId: string;
	parentLineageId?: string;
	mode: ReviewMode;
	snapshot: SnapshotV1;
	evidenceHash: string;
	budget: ReviewBudgetV1;
}

export interface ReceiptBodyV1 {
	schema: "gentle-ai.review-receipt-body/v1";
	lineage_id: string;
	mode: ReviewMode;
	base_tree: string;
	complete_snapshot_tree: string;
	review_projection: ReviewProjectionV1;
	initial_review_tree: string;
	final_candidate_tree: string;
	route: ReviewRoute;
	lenses: readonly ReviewLens[];
	policy_hash: string;
	frozen_ledger_hash: string;
	evidence_hash: string;
	budget: ReviewBudgetV1;
	counters: ReviewCountersV1;
	terminal_state: TerminalState;
}

export interface ReceiptEnvelopeV1 {
	body: ReceiptBodyV1;
	receipt_hash: string;
}

export interface ChildClaimV1 {
	parent_lineage_id: string;
	target_tree: string;
	child_lineage_id: string;
	budget: ReviewBudgetV1;
}

interface ChildClaimEnvelopeV1 {
	claim: ChildClaimV1;
	claim_hash: string;
}

interface ReviewTransactionStoreOptions {
	faultInjector?: (point: StoreFaultPoint) => void;
	mutationLockPlatform?: ReviewLockPlatformAdapterV1;
}

const authoritativeReceiptBrand: unique symbol = Symbol("gentle-ai.authoritative-receipt");
let mutationLockPlatformForTesting: ReviewLockPlatformAdapterV1 | undefined;

/** @internal Test-only injection for exercising graph authority without a native platform adapter. */
export function setReviewMutationLockPlatformForTesting(
	platform: ReviewLockPlatformAdapterV1 | undefined,
): void {
	mutationLockPlatformForTesting = platform;
}
export interface AuthoritativeReceiptV1 {
	readonly [authoritativeReceiptBrand]: true;
	readonly envelope: ReceiptEnvelopeV1;
	readonly repository_id: string;
	readonly authority_id: string;
	readonly common_directory: string;
	readonly root_set_id: string;
	readonly head_event_id: string;
	readonly store_epoch?: string;
	readonly authority_incarnation_id?: string;
	readonly authority_receipt_hash: string;
}

interface RunOperationResult<TResult> {
	state: ReviewStateV1;
	result: TResult;
}

interface RunOperationOptions<TRequest, TResult> {
	lineageId: string;
	operation: ReviewOperation;
	idempotencyKey: string;
	request: TRequest;
	beforeReplay?: () => void;
	apply: (state: ReviewStateV1) => RunOperationResult<TResult>;
}

export type ReviewReducerInput =
	| OrdinaryDiscoveryInput
	| OrdinaryEvidenceInput
	| OrdinaryFixInput
	| OrdinaryValidationInput
	| OrdinaryFinalVerificationInput
	| JudgmentDayDiscoveryInput
	| JudgmentDayFixInput
	| JudgmentDayRejudgmentInput
	| JudgmentDayFinalVerificationInput
	| { reason: string };

export interface ReducerOperationResultV1 {
	revision: number;
	phase: ReviewPhase;
	terminal_state?: TerminalState;
}

export interface StartOperationResultV1 {
	lineage_id: string;
	revision: 0;
	phase: typeof REVIEW_PHASE.STARTED;
}

export interface RunReducerOperationOptions {
	lineageId: string;
	transition: ReviewTransition;
	idempotencyKey: string;
	input: ReviewReducerInput;
}

export interface BeginReducerOperationOptions<TRequest> {
	lineageId: string;
	transition: ReviewTransition;
	idempotencyKey: string;
	request: TRequest;
	authorization?: unknown;
}

export interface CompleteReducerOperationOptions<TRequest>
	extends BeginReducerOperationOptions<TRequest> {
	input: ReviewReducerInput;
}

export interface ValidateReviewGateOptions {
	store: ReviewTransactionStore;
	receipt: ReceiptEnvelopeV1;
	target: GateTargetV1;
	repositoryCwd: string;
	idempotencyKey: string;
	scopeBudget: ReviewBudgetV1;
	actualIntendedCommitTree?: string;
}

export class ReviewIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewIntegrityError";
	}
}

const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const LINEAGE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const COUNTER_KEYS = Object.freeze([
	"review_batches",
	"review_actors",
	"refuter_batches",
	"fix_batches",
	"validator_runs",
	"final_verifications",
	"judgment_rounds",
	"judge_runs",
] satisfies Array<keyof ReviewCountersV1>);

function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.toSorted()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
		return `{${entries.join(",")}}`;
	}
	throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

export function canonicalHash(value: unknown): string {
	return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function cloneCanonical<T>(value: T): T {
	return JSON.parse(canonicalize(value)) as T;
}

function assertDigest(value: string, label: string): void {
	if (!DIGEST.test(value)) throw new ReviewIntegrityError(`${label} is not a SHA-256 digest`);
}

function assertObjectId(value: string, label: string): void {
	if (!OBJECT_ID.test(value)) throw new ReviewIntegrityError(`${label} is not a resolved object ID`);
}

function assertLineageId(value: string): void {
	if (!LINEAGE_ID.test(value)) throw new ReviewIntegrityError("Invalid lineage ID");
}

function zeroCounters(): ReviewCountersV1 {
	return {
		review_batches: 0,
		review_actors: 0,
		refuter_batches: 0,
		fix_batches: 0,
		validator_runs: 0,
		final_verifications: 0,
		judgment_rounds: 0,
		judge_runs: 0,
	};
}

function assertBudget(budget: ReviewBudgetV1): void {
	for (const key of COUNTER_KEYS) {
		if (!Number.isSafeInteger(budget[key]) || budget[key] < 0) {
			throw new ReviewIntegrityError(`Invalid budget counter: ${key}`);
		}
	}
}

function assertCounters(
	counters: ReviewCountersV1,
	budget: ReviewBudgetV1,
	previous?: ReviewCountersV1,
): void {
	for (const key of COUNTER_KEYS) {
		if (!Number.isSafeInteger(counters[key]) || counters[key] < 0) {
			throw new ReviewIntegrityError(`Invalid review counter: ${key}`);
		}
		if (counters[key] > budget[key]) {
			throw new ReviewIntegrityError(`Review budget exceeded: ${key}`);
		}
		if (previous && counters[key] < previous[key]) {
			throw new ReviewIntegrityError(`Review counter is not monotonic: ${key}`);
		}
	}
}

function assertProjectionBinding(
	projection: ReviewProjectionV1,
	completeTree: string,
	initialTree: string,
): void {
	if (projection.kind === REVIEW_PROJECTION.COMPLETE) {
		if (initialTree !== completeTree) {
			throw new ReviewIntegrityError("Complete projection does not bind the initial review tree");
		}
		return;
	}
	if (projection.kind === REVIEW_PROJECTION.INTENDED_COMMIT) {
		assertObjectId(projection.tree, "intended commit tree");
		if (projection.tree !== initialTree) {
			throw new ReviewIntegrityError("Intended-commit projection does not bind the initial review tree");
		}
		return;
	}
	throw new ReviewIntegrityError("Unsupported review projection");
}

function assertCanonicalPaths(paths: readonly string[], label: string): void {
	if (canonicalize(paths) !== canonicalize([...new Set(paths)].toSorted())) {
		throw new ReviewIntegrityError(`${label} must be unique and sorted`);
	}
	for (const path of paths) {
		if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
			throw new ReviewIntegrityError(`${label} must be canonical repository-relative paths`);
		}
	}
}

function assertFollowUp(value: FollowUpObservationV1): void {
	if (Object.keys(value as object).some((key) => !["id", "location", "summary", "evidence_hash"].includes(key))) {
		throw new ReviewIntegrityError("Follow-up cannot request lifecycle action or correction");
	}
	if (typeof value.id !== "string" || value.id.length === 0 || typeof value.location !== "string" || value.location.length === 0 || typeof value.summary !== "string" || value.summary.length === 0) {
		throw new ReviewIntegrityError("Follow-up requires identity, location, and summary");
	}
	assertDigest(value.evidence_hash, "Follow-up evidence hash");
}

function assertValidationEvidence(value: ValidationEvidenceV1): void {
	if (typeof value.original_acceptance_tests?.passed !== "boolean") throw new ReviewIntegrityError("Original acceptance evidence is invalid");
	assertDigest(value.original_acceptance_tests.evidence_hash, "Original acceptance evidence hash");
	for (const regression of value.correction_regressions) {
		if (typeof regression.finding_id !== "string" || typeof regression.passed !== "boolean") throw new ReviewIntegrityError("Correction regression evidence is invalid");
		assertDigest(regression.evidence_hash, "Correction regression evidence hash");
	}
	if (!Array.isArray(value.original_criterion_regressions) || value.original_criterion_regressions.some((reason) => typeof reason !== "string" || reason.length === 0)) {
		throw new ReviewIntegrityError("Original criterion regression evidence is invalid");
	}
	if (!Array.isArray(value.follow_ups)) throw new ReviewIntegrityError("Follow-up evidence is invalid");
	for (const followUp of value.follow_ups) assertFollowUp(followUp);
	if (canonicalize(value.follow_ups) !== canonicalize([...value.follow_ups].toSorted((left, right) => left.id.localeCompare(right.id)))) {
		throw new ReviewIntegrityError("Follow-up evidence must be ID-sorted");
	}
}

export function createFrozenLedger(
	rows: readonly CanonicalFrozenRowV1[],
): FrozenLedgerV1 {
	const severityValues = new Set(Object.values(FROZEN_SEVERITY));
	const statusValues = new Set(Object.values(FROZEN_STATUS));
	const evidenceValues = new Set(Object.values(EVIDENCE_CLASS));
	const lensValues = new Set([
		"review-risk",
		"review-resilience",
		"review-readability",
		"review-reliability",
		"judgment-day",
	]);
	const normalizedRows = cloneCanonical(rows).map((row) => {
		if (typeof row.id !== "string" || row.id.trim().length === 0) {
			throw new ReviewIntegrityError("Frozen finding ID must be non-empty");
		}
		if (!lensValues.has(row.lens)) {
			throw new ReviewIntegrityError(`Unsupported frozen finding lens: ${row.lens}`);
		}
		if (!severityValues.has(row.severity)) {
			throw new ReviewIntegrityError(`Unsupported frozen finding severity: ${row.severity}`);
		}
		if (!statusValues.has(row.status_at_freeze)) {
			throw new ReviewIntegrityError(`Unsupported frozen finding status: ${row.status_at_freeze}`);
		}
		if (!evidenceValues.has(row.evidence_class)) {
			throw new ReviewIntegrityError(`Unsupported frozen evidence class: ${row.evidence_class}`);
		}
		if (typeof row.location !== "string" || row.location.trim().length === 0) {
			throw new ReviewIntegrityError(`Frozen finding ${row.id} requires an exact location`);
		}
		if (typeof row.evidence_claim !== "string" || row.evidence_claim.trim().length === 0) {
			throw new ReviewIntegrityError(`Frozen finding ${row.id} requires a concrete evidence claim`);
		}
		const severe =
			row.severity === FROZEN_SEVERITY.BLOCKER ||
			row.severity === FROZEN_SEVERITY.CRITICAL;
		return {
			...row,
			status_at_freeze: severe ? FROZEN_STATUS.OPEN : FROZEN_STATUS.INFO,
			evidence_class: severe
				? row.evidence_class === EVIDENCE_CLASS.INFO
					? EVIDENCE_CLASS.INFERENTIAL_SEVERE
					: row.evidence_class
				: EVIDENCE_CLASS.INFO,
		};
	});
	const canonicalRows = normalizedRows.toSorted((left, right) =>
		left.id.localeCompare(right.id),
	);
	for (let index = 1; index < canonicalRows.length; index += 1) {
		if (canonicalRows[index - 1]!.id === canonicalRows[index]!.id) {
			throw new ReviewIntegrityError(`Duplicate frozen finding ID: ${canonicalRows[index]!.id}`);
		}
	}
	return {
		schema: "gentle-ai.review-frozen-ledger/v1",
		rows: canonicalRows,
		frozen_ledger_hash: canonicalHash(canonicalRows),
	};
}

export function assertFrozenLedgerIntegrity(ledger: FrozenLedgerV1): void {
	if (ledger.schema !== "gentle-ai.review-frozen-ledger/v1") {
		throw new ReviewIntegrityError("Unknown frozen ledger schema");
	}
	const rebuilt = createFrozenLedger(ledger.rows);
	if (canonicalize(rebuilt.rows) !== canonicalize(ledger.rows)) {
		throw new ReviewIntegrityError("Frozen ledger rows are not in canonical ID order");
	}
	if (rebuilt.frozen_ledger_hash !== ledger.frozen_ledger_hash) {
		throw new ReviewIntegrityError("Frozen ledger hash mismatch");
	}
}

export function createReviewState(input: CreateReviewStateInput): ReviewStateV1 {
	if (input.snapshot.schema !== "gentle-ai.review-snapshot/v1") {
		throw new ReviewIntegrityError("Unknown review snapshot schema");
	}
	if (input.snapshot.mode !== input.mode) {
		throw new ReviewIntegrityError("Review snapshot mode does not match the requested transaction mode");
	}
	let route = input.snapshot.route;
	let lenses = [...input.snapshot.lenses];
	if (input.mode === REVIEW_MODE.ORDINARY) {
		const derived = classifyReviewRoute(input.snapshot.diff_evidence);
		if (
			derived.route !== input.snapshot.route ||
			canonicalHash(derived.lenses) !== canonicalHash(input.snapshot.lenses)
		) {
			throw new ReviewIntegrityError("Review route and lenses were not derived from the snapshot diff");
		}
		route = derived.route;
		lenses = [...derived.lenses];
	} else if (
		input.mode === REVIEW_MODE.JUDGMENT_DAY &&
		(input.snapshot.route !== REVIEW_ROUTE.TRIVIAL || input.snapshot.lenses.length !== 0)
	) {
		throw new ReviewIntegrityError("Judgment Day snapshot must not carry ordinary route classification");
	}
	const result: ReviewStateV1 = {
		schema: "gentle-ai.review-state/v1",
		lineage_id: input.lineageId,
		mode: input.mode,
		revision: 0,
		phase: REVIEW_PHASE.STARTED,
		base_tree: input.snapshot.base_tree,
		complete_snapshot_tree: input.snapshot.complete_snapshot_tree,
		review_projection: cloneCanonical(input.snapshot.review_projection),
		initial_review_tree: input.snapshot.initial_review_tree,
		...(input.snapshot.genesis_paths === undefined ? {} : { genesis_paths: cloneCanonical(input.snapshot.genesis_paths) }),
		snapshot_object_store: cloneCanonical(input.snapshot.object_store),
		current_candidate_tree: input.snapshot.initial_review_tree,
		route,
		lenses: Object.freeze(lenses),
		policy_hash: input.snapshot.policy_hash,
		evidence_hash: input.evidenceHash,
		budget: cloneCanonical(input.budget),
		counters: zeroCounters(),
		request_journal: [],
	};
	if (input.parentLineageId !== undefined) result.parent_lineage_id = input.parentLineageId;
	assertState(result);
	if (input.mode === REVIEW_MODE.ORDINARY && result.genesis_paths === undefined) {
		throw new ReviewIntegrityError("New ordinary lineages require immutable genesis paths");
	}
	return result;
}

function assertState(state: ReviewStateV1, previous?: ReviewStateV1): void {
	if (state.schema !== "gentle-ai.review-state/v1") {
		throw new ReviewIntegrityError("Unknown review state schema");
	}
	assertLineageId(state.lineage_id);
	if (state.parent_lineage_id !== undefined) assertLineageId(state.parent_lineage_id);
	if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
		throw new ReviewIntegrityError("Invalid state revision");
	}
	for (const [label, value] of [
		["base tree", state.base_tree],
		["complete snapshot tree", state.complete_snapshot_tree],
		["initial review tree", state.initial_review_tree],
		["current candidate tree", state.current_candidate_tree],
	] as const) {
		assertObjectId(value, label);
	}
	if (state.final_candidate_tree !== undefined) {
		assertObjectId(state.final_candidate_tree, "final candidate tree");
	}
	assertDigest(state.policy_hash, "policy hash");
	assertDigest(state.evidence_hash, "evidence hash");
	assertProjectionBinding(
		state.review_projection,
		state.complete_snapshot_tree,
		state.initial_review_tree,
	);
	if (state.genesis_paths !== undefined) assertCanonicalPaths(state.genesis_paths, "Genesis paths");
	assertBudget(state.budget);
	assertCounters(state.counters, state.budget, previous?.counters);
	if (state.frozen_ledger) assertFrozenLedgerIntegrity(state.frozen_ledger);
	if (state.fix_record) {
		assertObjectId(state.fix_record.candidate_tree, "fix candidate tree");
		assertDigest(state.fix_record.fix_diff_hash, "fix diff hash");
		if (canonicalHash(state.fix_record.fix_diff) !== state.fix_record.fix_diff_hash) {
			throw new ReviewIntegrityError("Fix diff hash mismatch");
		}
	}
	if (state.validation_evidence) assertValidationEvidence(state.validation_evidence);
	if (state.active_finding_ids) {
		const unique = new Set(state.active_finding_ids);
		if (unique.size !== state.active_finding_ids.length) {
			throw new ReviewIntegrityError("Active finding IDs must be unique");
		}
		if (state.frozen_ledger) {
			const frozenIds = new Set(state.frozen_ledger.rows.map(({ id }) => id));
			if (state.active_finding_ids.some((id) => !frozenIds.has(id))) {
				throw new ReviewIntegrityError("Active finding ID is not frozen");
			}
		}
	}
	if (state.child_claims) {
		const targets = new Set<string>();
		for (const claim of state.child_claims) {
			if (claim.parent_lineage_id !== state.lineage_id) {
				throw new ReviewIntegrityError("Child claim parent does not match its authoritative lineage");
			}
			assertObjectId(claim.target_tree, "child claim target tree");
			assertBudget(claim.budget);
			if (
				claim.child_lineage_id !==
				canonicalHash({
					parent_lineage_id: claim.parent_lineage_id,
					target_tree: claim.target_tree,
				})
			) {
				throw new ReviewIntegrityError("Child claim identity mismatch");
			}
			if (targets.has(claim.target_tree)) {
				throw new ReviewIntegrityError("Child claim target must be unique per parent lineage");
			}
			targets.add(claim.target_tree);
		}
	}
	const journalKeys = new Set<string>();
	let pendingEntries = 0;
	for (const entry of state.request_journal) {
		if (journalKeys.has(entry.idempotency_key)) {
			throw new ReviewIntegrityError("Request journal idempotency keys must be unique");
		}
		journalKeys.add(entry.idempotency_key);
		assertDigest(entry.request_hash, "journal request hash");
		if (entry.status === JOURNAL_STATUS.PENDING) pendingEntries += 1;
		else if (entry.status !== JOURNAL_STATUS.COMPLETED) {
			throw new ReviewIntegrityError("Request journal has an unsupported status");
		}
	}
	if (pendingEntries > 1) {
		throw new ReviewIntegrityError("Only one pending operation may exist per lineage");
	}
	if (state.terminal_state !== undefined && state.phase !== REVIEW_PHASE.TERMINAL) {
		throw new ReviewIntegrityError("Terminal state requires terminal phase");
	}
	if (previous) assertImmutableState(previous, state);
}

function assertImmutableState(previous: ReviewStateV1, next: ReviewStateV1): void {
	const previousBinding = {
		schema: previous.schema,
		lineage_id: previous.lineage_id,
		parent_lineage_id: previous.parent_lineage_id,
		mode: previous.mode,
		base_tree: previous.base_tree,
		complete_snapshot_tree: previous.complete_snapshot_tree,
		review_projection: previous.review_projection,
		initial_review_tree: previous.initial_review_tree,
		genesis_paths: previous.genesis_paths,
		snapshot_object_store: previous.snapshot_object_store,
		route: previous.route,
		lenses: previous.lenses,
		policy_hash: previous.policy_hash,
		budget: previous.budget,
	};
	const nextBinding = {
		schema: next.schema,
		lineage_id: next.lineage_id,
		parent_lineage_id: next.parent_lineage_id,
		mode: next.mode,
		base_tree: next.base_tree,
		complete_snapshot_tree: next.complete_snapshot_tree,
		review_projection: next.review_projection,
		initial_review_tree: next.initial_review_tree,
		genesis_paths: next.genesis_paths,
		snapshot_object_store: next.snapshot_object_store,
		route: next.route,
		lenses: next.lenses,
		policy_hash: next.policy_hash,
		budget: next.budget,
	};
	if (canonicalize(previousBinding) !== canonicalize(nextBinding)) {
		throw new ReviewIntegrityError("Immutable review binding changed");
	}
	if (
		previous.frozen_ledger &&
		(!next.frozen_ledger ||
			canonicalHash(previous.frozen_ledger) !== canonicalHash(next.frozen_ledger))
	) {
		throw new ReviewIntegrityError("Frozen review ledger changed after publication");
	}
	if (previous.terminal_state !== undefined) {
		const previousTerminalAuthority = {
			phase: previous.phase,
			current_candidate_tree: previous.current_candidate_tree,
			final_candidate_tree: previous.final_candidate_tree,
			frozen_ledger: previous.frozen_ledger,
			evidence_hash: previous.evidence_hash,
			counters: previous.counters,
			resolutions: previous.resolutions,
			fix_record: previous.fix_record,
			active_finding_ids: previous.active_finding_ids,
			escalation_reasons: previous.escalation_reasons,
			terminal_state: previous.terminal_state,
		};
		const nextTerminalAuthority = {
			phase: next.phase,
			current_candidate_tree: next.current_candidate_tree,
			final_candidate_tree: next.final_candidate_tree,
			frozen_ledger: next.frozen_ledger,
			evidence_hash: next.evidence_hash,
			counters: next.counters,
			resolutions: next.resolutions,
			fix_record: next.fix_record,
			active_finding_ids: next.active_finding_ids,
			escalation_reasons: next.escalation_reasons,
			terminal_state: next.terminal_state,
		};
		if (canonicalize(previousTerminalAuthority) !== canonicalize(nextTerminalAuthority)) {
			throw new ReviewIntegrityError("Terminal review authority is closed and immutable");
		}
	}
}

export function createReceiptEnvelope(body: ReceiptBodyV1): ReceiptEnvelopeV1 {
	assertReceiptBody(body);
	const canonicalBody = cloneCanonical(body);
	return { body: canonicalBody, receipt_hash: canonicalHash(canonicalBody) };
}

function assertReceiptBody(body: ReceiptBodyV1): void {
	if (body.schema !== "gentle-ai.review-receipt-body/v1") {
		throw new ReviewIntegrityError("Unknown receipt body schema");
	}
	assertLineageId(body.lineage_id);
	for (const [label, value] of [
		["base tree", body.base_tree],
		["complete snapshot tree", body.complete_snapshot_tree],
		["initial review tree", body.initial_review_tree],
		["final candidate tree", body.final_candidate_tree],
	] as const) {
		assertObjectId(value, label);
	}
	assertProjectionBinding(
		body.review_projection,
		body.complete_snapshot_tree,
		body.initial_review_tree,
	);
	assertDigest(body.policy_hash, "policy hash");
	assertDigest(body.frozen_ledger_hash, "frozen ledger hash");
	assertDigest(body.evidence_hash, "evidence hash");
	assertBudget(body.budget);
	assertCounters(body.counters, body.budget);
}

export function assertReceiptIntegrity(envelope: ReceiptEnvelopeV1): void {
	assertReceiptBody(envelope.body);
	assertDigest(envelope.receipt_hash, "receipt hash");
	if (canonicalHash(envelope.body) !== envelope.receipt_hash) {
		throw new ReviewIntegrityError("Receipt hash mismatch");
	}
}

export function reviewStoreRootForRepository(cwd: string): string {
	const repositoryRoot = execFileSync(
		"git",
		["rev-parse", "--show-toplevel"],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	).trim();
	const gitPath = execFileSync(
		"git",
		["rev-parse", "--git-path", "gentle-ai/reviews"],
		{ cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	).trim();
	return isAbsolute(gitPath) ? gitPath : resolve(repositoryRoot, gitPath);
}

function repositoryRootForGate(cwd: string): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}).trim();
}

function createScopeChildClaim(
	parentLineageId: string,
	targetTree: string,
	budget: ReviewBudgetV1,
): ChildClaimV1 {
	assertLineageId(parentLineageId);
	assertObjectId(targetTree, "scope target tree");
	assertBudget(budget);
	const identity = {
		parent_lineage_id: parentLineageId,
		target_tree: targetTree,
	};
	return {
		...identity,
		child_lineage_id: canonicalHash(identity),
		budget: cloneCanonical(budget),
	};
}

function operationForTransition(transition: ReviewTransition): ReviewOperation {
	switch (transition) {
		case REVIEW_TRANSITION.ORDINARY_DISCOVERY:
		case REVIEW_TRANSITION.JUDGMENT_DAY_DISCOVERY:
			return REVIEW_OPERATION.FREEZE_LEDGER;
		case REVIEW_TRANSITION.ORDINARY_EVIDENCE:
		case REVIEW_TRANSITION.JUDGMENT_DAY_REJUDGMENT:
			return REVIEW_OPERATION.RESOLVE_EVIDENCE;
		case REVIEW_TRANSITION.ORDINARY_FIX:
		case REVIEW_TRANSITION.ORDINARY_NO_FIX:
		case REVIEW_TRANSITION.JUDGMENT_DAY_FIX:
			return REVIEW_OPERATION.AUTHORIZE_FIX;
		case REVIEW_TRANSITION.ORDINARY_VALIDATION:
			return REVIEW_OPERATION.VALIDATE_FIX;
		case REVIEW_TRANSITION.ORDINARY_FINAL_VERIFICATION:
		case REVIEW_TRANSITION.JUDGMENT_DAY_FINAL_VERIFICATION:
			return REVIEW_OPERATION.VERIFY;
	}
	throw new ReviewIntegrityError(`Unsupported reducer transition: ${transition}`);
}

function reduceReviewState(
	state: ReviewStateV1,
	transition: ReviewTransition,
	input: ReviewReducerInput,
): ReviewStateV1 {
	switch (transition) {
		case REVIEW_TRANSITION.ORDINARY_DISCOVERY:
			return recordOrdinaryDiscovery(state, input as OrdinaryDiscoveryInput);
		case REVIEW_TRANSITION.ORDINARY_EVIDENCE:
			return resolveOrdinaryEvidence(state, input as OrdinaryEvidenceInput);
		case REVIEW_TRANSITION.ORDINARY_FIX:
			return applyOrdinaryFix(state, input as OrdinaryFixInput);
		case REVIEW_TRANSITION.ORDINARY_NO_FIX:
			return declineOrdinaryFix(state, (input as { reason: string }).reason);
		case REVIEW_TRANSITION.ORDINARY_VALIDATION:
			return recordOrdinaryValidation(state, input as OrdinaryValidationInput);
		case REVIEW_TRANSITION.ORDINARY_FINAL_VERIFICATION:
			return recordOrdinaryFinalVerification(
				state,
				input as OrdinaryFinalVerificationInput,
			);
		case REVIEW_TRANSITION.JUDGMENT_DAY_DISCOVERY:
			return recordJudgmentDayDiscovery(state, input as JudgmentDayDiscoveryInput);
		case REVIEW_TRANSITION.JUDGMENT_DAY_FIX:
			return applyJudgmentDayFix(state, input as JudgmentDayFixInput);
		case REVIEW_TRANSITION.JUDGMENT_DAY_REJUDGMENT:
			return recordJudgmentDayRejudgment(
				state,
				input as JudgmentDayRejudgmentInput,
			);
		case REVIEW_TRANSITION.JUDGMENT_DAY_FINAL_VERIFICATION:
			return recordJudgmentDayFinalVerification(
				state,
				input as JudgmentDayFinalVerificationInput,
			);
	}
	throw new ReviewIntegrityError(`Unsupported reducer transition: ${transition}`);
}

export function validateReviewGraphReplayV1(events: readonly ReturnType<ReviewGraphObjectStoreV1["readEvent"]>[]): ReviewStateV1 {
	if (events.length === 0) throw new ReviewIntegrityError("Graph replay requires a genesis event");
	let previous: ReviewStateV1 | undefined;
	for (const [index, event] of events.entries()) {
		const payload = event.body.payload as { state?: ReviewStateV1 };
		if (!payload?.state || canonicalHash(payload.state) !== event.body.reduced_state_hash) throw new ReviewIntegrityError("Graph event state reduction is invalid");
		if (event.body.reducer_transition === undefined || event.body.reducer_input === undefined) throw new ReviewIntegrityError("Graph event lacks canonical reducer transition/input");
		const state = payload.state;
		assertState(state, previous);
		if (index === 0) {
			if (event.body.reducer_transition !== "start" || canonicalHash(event.body.reducer_input) !== canonicalHash(state)) throw new ReviewIntegrityError("Graph genesis reducer input is invalid");
		} else if (event.body.reducer_transition === "operation-prepared") {
			const input = event.body.reducer_input as { transition?: unknown; request?: unknown };
			if (typeof input.transition !== "string" || !(Object.values(REVIEW_TRANSITION) as string[]).includes(input.transition)) throw new ReviewIntegrityError("Graph prepared operation transition is invalid");
			const expected = { ...previous!, revision: state.revision, request_journal: state.request_journal };
			if (canonicalHash(expected) !== canonicalHash(state)) throw new ReviewIntegrityError("Graph prepared operation replay does not match event state");
		} else if (event.body.reducer_transition === "gate") {
			if (event.body.kind !== "gate-evaluated" || !Array.isArray(state.request_journal) || state.request_journal.length !== previous!.request_journal.length + 1 || canonicalHash(state.request_journal.slice(0, -1)) !== canonicalHash(previous!.request_journal)) throw new ReviewIntegrityError("Graph gate replay journal is invalid");
			const journal = state.request_journal.at(-1);
			if (!journal || journal.operation !== REVIEW_OPERATION.GATE || journal.status !== JOURNAL_STATUS.COMPLETED || journal.request_hash !== canonicalHash(event.body.reducer_input)) throw new ReviewIntegrityError("Graph gate replay request is invalid");
			const priorClaims = previous!.child_claims ?? [];
			const nextClaims = state.child_claims ?? [];
			if (nextClaims.length < priorClaims.length || canonicalHash(nextClaims.slice(0, priorClaims.length)) !== canonicalHash(priorClaims) || nextClaims.length > priorClaims.length + 1) throw new ReviewIntegrityError("Graph gate replay claims are invalid");
			const expected = { ...previous!, revision: state.revision, request_journal: state.request_journal, ...(nextClaims.length === 0 ? {} : { child_claims: nextClaims }) };
			if (canonicalHash(expected) !== canonicalHash(state)) throw new ReviewIntegrityError("Graph gate replay does not match event state");
		} else if ((Object.values(REVIEW_TRANSITION) as string[]).includes(event.body.reducer_transition)) {
			const replayed = reduceReviewState(previous!, event.body.reducer_transition as ReviewTransition, event.body.reducer_input);
			const expected = { ...replayed, revision: state.revision, request_journal: state.request_journal };
			if (canonicalHash(expected) !== canonicalHash(state)) throw new ReviewIntegrityError("Graph adjacent reducer replay does not match event state");
		} else {
			throw new ReviewIntegrityError("Graph event reducer transition is unsupported");
		}
		previous = state;
	}
	return cloneCanonical(previous!);
}

function reducerOperationResult(
	state: ReviewStateV1,
	revision: number,
): ReducerOperationResultV1 {
	const result: ReducerOperationResultV1 = {
		revision,
		phase: state.phase,
	};
	if (state.terminal_state !== undefined) result.terminal_state = state.terminal_state;
	return result;
}

export class ReviewTransactionStore {
	readonly root: string;
	readonly faultInjector?: (point: StoreFaultPoint) => void;
	readonly #authority: RepositoryAuthorityV1;
	readonly #authorityCwd: string;
	readonly #graphStore: ReviewGraphObjectStoreV1;
	readonly #mutationLock: ReviewMutationLockV1;

	private constructor(options: ReviewTransactionStoreOptions, authority: RepositoryAuthorityV1, authorityCwd: string) {
		this.root = join(authority.store_root, "graph-v1");
		this.faultInjector = options.faultInjector;
		this.#authority = authority;
		this.#authorityCwd = authorityCwd;
		this.#graphStore = new ReviewGraphObjectStoreV1(this.root, authority.repository_id, authority.authority_id, {
			faultInjector: (point) => {
				if (point === "before-current-slot-1-replace") this.faultInjector?.(STORE_FAULT_POINT.BEFORE_HEAD_RENAME);
			},
		});
		this.#mutationLock = new ReviewMutationLockV1(join(authority.store_root, "control"), authority.repository_id, authority.authority_id, options.mutationLockPlatform);
	}

	static forRepository(
		cwd: string,
		options: Pick<ReviewTransactionStoreOptions, "faultInjector" | "mutationLockPlatform"> = {},
	): ReviewTransactionStore {
		const authority = resolveRepositoryAuthorityV1(cwd);
		assertNoLegacyReviewAuthorityV1(cwd);
		return new ReviewTransactionStore({ faultInjector: options.faultInjector, mutationLockPlatform: options.mutationLockPlatform ?? mutationLockPlatformForTesting }, authority, cwd);
	}

	readCurrentAuthority(): ReturnType<ReviewGraphObjectStoreV1["readCurrent"]> {
		return this.#graphStore.readCurrent();
	}

	repairCurrentAuthority(): void {
		this.withLock("authority-repair", () => this.#graphStore.repairCurrentPointers());
	}

	create(
		initialState: ReviewStateV1,
		idempotencyKey: string,
	): StartOperationResultV1 {
		assertState(initialState);
		if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
			throw new ReviewIntegrityError("Lineage start requires an idempotency key");
		}
		if (
			initialState.revision !== 0 ||
			initialState.request_journal.length !== 0 ||
			initialState.phase !== REVIEW_PHASE.STARTED ||
			initialState.terminal_state !== undefined ||
			initialState.frozen_ledger !== undefined
		) {
			throw new ReviewIntegrityError("A new lineage must start only through a clean started state");
		}
		const requestHash = canonicalHash(initialState);
		const result: StartOperationResultV1 = {
			lineage_id: initialState.lineage_id,
			revision: 0,
			phase: REVIEW_PHASE.STARTED,
		};
		return this.withLock(initialState.lineage_id, () => {
			const started: ReviewStateV1 = {
				...cloneCanonical(initialState),
				request_journal: [
					{
						operation: REVIEW_OPERATION.START,
						idempotency_key: idempotencyKey,
						request_hash: requestHash,
						status: JOURNAL_STATUS.COMPLETED,
						canonical_result: result,
					},
				],
			};
			assertState(started);
			this.writeRevision(started, undefined, { transition: "start", input: started });
			return cloneCanonical(result);
		});
	}

	read(lineageId: string): ReviewStateV1 {
		assertLineageId(lineageId);
		return this.readUnlocked(lineageId);
	}

	runReducerOperation(
		options: RunReducerOperationOptions,
	): ReducerOperationResultV1 {
		const operation = operationForTransition(options.transition);
		return this.#runCompletedOperation({
			lineageId: options.lineageId,
			operation,
			idempotencyKey: options.idempotencyKey,
			request: { transition: options.transition, input: options.input },
			apply(current) {
				const reduced = reduceReviewState(current, options.transition, options.input);
				return {
					state: reduced,
					result: reducerOperationResult(reduced, current.revision + 1),
				};
			},
		});
	}

	beginReducerOperation<TRequest>(
		options: BeginReducerOperationOptions<TRequest>,
	): void {
		const operation = operationForTransition(options.transition);
		this.withLock(options.lineageId, () => {
			const current = this.readUnlocked(options.lineageId);
			const requestHash = canonicalHash({
				transition: options.transition,
				request: options.request,
			});
			const existing = current.request_journal.find(
				(entry) => entry.idempotency_key === options.idempotencyKey,
			);
			if (existing) {
				if (existing.operation !== operation || existing.request_hash !== requestHash) {
					throw new ReviewIntegrityError("Idempotency key was reused with a different request");
				}
				throw new ReviewIntegrityError(
					existing.status === JOURNAL_STATUS.PENDING
						? "Unresolved pending operation blocks replay"
						: "Completed operation cannot be reopened",
				);
			}
			this.assertNoPendingOperation(current);
			const entry: RequestJournalEntryV1 = {
				operation,
				idempotency_key: options.idempotencyKey,
				request_hash: requestHash,
				status: JOURNAL_STATUS.PENDING,
			};
			if (options.authorization !== undefined) {
				entry.authorization = cloneCanonical(options.authorization);
			}
			const next: ReviewStateV1 = {
				...current,
				revision: current.revision + 1,
				request_journal: [...current.request_journal, entry],
			};
			assertState(next, current);
			this.writeRevision(next, current, { transition: "operation-prepared", input: { transition: options.transition, request: options.request } });
		});
	}

	completeReducerOperation<TRequest>(
		options: CompleteReducerOperationOptions<TRequest>,
	): ReducerOperationResultV1 {
		const operation = operationForTransition(options.transition);
		return this.withLock(options.lineageId, () => {
			const current = this.readUnlocked(options.lineageId);
			const requestHash = canonicalHash({
				transition: options.transition,
				request: options.request,
			});
			const index = current.request_journal.findIndex(
				(entry) => entry.idempotency_key === options.idempotencyKey,
			);
			if (index < 0) throw new ReviewIntegrityError("Pending reducer operation was not found");
			const existing = current.request_journal[index]!;
			if (existing.operation !== operation || existing.request_hash !== requestHash) {
				throw new ReviewIntegrityError("Idempotency key was reused with a different request");
			}
			if (existing.status === JOURNAL_STATUS.COMPLETED) {
				return cloneCanonical(existing.canonical_result) as ReducerOperationResultV1;
			}
			const reduced = reduceReviewState(current, options.transition, options.input);
			const result = reducerOperationResult(reduced, current.revision + 1);
			const completed: RequestJournalEntryV1 = {
				...existing,
				status: JOURNAL_STATUS.COMPLETED,
				canonical_result: cloneCanonical(result),
			};
			const journal = [...current.request_journal];
			journal[index] = completed;
			const next: ReviewStateV1 = {
				...cloneCanonical(reduced),
				revision: current.revision + 1,
				request_journal: journal,
			};
			assertState(next, current);
			this.writeRevision(next, current, { transition: options.transition, input: options.input });
			return cloneCanonical(result);
		});
	}

	#validateGate(
		options: Omit<ValidateReviewGateOptions, "store">,
		beforeReplay?: () => void,
	): GateResultV1 {
		const targetHash = canonicalHash(options.target);
		const repositoryRoot = repositoryRootForGate(options.repositoryCwd);
		return this.#runCompletedOperation({
			lineageId: options.receipt.body.lineage_id,
			operation: REVIEW_OPERATION.GATE,
			idempotencyKey: options.idempotencyKey,
			request: {
				receipt_hash: options.receipt.receipt_hash,
				target_hash: targetHash,
				repository_root: repositoryRoot,
				actual_intended_commit_tree: options.actualIntendedCommitTree ?? null,
			},
			beforeReplay,
			apply(state) {
				assertReceiptIntegrity(options.receipt);
				assertReceiptMatchesState(options.receipt, state);
				const evaluated = evaluateGateTarget(
					options.receipt,
					options.target,
					repositoryRoot,
					options.actualIntendedCommitTree,
				);
				if (evaluated.status !== GATE_RESULT.SCOPE_CHANGED) {
					return { state, result: evaluated };
				}
				const inspection = inspectGateTarget(
					options.target,
					options.receipt,
					repositoryRoot,
					options.actualIntendedCommitTree,
				);
				if (!inspection.targetTree) {
					return {
						state,
						result: deniedGateResult(
							options.receipt.receipt_hash,
							targetHash,
							"Changed scope does not resolve to one target tree.",
						),
					};
				}
				const existingClaim = state.child_claims?.find(
					(claim) => claim.target_tree === inspection.targetTree,
				);
				const childClaim = existingClaim ?? createScopeChildClaim(
					state.lineage_id,
					inspection.targetTree,
					options.scopeBudget,
				);
				const next = existingClaim
					? state
					: {
						...state,
						child_claims: [...(state.child_claims ?? []), childClaim],
					};
				return {
					state: next,
					result: { ...evaluated, child_claim: childClaim },
				};
			},
		});
	}

	#runCompletedOperation<TRequest, TResult>(
		options: RunOperationOptions<TRequest, TResult>,
	): TResult {
		return this.withLock(options.lineageId, () => {
			const current = this.readUnlocked(options.lineageId);
			const requestHash = canonicalHash(options.request);
			const existing = current.request_journal.find(
				(entry) => entry.idempotency_key === options.idempotencyKey,
			);
			if (existing) {
				if (existing.operation !== options.operation || existing.request_hash !== requestHash) {
					throw new ReviewIntegrityError("Idempotency key was reused with a different request");
				}
				if (existing.status === JOURNAL_STATUS.PENDING) {
					throw new ReviewIntegrityError("Unresolved pending operation blocks replay");
				}
				return cloneCanonical(existing.canonical_result) as TResult;
			}
			options.beforeReplay?.();
			this.assertNoPendingOperation(current);
			const applied = options.apply(cloneCanonical(current));
			const result = cloneCanonical(applied.result);
			const journalEntry: RequestJournalEntryV1 = {
				operation: options.operation,
				idempotency_key: options.idempotencyKey,
				request_hash: requestHash,
				status: JOURNAL_STATUS.COMPLETED,
				canonical_result: result,
			};
			const next: ReviewStateV1 = {
				...cloneCanonical(applied.state),
				revision: current.revision + 1,
				request_journal: [...current.request_journal, journalEntry],
			};
			assertState(next, current);
			const request = options.request as { transition?: unknown; input?: unknown };
			this.writeRevision(next, current, { transition: typeof request.transition === "string" ? request.transition : options.operation, input: "input" in request ? request.input : options.request });
			return result;
		});
	}

	private readUnlocked(lineageId: string): ReviewStateV1 {
		return this.readGraphState(lineageId);
	}

	private assertNoPendingOperation(state: ReviewStateV1): void {
		if (state.request_journal.some((entry) => entry.status === JOURNAL_STATUS.PENDING)) {
			throw new ReviewIntegrityError("Unresolved pending operation blocks mutation");
		}
	}

	private withLock<T>(lockId: string, action: () => T): T {
		assertLineageId(lockId);
		this.assertCurrentRepositoryAuthority();
		const owner = this.#mutationLock.acquire();
		try {
			return action();
		} finally {
			this.#mutationLock.release(owner);
		}
	}

	private assertCurrentRepositoryAuthority(): void {
		const current = resolveRepositoryAuthorityV1(this.#authorityCwd);
		if (
			current.common_directory !== this.#authority.common_directory ||
			current.repository_id !== this.#authority.repository_id ||
			current.authority_id !== this.#authority.authority_id
		) {
			throw new ReviewIntegrityError("Repository authority changed before graph mutation");
		}
	}

	private writeRevision(next: ReviewStateV1, previous?: ReviewStateV1, eventContext?: { transition: string; input: unknown }): void {
		this.writeGraphState(next, previous, eventContext);
	}

	private readGraphState(lineageId: string): ReviewStateV1 {
		const root = this.#graphStore.readCurrent();
		const descriptor = existsSync(join(this.#graphStore.root, "STORE")) ? this.#graphStore.readStoreDescriptor() : undefined;
		if (descriptor && (root.body.store_epoch !== descriptor.store_epoch || root.body.authority_incarnation_id !== descriptor.authority_incarnation_id || root.body.initialized_by_reset_id !== descriptor.initialized_by_reset_id)) throw new ReviewIntegrityError("Graph root does not match the live authority incarnation");
		const entry = (root.body.lineages as Array<Record<string, unknown>>).find((value) => value.lineage_id === lineageId && value.mode === "graph");
		if (!entry || typeof entry.head_event_id !== "string" || typeof entry.sequence !== "number" || typeof entry.reduced_state_hash !== "string") throw new ReviewIntegrityError("Graph lineage is missing from authoritative root set");
		let eventId: string | null = entry.head_event_id;
		let expectedSequence = entry.sequence;
		const reversed: Array<{ event: ReturnType<ReviewGraphObjectStoreV1["readEvent"]>; state: ReviewStateV1 }> = [];
		const seen = new Set<string>();
		while (eventId !== null) {
			if (seen.has(eventId)) throw new ReviewIntegrityError("Graph predecessor closure contains a cycle");
			seen.add(eventId);
			const event = this.#graphStore.readEvent(eventId);
			if (descriptor && (event.body.store_epoch !== descriptor.store_epoch || event.body.authority_incarnation_id !== descriptor.authority_incarnation_id || event.body.initialized_by_reset_id !== descriptor.initialized_by_reset_id)) throw new ReviewIntegrityError("Graph event does not match the live authority incarnation");
			if (event.body.lineage_id !== lineageId || event.body.sequence !== expectedSequence) throw new ReviewIntegrityError("Graph predecessor closure is discontinuous");
			const payload = event.body.payload as { state?: ReviewStateV1 };
			if (!payload || !payload.state || canonicalHash(payload.state) !== event.body.reduced_state_hash) throw new ReviewIntegrityError("Graph event state reduction is invalid");
			if (payload.state.lineage_id !== lineageId || payload.state.revision !== event.body.sequence) throw new ReviewIntegrityError("Graph event does not match lineage state");
			reversed.push({ event, state: payload.state });
			if (event.body.sequence === 0) {
				if (event.body.predecessor_event_id !== null || event.body.kind !== "lineage-created") throw new ReviewIntegrityError("Graph genesis is invalid");
				break;
			}
			eventId = event.body.predecessor_event_id;
			expectedSequence -= 1;
		}
		const ordered = reversed.reverse();
		let headState: ReviewStateV1;
		try { headState = validateReviewGraphReplayV1(ordered.map(({ event }) => event)); }
		catch (error) { throw new ReviewIntegrityError(`Authoritative graph semantic replay failed: ${error instanceof Error ? error.message : String(error)}`); }
		if (expectedSequence !== 0 || canonicalHash(headState) !== entry.reduced_state_hash) throw new ReviewIntegrityError("Graph root entry does not bind a complete reduced state");
		return cloneCanonical(headState);
	}

	private writeGraphState(next: ReviewStateV1, previous?: ReviewStateV1, eventContext?: { transition: string; input: unknown }): void {
		const graph = this.#graphStore;
		let current: ReturnType<ReviewGraphObjectStoreV1["readCurrent"]> | undefined;
		try { current = graph.readCurrent(); } catch {}
		const existing = current ? (current.body.lineages as Array<Record<string, unknown>>).find((value) => value.lineage_id === next.lineage_id && value.mode === "graph") : undefined;
		if (previous && !existing) throw new ReviewIntegrityError("Graph predecessor is missing");
		if (!previous && existing) throw new ReviewIntegrityError("Graph lineage already exists");
		const predecessor = existing?.head_event_id;
		if (predecessor !== undefined && typeof predecessor !== "string") throw new ReviewIntegrityError("Graph head is invalid");
		const last = next.request_journal.at(-1);
		const descriptor = (() => { try { return graph.readStoreDescriptor(); } catch { return undefined; } })();
		const reducerTransition = eventContext?.transition ?? (predecessor === undefined ? "start" : last?.operation ?? "state-update");
		const reducerInput = eventContext === undefined ? (predecessor === undefined ? cloneCanonical(next) : { request_hash: last?.request_hash }) : cloneCanonical(eventContext.input);
		const event = createReviewEventV1({ ...(descriptor === undefined ? {} : { store_epoch: descriptor.store_epoch, authority_incarnation_id: descriptor.authority_incarnation_id, initialized_by_reset_id: descriptor.initialized_by_reset_id }), lineage_id: next.lineage_id, sequence: next.revision, predecessor_event_id: predecessor ?? null, kind: predecessor === undefined ? "lineage-created" : last?.status === JOURNAL_STATUS.PENDING ? "operation-prepared" : last?.operation === REVIEW_OPERATION.GATE ? "gate-evaluated" : "operation-completed", reducer_transition: reducerTransition, reducer_input: reducerInput, payload: { state: cloneCanonical(next) }, reduced_state_hash: canonicalHash(next) });
		graph.installEvent(event);
		const lineages = [...(current?.body.lineages as Array<Record<string, unknown>> ?? []).filter((value) => value.lineage_id !== next.lineage_id), { lineage_id: next.lineage_id, mode: "graph", head_event_id: event.event_id, sequence: next.revision, reduced_state_hash: event.body.reduced_state_hash }].toSorted((a, b) => String(a.lineage_id).localeCompare(String(b.lineage_id)));
		const root = graph.installRootSet({ schema: "gentle-ai.review-root-set/v1", repository_id: this.#authority.repository_id, authority_id: this.#authority.authority_id, ...(descriptor === undefined ? {} : { store_epoch: descriptor.store_epoch, authority_incarnation_id: descriptor.authority_incarnation_id, initialized_by_reset_id: descriptor.initialized_by_reset_id }), generation: current ? current.body.generation + 1 : 0, predecessor_root_set_id: current ? current.root_set_id : null, lineages });
		graph.publishRootSet(root);
	}

	createAuthoritativeReceipt(lineageId: string): AuthoritativeReceiptV1 {
		const state = this.read(lineageId);
		const envelope = createReceiptForState(state);
		const root = this.#graphStore.readCurrent();
		const entry = (root.body.lineages as Array<Record<string, unknown>>).find((value) => value.lineage_id === lineageId && value.mode === "graph");
		if (!entry || typeof entry.head_event_id !== "string") throw new ReviewIntegrityError("Authoritative graph head is missing");
		const descriptor = (() => { try { return this.#graphStore.readStoreDescriptor(); } catch { return undefined; } })();
		const body = { receipt_hash: envelope.receipt_hash, repository_id: this.#authority.repository_id, authority_id: this.#authority.authority_id, common_directory: this.#authority.common_directory, root_set_id: root.root_set_id, head_event_id: entry.head_event_id, ...(descriptor === undefined ? {} : { store_epoch: descriptor.store_epoch, authority_incarnation_id: descriptor.authority_incarnation_id }) };
		return Object.freeze({ [authoritativeReceiptBrand]: true as const, envelope, repository_id: this.#authority.repository_id, authority_id: this.#authority.authority_id, common_directory: this.#authority.common_directory, root_set_id: root.root_set_id, head_event_id: entry.head_event_id, ...(descriptor === undefined ? {} : { store_epoch: descriptor.store_epoch, authority_incarnation_id: descriptor.authority_incarnation_id }), authority_receipt_hash: canonicalHash(body) });
	}

	validateAuthoritativeGate(options: Omit<ValidateReviewGateOptions, "store" | "receipt"> & { receipt: AuthoritativeReceiptV1 }): GateResultV1 {
		if (options.receipt[authoritativeReceiptBrand] !== true) throw new ReviewIntegrityError("Lifecycle gates require a branded authoritative receipt");
		const gateAuthority = resolveRepositoryAuthorityV1(options.repositoryCwd);
		if (gateAuthority.common_directory !== this.#authority.common_directory || gateAuthority.repository_id !== options.receipt.repository_id || gateAuthority.authority_id !== options.receipt.authority_id) throw new ReviewIntegrityError("Gate repository authority does not match receipt authority");
		return this.#validateGate({ ...options, receipt: options.receipt.envelope }, () => {
			const descriptor = (() => { try { return this.#graphStore.readStoreDescriptor(); } catch { return undefined; } })();
			if ((options.receipt.store_epoch !== undefined || options.receipt.authority_incarnation_id !== undefined) && (!descriptor || options.receipt.store_epoch !== descriptor.store_epoch || options.receipt.authority_incarnation_id !== descriptor.authority_incarnation_id)) throw new ReviewIntegrityError("REVIEW_RECEIPT_EPOCH_MISMATCH");
			const currentRoot = this.#graphStore.readCurrent();
			const currentEntry = (currentRoot.body.lineages as Array<Record<string, unknown>>).find((value) => value.lineage_id === options.receipt.envelope.body.lineage_id && value.mode === "graph");
			if (!currentEntry || currentRoot.root_set_id !== options.receipt.root_set_id || currentEntry.head_event_id !== options.receipt.head_event_id) throw new ReviewIntegrityError("Authoritative receipt is stale or unbound from the current graph head");
		});
	}

}

interface GateTargetInspection {
	valid: boolean;
	matchesReceipt: boolean;
	targetTree?: string;
	reason: string;
}

const FULL_REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectId(value: unknown): value is string {
	return typeof value === "string" && OBJECT_ID.test(value);
}

function isFullRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
		FULL_REF.test(value) &&
		!value.includes("..") &&
		!value.includes("//") &&
		!value.includes("/.") &&
		!value.endsWith("/") &&
		!value.endsWith(".")
	);
}

function runGateGit(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}).trim();
}

function resolveGateObject(cwd: string, objectId: string, label: string): string {
	if (!isObjectId(objectId)) throw new ReviewIntegrityError(`${label} is not an object ID`);
	const resolved = runGateGit(cwd, ["rev-parse", "--verify", `${objectId}^{object}`]);
	if (resolved !== objectId) throw new ReviewIntegrityError(`${label} does not resolve exactly`);
	return resolved;
}

function resolveGateRef(cwd: string, ref: string, label: string): string {
	if (!isFullRef(ref)) throw new ReviewIntegrityError(`${label} is not a full ref`);
	return runGateGit(cwd, ["rev-parse", "--verify", `${ref}^{object}`]);
}

function assertTreeObject(cwd: string, tree: string, label: string): void {
	resolveGateObject(cwd, tree, label);
	if (runGateGit(cwd, ["cat-file", "-t", tree]) !== "tree") {
		throw new ReviewIntegrityError(`${label} is not a tree object`);
	}
}

function assertCommitBinding(
	cwd: string,
	objectId: string,
	peeledCommit: string,
	tree: string,
	label: string,
): void {
	resolveGateObject(cwd, objectId, `${label} object`);
	resolveGateObject(cwd, peeledCommit, `${label} peeled commit`);
	assertTreeObject(cwd, tree, `${label} tree`);
	const resolvedCommit = runGateGit(cwd, [
		"rev-parse",
		"--verify",
		`${objectId}^{commit}`,
	]);
	if (resolvedCommit !== peeledCommit) {
		throw new ReviewIntegrityError(`${label} object does not peel to the supplied commit`);
	}
	const resolvedTree = runGateGit(cwd, [
		"rev-parse",
		"--verify",
		`${peeledCommit}^{tree}`,
	]);
	if (resolvedTree !== tree) {
		throw new ReviewIntegrityError(`${label} commit does not resolve to the supplied tree`);
	}
}

function inspectPushTarget(
	target: Record<string, unknown>,
	receipt: ReceiptEnvelopeV1,
	repositoryCwd: string,
): GateTargetInspection {
	if (typeof target.remote !== "string") {
		return { valid: false, matchesReceipt: false, reason: "Push target requires an exact remote identity." };
	}
	if (typeof target.destination_id !== "string" || !DIGEST.test(target.destination_id)) {
		return { valid: false, matchesReceipt: false, reason: "Push target requires one bound publication destination." };
	}
	if (!Array.isArray(target.updates) || target.updates.length === 0) {
		return { valid: false, matchesReceipt: false, reason: "Push target requires a complete non-empty update set." };
	}
	const updateKeys: string[] = [];
	const newTrees = new Set<string>();
	let matchesReceipt = true;
	for (const value of target.updates) {
		if (!isRecord(value)) {
			return { valid: false, matchesReceipt: false, reason: "Push update is malformed." };
		}
		if (!isFullRef(value.source_ref) || !isFullRef(value.destination_ref)) {
			return { valid: false, matchesReceipt: false, reason: "Push update refs must be fully resolved." };
		}
		if (
			!isObjectId(value.new_object) ||
			!isObjectId(value.new_peeled_commit) ||
			!isObjectId(value.new_tree)
		) {
			return { valid: false, matchesReceipt: false, reason: "Push new identity is unresolved." };
		}
		if (resolveGateRef(repositoryCwd, value.source_ref, "push source ref") !== value.new_object) {
			return { valid: false, matchesReceipt: false, reason: "Push source ref does not resolve to its supplied new object." };
		}
		assertCommitBinding(
			repositoryCwd,
			value.new_object,
			value.new_peeled_commit,
			value.new_tree,
			"push new identity",
		);
		updateKeys.push(`${value.destination_ref}\u0000${value.source_ref}`);
		newTrees.add(value.new_tree);
		if (value.new_tree !== receipt.body.final_candidate_tree) matchesReceipt = false;
		if (value.kind === PUSH_UPDATE_KIND.CREATE) {
			if (
				value.old_object !== null ||
				value.old_peeled_commit !== null ||
				value.old_tree !== null
			) {
				return { valid: false, matchesReceipt: false, reason: "Push create must bind an explicitly absent old identity." };
			}
			if (
				resolvePushRemoteRefV1(
					repositoryCwd,
					target.remote,
					value.destination_ref,
					"push remote destination ref",
					target.destination_id,
				).object_id !== null
			) {
				return { valid: false, matchesReceipt: false, reason: "Push create destination ref already exists." };
			}
			if (value.destination_ref.startsWith("refs/tags/")) {
				if (!value.source_ref.startsWith("refs/tags/") || value.source_ref !== value.destination_ref) {
					return { valid: false, matchesReceipt: false, reason: "Push tag create requires one exact matching tag source and destination ref." };
				}
				if (value.new_tree !== receipt.body.final_candidate_tree) {
					return { valid: false, matchesReceipt: false, reason: "Push tag create tree does not match the approved receipt final candidate." };
				}
				if (!pushRemoteAdvertisesObjectV1(repositoryCwd, target.remote, target.destination_id, value.new_peeled_commit)) {
					return { valid: false, matchesReceipt: false, reason: "Push tag create peeled commit is not advertised by the bound publication destination." };
				}
			} else {
				const parentLine = runGateGit(repositoryCwd, ["rev-list", "--parents", "-n", "1", value.new_peeled_commit]);
				const parents = parentLine.split(" ");
				if (parents.length !== 2 || parents[0] !== value.new_peeled_commit || !isObjectId(parents[1])) {
					return { valid: false, matchesReceipt: false, reason: "Push create requires exactly one resolved parent commit." };
				}
				const parent = parents[1]!;
				if (runGateGit(repositoryCwd, ["rev-parse", "--verify", `${parent}^{tree}`]) !== receipt.body.base_tree) {
					return { valid: false, matchesReceipt: false, reason: "Push create parent tree does not match the approved receipt base tree." };
				}
				if (!pushRemoteAdvertisesObjectV1(repositoryCwd, target.remote, target.destination_id, parent)) {
					return { valid: false, matchesReceipt: false, reason: "Push create parent is not advertised by the bound publication destination." };
				}
			}
		} else if (value.kind === PUSH_UPDATE_KIND.UPDATE) {
			if (
				!isObjectId(value.old_object) ||
				!isObjectId(value.old_peeled_commit) ||
				!isObjectId(value.old_tree)
			) {
				return { valid: false, matchesReceipt: false, reason: "Push old identity is unresolved." };
			}
			const destinationObject = resolvePushRemoteRefV1(
				repositoryCwd,
				target.remote,
				value.destination_ref,
				"push remote destination ref",
				target.destination_id,
			).object_id;
			if (destinationObject === null) {
				return { valid: false, matchesReceipt: false, reason: "Push update destination ref does not exist." };
			}
			if (destinationObject !== value.old_object) {
				return { valid: false, matchesReceipt: false, reason: "Push update destination ref does not match its supplied old object." };
			}
			assertCommitBinding(
				repositoryCwd,
				value.old_object,
				value.old_peeled_commit,
				value.old_tree,
				"push old identity",
			);
			if (value.old_tree !== receipt.body.base_tree) matchesReceipt = false;
		} else {
			return { valid: false, matchesReceipt: false, reason: "Push deletion or unsupported update kind is forbidden." };
		}
	}
	if (new Set(updateKeys).size !== updateKeys.length) {
		return { valid: false, matchesReceipt: false, reason: "Push update set contains duplicate ref pairs." };
	}
	if (canonicalize(updateKeys) !== canonicalize(updateKeys.toSorted())) {
		return { valid: false, matchesReceipt: false, reason: "Push update set is not in stable ref order." };
	}
	if (newTrees.size !== 1) {
		return { valid: false, matchesReceipt: false, reason: "Push update set has an ambiguous target tree." };
	}
	return {
		valid: true,
		matchesReceipt,
		targetTree: [...newTrees][0],
		reason: matchesReceipt
			? "Every push ref update matches the approved receipt."
			: "Push ref update semantics differ from the approved receipt.",
	};
}

function inspectGateTarget(
	target: GateTargetV1,
	receipt: ReceiptEnvelopeV1,
	repositoryCwd: string,
	actualIntendedCommitTree?: string,
): GateTargetInspection {
	try {
		if (!isRecord(target) || typeof target.kind !== "string") {
			return { valid: false, matchesReceipt: false, reason: "Gate target is malformed." };
		}
		if (target.kind === GATE_TARGET_KIND.INTENDED_COMMIT) {
			if (!isObjectId(target.intended_commit_tree)) {
				return { valid: false, matchesReceipt: false, reason: "Intended commit tree is unresolved." };
			}
			assertTreeObject(repositoryCwd, target.intended_commit_tree, "intended commit tree");
			const actualTree = actualIntendedCommitTree ?? runGateGit(repositoryCwd, ["write-tree"]);
			assertTreeObject(repositoryCwd, actualTree, "actual intended commit tree");
			if (actualTree !== target.intended_commit_tree) {
				return {
					valid: false,
					matchesReceipt: false,
					reason: "The actual staged tree does not match the supplied intended commit tree.",
				};
			}
			const matchesReceipt = target.intended_commit_tree === receipt.body.final_candidate_tree;
			return {
				valid: true,
				matchesReceipt,
				targetTree: target.intended_commit_tree,
				reason: matchesReceipt
					? "Intended commit tree matches the approved receipt."
					: "Intended commit tree differs from the approved receipt.",
			};
		}
		if (target.kind === GATE_TARGET_KIND.PUSH) {
			return inspectPushTarget(target, receipt, repositoryCwd);
		}
		if (target.kind === GATE_TARGET_KIND.PULL_REQUEST) {
		if (
			!isFullRef(target.base_ref) ||
			!isObjectId(target.base_commit) ||
			!isObjectId(target.base_tree) ||
			!isFullRef(target.head_ref) ||
			!isObjectId(target.head_commit) ||
			!isObjectId(target.head_tree)
		) {
			return { valid: false, matchesReceipt: false, reason: "Pull request target contains unresolved identity." };
		}
		if (resolveGateRef(repositoryCwd, target.base_ref, "pull request base ref") !== target.base_commit) {
			return { valid: false, matchesReceipt: false, reason: "Pull request base ref does not resolve to its supplied commit." };
		}
		if (resolveGateRef(repositoryCwd, target.head_ref, "pull request head ref") !== target.head_commit) {
			return { valid: false, matchesReceipt: false, reason: "Pull request head ref does not resolve to its supplied commit." };
		}
		assertCommitBinding(repositoryCwd, target.base_commit, target.base_commit, target.base_tree, "pull request base");
		assertCommitBinding(repositoryCwd, target.head_commit, target.head_commit, target.head_tree, "pull request head");
		const matchesReceipt =
			target.base_tree === receipt.body.base_tree &&
			target.head_tree === receipt.body.final_candidate_tree;
		return {
			valid: true,
			matchesReceipt,
			targetTree: target.head_tree,
			reason: matchesReceipt
				? "Pull request base and head match the approved receipt."
				: "Pull request base or head differs from the approved receipt.",
		};
		}
		if (target.kind === GATE_TARGET_KIND.RELEASE) {
		if (
			!isFullRef(target.tag_ref) ||
			!target.tag_ref.startsWith("refs/tags/") ||
			!isObjectId(target.tag_object) ||
			!isObjectId(target.peeled_commit) ||
			!isObjectId(target.tree)
		) {
			return { valid: false, matchesReceipt: false, reason: "Release target contains unresolved identity." };
		}
		if (resolveGateRef(repositoryCwd, target.tag_ref, "release tag ref") !== target.tag_object) {
			return { valid: false, matchesReceipt: false, reason: "Release tag ref does not resolve to its supplied object." };
		}
		assertCommitBinding(
			repositoryCwd,
			target.tag_object,
			target.peeled_commit,
			target.tree,
			"release identity",
		);
		const matchesReceipt = target.tree === receipt.body.final_candidate_tree;
		return {
			valid: true,
			matchesReceipt,
			targetTree: target.tree,
			reason: matchesReceipt
				? "Release tag and commit tree match the approved receipt."
				: "Release commit tree differs from the approved receipt.",
		};
		}
		return { valid: false, matchesReceipt: false, reason: "Unsupported gate target kind." };
	} catch (error) {
		return {
			valid: false,
			matchesReceipt: false,
			reason: `Gate target identity cannot be resolved in the repository: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function deniedGateResult(
	receiptHash: string,
	targetHash: string,
	reason: string,
): GateResultV1 {
	return {
		status: GATE_RESULT.DENY,
		actor_count: 0,
		target_hash: targetHash,
		receipt_hash: receiptHash,
		reason,
	};
}

export function evaluateGateTarget(
	receipt: ReceiptEnvelopeV1,
	target: GateTargetV1,
	repositoryCwd: string,
	actualIntendedCommitTree?: string,
): GateResultV1 {
	let targetHash: string;
	try {
		targetHash = canonicalHash(target);
	} catch {
		targetHash = canonicalHash({ invalid_target: true });
	}
	try {
		assertReceiptIntegrity(receipt);
	} catch (error) {
		return deniedGateResult(
			typeof receipt?.receipt_hash === "string" ? receipt.receipt_hash : "0".repeat(64),
			targetHash,
			`Receipt integrity failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (receipt.body.terminal_state !== TERMINAL_STATE.APPROVED) {
		return deniedGateResult(receipt.receipt_hash, targetHash, "Only an approved receipt can cross a gate.");
	}
	let repositoryRoot: string;
	try {
		repositoryRoot = repositoryRootForGate(repositoryCwd);
	} catch (error) {
		return deniedGateResult(
			receipt.receipt_hash,
			targetHash,
			`Gate repository cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const inspection = inspectGateTarget(
		target,
		receipt,
		repositoryRoot,
		actualIntendedCommitTree,
	);
	if (!inspection.valid) {
		return deniedGateResult(receipt.receipt_hash, targetHash, inspection.reason);
	}
	return {
		status: inspection.matchesReceipt ? GATE_RESULT.ALLOW : GATE_RESULT.SCOPE_CHANGED,
		actor_count: 0,
		target_hash: targetHash,
		receipt_hash: receipt.receipt_hash,
		reason: inspection.reason,
	};
}

function assertReceiptMatchesState(
	receipt: ReceiptEnvelopeV1,
	state: ReviewStateV1,
): void {
	if (!state.frozen_ledger || !state.final_candidate_tree || !state.terminal_state) {
		throw new ReviewIntegrityError("Authoritative state cannot mint a receipt");
	}
	const expected: ReceiptBodyV1 = {
		schema: "gentle-ai.review-receipt-body/v1",
		lineage_id: state.lineage_id,
		mode: state.mode,
		base_tree: state.base_tree,
		complete_snapshot_tree: state.complete_snapshot_tree,
		review_projection: state.review_projection,
		initial_review_tree: state.initial_review_tree,
		final_candidate_tree: state.final_candidate_tree,
		route: state.route,
		lenses: state.lenses,
		policy_hash: state.policy_hash,
		frozen_ledger_hash: state.frozen_ledger.frozen_ledger_hash,
		evidence_hash: state.evidence_hash,
		budget: state.budget,
		counters: state.counters,
		terminal_state: state.terminal_state,
	};
	if (canonicalHash(expected) !== canonicalHash(receipt.body)) {
		throw new ReviewIntegrityError("Receipt body does not match authoritative state");
	}
}

export function createReceiptForState(state: ReviewStateV1): ReceiptEnvelopeV1 {
	if (
		state.phase !== REVIEW_PHASE.TERMINAL ||
		!state.frozen_ledger ||
		!state.final_candidate_tree ||
		!state.terminal_state
	) {
		throw new ReviewIntegrityError("Only terminal authoritative state can mint a receipt");
	}
	const body: ReceiptBodyV1 = {
		schema: "gentle-ai.review-receipt-body/v1",
		lineage_id: state.lineage_id,
		mode: state.mode,
		base_tree: state.base_tree,
		complete_snapshot_tree: state.complete_snapshot_tree,
		review_projection: state.review_projection,
		initial_review_tree: state.initial_review_tree,
		final_candidate_tree: state.final_candidate_tree,
		route: state.route,
		lenses: state.lenses,
		policy_hash: state.policy_hash,
		frozen_ledger_hash: state.frozen_ledger.frozen_ledger_hash,
		evidence_hash: state.evidence_hash,
		budget: state.budget,
		counters: state.counters,
		terminal_state: state.terminal_state,
	};
	return createReceiptEnvelope(body);
}

export function validateReviewGate(
	options: Omit<ValidateReviewGateOptions, "receipt"> & { receipt: AuthoritativeReceiptV1 },
): GateResultV1 {
	return options.store.validateAuthoritativeGate(options);
}

export function validateAuthoritativeReviewGate(
	options: Omit<ValidateReviewGateOptions, "receipt"> & { receipt: AuthoritativeReceiptV1 },
): GateResultV1 {
	return options.store.validateAuthoritativeGate(options);
}
