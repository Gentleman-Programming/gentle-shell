import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readProjectMapCoordinationState } from "../lib/project-map-coordination-state.ts";
import { resolveProjectMapStoreRoot } from "../lib/project-map-store-root.ts";
import { listProjectMapStoreWorktreeBindings } from "../lib/project-map-store-worktrees.ts";
import { readProjectMapStoreHeartbeat } from "../lib/project-map-store-heartbeats.ts";
import { collectProjectMapSteps, deriveProjectMap, splitWorkUnitLabel } from "../lib/shell-project-map-draft.ts";
import { readCapabilityDescription, type ProjectMapDescription } from "../lib/project-map-description.ts";
import { PROJECT_MAP_TRANSLATIONS_PATH, projectMapTranslationFor, readProjectMapTranslations } from "../lib/project-map-translations.ts";
import { buildProjectMapHelpContent, ProjectMapHelpModal, type ProjectMapHelpResult } from "../lib/project-map-help-modal.ts";
import { projectMapCardPart } from "../lib/shell-project-map-card.ts";
import { createOrchestratorSessionTabsSnapshot, orchestratorSessionTabsDigest, orchestratorSessionTabsRail, renderOrchestratorSessionTabDetail } from "../lib/shell-project-map-tabs.ts";
import { listPresence } from "../lib/orchestrator-presence.ts";
import { sidebarHeaderContributor, sidebarState } from "../lib/shell-sidebar.ts";
import { resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import type { CardTheme } from "../lib/shell-card.ts";
import { invalidateSidebar, RAIL_WIDTH } from "../lib/shell-sidebar-layout.ts";
import { PROJECT_MAP_ARTIFACT_PATH, type ProjectMapCapabilityV1 } from "../lib/shell-project-map-schema.ts";
import { orderCapabilitiesForDisplay } from "../lib/shell-project-map-display-order.ts";
import {
	PROJECT_MAP_EXPANDED,
	PROJECT_MAP_OVERLAY_UNAVAILABLE,
	type ProjectMapCardState,
	projectMapCoverage,
	projectMapCoverageLines,
	projectMapStaticBlockers,
	toggleProjectMapGroup,
	type ProjectMapCollapseState,
	type ProjectMapGroup,
} from "../lib/shell-project-map-view.ts";

// The Project Map is a read-only projection of the project's functional points.
export const PROJECT_MAP_WIDGET_KEY = "gentle-project-map";
export const PROJECT_MAP_COLLAPSE_KEY_DEFAULT = "alt+m";
export const PROJECT_MAP_NEXT_KEY_DEFAULT = "alt+j";
export const PROJECT_MAP_PREV_KEY_DEFAULT = "alt+k";
export const PROJECT_MAP_HELP_KEY_DEFAULT = "alt+e";

function projectMapKey(value: string | undefined, fallback: string): string | undefined {
	if (value === undefined || value === "") return fallback;
	return value.toLowerCase() === "off" ? undefined : value;
}

export function parseProjectMapCollapseKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return projectMapKey(env.GENTLE_PI_PROJECT_MAP_KEY?.trim(), PROJECT_MAP_COLLAPSE_KEY_DEFAULT);
}

export function parseProjectMapNextKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return projectMapKey(env.GENTLE_PI_PROJECT_MAP_NEXT_KEY?.trim(), PROJECT_MAP_NEXT_KEY_DEFAULT);
}

export function parseProjectMapPrevKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return projectMapKey(env.GENTLE_PI_PROJECT_MAP_PREV_KEY?.trim(), PROJECT_MAP_PREV_KEY_DEFAULT);
}

export function parseProjectMapHelpKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return projectMapKey(env.GENTLE_PI_PROJECT_MAP_HELP_KEY?.trim(), PROJECT_MAP_HELP_KEY_DEFAULT);
}

export interface ProjectMapViewContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify: (message: string) => void;
		/** The synchronous card reports the marker click; the extension awaits the overlay. */
		custom?: <T>(factory: (tui: TUI, theme: CardTheme, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void }, options?: { overlay?: boolean; overlayOptions?: { anchor?: string; width?: number | string; minWidth?: number; maxHeight?: number | string; margin?: number | { top?: number; right?: number; bottom?: number; left?: number } } }) => Promise<T>;
		setWidget?: (key: string, widget: ((tui: TUI, theme: CardTheme) => Component) | undefined, options?: { placement: "belowEditor" }) => void;
	};
	sessionManager?: { getSessionId: () => string | undefined };
}

function sessionKey(ctx: ProjectMapViewContext): string {
	return ctx.sessionManager?.getSessionId() ?? "";
}

/** Flat on purpose: this repository compiles with strict: false. */
interface SourceRead {
	ok: boolean;
	text: string;
	reason: "absent" | "unreadable" | null;
}

function readSource(path: string): SourceRead {
	try {
		return { ok: true, text: readFileSync(path, "utf8"), reason: null };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		return { ok: false, text: "", reason: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable" };
	}
}

/** Explains a capability from its source document, without writing or launching anything. */
export async function explainProjectMapCapability(ctx: ProjectMapViewContext, capabilityId: string, railColumns = 0): Promise<void> {
	const repository = readProjectMapDisplay(ctx.cwd);
	const map = repository.map;
	const capability = map?.capabilities.find((entry) => entry.id === capabilityId);
	if (map === null || capability === undefined) {
		ctx.ui.notify(`No FP work unit named "${capabilityId}" was found in odd/tasks/*.md.`);
		return;
	}
	if (!ctx.hasUI || ctx.ui.custom === undefined) {
		ctx.ui.notify(`Explaining ${capabilityId} needs an interactive session.`);
		return;
	}
	const document = capability.featureDocs[0];
	const source = document === undefined ? null : readSource(join(ctx.cwd, document));
	const label = splitWorkUnitLabel(capability.outcome);
	const code = (label.head.length === 0 ? capability.outcome : label.head.replace(/—\s*$/, "")).trim();
	const description = source !== null && source.ok ? readCapabilityDescription(source.text, capabilityId, code) : null;
	const translated = translatedExplanation(ctx.cwd, capability, description);
	const steps = collectProjectMapSteps(repository.sources.oddTaskDocuments ?? [], code, "FP-");
	const content = buildProjectMapHelpContent(
		translated.capability,
		translated.description,
		projectMapStaticBlockers(map, capabilityId),
		translated.note,
		steps,
		projectMapCoverageLines(map, projectMapCoverage(map)),
	);
	try {
		await ctx.ui.custom<ProjectMapHelpResult>(
			(tui, theme, _keybindings, done) => new ProjectMapHelpModal(content, done, theme, () => Math.max(0, tui.terminal.rows)),
			{ overlay: true, overlayOptions: helpOverlayOptions(railColumns) },
		);
	} catch (error) {
		ctx.ui.notify(`The capability could not be explained: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** A missing or stale stored translation falls back to the document's own words. */
function translatedExplanation(cwd: string, capability: ProjectMapCapabilityV1, description: ProjectMapDescription | null): { capability: ProjectMapCapabilityV1; description: ProjectMapDescription | null; note: string | undefined } {
	if (description === null) return { capability, description, note: undefined };
	const target = PROJECT_MAP_TRANSLATIONS_PATH;
	const stored = readSource(join(cwd, target));
	if (!stored.ok) return { capability, description, note: `Traducción: no generada` };
	const parsed = readProjectMapTranslations(stored.text);
	if (parsed.translations === null) return { capability, description, note: `Traducción: ${target} no se pudo usar — ${parsed.diagnostics[0] ?? "forma inválida"}` };
	const lookup = projectMapTranslationFor(parsed.translations, capability.id, description.lines);
	if (lookup.translation === null) {
		return { capability, description, note: lookup.state === "stale" ? `Traducción: desactualizada, el documento cambió` : `Traducción: no generada` };
	}
	const translation = lookup.translation;
	const { head } = splitWorkUnitLabel(capability.outcome);
	// Stored titles can already carry the code with their own spacing.
	const flattened = (value: string): string => value.replace(/\s+/g, "");
	const translatedTitle = translation.title;
	const carriesHead =
		translatedTitle !== undefined && head.length > 0 && flattened(splitWorkUnitLabel(translatedTitle).head) === flattened(head);
	const outcome = translatedTitle === undefined
		? capability.outcome
		: head.length === 0 || carriesHead
			? translatedTitle
			: `${head}${translatedTitle}`;
	return {
		capability: translation.title === undefined ? capability : { ...capability, outcome },
		description: { title: description.title, lines: translation.lines },
		note: undefined,
	};
}

function helpOverlayOptions(railColumns: number): { anchor: string; width: string; minWidth: number; maxHeight: string; margin?: { left: number; right: number } } {
	if (railColumns <= 0) return { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" };
	return { anchor: "left-center", width: "70%", minWidth: 60, maxHeight: "85%", margin: { left: 2, right: railColumns + 2 } };
}

export function readRepositorySources(cwd: string): { sources: { packageJson?: unknown; oddTaskDocuments?: { path: string; text: string }[] }; omissions: string[] } {
	const omissions: string[] = [];
	const sources: { packageJson?: unknown; oddTaskDocuments?: { path: string; text: string }[] } = {};
	const manifest = readSource(join(cwd, "package.json"));
	if (manifest.ok) {
		try {
			sources.packageJson = JSON.parse(manifest.text);
		} catch {
			omissions.push("package.json could not be parsed as JSON, so the project identity could not be derived from it.");
		}
	} else if (manifest.reason === "unreadable") {
		omissions.push("package.json exists but could not be read, so the project identity could not be derived from it.");
	}
	const tasksRoot = join(cwd, "odd", "tasks");
	const documents: { path: string; text: string }[] = [];
	const hasTasksRoot = existsSync(tasksRoot);
	if (hasTasksRoot) {
		for (const name of readdirSync(tasksRoot).sort()) {
			if (!name.endsWith(".md")) continue;
			const path = `odd/tasks/${name}`;
			const document = readSource(join(cwd, path));
			if (document.ok) documents.push({ path, text: document.text });
			else if (document.reason === "unreadable") omissions.push(`${path} exists but could not be read, so it contributed no capability.`);
		}
	}
	if (hasTasksRoot || documents.length > 0) sources.oddTaskDocuments = documents;
	return { sources, omissions };
}

export function readProjectMapDisplay(cwd: string) {
	const repository = readRepositorySources(cwd);
	const derived = deriveProjectMap(repository.sources, basename(resolve(cwd)) || "project");
	// Display follows the functional points' own order, never the canonical identifier sort.
	const map = derived.map === null ? null : orderCapabilitiesForDisplay(derived.map);
	return { ...derived, map, sources: repository.sources, omissions: [...repository.omissions, ...derived.omissions] };
}

function displayCardState(cwd: string): ProjectMapCardState {
	const { map } = readProjectMapDisplay(cwd);
	const overlay = PROJECT_MAP_OVERLAY_UNAVAILABLE;
	return map === null ? { kind: "no-fp", path: cwd, overlay } : { kind: "ready", path: cwd, map, coverage: projectMapCoverage(map), overlay, derived: true };
}

interface ProjectMapSessionRecord {
	collapse: ProjectMapCollapseState;
	selection: string | undefined;
	tabsSelection: string | undefined;
}

export const PROJECT_MAP_TABS_CONTRIBUTOR_KEY = "orchestrator-tabs";
// Bound store reads to one snapshot per window, not one directory scan per frame.
const PROJECT_MAP_TABS_REFRESH_MS = 2_000;

const projectMapTabsReaders = {
	coordination: ({ root, mapPath, now }: { root: string; mapPath: string; now: string }) => readProjectMapCoordinationState({ root, mapPath, now }),
	worktreeBindings: (root: string) => {
		const listed = listProjectMapStoreWorktreeBindings({ root });
		return {
			bindings: listed.bindings.map((binding) => ({ capabilityId: binding.capability_id, sessionId: binding.session_id, branch: binding.branch, worktreeRoot: binding.worktree_root })),
			diagnostics: listed.diagnostics,
		};
	},
	presenceAlive: (profile: string | undefined, sessionIds: readonly string[]) => {
		if (profile === undefined) return null;
		const page = listPresence(profile, Date.now());
		if (page.unavailable !== undefined) return null;
		const present = new Set(page.entries.map((entry) => entry.sessionHash));
		return new Set(sessionIds.filter((sessionId) => present.has(createHash("sha256").update(sessionId).digest("hex"))));
	},
	lastActivity: (root: string, sessionId: string) => readProjectMapStoreHeartbeat({ root, sessionId, now: new Date().toISOString() }).heartbeat?.beat_at,
};

export default function gentleProjectMap(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const sessions = new Map<string, ProjectMapSessionRecord>();
	const mounted = new Map<string, { part: Component & { dispose?(): void }; tui: TUI; disposeTabs?: () => void }>();
	const collapseKey = parseProjectMapCollapseKey(env);
	const nextKey = parseProjectMapNextKey(env);
	const prevKey = parseProjectMapPrevKey(env);
	const helpKey = parseProjectMapHelpKey(env);
	const record = (ctx: ProjectMapViewContext): ProjectMapSessionRecord => {
		const key = sessionKey(ctx);
		const existing = sessions.get(key);
		if (existing) return existing;
		const created = { collapse: { ...PROJECT_MAP_EXPANDED }, selection: undefined, tabsSelection: undefined };
		sessions.set(key, created);
		return created;
	};
	const refresh = (ctx: ProjectMapViewContext) => {
		const current = mounted.get(sessionKey(ctx));
		if (!current) return;
		invalidateSidebar(current.tui);
		(current.tui as unknown as { requestRender?: () => void }).requestRender?.();
	};
	const unmount = (ctx: ProjectMapViewContext) => {
		const key = sessionKey(ctx);
		const current = mounted.get(key);
		current?.disposeTabs?.();
		current?.part.dispose?.();
		ctx.ui.setWidget?.(PROJECT_MAP_WIDGET_KEY, undefined);
		if (current) refresh(ctx);
		mounted.delete(key);
	};
	const mount = (ctx: ProjectMapViewContext) => {
		if (!ctx.ui.setWidget) return;
		const key = sessionKey(ctx);
		const path = join(ctx.cwd, PROJECT_MAP_ARTIFACT_PATH);
		ctx.ui.setWidget(PROJECT_MAP_WIDGET_KEY, (tui, theme) => {
			const session = {
				collapse: () => record(ctx).collapse,
				selection: () => record(ctx).selection,
				select: (id: string | undefined) => {
					record(ctx).selection = id;
					refresh(ctx);
				},
				toggle: (group: ProjectMapGroup) => {
					const current = record(ctx);
					current.collapse = toggleProjectMapGroup(current.collapse, group);
					refresh(ctx);
				},
			};
			// Tabs lend their read-only detail to the card and their row to the header.
			const storeRoot = (() => {
				try { return resolveProjectMapStoreRoot(ctx.cwd).root; } catch { return null; }
			})();
			const tabs = storeRoot === null ? undefined : (() => {
				try {
					return createOrchestratorSessionTabsSnapshot({
						root: storeRoot,
						mapPath: path,
						profile: resolveGentlePiAgentHome(env),
						readers: projectMapTabsReaders,
						now: () => Date.now(),
						refreshMs: PROJECT_MAP_TABS_REFRESH_MS,
					});
				} catch { return undefined; }
			})();
			const part = projectMapCardPart(tui, path, theme, session, collapseKey, tabs === undefined ? undefined : {
				lines: (width: number) => renderOrchestratorSessionTabDetail({ tabs: tabs.read(), selection: record(ctx).tabsSelection, width, theme }),
				digest: () => `tabs:${orchestratorSessionTabsDigest(tabs.read(), record(ctx).tabsSelection)}`,
			}, (capabilityId) => { void explainProjectMapCapability(ctx, capabilityId, sidebarState(tui).active ? RAIL_WIDTH : 0); }, () => displayCardState(ctx.cwd));
			const disposeTabs = tabs === undefined ? undefined : sidebarHeaderContributor(tui, PROJECT_MAP_TABS_CONTRIBUTOR_KEY, orchestratorSessionTabsRail({
				read: () => tabs.read(),
				selection: {
					selected: () => record(ctx).tabsSelection,
					select: (capabilityId) => {
						record(ctx).tabsSelection = capabilityId;
						refresh(ctx);
					},
				},
				theme,
			}));
			mounted.set(key, { part, tui, disposeTabs });
			return part;
		}, { placement: "belowEditor" });
	};

	if (collapseKey) {
		pi.registerShortcut(collapseKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Collapse or expand the Project Map groups",
			handler: async (ctx) => {
				const viewCtx = ctx as unknown as ProjectMapViewContext;
				if (!mounted.has(sessionKey(viewCtx))) {
					viewCtx.ui.notify("Project Map card is hidden for this session.");
					return;
				}
				const current = record(viewCtx);
				const allCollapsed = current.collapse.foundations && current.collapse.capabilities;
				current.collapse = allCollapsed ? { ...PROJECT_MAP_EXPANDED } : { foundations: true, capabilities: true };
				refresh(viewCtx);
			},
		});
	}
	const selectBy = (offset: -1 | 1) => async (ctx: unknown) => {
		const viewCtx = ctx as ProjectMapViewContext;
		if (!mounted.has(sessionKey(viewCtx))) {
			viewCtx.ui.notify("Project Map card is hidden for this session.");
			return;
		}
		const map = readProjectMapDisplay(viewCtx.cwd).map;
		const capabilities = map?.capabilities ?? [];
		const current = record(viewCtx);
		if (capabilities.length > 0) {
			const index = capabilities.findIndex((capability) => capability.id === current.selection);
			const next = capabilities[index < 0 ? 0 : Math.max(0, Math.min(capabilities.length - 1, index + offset))]!;
			current.selection = next.id;
			if (current.collapse.capabilities) current.collapse = { ...current.collapse, capabilities: false };
		}
		refresh(viewCtx);
	};
	if (nextKey) pi.registerShortcut(nextKey as Parameters<ExtensionAPI["registerShortcut"]>[0], { description: "Select the next Project Map capability", handler: selectBy(1) });
	if (prevKey) pi.registerShortcut(prevKey as Parameters<ExtensionAPI["registerShortcut"]>[0], { description: "Select the previous Project Map capability", handler: selectBy(-1) });
	if (helpKey) pi.registerShortcut(helpKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Explain the selected Project Map capability",
		handler: async (ctx) => {
			const viewCtx = ctx as unknown as ProjectMapViewContext;
			const selection = record(viewCtx).selection;
			if (selection === undefined) {
				viewCtx.ui.notify("Select a Project Map capability first, then explain it.");
				return;
			}
			const current = mounted.get(sessionKey(viewCtx));
			await explainProjectMapCapability(viewCtx, selection, current !== undefined && sidebarState(current.tui).active ? RAIL_WIDTH : 0);
		},
	});
	pi.on("session_start", (_event, ctx) => mount(ctx as unknown as ProjectMapViewContext));
	pi.on("session_shutdown", (_event, ctx) => {
		const viewCtx = ctx as unknown as ProjectMapViewContext;
		unmount(viewCtx);
		sessions.delete(sessionKey(viewCtx));
	});
}
