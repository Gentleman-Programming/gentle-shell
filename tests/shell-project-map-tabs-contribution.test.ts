import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	createOrchestratorSessionTabsSnapshot,
	orchestratorSessionTabsRail,
	type OrchestratorSessionTabs,
	type OrchestratorSessionTabsReaders,
} from "../lib/shell-project-map-tabs.ts";

const ROLE_CODE: Record<string, string> = { accent: "\u001b[36m", muted: "\u001b[90m", text: "\u001b[0m", error: "\u001b[31m" };
const theme = { fg: (color: string, text: string) => `${ROLE_CODE[color] ?? "\u001b[0m"}${text}\u001b[0m` };
const ESCAPE = /\u001b\[[0-9;]*m/g;

const click = (x: number, y = 0) => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 140, height: 1, shift: false, alt: false, ctrl: false } as TuiMouseEvent);

const map = { capabilities: [{ id: "catalog", outcome: "Merchants can publish a catalog.", surfaces: ["web" as const], state: "active" as const }] };

function readers(overrides: Partial<OrchestratorSessionTabsReaders> = {}): OrchestratorSessionTabsReaders {
	return {
		coordination: () => ({
			map,
			satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: "live" as const, heartbeat: "fresh" as const }],
			capabilities: [{ capabilityId: "catalog", openBlockers: 0, nextSafeAction: "work" }],
			diagnostics: [],
		}),
		worktreeBindings: () => ({ bindings: [{ capabilityId: "catalog", sessionId: "session-42", branch: "feat/catalog", worktreeRoot: "/projects/shop-worktrees/catalog" }], diagnostics: [] }),
		presenceAlive: () => null,
		lastActivity: () => "2026-09-26T20:00:00.000Z",
		...overrides,
	};
}

test("the snapshot reads every source once and reuses the result inside its window", () => {
	let reads = 0;
	const snapshot = createOrchestratorSessionTabsSnapshot({
		root: "/store",
		mapPath: "/repo/openspec/project-map.json",
		readers: readers({ coordination: (options) => { reads += 1; return readers().coordination(options); } }),
		now: () => 1_000,
		refreshMs: 2_000,
	});
	assert.equal(snapshot.read().sections.length, 1);
	assert.equal(snapshot.read().sections.length, 1);
	assert.equal(reads, 1, "a second read inside the window must not touch the store again");
});

test("the snapshot re-reads once its window has passed and reflects the new data", () => {
	let now = 1_000;
	let live = true;
	const snapshot = createOrchestratorSessionTabsSnapshot({
		root: "/store",
		mapPath: "/map.json",
		readers: readers({
			coordination: () => ({
				map,
				satellites: [{ capabilityId: "catalog", sessionId: "session-42", status: live ? ("live" as const) : ("stale" as const), heartbeat: live ? ("fresh" as const) : ("stale" as const) }],
				capabilities: [{ capabilityId: "catalog", openBlockers: 0, nextSafeAction: "work" }],
				diagnostics: [],
			}),
		}),
		now: () => now,
		refreshMs: 2_000,
	});
	assert.equal(snapshot.read().sections.length, 1);
	live = false;
	now += 1_999;
	assert.equal(snapshot.read().sections.length, 1, "inside the window the cached liveness stands");
	now += 1;
	assert.deepEqual(snapshot.read().sections, [], "past the window the store's new liveness is honoured");
});

test("the snapshot hands the coordination and binding diagnostics to the projection", () => {
	const diagnostic = { code: "project-map-store/unreadable-store", path: "$", message: "unreadable", severity: "error" as const };
	const snapshot = createOrchestratorSessionTabsSnapshot({
		root: "/store",
		mapPath: "/map.json",
		readers: readers({
			coordination: () => ({ map, satellites: [], capabilities: [], diagnostics: [diagnostic] }),
			worktreeBindings: () => ({ bindings: [], diagnostics: [{ ...diagnostic, code: "project-map-store/worktree-corrupted" }] }),
		}),
		now: () => 0,
		refreshMs: 1_000,
	});
	assert.deepEqual(snapshot.read().diagnostics.map((entry) => entry.code), ["project-map-store/unreadable-store", "project-map-store/worktree-corrupted"]);
});

test("a reader that throws yields an unavailable row with a diagnostic instead of escaping", () => {
	const snapshot = createOrchestratorSessionTabsSnapshot({
		root: "/store",
		mapPath: "/map.json",
		readers: readers({ coordination: () => { throw new Error("store exploded"); } }),
		now: () => 0,
		refreshMs: 1_000,
	});
	const model = snapshot.read();
	assert.equal(model.available, false);
	assert.deepEqual(model.sections, []);
	assert.equal(model.diagnostics.length, 1);
	assert.equal(model.diagnostics[0].severity, "error");
	assert.match(model.diagnostics[0].message, /store exploded/);
});

test("the snapshot asks the store for each session's last activity", () => {
	const asked: string[] = [];
	const snapshot = createOrchestratorSessionTabsSnapshot({
		root: "/store",
		mapPath: "/map.json",
		readers: readers({ lastActivity: (_root, sessionId) => { asked.push(sessionId); return "2026-09-26T21:00:00.000Z"; } }),
		now: () => 0,
		refreshMs: 1_000,
	});
	assert.equal(snapshot.read().sections[0]!.tabs[0]!.lastActivity, "2026-09-26T21:00:00.000Z");
	assert.deepEqual(asked, ["session-42"]);
});

function model(): OrchestratorSessionTabs {
	return {
		available: true,
		sections: [{
			surface: "web",
			tabs: [{ capabilityId: "catalog", outcome: "Merchants can publish a catalog.", state: "active", sessionId: "session-42", liveness: "live", heartbeat: "fresh", worktreeRoot: "/projects/shop-worktrees/catalog", branch: "feat/catalog", openBlockers: 0, nextSafeAction: "work", lastActivity: null }],
		}],
		diagnostics: [],
	};
}

function selection() {
	let selected: string | undefined;
	return { selected: () => selected, select: (capabilityId: string | undefined) => { selected = capabilityId; } };
}

test("the rail paints nothing when there is nothing to show", () => {
	const rail = orchestratorSessionTabsRail({ read: () => ({ available: false, sections: [], diagnostics: [] }), selection: selection(), theme });
	assert.deepEqual(rail.render(140), []);
});

test("the rail paints the row and selects the capability a click lands on", () => {
	const chosen = selection();
	const rail = orchestratorSessionTabsRail({ read: model, selection: chosen, theme });
	const line = rail.render(140)[0]!.replace(ESCAPE, "");
	const at = line.indexOf("catalog");
	assert.ok(at >= 0, "the row names the capability");
	assert.equal(rail.handleMouse?.(click(at + 1))?.handled, true);
	assert.equal(chosen.selected(), "catalog");
});

test("clicking the selected capability again clears the selection", () => {
	const chosen = selection();
	const rail = orchestratorSessionTabsRail({ read: model, selection: chosen, theme });
	const line = rail.render(140)[0]!.replace(ESCAPE, "");
	rail.handleMouse?.(click(line.indexOf("catalog") + 1));
	rail.handleMouse?.(click(line.indexOf("catalog") + 1));
	assert.equal(chosen.selected(), undefined);
});

test("a click that lands on no capability is ignored", () => {
	const chosen = selection();
	const rail = orchestratorSessionTabsRail({ read: model, selection: chosen, theme });
	const line = rail.render(140)[0]!.replace(ESCAPE, "");
	assert.equal(rail.handleMouse?.(click(line.indexOf("Web"))), undefined);
	assert.equal(chosen.selected(), undefined);
});

test("a click below the row is ignored, because the row is the rail's only line", () => {
	const chosen = selection();
	const rail = orchestratorSessionTabsRail({ read: model, selection: chosen, theme });
	const line = rail.render(140)[0]!.replace(ESCAPE, "");
	assert.equal(rail.handleMouse?.(click(line.indexOf("catalog") + 1, 3)), undefined);
	assert.equal(chosen.selected(), undefined);
});

test("a narrow row keeps only the columns it actually painted clickable", () => {
	const chosen = selection();
	const rail = orchestratorSessionTabsRail({ read: model, selection: chosen, theme });
	const narrow = rail.render(8)[0]!.replace(ESCAPE, "");
	assert.equal(narrow, "Web · c…", "eight columns, with the dropped tail replaced by an ellipsis");
	assert.equal(rail.handleMouse?.(click(20)), undefined, "past the painted line there is nothing to click");
	assert.equal(rail.handleMouse?.(click(6))?.handled, true, "the visible head of the item is still clickable");
	assert.equal(chosen.selected(), "catalog");
});

test("the rail digest follows both the model and the selection", () => {
	const chosen = selection();
	const rail = orchestratorSessionTabsRail({ read: model, selection: chosen, theme });
	const before = rail.digest?.();
	assert.equal(rail.digest?.(), before);
	rail.handleMouse?.(click(rail.render(140)[0]!.replace(ESCAPE, "").indexOf("catalog") + 1));
	assert.notEqual(rail.digest?.(), before, "a selection change must repaint the header");
});
