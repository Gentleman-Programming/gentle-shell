import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("ODD continuity persists the task file and complete Engram mirror across resume", () => {
	const memory = read("assets/orchestrator-memory.md");
	assert.match(memory, /one feature document, not a separate plan file or topic/);
	assert.match(memory, /odd\/tasks\/<feature-name>\.md/);
	assert.match(memory, /odd\/<feature-name>\/tasks/);
	assert.match(memory, /Mirror the full current document and repository-relative file locator/);
	assert.match(memory, /Read back both writes; they are not atomic/);
	assert.match(memory, /mirror pending/);
	assert.match(memory, /On resume, use `mem_context`, then project\/feature-scoped `mem_search`, and `mem_get_observation`/);
	assert.match(memory, /read the actual task file/);
});

test("optional research stays output-only and delegates to a general worker", () => {
	const delegation = read("assets/orchestrator-delegation.md");
	assert.match(delegation, /Recommend optional research only for a named uncertainty/);
	assert.match(delegation, /Forward these research instructions to an existing fresh general exploration\/research worker/);
	assert.match(delegation, /Research remains read-only and requires no new persistence or readiness machinery/);
	assert.match(delegation, /If tools are unavailable, disclose limitations without inventing access or evidence/);
});

test("configured strict TDD source and exact runner flow through the wrapper, support, worker and verifier", () => {
	const wrapper = read("extensions/gentle-ai.ts");
	const delegation = read("assets/orchestrator-delegation.md");
	const support = read("assets/support/strict-tdd.md");
	const worker = read("assets/agents/gentle-ai-worker.md");
	const verifier = read("assets/agents/gentle-ai-verify.md");
	assert.match(wrapper, /Use configured TDD mode, source, and exact runner; test presence does not enable it/);
	assert.match(delegation, /Resolve effective TDD on\/off from existing project\/session configuration or explicit user choice; retain its source and exact test runner/);
	assert.match(delegation, /Forward mode, source, and runner on every implementation delegation/);
	assert.match(support, /retained configured TDD source and runner forwarded by the parent/);
	assert.match(support, /If either is missing or conflicting, stop and ask the parent to resolve it/);
	assert.match(worker, /Consume the parent's effective TDD mode, configuration\/choice source, and exact runner/);
	assert.match(worker, /RED — add the smallest behavior-level test and capture its intended observed failure/);
	assert.match(verifier, /execute only exact test, build, or lint commands explicitly authorized by the parent/);
	assert.doesNotMatch(wrapper + delegation + support + worker + verifier, /If tests exist(?:, use strict TDD| or strict TDD)/);
});

test("retired SDD routes and assets are absent while ODD entry and generic workers remain", () => {
	const core = read("assets/orchestrator.md");
	const delegation = read("assets/orchestrator-delegation.md");
	assert.match(core, /ODD \(Default Workflow, harness section above\) is mandatory on every request/);
	assert.match(delegation, /generic writer chain is unavailable/);
	for (const path of [
		"assets/agents/gentle-ai-worker.md",
		"assets/agents/gentle-ai-verify.md",
		"assets/support/strict-tdd.md",
	]) assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, path);
	for (const path of [
		"assets/sdd-orchestrator-workflow.md",
		"assets/support/sdd-status-contract.md",
		"assets/agents/sdd-apply.md",
		"assets/agents/sdd-research.md",
		"assets/chains/sdd-full.chain.md",
		"assets/chains/sdd-plan.chain.md",
		"assets/chains/sdd-verify.chain.md",
	]) assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
	assert.doesNotMatch(core + delegation + read("extensions/gentle-ai.ts"), /(?:\/sdd-(?:init|explore|status|apply|verify|archive)|sdd-full\.chain|sdd-orchestrator-workflow\.md)/);
});
