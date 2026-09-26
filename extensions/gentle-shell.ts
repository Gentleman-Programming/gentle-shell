import { CustomEditor, keyHint, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, decodeKittyPrintable, isKeyRelease, matchesKey, parseKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { execFile, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { profilesFilePath, readProfilesFileResult } from "../lib/agent-profiles.ts";
import { resolveProfilePin } from "../lib/agent-profile-pin.ts";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildShellHeaderModel, renderShellBar, renderShellBottomOnlyBar, renderShellHeaderBar, renderShellHeaderRule, renderShellSidebarBar, shellEnabled, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { CHANGE_STATUS, RootBranchLabels, renderChangesWidget, type ChangedFile, type ChangesModel, type GitRunner, type WorktreeChanges } from "../lib/shell-changes.ts";
import { WorktreeChangesView } from "../lib/shell-changes-view.ts";
import { SessionWorktreeRegistry, resolveSessionWorktree, worktreeGitEnvironment, type WorktreeResolver, type WorktreeIdentity } from "../lib/session-worktree-registry.ts";
import { CARD_TONE, renderCard, type Card, type CardTheme } from "../lib/shell-card.ts";
import { CommandPalette, commandsKey, type CommandPaletteResult } from "../lib/command-palette.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { VisualCustomizeView, type CustomizeCategory, type CustomizeRow, type ProfileActions } from "../lib/visual-customize-view.ts";
import { deleteVisualProfile, getVisualProfile, listVisualProfiles, resetVisualProfiles, saveVisualProfile } from "../lib/visual-profiles.ts";
import { sourcePalettePreview } from "../lib/theme-customization.ts";
import { DEFAULT_VISUAL_SETTINGS, DENSITY, HEADER_PLACEMENT, STATUS_PLACEMENT, resolveVisualSettings, writeVisualSettings } from "../lib/visual-customization-policy.ts";
import { BANNER_COLORS, DEFAULT_BANNER_CONFIG, readBannerConfig, readBannerConfigForEdit, writeBannerConfig } from "./startup-banner.ts";
import { agentsViewKey } from "../lib/agents-keys.ts";
import { GentleAiDevBinaryOverrideError, resolveGentleAiDevBinaryOverride } from "../lib/gentle-ai-binary.ts";
import { DOUBLE_ESC_CANCEL_HINT, framePromptLines, IDLE_ESC_CLEAR_HINT, PROMPT_HINT, PROMPT_STATE, SHELL_PULSE_MS, withPromptHint, type PromptState } from "../lib/shell-prompt.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { resolveAnimationPolicy, writeAnimationPolicy, type AnimationPolicy } from "../lib/animation-policy.ts";
import { resolveVimPolicy, writeVimPolicy, type VimPolicy } from "../lib/vim-policy.ts";
import { createRequire } from "node:module";
import { createVimEditorAdapter } from "../lib/vim-editor-adapter.ts";
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
	// The 0.87.1 CLI uses the bundled virtual module graph. Its public index
	// exports the very CustomEditor class supplied to extensions by that graph.
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
					if (metadata.name === "@earendil-works/pi-coding-agent" && metadata.version === "0.87.1" &&
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
				(agentMetadata.version === "0.85.1" || agentMetadata.version === "0.87.1") &&
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
import { accountIdFromToken, CODEX_PROVIDER, CODEX_USAGE_URL, NAN_PROVIDER, NAN_QUOTA_URL, parseCodexUsage, parseNanQuota, parseProviderUsage, parseUsageHeaders, parseUsageSource, UsageSourceRegistry, UsageStore, USAGE_SOURCE_EVENT, type ProviderUsage, type UsageSource } from "../lib/shell-usage.ts";
import { UsageView } from "../lib/shell-usage-view.ts";
import { sidebarHeader, sidebarPart, sidebarState, VISUAL_SETTINGS_CHANGED } from "../lib/shell-sidebar.ts";
import { installSidebar, invalidateSidebar, narrowStatusOwner, STATUS_OWNER } from "../lib/shell-sidebar-layout.ts";
import { SessionChanges, SESSION_CHANGE_EVENT } from "../lib/session-changes.ts";
import { installSessionChangeCapture } from "../lib/session-change-capture.ts";
import { withOverlayRepaint } from "../lib/overlay-repaint.ts";

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
	gitRunner(cwd: string): GitRunner;
	vimRuntimeVersion?(): string | undefined;
}

export type ActiveProfileReader = (() => string | undefined) & {
	bind(cwd: string, resolveWorktree: WorktreeResolver): boolean;
	refresh(): boolean;
	reset(): void;
};

// Unbound reads retain the global file-identity cache, including atomic replacements.
// Bound reads are snapshots: no filesystem or Git work is done during a frame.
export function createActiveProfileReader(env: NodeJS.ProcessEnv = process.env): ActiveProfileReader {
	const path = profilesFilePath(env.GENTLE_PI_CONFIG_HOME ?? join(os.homedir(), ".pi", "gentle-ai"));
	let fingerprint: string | undefined;
	let name: string | undefined;
	let bound = false;
	let cwd: string | undefined;
	let identity: WorktreeIdentity | undefined;
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
		const pin = identity && cwd ? resolveProfilePin({
			cwd,
			configHome: env.GENTLE_PI_CONFIG_HOME ?? join(os.homedir(), ".pi", "gentle-ai"),
			resolveWorktree: () => identity!,
		}) : undefined;
		const next = pin ? `${pin.profile} (${pin.source})` : global();
		const changed = next !== effective;
		effective = next;
		return changed;
	};
	reader.bind = (nextCwd, resolveWorktree) => {
		reader.reset();
		cwd = nextCwd;
		try { identity = resolveWorktree(nextCwd, nextCwd); } catch { identity = undefined; }
		bound = true;
		return reader.refresh();
	};
	reader.reset = () => { bound = false; cwd = undefined; identity = undefined; effective = undefined; };
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

const defaultShellDeps: Omit<ShellDeps, "activeProfile"> = { fetch: (...args) => globalThis.fetch(...args), now: () => Date.now(), devBinary: ambientDevBinary, resolveWorktree: resolveSessionWorktree, gitRunner: shellGitRunner };

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

export function buildShellBarModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	footerData: ShellFooterData,
	options: BuildOptions = {},
): ShellBarModel {
	const home = options.home ?? os.homedir();
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	const statuses = Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text);
	return {
		cwd: shortenHome(ctx.sessionManager.getCwd(), home),
		profile: options.profile,
		branch: footerData.getGitBranch(),
		dirty: options.dirty,
		sessionName: ctx.sessionManager.getSessionName(),
		modelId: model?.id ?? "no-model",
		effort: model?.reasoning ? pi.getThinkingLevel() : undefined,
		contextPercent: usage?.percent ?? null,
		contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
		costTotal: sessionCost(ctx),
		subscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
		usage: options.usage,
		statuses,
	};
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
			return renderShellBar(buildShellBarModel(pi, ctx, footerData, { dirty: dirty(), usage: usage() }), theme, width, presentation?.());
		},
		invalidate() {},
		dispose() {
			unsubscribe();
		},
	};
}

interface PromptEditorDeps {
	fg: (color: string, text: string) => string;
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
	private pulse: NodeJS.Timeout | undefined;
	private readonly deps: PromptEditorDeps;
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

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, deps: PromptEditorDeps) {
		super(tui, theme, keybindings);
		this.deps = deps;
		this.keybindingsManager = keybindings;
	}

	setAnimationPolicy(policy: AnimationPolicy): void {
		if (this.animationPolicy === policy) return;
		this.animationPolicy = policy;
		this.stopPulse();
		if (this.promptState === PROMPT_STATE.WORKING) this.startPulse();
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

	private startPulse(): void {
		if (this.animationPolicy === "potato") return;
		this.pulse = setInterval(() => {
			this.tick += 1;
			this.deps.requestRender();
		}, this.animationPolicy === "performance" ? 1000 : SHELL_PULSE_MS);
		this.pulse.unref();
	}

	setWorking(working: boolean): void {
		this.promptState = working ? PROMPT_STATE.WORKING : PROMPT_STATE.IDLE;
		this.stopPulse();
		if (!working) {
			this.pendingEscapeCancelDeadline = undefined;
		} else {
			this.pendingIdleClearDeadline = undefined;
			this.pendingIdleClearText = undefined;
			this.startPulse();
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
		// Any keystroke that is not the confirming Esc ends the pending idle
		// clear, even one that leaves the text identical (type, then delete).
		if (this.pendingIdleClearDeadline !== undefined && !this.keybindingsManager.matches(data, "app.interrupt")) {
			this.pendingIdleClearDeadline = undefined;
			this.pendingIdleClearText = undefined;
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

	render(width: number): string[] {
		const lines = super.render(Math.max(1, width - 2));
		if (this.getText() === "" && lines.length === 3) lines[1] = withPromptHint(lines[1], PROMPT_HINT, this.deps.fg);
		const state = this.promptState === PROMPT_STATE.WORKING && this.deps.pending() ? PROMPT_STATE.QUEUED : this.promptState;
		// The frame keeps the theme's border color rather than pi's thinking-level
		// color, so the prompt reads as one panel with the cards around it.
		// Selection is applied only to the owned Pi editor rows, before Gentle
		// frames them. No second editor factory or private layout mutation.
		let editorLines = lines;
		if (this.vimPolicy === "on" && this.vimVisual.active) {
			try {
				const adapter = this.vimAdapter();
				const range = this.vimVisual.range(this.getText(), this.getCursor(), adapter.motionBoundaries());
				if (range) editorLines = adapter.renderSelection(Math.max(1, width - 2), range.start, range.end, lines);
			} catch { /* Unknown layout: keep the original rendered prompt. */ }
		}
		const visibleCount = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
		const borderEnd = Number.isInteger(visibleCount) && visibleCount! >= 1 && visibleCount! + 2 <= editorLines.length
			? visibleCount! + 2 : editorLines.length;
		const framed = framePromptLines(editorLines.slice(0, borderEnd), width, {
			state,
			tick: this.tick,
			borderColor: (text) => this.deps.fg(PROMPT_FRAME_ROLE, text),
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
		});
		// Pi places autocomplete after its bottom border. Keep those rows below
		// Gentle's frame and preserve their terminal width and row coordinates.
		for (const line of editorLines.slice(borderEnd)) {
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
		this.stopPulse();
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

	private stopPulse(): void {
		if (this.pulse) clearInterval(this.pulse);
		this.pulse = undefined;
		this.tick = 0;
	}
}

// Stable across extension module reloads; never infer ownership from a name.
const PROMPT_OWNER = Symbol.for("gentle-pi.prompt-owner");
type PromptFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>> & { [PROMPT_OWNER]?: boolean };

function installPrompt(
	ctx: ExtensionContext,
	onCreated: (prompt: GentlePromptEditor) => void,
	promptDeps: { now: () => number; doubleEscCancelEnabled: () => boolean; dispatchQueuedText: (text: string) => void; vimRuntimeVersion?: () => string | undefined },
): boolean {
	const previous = ctx.ui.getEditorComponent() as PromptFactory | undefined;
	if (previous && !previous[PROMPT_OWNER]) return false;
	const factory: PromptFactory = (tui, theme, keybindings) => {
		const prompt = new GentlePromptEditor(tui, theme, keybindings, {
			fg: (color, text) => ctx.ui.theme.fg(color as Parameters<typeof ctx.ui.theme.fg>[0], text),
			bold: (text) => ctx.ui.theme.bold(text),
			requestRender: () => tui.requestRender(),
			pending: () => ctx.hasPendingMessages(),
			now: promptDeps.now,
			doubleEscCancelEnabled: promptDeps.doubleEscCancelEnabled,
			dispatchQueuedText: promptDeps.dispatchQueuedText,
			notifyCompatibility: (message) => ctx.ui.notify(message, "warning"),
			tuiVersion: promptDeps.vimRuntimeVersion,
			workingLabel: () => oddPhaseRegistry.label(ctx.sessionManager.getSessionId()),
		});
		// Pi's own docs require an explicit requestRender() after a state change
		// (docs/tui.md: "Call tui.requestRender() after state changes"); no host
		// re-render is implicitly guaranteed, and the WORKING pulse loop does not
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
const OVERLAY_HEIGHT_RATIO = 0.8;
const OVERLAY_MIN_ROWS = 8;

export function shellGitRunner(cwd: string, env: NodeJS.ProcessEnv = process.env, run: typeof execFile = execFile): GitRunner {
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
			maxBuffer: Infinity,
		}, (error, stdout) => {
			resolve({ stdout, code: error ? typeof error.code === "number" ? error.code : 1 : 0 });
		});
	});
}

export async function loadFileDiff(git: GitRunner, file: ChangedFile): Promise<string> {
	const args = file.status === CHANGE_STATUS.UNTRACKED ? ["diff", "--no-index", "--", "/dev/null", file.path] : ["diff", "HEAD", "--", file.path];
	const result = await git(args);
	return result.code === 0 || result.code === 1 ? result.stdout : "";
}

export interface ExternalEditorHost {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

export function openInExternalEditor(host: ExternalEditorHost, path: string, env: NodeJS.ProcessEnv = process.env, spawn: typeof spawnSync = spawnSync, cwd?: string): boolean {
	const command = env.VISUAL || env.EDITOR;
	if (!command) return false;
	const [editor, ...editorArgs] = command.split(" ");
	host.stop();
	try {
		spawn(editor, [...editorArgs, path], { cwd, stdio: "inherit", shell: process.platform === "win32" });
	} finally {
		host.start();
		host.requestRender(true);
	}
	return true;
}

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

function changesFingerprint(model: ChangesModel): string {
	return [model.notice ?? "", ...model.files.map((file) => `${file.path}:${file.status}:${file.added}:${file.deleted}:${file.diffRevision ?? ""}:${file.countsUnavailable ?? ""}`)].join("|");
}

interface OverlayDeps {
	loadDiff(root: string, file: ChangedFile): string;
	worktrees(): WorktreeChanges[];
	refresh(): Promise<ChangesModel>;
	apply(ctx: ExtensionContext, model: ChangesModel): void;
	pollMs: number;
	gitForRoot(root: string): GitRunner;
}

// Refresh only the captured session model. Never read live files here; the
// only Git the overlay touches is each root's HEAD, to label its tree.
async function showChangesOverlay(ctx: ExtensionContext, deps: OverlayDeps): Promise<void> {
	let host: ExternalEditorHost | undefined;
	let view: WorktreeChangesView | undefined;
	// Session evidence knows roots, not branches; label them while the overlay
	// is open and repaint when Git answers.
	const labels = new RootBranchLabels(deps.gitForRoot, () => {
		view?.update(labels.decorate(deps.worktrees()));
		host?.requestRender();
	});
	const worktrees = () => labels.decorate(deps.worktrees());
	const refresh = async () => {
		const latest = await deps.refresh();
		view?.update(worktrees());
		deps.apply(ctx, latest);
	};
	const poll = setInterval(() => void refresh(), deps.pollMs);
	poll.unref();
	try {
		const chosen = await ctx.ui.custom<{ root: string; file: ChangedFile } | null>(
			(tui, theme, _keybindings, done) => {
				const close = withOverlayRepaint(tui, done);
				host = tui;
				view = new WorktreeChangesView(worktrees(), {
					theme,
					rows: () => Math.max(OVERLAY_MIN_ROWS, Math.floor(tui.terminal.rows * OVERLAY_HEIGHT_RATIO)),
					loadDiff: (root, file) => Promise.resolve(deps.loadDiff(root, file)),
					onOpen: (root, file) => close({ root, file }),
					onRefresh: () => void refresh(),
					onClose: () => close(null),
					requestRender: () => tui.requestRender(),
				});
				return view;
			},
			{ overlay: true, overlayOptions: { width: "92%", anchor: "center" } },
		);
		if (!chosen || !host) return;
		if (!openInExternalEditor(host, chosen.file.path, process.env, spawnSync, chosen.root)) ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
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

function showChanges(ctx: ExtensionContext, model: ChangesModel, visible = true): void {
	if (!visible || model.files.length === 0) {
		ctx.ui.setWidget(CHANGES_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(
		CHANGES_WIDGET_KEY,
		(tui, theme) => sidebarPart(tui, "changes", {
			render(width: number) {
				return renderChangesWidget(model, theme, width);
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

export function devBinaryCard(notice: DevBinaryNotice): Card {
	if (notice.state === "invalid") {
		return { title: "Gentle AI", subtitle: "dev binary override invalid", body: [notice.reason], tone: CARD_TONE.ERROR };
	}
	return {
		title: "Gentle AI",
		subtitle: "dev binary override · field-test only",
		body: [`${notice.path} · sha256:${notice.sha256.slice(0, SHA_PREFIX_LENGTH)}`],
		tone: CARD_TONE.WARNING,
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

export default function gentleShell(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, overrides: Partial<ShellDeps> = {}): void {
	installSessionChangeCapture(pi, env, overrides.resolveWorktree ?? resolveSessionWorktree);
	if (!shellEnabled(env)) return;
	const profileReader = createActiveProfileReader(env);
	const deps: ShellDeps = { ...defaultShellDeps, activeProfile: profileReader, ...overrides };
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
	const refreshUsage = async (ctx: ExtensionContext, force: boolean) => {
		const provider = ctx.model?.provider;
		if (!provider) return;
		const source = usageSources.get(provider);
		if (!source && provider !== CODEX_PROVIDER && provider !== NAN_PROVIDER) return;
		const now = deps.now();
		if (!force && now - (usageFetchedAt.get(provider) ?? 0) < USAGE_REFRESH_MS) return;
		usageFetchedAt.set(provider, now);
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider).catch(() => undefined);
		const fetched = source
			? await fetchFromSource(source, apiKey, deps.fetch, deps.now())
			: provider === NAN_PROVIDER
				? await fetchNanUsage(apiKey, deps.fetch, deps.now())
				: await fetchCodexUsage(apiKey, deps.fetch, deps.now());
		if (!fetched) return;
		// A registered source can be replaced while its own fetch is still in
		// flight; the identity captured above is this call's source, so a stale
		// answer that outlives its replacement is discarded instead of
		// overwriting whatever the replacement already recorded.
		if (source && usageSources.get(provider) !== source) return;
		usage.record(fetched);
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
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
		if (currentContext?.model?.provider === source.provider) void refreshUsage(currentContext, true);
	});
	pi.on("after_provider_response", (event) => {
		const parsed = parseUsageHeaders(event.headers, deps.now());
		if (!parsed) return;
		usage.record(parsed);
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	});
	pi.registerMessageRenderer(REVIEW_PREFLIGHT_TYPE, (message, options, theme) => {
		const body = messageText(message.content as string | Array<{ type: string; text?: string }>).split("\n");
		const hint = keyHint("app.tools.expand", options.expanded ? "collapse" : "expand");
		return cardComponent({ title: "Gentle AI", subtitle: "review preflight", body, tone: CARD_TONE.INFO }, theme, { expanded: options.expanded, hint });
	});
	const openUsage = async (ctx: ExtensionContext) => {
		await refreshUsage(ctx, true);
		await ctx.ui.custom<null>(
			(tui, theme, _keybindings, done) =>
				new UsageView(usage, {
					theme,
					now: () => deps.now(),
					active: () => (ctx.model ? { provider: ctx.model.provider } : undefined),
					registry: () => usageSources,
					onRefresh: () => refreshUsage(ctx, true),
					onClose: () => withOverlayRepaint(tui, done)(null),
					requestRender: () => tui.requestRender(),
				}),
			{ overlay: true, overlayOptions: { width: "70%", minWidth: 60, anchor: "center" } },
		);
	};
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
	const refreshVisual = () => {
		visualSettings = resolveVisualSettings(animationOptions).settings;
		if (currentContext && changes) showChanges(currentContext, changes.model, visualSettings.visibility.changes);
		if (sidebarTui?.terminal) sidebarState(sidebarTui).visibility = { todo: visualSettings.visibility.todo };
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	};
	let doubleEscCancelPolicy: DoubleEscCancelPolicy = resolveDoubleEscCancelPolicy({
		env,
		gentlePiConfigHome: doubleEscCancelConfigHome,
	}).policy;
	let changes: SessionChanges | undefined;
	let registry: SessionWorktreeRegistry | undefined;
	let currentContext: ExtensionContext | undefined;
	let shown = "";
	const applyChanges = (ctx: ExtensionContext, model: ChangesModel) => {
		const fingerprint = changesFingerprint(model);
		if (fingerprint === shown) return;
		shown = fingerprint;
		showChanges(ctx, model, visualSettings.visibility.changes);
	};
	const refreshChanges = async (ctx: ExtensionContext) => {
		const tracker = changes;
		if (!tracker || !ctx.hasUI || registry?.sessionId !== ctx.sessionManager.getSessionId()) return;
		tracker.restore(ctx.sessionManager.getEntries());
		const model = await tracker.refresh();
		if (changes === tracker) applyChanges(ctx, model);
	};
	const unsubscribeWorktrees = pi.events.on(SESSION_CHANGE_EVENT, (data) => {
		if (!currentContext || !registry || (data as { sessionId?: string } | undefined)?.sessionId !== registry.sessionId) return;
		const notice = (data as { notice?: string } | undefined)?.notice;
		if (notice) { if (changes) changes.notice = notice; currentContext.ui.notify(notice, "warning"); }
		void refreshChanges(currentContext);
	});
	pi.registerTool({
		name: "session_worktree_register",
		renderShell: "self",
		label: "Register session worktree",
		description: "Register a worktree in the same Git clone for session coordination. Registration does not attribute file changes; Changes shows captured write/edit operations only.",
		parameters: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", description: "Worktree path to include in this session." } } } as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!registry || registry.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("No active session worktree registry.");
			const root = registry.register((params as { path: string }).path, "explicit");
			await refreshChanges(ctx);
			return { content: [{ type: "text", text: `Registered session worktree: ${root}` }], details: { root, sessionId: registry.sessionId } };
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		stopProfilePoll();
		registry?.close();
		currentContext = ctx;
		changes = undefined;
		registry = new SessionWorktreeRegistry(pi, ctx.sessionManager, ctx.cwd, deps.resolveWorktree);
		registry.start();
		if (!ctx.hasUI) return;
		visualSettings = resolveVisualSettings(animationOptions).settings;
		if (!overrides.activeProfile) {
			profileReader.bind(ctx.cwd, deps.resolveWorktree);
			const sessionId = ctx.sessionManager.getSessionId();
			profilePoll = setInterval(() => {
				if (currentContext !== ctx || ctx.sessionManager.getSessionId() !== sessionId) return;
				if (!profileReader.refresh()) return;
				renderHost?.invalidateSidebar?.();
				renderHost?.requestRender();
			}, 2_000);
			profilePoll.unref?.();
		}
		changes = new SessionChanges(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries());
		const tracker = changes;
		ctx.ui.setFooter((tui, theme, footerData) => {
			sidebarTui = tui;
			if (tui.terminal) sidebarState(tui).visibility = { todo: visualSettings.visibility.todo };
			renderHost = { requestRender: () => tui.requestRender(), invalidateSidebar: () => invalidateSidebar(tui) };
			const bottom = createShellBarComponent(pi, ctx, renderHost, theme, footerData, () => tracker.model.files.length, () => usage.get(ctx.model?.provider ?? ""), () => visualSettings);
			// The Status card paints live session state that no event re-registers a
			// part for: model, effort, context, cost, session name and extension
			// statuses. The digest is what keeps the fullscreen memo honest, and it
			// rebuilds the model exactly as the narrow bottom bar does every frame.
			const footerModel = (): ShellBarModel => ({
				...buildShellBarModel(pi, ctx, footerData, { dirty: tracker.model.files.length, usage: usage.get(ctx.model?.provider ?? ""), profile: deps.activeProfile() }),
				changes: { files: tracker.model.files.length, added: tracker.model.added, deleted: tracker.model.deleted, notice: tracker.model.notice },
			});
			// At narrow fullscreen widths only one status row paints: a top header
			// suppresses the bottom bar in the layout, and otherwise the bottom bar
			// takes over the header's data while the below-input header steps aside.
			const statusOwner = () => narrowStatusOwner({ mode: (tui as TUI & { mode?: string }).mode, columns: tui.terminal?.columns ?? 0, statusPlacement: visualSettings.statusPlacement, headerPlacement: visualSettings.headerPlacement });
			const bottomBar = { ...bottom, render: (width: number) => statusOwner() === STATUS_OWNER.BOTTOM ? renderShellBottomOnlyBar(footerModel(), theme, width, usageShortcutKey, visualSettings) : bottom.render(width) };
			const part = sidebarPart(tui, "footer", bottomBar, {
				digest: () => JSON.stringify([footerModel(), visualSettings]),
				render: (width) => renderShellSidebarBar(footerModel(), theme, width, visualSettings),
				invalidate() {},
			});
			// The header row carries everything that ticks every frame (model,
			// effort, context, cost, usage) plus session identity; it never sees
			// extension statuses or the working/thinking state.
			const headerBar = (width: number) => renderShellHeaderBar(buildShellHeaderModel(footerModel()), theme, width, usageShortcutKey, visualSettings);
			const disposeHeader = sidebarHeader(tui, {
				digest: () => JSON.stringify([buildShellHeaderModel(footerModel()), visualSettings]),
				render: (width) => [headerBar(width).text, renderShellHeaderRule(theme, width)],
				invalidate() {},
				handleMouse(event) {
					if (event.type !== "click" || event.button !== "left") return undefined;
					if (event.y !== 0) return undefined; // the rule row under the status line is decorative, never clickable
					const { usageSpan } = headerBar(event.width);
					if (!usageSpan || event.x < usageSpan.start || event.x >= usageSpan.end) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			});
			const uninstall = installSidebar(tui, theme, () => visualSettings.statusPlacement, () => visualSettings.headerPlacement, () => visualSettings.density);
			// The public widget slot follows the editor even when the rail is absent.
			const belowHeader = () => visualSettings.headerPlacement === "below-input" && (tui as TUI & { mode?: string }).mode === "fullscreen" && statusOwner() !== STATUS_OWNER.BOTTOM;
			ctx.ui.setWidget(HEADER_WIDGET_KEY, () => ({
				render(width: number) { return belowHeader() ? [headerBar(width).text, renderShellHeaderRule(theme, width)] : []; },
				invalidate() {},
				handleMouse(event) {
					if (!belowHeader() || event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
					const span = headerBar(event.width).usageSpan;
					if (!span || event.x < span.start || event.x >= span.end) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			}), { placement: "belowEditor" });
			return { ...part, dispose() { ctx.ui.setWidget(HEADER_WIDGET_KEY, undefined); disposeHeader(); uninstall(); part.dispose(); if (sidebarTui === tui) sidebarTui = undefined; } };
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
			{ now: () => deps.now(), doubleEscCancelEnabled: () => doubleEscCancelPolicy === "on", dispatchQueuedText: (text) => { pendingQueuedText = pendingQueuedText === undefined ? text : `${pendingQueuedText}\n\n${text}`; }, vimRuntimeVersion: deps.vimRuntimeVersion },
		);
		// Hide native feedback only when our petal replaces it. Native transcript
		// thinking blocks remain Pi-owned; this changes only the supported loader UI.
		if (ownsPrompt) ctx.ui.setWorkingVisible(false);
		const notice = deps.devBinary();
		ctx.ui.setWidget(
			DEV_BINARY_WIDGET_KEY,
			notice
				? (_tui, theme) => spaced(cardComponent(devBinaryCard(notice), theme, { expanded: true }))
				: undefined,
		);
		if (changes !== tracker) return;
		shown = "";
		applyChanges(ctx, tracker.model);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopProfilePoll();
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		oddPhaseRegistry.clearRenderRequest(ctx.sessionManager.getSessionId());
		pendingQueuedText = undefined;
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
		unsubscribeWorktrees();
	});
	const openChanges = async (ctx: ExtensionContext) => {
		if (!changes) return;
		const tracker = changes;
		const model = await tracker.refresh();
		if (model.files.length === 0) {
			ctx.ui.notify("No captured agent changes. Only successful write/edit operations from this session and its subagents are shown; shell changes are not attributed.", "info");
			return;
		}
		await showChangesOverlay(ctx, { loadDiff: (root, file) => tracker.loadDiff(root, file), worktrees: () => tracker.worktrees, refresh: () => tracker.refresh(), apply: applyChanges, pollMs: changesPollMs(env), gitForRoot: (root) => deps.gitRunner(root) });
	};
	pi.registerCommand(CHANGES_COMMAND_NAME, {
		description: "Browse captured write/edit changes from this agent session and its subagents, excluding preexisting and external edits. Shell changes are not attributed. Press o to open $EDITOR.",
		handler: async (_args, ctx) => openChanges(ctx),
	});
	const shortcut = changesShortcut(env);
	if (shortcut) {
		pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Open captured agent session changes",
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
	pi.registerCommand("gentle:customize", {
		description: "Configure animations, banner, themes, layout and global Vim prompt editing.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				if (ctx.hasUI) ctx.ui.notify("Visual customization requires an interactive terminal.", "warning");
				return;
			}
			const home = { gentlePiConfigHome: doubleEscCancelConfigHome };
			const rows: CustomizeRow[] = [];
			const bannerHome = doubleEscCancelConfigHome;
			let banner = await readBannerConfig(bannerHome);
			let activeTheme = ctx.ui.theme.name;
			let customizeView: VisualCustomizeView | undefined;
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
			category = "Layout";
			for (const value of Object.values(STATUS_PLACEMENT)) add(() => `Status placement: ${value}${visual().statusPlacement === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, statusPlacement: value })), () => layoutPreview({ ...visual(), statusPlacement: value }));
			for (const value of Object.values(HEADER_PLACEMENT)) add(() => `Header placement: ${value}${visual().headerPlacement === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, headerPlacement: value })), () => layoutPreview({ ...visual(), headerPlacement: value }));
			for (const value of Object.values(DENSITY)) add(() => `Density: ${value}${visual().density === value ? " (current)" : ""}`, pending, () => updateVisual((settings) => ({ ...settings, density: value })), () => layoutPreview({ ...visual(), density: value }));
			category = "Sections";
			for (const key of ["changes", "agents", "todo", "usageCost", "modelDetails"] as const) add(
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
			await ctx.ui.custom<null>((tui, theme, _keys, done) => {
				customizeView = new VisualCustomizeView({ rows, profiles, theme, requestRender: () => tui.requestRender(), rowsAvailable: () => Math.max(0, Math.floor(tui.terminal.rows * 0.85) - 2), onError: (error) => ctx.ui.notify(`Visual customization: ${error.message}`, "error"), onClose: () => done(null) });
				return customizeView;
			}, { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } });
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
		// previous turn must never leak into this one. The orchestrator
		// reports the new turn's phase explicitly once it knows it.
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		prompt?.setWorking(true);
		// The dev-binary card is a startup notice: it leaves with the first prompt.
		if (ctx.hasUI) ctx.ui.setWidget(DEV_BINARY_WIDGET_KEY, undefined);
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
		await refreshChanges(ctx);
		void refreshUsage(ctx, false);
	});
}
