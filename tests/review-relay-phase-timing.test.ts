import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { observeReviewRelayPhase, type ReviewRelayPhaseObserver, type ReviewRelayPhaseTiming } from "../lib/review-relay-phase-timing.ts";
import { runReviewHostRelaySlot, type ReviewHostRelayRequest, ReviewHostRelayError } from "../lib/review-host-relay.ts";
import type { runInProcessReviewer } from "../lib/inprocess-reviewer.ts";

test("disabled observation adds no clock reads and preserves operation settlement", async () => {
	const value = {};
	assert.equal(await observeReviewRelayPhase(undefined, "materialize", async () => value, undefined, () => { throw new Error("must not read clock"); }), value);
});

test("monotonic intervals report only the minimal immutable sample", async () => {
	const samples: ReviewRelayPhaseTiming[] = [], ticks = [12, 39];
	const result = await observeReviewRelayPhase(sample => { samples.push(sample); }, "submit", async () => "private-output", undefined, () => ticks.shift()!);
	assert.equal(result, "private-output");
	assert.deepEqual(samples, [{ phase: "submit", duration_ms: 27, outcome: "success" }]);
	assert.equal(Object.isFrozen(samples[0]), true);
});

test("throwing, rejecting and never-settling observers preserve values and original failures", async t => {
	for (const observer of [() => { throw new Error("observer"); }, () => Promise.reject(new Error("observer")), () => new Promise(() => {})]) {
		await t.test(String(observer), { timeout: 1000 }, async () => {
			const value = {}, failure = new Error("primary");
			assert.equal(await observeReviewRelayPhase(observer, "materialize", async () => value), value);
			await assert.rejects(observeReviewRelayPhase(observer, "cleanup", async () => { throw failure; }), error => error === failure);
			await new Promise(resolve => setImmediate(resolve));
		});
	}
});

test("unavailable or backwards clocks omit samples without changing the operation", async () => {
	for (const ticks of [[NaN, 5], [7, 3], [Infinity, 5]]) {
		const samples: ReviewRelayPhaseTiming[] = [];
		assert.equal(await observeReviewRelayPhase(sample => samples.push(sample), "submit", async () => 42, undefined, () => ticks.shift()!), 42);
		assert.deepEqual(samples, []);
	}
	assert.equal(await observeReviewRelayPhase(() => { throw new Error("not observed"); }, "submit", async () => 42, undefined, () => { throw new Error("clock"); }), 42);
});

function fakeRelay(t: test.TestContext, options: { materializeFail?: boolean; submitFail?: boolean; cleanupFail?: boolean; launchFail?: boolean } = {}) {
	const original = { spawn: childProcess.spawn, mkdtemp: fsPromises.mkdtemp, chmod: fsPromises.chmod, writeFile: fsPromises.writeFile, rm: fsPromises.rm };
	const invocations: string[][] = [];
	let submissions = 0, cleaned = 0, reviewerCalls = 0;
	const bytes: Buffer[] = [];
	childProcess.spawn = ((_file: string, argv: string[]) => {
		invocations.push([...argv]);
		if (options.launchFail) throw new Error("private-launch-message");
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
		queueMicrotask(() => {
			const materialize = argv.includes("--materialize=true");
			if (!materialize) submissions++;
			const failed = materialize ? options.materializeFail : options.submitFail;
			child.stdout.write(failed ? "" : materialize ? "private-prompt" : "private-admission-output");
			if (failed) child.stderr.write("private-provider-refusal [invalid_request]");
			child.emit("close", failed ? 1 : 0);
		});
		return child;
	}) as unknown as typeof childProcess.spawn;
	fsPromises.mkdtemp = (async () => join(process.cwd(), "private-fixture-path")) as unknown as typeof fsPromises.mkdtemp;
	fsPromises.chmod = async () => {};
	fsPromises.writeFile = (async (_path: unknown, data: Buffer) => { bytes.push(Buffer.from(data)); }) as unknown as typeof fsPromises.writeFile;
	fsPromises.rm = async () => { cleaned++; if (options.cleanupFail) throw new Error("private-cleanup-message"); };
	syncBuiltinESMExports();
	t.after(() => { Object.assign(childProcess, { spawn: original.spawn }); Object.assign(fsPromises, { mkdtemp: original.mkdtemp, chmod: original.chmod, writeFile: original.writeFile, rm: original.rm }); syncBuiltinESMExports(); });
	const request: ReviewHostRelayRequest = {
		captureArgumentTokens: ["--materialize=true", "--private-binding=secret"],
		submission: { operationToken: "capture-result", argumentTokens: ["--input={{value}}"], values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: 0 }] },
		gentleAiExecutable: process.execPath,
		targetCwd: process.cwd(),
		reviewerRegistry: {
			find: () => ({ id: "private-model", provider: "private-provider", api: "openai-responses", reasoning: false }) as never,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "private-credential" }),
		},
		selection: "private-provider/private-model",
		environment: { PRIVATE_CREDENTIAL: "private-credential" },
	};
	const runReviewer = (async () => { reviewerCalls++; return { kind: "text", text: "private-reviewer-output", reviewerModel: "private-model" }; }) as typeof runInProcessReviewer;
	return { run: (observePhase?: ReviewRelayPhaseObserver) => runReviewHostRelaySlot({ ...request, ...(observePhase === undefined ? {} : { observePhase }) }, runReviewer), state: () => ({ submissions, cleaned, reviewerCalls, bytes, invocations }) };
}

test("relay reports materialize, submit and cleanup success without exposing payload or binding data", async t => {
	const relay = fakeRelay(t), samples: ReviewRelayPhaseTiming[] = [];
	const result = await relay.run(sample => samples.push(sample));
	assert.deepEqual(result, { promptByteLength: Buffer.byteLength("private-prompt"), resultByteLength: Buffer.byteLength("private-reviewer-output"), submission: "private-admission-output" });
	assert.deepEqual(samples.map(({ phase, outcome }) => ({ phase, outcome })), ["materialize", "submit", "cleanup"].map(phase => ({ phase, outcome: "success" })));
	for (const sample of samples) {
		assert.deepEqual(Object.keys(sample).sort(), ["duration_ms", "outcome", "phase"]);
		assert.ok(Number.isFinite(sample.duration_ms) && sample.duration_ms >= 0);
	}
	assert.doesNotMatch(JSON.stringify(samples), /private|secret|credential|binding|prompt|output/);
	assert.equal(relay.state().submissions, 1);
	assert.deepEqual(relay.state().bytes, [Buffer.from("private-reviewer-output")]);
});

for (const options of [{ materializeFail: true }, { launchFail: true }, { submitFail: true }, { cleanupFail: true }, { submitFail: true, cleanupFail: true }]) {
	test(`relay reports phase failures and keeps original refusal/cleanup precedence: ${JSON.stringify(options)}`, async t => {
		const relay = fakeRelay(t, options), samples: ReviewRelayPhaseTiming[] = [];
		let caught: unknown;
		try { await relay.run(sample => samples.push(sample)); } catch (error) { caught = error; }
		assert.ok(caught instanceof ReviewHostRelayError);
		const materializeFailed = options.materializeFail || options.launchFail;
		assert.equal(caught.stage, materializeFailed ? "materialize" : "submit");
		assert.equal(caught.mutationOutcome, options.submitFail || materializeFailed ? "none" : "unknown");
		assert.deepEqual(samples.map(({ phase, outcome }) => ({ phase, outcome })), materializeFailed
			? [{ phase: "materialize", outcome: "failure" }]
			: [{ phase: "materialize", outcome: "success" }, { phase: "submit", outcome: options.submitFail ? "failure" : "success" }, { phase: "cleanup", outcome: options.cleanupFail ? "failure" : "success" }]);
		assert.equal(relay.state().reviewerCalls, materializeFailed ? 0 : 1);
		assert.equal(relay.state().cleaned, materializeFailed ? 0 : 1);
		if (options.submitFail) assert.match(caught.message, /private-provider-refusal/);
		assert.doesNotMatch(JSON.stringify(samples), /private|secret|credential|binding|prompt|output/);
	});
}

test("relay outcomes and process counts survive broken observers without awaiting promises", { timeout: 2000 }, async t => {
	const relay = fakeRelay(t);
	const expected = await relay.run();
	for (const observer of [() => { throw new Error("observer"); }, () => Promise.reject(new Error("observer")), () => new Promise(() => {})]) assert.deepEqual(await relay.run(observer), expected);
	assert.equal(relay.state().submissions, 4);
	assert.equal(relay.state().invocations.length, 8);
	assert.equal(relay.state().cleaned, 4);
	await new Promise(resolve => setImmediate(resolve));
});
