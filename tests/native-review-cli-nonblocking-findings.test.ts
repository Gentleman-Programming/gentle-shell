import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { NativeReviewCliV216, NativeReviewIntegrationError, type ExecFileAdapter } from "../lib/native-review-cli.ts";
import { statusV9 } from "./support/status-v9.ts";

// odd/tasks/review-one-call.md T11 (S5), L18: contracted STATUS asks for the
// non-blocking findings (gentle-ai#6088) only when the caller requests them.
// gentle-ai v4.6.0 (the minimum supported binary) always understands the flag,
// so a refusal of it is an ordinary failure and is never retried without it.

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "native-nbf-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
let binaries = 0;
/** A package-local executable stand-in; only its path and bytes identify it. */
function binary(content = `fixture-${binaries}`): string {
	const path = join(scratch, `gentle-ai-${binaries++}`);
	writeFileSync(path, content);
	return path;
}

const statusBody = statusV9(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "status-v5.captured.json"), "utf8")));
const refusal = (cause: string) => ({
	schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2", operation: "review.status", phase: "preflight",
	code: "invalid_request", message: "The negotiated review request is invalid.", mutation_outcome: "not_started", authority_applicability: "not_evaluated",
	retry_safe: true, replayability: "not_replayable", required_inputs: [], next_action: "correct_request", cause,
});
const UNKNOWN_FLAG = refusal("flag provided but not defined: -non-blocking-findings");
type Reply = { body: unknown; exitCode?: number };
function adapter(replies: Reply[]): { adapter: ExecFileAdapter; calls: { file: string; arguments: readonly string[] }[] } {
	const calls: { file: string; arguments: readonly string[] }[] = [];
	return { calls, adapter: async (request) => {
		calls.push({ file: request.file, arguments: request.arguments });
		const reply = replies.shift();
		if (reply === undefined) throw new Error("unexpected native invocation");
		const exitCode = reply.exitCode ?? 0;
		return { stdout: JSON.stringify(reply.body), stderr: exitCode === 0 ? "" : "Error: The negotiated review request is invalid. [invalid_request]\n", exitCode, signal: null, timedOut: false, outputLimitExceeded: false };
	} };
}
const base = ["review", "status", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo", "--projection", "workspace", "--lineage", "review-status-fixture", "--agent", "pi"];
const request = { cwd: "/repo", lineageId: "review-status-fixture", agent: "pi" as const };

test("a contracted STATUS sends --non-blocking-findings only when the caller asks for it", async () => {
	const queue = adapter([{ body: statusBody }, { body: statusBody }]);
	const cli = new NativeReviewCliV216(queue.adapter, binary(), 30_000, 1024 * 1024);
	await cli.targetStatus({ ...request, nonBlockingFindings: true });
	await cli.targetStatus(request);
	assert.deepEqual(queue.calls.map((call) => call.arguments), [[...base, "--non-blocking-findings", "--next-transition"], [...base, "--next-transition"]]);
});

test("the unknown-flag refusal is no longer retried without the flag: it surfaces unchanged", async () => {
	const executable = binary();
	const queue = adapter([{ body: UNKNOWN_FLAG, exitCode: 1 }]);
	const cli = new NativeReviewCliV216(queue.adapter, () => executable, 30_000, 1024 * 1024);
	await assert.rejects(cli.targetStatus({ ...request, nonBlockingFindings: true }), (error: unknown) => error instanceof NativeReviewIntegrationError && error.failureEnvelope.cause === UNKNOWN_FLAG.cause);
	assert.equal(queue.calls.length, 1);
});

test("any other STATUS failure is not retried and keeps its error", async () => {
	for (const body of [refusal("flag provided but not defined: -lenses"), refusal("--non-blocking-findings requires --contract gentle-ai.review-integration/v2"), { ...UNKNOWN_FLAG, code: "authority_unavailable" }]) {
		const queue = adapter([{ body, exitCode: 1 }]);
		const cli = new NativeReviewCliV216(queue.adapter, binary(), 30_000, 1024 * 1024);
		await assert.rejects(cli.targetStatus({ ...request, nonBlockingFindings: true }), (error: unknown) => error instanceof NativeReviewIntegrationError && error.failureEnvelope.cause === body.cause);
		assert.equal(queue.calls.length, 1, String(body.cause));
	}
});

test("the flag rides only Gentle Shell's own contracted STATUS, never a provider-issued selection submission", async () => {
	const queue = adapter([{ body: statusBody }]);
	const cli = new NativeReviewCliV216(queue.adapter, binary(), 30_000, 1024 * 1024);
	await cli.targetStatus({ cwd: "/repo", nonBlockingFindings: true, intendedUntrackedSelection: {
		argumentTokens: ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", "--intended-untracked-selection={{value}}"], value: "{}" } } as never);
	assert.equal(queue.calls[0]!.arguments.includes("--non-blocking-findings"), false);
});

test("look-alike refusals are not retried", async () => {
	for (const body of [
		refusal("x flag provided but not defined: -non-blocking-findings"),
		refusal("flag provided but not defined: -non-blocking-findings-v2"),
		{ ...UNKNOWN_FLAG, mutation_outcome: "unknown" },
	]) {
		const queue = adapter([{ body, exitCode: 1 }]);
		const cli = new NativeReviewCliV216(queue.adapter, binary(), 30_000, 1024 * 1024);
		await assert.rejects(cli.targetStatus({ ...request, nonBlockingFindings: true }));
		assert.equal(queue.calls.length, 1, JSON.stringify(body).slice(0, 200));
	}
});

