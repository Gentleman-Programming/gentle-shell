import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";
import { NativePointerRegion } from "../lib/native-pointer-region.ts";
import { panelHeaderRow } from "../lib/shell-card.ts";
import { sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";
import { invalidateSidebar } from "../lib/shell-sidebar-layout.ts";
import {
	applyTodo,
	emptyTodo,
	renderTodoCard,
	replayTodo,
	staleTurns,
	TODO_DETAILS_KEY,
	TODO_GLYPH,
	TODO_TOOL_NAME,
	todoCardTone,
	todoPromptBlock,
	todoSummary,
	type TodoParams,
	type TodoState,
} from "../lib/shell-todo.ts";

// Gentle Todo: the task list the model keeps while it works, drawn as a
// Gentle Shell card above the editor. Three things keep it current that a
// static tool description cannot: `write` replaces the whole list in one
// call, each run's system prompt carries the open tasks and the rules, and
// a list that goes untouched while tasks stay open is marked stale for both
// the human and the model. Long runs also receive one request-local reminder
// after several tool-use turns, without waking the agent or changing tasks.

const WIDGET_KEY = "gentle-todo";
const STATUS_ENUM = ["pending", "in_progress", "blocked", "done", "dropped"];
const COLLAPSE_KEY_DEFAULT = "ctrl+shift+t";
const REMIND_AFTER_TOOL_TURNS = 4;
const TODO_REMINDER = "The todo plan has not been reviewed during several tool-use turns. Check whether it still matches the work performed and update tasks where needed. Do not mark work done without verification.";
const TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["action"],
	properties: {
		action: { type: "string", enum: ["write", "add", "update", "clear", "list"], description: "write replaces the whole list; add appends one task; update changes one task by id; clear empties the list; list reports it." },
		tasks: {
			type: "array",
			description: "For write: the complete ordered list. Keep the id of tasks that already exist so their history survives; omit it for new ones.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["title"],
				properties: {
					id: { type: "integer", description: "Existing task id to keep." },
					title: { type: "string", description: "Short imperative title, e.g. 'Write the parser'." },
					status: { type: "string", enum: STATUS_ENUM, description: "Defaults to pending. blocked: open but waiting on something outside the list; dropped: will not be done, on purpose." },
					note: { type: "string", description: "What is happening right now, shown while in_progress, e.g. 'writing tests'; required for blocked, naming what it waits for, e.g. 'waiting for an admin'." },
				},
			},
		},
		id: { type: "integer", description: "Task id for update." },
		title: { type: "string", description: "Title for add, or a new title for update." },
		status: { type: "string", enum: STATUS_ENUM, description: "Status for add or update." },
		note: { type: "string", description: "Note for add or update; required for blocked." },
	},
} as const;

export function todoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return false;
	const value = env.GENTLE_PI_TODO?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}

export function todoCollapseKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_TODO_KEY?.trim();
	if (value === undefined) return COLLAPSE_KEY_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}

interface TodoSession {
	state: TodoState;
	turn: number;
	/** Separate from the existing run-based card freshness. */
	toolTurnsSinceWrite: number;
	reminded: boolean;
	wroteThisTurn: boolean;
	collapsed: boolean;
	/** A finished list stays on screen for the turn it finished in, then clears. */
	clearOnNextTurn: boolean;
	ui: ExtensionContext["ui"] | undefined;
	host: { requestRender(): void } | undefined;
	tui: TUI | undefined;
	/** Resolve the visible host when the key is pressed, not when it renders. */
	scrollTodo?: (lines: number) => void;
}

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

export default function gentleTodo(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	if (!todoEnabled(env)) return;
	const sessions = new Map<string, TodoSession>();
	const collapseKey = todoCollapseKey(env);

	const session = (ctx: ExtensionContext): TodoSession => {
		const key = sessionKey(ctx);
		let current = sessions.get(key);
		if (!current) {
			current = { state: emptyTodo(), turn: 0, toolTurnsSinceWrite: 0, reminded: false, wroteThisTurn: false, collapsed: false, clearOnNextTurn: false, ui: undefined, host: undefined, tui: undefined };
			sessions.set(key, current);
		}
		return current;
	};

	const toggle = (current: TodoSession) => {
		current.collapsed = !current.collapsed;
		if (current.tui) invalidateSidebar(current.tui);
		current.host?.requestRender();
	};

	const todoCard = (current: TodoSession, theme: Parameters<typeof renderTodoCard>[1], spacer: boolean): Component & { dispose(): void; digest(): string; scrollBy(lines: number): void } => {
		let hovered = false;
		let body: string[] = [];
		let collapsed = current.collapsed;
		// Widgets are measured as leaves, so native layout cannot assign this
		// body a viewport. Use native scroll state and explicitly slice its lines
		// while keeping the collapse header and card footer outside the viewport.
		const scroll = new ScrollView({ render: () => body, invalidate() {} }, { follow: "none", overscroll: "contain" });
		const scrollBy = (lines: number) => {
			if (current.collapsed) return;
			scroll.scrollBy(lines);
			if (current.tui) invalidateSidebar(current.tui);
			current.host?.requestRender();
		};
		// The row the rendered card draws its header on: 0 for the outlined
		// frame, 1 below the float panel's top padding row.
		let headerRow = 0;
		const card: Component = {
			render(width: number) {
				const stale = staleTurns(current.state, current.turn);
				headerRow = panelHeaderRow(theme, width, todoCardTone(stale));
				const lines = renderTodoCard(current.state, theme, width, {
					collapsed: current.collapsed,
					staleTurns: stale,
					collapseKey,
					hovered,
					scrollable: true,
				});
				if (collapsed !== current.collapsed) {
					collapsed = current.collapsed;
					scroll.scrollToStart();
				}
				// At most one third of the screen, capped at 16 rows. Read height
				// on every render so a mobile resize immediately releases chat space.
				const terminalRows = current.tui?.terminal?.rows ?? 48;
				const height = Math.min(16, Math.floor(terminalRows / 3));
				const bodyStart = headerRow === 1 ? 3 : 1;
				body = lines.slice(bodyStart, -1);
				const overflow = !current.collapsed && lines.length + Number(spacer) > height;
				const room = Math.max(1, height - bodyStart - 1 - Number(spacer) - Number(overflow));
				scroll.updateLayout(body.length, current.collapsed ? body.length : room, () => current.host?.requestRender());
				const visible = scroll.render(width).slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
				const output = [...lines.slice(0, bodyStart), ...visible, ...lines.slice(-1)];
				if (overflow) output.push(theme.fg("muted", truncateToWidth(`↑↓ ${scroll.scrollTop + 1}–${scroll.scrollTop + visible.length}/${body.length} · ctrl+shift+↑/↓`, width)));
				return spacer && output.length > 0 ? [...output, ""] : output;
			},
			invalidate() {
				hovered = false;
			},
		};
		const region = new NativePointerRegion(card, {
			onHover(event) {
				// The region spans the whole card, but only the header row is the
				// clickable control, so a move elsewhere in the card clears hover
				// exactly like leaving the region entirely would.
				const next = event.y === headerRow;
				if (next === hovered) return { handled: true };
				hovered = next;
				return { handled: true, render: true };
			},
			onLeave() {
				if (!hovered) return;
				hovered = false;
				current.host?.requestRender();
			},
			onClick(event) {
				if (event.button !== "left" || event.y !== headerRow) return undefined;
				toggle(current);
				return { handled: true, render: true };
			},
			onWheel(event) {
				if (current.collapsed || body.length <= scroll.viewportHeight) return undefined;
				scrollBy(event.wheelDelta ?? 0);
				return { handled: true, render: true };
			},
		});
		return {
			scrollBy,
			// Sidebar caches must observe height-only resizes and local viewport
			// changes, even when terminal width and task content stay the same.
			digest: () => JSON.stringify([current.tui?.terminal?.rows, current.collapsed, current.turn, hovered, scroll.scrollTop]),
			render: (width) => region.render(width),
			handleMouse: (event) => region.handleMouse(event),
			invalidate: () => region.invalidate(),
			dispose: () => region.dispose(),
		};
	};

	const show = (current: TodoSession) => {
		if (current.tui) invalidateSidebar(current.tui);
		if (!current.ui) return;
		if (current.state.tasks.length === 0) {
			current.scrollTodo = undefined;
			current.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const snapshot = current;
		current.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			snapshot.host = tui;
			snapshot.tui = tui;
			const bottom = todoCard(snapshot, theme, true);
			const rail = todoCard(snapshot, theme, false);
			snapshot.scrollTodo = (lines) => {
				// Cached rail lines do not re-render when a narrow→wide resize
				// restores the sidebar. Select ownership from the live layout.
				const state = tui.terminal ? sidebarState(tui) : undefined;
				(state?.active && state.ownsHost?.() ? rail : bottom).scrollBy(lines);
			};
			return sidebarPart(tui, "todo", bottom, rail);
		});
	};

	pi.registerTool({
		name: TODO_TOOL_NAME,
		renderShell: "self",
		label: "Todo",
		description: "Plan and track multi-step work. Use write to set the whole list, update to move one task, add for a new one, clear to reset, list to read it back.",
		promptSnippet: "Track multi-step work; rewrite the whole list as the plan changes",
		promptGuidelines: [
			"Use todo for work with three or more steps or when the user hands you a list. Skip it for single trivial requests.",
			"Mark a task in_progress before starting it and done right after finishing it; keep exactly one task in_progress.",
			"Prefer write with the complete list whenever the plan changes; keep ids of tasks that already exist.",
			"Never mark a task done while tests fail or the work is partial; add a task for the blocker instead.",
			"Mark a task blocked with a note naming what it waits for only when that is outside the list (a person, another team, an authorization); a prerequisite in the list is ordering, so keep the task pending. Return it to pending once the condition holds.",
			"When the plan changes, mark tasks it made obsolete dropped, never done; dropped tasks no longer count as open.",
		],
		parameters: TOOL_PARAMETERS,
		executionMode: "sequential",
		renderCall(args, theme) {
			const params = args as TodoParams;
			return new Text(theme.fg("toolTitle", `${TODO_GLYPH} todo · ${params.action}`), 0, 0);
		},
		renderResult(result, options, theme) {
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			return new Text(options.expanded ? text : theme.fg("muted", text.split("\n")[0] ?? ""), 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = session(ctx);
			const result = applyTodo(current.state, params as TodoParams, current.turn);
			if (!result.error) {
				current.state = result.state;
				current.clearOnNextTurn = false;
				if (params.action !== "list") {
					current.toolTurnsSinceWrite = 0;
					current.reminded = false;
					current.wroteThisTurn = true;
				}
				if (current.tui) invalidateSidebar(current.tui);
			}
			return {
				content: [{ type: "text", text: result.text }],
				details: { [TODO_DETAILS_KEY]: result.state, ...(result.error ? { error: result.error } : {}) },
			};
		},
	});

	if (collapseKey) {
		pi.registerShortcut(collapseKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Collapse or expand the todo list",
			handler: async (ctx) => {
				toggle(session(ctx));
			},
		});
	}

	for (const [key, lines] of [["ctrl+shift+up", -3], ["ctrl+shift+down", 3]] as const) {
		pi.registerShortcut(key, {
			description: `Scroll the Todo list ${lines < 0 ? "up" : "down"}`,
			handler: async (ctx) => session(ctx).scrollTodo?.(lines),
		});
	}

	pi.on("session_start", (_event, ctx) => {
		const current = session(ctx);
		// A list that was already finished when the session was left is history,
		// not work: it would otherwise sit on screen until two more turns pass.
		const replayed = replayTodo(ctx.sessionManager.getBranch());
		current.state = replayed.tasks.length > 0 && todoSummary(replayed).open === 0 ? { ...replayed, tasks: [] } : replayed;
		current.turn = ctx.sessionManager.getBranch().filter((entry) => (entry as { type?: string }).type === "message" && (entry as { message?: { role?: string } }).message?.role === "user").length;
		current.toolTurnsSinceWrite = 0;
		current.reminded = false;
		current.wroteThisTurn = false;
		current.ui = ctx.hasUI ? ctx.ui : undefined;
		show(current);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessions.delete(sessionKey(ctx));
	});

	pi.on("before_agent_start", (event, ctx) => {
		const current = session(ctx);
		current.turn += 1;
		if (current.tui) invalidateSidebar(current.tui);
		if (current.clearOnNextTurn) {
			current.state = { ...current.state, tasks: [] };
			current.clearOnNextTurn = false;
			show(current);
		}
		const block = todoPromptBlock(current.state, staleTurns(current.state, current.turn));
		if (!block) return undefined;
		// gentle-shell#1485: pi-claude-bridge drops a handler-returned
		// systemPrompt, so the open-tasks block goes through appendSystemPrompt.
		appendSystemPromptOnce(event.systemPromptOptions, block);
		return undefined;
	});

	pi.on("turn_end", (event, ctx) => {
		const current = session(ctx);
		// A turn containing a valid todo write is already reconciled. Failed
		// writes and list reads deliberately do not refresh this counter.
		if (!current.wroteThisTurn && event.message.role === "assistant" && event.message.content.some((part) => part.type === "toolCall")) {
			current.toolTurnsSinceWrite += 1;
		}
		current.wroteThisTurn = false;
	});

	pi.on("context", (event, ctx) => {
		const current = session(ctx);
		if (current.reminded || current.toolTurnsSinceWrite < REMIND_AFTER_TOOL_TURNS) return undefined;
		if (!current.state.tasks.some((task) => task.status === "pending" || task.status === "in_progress")) return undefined;
		current.reminded = true;
		// Context transforms are request-local: no transcript entry, UI
		// notification, continuation or provider-specific wake is needed.
		return {
			messages: [...event.messages, { role: "custom" as const, customType: "gentle-todo-reminder", content: TODO_REMINDER, display: false, timestamp: Date.now() }],
		};
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== TODO_TOOL_NAME) return;
		show(session(ctx));
	});

	pi.on("agent_end", (_event, ctx) => {
		const current = session(ctx);
		if (current.state.tasks.length > 0 && todoSummary(current.state).open === 0) current.clearOnNextTurn = true;
		show(current);
	});
}
