// The thin Pi host relay (gentle-pi#311 P4; provider contract gentle-ai#3249).
//
// gentle-ai owns prompt materialization, role and schema selection, byte
// budgets, parsing, admission, immutable capture, retry, correction
// accounting, and receipt state. This host boundary is
// intentionally narrow:
//
//   1. Run the exact provider-issued capture binding with `--agent pi
//      --materialize` and take stdout as opaque prompt BYTES, verbatim.
//   2. Run that prompt through one in-process reviewer completion
//      (lib/inprocess-reviewer.ts#runInProcessReviewer): resolve the lens's
//      "provider/id" selection through the live model registry, authenticate
//      through the registry's own resolver, and complete the frozen prompt as
//      a single user message. There is no child process, no extension
//      allowlist, and no ambient default model — a missing registry or a
//      routing entry with no model is a typed refusal before materialize ever
//      runs (gentle-ai#4611; gentle-pi#311 P2).
//   3. Submit the completion's text untouched through the provider-owned
//      `submission` form carried by the collect input: execute its exact
//      operation and argument tokens with only the tempfile path substituted
//      into the declared {{value}} slot (BOM-less: the buffer is written
//      byte-for-byte). The host never synthesizes or filters the completing
//      form; a materialize slot without a provider submission is a typed
//      contract mismatch, never a rebuilt invocation.
//
// On any failure the relay returns a TYPED transport error and submits
// nothing further. After a transport failure the caller re-queries negotiated
// STATUS and relaunches only if the exact same bound slot is reoffered —
// never from transcript inference. The relay never parses or rebuilds
// binding, evidence, prompt, schema, budgets, or admission.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { resolveGentleAiBinary } from "./gentle-ai-binary.ts";
import {
	INPROCESS_REVIEWER_FAILURE,
	runInProcessReviewer,
	type InProcessReviewerFailureCode,
	type InProcessReviewerOutcome,
	type InProcessReviewerRegistry,
} from "./inprocess-reviewer.ts";
import { REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION, REVIEW_PROVIDER_ROLE_CAPTURE_OPERATIONS, type ReviewCaptureSubmissionV1, type ReviewCollectInputV3 } from "./review-integration-v2.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "./review-relay-contract.ts";

export const REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE =
	"provider relay requires a gentle-ai build with the pi host relay surface";

export const REVIEW_HOST_RELAY_FAILURE = {
	RELAY_UNAVAILABLE: "relay-unavailable",
	HANDSHAKE_REFUSED: "handshake-refused",
	SUBMISSION_CONTRACT_MISMATCH: "submission-contract-mismatch",
	MATERIALIZE_FAILED: "materialize-failed",
	EMPTY_PROMPT: "empty-prompt",
	// gentle-pi#311 P2: these four names predate the in-process completion,
	// when a killed or crashed child process was the only way a reviewer
	// failed. They stay exactly as they are — including their "pi" wording —
	// because other test lanes (the maintainer provider-relay matrix, the
	// restart-parity harness) construct `ReviewHostRelayError` literals with
	// them directly and are out of this change's scope (gentle-pi#311 P4).
	// PI_TIMED_OUT and PI_FAILED are still reachable from production: a
	// reviewer completion that exceeds its bound or fails for any reason not
	// covered by a more specific REVIEWER_* code below reuses them, since the
	// semantics (a deterministic bound; a generic failure) carried over
	// unchanged. PI_LAUNCH_FAILED and PI_EMPTY_OUTPUT are no longer produced
	// by this module — there is no child to fail to launch, and empty output
	// is now REVIEWER_EMPTY_OUTPUT with different evidence — but the codes
	// stay defined for the lanes above.
	PI_LAUNCH_FAILED: "pi-launch-failed",
	PI_FAILED: "pi-failed",
	PI_TIMED_OUT: "pi-timed-out",
	PI_EMPTY_OUTPUT: "pi-empty-output",
	// gentle-shell#1158 / #1136 (superseded by gentle-pi#311 P2): a caller-owned
	// reviewer selection that cannot possibly complete — no model registry, or
	// a routing entry with no configured model — is a configuration failure,
	// refused typed before anything runs, never a mid-review transport
	// mystery. The in-process path has no ambient default model to fall back
	// to, so a missing selection is refused here rather than launched anyway.
	REVIEWER_CONFIG_INVALID: "reviewer-config-invalid",
	// gentle-pi#311 P2 — in-process completion outcomes with no equivalent
	// above (lib/inprocess-reviewer.ts#INPROCESS_REVIEWER_FAILURE).
	REVIEWER_MODEL_NOT_FOUND: "reviewer-model-not-found",
	REVIEWER_AUTH_UNAVAILABLE: "reviewer-auth-unavailable",
	REVIEWER_THINKING_INVALID: "reviewer-thinking-invalid",
	REVIEWER_TOOL_CALL: "reviewer-tool-call-attempted",
	REVIEWER_EMPTY_OUTPUT: "reviewer-empty-output",
	REVIEWER_OUTPUT_TOO_LARGE: "reviewer-output-too-large",
	REVIEWER_ABORTED: "reviewer-aborted",
	SUBMISSION_REFUSED: "submission-refused",
} as const;
export type ReviewHostRelayFailureKind = (typeof REVIEW_HOST_RELAY_FAILURE)[keyof typeof REVIEW_HOST_RELAY_FAILURE];

export type ReviewHostRelayStage = "binding" | "materialize" | "pi" | "submit";

export const REVIEW_HOST_RELAY_SUBMISSION_VALUE_SLOT = "{{value}}";

export const REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE =
	"provider contract mismatch: the materialize capture input carries no provider-owned submission form; the host never synthesizes the completing form";

export class ReviewHostRelayError extends Error {
	readonly kind: ReviewHostRelayFailureKind;
	readonly stage: ReviewHostRelayStage;
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly timedOut: boolean;
	// Wall time the aborted, timed-out, or failed reviewer completion actually
	// consumed, and the bound it was measured against. Both are null only when
	// no completion ran. Without them a transport failure cannot be told apart
	// from a crash, which is what forced the gentle-pi#367 reporter to measure
	// the relay by hand.
	readonly elapsedMs: number | null;
	readonly timeoutMs: number | null;
	// "none" until the submission invocation launches; a launched submission
	// whose outcome could not be read is "unknown" and the caller reconciles
	// through negotiated STATUS, never through a blind retry. A launched
	// submission that gentle-ai refused with its typed admission refusal is
	// "none" again: the provider states that the lens slot was not consumed
	// (gentle-pi#522 / #524).
	readonly mutationOutcome: "none" | "unknown";
	/** What the in-process reviewer outcome carried as structured evidence (e.g. the completion's stopReason on an empty-output refusal). */
	readonly reviewerEvidence: Record<string, unknown> | undefined;
	constructor(kind: ReviewHostRelayFailureKind, stage: ReviewHostRelayStage, message: string, details?: { exitCode?: number | null; stderr?: string; timedOut?: boolean; elapsedMs?: number; timeoutMs?: number; mutationOutcome?: "none" | "unknown"; reviewerEvidence?: Record<string, unknown> }) {
		super(message);
		this.name = "ReviewHostRelayError";
		this.kind = kind;
		this.stage = stage;
		this.exitCode = details?.exitCode ?? null;
		this.stderr = details?.stderr ?? "";
		this.timedOut = details?.timedOut ?? false;
		this.elapsedMs = details?.elapsedMs ?? null;
		this.timeoutMs = details?.timeoutMs ?? null;
		this.mutationOutcome = details?.mutationOutcome ?? (stage === "submit" ? "unknown" : "none");
		this.reviewerEvidence = details?.reviewerEvidence;
	}
}

// gentle-pi#522 / #524: gentle-ai refuses a reviewer submission before any
// admission with exit 1 and its typed operator line, `<reason> [invalid_request]`.
// That code is the provider's preflight class: the request was refused as
// sent and the lens slot was not consumed. The relay recognises only that
// typed shape; it never parses the reason, and it never retries.
const ADMISSION_REFUSAL = /\[invalid_request\]/;

export function isReviewHostRelayAdmissionRefusal(capture: { exitCode: number | null; timedOut: boolean }, stderr: string): boolean {
	return capture.exitCode === 1 && !capture.timedOut && ADMISSION_REFUSAL.test(stderr);
}

// Refusal classification for the materialize invocation. The installed
// gentle-ai is the only authority on whether the materialize form exists; Pi
// never version-sniffs. Two typed refusal classes are distinguished:
//
//   unknown-flag  the Go flag package's exact refusal for a flag the binary
//                 does not define (any binary older than v2.4.0) —
//                 the relay is unavailable and existing behavior stays
//                 untouched.
//   handshake     the provider's pre-authority pi admission refusal — always
//                 surfaced verbatim, never worked around.
const UNKNOWN_FLAG_REFUSAL = /flag provided but not defined: -{1,2}(?:materialize|agent)\b/;
const HANDSHAKE_REFUSAL = new RegExp(
	[
		GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV,
		GENTLE_PI_REVIEW_RELAY_CONTRACT.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
		"not eligible for immutable receipt review",
	].join("|"),
);

export function classifyReviewHostRelayRefusal(stderr: string): "unknown-flag" | "handshake" | "other" {
	if (UNKNOWN_FLAG_REFUSAL.test(stderr)) return "unknown-flag";
	if (HANDSHAKE_REFUSAL.test(stderr)) return "handshake";
	return "other";
}

// ---------------------------------------------------------------------------
// gentle-pi#638: only a relay-bound reviewer timeout is deterministic for the
// exact selected slot: relaunching the same materialized request reaches the
// same wall. Generic admission refusals, including malformed reviewer JSON and
// binding_mismatch [invalid_request], describe repairable submitted bytes; a
// fresh reviewer can change them. They keep the existing exact-reoffer path.
// A future provider-issued, typed slot-deterministic refusal may be added here
// only when its schema proves that this exact bound slot cannot be repaired.
// ---------------------------------------------------------------------------

export const REVIEW_HOST_RELAY_UNACHIEVABLE_REASON = {
	PI_TIMED_OUT: "relay_transport_bound_exceeded",
} as const;

export function reviewHostRelayUnachievableReason(error: ReviewHostRelayError): string | undefined {
	return error.kind === REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT
		? REVIEW_HOST_RELAY_UNACHIEVABLE_REASON.PI_TIMED_OUT
		: undefined;
}

// Optional bounded evidence for the declaration's --detail. Only the killed reviewer carries measurements worth recording; an admission refusal's text already rides failure.stderr, and unmeasured failures never get a fabricated detail.
export function reviewHostRelayUnachievableDetail(error: ReviewHostRelayError): string | undefined {
	if (error.kind === REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT && error.elapsedMs !== null && error.timeoutMs !== null) {
		return `killed after ${error.elapsedMs}ms against a ${error.timeoutMs}ms relay bound`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Slot detection — the provider decides. A collect input routes through the
// host relay ONLY when the provider itself issued the `--materialize` token
// (with the pi runtime identity) on a `review.capture-result` collection
// input. Nothing is ever inferred from state prose, risk, or transcript.
// ---------------------------------------------------------------------------

export interface ReviewHostRelaySlot {
	/** Every provider-issued argument token, verbatim, in provider order. */
	readonly captureArgumentTokens: readonly string[];
	/**
	 * The provider-owned completing form, verbatim. Absent only when the
	 * provider violated its own contract; the relay then fails closed with a
	 * typed submission-contract-mismatch error instead of synthesizing one.
	 */
	readonly submission?: ReviewCaptureSubmissionV1;
	readonly lens?: string;
	readonly order?: string;
	readonly subjectHash?: string;
	/**
	 * Overrides the routing config key the reviewer selection resolves
	 * through (gentle-pi#311 P3). A lens slot leaves this unset and resolves
	 * through `lens` instead; a v9 host-mediated refuter/targeted-validator
	 * slot sets it to its fixed `review-refuter` / `review-validator` key,
	 * since those roles carry no per-slot lens identity.
	 */
	readonly routingKey?: string;
	/** The provider-declared collect input name (e.g. `provider_refuter`), carried for diagnostics only. */
	readonly name?: string;
}

function argumentValue(input: ReviewCollectInputV3, name: string): string | undefined {
	const matches = input.arguments.filter((argument) => argument.name === name);
	return matches.length === 1 ? matches[0]!.value : undefined;
}

function renderToken(argument: ReviewCollectInputV3["arguments"][number]): string {
	return argument.token ?? `--${argument.name}=${argument.value}`;
}

export function isReviewHostRelayCollectInput(input: ReviewCollectInputV3): boolean {
	return input.captureOperation === "review.capture-result"
		&& argumentValue(input, "materialize") === "true"
		&& argumentValue(input, "agent") === "pi";
}

export function reviewHostRelaySlots(inputs: readonly ReviewCollectInputV3[]): readonly ReviewHostRelaySlot[] {
	return inputs.filter((input) => isReviewHostRelayCollectInput(input)).map((input) => ({
		captureArgumentTokens: input.arguments.map((argument) => renderToken(argument)),
		...(input.submission === undefined ? {} : { submission: input.submission }),
		...(argumentValue(input, "lens") === undefined ? {} : { lens: argumentValue(input, "lens") }),
		...(argumentValue(input, "order") === undefined ? {} : { order: argumentValue(input, "order") }),
		...(input.artifactSubject === undefined ? {} : { subjectHash: input.artifactSubject.subjectHash }),
	}));
}

// ---------------------------------------------------------------------------
// Provider role vectors (gentle-pi#311 P4-roles) — the two Go-owned non-lens
// adversarial role capture operations. Unlike the lens materialize slots
// above, these vectors are SELF-CONTAINED: the provider renders binding
// tokens plus `--agent=pi --execute=true`, and executing the exact rendered
// invocation makes Go materialize the role prompt, spawn its own locked-down
// pi subprocess, and admit the raw verdict into the compact slot. The host
// never materializes, launches pi, or submits anything for these slots — it
// runs one CLI invocation verbatim and re-queries negotiated STATUS.
// ---------------------------------------------------------------------------

export interface ReviewProviderRoleVectorSlot {
	/** The provider-named capture operation, e.g. `review.capture-refuter`. */
	readonly captureOperation: (typeof REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION)[keyof typeof REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION];
	/** Every provider-issued argument token, verbatim, in provider order. */
	readonly argumentTokens: readonly string[];
	/** The provider-declared input name, e.g. `provider_refuter`. */
	readonly name: string;
}

export function isReviewProviderRoleVectorInput(input: ReviewCollectInputV3): boolean {
	return (REVIEW_PROVIDER_ROLE_CAPTURE_OPERATIONS as readonly string[]).includes(input.captureOperation)
		&& argumentValue(input, "execute") === "true"
		&& argumentValue(input, "agent") === "pi";
}

export function reviewProviderRoleVectorSlots(inputs: readonly ReviewCollectInputV3[]): readonly ReviewProviderRoleVectorSlot[] {
	return inputs.filter((input) => isReviewProviderRoleVectorInput(input)).map((input) => ({
		captureOperation: input.captureOperation as ReviewProviderRoleVectorSlot["captureOperation"],
		argumentTokens: input.arguments.map((argument) => renderToken(argument)),
		name: input.name,
	}));
}

// ---------------------------------------------------------------------------
// Host-mediated provider role slots (gentle-pi#311 P3; provider contract
// v9) — the same two role capture operations above, but rendered exactly
// like a lens materialize slot: binding tokens plus `--agent=pi
// --materialize=true` (never `--execute`) and a provider-owned submission
// descriptor. These slots run through the SAME relay machinery a lens slot
// does (`prepareReviewHostRelaySlot` / `submitReviewHostRelayPreparedResult`)
// — there is no second relay. The only role-specific parts are the fixed
// `routingKey` (there is no per-slot lens identity to read one from) and the
// input's own schema, which already names refuter vs targeted-validator in
// every refusal that carries the request.
// ---------------------------------------------------------------------------

const REVIEW_HOST_MEDIATED_ROLE_ROUTING_KEY: Record<ReviewProviderRoleVectorSlot["captureOperation"], "review-refuter" | "review-validator"> = {
	[REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION.CAPTURE_REFUTER]: "review-refuter",
	[REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION.CAPTURE_VALIDATION]: "review-validator",
};

export function isReviewHostMediatedRoleCollectInput(input: ReviewCollectInputV3): boolean {
	return (REVIEW_PROVIDER_ROLE_CAPTURE_OPERATIONS as readonly string[]).includes(input.captureOperation)
		&& argumentValue(input, "materialize") === "true"
		&& argumentValue(input, "agent") === "pi"
		&& input.submission !== undefined;
}

export function reviewHostMediatedRoleSlots(inputs: readonly ReviewCollectInputV3[]): readonly ReviewHostRelaySlot[] {
	return inputs.filter((input) => isReviewHostMediatedRoleCollectInput(input)).map((input) => ({
		captureArgumentTokens: input.arguments.map((argument) => renderToken(argument)),
		submission: input.submission!,
		routingKey: REVIEW_HOST_MEDIATED_ROLE_ROUTING_KEY[input.captureOperation as ReviewProviderRoleVectorSlot["captureOperation"]],
		name: input.name,
	}));
}

// Resolves the provider-owned submission form into an executable binding.
// Fails closed with a typed contract-mismatch error whenever the completing
// form is absent or cannot bind exactly one artifact value; the relay never
// repairs, filters, or synthesizes it.
export interface ReviewHostRelaySubmissionBinding {
	readonly operationToken: string;
	readonly argumentTokens: readonly string[];
	readonly substitutionLocation: number;
}

export function resolveReviewHostRelaySubmission(submission: ReviewCaptureSubmissionV1 | undefined): ReviewHostRelaySubmissionBinding {
	if (submission === undefined) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding", REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE);
	}
	if (submission.operationToken.length === 0 || submission.argumentTokens.length === 0 || submission.argumentTokens.some((token) => typeof token !== "string" || token.length === 0)) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding", "provider contract mismatch: the submission form carries an empty operation or argument token");
	}
	if (submission.values.length !== 1) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding", `provider contract mismatch: the submission form must bind exactly one artifact value, received ${submission.values.length}`);
	}
	const value = submission.values[0]!;
	const location = value.substitutionLocation;
	if (!Number.isSafeInteger(location) || location < 0 || location >= submission.argumentTokens.length) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding", "provider contract mismatch: the submission substitution location is outside its argument tokens");
	}
	if (!submission.argumentTokens[location]!.includes(REVIEW_HOST_RELAY_SUBMISSION_VALUE_SLOT)) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding", `provider contract mismatch: the submission token at location ${location} carries no ${REVIEW_HOST_RELAY_SUBMISSION_VALUE_SLOT} slot`);
	}
	return { operationToken: submission.operationToken, argumentTokens: submission.argumentTokens, substitutionLocation: location };
}

// ---------------------------------------------------------------------------
// Relay execution
// ---------------------------------------------------------------------------

export interface ReviewHostRelayRequest {
	readonly captureArgumentTokens: readonly string[];
	/** Canonical target worktree for coordinator-only native materialize/submit calls. */
	readonly targetCwd?: string;
	/** The provider-owned completing form; absent means contract mismatch. */
	readonly submission?: ReviewCaptureSubmissionV1;
	/** Absolute path; defaults to the verified package-local binary. */
	readonly gentleAiExecutable?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly gentleAiTimeoutMs?: number;
	/**
	 * The live model registry the reviewer completion resolves its selection
	 * and credentials through — structurally, pi's own `ModelRegistry`
	 * (`ctx.modelRegistry`). Absent is a typed refusal before materialize ever
	 * runs; the relay never falls back to a child process or an ambient
	 * default model (gentle-ai#4611; gentle-pi#311 P2).
	 */
	readonly reviewerRegistry?: InProcessReviewerRegistry;
	/**
	 * The lens's user-owned "provider/id" selection, read from the agent model
	 * routing config's `review-<lens>` entry. The relay never invents one: a
	 * routing entry with no configured model is refused typed before
	 * materialize, naming {@link ReviewHostRelayRequest.routingKey}.
	 */
	readonly selection?: string;
	/** The routing entry's thinking label, forwarded verbatim to the completion. */
	readonly thinking?: string;
	/**
	 * The caller's live pi session id, forwarded into the in-process completion
	 * request so an OpenCode-routed reviewer model carries its
	 * `x-opencode-session` attribution header (a side-call bypasses pi's main
	 * agent loop, where pi adds those headers itself). Absent forwards nothing:
	 * no invented header, no error.
	 */
	readonly reviewerSessionId?: string;
	/** Names the routing config key (e.g. "review-risk") in refusal messages; defaults to a generic label when absent. */
	readonly routingKey?: string;
	/**
	 * Overrides the reviewer bound entirely. Production leaves it unset and the
	 * relay derives the bound from the materialized prompt bytes and
	 * {@link REVIEW_HOST_RELAY_PI_TIMEOUT_ENV}; this seam exists so tests can
	 * exercise the timeout leg without a wall-clock wait.
	 */
	readonly piTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface ReviewHostRelayResult {
	readonly promptByteLength: number;
	readonly resultByteLength: number;
	/** Raw submission stdout (the provider's admitted-manifest JSON), opaque. */
	readonly submission: string;
}

/** Opaque materialize-and-review result, not yet submitted to the provider. */
export interface ReviewHostRelayPreparedResult {
	/** Copy-safe request snapshot captured before materialization starts. */
	readonly request: ReviewHostRelayRequest;
	readonly promptByteLength: number;
	readonly resultByteLength: number;
}

const preparedResultBytes = new WeakMap<ReviewHostRelayPreparedResult, Buffer>();

export type ReviewHostRelayRunner = (request: ReviewHostRelayRequest) => Promise<ReviewHostRelayResult>;
export type ReviewHostRelayPreparationRunner = (request: ReviewHostRelayRequest) => Promise<ReviewHostRelayPreparedResult>;
export type ReviewHostRelaySubmissionRunner = (prepared: ReviewHostRelayPreparedResult) => Promise<ReviewHostRelayResult>;

const DEFAULT_GENTLE_AI_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// The reviewer completion bound (gentle-pi#367).
//
// The previous bound was a single hardcoded 600_000 ms reachable only through
// the test-injectable runner. A field-measured lens legitimately needed 478s
// against a ~1.58 MB materialized prompt: it survived by hand and was killed
// under the relay, and the sanctioned continuation then re-spent every lens to
// reach the same wall. One fixed number cannot serve a prompt class that
// varies by orders of magnitude, so the bound is derived instead:
//
//   floor + ceil(promptBytes / MiB * perMebibyte), clamped to the ceiling
//
// The floor covers model latency that does not depend on prompt size; the
// linear term covers the part that does. At the measured 1.58 MB the derived
// bound is ~37 minutes, roughly a 4.7x margin over the 478s the reviewer
// actually needed — deliberately generous, because the reviewer model and
// provider are user-owned and the relay cannot know their throughput.
//
// GENTLE_PI_REVIEW_RELAY_PI_TIMEOUT_MS replaces the derived bound entirely for
// callers who know their own configuration. It follows the repository's
// established numeric-override shape (GENTLE_PI_CANDIDATE_GIT_TIMEOUT_MS,
// GENTLE_PI_REVIEW_MAX_BUFFER_BYTES): a positive decimal, silently ignored
// when malformed, and clamped to the same hard ceiling so no configuration can
// turn a foreground FINALIZE into an unbounded completion.
// ---------------------------------------------------------------------------

export const REVIEW_HOST_RELAY_PI_TIMEOUT_ENV = "GENTLE_PI_REVIEW_RELAY_PI_TIMEOUT_MS";
export const REVIEW_HOST_RELAY_PI_TIMEOUT_FLOOR_MS = 900_000;
export const REVIEW_HOST_RELAY_PI_TIMEOUT_PER_MEBIBYTE_MS = 900_000;
export const REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS = 7_200_000;
const BYTES_PER_MEBIBYTE = 1024 * 1024;

export function resolveReviewHostRelayPiTimeoutMs(promptByteLength: number, environment: NodeJS.ProcessEnv = process.env): number {
	const configured = environment[REVIEW_HOST_RELAY_PI_TIMEOUT_ENV];
	if (configured !== undefined && /^[1-9]\d*$/.test(configured)) {
		const parsed = Number(configured);
		if (Number.isSafeInteger(parsed)) return Math.min(parsed, REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS);
	}
	const bytes = Number.isSafeInteger(promptByteLength) && promptByteLength > 0 ? promptByteLength : 0;
	const scaled = REVIEW_HOST_RELAY_PI_TIMEOUT_FLOOR_MS + Math.ceil((bytes / BYTES_PER_MEBIBYTE) * REVIEW_HOST_RELAY_PI_TIMEOUT_PER_MEBIBYTE_MS);
	return Math.min(scaled, REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS);
}

// The reviewer completion ran out of time; it did not crash. The message
// states both measurements and names the two things that can change the
// outcome, because the one thing that cannot is relaunching the identical
// slot.
export function reviewHostRelayPiTimeoutMessage(elapsedMs: number, timeoutMs: number, promptByteLength: number): string {
	return `the reviewer completion exceeded the relay bound: aborted after ${elapsedMs}ms against a ${timeoutMs}ms limit for a ${promptByteLength}-byte materialized prompt. `
		+ `Relaunching the same slot unchanged reaches the same wall. Raise ${REVIEW_HOST_RELAY_PI_TIMEOUT_ENV} above the reviewer's real wall time (ceiling ${REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS}ms) or reduce the candidate scope so the materialized prompt is smaller.`;
}

interface ProcessCapture {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	timedOut: boolean;
	elapsedMs: number;
}

function collectGentleAiProcess(
	file: string,
	arguments_: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: Buffer; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessCapture> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn(file, [...arguments_], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		let settled = false;
		const timer = options.timeoutMs > 0
			? setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs)
			: undefined;
		timer?.unref();
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code, timedOut, elapsedMs: Date.now() - startedAt });
		});
		if (options.stdin === undefined) {
			child.stdin.end();
		} else {
			child.stdin.on("error", () => undefined);
			child.stdin.end(options.stdin);
		}
	});
}

// Maps one in-process reviewer refusal onto a typed relay error. TIMED_OUT
// reuses PI_TIMED_OUT and PROVIDER_FAILED reuses PI_FAILED (identical
// semantics: a deterministic bound; a generic failure bucket); every other
// code gets its own REVIEWER_* kind with no prior equivalent.
function relayReviewerRefusalError(
	outcome: Extract<InProcessReviewerOutcome, { kind: "refused" }>,
	timing: { elapsedMs: number; timeoutMs: number },
	promptByteLength: number,
): ReviewHostRelayError {
	const details = { ...timing, ...(outcome.evidence === undefined ? {} : { reviewerEvidence: outcome.evidence }) };
	const code: InProcessReviewerFailureCode = outcome.code;
	switch (code) {
		case INPROCESS_REVIEWER_FAILURE.MODEL_NOT_FOUND:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_MODEL_NOT_FOUND, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.AUTH_UNAVAILABLE:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_AUTH_UNAVAILABLE, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.THINKING_INVALID:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_THINKING_INVALID, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.TOOL_CALL_ATTEMPTED:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_TOOL_CALL, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_EMPTY_OUTPUT, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.OUTPUT_TOO_LARGE:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_OUTPUT_TOO_LARGE, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.ABORTED:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_ABORTED, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.SELECTION_INVALID:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID, "pi", outcome.message, details);
		case INPROCESS_REVIEWER_FAILURE.TIMED_OUT:
			return new ReviewHostRelayError(
				REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT,
				"pi",
				reviewHostRelayPiTimeoutMessage(timing.elapsedMs, timing.timeoutMs, promptByteLength),
				{ ...details, timedOut: true },
			);
		case INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED:
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", outcome.message, details);
		default: {
			const unreachable: never = code;
			return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", `unrecognized reviewer refusal code ${String(unreachable)}`, details);
		}
	}
}

function assertTokens(name: string, tokens: readonly string[]): void {
	if (tokens.length === 0) throw new TypeError(`Pi host relay requires the provider-issued ${name} tokens`);
	if (tokens.some((token) => typeof token !== "string" || token.length === 0)) {
		throw new TypeError(`Pi host relay ${name} tokens must all be non-empty strings`);
	}
}

/**
 * Validates the caller-owned reviewer selection before any process launches: a
 * missing model registry or a routing entry with no configured model is a
 * typed refusal, never a mid-review transport failure and never a fallback to
 * an ambient default model (gentle-ai#4611; gentle-pi#311 P2, superseding
 * gentle-shell#1158 / #1136's child-process launch configuration).
 */
function validateReviewerSelectionConfiguration(request: ReviewHostRelayRequest): { reviewerRegistry: InProcessReviewerRegistry; selection: string; thinking?: string; routingKey: string } {
	const routingKey = typeof request.routingKey === "string" && request.routingKey.length > 0 ? request.routingKey : "review capture";
	if (request.reviewerRegistry === undefined) {
		throw new ReviewHostRelayError(
			REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID,
			"pi",
			`Pi host relay reviewer launch configuration is invalid: no model registry is available to complete ${routingKey}`,
		);
	}
	if (typeof request.selection !== "string" || request.selection.length === 0) {
		throw new ReviewHostRelayError(
			REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID,
			"pi",
			`Pi host relay reviewer launch configuration is invalid: no model is configured for ${routingKey}; assign it a model in the agent model routing config`,
		);
	}
	return {
		reviewerRegistry: request.reviewerRegistry,
		selection: request.selection,
		...(request.thinking === undefined ? {} : { thinking: request.thinking }),
		...(request.reviewerSessionId === undefined ? {} : { reviewerSessionId: request.reviewerSessionId }),
		routingKey,
	};
}

function snapshotReviewHostRelayRequest(request: ReviewHostRelayRequest): ReviewHostRelayRequest {
	// Structural malformations (empty/blank tokens, a non-absolute executable)
	// are TypeErrors — a programmer mistake, never a typed relay refusal — and
	// are checked before the business-level reviewer selection below.
	assertTokens("capture", request.captureArgumentTokens);
	const gentleAiExecutable = request.gentleAiExecutable ?? resolveGentleAiBinary();
	if (!isAbsolute(gentleAiExecutable)) throw new TypeError("Pi host relay requires an absolute gentle-ai executable path");
	// Caller-owned reviewer selection is validated before any process launches:
	// a broken configuration is a typed refusal, never a mid-review transport
	// failure (gentle-pi#311 P2).
	const reviewerSelection = validateReviewerSelectionConfiguration(request);
	// The completing form is validated before any process launches: a materialize
	// slot without a provider-owned submission is a typed contract mismatch,
	// never a synthesized invocation.
	resolveReviewHostRelaySubmission(request.submission);
	const environment = Object.freeze({ ...(request.environment ?? process.env) }) as NodeJS.ProcessEnv;
	const submission = request.submission === undefined ? undefined : Object.freeze({
		operationToken: request.submission.operationToken,
		argumentTokens: Object.freeze([...request.submission.argumentTokens]),
		values: Object.freeze(request.submission.values.map((value) => Object.freeze({ ...value }))),
	});
	return Object.freeze({
		...request,
		captureArgumentTokens: Object.freeze([...request.captureArgumentTokens]),
		...(submission === undefined ? {} : { submission }),
		...reviewerSelection,
		gentleAiExecutable,
		environment,
		gentleAiTimeoutMs: request.gentleAiTimeoutMs ?? DEFAULT_GENTLE_AI_TIMEOUT_MS,
		targetCwd: request.targetCwd ?? process.cwd(),
	});
}

/**
 * Materializes one provider-bound reviewer prompt and runs it through one
 * in-process reviewer completion. It does not submit anything, so independent
 * reviewer work can finish before the caller performs provider-ordered
 * admission.
 */
export async function prepareReviewHostRelaySlot(
	request: ReviewHostRelayRequest,
	runReviewer: typeof runInProcessReviewer = runInProcessReviewer,
): Promise<ReviewHostRelayPreparedResult> {
	// Copy mutable transport configuration before the first async boundary. The
	// supplied AbortSignal intentionally stays live across materialize, reviewer,
	// and submit, preserving the established cancellation behavior.
	const preparedRequest = snapshotReviewHostRelayRequest(request);

	// The provider materializes the opaque prompt and detects whether this relay
	// surface is available. No version sniffing or prompt reconstruction occurs.
	// The materialize subcommand is the provider's own submission operation
	// token (validated present above): "capture-result" for a lens slot,
	// "capture-refuter" or "capture-validation" for a v9 host-mediated role
	// slot — the provider always names the same operation for both the
	// materialize and the submit leg of one slot.
	let materialized: ProcessCapture;
	try {
		materialized = await collectGentleAiProcess(preparedRequest.gentleAiExecutable!, ["review", preparedRequest.submission!.operationToken, ...preparedRequest.captureArgumentTokens], {
			cwd: preparedRequest.targetCwd!,
			env: { ...preparedRequest.environment!, [GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: GENTLE_PI_REVIEW_RELAY_CONTRACT },
			timeoutMs: preparedRequest.gentleAiTimeoutMs!,
			...(preparedRequest.signal === undefined ? {} : { signal: preparedRequest.signal }),
		});
	} catch (error) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.MATERIALIZE_FAILED, "materialize", `gentle-ai prompt materialization could not start: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (materialized.exitCode !== 0 || materialized.timedOut) {
		const stderr = materialized.stderr.toString("utf8");
		const refusal = classifyReviewHostRelayRefusal(stderr);
		const timing = { elapsedMs: materialized.elapsedMs, timeoutMs: preparedRequest.gentleAiTimeoutMs! };
		if (refusal === "unknown-flag") {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE, "materialize", REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE, {
				exitCode: materialized.exitCode,
				stderr,
				timedOut: materialized.timedOut,
				...timing,
			});
		}
		if (refusal === "handshake") {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED, "materialize", stderr, {
				exitCode: materialized.exitCode,
				stderr,
				timedOut: materialized.timedOut,
				...timing,
			});
		}
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.MATERIALIZE_FAILED, "materialize", materialized.timedOut
			? `gentle-ai prompt materialization exceeded its ${preparedRequest.gentleAiTimeoutMs!}ms bound after ${materialized.elapsedMs}ms`
			: "gentle-ai prompt materialization failed", { exitCode: materialized.exitCode, stderr, timedOut: materialized.timedOut, ...timing });
	}
	const promptBytes = materialized.stdout;
	if (promptBytes.length === 0) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.EMPTY_PROMPT, "materialize", "gentle-ai prompt materialization produced no bytes", {
			exitCode: 0,
			stderr: materialized.stderr.toString("utf8"),
			elapsedMs: materialized.elapsedMs,
			timeoutMs: preparedRequest.gentleAiTimeoutMs!,
		});
	}
	// The reviewer bound is derived from the prompt the provider actually
	// materialized. The explicit request timeout is a test seam that wins over
	// both the user-owned environment override and the scale-derived bound.
	const piTimeoutMs = preparedRequest.piTimeoutMs ?? resolveReviewHostRelayPiTimeoutMs(promptBytes.length, preparedRequest.environment);

	// The completion runs in-process through the live model registry: no
	// child, no extension allowlist, no ambient default model. Elapsed time is
	// measured here (there is no killed process to read it from) so a timed-out
	// or aborted refusal still carries the same elapsed/limit evidence a killed
	// child used to.
	const startedAt = Date.now();
	let outcome: InProcessReviewerOutcome;
	try {
		outcome = await runReviewer(
			{
				selection: preparedRequest.selection!,
				...(preparedRequest.thinking === undefined ? {} : { thinking: preparedRequest.thinking }),
				...(preparedRequest.reviewerSessionId === undefined ? {} : { sessionId: preparedRequest.reviewerSessionId }),
				prompt: promptBytes,
				timeoutMs: piTimeoutMs,
				...(preparedRequest.signal === undefined ? {} : { signal: preparedRequest.signal }),
				routingKey: preparedRequest.routingKey!,
			},
			{ registry: preparedRequest.reviewerRegistry!, complete: completeSimple },
		);
	} catch (error) {
		throw new ReviewHostRelayError(
			REVIEW_HOST_RELAY_FAILURE.PI_FAILED,
			"pi",
			`the reviewer completion could not run: ${error instanceof Error ? error.message : String(error)}`,
			{ elapsedMs: Date.now() - startedAt, timeoutMs: piTimeoutMs },
		);
	}
	if (outcome.kind === "refused") {
		throw relayReviewerRefusalError(outcome, { elapsedMs: Date.now() - startedAt, timeoutMs: piTimeoutMs }, promptBytes.length);
	}
	const resultBytes = Buffer.from(outcome.text, "utf8");
	const prepared = Object.freeze({
		request: preparedRequest,
		promptByteLength: promptBytes.length,
		resultByteLength: resultBytes.length,
	});
	preparedResultBytes.set(prepared, resultBytes);
	return prepared;
}

/**
 * Starts every reviewer before awaiting any result. If one or more reviewers
 * fail, it rejects only after every started transport has settled and reports
 * the earliest failed request in provider order.
 */
export async function runReviewHostRelayReviewerGroup(
	requests: readonly ReviewHostRelayRequest[],
	prepare: ReviewHostRelayPreparationRunner = prepareReviewHostRelaySlot,
): Promise<readonly ReviewHostRelayPreparedResult[]> {
	if (requests.length === 0) {
		throw new TypeError("Pi host relay reviewer group requires at least one provider-bound request");
	}
	const settled = await Promise.allSettled(requests.map(async (request) => await prepare(request)));
	const failed = settled.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	return settled.map((result) => (result as PromiseFulfilledResult<ReviewHostRelayPreparedResult>).value);
}

/**
 * Submits one already-reviewed opaque result through the exact provider-owned
 * completing form. Only the provider-declared artifact slot is substituted.
 */
export async function submitReviewHostRelayPreparedResult(prepared: ReviewHostRelayPreparedResult): Promise<ReviewHostRelayResult> {
	const resultBytes = preparedResultBytes.get(prepared);
	if (resultBytes === undefined) throw new TypeError("Pi host relay requires a recognized prepared result");
	const { request } = prepared;
	assertTokens("capture", request.captureArgumentTokens);
	const submissionBinding = resolveReviewHostRelaySubmission(request.submission);
	const stagingDirectory = await mkdtemp(join(tmpdir(), "gentle-pi-host-relay-result-"));
	let primaryFailure = false;
	try {
		await chmod(stagingDirectory, 0o700);
		const resultFile = join(stagingDirectory, "result.raw");
		await writeFile(resultFile, resultBytes, { mode: 0o600 });
		await chmod(resultFile, 0o600);
		const submitTokens = submissionBinding.argumentTokens.map((token, index) =>
			index === submissionBinding.substitutionLocation
				? token.split(REVIEW_HOST_RELAY_SUBMISSION_VALUE_SLOT).join(resultFile)
				: token,
		);
		let submission: ProcessCapture;
		try {
			submission = await collectGentleAiProcess(request.gentleAiExecutable!, ["review", submissionBinding.operationToken, ...submitTokens], {
				cwd: request.targetCwd!,
				env: { ...request.environment!, [GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: GENTLE_PI_REVIEW_RELAY_CONTRACT },
				timeoutMs: request.gentleAiTimeoutMs!,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
		} catch (error) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", `gentle-ai capture submission could not start: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (submission.exitCode !== 0 || submission.timedOut || submission.stdout.length === 0) {
			const stderr = submission.stderr.toString("utf8");
			const details = { exitCode: submission.exitCode, stderr, timedOut: submission.timedOut, elapsedMs: submission.elapsedMs, timeoutMs: request.gentleAiTimeoutMs! };
			// A typed admission refusal proves the provider consumed no slot.
			// Every other launched submission stays unknown pending fresh STATUS.
			if (isReviewHostRelayAdmissionRefusal(submission, stderr)) {
				throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", stderr.trim(), {
					...details,
					mutationOutcome: "none",
				});
			}
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", submission.timedOut
				? `gentle-ai capture submission exceeded its ${request.gentleAiTimeoutMs!}ms bound after ${submission.elapsedMs}ms`
				: "gentle-ai refused the relayed capture submission", details);
		}
		return {
			promptByteLength: prepared.promptByteLength,
			resultByteLength: prepared.resultByteLength,
			submission: submission.stdout.toString("utf8"),
		};
	} catch (error) {
		primaryFailure = true;
		throw error;
	} finally {
		try {
			await rm(stagingDirectory, { recursive: true, force: true });
		} catch (error) {
			if (!primaryFailure) {
				throw new ReviewHostRelayError(
					REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED,
					"submit",
					`Pi host relay result staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

/**
 * Compatibility one-binding path: materialize → in-process reviewer
 * completion → submit. It preserves the established API and its typed
 * failure behavior exactly. `runReviewer` is the same test seam
 * {@link prepareReviewHostRelaySlot} takes, threaded through so a caller never
 * needs to call the two-step path just to inject a fake completion.
 */
export async function runReviewHostRelaySlot(
	request: ReviewHostRelayRequest,
	runReviewer: typeof runInProcessReviewer = runInProcessReviewer,
): Promise<ReviewHostRelayResult> {
	return await submitReviewHostRelayPreparedResult(await prepareReviewHostRelaySlot(request, runReviewer));
}
