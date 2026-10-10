import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import gentleTodo, { todoCollapseKey, todoEnabled } from "../extensions/gentle-todo.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";

// The card style defaults to float; these assertions pin the outlined (neon)
// panels unless a test switches the style itself.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

// The Gentle Todo extension: the `todo` tool, the card above the editor,
// the per-turn prompt block, and the staleness signal, driven by fakes.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Registered {
	renderShell?: string;
	execute(toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	renderCall(args: unknown, theme: unknown): { render(width: number): string[] };
	renderResult(result: unknown, options: { expanded: boolean }, theme: unknown): { render(width: number): string[] };
}

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	strikethrough(text: string) {
		return `~${text}~`;
	},
};
const fakeTui = { requestRender() {} };
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Registered>();
	const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> }>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: Registered & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerShortcut(key: string, registration: { handler(ctx: ExtensionContext): Promise<void> }) {
			shortcuts.set(key, registration);
		},
	} as unknown as ExtensionAPI;
	const fire = async (event: string, ctx: ExtensionContext, payload: unknown = {}) => {
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
		return last;
	};
	return { pi, tools, shortcuts, fire };
}

function fakeContext(branch: unknown[] = [], hasUI = true) {
	const widgets = new Map<string, (tui: unknown, theme: unknown) => Component>();
	const ctx = {
		hasUI,
		sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
		ui: {
			setWidget(key: string, content: ((tui: unknown, theme: unknown) => Component) | undefined) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, content);
			},
		},
	} as unknown as ExtensionContext;
	const widgetComponent = () => {
		const factory = widgets.get("gentle-todo");
		return factory?.(fakeTui, plainTheme);
	};
	const widget = () => widgetComponent()?.render(70).map(stripAnsi);
	return { ctx, widgets, widget, widgetComponent };
}

test("long Todo widgets stay bounded, scroll, resize and keep their collapse control in mobile and sidebar", async (t) => {
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		setCardStyle(style);
		const { pi, tools, fire, shortcuts } = fakePi();
		gentleTodo(pi, {});
		const { ctx, widgets } = fakeContext();
		await fire("session_start", ctx);
		const title = "long active title ".repeat(150);
		const note = "description ".repeat(150);
		const result = await tools.get("todo")!.execute("write", { action: "write", tasks: [{ title, note, status: "in_progress" }, { title: "LAST TASK" }] }, undefined, undefined, ctx);
		await fire("tool_execution_end", ctx, { toolName: "todo" });
		const tui = { requestRender() {}, terminal: { rows: 30, columns: 40 } };
		const theme = { ...plainTheme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
		const bottom = widgets.get("gentle-todo")!(tui, theme);
		const rail = sidebarState(tui as never).parts.get("todo")!;
		for (const component of [bottom, rail]) {
			const before = component.render(40).map(stripAnsi);
			assert.ok(before.length <= 10, "card uses at most one third of terminal height");
			const header = style === CARD_STYLE.FLOAT ? 1 : 0;
			assert.match(before[header]!, /Todos ▾/);
			assert.equal(component.handleMouse?.({ type: "wheel", button: "none", wheelDelta: 10000, x: 5, y: header + 2, screenX: 5, screenY: 5, width: 40, height: before.length, shift: false, alt: false, ctrl: false })?.handled, true);
			const after = component.render(40).map(stripAnsi);
			assert.match(after[header]!, /Todos ▾/);
			assert.match(after.join("\n"), /LAST TASK/, "all details remain reachable by scrolling");
			assert.notDeepEqual(after, before);
		}
		tui.terminal.rows = 24;
		assert.ok(bottom.render(40).length <= 8, "height responds to resize");
		await shortcuts.get("ctrl+shift+t")!.handler(ctx);
		const collapsed = bottom.render(40).map(stripAnsi);
		assert.ok(collapsed.length <= (style === CARD_STYLE.FLOAT ? 6 : 4));
		assert.match(collapsed.join("\n"), /long active title/);
		assert.match(collapsed.join("\n"), /…/);
		assert.equal((result.details.gentleTodo as { tasks: { title: string; note: string }[] }).tasks[0].title, title.trim());
		assert.equal((result.details.gentleTodo as { tasks: { title: string; note: string }[] }).tasks[0].note, note.trim());
		await shortcuts.get("ctrl+shift+t")!.handler(ctx);
		await shortcuts.get("ctrl+shift+down")!.handler(ctx);
		assert.notDeepEqual(bottom.render(40), collapsed, "keyboard scrolling is available without mouse");
	}
	t.after(() => setCardStyle(CARD_STYLE.NEON));
});

test("Todo keyboard scrolling targets the visible card after a cached sidebar breakpoint round-trip", async (t) => {
	const node = Symbol.for("@earendil-works/pi-tui/layout-node");
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		setCardStyle(style);
		const { pi, tools, fire, shortcuts } = fakePi();
		gentleTodo(pi, {});
		const { ctx, widgets } = fakeContext();
		await fire("session_start", ctx);
		await tools.get("todo")!.execute("write", { action: "write", tasks: [{ title: Array.from({ length: 100 }, (_, i) => `TITLE${i}`).join(" "), status: "in_progress" }] }, undefined, undefined, ctx);
		await fire("tool_execution_end", ctx, { toolName: "todo" });
		const root = { render: () => [], invalidate() {}, [node]: () => ({ type: "vstack", entries: [] }) };
		const tui = { mode: "fullscreen", terminal: { rows: 30, columns: 160 }, layoutRoot: root, requestRender() {} };
		const theme = { ...plainTheme, bold: (text: string) => text, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
		const bottom = widgets.get("gentle-todo")!(tui, theme);
		const dispose = installSidebar(tui as unknown as TUI, theme);
		try {
			const railLines = () => {
				const layout = root[node]() as unknown as { entries: { component: Component }[] };
				return layout.entries[1]!.component.render(50).map(stripAnsi);
			};
			railLines();
			tui.terminal.columns = 40;
			root[node]();
			bottom.render(40);
			tui.terminal.columns = 160;
			const before = railLines();
			await shortcuts.get("ctrl+shift+down")!.handler(ctx);
			const after = railLines();
			assert.notDeepEqual(after, before, "DOWN changes the visible cached rail, not the hidden bottom widget");
			assert.match(after.join("\n"), /↑↓ 4–/);
			await shortcuts.get("ctrl+shift+up")!.handler(ctx);
			assert.deepEqual(railLines(), before, "UP restores the expanded viewport");
		} finally {
			dispose();
		}
	}
	t.after(() => setCardStyle(CARD_STYLE.NEON));
});

test("todoEnabled and todoCollapseKey read their environment flags", () => {
	assert.equal(todoEnabled({}), true);
	assert.equal(todoEnabled({ GENTLE_PI_TODO: "0" }), false);
	assert.equal(todoEnabled({ GENTLE_PI_AGENTS_CHILD: "1" }), false);
	assert.equal(todoCollapseKey({}), "ctrl+shift+t");
	assert.equal(todoCollapseKey({ GENTLE_PI_TODO_KEY: "alt+t" }), "alt+t");
	assert.equal(todoCollapseKey({ GENTLE_PI_TODO_KEY: "off" }), undefined);
	const off = fakePi();
	gentleTodo(off.pi, { GENTLE_PI_TODO: "off" });
	assert.equal(off.tools.size, 0);
});

test("todo registration owns its transparent transcript shell", () => {
	const { pi, tools } = fakePi();
	gentleTodo(pi, {});
	assert.equal(tools.get("todo")?.renderShell, "self");
});

test("the todo tool writes the list, shows the card after the call, and carries the snapshot in details", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	assert.equal(widget(), undefined, "no card without tasks");

	const tool = tools.get("todo")!;
	const result = await tool.execute("c1", { action: "write", tasks: [{ title: "Write the parser", status: "in_progress", note: "parsing" }, { title: "Add tests" }] }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /2 tasks · 0 done · 1 in progress/);
	assert.equal((result.details.gentleTodo as { tasks: unknown[] }).tasks.length, 2);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	const lines = widget()!;
	assert.match(lines[0], /^╭─ ❀ Todos ▾ Collapse · 0 of 2 ─+ ctrl\+shift\+t collapse ╮$/);
	assert.match(lines[1], /◐ Write the parser · parsing/);
	assert.match(lines[2], /○ Add tests/);
	assert.equal(lines[lines.length - 1], "", "a blank line keeps the card off the prompt");

	const bad = await tool.execute("c2", { action: "update", id: 9, status: "done" }, undefined, undefined, ctx);
	assert.match(bad.content[0].text, /Error: no task #9/);
	assert.equal(bad.details.error, "no task #9");
	assert.match(tool.renderCall({ action: "write" }, plainTheme).render(40).join(""), /❀ todo · write/);
	assert.equal(tool.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false }, plainTheme).render(40).join("|").trimEnd(), "a");
});

test("the Todo header is a fullscreen left-click control while non-click pointer events stay inert", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widgetComponent } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A", status: "in_progress" }, { title: "B" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });

	const component = widgetComponent()!;
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/);
	const event = (type: "press" | "click", button: "left" | "right", y = 0) => ({
		type, button, x: 1, y, screenX: 1, screenY: y, width: 70, height: 5, shift: false, alt: false, ctrl: false,
	});
	assert.equal(component.handleMouse?.(event("press", "left")), undefined);
	assert.equal(component.handleMouse?.(event("click", "right")), undefined);
	assert.equal(component.handleMouse?.(event("click", "left", 1)), undefined);
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/, "only a left click on the header toggles");
	assert.equal(component.handleMouse?.(event("click", "left"))?.handled, true);
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▸ Expand/);
});

// H1 (odd/tasks/usage-click-and-changes-attribution.md): the header control
// now paints the same shared hover role every other clickable surface uses.
test("the Todo header paints the shared hover role while hovered, and clears it off the header row or on leave", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widgetComponent } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	const component = widgetComponent()!;
	const move = (y: number) => ({ type: "move" as const, button: "none" as const, x: 1, y, screenX: 1, screenY: y, width: 70, height: 5, shift: false, alt: false, ctrl: false });
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/);

	const entered = component.handleMouse?.(move(0));
	assert.deepEqual(entered, { handled: true, render: true });
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/, "the collapse label is unchanged; only its role changes (not observable through plainTheme here)");

	// Moving to another row of the card (still inside the region, but off the
	// clickable header) clears the hover.
	const movedOff = component.handleMouse?.(move(1));
	assert.deepEqual(movedOff, { handled: true, render: true });

	// Re-entering, then a second move at the same row is a no-op (already hovered).
	component.handleMouse?.(move(0));
	assert.deepEqual(component.handleMouse?.(move(0)), { handled: true });
});

test("in the float style the Todos header sits on row 1 below the top padding, and hover and click work there", async (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widgets } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A", status: "in_progress" }, { title: "B" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	setCardStyle(CARD_STYLE.FLOAT);
	// Float panels need a theme background; without one they keep the frame.
	const theme = { ...plainTheme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	const component = widgets.get("gentle-todo")!(fakeTui, theme);
	const rows = component.render(70).map(stripAnsi);
	assert.match(rows[0]!, /^ ▎ +$/, "a padding row sits above the header");
	assert.match(rows[1]!, /^ ▎ ❀ Todos ▾ Collapse  0 of 2 +ctrl\+shift\+t {3}$/);
	assert.match(rows[2]!, /^ ▎ +$/, "a blank separator row follows the header");
	assert.match(rows[3]!, /^ ▎ ◐ A/);
	assert.doesNotMatch(rows.join("\n"), /[╭╮╰╯│]/u);
	assert.equal(rows.at(-1), "", "the spacer row still keeps the card off the prompt");
	const pointer = (type: "move" | "click", y: number) => ({
		type, button: type === "move" ? "none" as const : "left" as const, x: 1, y, screenX: 1, screenY: y, width: 70, height: rows.length, shift: false, alt: false, ctrl: false,
	});
	assert.deepEqual(component.handleMouse?.(pointer("move", 1)), { handled: true, render: true }, "the header row is hoverable");
	assert.deepEqual(component.handleMouse?.(pointer("move", 3)), { handled: true, render: true }, "a body row clears the hover");
	assert.equal(component.handleMouse?.(pointer("click", 0)), undefined, "the padding row is not the control");
	assert.equal(component.handleMouse?.(pointer("click", 2)), undefined, "the separator row is not the control");
	assert.equal(component.handleMouse?.(pointer("click", 3)), undefined, "a body row is not the control");
	assert.equal(component.handleMouse?.(pointer("click", 1))?.handled, true);
	assert.match(stripAnsi(component.render(70)[1]!), /^ ▎ ❀ Todos ▸ Expand  0 of 2 /);
});

const REMINDER = "The todo plan has not been reviewed during several tool-use turns. Check whether it still matches the work performed and update tasks where needed. Do not mark work done without verification.";

function toolTurn(toolName = "read") {
	return { message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: toolName, arguments: {} }] }, toolResults: [] };
}

async function contextReminder(fire: ReturnType<typeof fakePi>["fire"], ctx: ExtensionContext) {
	const messages = [{ role: "user", content: "Keep working", timestamp: 1 }];
	const result = await fire("context", ctx, { messages }) as { messages: Array<{ role: string; content: unknown }> } | undefined;
	assert.deepEqual(messages, [{ role: "user", content: "Keep working", timestamp: 1 }], "request-local injection must not mutate the input transcript");
	return result;
}

async function workTurns(fire: ReturnType<typeof fakePi>["fire"], ctx: ExtensionContext, count: number) {
	for (let index = 0; index < count; index++) {
		assert.equal(await fire("turn_end", ctx, toolTurn()), undefined, "a reminder must never request continuation or persist entries");
	}
}

test("runtime reminder arrives after four tool-use turns, only once, without changing todo state", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx } = fakeContext([], false);
	await fire("session_start", ctx);
	const tool = tools.get("todo")!;
	const written = await tool.execute("write", { action: "write", tasks: [{ title: "Implement" }] }, undefined, undefined, ctx);
	await fire("turn_end", ctx, toolTurn("todo"));
	await workTurns(fire, ctx, 3);
	assert.equal(await contextReminder(fire, ctx), undefined);
	await workTurns(fire, ctx, 1);
	const result = await contextReminder(fire, ctx);
	assert.ok(result, "the next model request must carry a reminder within the same run");
	assert.equal(result.messages.length, 2);
	assert.deepEqual(result.messages[0], { role: "user", content: "Keep working", timestamp: 1 });
	assert.deepEqual(result.messages[1], { role: "custom", customType: "gentle-todo-reminder", content: REMINDER, display: false, timestamp: (result.messages[1] as { timestamp?: number }).timestamp });
	const converted = convertToLlm(result.messages as Parameters<typeof convertToLlm>[0]);
	assert.deepEqual(converted[1], { role: "user", content: [{ type: "text", text: REMINDER }], timestamp: (result.messages[1] as { timestamp?: number }).timestamp }, "Pi forwards the reminder as provider-compatible text");
	await workTurns(fire, ctx, 4);
	assert.equal(await contextReminder(fire, ctx), undefined, "no repeated nagging without a todo write");
	const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
	assert.deepEqual(listed.details.gentleTodo, written.details.gentleTodo, "a nudge does not update tasks, freshness or IDs");
});

test("a successful todo update resets and rearms the runtime reminder", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const tool = tools.get("todo")!;
	await tool.execute("write", { action: "write", tasks: [{ title: "Implement" }] }, undefined, undefined, ctx);
	await fire("turn_end", ctx, toolTurn("todo"));
	await workTurns(fire, ctx, 4);
	assert.ok(await contextReminder(fire, ctx));
	await tool.execute("update", { action: "update", id: 1, status: "in_progress" }, undefined, undefined, ctx);
	await fire("turn_end", ctx, toolTurn("todo"));
	await workTurns(fire, ctx, 3);
	assert.equal(await contextReminder(fire, ctx), undefined);
	await workTurns(fire, ctx, 1);
	assert.ok(await contextReminder(fire, ctx));
});

test("list and rejected todo writes do not reset or rearm runtime reminders", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const tool = tools.get("todo")!;
	const written = await tool.execute("write", { action: "write", tasks: [{ title: "Implement" }] }, undefined, undefined, ctx);
	await fire("turn_end", ctx, toolTurn("todo"));
	await workTurns(fire, ctx, 2);
	const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
	assert.deepEqual(listed.details.gentleTodo, written.details.gentleTodo);
	await fire("turn_end", ctx, toolTurn("todo"));
	const rejected = await tool.execute("bad", { action: "update", id: 999, status: "done" }, undefined, undefined, ctx);
	assert.equal(rejected.content[0].text, "Error: no task #999");
	assert.equal(rejected.details.error, "no task #999");
	assert.deepEqual(rejected.details.gentleTodo, written.details.gentleTodo);
	await fire("turn_end", ctx, toolTurn("todo"));
	assert.ok(await contextReminder(fire, ctx));
	await tool.execute("list-again", { action: "list" }, undefined, undefined, ctx);
	await tool.execute("bad-again", { action: "update", id: 999, status: "done" }, undefined, undefined, ctx);
	await workTurns(fire, ctx, 4);
	assert.equal(await contextReminder(fire, ctx), undefined);
});

test("runtime reminders skip empty, blocked-only and finished plans and non-tool turns", async () => {
	for (const tasks of [[], [{ title: "Wait", status: "blocked", note: "waiting for approval" }], [{ title: "Done", status: "done" }, { title: "Obsolete", status: "dropped" }]]) {
		const { pi, tools, fire } = fakePi();
		gentleTodo(pi, {});
		const { ctx } = fakeContext();
		await fire("session_start", ctx);
		await tools.get("todo")!.execute("write", { action: "write", tasks }, undefined, undefined, ctx);
		await fire("turn_end", ctx, toolTurn("todo"));
		await workTurns(fire, ctx, 8);
		assert.equal(await contextReminder(fire, ctx), undefined);
	}
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("write", { action: "write", tasks: [{ title: "Implement" }] }, undefined, undefined, ctx);
	await fire("turn_end", ctx, toolTurn("todo"));
	for (let index = 0; index < 8; index++) await fire("turn_end", ctx, { message: { role: "assistant", content: [{ type: "text", text: "Thinking" }] }, toolResults: [] });
	assert.equal(await contextReminder(fire, ctx), undefined);
	await workTurns(fire, ctx, 4);
	await tools.get("todo")!.execute("clear", { action: "clear" }, undefined, undefined, ctx);
	assert.equal(await contextReminder(fire, ctx), undefined, "clearing the plan invalidates a pending reminder");
});

test("runtime reminder tracking is isolated by session and reset on session load", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const first = fakeContext();
	const second = fakeContext();
	second.ctx.sessionManager = { ...second.ctx.sessionManager, getSessionId: () => "s2" } as ExtensionContext["sessionManager"];
	await fire("session_start", first.ctx);
	await fire("session_start", second.ctx);
	const tool = tools.get("todo")!;
	const written = await tool.execute("write", { action: "write", tasks: [{ title: "Implement" }] }, undefined, undefined, first.ctx);
	await fire("turn_end", first.ctx, toolTurn("todo"));
	await workTurns(fire, first.ctx, 4);
	await workTurns(fire, second.ctx, 4);
	assert.equal(await contextReminder(fire, second.ctx), undefined, "another session cannot inherit the plan or reminder");
	assert.ok(await contextReminder(fire, first.ctx));
	await fire("session_shutdown", first.ctx);
	const reloaded = fakeContext([{ type: "message", message: { role: "toolResult", toolName: "todo", details: written.details } }]);
	await fire("session_start", reloaded.ctx);
	assert.equal(await contextReminder(fire, reloaded.ctx), undefined, "reloaded plans start with a fresh reminder counter");
	await workTurns(fire, reloaded.ctx, 4);
	assert.ok(await contextReminder(fire, reloaded.ctx), "reload does not inherit a consumed reminder");
});

function promptEvent(): { systemPrompt: string; systemPromptOptions: { appendSystemPrompt: string } } {
	return { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
}

test("every turn carries the open tasks in appendSystemPrompt (never a returned systemPrompt) and the card goes stale after two silent turns", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	await fire("before_agent_start", ctx, promptEvent());
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Fix the bug" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });

	const withTasksEvent = promptEvent();
	const withTasksResult = await fire("before_agent_start", ctx, withTasksEvent);
	assert.equal(withTasksResult, undefined, "the handler must not return a replacement systemPrompt");
	assert.match(withTasksEvent.systemPromptOptions.appendSystemPrompt, /^## Todo list/);
	assert.match(withTasksEvent.systemPromptOptions.appendSystemPrompt, /1\. \[pending\] Fix the bug/);
	assert.doesNotMatch(widget()![0], /stale/);

	const staleEvent = promptEvent();
	await fire("before_agent_start", ctx, staleEvent);
	assert.match(staleEvent.systemPromptOptions.appendSystemPrompt, /stale: 2 turns without an update/);
	assert.match(widget()![0], /ctrl\+shift\+t collapse/);
	assert.match(widget()![1], /stale · 2 turns/);

	await tools.get("todo")!.execute("c2", { action: "update", id: 1, status: "in_progress", note: "on it" }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	assert.doesNotMatch(widget()![0], /stale/);
});

test("before_agent_start is idempotent: a todo block already present in appendSystemPrompt is not duplicated", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});

	// Capture the exact block a fresh turn produces (no staleness yet).
	const probe = fakeContext();
	await fire("session_start", probe.ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Fix the bug" }] }, undefined, undefined, probe.ctx);
	await fire("tool_execution_end", probe.ctx, { toolName: "todo" });
	const probeEvent = promptEvent();
	await fire("before_agent_start", probe.ctx, probeEvent);
	const block = probeEvent.systemPromptOptions.appendSystemPrompt;
	assert.match(block, /^## Todo list/);

	// A fresh session reaching the identical block, but whose options object
	// already carries that exact text (e.g. a retried emission), must not
	// duplicate it.
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Fix the bug" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	const seededEvent = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: block } };
	await fire("before_agent_start", ctx, seededEvent);
	assert.equal(seededEvent.systemPromptOptions.appendSystemPrompt, block, "a block already present must not be appended again");
});

test("a finished list stays for its turn and clears at the next, and the collapse key folds the card", async () => {
	const { pi, tools, shortcuts, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A", status: "in_progress" }, { title: "B" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	await shortcuts.get("ctrl+shift+t")!.handler(ctx);
	assert.equal(widget()!.length, 4, "collapsed: top, one row, bottom, spacer");
	assert.match(widget()![1], /◐ A/);
	await shortcuts.get("ctrl+shift+t")!.handler(ctx);
	assert.equal(widget()!.length, 5);

	await tools.get("todo")!.execute("c2", { action: "write", tasks: [{ id: 1, title: "A", status: "done" }, { id: 2, title: "B", status: "done" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	await fire("agent_end", ctx);
	assert.match(widget()![0], /Todos ▾ Collapse · 2 of 2/, "the finished list is still visible at the end of its turn");
	const next = await fire("before_agent_start", ctx, { systemPrompt: "base" });
	assert.equal(next, undefined, "nothing open, nothing to add to the prompt");
	assert.equal(widget(), undefined, "the card clears at the next turn");
});

test("session_start replays the list from the branch, rpiv-todo results included, and counts past turns", async () => {
	const { pi, fire } = fakePi();
	gentleTodo(pi, {});
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { action: "create", params: {}, tasks: [{ id: 1, subject: "Old task", status: "in_progress", activeForm: "still going" }], nextId: 2 } } },
		{ type: "message", message: { role: "user", content: "again" } },
	];
	const { ctx, widget } = fakeContext(branch);
	await fire("session_start", ctx);
	const lines = widget()!;
	assert.match(lines[0], /Todos ▾ Collapse · 0 of 1/);
	assert.match(lines[1], /◐ Old task · still going/);
	const headless = fakeContext(branch, false);
	await fire("session_start", headless.ctx);
	assert.equal(headless.widget(), undefined);
});

test("session_start drops a list that was already finished, so a reload never shows stale done work", async () => {
	const { pi, fire } = fakePi();
	gentleTodo(pi, {});
	const finished = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { gentleTodo: { tasks: [{ id: 1, title: "Done A", status: "done" }, { id: 2, title: "Done B", status: "done" }], nextId: 3, updatedTurn: 1 } } } },
	];
	const { ctx, widget } = fakeContext(finished);
	await fire("session_start", ctx);
	assert.equal(widget(), undefined, "nothing to show after a reload of finished work");
	const prompt = (await fire("before_agent_start", ctx, { systemPrompt: "base" })) as { systemPrompt: string } | undefined;
	assert.equal(prompt, undefined, "and nothing is injected into the prompt");
});

test("the todo tool offers blocked and dropped in its schema and guidelines", () => {
	const { pi, tools } = fakePi();
	gentleTodo(pi, {});
	const tool = tools.get("todo") as unknown as { parameters: { properties: Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[]; description?: string }> } }> }; promptGuidelines: string[] };
	const statuses = ["pending", "in_progress", "blocked", "done", "dropped"];
	assert.deepEqual(tool.parameters.properties.status.enum, statuses);
	assert.deepEqual(tool.parameters.properties.tasks.items!.properties.status.enum, statuses);
	assert.match(tool.parameters.properties.tasks.items!.properties.note.description!, /required for blocked/);
	assert.ok(tool.promptGuidelines.some((line) => /blocked with a note naming what it waits for/.test(line)));
	assert.ok(tool.promptGuidelines.some((line) => /dropped/.test(line) && /obsolete/.test(line)));
});

test("a list left with only dropped tasks open finishes and clears; a blocked-only list stays in the prompt without going stale", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A", status: "done" }, { title: "Old plan", status: "dropped" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	await fire("agent_end", ctx);
	assert.match(widget()![0], /Todos ▾ Collapse · 1 of 1/);
	await fire("before_agent_start", ctx, promptEvent());
	assert.equal(widget(), undefined, "a done-and-dropped list clears at the next turn");

	await tools.get("todo")!.execute("c2", { action: "write", tasks: [{ title: "A", status: "done" }, { title: "Deploy", status: "blocked", note: "waiting for an admin" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	for (let turn = 0; turn < 4; turn++) {
		await fire("agent_end", ctx);
		const event = promptEvent();
		await fire("before_agent_start", ctx, event);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /2\. \[blocked\] Deploy — waiting for an admin/);
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /stale/);
	}
	assert.match(widget()![2], /⊘ Deploy · waiting for an admin/);
});
