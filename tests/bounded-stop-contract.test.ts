import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// ODD harness-continuity S3 (odd/tasks/harness-continuity.md): authorized work
// continues, a pending child is a wait event that resumes the turn, and only a
// real human decision, the user's explicit stop, a denial, missing consent, or
// an exhausted limit stops the work it applies to. The canonical Close owns
// those boundaries; Pi-owned continuity keeps only its unique guards and
// budget clauses and never licenses a generic terminal **Needs your decision**
// result or broad "never more verification". These are instruction-delivery
// contracts, not proof of model adherence.

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");
const verification = read("assets/orchestrator-verification.md");
const tracking = read("assets/orchestrator-tracking.md");
const worker = read("assets/agents/gentle-ai-worker.md");
const verify = read("assets/agents/gentle-ai-verify.md");
const personas = ["gentleman", "neutral"] as const;
const modes = ["organic", "full-delegation"] as const;
let scratch: string;
let previousConfigHome: string | undefined;
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "gentle-bounded-stop-"));
	previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
});
after(() => {
	if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function prompt(persona: (typeof personas)[number], mode: (typeof modes)[number] = "organic"): string {
	return __testing.buildGentlePrompt(persona, scratch, ["read"], undefined, undefined, mode);
}

function lineStarting(text: string, prefix: string): string {
	const line = text.split("\n").find((entry) => entry.startsWith(prefix));
	assert.ok(line, `missing line starting with: ${prefix}`);
	return line;
}

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

function closeStep(persona: (typeof personas)[number], mode: (typeof modes)[number] = "organic"): string {
	return lineStarting(prompt(persona, mode), "7. **Close.**");
}

// The canonical Close boundaries rendered from the mirrored routing/pi.md.
const CANONICAL_CLOSE = [
	"Authorized work continues: runnable in-scope steps run, a pending child is a wait event whose completion resumes the turn without asking the human, and only a real human decision, the user's explicit stop, a denial, missing consent, or an exhausted limit stops the work it applies to, never independent authorized work.",
	"A tracked task ends the turn pending only while it waits on already-launched work, for the affected work a denial, missing consent, the user's explicit stop, or an exhausted limit applies to, or for a genuine human decision still outstanding; independent authorized work continues, and it never abandons runnable work or presents an unverified outcome as final.",
	"Missing, partial, unavailable, or declined proof forbids claiming completion of the affected work, never an independently authorized next step, while a required authorized check the existing budget still allows keeps running; stop checking only inside an exhausted or denied boundary, report that exact blocker and the decision that is genuinely the human's, and never invent a pass.",
	"Never turn a report into a blind self-reprompt loop.",
	"Hedged wording is not a stop.",
] as const;

function trackedPendingBoundary(text: string): string {
	const start = text.indexOf("A tracked task ends the turn pending");
	assert.ok(start >= 0, "the canonical tracked-task boundary is rendered");
	const end = text.indexOf("as final.", start);
	assert.ok(end > start, "the canonical tracked-task boundary ends with its finality clause");
	return text.slice(start, end + "as final.".length);
}

test("T23(a): a partial or blocked writer gets the one correction; verification-specific blockers remain bounded", () => {
	containsAll(lineStarting(verification, "5. **One correction**"), [
		"A `partial` or `blocked` writer report gets only this correction, never an extra verify run beyond the risk tier's verifier",
		"leftover partial, blocked, unavailable, or exhausted proof likewise",
	], "verification correction bound");
	for (const persona of personas) {
		containsAll(closeStep(persona), [
			"An applicable quick check runs once",
			"an unavailable verifier or subagent is reported as unavailable, never retried or escalated into extra ceremony",
		], `${persona} harness Close step`);
	}
});

test("S3: the canonical Close carries authorized continuation, a pending-child wait, and only real stops in both modes", () => {
	for (const mode of modes) {
		const close = closeStep("gentleman", mode);
		containsAll(close, CANONICAL_CLOSE, `${mode} canonical Close`);
		assert.ok(!close.includes("Needs your decision"), `${mode} Close must not license a generic terminal result`);
		assert.ok(!close.includes("never more verification"), `${mode} Close must not broaden into a generic verification stop`);
	}
});

test("S3: an explicit user stop is scoped to the work it names while authorized checks continue", () => {
	const rendered = prompt("gentleman");
	containsAll(rendered, [
		"An explicit user stop applies only to the work it names.",
		"while a required authorized check the existing budget still allows keeps running",
		"Missing, partial, unavailable, or declined proof forbids claiming completion of the affected work, never an independently authorized next step",
	], "authorized continuation boundaries");
	assert.ok(!rendered.includes("Needs your decision"), "ordinary continuity must not carry a generic terminal phrase");
});

test("S3 F1: denied, exhausted, missing-consent, and partial-stop cases stay scoped to the affected work", () => {
	for (const mode of modes) {
		const close = closeStep("gentleman", mode);
		const slice = trackedPendingBoundary(close);
		containsAll(slice, [
			"waits on already-launched work",
			"for the affected work a denial, missing consent, the user's explicit stop, or an exhausted limit applies to",
			"or for a genuine human decision still outstanding",
			"independent authorized work continues",
			"never abandons runnable work or presents an unverified outcome as final",
		], `${mode} tracked-task boundary`);
		// A denied destructive migration stays pending without a retry, an
		// exhausted verifier/correction limit never resumes its blocked task,
		// missing consent stops only that work, and a partial user stop leaves
		// unrelated runnable work running. These are the rendered clauses that
		// carry those cases, not model-adherence proof.
		containsAll(close, [
			"stops the work it applies to, never independent authorized work",
			"stop checking only inside an exhausted or denied boundary",
			"report that exact blocker and the decision that is genuinely the human's",
			"Missing, partial, unavailable, or declined proof forbids claiming completion of the affected work",
		], `${mode} central stop rule`);
	}
});

test("S3: a pending child or an open human decision is a legitimate pending turn, not a generic terminal result", () => {
	containsAll(tracking, [
		"continue every pending tracked task in the document or `todo` unless it waits on a launched child",
		"an already-decided denial, missing consent, or exhausted limit applies to that affected work",
		"the user stopped only that work",
		"or a genuine human decision is open",
		"Unrelated runnable authorized work continues",
		"Hedged delivery wording (the user may stop you, review commits one at a time, or pick the work up later) asks for resumable notes and separate commits, not a stop",
	], "tracking Close gate");
	assert.ok(!tracking.includes("Needs your decision"), "tracking must not license a generic terminal phrase");
	assert.ok(!tracking.includes("also a valid stop"), "tracking must not keep the old terminal stop license");
	assert.ok(!tracking.includes("tracked or untracked work alike"), "the unscoped stop exception must go");
});

test("S3: no phrase detector or broad verification stop joins ordinary continuity", () => {
	const source = read("extensions/gentle-ai.ts");
	assert.ok(!source.includes("Needs your decision"), "the extension must not detect or emit the generic terminal phrase");
	assert.ok(!source.includes("never more verification"), "the extension must not license a broad verification stop");
	assert.ok(prompt("gentleman").includes("Never turn a report into a blind self-reprompt loop."));
});

test("T23(c): writer self-review and worker validation stop after a bounded correction", () => {
	containsAll(lineStarting(verification, "1. **Self-review**"), [
		"fixes and continues (one correction per failing check, a second only if the same check still fails, then `partial`)",
	], "self-review item");
	containsAll(worker, [
		"Do not claim completion while required validation is failing.",
		"Make one correction attempt per failing check, and a second only if the same check still fails after a real fix; then stop and return `status: partial` with the failing command and its output, never looping.",
	], "worker Test discipline");
});

test("T23(d)(e): a quick check runs once and an unavailable verifier is reported, never retried", () => {
	for (const persona of personas) {
		containsAll(closeStep(persona), [
			"An applicable quick check runs once",
			"an unavailable verifier or subagent is reported as unavailable, never retried or escalated into extra ceremony",
		], `${persona} harness Close step`);
	}
});

test("S4-S5: the Close stop stays scoped to the ended automatic cycle", () => {
	for (const persona of personas) {
		containsAll(prompt(persona), [
			"The Close stop ends the cycle; later explicit requests stay subject to native authority.",
			"Partial worker execution is not by itself exhausted proof or a terminal native review outcome.",
		], `${persona} delivered continuation`);
	}
});

test("S4-S5: the worker returns remaining work and a human-controlled continuation after its bound", () => {
	containsAll(worker, [
		"After the correction bound is exhausted, stop and return `status: partial`",
		"report the concrete remaining implementation work, failing commands and outputs, and missing proof",
		"identify a scoped continuation the parent can offer for explicit human authorization",
		"Do not start a fresh correction cycle or treat a new session as a reset",
		"native authority and all other applicable limits remain binding",
	], "worker continuation handoff");
	containsAll(verification, [
		"Follow **Authorized work continuity** for setup and worker recovery; scratch: `gentle-ai-verify`.",
	], "parent continuation reference");
});

test("T23(f): the verify agent allows a second correction only for the same blocker still failing", () => {
	containsAll(lineStarting(verify, "5. **Every item.**"), [
		"one correction batch and one recheck limited to the reported blockers",
		"a second correction only when the recheck shows the same blocker still failing, never for a new finding",
	], "verify item 5");
});

test("gentle-shell#3082: a stopped verification carries its terminal disposition in the lazy module", () => {
	containsAll(verification, [
		"When required proof is unobtainable, one terminal disposition closes a stopped verification",
		"name the missing proof and resume authorized in-scope work at `status: partial`",
		"never PASS, never silently dropped",
	], "verification terminal disposition");
});
