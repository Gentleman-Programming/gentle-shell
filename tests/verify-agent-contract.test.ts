import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// gentle-shell#1731 T11 (S4, S5; L24): in the bench the independent verifier
// re-ran the writer's own tests and happy-path examples and missed defects that
// blind adversarial probes found (an import accepting invalid split groups; a
// budget ignoring refund parts whose own test locked the bug in). The verifier
// now derives its own probes from the spec. These are instruction-delivery
// contracts, not proof of model adherence.

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");
const verify = read("assets/agents/gentle-ai-verify.md");

function checklistItem(n: number): string {
	const line = verify.split("\n").find((entry) => entry.startsWith(`${n}. **`));
	assert.ok(line, `verify checklist item ${n} is missing`);
	return line;
}

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

test("T11.1: verify derives its own probes from every numbered rule and never trusts the writer's tests", () => {
	assert.ok(verify.includes("The writer's tests and examples are never evidence of correctness"), "verify must not treat the writer's tests as evidence");
	containsAll(checklistItem(1), [
		"verbatim request",
		"every numbered rule or requirement",
		"derive your own probes",
		"positive examples",
		"negative and boundary cases",
		"exact error messages and exit codes",
	], "probe item");
});

test("T11.2: verify checks stored-data and legacy-output invariants against the baseline", () => {
	containsAll(checklistItem(2), [
		"after every rejected or failing command",
		"byte-identical",
		"hash before and after",
		"commands that existed before the change",
		"same output as at the baseline commit",
		"unless the request changes them",
	], "invariant item");
});

test("T11.3: verify probes the cross-feature interactions the request implies", () => {
	containsAll(checklistItem(3), ["cross-feature interactions", "new data", "existing reports, totals, and exports"], "interaction item");
});

test("T11.4: verify runs the typecheck or build and flags scope creep", () => {
	containsAll(checklistItem(4), ["typecheck or build", "when the project has one", "outside the request's scope"], "build and scope item");
});

test("T11.5: verify returns a verdict for every spec item with no partial-scope carve-out", () => {
	containsAll(checklistItem(5), [
		"verdict for EVERY spec item",
		"met, unmet, or not implemented",
		"no partial-scope carve-out",
		"even when the parent named one task or unit",
		"the parent resolves every unmet item before closing, with one correction batch and one recheck limited to the reported blockers",
	], "verdict item");
	assert.ok(verify.includes("verdict per `S#`"), "the feature-document verdict per S# must stay");
});

test("T11.6: verify leaves its probes as regression tests the writer commits", () => {
	containsAll(checklistItem(6), [
		"regression tests",
		"the project's test suite",
		"the writer to commit",
		"you never write them",
	], "durable probe item");
});

// T16 replaced "Run every probe only through command forms the parent authorized and only on isolated state the
// parent named": probes now run on the first launch in a fresh scratch copy (verify-first-launch-contract).
test("T11: probes stay inside the authorized commands or the scratch copy, and verify stays read-only", () => {
	containsAll(verify, [
		"execute only exact test, build, lint, or spec example commands explicitly authorized by the parent",
		"only inside your scratch copy or on isolated state the parent named",
		"report that probe as unverified with its exact command instead of running it",
		"Do not edit, write, or fix findings.",
		"Treat every unexpected mutation as a blocker",
		"at most ~2k tokens",
	], "verify agent");
	const tools = verify.split("---")[1] ?? "";
	assert.ok(!/\n {2}- (edit|write)\n/.test(tools), "verify must not gain edit or write tools");
});
