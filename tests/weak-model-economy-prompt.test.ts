import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// odd/tasks/weak-model-economy.md S2-S4: bench C-econ and C-risk wording, asserted in the
// rendered primary-session prompt (S1, the todo block, is covered in gentle-todo.test.ts).

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");

test("S2: the differential check runs only when shared code an unnamed command uses changes", () => {
	const gated = "Only when your diff changes shared code (options, parsers, helpers) that an existing command the request did not name also uses, run one differential check before finishing, as a single script: for each such command,";
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.ok(prompt.includes(gated), `${persona} prompt must gate the differential check`);
		assert.ok(!prompt.includes("Before finishing, run a differential check"), `${persona} prompt keeps the ungated check`);
	}
	const worker = read("assets/agents/gentle-ai-worker.md");
	assert.ok(worker.includes(gated), "worker PRESERVE step must gate the differential check");
	assert.ok(!worker.includes("Before finishing, run a differential check"), "worker keeps the ungated check");
});

test("S3: the small path reads one batch and runs its checks in one command", () => {
	const prompt = __testing.buildGentlePrompt("gentleman");
	assert.ok(prompt.includes("Small path: inline (parent; `bash_background` policy); read only what you change and its helpers, in one batch; observe RED inline before the fix; run the focused test and the suite inline in one command."));
});

test("S4: high-risk item 1 covers only data someone cannot rebuild", () => {
	const prompt = __testing.buildGentlePrompt("gentleman");
	assert.ok(prompt.includes("(1) data or irreversible effects that cannot be rebuilt (migrations, rewriting or deleting stored data, format changes, writing data without validation; not saving new records, nor a dev or test database a seed or backup rebuilds);"));
});
