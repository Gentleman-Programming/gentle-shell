import assert from "node:assert/strict";
import test from "node:test";
import { deriveProjectMapIntegrationReadiness, PROJECT_MAP_INTEGRATION_GATING_CHECKS, PROJECT_MAP_INTEGRATION_REPORTED_CHECKS, type ProjectMapIntegrationInput } from "../lib/project-map-integration.ts";

function input(overrides: Partial<ProjectMapIntegrationInput> = {}): ProjectMapIntegrationInput {
	return {
		map: {
			capabilities: [
				{ id: "catalog", outcome: "Merchants can publish a catalog.", state: "active", dependsOn: [], contracts: [], featureDocs: ["odd/tasks/catalog.md"] },
				{ id: "checkout", outcome: "Shoppers can check out.", state: "ready", dependsOn: ["catalog"], contracts: [], featureDocs: ["odd/tasks/checkout.md"] },
			],
		},
		coordination: {
			satellites: [],
			capabilities: [
				{ capabilityId: "catalog", dependencyReady: true, complete: true, openBlockers: 0, proposedContracts: 0, nextSafeAction: "integrate" },
				{ capabilityId: "checkout", dependencyReady: false, complete: false, openBlockers: 0, proposedContracts: 0, nextSafeAction: "wait-for-dependency" },
			],
			conflicts: [],
		},
		worktreeBindings: [{ capabilityId: "catalog", sessionId: "session-a", branch: "feat/catalog", worktreeRoot: "/projects/shop-worktrees/catalog", baseCommit: "a".repeat(40) }],
		verification: { testCommand: "pnpm test" },
		target: "main",
		review: new Map([["catalog", { lineages: 1 }]]),
		tasks: new Map([["catalog", { path: "odd/tasks/catalog.md", done: 3, total: 3 }]]),
		checks: new Map([["catalog", { freshness: "verified", conflicts: "verified", tasks: "verified", review: "verified" }]]),
		...overrides,
	};
}

test("an absent map reports nothing available and forwards the diagnostics it was given", () => {
	const diagnostic = { code: "project-map-store/unreadable-store", path: "$", message: "unreadable", severity: "error" as const };
	const result = deriveProjectMapIntegrationReadiness(input({ map: null, diagnostics: [diagnostic] }));
	assert.equal(result.available, false);
	assert.deepEqual(result.candidates, []);
	assert.deepEqual(result.diagnostics, [diagnostic]);
});

test("a dependency is ordered before the capability that depends on it", () => {
	const result = deriveProjectMapIntegrationReadiness(input());
	assert.deepEqual(result.candidates.map((candidate) => candidate.capabilityId), ["catalog", "checkout"]);
});

test("the order stays deterministic when nothing depends on anything", () => {
	const result = deriveProjectMapIntegrationReadiness(input({
		map: {
			capabilities: [
				{ id: "zulu", outcome: "Z", state: "active", dependsOn: [], contracts: [], featureDocs: [] },
				{ id: "alpha", outcome: "A", state: "active", dependsOn: [], contracts: [], featureDocs: [] },
			],
		},
		coordination: { satellites: [], capabilities: [], conflicts: [] },
		worktreeBindings: [],
	}));
	assert.deepEqual(result.candidates.map((candidate) => candidate.capabilityId), ["alpha", "zulu"]);
});

test("a done capability is not a candidate, and a blocked one is reported but never ready", () => {
	const result = deriveProjectMapIntegrationReadiness(input({
		map: {
			capabilities: [
				{ id: "shipped", outcome: "Shipped", state: "done", dependsOn: [], contracts: [], featureDocs: [] },
				{ id: "stuck", outcome: "Stuck", state: "blocked", dependsOn: [], contracts: [], featureDocs: [] },
			],
		},
		coordination: { satellites: [], capabilities: [], conflicts: [] },
		worktreeBindings: [],
	}));
	assert.deepEqual(result.candidates.map((candidate) => candidate.capabilityId), ["stuck"]);
	assert.equal(result.candidates[0]!.ready, false);
});

test("a capability the map declares but the projection does not cover carries no invented action", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		map: { capabilities: [{ id: "orphan", outcome: "Orphan", state: "active", dependsOn: [], contracts: [], featureDocs: [] }] },
		coordination: { satellites: [], capabilities: [], conflicts: [] },
		worktreeBindings: [],
	})).candidates;
	assert.equal(candidate!.nextSafeAction, null);
	assert.equal(candidate!.dependencyReady, false);
	assert.equal(candidate!.complete, false);
	assert.equal(candidate!.openBlockers, 0);
});

test("every check defaults to unverified, and an unverified check is never read as verified", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		coordination: {
			satellites: [],
			capabilities: [{ capabilityId: "catalog", dependencyReady: true, complete: true, openBlockers: 0, proposedContracts: 0, nextSafeAction: "integrate" }],
			conflicts: [],
		},
		checks: new Map(),
	})).candidates;
	assert.equal(candidate!.checks.freshness, "unverified");
	assert.equal(candidate!.checks.conflicts, "unverified");
	assert.equal(candidate!.checks.tasks, "unverified");
	assert.equal(candidate!.ready, false, "a candidate nobody verified is not ready");
});

test("a fully verified, unblocked, complete capability is ready", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input()).candidates;
	assert.equal(candidate!.capabilityId, "catalog");
	assert.equal(candidate!.ready, true);
	assert.deepEqual(candidate!.checks, {
		dependencies: "verified",
		contracts: "verified",
		blockers: "verified",
		coverage: "verified",
		freshness: "verified",
		conflicts: "verified",
		verification: "verified",
		tasks: "verified",
		review: "verified",
	});
});

test("an open blocker is a mismatch and keeps the candidate out of ready", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		coordination: {
			satellites: [],
			capabilities: [{ capabilityId: "catalog", dependencyReady: true, complete: true, openBlockers: 2, proposedContracts: 0, nextSafeAction: "resolve-blocker" }],
			conflicts: [],
		},
	})).candidates;
	assert.equal(candidate!.checks.blockers, "mismatched");
	assert.equal(candidate!.openBlockers, 2);
	assert.equal(candidate!.ready, false);
});

test("a proposed contract without a decision is a mismatch and keeps the candidate out of ready", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		coordination: {
			satellites: [],
			capabilities: [{ capabilityId: "catalog", dependencyReady: true, complete: true, openBlockers: 0, proposedContracts: 1, nextSafeAction: "decide-contract" }],
			conflicts: [],
		},
	})).candidates;
	assert.equal(candidate!.checks.contracts, "mismatched");
	assert.equal(candidate!.ready, false);
});

test("an unready dependency is a mismatch and keeps the candidate out of ready", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		coordination: {
			satellites: [],
			capabilities: [{ capabilityId: "catalog", dependencyReady: false, complete: true, openBlockers: 0, proposedContracts: 0, nextSafeAction: "wait-for-dependency" }],
			conflicts: [],
		},
	})).candidates;
	assert.equal(candidate!.checks.dependencies, "mismatched");
	assert.equal(candidate!.ready, false);
});

test("a capability with no readiness receipt is ready anyway, because the receipt is what this run produces", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		coordination: {
			satellites: [],
			capabilities: [{ capabilityId: "catalog", dependencyReady: true, complete: false, openBlockers: 0, proposedContracts: 0, nextSafeAction: "work" }],
			conflicts: [],
		},
	})).candidates;
	// The check still reports the fact; it no longer gates on its own product.
	assert.equal(candidate!.checks.coverage, "mismatched");
	assert.equal(candidate!.ready, true, "a missing receipt cannot block the run that issues it");
});

test("coverage and review are reported but never gate, and the gating set says so", () => {
	assert.deepEqual([...PROJECT_MAP_INTEGRATION_GATING_CHECKS], ["dependencies", "contracts", "blockers", "verification", "freshness", "conflicts", "tasks"]);
	assert.deepEqual([...PROJECT_MAP_INTEGRATION_REPORTED_CHECKS], ["coverage", "review"]);
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		coordination: {
			satellites: [],
			capabilities: [{ capabilityId: "catalog", dependencyReady: true, complete: false, openBlockers: 0, proposedContracts: 0, nextSafeAction: "work" }],
			conflicts: [],
		},
		review: new Map(),
	})).candidates;
	for (const name of PROJECT_MAP_INTEGRATION_REPORTED_CHECKS) assert.notEqual(candidate!.checks[name], undefined, `${name} is still reported`);
	assert.equal(candidate!.ready, true, "neither reported check can hold a candidate back");
});

test("the verification requirement is the project's own test command, and an undeclared one blocks ready", () => {
	const declared = deriveProjectMapIntegrationReadiness(input()).candidates[0]!;
	assert.deepEqual(declared.verification, { command: "pnpm test", source: "manifest" });
	assert.equal(declared.checks.verification, "verified");
	const undeclared = deriveProjectMapIntegrationReadiness(input({ verification: { testCommand: null } })).candidates[0]!;
	assert.deepEqual(undeclared.verification, { command: null, source: "not-declared" });
	assert.equal(undeclared.checks.verification, "unverified");
	assert.equal(undeclared.ready, false);
});

test("review evidence is reported but never gates, so a candidate with none can still be ready", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({
		review: new Map(),
		checks: new Map([["catalog", { freshness: "verified", conflicts: "verified", tasks: "verified" }]]),
	})).candidates;
	assert.equal(candidate!.review.lineages, 0);
	assert.equal(candidate!.checks.review, "unverified");
	assert.equal(candidate!.ready, true, "review is evidence, never authorization");
});

test("the branch, the worktree and the base commit come from the worktree binding", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input()).candidates;
	assert.equal(candidate!.branch, "feat/catalog");
	assert.equal(candidate!.worktreeRoot, "/projects/shop-worktrees/catalog");
	assert.equal(candidate!.baseCommit, "a".repeat(40));
});

test("a capability with no worktree binding reports its branch as unknown rather than guessing", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({ worktreeBindings: [] })).candidates;
	assert.equal(candidate!.branch, null);
	assert.equal(candidate!.worktreeRoot, null);
	assert.equal(candidate!.baseCommit, null);
});

test("the task document counts are carried so a mismatch can be judged later", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input()).candidates;
	assert.deepEqual(candidate!.tasks, { path: "odd/tasks/catalog.md", done: 3, total: 3 });
});

test("a capability with no task document reports none rather than an empty document", () => {
	const [candidate] = deriveProjectMapIntegrationReadiness(input({ tasks: new Map() })).candidates;
	assert.equal(candidate!.tasks, null);
});

test("a dependency cycle is reported and still yields a deterministic order", () => {
	const result = deriveProjectMapIntegrationReadiness(input({
		map: {
			capabilities: [
				{ id: "beta", outcome: "B", state: "active", dependsOn: ["alpha"], contracts: [], featureDocs: [] },
				{ id: "alpha", outcome: "A", state: "active", dependsOn: ["beta"], contracts: [], featureDocs: [] },
			],
		},
		coordination: { satellites: [], capabilities: [], conflicts: [] },
		worktreeBindings: [],
	}));
	assert.deepEqual(result.candidates.map((candidate) => candidate.capabilityId), ["alpha", "beta"]);
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0]!.severity, "warning");
	assert.match(result.diagnostics[0]!.message, /cycle/i);
});

test("the integration target is carried as read, and is null when it is unknown", () => {
	assert.equal(deriveProjectMapIntegrationReadiness(input()).target, "main");
	assert.equal(deriveProjectMapIntegrationReadiness(input({ target: null })).target, null);
});
