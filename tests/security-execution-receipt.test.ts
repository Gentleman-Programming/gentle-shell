import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureNodeTestExecution, validateExecutionReceipt } from "../lib/security-execution-receipt.ts";

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
		await assertMinimalEnvironment();
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

async function assertMinimalEnvironment() {
	const originalCanary = process.env.SEC_A1_ENV_CANARY;
	const originalOptions = process.env.NODE_OPTIONS;
	const originalPath = process.env.NODE_PATH;
	process.env.SEC_A1_ENV_CANARY = "synthetic-only";
	process.env.NODE_OPTIONS = "--no-warnings";
	process.env.NODE_PATH = "/synthetic-node-path";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a1-env-"));
	try {
		const tf = writeTemp(dir, "env.js", `const test = require("node:test"); const assert = require("node:assert/strict"); test("env", () => { assert.equal(process.env.SEC_A1_ENV_CANARY, undefined); assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined); });`);
		assert.equal((await captureAndAssertDenials({ testFile: tf, testName: "env" })).execution.observedOutcome, "pass");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		if (originalCanary === undefined) delete process.env.SEC_A1_ENV_CANARY; else process.env.SEC_A1_ENV_CANARY = originalCanary;
		if (originalOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalOptions;
		if (originalPath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = originalPath;
	}
}

async function waitForFile(file: string, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) throw new Error("descendant handshake did not arrive");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function assertDescendantTermination(kind: "abort" | "timeout") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a1-tree-"));
	const handshake = path.join(dir, "grandchild.pid");
	let grandchildPid: number | undefined;
	try {
		const tf = writeTemp(dir, "tree.js", `const test = require("node:test"); const fs = require("node:fs"); const { spawn } = require("node:child_process"); test("tree", async () => { spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(handshake)}, String(process.pid)); setTimeout(() => {}, 2000);`)}], { stdio: "inherit" }); for (let i = 0; i < 100 && !fs.existsSync(${JSON.stringify(handshake)}); i++) await new Promise(resolve => setTimeout(resolve, 10)); });`);
		const ac = new AbortController();
		const pending = captureAndAssertDenials({ testFile: tf, testName: "tree", timeoutMs: kind === "timeout" ? 800 : 1500, ...(kind === "abort" && { signal: ac.signal }) });
		await waitForFile(handshake);
		grandchildPid = Number(fs.readFileSync(handshake, "utf8"));
		if (kind === "abort") ac.abort();
		const r = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close remained blocked by descendant")), 800))]);
		assert.equal(r.execution.observedOutcome, kind === "abort" ? "aborted" : "timeout");
	} finally {
		if (grandchildPid && Number.isSafeInteger(grandchildPid)) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} }
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

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
		await assertDescendantTermination("abort");
		await assertDescendantTermination("timeout");
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

const SHA = "a".repeat(64);
const TS = new Date().toISOString();
const UUID = "00000000-0000-4000-8000-000000000000";
const ABS = "/abs/path/test.js";

function baseGreen(): Record<string, unknown> {
	return {
		id: UUID, timestamp: TS, runner: "node:test", supported: true,
		callerMetadata: {}, targetedTest: { file: ABS, testName: "t" },
		provenance: { testContentSha256: SHA, postTestContentSha256: SHA, observedRevision: "unavailable" },
		processExit: { code: 0, signal: null },
		execution: { observedOutcome: "pass", eventsObserved: 1, truncated: false },
		verdict: { isAssertionRed: false, isGreen: false, failClosed: true, validationState: "unvalidated_capture" },
	};
}

function baseRed(): Record<string, unknown> {
	return {
		id: UUID, timestamp: TS, runner: "node:test", supported: true,
		callerMetadata: {}, targetedTest: { file: ABS, testName: "t" },
		provenance: { testContentSha256: SHA, postTestContentSha256: SHA, observedRevision: "unavailable" },
		processExit: { code: 1, signal: null },
		execution: {
			observedOutcome: "fail_assertion", eventsObserved: 1, truncated: false,
			failureType: "testCodeFailure",
			assertionFailure: { code: "ERR_ASSERTION", operator: "strictEqual", actual: "a", expected: "b" },
		},
		verdict: { isAssertionRed: false, isGreen: false, failClosed: true, validationState: "unvalidated_capture" },
	};
}

function invalid(r: unknown, label: string) {
	const v = validateExecutionReceipt(r);
	assert.equal(v.isValid, false, `${label}: isValid`);
	assert.equal(v.isGreen, false, `${label}: isGreen`);
	assert.equal(v.isAssertionRed, false, `${label}: isAssertionRed`);
	assert.equal(v.failClosed, true, `${label}: failClosed`);
	assert.equal(v.validationState, "invalid", `${label}: validationState`);
	assert.ok(typeof v.failureReason === "string" && v.failureReason.length > 0, `${label}: failureReason`);
}

test("A2: strict validation of execution receipts - valid green and red, fail-closed rejections", () => {
	// Valid GREEN
	const g = validateExecutionReceipt(baseGreen());
	assert.equal(g.isValid, true, "green isValid");
	assert.equal(g.isGreen, true, "green isGreen");
	assert.equal(g.isAssertionRed, false, "green isAssertionRed");
	assert.equal(g.failClosed, false, "green failClosed");
	assert.equal(g.validationState, "valid_green", "green validationState");
	assert.equal(g.failureReason, undefined, "green failureReason");

	// Valid GREEN with sourceFile hashes
	const gSrc = validateExecutionReceipt({ ...baseGreen(), provenance: { ...baseGreen().provenance as object, sourceContentSha256: SHA, postSourceContentSha256: SHA } });
	assert.equal(gSrc.isValid, true, "green+src isValid");
	assert.equal(gSrc.validationState, "valid_green", "green+src validationState");

	// Valid RED
	const red = validateExecutionReceipt(baseRed());
	assert.equal(red.isValid, true, "red isValid");
	assert.equal(red.isGreen, false, "red isGreen");
	assert.equal(red.isAssertionRed, true, "red isAssertionRed");
	assert.equal(red.failClosed, false, "red failClosed");
	assert.equal(red.validationState, "valid_red", "red validationState");
	assert.equal(red.failureReason, undefined, "red failureReason");

	// --- Fail-closed rejections ---
	// Malformed / unsupported
	invalid(null, "null");
	invalid(undefined, "undefined");
	invalid(42, "non-object");
	invalid({ ...baseGreen(), supported: false }, "supported=false");
	invalid({ ...baseGreen(), runner: "jest" }, "wrong runner");
	invalid({ ...baseGreen(), id: "not-a-uuid" }, "bad id");
	invalid({ ...baseGreen(), id: undefined }, "missing id");
	invalid({ ...baseGreen(), timestamp: "not-a-date" }, "bad timestamp");
	invalid({ ...baseGreen(), timestamp: undefined }, "missing timestamp");

	// Missing / non-absolute test file, empty testName
	invalid({ ...baseGreen(), targetedTest: { file: "relative/path.js", testName: "t" } }, "relative file");
	invalid({ ...baseGreen(), targetedTest: { file: ABS, testName: "" } }, "empty testName");
	invalid({ ...baseGreen(), targetedTest: undefined }, "missing targetedTest");

	// Hash instability / drift
	invalid({ ...baseGreen(), provenance: { testContentSha256: SHA, postTestContentSha256: "b".repeat(64), observedRevision: "unavailable" } }, "pre/post test sha mismatch");
	invalid({ ...baseGreen(), provenance: { testContentSha256: "unavailable", postTestContentSha256: "unavailable", observedRevision: "unavailable" } }, "test sha unavailable");
	invalid({ ...baseGreen(), provenance: { testContentSha256: SHA, postTestContentSha256: SHA, sourceContentSha256: SHA, postSourceContentSha256: "b".repeat(64), observedRevision: "unavailable" } }, "src sha mismatch");
	invalid({ ...baseGreen(), provenance: { testContentSha256: SHA, postTestContentSha256: SHA, sourceContentSha256: "unavailable", postSourceContentSha256: "unavailable", observedRevision: "unavailable" } }, "src sha unavailable");

	// SHA format invalid
	invalid({ ...baseGreen(), provenance: { testContentSha256: "zz", postTestContentSha256: "zz", observedRevision: "unavailable" } }, "sha bad format");

	// Truncated capture
	invalid({ ...baseGreen(), execution: { ...baseGreen().execution as object, truncated: true } }, "truncated");

	// Zero events
	invalid({ ...baseGreen(), execution: { ...baseGreen().execution as object, eventsObserved: 0 } }, "zero events");
	invalid({ ...baseGreen(), execution: { ...baseGreen().execution as object, eventsObserved: -1 } }, "negative events");

	// Process exit anomalies
	invalid({ ...baseGreen(), processExit: { code: null, signal: null } }, "exitCode null GREEN");
	invalid({ ...baseGreen(), processExit: { code: 0, signal: "SIGKILL" } }, "signal SIGKILL GREEN");
	invalid({ ...baseGreen(), processExit: { code: 1, signal: null } }, "GREEN exitCode!=0");
	invalid({ ...baseRed(), processExit: { code: 0, signal: null } }, "RED exitCode==0");
	invalid({ ...baseRed(), processExit: { code: null, signal: null } }, "RED exitCode null");
	invalid({ ...baseRed(), processExit: { code: 1, signal: "SIGTERM" } }, "signal SIGTERM RED");

	// Rejected observedOutcomes
	for (const outcome of ["skipped", "unmatched", "timeout", "aborted", "fail_setup", "error"]) {
		invalid({ ...baseGreen(), execution: { ...baseGreen().execution as object, observedOutcome: outcome } }, `outcome=${outcome}`);
	}

	// RED missing/wrong assertionFailure or failureType
	invalid({ ...baseRed(), execution: { ...(baseRed().execution as Record<string, unknown>), assertionFailure: undefined } }, "RED no assertionFailure");
	invalid({ ...baseRed(), execution: { ...(baseRed().execution as Record<string, unknown>), assertionFailure: { code: "ERR_OTHER" } } }, "RED wrong code");
	invalid({ ...baseRed(), execution: { ...(baseRed().execution as Record<string, unknown>), failureType: "hookFailed" } }, "RED wrong failureType");
	invalid({ ...baseRed(), execution: { ...(baseRed().execution as Record<string, unknown>), failureType: undefined } }, "RED missing failureType");
});
