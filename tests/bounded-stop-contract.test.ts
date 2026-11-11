import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// gentle-shell#1731 T23 (G1 audit L48): port the gentle-ai Native Checking
// Contract bounded stop. Partial, blocked, unavailable, or exhausted proof
// becomes one **Needs your decision** result instead of more verification; the
// close gate accepts that result as a stop; writer self-review and worker
// validation stop after a bounded correction; a quick check runs once; an
// unavailable verifier is reported, never retried or escalated.
// These are instruction-delivery contracts, not proof of model adherence.

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");
const verification = read("assets/orchestrator-verification.md");
const tracking = read("assets/orchestrator-tracking.md");
const worker = read("assets/agents/gentle-ai-worker.md");
const verify = read("assets/agents/gentle-ai-verify.md");
const personas = ["gentleman", "neutral"] as const;
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

function prompt(persona: (typeof personas)[number]): string {
	return __testing.buildGentlePrompt(persona, scratch, ["read"]);
}

function lineStarting(text: string, prefix: string): string {
	const line = text.split("\n").find((entry) => entry.startsWith(prefix));
	assert.ok(line, `missing line starting with: ${prefix}`);
	return line;
}

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

function closeStep(persona: (typeof personas)[number]): string {
	return lineStarting(prompt(persona), "7. **Close.**");
}

test("T23(a): a partial or blocked writer gets the one correction, then Needs your decision, never more verify", () => {
	containsAll(lineStarting(verification, "5. **One correction**"), [
		"A `partial` or `blocked` writer report gets only this correction, never an extra verify run beyond the risk tier's verifier",
		"partial, blocked, unavailable, or exhausted proof left after it becomes that one **Needs your decision**",
	], "verification correction bound");
	for (const persona of personas) {
		containsAll(closeStep(persona), [
			"Partial, blocked, unavailable, or exhausted proof becomes one **Needs your decision** result naming the open blockers or missing proof, never more verification",
		], `${persona} harness Close step`);
	}
});

test("T23(b): the close gate accepts one Needs your decision result as a stop, hedged wording still is not", () => {
	for (const persona of personas) {
		containsAll(closeStep(persona), [
			"Never end with a tracked task pending unless you quote the user's explicit stop.",
			"that result is a valid stop, hedged wording is not",
		], `${persona} harness Close step`);
	}
	containsAll(tracking, [
		"continue it or quote the exact user sentence that orders the stop. One **Needs your decision** result naming the open blockers or missing proof is also a valid stop.",
		"Hedged delivery wording (the user may stop you, review commits one at a time, or pick the work up later) asks for resumable notes and separate commits, not a stop",
	], "tracking Close gate");
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

test("S4-S5: the unchanged Close stop is scoped to the ended automatic cycle", () => {
	for (const persona of personas) {
		containsAll(prompt(persona), [
			"The Close stop ends the cycle; later explicit requests stay subject to native authority.",
			"Partial worker execution is not by itself exhausted proof or a terminal native review outcome.",
		], `${persona} delivered continuation`);
		assert.ok(closeStep(persona).includes("never more verification"), "the mirrored Close rule remains intact");
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
