import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// gentle-shell#1731 T26 (L54): in the final bench blind review of x2, the
// Gentle Shell inline solutions ranked below Codex on tests: they skipped the
// empty-stdout check, put the bad row last (no proof that later valid rows are
// not saved), missed the empty value, and asserted internal storage instead of
// the public output. The verify-backed arm ranked first because verify's probe
// checklist covers exactly these. Writers and inline work get the same
// checklist for the tests they write. Instruction-delivery contract only.

const TEST_RULE = [
	"Each test asserts every observable effect of the rule it covers",
	"exit code, exact stdout and stderr",
	"rejected input leaves stored data and counters unchanged",
	"covers the cases the rule itself names (its examples, boundaries, and errors)",
	"through the public interface, never internal storage",
];

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");

test("T26: the always-on Implement step gives inline work the test checklist", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const step = __testing.buildGentlePrompt(persona).split("\n").find((line) => line.startsWith("6. **Implement"));
		assert.ok(step, "ODD step 6 Implement is missing");
		for (const clause of TEST_RULE) assert.ok(step.includes(clause), `${persona} Implement step is missing: ${clause}`);
	}
});

test("T26: the worker test discipline carries the same checklist", () => {
	const worker = read("assets/agents/gentle-ai-worker.md");
	for (const clause of TEST_RULE) assert.ok(worker.includes(clause), `worker test discipline is missing: ${clause}`);
	assert.ok(!worker.includes("add the smallest behavior-level test"), "RED must not ask for the smallest test");
});

// T26b (L56): blind review of x5 ranked Codex above the inline Gentle Shell
// arms partly because they added options without updating help and README.
test("T26b: inline and delegated work update the help and docs that describe a changed option", () => {
	const clause = "When you add or change a command, option, or message, update the help text and docs that describe it";
	for (const persona of ["gentleman", "neutral"] as const) {
		const step = __testing.buildGentlePrompt(persona).split("\n").find((line) => line.startsWith("6. **Implement"));
		assert.ok(step?.includes(clause), `${persona} Implement step is missing the docs rule`);
	}
	assert.ok(read("assets/agents/gentle-ai-worker.md").includes(clause), "worker is missing the docs rule");
});

// T27 (L56): in `pi --mode json` the runtime already rejects background
// launches (T18), but the prompt still said "Background subagent policy: on",
// so B-bg tried background twice and took the parallel-writer path; its worker
// shipped the silent `budget set --year` defect. Single-shot hosts render off.
test("T27: single-shot host modes render the background policy as off", () => {
	for (const mode of ["json", "print"]) {
		const prompt = __testing.buildGentlePrompt("gentleman", process.cwd(), undefined, undefined, mode);
		assert.match(prompt, /Background subagent policy: off \(single-shot mode\)/, `${mode} must render off`);
	}
	for (const mode of ["tui", "rpc", undefined]) {
		const prompt = __testing.buildGentlePrompt("gentleman", process.cwd(), undefined, undefined, mode);
		assert.doesNotMatch(prompt, /single-shot mode/, `${String(mode)} must keep the configured policy`);
	}
});

// T28b (L60-L62): a fixed quota of generic edge cases is test padding. Every
// real defect in the blind reviews came from a case derived from the request
// or from an existing command the change touched (budget set --year, edit
// --amount ignored), never from an invented edge. Tests are derived: one per
// requested rule with the cases it names, plus one per touched existing
// command or option proving its previous behavior still holds. Nothing else.
const PRESERVE = "For every existing command or option the change touches, add one test proving its previous behavior still holds; add no other cases";
test("T28b: inline test-first derives cases from the rules and touched commands, with no edge-case quota", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		const principle = prompt.split("\n").find((line) => line.includes("use test-first by default"));
		assert.ok(principle?.includes("observe RED, GREEN, then refactor with focused checks"), `${persona} principle keeps RED, GREEN, refactor`);
		assert.ok(principle?.includes("one RED test per requested rule"), `${persona} principle must ask for one RED test per rule`);
		assert.ok(principle?.includes(PRESERVE), `${persona} principle must add the preserve test`);
		assert.doesNotMatch(prompt, /TRIANGULATE|at least two edge cases/, `${persona} prompt must not keep the edge-case quota`);
	}
});

test("T28b: the worker preserves touched behavior instead of inventing edge cases", () => {
	const worker = read("assets/agents/gentle-ai-worker.md");
	assert.ok(worker.includes(`3. PRESERVE — ${PRESERVE}`), "worker step 3 must be PRESERVE");
	assert.doesNotMatch(worker, /at least two edge cases|3\. TRIANGULATE/, "worker must not keep the edge-case quota");
});

// T31 (L68-L70): T30 named a CLI-parser case and did not work (0/2 probes
// wrote the sibling test); it was fixture-specific. Replaced with the general
// definition of "touched", and high-risk item 3 now separates a requested
// contract change (covered by the request's tests) from existing behavior
// nobody asked to change that shares the changed code (the real regressions).
const TOUCHED = "An existing behavior counts as touched when it shares the code you changed (options, parsers, helpers, validation)";
test("T31: PRESERVE uses the general definition of touched, not a parser-specific case", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.ok(prompt.includes(TOUCHED), `${persona} prompt must define touched behavior`);
		assert.doesNotMatch(prompt, /shared parser or command, test that every sibling subcommand/, `${persona} must drop the T30 parser case`);
	}
	const worker = read("assets/agents/gentle-ai-worker.md");
	assert.ok(worker.includes(TOUCHED), "worker must define touched behavior");
	assert.doesNotMatch(worker, /shared parser or command, test that every sibling subcommand/, "worker must drop the T30 parser case");
});

test("T31: high-risk item 3 is about unrequested breaks, not the requested change", () => {
	const core = read("assets/orchestrator.md");
	assert.ok(
		core.includes("requested changes are not; unrequested breaks in shared code are"),
		"item 3 must separate requested changes from unrequested breaks",
	);
});

// T33 (L74): in p31 x5 both runs declared `Risk: none` after adding --year to
// the shared budget options; one shipped `budget set --year` silently saving a
// wrong budget, the regression verify used to catch. The Risk line must check
// shared code before claiming none.
const SHARED_CHECK = "Before writing `Risk: none`, check whether your diff changes code that existing behavior the request did not mention also uses (shared options, parsers, helpers); if it does, that is item 3";
test("T33: the Close step checks shared code before Risk: none", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const step = __testing.buildGentlePrompt(persona).split("\n").find((line) => line.startsWith("7. **Close"));
		assert.ok(step?.includes(SHARED_CHECK), `${persona} Close step must check shared code before Risk: none`);
	}
});
