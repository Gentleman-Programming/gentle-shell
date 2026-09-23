import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guidancePaths = [
	"assets/support/sdd-status-contract.md",
	"assets/sdd-orchestrator-workflow.md",
	"assets/agents/sdd-status.md",
	"assets/agents/sdd-verify.md",
	"assets/agents/sdd-archive.md",
];

for (const path of guidancePaths) {
	test(`${path}: native v2 status remains read-only and authoritative`, () => {
		const guidance = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
		assert.match(guidance, /native.*(?:status|v2)|gentle-ai\.sdd-status/i);
		assert.match(guidance, /read-only/i);
		assert.doesNotMatch(guidance, /resolve-via-engram/i);
		assert.doesNotMatch(guidance, /local SDD status engine|manual (?:fallback )?status|reconstruct(?:ing)? (?:native )?status/i);
	});
}

test("workflow preserves explicit continuation and native-only classical completion", () => {
	const workflow = readFileSync(new URL("../assets/sdd-orchestrator-workflow.md", import.meta.url), "utf8");
	assert.match(workflow, /only.*sdd-continue|sdd-continue.*only/i);
	assert.doesNotMatch(workflow, /manual sdd-sync|local resolver/i);
	assert.match(workflow, /verification is optional/);
	assert.doesNotMatch(workflow, /sdd-(?:apply|verify|archive).*local|local.*sdd-(?:apply|verify|archive)/i);
});

test("archive owns composition without mandatory verification or a standalone sync receipt", () => {
	const archive = readFileSync(new URL("../assets/agents/sdd-archive.md", import.meta.url), "utf8");
	const full = readFileSync(new URL("../assets/chains/sdd-full.chain.md", import.meta.url), "utf8");
	assert.doesNotMatch(full, /^## sdd-(verify|sync)$/m);
	assert.match(full, /apply -> archive/);
	assert.match(archive, /missing optional report is not a blocker/);
	assert.match(archive, /no separate sync phase or successful sync-report artifact is required/);
	for (const guard of ["Final Task Completion Gate", "allowed edit roots", "resolved symlink targets", "existing archive destination",
		"ADDED Requirements", "MODIFIED Requirements", "REMOVED Requirements", "RENAMED Requirements",
		"explicit composition/archive order", "explicit approval for the destructive sync", "dependsOn", "rules.sync",
		"archive-report", "observation-ID traceability", "Preserve every canonical requirement not mentioned by the delta"]) {
		assert.ok(archive.includes(guard), `archive retains ${guard}`);
	}
});
