import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// Pain-point iteration S15. Bench evidence (pps14 x5): one run read "Two unrelated wishes" as separate
// deliverables, classified a two-feature request as large (branch, feature document, session state), and
// started two writers for ~100-line units: USD 0.55 against 0.20 for the run that stayed inline. Blind round 4
// also found delivered tests that pin `git show <baseline commit>`, so the differential check had leaked into
// committed tests that fail in another clone. These are instruction-delivery contracts, not proof of adherence.

const read = (path: string): string => readFileSync(join(import.meta.dirname, "..", path), "utf8");

test("S15 (a): separate deliverables are ones the user wants apart, not several features asked at once", () => {
	const core = read("assets/orchestrator.md");
	assert.ok(
		core.includes("deliverables the user wants apart (never several features asked at once)"),
		"Task Size must define separate deliverables",
	);
});

test("S15 (b): parallel writers never fire for units of about 100 changed lines or less", () => {
	const card = read("assets/orchestrator-delegation.md");
	assert.ok(
		card.includes("Units of about 100 changed lines or less always run inline: writing them costs less than starting workers."),
		"the Writer trigger must keep small units inline",
	);
});

test("S15 (c): the differential check runs in scratch and is never committed as a test", () => {
	const clause = "a copy of the base commit in a `mktemp -d` scratch directory, never committed as a test; committed tests never read git history or a fixed commit";
	const harness = __testing.buildGentlePrompt("neutral");
	assert.ok(harness.includes(clause), "the always-on test-first policy must keep the differential check in scratch");
	assert.ok(!harness.includes("(`git stash` or a copy of HEAD)"), "the harness must not suggest git stash or HEAD copies");
	assert.ok(read("assets/agents/gentle-ai-worker.md").includes(clause), "the worker must keep the differential check in scratch");
});
