import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const verify = read("assets/agents/gentle-ai-verify.md");
const policy = read("assets/orchestrator-verification.md");
const parent = read("assets/orchestrator.md");

// Instruction-delivery checks, not evidence of model adherence or delivery time.
test("unit verification keeps whole-feature context without blocking on future work", () => {
  for (const text of [verify, policy]) {
    assert.ok(text.includes("out of scope, not unmet"));
    assert.ok(text.includes("affected interactions"));
  }
  assert.ok(!verify.includes("no partial-scope carve-out"));
  assert.ok(verify.includes("At final feature verification, cover every requirement"));
  assert.ok(policy.includes("final feature verification covers every `S#`"));
  assert.ok(verify.includes("met, unmet, not implemented, or out of scope"));
  assert.ok(verify.includes("unrelated future work must not block that unit"));
});

test("observed writer evidence is reusable but does not replace independent probes", () => {
  assert.ok(verify.includes("Reuse observed writer checks when their candidate and scope remain valid"));
  assert.ok(verify.includes("independent probes"));
  assert.ok(!verify.includes("never evidence of correctness"));
});

test("auxiliary gates must protect a concrete requirement or threat", () => {
  assert.ok(parent.includes("gates/overengineering: `orchestrator-verification.md`"));
  assert.ok(policy.includes("acceptance criterion, concrete threat, or authoritative contract"));
  assert.ok(policy.includes("must not become a delivery blocker"));
  assert.ok(policy.includes("Do not build a framework for a bounded capability probe"));
});

test("overengineering warnings visibly simplify the plan without weakening safeguards", () => {
  assert.ok(policy.includes("remove or collapse optional artifacts and checks"));
  assert.ok(policy.includes("State what was removed, what remains indispensable, and the next application outcome"));
  assert.ok(policy.includes("Keep required functional checks, security controls, and native review authority intact"));
});

test("existing verification isolation and bounded correction remain required", () => {
  assert.ok(verify.includes("run it only against isolated state"));
  assert.ok(verify.includes("one correction batch and one recheck limited to the reported blockers"));
  assert.ok(policy.includes("Advisories never start a correction"));
});
