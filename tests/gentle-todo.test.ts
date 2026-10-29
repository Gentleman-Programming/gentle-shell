import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import gentleTodo, { todoCollapseKey, todoEnabled } from "../extensions/gentle-todo.ts";
import { TODO_PROGRESS_EVENT } from "../lib/shell-todo.ts";
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
		await shortcuts.get("alt+shift+down")!.handler(ctx);
		assert.notDeepEqual(bottom.render(40), collapsed, "keyboard scrolling is available without mouse");
	}
	t.after(() => setCardStyle(CARD_STYLE.NEON));
});

test("Todo shortcuts never take a key Pi binds by default, so startup reports no shortcut conflict", async () => {
	// Pi keeps its default table in dist/core/keybindings.js, next to the package entry.
	const { KEYBINDINGS } = await import(new URL("core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as
		{ KEYBINDINGS: Record<string, { defaultKeys?: string | string[] }> };
	assert.ok("tui.altScreen.previousPrompt" in KEYBINDINGS, "the table includes Pi's built-in prompt navigation");
	const owners = new Map<string, string[]>();
	for (const [id, binding] of Object.entries(KEYBINDINGS)) {
		for (const key of ([] as string[]).concat(binding.defaultKeys ?? [])) owners.set(key, [...(owners.get(key) ?? []), id]);
	}
	const { pi, shortcuts } = fakePi();
	gentleTodo(pi, {});
	assert.deepEqual([...shortcuts.keys()].sort(), ["alt+shift+down", "alt+shift+up", "ctrl+shift+t"]);
	for (const key of shortcuts.keys()) assert.equal(owners.get(key), undefined, `${key} is a Pi default for ${owners.get(key)?.join(", ")}`);
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
			await shortcuts.get("alt+shift+down")!.handler(ctx);
			const after = railLines();
			assert.notDeepEqual(after, before, "DOWN changes the visible cached rail, not the hidden bottom widget");
			assert.match(after.join("\n"), /↑↓ 4–/);
			assert.match(after.join("\n"), /alt\+shift\+↑\/↓/, "scroll hint reflects alt+shift shortcuts");
			await shortcuts.get("alt+shift+up")!.handler(ctx);
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

type ContextMessage = { role: string; content: unknown; customType?: string; display?: boolean; timestamp?: number };

async function contextMessages(fire: ReturnType<typeof fakePi>["fire"], ctx: ExtensionContext): Promise<ContextMessage[] | undefined> {
	const messages = [{ role: "user", content: "Keep working", timestamp: 1 }];
	const result = await fire("context", ctx, { messages }) as { messages: ContextMessage[] } | undefined;
	assert.deepEqual(messages, [{ role: "user", content: "Keep working", timestamp: 1 }], "request-local injection must not mutate the input transcript");
	if (result === undefined) return undefined;
	assert.deepEqual(result.messages[0], { role: "user", content: "Keep working", timestamp: 1 }, "the transcript stays first; todo messages trail it");
	return result.messages;
}

/** The request-local reminder, if the next model request carries one. */
async function contextReminder(fire: ReturnType<typeof fakePi>["fire"], ctx: ExtensionContext): Promise<ContextMessage | undefined> {
	return (await contextMessages(fire, ctx))?.find((message) => message.customType === "gentle-todo-reminder");
}

/** The request-local current-list message, if the next model request carries one (#1662). */
async function contextState(fire: ReturnType<typeof fakePi>["fire"], ctx: ExtensionContext): Promise<ContextMessage | undefined> {
	return (await contextMessages(fire, ctx))?.find((message) => message.customType === "gentle-todo-state");
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
	const messages = await contextMessages(fire, ctx);
	assert.ok(messages, "the next model request must carry a reminder within the same run");
	assert.equal(messages.length, 3, "transcript, current list, then the reminder");
	assert.equal(messages[1]!.customType, "gentle-todo-state");
	const reminder = messages[2]!;
	assert.deepEqual(reminder, { role: "custom", customType: "gentle-todo-reminder", content: REMINDER, display: false, timestamp: reminder.timestamp });
	const converted = convertToLlm(messages as Parameters<typeof convertToLlm>[0]);
	assert.deepEqual(converted[2], { role: "user", content: [{ type: "text", text: REMINDER }], timestamp: reminder.timestamp }, "Pi forwards the reminder as provider-compatible text");
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

test("the system prompt carries only a byte-stable todo block; the current list travels as a request-local message (#1662)", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	const emptyEvent = promptEvent();
	assert.equal(await fire("before_agent_start", ctx, emptyEvent), undefined, "the handler must not return a replacement systemPrompt");
	assert.match(emptyEvent.systemPromptOptions.appendSystemPrompt, /^## Todo list/);
	assert.match(emptyEvent.systemPromptOptions.appendSystemPrompt, /mark a task in_progress before starting/);
	assert.equal(await contextState(fire, ctx), undefined, "an empty list sends no state message");

	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Fix the bug" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	const withTasksEvent = promptEvent();
	await fire("before_agent_start", ctx, withTasksEvent);
	assert.equal(withTasksEvent.systemPromptOptions.appendSystemPrompt, emptyEvent.systemPromptOptions.appendSystemPrompt, "writing a list must not change the system prompt");
	assert.doesNotMatch(withTasksEvent.systemPromptOptions.appendSystemPrompt, /Fix the bug/, "task content never enters the system prompt");
	const state = await contextState(fire, ctx);
	assert.ok(state, "open tasks arrive as a trailing request-local message");
	assert.equal(state.role, "custom");
	assert.equal(state.display, false);
	assert.match(String(state.content), /1\. \[pending\] Fix the bug/);
	assert.doesNotMatch(widget()![0], /stale/);

	// Silent turns: the UI card goes stale, the system prompt stays frozen (#1367).
	for (const expected of ["stale · 2 turns", "stale · 3 turns"]) {
		const silent = promptEvent();
		await fire("before_agent_start", ctx, silent);
		assert.equal(silent.systemPromptOptions.appendSystemPrompt, emptyEvent.systemPromptOptions.appendSystemPrompt);
		assert.match(widget()![1], new RegExp(expected));
	}

	// Status, note, title and ordering changes reach the model through the message only.
	await tools.get("todo")!.execute("c2", { action: "update", id: 1, status: "in_progress", note: "on it" }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	const updatedEvent = promptEvent();
	await fire("before_agent_start", ctx, updatedEvent);
	assert.equal(updatedEvent.systemPromptOptions.appendSystemPrompt, emptyEvent.systemPromptOptions.appendSystemPrompt, "a status change must not change the system prompt");
	assert.match(String((await contextState(fire, ctx))!.content), /1\. \[in_progress\] Fix the bug — on it/);
	assert.doesNotMatch(widget()![0], /stale/);

	await tools.get("todo")!.execute("c3", { action: "update", id: 1, status: "done" }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	assert.equal(await contextState(fire, ctx), undefined, "a finished list sends no state message");
	const finishedEvent = promptEvent();
	await fire("before_agent_start", ctx, finishedEvent);
	assert.equal(finishedEvent.systemPromptOptions.appendSystemPrompt, emptyEvent.systemPromptOptions.appendSystemPrompt, "finishing the list must not change the system prompt");
});

// weak-model-economy S1: small tasks skip the todo list (bench C-econ).
test("the todo block exempts small tasks before the tracking rules", async () => {
	const { pi, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const event = promptEvent();
	await fire("before_agent_start", ctx, event);
	assert.ok(event.systemPromptOptions.appendSystemPrompt.startsWith("## Todo list\nA small task (Task Size) uses no todo list: do it and report. For tracked or multi-step work, keep it current with the `todo` tool: mark a task in_progress before starting it,"));
});

/**
 * Drives the extension the way Pi's agent loop does (#2195): every model request
 * runs the context handlers over the persisted transcript, and a custom message
 * sent with triggerTurn false while streaming is appended to the transcript at
 * turn_end, after the tool results (agent-session `_flushPendingCustomMessages`).
 */
function liveSession() {
	const base = fakePi();
	const queued: ContextMessage[] = [];
	const pi = {
		...base.pi,
		sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn?: boolean }) {
			assert.equal(options.triggerTurn, false, "todo state must never start a turn");
			queued.push({ role: "custom", customType: message.customType, content: message.content, display: message.display, timestamp: 0 });
		},
	} as unknown as ExtensionAPI;
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	const transcript: ContextMessage[] = [{ role: "user", content: "Work on it", timestamp: 1 }];
	const requests: ContextMessage[][] = [];
	let call = 0;
	const request = async () => {
		const result = await base.fire("context", ctx, { messages: [...transcript] }) as { messages: ContextMessage[] } | undefined;
		const messages = result?.messages ?? [...transcript];
		requests.push(messages);
		return messages;
	};
	/** One model request whose assistant reply calls `todo` (when params are given) or `read`. */
	const turn = async (todo?: Record<string, unknown>) => {
		await request();
		call += 1;
		const id = `call-${call}`;
		const name = todo ? "todo" : "read";
		const assistant = { role: "assistant", content: [{ type: "toolCall", id, name, arguments: todo ?? {} }], timestamp: 0 };
		transcript.push(assistant);
		if (todo) await base.tools.get("todo")!.execute(id, todo, undefined, undefined, ctx);
		transcript.push({ role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: 0 });
		await base.fire("turn_end", ctx, { message: assistant, toolResults: [] });
		transcript.push(...queued.splice(0));
	};
	const assertAppendOnly = (from: number) => {
		for (let index = from + 1; index < requests.length; index++) {
			const previous = requests[index - 1]!;
			assert.deepEqual(requests[index]!.slice(0, previous.length), previous, `request ${index} must extend request ${index - 1} byte for byte`);
		}
	};
	const visibleState = (messages: ContextMessage[]) => [...messages].reverse().find((message) => message.customType === "gentle-todo-state")?.content;
	return { ctx, fire: base.fire, transcript, requests, request, turn, assertAppendOnly, visibleState };
}

test("a todo write in a running tool loop reaches the transcript before the next request, which stays append-only (#2195)", async () => {
	const live = liveSession();
	await live.fire("session_start", live.ctx);
	await live.turn({ action: "write", tasks: [{ title: "Fix the bug" }, { title: "Ship it" }] });
	await live.turn();
	await live.turn();
	await live.turn({ action: "update", id: 1, status: "done" });
	await live.turn();
	await live.request();
	assert.match(live.visibleState(live.requests.at(-1)!) as string, /1\. \[done\] Fix the bug\n2\. \[pending\] Ship it/);
	live.assertAppendOnly(0);
});

test("closing every task does not leave a stale open list in the transcript (#2195)", async () => {
	for (const close of [{ action: "update", id: 1, status: "done" }, { action: "update", id: 1, status: "dropped" }, { action: "clear" }]) {
		const live = liveSession();
		await live.fire("session_start", live.ctx);
		await live.turn({ action: "write", tasks: [{ title: "Fix the bug" }] });
		await live.turn(close);
		await live.turn();
		const messages = await live.request();
		assert.equal(live.visibleState(messages), "Current todo list: no open tasks.", `${JSON.stringify(close)}: the model must not see the closed task as still open`);
		live.assertAppendOnly(0);
	}
});

test("an open list missing from the transcript (compaction, branch switch) is persisted again once, then requests stay append-only (#2195)", async () => {
	const live = liveSession();
	await live.fire("session_start", live.ctx);
	await live.turn({ action: "write", tasks: [{ title: "Fix the bug" }] });
	// Compaction summarises the head of the conversation, including the persisted state.
	live.transcript.splice(0, live.transcript.length, { role: "user", content: "Summary of earlier work", timestamp: 2 });
	const healedFrom = live.requests.length;
	await live.turn();
	await live.turn();
	await live.turn();
	await live.request();
	for (const messages of live.requests.slice(healedFrom)) assert.match(String(live.visibleState(messages)), /\[pending\] Fix the bug/);
	assert.equal(live.transcript.filter((message) => message.customType === "gentle-todo-state").length, 1, "the missing state is persisted exactly once");
	live.assertAppendOnly(healedFrom + 1);
});

test("consecutive context requests with an unchanged Todo list preserve prefix stability (#2195)", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Fix the bug" }] }, undefined, undefined, ctx);

	// Request 1: first model request
	const userMsg = { role: "user", content: "Work on it", timestamp: 100 };
	const req1 = await fire("context", ctx, { messages: [userMsg] }) as { messages: Array<{ role: string; customType?: string }> };
	assert.ok(req1, "req1 must return context messages");
	assert.ok(req1.messages.some((m) => (m as { customType?: string }).customType === "gentle-todo-state"), "req1 must include gentle-todo-state");

	// Model executes a tool (read), producing assistant message and tool result
	const assistantMsg = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], timestamp: 200 };
	const toolResultMsg = { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "file content" }], timestamp: 300 };

	// Request 2: next model request with unchanged todo list.
	// The input messages to context include the transcript with the already-delivered state message
	const inputReq2 = [...req1.messages, assistantMsg, toolResultMsg];
	const req2 = await fire("context", ctx, { messages: inputReq2 }) as { messages: Array<{ role: string; customType?: string }> } | undefined;

	// req2 must not append a redundant trailing gentle-todo-state that would invalidate prefix caching
	const effectiveReq2 = req2?.messages ?? inputReq2;
	assert.deepEqual(
		effectiveReq2.slice(0, req1.messages.length),
		req1.messages,
		"req1 must be an exact prefix of req2 to preserve prompt caching",
	);
	// No duplicate trailing state message at the end of req2
	const stateMessages = effectiveReq2.filter((m) => (m as { customType?: string }).customType === "gentle-todo-state");
	assert.equal(stateMessages.length, 1, "must not append duplicate gentle-todo-state when unchanged");
});

test("todo write and update persist gentle-todo-state custom message to transcript (#2195)", async () => {
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const base = fakePi();
	const pi = {
		...base.pi,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	await base.fire("session_start", ctx);

	// 1. todo write persists state
	await base.tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "Task 1" }] }, undefined, undefined, ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	const firstMsg = sent[0]!.message as { role: string; customType: string; content: string; display: boolean };
	assert.equal(firstMsg.customType, "gentle-todo-state");
	assert.equal(firstMsg.display, false);
	assert.match(firstMsg.content, /1\. \[pending\] Task 1/);

	// 2. todo update persists new state
	await base.tools.get("todo")!.execute("c2", { action: "update", id: 1, status: "in_progress", note: "doing" }, undefined, undefined, ctx);
	assert.equal(sent.length, 2);
	assert.deepEqual(sent[1]!.options, { triggerTurn: false });
	const secondMsg = sent[1]!.message as { content: string };
	assert.match(secondMsg.content, /1\. \[in_progress\] Task 1 — doing/);

	// 3. todo list does NOT persist extra messages
	await base.tools.get("todo")!.execute("c3", { action: "list" }, undefined, undefined, ctx);
	assert.equal(sent.length, 2, "read actions must not emit state messages");
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
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /Deploy/);
		assert.match(String((await contextState(fire, ctx))!.content), /2\. \[blocked\] Deploy — waiting for an admin/);
	}
	assert.match(widget()![2], /⊘ Deploy · waiting for an admin/);
});

// Harness roadmap T6: the todo list is the session's progress, so the runtime
// publishes it for peers instead of asking the model to call orchestrator_session_id.
test("a todo write emits the session's progress; list and errors emit nothing", async () => {
	const { pi, tools } = fakePi();
	const emitted: Array<{ name: string; data: unknown }> = [];
	Object.assign(pi, { events: { emit: (name: string, data: unknown) => { emitted.push({ name, data }); }, on: () => () => {} } });
	gentleTodo(pi, {});
	const { ctx } = fakeContext();
	const todo = (params: unknown) => tools.get("todo")!.execute("call", params, undefined, undefined, ctx);
	await todo({ action: "write", tasks: [{ title: "Write parser", status: "done" }, { title: "Wire CLI", status: "in_progress" }, { title: "Docs" }] });
	assert.deepEqual(emitted, [{ name: TODO_PROGRESS_EVENT, data: { sessionId: "s1", done: 1, total: 3, current: "Wire CLI" } }]);
	await todo({ action: "list" });
	await todo({ action: "update", id: 99, status: "done" });
	assert.equal(emitted.length, 1, "list and a failed update publish nothing");
	await todo({ action: "update", id: 2, status: "done" });
	assert.deepEqual(emitted.at(-1)?.data, { sessionId: "s1", done: 2, total: 3, current: null });
});
