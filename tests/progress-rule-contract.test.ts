import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAgentDefinition } from "../lib/agents-config.ts";

const path = "assets/agents/gentle-ai-worker.md";
const worker = parseAgentDefinition(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), path, "global");
assert.ok(!("error" in worker));
const instructions = worker.instructions;
const paragraphs = instructions.split("\n\n");

function correctionStop(): string {
	const paragraph = paragraphs.find((entry) => entry.startsWith("Stop correcting and return `status: partial` only if"));
	assert.ok(paragraph, "the worker limits partial stops to named conditions");
	return paragraph;
}

// S11: assert the delivered worker instructions, not model adherence.
test("S11: a failing check is an obstacle; each correction names a cause from output and changes something to address it", () => {
	assert.match(instructions, /A failing check is an obstacle: keep correcting while each attempt names a cause from the output and makes a change to address it\./);
});

test("S11: a repeated cause stops correction only after a real fix and with no new hypothesis", () => {
	assert.match(correctionStop(), /the same cause fails again after a real fix and no new hypothesis exists/);
});

test("S11: stop rather than weaken, skip or rewrite a check to make it pass", () => {
	assert.match(correctionStop(), /passing would require weakening, skipping or rewriting the check/);
});

test("S11: stop if the fix exceeds allowed surfaces or crosses an explicit limit", () => {
	const stop = correctionStop();
	assert.match(stop, /the fix needs work outside the allowed surfaces or crosses an explicit limit/);
	assert.match(stop, /An explicit limit binds only the work it names\./);
});

test("S11: never repeat the same change or stop because of an attempt count", () => {
	assert.doesNotMatch(instructions, /one correction attempt per failing check|after the correction bound is exhausted/i);
	assert.match(instructions, /Never repeat the same change or stop because of an attempt count\./);
});

test("S11: the partial handoff keeps evidence and does not authorize a fresh cycle", () => {
	const stop = correctionStop();
	assert.match(stop, /failing commands and outputs, concrete remaining implementation work, missing proof, and diagnosed cause with evidence/);
	assert.match(stop, /That ends your cycle, not the unit: the parent decides the next step from that evidence\./);
	assert.match(stop, /This handoff is not authorization to continue\./);
	assert.match(stop, /After a repeated-cause stop, do not start a fresh correction cycle or treat a new session as a reset\./);
	assert.match(stop, /Native authority and all other applicable limits remain binding\./);
	assert.match(stop, /missing proof still blocks completion and delivery\./);
});

test("S11: RED reproduction keeps its own setup self-fix and evidence, separate from fix correction", () => {
	assert.match(instructions, /RED construction is separate from fix correction: harness or setup errors get one self-fix; if the test still cannot reproduce the failure, return `status: partial` with the reproduction blocker and its evidence/);
});
