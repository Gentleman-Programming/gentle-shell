import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	applyTodo,
	emptyTodo,
	renderTodoCard,
	replayTodo,
	staleTurns,
	TODO_STATUS,
	todoPromptBlock,
	todoSummary,
	type TodoState,
} from "../lib/shell-todo.ts";
import { CARD_STYLE, cardStyle, setCardStyle, type CardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Gentle Todo: a task list the model rewrites as it works. The reducer is
// pure, the state replays from the session branch, and staleness is derived
// from how many turns passed since the last write while tasks stay open.

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	strikethrough(text: string) {
		return `~${text}~`;
	},
};

// The card style defaults to float; these assertions pin the outlined (neon)
// panels unless a test switches the style itself.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

function useCardStyle(t: TestContext, style: CardStyle): void {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(style);
}

const BG_OPEN = "\x1b[48;5;22m";
const BG_CLOSE = "\x1b[49m";

/** The same theme with a background, so the float style applies (without one panels keep the frame). */
function withBackground<T extends object>(theme: T): T & { bg(color: string, text: string): string } {
	return { ...theme, bg: (_color: string, text: string) => `${BG_OPEN}${text}${BG_CLOSE}` };
}

/** Float panel rows: a painted panel inside transparent one-column margins, between padding rows that keep the accent bar. */
function assertFloatRows(lines: readonly string[], width: number): void {
	for (const line of lines) {
		assert.equal(visibleWidth(line), width, `"${stripAnsi(line)}" is not ${width} wide`);
		assert.ok(line.startsWith(` ${BG_OPEN}`) && line.endsWith(`${BG_CLOSE} `), `painted inside the margins: ${JSON.stringify(line)}`);
	}
	const padding = ` ▎${" ".repeat(width - 3)} `;
	assert.equal(stripAnsi(lines[0]!), padding, "a padding row with the accent bar sits above the header");
	assert.equal(stripAnsi(lines.at(-1)!), padding, "a padding row with the accent bar replaces the bottom rule");
}

/** The text of a body row, without the neon side rails or the float accent bar. */
function bodyText(row: string): string {
	return stripAnsi(row).replace(/^ ?[│▎] /u, "").replace(/ ?│? ?$/u, "").trimEnd();
}

function seeded(): TodoState {
	return applyTodo(
		emptyTodo(),
		{ action: "write", tasks: [{ title: "Add quiet tool rendering", status: "done" }, { title: "Fix quiet tools conflict", status: "in_progress", note: "fixing conflict" }, { title: "Show git bash tails" }] },
		3,
	).state;
}

test("applyTodo write replaces the list, assigns ids, defaults to pending, and records the turn", () => {
	const { state, text, error } = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "First" }, { title: "Second", status: "in_progress", note: "working" }] }, 2);
	assert.equal(error, undefined);
	assert.deepEqual(state.tasks, [
		{ id: 1, title: "First", status: TODO_STATUS.PENDING },
		{ id: 2, title: "Second", status: TODO_STATUS.IN_PROGRESS, note: "working" },
	]);
	assert.equal(state.nextId, 3);
	assert.equal(state.updatedTurn, 2);
	assert.match(text, /2 tasks · 0 done · 1 in progress/);
});

test("applyTodo write keeps ids the model passes back and drops the rest", () => {
	const first = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "A" }, { title: "B" }] }, 1).state;
	const second = applyTodo(first, { action: "write", tasks: [{ id: 2, title: "B", status: "done" }, { title: "C" }] }, 2).state;
	assert.deepEqual(second.tasks.map((task) => `${task.id}:${task.title}:${task.status}`), ["2:B:done", "3:C:pending"]);
});

test("applyTodo add, update, and clear mutate one task at a time and validate ids", () => {
	let state = applyTodo(emptyTodo(), { action: "add", title: "Write tests" }, 1).state;
	assert.equal(state.tasks[0].id, 1);
	const updated = applyTodo(state, { action: "update", id: 1, status: "in_progress", note: "writing tests" }, 2);
	assert.equal(updated.error, undefined);
	assert.equal(updated.state.tasks[0].status, TODO_STATUS.IN_PROGRESS);
	assert.equal(updated.state.tasks[0].note, "writing tests");
	assert.match(updated.text, /#1 Write tests → in_progress/);
	const missing = applyTodo(updated.state, { action: "update", id: 9, status: "done" }, 2);
	assert.match(missing.error ?? "", /no task #9/);
	assert.strictEqual(missing.state, updated.state);
	const noField = applyTodo(updated.state, { action: "update", id: 1 }, 2);
	assert.match(noField.error ?? "", /nothing to update/);
	state = applyTodo(updated.state, { action: "clear" }, 3).state;
	assert.deepEqual(state.tasks, []);
	assert.equal(state.nextId, 1);
});

test("applyTodo accepts completed as an alias of done, rejects unknown statuses, and sanitizes text", () => {
	const alias = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "X", status: "completed" }] }, 1);
	assert.equal(alias.state.tasks[0].status, TODO_STATUS.DONE);
	const bad = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "X", status: "later" }] }, 1);
	assert.match(bad.error ?? "", /unknown status "later"/);
	const dirty = applyTodo(emptyTodo(), { action: "add", title: "Evil\x1b[31m title\n" }, 1).state;
	assert.equal(dirty.tasks[0].title, "Evil title");
	const empty = applyTodo(emptyTodo(), { action: "add", title: "   " }, 1);
	assert.match(empty.error ?? "", /title is required/);
});

test("applyTodo list reports the state without changing it", () => {
	const state = seeded();
	const listed = applyTodo(state, { action: "list" }, 5);
	assert.strictEqual(listed.state, state);
	assert.match(listed.text, /\[done\] #1 Add quiet tool rendering/);
	assert.match(listed.text, /\[in_progress\] #2 Fix quiet tools conflict — fixing conflict/);
	assert.match(listed.text, /\[pending\] #3 Show git bash tails/);
});

test("todoSummary and staleTurns describe progress and how long the list went untouched", () => {
	const state = seeded();
	assert.deepEqual(todoSummary(state), { done: 1, total: 3, open: 2 });
	assert.equal(staleTurns(state, 3), 0);
	assert.equal(staleTurns(state, 5), 2);
	const allDone = applyTodo(state, { action: "write", tasks: state.tasks.map((task) => ({ ...task, status: "done" })) }, 4).state;
	assert.equal(staleTurns(allDone, 9), 0, "a finished list never goes stale");
	assert.equal(staleTurns(emptyTodo(), 9), 0);
});

test("replayTodo rebuilds the latest state from Gentle and rpiv tool results alike", () => {
	const gentle = { type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { gentleTodo: { tasks: [{ id: 4, title: "Ours", status: "pending" }], nextId: 5, updatedTurn: 7 } } } };
	const rpiv = { type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { action: "update", params: {}, tasks: [{ id: 1, subject: "Theirs", status: "completed", activeForm: "done" }, { id: 2, subject: "Gone", status: "deleted" }, { id: 3, subject: "Now", status: "in_progress", activeForm: "doing it" }], nextId: 4 } } };
	const other = { type: "message", message: { role: "toolResult", toolName: "bash", details: { tasks: [] } } };
	assert.deepEqual(replayTodo([other, rpiv]).tasks, [
		{ id: 1, title: "Theirs", status: TODO_STATUS.DONE },
		{ id: 3, title: "Now", status: TODO_STATUS.IN_PROGRESS, note: "doing it" },
	]);
	assert.equal(replayTodo([other, rpiv]).nextId, 4);
	assert.equal(replayTodo([rpiv, gentle]).tasks[0].title, "Ours", "the last write wins");
	assert.equal(replayTodo([rpiv, gentle]).updatedTurn, 7);
	assert.deepEqual(replayTodo([]), emptyTodo());
});

test("todoPromptBlock lists open work with the rules, and stays silent when there is nothing open", () => {
	const block = todoPromptBlock(seeded(), 0);
	assert.ok(block);
	assert.match(block, /^## Todo list/m);
	assert.match(block, /mark a task in_progress before starting/);
	assert.match(block, /1\. \[done\] Add quiet tool rendering/);
	assert.match(block, /2\. \[in_progress\] Fix quiet tools conflict — fixing conflict/);
	assert.match(block, /3\. \[pending\] Show git bash tails/);
	assert.doesNotMatch(block, /stale/);
	assert.match(todoPromptBlock(seeded(), 2) ?? "", /stale: 2 turns without an update/);
	assert.equal(todoPromptBlock(emptyTodo(), 0), undefined);
	const allDone = applyTodo(seeded(), { action: "write", tasks: [{ title: "A", status: "done" }] }, 1).state;
	assert.equal(todoPromptBlock(allDone, 0), undefined);
});

test("renderTodoCard draws the framed list with status glyphs and keeps every line at width", () => {
	const lines = renderTodoCard(seeded(), plainTheme, 60, { collapsed: false, staleTurns: 0, collapseKey: "ctrl+shift+t" });
	for (const line of lines) assert.equal(visibleWidth(line), 60, `"${stripAnsi(line)}" is not 60 wide`);
	const plain = lines.map(stripAnsi);
	assert.match(plain[0], /^╭─ ❀ Todos ▾ Collapse · 1 of 3 ─+ ctrl\+shift\+t collapse ╮$/);
	assert.match(plain[1], /^│ ✓ ~Add quiet tool rendering~ +│$/);
	assert.match(plain[2], /^│ ◐ Fix quiet tools conflict · fixing conflict +│$/);
	assert.match(plain[3], /^│ ○ Show git bash tails +│$/);
	assert.match(plain[4], /^╰─+╯$/);
});

test("renderTodoCard folds a long list: done tasks become one row and the open ones are capped", () => {
	const tasks = Array.from({ length: 40 }, (_, index) => ({ title: `Task ${index + 1}`, status: index < 25 ? "done" : index === 25 ? "in_progress" : "pending" }));
	const state = applyTodo(emptyTodo(), { action: "write", tasks }, 1).state;
	const plain = renderTodoCard(state, plainTheme, 60, { collapsed: false, staleTurns: 0 }).map(stripAnsi);
	assert.equal(plain.length, 14, "top rule, twelve rows, bottom rule");
	assert.match(plain[0], /Todos ▾ Collapse · 25 of 40/);
	assert.match(plain[1], /^│ ✓ 25 done +│$/);
	assert.match(plain[2], /^│ ◐ Task 26 +│$/);
	assert.match(plain[11], /^│ ○ Task 35 +│$/);
	assert.match(plain[12], /^│ … 5 more +│$/);
	const allDone = applyTodo(emptyTodo(), { action: "write", tasks: tasks.map((task) => ({ ...task, status: "done" })) }, 1).state;
	const folded = renderTodoCard(allDone, plainTheme, 60, { collapsed: false, staleTurns: 0 }).map(stripAnsi);
	assert.equal(folded.length, 3);
	assert.match(folded[1], /^│ ✓ 40 done +│$/);
});

test("renderTodoCard keeps the configured collapse shortcut in the header while stale state remains visible", () => {
	const freshExpanded = renderTodoCard(seeded(), plainTheme, 70, { collapsed: false, staleTurns: 0, collapseKey: "ctrl+shift+t" }).map(stripAnsi);
	assert.match(freshExpanded[0], /^╭─ ❀ Todos ▾ Collapse · 1 of 3 ─+ ctrl\+shift\+t collapse ╮$/);

	const freshCollapsed = renderTodoCard(seeded(), plainTheme, 70, { collapsed: true, staleTurns: 0, collapseKey: "ctrl+shift+t" }).map(stripAnsi);
	assert.equal(freshCollapsed.length, 3);
	assert.match(freshCollapsed[0], /^╭─ ❀ Todos ▸ Expand · 1 of 3 ─+ ctrl\+shift\+t expand ╮$/);
	assert.match(freshCollapsed[1], /^│ ◐ Fix quiet tools conflict · fixing conflict +│$/);

	const staleExpanded = renderTodoCard(seeded(), plainTheme, 70, { collapsed: false, staleTurns: 2, collapseKey: "ctrl+shift+t" }).map(stripAnsi);
	assert.match(staleExpanded[0], /^╭─ ❀ Todos ▾ Collapse · 1 of 3 ─+ ctrl\+shift\+t collapse ╮$/);
	assert.match(staleExpanded[1], /^│ stale · 2 turns +│$/);

	const staleCollapsed = renderTodoCard(seeded(), plainTheme, 70, { collapsed: true, staleTurns: 2, collapseKey: "ctrl+shift+t" }).map(stripAnsi);
	assert.match(staleCollapsed[0], /^╭─ ❀ Todos ▸ Expand · 1 of 3 ─+ ctrl\+shift\+t expand ╮$/);
	assert.match(staleCollapsed[1], /^│ stale · 2 turns +│$/);
	assert.match(staleCollapsed[2], /^│ ◐ Fix quiet tools conflict · fixing conflict +│$/);

	const fallback = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "Finished first", status: "done" }, { title: "First pending" }, { title: "Later pending" }] }, 1).state;
	assert.match(renderTodoCard(fallback, plainTheme, 70, { collapsed: true, staleTurns: 0 }).map(stripAnsi)[1], /^│ ○ First pending +│$/);

	const activeAfterPending = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "Pending first" }, { title: "Active second", status: "in_progress" }, { title: "Pending third" }] }, 1).state;
	assert.match(renderTodoCard(activeAfterPending, plainTheme, 70, { collapsed: true, staleTurns: 0 }).map(stripAnsi)[1], /^│ ◐ Active second +│$/);
	assert.deepEqual(renderTodoCard(emptyTodo(), plainTheme, 70, { collapsed: false, staleTurns: 0 }), []);
});

test("renderTodoCard keeps English controls visible and falls back to their icons at narrow widths", () => {
	const expanded = renderTodoCard(seeded(), plainTheme, 70, { collapsed: false, staleTurns: 0, collapseKey: "ctrl+shift+t" }).map(stripAnsi);
	assert.match(expanded[0], /Todos ▾ Collapse/);
	assert.match(expanded[0], /ctrl\+shift\+t collapse/);
	const collapsed = renderTodoCard(seeded(), plainTheme, 70, { collapsed: true, staleTurns: 0, collapseKey: "ctrl+shift+t" }).map(stripAnsi);
	assert.match(collapsed[0], /Todos ▸ Expand/);
	for (const [collapsedState, icon] of [[false, "▾"], [true, "▸"]] as const) {
		const line = renderTodoCard(seeded(), plainTheme, 16, { collapsed: collapsedState, staleTurns: 0, collapseKey: "ctrl+shift+t" })[0]!;
		assert.match(stripAnsi(line), new RegExp(`Todos ${icon}`));
		assert.equal(visibleWidth(line), 16);
	}
});

test("completed titles strike only title cells across wrapped lines, never padding or rails", () => {
	const theme = {
		fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
	};
	const state = applyTodo(emptyTodo(), { action: "write", tasks: [
		{ title: "Alpha beta gamma delta epsilon", status: "done" },
		{ title: "Pending", status: "pending" },
	] }, 1).state;
	for (const width of [12, 20, 60]) {
		const lines = renderTodoCard(state, theme, width, { collapsed: false, staleTurns: 0 });
		let struckLetters = "";
		for (const line of lines) {
			let strike = false, column = 0;
			const plain = stripAnsi(line);
			const titleEnd = plain.slice(0, -1).trimEnd().length;
			for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
				if (token.startsWith("\x1b")) {
					for (const code of token.slice(2, -1).split(";").map(Number)) {
						if (code === 0 || code === 29) strike = false;
						if (code === 9) strike = true;
					}
				} else {
					if (column < 2 || column >= titleEnd || /[│╭╮╰╯─✓]/u.test(token)) assert.equal(strike, false, `struck frame/padding: ${JSON.stringify(line)}`);
					if (strike && /[A-Za-z]/.test(token)) struckLetters += token;
					column += visibleWidth(token);
				}
			}
			assert.equal(strike, false, "SGR 9 must close before the host appends padding");
			assert.equal(visibleWidth(line), width);
		}
		assert.equal(struckLetters, "Alphabetagammadeltaepsilon");
	}
});

test("renderTodoCard paints the sidebar rail and the bottom widget with the same rose INFO frame", () => {
	const taggedTheme = {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
		strikethrough(text: string) {
			return text;
		},
	};
	const sidebar = renderTodoCard(seeded(), taggedTheme, 60, { scrollable: true, collapsed: false, staleTurns: 0 });
	assert.match(sidebar[0], /<border>╭<\/border>/);
	assert.match(sidebar[0], /<accent>❀ Todos/);

	const bottom = renderTodoCard(seeded(), taggedTheme, 60, { collapsed: false, staleTurns: 0 });
	assert.match(bottom[0], /<border>╭<\/border>/);
	assert.match(bottom[0], /<accent>❀ Todos/);
});

// H1 (odd/tasks/usage-click-and-changes-attribution.md): the same shared
// hover role every other clickable surface uses.
test("renderTodoCard paints its clickable header control in the shared hover role when hovered", () => {
	const taggedTheme = {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
		strikethrough(text: string) {
			return text;
		},
	};
	const idle = renderTodoCard(seeded(), taggedTheme, 70, { collapsed: false, staleTurns: 0 });
	assert.match(idle[0], /<accent>▾ Collapse<\/accent>/, "idle keeps its ordinary accent role");
	const hovered = renderTodoCard(seeded(), taggedTheme, 70, { collapsed: false, staleTurns: 0, hovered: true });
	assert.match(hovered[0], /<warning>▾ Collapse<\/warning>/, "hovering paints the shared hover role");
	assert.doesNotMatch(hovered[0], /<accent>▾ Collapse/);
});

test("renderTodoCard keeps stale indicators and collapse hints in scrollable lists", () => {
	const tasks = Array.from({ length: 40 }, (_, index) => ({ title: `Task ${index + 1}`, status: index < 25 ? "done" : "pending" }));
	const state = applyTodo(emptyTodo(), { action: "write", tasks }, 1).state;
	const lines = renderTodoCard(state, plainTheme, 70, { scrollable: true, collapsed: false, staleTurns: 2, collapseKey: "alt+t" }).map(stripAnsi);
	assert.equal(lines.length, 43, "top rule, stale row, every task, bottom rule");
	assert.match(lines[0], /^╭─ ❀ Todos ▾ Collapse · 25 of 40 ─+ alt\+t collapse ╮$/);
	assert.match(lines[1], /^│ stale · 2 turns +│$/);
	assert.match(lines[2], /^│ ✓ ~Task 1~ +│$/);
	assert.match(lines[41], /^│ ○ Task 40 +│$/);
	for (const line of lines) assert.equal(visibleWidth(line), 70);
});

test("renderTodoCard uses custom shortcuts, omits disabled shortcuts, and remains width-safe when hints cannot fit", () => {
	const custom = renderTodoCard(seeded(), plainTheme, 70, { collapsed: false, staleTurns: 2, collapseKey: "alt+t" }).map(stripAnsi);
	assert.match(custom[0], /alt\+t collapse/);
	assert.match(custom[1], /stale · 2 turns/);

	const disabled = renderTodoCard(seeded(), plainTheme, 70, { collapsed: true, staleTurns: 2 }).map(stripAnsi);
	assert.doesNotMatch(disabled[0], /(?:collapse|expand|ctrl\+shift\+t)/);
	assert.match(disabled[1], /stale · 2 turns/);

	for (const width of [0, 1, 2, 3, 4, 5, 8, 16]) {
		const lines = renderTodoCard(seeded(), plainTheme, width, { collapsed: false, staleTurns: 2, collapseKey: "ctrl+shift+t" });
		for (const line of lines) assert.equal(visibleWidth(line), width, `"${stripAnsi(line)}" is not ${width} wide`);
	}
});

test("renderTodoCard in the float style keeps its clickable control on the header row, one row below the top padding, above a separator row", (t) => {
	const theme = withBackground(plainTheme);
	for (const options of [
		{ collapsed: false, staleTurns: 0, collapseKey: "ctrl+shift+t" },
		{ collapsed: true, staleTurns: 0, collapseKey: "ctrl+shift+t" },
		{ collapsed: false, staleTurns: 4 },
		{ collapsed: false, staleTurns: 0, scrollable: true },
	]) {
		const neon = renderTodoCard(seeded(), theme, 60, options);
		useCardStyle(t, CARD_STYLE.FLOAT);
		const float = renderTodoCard(seeded(), theme, 60, options);
		setCardStyle(CARD_STYLE.NEON);
		assert.equal(float.length, neon.length + 2, "the top padding and separator rows add two rows");
		const action = options.collapsed ? "▸ Expand" : "▾ Collapse";
		const hint = options.collapseKey ? `ctrl\\+shift\\+t {3}` : "";
		assert.match(stripAnsi(float[1]!), new RegExp(`^ ▎ ❀ Todos ${action}  1 of 3 +${hint}$`), "row 1 is the clickable header");
		assert.match(stripAnsi(float[2]!), /^ ▎ +$/, "a blank separator row follows the header");
		assertFloatRows(float, 60);
		assert.deepEqual(float.slice(3, -1).map(bodyText), neon.slice(1, -1).map(bodyText));
	}
	useCardStyle(t, CARD_STYLE.FLOAT);
	const tagged = withBackground({ ...plainTheme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` });
	const [, header] = renderTodoCard(seeded(), tagged, 120, { collapsed: false, staleTurns: 0, hovered: true });
	assert.match(stripAnsi(header!), /^ <border>▎<\/border> <accent>❀ Todos <[a-zA-Z]+>▾ Collapse<\/[a-zA-Z]+><\/accent>  <muted>1 of 3<\/muted> +$/, "the hovered control keeps its own role and case");
});

test("float Todos keeps the configured shortcut visible at rail width without repeating the action", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const theme = withBackground(plainTheme);
	for (const collapsed of [false, true]) {
		for (const collapseKey of ["ctrl+shift+t", "alt+t", undefined]) {
			const rows = renderTodoCard(seeded(), theme, 48, { collapsed, staleTurns: 0, collapseKey });
			const header = stripAnsi(rows[1]!);
			assert.match(header, collapsed ? /▸ Expand/ : /▾ Collapse/);
			if (collapseKey) assert.ok(header.includes(collapseKey));
			else assert.doesNotMatch(header, /ctrl\+shift\+t|alt\+t/);
			assert.equal(visibleWidth(rows[1]!), 48);
		}
	}
});

test("a done todo wraps to the float body so the strikethrough never re-wraps", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const state = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "word ".repeat(20).trim(), status: "done" }] }, 1).state;
	const lines = renderTodoCard(state, withBackground(plainTheme), 40, { collapsed: false, staleTurns: 0 });
	assertFloatRows(lines, 40);
	for (const row of lines.slice(3, -1)) assert.match(stripAnsi(row), /^ ▎ [✓ ] ~[^~]+~ +$/u, "each physical row closes its own strikethrough");
});

// #1814 dropped: terminal, never counts as open, reads apart from done.
// #1820 blocked: open but not actionable, always carries its reason.

test("applyTodo accepts dropped and blocked, maps cancel vocabulary to dropped, and names every status on an unknown one", () => {
	const { state, error } = applyTodo(
		emptyTodo(),
		{ action: "write", tasks: [{ title: "Old plan", status: "dropped" }, { title: "Deploy", status: "blocked", note: "waiting for an admin" }, { title: "A", status: "cancelled" }, { title: "B", status: "canceled" }, { title: "C", status: "abandoned" }] },
		1,
	);
	assert.equal(error, undefined);
	assert.deepEqual(state.tasks.map((task) => task.status), [TODO_STATUS.DROPPED, TODO_STATUS.BLOCKED, TODO_STATUS.DROPPED, TODO_STATUS.DROPPED, TODO_STATUS.DROPPED]);
	assert.equal(state.tasks[1].note, "waiting for an admin");
	const bad = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "X", status: "later" }] }, 1);
	assert.equal(bad.error, 'unknown status "later" (use pending, in_progress, blocked, done, or dropped)');
});

test("applyTodo rejects blocked without a note and leaves the list unchanged", () => {
	const before = seeded();
	for (const params of [
		{ action: "add", title: "Deploy", status: "blocked" },
		{ action: "update", id: 3, status: "blocked" },
		{ action: "write", tasks: [{ title: "Deploy", status: "blocked", note: "   " }] },
	]) {
		const result = applyTodo(before, params, 9);
		assert.equal(result.error, "blocked needs a note naming what it waits for");
		assert.equal(result.text, "Error: blocked needs a note naming what it waits for");
		assert.strictEqual(result.state, before, `${params.action} must not change the list`);
	}
	const blocked = applyTodo(before, { action: "update", id: 3, status: "blocked", note: "waiting for the API contract" }, 9);
	assert.equal(blocked.error, undefined);
	assert.equal(blocked.text, "#3 Show git bash tails → blocked");
	const unblocked = applyTodo(blocked.state, { action: "update", id: 3, status: "pending" }, 10);
	assert.equal(unblocked.state.tasks[2].status, TODO_STATUS.PENDING);
});

test("dropped tasks never count as open: a list of done and dropped is finished, silent, and never stale", () => {
	const state = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "A", status: "done" }, { title: "B", status: "dropped" }, { title: "C", status: "dropped" }] }, 1).state;
	assert.deepEqual(todoSummary(state), { done: 1, total: 3, open: 0 });
	assert.equal(todoPromptBlock(state, 5), undefined);
	assert.equal(staleTurns(state, 9), 0);
});

test("blocked tasks stay open but alone never make the list stale; an actionable task still does", () => {
	const blockedOnly = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "A", status: "done" }, { title: "Deploy", status: "blocked", note: "waiting for an admin" }] }, 1).state;
	assert.deepEqual(todoSummary(blockedOnly), { done: 1, total: 2, open: 1 });
	assert.equal(staleTurns(blockedOnly, 9), 0);
	const block = todoPromptBlock(blockedOnly, 0) ?? "";
	assert.match(block, /2\. \[blocked\] Deploy — waiting for an admin/);
	assert.match(block, /A blocked task waits on something outside the list: do not work on it until its condition holds/);
	assert.match(block, /mark the tasks it made obsolete dropped instead of leaving them pending or marking them done/);
	const mixed = applyTodo(blockedOnly, { action: "add", title: "Write docs" }, 1).state;
	assert.equal(staleTurns(mixed, 3), 2);
});

test("renderTodoCard draws blocked with its reason and dropped dim without strikethrough, excluding dropped from the count", () => {
	const state = applyTodo(
		emptyTodo(),
		{ action: "write", tasks: [{ title: "Ship", status: "done" }, { title: "Old plan", status: "dropped" }, { title: "Deploy", status: "blocked", note: "waiting for an admin" }, { title: "Docs" }] },
		1,
	).state;
	const plain = renderTodoCard(state, plainTheme, 60, { collapsed: false, staleTurns: 0 }).map(stripAnsi);
	assert.match(plain[0], /Todos ▾ Collapse · 1 of 3/);
	assert.match(plain[2], /^│ ✕ Old plan +│$/);
	assert.match(plain[3], /^│ ⊘ Deploy · waiting for an admin +│$/);
	const roles: string[] = [];
	const spy = { ...plainTheme, fg(color: string, text: string) { roles.push(`${color}:${text}`); return text; } };
	renderTodoCard(state, spy, 60, { collapsed: false, staleTurns: 0 });
	assert.ok(roles.includes("muted:✕") && roles.includes("dim:Old plan"), "dropped: muted glyph, dim title");
	assert.ok(roles.includes("warning:⊘"), "blocked: warning glyph");
});

test("the collapsed card skips blocked tasks for the next one, and shows a blocked task only when nothing else is open", () => {
	const state = applyTodo(emptyTodo(), { action: "write", tasks: [{ title: "Deploy", status: "blocked", note: "waiting for an admin" }, { title: "Docs" }] }, 1).state;
	assert.match(renderTodoCard(state, plainTheme, 60, { collapsed: true, staleTurns: 0 }).map(stripAnsi)[1], /^│ ○ Docs +│$/);
	const onlyBlocked = applyTodo(state, { action: "update", id: 2, status: "done" }, 2).state;
	assert.match(renderTodoCard(onlyBlocked, plainTheme, 60, { collapsed: true, staleTurns: 0 }).map(stripAnsi)[1], /^│ ⊘ Deploy · waiting for an admin +│$/);
});

test("renderTodoCard folds dropped tasks next to done ones in a long list", () => {
	const tasks = Array.from({ length: 20 }, (_, index) => ({ title: `Task ${index + 1}`, status: index < 5 ? "done" : index < 8 ? "dropped" : "pending" }));
	const state = applyTodo(emptyTodo(), { action: "write", tasks }, 1).state;
	const plain = renderTodoCard(state, plainTheme, 60, { collapsed: false, staleTurns: 0 }).map(stripAnsi);
	assert.equal(plain.length, 14);
	assert.match(plain[0], /Todos ▾ Collapse · 5 of 17/);
	assert.match(plain[1], /^│ ✓ 5 done +│$/);
	assert.match(plain[2], /^│ ✕ 3 dropped +│$/);
	assert.match(plain[3], /^│ ○ Task 9 +│$/);
	assert.match(plain[12], /^│ … 3 more +│$/);
});
