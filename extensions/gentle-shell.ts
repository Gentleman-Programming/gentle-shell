import { sharedCooldown, syncUsageCooldown } from "../lib/model-fallback-policy.ts";
import { CustomEditor, keyHint, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isHomeOrBroadUserDirectory } from "../lib/bounded-writer-admission.ts";
import { Editor, Image, Key, decodeKittyPrintable, getCapabilities, isKeyRelease, matchesKey, parseKey, truncateToWidth, visibleWidth, type Component, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { readClipboardImage, type ClipboardImage } from "../lib/clipboard-image.ts";
import { readPastedImagePaths } from "../lib/pasted-image-paths.ts";
import { describeAttachment, ImageAttachments } from "../lib/image-attachments.ts";
import { defaultCacheRoot, ImageDiskCache } from "../lib/image-disk-cache.ts";
import { execFile, spawnSync } from "node:child_process";
import { openInExternalEditor, type ExternalEditorHost } from "../lib/external-editor.ts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { profilesFilePath, profileRoleEntries, readProfilesFileResult } from "../lib/agent-profiles.ts";
import { resolveSessionProfile, sessionProfileLabel, sessionProfileModelProfiles } from "../lib/session-profile-freeze.ts";
import * as os from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { buildShellHeaderModel, renderShellBar, renderShellBelowInputFloat, renderShellBottomOnlyBar, renderShellHeaderChrome, renderShellSidebarBar, renderShellStatusBar, renderShellStatusSections, renderShellChromeBar, renderShellChromePad, renderShellTitleRow, type StatusSection, type StatusTarget, keepNativeWorkingRow, shellEnabled, shellHeaderUsageHit, shellJobsCount, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { CHANGE_STATUS, DIFF_MAX_BYTES, DIFF_MAX_LINES, DIFF_TOO_LARGE, ChangesTracker, WorktreeChangesTracker, changesDigest, renderChangesWidget, type ChangedFile, type ChangesModel, type FileRevision, type GitRunner, type LineCounter, type WorktreeChanges } from "../lib/shell-changes.ts";
import { WorktreeChangesView } from "../lib/shell-changes-view.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import { windowsProcessTreeKiller, type ProcessTreeKiller } from "../lib/native-review-cli.ts";
import { SessionWorktreeRegistry, resolveSessionWorktree, worktreeGitEnvironment, type WorktreeResolver, type WorktreeIdentity } from "../lib/session-worktree-registry.ts";
import { CARD_STYLE, CARD_TONE, cardStyle, panelHeaderRow, panelInnerWidth, renderCard, setCardStyle, type Card, type CardTheme } from "../lib/shell-card.ts";
import { resolveCardStyle, writeCardStyle } from "../lib/card-style-policy.ts";
import { CARD_CONTENT, resolveCardContent, setCardContent, writeCardContent } from "../lib/card-content-policy.ts";
import { CommandPalette, commandsKey, type CommandPaletteResult } from "../lib/command-palette.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { buildKeymapRows } from "../lib/keymaps-customize.ts";
import { discoverYoloUiAdapter, MODE_STATUS_KEY, YOLO_DISPLAY, YOLO_STATUS_KEY, type YoloDisplay, type YoloUiAdapter } from "../lib/yolo-session-policy.ts";
import { discoverRddModeControl, type RddModeControl } from "../lib/rdd-mode-control.ts";
import { NATIVE_REVIEW_MODE_SOURCE } from "../lib/native-review-cli.ts";
import { VisualCustomizeView, type CustomizeCategory, type CustomizeRow, type ProfileActions } from "../lib/visual-customize-view.ts";
import { deleteVisualProfile, getVisualProfile, listVisualProfiles, resetVisualProfiles, saveVisualProfile } from "../lib/visual-profiles.ts";
import { gaugePaintFor } from "../lib/gauge-theme.ts";
import type { GaugePaint } from "../lib/shell-gauge.ts";
import { sourcePalettePreview } from "../lib/theme-customization.ts";
import { applyVisualPreset, CHROME_SURFACE, DEFAULT_VISUAL_SETTINGS, DENSITY, HEADER_PLACEMENT, STATUS_PLACEMENT, VISUAL_PRESET, VISUAL_SECTION_KEYS, resolveVisualSettings, visualPresetOf, writeVisualSettings, type VisualPreset } from "../lib/visual-customization-policy.ts";
import { BANNER_COLORS, DEFAULT_BANNER_CONFIG, readBannerConfig, readBannerConfigForEdit, writeBannerConfig } from "./startup-banner.ts";
import { commandKeymapId, commandKeymapIds, effectiveKey, keymapCommand, keymapLabel, keymapSavedNotice, loadKeymaps, prepareKeymapChange, writeKeymaps, type KeymapBindings, type PiKeybindings } from "../lib/keymaps.ts";
import { GentleAiDevBinaryOverrideError, resolveGentleAiDevBinaryOverride } from "../lib/gentle-ai-binary.ts";
import { DOUBLE_ESC_CANCEL_HINT, floatPromptRow, framePromptLines, panelPromptRow, resolvePromptLayout, IDLE_ESC_CLEAR_HINT, PANEL_BUTTON, PROMPT_HINT, PROMPT_STATE, SHELL_PULSE_MS, SHELL_PULSE_WATCHDOG_MS, withPromptHint, workingTick, type PromptState } from "../lib/shell-prompt.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { CLAUDE_BRIDGE_PROVIDER, priceBridgeMessage } from "../lib/bridge-cost.ts";
import { inferOddPhase } from "../lib/odd-phase-inference.ts";
import { isInteractiveMode } from "../lib/rpc-host.ts";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { resolveAnimationPolicy, writeAnimationPolicy, type AnimationPolicy } from "../lib/animation-policy.ts";
import { resolveVimPolicy, writeVimPolicy, type VimPolicy } from "../lib/vim-policy.ts";
import { resolveSidebarTabs, writeSidebarTabs } from "../lib/sidebar-tabs-policy.ts";
import { resolveHistoryCapture, writeHistoryCapturePolicy } from "../lib/history-capture-policy.ts";
import { HERDR_TASK_SUMMARY_CHANGED, resolveHerdrTaskSummarySettings, writeHerdrTaskSummarySettings } from "../lib/herdr-task-summary-policy.ts";
import { createRequire } from "node:module";
import { createVimEditorAdapter, isAuditedPiEditorVersion } from "../lib/vim-editor-adapter.ts";
import { VimNormalEngine } from "../lib/vim-normal-engine.ts";
import { VimOperatorEngine, type OperatorResult } from "../lib/vim-operator-engine.ts";
import { VimVisualEngine } from "../lib/vim-visual-engine.ts";

// Canonical entrypoint and index patterns across POSIX and Windows separators.
// Exported for cross-platform unit testing of candidate path resolution.
export const VIM_CLI_ENTRY_PATTERN = /(?:^|[\\/])dist[\\/]bundle[\\/]cli\.js$/;
export const VIM_AGENT_INDEX_PATTERN = /(?:^|[\\/])dist[\\/]index\.js$/;

// Candidate paths provide only package roots, never version authority. Both
// constructors must come from that same canonical agent/TUI pair before its
// metadata can admit private editing (jiti may alias imports to host modules).
export function resolveVimRuntime(entry = process.argv[1], customClass: typeof CustomEditor = CustomEditor):
	{ version: string; editorClass: typeof Editor } | undefined {
	const editorPrototype = Object.getPrototypeOf(customClass.prototype) as typeof Editor.prototype | undefined;
	const editorClass = editorPrototype?.constructor as typeof Editor | undefined;
	const candidates: string[] = [];
	// Audited CLIs (AUDITED_PI_EDITOR_VERSIONS) use the bundled virtual module graph.
	// Its public index exports the very CustomEditor class supplied to extensions by that graph.
	try {
		if (entry) {
			const cli = realpathSync(entry);
			if (VIM_CLI_ENTRY_PATTERN.test(cli)) {
				const root = resolve(dirname(cli), "../..");
				const bundlePath = resolve(root, "dist", "bundle", "index.js");
				if (realpathSync(bundlePath) === bundlePath) {
					const requireFromBundle = createRequire(bundlePath);
					const bundled = requireFromBundle(bundlePath) as { CustomEditor?: typeof CustomEditor; VERSION?: string };
					const metadata = requireFromBundle(resolve(root, "package.json")) as { name?: string; version?: string };
					if (metadata.name === "@earendil-works/pi-coding-agent" && isAuditedPiEditorVersion(metadata.version) &&
						bundled.VERSION === metadata.version && bundled.CustomEditor === customClass &&
						typeof editorClass === "function" && editorClass.name === "Editor" &&
						editorPrototype === editorClass.prototype &&
						Object.getPrototypeOf(customClass) === editorClass) {
						return { version: metadata.version, editorClass };
					}
				}
			}
		}
	} catch { /* Unknown bundled host: do not authorize private editing. */ }
	try {
		if (entry) {
			const cli = realpathSync(entry);
			if (VIM_CLI_ENTRY_PATTERN.test(cli)) candidates.push(resolve(dirname(cli), "../.."));
		}
	} catch { /* The CLI is only a candidate, not proof. */ }
	try {
		const localIndex = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		if (VIM_AGENT_INDEX_PATTERN.test(localIndex)) candidates.push(resolve(dirname(localIndex), ".."));
	} catch { /* No local candidate; do not trust extension-relative metadata. */ }
	for (const root of new Set(candidates)) {
		try {
			const agentIndex = realpathSync(resolve(root, "dist", "index.js"));
			if (agentIndex !== resolve(root, "dist", "index.js")) continue;
			const requireFromRuntime = createRequire(agentIndex);
			const agent = requireFromRuntime(agentIndex) as { CustomEditor?: typeof CustomEditor };
			const agentMetadata = requireFromRuntime(resolve(root, "package.json")) as { version?: string; name?: string };
			const tuiPath = realpathSync(requireFromRuntime.resolve("@earendil-works/pi-tui"));
			const tui = requireFromRuntime(tuiPath) as { Editor?: typeof Editor };
			const tuiRoot = resolve(dirname(tuiPath), "..");
			const tuiMetadata = requireFromRuntime(resolve(tuiRoot, "package.json")) as { version?: string; name?: string };
			if (agent.CustomEditor === customClass && tui.Editor === editorClass &&
				agentMetadata.name === "@earendil-works/pi-coding-agent" && tuiMetadata.name === "@earendil-works/pi-tui" &&
				isAuditedPiEditorVersion(agentMetadata.version) &&
				agentMetadata.version === tuiMetadata.version) return { version: tuiMetadata.version, editorClass };
		} catch { /* Unknown package or constructor: ordinary editing stays active. */ }
	}
	return undefined;
}
import {
	DOUBLE_ESC_CANCEL_WINDOW_MS,
	resolveDoubleEscCancelPolicy,
	writeDoubleEscCancelPolicy,
	type DoubleEscCancelPolicy,
	type DoubleEscCancelResolution,
} from "../lib/double-esc-cancel-policy.ts";
import { accountIdFromToken, CODEX_PROVIDER, CODEX_USAGE_URL, NAN_PROVIDER, NAN_QUOTA_URL, parseCodexUsage, parseNanQuota, parseProviderUsage, parseUsageHeaders, parseUsageSource, usageScopeProviders, UsageSourceRegistry, UsageStore, USAGE_SOURCE_EVENT, type ProviderUsage, type UsageSource } from "../lib/shell-usage.ts";
import {
	DESKTOP_USAGE_SERVICE_CHANNEL,
	DESKTOP_USAGE_SERVICE_SCHEMA,
	isRefreshableUsageProvider,
	isSupportedUsageProvider,
	type DesktopUsageOwnerRead,
	type DesktopUsageRecordedSnapshot,
	type DesktopUsageService,
} from "../lib/desktop-rpc-usage.ts";
import { UsageView } from "../lib/shell-usage-view.ts";
import { releaseSidebarHover, setSidebarHover, sidebarHeader, sidebarPart, sidebarState, sidebarStatusBar, VISUAL_SETTINGS_CHANGED, type SidebarRail } from "../lib/shell-sidebar.ts";
import { installSidebar, invalidateSidebar, narrowStatusOwner, SIDEBAR_BREAKPOINT, STATUS_OWNER } from "../lib/shell-sidebar-layout.ts";
import { SidebarGitCards } from "../lib/git-cards.ts";
import { discoverSidebarGitRoots, type SidebarGitRoots } from "../lib/sidebar-git-roots.ts";
import { chromeSurface, panelSheetBackHit, renderPanelSheet, renderWorkRow, setChromeSurface, workRowLead } from "../lib/shell-panel.ts";
import { installPagePaint, type PageTheme } from "../lib/shell-page.ts";
import { layoutSchematic } from "../lib/visual-layout-preview.ts";
import { collectSessionStats, type SessionStats } from "../lib/shell-stats.ts";
import { sessionChangeRoots } from "../lib/session-changes.ts";
import { REVIEW_SIDEBAR_EVENT, isReviewSidebarSnapshot, type ReviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";
import { JOBS_SIDEBAR_EVENT, JOBS_STATUS_KEY, isJobsSidebarSnapshot, jobsCollapseKey, type RunningJobDisplay } from "../lib/jobs-sidebar-state.ts";
import { JOBS_FINISHED_TTL_MS, renderJobsSection } from "../lib/jobs-widget.ts";
import { todoCollapseKey } from "../lib/shell-todo.ts";
import { NativePointerRegion } from "../lib/native-pointer-region.ts";
import { installSessionChangeCapture } from "../lib/session-change-capture.ts";
import { SelectionEngine } from "../lib/selection-engine.ts";
import { withOverlayRepaint } from "../lib/overlay-repaint.ts";
import { buildNotificationRows } from "../lib/notification-customize.ts";

// Gentle Shell: the visual layer gentle-pi puts on top of pi. It installs the
// status bar, the petal prompt, the working-tree changes widget and overlay,
// the subscription usage view, and the cards Gentle notices are drawn with.

export interface ShellFooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}

interface ShellRenderHost {
	requestRender(): void;
	invalidateSidebar?(): void;
}

interface ShellBarComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
}

interface BuildOptions {
	jobs?: RunningJobDisplay[];
	profile?: string;
	profileTier?: ShellBarModel["profileTier"];
	home?: string;
	dirty?: number;
	usage?: ProviderUsage;
}

export type DevBinaryNotice = { state: "active"; path: string; sha256: string } | { state: "invalid"; reason: string };

export interface ShellDeps {
	activeProfile(): string | undefined;
	fetch: typeof fetch;
	now(): number;
	devBinary(): DevBinaryNotice | undefined;
	resolveWorktree: WorktreeResolver;
	/** maxBuffer bounds one diff; status and discovery stay unbounded. */
	gitRunner(cwd: string, maxBuffer?: number): GitRunner;
	/** A root Changes may scan: removed worktrees and leftover directories are skipped. */
	rootExists(root: string): boolean;
	/** The Vim editor adapter version injected by deterministic tests. */
	vimRuntimeVersion?(): string | undefined;
	/** Clipboard image source for the prompt's attachment chips; tests inject a fake. */
	readClipboardImage?(): Promise<ClipboardImage | null>;
}

export type ActiveProfileReader = (() => string | undefined) & {
	tier(): ShellBarModel["profileTier"];
	/** The configured profile name (no origin label); memory-only snapshot like tier(). */
	configured(): string | undefined;
	/** The cached role→model routing rows of a profile, defaulting to the configured one; memory-only snapshot. */
	routes(profile?: string): Array<{ role: string; model: string; effort?: string }>;
	bind(cwd: string, resolveWorktree: WorktreeResolver, sessionId?: string): boolean;
	refresh(): boolean;
	reset(): void;
};

// Unbound reads retain the global file-identity cache, including atomic replacements.
// Bound reads are snapshots: no filesystem or Git work is done during a frame.
export function createActiveProfileReader(env: NodeJS.ProcessEnv = process.env): ActiveProfileReader {
	const path = profilesFilePath(gentlePiConfigHome(env));
	let fingerprint: string | undefined;
	let name: string | undefined;
	let tiers: Record<string, ShellBarModel["profileTier"]> = {};
	let routes: Record<string, Array<{ role: string; model: string }>> = {};
	let effectiveTier: ShellBarModel["profileTier"];
	let bound = false;
	let cwd: string | undefined;
	let identity: WorktreeIdentity | undefined;
	let sessionId: string | undefined;
	let effective: string | undefined;
	let effectiveConfig: string | undefined;
	const global = () => {
		try {
			const stat = statSync(path, { bigint: true });
			const next = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			if (next !== fingerprint) {
				const result = readProfilesFileResult(path);
				name = result.status === "valid" ? result.file.active : undefined;
				tiers = result.status === "valid" ? Object.fromEntries(Object.entries(result.file.profiles).map(([name, config]) => [name, config.orchestrator?.tier])) : {};
				routes = result.status === "valid" ? Object.fromEntries(Object.entries(result.file.profiles).map(([profileName, config]) => [profileName, profileRoleEntries(config).map(([role, entry]) => ({ role, model: entry.model ?? "inherit", effort: entry.thinking }))])) : {};
				fingerprint = next;
			}
			return name;
		} catch {
			fingerprint = undefined;
			name = undefined;
			routes = {};
			return undefined;
		}
	};
	const reader = (() => bound ? effective : global()) as ActiveProfileReader;
	reader.tier = () => {
		if (bound) return effectiveTier;
		const active = global();
		return active ? tiers[active] : undefined;
	};
	reader.configured = () => {
		if (bound) return effectiveConfig;
		return global() ? name : undefined;
	};
	reader.routes = (profile?: string) => routes[profile ?? (bound ? effectiveConfig : name)] ?? [];
	reader.refresh = () => {
		if (!bound) return false;
		// gentle-shell#1064: the status shows the profile launches use, through
		// the same single rule (explicit Enter binding → profile frozen at
		// startup → live p → P → G only in follow mode), with the existing
		// spelling: "name (session)", "name (local)", "name (repo)", or the bare
		// global name.
		global();
		const selected = cwd === undefined ? undefined : resolveSessionProfile({
			sessionId,
			cwd,
			configHome: gentlePiConfigHome(env),
			resolveWorktree: () => identity,
			env,
		});
		const next = selected ? sessionProfileLabel(selected) : name;
		const configuredName = selected ? selected.kind === "explicit" ? selected.name : selected.profile?.name : name;
		const nextTier = configuredName ? tiers[configuredName] : undefined;
		const changed = next !== effective || nextTier !== effectiveTier;
		effective = next;
		effectiveTier = nextTier;
		effectiveConfig = configuredName;
		return changed;
	};
	reader.bind = (nextCwd, resolveWorktree, nextSessionId) => {
		reader.reset();
		cwd = nextCwd;
		sessionId = nextSessionId;
		try { identity = resolveWorktree(nextCwd, nextCwd); } catch { identity = undefined; }
		bound = true;
		return reader.refresh();
	};
	reader.reset = () => { bound = false; cwd = undefined; identity = undefined; sessionId = undefined; effective = undefined; effectiveTier = undefined; effectiveConfig = undefined; };
	return reader;
}

function ambientDevBinary(): DevBinaryNotice | undefined {
	try {
		const override = resolveGentleAiDevBinaryOverride();
		return override ? { state: "active", path: override.path, sha256: override.sha256 } : undefined;
	} catch (error) {
		if (error instanceof GentleAiDevBinaryOverrideError) return { state: "invalid", reason: error.message };
		return undefined;
	}
}

const defaultShellDeps: Omit<ShellDeps, "activeProfile"> = { fetch: (input, init) => globalThis.fetch(input, init), now: () => Date.now(), devBinary: ambientDevBinary, resolveWorktree: resolveSessionWorktree, gitRunner: (cwd, maxBuffer) => shellGitRunner(cwd, process.env, execFile, maxBuffer), rootExists: (root) => existsSync(join(root, ".git")) };

interface AssistantUsageEntry {
	type: string;
	message?: {
		role?: string;
		usage?: {
			cost?: { total?: number };
		};
	};
}

function shortenHome(cwd: string, home: string | undefined): string {
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function sessionCost(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries() as AssistantUsageEntry[]) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		total += entry.message.usage?.cost?.total ?? 0;
	}
	return total;
}

type ShellSessionStats = { costTotal: number; usage: ReturnType<ExtensionContext["getContextUsage"]> };
// The exact identity sessionStats' memo keys on: when any element differs the
// stats are recomputed. Undefined means the host lacks the leaf identity and
// the stats must be computed fresh on every call. Callers that digest live
// state per frame (issue #1681) reuse this key so their own memos can never
// disagree with sessionStats about what is still current.
type SessionStatsKey = readonly [
	sessionId: string | undefined,
	leafId: string | null,
	entryCount: number | undefined,
	model: ExtensionContext["model"],
	contextWindow: number | undefined,
];
const shellSessionStats = new WeakMap<object, { key: SessionStatsKey; stats: ShellSessionStats }>();

function sessionStatsKey(ctx: ExtensionContext): SessionStatsKey | undefined {
	const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & { getEntryCount?(): number };
	// Append-only session entries move the leaf, including compaction and branch
	// switches. A virtual model's routed physical model comes from the latest
	// response, which is appended as an entry, so the leaf covers it as well.
	// Older/test hosts without that identity must stay uncached.
	if (typeof manager.getLeafId !== "function") return undefined;
	return [manager.getSessionId(), manager.getLeafId(), manager.getEntryCount?.(), ctx.model, ctx.model?.contextWindow] as const;
}

function sessionStats(ctx: ExtensionContext): ShellSessionStats {
	const compute = (): ShellSessionStats => ({ costTotal: sessionCost(ctx), usage: ctx.getContextUsage() });
	const key = sessionStatsKey(ctx);
	if (!key) return compute();
	const cached = shellSessionStats.get(ctx.sessionManager);
	if (cached && cached.key.every((value, index) => value === key[index])) return cached.stats;
	const stats = compute();
	shellSessionStats.set(ctx.sessionManager, { key, stats });
	return stats;
}

export function buildShellBarModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	footerData: ShellFooterData,
	options: BuildOptions = {},
): ShellBarModel {
	const home = options.home ?? os.homedir();
	const { usage, costTotal } = sessionStats(ctx);
	const model = ctx.model;
	const entries = Array.from(footerData.getExtensionStatuses().entries())
		.filter(([key]) => key !== "gentle-fast" && (options.jobs === undefined || key !== JOBS_STATUS_KEY))
		.sort(([a], [b]) => a.localeCompare(b));
	const statuses = entries.map(([, text]) => text);
	// The permission mode has its own status keys: the wide chrome shows the mode
	// once in its status bar and the rail only says what it means.
	const modeText = entries.find(([key]) => key === MODE_STATUS_KEY)?.[1];
	const yoloText = entries.find(([key]) => key === YOLO_STATUS_KEY)?.[1];
	const mode = modeText?.replace(/^Permissions:\s*/, "").trim();
	const detail = yoloText?.includes(" — ") ? yoloText.slice(yoloText.indexOf(" — ") + 3).trim() : yoloText?.trim();
	return {
		cwd: shortenHome(ctx.sessionManager.getCwd(), home),
		profile: options.profile,
		...(options.profileTier ? { profileTier: options.profileTier } : {}),
		branch: footerData.getGitBranch(),
		dirty: options.dirty,
		sessionName: ctx.sessionManager.getSessionName(),
		modelId: model?.id ?? "no-model",
		effort: model?.reasoning ? pi.getThinkingLevel() : undefined,
		contextPercent: usage?.percent ?? null,
		contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
		costTotal,
		// claude-bridge runs on a Claude subscription without a Pi OAuth credential.
		subscription: model ? model.provider === CLAUDE_BRIDGE_PROVIDER || ctx.modelRegistry.isUsingOAuth(model) : false,
		usage: options.usage,
		...(options.jobs !== undefined ? { jobs: options.jobs } : {}),
		statuses,
		...(mode ? { permission: { mode, ...(detail ? { detail } : {}) } } : {}),
		integrations: entries.filter(([key]) => key !== MODE_STATUS_KEY && key !== YOLO_STATUS_KEY).map(([, text]) => text),
	};
}

export interface FooterStatusMemoDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	footerData: ShellFooterData;
	usage: () => ProviderUsage | undefined;
	profile: () => string | undefined;
	profileTier?: () => ShellBarModel["profileTier"];
	jobs: () => RunningJobDisplay[] | undefined;
	review: () => ReviewSidebarSnapshot | undefined;
	tracker: () => Pick<WorktreeChangesTracker, "model" | "unbornRoots">;
	visualSettings: () => unknown;
	cardStyle: () => unknown;
}

// Issue #1681: railDigest evaluates every rail's digest before the fullscreen
// layout's prepared cache can answer, so both Status rails digest per
// keystroke and a cache hit still paid for building and serializing the whole
// bar model. The memo keys on the cheap live inputs the model reads instead:
// the digest serializes only this key, and the model is rebuilt just when one
// of those inputs moved. On hosts without leaf identity the session stats
// stay uncached and ride the key by value, so those hosts keep exactly the
// pre-memo digest honesty.
export function createFooterStatusMemo(deps: FooterStatusMemoDeps): { key(): string; model(): ShellBarModel } {
	const { pi, ctx, footerData } = deps;
	let cache: { key: string; model: ShellBarModel } | undefined;
	const key = (): string => {
		const statsKey = sessionStatsKey(ctx);
		const model = ctx.model;
		return JSON.stringify([
			// Session statistics identity by value: without leaf identity the
			// computed stats ride the key, so those hosts keep exactly the pre-memo
			// digest honesty. The model rides its value pieces (id, contextWindow,
			// effort lookup, OAuth state) because that is all buildShellBarModel
			// reads — serializing the model object itself would bloat every digest.
			statsKey ? [statsKey[0], statsKey[1], statsKey[2]] : sessionStats(ctx),
			model?.id ?? null,
			model?.contextWindow ?? null,
			model?.reasoning ? pi.getThinkingLevel() : undefined,
			model ? ctx.modelRegistry.isUsingOAuth(model) : false,
			footerData.getGitBranch(),
			deps.profile(),
			deps.profileTier?.(),
			ctx.sessionManager.getSessionName(),
			ctx.sessionManager.getCwd(),
			[...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b)),
			deps.usage(),
			deps.jobs(),
			deps.review(),
			(() => {
				const { model: changes, unbornRoots } = deps.tracker();
				return { fingerprint: changesFingerprint(changes), files: changes.files.length, added: changes.added, deleted: changes.deleted, unbornRoots: unbornRoots.length };
			})(),
			deps.visualSettings(),
			deps.cardStyle(),
		]);
	};
	const model = (): ShellBarModel => {
		const k = key();
		if (cache?.key === k) return cache.model;
		const tracker = deps.tracker();
		const built: ShellBarModel = {
			...buildShellBarModel(pi, ctx, footerData, { dirty: tracker.model.files.length, usage: deps.usage(), profile: deps.profile(), profileTier: deps.profileTier?.(), jobs: deps.jobs() }),
			changes: { files: tracker.model.files.length, added: tracker.model.added, deleted: tracker.model.deleted },
			review: deps.review(),
		};
		cache = { key: k, model: built };
		return built;
	};
	return { key, model };
}

// Gauge-specific theme roles (issue #2222): resolved from the installed theme
// source and memoized by gauge-theme.ts, so the render hot path only stats the
// theme file. Undefined — and therefore today's shared roles — whenever the theme
// source is unavailable.
function gaugePaint(ctx: ExtensionContext): GaugePaint | undefined {
	const themeName = ctx.ui.theme.name;
	const source = ctx.ui.theme.sourcePath ?? ctx.ui.getAllThemes?.().find((item) => item?.name === themeName)?.path;
	return gaugePaintFor(typeof source === "string" ? source : undefined);
}

export function createShellBarComponent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	host: ShellRenderHost,
	theme: ShellBarTheme,
	footerData: ShellFooterData,
	dirty: () => number | undefined = () => undefined,
	usage: () => ProviderUsage | undefined = () => undefined,
	presentation?: () => ReturnType<typeof resolveVisualSettings>["settings"],
): ShellBarComponent {
	const unsubscribe = footerData.onBranchChange(() => {
		host.invalidateSidebar?.();
		host.requestRender();
	});
	return {
		render(width: number) {
			return renderShellBar(buildShellBarModel(pi, ctx, footerData, { dirty: dirty(), usage: usage() }), theme, width, presentation?.(), gaugePaint(ctx));
		},
		invalidate() {},
		dispose() {
			unsubscribe();
		},
	};
}

interface PromptEditorDeps {
	fg: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	bold: (text: string) => string;
	requestRender(): void;
	pending(): boolean;
	now(): number;
	/** Read fresh on every keypress: the command handler updates this in-memory, the editor never re-reads the file. */
	doubleEscCancelEnabled(): boolean;
	/** Hand off text reconstructed from Pi's Esc-abort restore so it is sent as the next turn instead of sitting in the editor. */
	dispatchQueuedText(text: string): void;
	/** Override only for isolated adapter compatibility tests; production reads installed metadata. */
	tuiVersion?: () => string | undefined;
	/** Report a single warning if this editor cannot safely provide modal editing. */
	notifyCompatibility?: (message: string) => void;
	/**
	 * Read fresh on every render while WORKING: the explicit, orchestrator-reported
	 * ODD phase label for the current session, or undefined to fall back to the
	 * generic "working…" label. Never applied to IDLE or QUEUED.
	 */
	workingLabel?: () => string | undefined;
	/** Pasted images become atomic `[Image#N]` chips; absent, Pi's paste handler runs unchanged. */
	attachments?: ImageAttachments;
	readClipboardImage?: () => Promise<ClipboardImage | null>;
	/** Injectable coarse-animation window; production and tests default to SHELL_PULSE_WATCHDOG_MS. */
	watchdogMs?: number;
	/** Read on every render: true while the wide IDE chrome shows, so the editor draws its panel frame. */
	panelChrome?: () => boolean;
	/** The Panel action is available only in the shell's narrow chrome. */
	panelButton?: () => boolean;
	/** Rows the editor draws right above its rule (the mobile work row, agent questions), so no widget lands between them and the input; `hovered` is the top row under the pointer. */
	topRows?: (width: number, hovered?: number) => string[];
	/** A left click on one of the top rows (index into topRows). */
	onTopRowClick?: (index: number) => void;
	/** Open the same sheet as /gentle:panel. */
	onPanelClick?: () => void;
}

const PROMPT_FRAME_ROLE = "border";
// Matches Pi's own idle double-Esc window (empty editor -> /tree or /fork);
// this is the same muscle memory applied to clearing a non-empty draft.
const IDLE_ESC_CLEAR_WINDOW_MS = 500;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
// Bound our framing buffer even when a terminal never sends the closing marker.
const MAX_BRACKETED_PASTE_CHARS = 1024 * 1024;

/**
 * Pi's own Esc-abort handler (`restoreQueuedMessagesToEditor({ abort: true
 * })`) rebuilds the editor text as
 * `[queuedText, currentText].filter((t) => t.trim()).join("\n\n")`, where
 * `currentText` is the draft captured just before the abort. Reverse that
 * join to recover the queued text alone, so the draft can be restored by
 * itself and the queued text dispatched as the next turn. `draft` is empty
 * (including whitespace-only) whenever `.trim() === ""`, matching the
 * `filter` predicate above exactly.
 *
 * Returns `""` only for the genuine no-queue case (`combined === draft`, or
 * both empty). Returns `undefined` when `combined` does not match Pi's join
 * shape at all — a future Pi change, or anything else that touched the
 * editor during the abort. That distinction matters to the caller: an empty
 * queue means "nothing to restore," while an unrecognized shape means "do
 * not touch what Pi already wrote," so a mismatch is never silently treated
 * as an empty queue.
 */
export function extractQueuedText(combined: string, draft: string): string | undefined {
	if (combined === draft) return "";
	if (draft.trim() === "") return combined;
	const suffix = `\n\n${draft}`;
	return combined.endsWith(suffix) ? combined.slice(0, combined.length - suffix.length) : undefined;
}

export class GentlePromptEditor extends CustomEditor {
	private promptState: PromptState = PROMPT_STATE.IDLE;
	private animationPolicy: AnimationPolicy = "quality";
	private vimPolicy: VimPolicy = "off";
	private vimRejected = false;
	private vimNormal = false;
	private compatibilityNotified = false;
	private readonly vimEngine = new VimNormalEngine();
	private readonly vimOperator = new VimOperatorEngine();
	private vimInsertIntent?: { operator?: OperatorResult; command?: string };
	private readonly vimVisual = new VimVisualEngine();
	private pasteFrame: string | undefined;
	private pasteOverflow = false;
	private pasteTail = "";
	private visualReplacePending = false;
	private visualObjectPending: "i" | "a" | undefined;
	private visualAnchor: { line: number; col: number } | undefined;
	private watchdog: NodeJS.Timeout | undefined;
	private readonly deps: PromptEditorDeps;
	private readonly pointerTui: TUI;
	private floatMouseLayout?: ReturnType<typeof resolvePromptLayout>;
	private topRowCount = 0;
	private hoveredTopRow: number | undefined;
	private hoveredPanel = false;
	private panelStart: number | undefined;
	// Native selection engine (shift+home/end, alt+a, replace-on-key): ported
	// from pi-select-del so the petal prompt owns the feature without factory
	// composition. Constructed with `this`; the internals probe degrades to
	// passthrough on pi drift, costing only the selection features.
	private readonly selectionEngine: SelectionEngine;
	// CustomEditor keeps its own `keybindings` private, so this class holds
	// its own reference to run the same app.interrupt match before deciding
	// whether to swallow the keystroke.
	private readonly keybindingsManager: KeybindingsManager;
	private pendingEscapeCancelDeadline: number | undefined;
	private pendingIdleClearDeadline: number | undefined;
	// Snapshot of the draft at the first Esc; the second Esc only clears when
	// the text is still exactly this, so an edit in between never gets
	// silently discarded (issue #1218 review).
	private pendingIdleClearText: string | undefined;
	// Pi's own paste handler (files, text, unsupported formats). Pi assigns
	// `onPasteImage` after construction; the accessor below keeps it as the
	// fallback and routes every paste key, Vim NORMAL included, to pasteImage.
	private piPasteImage: (() => void) | undefined;
	private pastingImage = false;
	private disposed = false;
	// Counts submitted drafts, so a clipboard read that resolves after its
	// draft was sent never lands in (and rides along with) the next message.
	private submittedDrafts = 0;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, deps: PromptEditorDeps) {
		super(tui, theme, keybindings);
		this.selectionEngine = new SelectionEngine(this);
		this.deps = deps;
		this.pointerTui = tui;
		this.keybindingsManager = keybindings;
		const attachments = deps.attachments;
		if (!attachments || !deps.readClipboardImage) return;
		// SAFETY: Pi's Editor routes cursor movement, wrapping and deletion through
		// its private segment(). Wrapping it only merges registered chips into one
		// segment; if a future Pi drops the method, chips degrade to plain text.
		const host = this as unknown as {
			segment?: (text: string, mode?: string) => Iterable<{ segment: string; index: number; input: string }>;
			handlePaste?: (text: string) => void;
			submitValue?: () => void;
		};
		const segment = host.segment;
		if (typeof segment === "function") host.segment = (text, mode) => attachments.segment(text, segment.call(this, text, mode));
		// SAFETY: Pi hands a complete bracketed paste to its private handlePaste().
		// Wrapping it only turns a paste made of image paths into chips; if a future
		// Pi drops the method, such a paste inserts its paths as text as before.
		const handlePaste = host.handlePaste;
		if (typeof handlePaste === "function") host.handlePaste = (text) => { if (!this.pasteImagePaths(attachments, text)) handlePaste.call(this, text); };
		// SAFETY: Pi empties the draft in its private submitValue() before onSubmit.
		// Counting here only marks the draft boundary; if a future Pi drops the
		// method, a late read falls back to landing in the next draft.
		const submitValue = host.submitValue;
		if (typeof submitValue === "function") host.submitValue = () => { this.submittedDrafts += 1; submitValue.call(this); };
		// Undefined until Pi installs its handler, so Pi's `if (!onPasteImage)`
		// wiring still runs; afterwards every read returns the chip handler.
		Object.defineProperty(this, "onPasteImage", {
			configurable: true,
			enumerable: true,
			get: () => this.piPasteImage ? () => this.pasteImage() : undefined,
			set: (handler: (() => void) | undefined) => { this.piPasteImage = handler; },
		});
	}

	/** Registered image chips on `line`; the Vim adapter keeps NORMAL motions out of them. */
	atomicSpans(line: string): Array<{ start: number; end: number }> {
		return this.deps.attachments?.spans(line) ?? [];
	}

	/** Insert the clipboard image as a chip, or hand the paste to Pi. */
	private pasteImage(): void {
		const attachments = this.deps.attachments;
		const read = this.deps.readClipboardImage;
		if (!attachments || !read) { this.piPasteImage?.(); return; }
		// The Windows clipboard read on WSL takes about a second; a repeated key
		// press during it must not insert a second chip or a stray path.
		if (this.pastingImage) return;
		this.pastingImage = true;
		void this.insertClipboardImage(attachments, read).finally(() => { this.pastingImage = false; });
	}

	private async insertClipboardImage(attachments: ImageAttachments, read: () => Promise<ClipboardImage | null>): Promise<void> {
		const draft = this.submittedDrafts;
		let image: ClipboardImage | null;
		try { image = await read(); } catch { image = null; }
		// A read that outlives this editor (session switch, quit) must not
		// register bytes in the next session or write into a disposed prompt.
		if (this.disposed) return;
		// The draft this paste belonged to was already sent: neither attach the
		// image to the next message nor run Pi's fallback into the new draft.
		if (this.submittedDrafts !== draft) {
			if (image) this.deps.notifyCompatibility?.("Image paste discarded: the message was sent before the clipboard finished reading. Paste again to attach it.");
			return;
		}
		try {
			if (!image) { this.piPasteImage?.(); return; }
			this.insertChip(attachments, image);
		} catch (error) {
			// Never let a paste reject unhandled: Node 24 ends the process on it.
			this.deps.notifyCompatibility?.(`Image paste failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** One `[Image#N]` at the cursor, spaced from adjacent text. */
	private insertChip(attachments: ImageAttachments, image: ClipboardImage): void {
		const { token } = attachments.add(image);
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		const before = cursor.col > 0 && !/\s/.test(line[cursor.col - 1] ?? "") ? " " : "";
		const after = cursor.col < line.length && !/\s/.test(line[cursor.col] ?? "") ? " " : "";
		this.insertTextAtCursor(`${before}${token}${after}`);
		this.deps.requestRender();
	}

	/**
	 * Herdr (desktop app, `--remote`, drops) and file managers paste an image as
	 * a path. Read those synchronously and insert chips; false means the paste is
	 * not only image paths and Pi handles it.
	 */
	private pasteImagePaths(attachments: ImageAttachments, text: string): boolean {
		if (this.disposed || !text) return false;
		let images: ClipboardImage[];
		try { images = readPastedImagePaths(text); } catch { return false; }
		if (images.length === 0) return false;
		try {
			for (const image of images) this.insertChip(attachments, image);
		} catch (error) {
			this.deps.notifyCompatibility?.(`Image paste failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return true;
	}

	setAnimationPolicy(policy: AnimationPolicy): void {
		if (this.animationPolicy === policy) return;
		this.animationPolicy = policy;
		this.stopWatchdog();
		if (this.promptState === PROMPT_STATE.WORKING) this.startWatchdog();
		this.deps.requestRender();
	}

	get effectiveVimPolicy(): VimPolicy { return this.vimPolicy; }

	setVimPolicy(policy: VimPolicy): void {
		this.vimRejected = false;
		if (policy === "on") {
			try { this.vimAdapter(); }
			catch {
				this.vimRejected = true;
				if (!this.compatibilityNotified) {
					this.compatibilityNotified = true;
					this.deps.notifyCompatibility?.("Gentle Vim unsupported by this Pi editor layout/version; ordinary editing remains active.");
				}
				policy = "off";
			}
		}
		if (this.vimPolicy === policy) return;
		this.pasteFrame = undefined;
		this.pasteOverflow = false;
		this.pasteTail = "";
		if (this.vimPolicy === "on" && !this.disablingUnsupportedVim) {
			try { this.vimAdapter().endInsertSession(); } catch { /* Unsupported editor cannot group inserts. */ }
		}
		this.vimInsertIntent = undefined;
		this.vimPolicy = policy;
		this.vimNormal = false;
		this.vimOperator.forgetRepeat();
		this.vimOperator.cancel();
		this.visualAnchor = undefined;
		this.vimVisual.cancel();
		this.visualReplacePending = false;
		this.visualObjectPending = undefined;
		this.deps.requestRender();
	}

	private notifyUnsafeVisual(stage: "range" | "readRange" | "beginInsertSession" | "replace" | "move" | "operation", error?: unknown): void {
		// Only fixed reason codes reach UI; never include a draft, path, or raw host error.
		const message = error instanceof Error ? error.message : "";
		const reason = /duplicate registered paste marker/i.test(message) ? "duplicate-marker" :
			/paste marker/i.test(message) ? "paste-marker" :
			/unsupported pi editor layout/i.test(message) ? "unsupported-layout" :
			/valid grapheme or paste boundary|invalid cursor boundary/i.test(message) ? "invalid-boundary" :
			/invalid selection range|invalid operator range/i.test(message) ? "invalid-range" :
			/insert session already active/i.test(message) ? "session-active" :
			error === undefined ? "no-range" : "unexpected";
		this.deps.notifyCompatibility?.((reason === "paste-marker"
			? "Vim selection contains a registered paste marker; edit it in INSERT mode instead."
			: "Vim selection cannot be edited safely; try a different selection.") + ` [${stage}:${reason}]`);
	}

	private disablingUnsupportedVim = false;
	private vimAdapter(): ReturnType<typeof createVimEditorAdapter> {
		const runtime = resolveVimRuntime();
		try {
			return createVimEditorAdapter(this, this.deps.tuiVersion?.() ?? runtime?.version ?? "unknown", runtime?.editorClass ?? Editor, runtime?.version);
		} catch (error) {
			if (this.vimPolicy === "on" && !this.disablingUnsupportedVim) {
				this.disablingUnsupportedVim = true;
				try { this.setVimPolicy("off"); this.vimRejected = true; } finally { this.disablingUnsupportedVim = false; }
				if (!this.compatibilityNotified) {
					this.compatibilityNotified = true;
					this.deps.notifyCompatibility?.("Gentle Vim unsupported by this Pi editor layout/version; ordinary editing remains active.");
				}
			}
			throw error;
		}
	}

	private enterVimInsert(resetEngine = true, cancelOperator = true, beginSession = true): void {
		if (this.vimNormal && beginSession) {
			try { this.vimAdapter().beginInsertSession(); } catch { /* Unknown layout: normal edits remain disabled. */ }
		}
		this.vimNormal = false;
		if (cancelOperator) this.vimOperator.cancel();
		if (resetEngine) this.vimEngine.reset();
		this.visualAnchor = undefined;
		this.vimVisual.cancel();
		this.visualReplacePending = false;
		this.visualObjectPending = undefined;
		this.deps.requestRender();
	}

	/** Current animation phase: elapsed working time at the policy cadence. */
	private workingPhase(): number {
		// potato never animates (no timer, static petal); quality steps per
		// SHELL_PULSE_MS window; performance keeps the coarse watchdog cadence.
		if (this.animationPolicy === "potato") return 0;
		return workingTick(this.deps.now(), this.animationPolicy === "quality" ? SHELL_PULSE_MS : (this.deps.watchdogMs ?? SHELL_PULSE_WATCHDOG_MS));
	}

	private startWatchdog(): void {
		// Time-based animation: the phase comes from workingPhase(), so this
		// timer only keeps repaints flowing while working — quality pulses at
		// SHELL_PULSE_MS so silent tool runs stay on cadence; potato gets no
		// timer at all (its coarse frames paint only when a repaint happens).
		if (this.animationPolicy === "potato") return;
		const windowMs = this.animationPolicy === "quality" ? SHELL_PULSE_MS : (this.deps.watchdogMs ?? SHELL_PULSE_WATCHDOG_MS);
		this.watchdog = setInterval(() => this.deps.requestRender(), windowMs);
		this.watchdog.unref();
	}

	setWorking(working: boolean): void {
		this.promptState = working ? PROMPT_STATE.WORKING : PROMPT_STATE.IDLE;
		this.stopWatchdog();
		if (!working) {
			this.pendingEscapeCancelDeadline = undefined;
		} else {
			this.pendingIdleClearDeadline = undefined;
			this.pendingIdleClearText = undefined;
			this.startWatchdog();
		}
		this.deps.requestRender();
	}

	/**
	 * Swallow the first Esc while working (issue #1163), opt-in via
	 * doubleEscCancelEnabled(). `pi.registerShortcut("escape")` is not viable
	 * here: Pi reserves app.interrupt and skips colliding extension
	 * shortcuts, so this has to sit in front of CustomEditor's own
	 * handleInput instead. The Esc that actually aborts the turn (the single
	 * Esc when double-esc-cancel is off, or the confirming second Esc when
	 * it is on) always goes through abortAndDispatchQueued so the queued
	 * text Pi would otherwise dump back into the editor is sent as the next
	 * turn instead (issue #1218). Idle double-Esc (tree/fork), bash-mode
	 * Esc, and autocomplete cancel are all decided by CustomEditor/onEscape
	 * and never reach this branch.
	 */
	override handleInput(data: string): void {
		// Selection and Vim handlers can consume input before the native chain;
		// any intervening key invalidates an idle Esc confirmation.
		if (this.pendingIdleClearDeadline !== undefined && !this.keybindingsManager.matches(data, "app.interrupt")) {
			this.pendingIdleClearDeadline = undefined;
			this.pendingIdleClearText = undefined;
		}
		// Vim owns its modal keys and paste frames. Ordinary editing retains
		// native selection before the prompt's existing input chain, but a
		// registered extension shortcut still owns its chord (gentle-shell#1565).
		if (this.vimPolicy === "on") this.handleInputNative(data);
		else this.selectionEngine.handleInput(data, (d) => this.handleInputNative(d), (d) => this.onExtensionShortcut?.(d) === true);
	}

	private handleInputNative(data: string): void {
		if ((this.vimPolicy === "on" || this.vimRejected) && this.handleVimPasteFrame(data)) return;
		if (this.vimPolicy === "on" && isKeyRelease(data)) return;
		if (this.vimPolicy === "on" && this.vimNormal && matchesKey(data, "escape") && this.vimVisual.active) {
			if (this.isShowingAutocomplete()) {
				try { this.vimAdapter().dismissAutocomplete(); } catch { return; }
			}
			this.vimVisual.cancel(); this.visualAnchor = undefined;
			this.visualReplacePending = false; this.visualObjectPending = undefined;
			this.vimOperator.cancel(); this.vimEngine.cancelPendingFind();
			this.deps.requestRender();
			return;
		}
		if (this.vimPolicy === "on" && this.vimNormal && matchesKey(data, "escape") &&
			(this.vimOperator.cancel() || this.vimEngine.cancelPendingFind())) {
			this.deps.requestRender();
			return;
		}
		// Pi owns autocomplete and shell input except while a VISUAL command
		// owns the key. Defer that handoff until after shortcut priority.
		const bashMode = this.getText().trimStart().startsWith("!");
		if (this.vimPolicy === "on" && this.vimNormal && ((this.isShowingAutocomplete() && !this.vimVisual.active) ||
			(bashMode && !this.keybindingsManager.matches(data, "app.interrupt") && !matchesKey(data, "escape")))) {
			this.enterVimInsert();
		}
		if (this.vimPolicy === "on" && !this.vimNormal && !this.isShowingAutocomplete() &&
			(this.keybindingsManager.matches(data, "app.interrupt") || matchesKey(data, "escape"))) {
			try {
				const inserted = this.vimAdapter().endInsertSession();
				if (matchesKey(data, "escape") && inserted && this.vimInsertIntent?.operator)
					this.vimOperator.rememberInsert(this.vimInsertIntent.operator, inserted);
				else if (matchesKey(data, "escape") && inserted && this.vimInsertIntent?.command)
					this.vimOperator.rememberLiteralInsert(this.vimInsertIntent.command, inserted);
			} catch { /* Unknown layout: no grouping or repeat. */ }
			this.vimInsertIntent = undefined;
			this.vimNormal = true;
			this.visualAnchor = undefined;
			this.vimVisual.cancel();
			this.pendingEscapeCancelDeadline = undefined;
			this.pendingIdleClearDeadline = undefined;
			this.pendingIdleClearText = undefined;
			this.deps.requestRender();
			return;
		}
		if (this.vimPolicy === "on" && (!this.isShowingAutocomplete() || this.vimVisual.active) && !bashMode) {
			// CustomEditor gives extension, clipboard and app shortcuts priority
			// over editor input. Preserve that order even when a shortcut shares
			// a modal command key, and transfer ownership before its callback.
			if (this.vimNormal && !this.keybindingsManager.matches(data, "app.interrupt") && !matchesKey(data, "escape")) {
				if (this.onExtensionShortcut) {
					const draft = this.getText();
					const anchor = this.visualAnchor;
					const visualMode = this.vimVisual.kind;
					const replacePending = this.visualReplacePending;
					const objectPending = this.visualObjectPending;
					const restoreMode = () => {
						this.vimNormal = true;
						this.visualAnchor = anchor;
						this.visualReplacePending = replacePending;
						this.visualObjectPending = objectPending;
						if (anchor) this.vimVisual.start(visualMode, anchor);
						this.deps.requestRender();
					};
					this.enterVimInsert(false, false);
					let consumed: boolean;
					try { consumed = this.onExtensionShortcut(data); }
					catch (error) {
						if (this.getText() === draft) {
							try { this.vimAdapter().endInsertSession(); } catch { /* Preserve the callback failure. */ }
							restoreMode();
						} else {
							this.vimOperator.cancel();
							this.vimEngine.reset();
						}
						throw error;
					}
					if (consumed || this.getText() !== draft) {
						this.vimOperator.cancel();
						this.vimEngine.reset();
						return;
					}
					// A non-owning shortcut probe temporarily entered INSERT; close
					// its session before restoring NORMAL and dispatching this key.
					try { this.vimAdapter().endInsertSession(); } catch { return; }
					restoreMode();
				}
				if (this.keybindingsManager.matches(data, "app.clipboard.pasteImage")) {
					this.enterVimInsert();
					this.onPasteImage?.();
					return;
				}
				if (this.keybindingsManager.matches(data, "tui.editor.historyPrevious") ||
					this.keybindingsManager.matches(data, "tui.editor.historyNext")) {
					this.enterVimInsert();
					super.handleInput(data);
					return;
				}
				for (const [action, handler] of this.actionHandlers) {
					if (action !== "app.interrupt" && this.keybindingsManager.matches(data, action)) {
						if (action === "app.exit" && this.getText().length !== 0) continue;
						this.enterVimInsert();
						handler();
						return;
					}
				}
			}
			const parsed = parseKey(data);
			const singleGrapheme = (value: string): boolean =>
				[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1;
			const printable = decodeKittyPrintable(data) ??
				(parsed && singleGrapheme(parsed) ? parsed : undefined) ??
				(singleGrapheme(data) ? data : undefined);
			// Only unmodified presses become modal commands; other shortcuts
			// remain available to Pi's application keybindings.
			const command = printable && (matchesKey(data, printable as Parameters<typeof matchesKey>[1]) || data === printable)
				? printable : matchesKey(data, "space") ? "Space" : undefined;
			// A stale Pi menu must never take a VISUAL motion, count or
			// operator. Dismiss it only after app/extension shortcut priority;
			// outside VISUAL Pi retains its ordinary completion ownership.
			if (this.vimNormal && this.vimVisual.active && this.isShowingAutocomplete()) {
				try { this.vimAdapter().dismissAutocomplete(); } catch { return; }
			}
			if (this.vimNormal && !this.vimVisual.active && command === "/") {
				// Pi 0.85.1 opens slash completion only at the start of the
				// first line. Let its editor insert the slash and decide whether
				// to open the menu; never relocate or replace an existing draft.
				this.enterVimInsert();
				super.handleInput(data);
				return;
			}
			if (this.vimNormal && command) {
				if (this.visualObjectPending && this.vimVisual.active) {
					const around = this.visualObjectPending;
					this.visualObjectPending = undefined;
					try {
						const adapter = this.vimAdapter();
						const stops = adapter.motionBoundaries();
						const range = this.vimVisual.object(this.getText(), this.getCursor(), stops, around, command);
						if (range) {
							adapter.readRange(range.start, range.end);
							const endStops = stops[range.end.line]!;
							const endIndex = endStops.indexOf(range.end.col);
							const last = endIndex > 0 ? { line: range.end.line, col: endStops[endIndex - 1]! } :
								range.end.line > 0 ? { line: range.end.line - 1, col: stops[range.end.line - 1]!.at(-1)! } : undefined;
							if (last) {
								this.visualAnchor = range.start;
								this.vimVisual.start("char", range.start);
								adapter.move(last);
							}
						}
					} catch { /* Registered paste markers and unknown layouts leave the visual range intact. */ }
					this.deps.requestRender(); return;
				}
				if (this.visualReplacePending && this.vimVisual.active) {
					this.visualReplacePending = false;
					if (singleGrapheme(command) && !command.includes("\n")) {
						try {
							const adapter = this.vimAdapter();
							const range = this.vimVisual.range(this.getText(), this.getCursor(), adapter.motionBoundaries());
							if (range) {
								adapter.readRange(range.start, range.end);
								const edit = this.vimOperator.visualEdit("r" + command, this.getText(), range).edit;
								if (edit) { adapter.replace(edit.start, edit.end, edit.text); adapter.move(edit.cursor); }
								this.vimVisual.cancel(); this.visualAnchor = undefined;
								this.vimOperator.cancel(); this.vimEngine.reset();
							}
						} catch { /* Preserve selection when a paste marker or layout is unsafe. */ }
					}
					this.deps.requestRender(); return;
				}
				if (command === "v" || command === "V") {
					if (this.vimVisual.active && this.vimVisual.kind === (command === "v" ? "char" : "line")) {
						this.vimVisual.cancel(); this.visualAnchor = undefined;
					} else {
						let anchor = this.visualAnchor ?? this.getCursor();
						if (command === "v" && !this.vimVisual.active) {
							try {
								const adapter = this.vimAdapter();
								const stops = adapter.motionBoundaries()[anchor.line];
								if (!stops) return;
								if (stops.length > 1 && anchor.col === stops[stops.length - 1]) {
									anchor = { line: anchor.line, col: stops[stops.length - 2]! };
									adapter.move(anchor);
								}
							} catch { return; }
						}
						this.visualAnchor = anchor;
						this.vimVisual.start(command === "v" ? "char" : "line", anchor);
					}
					this.vimOperator.cancel();
					this.vimEngine.reset();
					this.deps.requestRender();
					return;
				}
				let adapter;
				try { adapter = this.vimAdapter(); } catch { return; }
				if (this.vimVisual.active) {
					if (command === "i" || command === "a") { this.visualObjectPending = command; return; }
					if (command === "r") { this.visualReplacePending = true; return; }
					if (command === "o") {
						const target = this.vimVisual.swap(this.getCursor());
						if (target) { this.visualAnchor = this.getCursor(); adapter.move(target); }
						this.deps.requestRender(); return;
					}
					if (["d", "x", "c", "s", "y", "p", "~", "u", "U", ">", "<", "J"].includes(command)) {
						let range;
						try { range = this.vimVisual.range(this.getText(), this.getCursor(), adapter.motionBoundaries()); }
						catch (error) { this.notifyUnsafeVisual("range", error); return; }
						if (!range) { this.notifyUnsafeVisual("range"); return; }
						let stage: "readRange" | "operation" | "beginInsertSession" | "replace" | "move" = "readRange";
						let beganInsert = false;
						try {
							const selected = adapter.readRange(range.start, range.end);
							if (!selected && (!range.linewise || !this.getText())) {
								this.vimVisual.cancel(); this.visualAnchor = undefined;
								this.vimEngine.reset(); this.deps.requestRender();
								return;
							}
							stage = "operation";
							const operation = this.vimOperator.visualEdit(command === "x" ? "d" : command === "s" ? "c" : command, this.getText(), range);
							if (command === "p" && !operation.edit) {
								this.deps.notifyCompatibility?.("Vim register is empty; yank text before visual paste.");
								return;
							}
							if (operation.edit) {
								this.vimOperator.forgetRepeat();
								if (operation.edit.insert) { stage = "beginInsertSession"; adapter.beginInsertSession(); beganInsert = true; }
								if (operation.edit.start.line !== operation.edit.end.line || operation.edit.start.col !== operation.edit.end.col || operation.edit.text) {
									stage = "replace"; adapter.replace(operation.edit.start, operation.edit.end, operation.edit.text);
								}
								stage = "move"; adapter.move(operation.edit.cursor);
							}
							if (["d", "x", "c", "s", "y", "p"].includes(command)) this.vimOperator.visualRegister(range.linewise ? selected + "\n" : selected, range.linewise);
							this.vimVisual.cancel(); this.visualAnchor = undefined;
							this.vimOperator.cancel(); this.vimEngine.reset();
							if (operation.edit?.insert) this.enterVimInsert(true, true, false);
						} catch (error) {
							if (beganInsert) { try { adapter.endInsertSession(); } catch { /* Retain the original failure. */ } }
							this.notifyUnsafeVisual(stage, error);
						}
						this.deps.requestRender(); return;
					}
				}
				if (command === "." && !this.vimVisual.active && !this.vimOperator.isPending) {
					const count = this.vimOperator.takeRepeatCount();
					this.vimEngine.reset();
					for (let i = 0; i < count; i++) {
						const literal = this.vimOperator.repeatInsertCommand;
						const inserted = this.vimOperator.repeatInsertion;
						const destination = literal ? new VimNormalEngine().input(literal, this.getText(), this.getCursor(), adapter.motionBoundaries()) : undefined;
						const change = literal ? undefined : this.vimOperator.repeatAt(this.getText(), this.getCursor(), adapter.motionBoundaries());
						if (!change?.edit && !(destination?.handled && inserted)) break;
						try {
							if (inserted && /[\r\t]/.test(inserted)) break;
							if (change?.edit?.insert) {
								adapter.readRange(change.edit.start, change.edit.end);
								adapter.beginInsertSession();
							}
							if (change?.edit) {
							if (change.edit.text || change.edit.start.line !== change.edit.end.line || change.edit.start.col !== change.edit.end.col)
								adapter.replace(change.edit.start, change.edit.end, change.edit.text);
							adapter.move(change.edit.cursor);
							}
							if (inserted && (change?.edit?.insert || destination)) {
								const at = destination?.cursor ?? change!.edit!.cursor;
							adapter.replace(at, at, inserted);
							}
							if (change?.edit?.insert) adapter.endInsertSession();
							else if (change?.edit) adapter.move(change.edit.cursor);
						} catch { if (change?.edit?.insert) adapter.endInsertSession(); break; /* Unsafe paste marker: stop replay. */ }
					}
					this.deps.requestRender(); return;
				}
				const wasPending = this.vimOperator.isPending;
				const operator = this.vimVisual.active ? null : this.vimOperator.input(command, this.getText(), this.getCursor(), adapter.motionBoundaries());
				if (operator && (wasPending || !/^[0-9]$/.test(command))) {
					if (!wasPending) this.vimEngine.reset();
					if (operator.edit) {
						try {
							if (operator.edit.insert) adapter.beginInsertSession();
							if (operator.edit.text || operator.edit.start.line !== operator.edit.end.line ||
								operator.edit.start.col !== operator.edit.end.col) {
								adapter.replace(operator.edit.start, operator.edit.end, operator.edit.text);
							}
							adapter.move(operator.edit.cursor);
							if (operator.edit.insert) {
								adapter.markInsertAnchor();
								this.vimInsertIntent = { operator };
							} else this.vimOperator.remember(operator);
							if (operator.edit.insert) this.enterVimInsert(true, true, false);
						} catch { if (operator.edit.insert) adapter.endInsertSession(); this.vimOperator.cancel(); }
					}
					this.deps.requestRender();
					return;
				}
				if (command === "u" && !this.vimVisual.active) { adapter.undo(); this.vimEngine.reset(); this.deps.requestRender(); return; }
				const motion = this.vimEngine.input(command, this.getText(), this.getCursor(), adapter.motionBoundaries());
				if (motion.handled) {
					if (this.vimVisual.active && motion.insert !== undefined) return;
					try {
						adapter.move(motion.cursor);
						if (motion.insert !== undefined) {
							this.enterVimInsert();
							this.vimInsertIntent = { command };
						}
						if (motion.insert === "\n") {
							this.insertTextAtCursor("\n");
							if (command === "O") this.vimAdapter().move({ line: motion.cursor.line, col: 0 });
						}
						this.deps.requestRender();
					} catch { this.vimEngine.reset(); /* Unsupported private layout: no modal mutation. */ }
					return;
				}
			}
			// Encoded Return, Tab, IME and paste are editor input, not
			// app actions. Never forward an unowned NORMAL byte to insertion.
			if (this.vimNormal && !this.keybindingsManager.matches(data, "app.interrupt") && !matchesKey(data, "escape")) return;
		}
		if (
			this.promptState === PROMPT_STATE.WORKING &&
			!this.isShowingAutocomplete() &&
			this.keybindingsManager.matches(data, "app.interrupt")
		) {
			if (!this.deps.doubleEscCancelEnabled()) {
				this.abortAndDispatchQueued(data);
				return;
			}
			if (this.isPendingEscapeCancel()) {
				this.pendingEscapeCancelDeadline = undefined;
				this.abortAndDispatchQueued(data);
				return;
			}
			// Pi's own idle double-Esc (empty editor -> /tree or /fork) uses a
			// 500ms window; canceling a running turn is a heavier, harder-to-undo
			// action, so this confirmation deliberately gets double that time.
			this.pendingEscapeCancelDeadline = this.deps.now() + DOUBLE_ESC_CANCEL_WINDOW_MS;
			this.deps.requestRender();
			return;
		}
		// Idle with a non-empty draft: Pi's own idle double-Esc only acts on an
		// empty editor (tree/fork), so a draft's first Esc would otherwise do
		// nothing. Mirror the same swallow-then-confirm shape as the
		// working-cancel gate above, on the same 500ms window as Pi's own idle
		// double-Esc (issue #1218). Bash-mode drafts ("!...", the same rule
		// Pi's own interactive-mode uses to detect bash mode) are Pi's own
		// bash-mode Esc territory and must never reach this gate.
		if (
			this.promptState === PROMPT_STATE.IDLE &&
			!this.isShowingAutocomplete() &&
			this.keybindingsManager.matches(data, "app.interrupt")
		) {
			const text = this.getText();
			if (text.trim() !== "" && !text.trimStart().startsWith("!")) {
				// The second Esc only clears when the text is still exactly what
				// it was at the first Esc; an edit in between starts a fresh
				// first press on the new text instead of silently discarding it.
				if (this.isPendingIdleClear() && this.pendingIdleClearText === text) {
					this.pendingIdleClearDeadline = undefined;
					this.pendingIdleClearText = undefined;
					this.addToHistory(text);
					this.setText("");
					this.deps.requestRender();
					return;
				}
				this.pendingIdleClearDeadline = this.deps.now() + IDLE_ESC_CLEAR_WINDOW_MS;
				this.pendingIdleClearText = text;
				this.deps.requestRender();
				return;
			}
		}
		super.handleInput(data);
	}

	/** Buffer a whole paste before any bytes reach Vim's command router. Pi's
	 * editor receives the complete frame in INSERT so it retains native paste
	 * normalization, marker registration and undo behavior. In NORMAL, discard
	 * the entire frame rather than interpreting its contents as keystrokes.
	 */
	private handleVimPasteFrame(data: string): boolean {
		if (this.pasteFrame === undefined) {
			const start = data.indexOf(BRACKETED_PASTE_START);
			if (start < 0) return false;
			// A frame is an atomic event: bytes before its marker must not be
			// accidentally interpreted as a Vim command either.
			this.pasteFrame = "";
			this.pasteOverflow = false;
			data = data.slice(start + BRACKETED_PASTE_START.length);
		}
		// Retain only the terminator's possible prefix between events. This
		// avoids rescanning the entire paste for each single-character chunk.
		const chunk = this.pasteTail + data;
		const end = chunk.indexOf(BRACKETED_PASTE_END);
		const content = end < 0 ? chunk.slice(0, -(BRACKETED_PASTE_END.length - 1)) : chunk.slice(0, end);
		if (!this.pasteOverflow) {
			if (this.pasteFrame.length + content.length > MAX_BRACKETED_PASTE_CHARS) {
				this.pasteFrame = "";
				this.pasteOverflow = true;
			} else this.pasteFrame += content;
		}
		if (end < 0) {
			this.pasteTail = chunk.slice(-(BRACKETED_PASTE_END.length - 1));
			return true;
		}
		const paste = this.pasteFrame;
		const overflow = this.pasteOverflow;
		this.pasteFrame = undefined;
		this.pasteOverflow = false;
		this.pasteTail = "";
		if (!overflow && !this.vimNormal) super.handleInput(BRACKETED_PASTE_START + paste + BRACKETED_PASTE_END);
		const remaining = chunk.slice(end + BRACKETED_PASTE_END.length);
		if (remaining) this.handleInput(remaining);
		return true;
	}

	/**
	 * Runs the Esc that actually aborts the turn. Pi's own onEscape (invoked
	 * synchronously by `super.handleInput`) restores `queuedText + draft`
	 * into the editor and aborts; snapshot the draft first, reconstruct the
	 * queued text from what comes back, restore the draft alone, and hand
	 * the queued text to the dispatcher so it is sent once the aborted run
	 * settles (see the `agent_settled` handler in `gentleShell`). Images
	 * inside queued messages are already dropped by Pi's own restore, before
	 * this code ever sees the text.
	 *
	 * `extractQueuedText` returning `undefined` means the restored text does
	 * not match Pi's own join shape; Pi's own text wins and is left exactly
	 * as it is, nothing is dispatched. An empty string means a genuine empty
	 * queue: there is nothing to restore, so `setText` is not called at all
	 * on the common no-queue path. Only a recognized, non-empty queue
	 * restores the draft and dispatches.
	 */
	private abortAndDispatchQueued(data: string): void {
		const draft = this.getText();
		super.handleInput(data);
		const queued = extractQueuedText(this.getText(), draft);
		// undefined: unrecognized shape, Pi's own text stays untouched.
		if (queued === undefined) return;
		// "": nothing was queued, and the editor already holds the draft, so no
		// redundant write. Anything else was recognized: the draft comes back
		// alone, and only real text (not whitespace) is worth a turn.
		if (queued !== "") this.setText(draft);
		if (queued.trim() === "") return;
		this.deps.dispatchQueuedText(queued);
	}

	private clearPanelHover(): void {
		if (!this.hoveredPanel) return;
		this.hoveredPanel = false;
		this.deps.requestRender();
	}

	private clearEditorHover(): void {
		this.clearPanelHover();
		if (this.hoveredTopRow !== undefined) {
			this.hoveredTopRow = undefined;
			this.deps.requestRender();
		}
		releaseSidebarHover(this.pointerTui, this);
	}

	handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]): ReturnType<CustomEditor["handleMouse"]> {
		const onPanel = (this.deps.panelButton?.() ?? true) && this.panelStart !== undefined && this.floatMouseLayout?.panel && event.width === this.floatMouseLayout.width && event.y === this.topRowCount &&
			event.x >= this.panelStart && event.x < this.panelStart + visibleWidth(PANEL_BUTTON);
		if (event.type === "move" && event.button === "none") {
			if (onPanel || (event.y >= 0 && event.y < this.topRowCount)) setSidebarHover(this.pointerTui, this, () => this.clearEditorHover());
			else setSidebarHover(this.pointerTui);
			if (onPanel) {
				const changed = this.hoveredTopRow !== undefined || !this.hoveredPanel;
				if (this.hoveredTopRow !== undefined) { this.hoveredTopRow = undefined; this.deps.requestRender(); }
				if (!this.hoveredPanel) { this.hoveredPanel = true; this.deps.requestRender(); }
				return changed ? { handled: true, render: true } : { handled: true };
			}
			this.clearPanelHover();
		}
		if (onPanel && (event.type === "press" || event.type === "click")) {
			if (event.type === "click" && event.button === "left") {
				this.clearEditorHover();
				this.deps.onPanelClick?.();
			}
			return { handled: true, render: event.type === "click" };
		}
		// Rows drawn above the panel rule belong to the shell, not to Pi's editor.
		if (this.topRowCount > 0) {
			if (event.y < this.topRowCount) {
				// Hovering a top row paints it as clickable, like every other control.
				if (event.type === "move" && event.button === "none") {
					if (this.hoveredTopRow !== event.y) {
						this.hoveredTopRow = event.y;
						this.deps.requestRender();
						return { handled: true, render: true };
					}
					return { handled: true };
				}
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.deps.onTopRowClick?.(event.y);
				return { handled: true, render: true };
			}
			if (this.hoveredTopRow !== undefined) {
				this.hoveredTopRow = undefined;
				this.deps.requestRender();
			}
			event = { ...event, y: event.y - this.topRowCount, height: event.height - this.topRowCount };
		}
		const layout = this.floatMouseLayout;
		if (!layout) return super.handleMouse(event);
		// Row coordinates stay native: padding=0, content=1…N, hint=N+1.
		// Float and panel translate x; the existing neon/fallback path is unchanged.
		if (event.x < layout.prefixWidth || event.x >= (layout.panel ? layout.prefixWidth + layout.nativeWidth : layout.width - 1)) return undefined;
		return super.handleMouse({ ...event, x: event.x - layout.prefixWidth, width: layout.nativeWidth });
	}

	render(width: number): string[] {
		// Time-based animation: the phase is read from the clock per frame, so a
		// streaming render burst cannot strobe the wave and silent tool runs
		// advance it via the working pulse timer.
		const layout = resolvePromptLayout(width, cardStyle(), this.deps.bg, this.deps.panelChrome?.() ?? false);
		this.floatMouseLayout = layout.background || layout.panel ? layout : undefined;
		const inner = layout.nativeWidth;
		const lines = super.render(inner);
		if (this.getText() === "" && lines.length === 3) lines[1] = withPromptHint(lines[1], PROMPT_HINT, this.deps.fg);
		const state = this.promptState === PROMPT_STATE.WORKING && this.deps.pending() ? PROMPT_STATE.QUEUED : this.promptState;
		// Neon keeps the shell's border role; float follows Pi's live public
		// borderColor callback so thinking/bash mode accents survive.
		// Selection is applied only to the owned Pi editor rows, before Gentle
		// frames them. No second editor factory or private layout mutation.
		let editorLines = lines;
		if (this.vimPolicy === "on" && this.vimVisual.active) {
			try {
				const adapter = this.vimAdapter();
				const range = this.vimVisual.range(this.getText(), this.getCursor(), adapter.motionBoundaries());
				if (range) editorLines = adapter.renderSelection(inner, range.start, range.end, lines);
			} catch { /* Unknown layout: keep the original rendered prompt. */ }
		}
		if (this.vimPolicy !== "on") editorLines = this.selectionEngine.decorateRows(editorLines, inner, 0);
		// SAFETY: this optional host hint is accepted only as an integer within the
		// rendered row bounds below; absent/invalid hints fall back to all rows.
		const visibleCount = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
		const borderEnd = Number.isInteger(visibleCount) && visibleCount! >= 1 && visibleCount! + 2 <= editorLines.length
			? visibleCount! + 2 : editorLines.length;
		const framed = framePromptLines(editorLines.slice(0, borderEnd), width, {
			state,
			tick: this.workingPhase(),
			borderColor: (text) => layout.background || layout.panel ? this.borderColor(text) : this.deps.fg(PROMPT_FRAME_ROLE, text),
			fg: this.deps.fg,
			bold: this.deps.bold,
			workingLabel: this.promptState === PROMPT_STATE.WORKING ? this.deps.workingLabel?.() : undefined,
			panelButton: Boolean(layout.panel && this.deps.onPanelClick && (this.deps.panelButton?.() ?? true)),
			panelHovered: this.hoveredPanel,
			escHint: [
				this.vimPolicy === "on" ? (this.vimVisual.active ? (this.vimVisual.kind === "line" ? "VISUAL LINE" : "VISUAL") : this.vimNormal ? "NORMAL" : "INSERT") : undefined,
				this.promptState === PROMPT_STATE.WORKING && this.isPendingEscapeCancel()
					? DOUBLE_ESC_CANCEL_HINT
					: this.promptState === PROMPT_STATE.IDLE && this.isPendingIdleClear()
						? IDLE_ESC_CLEAR_HINT
						: undefined,
			].filter(Boolean).join(" · ") || undefined,
		}, layout);
		if (this.vimPolicy !== "on") {
			framed[framed.length - 1] = layout.panel
				? panelPromptRow(this.selectionEngine.decorateBottomRule("", layout.nativeWidth, ""), layout, " ".repeat(layout.prefixWidth))
				: layout.background
					? floatPromptRow(this.selectionEngine.decorateBottomRule("", layout.nativeWidth, ""), layout, (text) => this.borderColor(text))
					: this.selectionEngine.decorateBottomRule(framed[framed.length - 1] ?? "", width, "╯");
		}
		// The shell decides what goes above the editor (work row, agent questions) for every frame style.
		const topRows = this.deps.topRows?.(width, this.hoveredTopRow) ?? [];
		if (this.hoveredTopRow !== undefined && this.hoveredTopRow >= topRows.length) this.hoveredTopRow = undefined;
		this.topRowCount = topRows.length;
		const plainRule = stripAnsi(framed[0] ?? "");
		const panelAt = layout.panel && this.deps.onPanelClick && (this.deps.panelButton?.() ?? true) ? plainRule.lastIndexOf(PANEL_BUTTON) : -1;
		this.panelStart = panelAt < 0 ? undefined : visibleWidth(plainRule.slice(0, panelAt));
		if (this.panelStart === undefined && this.hoveredPanel) this.clearEditorHover();
		framed.unshift(...topRows);
		// Pi places autocomplete after its bottom border. Keep those rows below
		// Gentle's frame and preserve their terminal width and row coordinates.
		for (const line of editorLines.slice(borderEnd)) {
			if (layout.panel) {
				framed.push(panelPromptRow(line, layout, " ".repeat(layout.prefixWidth)));
				continue;
			}
			if (layout.background) {
				framed.push(floatPromptRow(line, layout, (text) => this.borderColor(text)));
				continue;
			}
			const available = Math.max(0, width);
			const border = available >= 2 ? "│" : "";
			const inner = available - border.length * 2;
			const clipped = truncateToWidth(line, inner, "");
			framed.push(this.deps.fg(PROMPT_FRAME_ROLE, border) + clipped +
				" ".repeat(Math.max(0, inner - visibleWidth(clipped))) + this.deps.fg(PROMPT_FRAME_ROLE, border));
		}
		return framed;
	}

	invalidate(): void {
		super.invalidate();
		this.panelStart = undefined;
		this.clearEditorHover();
	}

	dispose(): void {
		this.disposed = true;
		this.clearEditorHover();
		this.stopWatchdog();
	}

	private isPendingEscapeCancel(): boolean {
		return this.pendingEscapeCancelDeadline !== undefined && this.deps.now() < this.pendingEscapeCancelDeadline;
	}

	private isPendingIdleClear(): boolean {
		return (
			this.pendingIdleClearDeadline !== undefined &&
			this.deps.now() < this.pendingIdleClearDeadline &&
			this.pendingIdleClearText === this.getText()
		);
	}

	private stopWatchdog(): void {
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = undefined;
	}
}

const IMAGE_ATTACHMENTS_WIDGET_KEY = "gentle-shell-image-attachments";
const IMAGE_PREVIEW_MAX_ROWS = 6;
const IMAGE_PREVIEW_MAX_COLUMNS = 40;

/** Unknown capabilities count as image-capable; Pi decides for its own models. */
export function modelAcceptsImages(model: { input?: readonly string[] } | undefined): boolean {
	return !model?.input || model.input.includes("image");
}

/**
 * Lists the chips still in the draft above the prompt. Terminals with an image
 * protocol (Kitty, iTerm2) get a thumbnail under each label; every other
 * terminal, or a multiplexer that hides the protocol, gets the label alone.
 */
export function imageAttachmentsWidget(
	attachments: ImageAttachments,
	draft: () => string,
	theme: { fg(color: string, text: string): string },
	acceptsImages: () => boolean,
	canDrawImages: () => boolean = () => getCapabilities().images !== null,
) {
	const previews = new Map<number, Image>();
	return {
		render(width: number): string[] {
			const shown = attachments.referenced(draft());
			for (const id of previews.keys()) if (!shown.some((attachment) => attachment.id === id)) previews.delete(id);
			if (shown.length === 0) return [];
			const draw = canDrawImages();
			const warning = acceptsImages() ? "" : theme.fg("warning", " · not sent: the current model does not accept images");
			const lines: string[] = [];
			for (const attachment of shown) {
				lines.push(truncateToWidth(`${theme.fg("accent", attachment.token)} ${theme.fg("dim", describeAttachment(attachment))}${warning}`, width));
				if (!draw) continue;
				let preview = previews.get(attachment.id);
				if (!preview) {
					preview = new Image(attachment.base64, attachment.mimeType, { fallbackColor: (text) => theme.fg("dim", text) },
						{ maxWidthCells: IMAGE_PREVIEW_MAX_COLUMNS, maxHeightCells: IMAGE_PREVIEW_MAX_ROWS }, attachment.dimensions);
					previews.set(attachment.id, preview);
				}
				lines.push(...preview.render(width));
			}
			return lines;
		},
		invalidate(): void {
			for (const preview of previews.values()) preview.invalidate();
		},
	};
}

// Stable across extension module reloads; never infer ownership from a name.
const PROMPT_OWNER = Symbol.for("gentle-pi.prompt-owner");
type PromptFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>> & { [PROMPT_OWNER]?: boolean };

function installPrompt(
	ctx: ExtensionContext,
	onCreated: (prompt: GentlePromptEditor) => void,
	promptDeps: { now: () => number; doubleEscCancelEnabled: () => boolean; dispatchQueuedText: (text: string) => void; vimRuntimeVersion?: () => string | undefined; attachments?: ImageAttachments; readClipboardImage?: () => Promise<ClipboardImage | null>; panelChrome?: (tui: TUI) => boolean; panelButton?: (tui: TUI) => boolean; topRows?: (tui: TUI, width: number, hovered?: number) => string[]; onTopRowClick?: (tui: TUI, index: number) => void; onPanelClick?: () => void },
): boolean {
	const previous = ctx.ui.getEditorComponent() as PromptFactory | undefined;
	if (previous && !previous[PROMPT_OWNER]) return false;
	const factory: PromptFactory = (tui, theme, keybindings) => {
		const prompt = new GentlePromptEditor(tui, theme, keybindings, {
			fg: (color, text) => ctx.ui.theme.fg(color as Parameters<typeof ctx.ui.theme.fg>[0], text),
			bg: (color, text) => ctx.ui.theme.bg(color as Parameters<typeof ctx.ui.theme.bg>[0], text),
			bold: (text) => ctx.ui.theme.bold(text),
			requestRender: () => tui.requestRender(),
			pending: () => ctx.hasPendingMessages(),
			now: promptDeps.now,
			doubleEscCancelEnabled: promptDeps.doubleEscCancelEnabled,
			dispatchQueuedText: promptDeps.dispatchQueuedText,
			notifyCompatibility: (message) => ctx.ui.notify(message, "warning"),
			tuiVersion: promptDeps.vimRuntimeVersion,
			workingLabel: () => oddPhaseRegistry.label(ctx.sessionManager.getSessionId()),
			attachments: promptDeps.attachments,
			readClipboardImage: promptDeps.readClipboardImage,
			panelChrome: promptDeps.panelChrome ? () => promptDeps.panelChrome!(tui) : undefined,
			panelButton: promptDeps.panelButton ? () => promptDeps.panelButton!(tui) : undefined,
			topRows: promptDeps.topRows ? (width, hovered) => promptDeps.topRows!(tui, width, hovered) : undefined,
			onTopRowClick: promptDeps.onTopRowClick ? (index) => promptDeps.onTopRowClick!(tui, index) : undefined,
			onPanelClick: promptDeps.onPanelClick,
		});
		// Pi's own docs require an explicit requestRender() after a state change
		// (docs/tui.md: "Call tui.requestRender() after state changes"); no host
		// re-render is implicitly guaranteed, and the WORKING watchdog does not
		// run at all under the "potato" animation policy. Register this session's
		// redraw so a phase reported by the tool is visible immediately.
		oddPhaseRegistry.setRenderRequest(ctx.sessionManager.getSessionId(), () => tui.requestRender());
		onCreated(prompt);
		return prompt;
	};
	factory[PROMPT_OWNER] = true;
	ctx.ui.setEditorComponent(factory);
	return true;
}

const DOUBLE_ESC_CANCEL_COMMAND_NAME = "gentle:double-esc-cancel";

function describeDoubleEscCancelSource(resolution: DoubleEscCancelResolution): string {
	switch (resolution.source) {
		case "global_file":
			return `global file ${resolution.globalFile}`;
		case "environment":
			return "GENTLE_PI_DOUBLE_ESC_CANCEL";
		default:
			return "built-in default";
	}
}

/**
 * Report the effective policy, the source that decided it, and (when this
 * invocation just wrote one) the policy it wrote. Unlike background-subagents
 * there is no project-file layer to outrank the write, so a write always
 * takes effect immediately.
 */
function renderDoubleEscCancelReport(
	resolution: DoubleEscCancelResolution,
	wrote?: DoubleEscCancelPolicy,
): { message: string; type: "info" | "warning" } {
	const lines = [`double-esc-cancel: ${resolution.policy} (decided by ${describeDoubleEscCancelSource(resolution)})`];
	if (wrote !== undefined) lines.push(`Wrote ${wrote} to the global file ${resolution.globalFile}.`);
	if (resolution.malformed) {
		lines.push(`${resolution.globalFile} is present but malformed, so the policy fails closed to off and the environment variable is not consulted.`);
	}
	if (resolution.envValue !== undefined && resolution.source !== "environment") {
		lines.push(
			resolution.envValue === "on" || resolution.envValue === "off"
				? `GENTLE_PI_DOUBLE_ESC_CANCEL=${resolution.envValue} is set, but the global file exists and decides; the env var applies only when no file exists.`
				: `GENTLE_PI_DOUBLE_ESC_CANCEL="${resolution.envValue}" is not a recognized value ("on" or "off"), so it is ignored.`,
		);
	}
	lines.push("Resolution order (first hit wins): global file, GENTLE_PI_DOUBLE_ESC_CANCEL, built-in default off.");
	return { message: lines.join("\n"), type: resolution.malformed ? "warning" : "info" };
}

const CHANGES_WIDGET_KEY = "gentle-shell-changes";
const HEADER_WIDGET_KEY = "gentle-shell-below-input-header";
const CHANGES_COMMAND_NAME = "gentle:changes";
const IMAGES_COMMAND_NAME = "gentle:images";
const CHANGES_POLL_DEFAULT_MS = 2000;
const GIT_TIMEOUT_MS = 5000;
const COMMANDS_COMMAND_NAME = "gentle:commands";

// If taskkill cannot run (AppLocker, a broken PATH) the direct child can exit
// while a descendant still holds the inherited pipes, which keeps execFile from
// calling back; cut them after this grace so the scan still settles.
const GIT_TREE_KILL_GRACE_MS = 1_000;

export function shellGitRunner(cwd: string, env: NodeJS.ProcessEnv = process.env, run: typeof execFile = execFile, maxBuffer = Infinity, killProcessTree: ProcessTreeKiller | undefined = process.platform === "win32" ? windowsProcessTreeKiller : undefined): GitRunner {
	// Pi exec cannot replace the inherited environment. Use argv directly and
	// a complete sanitized environment for discovery, status, and lazy diffs.
	const childEnv = worktreeGitEnvironment(env);
	// A timed-out Git scan on Windows is more than one process: `git` hands the
	// status work to a descendant, and that descendant survives the direct child
	// Node itself kills, so a large repository whose scan passes the timeout
	// leaks another orphaned git.exe on every poll until physical memory is
	// exhausted (#927). Windows therefore owns the deadline below, so the tree
	// kill lands while the parent is still alive for taskkill to walk; everywhere
	// else execFile's own timeout stays exactly as it was.
	const treeKiller = killProcessTree;
	return (args) => new Promise((resolve) => {
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let grace: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		// A scan that passed its deadline is a failed scan, never a partial
		// success, even if the direct child exited 0 before its pipes closed.
		let timedOut = false;
		const settle = (error: { code?: unknown; killed?: boolean } | null, stdout: string): void => {
			settled = true;
			if (deadline !== undefined) clearTimeout(deadline);
			if (grace !== undefined) clearTimeout(grace);
			if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") { resolve({ stdout, code: 1, truncated: true }); return; }
			const code = timedOut ? 1 : error ? typeof error.code === "number" ? error.code : 1 : 0;
			// Without a tree killer execFile owns the timeout and reports its kill on the error.
			resolve({ stdout, code, ...(timedOut || (treeKiller === undefined && error?.killed) ? { timedOut: true } : {}) });
		};
		let child: ReturnType<typeof execFile>;
		try {
			child = run("git", ["-C", cwd, ...args], {
				env: childEnv,
				encoding: "utf8",
				shell: false,
				windowsHide: true,
				...(treeKiller === undefined ? { timeout: GIT_TIMEOUT_MS } : {}),
				// Pi exec accumulates output without a maxBuffer cap. In particular,
				// large porcelain inventories must not become partial successful scans.
				// Only a single diff passes a bound, and is told when it hit it.
				maxBuffer,
			}, (error, stdout) => settle(error, stdout));
		} catch (error) {
			// A spawn that throws (invalid options, an injected runner) is a failed scan.
			settle(error as { code?: unknown }, "");
			return;
		}
		// The callback may already have settled a synchronous run (a fake in
		// tests, a spawn error), so only arm the deadline while it is pending.
		if (settled || treeKiller === undefined || child?.pid === undefined) return;
		const pid = child.pid;
		deadline = setTimeout(() => {
			timedOut = true;
			// taskkill walks the tree from a live parent. If the direct child
			// already exited, only a descendant can be holding the inherited
			// pipes, and a PID-based kill would just report "process not found";
			// the grace below still cuts those pipes so the scan can settle.
			if (child.exitCode === null && child.signalCode === null) treeKiller(pid);
			grace = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill();
				child.stdout?.destroy();
				child.stderr?.destroy();
			}, GIT_TREE_KILL_GRACE_MS);
			grace.unref?.();
		}, GIT_TIMEOUT_MS);
		deadline.unref?.();
	});
}

export async function loadFileDiff(git: GitRunner, file: ChangedFile): Promise<string> {
	const args = file.status === CHANGE_STATUS.UNTRACKED ? ["diff", "--no-index", "--", "/dev/null", file.path] : ["diff", "HEAD", "--", file.path];
	const result = await git(args);
	if (result.truncated || result.stdout.length > DIFF_MAX_BYTES || result.stdout.split("\n", DIFF_MAX_LINES + 2).length > DIFF_MAX_LINES + 1) return DIFF_TOO_LARGE;
	return !result.timedOut && (result.code === 0 || result.code === 1) ? result.stdout : "";
}

// Untracked files have no numstat; count their lines without reading past the diff bound.
const untrackedLines = (root: string): LineCounter => async (path) => {
	const target = join(root, path);
	const info = await lstat(target);
	if (!info.isFile() || info.size > DIFF_MAX_BYTES) return 0;
	const text = await readFile(target, "utf8");
	return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};
// Same-count edits still change size or mtime, so an open diff reloads.
const fileRevision = (root: string): FileRevision => async (path) => {
	const info = await lstat(join(root, path));
	return `${info.size}:${info.mtimeMs}`;
};

export { openInExternalEditor, type ExternalEditorHost } from "../lib/external-editor.ts";
// Each key reads its environment variable, then keymaps.json, then its default (lib/keymaps.ts).
export function changesShortcut(env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): string | undefined {
	return effectiveKey("changes", env, bindings);
}

export function presetShortcut(env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): string | undefined {
	return effectiveKey("preset", env, bindings);
}

export function usageShortcut(env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): string | undefined {
	return effectiveKey("usage", env, bindings);
}

function positiveMs(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function changesPollMs(env: NodeJS.ProcessEnv): number {
	return positiveMs(env.GENTLE_PI_SHELL_CHANGES_POLL_MS, CHANGES_POLL_DEFAULT_MS);
}

// One bounded window per provider refresh: a credential lookup or fetch that
// never answers must not hold the other providers — or the panel opening on
// them — past it. Tunable (tests, slow networks); invalid values fall back.
const USAGE_FETCH_TIMEOUT_DEFAULT_MS = 10_000;
const usageFetchTimeoutMs = (env: NodeJS.ProcessEnv): number => positiveMs(env.GENTLE_PI_SHELL_USAGE_TIMEOUT_MS, USAGE_FETCH_TIMEOUT_DEFAULT_MS);

// The footer memo reads this every keystroke: tracker models store the
// digest once per scan (lib/shell-changes.ts), so this is O(1); hand-built
// models without a stored digest fall back to computing it here.
function changesFingerprint(model: ChangesModel): string {
	return model.digest ?? changesDigest(model);
}

interface OverlayDeps {
	available?(): boolean;
	initial?: { root: string; path: string };
	loadDiff(root: string, file: ChangedFile): Promise<string>;
	worktrees(): WorktreeChanges[];
	refresh(): Promise<ChangesModel>;
	apply(ctx: ExtensionContext, model: ChangesModel): void;
	pollMs?: number;
}


// The overlay polls each root's Git state while it is open; diffs load lazily.
// Like Gentle Agents it takes the whole terminal, and the native fullscreen
// wrapper keeps mouse dispatch on the view while it owns the keyboard.
async function showChangesOverlay(ctx: ExtensionContext, deps: OverlayDeps): Promise<void> {
	let host: ExternalEditorHost | undefined;
	let view: WorktreeChangesView | undefined;
	let open = true;
	const available = () => open && (deps.available?.() ?? true);
	let refreshing = false;
	let refreshQueued = false;
	const refresh = async () => {
		if (!available()) return;
		if (!deps.available) {
			const latest = await deps.refresh();
			view?.update(deps.worktrees());
			deps.apply(ctx, latest);
			return;
		}
		if (refreshing) { refreshQueued = true; return; }
		refreshing = true;
		try {
			do {
				refreshQueued = false;
				const latest = await deps.refresh();
				if (!available()) return;
				view?.update(deps.worktrees());
				deps.apply(ctx, latest);
			} while (refreshQueued && available());
		} finally {
			refreshing = false;
		}
	};
	const poll = deps.pollMs === undefined ? undefined : setInterval(() => void refresh().catch(() => {}), deps.pollMs);
	poll?.unref();
	try {
		const chosen = await ctx.ui.custom<{ root: string; file: ChangedFile } | null>(
			(tui, theme, _keybindings, done) => {
				const finish = withOverlayRepaint(tui, done);
				const close = (value: { root: string; file: ChangedFile } | null) => { open = false; finish(value); };
				host = tui;
				view = new WorktreeChangesView(deps.worktrees(), {
					initial: deps.initial,
					theme,
					rows: () => Math.max(0, tui.terminal.rows),
					loadDiff: deps.loadDiff,
					onOpen: (root, file) => close({ root, file }),
					onRefresh: () => void refresh().catch(() => {}),
					onClose: () => close(null),
					requestRender: () => tui.requestRender(),
				});
				const interaction = createNativeFullscreenInteraction({ keyboardTarget: view, requestRender: () => tui.requestRender() });
				interaction.addChild(view);
				return interaction;
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } },
		);
		if (!chosen || !host || !(deps.available?.() ?? true)) return;
		try {
			if (!openInExternalEditor(host, chosen.file.path, process.env, spawnSync, chosen.root)) ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	} finally {
		open = false;
		if (poll) clearInterval(poll);
		view?.dispose();
		view = undefined;
	}
}

// The command palette is a curated, grouped menu (Configuration, Session,
// Diagnostics, SDD, Skills), not a raw listing of every registered
// extension command: buildCommandPaletteGroups keeps only the catalog
// entries that are actually registered, so a missing extension never shows
// a dead row. Selecting an entry runs it exactly as if the user had typed
// the underlying slash command.
// Each row shows the key saved now; one that differs from the key Pi loaded at
// startup is marked "(reload)", since Pi only applies it after /reload.
function paletteShortcuts(pi: ExtensionAPI, env: NodeJS.ProcessEnv, loaded: KeymapBindings): Record<string, string | undefined> {
	const saved = loadKeymaps(env).bindings;
	const shortcuts: Record<string, string | undefined> = {};
	for (const { name } of pi.getCommands()) {
		const id = commandKeymapId(name);
		const now = effectiveKey(id, env, saved);
		const active = effectiveKey(id, env, loaded);
		shortcuts[name] = now === active ? now : `${now ?? "none"} (reload)`;
	}
	return shortcuts;
}

/**
 * The palette commands Customize lists under Keymaps. The command list is an
 * extra there: when Pi cannot report it yet (before its runtime is
 * initialized), Customize still opens with the built-in actions only.
 */
function paletteCommandsForKeymaps(pi: ExtensionAPI): { command: string; label: string }[] {
	try {
		return buildCommandPaletteGroups(pi.getCommands(), {}).flatMap((group) => group.items);
	} catch {
		return [];
	}
}

/** Tab in the palette: assign the captured key to the command, through the same checks as /gentle:customize. */
async function bindFromPalette(ctx: ExtensionContext, env: NodeJS.ProcessEnv, command: string, data: string, keybindings: PiKeybindings | undefined): Promise<void> {
	const id = commandKeymapId(command);
	const file = loadKeymaps(env);
	const change = prepareKeymapChange(id, data, env, file, keybindings);
	if (change.kind === "refused") return ctx.ui.notify(change.message, change.type);
	if (change.confirm && !(await ctx.ui.confirm("Keymaps", change.confirm))) return;
	writeKeymaps(gentlePiConfigHome(env), change.bindings);
	ctx.ui.notify(keymapSavedNotice(id, keymapLabel(id), env, change.bindings), "info");
}

async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext, env: NodeJS.ProcessEnv, loaded: KeymapBindings = {}): Promise<void> {
	if (!ctx.hasUI) return;
	const groups = buildCommandPaletteGroups(pi.getCommands(), paletteShortcuts(pi, env, loaded));
	if (groups.length === 0) {
		ctx.ui.notify("No Gentle commands are registered.", "info");
		return;
	}
	let piKeybindings: PiKeybindings | undefined;
	const result = await ctx.ui.custom<CommandPaletteResult>(
		(tui, theme, keybindings, done) => {
			if (typeof (keybindings as Partial<PiKeybindings> | undefined)?.getKeys === "function") piKeybindings = keybindings as PiKeybindings;
			return new CommandPalette(groups, withOverlayRepaint(tui, done), theme, () => Math.max(0, tui.terminal.rows));
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } },
	);
	if (result?.type === "run") pi.sendUserMessage(`/${result.name}`, { expandPromptTemplates: true });
	if (result?.type === "bind") await bindFromPalette(ctx, env, result.name, result.data, piKeybindings);
}

function showChanges(ctx: ExtensionContext, model: ChangesModel, visible = true, grouped: (width: number) => boolean = () => false): void {
	if (!visible || model.files.length === 0) {
		ctx.ui.setWidget(CHANGES_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(
		CHANGES_WIDGET_KEY,
		(tui, theme) => sidebarPart(tui, "changes", {
			render(width: number) {
				return grouped(width) ? [] : renderChangesWidget(model, theme, width);
			},
			invalidate() {},
		}),
		{ placement: "belowEditor" },
	);
}

const USAGE_COMMAND_NAME = "gentle:usage";
const PANEL_COMMAND_NAME = "gentle:panel";
/** Rows the panel sheet leaves free at the bottom: work row, editor rule, input, closing row, status bar and a spare. */
const SHEET_RESERVED_ROWS = 6;
const PRESET_LABEL: Record<VisualPreset, string> = { [VISUAL_PRESET.LIGHT]: "Light", [VISUAL_PRESET.NEUTRAL]: "Neutral", [VISUAL_PRESET.POWER_USER]: "Power user" };
/** The order the preset shortcut walks; a hand-tuned mix starts it on Neutral. */
const PRESET_CYCLE: readonly VisualPreset[] = [VISUAL_PRESET.LIGHT, VISUAL_PRESET.NEUTRAL, VISUAL_PRESET.POWER_USER];
export function nextVisualPreset(current: VisualPreset | undefined): VisualPreset {
	return current === undefined ? VISUAL_PRESET.NEUTRAL : PRESET_CYCLE[(PRESET_CYCLE.indexOf(current) + 1) % PRESET_CYCLE.length]!;
}
const REVIEW_PREFLIGHT_TYPE = "gentle-pi.review-preflight";
const DEV_BINARY_WIDGET_KEY = "gentle-shell-dev-binary";
const SHA_PREFIX_LENGTH = 16;

function messageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

interface CardComponentOptions {
	expanded: boolean;
	previewRows?: number;
	hint?: string;
}

function cardComponent(card: Card, theme: CardTheme, options: CardComponentOptions) {
	return {
		render(width: number) {
			return renderCard(card, theme, width, options);
		},
		invalidate() {},
	};
}

// Widgets above the editor sit flush against the prompt frame; a blank line
// after the card keeps the two frames apart.
function spaced(component: { render(width: number): string[]; invalidate(): void }) {
	return {
		render(width: number) {
			return [...component.render(width), ""];
		},
		invalidate() {},
	};
}

// Same rose identity as the Gentle AI tool cards (lib/gentle-ai-renderer.ts).
const GENTLE_AI_GLYPH = "\u{1F339}";

export function devBinaryCard(notice: DevBinaryNotice): Card {
	if (notice.state === "invalid") {
		return { title: "gentle-ai", subtitle: "dev binary override invalid", body: [notice.reason], tone: CARD_TONE.ERROR, glyph: GENTLE_AI_GLYPH };
	}
	return {
		title: "gentle-ai",
		subtitle: "dev binary override · field-test only",
		body: [`${notice.path} · sha256:${notice.sha256.slice(0, SHA_PREFIX_LENGTH)}`],
		tone: CARD_TONE.WARNING,
		glyph: GENTLE_AI_GLYPH,
	};
}

const USAGE_REFRESH_MS = 5 * 60_000;

// The Codex usage endpoint is what the Codex CLI itself reads. The OAuth
// token pi already holds carries the account id; nothing else is sent.
export async function fetchCodexUsage(token: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	if (!token) return undefined;
	const accountId = accountIdFromToken(token);
	if (!accountId) return undefined;
	try {
		const response = await fetchFn(CODEX_USAGE_URL, {
			headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId, originator: "pi", "User-Agent": "gentle-pi" },
		});
		if (!response.ok) return undefined;
		return parseCodexUsage(await response.json(), now);
	} catch {
		return undefined;
	}
}

// The NaN Cloud quota endpoint is the one the official dashboard reads with the
// same API key pi already holds. The key travels in the header only: the request
// refuses redirects so it cannot be replayed to another origin, asks for no
// stored copy, and nothing here logs, renders, or persists it.
export async function fetchNanUsage(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	if (!apiKey) return undefined;
	try {
		const response = await fetchFn(NAN_QUOTA_URL, {
			redirect: "error",
			cache: "no-store",
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "gentle-pi" },
		});
		if (!response.ok) return undefined;
		const parsed = parseNanQuota(await response.json(), now);
		return parsed.limits.length > 0 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// A registered source is foreign code running inside a fire-and-forget
// refresh: it must degrade exactly like the built-in fetchers above, never
// throw past this call, and never leave an unhandled rejection behind.
async function fetchFromSource(source: UsageSource, apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	try {
		const result = await source.fetch(apiKey, fetchFn, now);
		return result === undefined ? undefined : parseProviderUsage(result, source.provider);
	} catch {
		return undefined;
	}
}

// Changes refreshes started without awaiting (turn end, worktree registration)
// are tracked so tests can wait for them instead of guessing a delay.
const backgroundChangeRefreshes = new Set<Promise<void>>();
function trackChangeRefresh(refresh: Promise<void>): void {
	const tracked = refresh.catch(() => {}).finally(() => { backgroundChangeRefreshes.delete(tracked); });
	backgroundChangeRefreshes.add(tracked);
}

/** Resolves once every background Changes refresh has finished, or after `timeoutMs` for one that never settles. */
export async function backgroundChangeRefreshesSettled(timeoutMs = 2000): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
	const settled = (async () => { while (backgroundChangeRefreshes.size > 0) await Promise.all([...backgroundChangeRefreshes]); })();
	await Promise.race([settled, deadline]);
	clearTimeout(timer);
}

export default function gentleShell(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, overrides: Partial<ShellDeps> = {}): void {
	installSessionChangeCapture(pi, env, overrides.resolveWorktree ?? resolveSessionWorktree);
	// Replaced before persistence, so the footer, /gentle:stats and the session file
	// all carry the API-equivalent cost of claude-bridge turns instead of $0. It runs
	// in subagent children too: the parent sums their message_end cost over RPC.
	pi.on("message_end", (event, ctx) => {
		const priced = priceBridgeMessage(event.message, (provider, id) => ctx.modelRegistry.find(provider, id)?.cost);
		return priced ? { message: priced } : undefined;
	});
	if (!shellEnabled(env)) return;
	// Pi reads shortcuts once (startup and /reload), so the saved keymaps are read once too.
	const keymaps = loadKeymaps(env);
	let keymapsReported = false;
	pi.on("session_start", (_event, ctx) => {
		if (!keymaps.malformed || keymapsReported || !ctx.hasUI) return;
		keymapsReported = true;
		ctx.ui.notify(`Keymaps: ${keymaps.path} is unreadable or malformed; using the default keys.`, "warning");
	});
	const profileReader = createActiveProfileReader(env);
	const deps: ShellDeps = { ...defaultShellDeps, activeProfile: profileReader, ...overrides };
	let closeCustomize: (() => void) | undefined;
	let customizeGeneration = 0;
	const stopProfilePoll = () => {
		profileReader.reset();
	};
	// A full subscription window makes model fallbacks skip that provider until it resets.
	const usage = new UsageStore((reading) => syncUsageCooldown(reading, sharedCooldown(), Date.now()));
	// Providers gentle-shell has never heard of get a usage source too, when
	// the extension that owns them registers one on pi.events; see the
	// USAGE_SOURCE_EVENT subscription below.
	const usageSources = new UsageSourceRegistry();
	let renderHost: ShellRenderHost | undefined;
	// The 5-minute rule is per provider: one provider's fetch cannot leave the
	// next one waiting for an interval it never used.
	const usageFetchedAt = new Map<string, number>();
	// Actual failures, per provider: a refresh that settled without a snapshot.
	// In-flight fetches are never in here, so they cannot read as failed; a
	// successful refresh (or a snapshot otherwise recorded) clears the provider.
	const usageFailures = new Set<string>();
	// Monotonic per-provider generation: each dispatched refresh takes the next
	// number, and only the newest one for a provider may mutate its state. Two
	// overlapping refreshes of the SAME source (or of builtins) can otherwise
	// let an older failure settle after a newer success and poison it.
	const usageGenerations = new Map<string, number>();
	// One spelling of the config home, so the pin resolver, the global profiles
	// store and the profile reader cannot drift onto two different stores.
	const usageConfigHome = gentlePiConfigHome(env);
	const usageFetchTimeout = usageFetchTimeoutMs(env);
	// The subagent routing in force for this session, through the same single
	// rule launches use (gentle-shell#1064): explicit Enter binding, then the
	// profile frozen at startup, then the live p → P → G only in follow mode.
	// Only the profile's own role entries count; the reserved orchestrator key
	// is not a route.
	const activeRoutingModels = (ctx: ExtensionContext): Array<string | undefined> => {
		const config = sessionProfileModelProfiles(resolveSessionProfile({
			sessionId: ctx.sessionManager?.getSessionId?.(),
			cwd: ctx.cwd,
			configHome: usageConfigHome,
			resolveWorktree: deps.resolveWorktree,
			env,
		}));
		return config ? profileRoleEntries(config).map(([, entry]) => entry.model) : [];
	};
	// A bare model id names a provider only when exactly one provider in the
	// registry carries that id; anything else stays untargeted rather than guessed.
	const bareModelProvider = (ctx: ExtensionContext, modelId: string): string | undefined => {
		try {
			const providers = new Set(ctx.modelRegistry.getAll().filter((model) => model.id === modelId).map((model) => model.provider));
			return providers.size === 1 ? [...providers][0] : undefined;
		} catch {
			return undefined;
		}
	};
	const usageScopeFor = (ctx: ExtensionContext): string[] =>
		usageScopeProviders(ctx.model?.provider, activeRoutingModels(ctx), (modelId) => bareModelProvider(ctx, modelId));
	let usageScope: string[] = [];
	// The scope is Git/filesystem work, so it is resolved once per refresh and
	// per registration — never per panel render, which only reads the cache.
	const resolveUsageScope = (ctx: ExtensionContext): string[] => {
		usageScope = usageScopeFor(ctx);
		return usageScope;
	};
	// One notification per settled provider — snapshot or failure — so the
	// shell and the open overlay repaint immediately instead of waiting for
	// the whole refresh, whose slowest member is the bounded window itself.
	const notifyUsageSettled = () => {
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	};
	// One bounded, self-contained refresh per provider. Providers run
	// concurrently: a stalled credential lookup or fetch for one can never hold
	// the others — or the overlay opening on them — past its own window.
	const refreshProvider = async (ctx: ExtensionContext, provider: string, source: UsageSource | undefined, force: boolean, now: number): Promise<boolean> => {
		if (!source && provider !== CODEX_PROVIDER && provider !== NAN_PROVIDER) return false;
		if (!force && now - (usageFetchedAt.get(provider) ?? 0) < USAGE_REFRESH_MS) return false;
		usageFetchedAt.set(provider, now);
		const generation = (usageGenerations.get(provider) ?? 0) + 1;
		usageGenerations.set(provider, generation);
		// The window covers credential resolution and the fetch together. The
		// abort signal reaches the underlying fetch through the wrapped fetchFn —
		// built-ins and registered sources alike — so an expired provider is
		// actually cancelled when its caller honors the signal. The race is the
		// only path to state mutation: whatever the work resolves after the
		// window expired is a value nobody reads, so a late answer — success or
		// failure — cannot mutate anything.
		const controller = new AbortController();
		let expire: (() => void) | undefined;
		const expired = new Promise<"timeout">((resolve) => { expire = () => resolve("timeout"); });
		const timer = setTimeout(() => {
			controller.abort();
			expire?.();
		}, usageFetchTimeout);
		// The window's signal composes with whatever the caller already carries —
		// init.signal, or a Request input's own signal — instead of replacing it:
		// either side aborting still aborts, exactly like a plain fetch. With no
		// caller signal the window's signal passes through unchanged.
		const boundedFetch: typeof fetch = (input, init) => {
			const callerSignal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
			return deps.fetch(input, {
				...init,
				signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
			});
		};
		const work = (async () => {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider).catch(() => undefined);
			// The window may have expired while the credential was resolving: an
			// aborted provider must not start its fetch at all.
			if (controller.signal.aborted) return undefined;
			return source
				? fetchFromSource(source, apiKey, boundedFetch, deps.now())
				: provider === NAN_PROVIDER
					? fetchNanUsage(apiKey, boundedFetch, deps.now())
					: fetchCodexUsage(apiKey, boundedFetch, deps.now());
		})();
		// The race's loser still runs to completion in the background: guard it so
		// its rejection (a foreign source escaping its own catch) can never
		// surface as unhandled, and clear the timer so nothing dangles.
		const guarded = work.catch(() => undefined);
		const settled = await Promise.race([guarded, expired]);
		clearTimeout(timer);
		// Discard before any state mutation: a generation mismatch means a newer
		// refresh for this provider was dispatched and owns the state, and a
		// replaced source's answer belongs to neither. A late success must not
		// overwrite the newer snapshot, and a late failure must not mark the
		// provider failed after its replacement succeeded.
		if (usageGenerations.get(provider) !== generation) return false;
		if (source && usageSources.get(provider) !== source) return false;
		if (settled === "timeout" || !settled) {
			usageFailures.add(provider);
			notifyUsageSettled();
			return false;
		}
		usage.record(settled);
		usageFailures.delete(provider);
		notifyUsageSettled();
		return true;
	};
	const refreshUsage = async (ctx: ExtensionContext, force: boolean, only?: string) => {
		const scope = resolveUsageScope(ctx);
		const now = deps.now();
		// Concurrent per provider; each settle notifies the shell (and repaints
		// the open overlay) on its own, so a fast provider never waits for the
		// slowest one's window. A discarded late answer notifies nothing: the
		// refresh that owns the state notifies at its own settle.
		await Promise.all(
			scope
				.filter((provider) => only === undefined || provider === only)
				.map((provider) => refreshProvider(ctx, provider, usageSources.get(provider), force, now)),
		);
	};
	// Desktop's usage slice reaches the owner only through this versioned,
	// adapter-shaped seam — the usage analogue of the YOLO host-ui adapter. It
	// wraps the existing UsageStore / UsageSourceRegistry / refreshUsage /
	// after_provider_response closures; there is no second store, fetcher, or
	// auth resolver. Header-driven snapshots are broadcast to every subscribed
	// Desktop consumer through the shared observer set below, already parsed.
	const desktopUsageObservers = new Set<(recorded: DesktopUsageRecordedSnapshot) => void>();
	pi.events.on(DESKTOP_USAGE_SERVICE_CHANNEL, (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const request = payload as Partial<{ context: ExtensionContext; respond(service: DesktopUsageService): void }>;
		if (typeof request.respond !== "function" || !request.context) return;
		const ctx = request.context;
		try {
			let disposed = false;
			const subscriptions = new Set<(recorded: DesktopUsageRecordedSnapshot) => void>();
			const read = (provider?: string, outOfScope = false): DesktopUsageOwnerRead => {
				if (disposed) return { providers: [] };
				const scope = provider === undefined ? resolveUsageScope(ctx) : [provider];
				return {
					providers: scope.map((name) => ({
						provider: name,
						supported: isSupportedUsageProvider(name, usageSources.has(name)),
						refreshable: isRefreshableUsageProvider(name, usageSources.has(name)),
						failed: usageFailures.has(name),
						...(outOfScope ? { outOfScope: true } : {}),
						snapshot: usage.get(name),
					})),
				};
			};
			const refresh = async (provider?: string): Promise<DesktopUsageOwnerRead> => {
				if (disposed) return { providers: [] };
				// Resolve the scope BEFORE delegation: a filtered refresh for a provider
				// outside the current session scope would never fetch anything (refreshUsage
				// filters by scope), so it answers a truthful out_of_scope no-op instead of
				// an ambiguous pending, and never attempts the fetch.
				const scope = resolveUsageScope(ctx);
				if (provider !== undefined && !scope.includes(provider)) {
					return read(provider, true);
				}
				// The same API-key/auth logic the panel uses: refreshUsage resolves
				// the scope, the credentials, and the fetch window itself. Anthropic
				// is skipped there because it has no usage endpoint, so a refresh
				// for it is a truthful no-op rather than a fabricated snapshot.
				await refreshUsage(ctx, true, provider);
				return read(provider);
			};
			request.respond({
				schema: DESKTOP_USAGE_SERVICE_SCHEMA,
				read,
				refresh,
				observe: (onSnapshot) => {
					if (disposed) return () => {};
					subscriptions.add(onSnapshot);
					desktopUsageObservers.add(onSnapshot);
					return () => {
						subscriptions.delete(onSnapshot);
						desktopUsageObservers.delete(onSnapshot);
					};
				},
				dispose: () => {
					disposed = true;
					for (const onSnapshot of subscriptions) desktopUsageObservers.delete(onSnapshot);
					subscriptions.clear();
				},
			});
		} catch {
			/* obsolete trusted context: discovery expires closed */
		}
	});
	// Subscribed once, for the life of the extension: a registration can
	// arrive before the first session_start (the owning extension's factory
	// runs first) or after it (its own session_start fires later, or it
	// registers lazily). Either order is fine: a registration for the
	// currently active provider forces exactly one refresh, so the panel
	// never waits for the 5-minute window or the next turn to notice it.
	pi.events.on(USAGE_SOURCE_EVENT, (payload) => {
		const source = parseUsageSource(payload);
		if (!source) return;
		usageSources.register(source);
		if (!currentContext) return;
		// A registration is interesting when its provider is targeted at all —
		// the session's own or a subagent route of the active profile — and then
		// only that provider is forced, never the whole scope.
		if (resolveUsageScope(currentContext).includes(source.provider)) void refreshUsage(currentContext, true, source.provider);
	});
	pi.on("after_provider_response", (event, ctx) => {
		const headerUsage = parseUsageHeaders(event.headers, deps.now());
		if (!headerUsage) return;
		// The headers name a format, not the provider: pi-claude-bridge reports
		// Claude Code's usage as the Anthropic unified headers. File the snapshot
		// under the provider that served the response, which the bar looks up.
		const served = ctx?.model?.provider;
		const parsed = served ? { ...headerUsage, provider: served } : headerUsage;
		usage.record(parsed);
		// A snapshot that arrived with a response is evidence the provider is
		// answering: a failure some earlier refresh recorded no longer stands.
		usageFailures.delete(parsed.provider);
		// Desktop consumers subscribed through the owner service get the already-
		// parsed snapshot (Claude's 5h/7d windows included), never header text.
		for (const onSnapshot of [...desktopUsageObservers]) {
			try { onSnapshot({ provider: parsed.provider, usage: parsed }); } catch { /* a listener never breaks usage */ }
		}
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	});
	pi.registerMessageRenderer(REVIEW_PREFLIGHT_TYPE, (message, options, theme) => {
		const lines = messageText(message.content as string | Array<{ type: string; text?: string }>).split("\n");
		const body = options.expanded ? lines : lines.filter((line) => line.trim() !== "");
		const hint = keyHint("app.tools.expand", options.expanded ? "collapse" : "expand");
		return cardComponent({ title: "Gentle AI", subtitle: "review preflight", body, tone: CARD_TONE.INFO }, theme, { expanded: options.expanded, previewRows: 3, hint });
	});
	// The attached narrow fullscreen layout owns the mobile editor and work row
	// for every header placement. Wide split uses the IDE chrome beside the rail;
	// wide top and below-input keep their existing chrome-bar paths.
	const chromeMode = (tui: TUI): "wide" | "narrow" | undefined => {
		if ((tui as TUI & { mode?: string }).mode !== "fullscreen" || !tui.terminal) return undefined;
		const state = sidebarState(tui);
		if (state.active && state.ownsHost?.()) return visualSettings.headerPlacement === "split" ? "wide" : undefined;
		// Do not suppress native widgets unless the host can actually draw the bar.
		if (!state.layoutAttached?.()) return undefined;
		return tui.terminal.columns < SIDEBAR_BREAKPOINT ? "narrow" : undefined;
	};
	// Where the chrome bars draw (beside the rail, or with Status hidden or at the
	// bottom, outside the mobile chrome): every placement there shares the bar
	// design and the titled-rule editor.
	// `drawn` asks whether the rail actually painted in the last layout pass: the
	// editor and footer render after it, while the header renders during it.
	const chromeBarsShown = (tui: TUI, drawn = false): boolean => {
		if ((tui as TUI & { mode?: string }).mode !== "fullscreen" || !tui.terminal || chromeMode(tui) === "narrow") return false;
		const placement = visualSettings.statusPlacement;
		if (placement === "hidden" || placement === "bottom") return true;
		// The rail owns the host (layout installed) only at 140 columns or wider, with Status auto or right.
		const state = sidebarState(tui);
		return Boolean(state.ownsHost?.() && (!drawn || state.active));
	};
	// The live-work digests the mobile work row folds, honoring the Todos switch.
	const workParts = (tui: TUI) => {
		const state = sidebarState(tui);
		return ["agents", "todo"].filter((key) => key !== "todo" || state.visibility?.todo !== false).flatMap((key) => {
			const part = state.parts.get(key);
			const summary = part?.summary?.();
			return part && summary ? [{ part, summary }] : [];
		});
	};
	const workSummaries = (tui: TUI) => workParts(tui).map((work) => work.summary);
	// A tap on the work row opens the leading section's own view (an agent opens
	// /gentle:agents); a section without one, such as Todos, opens the panel sheet.
	const openWorkRow = (tui: TUI, ctx: ExtensionContext) => {
		const parts = workParts(tui);
		const lead = parts[workRowLead(parts.map((work) => work.summary))];
		if (!lead) return;
		if (lead.part.open) lead.part.open();
		else void openPanelSheet(ctx);
	};
	// What the panel editor draws above its rule: the mobile work row, then any
	// agent question, so nothing another widget adds can land between them and the input.
	const panelTopRows = (tui: TUI, width: number, theme: Parameters<typeof renderWorkRow>[1], hovered?: number): string[] => {
		if (!tui.terminal) return [];
		const state = sidebarState(tui);
		const row = chromeMode(tui) === "narrow" ? renderWorkRow(workSummaries(tui), theme, width, hovered === 0) : undefined;
		// An agent question needs its own row whenever the above-editor Agents
		// card is hidden: the rail owns the host (any header placement) or the
		// work row folded the card.
		const cardHidden = Boolean(state.active && state.ownsHost?.()) || Boolean(state.compactWork?.());
		return [...(row ? [row] : []), ...(cardHidden ? (state.parts.get("agents")?.alert?.(width) ?? []) : [])];
	};
	// The rail's sections as a full-width sheet: /gentle:panel, or a tap on the mobile work row.
	// The sheet leaves the editor's [ Panel ] clickable, so an open sheet is reused
	// instead of stacking another overlay per click.
	let openSheet: Promise<null | undefined> | undefined;
	const openPanelSheet = (ctx: ExtensionContext) => {
		if (openSheet) return openSheet;
		const opened = showPanelSheet(ctx).finally(() => { if (openSheet === opened) openSheet = undefined; });
		openSheet = opened;
		return opened;
	};
	const showPanelSheet = (ctx: ExtensionContext) =>
		ctx.ui.custom<null>(
			(tui, theme, _keybindings, done) => {
				const close = withOverlayRepaint(tui, done);
				let scrollTop = 0;
				let maxScroll = 0;
				let backHovered = false;
				let sheetWidth = 0;
				return {
					render(width: number) {
						sheetWidth = width;
						// Hang from the top and leave the bottom rows to the work row, the
						// editor and the status bar, so the input stays visible.
						// The sections live on the shell's sidebar terminal, the one its footer drew on,
						// and a section the rail hides (the Todos switch) stays hidden here too.
						const host = (sidebarTui ?? tui) as TUI;
						const rows = Math.max(4, (host.terminal?.rows ?? 24) - SHEET_RESERVED_ROWS);
						const state = sidebarState(host);
						const parts = new Map([...state.parts].filter(([key]) => key !== "todo" || state.visibility?.todo !== false));
						const sheet = renderPanelSheet(parts, theme, width, { rows, scrollTop, backHovered });
						maxScroll = sheet.maxScroll;
						scrollTop = Math.min(scrollTop, maxScroll);
						return sheet.lines;
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || data === "q") { close(null); return; }
						if (matchesKey(data, Key.down) || data === "j") scrollTop = Math.min(maxScroll, scrollTop + 1);
						else if (matchesKey(data, Key.up) || data === "k") scrollTop = Math.max(0, scrollTop - 1);
						else return;
						tui.requestRender();
					},
					// `esc back` is a control too: hover paints it, a click closes the sheet; the wheel scrolls.
					handleMouse(event: TuiMouseEvent) {
						const onBack = panelSheetBackHit(sheetWidth || event.width, event.x, event.y);
						if (event.type === "move" && onBack !== backHovered) { backHovered = onBack; return { handled: true, render: true }; }
						if (event.type === "click" && event.button === "left" && onBack) { close(null); return { handled: true, render: true }; }
						if (event.type === "wheel") {
							scrollTop = Math.max(0, Math.min(maxScroll, scrollTop + Math.sign(event.wheelDelta ?? 0)));
							return { handled: true, render: true };
						}
						return undefined;
					},
					invalidate() {},
				};
			},
			{ overlay: true, overlayOptions: { width: "100%", anchor: "top-center" } },
		);
	pi.registerCommand(PANEL_COMMAND_NAME, {
		description: "Show the sidebar panel (todos, jobs, agents, changes, review, integrations) as a full-width sheet.",
		handler: async (_args, ctx) => openPanelSheet(ctx),
	});
	const openUsage = (ctx: ExtensionContext) =>
		ctx.ui.custom<null>(
			(tui, theme, _keybindings, done) => {
				const view = new UsageView(usage, {
					theme,
					now: () => deps.now(),
					active: () => (ctx.model ? { provider: ctx.model.provider } : undefined),
					registry: () => usageSources,
					onRefresh: () => refreshUsage(ctx, true),
					onClose: () => withOverlayRepaint(tui, done)(null),
					requestRender: () => tui.requestRender(),
					scope: () => ({ providers: usageScope, failed: new Set(usageFailures) }),
					gauge: () => gaugePaint(ctx),
				});
				// Open promptly: the panel draws whatever the store already holds
				// while the forced refresh runs underneath it, and repaints when
				// the refresh settles — answers, failures, or the bounded timeout.
				view.refresh();
				return view;
			},
			{ overlay: true, overlayOptions: { width: "70%", minWidth: 60, anchor: "center" } },
		);
	pi.registerCommand(USAGE_COMMAND_NAME, {
		description: "Show subscription usage windows for the connected providers. Press r to refetch.",
		handler: async (_args, ctx) => openUsage(ctx),
	});
	const usageShortcutKey = usageShortcut(env, keymaps.bindings);
	const todoKey = todoCollapseKey(env, keymaps.bindings);
	if (usageShortcutKey) {
		pi.registerShortcut(usageShortcutKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Show subscription usage windows for the connected providers",
			handler: async (ctx) => openUsage(ctx),
		});
	}
	let prompt: GentlePromptEditor | undefined;
	// Images pasted into the current draft; emptied on every submit.
	const imageAttachments = new ImageAttachments();
	// Opt-in disk cache for tools that need a real file path. Off unless the user
	// asks for it: `GENTLE_PI_IMAGES_DISK_CACHE=session`. The path is never put in
	// the prompt; it is readable through /gentle:images only.
	const imagesDiskCachePolicy = (env.GENTLE_PI_IMAGES_DISK_CACHE ?? "off").trim().toLowerCase() === "session" ? "session" : "off";
	// Set by abortAndDispatchQueued via dispatchQueuedText when an Esc aborts
	// a turn with a non-empty queue; sent exactly once, from agent_settled,
	// once the aborted run has fully settled (issue #1218). Several aborts
	// before that settle append in order, joined the way Pi joins its own
	// queue, so nothing is overwritten. It belongs to the current session and
	// is dropped on session_shutdown.
	let pendingQueuedText: string | undefined;
	// Resolved once at startup and cached in memory so the editor never
	// re-reads the file per keypress. The /gentle:double-esc-cancel command
	// below is the only place that touches the file, and every invocation
	// re-syncs this cache from disk first, so status, the no-argument toggle
	// direction, and the Esc gate always describe the same effective policy
	// even when another session or a hand edit changed the file mid-session.
	const doubleEscCancelConfigHome = gentlePiConfigHome(env);
	const animationOptions = { gentlePiConfigHome: doubleEscCancelConfigHome };
	let animationPolicy = resolveAnimationPolicy(animationOptions).policy;
	let vimPolicy = resolveVimPolicy(animationOptions).policy;
	let tabsSettings = resolveSidebarTabs(animationOptions);
	// Conversation cards read the style from a process-wide slot; the saved
	// preference fills it at startup and again on every session start.
	const applyCardStyle = () => setCardStyle(resolveCardStyle(animationOptions).style);
	applyCardStyle();
	// The Card content preference rides the same kind of slot: the quiet tool
	// renderers read it live, so the saved level applies from the first render.
	const applyCardContent = () => setCardContent(resolveCardContent(animationOptions).content);
	applyCardContent();
	const reportVim = (ctx: ExtensionContext, result: ReturnType<typeof resolveVimPolicy>) => {
		const source = result.source === "default" ? "built-in default" : `global file ${result.globalFile}`;
		const effective = prompt?.effectiveVimPolicy;
		const state = effective === undefined ? "No active Gentle prompt; preference applies when one starts" :
			effective !== result.policy ? `Effective prompt: ${effective}; saved preference and prompt differ; ordinary editing remains active` :
			result.policy === "off" ? "Prompt applies now; ordinary editing active" : "Prompt applies now";
		ctx.ui.notify(`vim: ${result.policy} (decided by ${source})${result.malformed ? "; malformed or unreadable file, falling back to off" : ""}. ${state}.`, result.malformed || (effective !== undefined && effective !== result.policy) ? "warning" : "info");
	};
	let visualSettings = resolveVisualSettings(animationOptions).settings;
	setChromeSurface(visualSettings.surface);
	let sidebarTui: TUI | undefined;
	let groupedChangesOwner: (width: number) => boolean = () => false;
	const refreshVisual = () => {
		visualSettings = resolveVisualSettings(animationOptions).settings;
		setChromeSurface(visualSettings.surface);
		if (currentContext && changes) showChanges(currentContext, changes.model, visualSettings.visibility.changes, (width) => groupedChangesOwner(width));
		if (sidebarTui?.terminal) sidebarState(sidebarTui).visibility = { todo: visualSettings.visibility.todo };
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	};
	let doubleEscCancelPolicy: DoubleEscCancelPolicy = resolveDoubleEscCancelPolicy({
		env,
		gentlePiConfigHome: doubleEscCancelConfigHome,
	}).policy;
	let changes: WorktreeChangesTracker | undefined;
	let registry: SessionWorktreeRegistry | undefined;
	let currentContext: ExtensionContext | undefined;
	let disposeFooter: (() => void) | undefined;
	let refreshSidebarHistory: (() => Promise<void>) | undefined;
	let refreshSidebarDiff: (() => Promise<void>) | undefined;
	let toggleSidebarDiff: (() => void) | undefined;
	let toggleSidebarHistory: (() => void) | undefined;
	let review: ReviewSidebarSnapshot | undefined;
	let runningJobs: RunningJobDisplay[] | undefined;
	let jobsCollapsed = false;
	const redrawReview = () => {
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	};
	const unsubscribeReview = pi.events.on(REVIEW_SIDEBAR_EVENT, (value) => {
		const event = value as { sessionId?: unknown; snapshot?: unknown } | undefined;
		if (!currentContext || event?.sessionId !== currentContext.sessionManager.getSessionId()) return;
		if (!isReviewSidebarSnapshot(event.snapshot)) return;
		review = { state: event.snapshot.state, scope: event.snapshot.scope };
		redrawReview();
	});
	const unsubscribeJobs = pi.events.on(JOBS_SIDEBAR_EVENT, (value) => {
		const event = value as { sessionId?: unknown; snapshot?: unknown } | undefined;
		if (!currentContext || event?.sessionId !== currentContext.sessionManager.getSessionId()) return;
		if (!isJobsSidebarSnapshot(event.snapshot)) return;
		runningJobs = event.snapshot.jobs.map(({ id, label, startedAt, status, endedAt, exitCode }) => ({ id, label, startedAt, status, endedAt, exitCode }));
		redrawReview();
	});
	pi.on("session_tree", () => {
		review = undefined;
		redrawReview();
	});
	let shown = "";
	const applyChanges = (ctx: ExtensionContext, model: ChangesModel) => {
		const fingerprint = changesFingerprint(model);
		if (fingerprint === shown) return;
		shown = fingerprint;
		showChanges(ctx, model, visualSettings.visibility.changes, (width) => groupedChangesOwner(width));
	};
	const gitForRoot = (root: string) => deps.gitRunner(root);
	// A Git discovery failure is the same as no Git root: an injected resolver
	// that throws must never abort session startup.
	const worktreeOrNone: WorktreeResolver = (path, cwd) => {
		try { return deps.resolveWorktree(path, cwd); } catch { return undefined; }
	};
	// Changes is the Git state of the session's roots that still exist: read
	// at turn end, on panel open and by the panel's poll, never at startup.
	const changesTracker = (ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const roots = () => {
			try { return sessionChangeRoots(sessionId, ctx.sessionManager.getEntries()).filter((root) => deps.rootExists(root) && !isHomeOrBroadUserDirectory(root)); }
			catch { return []; }
		};
		return new WorktreeChangesTracker(gitForRoot(ctx.cwd), gitForRoot, untrackedLines, roots, fileRevision);
	};
	const refreshChanges = async (ctx: ExtensionContext) => {
		const tracker = changes;
		if (!tracker || !ctx.hasUI || registry?.sessionId !== ctx.sessionManager.getSessionId()) return;
		const [model] = await Promise.all([tracker.refresh(), refreshSidebarHistory?.() ?? Promise.resolve()]);
		if (changes === tracker) applyChanges(ctx, model);
	};
	pi.registerTool({
		name: "session_worktree_register",
		renderShell: "self",
		label: "Register session worktree",
		description: "Register a worktree in the same Git clone for session coordination. /gentle:changes then also lists that worktree's uncommitted Git changes.",
		parameters: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", description: "Worktree path to include in this session." } } } as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!registry || registry.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("No active session worktree registry.");
			const root = registry.register((params as { path: string }).path, "explicit");
			trackChangeRefresh(refreshChanges(ctx));
			return { content: [{ type: "text", text: `Registered session worktree: ${root}` }], details: { root, sessionId: registry.sessionId } };
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		customizeGeneration++;
		if (imagesDiskCachePolicy === "session") {
			const cacheRoot = defaultCacheRoot(env);
			try {
				ImageDiskCache.sweepStale(cacheRoot, 7 * 24 * 60 * 60 * 1000);
			} catch {
				// A sweep that cannot run must never block the session.
			}
			imageAttachments.setCache(new ImageDiskCache({ root: cacheRoot, sessionId: ctx.sessionManager.getSessionId() }));
		}
		closeCustomize?.();
		runningJobs = undefined;
		if (review) {
			review = undefined;
			redrawReview();
		}
		stopProfilePoll();
		registry?.close();
		currentContext = ctx;
		changes = undefined;
		registry = new SessionWorktreeRegistry(pi, ctx.sessionManager, ctx.cwd, worktreeOrNone);
		registry.start();
		applyCardStyle();
		applyCardContent();
		if (!ctx.hasUI) return;
		visualSettings = resolveVisualSettings(animationOptions).settings;
		setChromeSurface(visualSettings.surface);
		if (!overrides.activeProfile) {
			profileReader.bind(ctx.cwd, deps.resolveWorktree, ctx.sessionManager.getSessionId());
		}
		changes = changesTracker(ctx);
		const tracker = changes;
		const hasGitRoot = !!worktreeOrNone(ctx.cwd, ctx.cwd);
		ctx.ui.setFooter((tui, theme, footerData) => {
			disposeFooter?.();
			sidebarTui = tui;
			if (tui.terminal) sidebarState(tui).visibility = { todo: visualSettings.visibility.todo };
			renderHost = { requestRender: () => tui.requestRender(), invalidateSidebar: () => invalidateSidebar(tui) };
			let gitActive = false, aliveGit = true, generation = 0, diffOpening = false;
			let roots: SidebarGitRoots | undefined;
			let selectedRoot = ctx.cwd;
			const valid = (version: number) => aliveGit && gitActive && generation === version && currentContext === ctx && changes === tracker;
			const guardedGit = (root: string, version: number): GitRunner => async args => valid(version) ? deps.gitRunner(root, 1024 * 1024)(args) : { code: 128, stdout: "" };
			// The GIT history and changes cards are one root-keyed state machine: a
			// MAIN/WORKTREE switch keeps the last good frame painted until the newly
			// selected root's history and diff have answered, then swaps it with a
			// single repaint. Re-entry paints the cached frame again.
			let historyOffset = 0, diffOffset = 0;
			let offsetRoot: string | undefined;
			const offsets = new Map<string, { history: number; diff: number }>();
			const syncGitOffsets = () => {
				const root = gitCardsState.paintedRoot;
				if (root === offsetRoot) return;
				if (offsetRoot !== undefined) offsets.set(offsetRoot, { history: historyOffset, diff: diffOffset });
				historyOffset = root ? offsets.get(root)?.history ?? 0 : 0;
				diffOffset = root ? offsets.get(root)?.diff ?? 0 : 0;
				offsetRoot = root;
			};
			const gitCardsState = new SidebarGitCards({
				git: root => deps.gitRunner(root, 1024 * 1024),
				untrackedLines, fileRevision,
				publish: () => { if (!aliveGit) return; syncGitOffsets(); invalidateSidebar(tui); tui.requestRender(); },
			}, { history: tabsSettings.gitHistory === "on", diff: tabsSettings.diff === "on" });
			const configureGitCards = () => gitCardsState.configure({ history: tabsSettings.gitHistory === "on", diff: tabsSettings.diff === "on" });
			toggleSidebarHistory = configureGitCards;
			toggleSidebarDiff = configureGitCards;
			const refreshHistoryCards = () => gitCardsState.refreshHistory();
			const refreshDiffCards = () => gitCardsState.refreshDiff();
			refreshSidebarHistory = refreshHistoryCards;
			refreshSidebarDiff = refreshDiffCards;
			let historyViewport = 1, historyCardViewport = 1, historyCollapsed = false, historyHovered = false;
			const clearHistoryHover = () => {
				releaseSidebarHover(tui, gitRail);
				if (!historyHovered) return;
				historyHovered = false;
				tui.requestRender();
			};
			const maxHistoryOffset = (viewport = historyCardViewport) => Math.max(0, (gitCardsState.graph.state === "ready" ? gitCardsState.graph.lines.length : 0) - Math.max(1, viewport - 1));
			const gitRail: SidebarRail = {
				surface: "panel",
				digest: () => `${gitCardsState.digest()}:${visualSettings.density}:${historyViewport}:${historyOffset}:${historyCollapsed}:${historyHovered}`,
				render: width => gitCardsState.historyRows(theme, width, historyViewport, Math.min(historyOffset, maxHistoryOffset()), historyCollapsed, historyHovered),
				invalidate() {},
				handleMouse(event) {
					if (event.type === "move" && event.button === "none") {
						const next = event.y === 0;
						if (next) setSidebarHover(tui, gitRail, clearHistoryHover);
						else setSidebarHover(tui);
						if (next === historyHovered) return { handled: true };
						historyHovered = next;
						return { handled: true, render: true };
					}
					if (event.type === "click" && event.button === "left" && event.y === 0) {
						historyCollapsed = !historyCollapsed;
						invalidateSidebar(tui);
						tui.requestRender();
						return { handled: true, render: true };
					}
					if (event.type !== "wheel") return undefined;
					if (historyCollapsed) return { handled: true };
					const next = Math.max(0, Math.min(maxHistoryOffset(), historyOffset + (event.wheelDelta ?? 0)));
					if (next === historyOffset) return { handled: true };
					historyOffset = next;
					return { handled: true, render: true };
				},
			};
			let diffCollapsed = false, diffHovered = false, diffStart = 0, diffLength = 0;
			const files = () => gitCardsState.model?.files ?? [];
			const selectorVisible = () => roots?.state === "ready" && roots.main !== roots.wt;
			// Transparent cards render loose rows at the card's inner width, from
			// the rail's left edge. Match the right inset at that width locally.
			const selectorInset = () => visualSettings.surface === "transparent" ? 50 - (panelInnerWidth(theme, 50) + 2) : 0;
			const selector = (width: number) => {
				const inset = selectorInset();
				if (!selectorVisible() || roots?.state !== "ready" || width < 16 + inset) return "";
				const paintedRoot = gitCardsState.paintedRoot ?? selectedRoot;
				const left = paintedRoot === roots.main ? "[MAIN]" : " MAIN ";
				const right = paintedRoot === roots.wt ? "[WORKTREE]" : " WORKTREE ";
				return " ".repeat(inset) + theme.fg(paintedRoot === roots.main ? "accent" : "muted", left) + " ".repeat(width - inset - left.length - right.length) + theme.fg(paintedRoot === roots.wt ? "accent" : "muted", right);
			};
			const gitCards: SidebarRail = {
				surface: "panel",
				// The selector and offsets follow the painted root during a deferred switch.
				digest: () => JSON.stringify([gitRail.digest?.(), roots, selectedRoot, diffOffset, diffCollapsed, diffHovered, visualSettings.density]),
				render(width) {
					const showGit = tabsSettings.gitHistory === "on", showDiff = tabsSettings.diff === "on";
					const bothOpen = showGit && showDiff && !historyCollapsed && !diffCollapsed;
					// The separating row between the two equal-weight cards reserves one
					// viewport row on the tinted surface, so both cards share what is
					// left: the gap never grows the rail beyond MAIN's per-section gaps.
					// On transparent there is no painted gap row: the card chrome keeps
					// the two frames side by side, so the viewport budget is untouched.
					const tintedGap = bothOpen && chromeSurface() !== "transparent";
					const available = Math.max(1, historyViewport - Number(selectorVisible()) - (tintedGap ? 1 : 0));
					const gitHeight = showGit ? (bothOpen ? Math.ceil(available / 2) : historyCollapsed ? 1 : Math.max(1, available - Number(showDiff))) : 0;
					const diffHeight = showDiff ? (bothOpen ? Math.floor(available / 2) : diffCollapsed ? 1 : Math.max(1, available - Number(showGit))) : 0;
					historyCardViewport = gitHeight;
					const rows = selectorVisible() ? [selector(width)] : [];
					if (showGit) rows.push(...gitCardsState.historyRows(theme, width, gitHeight, Math.min(historyOffset, maxHistoryOffset(gitHeight)), historyCollapsed, historyHovered));
					// Filler rows between the two cards must paint the full width: the tinted
					// surface fills per cell, and a one-space filler leaves a bare notch.
					if (bothOpen) while (rows.length < gitHeight + Number(selectorVisible())) rows.push(" ".repeat(width));
					// Git and Changes are two equal-weight cards, never a nested one: a
					// separating row always sits between them when both are open. The tinted
					// surface paints it full-width; on transparent the card chrome already
					// separates both frames and this row only keeps the same space.
					if (tintedGap) rows.push(" ".repeat(width));
					diffStart = rows.length;
					if (showDiff) {
						const list = files();
						diffOffset = Math.min(diffOffset, Math.max(0, list.length - Math.max(0, diffHeight - 2)));
						rows.push(...gitCardsState.changesRows(theme, width, diffHeight, diffOffset, diffCollapsed, diffHovered));
					}
					diffLength = rows.length - diffStart;
					return rows;
				},
				// The separating row belongs to neither card: the history group ends
				// before it, so both cards keep equal spans and the tinted paint fills it.
				cardGroups: () => {
					const tintedGap = tabsSettings.gitHistory === "on" && tabsSettings.diff === "on" && !historyCollapsed && !diffCollapsed && chromeSurface() !== "transparent";
					// The separating row belongs to neither card: the history group ends
					// before it, so both cards keep equal spans and the tinted paint fills it.
					return { groups: [...(tabsSettings.gitHistory === "on" ? [{ start: Number(selectorVisible()), end: diffStart - (tintedGap ? 1 : 0) }] : []), ...(tabsSettings.diff === "on" ? [{ start: diffStart, end: diffStart + diffLength }] : [])], loose: selectorVisible() ? [0] : [] };
				},
				invalidate() {},
				handleMouse(event) {
					if (selectorVisible() && event.y === 0) {
						if (event.type !== "click" || event.button !== "left" || roots?.state !== "ready") return undefined;
						if (event.width < 16 + selectorInset()) return undefined;
						const main = selectorInset() + 1, wt = event.width - 9;
						const root = event.x >= main && event.x < main + 4 ? roots.main : event.x >= wt && event.x < wt + 8 ? roots.wt : undefined;
						if (!root) return undefined;
						if (root !== selectedRoot) { selectedRoot = root; gitCardsState.select(root); invalidateSidebar(tui); tui.requestRender(); }
						return { handled: true, render: true };
					}
					if (tabsSettings.diff !== "on" || event.y < diffStart) return gitRail.handleMouse?.({ ...event, y: event.y - Number(selectorVisible()) });
					const row = event.y - diffStart;
					if (event.type === "move" && event.button === "none") { diffHovered = row === 0; setSidebarHover(tui, diffHovered ? gitCards : undefined, diffHovered ? () => { diffHovered = false; tui.requestRender(); } : undefined); return { handled: true, render: true }; }
					if (event.type === "wheel") { if (!diffCollapsed) diffOffset = Math.max(0, Math.min(Math.max(0, files().length - Math.max(0, diffLength - 2)), diffOffset + (event.wheelDelta ?? 0))); return { handled: true, render: true }; }
					if (event.type !== "click" || event.button !== "left") return undefined;
					if (row === 0) { diffCollapsed = !diffCollapsed; invalidateSidebar(tui); return { handled: true, render: true }; }
					const file = row >= 2 ? files()[diffOffset + row - 2] : undefined;
					if (file && !diffCollapsed && !diffOpening) {
						diffOpening = true;
						// The painted root owns the rows the click hit: a deferred switch
						// still shows the previous root's files.
						const root = gitCardsState.paintedRoot ?? selectedRoot, version = generation;
						const direct = new ChangesTracker(guardedGit(root, version), untrackedLines(root), fileRevision(root));
						let model = gitCardsState.model ?? { files: [], added: 0, deleted: 0 };
						let started: Promise<void> | undefined;
						void showChangesOverlay(ctx, { initial: { root, path: file.path }, available: () => valid(version), loadDiff: (targetRoot, target) => loadFileDiff(guardedGit(targetRoot, version), target), worktrees: () => [{ root, model }], pollMs: changesPollMs(env), refresh: async () => { // A failed first capture leaves the tracker unread; retry start()
									// instead of refreshing a tracker that can no longer read (CodeRabbit finding).
									if (!started) { started = direct.start(); await started; model = direct.model; }
									else if (!direct.statusRead) { await direct.start(); model = direct.model; }
									else { await started; model = await direct.refresh(); }
									return model; }, apply: () => {} }).catch(() => { if (currentContext === ctx) ctx.ui.notify("Could not open changes.", "warning"); }).finally(() => { diffOpening = false; });
					}
					return { handled: true, render: true };
				},
			};
			const bottom = createShellBarComponent(pi, ctx, renderHost, theme, footerData, () => tracker.model.files.length, () => usage.get(ctx.model?.provider ?? ""), () => visualSettings);
			// The Status card paints live session state that no event re-registers a
			// part for: model, effort, context, cost, session name and extension
			// statuses. The digest is what keeps the fullscreen memo honest. Issue
			// #1681: railDigest evaluates every rail's digest per keystroke, so both
			// Status rails digest a cheap key and reuse the memoized model
			// (createFooterStatusMemo).
			const footerStatus = createFooterStatusMemo({
				pi, ctx, footerData,
				usage: () => usage.get(ctx.model?.provider ?? ""),
				profile: () => deps.activeProfile(),
				profileTier: () => deps.activeProfile === profileReader ? profileReader.tier() : undefined,
				// The compact bar and header derive ⧗ N jobs from model.jobs.length,
				// so this input is running-only: the snapshot carries the finished tail.
				jobs: () => runningJobs?.filter((job) => job.status === undefined),
				review: () => review,
				tracker: () => tracker,
				visualSettings: () => visualSettings,
				cardStyle: () => cardStyle(),
			});
			const footerModel = footerStatus.model;
			// At narrow fullscreen widths only one status row paints: a top header
			// suppresses the bottom bar in the layout, and otherwise the bottom bar
			// takes over the header's data while the below-input header steps aside.
			const statusOwner = () => narrowStatusOwner({ mode: (tui as TUI & { mode?: string }).mode, columns: tui.terminal?.columns ?? 0, statusPlacement: visualSettings.statusPlacement, headerPlacement: visualSettings.headerPlacement });
			const statusCardVisible = () => Boolean(tui.terminal && tui.terminal.columns >= SIDEBAR_BREAKPOINT && sidebarState(tui).ownsHost?.() && visualSettings.statusPlacement !== "hidden");
			const belowFloat = (width: number, statuses: boolean) => (tui as TUI & { mode?: string }).mode === "fullscreen"
				? renderShellBelowInputFloat({ ...footerModel(), ...(statuses ? {} : { statuses: [] }), ...(statusCardVisible() ? { jobs: undefined } : {}) }, theme, width, usageShortcutKey, visualSettings, tracker.model, gaugePaint(ctx))
				: undefined;
			// Match sidebarPart's live paint ownership, including an unavailable rail.
			const footerSuppressed = () => {
				if (!tui.terminal) return false;
				const state = sidebarState(tui);
				return Boolean(state.statusHidden?.() || state.headerOwnsStatus?.() || (state.active && state.ownsHost?.()));
			};
			// Chrome bars never group Changes: they keep their own row (or the rail).
			groupedChangesOwner = (width) => !narrowChrome() && !belowChrome() && belowFloat(width, !footerSuppressed()) !== undefined;
			const bottomBar = {
				...bottom,
				render: (width: number) => bottomStatus() ? [] : belowFloat(width, true)?.rows ?? (statusOwner() === STATUS_OWNER.BOTTOM ? renderShellBottomOnlyBar(footerModel(), theme, width, usageShortcutKey, visualSettings, undefined, gaugePaint(ctx)) : bottom.render(width)),
				handleMouse(event: Parameters<NonNullable<SidebarRail["handleMouse"]>>[0]) {
					if (footerSuppressed() || event.type !== "click" || event.button !== "left") return undefined;
					const chrome = belowFloat(event.width, true);
					if (!chrome || !shellHeaderUsageHit(chrome, event.x, event.y)) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			};
			// The rail's Status is a panel: Changes, Review and Integrations, then
			// the key hints that close the rail (the section headers carry none).
			// The rail carries no key hints row: the Todos header shows its own collapse
			// key, and the bars carry the usage key.
			const railHints = undefined;
			// Status sections are clickable like the other rail sections: a header
			// folds its section, the Changes row opens /gentle:changes.
			const statusCollapsed = new Set<StatusSection>();
			let statusHover: StatusSection | "open-changes" | undefined;
			// Keyed by width: the rail and the full-width panel sheet render the same part.
			const statusTargets = new Map<number, StatusTarget[]>();
			const statusGroups = new Map<number, { groups: Array<{ start: number; end: number }>; loose: number[] }>();
			const statusCard: Component = {
				render(width: number) {
					// Beside the rail every header placement draws a chrome bar that shows
					// the permission mode with its icon, so the rail never repeats the raw
					// mode statuses; the session-and-statuses view stays for other hosts.
					const view = statusCardVisible()
						? renderShellStatusSections(withStats(footerModel()), theme, width, visualSettings, railHints, { collapsed: statusCollapsed, hovered: statusHover })
						: renderShellStatusSections(withStats({ ...footerModel(), integrations: undefined, permission: undefined }), theme, width, visualSettings, railHints, { session: true, collapsed: statusCollapsed, hovered: statusHover });
					statusTargets.set(width, view.targets);
					statusGroups.set(width, { groups: view.groups, loose: view.loose });
					return view.lines;
				},
				invalidate() {
					statusHover = undefined;
				},
			};
			// The Stats section (on in Power user); walked once per session leaf, like sessionStats.
			let statsMemo: { key: SessionStatsKey | undefined; stats: SessionStats } | undefined;
			const currentStats = (): SessionStats => {
				const key = sessionStatsKey(ctx);
				if (key && statsMemo?.key && statsMemo.key.every((value, index) => value === key[index])) return statsMemo.stats;
				const stats = collectSessionStats(ctx.sessionManager.getEntries());
				statsMemo = { key, stats };
				return stats;
			};
			const statsOn = () => visualSettings.visibility.stats;
			// Subagent spend comes from the Agents section, which owns the task records.
			const subagentSpend = () => sidebarState(tui).parts.get("agents")?.spend?.();
			const withStats = (model: ShellBarModel): ShellBarModel => (statsOn() ? { ...model, stats: { ...currentStats(), subagents: subagentSpend() } } : model);
			const targetAt = (y: number, width: number) => statusTargets.get(width)?.find((target) => target.row === y);
			const statusRegion = new NativePointerRegion(statusCard, {
				onHover(event) {
					const target = targetAt(event.y, event.width);
					const next = !target ? undefined : target.kind === "toggle" ? target.section : "open-changes";
					if (next) setSidebarHover(tui, statusRegion, () => statusRegion.clearHover());
					else setSidebarHover(tui);
					if (next === statusHover) return { handled: true };
					statusHover = next;
					return { handled: true, render: true };
				},
				onLeave() {
					releaseSidebarHover(tui, statusRegion);
					if (!statusHover) return;
					statusHover = undefined;
					tui.requestRender();
				},
				onClick(event) {
					const target = event.button === "left" ? targetAt(event.y, event.width) : undefined;
					if (!target) return undefined;
					if (target.kind === "open-changes") void openChanges(ctx);
					else if (statusCollapsed.has(target.section)) statusCollapsed.delete(target.section);
					else statusCollapsed.add(target.section);
					invalidateSidebar(tui);
					return { handled: true, render: true };
				},
			});
			const part = sidebarPart(tui, "footer", bottomBar, {
				surface: "panel",
				digest: () => {
					const stats = statsOn() ? currentStats() : undefined;
					const spend = stats ? subagentSpend() : undefined;
					return JSON.stringify([footerStatus.key(), [...statusCollapsed], statusHover ?? "", stats ? [stats.turns, stats.toolCalls, stats.cost, stats.spanMs, spend?.runs, spend?.tokens, spend?.cost] : ""]);
				},
				render: (width) => statusRegion.render(width),
				cardGroups: (width) => statusGroups.get(width),
				handleMouse: (event) => statusRegion.handleMouse(event),
				invalidate: () => statusRegion.invalidate(),
			});
			// The Jobs card: its own rail section, like Agents and Todos, fed by the
			// same running-job display snapshot the Status card used to print. The
			// rail is natively scrollable, so it lists every running job; there is
			// no above-editor copy — regular mode keeps the compact bar count.
			let jobsHovered = false;
			let jobsPainted = false;
			let jobsHeaderRow = 0;
			const jobsRailCard: Component = {
				render(width: number) {
					const jobs = runningJobs ?? [];
					if (jobs.length === 0) { jobsPainted = false; return []; }
					// The rail draws Jobs as a panel section: its header is row 0.
					const lines = renderJobsSection(jobs, theme, width, deps.now(), { collapsed: jobsCollapsed, hovered: jobsHovered });
					jobsPainted = lines.length > 0;
					jobsHeaderRow = 0;
					return lines;
				},
				invalidate() {
					jobsHovered = false;
				},
			};
			const jobsRegion = new NativePointerRegion(jobsRailCard, {
				onHover(event) {
					const next = event.y === jobsHeaderRow;
					if (next) setSidebarHover(tui, jobsRegion, () => jobsRegion.clearHover());
					else setSidebarHover(tui);
					if (next === jobsHovered) return { handled: true };
					jobsHovered = next;
					return { handled: true, render: true };
				},
				onLeave() {
					releaseSidebarHover(tui, jobsRegion);
					if (!jobsHovered) return;
					jobsHovered = false;
					tui.requestRender();
				},
				onClick(event) {
					if (event.button !== "left" || event.y !== jobsHeaderRow) return undefined;
					jobsCollapsed = !jobsCollapsed;
					invalidateSidebar(tui);
					tui.requestRender();
					return { handled: true, render: true };
				},
			});
			const jobsRail: Component & { digest(): string; dispose(): void; surface: "panel" } = {
				surface: "panel",
				digest: () => JSON.stringify([jobsCollapsed, jobsHovered, runningJobs, Math.floor(deps.now() / 1000)]),
				render: (width) => jobsRegion.render(width),
				handleMouse: (event) => jobsRegion.handleMouse(event),
				invalidate() {
					jobsRegion.invalidate();
				},
				dispose() {
					jobsRegion.dispose();
				},
			};
			const jobsPart = sidebarPart(tui, "jobs", { render: () => [], invalidate() {}, dispose() {} }, jobsRail);
			// Elapsed time moves while a job runs, and a finished tail must clear
			// itself once its TTL expires with nothing running behind it; one frame
			// a second is enough, and the digest's second bucket revalidates the
			// cached section.
			const jobsTimer = setInterval(() => {
				const now = deps.now();
				const fresh = (runningJobs ?? []).some((job) => job.status === undefined || now - (job.endedAt ?? 0) < JOBS_FINISHED_TTL_MS);
				if (jobsPainted || fresh) tui.requestRender();
			}, 1_000);
			jobsTimer.unref?.();
			// The header row carries everything that ticks every frame (model,
			// effort, context, cost, usage) plus session identity and the jobs count
			// when Status is absent. Opaque statuses and working state stay excluded.
			const headerBar = (width: number) => renderShellHeaderChrome(buildShellHeaderModel(footerModel(), !statusCardVisible() && (statusOwner() === STATUS_OWNER.HEADER || visualSettings.statusPlacement === "hidden")), theme, width, usageShortcutKey, visualSettings, gaugePaint(ctx));
			// With the rail shown and a split header, the chrome splits like an
			// IDE: a title row with the project identity above, and a status bar
			// with the per-frame counters below (design/shell-rework/02-proposal.html).
			// A top header instead keeps the whole header row above the conversation.
			const ideChrome = () => statusCardVisible() && visualSettings.headerPlacement === "split";
			// The split title row and status bar also stay with Status hidden.
			const splitChrome = () => ideChrome() || (barChrome() && visualSettings.headerPlacement === "split");
			// Beside the rail the below-input bar is the full-width bottom row, like
			// split's status bar; the widget under the input steps aside while the
			// rail is actually drawn.
			const belowRail = () => fullscreen() && visualSettings.headerPlacement === "below-input" && statusCardVisible();
			// Beside the rail, the top and below-input headers draw the split status
			// bar's design (a chrome bar) with a margin row toward the content.
			// They apply beside the rail and with Status hidden (no rail at all); the
			// mobile chrome keeps phones and the minimal edition.
			const fullscreen = () => (tui as TUI & { mode?: string }).mode === "fullscreen";
			const barChrome = () => chromeBarsShown(tui);
			// Status at the bottom of a wide terminal: the chrome bars close the screen, and the
			// previous compact bottom bar steps aside ([ Panel ] opens the Status sections).
			const bottomStatus = () => barChrome() && visualSettings.statusPlacement === "bottom";
			const topChrome = () => barChrome() && visualSettings.headerPlacement === "top";
			// The below-input widget renders after the layout pass, so it can also
			// require the rail to be actually drawn (a rail that does not fit groups
			// Changes into the float footer as before).
			const belowChrome = () => barChrome() && visualSettings.headerPlacement === "below-input" && (visualSettings.statusPlacement === "hidden" || visualSettings.statusPlacement === "bottom" || sidebarState(tui).active === true);
			// Without the rail the bar also counts the running jobs, as the mobile status bar does.
			const chromeBar = (width: number) => renderShellChromeBar(footerModel(), theme, width, usageShortcutKey, visualSettings, gaugePaint(ctx), { jobs: !statusCardVisible() });
			const topHeader = (width: number) => chromeBar(width);
			// Comfortable centers the split title row between two margin rows.
			const titleRows = (width: number) => visualSettings.density === "comfortable"
				? [renderShellChromePad(theme, width), renderShellTitleRow(footerModel(), theme, width), renderShellChromePad(theme, width)]
				: [renderShellTitleRow(footerModel(), theme, width)];
			// Mobile keeps the same work row and editor for all placements. Only split
			// moves model identity to the title; top and below-input use one shared bar.
			const narrowChrome = () => chromeMode(tui) === "narrow";
			const narrowSplit = () => narrowChrome() && visualSettings.headerPlacement === "split";
			const narrowTop = () => narrowChrome() && visualSettings.headerPlacement === "top";
			const narrowBelow = () => narrowChrome() && visualSettings.headerPlacement === "below-input";
			if (tui.terminal) {
				sidebarState(tui).compactWork = narrowChrome;
				// The IDE chromes and the chrome bars show the permission mode with its icon.
				sidebarState(tui).statusBarShowsMode = () => chromeMode(tui) !== undefined || topChrome() || belowChrome() || splitChrome();
			}
			const statusBarChrome = (width: number) => narrowSplit()
				? renderShellStatusBar(footerModel(), theme, width, usageShortcutKey, { ...visualSettings, visibility: { ...visualSettings.visibility, modelDetails: false } }, gaugePaint(ctx), { jobs: true })
				: chromeBar(width);
			const disposeHeader = sidebarHeader(tui, {
				digest: () => footerStatus.key(),
				render: (width) => splitChrome() ? titleRows(width) : narrowSplit() ? [renderShellTitleRow(footerModel(), theme, width, { model: true })] : (narrowTop() || topChrome()) ? topHeader(width).rows : headerBar(width).rows,
				invalidate() {},
				handleMouse(event) {
					if (splitChrome() || narrowSplit() || narrowBelow() || event.type !== "click" || event.button !== "left") return undefined;
					if (!shellHeaderUsageHit(narrowTop() || topChrome() ? topHeader(event.width) : headerBar(event.width), event.x, event.y)) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			});
			const disposeStatusBar = sidebarStatusBar(tui, {
				digest: () => footerStatus.key(),
				render: (width) => splitChrome() || narrowSplit() || narrowBelow() ? statusBarChrome(width).rows : belowRail() ? chromeBar(width).rows : [],
				invalidate() {},
				handleMouse(event) {
					if (!(splitChrome() || narrowSplit() || narrowBelow() || belowRail()) || event.type !== "click" || event.button !== "left") return undefined;
					if (!shellHeaderUsageHit(belowRail() ? chromeBar(event.width) : statusBarChrome(event.width), event.x, event.y)) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			});
			const uninstall = installSidebar(tui, theme, () => visualSettings.statusPlacement, () => visualSettings.headerPlacement, () => visualSettings.density, () => tabsSettings.policy === "on" ? [...(tabsSettings.main === "on" ? [{ id: "main", label: "MAIN" }] : []), ...(hasGitRoot && tabsSettings.git === "on" && (tabsSettings.gitHistory === "on" || tabsSettings.diff === "on") ? [{ id: "git", label: "GIT", rail: gitCards }] : [])] : [], id => {
				const active = id === "git";
				if (active === gitActive) return;
				gitActive = active;
				if (!active) { generation++; gitCardsState.leave(); return; }
				const version = ++generation;
				// Re-entry runs discovery once to reconcile metadata and keeps a
				// surviving selection; only a removed selection falls back to the
				// surviving root before the cards are shown.
				const reentry = roots?.state === "ready";
				void discoverSidebarGitRoots(guardedGit(ctx.cwd, version)).then(result => {
					if (!valid(version)) return;
					if (result.state === "ready") {
						if (selectedRoot !== result.main && selectedRoot !== result.wt) selectedRoot = result.wt;
						if (!reentry) selectedRoot = result.wt;
						roots = result;
					} else if (!reentry) roots = result;
					// A failed re-entry discovery must not leave the cards dormant:
					// resume the cached root with the data already captured (CodeRabbit
					// finding) — the next turn's discovery reconciles the metadata.
					// The host selection follows the resumed root, or a click on the
					// selector's other root would be swallowed by the click guard
					// (CodeRabbit follow-up).
					if (!reentry || result.state === "ready" || !gitCardsState.paintedRoot) gitCardsState.enter(selectedRoot);
					else { selectedRoot = gitCardsState.paintedRoot; gitCardsState.enter(selectedRoot); }
					invalidateSidebar(tui); tui.requestRender();
				});
			}, (id, height) => {
				if (id !== "git" || height === historyViewport) return;
				historyViewport = Math.max(1, height);
				historyOffset = Math.min(historyOffset, maxHistoryOffset());
				queueMicrotask(() => tui.requestRender());
			});
			// A light theme paints the whole fullscreen frame (prose, gaps, the
			// column beside the rail) instead of leaving the terminal's dark cells.
			const unpaintPage = installPagePaint(tui as never, () => ((tui as TUI & { mode?: string }).mode === "fullscreen" ? ctx.ui.theme as PageTheme : {}));
			// The public widget slot follows the editor even when the rail is absent.
			const belowHeader = () => visualSettings.headerPlacement === "below-input" && (tui as TUI & { mode?: string }).mode === "fullscreen" && statusOwner() !== STATUS_OWNER.BOTTOM;
			const widgetChrome = (width: number) => belowFloat(width, false) ?? headerBar(width);
			let disposed = false;
			ctx.ui.setWidget(HEADER_WIDGET_KEY, () => ({
				render(width: number) {
					if (disposed || narrowChrome()) return [];
					if (belowRail() && sidebarState(tui).active) return [];
					if (belowChrome()) return chromeBar(width).rows;
					if (belowFloat(width, false)) return footerSuppressed() ? widgetChrome(width).rows : [];
					return belowHeader() ? headerBar(width).rows : [];
				},
				invalidate() {},
				handleMouse(event) {
					if (disposed || narrowChrome()) return undefined;
					if (belowRail() && sidebarState(tui).active) return undefined;
					if (belowChrome()) {
						if (event.type !== "click" || event.button !== "left" || !shellHeaderUsageHit(chromeBar(event.width), event.x, event.y)) return undefined;
						void openUsage(ctx);
						return { handled: true, render: true };
					}
					const grouped = belowFloat(event.width, false);
					if ((grouped ? !footerSuppressed() : !belowHeader()) || event.type !== "click" || event.button !== "left") return undefined;
					if (!shellHeaderUsageHit(widgetChrome(event.width), event.x, event.y)) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			}), { placement: "belowEditor" });
			// Pi still owns the footer component; shutdown releases its session-bound
			// hooks before the old context becomes invalid, even if Pi disposes later.
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				aliveGit = false; gitActive = false; generation++; gitCardsState.dispose();
				if (disposeFooter === dispose) disposeFooter = undefined;
				clearInterval(jobsTimer);
				jobsPart.dispose();
				ctx.ui.setWidget(HEADER_WIDGET_KEY, undefined);
				disposeHeader();
				disposeStatusBar();
				statusRegion.dispose();
				uninstall();
				if (refreshSidebarHistory === refreshHistoryCards) refreshSidebarHistory = undefined;
				if (refreshSidebarDiff === refreshDiffCards) { refreshSidebarDiff = undefined; toggleSidebarDiff = undefined; toggleSidebarHistory = undefined; }
				unpaintPage();
				part.dispose();
				if (sidebarTui === tui) { sidebarTui = undefined; renderHost = undefined; groupedChangesOwner = () => false; }
			};
			disposeFooter = dispose;
			return { ...part,
				render(width: number) {
					if (disposed) return [];
					// Running-only: a finished tail must never paint a ⧗ 0 jobs row.
					const compactRunningJobs = runningJobs?.filter((job) => job.status === undefined);
					if (visualSettings.statusPlacement === "hidden" && (tui as TUI & { mode?: string }).mode !== "fullscreen" && compactRunningJobs?.length) {
						return [truncateToWidth(theme.fg("muted", shellJobsCount(compactRunningJobs.length)), width, "…")];
					}
					const rows = part.render(width);
					// Preserve a shrinkable exterior dock row, outside prompt/completion geometry,
					// only while the float prompt ends the dock. A titled-rule editor (top, split,
					// mobile) keeps its own bottom row as the margin, and a below-input header follows it.
					// A split status bar follows the prompt too, so it never needs the exterior row.
					const promptEndsDock = !(chromeMode(tui) !== undefined || chromeBarsShown(tui, true) || belowHeader());
					return rows.length === 0 && (tui as TUI & { mode?: string }).mode === "fullscreen" && promptEndsDock
						&& resolvePromptLayout(width, cardStyle(), theme.bg?.bind(theme)).background ? [""] : rows;
				},
				handleMouse(event: Parameters<NonNullable<SidebarRail["handleMouse"]>>[0]) {
					return disposed ? undefined : part.handleMouse?.(event);
				},
				dispose };
		});
		void refreshUsage(ctx, true);
		const ownsPrompt = installPrompt(
			ctx,
			(created) => {
				prompt?.dispose();
				prompt = created;
				prompt.setAnimationPolicy(animationPolicy);
				prompt.setVimPolicy(vimPolicy);
			},
			{ now: () => deps.now(), doubleEscCancelEnabled: () => doubleEscCancelPolicy === "on", dispatchQueuedText: (text) => { pendingQueuedText = pendingQueuedText === undefined ? text : `${pendingQueuedText}\n\n${text}`; }, vimRuntimeVersion: deps.vimRuntimeVersion, attachments: imageAttachments, readClipboardImage: () => (deps.readClipboardImage ?? readClipboardImage)(),
				// The editor joins the wide IDE chrome while the rail owns the host with the header on top.
				panelChrome: (tui) => chromeMode(tui) !== undefined || chromeBarsShown(tui, true),
				// Without the rail, [ Panel ] opens the Status sections: the mobile chrome,
				// and a wide terminal with Status at the bottom.
				panelButton: (tui) => chromeMode(tui) === "narrow" || (visualSettings.statusPlacement === "bottom" && chromeBarsShown(tui, true)),
				topRows: (tui, width, hovered) => panelTopRows(tui, width, ctx.ui.theme, hovered),
				// The mobile work row is the first top row; a tap on it opens the leading section's view.
				onTopRowClick: (tui, index) => { if (chromeMode(tui) === "narrow" && index === 0) openWorkRow(tui, ctx); },
				onPanelClick: () => { void openPanelSheet(ctx); } },
		);
		imageAttachments.clear();
		ctx.ui.setWidget(IMAGE_ATTACHMENTS_WIDGET_KEY, ownsPrompt
			// Kitty re-sends a full image block whenever content above it moves, so
			// thumbnails show only while idle; while the agent streams, labels only.
			? (_tui, theme) => imageAttachmentsWidget(imageAttachments, () => prompt?.getText() ?? "", theme, () => modelAcceptsImages(ctx.model),
				() => getCapabilities().images !== null && ctx.isIdle())
			: undefined);
		// Hide native feedback only when our petal replaces it. Native transcript
		// thinking blocks remain Pi-owned; this changes only the supported loader UI.
		// Inside Herdr the row stays: its native Pi detection reads it.
		if (ownsPrompt && !keepNativeWorkingRow(env)) ctx.ui.setWorkingVisible(false);
		const notice = deps.devBinary();
		ctx.ui.setWidget(
			DEV_BINARY_WIDGET_KEY,
			notice
				? (_tui, theme) => spaced(cardComponent(devBinaryCard(notice), theme, { expanded: true, previewRows: 3 }))
				: undefined,
		);
		if (changes !== tracker) return;
		shown = "";
		applyChanges(ctx, tracker.model);
	});
	// Chips still in the submitted draft travel as real image attachments, so
	// the model sees the image without calling `read` on a temp-file path.
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || imageAttachments.size === 0) return { action: "continue" };
		// The editor may already hold the next draft (a prompt Pi queued during
		// compaction): its chips stay registered for their own submit.
		const submitted = imageAttachments.submit(event.text, modelAcceptsImages(ctx.model), prompt?.getText() ?? "");
		if (!submitted) return { action: "continue" };
		if (submitted.omitted > 0 && ctx.hasUI) {
			const count = submitted.omitted === 1 ? "1 pasted image was" : `${submitted.omitted} pasted images were`;
			ctx.ui.notify(`${count} not sent: the current model does not accept images. Switch to a vision model and paste again.`, "warning");
		}
		return { action: "transform", text: submitted.text, images: [...(event.images ?? []), ...submitted.images] };
	});
	pi.on("session_shutdown", (_event, ctx) => {
		customizeGeneration++;
		disposeFooter?.();
		imageAttachments.dispose();
		imageAttachments.setCache(undefined);
		closeCustomize?.();
		if (review) {
			review = undefined;
			redrawReview();
		}
		// Pi rebuilds the extension runtime after every shutdown (reload, replacement,
		// fork, quit), so the factory-level subscription never needs to be restored.
		unsubscribeReview();
		unsubscribeJobs();
		runningJobs = undefined;
		stopProfilePoll();
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		oddPhaseRegistry.clearRenderRequest(ctx.sessionManager.getSessionId());
		pendingQueuedText = undefined;
		imageAttachments.clear();
		ctx.ui.setWidget(IMAGE_ATTACHMENTS_WIDGET_KEY, undefined);
		prompt?.dispose();
		prompt = undefined;
		if ((ctx.ui.getEditorComponent() as PromptFactory | undefined)?.[PROMPT_OWNER]) {
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setWorkingVisible(true);
		}
		registry?.close();
		registry = undefined;
		changes = undefined;
		currentContext = undefined;
	});
	const openChanges = async (ctx: ExtensionContext) => {
		if (!changes) return;
		const tracker = changes;
		const model = await tracker.refresh();
		if (changes !== tracker) return;
		applyChanges(ctx, model);
		// A failed root scan is unknown, never clean: say so whenever one failed.
		const failed = tracker.failedRoots.length;
		const unborn = tracker.unbornRoots.length;
		const roots = tracker.scannedRootCount;
		if (model.files.length === 0) {
			if (failed > 0 && failed === roots) ctx.ui.notify(`Could not read Git status for ${failed} ${failed === 1 ? "root" : "roots"}; uncommitted changes are unknown.`, "error");
			else if (failed > 0) ctx.ui.notify(`No uncommitted changes in the roots Git could read; Git status failed for ${failed} of ${roots} roots.`, "warning");
			else if (unborn > 0) ctx.ui.notify(unborn === roots
				? `No commits yet in ${unborn === 1 ? "this session's repository" : "any root"} — make a commit to start tracking changes.`
				: `No uncommitted changes; ${unborn} of ${roots} roots have no commits yet, so they are not tracked.`, "info");
			else ctx.ui.notify("No uncommitted changes in this session's repository or its subagents' worktrees.", "info");
			return;
		}
		if (failed > 0) ctx.ui.notify(`Git status failed for ${failed} ${failed === 1 ? "root" : "roots"}; ${failed === 1 ? "its" : "their"} changes are not listed.`, "warning");
		await showChangesOverlay(ctx, { loadDiff: (root, file) => loadFileDiff(deps.gitRunner(root, DIFF_MAX_BYTES), file), worktrees: () => tracker.worktrees, refresh: () => tracker.refresh(), apply: applyChanges, pollMs: changesPollMs(env) });
	};
	pi.registerCommand(IMAGES_COMMAND_NAME, {
		description: "List the on-disk paths of images pasted in this draft (needs GENTLE_PI_IMAGES_DISK_CACHE=session).",
		handler: async (_args, ctx) => {
			if (imagesDiskCachePolicy !== "session") {
				ctx.ui.notify("Image disk cache is off. Set GENTLE_PI_IMAGES_DISK_CACHE=session to enable it.", "info");
				return;
			}
			const cached = imageAttachments.cachedPaths(prompt?.getText() ?? "");
			if (cached.length === 0) {
				ctx.ui.notify("No pasted images are cached in this draft.", "info");
				return;
			}
			for (const entry of cached) ctx.ui.notify(`${entry.token} ${entry.path}`, "info");
		},
	});
	pi.registerCommand(CHANGES_COMMAND_NAME, {
		description: "Browse uncommitted Git changes (working tree vs HEAD, untracked included) in this session's repository and its subagents' worktrees. Press o to open $EDITOR.",
		handler: async (_args, ctx) => openChanges(ctx),
	});
	const shortcut = changesShortcut(env, keymaps.bindings);
	if (shortcut) {
		pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Open the session's uncommitted Git changes",
			handler: async (ctx) => openChanges(ctx),
		});
	}
	pi.registerCommand(COMMANDS_COMMAND_NAME, {
		description: "Open the command palette: a curated, grouped menu of Gentle commands.",
		handler: async (_args, ctx) => showCommandPalette(pi, ctx, env, keymaps.bindings),
	});
	const commandsShortcut = commandsKey(env, keymaps.bindings);
	if (commandsShortcut) {
		pi.registerShortcut(commandsShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Open the command palette",
			handler: async (ctx) => showCommandPalette(pi, ctx, env, keymaps.bindings),
		});
	}
	// A palette command the user gave a key runs exactly as if typed.
	for (const id of commandKeymapIds(keymaps.bindings)) {
		const key = effectiveKey(id, env, keymaps.bindings);
		const command = keymapCommand(id);
		if (!key || !command) continue;
		pi.registerShortcut(key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: `Run /${command}`,
			handler: async (ctx) => {
				if (!pi.getCommands().some((registered) => registered.name === command)) {
					ctx.ui.notify(`${key} runs /${command}, which is not available in this session.`, "warning");
					return;
				}
				pi.sendUserMessage(`/${command}`, { expandPromptTemplates: true });
			},
		});
	}
	const jobsKey = jobsCollapseKey(env, keymaps.bindings);
	if (jobsKey) {
		pi.registerShortcut(jobsKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Collapse or expand the jobs card",
			handler: async () => {
				jobsCollapsed = !jobsCollapsed;
				if (sidebarTui) invalidateSidebar(sidebarTui);
				renderHost?.requestRender();
			},
		});
	}
	const presetKey = presetShortcut(env, keymaps.bindings);
	if (presetKey) {
		pi.registerShortcut(presetKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Cycle the visual preset: Light, Neutral, Power user",
			handler: async (ctx) => {
				const current = resolveVisualSettings(animationOptions);
				if (current.malformed || current.readError) {
					ctx.ui.notify(`Cannot switch presets: unreadable or malformed visual settings (${current.globalFile}).`, "error");
					return;
				}
				const next = nextVisualPreset(visualPresetOf(current.settings));
				writeVisualSettings(applyVisualPreset(current.settings, next), animationOptions);
				refreshVisual();
				pi.events.emit(VISUAL_SETTINGS_CHANGED, { configHome: doubleEscCancelConfigHome });
				ctx.ui.notify(`Preset: ${PRESET_LABEL[next]}`, "info");
			},
		});
	}
	pi.registerCommand("gentle:customize", {
		description: "Configure appearance, task summary publishing, audio notifications, Vim editing, RDD, session permissions and global Auto/YOLO defaults, and prompt history capture.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				if (ctx.hasUI) ctx.ui.notify("Customization requires an interactive terminal.", "warning");
				return;
			}
			closeCustomize?.();
			const generation = ++customizeGeneration;
			// The owner also checks its lifecycle; this binds this particular card
			// to its caller before discovery and again before handing off the UI.
			const currentRddSession = (() => {
				try {
					const manager = ctx.sessionManager, id = manager.getSessionId(), cwd = ctx.cwd, ui = ctx.ui;
					if (env.GENTLE_PI_AGENTS_CHILD === "1" || !id || !cwd || (manager.getCwd?.() ?? cwd) !== cwd) return () => false;
					return () => {
						try { return customizeGeneration === generation && ctx.mode === "tui" && ctx.hasUI && ctx.ui === ui && ctx.cwd === cwd && ctx.sessionManager === manager && manager.getSessionId() === id && (manager.getCwd?.() ?? cwd) === cwd; }
						catch { return false; }
					};
				} catch { return () => false; }
			})();
			let closed = false;
			let adapter: YoloUiAdapter | undefined;
			let unobserve: (() => void) | undefined;
			let finish: (() => void) | undefined;
			let customizeView: VisualCustomizeView | undefined;
			const close = () => {
				if (closed) return;
				closed = true;
				customizeView?.dispose();
				unobserve?.(); adapter?.dispose(); finish?.();
				if (closeCustomize === close) closeCustomize = undefined;
			};
			closeCustomize = close;
			const home = { gentlePiConfigHome: doubleEscCancelConfigHome };
			const rows: CustomizeRow[] = [];
			const bannerHome = doubleEscCancelConfigHome;
			let banner = await readBannerConfig(bannerHome).catch(error => { close(); throw error; });
			if (closed) return;
			let activeTheme = ctx.ui.theme.name;
			let requestCustomizeRender: (() => void) | undefined;
			let category: CustomizeCategory = "Animations";
			const add = (label: CustomizeRow["label"], notice: string, action: () => void | false | Promise<void | false>, preview?: CustomizeRow["preview"], choice?: CustomizeRow["choice"]) => rows.push({ category, label, preview, choice, action: async () => {
				if (await action() === false) return;
				ctx.ui.notify(notice, "info");
			} });
			const explicitChoice = (setting: string, value: string, current: () => boolean): CustomizeRow["choice"] => ({ setting, value, current, applyOnMove: false });
			for (const policy of ["quality", "performance", "potato"] as const) add(
				() => `Animations: ${policy}${resolveAnimationPolicy(animationOptions).policy === policy ? " (current)" : ""}`,
				"Animation saved. Prompt applies now; startup banner applies at next startup.",
				() => {
					writeAnimationPolicy(policy, animationOptions);
					animationPolicy = resolveAnimationPolicy(animationOptions).policy;
					prompt?.setAnimationPolicy(animationPolicy);
				},
				() => ({ title: `${policy} · static animation sample`, sample: policy === "potato" ? "✿  idle → working (no pulse)" : policy === "performance" ? "✿  short pulse → settle (static)" : "✿  gentle wave → settle (static)" }),
				{ setting: "Animations", value: policy, current: () => resolveAnimationPolicy(animationOptions).policy === policy, hint: "Prompt and startup motion; potato turns it off" },
			);
			category = "Banner";
			const bannerColors = { pink: [255, 118, 195], cyan: [95, 210, 255], yellow: [255, 210, 95], green: [110, 220, 145] } as const;
			const bannerPreview = (next: typeof banner) => {
				const [r, g, b] = bannerColors[next.color];
				return { title: `Banner · ${next.color} (static)`, sample: `${next.showRose ? `\x1b[38;2;${r};${g};${b}m🌹\x1b[0m` : "·"}  ${next.showTextLogo ? "GENTLE SHELL" : "(logo hidden)"}` };
			};
			for (const [setting, key] of [["Banner rose", "showRose"], ["Banner text logo", "showTextLogo"]] as const) {
				for (const enabled of [true, false]) add(
					() => `${setting}: ${enabled ? "on" : "off"}${banner[key] === enabled ? " (current)" : ""}`,
					"Banner saved; applies at next startup.",
					async () => {
						const next = { ...await readBannerConfigForEdit(bannerHome), [key]: enabled };
						await writeBannerConfig(next, bannerHome);
						banner = next;
					},
					() => bannerPreview({ ...banner, [key]: enabled }),
					explicitChoice(setting, enabled ? "on" : "off", () => banner[key] === enabled),
				);
			}
			for (const color of BANNER_COLORS) add(
				() => `Banner color: ${color}${banner.color === color ? " (current)" : ""}`,
				"Banner saved; applies at next startup.",
				async () => { const next = { ...await readBannerConfigForEdit(bannerHome), color }; await writeBannerConfig(next, bannerHome); banner = next; },
				() => bannerPreview({ ...banner, color }),
				{ setting: "Banner color", value: color, current: () => banner.color === color, hint: "Startup banner color; applies at next startup" },
			);
			category = "Themes";
			try {
				if (typeof ctx.ui.getAllThemes !== "function" || typeof ctx.ui.getTheme !== "function" || typeof ctx.ui.setTheme !== "function") throw new Error("theme API unavailable");
				const themes = ctx.ui.getAllThemes();
				if (!Array.isArray(themes)) throw new Error("invalid theme list");
				const names = [...new Set(themes.map((item) => item?.name).filter((name): name is string => typeof name === "string" && !!name && !name.includes("/")))];
				if (names.length === 0) throw new Error("no installed themes");
				for (const name of names) rows.push({
					category,
					label: () => `Theme: ${name}${activeTheme === name ? " (current)" : ""}`,
					choice: explicitChoice("Theme", name, () => activeTheme === name),
					preview: () => {
						const selected = ctx.ui.getTheme(name);
						if (selected?.name !== name) throw new Error("Selected theme is unavailable.");
						const source = selected.sourcePath ?? ctx.ui.getAllThemes().find((item) => item.name === name)?.path;
						return sourcePalettePreview(name, source);
					},
					action: () => {
						if (!ctx.ui.getTheme(name)) throw new Error(`Theme ${name} is unavailable or invalid.`);
						const result = ctx.ui.setTheme(name);
						if (!result.success) throw new Error(result.error ?? `Could not activate theme ${name}.`);
						activeTheme = name;
						ctx.ui.notify("Theme applies now and is saved by Pi.", "info");
					},
				});
			} catch {
				rows.push({ category, label: "Themes unavailable; use Pi /settings", preview: () => ({ title: "Themes unavailable", sample: "Use Pi /settings to select a theme" }), action: () => ctx.ui.notify("Installed themes are unavailable in this session.", "warning") });
			}
			const updateVisual = (change: (settings: ReturnType<typeof resolveVisualSettings>["settings"]) => ReturnType<typeof resolveVisualSettings>["settings"]) => {
				const current = resolveVisualSettings(home);
				if (current.malformed || current.readError) throw new Error(`Cannot update unreadable or malformed visual settings: ${current.globalFile}`);
				writeVisualSettings(change(current.settings), home);
				refreshVisual();
				pi.events.emit(VISUAL_SETTINGS_CHANGED, { configHome: doubleEscCancelConfigHome });
			};
			const visual = () => resolveVisualSettings(home).settings;
			const pending = "Preference saved and applied.";
			const layoutPreview = (settings: ReturnType<typeof visual>) => ({
				title: `Layout · ${settings.density} (schematic)`,
				sample: layoutSchematic(settings),
			});
			const layoutChoice = (setting: string, value: string, current: () => boolean, hint: string): CustomizeRow["choice"] => ({ setting, value, current, hint });
			category = "Editor";
			for (const [label, policy] of [["enable", "on"], ["disable", "off"]] as const) rows.push({
				category,
				label: () => `Vim: ${label}${resolveVimPolicy(animationOptions).policy === policy ? " (current preference)" : ""}`,
				choice: explicitChoice("Vim", policy, () => resolveVimPolicy(animationOptions).policy === policy),
				preview: () => {
					const result = resolveVimPolicy(animationOptions);
					const effective = prompt?.effectiveVimPolicy ?? "no active prompt";
					return { title: "Vim · global prompt editing", sample: `preference: ${result.policy} · effective: ${effective}${result.malformed ? " · malformed or unreadable file" : result.policy !== effective && effective !== "no active prompt" ? " · preference and prompt differ" : ""}` };
				},
				action: () => {
					const current = resolveVimPolicy(animationOptions);
					if (current.malformed) throw new Error(`Cannot update malformed or unreadable Vim policy: ${current.globalFile}`);
					writeVimPolicy(policy, animationOptions);
					const result = resolveVimPolicy(animationOptions);
					vimPolicy = result.policy;
					prompt?.setVimPolicy(vimPolicy);
					reportVim(ctx, result);
				},
			});
			let rddControl: RddModeControl | undefined;
			let rddSnapshot: Awaited<ReturnType<RddModeControl["read"]>>;
			let rddLoading = true;
			let rddHandoff: RddModeControl | undefined;
			// Never block the rest of Customize on an unavailable or slow provider.
			// Rendering only consumes the snapshot, which is refreshed on each open.
			const refreshRdd = async () => {
				let control: RddModeControl | undefined;
				let snapshot: Awaited<ReturnType<RddModeControl["read"]>>;
				try {
					control = currentRddSession() ? await discoverRddModeControl(pi) : undefined;
					snapshot = !closed && currentRddSession() ? await control?.read() : undefined;
				} catch { /* An incompatible or failing bridge is unavailable. */ }
				if (closed) return;
				rddSnapshot = currentRddSession() && snapshot && (snapshot.effective === "on" || snapshot.effective === "off") && Object.values(NATIVE_REVIEW_MODE_SOURCE).includes(snapshot.source) ? snapshot : undefined;
				rddControl = rddSnapshot ? control : undefined;
				rddLoading = false;
				requestCustomizeRender?.();
			};
			rows.push({
				category,
				label: () => rddSnapshot ? `RDD: ${rddSnapshot.effective} (decided by ${rddSnapshot.source}) · checked on open` : `RDD: ${rddLoading ? "checking" : "unavailable"}`,
				preview: () => ({ title: "RDD selector", sample: "Enter for fresh status and repository or explicitly machine-wide choices; review consent unchanged." }),
				action: () => {
					if (closed || !currentRddSession()) return;
					if (!rddControl || !rddSnapshot) {
						ctx.ui.notify(rddLoading ? "RDD status is still being checked." : "RDD is unavailable in this live primary session.", "warning");
						return;
					}
					// The owner's native selector must not sit underneath our overlay.
					rddHandoff = rddControl;
					close();
				},
			});
			let yoloDisplay: YoloDisplay = YOLO_DISPLAY.unavailable;
			let permissionDisplay = "normal", permissionDefault = "normal";
			let requestYoloRender = () => {};
			let refreshing: Promise<void> | undefined;
			let refreshAgain = false;
			// One in-flight read and one dirty bit coalesce slash/action/revocation
			// changes. Labels and previews only read the authority-free snapshot.
			const refreshYolo = (): Promise<void> => {
				refreshAgain = true;
				if (refreshing) return refreshing;
				refreshing = (async () => {
					while (refreshAgain && !closed) {
						refreshAgain = false;
						const snapshot = await adapter?.readSnapshot?.().catch(() => undefined);
						const next = snapshot?.yolo ?? await adapter?.read().catch(() => YOLO_DISPLAY.unavailable) ?? YOLO_DISPLAY.unavailable;
						if (closed) return;
						const nextMode = snapshot?.mode ?? "normal";
						const nextDefault = snapshot?.defaultMode ?? "normal";
						if (closed) return;
						if (refreshAgain) continue;
						yoloDisplay = next;
						permissionDisplay = nextMode;
						permissionDefault = nextDefault;
						requestYoloRender();
					}
				})().finally(() => { refreshing = undefined; });
				return refreshing;
			};
			for (const value of [YOLO_DISPLAY.on, YOLO_DISPLAY.off]) rows.push({
				category,
				label: () => `YOLO: ${value} · session only`,
				choice: explicitChoice("YOLO", value, () => yoloDisplay === value),
				preview: () => ({ title: `YOLO: ${yoloDisplay} · session only`, sample: "ordinary scoped commits/push/PR · destructive confirmations remain · review consent unchanged · reset on reload" }),
				action: async () => {
					if (closed) return;
					if (!adapter || yoloDisplay === YOLO_DISPLAY.unavailable) {
						ctx.ui.notify("YOLO is unavailable in this live primary session.", "warning");
						return;
					}
					if (yoloDisplay !== value) await adapter.toggle();
					await refreshYolo();
				},
			});
			for (const mode of ["normal", "auto", "yolo", "super-yolo"] as const) rows.push({
				category,
				label: () => `Session permissions: ${mode.toUpperCase()}${mode === "auto" ? " (beta)" : ""}${permissionDisplay === mode ? " (current)" : ""}`,
				choice: explicitChoice("Session permissions", mode === "auto" ? "AUTO (beta)" : mode.toUpperCase(), () => permissionDisplay === mode),
				preview: () => ({ title: "Permissions · current session", sample: mode === "auto"
					? "independent session-model action checks · extra inference cost · hard safety and native consent remain"
					: mode === "yolo" ? "ordinary scoped delivery permission · destructive confirmations remain"
					: mode === "super-yolo" ? "no permission prompts · only private-path protection (.env, keys, secrets) remains"
					: "normal checks · overrides an elevated global default" }),
				action: async () => {
					if (closed) return;
					if (!adapter?.setMode || !await adapter.setMode(mode)) ctx.ui.notify("Session mode unchanged — live primary UI unavailable or changed.", "warning");
					await refreshYolo();
				},
			});
			for (const mode of ["normal", "auto", "yolo", "super-yolo"] as const) rows.push({
				category,
				label: () => `Default permissions: ${mode.toUpperCase()}${mode === "auto" ? " (beta)" : ""}${permissionDefault === mode ? " (saved)" : ""}`,
				choice: explicitChoice("Default permissions", mode === "auto" ? "AUTO (beta)" : mode.toUpperCase(), () => permissionDefault === mode),
				preview: () => ({ title: "Permissions · user-global default", sample: `New primary sessions start in ${mode.toUpperCase()}; current session stays unchanged. ${mode === "auto" ? "Additional classifier inference uses the session model; usage is separate." : "Independent safety and consent remain."}` }),
				action: async () => {
					if (closed) return;
					if (!adapter?.saveDefault || !await adapter.saveDefault(mode)) ctx.ui.notify("Default unchanged — trusted UI unavailable or preference could not be saved.", "warning");
					await refreshYolo();
				},
			});
			category = "History";
			// The prompt-history extension re-reads this preference per prompt, so a
			// change applies without restart. An explicit GENTLE_PI_HISTORY_CAPTURE
			// value wins; the rows say so instead of silently ignoring the choice.
			const historyCapture = () => resolveHistoryCapture({ env, gentlePiConfigHome: doubleEscCancelConfigHome });
			for (const [label, policy] of [["enable", "on"], ["disable", "off"]] as const) rows.push({
				category,
				label: () => {
					const result = historyCapture();
					return `Prompt history capture: ${label}${result.preference === policy && !result.malformed ? " (current)" : ""}${result.envOverride ? " · env override" : ""}`;
				},
				choice: explicitChoice("History capture", policy, () => { const result = historyCapture(); return result.preference === policy && !result.malformed; }),
				preview: () => {
					const result = historyCapture();
					const effective = result.enabled ? "on" : "off";
					return { title: "Prompt history capture · Customize preference", sample: `preference: ${result.preference} · effective: ${effective}${result.malformed ? " · malformed or unreadable file" : ""}${result.envOverride ? " · GENTLE_PI_HISTORY_CAPTURE overrides this preference" : ""}` };
				},
				action: () => {
					const current = historyCapture();
					if (current.malformed) throw new Error(`Cannot update malformed or unreadable history capture preference: ${current.globalFile}`);
					writeHistoryCapturePolicy(policy, { gentlePiConfigHome: doubleEscCancelConfigHome });
					const result = historyCapture();
					if (result.envOverride) ctx.ui.notify(`Prompt history capture preference saved: ${result.preference}. GENTLE_PI_HISTORY_CAPTURE=${result.envOverride} overrides it; capture stays ${result.envOverride}.`, "warning");
					else ctx.ui.notify(result.enabled ? "Prompt history capture: on. Applies from the next prompt; stored history is kept." : "Prompt history capture: off. New prompts are not recorded; stored history is kept.", "info");
				},
			});
			rows.push(...buildNotificationRows(ctx));
			category = "Layout";
			const taskSummary = () => resolveHerdrTaskSummarySettings(home);
			const taskSummaryCurrent = (enabled: boolean) => {
				const current = taskSummary();
				return !current.malformed && !current.readError && current.settings.enabled === enabled;
			};
			for (const enabled of [true, false]) add(
				() => `Task summary: ${enabled ? "on" : "off"}${taskSummaryCurrent(enabled) ? " (current)" : ""}`,
				`Task summary: ${enabled ? "on" : "off"}. Applies now to the active-task summary published to terminal tools (for example Herdr's sidebar).`,
				() => {
					const current = taskSummary();
					if (current.malformed || current.readError) throw new Error(`Cannot update malformed or unreadable task summary preference: ${current.globalFile}`);
					writeHerdrTaskSummarySettings({ ...current.settings, enabled }, home);
					pi.events.emit(HERDR_TASK_SUMMARY_CHANGED, { configHome: doubleEscCancelConfigHome });
				},
				undefined,
				{ ...explicitChoice("Task summary", enabled ? "on" : "off", () => taskSummaryCurrent(enabled)), hint: "Controls the task summary published to terminal tools" },
			);
			// Presets set the visibility switches and keep the placements, the density and the surface; any switch below still overrides them.
			for (const preset of Object.values(VISUAL_PRESET)) add(() => `Preset: ${PRESET_LABEL[preset]}${visualPresetOf(visual()) === preset ? " (current)" : ""}`, pending, () => updateVisual((settings) => applyVisualPreset(settings, preset)), () => layoutPreview(applyVisualPreset(visual(), preset)),
				layoutChoice("Preset", PRESET_LABEL[preset], () => visualPresetOf(visual()) === preset, "Light hides the rail, Power user adds Stats; alt+l cycles them"));
			for (const value of Object.values(STATUS_PLACEMENT)) add(() => `Status placement: ${value}${visual().statusPlacement === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, statusPlacement: value })), () => layoutPreview({ ...visual(), statusPlacement: value }),
				layoutChoice("Status", value, () => visual().statusPlacement === value, "Where Status lives; auto uses the rail from 140 columns"));
			for (const value of Object.values(HEADER_PLACEMENT)) add(() => `Header placement: ${value}${visual().headerPlacement === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, headerPlacement: value })), () => layoutPreview({ ...visual(), headerPlacement: value }),
				layoutChoice("Header", value, () => visual().headerPlacement === value, "The model, context and cost row: top above the conversation, below-input under the input, split into a title row and a bottom status bar"));
			for (const value of Object.values(DENSITY)) add(() => `Density: ${value}${visual().density === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, density: value })), () => layoutPreview({ ...visual(), density: value }),
				layoutChoice("Density", value, () => visual().density === value, "Spacing: comfortable adds gaps between rail sections and a padding row under a top header; compact removes them; minimal also drops the brand and the key hints"));
			for (const value of Object.values(CHROME_SURFACE)) add(() => `Surface: ${value}${visual().surface === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, surface: value })), () => layoutPreview({ ...visual(), surface: value }),
				layoutChoice("Surface", value, () => visual().surface === value, "Chrome background: transparent (default) lets the terminal background show through; tinted paints the rail, header rows and panel"));
			const saveTabs = (policy: "on" | "off", destination?: "main" | "git" | "gitHistory" | "diff") => {
				const current = resolveSidebarTabs(animationOptions);
				writeSidebarTabs(destination ? current.policy : policy, animationOptions, { main: destination === "main" ? policy : current.main, git: destination === "git" ? policy : current.git, gitHistory: destination === "gitHistory" ? policy : current.gitHistory, diff: destination === "diff" ? policy : current.diff });
				tabsSettings = resolveSidebarTabs(animationOptions);
				if (destination === "diff" && current.diff !== tabsSettings.diff) toggleSidebarDiff?.();
				if (destination === "gitHistory" && current.gitHistory !== tabsSettings.gitHistory) toggleSidebarHistory?.();
				if (sidebarTui) { invalidateSidebar(sidebarTui); sidebarTui.requestRender(); }
			};
			for (const [label, policy] of [["shown", "on"], ["hidden", "off"]] as const) add(
				() => `Tabs: ${label}`, pending, () => saveTabs(policy),
				() => { const result = resolveSidebarTabs(animationOptions); return { title: "Tabs · global", sample: result.malformed ? "Malformed or unreadable Tabs preference; not overwritten." : `Preference: ${result.policy}. Destinations appear only when real content is available.` }; },
				explicitChoice("Tabs", label, () => resolveSidebarTabs(animationOptions).policy === policy),
			);
			rows.push({ category, label: "Configure tabs", indent: 2, visible: () => { const result = resolveSidebarTabs(animationOptions); return !result.malformed && result.policy === "on"; }, action: () => {}, children: [
				...(["main", "git"] as const).flatMap(destination => (["on", "off"] as const).map(policy => ({ label: `${destination.toUpperCase()}: ${policy}`, choice: { setting: destination.toUpperCase(), value: policy, current: () => resolveSidebarTabs(animationOptions)[destination] === policy }, action: () => saveTabs(policy, destination) })).concat(destination === "git" ? (["gitHistory", "diff"] as const).map(key => ({ label: () => `[${resolveSidebarTabs(animationOptions)[key] === "on" ? "x" : " "}] ${key === "diff" ? "Diff" : "Git history"}`, indent: 2, visible: () => resolveSidebarTabs(animationOptions).git === "on", action: () => saveTabs(resolveSidebarTabs(animationOptions)[key] === "on" ? "off" : "on", key) })) as never[] : [])),
				...["MEMORY", "STATS"].map(name => ({ label: `${name} · coming soon`, inert: true, action: () => {} })),
			] });
			category = "Cards";
			// One live style for conversation cards, panels, header/footer and prompt.
			const cardStylePreview = { [CARD_STYLE.NEON]: "╭─ ✿ read ─╮  outlined chrome + prompt", [CARD_STYLE.FLOAT]: "▎ ✿ read  painted chrome + prompt" };
			for (const style of Object.values(CARD_STYLE)) add(
				() => {
					const current = resolveCardStyle(home);
					return `Card style: ${style}${current.style === style && !current.malformed ? " (current)" : ""}`;
				},
				`Card style: ${style}. Conversation cards and shell chrome redraw now.`,
				() => {
					writeCardStyle(style, home);
					setCardStyle(style);
					renderHost?.invalidateSidebar?.();
					renderHost?.requestRender();
					requestCustomizeRender?.();
				},
				() => ({ title: `Cards · ${style}`, sample: `${cardStylePreview[style]}${resolveCardStyle(home).malformed ? " · malformed or unreadable file" : ""}` }),
				{ setting: "Card style", value: style, current: () => { const current = resolveCardStyle(home); return current.style === style && !current.malformed; }, hint: "How conversation cards are drawn" },
			);
			// The content level picks between the quiet tools' result previews
			// (default) and command-only cards (minimal).
			const cardContentPreview = {
				[CARD_CONTENT.DEFAULT]: "≡ read a.ts · result previews + counts · bash rows keep pi's native card",
				[CARD_CONTENT.MINIMAL]: "≡ read a.ts · command only · ctrl+o expands · bash draws as a Gentle card",
			};
			for (const content of Object.values(CARD_CONTENT)) add(
				() => {
					const current = resolveCardContent(home);
					return `Card content: ${content}${current.content === content && !current.malformed ? " (current)" : ""}`;
				},
				`Card content: ${content}. Quiet tool cards redraw now; bash rows follow on new calls.`,
				() => {
					writeCardContent(content, home);
					setCardContent(content);
					renderHost?.requestRender();
					requestCustomizeRender?.();
				},
				() => ({ title: `Cards · content ${content}`, sample: `${cardContentPreview[content]}${resolveCardContent(home).malformed ? " · malformed or unreadable file" : ""}` }),
				{ setting: "Card content", value: content, current: () => { const current = resolveCardContent(home); return current.content === content && !current.malformed; }, hint: "Tool cards: result previews, or the command only" },
			);
			category = "Sections";
			for (const key of VISUAL_SECTION_KEYS) for (const shown of [true, false]) add(
				() => `Section ${key}: ${shown ? "shown" : "hidden"}`,
				pending,
				() => updateVisual((settings) => ({ ...settings, visibility: { ...settings.visibility, [key]: shown } })),
				() => {
					const visibility = { ...visual().visibility, [key]: shown };
					return { title: `Sections · ${key} ${shown ? "shown" : "hidden"}`, sample: `[${Object.entries(visibility).filter(([, value]) => value).map(([section]) => section).join("] [") || "no optional sections"}]` };
				},
				explicitChoice(key, shown ? "shown" : "hidden", () => visual().visibility[key] === shown),
			);
			let piKeybindings: PiKeybindings | undefined;
			let reloadRequested = false;
			rows.push(...buildKeymapRows({
				env,
				configHome: doubleEscCancelConfigHome,
				keybindings: () => piKeybindings,
				commands: paletteCommandsForKeymaps(pi),
				notify: (message, type) => ctx.ui.notify(message, type),
				// Pi reloads after this card closes, as the command's last step.
				reload: () => { reloadRequested = true; close(); },
			}));
			const catalog = () => listVisualProfiles(home).map(name => getVisualProfile(name, home)!);
			category = "Profiles";
			rows.push({ category, label: "Visual profiles (preview, save, apply, delete)", preview: () => {
				const saved = catalog()[0];
				return saved ? { title: `${saved.name} · saved profile`, sample: `${saved.visual.headerPlacement === "top" ? "[Header] → [Input]" : saved.visual.headerPlacement === "split" ? "[Title] → [Input] → [Status bar]" : "[Input] → [Header]"}  [${saved.visual.statusPlacement} status]` } : { title: "No saved profiles", sample: "Enter to save the current appearance" };
			}, action: () => {
				catalog();
				customizeView?.openProfiles();
				ctx.ui.notify("Profile preview opened; selections do not change preferences.", "info");
			} });
			category = "Reset";
			add("Reset visual, banner and animation defaults", "Defaults saved. Layout and prompt apply now; banner at next startup.", async (): Promise<void | false> => {
				// Validate the banner before touching any store. The writes below are
				// independent, not a transaction: report precisely what succeeded.
				await readBannerConfigForEdit(bannerHome);
				const changed: string[] = [];
				try {
					writeVisualSettings(structuredClone(DEFAULT_VISUAL_SETTINGS), home);
					refreshVisual();
					pi.events.emit(VISUAL_SETTINGS_CHANGED, { configHome: doubleEscCancelConfigHome });
					changed.push("visual");
					await writeBannerConfig({ ...DEFAULT_BANNER_CONFIG }, bannerHome);
					banner = { ...DEFAULT_BANNER_CONFIG };
					changed.push("banner");
					writeAnimationPolicy("quality", animationOptions);
					animationPolicy = resolveAnimationPolicy(animationOptions).policy;
					prompt?.setAnimationPolicy(animationPolicy);
					changed.push("animation");
				} catch (error) {
					const state = ["visual", "banner", "animation"].map((store) => `${store} ${changed.includes(store) ? "changed" : "unchanged"}`).join(", ");
					ctx.ui.notify(`Partial reset: ${state}. ${error instanceof Error ? error.message : String(error)}`, "warning");
					return false;
				}
		}, () => ({ title: "Restore visual defaults", sample: "[Header] → [Input]  [responsive status] · quality" }));
			const profiles: ProfileActions = {
				list: catalog,
				save: async (name, replace) => {
					const visual = resolveVisualSettings(home);
					if (visual.malformed || visual.readError) throw new Error("Visual settings unavailable for snapshot.");
					const currentBanner = await readBannerConfigForEdit(bannerHome);
					const currentAnimation = resolveAnimationPolicy(animationOptions);
					if (currentAnimation.malformed) throw new Error(`Cannot read animation policy: ${currentAnimation.globalFile}`);
					const themeName = ctx.ui.theme.name;
					if (!themeName || !ctx.ui.getAllThemes?.().some((item) => item.name === themeName) || !ctx.ui.getTheme?.(themeName)) throw new Error("Active theme is not installed or valid; profile not saved.");
					saveVisualProfile(name, { themeName, animationPolicy: currentAnimation.policy, banner: currentBanner, visual: visual.settings }, { ...home, replace });
					ctx.ui.notify(`Visual profile ${name} saved.`, "info");
				},
				apply: async (name) => {
					const profile = getVisualProfile(name, home);
					if (!profile) throw new Error(`Visual profile ${name} not found.`);
					const changed: string[] = [];
					const failures: string[] = [];
					const step = async (label: string, action: () => void | Promise<void>) => {
						try { await action(); changed.push(label); } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
					};
					await step("theme", () => {
						if (!ctx.ui.getTheme?.(profile.themeName)) throw new Error("Installed theme unavailable.");
						const result = ctx.ui.setTheme(profile.themeName);
						if (!result.success) throw new Error(result.error ?? "Theme activation failed.");
						activeTheme = profile.themeName;
					});
					await step("visual", () => {
						const current = resolveVisualSettings(home);
						if (current.malformed || current.readError) throw new Error("Visual settings unreadable.");
						writeVisualSettings(profile.visual, home);
						refreshVisual();
						pi.events.emit(VISUAL_SETTINGS_CHANGED, { configHome: doubleEscCancelConfigHome });
					});
					await step("banner", async () => { await readBannerConfigForEdit(bannerHome); await writeBannerConfig(profile.banner, bannerHome); banner = profile.banner; });
					await step("animation", () => { writeAnimationPolicy(profile.animationPolicy, animationOptions); animationPolicy = profile.animationPolicy; prompt?.setAnimationPolicy(animationPolicy); });
					ctx.ui.notify(failures.length ? `PARTIAL profile apply: ${changed.join(", ") || "none"} changed; ${failures.join("; ")}` : `Visual profile ${name} applied; banner applies at next startup.`, failures.length ? "warning" : "info");
				},
				delete: (name) => { deleteVisualProfile(name, home); ctx.ui.notify(`Visual profile ${name} deleted.`, "info"); },
				reset: () => { resetVisualProfiles(home); ctx.ui.notify("Visual profile catalog cleared; active settings unchanged.", "info"); },
			};
			try {
				adapter = await discoverYoloUiAdapter(pi, ctx);
				if (closed) { adapter?.dispose(); return; }
				unobserve = adapter?.observe(() => { void refreshYolo(); });
				await refreshYolo();
				if (closed) return;
				await ctx.ui.custom<null>((tui, theme, keys, done) => {
					if (typeof (keys as Partial<PiKeybindings> | undefined)?.getKeys === "function") piKeybindings = keys as PiKeybindings;
					finish = () => done(null);
					if (closed) done(null);
					requestYoloRender = () => { if (!closed) tui.requestRender(); };
					requestCustomizeRender = requestYoloRender;
					customizeView = new VisualCustomizeView({ rows, profiles, theme, requestRender: requestYoloRender, rowsAvailable: () => Math.max(0, Math.floor(tui.terminal.rows * 0.85) - 2), onError: (error) => { if (!closed) ctx.ui.notify(`${customizeView?.title() ?? "Customization"}: ${error.message}`, "error"); }, onClose: close });
					const view = customizeView;
					void refreshRdd();
					// Own interaction lifetime here, leaving the shared view unchanged.
					return {
						render: (width) => closed ? [] : view.render(width),
						handleInput: (data) => { if (!closed) view.handleInput(data); },
						handleMouse: (event) => closed ? undefined : view.handleMouse(event),
						focus: (label: string) => !closed && view.focus(label),
						invalidate: () => { if (!closed) view.invalidate(); },
						dispose: close,
					};
				}, { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } });
			} finally { close(); }
			if (rddHandoff && currentRddSession()) await rddHandoff.open();
			if (reloadRequested) await ctx.reload();
		},
	});
	pi.registerCommand("gentle:vim", {
		description: "Show or set global Vim prompt editing (status|enable|disable); no argument opens a menu.",
		handler: async (args, ctx) => {
			let action = args.trim() || "status";
			if (!args.trim() && ctx.hasUI && typeof ctx.ui.select === "function") {
				const selected = await ctx.ui.select(`Gentle Vim (current: ${vimPolicy})`, ["enable", "disable", "status"]);
				if (selected === undefined) return;
				action = selected;
			}
			if (action !== "status" && action !== "enable" && action !== "disable") {
				ctx.ui.notify("Use /gentle:vim status|enable|disable.", "warning");
				return;
			}
			try {
				if (action !== "status") writeVimPolicy(action === "enable" ? "on" : "off", animationOptions);
				const result = resolveVimPolicy(animationOptions);
				vimPolicy = result.policy;
				prompt?.setVimPolicy(vimPolicy);
				reportVim(ctx, result);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("gentle:animations", {
		description: "Show or set global animations; no argument opens a selectable menu (quality|performance|potato, plus status).",
		// No argument opens a selectable menu when an interactive UI is present;
		// headless callers and fakes without ui.select keep the status fallback.
		handler: async (args, ctx) => {
			let action = args.trim() || "status";
			if (args.trim().length === 0 && ctx.hasUI && typeof ctx.ui.select === "function") {
				const selected = await ctx.ui.select(
					`Gentle animations (current: ${animationPolicy})`,
					["quality", "performance", "potato", "status"],
				);
				if (selected === undefined) return;
				action = selected;
			}
			if (action !== "status" && action !== "quality" && action !== "performance" && action !== "potato") {
				ctx.ui.notify("Use /gentle:animations status|quality|performance|potato.", "warning");
				return;
			}
			try {
				if (action !== "status") writeAnimationPolicy(action, animationOptions);
				const result = resolveAnimationPolicy(animationOptions);
				animationPolicy = result.policy;
				prompt?.setAnimationPolicy(animationPolicy);
				const source = result.source === "default" ? "built-in default" : `global file ${result.globalFile}`;
				ctx.ui.notify(`animations: ${result.policy} (decided by ${source})${result.malformed ? "; malformed or unreadable file, falling back to quality" : ""}. Prompt applies now; startup banner applies at next creation.`, result.malformed ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	// User-owned, like gentle:background-subagents and gentle:review-mode: the
	// only writer is this handler, reached only by explicit invocation. Unlike
	// those two, no argument toggles the effective policy instead of merely
	// reporting it (see odd/tasks/double-esc-cancel.md).
	pi.registerCommand(DOUBLE_ESC_CANCEL_COMMAND_NAME, {
		description: "Show or set the double-esc-cancel preference (status|enable|disable); no argument toggles it. User-initiated only.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed !== "" && trimmed !== "status" && trimmed !== "enable" && trimmed !== "disable") {
				ctx.ui.notify(`Unknown /${DOUBLE_ESC_CANCEL_COMMAND_NAME} sub-action "${trimmed}". Use status, enable, or disable.`, "warning");
				return;
			}
			try {
				const before = resolveDoubleEscCancelPolicy({ env, gentlePiConfigHome: doubleEscCancelConfigHome });
				doubleEscCancelPolicy = before.policy;
				const subAction = trimmed === "" ? (before.policy === "on" ? "disable" : "enable") : trimmed;
				if (subAction === "status") {
					const report = renderDoubleEscCancelReport(before);
					ctx.ui.notify(report.message, report.type);
					return;
				}
				const wrote: DoubleEscCancelPolicy = subAction === "enable" ? "on" : "off";
				writeDoubleEscCancelPolicy(wrote, { gentlePiConfigHome: doubleEscCancelConfigHome });
				const after = resolveDoubleEscCancelPolicy({ env, gentlePiConfigHome: doubleEscCancelConfigHome });
				// Cache what the file actually resolves to, not what was written: a
				// competing writer or a read failure would otherwise leave the gate
				// and the report disagreeing.
				doubleEscCancelPolicy = after.policy;
				const report = renderDoubleEscCancelReport(after, wrote);
				ctx.ui.notify(report.message, report.type);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.on("agent_start", (_event, ctx) => {
		// A turn can start any other way (the user sending the draft, an
		// extension, a shortcut) before the aborted run's own agent_settled
		// below has delivered the pending text. Nothing is sent from here: Pi
		// is mid-turn, so the text simply waits and goes out, once, when that
		// turn settles. It is never dropped.
		// A new turn always starts unlabeled: any ODD phase reported for the
		// previous turn must never leak into this one. The new turn's tool
		// activity, or an explicit orchestrator report, labels it again.
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		prompt?.setWorking(true);
		// The dev-binary card is a startup notice: it leaves with the first prompt.
		if (ctx.hasUI) ctx.ui.setWidget(DEV_BINARY_WIDGET_KEY, undefined);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		// The working label follows the primary session's own tool activity so
		// it never depends on the model remembering gentle_odd_phase, which
		// stays the explicit refinement (its report is already explicit).
		// Subagents run as headless `pi --mode rpc` children whose env never
		// carries the interactive-host signal (lib/agents-runner.ts), so they
		// never infer; their process-local registry could not reach this
		// label anyway.
		if (!ctx.hasUI || !isInteractiveMode(ctx.mode) || event.toolName === "gentle_odd_phase") return;
		const phase = inferOddPhase(event.toolName, event.args);
		if (phase) {
			const delegated = event.toolName === "subagent_run" || /^mcp__.+?__subagent_run$/.test(event.toolName);
			oddPhaseRegistry.infer(ctx.sessionManager.getSessionId(), phase, delegated ? "delegation" : "tool");
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		// Pi clears its own run-active flag before emitting agent_settled, so
		// this is normally idle; if a run is somehow still in flight the prompt
		// stays working and the pending text waits for the next settle.
		if (!ctx.isIdle()) return;
		// Covers both a normal finish and an aborted turn settling idle: the
		// input falls back to the generic "working…" label until the next
		// turn's own agent_start clears it again (belt-and-suspenders with the
		// clear above).
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		prompt?.setWorking(false);
		if (pendingQueuedText === undefined) return;
		const queued = pendingQueuedText;
		pendingQueuedText = undefined;
		try {
			pi.sendUserMessage(queued);
		} catch (error) {
			// Never drop the user's words: put them back in front of the draft,
			// exactly the shape Pi's own restore would have left, and say why.
			if (prompt) {
				const current = prompt.getText();
				prompt.setText([queued, current].filter((text) => text.trim() !== "").join("\n\n"));
			} else {
				pendingQueuedText = queued;
			}
			if (ctx.hasUI) ctx.ui.notify(`Could not send the queued message after cancel; it is back in the editor: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
	pi.on("agent_end", async (_event, ctx) => {
		// A slow or failing Git never holds the turn end.
		trackChangeRefresh(refreshChanges(ctx));
		if (currentContext === ctx) trackChangeRefresh(refreshSidebarDiff?.() ?? Promise.resolve());
		void refreshUsage(ctx, false);
	});
}
