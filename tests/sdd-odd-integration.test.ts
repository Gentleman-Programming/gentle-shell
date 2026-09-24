import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("integrated organic continuity and selected SDD keep separate persistence ownership", () => {
	const memory = read("assets/orchestrator-memory.md");
	assert.match(memory, /one feature document, not a separate plan file or topic/);
	assert.match(memory, /odd\/tasks\/<feature-name>\.md/);
	assert.match(memory, /odd\/<feature-name>\/tasks/);
	assert.match(memory, /Research is output-only/);
	assert.match(memory, /Except for output-only `sdd-research`/);
	assert.match(memory, /do not switch the selected store/);
	const delegation = read("assets/orchestrator-delegation.md");
	assert.match(delegation, /organic work, not explicitly selected SDD/);
	assert.match(delegation, /do not create a specialized agent or invoke `sdd-research`/);
	assert.match(read("assets/agents/sdd-research.md"), /Do not read local artifacts/);
	assert.match(read("assets/sdd-orchestrator-workflow.md"), /Optional research takes precedence/);
});

test("integrated TDD guidance preserves native SDD completion without retired consumers", () => {
	const wrapper = read("extensions/gentle-ai.ts"), tasks = read("assets/agents/sdd-tasks.md");
	assert.match(wrapper, /Use configured TDD mode, source, and exact runner/);
	assert.doesNotMatch(wrapper + tasks, /If tests exist(?:, use strict TDD| or strict TDD)/);
	assert.match(tasks, /Only when configured strict TDD is active/);
	assert.match(read("assets/agents/sdd-apply.md"), /native task progress and authorized scope/);
	assert.match(read("assets/agents/sdd-verify.md"), /Archive admission follows fresh native status and real permissions/);
	assert.match(read("assets/chains/sdd-full.chain.md"), /apply -> archive/);
	for (const path of ["assets/agents/sdd-sync.md", "lib/openspec-guardrails.ts"]) {
		assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
	}
});
