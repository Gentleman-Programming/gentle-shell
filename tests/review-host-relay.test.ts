import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeExecFileAdapter } from "../lib/native-review-cli.ts";
import { INPROCESS_REVIEWER_FAILURE, type InProcessReviewerOutcome, type InProcessReviewerRequest, type InProcessReviewerDeps, runInProcessReviewer } from "../lib/inprocess-reviewer.ts";
import {
	REVIEW_HOST_RELAY_FAILURE,
	REVIEW_HOST_RELAY_PI_TIMEOUT_ENV,
	REVIEW_HOST_RELAY_PI_TIMEOUT_FLOOR_MS,
	REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS,
	REVIEW_HOST_RELAY_PI_TIMEOUT_PER_MEBIBYTE_MS,
	REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE,
	REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE,
	ReviewHostRelayError,
	classifyReviewHostRelayRefusal,
	resolveReviewHostRelayPiTimeoutMs,
	resolveReviewHostRelaySubmission,
	reviewHostRelaySlots,
	reviewHostRelayUnachievableDetail,
	reviewHostRelayUnachievableReason,
	prepareReviewHostRelaySlot,
	runReviewHostRelayReviewerGroup,
	runReviewHostRelaySlot,
	submitReviewHostRelayPreparedResult,
	type ReviewHostRelayPreparedResult,
	type ReviewHostRelayRequest,
} from "../lib/review-host-relay.ts";
import * as reviewHostRelayModule from "../lib/review-host-relay.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "../lib/review-relay-contract.ts";
import { decodeReviewNextTransitionV3, type ReviewCaptureSubmissionV1, type ReviewCollectInputV3 } from "../lib/review-integration-v2.ts";

// gentle-pi#311 P2: the reviewer transport this file exercises no longer
// spawns a pi child. `runReviewHostRelaySlot`/`prepareReviewHostRelaySlot`
// take an injectable `runReviewer` (defaulting to the real
// `runInProcessReviewer`), so every test below fakes that seam instead of a
// fake `pi` executable on disk. `lib/inprocess-reviewer.ts`'s own tests own
// the completion's internal behavior (model resolution, auth, thinking
// mapping, text extraction); this file owns the relay's mapping of that
// completion's outcome onto a typed `ReviewHostRelayError`, plus everything
// unrelated to the reviewer transport (materialize, submission, admission,
// slot detection) which stayed exactly as it was.

// ---------------------------------------------------------------------------
// Fake gentle-ai binary. Following the repo's fake-executable idiom (shell/git
// wrappers in related review tests), this is a shebang script written into a
// scratch directory; a node script is used so binary-unsafe bytes survive
// verbatim.
// ---------------------------------------------------------------------------

const FAKE_GENTLE_AI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (process.env.RELAY_FAKE_LOG) fs.appendFileSync(process.env.RELAY_FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), contract: process.env.${GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV} ?? null }) + "\\n");
if (argv.some((token) => token === "--materialize" || token.startsWith("--materialize="))) {
	const mode = process.env.RELAY_FAKE_MATERIALIZE_MODE || "ok";
	if (mode === "ok") { process.stdout.write(Buffer.from(process.env.RELAY_FAKE_PROMPT_B64 || "", "base64")); process.exit(0); }
	if (mode === "empty") process.exit(0);
	if (mode === "unknown-flag") { process.stderr.write("flag provided but not defined: -materialize\\nUsage of gentle-ai review capture-result:\\n"); process.exit(2); }
	if (mode === "handshake") { process.stderr.write(process.env.RELAY_FAKE_HANDSHAKE_STDERR || "the active runtime is not eligible for immutable receipt review"); process.exit(1); }
	process.stderr.write("materialize exploded\\n"); process.exit(3);
}
const inputToken = argv.find((token) => token === "--input" || token.startsWith("--input="));
if (inputToken !== undefined) {
	const mode = process.env.RELAY_FAKE_SUBMIT_MODE || "ok";
	const inputPath = inputToken.startsWith("--input=") ? inputToken.slice("--input=".length) : argv[argv.indexOf("--input") + 1];
	const submitDelayMs = Number(process.env.RELAY_FAKE_SUBMIT_DELAY_MS || "0");
	if (Number.isSafeInteger(submitDelayMs) && submitDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, submitDelayMs);
	if (mode === "ok" || mode === "cleanup-fail") {
		const bytes = fs.readFileSync(inputPath);
		if (process.env.RELAY_FAKE_SUBMIT_CAPTURE) fs.writeFileSync(process.env.RELAY_FAKE_SUBMIT_CAPTURE, bytes);
		const accepted = JSON.stringify({ schema: "gentle-ai.review-result-artifact/v2", admission_decision: "completed" });
		if (mode === "cleanup-fail") {
			process.stdout.write(accepted, () => {
				fs.chmodSync(path.dirname(path.dirname(inputPath)), 0o500);
				process.exit(0);
			});
			return;
		}
		process.stdout.write(accepted);
		process.exit(0);
	}
	if (mode === "refuse-cleanup-fail") fs.chmodSync(path.dirname(path.dirname(inputPath)), 0o500);
	if (mode === "admit") {
		// Go's admission refusal shape: a schema-bounded failure/v2 envelope on
		// stdout, the operator line with the typed code suffix on stderr, exit 1.
		const bytes = fs.readFileSync(inputPath);
		let parsed;
		try { parsed = JSON.parse(bytes.toString("utf8")); } catch { parsed = undefined; }
		const refuse = (cause) => {
			process.stdout.write(JSON.stringify({ schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2", operation: "review.capture-result", phase: "preflight", code: "invalid_request", message: "The negotiated review request is invalid.", mutation_outcome: "not_started", authority_applicability: "not_evaluated", retry_safe: true, replayability: "not_replayable", required_inputs: [], next_action: "correct_request", cause }));
			process.stderr.write("Error: " + cause + " [invalid_request]\\n");
			process.exit(1);
		};
		if (parsed === undefined || typeof parsed !== "object") refuse("lens provider result admission incomplete: reviewer payload contains no complete JSON object: no object start was found in " + bytes.length + " bytes; the rejected reviewer payload was preserved at " + inputPath + ".rejected");
		if (parsed.subject_hash !== process.env.RELAY_FAKE_EXPECTED_SUBJECT) refuse("reviewer artifact admission binding_mismatch: reviewer result echoed a different artifact subject: the rejected admission did not consume the lens slot, so re-run the lens and invoke gentle-ai review capture-result again on the same lineage with a result that echoes the binding's top-level subject_hash, which is " + process.env.RELAY_FAKE_EXPECTED_SUBJECT);
		process.stdout.write(JSON.stringify({ schema: "gentle-ai.review-result-artifact/v2", admission_decision: "completed" }));
		process.exit(0);
	}
	process.stderr.write("capture binding does not match the current reviewing authority\\n");
	process.exit(1);
}
process.stderr.write("unexpected fake gentle-ai invocation\\n");
process.exit(9);
`;

interface RelayHarness {
	directory: string;
	gentleAi: string;
	logPath: string;
	submitCapturePath: string;
	targetCwd: string;
	environment: NodeJS.ProcessEnv;
}

function harness(t: test.TestContext, overrides: Record<string, string> = {}): RelayHarness {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-relay-harness-")));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const gentleAi = join(directory, "gentle-ai");
	writeFileSync(gentleAi, FAKE_GENTLE_AI);
	chmodSync(gentleAi, 0o755);
	const logPath = join(directory, "gentle-ai.log");
	const submitCapturePath = join(directory, "submitted.bin");
	const targetCwd = join(directory, "target-worktree");
	mkdirSync(targetCwd);
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		RELAY_FAKE_LOG: logPath,
		RELAY_FAKE_SUBMIT_CAPTURE: submitCapturePath,
		...overrides,
	};
	// The relay itself must add the handshake; the base environment never
	// carries it, so the fake-binary log proves the injection.
	delete environment[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV];
	return { directory, gentleAi, logPath, submitCapturePath, targetCwd, environment };
}

function readLog(path: string): Array<{ argv: string[]; contract: string | null; cwd?: string }> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

const BINDING_TOKENS = Object.freeze([
	"--lineage=review-1d5aadacc600e167",
	`--expected-revision=sha256:${"c".repeat(64)}`,
	`--target=sha256:${"d".repeat(64)}`,
	`--repository-context=rctx1_${"e".repeat(64)}`,
	"--lens=review-reliability",
	"--order=0",
	`--subject-hash=sha256:${"a".repeat(64)}`,
]);
const CAPTURE_TOKENS = Object.freeze([...BINDING_TOKENS, "--agent=pi", "--materialize=true"]);
const REVIEWER_GROUP_LENSES = ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const;

// The provider-owned completing form: exact operation and argument tokens
// with one declared {{value}} substitution slot for the artifact path.
const SUBMISSION: ReviewCaptureSubmissionV1 = Object.freeze({
	operationToken: "capture-result",
	argumentTokens: Object.freeze([...BINDING_TOKENS, "--input={{value}}"]),
	values: Object.freeze([{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: BINDING_TOKENS.length }]),
});

// Prompt bytes deliberately include binary-unsafe content: NUL, control
// bytes, quotes, backslashes, CRLF, multi-byte UTF-8, and bytes that are not
// valid UTF-8 at all. The relay must materialize them verbatim into the
// completion request.
const PROMPT_BYTES = Buffer.concat([
	Buffer.from('GENTLE_AI_REVIEW_BINDING {"lineage":"review-1d5aadacc600e167"}\n"quotes" \\backslash\r\n\u00e9\u{1F3A9}\n', "utf8"),
	Buffer.from([0x00, 0x01, 0x07, 0xff, 0xfe, 0x00]),
]);
// The reviewer's completion text — what used to be the pi event stream's
// extracted assistant text is now simply the in-process outcome's `text`.
const REVIEWER_TEXT = `{"subject_hash":"sha256:${"a".repeat(64)}","findings":[]}\n🎉\r\n`;

function relayRequest(fixture: RelayHarness, overrides: Record<string, unknown> = {}): ReviewHostRelayRequest {
	return {
		captureArgumentTokens: CAPTURE_TOKENS,
		submission: SUBMISSION,
		gentleAiExecutable: fixture.gentleAi,
		targetCwd: fixture.targetCwd,
		reviewerRegistry: {
			find: () => ({ id: "gpt-5", name: "GPT-5", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8192 }) as never,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		selection: "openai/gpt-5",
		routingKey: "review-reliability",
		environment: {
			...fixture.environment,
			RELAY_FAKE_PROMPT_B64: PROMPT_BYTES.toString("base64"),
		},
		gentleAiTimeoutMs: 30_000,
		piTimeoutMs: 30_000,
		...overrides,
	} as ReviewHostRelayRequest;
}

/** A `runReviewer` fake resolving with canned completion text, capturing every call. */
function textReviewer(text: string, reviewerModel = "openai/gpt-5") {
	const calls: InProcessReviewerRequest[] = [];
	const runReviewer = (async (request: InProcessReviewerRequest, _deps: InProcessReviewerDeps): Promise<InProcessReviewerOutcome> => {
		calls.push(request);
		return { kind: "text", text, reviewerModel };
	}) as typeof runInProcessReviewer;
	return { runReviewer, calls };
}

/** A `runReviewer` fake resolving with a canned typed refusal. */
function refusingReviewer(code: (typeof INPROCESS_REVIEWER_FAILURE)[keyof typeof INPROCESS_REVIEWER_FAILURE], message: string, evidence?: Record<string, unknown>, delayMs = 0): typeof runInProcessReviewer {
	return (async () => {
		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
		return { kind: "refused", code, message, ...(evidence === undefined ? {} : { evidence }) };
	}) as typeof runInProcessReviewer;
}

/** Runs one relay slot with a safe-by-default fake reviewer; no test may reach the real network unless it explicitly overrides this. */
function runRelay(fixture: RelayHarness, overrides: Record<string, unknown> = {}, runReviewer: typeof runInProcessReviewer = textReviewer(REVIEWER_TEXT).runReviewer): Promise<{ promptByteLength: number; resultByteLength: number; submission: string }> {
	return runReviewHostRelaySlot(relayRequest(fixture, overrides), runReviewer);
}

function reviewerGroupRequests(fixture: RelayHarness): ReviewHostRelayRequest[] {
	return REVIEWER_GROUP_LENSES.map((lens, order) => relayRequest(fixture, {
		captureArgumentTokens: CAPTURE_TOKENS.map((token) => token === "--lens=review-reliability"
			? `--lens=${lens}`
			: token === "--order=0" ? `--order=${order}` : token),
		routingKey: lens,
		environment: {
			...fixture.environment,
			RELAY_FAKE_PROMPT_B64: PROMPT_BYTES.toString("base64"),
		},
	}));
}

async function rejectsWithRelayError(promise: Promise<unknown>, kind: string, stage: string): Promise<ReviewHostRelayError> {
	let caught: ReviewHostRelayError | undefined;
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof ReviewHostRelayError, `expected ReviewHostRelayError, received ${String(error)}`);
		caught = error;
		return error.name === "ReviewHostRelayError" && error.kind === kind && error.stage === stage;
	});
	return caught!;
}

// ---------------------------------------------------------------------------
// Handshake — every gentle-ai CLI spawn carries the compiled declaration.
// ---------------------------------------------------------------------------

test("the central native CLI runner declares the relay contract on every gentle-ai spawn", async (t) => {
	const fixture = harness(t);
	const probe = join(fixture.directory, "env-probe");
	writeFileSync(probe, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ contract: process.env.${GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV} ?? null }));\n`);
	chmodSync(probe, 0o755);
	const hadContract = Object.prototype.hasOwnProperty.call(process.env, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV);
	const previous = process.env[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV];
	delete process.env[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV];
	t.after(() => {
		if (hadContract) process.env[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV] = previous;
	});
	const adapter = createNodeExecFileAdapter();
	for (const argv of [["version"], ["review", "status", "--cwd", fixture.directory]]) {
		const result = await adapter({ file: probe, arguments: argv, cwd: fixture.directory, timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 });
		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.stdout), { contract: GENTLE_PI_REVIEW_RELAY_CONTRACT });
	}
});

test("relay contract constants are the compiled gentle-ai handshake values", () => {
	assert.equal(GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV, "GENTLE_PI_REVIEW_RELAY_CONTRACT");
	assert.equal(GENTLE_PI_REVIEW_RELAY_CONTRACT, "gentle-pi.review-relay/v1");
});

test("no pi child launcher is exported: the lens path completes in-process", () => {
	const relayExports = reviewHostRelayModule as unknown as Record<string, unknown>;
	assert.equal("REVIEW_HOST_RELAY_PI_ARGV" in relayExports, false, "the pinned pi argv export must be gone");
	assert.equal("resolveReviewHostRelayExtensionPaths" in relayExports, false, "the extension allowlist reader must be gone");
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("relay happy path moves prompt bytes verbatim into the completion and submits its text through the exact provider submission token", async (t) => {
	const fixture = harness(t);
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const result = await runRelay(fixture, {}, runReviewer);

	assert.equal(result.promptByteLength, PROMPT_BYTES.length);
	assert.equal(result.resultByteLength, Buffer.byteLength(REVIEWER_TEXT));
	assert.equal(JSON.parse(result.submission).admission_decision, "completed");

	// Prompt bytes reached the completion request verbatim.
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.prompt.equals(PROMPT_BYTES));
	// Submission --input file bytes are EXACTLY the reviewer's completion text.
	assert.deepEqual(readFileSync(fixture.submitCapturePath), Buffer.from(REVIEWER_TEXT, "utf8"));

	const gentleAiCalls = readLog(fixture.logPath);
	assert.equal(gentleAiCalls.length, 2);
	// (a) exact provider tokens, verbatim, in provider order.
	assert.deepEqual(gentleAiCalls[0]!.argv, ["review", "capture-result", ...CAPTURE_TOKENS]);
	// (b) the provider-owned submission form, verbatim: its exact operation
	// and argument tokens with only the artifact path substituted into the
	// declared {{value}} slot. No agent/materialize, nothing synthesized.
	assert.deepEqual(gentleAiCalls[1]!.argv.slice(0, 2 + BINDING_TOKENS.length), ["review", SUBMISSION.operationToken, ...BINDING_TOKENS]);
	const substituted = gentleAiCalls[1]!.argv.at(-1)!;
	assert.match(substituted, /^--input=\S+$/);
	assert.equal(substituted.includes("{{value}}"), false);
	assert.equal(existsSync(substituted.slice("--input=".length)), false, "the coordinator removes its temporary result file after provider submission");
	assert.equal(gentleAiCalls[1]!.argv.length, 2 + SUBMISSION.argumentTokens.length);
	assert.equal(gentleAiCalls[1]!.argv.some((token) => token.includes("--agent") || token.includes("--materialize")), false);
	// Handshake declared on both gentle-ai invocations even though the base
	// environment carried none.
	assert.deepEqual(gentleAiCalls.map((call) => call.contract), [GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT]);
	assert.deepEqual(gentleAiCalls.map((call) => call.cwd), [fixture.targetCwd, fixture.targetCwd]);
});

// gentle-pi#311 P3: a v9 provider role slot (refuter, targeted validator)
// reaches this same relay through the exact same request shape a lens
// materialize slot uses — the only difference is the operation name the
// provider's own submission descriptor names. The materialize invocation
// must follow that name, never a hardcoded "capture-result".
test("the materialize invocation follows the provider's own submission operation, not a hardcoded capture-result", async (t) => {
	const fixture = harness(t);
	const bindingTokens = [
		"--lineage=review-1d5aadacc600e167",
		`--expected-revision=sha256:${"c".repeat(64)}`,
		`--target=sha256:${"d".repeat(64)}`,
		`--repository-context=rctx1_${"e".repeat(64)}`,
	];
	const refuterCaptureTokens = [...bindingTokens, "--agent=pi", "--materialize=true"];
	const refuterSubmission: ReviewCaptureSubmissionV1 = {
		operationToken: "capture-refuter",
		argumentTokens: [...bindingTokens, "--agent=pi", "--input={{value}}"],
		values: [{ slot: "provider_refuter", domain: "artifact_path_or_stdin", substitutionLocation: bindingTokens.length + 1 }],
	};
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const result = await runRelay(fixture, { captureArgumentTokens: refuterCaptureTokens, submission: refuterSubmission, routingKey: "review-refuter" }, runReviewer);

	assert.equal(JSON.parse(result.submission).admission_decision, "completed");
	assert.equal(calls.length, 1);
	const gentleAiCalls = readLog(fixture.logPath);
	assert.equal(gentleAiCalls.length, 2);
	assert.deepEqual(gentleAiCalls[0]!.argv, ["review", "capture-refuter", ...refuterCaptureTokens]);
	assert.deepEqual(gentleAiCalls[1]!.argv.slice(0, 2 + bindingTokens.length), ["review", "capture-refuter", ...bindingTokens]);
	assert.equal(gentleAiCalls[1]!.argv[2 + bindingTokens.length], "--agent=pi");
	const submitted = gentleAiCalls[1]!.argv.at(-1)!;
	assert.match(submitted, /^--input=\S+$/);
});

test("preparation snapshots mutable submission tokens and values before materialization", async (t) => {
	const fixture = harness(t);
	const submissionTokens = [...SUBMISSION.argumentTokens];
	const submissionValues = SUBMISSION.values.map((value) => ({ ...value }));
	const submission: ReviewCaptureSubmissionV1 = { ...SUBMISSION, argumentTokens: submissionTokens, values: submissionValues };
	let releaseCompletion: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
	let reached = false;
	const runReviewer = (async () => {
		reached = true;
		await gate;
		return { kind: "text", text: REVIEWER_TEXT, reviewerModel: "openai/gpt-5" } as InProcessReviewerOutcome;
	}) as typeof runInProcessReviewer;
	const prepared = prepareReviewHostRelaySlot(relayRequest(fixture, { submission }), runReviewer);
	await waitFor(() => reached, "the completion was never reached");
	submissionTokens[submissionTokens.length - 1] = "--input=mutated";
	submissionValues[0]!.slot = "mutated";
	releaseCompletion!();

	const result = await prepared;
	assert.deepEqual(result.request.submission, SUBMISSION);
	await submitReviewHostRelayPreparedResult(result);
	assert.deepEqual(readFileSync(fixture.submitCapturePath), Buffer.from(REVIEWER_TEXT, "utf8"));
});

test("preparation keeps reviewer bytes private through deferred submission", async (t) => {
	const fixture = harness(t);
	const prepared = await prepareReviewHostRelaySlot(relayRequest(fixture), textReviewer(REVIEWER_TEXT).runReviewer);
	const mutablePrepared = prepared as unknown as { resultBytes?: Buffer };
	mutablePrepared.resultBytes?.fill(0);
	assert.throws(() => { mutablePrepared.resultBytes = Buffer.from("fabricated"); }, TypeError);
	await submitReviewHostRelayPreparedResult(prepared);
	assert.deepEqual(readFileSync(fixture.submitCapturePath), Buffer.from(REVIEWER_TEXT, "utf8"));

	const fabricated = { ...prepared, resultBytes: Buffer.from("fabricated") } as unknown as ReviewHostRelayPreparedResult;
	await assert.rejects(submitReviewHostRelayPreparedResult(fabricated), /recognized prepared result/);
	assert.equal(readLog(fixture.logPath).length, 2, "unrecognized results must not launch provider submission");
});

test("the supplied AbortSignal stays live through deferred submission", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_DELAY_MS: "1000" });
	const controller = new AbortController();
	const prepared = await prepareReviewHostRelaySlot(relayRequest(fixture, { signal: controller.signal }), textReviewer(REVIEWER_TEXT).runReviewer);
	const submission = submitReviewHostRelayPreparedResult(prepared);
	await waitFor(() => readLog(fixture.logPath).length === 2, "submission did not start");
	controller.abort();
	await rejectsWithRelayError(submission, REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit");
});

test("four reviewers cross a shared barrier before any result submission can begin", async (t) => {
	const fixture = harness(t);
	const requests = reviewerGroupRequests(fixture);
	let started = 0;
	const releases: Array<() => void> = [];
	const runReviewer = (async () => {
		started += 1;
		await new Promise<void>((resolve) => releases.push(resolve));
		return { kind: "text", text: REVIEWER_TEXT, reviewerModel: "openai/gpt-5" } as InProcessReviewerOutcome;
	}) as typeof runInProcessReviewer;

	const group = runReviewHostRelayReviewerGroup(requests, (request) => prepareReviewHostRelaySlot(request, runReviewer));
	await waitFor(() => started === REVIEWER_GROUP_LENSES.length, "every reviewer must start before any completes");
	for (const release of releases) release();
	const prepared = await group;

	assert.equal(prepared.length, REVIEWER_GROUP_LENSES.length);
	assert.ok(prepared.every((result) => result.resultByteLength === Buffer.byteLength(REVIEWER_TEXT)));
	assert.equal(readLog(fixture.logPath).length, REVIEWER_GROUP_LENSES.length, "preparation materializes only; it does not submit");
});

test("four reviewer results retain provider order when their preparation resolves in reverse", async (t) => {
	const requests = reviewerGroupRequests(harness(t));
	const started: number[] = [];
	const complete: Array<() => void> = [];
	const group = runReviewHostRelayReviewerGroup(requests, (request) => new Promise<ReviewHostRelayPreparedResult>((resolve) => {
		const index = requests.indexOf(request);
		assert.notEqual(index, -1);
		started.push(index);
		complete.push(() => resolve({
			request,
			promptByteLength: index + 1,
			resultByteLength: index + 1,
		}));
	}));

	assert.deepEqual(started, [0, 1, 2, 3], "every reviewer starts before the group waits");
	for (const finish of [...complete].reverse()) finish();
	const prepared = await group;

	assert.deepEqual(prepared.map((result) => result.resultByteLength), [1, 2, 3, 4]);
});

test("partial reviewer failures wait for a later pending transport and report the first provider-ordered error", async (t) => {
	const requests = reviewerGroupRequests(harness(t));
	const started: number[] = [];
	let groupSettled = false;
	let releaseLaterReviewer: (() => void) | undefined, rejectFirstProvider: ((reason?: unknown) => void) | undefined;
	const firstProviderError = new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "first provider error");

	const group = runReviewHostRelayReviewerGroup(requests, (request) => {
		const index = requests.indexOf(request);
		assert.notEqual(index, -1);
		started.push(index);
		if (index === 1) return new Promise<ReviewHostRelayPreparedResult>((_resolve, reject) => { rejectFirstProvider = reject; });
		if (index === 2) return Promise.reject(new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "later provider error"));
		if (index === 3) {
			return new Promise<ReviewHostRelayPreparedResult>((resolve) => {
				releaseLaterReviewer = () => resolve({
					request,
					promptByteLength: index + 1,
					resultByteLength: index + 1,
				});
			});
		}
		return Promise.resolve({
			request,
			promptByteLength: index + 1,
			resultByteLength: index + 1,
		});
	});
	void group.then(() => { groupSettled = true; }, () => { groupSettled = true; });

	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(started, [0, 1, 2, 3], "one failed reviewer does not prevent later reviewers from starting");
	rejectFirstProvider!(firstProviderError); await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(groupSettled, false, "the group must remain pending until the later reviewer settles");
	releaseLaterReviewer!();
	await assert.rejects(group, (error: unknown) => error === firstProviderError);
});

// ---------------------------------------------------------------------------
// Fail-closed legs — a typed transport error and NO submission.
// ---------------------------------------------------------------------------

test("materialize nonzero exit fails closed with a typed error and never runs the completion or submits", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "fail" });
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const error = await rejectsWithRelayError(runRelay(fixture, {}, runReviewer), REVIEW_HOST_RELAY_FAILURE.MATERIALIZE_FAILED, "materialize");
	assert.equal(error.exitCode, 3);
	assert.equal(error.mutationOutcome, "none");
	assert.equal(readLog(fixture.logPath).length, 1);
	assert.equal(calls.length, 0, "no completion may run after a materialize failure");
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("an empty materialized prompt fails closed before the completion runs", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "empty" });
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	await rejectsWithRelayError(runRelay(fixture, {}, runReviewer), REVIEW_HOST_RELAY_FAILURE.EMPTY_PROMPT, "materialize");
	assert.equal(calls.length, 0);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

// ---------------------------------------------------------------------------
// Every in-process reviewer refusal code maps to its typed relay code.
// ---------------------------------------------------------------------------

test("every in-process reviewer refusal maps to its typed relay failure code, carrying evidence when the outcome had any", async (t) => {
	const cases: Array<{ code: (typeof INPROCESS_REVIEWER_FAILURE)[keyof typeof INPROCESS_REVIEWER_FAILURE]; kind: string; evidence?: Record<string, unknown> }> = [
		{ code: INPROCESS_REVIEWER_FAILURE.SELECTION_INVALID, kind: REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID },
		{ code: INPROCESS_REVIEWER_FAILURE.MODEL_NOT_FOUND, kind: REVIEW_HOST_RELAY_FAILURE.REVIEWER_MODEL_NOT_FOUND },
		{ code: INPROCESS_REVIEWER_FAILURE.AUTH_UNAVAILABLE, kind: REVIEW_HOST_RELAY_FAILURE.REVIEWER_AUTH_UNAVAILABLE },
		{ code: INPROCESS_REVIEWER_FAILURE.THINKING_INVALID, kind: REVIEW_HOST_RELAY_FAILURE.REVIEWER_THINKING_INVALID },
		{ code: INPROCESS_REVIEWER_FAILURE.TOOL_CALL_ATTEMPTED, kind: REVIEW_HOST_RELAY_FAILURE.REVIEWER_TOOL_CALL },
		{ code: INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT, kind: REVIEW_HOST_RELAY_FAILURE.REVIEWER_EMPTY_OUTPUT, evidence: { stopReason: "stop" } },
		{ code: INPROCESS_REVIEWER_FAILURE.OUTPUT_TOO_LARGE, kind: REVIEW_HOST_RELAY_FAILURE.REVIEWER_OUTPUT_TOO_LARGE },
		{ code: INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED, kind: REVIEW_HOST_RELAY_FAILURE.PI_FAILED },
	];
	for (const { code, kind, evidence } of cases) {
		const fixture = harness(t);
		const message = `refused: ${code}`;
		const error = await rejectsWithRelayError(runRelay(fixture, {}, refusingReviewer(code, message, evidence)), kind, "pi");
		assert.equal(error.message, message);
		assert.equal(error.mutationOutcome, "none");
		assert.equal(existsSync(fixture.submitCapturePath), false, `${code} must never reach submission`);
		if (evidence !== undefined) assert.deepEqual(error.reviewerEvidence, evidence, `${code} must carry its outcome evidence`);
	}
});

test("a reviewer run that only attempted a tool call fails typed and never submits", async (t) => {
	const fixture = harness(t);
	const error = await rejectsWithRelayError(
		runRelay(fixture, {}, refusingReviewer(INPROCESS_REVIEWER_FAILURE.TOOL_CALL_ATTEMPTED, "Reviewer attempted a tool call for review-reliability; the in-process reviewer completion must answer in text only.")),
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_TOOL_CALL,
		"pi",
	);
	assert.equal(existsSync(fixture.submitCapturePath), false);
	assert.match(error.message, /tool call/);
});

test("the relay forwards the caller-owned selection and thinking level to the completion request", async (t) => {
	const fixture = harness(t);
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	await runRelay(fixture, { selection: "minimax/MiniMax-M3", thinking: "high", routingKey: "review-risk" }, runReviewer);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.selection, "minimax/MiniMax-M3");
	assert.equal(calls[0]!.thinking, "high");
	assert.equal(calls[0]!.routingKey, "review-risk");
});

test("a missing model registry is refused typed before materialize ever runs", async (t) => {
	const fixture = harness(t);
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const error = await rejectsWithRelayError(runRelay(fixture, { reviewerRegistry: undefined }, runReviewer), REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID, "pi");
	assert.equal(calls.length, 0, "no completion may run on a broken configuration");
	assert.equal(readLog(fixture.logPath).length, 0, "no materialization may run without a model registry");
	assert.match(error.message, /model registry/);
});

test("a routing entry with no configured model is refused typed, naming the routing key, before materialize ever runs", async (t) => {
	const fixture = harness(t);
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const error = await rejectsWithRelayError(runRelay(fixture, { selection: undefined, routingKey: "review-risk" }, runReviewer), REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID, "pi");
	assert.equal(calls.length, 0);
	assert.equal(readLog(fixture.logPath).length, 0, "no materialization may run without a configured model");
	assert.match(error.message, /review-risk/);
});

test("a tool call's cancelled signal maps to REVIEWER_ABORTED and forwards the caller's own signal to the completion", async (t) => {
	const fixture = harness(t);
	const controller = new AbortController();
	let receivedSignal: AbortSignal | undefined;
	// The signal aborts once the completion actually starts (materialize must
	// already have succeeded with a live signal); this proves the same signal
	// object reaches the completion request, not just that an early abort
	// short-circuits materialize too.
	const runReviewer = (async (request: InProcessReviewerRequest) => {
		receivedSignal = request.signal;
		controller.abort();
		return { kind: "refused", code: INPROCESS_REVIEWER_FAILURE.ABORTED, message: "Reviewer completion for review-reliability was aborted by the caller." } as InProcessReviewerOutcome;
	}) as typeof runInProcessReviewer;
	const error = await rejectsWithRelayError(runRelay(fixture, { signal: controller.signal }, runReviewer), REVIEW_HOST_RELAY_FAILURE.REVIEWER_ABORTED, "pi");
	assert.equal(receivedSignal, controller.signal, "the relay must forward the tool call's own signal into the completion request");
	assert.match(error.message, /aborted/);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

// ---------------------------------------------------------------------------
// gentle-pi#367 — the reviewer bound is reachable from production, and a
// timed-out completion says so with both measurements.
// ---------------------------------------------------------------------------

test("the reviewer bound scales with materialized prompt bytes instead of one fixed number", () => {
	const empty: NodeJS.ProcessEnv = {};
	// A tiny prompt still gets the model-latency floor.
	assert.equal(resolveReviewHostRelayPiTimeoutMs(0, empty), REVIEW_HOST_RELAY_PI_TIMEOUT_FLOOR_MS);
	assert.equal(resolveReviewHostRelayPiTimeoutMs(1, empty), REVIEW_HOST_RELAY_PI_TIMEOUT_FLOOR_MS + 1);
	// One mebibyte of prompt buys exactly one linear allowance.
	assert.equal(
		resolveReviewHostRelayPiTimeoutMs(1024 * 1024, empty),
		REVIEW_HOST_RELAY_PI_TIMEOUT_FLOOR_MS + REVIEW_HOST_RELAY_PI_TIMEOUT_PER_MEBIBYTE_MS,
	);
	// The reported field candidate: ~1.58 MB of prompt, whose reviewer needed
	// 478s and was killed by the old fixed 600s bound. The derived bound must
	// clear that measurement with real margin.
	const reported = resolveReviewHostRelayPiTimeoutMs(1_580_000, empty);
	assert.ok(reported > 600_000, `derived bound ${reported} must exceed the old fixed 600000ms bound`);
	assert.ok(reported > 478_000 * 3, `derived bound ${reported} must keep real margin over the measured 478000ms reviewer run`);
	// Never unbounded, however large the prompt gets.
	assert.equal(resolveReviewHostRelayPiTimeoutMs(Number.MAX_SAFE_INTEGER, empty), REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS);
});

test("the reviewer bound honours the environment override and ignores malformed values", () => {
	const bytes = 4 * 1024 * 1024;
	assert.equal(resolveReviewHostRelayPiTimeoutMs(bytes, { [REVIEW_HOST_RELAY_PI_TIMEOUT_ENV]: "1234" }), 1234);
	// The override is clamped by the same hard ceiling as the derived bound.
	assert.equal(resolveReviewHostRelayPiTimeoutMs(bytes, { [REVIEW_HOST_RELAY_PI_TIMEOUT_ENV]: "999999999" }), REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS);
	const derived = resolveReviewHostRelayPiTimeoutMs(bytes, {});
	for (const malformed of ["", "0", "-1", "12.5", "abc", " 600000", "1e6"]) {
		assert.equal(resolveReviewHostRelayPiTimeoutMs(bytes, { [REVIEW_HOST_RELAY_PI_TIMEOUT_ENV]: malformed }), derived, `malformed ${JSON.stringify(malformed)} must fall back to the derived bound`);
	}
});

test("the production relay path resolves the reviewer bound from the environment and forwards it to the completion, with no injected timeout", async (t) => {
	// The regression this guards: piTimeoutMs was reachable only through the
	// test seam, so production always ran against a fixed bound. This request
	// injects no timeout at all — the override must reach the completion.
	const fixture = harness(t, { [REVIEW_HOST_RELAY_PI_TIMEOUT_ENV]: "300000" });
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	await runRelay(fixture, { piTimeoutMs: undefined }, runReviewer);
	assert.equal(calls[0]!.timeoutMs, 300_000);
});

test("a timed-out reviewer completion reports elapsed, limit, and what to change instead of an opaque transport failure", async (t) => {
	const fixture = harness(t);
	const error = await rejectsWithRelayError(
		runRelay(fixture, { piTimeoutMs: 300 }, refusingReviewer(INPROCESS_REVIEWER_FAILURE.TIMED_OUT, "Reviewer completion for review-reliability exceeded its 300ms bound.", undefined, 20)),
		REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT,
		"pi",
	);
	assert.equal(error.timeoutMs, 300);
	assert.ok(error.elapsedMs !== null && error.elapsedMs >= 15, `elapsed ${error.elapsedMs} must record the real wall time`);
	assert.equal(error.timedOut, true);
	assert.match(error.message, /exceeded the relay bound/);
	assert.match(error.message, new RegExp(String(error.elapsedMs)));
	assert.match(error.message, /limit for a \d+-byte materialized prompt/);
	assert.match(error.message, new RegExp(REVIEW_HOST_RELAY_PI_TIMEOUT_ENV));
	assert.equal(error.mutationOutcome, "none");
});

test("a provider-failed completion stays distinguishable from a timed-out one and still carries its measurements", async (t) => {
	const fixture = harness(t);
	const error = await rejectsWithRelayError(
		runRelay(fixture, { piTimeoutMs: 30_000 }, refusingReviewer(INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED, "Reviewer completion failed for review-reliability: upstream 500")),
		REVIEW_HOST_RELAY_FAILURE.PI_FAILED,
		"pi",
	);
	assert.equal(error.timedOut, false);
	assert.equal(error.timeoutMs, 30_000);
	assert.ok(error.elapsedMs !== null && error.elapsedMs >= 0);
});

test("submission refusal is a typed error whose outcome is unknown pending STATUS", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "refuse" });
	const error = await rejectsWithRelayError(runRelay(fixture), REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit");
	assert.equal(error.mutationOutcome, "unknown");
	assert.match(error.stderr, /capture binding does not match/);
	assert.equal(readLog(fixture.logPath).length, 2);
});

// gentle-pi#522 / #524: Go refuses a reviewer submission at admission with a
// typed [invalid_request] refusal and states that the lens slot was not
// consumed. That is a proven non-mutation, not an unknown outcome, and the
// refusal text is the only thing that tells the host what to change.
function admittingRequest(fixture: RelayHarness): ReviewHostRelayRequest {
	return relayRequest(fixture);
}

test("a reviewer printing garbage is refused at admission as a proven non-mutation carrying Go's refusal", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "admit", RELAY_FAKE_EXPECTED_SUBJECT: `sha256:${"a".repeat(64)}` });
	const error = await rejectsWithRelayError(
		runReviewHostRelaySlot(admittingRequest(fixture), textReviewer("not json at all").runReviewer),
		REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED,
		"submit",
	);
	assert.equal(error.mutationOutcome, "none");
	assert.equal(error.exitCode, 1);
	assert.equal(error.timedOut, false);
	assert.match(error.stderr, /reviewer payload contains no complete JSON object/);
	assert.match(error.stderr, /\[invalid_request\]/);
	assert.match(error.message, /reviewer payload contains no complete JSON object/);
	assert.equal(readLog(fixture.logPath).length, 2, "the refusal must not be retried by the relay");
});

test("a reviewer echoing a different subject is refused at admission as a proven non-mutation carrying Go's continuation", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "admit", RELAY_FAKE_EXPECTED_SUBJECT: `sha256:${"a".repeat(64)}` });
	const wrongSubject = JSON.stringify({ subject_hash: `sha256:${"0".repeat(64)}`, inspection: { status: "completed", paths: [] }, findings: [], evidence: ["x"] });
	const error = await rejectsWithRelayError(
		runReviewHostRelaySlot(admittingRequest(fixture), textReviewer(wrongSubject).runReviewer),
		REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED,
		"submit",
	);
	assert.equal(error.mutationOutcome, "none");
	assert.equal(error.exitCode, 1);
	assert.match(error.stderr, /binding_mismatch/);
	assert.match(error.stderr, /did not consume the lens slot/);
	assert.match(error.stderr, /\[invalid_request\]/);
	assert.match(error.message, /did not consume the lens slot/);
	assert.equal(readLog(fixture.logPath).length, 2, "the refusal must not be retried by the relay");
});

test("a submission the fake admits with the expected subject still completes", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "admit", RELAY_FAKE_EXPECTED_SUBJECT: `sha256:${"a".repeat(64)}` });
	const expected = JSON.stringify({ subject_hash: `sha256:${"a".repeat(64)}`, inspection: { status: "completed", paths: [] }, findings: [], evidence: ["x"] });
	const result = await runReviewHostRelaySlot(admittingRequest(fixture), textReviewer(expected).runReviewer);
	assert.equal(JSON.parse(result.submission).admission_decision, "completed");
});

test("submission refusal preserves its primary evidence when result staging cleanup also fails", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "refuse-cleanup-fail" });
	const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-relay-primary-failure-")));
	const originalTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = scratchParent;
	try {
		const error = await rejectsWithRelayError(
			runRelay(fixture),
			REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED,
			"submit",
		);
		assert.equal(error.exitCode, 1);
		assert.equal(error.timedOut, false);
		assert.equal(error.timeoutMs, 30_000);
		assert.ok(error.elapsedMs !== null && error.elapsedMs >= 0);
		assert.match(error.stderr, /capture binding does not match/);
		assert.doesNotMatch(error.message, /staging cleanup/i);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
		chmodSync(scratchParent, 0o700);
		rmSync(scratchParent, { recursive: true, force: true });
	}
});

test("relay staging directories are removed after a submission failure too", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "refuse" });
	await rejectsWithRelayError(runRelay(fixture), REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit");
	assert.equal(readLog(fixture.logPath).length, 2);
});

test("a result staging cleanup failure remains a typed submit failure", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "cleanup-fail" });
	const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-relay-cleanup-")));
	const originalTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = scratchParent;
	try {
		const error = await rejectsWithRelayError(
			runRelay(fixture),
			REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED,
			"submit",
		);
		assert.equal(error.mutationOutcome, "unknown");
		assert.match(error.message, /staging cleanup/i);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
		chmodSync(scratchParent, 0o700);
		rmSync(scratchParent, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Capability detection — typed refusal classes, no version sniffing.
// ---------------------------------------------------------------------------

test("an old binary's unknown-flag refusal classifies as relay-unavailable with the exact report", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "unknown-flag" });
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const error = await rejectsWithRelayError(runRelay(fixture, {}, runReviewer), REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE, "materialize");
	assert.equal(error.message, REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE);
	assert.match(error.stderr, /flag provided but not defined: -materialize/);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("a handshake refusal surfaces the provider refusal verbatim", async (t) => {
	const refusal = "review capture-result --agent pi: the active runtime is not eligible for immutable receipt review; supported immutable review runtimes: claude-code, codex, opencode";
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "handshake", RELAY_FAKE_HANDSHAKE_STDERR: refusal });
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const error = await rejectsWithRelayError(runRelay(fixture, {}, runReviewer), REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED, "materialize");
	assert.equal(error.message, refusal);
	assert.equal(error.stderr, refusal);
	assert.equal(calls.length, 0);
});

test("refusal classification distinguishes unknown-flag, handshake, and other", () => {
	assert.equal(classifyReviewHostRelayRefusal("flag provided but not defined: -materialize\nUsage:"), "unknown-flag");
	assert.equal(classifyReviewHostRelayRefusal("flag provided but not defined: -agent"), "unknown-flag");
	assert.equal(classifyReviewHostRelayRefusal("the active runtime is not eligible for immutable receipt review"), "handshake");
	assert.equal(classifyReviewHostRelayRefusal("declare GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1"), "handshake");
	assert.equal(classifyReviewHostRelayRefusal("some unrelated explosion"), "other");
});

// gentle-pi#638: only a reviewer killed by the scaled relay bound is proven
// deterministic for this exact slot. Generic admission refusals are repairable
// by a fresh reviewer and retain the ordinary exact-reoffer behavior.
test("the unachievable predicate names only deterministic slot failures", () => {
	const killed = new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "the reviewer completion exceeded the relay bound", { timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	assert.equal(reviewHostRelayUnachievableReason(killed), "relay_transport_bound_exceeded");
	assert.equal(reviewHostRelayUnachievableDetail(killed), "killed after 2256004ms against a 2256000ms relay bound");

	for (const refusal of ["reviewer payload contains no complete JSON object", "reviewer artifact admission binding_mismatch"]) {
		const admitted = new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", `${refusal} [invalid_request]`, { exitCode: 1, mutationOutcome: "none" });
		assert.equal(reviewHostRelayUnachievableReason(admitted), undefined, `${refusal} is repairable by a fresh reviewer`);
		assert.equal(reviewHostRelayUnachievableDetail(admitted), undefined);
	}

	const unknownOutcome = new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", "gentle-ai capture submission exceeded its bound", { timedOut: true });
	assert.equal(reviewHostRelayUnachievableReason(unknownOutcome), undefined, "an unknown mutation outcome is never deterministic");
	assert.equal(reviewHostRelayUnachievableDetail(unknownOutcome), undefined);

	for (const kind of [
		REVIEW_HOST_RELAY_FAILURE.PI_FAILED,
		REVIEW_HOST_RELAY_FAILURE.PI_LAUNCH_FAILED,
		REVIEW_HOST_RELAY_FAILURE.PI_EMPTY_OUTPUT,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_MODEL_NOT_FOUND,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_AUTH_UNAVAILABLE,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_THINKING_INVALID,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_TOOL_CALL,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_EMPTY_OUTPUT,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_OUTPUT_TOO_LARGE,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_ABORTED,
		REVIEW_HOST_RELAY_FAILURE.REVIEWER_CONFIG_INVALID,
		REVIEW_HOST_RELAY_FAILURE.MATERIALIZE_FAILED,
		REVIEW_HOST_RELAY_FAILURE.EMPTY_PROMPT,
		REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE,
		REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED,
		REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH,
	]) {
		assert.equal(reviewHostRelayUnachievableReason(new ReviewHostRelayError(kind, "pi", "transient")), undefined, `${kind} stays transient`);
	}

	const unmeasured = new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "killed at the bound");
	assert.equal(reviewHostRelayUnachievableReason(unmeasured), "relay_transport_bound_exceeded");
	assert.equal(reviewHostRelayUnachievableDetail(unmeasured), undefined, "no measurements means no detail, never a fabricated one");
});

// ---------------------------------------------------------------------------
// Slot detection — the provider decides; nothing is inferred.
// ---------------------------------------------------------------------------

function collectInput(overrides: Partial<{ captureOperation: string; arguments: ReviewCollectInputV3["arguments"]; submission: ReviewCaptureSubmissionV1 | undefined }> = {}): ReviewCollectInputV3 {
	const argumentsList: ReviewCollectInputV3["arguments"] = overrides.arguments ?? [
		{ name: "lineage", value: "review-1d5aadacc600e167", token: "--lineage=review-1d5aadacc600e167" },
		{ name: "expected-revision", value: `sha256:${"c".repeat(64)}`, token: `--expected-revision=sha256:${"c".repeat(64)}` },
		{ name: "target", value: `sha256:${"d".repeat(64)}`, token: `--target=sha256:${"d".repeat(64)}` },
		{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
		{ name: "lens", value: "review-reliability", token: "--lens=review-reliability" },
		{ name: "order", value: "0", token: "--order=0" },
		{ name: "subject-hash", value: `sha256:${"a".repeat(64)}`, token: `--subject-hash=sha256:${"a".repeat(64)}` },
		{ name: "agent", value: "pi", token: "--agent=pi" },
		{ name: "materialize", value: "true", token: "--materialize=true" },
	];
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: overrides.captureOperation ?? "review.capture-result",
		arguments: argumentsList,
		...("submission" in overrides ? (overrides.submission === undefined ? {} : { submission: overrides.submission }) : { submission: SUBMISSION }),
	};
}

test("only provider-issued pi --materialize capture-result inputs become relay slots", () => {
	const slots = reviewHostRelaySlots([collectInput()]);
	assert.equal(slots.length, 1);
	assert.deepEqual(slots[0]!.captureArgumentTokens, [...CAPTURE_TOKENS]);
	// The provider-owned completing form passes through verbatim.
	assert.deepEqual(slots[0]!.submission, SUBMISSION);
	assert.equal(slots[0]!.lens, "review-reliability");
	assert.equal(slots[0]!.order, "0");

	// A materialize slot whose provider omitted the submission still becomes
	// a slot (the provider decided the route); the relay then fails closed.
	const missingSubmission = reviewHostRelaySlots([collectInput({ submission: undefined })]);
	assert.equal(missingSubmission.length, 1);
	assert.equal(missingSubmission[0]!.submission, undefined);

	const withoutMaterialize = collectInput({ arguments: collectInput().arguments.filter((argument) => argument.name !== "materialize") });
	assert.deepEqual(reviewHostRelaySlots([withoutMaterialize]), []);

	const withoutAgent = collectInput({ arguments: collectInput().arguments.filter((argument) => argument.name !== "agent") });
	assert.deepEqual(reviewHostRelaySlots([withoutAgent]), []);

	const foreignAgent = collectInput({ arguments: collectInput().arguments.map((argument) => argument.name === "agent" ? { ...argument, value: "codex", token: "--agent=codex" } : argument) });
	assert.deepEqual(reviewHostRelaySlots([foreignAgent]), []);

	const evidence = collectInput({ captureOperation: "review.capture-evidence" });
	assert.deepEqual(reviewHostRelaySlots([evidence]), []);
});

test("relay input validation rejects empty or malformed inputs before any process launches", async () => {
	await assert.rejects(runReviewHostRelaySlot({ captureArgumentTokens: [], submission: SUBMISSION }), TypeError);
	await assert.rejects(runReviewHostRelaySlot({ captureArgumentTokens: [""], submission: SUBMISSION }), TypeError);
	await assert.rejects(runReviewHostRelaySlot({ captureArgumentTokens: CAPTURE_TOKENS, submission: SUBMISSION, gentleAiExecutable: "gentle-ai" }), TypeError);
});

// ---------------------------------------------------------------------------
// Provider-owned submission form — consumed verbatim, never synthesized.
// ---------------------------------------------------------------------------

test("a materialize slot without a provider submission fails closed before any process launches", async (t) => {
	const fixture = harness(t);
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const error = await rejectsWithRelayError(
		runRelay(fixture, { submission: undefined }, runReviewer),
		REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH,
		"binding",
	);
	assert.equal(error.message, REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE);
	assert.equal(error.mutationOutcome, "none");
	assert.equal(readLog(fixture.logPath).length, 0, "no gentle-ai invocation was launched");
	assert.equal(calls.length, 0, "no completion was run");
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("a submission form the relay cannot bind is a typed contract mismatch, never a repaired invocation", async (t) => {
	const fixture = harness(t);
	const { runReviewer, calls } = textReviewer(REVIEWER_TEXT);
	const twoValues: ReviewCaptureSubmissionV1 = {
		...SUBMISSION,
		values: [...SUBMISSION.values, { slot: "extra", domain: "artifact_path_or_stdin", substitutionLocation: 0 }],
	};
	await rejectsWithRelayError(runRelay(fixture, { submission: twoValues }, runReviewer), REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding");
	const noSlot: ReviewCaptureSubmissionV1 = {
		...SUBMISSION,
		argumentTokens: [...BINDING_TOKENS, "--input=/etc/somewhere"],
	};
	await rejectsWithRelayError(runRelay(fixture, { submission: noSlot }, runReviewer), REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding");
	const outOfBounds: ReviewCaptureSubmissionV1 = {
		...SUBMISSION,
		values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: SUBMISSION.argumentTokens.length }],
	};
	await rejectsWithRelayError(runRelay(fixture, { submission: outOfBounds }, runReviewer), REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH, "binding");
	assert.equal(readLog(fixture.logPath).length, 0);
	assert.equal(calls.length, 0);
});

test("resolveReviewHostRelaySubmission returns the provider binding untouched", () => {
	const binding = resolveReviewHostRelaySubmission(SUBMISSION);
	assert.equal(binding.operationToken, "capture-result");
	assert.deepEqual(binding.argumentTokens, SUBMISSION.argumentTokens);
	assert.equal(binding.substitutionLocation, BINDING_TOKENS.length);
	assert.throws(() => resolveReviewHostRelaySubmission(undefined), (error: unknown) =>
		error instanceof ReviewHostRelayError && error.kind === REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH && error.message === REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE);
});

test("the negotiated decoder carries the provider submission through the capture-result collect input", () => {
	const lineageId = "review-1d5aadacc600e167";
	const sha = `sha256:${"c".repeat(64)}`;
	const tree = "3".repeat(40);
	const rawSubmission = {
		operation_token: "capture-result",
		argument_tokens: [...BINDING_TOKENS, "--input={{value}}"],
		values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitution_location: BINDING_TOKENS.length }],
	};
	const rawInput = {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		capture_operation: "review.capture-result",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "materialize", value: "true", token: "--materialize=true" },
		],
		artifact_subject: {
			schema: "gentle-ai.review-artifact-subject/v2",
			subject_hash: sha,
			lineage_id: lineageId,
			authority_revision: sha,
			target_identity: sha,
			base_tree: tree,
			candidate_tree: tree,
			changed_path_manifest_sha256: sha,
			lens: "review-reliability",
			selected_order: 0,
		},
		base_tree: tree,
		candidate_tree: tree,
		changed_path_manifest: [{ path: "app.ts", status: "M", old_mode: "100644", new_mode: "100644", deleted: false, type_changed: false, mode_only: false, intended_untracked: false }],
		submission: rawSubmission,
	};
	const decoded = decodeReviewNextTransitionV3({ kind: "collect", reason_code: "reviewer_results_required", collect: { inputs: [rawInput] } });
	assert.equal(decoded.collect!.inputs[0]!.submission!.operationToken, "capture-result");
	assert.deepEqual(decoded.collect!.inputs[0]!.submission!.argumentTokens, rawSubmission.argument_tokens);
	assert.deepEqual(decoded.collect!.inputs[0]!.submission!.values, [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: BINDING_TOKENS.length }]);

	// Strict rejections: submission outside capture-result, and a
	// substitution location outside its own argument tokens.
	assert.throws(() => decodeReviewNextTransitionV3({ kind: "collect", reason_code: "verification_evidence_required", collect: { inputs: [{
		name: "verification_evidence",
		schema: "gentle-ai.review-verification-evidence/v2",
		capture_operation: "review.capture-evidence",
		arguments: [{ name: "lineage", value: lineageId }],
		submission: rawSubmission,
	}] } }), /submission is only valid for review\.capture-result/);
	assert.throws(() => decodeReviewNextTransitionV3({ kind: "collect", reason_code: "reviewer_results_required", collect: { inputs: [{
		...rawInput,
		submission: { ...rawSubmission, values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitution_location: rawSubmission.argument_tokens.length }] },
	}] } }), /substitution_location/);
});
