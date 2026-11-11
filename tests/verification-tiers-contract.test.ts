import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Cost-speed P8 (S15, L32, L35, L36): the independent verifier's evidence depends on
// what kind of change it checks, and six contradictions in the verification
// module and the agent bodies are resolved in one direction. When a verifier
// runs is unchanged: only for a named high-risk item.

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const verification = read("assets/orchestrator-verification.md");
const verify = read("assets/agents/gentle-ai-verify.md");
const worker = read("assets/agents/gentle-ai-worker.md");
const docs = read("docs/delegated-verification.md");
const LENSES = ["review-risk", "review-reliability", "review-resilience", "review-readability"].map((name) => `assets/agents/${name}.md`);
const JUDGES = ["assets/agents/jd-judge-a.md", "assets/agents/jd-judge-b.md"];

function containsAll(content: string, phrases: readonly string[], label: string): void {
	for (const phrase of phrases) assert.ok(content.includes(phrase), `${label} is missing: ${phrase}`);
}

function sectionOf(content: string, heading: string): string {
	const start = content.indexOf(heading);
	assert.ok(start >= 0, `missing section ${heading}`);
	const next = content.indexOf("\n## ", start + heading.length);
	return content.slice(start, next === -1 ? undefined : next);
}

// Part A, rule 1: the verifier's evidence is what the writer could not see.
test("P8 rule 1: the verifier does not use the writer's reported suite as its main evidence; the spot check stays", () => {
	const kinds = sectionOf(verify, "## Evidence by change kind");
	containsAll(kinds, [
		"Your evidence is what the writer could not see.",
		"Do not re-run the suite the writer reported",
		"the parent's spot check of one reported command is the check on the writer's own results",
		"Run the commands the parent authorizes as your evidence (the real-case command, the user's failing command, the spec's example commands) and your own probes, including a focused test only when a probe needs it",
	], "verify change-kind rule 1");
	containsAll(verification, [
		"The parent spot check (re-running one reported command before delivery) stays required in every tier.",
	], "verification spot check");
});

// Cost-speed S15 P16 (from the review of gentle-ai PR #6072): when the user's failing command is the writer's
// reported suite, the rule against re-running that suite must not leave the user-reported fix unverified.
test("P16: the user's failing command is run even when it is the suite the writer reported", () => {
	const kinds = sectionOf(verify, "## Evidence by change kind");
	assert.ok(kinds.includes("Do not re-run the suite the writer reported: the parent's spot check of one reported command is the check on the writer's own results; the one exception is the user's failing command the parent passes, run even when it is that suite."), "the exception clause follows the prohibition in the verifier body");
	const handoff = verification.split("\n").find((line) => line.startsWith("4. **Verify handoff**")) ?? "";
	assert.ok(handoff.includes("the parent commits when a commit is authorized."), "the module's handoff commits only when a commit is authorized");
	assert.ok(!handoff.includes("the parent commits."), "the unconditional commit sentence is gone from the module's handoff");
	assert.ok(docs.includes("it does not re-run the suite the writer reported, because the parent's single spot check of one reported command is the check on the writer's own results; the one exception is the user's failing command the parent passes, which it runs even when it is that suite."), "the docs state the same exception next to the prohibition");
});

// Cost-speed S15 P17 (from the review of gentle-ai PR #6072): a passing run on the change proves nothing when the
// user's failing command did not fail at the baseline with the user's error; the fix stays unverified then.
test("P17: a user-reported fix is verified only when the failure reproduces at the baseline with the user's error", () => {
	const kinds = sectionOf(verify, "## Evidence by change kind");
	const rule = kinds.split("\n").find((line) => line.startsWith("- **A fix for a failure the user reported**")) ?? "";
	containsAll(rule, [
		"against the baseline and against the change",
		"The fix is not verified until that command passes there.",
		"The failure counts as reproduced only when that command fails at the baseline with the user's error; when it passes at the baseline or fails there with a different error, report the fix unverified and say which, never verified.",
	], "verifier body baseline-reproduction condition");
	const docRule = docs.split("\n").find((line) => line.startsWith("- **A fix for a failure the user reported**")) ?? "";
	containsAll(docRule, [
		"the verifier runs that command against the baseline and against the change",
		"The fix is not verified until that command passes there.",
		"The failure counts as reproduced only when that command fails at the baseline with the user's error; when it passes at the baseline or fails there with a different error, the verifier reports the fix unverified and says which, never verified.",
	], "docs baseline-reproduction condition");
});

// Part A, rule 2: external tools and environments.
test("P8 rule 2: an external tool or environment change is reproduced with the real tool and configuration plus own probes", () => {
	const kinds = sectionOf(verify, "## Evidence by change kind");
	containsAll(kinds, [
		"**External tool or environment** (package managers, CLIs, network services, operating-system behavior)",
		"reproduce the real case with the real tool and the configuration the change will meet",
		"plus your own probes derived from the spec",
		"A fixture that does not match that configuration is not proof",
	], "verify change-kind rule 2");
});

// Part A, rule 3: prompt or contract text.
test("P8 rule 3: a prompt or contract text change is compared sentence by sentence with the base and read literally", () => {
	const kinds = sectionOf(verify, "## Evidence by change kind");
	containsAll(kinds, [
		"**Prompt or other contract text**",
		"compare every removed or rewritten sentence with the baseline, one by one",
		"report each lost qualifier",
		"each rule turned absolute",
		"read each new rule as a literal model would",
	], "verify change-kind rule 3");
});

// Part A, rule 4: a fix for a failure the user reported.
test("P8 rule 4: a user-reported failure is reproduced with the user's exact command and environment before and after", () => {
	const kinds = sectionOf(verify, "## Evidence by change kind");
	containsAll(kinds, [
		"**A fix for a failure the user reported**",
		"run the user's exact failing command (the parent passes it verbatim, which authorizes it), with the user's tool versions and configuration",
		"against the baseline and against the change",
		"The fix is not verified until that command passes there",
	], "verify change-kind rule 4");
	containsAll(verification, [
		"Name the change kind",
		"for the last, pass verbatim its exact failing command, error text, tool versions and configuration",
	], "verification handoff for change kinds");
	containsAll(docs, [
		"the user's exact failing command and error text verbatim",
		"The fix is not verified until that command passes there",
	], "docs change kinds");
});

test("P8: change kinds never change when a verifier runs, and the verifier keeps its isolation", () => {
	containsAll(verification, [
		"The independent verifier runs only when the change touches a named Task Size high-risk item",
	], "verification named-risk rule");
	const kinds = sectionOf(verify, "## Evidence by change kind");
	assert.ok(kinds.includes("report that check unverified with its exact command"), "an unavailable real case must be reported unverified");
	containsAll(verify, ["No network, no installs, no writes outside the scratch directory."], "verify isolation");
});

// Part B, C1: second correction first, then the single Needs your decision.
test("P8 C1: the second correction is stated before the remaining blockers become one Needs your decision", () => {
	const second = verification.indexOf("A second correction runs automatically only when the recheck shows the same blocker still failing");
	const decision = verification.indexOf("Blockers still open after that stop as one **Needs your decision**");
	assert.ok(second >= 0 && decision >= 0, "both correction sentences must stay");
	assert.ok(second < decision, "the second correction must come before the Needs your decision stop");
});

// Part B, C2: writers add probes as tests; the parent owns git.
test("P8 C2: the writer adds verifier probes as regression tests and the parent commits", () => {
	assert.ok(verification.includes("the writer adds its probes as regression tests; the parent commits when a commit is authorized."), "verification must say the parent commits only when a commit is authorized");
	assert.ok(!verification.includes("the writer commits its probes"), "the writer never commits");
	// Cost-speed S15 P16 (from the review of gentle-ai PR #6072): the parent commits the probes only when a commit is authorized.
	assert.ok(verify.includes("for the parent to hand to the writer, who adds them; the parent commits them only when a commit is authorized, otherwise they stay uncommitted; you never write them"), "verify durable probes must say the parent commits only when a commit is authorized");
	assert.ok(!verify.includes("the parent commits; you never write them"), "the unconditional commit sentence is gone from the verifier body");
	assert.ok(!verify.includes("to hand to the writer to commit"), "verify must not say the writer commits");
});

// Part B, C6: the worker is for bounded implementation the parent delegates.
test("P8 C6: the worker is for bounded implementation the parent delegates, not only work too large for the parent", () => {
	assert.ok(!worker.includes("too large for the parent to execute inline"), "size never decides the worker");
	containsAll(worker, [
		"bounded implementation the parent delegates",
		"every change in full delegation mode",
		"never for Judgment Day artifact protocols",
	], "worker purpose");
});

// Part B, C10: passive has no tests, so the spot check applies when a command was reported.
test("P8 C10: a passive change with no reported command needs only its readback", () => {
	for (const [label, content] of [["verification", verification], ["docs", docs]] as const) {
		assert.ok(content.includes("A passive change that reports no command needs only its readback."), `${label} must reconcile passive with the spot check`);
	}
});

// Part B, C13: lens and judge agents return only the native JSON envelope.
test("P8 C13: review lenses and Judgment Day judges carry no prose output instruction", () => {
	for (const path of LENSES) {
		const content = read(path);
		assert.ok(!content.includes("## Output contract"), `${path} still has the prose output contract`);
		assert.ok(!content.includes("Report findings only"), `${path} still asks for prose findings`);
		assert.ok(content.includes("severity (`BLOCKER | CRITICAL | WARNING | SUGGESTION`)"), `${path} must keep the severity enum in the ledger contract`);
		assert.ok(content.includes("Return only this compact-v2 native JSON envelope"), `${path} must keep the JSON envelope`);
	}
	for (const path of JUDGES) {
		const content = read(path);
		assert.ok(!content.includes("suggested verification"), `${path} still asks for prose suggestions`);
		assert.ok(!content.includes("say so clearly"), `${path} still asks for a prose clean statement`);
		assert.ok(content.includes("return only this graph-v1 native JSON shape"), `${path} must keep the JSON shape`);
	}
});

// Part B, X6: stale numbering and the false "not restated" claim.
test("P8 X6: the Verification rule carries no stale number or not-restated claim", () => {
	assert.ok(!verification.includes("5. **Verification rule**"), "stale trigger number");
	assert.ok(!verification.includes("referenced, not restated"), "the rule is restated elsewhere; the claim is false");
	assert.ok(verification.includes("**Verification rule** (gentle-pi#661/#662):"), "the rule keeps its issue references");
});

// Preservation: PR #3084 setup self-correction and PR #3092 first-launch reads and resume rule.
test("P8 preservation: verifier setup self-correction, first-launch reads, resume rule and correction bound stay", () => {
	containsAll(verify, [
		"make exactly one corrected attempt without asking anyone and report both attempts",
		"`NO_UPDATE_NOTIFIER=1` for every probe",
		"Run the spec's example commands on your first launch",
		"When resumed in the same child session, do not re-read skill files or spec sections you already read there unless they changed or the parent says so",
		"Probe on your first launch; never wait for further authorization.",
		"any requested `## Key Learnings` block",
	], "verify preserved rules");
	containsAll(verification, [
		"one correction batch that fixes every reported blocker",
		"a new finding never earns one",
	], "verification correction bound");
});

// Verifier mwb64j0f-13-7akl, B1: the parent loads only the module, so the module must carry the real
// environment for a user-reported failure and tell the parent to run what the verifier could not.
test("P8 B1: the parent passes the user's environment and runs the real-case check the verifier left unverified", () => {
	const handoff = verification.split("\n").find((line) => line.startsWith("4. **Verify handoff**")) ?? "";
	containsAll(handoff, [
		"its exact failing command, error text, tool versions and configuration",
		"Run yourself any real-case check the verifier leaves unverified before calling the change verified.",
	], "verification handoff B1");
	// Cost-speed S15 P5a: the always-on verifier-setup paragraph moved into this module (MODULE_BUDGETS in
	// tests/task-size-routing-contract.test.ts holds the arithmetic): 7,900 -> 8,608 B; mode-neutral wording: 8,656 B; P16 conditional commit, paid by trimming restated phrases: 8,648 B; gentle-shell#3082 terminal-disposition raise: 8,900 B (#3149).
	assert.ok(verification.length > 0 && Buffer.byteLength(verification) <= 8_900, "the module stays within its 8,900 B budget");
});

// B2: the verifier never re-runs the writer's reported suite, and no other sentence of its body orders it.
test("P8 B2: the verifier body says one thing about which commands it runs", () => {
	assert.ok(!verify.includes("Never re-run the writer's reported suite as your main evidence"), "the weakened main-evidence wording is gone");
	assert.ok(!verify.includes("Run the focused test and the suite without status-only turns"), "the batch rule must not order the suite");
	const batch = verify.split("\n").find((line) => line.includes("**Batch tool calls:**")) ?? "";
	assert.ok(batch.includes("Run the commands you do run (your evidence commands and probes) without status-only turns between them"), "batching keeps no status-only turns for the commands the verifier runs");
	assert.ok(!verify.includes("run the authorized checks and independent spec-derived probes"), "preparation must not order generic authorized checks");
	assert.ok(verify.includes("If preparation succeeds, run your evidence commands and independent spec-derived probes."), "preparation runs the evidence commands and probes");
	assert.ok(verify.includes("execute only exact test, build, lint, or spec example commands explicitly authorized by the parent, plus the scratch-copy probes below"), "the verifier still runs only authorized commands plus scratch probes");
});

// A3: a user-reported fix without the failing command is unverified; the verifier never guesses the command.
test("P8 A3: a user-reported fix handed over without the failing command is unverified and the command is not guessed", () => {
	const kinds = sectionOf(verify, "## Evidence by change kind");
	assert.ok(kinds.includes("When the handoff does not carry the failing command, report the fix unverified and name the missing command; never guess one."), "A3 sentence");
});
