import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { measureAgentsViewLayout, type AgentsViewLayout } from "./agents-view-layout.ts";
import { HOVER_ROLE, paintHoverable } from "./shell-hover.ts";
import { emptyThread, isFinished, TASK_STATUS, THREAD_ITEM, type TaskRecord, type TaskStore, type TaskThread, type ThreadItem } from "./agents-protocol.ts";
import { agentMessageCard } from "./agents-message-card.ts";
import { isMemoryToolName } from "./agents-memory-card.ts";
import { agentToolRowCard, type AgentToolRowCard } from "./agents-tool-renderers.ts";
import { cardContent } from "./card-content-policy.ts";
import { cardBash } from "./card-bash-policy.ts";
import { resolveGentleAiDevBinaryOverride } from "./gentle-ai-binary.ts";
import { cardStyle } from "./shell-card.ts";
import { drawThreadItem, THREAD_PRESENTATION, type AgentsThreadTheme, type ThreadItemDrawing, type ThreadPresentation } from "./agents-thread-view.ts";
import { formatElapsed } from "./agents-widget.ts";
import { createNativePointerScope, type NativePointerRegion } from "./native-pointer-region.ts";
import { formatCost, formatTokens } from "./shell-bar.ts";
import { PresenceCursor, readActivity, type Header, type Target } from "./orchestrator-presence.ts";

// Gentle Agents overlay: tasks on the left, the selected task's thread on
// the right. Only the selected task is subscribed, thread items are rendered
// once each (they are immutable until replaced), and the viewport shows the
// tail unless the human scrolls up. Current scope contains direct live children;
// all sessions is a presence directory, not a history browser. Remote activity
// is presentation-only and never enters the local TaskStore.

export interface AgentsViewTheme extends AgentsThreadTheme {}

export const VIEW_SCOPE = {
	SESSION: "session",
	ALL: "all",
} as const;

export type ViewScope = (typeof VIEW_SCOPE)[keyof typeof VIEW_SCOPE];

export interface AgentsViewDeps {
	theme: AgentsViewTheme;
	rows: number | (() => number);
	store: TaskStore;
	sessionId?: string;
	presence?: { profile: string; target?: Readonly<Target> };
	now(): number;
	onCancel(task: TaskRecord): void;
	canCancel?(task: TaskRecord): boolean;
	isLocalTask?(task: TaskRecord): boolean;
	/**
	 * Presentation for the selected thread: the overlay's labeled log (the default)
	 * or the chat's own tool cards. Read as a hook so a preference applies live
	 * instead of being copied when the overlay opens.
	 */
	threadPresentation?(): ThreadPresentation;
	/**
	 * The host's live keybindings. The cards' thinking and tool-detail actions are
	 * the host's own, so a reader's rebinding applies there and an action left
	 * unbound has no key; without a manager the documented defaults still work.
	 */
	keybindings?: KeybindingsManager;
	/**
	 * The cards' detail levels as the host holds them when the overlay opens: its
	 * thinking visibility and its tool-output expansion. Seeds the cards only; the
	 * labeled log has no detail controls. They are read once here, never followed
	 * live and never written back to the chat's state.
	 */
	cardDetail?: { thinkingExpanded?: boolean; toolsExpanded?: boolean };
	onOpen(task: TaskRecord): void;
	onClose(): void;
	requestRender(): void;
}

const ROLE = {
	FRAME: "border",
	TITLE: "customMessageLabel",
	SELECTED: "accent",
	HOVER: HOVER_ROLE,
	NAME: "text",
	NAME_IDLE: "muted",
	META: "dim",
	KEY: "accent",
	KEY_TEXT: "dim",
	EMPTY: "dim",
} as const;

const GLYPH: Record<string, string> = {
	[TASK_STATUS.QUEUED]: "○",
	[TASK_STATUS.RUNNING]: "◐",
	[TASK_STATUS.WAITING]: "?",
	[TASK_STATUS.COMPLETED]: "✓",
	[TASK_STATUS.FAILED]: "✗",
	[TASK_STATUS.CANCELLED]: "–",
	[TASK_STATUS.TIMED_OUT]: "✗",
};
const GLYPH_ROLE: Record<string, string> = {
	[TASK_STATUS.QUEUED]: "muted",
	[TASK_STATUS.RUNNING]: "accent",
	[TASK_STATUS.WAITING]: "warning",
	[TASK_STATUS.COMPLETED]: "success",
	[TASK_STATUS.FAILED]: "error",
	[TASK_STATUS.CANCELLED]: "dim",
	[TASK_STATUS.TIMED_OUT]: "error",
};
const MAX_FINISHED_PER_SESSION = 200;
const SCOPE_LABEL: Record<ViewScope, string> = { [VIEW_SCOPE.SESSION]: "this session", [VIEW_SCOPE.ALL]: "all sessions" };
const SCOPE_KEY: Record<ViewScope, string> = { [VIEW_SCOPE.SESSION]: "all sessions", [VIEW_SCOPE.ALL]: "this session" };
const EMPTY_LIST = "no tasks yet";
const EMPTY_THREAD = "waiting for the first event";
const FOLLOW_BUTTON = "[ Follow ]";
const OPEN_BUTTON = "[ Open session ]";
const CLOSE_BUTTON = "[× Close]";
// At the 60-cell split boundary these four controls fit before any hints.
const STOP_BUTTON = "[Stop]";
const SCOPE_BUTTON = "[Scope]";
const KEYS = [
	["j/k", "task"],
	["ctrl+j/k", "scroll"],
	["f", "follow"],
	["o", "open session"],
	["esc", "back"],
	["q", "close"],
] as const;

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate() {},
};

// The host owns both actions; these are its documented defaults, used only when
// no keybinding manager was handed down.
const FALLBACK_BINDING = {
	"app.thinking.toggle": "ctrl+t",
	"app.tools.expand": "ctrl+o",
} as const;

type DetailBinding = keyof typeof FALLBACK_BINDING;

interface PointerButtonLayout {
	x: number;
	width: number;
}

interface PointerLayout extends AgentsViewLayout {
	narrowView: "list" | "details";
	sourceHeight?: number;
	closeButton?: PointerButtonLayout;
	modeButton?: PointerButtonLayout;
	actions?: Array<PointerButtonLayout & { region: NativePointerRegion }>;
	/** Per body row, the card key drawn there; only in cards mode. */
	threadCards?: Array<string | undefined>;
}

interface SessionGroup {
	id: string;
	sessionId: string | undefined;
	label?: string;
	tasks: TaskRecord[];
}

type VisibleRow =
	| { id: string; kind: "heading"; group: SessionGroup }
	| { id: string; kind: "task"; group: SessionGroup; task: TaskRecord };

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

// A published card names itself in a cache key by a per-process ordinal: a
// drawing belongs to that exact renderer, so a republication (a new object) or a
// withdrawn card never reuses rows the previous one drew. The WeakMap holds the
// publisher's object weakly; nothing here keeps it alive.
const cardIds = new WeakMap<object, number>();
let nextCardId = 0;

function cardId(card: object | undefined): string {
	if (card === undefined) return "none";
	const known = cardIds.get(card);
	if (known !== undefined) return String(known);
	const assigned = (nextCardId += 1);
	cardIds.set(card, assigned);
	return String(assigned);
}

// A registered dev-binary override changes how a bash card reads its command, so
// its identity is part of what a frame's rows were drawn under. Resolving it reads
// the binary — and hashes it once an override is registered — so a frame resolves
// it once and never once per item; an override that cannot be resolved is its own
// identity instead of a frame-breaking error.
function devBinaryIdentity(): string {
	try {
		const override = resolveGentleAiDevBinaryOverride();
		return override === undefined ? "none" : `${override.source}\u0000${override.path}`;
	} catch {
		return "invalid";
	}
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

// Deep equality over presence thread items: validated JSON payloads, so only
// plain objects, arrays, strings, booleans, and null appear. Used to keep the
// prior item object (and its WeakMap render cache entry) when polled content
// is render-equivalent at the same position.
function sameItemValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && sameItemValue(left[key], right[key]));
}

export function taskHeader(task: TaskRecord, now: number): string {
	// #2180: the winning profile layer is shown right after the model it supplied;
	// records without one render exactly as before.
	const parts = [task.agent, task.status, task.model, ...(task.modelSource === undefined ? [] : [task.modelSource]), task.tokens > 0 ? formatTokens(task.tokens) : "", task.cost > 0 ? formatCost(task.cost) : "", task.startedAt === null ? "" : formatElapsed((task.endedAt ?? now) - task.startedAt)];
	return parts.filter((part) => part.length > 0).join(" · ");
}

export class AgentsView {
	private readonly deps: AgentsViewDeps;
	private tasks: TaskRecord[] = [];
	private selectedId: string | undefined;
	private hoveredId: string | undefined;
	private narrowView: "list" | "details" = "list";
	private narrowGroup: string | undefined;
	private groupCursor: string | undefined;
	private footerPage = 0;
	private readonly actionRegions = new Map<string, NativePointerRegion>();
	private readonly expanded = new Map<string, boolean>();
	private readonly cardExpansion = new Map<string, boolean>();
	// Cards only, and local to this overlay: seeded from the host's thinking
	// visibility and tool expansion when it opened, never the thread's content and
	// never a global chat setting. The log always draws thinking and output whole.
	private thinkingExpanded = true;
	private cardToolsExpanded = false;
	private readonly observedActiveGroups = new Set<string>();
	private listScroll = 0;
	private readonly manualListOffsets = new Map<string, number>();
	private scope: ViewScope;
	private scroll = 0;
	private follow = true;
	private readonly pointerScope = createNativePointerScope();
	private readonly taskRegions = new Map<number, NativePointerRegion>();
	private readonly listRegion: NativePointerRegion;
	private readonly threadRegion: NativePointerRegion;
	private readonly followRegion: NativePointerRegion;
	private readonly openRegion: NativePointerRegion;
	private readonly closeRegion: NativePointerRegion;
	private readonly modeRegion: NativePointerRegion;
	private hoveredControl: "follow" | "open" | "close" | "mode" | undefined;
	private pointerLayout: PointerLayout | undefined;
	// Keyboard input has no terminal width, so retain its last rendered width
	// independently from disposable pointer hit geometry.
	private lastRenderedWidth: number | undefined;
	private closed = false;
	private unsubscribeTask: (() => void) | undefined;
	private subscribedTaskId: string | undefined;
	private readonly unsubscribeSummary: () => void;
	private cache = new WeakMap<ThreadItem, ThreadItemDrawing & { key: string }>();
	private peers: SessionGroup[] = [];
	private remoteThreads = new Map<string, TaskThread>();
	private presenceCursor?: PresenceCursor;
	private presenceTimer?: ReturnType<typeof setTimeout>;

	// One directory page or one pinned activity per turn; yield between reads.
	// Keep the previous directory until a traversal completes, avoiding page flicker.
	private refreshPresence(): void {
		const source = this.deps.presence;
		if (!source || this.closed) return;
		const groups: SessionGroup[] = [];
		const threads = new Map<string, TaskThread>();
		const seen = new Set<string>();
		let pending: Header[] = [];
		let overflow = true;
		const step = () => {
			if (this.closed) return;
			try {
				if (pending.length) {
					const header = pending.shift()!;
					const id = `${header.sessionHash}:${header.incarnation}`;
					if (!seen.has(id) && header.incarnation !== source.target?.incarnation) {
						seen.add(id);
						const { activity, unavailable } = readActivity(source.profile, header);
						const tasks = (activity?.tasks ?? []).filter(({ summary }) => !isFinished(summary.status as TaskRecord["status"])).map(({ summary, thread }) => {
							const task: TaskRecord = { ...summary, id: `peer:${id}:${summary.id}`, parentSessionId: id,
								status: summary.status as TaskRecord["status"], mode: "background", prompt: "", cwd: "",
								thinking: undefined, sessionPath: null, error: null, result: null, lastStep: "", turns: 0, toolCalls: 0, tokens: 0, cost: 0 };
							const prior = this.remoteThreads.get(task.id);
							threads.set(task.id, { ...emptyThread(), ...thread,
								items: thread.items.map((item, index) => {
									// Sanitize before equality: presence tool items carry no invocation
									// args, so compare against the stored sanitized form.
									const sanitized = item.kind === "tool" ? { ...item, args: {} } : item;
									const previous = prior?.items[index];
									// Reuse the prior object when content is render-equivalent so the
									// WeakMap render cache hits; any delta keeps a fresh identity.
									return previous !== undefined && sameItemValue(previous, sanitized) ? previous : sanitized;
								}) as ThreadItem[] });
							return task;
						});
						groups.push({ id, sessionId: id, label: `${header.label}${unavailable ? " · unavailable" : ""}`, tasks });
					}
				} else if (overflow) {
					this.presenceCursor ??= new PresenceCursor(source.profile);
					const page = this.presenceCursor.next();
					pending = page.entries.filter((entry) => entry.recent);
					overflow = page.overflow;
				} else {
					this.peers = groups;
					this.remoteThreads = threads;
					this.refreshTasks();
					this.clearFooterLayout();
					this.deps.requestRender();
					this.stopPresenceRefresh();
					this.presenceTimer = setTimeout(() => this.refreshPresence(), 1000);
					this.presenceTimer.unref();
					return;
				}
			} catch {
				this.peers = [];
				this.remoteThreads.clear();
				this.refreshTasks();
				this.clearFooterLayout();
				this.deps.requestRender();
				this.stopPresenceRefresh();
				this.presenceTimer = setTimeout(() => this.refreshPresence(), 1000);
				this.presenceTimer.unref();
				return;
			}
			this.presenceTimer = setTimeout(step, 0);
			this.presenceTimer.unref();
		};
		step();
	}

	private stopPresenceRefresh(): void {
		clearTimeout(this.presenceTimer);
		this.presenceCursor?.close();
		this.presenceCursor = undefined;
	}

	constructor(deps: AgentsViewDeps) {
		this.deps = deps;
		this.thinkingExpanded = deps.cardDetail?.thinkingExpanded !== false;
		this.cardToolsExpanded = deps.cardDetail?.toolsExpanded === true;
		this.scope = VIEW_SCOPE.SESSION;
		this.listRegion = this.pointerScope.wrap(EMPTY_COMPONENT, {
			onWheel: (event) => this.wheelList(event),
		});
		this.threadRegion = this.pointerScope.wrap(EMPTY_COMPONENT, {
			onWheel: (event) => this.wheelThread(event),
			onClick: (event) => this.clickThread(event),
		});
		this.followRegion = this.pointerScope.wrap(EMPTY_COMPONENT, {
			onHover: () => this.hoverControl("follow"),
			onLeave: () => this.clearHoveredControl("follow"),
			onClick: (event) => this.clickFollow(event),
		});
		this.openRegion = this.pointerScope.wrap(EMPTY_COMPONENT, {
			onHover: () => this.hoverControl("open"),
			onLeave: () => this.clearHoveredControl("open"),
			onClick: (event) => this.clickOpen(event),
		});
		this.closeRegion = this.pointerScope.wrap(EMPTY_COMPONENT, {
			onHover: () => this.hoverControl("close"),
			onLeave: () => this.clearHoveredControl("close"),
			onClick: (event) => this.clickClose(event),
		});
		this.modeRegion = this.pointerScope.wrap(EMPTY_COMPONENT, {
			onHover: () => this.hoverControl("mode"),
			onLeave: () => this.clearHoveredControl("mode"),
			onClick: (event) => this.clickMode(event),
		});
		this.refreshTasks();
		this.unsubscribeSummary = deps.store.subscribeSummary(() => {
			this.clearFooterLayout();
			this.refreshTasks();
			this.deps.requestRender();
		});
		this.subscribeSelected();
		this.refreshPresence();
	}

	dispose(): void {
		this.closed = true;
		this.stopPresenceRefresh();
		this.pointerLayout = undefined;
		this.pointerScope.dispose();
		this.unsubscribeTask?.();
		this.unsubscribeTask = undefined;
		this.subscribedTaskId = undefined;
		this.unsubscribeSummary();
	}

	mouseObserver(): ReturnType<typeof this.pointerScope.createMouseObserver> {
		return this.pointerScope.createMouseObserver(() => this.deps.requestRender());
	}

	selectedTask(): TaskRecord | undefined {
		return this.tasks.find((task) => `task:${task.id}` === this.selectedId);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (data === "q") return this.close();
		if (matchesKey(data, Key.escape)) return this.back();
		// These detail actions belong to the cards; the log keeps every key it always
		// had, so it never consumes them.
		if (this.threadPresentation() === THREAD_PRESENTATION.CARDS && this.matchesBinding(data, "app.thinking.toggle")) return this.toggleThinking();
		if (this.threadPresentation() === THREAD_PRESENTATION.CARDS && this.matchesBinding(data, "app.tools.expand")) return this.toggleToolOutput();
		if (data === "F" && !this.isNarrow()) {
			this.setNarrowView(this.narrowView === "list" ? "details" : "list");
			return;
		}
		if ((data === "\t" || matchesKey(data, Key.enter)) && this.isNarrow()) {
			if (this.narrowView === "details") this.back();
			else this.activate();
			return;
		}
		const rows = this.visibleRows();
		const selected = this.selectedRow(rows);
		const task = this.actionableTask();
		const index = selected ? rows.findIndex((row) => row.id === selected.id) : -1;
		if (this.narrowView === "details" && (data === "j" || data === "k" || matchesKey(data, Key.down) || matchesKey(data, Key.up))) {
			this.scrollBy(data === "j" || matchesKey(data, Key.down) ? 1 : -1);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.select(index + 1, rows);
		else if (data === "k" || matchesKey(data, Key.up)) this.select(index - 1, rows);
		else if (matchesKey(data, Key.left) && selected?.kind === "heading") this.setExpanded(selected.group, false);
		else if (matchesKey(data, Key.right) && selected?.kind === "heading") this.setExpanded(selected.group, true);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("j")) || matchesKey(data, Key.ctrlShift("j"))) this.scrollBy(this.pageRows());
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("k")) || matchesKey(data, Key.ctrlShift("k"))) this.scrollBy(-this.pageRows());
		else if (matchesKey(data, Key.ctrl("home"))) this.scrollToStart();
		else if (matchesKey(data, Key.ctrl("end"))) this.scrollToEnd();
		else if (data === "f" && task) {
			this.follow = true;
			this.deps.requestRender();
		} else if (data === "a" && this.deps.sessionId !== undefined) this.toggleScope();
		else if ((data === "s" || data === "c") && task && this.canCancel(task)) this.deps.onCancel(task);
		else if ((data === "o" || matchesKey(data, Key.enter)) && task && this.canOpen(task)) this.deps.onOpen(task);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const live = this.layout(event.width);
		const liveHeight = live.mode === "fallback" ? Math.min(1, live.height) : live.height;
		if (event.width !== live.width || event.height !== liveHeight) return undefined;
		const layout = this.pointerLayout;
		if (!layout || (layout.sourceHeight !== undefined && layout.sourceHeight !== live.height) || event.width !== layout.width || event.height !== layout.height || live.mode !== layout.mode || layout.narrowView !== this.narrowView || event.x < 0 || event.y < 0 || event.x >= layout.width || event.y >= layout.height) return undefined;
		if (event.y === 0) {
			if (this.isInButton(event.x, layout.modeButton)) return this.modeRegion.handleMouse(event);
			if (this.isInButton(event.x, layout.closeButton)) return this.closeRegion.handleMouse(event);
		}
		if (event.y >= 1 && event.y < 1 + layout.bodyRows) {
			const row = event.y - 1;
			if (layout.mode === "narrow" && event.x >= layout.listX && event.x < layout.listX + layout.listWidth) {
				if (event.type === "wheel") return this.narrowView === "list" ? this.listRegion.handleMouse(event) : this.threadRegion.handleMouse(event);
				if (this.narrowView === "details") return this.threadRegion.handleMouse(event);
				const visible = this.visibleRows()[this.listScroll + row];
				return visible ? this.taskRegion(row).handleMouse(event) : undefined;
			}
			if (layout.mode === "panes" && event.x >= layout.listX && event.x < layout.listX + layout.listWidth) {
				if (event.type === "wheel") return this.listRegion.handleMouse(event);
				const visible = this.visibleRows()[this.listScroll + row];
				return visible ? this.taskRegion(row).handleMouse(event) : undefined;
			}
			if (layout.mode === "panes" && event.x >= layout.threadX && event.x < layout.threadX + layout.threadWidth) return this.threadRegion.handleMouse(event);
		}
		if (event.y === layout.footerY) {
			for (const action of layout.actions ?? []) if (this.isInButton(event.x, action)) return action.region.handleMouse(event);
		}
		return undefined;
	}

	render(width: number): string[] {
		const layout = this.layout(width);
		this.lastRenderedWidth = layout.width;
		if (layout.width === 0 || layout.height === 0) {
			this.clearFooterLayout();
			return [];
		}
		if (layout.mode === "fallback") {
			this.clearFooterLayout();
			this.closeRegion.setDisabled(false);
			this.closeRegion.render(1);
			this.pointerLayout = { ...layout, height: 1, sourceHeight: layout.height, narrowView: this.narrowView, closeButton: { x: 0, width: 1 } };
			return ["×" + fit(" Close Agents", layout.width - 1)];
		}
		// Retained terminal rows never belong in either live scope.
		const now = this.deps.now();
		if (this.tasks.some((task) => !this.inScope(task, now))) this.refreshTasks();
		if (this.pointerLayout && (this.pointerLayout.width !== layout.width || this.pointerLayout.height !== layout.height || this.pointerLayout.mode !== layout.mode || this.pointerLayout.narrowView !== this.narrowView)) this.clearFooterLayout();
		const theme = this.deps.theme;
		const inner = layout.width - 2;
		const closeLabel = this.closeLabel(layout);
		const modeLabel = this.modeLabel(layout);
		this.closeRegion.setDisabled(closeLabel === undefined);
		this.modeRegion.setDisabled(modeLabel === undefined);
		this.followSelection(layout.bodyRows);
		const closeWidth = visibleWidth(closeLabel ?? "");
		const modeWidth = visibleWidth(modeLabel ?? "");
		const closeX = layout.width - 1 - closeWidth;
		this.pointerLayout = {
			...layout,
			narrowView: this.narrowView,
			closeButton: closeLabel ? { x: closeX, width: closeWidth } : undefined,
			modeButton: modeLabel ? { x: closeX - modeWidth - 1, width: modeWidth } : undefined,
		};
		this.listRegion.render(layout.listWidth);
		this.threadRegion.render(layout.threadWidth);
		if (closeLabel) this.closeRegion.render(closeWidth);
		if (modeLabel) this.modeRegion.render(modeWidth);
		const scope = this.deps.sessionId === undefined ? "" : `${SCOPE_LABEL[this.scope]} · `;
		const controlsWidth = (closeLabel ? closeWidth + 1 : 0) + (modeLabel ? modeWidth + 1 : 0);
		const title = truncateToWidth(`❀ Agents · ${scope}${this.counts()}`, Math.max(0, inner - 3 - controlsWidth), "…");
		const mode = modeLabel ? ` ${theme.fg(this.hoveredControl === "mode" ? "warning" : ROLE.KEY, modeLabel)}` : "";
		const close = closeLabel ? ` ${theme.fg(this.hoveredControl === "close" ? "warning" : ROLE.KEY, closeLabel)}` : "";
		const top = theme.fg(ROLE.FRAME, "╭─ ") + theme.fg(ROLE.TITLE, title) + theme.fg(ROLE.FRAME, ` ${rule(inner - visibleWidth(title) - 3 - controlsWidth)}`) + mode + close + theme.fg(ROLE.FRAME, "╮");
		const detail = layout.mode === "panes" || this.narrowView === "details" ? this.threadWindow(layout.bodyRows, layout.threadWidth) : [];
		const body: string[] = [];
		for (let row = 0; row < layout.bodyRows; row += 1) {
			if (layout.mode === "panes") body.push(`${theme.fg(ROLE.FRAME, "│")} ${fit(this.taskLine(row), layout.listWidth)} ${theme.fg(ROLE.FRAME, "│")} ${fit(detail[row] ?? "", layout.threadWidth)}${theme.fg(ROLE.FRAME, "│")}`);
			else body.push(`${theme.fg(ROLE.FRAME, "│")} ${fit(this.narrowView === "list" ? this.taskLine(row) : detail[row] ?? "", layout.listWidth)} ${theme.fg(ROLE.FRAME, "│")}`);
		}
		const keyHints = this.selectedRow()?.kind === "heading" ? [["←/→", "group"] as const, ...this.keys(layout.mode === "narrow")] : this.keys(layout.mode === "narrow");
		const keys = keyHints.map(([key, label]) => `${theme.fg(ROLE.KEY, key)} ${theme.fg(ROLE.KEY_TEXT, label)}`).join("   ");
		const footer = this.footer(keys, inner - 2);
		const keysLine = `${theme.fg(ROLE.FRAME, "│")} ${fit(footer, inner - 2)} ${theme.fg(ROLE.FRAME, "│")}`;
		return [top, ...body, keysLine, theme.fg(ROLE.FRAME, `╰${rule(inner)}╯`)];
	}

	invalidate(): void {
		this.clearFooterLayout();
		// Every retained drawing was painted with the theme this pane was handed and
		// no theme is part of its key, so a theme change has to drop the cache: the
		// log served rows painted by the previous theme before this was cleared here.
		this.cache = new WeakMap();
	}

	private counts(): string {
		const active = this.tasks.filter((task) => !isFinished(task.status)).length;
		const finished = this.tasks.length - active;
		return `${active} active · ${finished} finished`;
	}

	private actionableTask(): TaskRecord | undefined {
		return this.directoryRoot() && this.narrowView === "list" ? undefined : this.selectedTask();
	}

	private canCancel(task: TaskRecord): boolean {
		return !this.remoteThreads.has(task.id) && !isFinished(task.status) && (this.deps.canCancel?.(task) ?? true);
	}

	private canOpen(task: TaskRecord | undefined): boolean {
		return Boolean(task?.sessionPath) && !this.remoteThreads.has(task!.id);
	}

	private keys(narrow = false): ReadonlyArray<readonly [string, string]> {
		const task = this.actionableTask();
		const details = narrow && task ? [["tab", this.narrowView === "list" ? "details" : "back"]] as const : [];
		const stop = task && this.canCancel(task) ? [["s", "Stop selected"]] as const : [];
		const scope = this.deps.sessionId === undefined ? [] : [["a", SCOPE_KEY[this.scope]]] as const;
		return [...KEYS.slice(0, 1), ...details, ...KEYS.slice(1, 3), ...stop, ...scope, ...this.detailHints(), ...KEYS.slice(3)];
	}

	// The two detail hints belong to the cards alone: the log has no cards to
	// expand and no thinking to hide, so it never advertises a key that would
	// draw nothing. Each names the state its key leads to, and an action the host
	// left unbound has no key, so it gets no hint.
	private detailHints(): ReadonlyArray<readonly [string, string]> {
		if (this.threadPresentation() !== THREAD_PRESENTATION.CARDS) return [];
		const thinking = this.bindingKeys("app.thinking.toggle")[0];
		const expand = this.bindingKeys("app.tools.expand")[0];
		return [
			...(thinking === undefined ? [] : [[thinking, this.thinkingExpanded ? "hide thinking" : "show thinking"] as const]),
			...(expand === undefined ? [] : [[expand, this.cardToolsExpanded ? "collapse" : "expand"] as const]),
		];
	}

	private threadPresentation(): ThreadPresentation {
		return this.deps.threadPresentation?.() ?? THREAD_PRESENTATION.LOG;
	}

	// The host owns both actions: a configured binding replaces its documented
	// default, and one a reader unbound has no key at all.
	private bindingKeys(binding: DetailBinding): readonly string[] {
		const configured = typeof this.deps.keybindings?.getKeys === "function" ? this.deps.keybindings.getKeys(binding) : undefined;
		return configured ?? [FALLBACK_BINDING[binding]];
	}

	private matchesBinding(data: string, binding: DetailBinding): boolean {
		if (typeof this.deps.keybindings?.matches === "function") return this.deps.keybindings.matches(data, binding);
		return matchesKey(data, FALLBACK_BINDING[binding]);
	}

	// Cards only: the key a collapsed tool result offers to open it. Hidden thinking
	// never advertises a key, exactly as the chat's own hidden row does not.
	private outputExpandHint(): string | undefined {
		const key = this.bindingKeys("app.tools.expand")[0];
		return key === undefined ? undefined : `${key} to expand`;
	}

	private toggleThinking(): void {
		this.thinkingExpanded = !this.thinkingExpanded;
		this.clearFooterLayout();
		this.deps.requestRender();
	}

	private toggleToolOutput(): void {
		this.cardToolsExpanded = !this.cardToolsExpanded;
		// The control speaks for the whole thread, so a card's own level must not
		// outvote it; clicking a card afterwards sets that card's level again.
		this.cardExpansion.clear();
		this.clearFooterLayout();
		this.deps.requestRender();
	}

	// A click flips what the reader sees, so a card still following the cards' own
	// level starts from that level rather than from a stale default.
	private flipCardExpansion(card: string): void {
		this.cardExpansion.set(card, !(this.cardExpansion.get(card) ?? this.cardToolsExpanded));
	}

	// A card belongs to one task's call: two tasks may reuse a callId, and each
	// keeps its own level. The task id is the namespace, so switching tasks never
	// shares or drops the other's state.
	private cardKey(task: TaskRecord, callId: string): string {
		return `${task.id}\u0000${callId}`;
	}

	// Only this task's cards are pruned: their override lasts while their call is
	// retained, and no other task's cards are touched by this thread's renders.
	private pruneCardExpansion(task: TaskRecord, thread: TaskThread): void {
		if (this.cardExpansion.size === 0) return;
		const prefix = `${task.id}\u0000`;
		const retained = new Set(thread.items.flatMap((item) => (item.kind === THREAD_ITEM.TOOL ? [this.cardKey(task, item.callId)] : [])));
		for (const card of this.cardExpansion.keys()) if (card.startsWith(prefix) && !retained.has(card)) this.cardExpansion.delete(card);
	}

	// A new scope reads from the top: selection, list window, and thread reset.
	private toggleScope(): void {
		this.clearFooterLayout();
		this.scope = this.scope === VIEW_SCOPE.SESSION ? VIEW_SCOPE.ALL : VIEW_SCOPE.SESSION;
		this.narrowGroup = undefined;
		this.groupCursor = undefined;
		this.manualListOffsets.clear();
		this.narrowView = "list";
		this.tasks = [];
		this.selectedId = undefined;
		this.listScroll = 0;
		this.hoveredId = undefined;
		this.scroll = 0;
		this.follow = true;
		this.refreshTasks();
		this.deps.requestRender();
	}

	private inScope(task: TaskRecord, _now: number): boolean {
		// A local task (this session's own, active or finished history) always
		// belongs; refreshTasks() is the single authority on which finished ones
		// survive its own retention cap. A remote (presence) task never keeps
		// history -- it drops out of scope the moment it finishes.
		if (task.parentSessionId === this.deps.sessionId) return true;
		return !isFinished(task.status) && this.scope === VIEW_SCOPE.ALL && this.remoteThreads.has(task.id);
	}

	private directoryRoot(): boolean {
		return this.scope === VIEW_SCOPE.ALL && this.isNarrow() && !this.narrowGroup;
	}

	// Keep the selected row inside the list window, moving the window by the
	// least amount needed; the wheel moves the same window on its own.
	private followSelection(rows: number): void {
		const manual = this.manualListOffsets.get(this.listKey());
		if (manual !== undefined) {
			this.listScroll = Math.min(manual, Math.max(0, this.visibleRows().length - rows));
			return;
		}
		const selected = this.selectedRow();
		const index = selected ? this.visibleRows().findIndex((row) => row.id === selected.id) : -1;
		if (index >= 0 && index < this.listScroll) this.listScroll = index;
		else if (index >= this.listScroll + rows) this.listScroll = index - rows + 1;
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, this.visibleRows().length - rows)));
	}

	private layout(width = this.pointerLayout?.width ?? this.lastRenderedWidth ?? 80): AgentsViewLayout {
		const rows = typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows;
		return measureAgentsViewLayout(width, rows, this.narrowView === "details");
	}

	private listKey(): string {
		return this.isNarrow() ? this.narrowGroup ?? "root" : "panes";
	}

	private isNarrow(): boolean {
		return measureAgentsViewLayout(this.lastRenderedWidth ?? 80, 3).mode !== "panes";
	}

	private back(): void {
		if (this.narrowView === "details") this.setNarrowView("list");
		else if (this.isNarrow() && this.narrowGroup) {
			this.groupCursor = `heading:${this.narrowGroup}`;
			this.narrowGroup = undefined;
			this.listScroll = 0;
			this.clearFooterLayout();
			this.deps.requestRender();
		} else this.close();
	}

	private activate(): void {
		const selected = this.selectedRow();
		if (selected?.kind === "heading" && this.isNarrow()) {
			this.narrowGroup = selected.group.id;
			this.listScroll = 0;
			const children = this.visibleRows();
			if (!children.some((row) => row.id === this.selectedId)) this.select(0, children);
			this.clearFooterLayout();
			this.deps.requestRender();
		} else if (this.selectedTask()) this.setNarrowView("details");
	}

	private bodyRows(): number {
		return this.layout().bodyRows;
	}

	private refreshTasks(): void {
		// Finished history bypasses isLocalTask: that dep exists to keep an
		// unrelated task resolveTask pulled in on demand (e.g. `subagent_result`
		// for an id from another session) out of the live panel, never to hide
		// this session's own finished subagents -- those belong here whether
		// they were restored on resume or just finished live.
		const local = this.deps.store.list().filter((task) => task.parentSessionId === this.deps.sessionId
			&& (isFinished(task.status) || (this.deps.isLocalTask?.(task) ?? true)));
		const active = local.filter((task) => !isFinished(task.status));
		const finished = local
			.filter((task) => isFinished(task.status))
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
			.slice(0, MAX_FINISHED_PER_SESSION);
		this.tasks = [...active, ...finished];
		if (this.scope === VIEW_SCOPE.ALL) this.tasks.push(...this.peers.flatMap((group) => group.tasks));
		const groups = this.sessionGroups();
		const present = new Set(groups.map((group) => group.id));
		for (const id of this.observedActiveGroups) if (!present.has(id)) this.observedActiveGroups.delete(id);
		for (const group of groups) {
			if (group.tasks.some((task) => !isFinished(task.status))) this.observedActiveGroups.add(group.id);
		}
		const rows = this.allRows();
		if (this.narrowGroup && !this.sessionGroups().some((group) => group.id === this.narrowGroup)) this.narrowGroup = undefined;
		if (!this.selectedId || (!this.selectedTask() && !rows.some((row) => row.id === this.selectedId))) {
			this.selectedId = rows.find((row) => row.kind === "task")?.id ?? rows[0]?.id;
		}
		if (!this.selectedTask()) this.narrowView = "list";
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, rows.length - this.bodyRows())));
		if (this.hoveredId && !rows.some((row) => row.id === this.hoveredId)) this.hoveredId = undefined;
		for (const card of this.cardExpansion.keys()) if (!this.tasks.some((task) => card.startsWith(`${task.id}\u0000`))) this.cardExpansion.delete(card);
		this.subscribeSelected();
	}

	private sessionGroups(): SessionGroup[] {
		const groups = new Map<string, SessionGroup>();
		for (const task of this.tasks) {
			const sessionId = task.parentSessionId.trim() || undefined;
			const id = sessionId ? `session:${sessionId}` : `unknown:${task.id}`;
			const group = groups.get(id) ?? { id, sessionId, tasks: [] };
			if (!groups.has(id)) groups.set(id, group);
			group.tasks.push(task);
		}
		for (const group of groups.values()) {
			// Active tasks first (newest created), then finished ones as history
			// (newest ended first) -- a task never reorders within its own group
			// just because it finished.
			group.tasks.sort((a, b) => {
				const finishedRank = Number(isFinished(a.status)) - Number(isFinished(b.status));
				if (finishedRank !== 0) return finishedRank;
				if (isFinished(a.status)) return (b.endedAt ?? 0) - (a.endedAt ?? 0);
				return b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
			});
		}
		if (this.scope === VIEW_SCOPE.ALL) {
			const localId = `session:${this.deps.sessionId}`;
			const local = groups.get(localId) ?? { id: localId, sessionId: this.deps.sessionId, tasks: [] };
			return [local, ...this.peers];
		}
		return [...groups.values()];
	}

	private visibleRows(): VisibleRow[] {
		if (!this.isNarrow() || this.scope === VIEW_SCOPE.SESSION) return this.allRows();
		const groups = this.sessionGroups();
		if (!this.narrowGroup) return groups.map((group) => ({ id: `heading:${group.id}`, kind: "heading", group }));
		const group = groups.find((entry) => entry.id === this.narrowGroup);
		return group?.tasks.map((task) => ({ id: `task:${task.id}`, kind: "task", group, task })) ?? [];
	}

	private allRows(): VisibleRow[] {
		const rows: VisibleRow[] = [];
		for (const group of this.sessionGroups()) {
			if (this.scope === VIEW_SCOPE.ALL) rows.push({ id: `heading:${group.id}`, kind: "heading", group });
			if (this.scope === VIEW_SCOPE.SESSION || this.isExpanded(group)) {
				for (const task of group.tasks) rows.push({ id: `task:${task.id}`, kind: "task", group, task });
			}
		}
		return rows;
	}

	private selectedRow(rows = this.visibleRows()): VisibleRow | undefined {
		if (this.directoryRoot() && this.narrowView === "list") return rows.find((row) => row.id === this.groupCursor) ?? rows[0];
		return rows.find((row) => row.id === this.selectedId);
	}

	private isExpanded(group: SessionGroup): boolean {
		return this.expanded.get(group.id) ?? this.observedActiveGroups.has(group.id);
	}

	private setExpanded(group: SessionGroup, expanded: boolean): void {
		if (this.isExpanded(group) === expanded) return;
		this.expanded.set(group.id, expanded);
		if (!expanded) {
			this.selectedId = `heading:${group.id}`;
			this.narrowView = "list";
		}
		this.listScroll = Math.min(this.listScroll, Math.max(0, this.visibleRows().length - this.bodyRows()));
		this.clearFooterLayout();
		this.subscribeSelected();
		this.deps.requestRender();
	}

	private subscribeSelected(): void {
		const task = this.selectedTask();
		if (task?.id === this.subscribedTaskId) return;
		this.unsubscribeTask?.();
		this.unsubscribeTask = undefined;
		this.subscribedTaskId = task?.id;
		if (!task || this.remoteThreads.has(task.id)) return;
		this.unsubscribeTask = this.deps.store.subscribe(task.id, () => {
			this.clearFooterLayout();
			this.refreshTasks();
			this.deps.requestRender();
		});
	}

	private taskLine(row: number): string {
		const visible = this.visibleRows();
		if (visible.length === 0) return row === 0 ? this.deps.theme.fg(ROLE.EMPTY, EMPTY_LIST) : "";
		const entry = visible[this.listScroll + row];
		if (!entry) return "";
		const theme = this.deps.theme;
		this.taskRegion(row).render(this.pointerLayout?.listWidth ?? 1);
		const selected = entry.id === this.selectedRow()?.id;
		// Selection always outranks hover; the shared hover painter only
		// applies once selection is ruled out.
		const hovered = !selected && entry.id === this.hoveredId;
		const markerRole = selected ? ROLE.SELECTED : hovered ? ROLE.HOVER : undefined;
		const marker = markerRole ? theme.fg(markerRole, selected ? "▸" : "▹") : " ";
		if (entry.kind === "heading") {
			const state = this.isExpanded(entry.group) ? "▾" : "▸";
			return `${marker}${paintHoverable(theme, state, hovered, ROLE.SELECTED)} ${paintHoverable(theme, this.groupHeading(entry.group), hovered, selected ? ROLE.SELECTED : ROLE.NAME_IDLE)}`;
		}
		const task = entry.task;
		const glyph = theme.fg(GLYPH_ROLE[task.status] ?? ROLE.META, GLYPH[task.status] ?? "?");
		const name = paintHoverable(theme, `Subagent ${task.agent}`, hovered, selected ? ROLE.SELECTED : ROLE.NAME_IDLE);
		const time = task.startedAt === null ? "" : theme.fg(ROLE.META, formatElapsed((task.endedAt ?? this.deps.now()) - task.startedAt));
		return `${marker} ${theme.fg(ROLE.META, "└")} ${glyph} ${name}  ${time}`;
	}

	private groupHeading(group: SessionGroup): string {
		const count = `${group.tasks.length} ${group.tasks.length === 1 ? "Subagent" : "Subagents"}`;
		if (!this.isExpanded(group)) return `${this.groupTitle(group)} · ${count}`;
		const active = group.tasks.filter((task) => !isFinished(task.status)).length;
		return `${this.groupTitle(group)} · ${count} · ${active} active`;
	}

	private groupTitle(group: SessionGroup): string {
		if (group.label) return group.label;
		if (!group.sessionId) return "Current orchestrator";
		if (group.sessionId === this.deps.sessionId) return "Current orchestrator";
		return `Orchestrator ${group.sessionId.slice(0, 8)}`;
	}

	private threadRows(task: TaskRecord, thread: TaskThread, width: number): { lines: string[]; owners: Array<string | undefined>; cards: boolean } {
		const presentation = this.threadPresentation();
		const cards = presentation === THREAD_PRESENTATION.CARDS;
		this.pruneCardExpansion(task, thread);
		const lines: string[] = [];
		const owners: Array<string | undefined> = [];
		// The layout keeps exactly one unpainted row between two drawn blocks -- a
		// tool card, prose, thinking, a note, whatever -- in the cards presentation.
		// The seam is layout, not part of a block's drawing, so it never depends on a
		// block owning a frame or on the style that drew the frame: a block that
		// falls back to plain rows is separated exactly like a card. Nothing is added
		// inside a block, before the first one or after the last, and the labeled log
		// keeps the spacing it always had.
		let drawn = 0;
		const pushBlock = (drawing: ThreadItemDrawing, owner?: string): void => {
			if (drawing.lines.length === 0) return;
			if (cards && drawn > 0) {
				lines.push("");
				owners.push(undefined);
			}
			lines.push(...drawing.lines);
			for (let index = 0; index < drawing.lines.length; index += 1) owners.push(owner);
			drawn += 1;
		};
		// The message the subagent was asked is the one input outside the thread — a
		// delivery to the child is retained as a note, this is not. Only cards draw
		// it; the log never showed it and still does not.
		if (cards && task.prompt.trim().length > 0) pushBlock({ lines: agentMessageCard(task.prompt, this.deps.theme, width), card: true });
		if (thread.dropped > 0) pushBlock({ lines: [this.deps.theme.fg(ROLE.META, `… ${thread.dropped} earlier items not kept`)], card: false });
		// A retained item's rows are drawn once and reused on a full match. The frame
		// part names what every card in it was drawn under — width, the two detail
		// levels, the shared card style and content preference, the pane's own expand
		// binding, and the dev-binary override a bash card reads — and is resolved once
		// per frame. The item part adds what this one row adds on top: its kind, its
		// resolved level, the hint text, and the identity of the card that will draw it.
		// The labeled log keeps the plain key it always had: its rows depend on the
		// width alone, and it has no cards, detail levels or hints to vary.
		const frame = cards ? this.cardFrame(width) : `${width}\u0000${presentation}\u0000log`;
		const expandHint = cards ? this.outputExpandHint() : undefined;
		// Rows the thread itself contributes. The input card above is not thread
		// content, so it never stands in for the state line below.
		let retained = 0;
		for (const item of thread.items) {
			const card = cards && item.kind === THREAD_ITEM.TOOL ? this.cardKey(task, item.callId) : undefined;
			const expanded = card === undefined ? this.cardToolsExpanded : this.cardExpansion.get(card) ?? this.cardToolsExpanded;
			// Only a tool has a card to read; anything else was drawn by this pane alone.
			const slot = cards && item.kind === THREAD_ITEM.TOOL ? agentToolRowCard(item.name) : undefined;
			// The labeled log keeps the one key it always had: its rows depend on the
			// width alone, so nothing per item belongs in it.
			const key = cards ? `${frame}\u0000${item.kind}\u0000${expanded}\u0000${expandHint ?? ""}\u0000${cardId(slot?.renderer)}` : frame;
			// A call still receiving output is never reused: its rows are being written.
			const finished = item.kind !== THREAD_ITEM.TOOL || !item.running;
			const cached = finished ? this.cache.get(item) : undefined;
			const drawing = cached?.key === key ? cached : drawThreadItem(item, this.deps.theme, width, { presentation, expanded, thinkingExpanded: this.thinkingExpanded, expandHint });
			if (finished && cached?.key !== key && this.reusableRow(item, slot)) this.cache.set(item, { ...drawing, key });
			pushBlock(drawing, card);
			retained += drawing.lines.length;
		}
		// A task with nothing retained still says what it recorded — the error it
		// ended with, or that it is waiting — exactly as the empty thread always did.
		if (retained === 0 && thread.dropped === 0) {
			pushBlock({ lines: [this.deps.theme.fg(ROLE.EMPTY, task.error ?? EMPTY_THREAD)], card: false });
		}
		return { lines, owners, cards };
	}

	// Everything one frame's cards were drawn under, resolved once: repeating any of
	// it per item would resolve the dev-binary override for every retained call.
	private cardFrame(width: number): string {
		return [
			String(width),
			THREAD_PRESENTATION.CARDS,
			String(this.thinkingExpanded),
			String(this.cardToolsExpanded),
			cardStyle(),
			cardContent(),
			// A bash card's heading is the preference's identity, so its rows belong to it.
			cardBash(),
			this.bindingKeys("app.tools.expand").join("\u0000"),
			devBinaryIdentity(),
		].join("\u0000");
	}

	// The pane's own drawings — prose, thinking, notes, the memory design — depend on
	// the item and the frame alone, so they are always reusable. A published card is
	// reused only where its publisher declares its rows stable; a card that declares
	// nothing stays valid and is simply drawn again, and a tool the pane drew because
	// no record published a stable card keeps being drawn per frame.
	private reusableRow(item: ThreadItem, slot: AgentToolRowCard | undefined): boolean {
		if (slot === undefined) return true;
		if (slot.rowStable) return true;
		// An external memory plugin publishes no card for this pane, so its compact
		// design is this pane's own pure drawing.
		return item.kind === THREAD_ITEM.TOOL && slot.renderer === undefined && isMemoryToolName(item.name);
	}

	private threadWindow(rows: number, width: number): string[] {
		const task = this.selectedTask();
		if (!task) return [this.deps.theme.fg(ROLE.EMPTY, "Select a task to inspect its thread")];
		const theme = this.deps.theme;
		const header = theme.fg(ROLE.META, truncateToWidth(taskHeader(task, this.deps.now()), width, "…"));
		const { lines, owners, cards } = this.threadRows(task, this.remoteThreads.get(task.id) ?? this.deps.store.thread(task.id), width);
		const visible = Math.max(0, rows - 1);
		const maxScroll = Math.max(0, lines.length - visible);
		if (this.follow) this.scroll = maxScroll;
		// A taller/wider presentation may clamp its window, not the saved position.
		const start = Math.min(this.scroll, maxScroll);
		// Only a cards view has a card under the pointer; the log's rows belong to
		// no call, so a click there stays as inert as it always was.
		if (this.pointerLayout) this.pointerLayout.threadCards = cards ? [undefined, ...owners.slice(start, start + visible)] : undefined;
		return [header, ...lines.slice(start, start + visible)];
	}

	private select(index: number, rows = this.visibleRows(), revealSelection = true): void {
		const next = rows[Math.max(0, Math.min(rows.length - 1, index))];
		if (!next) return;
		// Keyboard movement reveals the selection; pointer activation keeps the
		// manually positioned list available for Back, even after height clamping.
		if (revealSelection) this.manualListOffsets.delete(this.listKey());
		if (this.directoryRoot()) {
			this.groupCursor = next.id;
			this.clearFooterLayout();
			this.deps.requestRender();
			return;
		}
		if (next.id === this.selectedId) return;
		this.selectedId = next.id;
		if (next.kind === "heading") this.narrowView = "list";
		this.scroll = 0;
		this.follow = true;
		this.clearFooterLayout();
		this.subscribeSelected();
		this.deps.requestRender();
	}

	// One page is the thread area: the body minus its header row.
	private pageRows(): number {
		return Math.max(1, this.bodyRows() - 1);
	}

	private scrollBy(delta: number): void {
		const task = this.selectedTask();
		const layout = this.layout();
		const lines = task ? this.threadRows(task, this.remoteThreads.get(task.id) ?? this.deps.store.thread(task.id), layout.threadWidth).lines : [];
		const maxScroll = Math.max(0, lines.length - Math.max(0, layout.bodyRows - 1));
		this.follow = false;
		// Clamp the current visible position before moving, including after resize.
		this.scroll = Math.max(0, Math.min(maxScroll, Math.min(this.scroll, maxScroll) + delta));
		this.deps.requestRender();
	}

	// Ctrl+Home leaves follow at the thread's first row, so a live event cannot
	// pull the reader back down while they are reading from the start.
	private scrollToStart(): void {
		this.follow = false;
		this.scroll = 0;
		this.deps.requestRender();
	}

	// Ctrl+End returns to the tail and resumes following it.
	private scrollToEnd(): void {
		this.follow = true;
		this.deps.requestRender();
	}

	private clearFooterLayout(): void {
		this.pointerLayout = undefined;
		this.hoveredControl = undefined;
		this.pointerScope.invalidate();
	}

	private footer(keys: string, width: number): string {
		const task = this.actionableTask();
		const controls = [
			{ label: FOLLOW_BUTTON, short: "Follow", region: this.followRegion, enabled: Boolean(task) },
			{ label: OPEN_BUTTON, short: "Open", region: this.openRegion, enabled: this.canOpen(task) },
		];
		if (task && this.canCancel(task)) controls.push({ label: STOP_BUTTON, short: "Stop", region: this.actionRegion("stop", () => this.handleInput("s")), enabled: true });
		if (this.deps.sessionId !== undefined) controls.push({ label: SCOPE_BUTTON, short: "Scope", region: this.actionRegion("scope", () => this.toggleScope()), enabled: true });
		for (const control of controls) control.region.setDisabled(!control.enabled);
		const required = controls.reduce((sum, control) => sum + control.label.length + 1, -1);
		const shown = required <= width ? controls : [controls[this.footerPage % controls.length]];
		const actions: NonNullable<PointerLayout["actions"]> = [];
		let text = "";
		for (const control of shown) {
			const label = required <= width ? control.label : control.short;
			if (text) text += " ";
			actions.push({ x: 2 + visibleWidth(text), width: label.length, region: control.region });
			control.region.render(label.length);
			const hovered = (control.region === this.followRegion && this.hoveredControl === "follow") || (control.region === this.openRegion && this.hoveredControl === "open");
			text += control.enabled ? paintHoverable(this.deps.theme, label, hovered, ROLE.KEY) : this.deps.theme.fg(ROLE.META, label);
		}
		if (required > width) {
			const more = this.actionRegion("more", () => {
				this.footerPage++;
				this.clearFooterLayout();
				this.deps.requestRender();
			});
			more.render(1);
			actions.push({ x: 2 + width - 1, width: 1, region: more });
			text = fit(text, width - 1) + ">";
		} else if (visibleWidth(text) + 1 < width) text += " " + truncateToWidth(keys, width - visibleWidth(text) - 1, "…");
		if (this.pointerLayout) this.pointerLayout.actions = actions;
		return text;
	}

	private actionRegion(id: string, action: () => void): NativePointerRegion {
		let region = this.actionRegions.get(id);
		if (!region) {
			region = this.pointerScope.wrap(EMPTY_COMPONENT, {
				onClick: (event) => {
					if (event.button !== "left") return undefined;
					action();
					return { handled: true, render: true };
				},
			});
			this.actionRegions.set(id, region);
		}
		return region;
	}

	private modeLabel(layout: AgentsViewLayout): string | undefined {
		if (this.narrowView === "details" || (this.isNarrow() && this.narrowGroup)) return layout.width < 24 ? "←" : "[← Back]";
		return !this.isNarrow() && this.selectedTask() ? "[F Fullscreen]" : undefined;
	}

	private closeLabel(layout: AgentsViewLayout): string | undefined {
		if (layout.mode === "fallback") return undefined;
		return layout.width < 60 ? "[×]" : CLOSE_BUTTON;
	}

	private setNarrowView(view: "list" | "details"): void {
		if (view === this.narrowView || (view === "details" && !this.selectedTask())) return;
		this.narrowView = view;
		this.clearFooterLayout();
		this.deps.requestRender();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopPresenceRefresh();
		this.pointerScope.invalidate();
		this.deps.onClose();
	}

	private isInButton(x: number, button: PointerButtonLayout | undefined): boolean {
		return button !== undefined && x >= button.x && x < button.x + button.width;
	}

	private hoverControl(control: "follow" | "open" | "close" | "mode"): TuiMouseEventResult {
		if (this.hoveredControl === control) return { handled: true };
		this.hoveredControl = control;
		return { handled: true, render: true };
	}

	private clearHoveredControl(control: "follow" | "open" | "close" | "mode"): void {
		if (this.hoveredControl !== control) return;
		this.hoveredControl = undefined;
		this.deps.requestRender();
	}

	private clickFollow(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || !this.selectedTask()) return undefined;
		this.follow = true;
		return { handled: true, render: true };
	}

	private clickOpen(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		const task = this.selectedTask();
		if (!this.canOpen(task)) return undefined;
		this.deps.onOpen(task!);
		return { handled: true, render: true };
	}

	private clickClose(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		this.close();
		return { handled: true, render: true };
	}

	private clickMode(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		if (this.narrowView === "details" || (this.isNarrow() && this.narrowGroup)) this.back();
		else this.activate();
		return { handled: true, render: true };
	}

	private taskRegion(row: number): NativePointerRegion {
		let region = this.taskRegions.get(row);
		if (!region) {
			region = this.pointerScope.wrap(EMPTY_COMPONENT, {
				onHover: () => this.hoverTask(row),
				onLeave: () => this.clearHoveredTask(row),
				onClick: (event) => this.clickTask(row, event),
			});
			this.taskRegions.set(row, region);
		}
		return region;
	}

	private hoverTask(row: number): TuiMouseEventResult | undefined {
		const entry = this.visibleRows()[this.listScroll + row];
		if (!entry || this.hoveredId === entry.id) return { handled: true };
		this.hoveredId = entry.id;
		return { handled: true, render: true };
	}

	private clearHoveredTask(row: number): void {
		const entry = this.visibleRows()[this.listScroll + row];
		if (!entry || this.hoveredId !== entry.id) return;
		this.hoveredId = undefined;
		this.deps.requestRender();
	}

	private clickTask(row: number, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		const entry = this.visibleRows()[this.listScroll + row];
		if (!entry) return undefined;
		if (this.isNarrow()) {
			this.select(this.listScroll + row, this.visibleRows(), false);
			this.activate();
		} else if (entry.kind === "heading") this.setExpanded(entry.group, !this.isExpanded(entry.group));
		else this.select(this.listScroll + row);
		return { handled: true, render: true };
	}

	private wheelList(event: TuiMouseEvent): TuiMouseEventResult {
		const delta = event.wheelDelta ?? 0;
		const next = Math.max(0, Math.min(Math.max(0, this.visibleRows().length - this.bodyRows()), this.listScroll + delta));
		if (next === this.listScroll) return { handled: true, render: false };
		this.listScroll = next;
		this.manualListOffsets.set(this.listKey(), next);
		this.clearFooterLayout();
		this.hoveredId = undefined;
		return { handled: true, render: true };
	}

	private wheelThread(event: TuiMouseEvent): TuiMouseEventResult {
		const delta = event.wheelDelta ?? 0;
		if (delta === 0) return { handled: true, render: false };
		this.scrollBy(delta);
		return { handled: true, render: true };
	}

	// A click belongs to the card under it, not to the whole pane: only that
	// card's expansion changes, so one call can be opened without losing the
	// collapsed overview around it.
	private clickThread(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		const card = this.pointerLayout?.threadCards?.[event.y - 1];
		if (card === undefined) return undefined;
		this.flipCardExpansion(card);
		this.clearFooterLayout();
		this.deps.requestRender();
		return { handled: true, render: true };
	}
}
