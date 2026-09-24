import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { NativePointerRegion } from "../lib/native-pointer-region.ts";
import { sidebarPart } from "../lib/shell-sidebar.ts";
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
	todoPromptBlock,
	todoSummary,
	type TodoParams,
	type TodoState,
} from "../lib/shell-todo.ts";

// Gentle Todo: the task list the model keeps while it works, drawn as a
// Gentle Shell card above the editor. Three things keep it current that a
// static tool description cannot: `write` replaces the whole list in one
// call, every turn's system prompt carries the open tasks and the rules, and
// a list that goes untouched while tasks stay open is marked stale for both
// the human and the model.

const WIDGET_KEY = "gentle-todo";
const COLLAPSE_KEY_DEFAULT = "ctrl+shift+t";
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
					status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Defaults to pending." },
					note: { type: "string", description: "What is happening right now, shown while in_progress, e.g. 'writing tests'." },
				},
			},
		},
		id: { type: "integer", description: "Task id for update." },
		title: { type: "string", description: "Title for add, or a new title for update." },
		status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Status for add or update." },
		note: { type: "string", description: "Note for add or update." },
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
	collapsed: boolean;
	/** A finished list stays on screen for the turn it finished in, then clears. */
	clearOnNextTurn: boolean;
	ui: ExtensionContext["ui"] | undefined;
	host: { requestRender(): void } | undefined;
	tui: TUI | undefined;
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
			current = { state: emptyTodo(), turn: 0, collapsed: false, clearOnNextTurn: false, ui: undefined, host: undefined, tui: undefined };
			sessions.set(key, current);
		}
		return current;
	};

	const toggle = (current: TodoSession) => {
		current.collapsed = !current.collapsed;
		if (current.tui) invalidateSidebar(current.tui);
		current.host?.requestRender();
	};

	const todoCard = (current: TodoSession, theme: Parameters<typeof renderTodoCard>[1], scrollable: boolean, spacer: boolean): Component & { dispose(): void } => {
		let hovered = false;
		const card: Component = {
			render(width: number) {
				const lines = renderTodoCard(current.state, theme, width, {
					collapsed: current.collapsed,
					staleTurns: staleTurns(current.state, current.turn),
					collapseKey,
					hovered,
					...(scrollable ? { scrollable: true } : {}),
				});
				return spacer && lines.length > 0 ? [...lines, ""] : lines;
			},
			invalidate() {
				hovered = false;
			},
		};
		const region = new NativePointerRegion(card, {
			onHover(event) {
				// The region spans the whole card, but only the header row (y===0)
				// is the clickable control, so a move elsewhere in the card clears
				// hover exactly like leaving the region entirely would.
				const next = event.y === 0;
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
				if (event.button !== "left" || event.y !== 0) return undefined;
				toggle(current);
				return { handled: true, render: true };
			},
		});
		return {
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
			current.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const snapshot = current;
		current.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			snapshot.host = tui;
			snapshot.tui = tui;
			return sidebarPart(tui, "todo", todoCard(snapshot, theme, false, true), todoCard(snapshot, theme, true, false));
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

	pi.on("session_start", (_event, ctx) => {
		const current = session(ctx);
		// A list that was already finished when the session was left is history,
		// not work: it would otherwise sit on screen until two more turns pass.
		const replayed = replayTodo(ctx.sessionManager.getBranch());
		current.state = replayed.tasks.length > 0 && todoSummary(replayed).open === 0 ? { ...replayed, tasks: [] } : replayed;
		current.turn = ctx.sessionManager.getBranch().filter((entry) => (entry as { type?: string }).type === "message" && (entry as { message?: { role?: string } }).message?.role === "user").length;
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
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
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
