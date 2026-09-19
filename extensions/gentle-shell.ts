import { CustomEditor, keyHint, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { execFile, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { profilesFilePath, readProfilesFileResult } from "../lib/agent-profiles.ts";
import * as os from "node:os";
import { join } from "node:path";
import { buildShellHeaderModel, renderShellBar, renderShellHeaderBar, renderShellSidebarBar, shellEnabled, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { CHANGE_STATUS, RootBranchLabels, renderChangesWidget, type ChangedFile, type ChangesModel, type GitRunner, type WorktreeChanges } from "../lib/shell-changes.ts";
import { WorktreeChangesView } from "../lib/shell-changes-view.ts";
import { SessionWorktreeRegistry, resolveSessionWorktree, worktreeGitEnvironment, type WorktreeResolver } from "../lib/session-worktree-registry.ts";
import { CARD_TONE, renderCard, type Card, type CardTheme } from "../lib/shell-card.ts";
import { CommandPalette, commandsKey, type CommandPaletteResult } from "../lib/command-palette.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { agentsViewKey } from "../lib/agents-keys.ts";
import { GentleAiDevBinaryOverrideError, resolveGentleAiDevBinaryOverride } from "../lib/gentle-ai-binary.ts";
import { DOUBLE_ESC_CANCEL_HINT, framePromptLines, IDLE_ESC_CLEAR_HINT, PROMPT_HINT, PROMPT_STATE, SHELL_PULSE_MS, withPromptHint, type PromptState } from "../lib/shell-prompt.ts";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import {
	DOUBLE_ESC_CANCEL_WINDOW_MS,
	resolveDoubleEscCancelPolicy,
	writeDoubleEscCancelPolicy,
	type DoubleEscCancelPolicy,
	type DoubleEscCancelResolution,
} from "../lib/double-esc-cancel-policy.ts";
import { accountIdFromToken, CODEX_PROVIDER, CODEX_USAGE_URL, NAN_PROVIDER, NAN_QUOTA_URL, parseCodexUsage, parseNanQuota, parseUsageHeaders, UsageStore, type ProviderUsage } from "../lib/shell-usage.ts";
import { UsageView } from "../lib/shell-usage-view.ts";
import { sidebarHeader, sidebarPart } from "../lib/shell-sidebar.ts";
import { installSidebar, invalidateSidebar } from "../lib/shell-sidebar-layout.ts";
import { SessionChanges, SESSION_CHANGE_EVENT } from "../lib/session-changes.ts";
import { installSessionChangeCapture } from "../lib/session-change-capture.ts";

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
}

// The rail digest runs every frame. Cache parsing by file identity and metadata,
// not just mtime: profile writes replace the store atomically. Keep the cache
// local to this shell instance and recheck on the next frame after panel edits.
export function createActiveProfileReader(env: NodeJS.ProcessEnv = process.env): () => string | undefined {
	const path = profilesFilePath(env.GENTLE_PI_CONFIG_HOME ?? join(os.homedir(), ".pi", "gentle-ai"));
	let fingerprint: string | undefined;
	let name: string | undefined;
	return () => {
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
): ShellBarComponent {
	const unsubscribe = footerData.onBranchChange(() => {
		host.invalidateSidebar?.();
		host.requestRender();
	});
	return {
		render(width: number) {
			return renderShellBar(buildShellBarModel(pi, ctx, footerData, { dirty: dirty(), usage: usage() }), theme, width);
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
}

const PROMPT_FRAME_ROLE = "border";
// Matches Pi's own idle double-Esc window (empty editor -> /tree or /fork);
// this is the same muscle memory applied to clearing a non-empty draft.
const IDLE_ESC_CLEAR_WINDOW_MS = 500;

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

	setWorking(working: boolean): void {
		this.promptState = working ? PROMPT_STATE.WORKING : PROMPT_STATE.IDLE;
		this.stopPulse();
		if (!working) {
			this.pendingEscapeCancelDeadline = undefined;
		} else {
			this.pendingIdleClearDeadline = undefined;
			this.pendingIdleClearText = undefined;
			this.pulse = setInterval(() => {
				this.tick += 1;
				this.deps.requestRender();
			}, SHELL_PULSE_MS);
			this.pulse.unref();
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
		return framePromptLines(lines, width, {
			state,
			tick: this.tick,
			borderColor: (text) => this.deps.fg(PROMPT_FRAME_ROLE, text),
			fg: this.deps.fg,
			bold: this.deps.bold,
			escHint: this.promptState === PROMPT_STATE.WORKING && this.isPendingEscapeCancel()
				? DOUBLE_ESC_CANCEL_HINT
				: this.promptState === PROMPT_STATE.IDLE && this.isPendingIdleClear()
					? IDLE_ESC_CLEAR_HINT
					: undefined,
		});
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
	promptDeps: { now: () => number; doubleEscCancelEnabled: () => boolean; dispatchQueuedText: (text: string) => void },
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
		});
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
				host = tui;
				view = new WorktreeChangesView(worktrees(), {
					theme,
					rows: () => Math.max(OVERLAY_MIN_ROWS, Math.floor(tui.terminal.rows * OVERLAY_HEIGHT_RATIO)),
					loadDiff: (root, file) => Promise.resolve(deps.loadDiff(root, file)),
					onOpen: (root, file) => done({ root, file }),
					onRefresh: () => void refresh(),
					onClose: () => done(null),
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
		(tui, theme, _keybindings, done) => new CommandPalette(groups, done, theme, () => Math.max(0, tui.terminal.rows)),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } },
	);
	if (result?.type === "run") pi.sendUserMessage(`/${result.name}`, { expandPromptTemplates: true });
}

function showChanges(ctx: ExtensionContext, model: ChangesModel): void {
	if (model.files.length === 0) {
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

export default function gentleShell(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, overrides: Partial<ShellDeps> = {}): void {
	installSessionChangeCapture(pi, env, overrides.resolveWorktree ?? resolveSessionWorktree);
	if (!shellEnabled(env)) return;
	const deps: ShellDeps = { ...defaultShellDeps, activeProfile: createActiveProfileReader(env), ...overrides };
	const usage = new UsageStore();
	let renderHost: ShellRenderHost | undefined;
	// The 5-minute rule is per provider: one provider's fetch cannot leave the
	// next one waiting for an interval it never used.
	const usageFetchedAt = new Map<string, number>();
	const refreshUsage = async (ctx: ExtensionContext, force: boolean) => {
		const provider = ctx.model?.provider;
		if (provider !== CODEX_PROVIDER && provider !== NAN_PROVIDER) return;
		const now = deps.now();
		if (!force && now - (usageFetchedAt.get(provider) ?? 0) < USAGE_REFRESH_MS) return;
		usageFetchedAt.set(provider, now);
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider).catch(() => undefined);
		const fetched = provider === NAN_PROVIDER ? await fetchNanUsage(apiKey, deps.fetch, deps.now()) : await fetchCodexUsage(apiKey, deps.fetch, deps.now());
		if (!fetched) return;
		usage.record(fetched);
		renderHost?.invalidateSidebar?.();
		renderHost?.requestRender();
	};
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
					onRefresh: () => refreshUsage(ctx, true),
					onClose: () => done(null),
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
		showChanges(ctx, model);
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
		registry?.close();
		currentContext = ctx;
		changes = undefined;
		registry = new SessionWorktreeRegistry(pi, ctx.sessionManager, ctx.cwd, deps.resolveWorktree);
		registry.start();
		if (!ctx.hasUI) return;
		changes = new SessionChanges(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries());
		const tracker = changes;
		ctx.ui.setFooter((tui, theme, footerData) => {
			renderHost = { requestRender: () => tui.requestRender(), invalidateSidebar: () => invalidateSidebar(tui) };
			const bottom = createShellBarComponent(pi, ctx, renderHost, theme, footerData, () => tracker.model.files.length, () => usage.get(ctx.model?.provider ?? ""));
			// The Status card paints live session state that no event re-registers a
			// part for: model, effort, context, cost, session name and extension
			// statuses. The digest is what keeps the fullscreen memo honest, and it
			// rebuilds the model exactly as the narrow bottom bar does every frame.
			const footerModel = (): ShellBarModel => ({
				...buildShellBarModel(pi, ctx, footerData, { dirty: tracker.model.files.length, usage: usage.get(ctx.model?.provider ?? ""), profile: deps.activeProfile() }),
				changes: { files: tracker.model.files.length, added: tracker.model.added, deleted: tracker.model.deleted, notice: tracker.model.notice },
			});
			const part = sidebarPart(tui, "footer", bottom, {
				digest: () => JSON.stringify(footerModel()),
				render: (width) => renderShellSidebarBar(footerModel(), theme, width),
				invalidate() {},
			});
			// The header row carries everything that ticks every frame (model,
			// effort, context, cost, usage) plus session identity; it never sees
			// extension statuses or the working/thinking state.
			const headerBar = (width: number) => renderShellHeaderBar(buildShellHeaderModel(footerModel()), theme, width, usageShortcutKey);
			const disposeHeader = sidebarHeader(tui, {
				digest: () => JSON.stringify(buildShellHeaderModel(footerModel())),
				render: (width) => [headerBar(width).text],
				invalidate() {},
				handleMouse(event) {
					if (event.type !== "click" || event.button !== "left") return undefined;
					const { usageSpan } = headerBar(event.width);
					if (!usageSpan || event.x < usageSpan.start || event.x >= usageSpan.end) return undefined;
					void openUsage(ctx);
					return { handled: true, render: true };
				},
			});
			const uninstall = installSidebar(tui, theme);
			return { ...part, dispose() { disposeHeader(); uninstall(); part.dispose(); } };
		});
		void refreshUsage(ctx, true);
		const ownsPrompt = installPrompt(
			ctx,
			(created) => {
				prompt?.dispose();
				prompt = created;
			},
			{ now: () => deps.now(), doubleEscCancelEnabled: () => doubleEscCancelPolicy === "on", dispatchQueuedText: (text) => { pendingQueuedText = pendingQueuedText === undefined ? text : `${pendingQueuedText}\n\n${text}`; } },
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
		prompt?.setWorking(true);
		// The dev-binary card is a startup notice: it leaves with the first prompt.
		if (ctx.hasUI) ctx.ui.setWidget(DEV_BINARY_WIDGET_KEY, undefined);
	});
	pi.on("agent_settled", (_event, ctx) => {
		// Pi clears its own run-active flag before emitting agent_settled, so
		// this is normally idle; if a run is somehow still in flight the prompt
		// stays working and the pending text waits for the next settle.
		if (!ctx.isIdle()) return;
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
