import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	orchestratorSessionTabsDigest,
	renderOrchestratorSessionTabDetail,
	renderOrchestratorSessionTabRow,
	ORCHESTRATOR_SESSION_SURFACE_LABEL,
	type OrchestratorSessionTabs,
} from "../lib/shell-project-map-tabs.ts";

/** Emits real ANSI so `visibleWidth` measures the text and not the roles. */
const ROLE_CODE: Record<string, string> = { accent: "\u001b[36m", muted: "\u001b[90m", text: "\u001b[0m", error: "\u001b[31m" };
const theme = { fg: (color: string, text: string) => `${ROLE_CODE[color] ?? "\u001b[0m"}${text}\u001b[0m` };
const ESCAPE = /\u001b\[[0-9;]*m/g;

function tabs(overrides: Partial<OrchestratorSessionTabs> = {}): OrchestratorSessionTabs {
	return {
		available: true,
		sections: [
			{
				surface: "web",
				tabs: [
					{ capabilityId: "cart", outcome: "Shoppers can build a cart.", state: "ready", sessionId: "session-2", liveness: "live", heartbeat: "fresh", worktreeRoot: "/projects/shop-worktrees/cart", branch: "feat/cart", openBlockers: 0, nextSafeAction: "claim", lastActivity: "2026-09-26T19:00:00.000Z" },
					{ capabilityId: "catalog", outcome: "Merchants can publish a catalog.", state: "active", sessionId: "session-42", liveness: "live", heartbeat: "fresh", worktreeRoot: "/projects/shop-worktrees/catalog", branch: "feat/catalog", openBlockers: 2, nextSafeAction: "resolve-blocker", lastActivity: "2026-09-26T20:00:00.000Z" },
				],
			},
			{
				surface: "api",
				tabs: [
					{ capabilityId: "catalog", outcome: "Merchants can publish a catalog.", state: "active", sessionId: "session-42", liveness: "live", heartbeat: "fresh", worktreeRoot: "/projects/shop-worktrees/catalog", branch: "feat/catalog", openBlockers: 2, nextSafeAction: "resolve-blocker", lastActivity: "2026-09-26T20:00:00.000Z" },
				],
			},
		],
		diagnostics: [],
		...overrides,
	};
}

const plain = (lines: string[]) => lines.join("\n").replace(ESCAPE, "");

test("the row renders nothing when there is nothing to show", () => {
	assert.deepEqual(renderOrchestratorSessionTabRow({ tabs: tabs({ sections: [] }), width: 140, theme }), []);
});

test("the row renders nothing when the store is unavailable", () => {
	assert.deepEqual(renderOrchestratorSessionTabRow({ tabs: tabs({ available: false }), width: 140, theme }), []);
});

test("the row is exactly one line", () => {
	assert.equal(renderOrchestratorSessionTabRow({ tabs: tabs(), width: 140, theme }).length, 1);
});

test("the row groups by surface, in section order, with the capability repeated under each surface it declares", () => {
	const line = plain(renderOrchestratorSessionTabRow({ tabs: tabs(), width: 140, theme }));
	assert.equal(line, "Web · cart, catalog   API · catalog");
});

test("a surface with no session on screen is absent from the row entirely", () => {
	const line = plain(renderOrchestratorSessionTabRow({ tabs: tabs(), width: 140, theme }));
	assert.doesNotMatch(line, /Tests/);
	assert.doesNotMatch(line, /Data/);
});

test("two sessions on one capability are one row item carrying a count, not two identical labels", () => {
	const doubled = tabs();
	doubled.sections = [{
		surface: "web",
		tabs: [
			{ ...doubled.sections[0].tabs[1], sessionId: "session-41", liveness: "stale" },
			doubled.sections[0].tabs[1],
		],
	}];
	const line = plain(renderOrchestratorSessionTabRow({ tabs: doubled, width: 140, theme }));
	assert.match(line, /Web · catalog ×2/);
});

test("the surface labels cover every surface the schema declares", async () => {
	const { PROJECT_MAP_SURFACES } = await import("../lib/shell-project-map-schema.ts");
	assert.deepEqual(Object.keys(ORCHESTRATOR_SESSION_SURFACE_LABEL).sort(), [...PROJECT_MAP_SURFACES].sort());
});

test("the row fits the width it is given and says what it dropped", () => {
	const line = renderOrchestratorSessionTabRow({ tabs: tabs(), width: 24, theme })[0];
	assert.ok(visibleWidth(line) <= 24, `rendered ${visibleWidth(line)} columns`);
	assert.match(plain([line]), /…$/);
});

test("the selected capability is marked in every section it appears in", () => {
	const line = plain(renderOrchestratorSessionTabRow({ tabs: tabs(), selection: "catalog", width: 140, theme }));
	assert.match(line, /Web · cart, ▸ catalog/);
	assert.match(line, /API · ▸ catalog/);
});

test("a selection paints with the accent role and an unselected row does not", () => {
	const selected = renderOrchestratorSessionTabRow({ tabs: tabs(), selection: "catalog", width: 140, theme })[0];
	const unselected = renderOrchestratorSessionTabRow({ tabs: tabs(), width: 140, theme })[0];
	assert.match(selected, /\u001b\[36m▸ catalog/);
	assert.doesNotMatch(unselected, /\u001b\[36m/);
});

test("the detail is empty until something is selected", () => {
	assert.deepEqual(renderOrchestratorSessionTabDetail({ tabs: tabs(), width: 50, theme }), []);
});

test("the detail names the objective, the declared state, the blockers and the next action", () => {
	const text = plain(renderOrchestratorSessionTabDetail({ tabs: tabs(), selection: "catalog", width: 60, theme }));
	assert.match(text, /Merchants can publish a catalog\./);
	assert.match(text, /active/);
	assert.match(text, /2 open blocker/);
	assert.match(text, /resolve-blocker/);
});

test("the detail gives each session its own line with worktree, branch, liveness and last activity", () => {
	const doubled = tabs();
	doubled.sections = [{
		surface: "web",
		tabs: [
			{ ...doubled.sections[0].tabs[1], sessionId: "session-41", liveness: "stale", heartbeat: "missing", lastActivity: null },
			doubled.sections[0].tabs[1],
		],
	}];
	const text = plain(renderOrchestratorSessionTabDetail({ tabs: doubled, selection: "catalog", width: 120, theme }));
	assert.match(text, /session-41/);
	assert.match(text, /stale/);
	assert.match(text, /no activity recorded/);
	assert.match(text, /session-42/);
	assert.match(text, /2026-09-26T20:00:00\.000Z/);
});

test("an unknown worktree is said to be unknown and never rendered as a path", () => {
	const unknown = tabs();
	unknown.sections = [{ surface: "web", tabs: [{ ...unknown.sections[0].tabs[1], worktreeRoot: null, branch: null }] }];
	const text = plain(renderOrchestratorSessionTabDetail({ tabs: unknown, selection: "catalog", width: 60, theme }));
	assert.match(text, /worktree unknown/);
	assert.doesNotMatch(text, /undefined/);
});

test("the detail refuses to invent a capability the sections never contained", () => {
	const text = plain(renderOrchestratorSessionTabDetail({ tabs: tabs(), selection: "ghost", width: 60, theme }));
	assert.match(text, /No session is bound to ghost/);
});

test("the detail separates the capability with a heading that names the selection", () => {
	const lines = renderOrchestratorSessionTabDetail({ tabs: tabs(), selection: "catalog", width: 60, theme });
	assert.match(plain([lines[0]]), /catalog/);
});

test("the detail fits the width it is given", () => {
	for (const line of renderOrchestratorSessionTabDetail({ tabs: tabs(), selection: "catalog", width: 12, theme })) {
		assert.ok(visibleWidth(line) <= 12, `rendered ${visibleWidth(line)} columns`);
	}
});

test("the digest changes when the painted tab state changes", () => {
	const before = orchestratorSessionTabsDigest(tabs(), undefined);
	assert.notEqual(orchestratorSessionTabsDigest(tabs({ available: false }), undefined), before);
	assert.notEqual(orchestratorSessionTabsDigest(tabs(), "catalog"), before);
	const moved = tabs();
	moved.sections = [{ surface: "web", tabs: [{ ...moved.sections[0].tabs[1], liveness: "stale" }] }];
	assert.notEqual(orchestratorSessionTabsDigest(moved, undefined), before);
});

test("the digest is stable while the painted state is stable", () => {
	assert.equal(orchestratorSessionTabsDigest(tabs(), "catalog"), orchestratorSessionTabsDigest(tabs(), "catalog"));
});

test("a diagnostic does not change the digest, because it paints nothing", () => {
	const withDiagnostic = tabs({ diagnostics: [{ code: "orchestrator-session-tabs/unknown-capability", path: "$", message: "ghost", severity: "warning" }] });
	assert.equal(orchestratorSessionTabsDigest(withDiagnostic, undefined), orchestratorSessionTabsDigest(tabs(), undefined));
});
