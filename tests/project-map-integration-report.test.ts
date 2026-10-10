import assert from "node:assert/strict";
import test from "node:test";
import { deriveProjectMapIntegrationReadiness, renderProjectMapIntegrationReport, type ProjectMapIntegrationInput } from "../lib/project-map-integration.ts";

function input(overrides: Partial<ProjectMapIntegrationInput> = {}): ProjectMapIntegrationInput {
	return {
		map: {
			capabilities: [
				{ id: "catalog", outcome: "Catalog", state: "active", dependsOn: [], contracts: [], featureDocs: ["odd/tasks/catalog.md"] },
				{ id: "checkout", outcome: "Checkout", state: "ready", dependsOn: [], contracts: [], featureDocs: ["odd/tasks/checkout.md"] },
			],
		},
		coordination: {
			satellites: [],
			capabilities: [
				{ capabilityId: "catalog", dependencyReady: true, complete: true, openBlockers: 0, proposedContracts: 0, nextSafeAction: "integrate" },
				{ capabilityId: "checkout", dependencyReady: true, complete: true, openBlockers: 0, proposedContracts: 0, nextSafeAction: "integrate" },
			],
			conflicts: [],
		},
		worktreeBindings: [
			{ capabilityId: "catalog", sessionId: "session-a", branch: "feat/catalog", worktreeRoot: "/w/catalog", baseCommit: "a".repeat(40) },
			{ capabilityId: "checkout", sessionId: "session-b", branch: "feat/checkout", worktreeRoot: "/w/checkout", baseCommit: "b".repeat(40) },
		],
		verification: { testCommand: "pnpm test" },
		target: "main",
		review: new Map([["catalog", { lineages: 1 }]]),
		tasks: new Map([
			["catalog", { path: "odd/tasks/catalog.md", done: 3, total: 3 }],
			["checkout", { path: "odd/tasks/checkout.md", done: 1, total: 4 }],
		]),
		checks: new Map([
			["catalog", { freshness: "verified", conflicts: "verified", tasks: "verified", review: "verified" }],
			["checkout", { freshness: "verified", conflicts: "mismatched", tasks: "verified", review: "unverified" }],
		]),
		evidence: new Map([
			["catalog", { behindBy: 7 }],
			["checkout", { behindBy: 2, overlaps: ["lib/b.ts"] }],
		]),
		...overrides,
	};
}

const report = (overrides: Partial<ProjectMapIntegrationInput> = {}) => renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input(overrides))).join("\n");

test("an unavailable readiness says so instead of printing an empty report", () => {
	const lines = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input({ map: null })));
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /could not be read/i);
});

test("the report names the integration target it measured against", () => {
	assert.match(report().split("\n")[0]!, /Integration readiness → main/);
});

test("an unknown target is said to be unknown rather than left blank", () => {
	assert.match(report({ target: null }).split("\n")[0]!, /target unknown/);
});

test("every candidate names its capability, its branch and its declared state", () => {
	const text = report();
	assert.match(text, /✓ catalog · feat\/catalog · active/);
	assert.match(text, /✕ checkout · feat\/checkout · ready/);
});

test("a ready candidate is marked as the next safe integration action", () => {
	assert.match(report(), /Next safe integration action: catalog/);
});

test("a ready candidate is the first one whose checks all verified, not merely the first one", () => {
	const text = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input({
		checks: new Map([
			["catalog", { freshness: "unverified", conflicts: "unverified", tasks: "unverified" }],
			["checkout", { freshness: "verified", conflicts: "verified", tasks: "verified", review: "verified" }],
		]),
	}))).join("\n");
	assert.match(text, /Next safe integration action: checkout/);
});

test("with nothing ready the report says so instead of naming a candidate", () => {
	const text = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input({ checks: new Map() }))).join("\n");
	assert.match(text, /Next safe integration action: none/);
});

test("a mismatched check is named with the reason it mismatched", () => {
	assert.match(report(), /mismatch: conflicts — .*lib\/b\.ts/);
});

test("coverage is reported as evidence and never as a mismatch, because it is this run's own output", () => {
	const without = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input({
		coordination: {
			satellites: [],
			capabilities: [
				{ capabilityId: "catalog", dependencyReady: true, complete: false, openBlockers: 0, proposedContracts: 0, nextSafeAction: "work" },
				{ capabilityId: "checkout", dependencyReady: true, complete: true, openBlockers: 0, proposedContracts: 0, nextSafeAction: "integrate" },
			],
			conflicts: [],
		},
	}))).join("\n");
	assert.match(without, /coverage: no readiness receipt recorded yet/);
	assert.equal(/mismatch: coverage/.test(without), false, "coverage never appears as a mismatch");
	assert.match(without, /✓ catalog/, "and it cannot keep a candidate out of ready");
	assert.match(without, /Next safe integration action: /);
	const with_ = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input())).join("\n");
	assert.match(with_, /coverage: a readiness receipt already covers it/);
});

test("unverified checks are named, so a reader can tell them from verified ones", () => {
	const text = report();
	assert.match(text, /unverified: .*review/);
});

test("an unverified check explains why it is unverified, because some of them never can be", () => {
	const text = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input({
		reasons: new Map([["checkout", { review: "the review store records candidates, not capabilities" }]]),
	}))).join("\n");
	assert.match(text, /    review: the review store records candidates, not capabilities/);
});

test("the distance behind the target is reported when it was measured", () => {
	const text = report();
	assert.match(text, /behind main by 7/);
	assert.match(text, /behind main by 2/);
});

test("the verification requirement and the task counts are shown per candidate", () => {
	const text = report();
	assert.match(text, /verification: pnpm test/);
	assert.match(text, /tasks: odd\/tasks\/catalog\.md 3\/3/);
	assert.match(text, /tasks: odd\/tasks\/checkout\.md 1\/4/);
});

test("review evidence is shown, and a candidate with none says so rather than showing zero", () => {
	const text = report();
	assert.match(text, /review: 1 lineage/);
	assert.match(text, /review: none recorded/);
});

test("the report always ends by saying that readiness grants nothing", () => {
	const lines = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input()));
	assert.match(lines[lines.length - 1]!, /grants nothing/i);
	assert.match(lines[lines.length - 1]!, /commit, push, PR and merge/);
});

test("the limit caps how many candidates are printed and says what it left out", () => {
	const lines = renderProjectMapIntegrationReport(deriveProjectMapIntegrationReadiness(input()), { limit: 1 });
	const text = lines.join("\n");
	assert.match(text, /catalog/);
	assert.doesNotMatch(text, /checkout · feat\/checkout/);
	assert.match(text, /1 more candidate not shown/);
});

test("the report is deterministic for the same readiness", () => {
	assert.equal(report(), report());
});
