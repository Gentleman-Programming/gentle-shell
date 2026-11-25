import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { parseAgentDefinition } from "../lib/agents-config.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const paragraph = (p: string, prefix: string) => {
  const text = p.split("\n\n").find(s => s.startsWith(prefix));
  assert.ok(text, prefix);
  return text;
};
// The body of the module's `## Verifier preparation failure` section.
const verifierPreparation = () => {
  const module = read("assets/orchestrator-verification.md");
  const start = module.indexOf("## Verifier preparation failure\n\n");
  assert.ok(start >= 0, "verification module keeps its preparation-failure section");
  const body = module.slice(start + "## Verifier preparation failure\n\n".length);
  const end = body.indexOf("\n## ");
  return end < 0 ? body : body.slice(0, end);
};
let cwd: string;
let prior: string | undefined;
before(() => {
  cwd = mkdtempSync(join(tmpdir(), "recovery-delivery-"));
  prior = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = join(cwd, "config");
  mkdirSync(join(cwd, "project"));
});
after(() => {
  if (prior === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = prior;
  rmSync(cwd, { recursive: true, force: true });
});

// S2-S5: positive setup/implementation routes and negative authority boundaries
// must coexist in the delivered parent prompt, in every persona and RDD mode.
for (const persona of ["gentleman", "neutral"] as const) {
  for (const mode of ["on", "off", "unknown"]) {
    test(`S2-S5 delivered recovery is bounded: ${persona}/${mode}`, () => {
      const p = __testing.buildGentlePrompt(persona, join(cwd, "project"), ["read"], `Receipt-driven development: ${mode}`);
      assert.equal(p.split("## Authorized work continuity").length, 2);
      // cost-speed-painpoints S15 P4: the setup rules live in the verification module, loaded when Verification fires;
      // the unavailable-verifier rule stays always-on in the mirrored Close step.
      assert.ok(!p.includes("A failed verifier setup"), "the setup paragraph left the always-on prompt");
      const setup = paragraph(verifierPreparation(), "A failed verifier setup");
      assert.match(setup, /prerequisite is repaired, the human may explicitly request one new bounded verification attempt/);
      assert.match(setup, /zero tests run; the checks remain unverified/);
      assert.match(setup, /self-fix of its own setup error \(one correction in the same verification\) needs no decision/);
      assert.match(p, /7\. \*\*Close\.\*\*[^\n]*an unavailable verifier or subagent is reported as unavailable, never retried or escalated/);
      for (const guard of ["consent", "a denial", "one-run", "no-retry", "terminal native outcomes", "exhausted native budgets"]) assert.ok(setup.includes(guard), guard);
      assert.match(setup, /no child is active or has an uncertain status/);
      const worker = paragraph(p, "Worker exhaustion:");
      // #2919 and turn-end-coherence S11: a repeated cause without a new hypothesis hands the next step to the parent.
      assert.match(worker, /without a new hypothesis ends the worker's cycle, not the unit\. The parent owns the next step, unasked, within native authority/);
      assert.match(worker, /Never repeat an attempt or swap executors to dodge limits/);
      assert.doesNotMatch(worker, /human-controlled|let the human stop/);
      assert.match(worker, /later explicit requests stay subject to native authority/);
      assert.match(paragraph(p, "Explicit limits:"), /Never reset, widen or dodge a limit, even in a new session/);
      // harness-continuity T5: the proof boundary moved from this paragraph into the canonical Close.
      const close = p.split("\n").find(line => line.startsWith("7. **Close.**"));
      assert.ok(close, "the always-on prompt delivers Close");
      assert.ok(close.includes("Missing, partial, unavailable, or declined proof bars claiming completion of affected work, not independent authorized work or required authorized checks in budget."));
      assert.match(worker, /no child is active or uncertain/);
      assert.ok(close.includes("Stop checks only at an exhausted or denied boundary or with no permitted route."));
      assert.doesNotMatch(p, /Stop only for[^\n]*unavailable required proof/);
      assert.ok(!p.includes("unavailable required proof"), "no rendered prompt stops for unavailable proof");
    });
  }
}

test("S3-S5 parsed worker and verifier contracts retain confinement and proof limits", () => {
  const agent = (name: string) => {
    const p = `assets/agents/gentle-ai-${name}.md`;
    const parsed = parseAgentDefinition(read(p), p, "global");
    assert.ok(!("error" in parsed));
    return parsed;
  };
  const worker = agent("worker");
  assert.match(worker.instructions, /handoff is not authorization to continue/);
  assert.match(worker.instructions, /After a repeated-cause stop, do not start a fresh correction cycle or treat a new session as a reset/);
  assert.match(worker.instructions, /missing proof still blocks completion and delivery/);
  const verify = agent("verify");
  assert.deepEqual(verify.tools, ["read", "grep", "find", "bash", "codemode", "mcp__codegraph__codegraph_explore"]);
  assert.match(verify.instructions, /Before isolated setup[^\n]*space and inodes/);
  assert.match(verify.instructions, /smaller copy[^\n]*all source, test\/build files, baseline material, and dependencies/);
  assert.match(verify.instructions, /deterministic error in a command or environment you constructed[^\n]*exactly one corrected attempt/);
  assert.match(verify.instructions, /second failure, or at any missing or unavailable prerequisite[^\n]*stop setup/);
  assert.match(verify.instructions, /setup fails before probes[^\n]*zero tests run/);
  assert.match(verify.instructions, /No further setup retries and no repair-helper loops/);
  for (const guard of ["system temp directory", "a symlink into the workspace", "No network, no installs, no writes outside", "NODE_COMPILE_CACHE", "NO_UPDATE_NOTIFIER=1"]) assert.ok(verify.instructions.includes(guard), guard);
});

test("S2-S5 user recovery docs retain the independent-proof and native-authority boundaries", () => {
  const docs = read("docs/delegated-verification.md");
  assert.match(docs, /static inspection and parent tests do not replace the missing independent runtime proof/);
  assert.match(docs, /no instantiated native budget[^\n]*grants no review approval/);
  assert.match(docs, /Missing required proof still blocks completion and delivery/);
  assert.match(docs, /active or uncertain child prevents continuation/);
  assert.match(docs, /explicit one-run\/no-retry limit/);
  // #2919 and turn-end-coherence S11: the docs route a worker's partial handoff to the parent, not the human.
  const start = docs.indexOf("### Parent continuation after a worker's partial handoff");
  assert.ok(start >= 0, "docs keep the worker-recovery section");
  const section = docs.slice(start, docs.indexOf("\n## ", start));
  assert.match(section, /parent decides the next step from the returned evidence, without asking the user/);
  assert.match(section, /never repeats the same attempt/);
  assert.match(section, /RED construction/);
  assert.doesNotMatch(section, /explicit human authorization/);
});
