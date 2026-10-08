import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { sidebarHeaderContributors, sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";
import { PROJECT_MAP_RAIL_KEY } from "../lib/shell-project-map-card.ts";
import { PROJECT_MAP_STATE_GLYPH } from "../lib/shell-project-map-view.ts";
import { initializeProjectMapStore } from "../lib/project-map-store.ts";
import { acquireProjectMapClaim } from "../lib/project-map-store-claims.ts";
import { beatProjectMapStoreHeartbeat, bindProjectMapStoreSession } from "../lib/project-map-store-heartbeats.ts";
import { resolveProjectMapStoreRoot } from "../lib/project-map-store-root.ts";
import { bindProjectMapStoreWorktree } from "../lib/project-map-store-worktrees.ts";
import { hashProjectMapDescription } from "../lib/project-map-translations.ts";
import gentleProjectMap, {
	PROJECT_MAP_COLLAPSE_KEY_DEFAULT,
	PROJECT_MAP_NEXT_KEY_DEFAULT,
	PROJECT_MAP_PREV_KEY_DEFAULT,
	PROJECT_MAP_HELP_KEY_DEFAULT,
	parseProjectMapCollapseKey,
	parseProjectMapNextKey,
	parseProjectMapPrevKey,
	parseProjectMapHelpKey,
	explainProjectMapCapability,
	readRepositorySources,
	readProjectMapDisplay,
	type ProjectMapViewContext,
} from "../extensions/gentle-project-map.ts";

function harness(cwd: string) {
	const notified: string[] = [];
	const ctx: ProjectMapViewContext = { cwd, hasUI: true, ui: { notify: (message) => notified.push(message) } };
	return { ctx, notified };
}

function repository(overrides: { manifest?: unknown; task?: string | null } = {}): string {
	const directory = mkdtempSync(join(tmpdir(), "project-map-view-"));
	writeFileSync(join(directory, "package.json"), JSON.stringify(overrides.manifest ?? { name: "example-shop", scripts: { test: "pnpm test" } }), "utf8");
	if (overrides.task !== null) {
		mkdirSync(join(directory, "odd", "tasks"), { recursive: true });
		writeFileSync(join(directory, "odd", "tasks", "roadmap.md"), overrides.task ?? "- [ ] **FP-2 — Plan**\n", "utf8");
	}
	return directory;
}

function withRepository(run: (directory: string) => Promise<void> | void, overrides: Parameters<typeof repository>[0] = {}): Promise<void> {
	const directory = repository(overrides);
	return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

type LifecycleHandler = (event: unknown, ctx: unknown) => unknown;
function projectMapExtension(env: NodeJS.ProcessEnv = {}) {
	const commands: string[] = [];
	const shortcuts = new Map<string, { handler(ctx: unknown): Promise<unknown> }>();
	const handlers = new Map<string, LifecycleHandler[]>();
	const pi = {
		registerCommand(name: string) { commands.push(name); },
		registerShortcut(key: string, shortcut: { handler(ctx: unknown): Promise<unknown> }) { shortcuts.set(key, shortcut); },
		on(name: string, handler: LifecycleHandler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
	} as unknown as Parameters<typeof gentleProjectMap>[0];
	const fire = async (name: string, ctx: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
	};
	gentleProjectMap(pi, env);
	return { commands, shortcuts, fire };
}

function widgetContext(cwd: string, id: string) {
	const widgets = new Map<string, ((tui: unknown, theme: unknown) => { dispose?(): void }) | undefined>();
	const calls: Array<[string, unknown, unknown]> = [];
	const notified: string[] = [];
	const ctx = {
		cwd, hasUI: true, sessionManager: { getSessionId: () => id },
		ui: {
			notify(message: string) { notified.push(message); },
			setWidget(key: string, value: ((tui: unknown, theme: unknown) => { dispose?(): void }) | undefined, options?: unknown) {
				calls.push([key, value, options]);
				if (value === undefined) widgets.delete(key);
				else widgets.set(key, value);
			},
		},
	};
	return { ctx, widgets, calls, notified };
}

function writeDisplayDocuments(directory: string, text = "- [x] **FP-1 — Catalog**\n"): void {
	mkdirSync(join(directory, "odd", "tasks"), { recursive: true });
	writeFileSync(join(directory, "odd", "tasks", "roadmap.md"), text, "utf8");
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "example-shop", scripts: { test: "pnpm test" } }), "utf8");
}

const theme = { fg: (_color: string, text: string) => text };
const newTui = () => ({ terminal: {}, requestRender() {} }) as unknown as TUI;
async function explanation(directory: string, id: string, railColumns = 0) {
	const probe = harness(directory);
	let body = "";
	let options: unknown;
	probe.ctx.ui.custom = async (factory, overlay) => {
		body = factory({ terminal: { rows: 100 } } as unknown as TUI, theme, {}, () => {}).render(120).join("\n");
		options = overlay;
		return {} as never;
	};
	await explainProjectMapCapability(probe.ctx, id, railColumns);
	return { body, options, notified: probe.notified };
}

test("the extension registers no commands", () => {
	assert.deepEqual(projectMapExtension().commands, []);
});

test("resolves the Project Map collapse shortcut with default, override, and off", () => {
	assert.equal(PROJECT_MAP_COLLAPSE_KEY_DEFAULT, "alt+m");
	assert.equal(parseProjectMapCollapseKey({}), "alt+m");
	assert.equal(parseProjectMapCollapseKey({ GENTLE_PI_PROJECT_MAP_KEY: "ctrl+m" }), "ctrl+m");
	assert.equal(parseProjectMapCollapseKey({ GENTLE_PI_PROJECT_MAP_KEY: "" }), "alt+m");
	assert.equal(parseProjectMapCollapseKey({ GENTLE_PI_PROJECT_MAP_KEY: "off" }), undefined);
	assert.ok(projectMapExtension().shortcuts.has("alt+m"));
	assert.ok(projectMapExtension({ GENTLE_PI_PROJECT_MAP_KEY: "ctrl+m" }).shortcuts.has("ctrl+m"));
});

test("resolves Project Map selection shortcuts with defaults, overrides, and off", () => {
	assert.equal(PROJECT_MAP_NEXT_KEY_DEFAULT, "alt+j");
	assert.equal(PROJECT_MAP_PREV_KEY_DEFAULT, "alt+k");
	assert.equal(parseProjectMapNextKey({}), "alt+j");
	assert.equal(parseProjectMapPrevKey({}), "alt+k");
	assert.equal(parseProjectMapNextKey({ GENTLE_PI_PROJECT_MAP_NEXT_KEY: "ctrl+j" }), "ctrl+j");
	assert.equal(parseProjectMapPrevKey({ GENTLE_PI_PROJECT_MAP_PREV_KEY: "off" }), undefined);
	const extension = projectMapExtension();
	assert.ok(extension.shortcuts.has("alt+j"));
	assert.ok(extension.shortcuts.has("alt+k"));
});

test("resolves the explain shortcut with a default, an override, and off", () => {
	assert.equal(PROJECT_MAP_HELP_KEY_DEFAULT, "alt+e");
	assert.equal(parseProjectMapHelpKey({}), "alt+e");
	assert.equal(parseProjectMapHelpKey({ GENTLE_PI_PROJECT_MAP_HELP_KEY: "ctrl+e" }), "ctrl+e");
	assert.equal(parseProjectMapHelpKey({ GENTLE_PI_PROJECT_MAP_HELP_KEY: "" }), "alt+e");
	assert.equal(parseProjectMapHelpKey({ GENTLE_PI_PROJECT_MAP_HELP_KEY: "off" }), undefined);
	assert.ok(projectMapExtension().shortcuts.has("alt+e"));
	assert.ok(!projectMapExtension({ GENTLE_PI_PROJECT_MAP_HELP_KEY: "off" }).shortcuts.has("alt+e"));
});

test("the Project Map card renders by default without an executable opt-in", async () => {
	await withRepository(async (directory) => {
		writeDisplayDocuments(directory);
		const extension = projectMapExtension({});
		const probe = widgetContext(directory, "default-visible");
		await extension.fire("session_start", probe.ctx);
		const factory = probe.widgets.get("gentle-project-map");
		assert.ok(factory, "the card mounts by default without an executable opt-in");
		assert.deepEqual(probe.calls.at(-1)?.[2], { placement: "belowEditor" });
		const tui = newTui();
		factory(tui, theme);
		const card = sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY);
		assert.ok(card, "the visible card registers its rail part");
		assert.match(card.render(80).join("\n"), /FP-1 — Catalog/);
		assert.doesNotMatch(card.render(80).join("\n"), /\? ✿/);
		await extension.fire("session_shutdown", probe.ctx);
	});
});

test("the collapse shortcut toggles all groups only while the card is mounted", async () => {
	await withRepository(async (directory) => {
		writeDisplayDocuments(directory);
		const extension = projectMapExtension();
		const probe = widgetContext(directory, "shortcut");
		await extension.fire("session_start", probe.ctx);
		const tui = newTui();
		probe.widgets.get("gentle-project-map")!(tui, theme);
		const body = () => sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!.render(80).join("\n");
		assert.match(body(), /▾ Foundations 1\/1/);
		assert.match(body(), /▾ Product capabilities 1\/1/);
		await extension.shortcuts.get("alt+m")!.handler(probe.ctx);
		assert.match(body(), /▸ Foundations 1\/1/);
		assert.match(body(), /▸ Product capabilities 1\/1/);
		await extension.shortcuts.get("alt+m")!.handler(probe.ctx);
		assert.match(body(), /▾ Foundations 1\/1/);
		assert.match(body(), /▾ Product capabilities 1\/1/);
		await extension.fire("session_shutdown", probe.ctx);
		await extension.shortcuts.get("alt+m")!.handler(probe.ctx);
		assert.ok(probe.notified.some((message) => message.includes("hidden")));
	});
});

test("the card part receives a session toggle that changes only the clicked group", async () => {
	await withRepository(async (directory) => {
		writeDisplayDocuments(directory);
		const extension = projectMapExtension();
		const probe = widgetContext(directory, "part-toggle");
		await extension.fire("session_start", probe.ctx);
		const tui = newTui();
		probe.widgets.get("gentle-project-map")!(tui, theme);
		const rail = sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!;
		const lines = rail.render(80);
		const header = lines.findIndex((line) => line.includes("Foundations"));
		rail.handleMouse?.({ type: "click", button: "left", x: 2, y: header, screenX: 2, screenY: header, width: 80, height: lines.length, shift: false, alt: false, ctrl: false });
		const body = rail.render(80).join("\n");
		assert.match(body, /▸ Foundations 1\/1/);
		assert.equal(body.includes("✓ repository-tooling"), false);
		assert.match(body, /▾ Product capabilities 1\/1/);
		assert.ok(body.includes("✓ FP-1 — Catalog"));
	});
});

test("selection shortcuts clamp, expand capabilities, and reset at session shutdown", async () => {
	await withRepository(async (directory) => {
		writeDisplayDocuments(directory, "- [x] **FP-1 — Alpha**\n- [ ] **FP-2 — Beta**\n");
		const extension = projectMapExtension();
		const probe = widgetContext(directory, "selection");
		await extension.fire("session_start", probe.ctx);
		const tui = newTui();
		probe.widgets.get("gentle-project-map")!(tui, theme);
		const body = () => sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!.render(80).join("\n");
		await extension.shortcuts.get("alt+j")!.handler(probe.ctx);
		assert.match(body(), /▸ \? ✓ FP-1 — Alpha/);
		await extension.shortcuts.get("alt+j")!.handler(probe.ctx);
		assert.match(body(), /▸ \? ○ FP-2 — Beta/);
		await extension.shortcuts.get("alt+j")!.handler(probe.ctx);
		assert.match(body(), /▸ \? ○ FP-2 — Beta/, "next clamps at the end");
		await extension.shortcuts.get("alt+k")!.handler(probe.ctx);
		assert.match(body(), /▸ \? ✓ FP-1 — Alpha/);
		await extension.shortcuts.get("alt+k")!.handler(probe.ctx);
		assert.match(body(), /▸ \? ✓ FP-1 — Alpha/, "previous clamps at the start");
		await extension.shortcuts.get("alt+m")!.handler(probe.ctx);
		assert.match(body(), /▸ Product capabilities/);
		await extension.shortcuts.get("alt+j")!.handler(probe.ctx);
		assert.match(body(), /▾ Product capabilities/);
		await extension.fire("session_shutdown", probe.ctx);
		const resumed = widgetContext(directory, "selection");
		await extension.fire("session_start", resumed.ctx);
		resumed.widgets.get("gentle-project-map")!(tui, theme);
		assert.equal(body().includes("▸ ? ✓"), false);
	});
});

test("collapse survives a widget remount but is dropped at session shutdown without disk writes", async () => {
	await withRepository(async (directory) => {
		writeDisplayDocuments(directory);
		const extension = projectMapExtension();
		const first = widgetContext(directory, "same-collapse");
		const path = join(directory, "odd/tasks/roadmap.md");
		const before = readFileSync(path, "utf8");
		await extension.fire("session_start", first.ctx);
		const tui = newTui();
		first.widgets.get("gentle-project-map")!(tui, theme);
		await extension.shortcuts.get("alt+m")!.handler(first.ctx);
		assert.match(sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!.render(80).join("\n"), /▸ Product capabilities/);
		first.widgets.get("gentle-project-map")!(tui, theme);
		assert.match(sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!.render(80).join("\n"), /▸ Product capabilities/);
		await extension.fire("session_shutdown", first.ctx);
		const resumed = widgetContext(directory, "same-collapse");
		await extension.fire("session_start", resumed.ctx);
		resumed.widgets.get("gentle-project-map")!(tui, theme);
		assert.match(sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!.render(80).join("\n"), /▾ Product capabilities/);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("session shutdown removes only the map's rail part and a resumed session mounts", async () => {
	await withRepository(async (directory) => {
		const extension = projectMapExtension();
		const first = widgetContext(directory, "same-session");
		await extension.fire("session_start", first.ctx);
		const tui = newTui();
		sidebarPart(tui, "todo", { render: () => [], invalidate() {} });
		first.widgets.get("gentle-project-map")!(tui, theme);
		assert.equal(sidebarState(tui).parts.has(PROJECT_MAP_RAIL_KEY), true);
		await extension.fire("session_shutdown", first.ctx);
		assert.equal(sidebarState(tui).parts.has(PROJECT_MAP_RAIL_KEY), false);
		assert.equal(sidebarState(tui).parts.has("todo"), true);
		const resumed = widgetContext(directory, "same-session");
		await extension.fire("session_start", resumed.ctx);
		assert.equal(resumed.widgets.has("gentle-project-map"), true);
	});
});

// The tabs still read the real coordination store; no executable receiver is needed.
function withGitRepository(run: (directory: string, store: string, agentHome: string) => Promise<void> | void): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "project-map-tabs-"));
	const empty = mkdtempSync(join(tmpdir(), "project-map-tabs-git-"));
	const agentHome = mkdtempSync(join(tmpdir(), "project-map-tabs-home-"));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: join(empty, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" };
	writeFileSync(join(empty, "config"), "", "utf8");
	execFileSync("git", ["init", "--initial-branch=main", directory], { env, stdio: "ignore" });
	execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"], { env, stdio: "ignore" });
	const resolved = resolveProjectMapStoreRoot(directory);
	assert.ok(resolved.root && resolved.repositoryId, resolved.diagnostics.map((entry) => entry.message).join("\n"));
	mkdirSync(resolved.root, { recursive: true, mode: 0o700 });
	assert.ok(initializeProjectMapStore({ root: resolved.root, repositoryId: resolved.repositoryId, epoch: "123e4567-e89b-12d3-a456-426614174000", now: new Date().toISOString() }).descriptor);
	return Promise.resolve(run(directory, resolved.root, agentHome)).finally(() => {
		rmSync(directory, { recursive: true, force: true });
		rmSync(empty, { recursive: true, force: true });
		rmSync(agentHome, { recursive: true, force: true });
	});
}

async function mountTabsCard(directory: string, agentHome: string, sessionId: string) {
	const extension = projectMapExtension({ GENTLE_PI_AGENT_HOME: agentHome });
	const probe = widgetContext(directory, sessionId);
	await extension.fire("session_start", probe.ctx);
	const tui = newTui();
	probe.widgets.get("gentle-project-map")!(tui, theme);
	return { extension, probe, tui };
}

function writeTabMap(directory: string) {
	writeDisplayDocuments(directory);
	mkdirSync(join(directory, "openspec"), { recursive: true });
	writeFileSync(join(directory, "openspec/project-map.json"), JSON.stringify({
		version: "gentle-shell.project-map/v1", project: { id: "example-shop", name: "Example Shop" }, approval: { state: "draft" }, foundations: [],
		capabilities: [{ id: "catalog", outcome: "Catalog", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: ["web"], state: "done" }],
	}));
}

function bindTab(store: string, directory: string, sessionId: string) {
	const now = new Date().toISOString();
	const incarnation = "123e4567-e89b-12d3-a456-426614174001";
	assert.ok(acquireProjectMapClaim({ root: store, capabilityId: "catalog", sessionId, now }).claim);
	assert.ok(bindProjectMapStoreSession({ root: store, sessionId, workspaceRoot: directory, pid: 1, incarnation, now }).binding);
	assert.ok(beatProjectMapStoreHeartbeat({ root: store, sessionId, pid: 1, incarnation, now }).heartbeat);
	assert.ok(bindProjectMapStoreWorktree({ root: store, capabilityId: "catalog", branch: "feat/catalog", worktreeRoot: "/projects/shop-worktrees/catalog", sessionId, baseCommit: "0".repeat(40), now }).binding);
}

test("mounting the card contributes one header row group that reads the real coordination store", async () => {
	await withGitRepository(async (directory, store, agentHome) => {
		writeTabMap(directory);
		bindTab(store, directory, "session-tabs");
		const { tui } = await mountTabsCard(directory, agentHome, "tabs");
		const contributors = sidebarHeaderContributors(tui);
		assert.equal(contributors.length, 1);
		assert.match(contributors[0]!.render(140).join("\n"), /Web · catalog/);
		assert.equal(typeof contributors[0]!.digest, "function");
	});
});

test("the contribution paints nothing when no session holds a capability the map declares", async () => {
	await withGitRepository(async (directory, _store, agentHome) => {
		writeTabMap(directory);
		const { tui } = await mountTabsCard(directory, agentHome, "tabs-empty");
		const contributors = sidebarHeaderContributors(tui);
		assert.equal(contributors.length, 1);
		assert.deepEqual(contributors[0]!.render(140), []);
	});
});

test("selecting a tab paints its read-only detail in the card's rail", async () => {
	await withGitRepository(async (directory, store, agentHome) => {
		writeTabMap(directory);
		bindTab(store, directory, "session-detail");
		const { tui } = await mountTabsCard(directory, agentHome, "tabs-detail");
		const rail = sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!;
		const before = rail.render(46).join("\n");
		assert.doesNotMatch(before, /branch feat\/catalog/);
		const contributor = sidebarHeaderContributors(tui)[0]!;
		const at = contributor.render(140)[0]!.indexOf("catalog");
		assert.ok(at >= 0);
		assert.equal(contributor.handleMouse?.({ type: "click", button: "left", x: at + 1, y: 0, screenX: at + 1, screenY: 0, width: 140, height: 1, shift: false, alt: false, ctrl: false })?.handled, true);
		const after = rail.render(46).join("\n");
		assert.match(after, /▸ catalog/);
		assert.match(after, /session-detail/);
		assert.match(after, /branch feat\/catalog/);
		assert.match(after, /worktree \/projects\/shop-worktrees\/catalog/);
		assert.ok(after.length > before.length);
	});
});

test("unmounting the card releases the header contribution", async () => {
	await withGitRepository(async (directory, _store, agentHome) => {
		writeTabMap(directory);
		const { extension, probe, tui } = await mountTabsCard(directory, agentHome, "tabs-unmount");
		assert.equal(sidebarHeaderContributors(tui).length, 1);
		await extension.fire("session_shutdown", probe.ctx);
		assert.deepEqual(sidebarHeaderContributors(tui), []);
	});
});

test("the display derives FP rows without declarations, openspec, or writes", async () => {
	await withRepository(async (directory) => {
		const before = readdirSync(directory).sort();
		const report = readProjectMapDisplay(directory);
		assert.equal(report.map?.project.name, "example-shop");
		assert.deepEqual(report.map?.capabilities.map((row) => row.outcome).sort(), ["FP-0 — Zero", "FP-1 — One", "FP-1-2 — Separate row", "FP-9 — Nine"].sort());
		assert.deepEqual(readdirSync(directory).sort(), before);
		assert.equal(readdirSync(directory).includes("openspec"), false);
	}, { task: "- [x] **FP-0 — Zero**\n- [~] **FP-1 — One**\n- [ ] **FP-1-2 — Separate row**\n- [ ] **FP-9 — Nine**\n- [ ] **FP-1b — A continuation**\n- [ ] **FP-77b — An orphan**\n- [ ] **PM-2 — Not a row**\n" });
});

test("display maps document declarations and names unmappable declared paths", async () => {
	await withRepository(async (directory) => {
		assert.deepEqual(readProjectMapDisplay(directory).map?.capabilities[0]?.surfaces, ["web"]);
		writeDisplayDocuments(directory, "- [ ] **FP-1 — One**\n  **Allowed edit surfaces:** `src/one.ts`\n");
		const report = readProjectMapDisplay(directory);
		assert.deepEqual(report.map?.capabilities[0]?.surfaces, []);
		assert.match(report.omissions.join("\n"), /one.*odd\/tasks\/roadmap\.md.*src\/one\.ts/);
		assert.equal(readdirSync(directory).includes("openspec"), false);
	}, { task: "- [ ] **FP-1 — One**\n  **Allowed edit surfaces:** `web/one.ts`\n" });
});

test("display ignores conflicting map configuration, roadmap pointers, and artifact rows", async () => {
	await withRepository(async (directory) => {
		mkdirSync(join(directory, "openspec"));
		writeFileSync(join(directory, "openspec/config.yaml"), "project_map:\n  delegable: PM-\n  roadmap: docs/other.md\n  surfaces:\n    web: web/\n");
		mkdirSync(join(directory, "docs"));
		writeFileSync(join(directory, "docs/other.md"), "- [x] **FP-9 — Outside tasks**\n");
		const artifact = join(directory, "openspec/project-map.json");
		writeFileSync(artifact, JSON.stringify({ version: "gentle-shell.project-map/v1", project: { id: "other", name: "Other" }, capabilities: [{ id: "artifact-only", outcome: "Artifact only", state: "done", surfaces: ["web"] }] }));
		const before = readFileSync(artifact, "utf8");
		const report = readProjectMapDisplay(directory);
		assert.deepEqual(report.map?.capabilities.map((row) => row.outcome), ["FP-1 — One"]);
		assert.deepEqual(report.map?.capabilities[0]?.surfaces, ["web"]);
		assert.equal(report.map?.project.name, "example-shop");
		assert.equal(readFileSync(artifact, "utf8"), before);
	}, { task: "- [ ] **FP-1 — One**\n  **Allowed edit surfaces:** `web/one.ts`\n" });
});

test("artifact-free sessions render derived data and preserve git status", async () => {
	await withGitRepository(async (directory, _store, agentHome) => {
		writeDisplayDocuments(directory, "- [x] **FP-1 — One**\n- [~] **FP-9 — Nine**\n");
		const before = execFileSync("git", ["-C", directory, "status", "--porcelain"], { encoding: "utf8" });
		const { tui } = await mountTabsCard(directory, agentHome, "derived");
		const body = sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!.render(80).join("\n");
		assert.match(body, /✓ FP-1 — One/);
		assert.match(body, /◉ FP-9 — Nine/);
		assert.equal(execFileSync("git", ["-C", directory, "status", "--porcelain"], { encoding: "utf8" }), before);
		assert.equal(readdirSync(directory).includes("openspec"), false);
	});
});

test("a project without FP rows renders the title only", async () => {
	await withRepository(async (directory) => {
		assert.equal(readProjectMapDisplay(directory).map, null);
		const extension = projectMapExtension();
		const widget = widgetContext(directory, "no-fp");
		await extension.fire("session_start", widget.ctx);
		const tui = newTui();
		widget.widgets.get("gentle-project-map")!(tui, theme);
		const body = sidebarState(tui).parts.get(PROJECT_MAP_RAIL_KEY)!.render(80).join("\n");
		assert.match(body, /Project Map/);
		assert.doesNotMatch(body, /No FP work units|Work unit prefix|default: FP-/);
		assert.doesNotMatch(body, /Product capabilities 0\/0/);
	}, { task: "- [ ] **FP-77b — Orphan**\n- [ ] **PM-2 — Not FP**\n" });
});

test("explaining a capability opens the overlay with what its document says", async () => {
	await withRepository(async (directory) => {
		const id = readProjectMapDisplay(directory).map!.capabilities[0]!.id;
		const { body } = await explanation(directory, id);
		assert.ok(body.includes(id));
		assert.ok(body.includes("The body line the document carries."));
		assert.ok(body.includes("Lo que dice el documento:"));
	}, { task: "- [ ] **FP-2 — Plan**\n  - The body line the document carries.\n" });
});

test("every capability explanation carries the whole map's surface roll-up without writing", async () => {
	await withRepository(async (directory) => {
		const before = readFileSync(join(directory, "odd/tasks/roadmap.md"), "utf8");
		for (const capability of readProjectMapDisplay(directory).map!.capabilities) {
			const { body } = await explanation(directory, capability.id);
			const ordered = ["Product/UX —", "Web 100% (2/2): catalog ✓, checkout ✓", "API 100% (1/1): checkout ✓", "Data —", "Security —", "Ops —", "Tests —"];
			for (const line of ordered) assert.ok(body.includes(line), line);
			for (let index = 1; index < ordered.length; index++) assert.ok(body.indexOf(ordered[index]!) > body.indexOf(ordered[index - 1]!));
			assert.ok(body.indexOf("Subelementos: ninguno.") < body.indexOf("Cobertura por superficie"));
			assert.ok(body.indexOf("Tests —") < body.indexOf("Lo que dice el documento:"));
		}
		assert.equal(readFileSync(join(directory, "odd/tasks/roadmap.md"), "utf8"), before);
	}, { task: "- [x] **FP-1 — Catalog**\n  **Allowed edit surfaces:** web: `apps/web/catalog.ts`\n  Catalog body.\n- [x] **FP-2 — Checkout**\n  **Allowed edit surfaces:** web: `apps/web/checkout.ts`, api: `apps/api/checkout.ts`\n  Checkout body.\n" });
});

test("document-only explanations deduce Unicode and dotted steps and honor declared parents", async () => {
	await withRepository(async (directory) => {
		writeFileSync(join(directory, "odd/tasks/cuts.md"), "- [~] **FP-1é — Accent**\n- [x] **FP-1𐐀 — Astral letter**\n- [ ] **FP-1.2 — Dot**\n- [ ] **FP-10a — Other row**\n- [ ] **FP-77b — Orphan**\n");
		writeFileSync(join(directory, "odd/tasks/override.md"), "**Belongs to:** `FP-9`\n- [x] **FP-1b — Reparented**\n- [ ] **CUT-1 — Other family**\n");
		const one = await explanation(directory, "one");
		assert.match(one.body, /FP-1é — Accent/);
		assert.match(one.body, /FP-1𐐀 — Astral letter/);
		assert.match(one.body, /FP-1\.2 — Dot/);
		assert.doesNotMatch(one.body, /Reparented|Other family|Orphan|Other row/);
		const nine = await explanation(directory, "nine");
		assert.match(nine.body, /FP-1b — Reparented/);
		assert.match(nine.body, /CUT-1 — Other family/);
		assert.doesNotMatch(nine.body, /Accent|Astral letter|Dot|Orphan/);
	}, { task: "- [ ] **FP-1 — One**\n- [ ] **FP-9 — Nine**\n" });
});

test("the help overlay reserves the rail when the fullscreen sidebar owns it", async () => {
	await withRepository(async (directory) => {
		const id = readProjectMapDisplay(directory).map!.capabilities[0]!.id;
		const centered = await explanation(directory, id);
		assert.deepEqual(centered.options, { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } });
		const reserved = await explanation(directory, id, 50);
		assert.deepEqual(reserved.options, { overlay: true, overlayOptions: { anchor: "left-center", width: "70%", minWidth: 60, maxHeight: "85%", margin: { left: 2, right: 52 } } });
	});
});

test("the explanation shows a current translation, and says why it is not translated otherwise", async () => {
	await withRepository(async (directory) => {
		const id = readProjectMapDisplay(directory).map!.capabilities[0]!.id;
		mkdirSync(join(directory, "openspec"));
		const target = join(directory, "openspec/project-map.es.json");
		const write = (sourceHash: string, title = "Traducido") => writeFileSync(target, JSON.stringify({
			version: "gentle-pi.project-map-translations/v1", language: "es",
			capabilities: { [id]: { source: "odd/tasks/roadmap.md", sourceHash, title, lines: ["La línea de cuerpo que el documento trae."] } },
		}));
		const untranslated = (await explanation(directory, id)).body;
		assert.ok(untranslated.includes("The body line the document carries."));
		assert.ok(untranslated.includes("Traducción: no generada"));
		write(hashProjectMapDescription(["The body line the document carries."]));
		const translated = (await explanation(directory, id)).body;
		assert.ok(translated.includes("La línea de cuerpo que el documento trae."));
		assert.ok(translated.includes("Resultado: FP-2 — Traducido"));
		assert.equal(translated.includes("Traducción:"), false);
		assert.equal(translated.includes("The body line the document carries."), false);
		write(hashProjectMapDescription(["The body line the document carries."]), "FP-2 — Traducido");
		const prefixed = (await explanation(directory, id)).body;
		assert.equal(prefixed.includes("FP-2 — FP-2 —"), false);
		write(hashProjectMapDescription(["A different body."]));
		const stale = (await explanation(directory, id)).body;
		assert.ok(stale.includes("Traducción: desactualizada"));
		assert.ok(stale.includes("The body line the document carries."));
	}, { task: "- [ ] **FP-2 — Plan**\n  - The body line the document carries.\n" });
});

for (const title of ["Traducido", "FP-1 — Traducido"]) {
	test(`the explanation preserves unspaced codes with stored title ${title}`, async () => {
		await withRepository(async (directory) => {
			mkdirSync(join(directory, "openspec"));
			writeFileSync(join(directory, "openspec/project-map.es.json"), JSON.stringify({
				version: "gentle-pi.project-map-translations/v1", language: "es",
				capabilities: { provisioning: { source: "odd/tasks/roadmap.md", sourceHash: hashProjectMapDescription(["The body line the document carries."]), title, lines: ["La línea de cuerpo que el documento trae."] } },
			}));
			const { body } = await explanation(directory, "provisioning");
			assert.ok(body.includes(`Resultado: ${title === "Traducido" ? "FP-1—Traducido" : title}`));
			assert.equal(body.includes("FP-1—FP-1"), false);
		}, { task: "- [ ] **FP-1—Provisioning**\n  - The body line the document carries.\n" });
	});
}

test("distinct FP codes with the same title remain distinct, explainable rows", async () => {
	await withRepository(async (directory) => {
		const map = readProjectMapDisplay(directory).map!;
		assert.equal(map.capabilities.length, 2);
		assert.equal(new Set(map.capabilities.map((row) => row.id)).size, 2);
		for (const row of map.capabilities) {
			const { body } = await explanation(directory, row.id);
			assert.ok(body.includes(row.outcome));
			assert.ok(body.includes("Same body."));
		}
	}, { task: "- [x] **FP-1 — Same**\n  Same body.\n- [ ] **FP-2 — Same**\n  Same body.\n" });
});

test("explaining an unknown capability says so instead of opening an empty overlay", async () => {
	await withRepository(async (directory) => {
		const { body, notified } = await explanation(directory, "not-a-capability");
		assert.equal(body, "");
		assert.ok(notified.some((message) => message.includes("not-a-capability")));
	});
});

test("the explanation renders every lettered cut and dotted step inside its functional-point row", async () => {
	await withRepository(async (directory) => {
		const id = readProjectMapDisplay(directory).map?.capabilities.find((capability) => capability.outcome === "FP-1 — Provisioning")?.id;
		assert.equal(id, "provisioning");
		const steps = [
			["~", "FP-1a", "First cut"], ["x", "FP-1a.1", "First cut one"], [" ", "FP-1a.2", "First cut two"], ["x", "FP-1a.3", "First cut three"], [" ", "FP-1a.4", "First cut four"], ["~", "FP-1a.5", "First cut five"], ["x", "FP-1a.6", "First cut six"],
			[" ", "FP-1b", "Second cut"], ["x", "FP-1b.0", "Second cut zero"], ["~", "FP-1b.1a", "Second cut one-a"], [" ", "FP-1b.1", "Second cut one"], ["x", "FP-1b.2", "Second cut two"], [" ", "FP-1b.3", "Second cut three"], ["x", "FP-1b.3a", "Second cut three-a"], ["x", "FP-1b.3a-b", "Second cut three-a-b"], ["~", "FP-1b.3b", "Second cut three-b"], ["x", "FP-1b.4", "Second cut four"], [" ", "FP-1b.5", "Second cut five"], ["x", "FP-1b.6", "Second cut six"], ["~", "FP-1b.7", "Second cut seven"], ["x", "FP-1b.8", "Second cut eight"],
		] as const;
		writeFileSync(join(directory, "odd", "tasks", "provisioning-steps.md"), `${steps.map(([checkbox, code, title]) => `- [${checkbox}] **${code} — ${title}**`).join("\n")}\n`, "utf8");
		const { body } = await explanation(directory, id);
		assert.ok(body.includes("Subelementos: 21"));
		for (const [checkbox, code, title] of steps) {
			const state = checkbox === "x" ? "done" : checkbox === "~" ? "active" : "planned";
			const indentation = "  ".repeat((code.match(/\./g) ?? []).length + 1);
			assert.ok(body.includes(`${indentation}· ${code} — ${title} · ${PROJECT_MAP_STATE_GLYPH[state]}`), code);
		}
		assert.ok(body.includes("The body line the document carries."));
	}, { task: "- [ ] **FP-1 — Provisioning**\n  The body line the document carries.\n" });
});

test("the explanation honors a document's declared parent for coded and uncoded sub-elements", async () => {
	await withRepository(async (directory) => {
		writeFileSync(join(directory, "odd", "tasks", "roadmap.md"), "**Belongs to:** `FP-5`\n- [ ] **FP-5 — Five**\n", "utf8");
		writeFileSync(join(directory, "odd", "tasks", "five-steps.md"), "  * **Belongs to:** `FP-5`\n- [~] **F5b-1 — A different code family**\n  - [x] **A bare declared unit**\n- [ ] **FP-9 — A row is excluded**\n", "utf8");
		const { body } = await explanation(directory, "five");
		assert.ok(body.includes("Subelementos: 2"));
		assert.ok(body.includes(`  · F5b-1 — A different code family · ${PROJECT_MAP_STATE_GLYPH.active}`));
		assert.ok(body.includes(`  · A bare declared unit · ${PROJECT_MAP_STATE_GLYPH.done}`));
		assert.equal(body.includes("A row is excluded"), false);
	});
});

test("source reads distinguish absent, malformed, and unreadable repository sources", async () => {
	await withRepository(async (directory) => {
		writeFileSync(join(directory, "package.json"), "{");
		assert.match(readRepositorySources(directory).omissions.join("\n"), /could not be parsed/);
		const unreadable = join(directory, "odd/tasks/unreadable.md");
		mkdirSync(unreadable);
		assert.match(readRepositorySources(directory).omissions.join("\n"), /unreadable.md exists but could not be read/);
	});
});
