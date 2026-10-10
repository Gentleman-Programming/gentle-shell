import assert from "node:assert/strict";
import test from "node:test";
import { deriveOrchestratorSessionTabs, type OrchestratorSessionTabsInput, type OrchestratorSessionTabsDiagnostic } from "../lib/shell-project-map-tabs.ts";

function input(overrides: Partial<OrchestratorSessionTabsInput> = {}): OrchestratorSessionTabsInput {
	return {
		map: {
			capabilities: [
				{ id: "catalog", outcome: "Merchants can publish a catalog.", surfaces: ["web", "api", "data"], state: "active" },
				{ id: "cart", outcome: "Shoppers can build a cart.", surfaces: ["web"], state: "ready" },
			],
		},
		satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "live", heartbeat: "fresh" }],
		capabilities: [{ capabilityId: "catalog", openBlockers: 0, nextSafeAction: "work" }],
		worktreeBindings: [{ capabilityId: "catalog", sessionId: "session-42", branch: "feat/catalog", worktreeRoot: "/projects/shop-worktrees/catalog" }],
		presenceAlive: null,
		lastActivity: new Map([["session-42", "2026-09-26T20:00:00.000Z"]]),
		...overrides,
	};
}

test("an absent map renders no tabs and says the store is unavailable", () => {
	const result = deriveOrchestratorSessionTabs(input({ map: null }));
	assert.equal(result.available, false);
	assert.deepEqual(result.sections, []);
});

test("an absent map still forwards the diagnostics it was given", () => {
	const forwarded: OrchestratorSessionTabsDiagnostic = { code: "project-map-store/unreadable-store", path: "$.store", message: "unreadable", severity: "error" };
	const result = deriveOrchestratorSessionTabs(input({ map: null, diagnostics: [forwarded] }));
	assert.deepEqual(result.diagnostics, [forwarded]);
});

test("a live satellite on a mapped capability becomes one tab in every surface it declares", () => {
	const result = deriveOrchestratorSessionTabs(input());
	assert.equal(result.available, true);
	assert.deepEqual(result.sections.map((section) => section.surface), ["web", "api", "data"]);
	for (const section of result.sections) {
		assert.deepEqual(section.tabs.map((tab) => tab.capabilityId), ["catalog"]);
	}
});

test("sections follow the schema's surface order, not the declared order", () => {
	const result = deriveOrchestratorSessionTabs(input({
		map: { capabilities: [{ id: "catalog", outcome: "Outcome", surfaces: ["tests", "web", "api"], state: "active" }] },
	}));
	assert.deepEqual(result.sections.map((section) => section.surface), ["web", "api", "tests"]);
});

test("a tab carries the objective, declared state, worktree, branch and activity", () => {
	const [section] = deriveOrchestratorSessionTabs(input()).sections;
	const [tab] = section.tabs;
	assert.equal(tab.outcome, "Merchants can publish a catalog.");
	assert.equal(tab.state, "active");
	assert.equal(tab.worktreeRoot, "/projects/shop-worktrees/catalog");
	assert.equal(tab.branch, "feat/catalog");
	assert.equal(tab.lastActivity, "2026-09-26T20:00:00.000Z");
	assert.equal(tab.openBlockers, 0);
	assert.equal(tab.nextSafeAction, "work");
});

test("a surface whose only sessions are stale gets no section", () => {
	const result = deriveOrchestratorSessionTabs(input({
		satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "stale", heartbeat: "stale" }],
	}));
	assert.deepEqual(result.sections, []);
});

test("a stale session stays visible inside a section that a live session keeps on screen", () => {
	const result = deriveOrchestratorSessionTabs(input({
		satellites: [
			{ capabilityId: "catalog", sessionId: "session-42", status: "live", heartbeat: "fresh" },
			{ capabilityId: "catalog", sessionId: "session-41", status: "stale", heartbeat: "missing" },
		],
	}));
	const [section] = result.sections;
	assert.deepEqual(section.tabs.map((tab) => [tab.sessionId, tab.liveness]), [["session-41", "stale"], ["session-42", "live"]]);
});

test("without presence the store's own status decides liveness", () => {
	const result = deriveOrchestratorSessionTabs(input({
		satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "stale", heartbeat: "stale" }],
		presenceAlive: null,
	}));
	// The surface has no live session, so nothing is on screen; the status is what hid it.
	assert.deepEqual(result.sections, []);
});

test("presence overrides a stale lease and can keep the section on screen", () => {
	const result = deriveOrchestratorSessionTabs(input({
		satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "stale", heartbeat: "stale" }],
		presenceAlive: new Set(["session-42"]),
	}));
	assert.deepEqual(result.sections.map((section) => section.surface), ["web", "api", "data"]);
	assert.equal(result.sections[0].tabs[0].liveness, "live");
});

test("presence overrides a live lease and reports the session as stale", () => {
	const result = deriveOrchestratorSessionTabs(input({
		satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "live", heartbeat: "fresh" }],
		presenceAlive: new Set(["session-99"]),
	}));
	assert.deepEqual(result.sections, []);
});

test("a capability the map does not declare is dropped with a warning naming it", () => {
	const result = deriveOrchestratorSessionTabs(input({
		satellites: [{ capabilityId: "ghost", sessionId: "session-7", status: "live", heartbeat: "fresh" }],
	}));
	assert.deepEqual(result.sections, []);
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0].severity, "warning");
	assert.equal(result.diagnostics[0].code, "orchestrator-session-tabs/unknown-capability");
	assert.match(result.diagnostics[0].message, /ghost/);
});

test("a session with no worktree binding still renders, with its worktree left unknown", () => {
	const [tab] = deriveOrchestratorSessionTabs(input({ worktreeBindings: [] })).sections[0].tabs;
	assert.equal(tab.worktreeRoot, null);
	assert.equal(tab.branch, null);
});

test("the store keeps one worktree binding per capability, so a binding written by another session still names this capability's worktree", () => {
	const [tab] = deriveOrchestratorSessionTabs(input({
		satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "live", heartbeat: "fresh" }],
		worktreeBindings: [{ capabilityId: "catalog", sessionId: "session-41", branch: "feat/other", worktreeRoot: "/projects/shop-worktrees/other" }],
	})).sections[0].tabs;
	assert.equal(tab.branch, "feat/other");
	assert.equal(tab.worktreeRoot, "/projects/shop-worktrees/other");
});

test("when a capability somehow has two bindings, the one belonging to this session wins", () => {
	const [tab] = deriveOrchestratorSessionTabs(input({
		satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "live", heartbeat: "fresh" }],
		worktreeBindings: [
			{ capabilityId: "catalog", sessionId: "session-41", branch: "feat/stale", worktreeRoot: "/projects/shop-worktrees/stale" },
			{ capabilityId: "catalog", sessionId: "session-42", branch: "feat/catalog", worktreeRoot: "/projects/shop-worktrees/catalog" },
		],
	})).sections[0].tabs;
	assert.equal(tab.branch, "feat/catalog");
	assert.equal(tab.worktreeRoot, "/projects/shop-worktrees/catalog");
});

test("a session with no heartbeat instant reports no activity rather than inventing one", () => {
	const [tab] = deriveOrchestratorSessionTabs(input({ lastActivity: new Map() })).sections[0].tabs;
	assert.equal(tab.lastActivity, null);
});

test("a capability absent from the coordination projection keeps zero blockers and no invented action", () => {
	const [tab] = deriveOrchestratorSessionTabs(input({ capabilities: [] })).sections[0].tabs;
	assert.equal(tab.openBlockers, 0);
	assert.equal(tab.nextSafeAction, null);
});

test("tabs inside a section are ordered by capability id and then by session id", () => {
	const result = deriveOrchestratorSessionTabs(input({
		map: {
			capabilities: [
				{ id: "cart", outcome: "Cart outcome", surfaces: ["web"], state: "ready" },
				{ id: "catalog", outcome: "Catalog outcome", surfaces: ["web"], state: "active" },
			],
		},
		satellites: [
			{ capabilityId: "cart", sessionId: "session-9", status: "live", heartbeat: "fresh" },
			{ capabilityId: "catalog", sessionId: "session-9", status: "live", heartbeat: "fresh" },
			{ capabilityId: "cart", sessionId: "session-2", status: "live", heartbeat: "fresh" },
		],
	}));
	const [section] = result.sections;
	assert.deepEqual(section.tabs.map((tab) => [tab.capabilityId, tab.sessionId]), [
		["cart", "session-2"],
		["cart", "session-9"],
		["catalog", "session-9"],
	]);
});

test("the projection reports nothing as available when the map declares no capability", () => {
	const result = deriveOrchestratorSessionTabs(input({ map: { capabilities: [] }, satellites: [] }));
	assert.equal(result.available, true);
	assert.deepEqual(result.sections, []);
	assert.deepEqual(result.diagnostics, []);
});

test("an empty map still warns about a session holding a capability it does not declare", () => {
	const result = deriveOrchestratorSessionTabs(input({ map: { capabilities: [] } }));
	assert.deepEqual(result.sections, []);
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0].code, "orchestrator-session-tabs/unknown-capability");
});

test("the same session bound to two capabilities gets one tab per capability", () => {
	const result = deriveOrchestratorSessionTabs(input({
		map: {
			capabilities: [
				{ id: "catalog", outcome: "Catalog outcome", surfaces: ["web"], state: "active" },
				{ id: "cart", outcome: "Cart outcome", surfaces: ["web"], state: "ready" },
			],
		},
		satellites: [
			{ capabilityId: "catalog", sessionId: "session-42", status: "live", heartbeat: "fresh" },
			{ capabilityId: "cart", sessionId: "session-42", status: "live", heartbeat: "fresh" },
		],
	}));
	assert.deepEqual(result.sections[0].tabs.map((tab) => tab.capabilityId), ["cart", "catalog"]);
});

test("a capability with no declared surface never reaches a section", () => {
	const result = deriveOrchestratorSessionTabs(input({
		map: { capabilities: [{ id: "catalog", outcome: "Outcome", surfaces: [], state: "active" }] },
	}));
	assert.deepEqual(result.sections, []);
	assert.deepEqual(result.diagnostics, []);
});
