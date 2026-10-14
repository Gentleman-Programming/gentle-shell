// The reduced Pi FINALIZE input contract (gentle-pi#311 P5).
//
// Pi no longer authors or transports reviewer, refuter, or validator
// verdicts: lens results are admitted natively through the pi host relay,
// the adversarial roles execute through Go-owned pi processes via
// provider-rendered self-contained vectors, and the terminal FINALIZE runs
// the provider's own negotiated transition (captured-results discovery).
// What remains here are the negotiated collection ANSWERS the pinned
// provider still consumes from the host: the pre-edit correction forecast,
// the targeted validation document requested by the exact
// `external.run_targeted_validation` collection input, and the final
// verification evidence with its explicit outcome.

import { CORRECTION_OUTCOMES, type CorrectionOutcome } from "./review-correction-lifecycle.ts";

const DIGEST = /^[0-9a-f]{64}$/;
const LINEAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class CompactReviewContractError extends Error {
	readonly area: string;
	readonly code: string;

	constructor(area: string, code: string, message: string) {
		super(`${area}: ${message}`);
		this.name = "CompactReviewContractError";
		this.area = area;
		this.code = code;
	}
}

// Relocated from the deleted lib/review-compact.ts (gentle-pi#311 P5): the
// only compact shapes with surviving production consumers are the targeted
// validation document and its component rows.
export interface CompactValidationCheckInput {
	passed: boolean;
	evidence: string[];
}

export interface CompactFollowUp {
	finding_id: string;
	location: string;
	summary: string;
	proof_refs: string[];
}

export interface CompactTargetedValidationInput {
	request_hash: string;
	correction_ids: string[];
	original_criteria: CompactValidationCheckInput;
	correction_regression: CompactValidationCheckInput;
	fix_caused_findings?: unknown[];
	follow_ups: CompactFollowUp[];
}

export interface CompactFinalizeContractInput {
	cwd: string;
	lineageId?: string;
	correction_line_forecast?: number;
	validation?: CompactTargetedValidationInput;
	final_evidence?: string;
	final_verification_passed?: boolean;
	final_verification_outcome?: CorrectionOutcome;
	/**
	 * Explicit acknowledgement that this FINALIZE may spend real model tokens:
	 * a provider host-relay slot runs one locked-down `pi` reviewer subprocess
	 * per outstanding lens. Absent, FINALIZE forecasts the run and spends
	 * nothing. Same shape as the existing `committedOnly` acknowledgement — the
	 * caller states the consequence it accepts.
	 */
	reviewer_run_acknowledged?: boolean;
}

function fail(area: string, code: string, message: string): never {
	throw new CompactReviewContractError(area, code, message);
}

function record(value: unknown, area: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		return fail(area, "type", "must be a plain object");
	}
	return value as Record<string, unknown>;
}

function exact(value: unknown, area: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	const object = record(value, area);
	for (const key of Object.keys(object)) if (!required.includes(key) && !optional.includes(key)) fail(area, "unknown-key", `contains unknown field ${key}`);
	for (const key of required) if (!(key in object)) fail(area, "required", `requires ${key}`);
	return object;
}

function string(value: unknown, area: string): string {
	if (typeof value !== "string") return fail(area, "type", "must be a string");
	if (value.length === 0 || value.trim() !== value) return fail(area, "canonical-string", "must be non-empty and trimmed");
	return value;
}

function optionalString(value: unknown, area: string): string | undefined {
	return value === undefined ? undefined : string(value, area);
}

function strings(value: unknown, area: string): string[] {
	if (!Array.isArray(value)) return fail(area, "type", "must be an array");
	const parsed = value.map((item, index) => string(item, `${area}[${index}]`));
	if (new Set(parsed).size !== parsed.length) fail(area, "duplicate", "must not contain duplicates");
	return parsed;
}

function optionalLineage(value: unknown, area: string): string | undefined {
	const parsed = optionalString(value, area);
	if (parsed !== undefined && !LINEAGE_ID.test(parsed)) fail(area, "lineage", "is malformed");
	return parsed;
}

function parseValidation(value: unknown, area: string): CompactTargetedValidationInput {
	const input = exact(value, area, ["request_hash", "correction_ids", "original_criteria", "correction_regression", "fix_caused_findings", "follow_ups"]);
	const check = (item: unknown, label: string) => {
		const row = exact(item, label, ["passed", "evidence"]);
		if (typeof row.passed !== "boolean") fail(`${label}.passed`, "type", "must be boolean");
		return { passed: row.passed, evidence: strings(row.evidence, `${label}.evidence`) };
	};
	if (!Array.isArray(input.fix_caused_findings) || input.fix_caused_findings.length !== 0) fail(`${area}.fix_caused_findings`, "scope", "must be an explicitly empty array");
	if (!Array.isArray(input.follow_ups)) fail(`${area}.follow_ups`, "type", "must be an array");
	const follow_ups = input.follow_ups.map((item, index) => {
		const row = exact(item, `${area}.follow_ups[${index}]`, ["finding_id", "location", "summary", "proof_refs"]);
		return { finding_id: string(row.finding_id, `${area}.follow_ups[${index}].finding_id`), location: string(row.location, `${area}.follow_ups[${index}].location`), summary: string(row.summary, `${area}.follow_ups[${index}].summary`), proof_refs: strings(row.proof_refs, `${area}.follow_ups[${index}].proof_refs`) };
	});
	const request_hash = string(input.request_hash, `${area}.request_hash`);
	if (!DIGEST.test(request_hash)) fail(`${area}.request_hash`, "digest", "is malformed");
	return { request_hash, correction_ids: strings(input.correction_ids, `${area}.correction_ids`), original_criteria: check(input.original_criteria, `${area}.original_criteria`), correction_regression: check(input.correction_regression, `${area}.correction_regression`), fix_caused_findings: [], follow_ups };
}

function parseCompactFinalizeInputValue(value: unknown): CompactFinalizeContractInput {
	const input = exact(value, "review/finalize", ["cwd"], ["lineageId", "correction_line_forecast", "validation", "final_evidence", "final_verification_passed", "final_verification_outcome", "reviewer_run_acknowledged"]);
	if (input.reviewer_run_acknowledged !== undefined && typeof input.reviewer_run_acknowledged !== "boolean") fail("review/finalize.reviewer_run_acknowledged", "type", "must be boolean");
	const outcomeFields = Number(input.final_verification_passed !== undefined) + Number(input.final_verification_outcome !== undefined);
	if ((input.final_evidence === undefined && outcomeFields !== 0) || (input.final_evidence !== undefined && outcomeFields !== 1)) fail("review/finalize", "field-pair", "final evidence requires exactly one verification result or outcome");
	let correction_line_forecast: number | undefined;
	if (input.correction_line_forecast !== undefined) {
		if (typeof input.correction_line_forecast !== "number" || !Number.isSafeInteger(input.correction_line_forecast) || input.correction_line_forecast <= 0) fail("review/finalize.correction_line_forecast", "range", "must be a positive safe integer");
		correction_line_forecast = input.correction_line_forecast;
	}
	if (input.final_verification_passed !== undefined && typeof input.final_verification_passed !== "boolean") fail("review/finalize.final_verification_passed", "type", "must be boolean");
	let final_verification_outcome: CorrectionOutcome | undefined;
	if (input.final_verification_outcome !== undefined) {
		const outcome = string(input.final_verification_outcome, "review/finalize.final_verification_outcome");
		if (!(CORRECTION_OUTCOMES as readonly string[]).includes(outcome)) fail("review/finalize.final_verification_outcome", "enum", "contains an unsupported value");
		final_verification_outcome = outcome as CorrectionOutcome;
	}
	let final_evidence: string | undefined;
	if (input.final_evidence !== undefined) {
		// Final evidence is preserved BYTE-FOR-BYTE: it is staged into the native
		// --evidence file untouched, so the canonical trimmed-string rule does
		// not apply — only zero-length evidence is refused.
		if (typeof input.final_evidence !== "string" || input.final_evidence.length === 0) fail("review/finalize.final_evidence", "empty", "must contain at least one byte");
		final_evidence = input.final_evidence;
	}
	return { cwd: string(input.cwd, "review/finalize.cwd"), ...(optionalLineage(input.lineageId, "review/finalize.lineageId") === undefined ? {} : { lineageId: optionalLineage(input.lineageId, "review/finalize.lineageId")! }), ...(correction_line_forecast === undefined ? {} : { correction_line_forecast }), ...(input.validation === undefined ? {} : { validation: parseValidation(input.validation, "review/finalize.validation") }), ...(final_evidence === undefined ? {} : { final_evidence }), ...(typeof input.final_verification_passed !== "boolean" ? {} : { final_verification_passed: input.final_verification_passed }), ...(final_verification_outcome === undefined ? {} : { final_verification_outcome }), ...(typeof input.reviewer_run_acknowledged !== "boolean" ? {} : { reviewer_run_acknowledged: input.reviewer_run_acknowledged }) };
}

export function parseNativeCompactFinalizeInput(value: unknown): CompactFinalizeContractInput {
	const input = parseCompactFinalizeInputValue(value);
	if (input.validation && (input.validation.original_criteria.evidence.length === 0 || input.validation.correction_regression.evidence.length === 0)) {
		fail("review/finalize.validation", "empty", "validator evidence must be non-empty");
	}
	if (input.validation?.follow_ups.some((row) => row.proof_refs.length === 0)) fail("review/finalize.validation.follow_ups", "empty", "follow-up proof_refs must be non-empty");
	return input;
}

export function toNativeValidatorDocument(input: CompactTargetedValidationInput) {
	return {
		original_criteria: input.original_criteria,
		correction_regression: input.correction_regression,
		follow_ups: input.follow_ups.map((row) => ({ observation: row.summary, proof_refs: [...row.proof_refs] })),
	};
}
