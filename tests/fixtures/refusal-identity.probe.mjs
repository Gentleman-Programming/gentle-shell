// Independent T3 correction probes: S1/S3; public API only.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.env.PROBE_ROOT ?? process.cwd());
const entry = process.env.PROBE_FLAVOR === "typescript" ? "lib/native-review-cli.ts" : "runtime/native-review-cli.mjs";
const { NativeReviewCliV216, NativeReviewIntegrationError, NativeReviewCliError, createNodeExecFileAdapter } = await import(pathToFileURL(join(root, entry)).href);
const status = JSON.parse(readFileSync(join(root, "tests/fixtures/devbinary/status-v5.captured.json"), "utf8"));
const FLAG = "--non-blocking-findings";
const refusal = { schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2", operation: "review.status", phase: "preflight", code: "invalid_request", message: "The negotiated review request is invalid.", mutation_outcome: "not_started", authority_applicability: "not_evaluated", retry_safe: true, replayability: "not_replayable", required_inputs: [], next_action: "correct_request", cause: "flag provided but not defined: -non-blocking-findings" };
const result = (body = status, exitCode = 0, extra = {}) => ({ stdout: JSON.stringify(body), stderr: "", exitCode, signal: null, timedOut: false, outputLimitExceeded: false, ...extra });
const hash = p => createHash("sha256").update(readFileSync(p)).digest("hex");
function gate() { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; }
function setup(handler, absent = false) {
  const dir = mkdtempSync(join(tmpdir(), "identity-")), exe = join(dir, "provider");
  if (!absent) writeFileSync(exe, "#!/bin/sh\n# identity A\nexit 0\n", { mode: 0o700 });
  const state = join(dir, "authority.json"); writeFileSync(state, '{"authority":"unchanged"}\n');
  const original = hash(state), calls = [];
  const adapter = async call => { calls.push(call); return handler(call, calls.length); };
  const cli = new NativeReviewCliV216(adapter, () => exe, 5000, 1024 * 1024);
  const request = { cwd: dir, agent: "pi", nonBlockingFindings: true };
  return { dir, exe, cli, adapter, calls, request, flags: () => calls.map(c => c.arguments.includes(FLAG)), invariant: () => assert.equal(hash(state), original) };
}
const success = async (cli, request) => assert.equal((await cli.targetStatus(request)).nextTransition.kind, "collect");

test("S1/S3 old in-flight refusal must not suppress replacement", async () => {
  const entered = gate(), held = gate();
  const f = setup(async (_, n) => { if (n === 1) { entered.release(); await held.promise; return result(refusal, 1); } return result(); });
  const pending = f.cli.targetStatus(f.request); await entered.promise;
  writeFileSync(f.exe, "#!/bin/sh\n# supporting B\nexit 0\n"); held.release();
  await pending; await success(f.cli, f.request); f.invariant();
  assert.deepEqual(f.flags(), [true, false, true]);
});

for (const mode of ["mismatch", "missing"]) test(`S1/S3 old refusal cannot ${mode === "mismatch" ? "overwrite" : "delete"} newer valid refusal`, async () => {
  const entered = gate(), held = gate();
  const f = setup(async (call, n) => { if (n === 1) { entered.release(); await held.promise; return result(refusal, 1); } return call.arguments.includes(FLAG) ? result(refusal, 1) : result(); });
  const old = f.cli.targetStatus(f.request); await entered.promise;
  const newer = "#!/bin/sh\n# refusing B\nexit 0\n"; writeFileSync(f.exe, newer);
  await success(f.cli, f.request); // B's response overtakes A, caching only B.
  if (mode === "mismatch") writeFileSync(f.exe, "#!/bin/sh\n# third identity C\nexit 0\n");
  else renameSync(f.exe, join(f.dir, "parked"));
  held.release(); await old;
  if (mode === "mismatch") writeFileSync(f.exe, newer);
  else renameSync(join(f.dir, "parked"), f.exe);
  await success(new NativeReviewCliV216(f.adapter, f.exe), f.request); f.invariant();
  assert.deepEqual(f.flags(), [true, true, false, false, false]);
});

test("S1/S3 unreadable pre-invocation identity cannot cache a subsequently appearing executable", async () => {
  const entered = gate(), held = gate();
  const f = setup(async (_, n) => { if (n === 1) { entered.release(); await held.promise; return result(refusal, 1); } return result(); }, true);
  const pending = f.cli.targetStatus(f.request); await entered.promise;
  writeFileSync(f.exe, "#!/bin/sh\n# now present\nexit 0\n", {mode: 0o700}); held.release();
  await pending; await success(f.cli, f.request); f.invariant();
  assert.deepEqual(f.flags(), [true, false, true]);
});

test("S1/S3 unchanged executable pays one fallback, then cached omission across clients", async () => {
  const f = setup(async call => call.arguments.includes(FLAG) ? result(refusal, 1) : result());
  const before = hash(f.exe);
  await success(f.cli, f.request); await success(new NativeReviewCliV216(f.adapter, f.exe), f.request);
  await success(f.cli, {cwd: f.dir});
  assert.deepEqual(f.flags(), [true, false, false, false]); assert.equal(hash(f.exe), before); f.invariant();
  assert.deepEqual(f.calls[0].arguments, ["review", "status", "--contract", "gentle-ai.review-integration/v2", "--cwd", f.dir, "--projection", "workspace", "--agent", "pi", FLAG, "--next-transition"]);
  assert.deepEqual(f.calls[1].arguments, f.calls[0].arguments.filter(t => t !== FLAG));
});

test("S1/S3 permanently missing identity retains exact-refusal fallback on every request", async () => {
  const f = setup(async call => call.arguments.includes(FLAG) ? result(refusal, 1) : result(), true);
  await success(f.cli, f.request); await success(f.cli, f.request); f.invariant();
  assert.deepEqual(f.flags(), [true, false, true, false]);
});

test("S1/S3 failed fallback is surfaced without another retry", async () => {
  const f = setup(async () => result(refusal, 1)); const before = hash(f.exe);
  await assert.rejects(f.cli.targetStatus(f.request), e => e instanceof NativeReviewIntegrationError && e.message === refusal.message && e.failureEnvelope.cause === refusal.cause);
  assert.deepEqual(f.flags(), [true, false]); assert.equal(hash(f.exe), before); f.invariant();
});

test("S1/S3 typed and process failures remain exact, non-retried, and non-caching", async () => {
  const variants = [
    { ...refusal, cause: "flag provided but not defined: -lenses" },
    { ...refusal, cause: refusal.cause + "-v2" },
    { ...refusal, cause: "prefix " + refusal.cause },
    { ...refusal, code: "authority_unavailable" },
    { ...refusal, mutation_outcome: "unknown" },
  ];
  for (const body of variants) {
    const f = setup(async (_, n) => n === 1 ? result(body, 1) : result()); const before = hash(f.exe);
    await assert.rejects(f.cli.targetStatus(f.request), e => {
      assert.ok(e instanceof NativeReviewIntegrationError); assert.equal(e.message, body.message);
      assert.equal(e.failureEnvelope.cause, body.cause); assert.equal(e.failureEnvelope.code, body.code);
      assert.equal(e.mutationOutcome, body.mutation_outcome); return true;
    });
    assert.equal(f.calls.length, 1); assert.equal(hash(f.exe), before); f.invariant();
    await success(f.cli, f.request); assert.deepEqual(f.flags(), [true, true]);
  }
  for (const [reply, code, message] of [
    [result({}, 0, {timedOut: true}), "timeout", "native process timed out"],
    [result({}, 0, {signal: "SIGTERM"}), "signal", "native process was signalled"],
    [result({}, 0, {outputLimitExceeded: true}), "output-limit", "native process output exceeded limit"],
    [result({}, 0, {stdout: "{"}), "malformed-json", "native command returned malformed JSON"],
    [result({}), "schema-incompatible", "native response is schema incompatible"],
    [result(status, 0, {stderr: "not an allowed notice"}), "unexpected-stderr", "native process wrote stderr"],
  ]) {
    const f = setup(async (_, n) => n === 1 ? reply : result()); const before = hash(f.exe);
    await assert.rejects(f.cli.targetStatus(f.request), e => e instanceof NativeReviewCliError && e.code === code && e.message === message);
    assert.equal(f.calls.length, 1); assert.equal(hash(f.exe), before); f.invariant();
    await success(f.cli, f.request); assert.deepEqual(f.flags(), [true, true]);
  }
});

test("S1/S3 provider-issued STATUS selection is unchanged and never retried for opt-in refusal", async () => {
  for (const refused of [false, true]) {
    const f = setup(async () => refused ? result(refusal, 1) : result()); const before = hash(f.exe);
    const tokens = ["--contract=gentle-ai.review-integration/v2", "--agent=pi", "--next-transition=true", "--intended-untracked-selection={{value}}"];
    const request = { ...f.request, intendedUntrackedSelection: { argumentTokens: tokens, value: '{"paths":[]}' } };
    if (refused) await assert.rejects(f.cli.targetStatus(request), e => e instanceof NativeReviewIntegrationError && e.failureEnvelope.cause === refusal.cause);
    else await success(f.cli, request);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].arguments, ["review", "status", "--cwd", f.dir, ...tokens.map(t => t.replace("{{value}}", '{"paths":[]}'))]);
    assert.equal(hash(f.exe), before); f.invariant();
  }
});

test("S1/S3 real fixture process plus held adapter response survives executable replacement", async () => {
  const entered = gate(), held = gate(), real = createNodeExecFileAdapter();
  const f = setup(async (call, n) => { const response = await real({ ...call, file: process.execPath, arguments: [f.exe, ...call.arguments] }); if (n === 1) { entered.release(); await held.promise; } return response; });
  const script = body => `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(body))}); process.exitCode=${body === refusal ? 1 : 0};\n`;
  writeFileSync(f.exe, script(refusal));
  const old = f.cli.targetStatus(f.request); await entered.promise;
  writeFileSync(f.exe, script(status)); held.release();
  await old; await success(f.cli, f.request); f.invariant();
  assert.deepEqual(f.flags(), [true, false, true]);
});
