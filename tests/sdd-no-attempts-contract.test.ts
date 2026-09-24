import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("ordinary SDD instructions keep native selection and TDD without attempt launch governance", () => {
	const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
	const workflow = read("assets/sdd-orchestrator-workflow.md");
	const status = read("assets/support/sdd-status-contract.md");
	for (const text of [workflow, status, read("assets/agents/sdd-remediate.md")]) {
		assert.doesNotMatch(text, /sdd-attempt (acquire|settle)|Native Runtime Attempt Authority|compact acquire\/settle/);
	}
	assert.match(workflow, /Strict TDD/);
	assert.match(status, /native.*authoritative|authoritative.*native/i);
	assert.match(status, /edit.*grant|grant.*edit/i);
});
