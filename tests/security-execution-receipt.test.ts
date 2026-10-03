import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureNodeTestExecution } from "../lib/security-execution-receipt.ts";

function writeTemp(dir: string, name: string, content: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, content, "utf8");
	return file;
}

async function captureAndAssertDenials(opts: Parameters<typeof captureNodeTestExecution>[0]) {
	const r = await captureNodeTestExecution(opts);
	assert.equal(r.verdict.isGreen, false);
	assert.equal(r.verdict.isAssertionRed, false);
	assert.equal(r.verdict.failClosed, true);
	assert.equal(r.verdict.validationState, "unvalidated_capture");
	return r;
}

test("A1: captures pass and genuine assertion non-authoritatively with post SHA256", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a1-p-"));
	try {
		const tf1 = writeTemp(dir, "p.js", `const test = require("node:test"); test("ok", () => {});`);
		const sf = writeTemp(dir, "s.js", "module.exports = 1;");
		const rPass = await captureAndAssertDenials({
			testFile: tf1, testName: "ok", sourceFile: sf,
			callerMetadata: { taskId: "SEC-9A1" },
			candidateCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		});
		assert.equal(rPass.supported, true);
		assert.equal(rPass.callerMetadata.taskId, "SEC-9A1");
		assert.equal(rPass.execution.observedOutcome, "pass");
		assert.match(rPass.provenance.testContentSha256, /^[0-9a-f]{64}$/);
		assert.match(rPass.provenance.postTestContentSha256, /^[0-9a-f]{64}$/);
		assert.match(rPass.provenance.sourceContentSha256 ?? "", /^[0-9a-f]{64}$/);
		assert.match(rPass.provenance.postSourceContentSha256 ?? "", /^[0-9a-f]{64}$/);
		assert.equal(rPass.provenance.claimedCandidateCommit, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
		assert.equal(rPass.provenance.observedRevision, "unavailable");
		assert.equal(rPass.processExit.code, 0);

		const tf2 = writeTemp(dir, "f.js", `const test = require("node:test"); const assert = require("node:assert"); test("fl", () => { assert.strictEqual("a", "b"); });`);
		const rFail = await captureAndAssertDenials({ testFile: tf2, testName: "fl" });
		assert.equal(rFail.execution.observedOutcome, "fail_assertion");
		assert.equal(rFail.execution.assertionFailure?.operator, "strictEqual");
		assert.equal(rFail.execution.assertionFailure?.actual, "a");
		assert.equal(rFail.execution.assertionFailure?.expected, "b");
		assert.equal(rFail.processExit.code, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("A1: raw setup, hook, skip, unmatched observations remain non-authoritative", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a1-s-"));
	try {
		const tf1 = writeTemp(dir, "s.js", `const test = require("node:test"); test("setup-case", () => { throw new Error("bad setup"); });`);
		const r1 = await captureAndAssertDenials({ testFile: tf1, testName: "setup-case" });
		assert.equal(r1.execution.observedOutcome, "fail_setup");

		const tf2 = writeTemp(dir, "h.js", `const test = require("node:test"); test.beforeEach(() => { throw new Error("hook"); }); test("hook-case", () => {});`);
		const r2 = await captureAndAssertDenials({ testFile: tf2, testName: "hook-case" });
		assert.equal(r2.execution.observedOutcome, "fail_setup");
		assert.equal(r2.execution.failureType, "hookFailed");

		const tf3 = writeTemp(dir, "sk.js", `const test = require("node:test"); test("skip-case", { skip: "wip" }, () => {});`);
		const r3 = await captureAndAssertDenials({ testFile: tf3, testName: "skip-case" });
		assert.equal(r3.execution.observedOutcome, "skipped");

		const r4 = await captureAndAssertDenials({ testFile: tf3, testName: "missing-case" });
		assert.equal(r4.execution.observedOutcome, "unmatched");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("A1: nonexecuted cases and invalid configs fail closed with null exit and unavailable post-hashes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a1-ne-"));
	try {
		const tf = writeTemp(dir, "real.test.js", `const test = require("node:test"); test("t", () => {});`);
		const sf = writeTemp(dir, "real.src.js", `module.exports = 1;`);

		const rRunner = await captureAndAssertDenials({ testFile: tf, sourceFile: sf, testName: "t", runner: "jest" });
		assert.equal(rRunner.supported, false);
		assert.equal(rRunner.execution.observedOutcome, "unsupported_runner");
		assert.equal(rRunner.processExit.code, null);
		assert.match(rRunner.provenance.testContentSha256, /^[0-9a-f]{64}$/);
		assert.match(rRunner.provenance.sourceContentSha256 ?? "", /^[0-9a-f]{64}$/);
		assert.equal(rRunner.provenance.postTestContentSha256, "unavailable");
		assert.equal(rRunner.provenance.postSourceContentSha256, "unavailable");

		const ac = new AbortController();
		ac.abort();
		const rAbort = await captureAndAssertDenials({ testFile: tf, sourceFile: sf, testName: "t", signal: ac.signal });
		assert.equal(rAbort.execution.observedOutcome, "aborted");
		assert.equal(rAbort.processExit.code, null);
		assert.match(rAbort.provenance.testContentSha256, /^[0-9a-f]{64}$/);
		assert.equal(rAbort.provenance.postTestContentSha256, "unavailable");
		assert.equal(rAbort.provenance.postSourceContentSha256, "unavailable");

		const rInv1 = await captureAndAssertDenials({ testFile: tf, sourceFile: sf, testName: "t", timeoutMs: -100 });
		assert.equal(rInv1.execution.observedOutcome, "error");
		assert.equal(rInv1.processExit.code, null);
		assert.match(rInv1.provenance.testContentSha256, /^[0-9a-f]{64}$/);
		assert.equal(rInv1.provenance.postTestContentSha256, "unavailable");
		assert.equal(rInv1.provenance.postSourceContentSha256, "unavailable");

		const rInv2 = await captureAndAssertDenials({ testFile: tf, sourceFile: sf, testName: "t", maxBufferBytes: NaN });
		assert.equal(rInv2.execution.observedOutcome, "error");
		assert.equal(rInv2.processExit.code, null);
		assert.match(rInv2.provenance.testContentSha256, /^[0-9a-f]{64}$/);
		assert.equal(rInv2.provenance.postTestContentSha256, "unavailable");
		assert.equal(rInv2.provenance.postSourceContentSha256, "unavailable");

		const rMissing = await captureAndAssertDenials({ testFile: "/no.js", testName: "t", sourceFile: "/no2.js", candidateCommit: "xyz" });
		assert.equal(rMissing.provenance.testContentSha256, "unavailable");
		assert.equal(rMissing.provenance.postTestContentSha256, "unavailable");
		assert.equal(rMissing.provenance.sourceContentSha256, "unavailable");
		assert.equal(rMissing.provenance.postSourceContentSha256, "unavailable");
		assert.equal(rMissing.processExit.code, null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("A1: regression scenarios (global error, drift, spoof, loud buffer, leading hyphen, todo)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a1-reg-"));
	try {
		const tf1 = writeTemp(dir, "ge.js", `const test = require("node:test"); test("ok-target", () => {}); setTimeout(() => { throw new Error("async"); }, 10);`);
		const r1 = await captureAndAssertDenials({ testFile: tf1, testName: "ok-target" });
		assert.equal(r1.execution.observedOutcome, "error");

		const tf2 = writeTemp(dir, "dr.js", `const test = require("node:test"); const fs = require("node:fs"); test("drift", () => { fs.appendFileSync(__filename, "\\n// m"); });`);
		const r2 = await captureAndAssertDenials({ testFile: tf2, testName: "drift" });
		assert.equal(r2.execution.observedOutcome, "error");
		assert.notEqual(r2.provenance.testContentSha256, r2.provenance.postTestContentSha256);

		const tf3 = writeTemp(dir, "sp.js", `const test = require("node:test"); test("sp", () => { const e = new Error("x"); e.name = "AssertionError"; e.operator = "strictEqual"; throw e; });`);
		const r3 = await captureAndAssertDenials({ testFile: tf3, testName: "sp" });
		assert.equal(r3.execution.observedOutcome, "fail_setup");

		const tf4 = writeTemp(dir, "ld.js", `const test = require("node:test"); test("ld", () => { for (let i = 0; i < 3000; i++) console.log("A".repeat(100)); });`);
		const r4 = await captureAndAssertDenials({ testFile: tf4, testName: "ld", maxBufferBytes: 50 * 1024 });
		assert.equal(r4.execution.observedOutcome, "error");
		assert.equal(r4.execution.truncated, true);

		const tf5 = writeTemp(dir, "--hyphen.test.js", `const test = require("node:test"); test("hyphen", () => {});`);
		const r5 = await captureAndAssertDenials({ testFile: tf5, testName: "hyphen" });
		assert.equal(r5.execution.observedOutcome, "pass");
		assert.equal(r5.processExit.code, 0);

		const tf6 = writeTemp(dir, "todo.js", `const test = require("node:test"); test("todo-case", { todo: "wip" }, () => {});`);
		const r6 = await captureAndAssertDenials({ testFile: tf6, testName: "todo-case" });
		assert.equal(r6.execution.observedOutcome, "pass");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
