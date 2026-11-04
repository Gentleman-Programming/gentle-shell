import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderPaletteCard, type CommandPaletteTheme } from "./command-palette.ts";
import { effectiveKey, loadKeymaps } from "./keymaps.ts";

// The /gentle:guide tour, driver.js style: one popover per step, placed
// beside the part of the screen the step describes. Pure (no Pi extension
// API), so extensions/gentle-guide.ts owns the overlay and the agent tool,
// and tests drive the steps, placement and keys directly.

/** Where a step points: the prompt, the sidebar rail (or the cards around the prompt without it), or nothing in particular. */
export type GuideRegion = "center" | "editor" | "sidebar";
export type GuideMode = "local" | "agent";
/** How a popover ends: the last step was passed, the user or agent ended it, or it closed to reopen elsewhere. */
export type GuideResult = "finished" | "ended" | "moved";

export interface GuideStep {
	id: string;
	title: string;
	body: string;
	region: GuideRegion;
	/** The slash command to try, shown with its current key. */
	command?: string;
	/** The keymap id whose key the step shows (lib/keymaps.ts). */
	keymap?: string;
	/** A command or tool that must exist in the session for the step to be shown. */
	requires?: string;
}

export const GUIDE_STEPS: readonly GuideStep[] = [
	{ id: "welcome", title: "Welcome to Gentle Shell", region: "center",
		body: "el Gentleman is a coding agent harness: it explores before it writes, tracks larger work, delegates to subagents and checks its own changes. This tour shows where everything lives." },
	{ id: "prompt", title: "The prompt", region: "editor",
		body: "Ask for what you want in plain language. Slash commands start with /, and Esc stops the agent's current turn." },
	{ id: "palette", title: "Command palette", region: "center", command: "gentle:commands", keymap: "commands", requires: "gentle:commands",
		body: "Every Gentle command, grouped and searchable. Tab on a row gives that command a key of its own." },
	{ id: "keymaps", title: "Keymaps", region: "center", command: "gentle:customize", requires: "gentle:customize",
		body: "Customize → Keymaps lists every shortcut: press Enter on one and then the new key. Changes apply after /reload." },
	{ id: "models", title: "Models and profiles", region: "center", command: "gentle:profiles", requires: "gentle:profiles",
		body: "Pick the model for the main agent and for each kind of subagent, and save the mix as a profile." },
	{ id: "agents", title: "Subagents", region: "sidebar", command: "gentle:agents", keymap: "agents.view", requires: "gentle:agents",
		body: "The agent hands exploration, writing or verification to subagents. They appear as they run; open them to read what they are doing." },
	{ id: "todos", title: "Task list", region: "sidebar", keymap: "todo.collapse", requires: "todo",
		body: "For larger work the agent keeps a visible task list and updates it as each task starts and finishes." },
	{ id: "jobs", title: "Background jobs", region: "sidebar", command: "gentle:jobs", keymap: "jobs.collapse", requires: "gentle:jobs",
		body: "Long commands such as builds or test suites run in the background while you keep talking to the agent." },
	{ id: "changes", title: "Changes", region: "editor", command: "gentle:changes", keymap: "changes", requires: "gentle:changes",
		body: "Every uncommitted change of the session and its subagents' worktrees, with its diff. Press o to open a file in your editor." },
	{ id: "design", title: "Design canvas", region: "center", command: "gentle:design", requires: "gentle:design",
		body: "Ask for a screen, mockup or landing page and get HTML artboards on a local canvas to compare, comment and hand off." },
	{ id: "voice", title: "Voice", region: "center", command: "gentle:voice", requires: "gentle:voice",
		body: "Dictate prompts with push-to-talk; the transcription runs locally." },
	{ id: "music", title: "Music", region: "center", command: "gentle:music", requires: "gentle:music",
		body: "Background music while you work, controlled from the prompt." },
	{ id: "customize", title: "Customize", region: "center", command: "gentle:customize", requires: "gentle:customize",
		body: "Themes, layout, banner, cards, animations, audio notifications, Vim editing and prompt history, previewed before they apply." },
	{ id: "permissions", title: "Permissions", region: "center", command: "gentle:yolo", requires: "gentle:yolo",
		body: "YOLO lets the agent work without permission questions for this session. Secrets and credentials stay off-limits either way." },
	{ id: "memory", title: "Memory", region: "center", requires: "mem_search",
		body: "The agent saves decisions, fixes and discoveries, and recalls them in later sessions. Ask it what you did last time." },
	{ id: "usage", title: "Usage", region: "center", command: "gentle:usage", keymap: "usage", requires: "gentle:usage",
		body: "Your subscription's usage windows; /gentle:stats adds tokens, cost and models over time." },
	{ id: "diagnostics", title: "Diagnostics", region: "center", command: "gentle:doctor", requires: "gentle:doctor",
		body: "/gentle:doctor and /gentle:status check the installation when something looks off." },
	{ id: "end", title: "That's the tour", region: "center",
		body: "Run /gentle:guide again any time, or just ask the agent how to do something." },
];

/** The steps for one session: those without a requirement, and those whose command or tool exists. */
export function guideSteps(available: ReadonlySet<string>, steps: readonly GuideStep[] = GUIDE_STEPS): GuideStep[] {
	return steps.filter((step) => !step.requires || available.has(step.requires));
}

/** Position within a non-empty list of steps. */
export class GuideTour {
	readonly steps: readonly GuideStep[];
	private index = 0;

	constructor(steps: readonly GuideStep[]) {
		if (steps.length === 0) throw new Error("A tour needs at least one step.");
		this.steps = steps;
	}

	current(): GuideStep { return this.steps[this.index]!; }
	position(): number { return this.index + 1; }
	isLast(): boolean { return this.index === this.steps.length - 1; }
	/** False, without moving, on the last step. */
	next(): boolean { if (this.isLast()) return false; this.index += 1; return true; }
	/** False, without moving, on the first step. */
	previous(): boolean { if (this.index === 0) return false; this.index -= 1; return true; }
	show(id: string): boolean {
		const found = this.steps.findIndex((step) => step.id === id);
		if (found < 0) return false;
		this.index = found;
		return true;
	}
}

export const GUIDE_POPOVER_WIDTH = 56;
const MIN_POPOVER_WIDTH = 40;
/** Rows between the bottom of the screen and the popover for prompt steps: the prompt, its rule and the status bar stay visible. */
const EDITOR_OFFSET_ROWS = 6;

/**
 * Overlay options for a step: left of the sidebar rail when it shows, above
 * the prompt for prompt steps, centered otherwise. In agent mode the popover
 * never takes focus, so the user keeps typing in the prompt.
 */
export function guidePlacement(region: GuideRegion, columns: number, railColumns: number | undefined, mode: GuideMode) {
	const width = Math.min(GUIDE_POPOVER_WIDTH, Math.max(MIN_POPOVER_WIDTH, columns - 4));
	const nonCapturing = mode === "agent";
	if (region === "sidebar" && railColumns) return { anchor: "right-center" as const, offsetX: -(railColumns + 1), width, nonCapturing };
	if (region === "editor") return { anchor: "bottom-center" as const, offsetY: -EDITOR_OFFSET_ROWS, width, nonCapturing };
	return { anchor: "center" as const, width, nonCapturing };
}

/** "Try: /command · key" for a step, with the key the user has now; undefined when there is nothing to try. */
export function guideTryLine(step: GuideStep, env: NodeJS.ProcessEnv): string | undefined {
	const key = step.keymap ? effectiveKey(step.keymap, env, loadKeymaps(env).bindings) : undefined;
	const parts = [step.command ? `/${step.command}` : undefined, key].filter((part): part is string => Boolean(part));
	return parts.length ? `Try: ${parts.join(" · ")}` : undefined;
}

function pointerLine(region: GuideRegion, railColumns: number | undefined): string | undefined {
	if (region === "sidebar") return railColumns ? "▸ In the sidebar on the right" : "▾ In the cards around the prompt";
	if (region === "editor") return "▾ Below, at the prompt";
	return undefined;
}

export interface GuidePopoverOptions {
	tour: GuideTour;
	mode: GuideMode;
	theme: CommandPaletteTheme;
	env: NodeJS.ProcessEnv;
	/** The sidebar rail's columns while it shows; undefined without it. */
	railColumns?: () => number | undefined;
	/** Called after a local key moved the tour, so the owner can reopen the popover beside the new step. */
	onMove?: () => void;
	done(result: GuideResult): void;
}

export class GuidePopover {
	private completed = false;
	private readonly options: GuidePopoverOptions;

	constructor(options: GuidePopoverOptions) {
		this.options = options;
	}

	invalidate(): void {}

	/** Local mode only: in agent mode the popover never has focus. */
	handleInput(data: string): void {
		if (this.completed || this.options.mode !== "local" || isKeyRelease(data)) return;
		const { tour } = this.options;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return this.finish("ended");
		if (matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "return") || data === " " || data === "l") {
			if (!tour.next()) return this.finish("finished");
			this.options.onMove?.();
			return;
		}
		if ((matchesKey(data, "left") || data === "h") && tour.previous()) this.options.onMove?.();
	}

	render(width: number): string[] {
		const { tour, theme, mode } = this.options;
		const step = tour.current();
		const inner = Math.max(1, width - 4);
		const fg = (color: string, text: string) => theme.fg(color, text);
		const lines: string[] = [];
		const counter = `${tour.position()}/${tour.steps.length}`;
		const title = truncateToWidth(step.title, Math.max(1, inner - counter.length - 1), "…");
		lines.push(`${fg("accent", title)}${" ".repeat(Math.max(1, inner - visibleWidth(title) - counter.length))}${fg("muted", counter)}`);
		const pointer = pointerLine(step.region, this.options.railColumns?.());
		if (pointer) lines.push(fg("accent", pointer));
		lines.push("");
		for (const line of wrapTextWithAnsi(step.body, inner)) lines.push(fg("text", line));
		const tryLine = guideTryLine(step, this.options.env);
		if (tryLine) lines.push("", fg("accent", truncateToWidth(tryLine, inner, "…")));
		lines.push("");
		const footer = mode === "local" ? "→ next · ← back · esc end" : "Reply in the chat · /gentle:guide stop ends";
		lines.push(fg("muted", truncateToWidth(footer, inner, "…")));
		return renderPaletteCard(lines, width, theme);
	}

	private finish(result: GuideResult): void {
		if (this.completed) return;
		this.completed = true;
		this.options.done(result);
	}
}

/** What the gentle_guide tool returns for the current step, so the agent can explain it. */
export function guideStepText(tour: GuideTour, env: NodeJS.ProcessEnv): string {
	const step = tour.current();
	const lines = [`Step ${tour.position()}/${tour.steps.length} · ${step.title}`, step.body];
	const tryLine = guideTryLine(step, env);
	if (tryLine) lines.push(tryLine);
	if (tour.isLast()) lines.push('This is the last step: call gentle_guide with action "end" when the user is done.');
	else lines.push(`Next: ${tour.steps[tour.position()]!.title}`);
	return lines.join("\n");
}
