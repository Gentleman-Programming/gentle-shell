import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// ODD harness-continuity S3 (odd/tasks/harness-continuity.md): authorized work
// continues, a pending child is a wait event that resumes the turn, and only a
// real human decision, explicit user stop, denial, missing consent, exhausted
// limit, or failure without a permitted route stops affected work. Close applies
// those boundaries to tracking and proof; Pi-owned continuity carries the
// general rule and never licenses a generic terminal **Needs your decision**
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
	"A failed check is diagnosed, fixed and rerun within its limits.",
	"Run authorized in-scope steps. Work through failures with a permitted route. A pending child is a wait: completion resumes the turn without asking.",
	"Only a real human decision, explicit user stop, denial, missing consent, exhausted limit, or failure without a permitted route stops only affected work.",
	"A tracked task ends the turn pending only for launched work still running, a real human decision, denial, missing consent, explicit stop, or exhausted limit.",
	"Report failures without a permitted route as incomplete. Continue independent authorized work; never abandon runnable work or present an unverified outcome as final.",
	"Missing, partial, unavailable, or declined proof bars claiming completion of affected work, not independent authorized work or required authorized checks in budget.",
	"Stop checks only at an exhausted or denied boundary or with no permitted route. Report the exact blocker and any genuine human decision; never invent a pass.",
	"Never turn a report into a blind self-reprompt loop.",
	"Hedged wording is not a stop.",
] as const;

test("T23(a): the independent verifier's correction limit never grants an extra verify run", () => {
	containsAll(lineStarting(verification, "5. **One correction**"), [
		"This limit applies to independent verifier findings only.",
		"No extra verifier run for a `partial` or `blocked` writer or partial, blocked, unavailable or exhausted proof.",
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
		"Missing, partial, unavailable, or declined proof bars claiming completion of affected work, not independent authorized work or required authorized checks in budget.",
	], "authorized continuation boundaries");
	assert.ok(!rendered.includes("Needs your decision"), "ordinary continuity must not carry a generic terminal phrase");
});

test("S3 F1: denied, exhausted, missing-consent, and partial-stop cases stay scoped to the affected work", () => {
	for (const mode of modes) {
		const close = closeStep("gentleman", mode);
		containsAll(close, [
			"A tracked task ends the turn pending only for launched work still running, a real human decision, denial, missing consent, explicit stop, or exhausted limit.",
			"Report failures without a permitted route as incomplete. Continue independent authorized work; never abandon runnable work or present an unverified outcome as final.",
		], `${mode} tracked-task boundary`);
		// A denied destructive migration stays pending without a retry, an
		// exhausted verifier/correction limit never resumes its blocked task,
		// missing consent stops only that work, and a partial user stop leaves
		// unrelated runnable work running. These are the rendered clauses that
		// carry those cases, not model-adherence proof.
		containsAll(close, [
			"Only a real human decision, explicit user stop, denial, missing consent, exhausted limit, or failure without a permitted route stops only affected work.",
			"Stop checks only at an exhausted or denied boundary or with no permitted route.",
			"Report the exact blocker and any genuine human decision; never invent a pass.",
			"Missing, partial, unavailable, or declined proof bars claiming completion of affected work",
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

test("T23(c): writer self-review follows the progress rule without claiming unverified completion", () => {
	containsAll(lineStarting(verification, "1. **Self-review**"), [
		"The writer fixes and continues by progress: name the cause from output and change the fix to address it.",
	], "self-review item");
	containsAll(worker, [
		"Do not claim completion while required validation is failing.",
		"Never repeat the same change or stop because of an attempt count.",
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
			"Close ends the automatic cycle; later explicit requests stay subject to native authority.",
			"Partial worker execution is not exhausted proof or a terminal native review outcome.",
		], `${persona} delivered continuation`);
	}
});

// #2919 and turn-end-coherence S11: the worker returns evidence and the parent owns the next step.
test("the worker reports a repeated-cause stop with evidence; the parent decides", () => {
	containsAll(worker, [
		"Stop correcting and return `status: partial` only if the same cause fails again after a real fix and no new hypothesis exists",
		"failing commands and outputs, concrete remaining implementation work, missing proof, and diagnosed cause with evidence",
		"That ends your cycle, not the unit: the parent decides the next step from that evidence.",
		"This handoff is not authorization to continue.",
		"After a repeated-cause stop, do not start a fresh correction cycle or treat a new session as a reset",
		"Native authority and all other applicable limits remain binding",
	], "worker continuation handoff");
	assert.ok(!worker.includes("explicit human authorization"), "a worker's partial handoff does not route to the human");
	containsAll(worker, [
		"RED construction is separate from fix correction",
		"harness or setup errors get one self-fix",
		"return `status: partial` with the reproduction blocker and its evidence",
	], "worker RED construction bound");
	containsAll(verification, [
		"Follow **Authorized work continuity** for setup and worker recovery; scratch: `gentle-ai-verify`.",
	], "parent continuation reference");
});

// orchestrator-owns-correction-exhaustion S2 (mode-aware, user L5): the parent always decides after worker
// exhaustion, but only organic mode may fix inline; full delegation relaunches a bounded writer, never edits.
test("S2: the post-exhaustion route follows the active delegation mode", () => {
	for (const persona of personas) for (const mode of modes) {
		const paragraph = prompt(persona, mode).split("\n\n").find(block => block.startsWith("Worker exhaustion:"));
		assert.ok(paragraph, `${persona}/${mode} keeps the worker-exhaustion paragraph`);
		containsAll(paragraph, [
			"A worker-local cause recurring after a real fix without a new hypothesis ends the worker's cycle, not the unit.",
			"The parent owns the next step, unasked, within native authority.",
			"On any partial, diagnose from evidence; confirm no child is active or uncertain. Within user-authorized scope:",
			"Never repeat an attempt or swap executors to dodge limits.",
			"No permitted route: report only that work incomplete; continue independent work.",
		], `${persona}/${mode} exhaustion route`);
		if (mode === "organic") {
			assert.ok(paragraph.includes("fix inline if small and understood, or relaunch with changed scope, hypothesis or handoff plus new evidence."), `${persona} organic route`);
		} else {
			assert.ok(paragraph.includes("never edit: launch a new bounded writer with the diagnosis, new evidence and changed scope or hypothesis."), `${persona} full-delegation route`);
			assert.ok(!paragraph.includes("inline"), `${persona} full delegation never fixes inline after exhaustion`);
		}
	}
});

test("T23(f): the verify agent allows a second correction only for the same blocker still failing", () => {
	containsAll(lineStarting(verify, "5. **Every item.**"), [
		"one correction batch and one recheck limited to the reported blockers",
		"a second correction only when the recheck shows the same blocker still failing, never for a new finding",
	], "verify item 5");
});

test("gentle-shell#3082: a stopped verification carries its terminal disposition in the lazy module", () => {
	containsAll(verification, [
		"Unobtainable proof: close verification once, name the gap and resume authorized in-scope work at `status: partial`.",
		"Never PASS or silently omit it",
	], "verification terminal disposition");
});

test("S2 (verifier P2): full delegation continues a progressing writer and preserves the distinct parent recovery route", () => {
	for (const persona of personas) {
		const p = prompt(persona, "full-delegation");
		const paragraph = p.split("\n\n").find((block) => block.startsWith("Worker exhaustion:")) ?? "";
		assert.match(paragraph, /launch a new bounded writer/);
		assert.ok(!p.includes("Fixes to one unit continue its worker (`subagent_continue`), never a new worker per fix."), "unscoped per-fix rule contradicts the post-exhaustion launch");
		assert.ok(p.includes("Continue a progressing worker (`subagent_continue`), never a new worker per fix."));
	}
});
