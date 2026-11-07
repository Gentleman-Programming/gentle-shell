import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { runInProcessReviewer, type InProcessReviewerDeps, type InProcessReviewerOutcome } from "../lib/inprocess-reviewer.ts";
import { prepareReviewHostRelaySlot, submitReviewHostRelayPreparedResult, ReviewHostRelayError, REVIEW_HOST_RELAY_FAILURE, type ReviewHostRelayRequest } from "../lib/review-host-relay.ts";

const model = { id: "fixture-model", provider: "fixture", api: "openai-completions", baseUrl: "https://PRIVATE.invalid", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 1000, maxTokens: 100 };
const raw = '{"findings":[],"evidence":["fixture"]}\n';
const request = { selection: "fixture/fixture-model", prompt: Buffer.from("PRIVATE PROMPT"), timeoutMs: 30_000, routingKey: "review-risk" };
const assistant = (overrides: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text: raw }], api: "openai-completions", provider: "fixture", model: "fixture-model", stopReason: "stop", timestamp: 0,
	usage: { input: 12, output: 3, cacheRead: 2, totalTokens: 17, private: "PRIVATE USAGE", cost: { input: 0.12, output: 0.03, total: 0.15, totalFromProvider: false, private: "PRIVATE COST" } }, ...overrides });
const deps = (overrides: Record<string, unknown> = {}): InProcessReviewerDeps => ({
	registry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "PRIVATE KEY", headers: { private: "PRIVATE HEADER" }, env: { private: "PRIVATE ENV" } }) },
	complete: async () => assistant(), ...overrides,
} as unknown as InProcessReviewerDeps);
/** Require host evidence without narrowing away refused reviewer outcomes. */
function evidence(outcome: InProcessReviewerOutcome): Record<string, any> {
	const value = (outcome as { evidence?: Record<string, unknown> }).evidence;
	assert.ok(value, "a resolved reviewer run must carry host evidence");
	return value;
}
/** Check available phase measurements while preserving unknown completion time. */
function timings(value: Record<string, any>, completion: boolean) {
	assert.equal(typeof value.durationMs, "number"); assert.ok(value.durationMs >= 0);
	assert.equal(typeof value.authDurationMs, "number"); assert.ok(value.authDurationMs >= 0);
	assert.equal(typeof value.completionDurationMs, completion ? "number" : "undefined");
}

test("reviewer success carries allowlisted reported usage/cost and effective identity without private payloads", async () => {
	const outcome = await runInProcessReviewer(request, deps());
	assert.equal(outcome.kind, "text");
	const value = evidence(outcome);
	assert.equal(value.reviewerModel, "fixture/fixture-model"); assert.equal(value.provider, "fixture"); assert.equal(value.phase, "completion");
	assert.deepEqual(value.usage, { input: 12, output: 3, cacheRead: 2, totalTokens: 17 });
	assert.deepEqual(value.cost, { input: 0.12, output: 0.03, total: 0.15, totalFromProvider: false });
	timings(value, true);
	assert.doesNotMatch(JSON.stringify(value), /PRIVATE|baseUrl|apiKey|headers|signature|prompt|findings|private/);
});

test("reviewer evidence leaves unavailable usage and cost unknown instead of manufacturing zeros", async () => {
	const value = evidence(await runInProcessReviewer(request, deps({ complete: async () => assistant({ usage: undefined }) })));
	assert.equal(Object.hasOwn(value, "usage"), false); assert.equal(Object.hasOwn(value, "cost"), false);
	const partial = evidence(await runInProcessReviewer(request, deps({ complete: async () => assistant({ usage: { input: 0, output: -1, cacheRead: Infinity, totalTokens: "4", cost: { total: NaN, input: -1, private: "PRIVATE" } } }) })));
	assert.deepEqual(partial.usage, { input: 0 }); assert.equal(Object.hasOwn(partial, "cost"), false);
});

test("reviewer refusals preserve available completion usage without promoting private error text to evidence", async () => {
	for (const response of [assistant({ stopReason: "error", errorMessage: "PRIVATE PROVIDER ERROR" }), assistant({ content: [], stopReason: "length" }), assistant({ content: [{ type: "toolCall", name: "PRIVATE TOOL", arguments: { private: "PRIVATE ARG" } }], stopReason: "toolUse" })]) {
		const outcome = await runInProcessReviewer(request, deps({ complete: async () => response }));
		assert.equal(outcome.kind, "refused");
		const value = evidence(outcome); assert.equal(value.phase, "completion"); assert.equal(value.usage.output, 3); assert.equal(value.cost.total, 0.15);
		assert.doesNotMatch(JSON.stringify(value), /PRIVATE|errorMessage|arguments/);
	}
});

test("auth failure and non-cooperative auth timeout carry auth phase without fabricated completion usage", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const never of [false, true]) {
		let entered!: () => void;
		const began = new Promise<void>(resolve => { entered = resolve; });
		const getApiKeyAndHeaders = async () => { entered(); return never ? await new Promise(() => {}) : { ok: false, error: "fixture auth unavailable" }; };
		const pending = runInProcessReviewer(request, deps({ registry: { find: () => model, getApiKeyAndHeaders }, complete: async () => { throw new Error("must not dispatch"); } }));
		await began;
		if (never) t.mock.timers.tick(request.timeoutMs);
		const outcome = await pending;
		assert.equal(outcome.kind, "refused"); const value = evidence(outcome);
		assert.equal(value.phase, "auth"); timings(value, false);
		assert.equal(Object.hasOwn(value, "usage"), false); assert.equal(Object.hasOwn(value, "cost"), false);
	}
});

test("timeout and abort snapshots keep each phase within the total duration", async t => {
	for (const phase of ["auth", "completion"] as const) for (const stop of ["timeout", "abort"] as const) {
		await t.test(`${phase} ${stop}`, async child => {
			child.mock.timers.enable({ apis: ["setTimeout"] });
			let advancing = false, clock = 0, entered!: () => void;
			child.mock.method(performance, "now", () => advancing ? clock++ : 0);
			const started = new Promise<void>(resolve => { entered = resolve; });
			const hold = async () => { entered(); return await new Promise<never>(() => {}); };
			const controller = new AbortController();
			const pending = runInProcessReviewer({ ...request, timeoutMs: 1000, signal: controller.signal }, deps({
				registry: { find: () => model, getApiKeyAndHeaders: phase === "auth" ? hold : async () => ({ ok: true, apiKey: "fixture" }) },
				complete: phase === "completion" ? hold : async () => assistant(),
			}));
			await started;
			advancing = true; clock = stop === "timeout" ? 1000 : 100;
			if (stop === "timeout") child.mock.timers.tick(1000); else controller.abort();
			const outcome = await pending;
			assert.equal(outcome.kind, "refused");
			if (outcome.kind === "refused") assert.equal(outcome.code, stop === "timeout" ? "timed-out" : "aborted");
			const value = evidence(outcome);
			assert.equal(value.phase, phase);
			for (const key of ["authDurationMs", "completionDurationMs"]) if (typeof value[key] === "number") {
				assert.ok(value.durationMs >= value[key], `${key} must fit within durationMs`);
			}
		});
	}
});

test("evidence observers cannot mutate returned facts, change classification, throw or delay settlement", async () => {
	let observed: unknown;
	const outcome = await runInProcessReviewer(request, deps({ onEvidence: (value: Record<string, any>) => { observed = value; value.usage.input = 999; throw new Error("PRIVATE OBSERVER ERROR"); } }));
	assert.ok(observed); assert.equal(outcome.kind, "text"); assert.equal(evidence(outcome).usage.input, 12);
	const thrown = new Error("PRIVATE AUTH ERROR"); let failureEvidence: Record<string, any> | undefined;
	await assert.rejects(runInProcessReviewer(request, deps({ registry: { find: () => model, getApiKeyAndHeaders: async () => { throw thrown; } }, onEvidence: async (value: Record<string, any>) => { failureEvidence = value; throw new Error("PRIVATE ASYNC OBSERVER ERROR"); } })), error => error === thrown);
	await nextTurn(); assert.equal(failureEvidence?.phase, "auth"); assert.doesNotMatch(JSON.stringify(failureEvidence), /PRIVATE/);
	const controller = new AbortController(); controller.abort();
	const cancelled = await runInProcessReviewer({ ...request, signal: controller.signal }, deps({ onEvidence: async () => await new Promise(() => {}) }));
	assert.equal(cancelled.kind, "refused"); if (cancelled.kind === "refused") assert.equal(cancelled.code, "aborted");
});

test("late completion cannot publish usage or notify observers after cancellation settled the run", async () => {
	let release!: (value: unknown) => void, entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const completion = new Promise(resolve => { release = resolve; });
	const controller = new AbortController(), observed: Record<string, unknown>[] = [];
	const pending = runInProcessReviewer({ ...request, signal: controller.signal }, deps({
		complete: async () => { entered(); return await completion; }, onEvidence: value => { observed.push(value); },
	}));
	await started; controller.abort();
	const outcome = await pending;
	assert.equal(outcome.kind, "refused"); if (outcome.kind === "refused") assert.equal(outcome.code, "aborted");
	const before = structuredClone(evidence(outcome)); assert.equal(before.phase, "completion");
	assert.equal(Object.hasOwn(before, "usage"), false); assert.equal(observed.length, 1);
	release(assistant()); await nextTurn();
	assert.deepEqual(evidence(outcome), before); assert.equal(observed.length, 1);
});

test("malformed diagnostic getters cannot invalidate an otherwise usable completion", async () => {
	const usage = { input: 4 };
	Object.defineProperty(usage, "cost", { get() { throw new Error("PRIVATE DIAGNOSTIC GETTER"); } });
	const outcome = await runInProcessReviewer(request, deps({ complete: async () => assistant({ usage }) }));
	assert.equal(outcome.kind, "text"); if (outcome.kind === "text") assert.equal(outcome.text, raw);
	assert.equal(evidence(outcome).phase, "completion");
	assert.doesNotMatch(JSON.stringify(evidence(outcome)), /PRIVATE/);
});

/** Build a disposable Node-backed native transport fixture with no model calls. */
function relayFixture(t: test.TestContext, rejectSubmission = false): ReviewHostRelayRequest {
	const cwd = mkdtempSync(join(tmpdir(), "reviewer-evidence-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	// Portable executable fixture: node runs cwd/review. No shebang, fake pi,
	// native state, real model, credentials or network are involved.
	writeFileSync(join(cwd, "review"), `const fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--materialize=true'))process.stdout.write('PRIVATE FROZEN PROMPT');else{const input=args.find(v=>v.startsWith('--input=')).slice(8);fs.writeFileSync('submitted.raw',fs.readFileSync(input));${rejectSubmission ? "process.stderr.write('fixture refused [invalid_request]');process.exitCode=1;" : "process.stdout.write('{\"admission_decision\":\"completed\"}');"}}`);
	return { captureArgumentTokens: ["--agent=pi", "--materialize=true"], submission: { operationToken: "capture-result", argumentTokens: ["--input={{value}}"], values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: 0 }] },
		gentleAiExecutable: process.execPath, targetCwd: cwd, reviewerRegistry: deps().registry,
		selection: request.selection, routingKey: request.routingKey, environment: { ...process.env }, gentleAiTimeoutMs: 5_000, piTimeoutMs: 30_000 };
}

test("relay preserves reviewer evidence through prepare and submission without altering native artifact bytes", async t => {
	const fixture = relayFixture(t);
	let completionEvidence: Record<string, any> | undefined;
	const prepared = await prepareReviewHostRelaySlot(fixture, async (req, dependencies) => {
		const outcome = await runInProcessReviewer(req, { ...dependencies, complete: deps().complete });
		completionEvidence = evidence(outcome); return outcome;
	});
	assert.equal((prepared as any).reviewerEvidence?.phase, "completion");
	assert.equal((prepared as any).reviewerEvidence?.usage.totalTokens, 17);
	completionEvidence!.usage.totalTokens = 999;
	assert.equal((prepared as any).reviewerEvidence?.usage.totalTokens, 17, "prepare snapshots host facts independently of the completion outcome");
	const result = await submitReviewHostRelayPreparedResult(prepared);
	assert.deepEqual((result as any).reviewerEvidence, (prepared as any).reviewerEvidence);
	assert.equal(readFileSync(join(fixture.targetCwd!, "submitted.raw"), "utf8"), raw);
	assert.equal(result.submission, '{"admission_decision":"completed"}');
	assert.doesNotMatch(JSON.stringify((result as any).reviewerEvidence), /PRIVATE|headers|apiKey|prompt|submission|findings/);
});

test("relay auth throw and admission refusal retain host evidence while preserving failure classification", async t => {
	const fixture = relayFixture(t);
	await assert.rejects(prepareReviewHostRelaySlot(fixture, (req, dependencies) => runInProcessReviewer(req, { ...dependencies, registry: { find: () => model as never, getApiKeyAndHeaders: async () => { throw new Error("fixture auth throw"); } } })), error => {
		assert.ok(error instanceof ReviewHostRelayError); assert.equal(error.kind, REVIEW_HOST_RELAY_FAILURE.PI_FAILED); assert.equal(error.stage, "pi"); assert.equal(error.mutationOutcome, "none");
		assert.equal(error.reviewerEvidence?.phase, "auth"); return true;
	});
	const rejectedFixture = relayFixture(t, true);
	const prepared = await prepareReviewHostRelaySlot(rejectedFixture, (req, dependencies) => runInProcessReviewer(req, { ...dependencies, complete: deps().complete }));
	await assert.rejects(submitReviewHostRelayPreparedResult(prepared), error => {
		assert.ok(error instanceof ReviewHostRelayError); assert.equal(error.kind, REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED); assert.equal(error.stage, "submit"); assert.equal(error.mutationOutcome, "none");
		assert.equal(error.reviewerEvidence?.phase, "completion"); assert.equal((error.reviewerEvidence?.cost as any)?.total, 0.15); return true;
	});
});
