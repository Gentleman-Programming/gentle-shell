import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { NativeReviewCliV216, NativeReviewIntegrationError, type ExecFileAdapter } from "../lib/native-review-cli.ts";

// odd/tasks/review-one-call.md T11 (S5), L18: contracted STATUS asks for the
// non-blocking findings (gentle-ai#6088) only when the caller requests them; a
// provider that refuses the unknown flag is asked once more without it and is
// not sent the flag again while it stays the same binary.

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "native-nbf-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
let binaries = 0;
/** A package-local executable stand-in; only its path and bytes identify it. */
function binary(content = `fixture-${binaries}`): string {
	const path = join(scratch, `gentle-ai-${binaries++}`);
	writeFileSync(path, content);
	return path;
}

const statusBody = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "status-v5.captured.json"), "utf8"));
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

test("a provider that refuses the unknown flag is asked once more without it and is not sent it again while it is the same binary", async () => {
	const executable = binary();
	const queue = adapter([{ body: UNKNOWN_FLAG, exitCode: 1 }, { body: statusBody }, { body: statusBody }]);
	const cli = new NativeReviewCliV216(queue.adapter, () => executable, 30_000, 1024 * 1024);
	const first = await cli.targetStatus({ ...request, nonBlockingFindings: true });
	assert.equal(first.nextTransition?.kind, "collect", "the run ends as today");
	assert.equal(Object.hasOwn(first, "nonBlockingFindings"), false);
	await cli.targetStatus({ ...request, nonBlockingFindings: true });
	assert.deepEqual(queue.calls.map((call) => call.arguments), [
		[...base, "--non-blocking-findings", "--next-transition"],
		[...base, "--next-transition"],
		[...base, "--next-transition"],
	]);
	// A replaced binary at the same path is a different provider: asked again.
	writeFileSync(executable, "a newer provider");
	const renewed = adapter([{ body: statusBody }]);
	const replaced = new NativeReviewCliV216(renewed.adapter, () => executable, 30_000, 1024 * 1024);
	await replaced.targetStatus({ ...request, nonBlockingFindings: true });
	assert.deepEqual(renewed.calls[0]!.arguments, [...base, "--non-blocking-findings", "--next-transition"]);
});

test("the refusal is remembered per binary: another binary is still sent the flag", async () => {
	const old = binary("old provider");
	const current = binary("current provider");
	let path = old;
	const queue = adapter([{ body: UNKNOWN_FLAG, exitCode: 1 }, { body: statusBody }, { body: statusBody }]);
	const cli = new NativeReviewCliV216(queue.adapter, () => path, 30_000, 1024 * 1024);
	await cli.targetStatus({ ...request, nonBlockingFindings: true });
	path = current;
	await cli.targetStatus({ ...request, nonBlockingFindings: true });
	assert.deepEqual(queue.calls.map((call) => [call.file, call.arguments.includes("--non-blocking-findings")]), [[old, true], [old, false], [current, true]]);
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

// Verifier regressions (odd/tasks/review-one-call.md L19).
test("two concurrent first STATUS calls each pay the refusal once; later calls never resend the flag", async () => {
	const executable = binary("concurrent provider");
	const calls: boolean[] = [];
	const adapterFn: ExecFileAdapter = async (request) => {
		const flagged = request.arguments.includes("--non-blocking-findings");
		calls.push(flagged);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const refused = flagged;
		return { stdout: JSON.stringify(refused ? UNKNOWN_FLAG : statusBody), stderr: refused ? "Error: The negotiated review request is invalid. [invalid_request]\n" : "", exitCode: refused ? 1 : 0, signal: null, timedOut: false, outputLimitExceeded: false };
	};
	const cli = new NativeReviewCliV216(adapterFn, () => executable, 30_000, 1024 * 1024);
	await Promise.all([cli.targetStatus({ ...request, nonBlockingFindings: true }), cli.targetStatus({ ...request, nonBlockingFindings: true })]);
	await cli.targetStatus({ ...request, nonBlockingFindings: true });
	assert.deepEqual(calls, [true, true, false, false, false]);
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

test("an in-flight old refusal does not suppress the flag for a replacement executable", async () => {
	const executable = binary("old in-flight provider");
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const held = new Promise<void>((resolve) => { release = resolve; });
	const queue = adapter([{ body: UNKNOWN_FLAG, exitCode: 1 }, { body: statusBody }, { body: statusBody }]);
	let first = true;
	const cli = new NativeReviewCliV216(async (call) => {
		if (first) { first = false; enter(); await held; }
		return queue.adapter(call);
	}, executable, 30_000, 1024 * 1024);
	const pending = cli.targetStatus({ ...request, nonBlockingFindings: true });
	await entered;
	writeFileSync(executable, "replacement supporting provider");
	release();
	assert.equal((await pending).nextTransition?.kind, "collect");
	assert.equal((await cli.targetStatus({ ...request, nonBlockingFindings: true })).nextTransition?.kind, "collect");
	assert.deepEqual(queue.calls.map((call) => call.arguments), [
		[...base, "--non-blocking-findings", "--next-transition"],
		[...base, "--next-transition"],
		[...base, "--non-blocking-findings", "--next-transition"],
	]);
});

test("unreadable executable identity preserves STATUS refusal fallback without caching", async () => {
	const executable = join(scratch, "absent-executable");
	const queue = adapter([{ body: UNKNOWN_FLAG, exitCode: 1 }, { body: statusBody }, { body: UNKNOWN_FLAG, exitCode: 1 }, { body: statusBody }]);
	const cli = new NativeReviewCliV216(queue.adapter, executable, 30_000, 1024 * 1024);
	for (let call = 0; call < 2; call++) {
		assert.equal((await cli.targetStatus({ ...request, nonBlockingFindings: true })).nextTransition?.kind, "collect");
	}
	assert.deepEqual(queue.calls.map((call) => call.arguments.includes("--non-blocking-findings")), [true, false, true, false]);
});
