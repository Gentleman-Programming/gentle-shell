// The thin Pi host relay (gentle-pi#311 P4; provider contract gentle-ai#3249).
//
// gentle-ai owns prompt materialization, role and schema selection, byte
// budgets, parsing, admission, immutable capture, retry, correction
// accounting, and receipt state. This host boundary is
// intentionally narrow:
//
//   1. Run the exact provider-issued capture binding with `--agent pi
//      --materialize` and take stdout as opaque prompt BYTES, verbatim.
//   2. Pass those prompt bytes to the pure opaque Pi adapter, which owns its
//      locked-down print-mode subprocess and fresh empty scratch directory;
//      take its stdout as raw final bytes. Model/provider/profile selection
//      stays user-owned: no --model, no --provider, environment untouched.
//   3. Submit those bytes untouched through the provider-owned `submission`
//      form carried by the collect input: execute its exact operation and
//      argument tokens with only the tempfile path substituted into the
//      declared {{value}} slot (BOM-less: the buffer is written
//      byte-for-byte). The host never synthesizes or filters the completing
//      form; a materialize slot without a provider submission is a typed
//      contract mismatch, never a rebuilt invocation.
//
// On any failure the relay returns a TYPED transport error and submits
// nothing further. After a transport failure the caller re-queries negotiated
// STATUS and relaunches only if the exact same bound slot is reoffered —
// never from transcript inference. The relay never parses or rebuilds
// binding, evidence, prompt, schema, budgets, or admission.

import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveGentleAiBinary } from "./gentle-ai-binary.ts";
import { SAFE_MODEL_ID_PATTERN } from "./model-routing-authority.ts";
import { existsSync } from "node:fs";
import { delimiter as pathDelimiter } from "node:path";
import {
	OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE,
	OpaquePiReviewerTransportError,
	runOpaquePiReviewer,
	type PiReviewOutputEvidence,
	type OpaquePiReviewerResult,
} from "./opaque-pi-reviewer-adapter.ts";
import { REVIEW_PROVIDER_ROLE_CAPTURE_OPERATION, REVIEW_PROVIDER_ROLE_CAPTURE_OPERATIONS, type ReviewCaptureSubmissionV1, type ReviewCollectInputV3 } from "./review-integration-v2.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "./review-relay-contract.ts";

// Compatibility export for existing relay consumers. The pure adapter owns the
// fixed Pi process boundary and its locked-down argv.
export { OPAQUE_PI_REVIEWER_ARGV as REVIEW_HOST_RELAY_PI_ARGV } from "./opaque-pi-reviewer-adapter.ts";

export const REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE =
	"provider relay requires a gentle-ai build with the pi host relay surface";

export const REVIEW_HOST_RELAY_FAILURE = {
	RELAY_UNAVAILABLE: "relay-unavailable",
	HANDSHAKE_REFUSED: "handshake-refused",
	SUBMISSION_CONTRACT_MISMATCH: "submission-contract-mismatch",
	MATERIALIZE_FAILED: "materialize-failed",
	EMPTY_PROMPT: "empty-prompt",
	PI_LAUNCH_FAILED: "pi-launch-failed",
	PI_FAILED: "pi-failed",
	// gentle-pi#367: a reviewer killed by the relay bound is not a crash. It
	// is the one failure class that a byte-identical relaunch cannot survive,
	// so it carries its own kind, its own elapsed/limit evidence, and its own
	// continuation instead of hiding inside `pi-failed`.
	PI_TIMED_OUT: "pi-timed-out",
	PI_EMPTY_OUTPUT: "pi-empty-output",
	// gentle-shell#1158 / #1136: a caller-owned reviewer selection that cannot
	// possibly launch (a malformed selection id, a relative or missing extension
	// path) is a configuration failure, refused typed before anything runs —
	// never a mid-review transport mystery.
	REVIEWER_CONFIG_INVALID: "reviewer-config-invalid",
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
	// Wall time the killed or failed child actually consumed, and the bound it
	// was measured against. Both are null only when no child process ran.
	// Without them a transport failure cannot be told apart from a crash, which
	// is what forced the gentle-pi#367 reporter to measure the relay by hand.
	readonly elapsedMs: number | null;
	readonly timeoutMs: number | null;
	// "none" until the submission invocation launches; a launched submission
	// whose outcome could not be read is "unknown" and the caller reconciles
	// through negotiated STATUS, never through a blind retry. A launched
	// submission that gentle-ai refused with its typed admission refusal is
	// "none" again: the provider states that the lens slot was not consumed
	// (gentle-pi#522 / #524).
	readonly mutationOutcome: "none" | "unknown";
	/** What the reviewer child's own event stream revealed on an empty-output failure. */
	readonly reviewerEvidence: PiReviewOutputEvidence | undefined;
	constructor(kind: ReviewHostRelayFailureKind, stage: ReviewHostRelayStage, message: string, details?: { exitCode?: number | null; stderr?: string; timedOut?: boolean; elapsedMs?: number; timeoutMs?: number; mutationOutcome?: "none" | "unknown"; reviewerEvidence?: PiReviewOutputEvidence }) {
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
	/** User-owned pi launcher; defaults to `pi` on PATH. */
	readonly piExecutable?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly gentleAiTimeoutMs?: number;
	/**
	 * User-owned reviewer selection forwarded to the child as `--model`. The
	 * relay never invents one; the default launch stays selection-free. Must
	 * match {@link SAFE_MODEL_ID_PATTERN}; anything else is refused typed
	 * before any process launches (gentle-shell#1136).
	 */
	readonly reviewerModel?: string;
	/**
	 * User-owned extension files loaded into the isolated child through
	 * explicit `-e` paths (pi keeps explicit loads under `--no-extensions`),
	 * so a subscription provider's auth adapter can ride along without
	 * re-enabling extension discovery (gentle-shell#1158). Every path must be
	 * absolute and exist; anything else is refused typed before launch.
	 */
	readonly reviewerExtensionPaths?: readonly string[];
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
// The reviewer subprocess bound (gentle-pi#367).
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
// turn a foreground FINALIZE into an unbounded child process.
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

// The reviewer ran out of time; it did not crash. The message states both
// measurements and names the two things that can change the outcome, because
// the one thing that cannot is relaunching the identical slot.
export function reviewHostRelayPiTimeoutMessage(elapsedMs: number, timeoutMs: number, promptByteLength: number): string {
	return `pi reviewer subprocess exceeded the relay bound: killed after ${elapsedMs}ms against a ${timeoutMs}ms limit for a ${promptByteLength}-byte materialized prompt. `
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

function relayPiTransportError(error: unknown, promptByteLength: number, piTimeoutMs: number): ReviewHostRelayError {
	if (!(error instanceof OpaquePiReviewerTransportError)) {
		return new ReviewHostRelayError(
			REVIEW_HOST_RELAY_FAILURE.PI_LAUNCH_FAILED,
			"pi",
			`pi subprocess could not start: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const details = {
		exitCode: error.exitCode,
		stderr: error.stderr.toString("utf8"),
		timedOut: error.timedOut,
		...(error.elapsedMs === null ? {} : { elapsedMs: error.elapsedMs }),
		...(error.timeoutMs === null ? {} : { timeoutMs: error.timeoutMs }),
	};
	if (
		error.kind === OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.TIMED_OUT
		&& error.elapsedMs !== null
		&& error.timeoutMs !== null
	) {
		return new ReviewHostRelayError(
			REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT,
			"pi",
			reviewHostRelayPiTimeoutMessage(error.elapsedMs, error.timeoutMs, promptByteLength),
			{ ...details, timedOut: true, elapsedMs: error.elapsedMs, timeoutMs: error.timeoutMs },
		);
	}
	if (error.kind === OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT) {
		// #1156: the envelope says what the child's own stream revealed, and the
		// message names the remedies, because a bare kind code is what sent the
		// #1140 reporter into a retry loop with nothing to inspect.
		const evidence = error.evidence;
		const summary: string[] = [`stdout kind: ${evidence?.stdoutKind ?? "unknown"}`];
		if (evidence?.reviewerModel !== undefined) summary.push(`reviewer selection: ${evidence.reviewerModel}`);
		if (evidence?.toolCallAttempted) summary.push("a tool call was attempted");
		const stderrExcerpt = details.stderr.length > 0 ? ` child stderr: ${details.stderr.slice(0, 400).replace(/\s+/g, " ").trim()}` : "";
		const message = `pi subprocess produced no assistant text (${summary.join("; ")}).${stderrExcerpt}`
			+ " A reviewer that spent its turn on a tool call, a selection the child could not resolve, or a stream pi did not produce all land here; the evidence above says which."
			+ " Assign the lens a reviewer selection that answers in text (the lens's entry in the agent model routing config), and when the provider needs an auth adapter, name its absolute file path in " + REVIEW_HOST_RELAY_EXTENSIONS_ENV + ".";
		return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_EMPTY_OUTPUT, "pi", message, { ...details, ...(evidence === undefined ? {} : { reviewerEvidence: evidence }) });
	}
	if (
		error.kind === OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.LAUNCH_FAILED
		|| error.kind === OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.SCRATCH_FAILED
	) {
		return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_LAUNCH_FAILED, "pi", `pi subprocess could not start: ${error.message}`, details);
	}
	return new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "pi subprocess failed", details);
}

function assertTokens(name: string, tokens: readonly string[]): void {
	if (tokens.length === 0) throw new TypeError(`Pi host relay requires the provider-issued ${name} tokens`);
	if (tokens.some((token) => typeof token !== "string" || token.length === 0)) {
		throw new TypeError(`Pi host relay ${name} tokens must all be non-empty strings`);
	}
}

export const REVIEW_HOST_RELAY_EXTENSIONS_ENV = "GENTLE_PI_REVIEW_RELAY_EXTENSIONS";

/**
 * The user-owned extension allowlist for the reviewer child, read from the
 * environment (gentle-shell#1158). Entries are split on the platform path
 * delimiter; empty entries are skipped. Validation of each path happens at
 * snapshot time, so a broken entry is refused typed before anything launches.
 */
export function resolveReviewHostRelayExtensionPaths(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
	const configured = environment[REVIEW_HOST_RELAY_EXTENSIONS_ENV];
	if (configured === undefined || configured.trim().length === 0) return [];
	return configured.split(pathDelimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

// The tokens a validated caller-owned selection contributes to the child's
// argv. Only these two shapes may ride the forwarding path.
function reviewerLaunchArguments(reviewerModel: string | undefined, reviewerExtensionPaths: readonly string[] | undefined): readonly string[] {
	return [
		...(reviewerModel === undefined ? [] : ["--model", reviewerModel]),
		...(reviewerExtensionPaths ?? []).flatMap((path) => ["-e", path]),
	];
}

function validateReviewerLaunchConfiguration(request: ReviewHostRelayRequest): { reviewerModel?: string; reviewerExtensionPaths?: readonly string[] } {
	if (request.reviewerModel !== undefined) {
		if (typeof request.reviewerModel !== "string" || request.reviewerModel.length === 0 || !SAFE_MODEL_ID_PATTERN.test(request.reviewerModel)) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID, "pi", `Pi host relay reviewer launch configuration is invalid: the caller-owned reviewer selection ${JSON.stringify(request.reviewerModel)} is not a safe model id`);
		}
	}
	if (request.reviewerExtensionPaths !== undefined) {
		if (!Array.isArray(request.reviewerExtensionPaths) || request.reviewerExtensionPaths.some((path) => typeof path !== "string" || path.length === 0)) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID, "pi", "Pi host relay reviewer launch configuration is invalid: extension paths must all be non-empty strings");
		}
		for (const path of request.reviewerExtensionPaths) {
			if (!isAbsolute(path)) {
				throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID, "pi", `Pi host relay reviewer launch configuration is invalid: the extension path ${JSON.stringify(path)} is not absolute`);
			}
			if (!existsSync(path)) {
				throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID, "pi", `Pi host relay reviewer launch configuration is invalid: the extension path ${JSON.stringify(path)} does not exist`);
			}
		}
	}
	return {
		...(request.reviewerModel === undefined ? {} : { reviewerModel: request.reviewerModel }),
		...(request.reviewerExtensionPaths === undefined || request.reviewerExtensionPaths.length === 0 ? {} : { reviewerExtensionPaths: Object.freeze([...request.reviewerExtensionPaths]) }),
	};
}

function snapshotReviewHostRelayRequest(request: ReviewHostRelayRequest): ReviewHostRelayRequest {
	assertTokens("capture", request.captureArgumentTokens);
	// Caller-owned reviewer selection is validated before any process launches:
	// a broken configuration is a typed refusal, never a mid-review transport
	// failure (gentle-shell#1158 / #1136).
	const reviewerLaunch = validateReviewerLaunchConfiguration(request);
	// The completing form is validated before any process launches: a materialize
	// slot without a provider-owned submission is a typed contract mismatch,
	// never a synthesized invocation.
	resolveReviewHostRelaySubmission(request.submission);
	const gentleAiExecutable = request.gentleAiExecutable ?? resolveGentleAiBinary();
	if (!isAbsolute(gentleAiExecutable)) throw new TypeError("Pi host relay requires an absolute gentle-ai executable path");
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
		...reviewerLaunch,
		gentleAiExecutable,
		environment,
		gentleAiTimeoutMs: request.gentleAiTimeoutMs ?? DEFAULT_GENTLE_AI_TIMEOUT_MS,
		targetCwd: request.targetCwd ?? process.cwd(),
	});
}

/**
 * Materializes one provider-bound reviewer prompt and runs its opaque Pi
 * subprocess. It does not submit anything, so independent reviewer work can
 * finish before the caller performs provider-ordered admission.
 */
export async function prepareReviewHostRelaySlot(
	request: ReviewHostRelayRequest,
	reviewer: typeof runOpaquePiReviewer = runOpaquePiReviewer,
): Promise<ReviewHostRelayPreparedResult> {
	// Copy mutable transport configuration before the first async boundary. The
	// supplied AbortSignal intentionally stays live across materialize, reviewer,
	// and submit, preserving the established cancellation behavior.
	const preparedRequest = snapshotReviewHostRelayRequest(request);

	// The provider materializes the opaque prompt and detects whether this relay
	// surface is available. No version sniffing or prompt reconstruction occurs.
	let materialized: ProcessCapture;
	try {
		materialized = await collectGentleAiProcess(preparedRequest.gentleAiExecutable!, ["review", "capture-result", ...preparedRequest.captureArgumentTokens], {
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

	// The pure adapter owns the fresh isolated Pi process. Its input and output
	// are opaque bytes; this coordinator only maps transport failures.
	const launchArguments = reviewerLaunchArguments(preparedRequest.reviewerModel, preparedRequest.reviewerExtensionPaths);
	let piResult: OpaquePiReviewerResult;
	try {
		piResult = await reviewer(promptBytes, {
			...(preparedRequest.piExecutable === undefined ? {} : { piExecutable: preparedRequest.piExecutable }),
			environment: preparedRequest.environment,
			timeoutMs: piTimeoutMs,
			...(preparedRequest.signal === undefined ? {} : { signal: preparedRequest.signal }),
			...(launchArguments.length === 0 ? {} : { extraArguments: launchArguments }),
		});
	} catch (error) {
		throw relayPiTransportError(error, promptBytes.length, piTimeoutMs);
	}
	const prepared = Object.freeze({
		request: preparedRequest,
		promptByteLength: promptBytes.length,
		resultByteLength: piResult.stdoutByteLength,
	});
	preparedResultBytes.set(prepared, Buffer.from(piResult.stdout));
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
 * Compatibility one-binding path: materialize → opaque Pi adapter → submit.
 * It preserves the established API and its typed failure behavior exactly.
 */
export async function runReviewHostRelaySlot(request: ReviewHostRelayRequest): Promise<ReviewHostRelayResult> {
	return await submitReviewHostRelayPreparedResult(await prepareReviewHostRelaySlot(request));
}
