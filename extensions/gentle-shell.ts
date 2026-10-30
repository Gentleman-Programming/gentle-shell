import { CustomEditor, keyHint, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isHomeOrBroadUserDirectory } from "../lib/bounded-writer-admission.ts";
import { Editor, Image, decodeKittyPrintable, getCapabilities, isKeyRelease, matchesKey, parseKey, truncateToWidth, visibleWidth, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { readClipboardImage, type ClipboardImage } from "../lib/clipboard-image.ts";
import { describeAttachment, ImageAttachments } from "../lib/image-attachments.ts";
import { execFile, spawnSync } from "node:child_process";
import { openInExternalEditor, type ExternalEditorHost } from "../lib/external-editor.ts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { profilesFilePath, profileRoleEntries, readProfilesFileResult } from "../lib/agent-profiles.ts";
import { resolveSessionProfile, sessionProfileLabel, sessionProfileModelProfiles } from "../lib/session-profile-freeze.ts";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildShellHeaderModel, renderShellBar, renderShellBelowInputFloat, renderShellBottomOnlyBar, renderShellHeaderChrome, renderShellSidebarBar, keepNativeWorkingRow, shellEnabled, shellHeaderUsageHit, shellJobsCount, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { CHANGE_STATUS, DIFF_MAX_BYTES, DIFF_MAX_LINES, DIFF_TOO_LARGE, WorktreeChangesTracker, changesDigest, renderChangesWidget, type ChangedFile, type ChangesModel, type FileRevision, type GitRunner, type LineCounter, type WorktreeChanges } from "../lib/shell-changes.ts";
import { WorktreeChangesView } from "../lib/shell-changes-view.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import { SessionWorktreeRegistry, resolveSessionWorktree, worktreeGitEnvironment, type WorktreeResolver, type WorktreeIdentity } from "../lib/session-worktree-registry.ts";
import { CARD_STYLE, CARD_TONE, cardStyle, panelHeaderRow, renderCard, setCardStyle, type Card, type CardTheme } from "../lib/shell-card.ts";
import { resolveCardStyle, writeCardStyle } from "../lib/card-style-policy.ts";
import { CARD_CONTENT, resolveCardContent, setCardContent, writeCardContent } from "../lib/card-content-policy.ts";
import { CommandPalette, commandsKey, type CommandPaletteResult } from "../lib/command-palette.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { discoverYoloUiAdapter, YOLO_DISPLAY, type YoloDisplay, type YoloUiAdapter } from "../lib/yolo-session-policy.ts";
import { VisualCustomizeView, type CustomizeCategory, type CustomizeRow, type ProfileActions } from "../lib/visual-customize-view.ts";
import { deleteVisualProfile, getVisualProfile, listVisualProfiles, resetVisualProfiles, saveVisualProfile } from "../lib/visual-profiles.ts";
import { gaugePaintFor } from "../lib/gauge-theme.ts";
import type { GaugePaint } from "../lib/shell-gauge.ts";
import { sourcePalettePreview } from "../lib/theme-customization.ts";
import { DEFAULT_VISUAL_SETTINGS, DENSITY, HEADER_PLACEMENT, STATUS_PLACEMENT, VISUAL_SECTION_KEYS, resolveVisualSettings, writeVisualSettings } from "../lib/visual-customization-policy.ts";
import { BANNER_COLORS, DEFAULT_BANNER_CONFIG, readBannerConfig, readBannerConfigForEdit, writeBannerConfig } from "./startup-banner.ts";
import { agentsViewKey } from "../lib/agents-keys.ts";
import { GentleAiDevBinaryOverrideError, resolveGentleAiDevBinaryOverride } from "../lib/gentle-ai-binary.ts";
import { DOUBLE_ESC_CANCEL_HINT, floatPromptRow, framePromptLines, resolvePromptLayout, IDLE_ESC_CLEAR_HINT, PROMPT_HINT, PROMPT_STATE, SHELL_PULSE_WATCHDOG_MS, withPromptHint, type PromptState } from "../lib/shell-prompt.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { inferOddPhase } from "../lib/odd-phase-inference.ts";
import { isInteractiveMode } from "../lib/rpc-host.ts";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { isNanAdaptiveReasoningModel } from "../lib/nan-provider.ts";
import { resolveAnimationPolicy, writeAnimationPolicy, type AnimationPolicy } from "../lib/animation-policy.ts";
import { resolveVimPolicy, writeVimPolicy, type VimPolicy } from "../lib/vim-policy.ts";
import { resolveHistoryCapture, writeHistoryCapturePolicy } from "../lib/history-capture-policy.ts";
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
import { UsageView } from "../lib/shell-usage-view.ts";
import { sidebarHeader, sidebarPart, sidebarState, VISUAL_SETTINGS_CHANGED, type SidebarRail } from "../lib/shell-sidebar.ts";
import { installSidebar, invalidateSidebar, narrowStatusOwner, SIDEBAR_BREAKPOINT, STATUS_OWNER } from "../lib/shell-sidebar-layout.ts";
import { sessionChangeRoots } from "../lib/session-changes.ts";
import { REVIEW_SIDEBAR_EVENT, isReviewSidebarSnapshot, type ReviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";
import { JOBS_SIDEBAR_EVENT, JOBS_STATUS_KEY, isJobsSidebarSnapshot, jobsCollapseKey, type RunningJobDisplay } from "../lib/jobs-sidebar-state.ts";
import { JOBS_FINISHED_TTL_MS, jobsCardTone, renderJobsCard } from "../lib/jobs-widget.ts";
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
	vimRuntimeVersion?(): string | undefined;
	/** Clipboard image source for the prompt's attachment chips; tests inject a fake. */
	readClipboardImage?(): Promise<ClipboardImage | null>;
}

export type ActiveProfileReader = (() => string | undefined) & {
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
	let bound = false;
	let cwd: string | undefined;
	let identity: WorktreeIdentity | undefined;
	let sessionId: string | undefined;
	let effective: string | undefined;
	const global = () => {
		try {
			const stat = statSync(path, { bigint: true });
			const next = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			if (next !== fingerprint) {
				const result = readProfilesFileResult(path);
				name = result.status === "valid" ? result.file.active : undefined;
				fingerprint = next;
			}
			return name;
		} catch {
			fingerprint = undefined;
			name = undefined;
			return undefined;
		}
	};
	const reader = (() => bound ? effective : global()) as ActiveProfileReader;
	reader.refresh = () => {
		if (!bound) return false;
		// gentle-shell#1064: the status shows the profile launches use, through
		// the same single rule (explicit Enter binding → profile frozen at
		// startup → live p → P → G only in follow mode), with the existing
		// spelling: "name (session)", "name (local)", "name (repo)", or the bare
		// global name.
		const next = cwd === undefined ? global() : sessionProfileLabel(resolveSessionProfile({
			sessionId,
			cwd,
			configHome: gentlePiConfigHome(env),
			resolveWorktree: () => identity,
			env,
		}));
		const changed = next !== effective;
		effective = next;
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
	reader.reset = () => { bound = false; cwd = undefined; identity = undefined; sessionId = undefined; effective = undefined; };
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
	const adaptiveReasoning = isNanAdaptiveReasoningModel(model);
	const statuses = Array.from(footerData.getExtensionStatuses().entries())
		.filter(([key]) => options.jobs === undefined || key !== JOBS_STATUS_KEY)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text);
	return {
		cwd: shortenHome(ctx.sessionManager.getCwd(), home),
		profile: options.profile,
		branch: footerData.getGitBranch(),
		dirty: options.dirty,
		sessionName: ctx.sessionManager.getSessionName(),
		modelId: model?.id ?? "no-model",
		effort: model?.reasoning ? (adaptiveReasoning ? "auto" : pi.getThinkingLevel()) : undefined,
		contextPercent: usage?.percent ?? null,
		contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
		costTotal,
		subscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
		usage: options.usage,
		...(options.jobs !== undefined ? { jobs: options.jobs } : {}),
		statuses,
	};
}

export interface FooterStatusMemoDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	footerData: ShellFooterData;
	usage: () => ProviderUsage | undefined;
	profile: () => string | undefined;
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
			model?.reasoning ? (isNanAdaptiveReasoningModel(model) ? "auto" : pi.getThinkingLevel()) : undefined,
			model ? ctx.modelRegistry.isUsingOAuth(model) : false,
			footerData.getGitBranch(),
			deps.profile(),
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
			...buildShellBarModel(pi, ctx, footerData, { dirty: tracker.model.files.length, usage: deps.usage(), profile: deps.profile(), jobs: deps.jobs() }),
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
	/** Injectable silence-watchdog window; production and tests default to SHELL_PULSE_WATCHDOG_MS. */
	watchdogMs?: number;
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
	private tick = 0;
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
	// Last time a frame painted (or the watchdog forced one) while working; the
	// quality watchdog repaints only when now() drifts past its window.
	private lastRenderAt = 0;
	private readonly deps: PromptEditorDeps;
	private floatMouseLayout?: ReturnType<typeof resolvePromptLayout>;
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
		this.keybindingsManager = keybindings;
		const attachments = deps.attachments;
		if (!attachments || !deps.readClipboardImage) return;
		// SAFETY: Pi's Editor routes cursor movement, wrapping and deletion through
		// its private segment(). Wrapping it only merges registered chips into one
		// segment; if a future Pi drops the method, chips degrade to plain text.
		const host = this as unknown as {
			segment?: (text: string, mode?: string) => Iterable<{ segment: string; index: number; input: string }>;
			submitValue?: () => void;
		};
		const segment = host.segment;
		if (typeof segment === "function") host.segment = (text, mode) => attachments.segment(text, segment.call(this, text, mode));
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
			const { token } = attachments.add(image);
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			const before = cursor.col > 0 && !/\s/.test(line[cursor.col - 1] ?? "") ? " " : "";
			const after = cursor.col < line.length && !/\s/.test(line[cursor.col] ?? "") ? " " : "";
			this.insertTextAtCursor(`${before}${token}${after}`);
			this.deps.requestRender();
		} catch (error) {
			// Never let a paste reject unhandled: Node 24 ends the process on it.
			this.deps.notifyCompatibility?.(`Image paste failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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

	private startWatchdog(): void {
		if (this.animationPolicy === "potato") return;
		const windowMs = this.deps.watchdogMs ?? SHELL_PULSE_WATCHDOG_MS;
		this.lastRenderAt = this.deps.now();
		this.watchdog = setInterval(() => {
			// Render-driven petal (gentle-shell#994): streaming frames already
			// advance the animation in render(), so under quality the watchdog
			// stays silent unless no frame painted within its window. performance
			// keeps its coarse cadence regardless of render traffic.
			if (this.animationPolicy === "quality" && this.deps.now() - this.lastRenderAt < windowMs) return;
			this.tick += 1;
			this.lastRenderAt = this.deps.now();
			this.deps.requestRender();
		}, windowMs);
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

	handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]): ReturnType<CustomEditor["handleMouse"]> {
		const layout = this.floatMouseLayout;
		if (!layout) return super.handleMouse(event);
		// Row coordinates stay native: padding=0, content=1…N, hint=N+1.
		// Only float translates x; the existing neon/fallback path is unchanged.
		if (event.x < layout.prefixWidth || event.x >= layout.width - 1) return undefined;
		return super.handleMouse({ ...event, x: event.x - layout.prefixWidth, width: layout.nativeWidth });
	}

	render(width: number): string[] {
		// Render-driven petal (gentle-shell#994): every frame the host already
		// paints while working advances the animation for free, so no fast
		// timer forces renders during streaming.
		if (this.promptState === PROMPT_STATE.WORKING && this.animationPolicy === "quality") {
			this.tick += 1;
			this.lastRenderAt = this.deps.now();
		}
		const layout = resolvePromptLayout(width, cardStyle(), this.deps.bg);
		this.floatMouseLayout = layout.background ? layout : undefined;
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
			tick: this.tick,
			borderColor: (text) => layout.background ? this.borderColor(text) : this.deps.fg(PROMPT_FRAME_ROLE, text),
			fg: this.deps.fg,
			bold: this.deps.bold,
			workingLabel: this.promptState === PROMPT_STATE.WORKING ? this.deps.workingLabel?.() : undefined,
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
			framed[framed.length - 1] = layout.background
				? floatPromptRow(this.selectionEngine.decorateBottomRule("", layout.nativeWidth, ""), layout, (text) => this.borderColor(text))
				: this.selectionEngine.decorateBottomRule(framed[framed.length - 1] ?? "", width, "╯");
		}
		// Pi places autocomplete after its bottom border. Keep those rows below
		// Gentle's frame and preserve their terminal width and row coordinates.
		for (const line of editorLines.slice(borderEnd)) {
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

	dispose(): void {
		this.disposed = true;
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
		this.tick = 0;
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
	promptDeps: { now: () => number; doubleEscCancelEnabled: () => boolean; dispatchQueuedText: (text: string) => void; vimRuntimeVersion?: () => string | undefined; attachments?: ImageAttachments; readClipboardImage?: () => Promise<ClipboardImage | null> },
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
const CHANGES_SHORTCUT_DEFAULT = "alt+g";
const CHANGES_POLL_DEFAULT_MS = 2000;
const GIT_TIMEOUT_MS = 5000;
const COMMANDS_COMMAND_NAME = "gentle:commands";

export function shellGitRunner(cwd: string, env: NodeJS.ProcessEnv = process.env, run: typeof execFile = execFile, maxBuffer = Infinity): GitRunner {
	// Pi exec cannot replace the inherited environment. Use argv directly and
	// a complete sanitized environment for discovery, status, and lazy diffs.
	const childEnv = worktreeGitEnvironment(env);
	return (args) => new Promise((resolve) => {
		run("git", ["-C", cwd, ...args], {
			env: childEnv,
			encoding: "utf8",
			shell: false,
			windowsHide: true,
			timeout: GIT_TIMEOUT_MS,
			// Pi exec accumulates output without a maxBuffer cap. In particular,
			// large porcelain inventories must not become partial successful scans.
			// Only a single diff passes a bound, and is told when it hit it.
			maxBuffer,
		}, (error, stdout) => {
			if ((error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ stdout, code: 1, truncated: true });
			resolve({ stdout, code: error ? typeof error.code === "number" ? error.code : 1 : 0 });
		});
	});
}

export async function loadFileDiff(git: GitRunner, file: ChangedFile): Promise<string> {
	const args = file.status === CHANGE_STATUS.UNTRACKED ? ["diff", "--no-index", "--", "/dev/null", file.path] : ["diff", "HEAD", "--", file.path];
	const result = await git(args);
	if (result.truncated || result.stdout.length > DIFF_MAX_BYTES || result.stdout.split("\n", DIFF_MAX_LINES + 2).length > DIFF_MAX_LINES + 1) return DIFF_TOO_LARGE;
	return result.code === 0 || result.code === 1 ? result.stdout : "";
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
export function changesShortcut(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_SHELL_CHANGES_KEY?.trim();
	if (value === undefined) return CHANGES_SHORTCUT_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}

export function usageShortcut(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_SHELL_USAGE_KEY?.trim();
	if (value === undefined) return USAGE_SHORTCUT_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
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
	loadDiff(root: string, file: ChangedFile): Promise<string>;
	worktrees(): WorktreeChanges[];
	refresh(): Promise<ChangesModel>;
	apply(ctx: ExtensionContext, model: ChangesModel): void;
	pollMs: number;
}

// The overlay polls each root's Git state while it is open; diffs load lazily.
// Like Gentle Agents it takes the whole terminal, and the native fullscreen
// wrapper keeps mouse dispatch on the view while it owns the keyboard.
async function showChangesOverlay(ctx: ExtensionContext, deps: OverlayDeps): Promise<void> {
	let host: ExternalEditorHost | undefined;
	let view: WorktreeChangesView | undefined;
	const refresh = async () => {
		const latest = await deps.refresh();
		view?.update(deps.worktrees());
		deps.apply(ctx, latest);
	};
	const poll = setInterval(() => void refresh().catch(() => {}), deps.pollMs);
	poll.unref();
	try {
		const chosen = await ctx.ui.custom<{ root: string; file: ChangedFile } | null>(
			(tui, theme, _keybindings, done) => {
				const close = withOverlayRepaint(tui, done);
				host = tui;
				view = new WorktreeChangesView(deps.worktrees(), {
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
		if (!chosen || !host) return;
		try {
			if (!openInExternalEditor(host, chosen.file.path, process.env, spawnSync, chosen.root)) ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	} finally {
		clearInterval(poll);
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
async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext, env: NodeJS.ProcessEnv): Promise<void> {
	if (!ctx.hasUI) return;
	const groups = buildCommandPaletteGroups(pi.getCommands(), {
		"gentle:changes": changesShortcut(env),
		"gentle:agents": agentsViewKey(env),
	});
	if (groups.length === 0) {
		ctx.ui.notify("No Gentle commands are registered.", "info");
		return;
	}
	const result = await ctx.ui.custom<CommandPaletteResult>(
		(tui, theme, _keybindings, done) => new CommandPalette(groups, withOverlayRepaint(tui, done), theme, () => Math.max(0, tui.terminal.rows)),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } },
	);
	if (result?.type === "run") pi.sendUserMessage(`/${result.name}`, { expandPromptTemplates: true });
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
const USAGE_SHORTCUT_DEFAULT = "alt+u";
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
	if (!shellEnabled(env)) return;
	const profileReader = createActiveProfileReader(env);
	const deps: ShellDeps = { ...defaultShellDeps, activeProfile: profileReader, ...overrides };
	let closeCustomize: (() => void) | undefined;
	let profilePoll: ReturnType<typeof setInterval> | undefined;
	const stopProfilePoll = () => {
		if (profilePoll) clearInterval(profilePoll);
		profilePoll = undefined;
		profileReader.reset();
	};
	const usage = new UsageStore();
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
	// NaN accepts a thinking level for DeepSeek V4 Flash, Qwen 3.8 Flash, and MiMo
	// but manages their depth itself, so the header reports `auto` and the shell says
	// why once per model instead of repeating it on every level change.
	const adaptiveReasoningNotices = new Set<string>();
	const announceAdaptiveReasoning = (ctx: ExtensionContext, model: { provider: string; id: string; name?: string } | undefined) => {
		if (!ctx.hasUI || !isNanAdaptiveReasoningModel(model)) return;
		const key = `${model.provider}/${model.id}`;
		if (adaptiveReasoningNotices.has(key)) return;
		adaptiveReasoningNotices.add(key);
		ctx.ui.notify(`${model.name || model.id} chooses its reasoning depth automatically; the selected thinking level is accepted but does not change it.`, "info");
	};
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
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	});
	pi.registerMessageRenderer(REVIEW_PREFLIGHT_TYPE, (message, options, theme) => {
		const lines = messageText(message.content as string | Array<{ type: string; text?: string }>).split("\n");
		const body = options.expanded ? lines : lines.filter((line) => line.trim() !== "");
		const hint = keyHint("app.tools.expand", options.expanded ? "collapse" : "expand");
		return cardComponent({ title: "Gentle AI", subtitle: "review preflight", body, tone: CARD_TONE.INFO }, theme, { expanded: options.expanded, previewRows: 3, hint });
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
	const usageShortcutKey = usageShortcut(env);
	if (usageShortcutKey) {
		pi.registerShortcut(usageShortcutKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Show subscription usage windows for the connected providers",
			handler: async (ctx) => openUsage(ctx),
		});
	}
	let prompt: GentlePromptEditor | undefined;
	// Images pasted into the current draft; emptied on every submit.
	const imageAttachments = new ImageAttachments();
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
	let sidebarTui: TUI | undefined;
	let groupedChangesOwner: (width: number) => boolean = () => false;
	const refreshVisual = () => {
		visualSettings = resolveVisualSettings(animationOptions).settings;
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
		const model = await tracker.refresh();
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
		closeCustomize?.();
		runningJobs = undefined;
		adaptiveReasoningNotices.clear();
		// A restored or default session never emits model_select, so the startup model
		// announces itself here when it manages its own depth.
		announceAdaptiveReasoning(ctx, ctx.model);
		if (review) {
			review = undefined;
			redrawReview();
		}
		stopProfilePoll();
		registry?.close();
		currentContext = ctx;
		changes = undefined;
		registry = new SessionWorktreeRegistry(pi, ctx.sessionManager, ctx.cwd, deps.resolveWorktree);
		registry.start();
		applyCardStyle();
		applyCardContent();
		if (!ctx.hasUI) return;
		visualSettings = resolveVisualSettings(animationOptions).settings;
		if (!overrides.activeProfile) {
			profileReader.bind(ctx.cwd, deps.resolveWorktree, ctx.sessionManager.getSessionId());
			const sessionId = ctx.sessionManager.getSessionId();
			profilePoll = setInterval(() => {
				if (currentContext !== ctx || ctx.sessionManager.getSessionId() !== sessionId) return;
				if (!profileReader.refresh()) return;
				renderHost?.invalidateSidebar?.();
				renderHost?.requestRender();
			}, 2_000);
			profilePoll.unref?.();
		}
		changes = changesTracker(ctx);
		const tracker = changes;
		ctx.ui.setFooter((tui, theme, footerData) => {
			sidebarTui = tui;
			if (tui.terminal) sidebarState(tui).visibility = { todo: visualSettings.visibility.todo };
			renderHost = { requestRender: () => tui.requestRender(), invalidateSidebar: () => invalidateSidebar(tui) };
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
			groupedChangesOwner = (width) => belowFloat(width, !footerSuppressed()) !== undefined;
			const bottomBar = {
				...bottom,
				render: (width: number) => belowFloat(width, true)?.rows ?? (statusOwner() === STATUS_OWNER.BOTTOM ? renderShellBottomOnlyBar(footerModel(), theme, width, usageShortcutKey, visualSettings, undefined, gaugePaint(ctx)) : bottom.render(width)),
				handleMouse(event: Parameters<NonNullable<SidebarRail["handleMouse"]>>[0]) {
					if (footerSuppressed() || event.type !== "click" || event.button !== "left") return undefined;
					const chrome = belowFloat(event.width, true);
					if (!chrome || !shellHeaderUsageHit(chrome, event.x, event.y)) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			};
			const part = sidebarPart(tui, "footer", bottomBar, {
				digest: () => footerStatus.key(),
				render: (width) => renderShellSidebarBar(footerModel(), theme, width, visualSettings),
				invalidate() {},
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
					const lines = renderJobsCard(jobs, theme, width, deps.now(), { collapsed: jobsCollapsed, collapseKey: jobsKey, collapseControl: true, hovered: jobsHovered });
					jobsPainted = lines.length > 0;
					jobsHeaderRow = jobsPainted ? panelHeaderRow(theme, width, jobsCardTone(jobs)) : 0;
					return lines;
				},
				invalidate() {
					jobsHovered = false;
				},
			};
			const jobsRegion = new NativePointerRegion(jobsRailCard, {
				onHover(event) {
					const next = event.y === jobsHeaderRow;
					if (next === jobsHovered) return { handled: true };
					jobsHovered = next;
					return { handled: true, render: true };
				},
				onLeave() {
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
			const jobsRail: Component & { digest(): string; dispose(): void } = {
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
			const disposeHeader = sidebarHeader(tui, {
				digest: () => footerStatus.key(),
				render: (width) => headerBar(width).rows,
				invalidate() {},
				handleMouse(event) {
					if (event.type !== "click" || event.button !== "left") return undefined;
					if (!shellHeaderUsageHit(headerBar(event.width), event.x, event.y)) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			});
			const uninstall = installSidebar(tui, theme, () => visualSettings.statusPlacement, () => visualSettings.headerPlacement, () => visualSettings.density);
			// The public widget slot follows the editor even when the rail is absent.
			const belowHeader = () => visualSettings.headerPlacement === "below-input" && (tui as TUI & { mode?: string }).mode === "fullscreen" && statusOwner() !== STATUS_OWNER.BOTTOM;
			const widgetChrome = (width: number) => belowFloat(width, false) ?? headerBar(width);
			ctx.ui.setWidget(HEADER_WIDGET_KEY, () => ({
				render(width: number) {
					if (belowFloat(width, false)) return footerSuppressed() ? widgetChrome(width).rows : [];
					return belowHeader() ? headerBar(width).rows : [];
				},
				invalidate() {},
				handleMouse(event) {
					const grouped = belowFloat(event.width, false);
					if ((grouped ? !footerSuppressed() : !belowHeader()) || event.type !== "click" || event.button !== "left") return undefined;
					if (!shellHeaderUsageHit(widgetChrome(event.width), event.x, event.y)) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			}), { placement: "belowEditor" });
			return { ...part,
				render(width: number) {
					// Running-only: a finished tail must never paint a ⧗ 0 jobs row.
					const compactRunningJobs = runningJobs?.filter((job) => job.status === undefined);
					if (visualSettings.statusPlacement === "hidden" && (tui as TUI & { mode?: string }).mode !== "fullscreen" && compactRunningJobs?.length) {
						return [truncateToWidth(theme.fg("muted", shellJobsCount(compactRunningJobs.length)), width, "…")];
					}
					const rows = part.render(width);
					// Preserve a shrinkable exterior dock row, outside prompt/completion geometry.
					return rows.length === 0 && (tui as TUI & { mode?: string }).mode === "fullscreen"
						&& resolvePromptLayout(width, cardStyle(), theme.bg?.bind(theme)).background ? [""] : rows;
				},
				dispose() { clearInterval(jobsTimer); jobsPart.dispose(); ctx.ui.setWidget(HEADER_WIDGET_KEY, undefined); disposeHeader(); uninstall(); part.dispose(); if (sidebarTui === tui) { sidebarTui = undefined; groupedChangesOwner = () => false; } } };
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
			{ now: () => deps.now(), doubleEscCancelEnabled: () => doubleEscCancelPolicy === "on", dispatchQueuedText: (text) => { pendingQueuedText = pendingQueuedText === undefined ? text : `${pendingQueuedText}\n\n${text}`; }, vimRuntimeVersion: deps.vimRuntimeVersion, attachments: imageAttachments, readClipboardImage: () => (deps.readClipboardImage ?? readClipboardImage)() },
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
	pi.registerCommand(CHANGES_COMMAND_NAME, {
		description: "Browse uncommitted Git changes (working tree vs HEAD, untracked included) in this session's repository and its subagents' worktrees. Press o to open $EDITOR.",
		handler: async (_args, ctx) => openChanges(ctx),
	});
	const shortcut = changesShortcut(env);
	if (shortcut) {
		pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Open the session's uncommitted Git changes",
			handler: async (ctx) => openChanges(ctx),
		});
	}
	pi.registerCommand(COMMANDS_COMMAND_NAME, {
		description: "Open the command palette: a curated, grouped menu of Gentle commands.",
		handler: async (_args, ctx) => showCommandPalette(pi, ctx, env),
	});
	const commandsShortcut = commandsKey(env);
	if (commandsShortcut) {
		pi.registerShortcut(commandsShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Open the command palette",
			handler: async (ctx) => showCommandPalette(pi, ctx, env),
		});
	}
	const jobsKey = jobsCollapseKey(env);
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
	pi.registerCommand("gentle:customize", {
		description: "Configure appearance, audio notifications, Vim editing, session permissions and global Auto/YOLO defaults, and prompt history capture.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				if (ctx.hasUI) ctx.ui.notify("Customization requires an interactive terminal.", "warning");
				return;
			}
			closeCustomize?.();
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
			const add = (label: CustomizeRow["label"], notice: string, action: () => void | false | Promise<void | false>, preview?: CustomizeRow["preview"]) => rows.push({ category, label, preview, action: async () => {
				if (await action() === false) return;
				ctx.ui.notify(notice, "info");
			} });
			for (const policy of ["quality", "performance", "potato"] as const) add(
				() => `Animations: ${policy}${resolveAnimationPolicy(animationOptions).policy === policy ? " (current)" : ""}`,
				"Animation saved. Prompt applies now; startup banner applies at next startup.",
				() => {
					writeAnimationPolicy(policy, animationOptions);
					animationPolicy = resolveAnimationPolicy(animationOptions).policy;
					prompt?.setAnimationPolicy(animationPolicy);
				},
				() => ({ title: `${policy} · static animation sample`, sample: policy === "potato" ? "✿  idle → working (no pulse)" : policy === "performance" ? "✿  short pulse → settle (static)" : "✿  gentle wave → settle (static)" }),
			);
			category = "Banner";
			const bannerColors = { pink: [255, 118, 195], cyan: [95, 210, 255], yellow: [255, 210, 95], green: [110, 220, 145] } as const;
			const bannerPreview = (next: typeof banner) => {
				const [r, g, b] = bannerColors[next.color];
				return { title: `Banner · ${next.color} (static)`, sample: `${next.showRose ? `\x1b[38;2;${r};${g};${b}m🌹\x1b[0m` : "·"}  ${next.showTextLogo ? "GENTLE SHELL" : "(logo hidden)"}` };
			};
			add(() => `Banner rose: ${banner.showRose ? "on" : "off"}`, "Banner saved; applies at next startup.", async () => {
				const next = { ...await readBannerConfigForEdit(bannerHome) };
				next.showRose = !next.showRose;
				await writeBannerConfig(next, bannerHome);
				banner = next;
			}, () => bannerPreview({ ...banner, showRose: !banner.showRose }));
			add(() => `Banner text logo: ${banner.showTextLogo ? "on" : "off"}`, "Banner saved; applies at next startup.", async () => {
				const next = { ...await readBannerConfigForEdit(bannerHome) };
				next.showTextLogo = !next.showTextLogo;
				await writeBannerConfig(next, bannerHome);
				banner = next;
			}, () => bannerPreview({ ...banner, showTextLogo: !banner.showTextLogo }));
			for (const color of BANNER_COLORS) add(
				() => `Banner color: ${color}${banner.color === color ? " (current)" : ""}`,
				"Banner saved; applies at next startup.",
				async () => { const next = { ...await readBannerConfigForEdit(bannerHome), color }; await writeBannerConfig(next, bannerHome); banner = next; },
				() => bannerPreview({ ...banner, color }),
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
				sample: `${settings.headerPlacement === "top" ? "[Header] → [Input]" : "[Input] → [Header]"}  ${settings.statusPlacement === "auto" ? "[responsive status]" : settings.statusPlacement === "right" ? "[Right rail, wide]" : settings.statusPlacement === "hidden" ? "[No status bar or rail]" : "[Bottom status]"}`,
			});
			category = "Editor";
			for (const [label, policy] of [["enable", "on"], ["disable", "off"]] as const) rows.push({
				category,
				label: () => `Vim: ${label}${resolveVimPolicy(animationOptions).policy === policy ? " (current preference)" : ""}`,
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
			rows.push({
				category,
				label: () => `YOLO: ${yoloDisplay} · session only`,
				preview: () => ({ title: "YOLO · session permission", sample: "ordinary scoped commits/push/PR · destructive confirmations remain · review consent unchanged · reset on reload" }),
				action: async () => {
					if (closed) return;
					if (!adapter || yoloDisplay === YOLO_DISPLAY.unavailable) {
						ctx.ui.notify("YOLO is unavailable in this live primary session.", "warning");
						return;
					}
					await adapter.toggle();
					await refreshYolo();
				},
			});
			for (const mode of ["normal", "auto", "yolo", "super-yolo"] as const) rows.push({
				category,
				label: () => `Session permissions: ${mode.toUpperCase()}${mode === "auto" ? " (beta)" : ""}${permissionDisplay === mode ? " (current)" : ""}`,
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
			for (const value of Object.values(STATUS_PLACEMENT)) add(() => `Status placement: ${value}${visual().statusPlacement === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, statusPlacement: value })), () => layoutPreview({ ...visual(), statusPlacement: value }));
			for (const value of Object.values(HEADER_PLACEMENT)) add(() => `Header placement: ${value}${visual().headerPlacement === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, headerPlacement: value })), () => layoutPreview({ ...visual(), headerPlacement: value }));
			for (const value of Object.values(DENSITY)) add(() => `Density: ${value}${visual().density === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, density: value })), () => layoutPreview({ ...visual(), density: value }));
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
			);
			category = "Sections";
			for (const key of VISUAL_SECTION_KEYS) add(
				() => `Section ${key}: ${visual().visibility[key] ? "shown" : "hidden"}`,
				pending,
				() => updateVisual((settings) => ({ ...settings, visibility: { ...settings.visibility, [key]: !settings.visibility[key] } })),
				() => {
					const visibility = { ...visual().visibility, [key]: !visual().visibility[key] };
					return { title: `Sections · ${key} ${visibility[key] ? "shown" : "hidden"}`, sample: `[${Object.entries(visibility).filter(([, shown]) => shown).map(([section]) => section).join("] [") || "no optional sections"}]` };
				},
			);
			const catalog = () => listVisualProfiles(home).map(name => getVisualProfile(name, home)!);
			category = "Profiles";
			rows.push({ category, label: "Visual profiles (preview, save, apply, delete)", preview: () => {
				const saved = catalog()[0];
				return saved ? { title: `${saved.name} · saved profile`, sample: `${saved.visual.headerPlacement === "top" ? "[Header] → [Input]" : "[Input] → [Header]"}  [${saved.visual.statusPlacement} status]` } : { title: "No saved profiles", sample: "Enter to save the current appearance" };
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
				await ctx.ui.custom<null>((tui, theme, _keys, done) => {
					finish = () => done(null);
					if (closed) done(null);
					requestYoloRender = () => { if (!closed) tui.requestRender(); };
					requestCustomizeRender = requestYoloRender;
					customizeView = new VisualCustomizeView({ rows, profiles, theme, requestRender: requestYoloRender, rowsAvailable: () => Math.max(0, Math.floor(tui.terminal.rows * 0.85) - 2), onError: (error) => { if (!closed) ctx.ui.notify(`${customizeView?.title() ?? "Customization"}: ${error.message}`, "error"); }, onClose: close });
					const view = customizeView;
					// Own interaction lifetime here, leaving the shared view unchanged.
					return {
						render: (width) => closed ? [] : view.render(width),
						handleInput: (data) => { if (!closed) view.handleInput(data); },
						invalidate: () => { if (!closed) view.invalidate(); },
						dispose: close,
					};
				}, { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } });
			} finally { close(); }
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
		void refreshUsage(ctx, false);
	});
	pi.on("model_select", (event, ctx) => {
		announceAdaptiveReasoning(ctx, event.model);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		announceAdaptiveReasoning(ctx, ctx.model);
	});
}
