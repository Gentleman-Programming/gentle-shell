import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { emptyThread, TASK_EVENT, TASK_STATUS, TaskStore, THREAD_ITEM, type TaskRecord } from "../lib/agents-protocol.ts";
import { renderThreadItem } from "../lib/agents-thread-view.ts";
import { AgentsView, taskHeader, type AgentsViewDeps } from "../lib/agents-view.ts";
import { measureAgentsViewLayout } from "../lib/agents-view-layout.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { CARD_BASH, cardBash, setCardBash } from "../lib/card-bash-policy.ts";
import { CARD_CONTENT, cardContent, setCardContent } from "../lib/card-content-policy.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import productionQuietTools from "../extensions/quiet-tools.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	gentleAiDevBinaryRegistrationPath,
	registerGentleAiDevBinary,
	setGentleAiDevBinaryEnvironmentForTesting,
	unregisterGentleAiDevBinary,
	type GentleAiDevBinaryEnvironment,
} from "../lib/gentle-ai-binary.ts";

// Gentle Agents overlay: list left, selected thread right, tail-following,
// and only the selected task subscribed.

const plainTheme = { fg: (_color: string, text: string) => text };

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return { id, agent: "explore", mode: "task", prompt: "p", label: "p", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "gpt-5.6-terra", thinking: undefined, sessionPath: "/sessions/x.jsonl", error: null, result: null, lastStep: "grep", lastActivityAt: 1000, turns: 0, toolCalls: 0, tokens: 34_000, cost: 0.27, ...overrides };
}

function harness(rows: number | (() => number) = 8, sessionId = "s", canCancel?: (task: TaskRecord) => boolean) {
	const store = new TaskStore();
	const events: string[] = [];
	let renders = 0;
	const view = new AgentsView({
		theme: plainTheme,
		rows,
		store,
		sessionId,
		now: () => 61_000,
		canCancel,
		onCancel: (entry) => events.push(`cancel:${entry.id}`),
		onOpen: (entry) => events.push(`open:${entry.id}`),
		onClose: () => events.push("close"),
		requestRender: () => (renders += 1),
	});
	return { store, view, events, renders: () => renders };
}

// The thinking/output controls are overlay-local, so these harnesses keep the
// deps around: a second view over the same store proves the first one's state
// never leaked into the task or the chat.
function detailHarness(extra: Partial<AgentsViewDeps> = {}, rows = 14) {
	const store = new TaskStore();
	const deps: AgentsViewDeps = { theme: plainTheme, rows, store, sessionId: "s", now: () => 61_000, onCancel() {}, onOpen() {}, onClose() {}, requestRender() {}, ...extra };
	const view = new AgentsView(deps);
	store.add(task("a"));
	return { store, deps, view, text: (width = 100) => stripAnsi(view.render(width).join("\n")) };
}

// The card path is only real when the chat's renderers are actually registered,
// so this loads the production extension against a minimal host. A second load
// replaces whatever an earlier one published, exactly as a reload would.
function registerQuietTools(env: { quietTools?: string } = {}): void {
	initTheme("dark");
	const previous = process.env.GENTLE_PI_QUIET_TOOLS;
	if (env.quietTools === undefined) delete process.env.GENTLE_PI_QUIET_TOOLS;
	else process.env.GENTLE_PI_QUIET_TOOLS = env.quietTools;
	try {
		productionQuietTools({ registerTool() {}, registerCommand() {}, on() {}, registerToolRenderer() {} } as any);
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_QUIET_TOOLS;
		else process.env.GENTLE_PI_QUIET_TOOLS = previous;
	}
}

let quietToolsLoaded = false;
function loadQuietTools(): void {
	if (quietToolsLoaded) return;
	quietToolsLoaded = true;
	registerQuietTools();
}

function presentationHarness(presentation: () => "log" | "cards", rows = 14, overrides: Partial<TaskRecord> = {}) {
	const store = new TaskStore();
	const view = new AgentsView({
		theme: plainTheme,
		rows,
		store,
		sessionId: "s",
		now: () => 61_000,
		threadPresentation: presentation,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	store.add(task("a", overrides));
	return { store, view };
}

function applyTool(store: TaskStore, name: string, args: Record<string, unknown>, output: string, isError = false, callId = "call", taskId = "a"): void {
	store.apply(taskId, { type: TASK_EVENT.TOOL_START, callId, name, args }, 2000);
	store.apply(taskId, { type: TASK_EVENT.TOOL_END, callId, output, isError }, 2000);
}

function clickLabel(view: AgentsView, label: string, width = 60): void {
	const frame = view.render(width).map(stripAnsi);
	const y = frame.findIndex((line) => line.includes(label));
	assert.ok(y >= 0, `${label} must be mouse accessible at ${width} columns`);
	const x = visibleWidth(frame[y].slice(0, frame[y].indexOf(label)));
	assert.equal(view.handleMouse(mouse(x, y, width, frame.length, "click"))?.handled, true);
}

test("narrow navigation enters a direct child, retains manual thread position, and Escape backs out", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	store.add(task("other", { parentSessionId: "other", agent: "foreign" }));
	for (let i = 0; i < 30; i++) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${i}\n` }, 2000);
	assert.match(view.render(40).join("\n"), /Subagent explore/);
	assert.deepEqual(events, [], "rendering the direct list never activates a child");
	assert.doesNotMatch(view.render(40).join("\n"), /foreign/);
	clickLabel(view, "Subagent explore", 40);
	assert.match(view.render(40).join("\n"), /line 29/);
	view.handleInput("\x1b[5~");
	const manual = view.render(40).slice(1, 6);
	view.handleInput("\x1b");
	assert.deepEqual(events, []);
	assert.match(view.render(40).join("\n"), /Subagent explore/);
	clickLabel(view, "Subagent explore", 40);
	assert.deepEqual(view.render(40).slice(1, 6), manual);
	view.render(80);
	assert.equal(view.selectedTask()?.id, "a");
	assert.deepEqual(view.render(40).slice(1, 6), manual);
	view.handleInput("\x1b");
	assert.match(view.render(40).join("\n"), /Subagent explore/);
	view.handleInput("\x1b");
	assert.deepEqual(events, ["close"]);
	view.dispose();
});

test("desktop fullscreen and every task action have mouse controls at the split boundary", () => {
	const { store, view, events } = harness(8, "s");
	store.add(task("a"));
	for (let i = 0; i < 30; i++) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${i}\n` }, 2000);
	view.render(60);
	view.handleInput("F");
	assert.doesNotMatch(view.render(60).join("\n"), /Subagent explore/);
	view.handleInput("\x1b[5~");
	const manual = view.render(60).slice(1, 6);
	clickLabel(view, "Back");
	clickLabel(view, "Fullscreen");
	assert.deepEqual(view.render(60).slice(1, 6), manual);
	clickLabel(view, "Follow");
	assert.match(view.render(60).join("\n"), /line 29/);
	clickLabel(view, "Open");
	clickLabel(view, "Stop");
	clickLabel(view, "Scope");
	assert.deepEqual(events, ["open:a", "cancel:a"]);
	clickLabel(view, "Close");
	assert.deepEqual(events, ["open:a", "cancel:a", "close"]);
	view.dispose();
});

test("tiny frames stay bounded and Close remains clickable whenever a cell exists", () => {
	for (const rows of [0, 1, 2, 3, 8]) for (const width of [0, 1, 2, 11, 12, 23, 24, 59, 60]) {
		const { store, view, events } = harness(rows);
		store.add(task("a"));
		const frame = view.render(width);
		assert.ok(frame.length <= rows);
		for (const line of frame) assert.ok(visibleWidth(line) <= width);
		if (rows && width) clickLabel(view, "×", width);
		assert.deepEqual(events, rows && width ? ["close"] : []);
		view.dispose();
	}
});

test("compact footer cycles mouse actions without clipped hit regions", () => {
	const { store, view, events } = harness(8, "s");
	store.add(task("a"));
	view.render(12);
	view.handleInput("\r");
	clickLabel(view, "Follow", 12);
	clickLabel(view, ">", 12);
	clickLabel(view, "Open", 12);
	clickLabel(view, ">", 12);
	clickLabel(view, "Stop", 12);
	clickLabel(view, ">", 12);
	clickLabel(view, "Scope", 12);
	assert.deepEqual(events, ["open:a", "cancel:a"]);
	view.dispose();
});

test("manual list wheels remain independent of selection and survive Back and resize", () => {
	const { store, view } = harness(6);
	for (let i = 0; i < 10; i++) store.add(task(`t${i}`, { agent: `agent${i}`, createdAt: 1000 - i }));
	view.render(40);
	view.handleMouse(mouse(4, 2, 40, 6, "wheel", 5));
	const viewport = () => view.render(40).slice(1, 4).map((line) => stripAnsi(line).replace("▸", " "));
	const manual = viewport();
	assert.match(manual[0], /agent5/);
	assert.equal(view.selectedTask()?.id, "t0", "wheel scrolling does not change selection");
	clickLabel(view, "Subagent agent5", 40);
	view.handleInput("\x1b");
	assert.match(stripAnsi(view.render(40)[1]), /▸.*Subagent agent5/, "clicking selects the visible child");
	assert.deepEqual(viewport(), manual, "Back preserves viewport content apart from the intentional selection marker");
	view.render(80);
	assert.deepEqual(viewport(), manual);
	assert.equal(view.selectedTask()?.id, "t5");
	view.dispose();
});

test("activating a visible child preserves the manual list offset through Back and height resize", () => {
	for (const target of [4, 5]) {
		let rows = 6;
		const { store, view } = harness(() => rows);
		for (let i = 0; i < 10; i++) store.add(task(`t${i}`, { agent: `agent${i}`, createdAt: 1000 - i }));
		view.render(40);
		for (let i = 0; i < 4; i++) view.handleInput("j");
		view.render(40);
		view.handleMouse(mouse(4, 2, 40, rows, "wheel", 1));
		assert.match(view.render(40)[1], /agent3/);
		clickLabel(view, `Subagent agent${target}`, 40);
		assert.equal(view.selectedTask()?.id, `t${target}`);
		view.handleInput("\x1b");
		assert.match(view.render(40)[1], /agent3/, "Back restores the manual offset, not selection-following");
		rows = 20;
		view.render(40);
		rows = 6;
		assert.match(view.render(40)[1], /agent3/, "temporary height clamping must not replace the saved offset");
		assert.equal(view.selectedTask()?.id, `t${target}`);
		view.dispose();
	}
});

test("a task finishing while its details are open in narrow mode keeps its thread visible instead of kicking back to the list", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	view.render(40);
	clickLabel(view, "Fullscreen", 80);
	assert.deepEqual(events, []);
	store.update("a", { status: TASK_STATUS.COMPLETED, endedAt: 5000 });
	assert.equal(view.selectedTask()?.id, "a", "the finished task stays selected as history instead of disappearing");
	assert.match(view.render(80).join("\n"), /Back|Subagent explore/, "narrow details mode stays open on the now-finished task");
	assert.deepEqual(events, []);
	view.dispose();
});

test("fullscreen retains every semantic block and hides Stop for unowned active tasks", () => {
	const { store, view, events } = harness(8, "s", () => false);
	const thread = { ...emptyThread(), items: [
		{ kind: "thinking" as const, text: "reasoning retained" },
		{ kind: "text" as const, text: "answer retained" },
		{ kind: "tool" as const, callId: "call", name: "bash", args: {}, output: Array.from({ length: 40 }, (_, i) => `output ${i}`).join("\n"), running: false, isError: false },
		{ kind: "note" as const, text: "final retained note" },
	] };
	store.restore(task("a"), thread);
	view.render(60);
	view.handleInput("F");
	for (let i = 0; i < 12; i++) view.handleInput("\x1b[5~");
	const seen = new Set<string>();
	for (let i = 0; i < 50; i++) {
		const frame = view.render(60).map(stripAnsi);
		assert.doesNotMatch(frame.at(-2) ?? "", /\[Stop\]/);
		for (const line of frame.slice(1, 6)) seen.add(line);
		view.handleMouse(mouse(4, 2, 60, 8, "wheel", 1));
	}
	assert.match([...seen].join("\n"), /Thinking[\s\S]*reasoning retained[\s\S]*Text[\s\S]*answer retained[\s\S]*Tool[\s\S]*output 39[\s\S]*Note[\s\S]*final retained note/);
	view.handleInput("s");
	assert.deepEqual(events, []);
	assert.deepEqual(store.thread("a"), thread, "presentation does not mutate retention");
	view.dispose();
});

test("narrow unknown origins stay isolated rather than sharing an inferred orchestrator", () => {
	const { store, view } = harness(8);
	store.add(task("a", { parentSessionId: "", agent: "alpha" }));
	store.add(task("b", { parentSessionId: " ", agent: "beta" }));
	view.handleInput("a");
	assert.doesNotMatch(view.render(40).join("\n"), /Unknown session|alpha|beta/);
	assert.equal(view.selectedTask(), undefined);
	assert.equal(store.list().length, 2, "unknown retained origins remain isolated from presence");
	view.dispose();
});

test("presentation changes invalidate pointer geometry before another frame", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	const frame = view.render(80);
	view.handleInput("F");
	assert.equal(view.handleMouse(mouse(4, 2, 80, frame.length, "click")), undefined);
	view.render(80);
	view.handleInput("\x1b");
	assert.equal(view.handleMouse(mouse(40, 2, 80, frame.length, "wheel", 1)), undefined);
	view.handleInput("F");
	view.handleInput("q");
	assert.deepEqual(events, ["close"]);
	view.dispose();
});

test("renderThreadItem renders labeled text, thinking, tool-output, and note blocks", () => {
	assert.deepEqual(renderThreadItem({ kind: "text", text: "one two three four" }, plainTheme, 9), ["Text", "  one two", "  three", "  four"]);
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "deep\nthoughts" }, plainTheme, 20), ["Thinking", "  deep", "  thoughts"]);
	const output = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
	const tool = renderThreadItem({ kind: "tool", callId: "c", name: "bash", args: { command: "ls  -la" }, output, running: true, isError: false }, plainTheme, 30);
	assert.equal(tool[0], "Tool · bash · Running");
	assert.equal(tool.length, 12, "head, output label, and every retained output line");
	assert.equal(tool[1], "  Output");
	assert.equal(tool[2], "    line 0");
	assert.equal(tool[11], "    line 9");
	// A long output line wraps instead of being clipped, so nothing is hidden.
	const wide = renderThreadItem({ kind: "tool", callId: "c", name: "bash", args: {}, output: "alpha beta gamma delta", running: false, isError: false }, plainTheme, 12);
	assert.deepEqual(wide.slice(2), ["    alpha", "    beta", "    gamma", "    delta"]);
	assert.deepEqual(renderThreadItem({ kind: "note", text: "error: boom" }, plainTheme, 30), ["Note", "  error: boom"]);
	assert.equal(taskHeader(task("a"), 61_000), "explore · running · gpt-5.6-terra · 34k · $0.270 · 1m00s");
});

test("taskHeader formats subagent cost with formatCost (three decimals below $1, two at or above $1)", () => {
	assert.match(taskHeader(task("small", { cost: 0.09 }), 1000), /\$0\.090/);
	assert.match(taskHeader(task("large", { cost: 12.5 }), 1000), /\$12\.50/);
	assert.doesNotMatch(taskHeader(task("zero", { cost: 0 }), 1000), /\$/);
});

test("AgentsView renders the frame with the task list and the selected thread's tail, at width", () => {
	const { store, view } = harness(8);
	store.add(task("a"));
	store.add(task("b", { agent: "worker", status: TASK_STATUS.COMPLETED, endedAt: 5000, createdAt: 900, lastActivityAt: 900 }));
	for (let index = 0; index < 6; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	const lines = view.render(90);
	for (const line of lines) assert.equal(visibleWidth(line), 90, `"${stripAnsi(line)}" is not 90 wide`);
	const plain = lines.map(stripAnsi);
	assert.equal(plain.length, 8);
	assert.match(plain[0], /^╭─ ❀ Agents · this session · 1 active · 1 finished ─+ \[F Fullscreen\] \[× Close\]╮$/);
	assert.match(plain[1], /▸ └ ◐ Subagent explore.*explore · running · gpt-5\.6-terra · 34k · \$0\.270 · 1m00s/);
	assert.match(plain[2], /line 3/, "the thread window follows the tail");
	assert.match(plain[3], /line 4/);
	assert.match(plain.join("\n"), /Subagent worker/, "the session's own finished task now stays listed as history");
	assert.doesNotMatch(plain.join("\n"), /orchestrator/i);
	assert.match(plain[4], /line 5/);
	assert.match(plain[6], /\[ Follow \].*\[ Open session \].*\[Stop\]/);
	assert.match(plain[7], /^╰─+╯$/);
});

test("AgentsView keys move the selection, scroll, follow, cancel, open, and close", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	store.add(task("b", { createdAt: 900, lastActivityAt: 900, status: TASK_STATUS.WAITING }));
	assert.equal(view.selectedTask()?.id, "a");
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "b");
	view.handleInput("k");
	assert.deepEqual(events, [], "navigation alone does not cancel");
	view.handleInput("c");
	view.handleInput("o");
	assert.deepEqual(events, ["cancel:a", "open:a"]);
	for (let index = 0; index < 12; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `l${index}\n` }, 2000);
	view.handleInput("\x1b[5~");
	assert.match(stripAnsi(view.render(80)[2]), /│ Text +│$/, "page up leaves follow mode and shows the top block label");
	assert.match(stripAnsi(view.render(80)[3]), /│   l0 +│$/, "page up leaves follow mode and shows the top block body");
	view.handleInput("\x0a");
	assert.match(stripAnsi(view.render(80)[2]), /│   l3 +│$/, "ctrl+j scrolls one page down across the labeled block");
	view.handleInput("\x0b");
	assert.match(stripAnsi(view.render(80)[2]), /│ Text +│$/, "ctrl+k scrolls one page up to the labeled block");
	assert.match(stripAnsi(view.render(80)[3]), /│   l0 +│$/, "ctrl+k restores the top block body");
	view.handleInput("f");
	assert.match(stripAnsi(view.render(80)[2]), /│   l9 +│$/, "f follows the tail again");
	view.handleInput("\x1b");
	assert.deepEqual(events, ["cancel:a", "open:a", "close"]);
});

test("AgentsView clamps thread scrolling at the bottom so the first upward key moves", () => {
	for (const [down, up] of [["\x0a", "\x0b"], ["\x1b[6~", "\x1b[5~"]]) {
		const { store, view } = harness(8);
		try {
			store.add(task("a"));
			for (let i = 0; i < 30; i++) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${i}\n` }, 2000);
			const bottom = view.render(80).slice(1, 5);
			assert.match(bottom.join("\n"), /line 29/);
			view.handleInput(up);
			const previousPage = view.render(80).slice(1, 5);
			assert.notDeepEqual(previousPage, bottom, "ordinary upward scrolling still moves one page");
			view.handleInput(down);
			assert.deepEqual(view.render(80).slice(1, 5), bottom, "ordinary downward scrolling returns to the bottom");
			for (let i = 0; i < 7; i++) {
				view.handleInput(down);
				assert.deepEqual(view.render(80).slice(1, 5), bottom, "extra downward presses leave the bottom visible");
			}
			view.handleInput(up);
			assert.deepEqual(view.render(80).slice(1, 5), previousPage, "the first upward press moves immediately without consuming hidden offset");
			view.handleInput("f");
			assert.deepEqual(view.render(80).slice(1, 5), bottom, "follow still restores the tail");
		} finally {
			view.dispose();
		}
	}
});

test("AgentsView subscribes only to the selected task and survives an empty store", () => {
	const { store, view, renders } = harness(6);
	assert.match(stripAnsi(view.render(60)[1]), /no tasks yet/);
	store.add(task("a"));
	store.add(task("b", { createdAt: 900, lastActivityAt: 900 }));
	const before = renders();
	store.apply("b", { type: TASK_EVENT.TEXT, text: "quiet" }, 2000);
	assert.equal(renders(), before, "an event on the unselected task renders nothing");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "loud" }, 2000);
	assert.equal(renders(), before + 1);
	view.dispose();
	store.apply("a", { type: TASK_EVENT.TEXT, text: "after" }, 2000);
	assert.equal(renders(), before + 1, "disposed views stay quiet");
});

test("current panel exposes active children directly at desktop and narrow widths, and keeps its own finished history", () => {
	for (const width of [40, 80]) {
		const { store, view, events } = harness(12, "s");
		try {
			for (const status of [TASK_STATUS.RUNNING, TASK_STATUS.QUEUED, TASK_STATUS.WAITING]) {
				store.add(task(status, { agent: status, status }));
			}
			for (const status of [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.TIMED_OUT]) {
				store.add(task(status, { agent: `history_${status}`, status, endedAt: 60_999 }));
			}
			store.add(task("foreign", { agent: "foreign", parentSessionId: "other" }));
			const frame = view.render(width).map(stripAnsi).join("\n");
			assert.doesNotMatch(frame, /orchestrator|foreign/i);
			for (const status of ["running", "queued", "waiting"]) assert.match(frame, new RegExp(`Subagent ${status}`));
			// The narrow list column truncates each "history_<status>" label to a
			// common "history_…" prefix, so count occurrences instead of matching
			// each one by its full name.
			assert.equal((frame.match(/Subagent history_/g) ?? []).length, 4, "all four finished tasks of this session stay listed as history");
			assert.match(stripAnsi(view.render(width)[1]), /Subagent queued/, "equal creation times sort by ID, with no parent wrapper");
			assert.equal(view.selectedTask()?.id, "running", "adding earlier-sorted children preserves the existing selection");
			view.handleInput("k");
			assert.equal(view.selectedTask()?.id, "queued", "Up selects the preceding live child");
			const selected = view.selectedTask()!;
			view.handleInput("k");
			assert.equal(view.selectedTask()?.id, selected.id, "Up at the first child cannot select a hidden parent wrapper");
			assert.match(stripAnsi(view.render(width)[1]), /▸.*Subagent queued/);
			if (width < 60) clickLabel(view, `Subagent ${selected.agent}`, width);
			view.handleInput("s");
			assert.deepEqual(events, [`cancel:${selected.id}`]);
			store.update(selected.id, { status: TASK_STATUS.COMPLETED, endedAt: 61_000 });
			assert.equal(view.selectedTask()?.id, selected.id, "completion keeps the task selected, now as finished history");
		} finally {
			view.dispose();
		}
	}
});

test("current panel never promotes retained foreign or unknown tasks into open sessions, but keeps its own finished history", () => {
	const { store, view } = harness(12, "s");
	try {
		store.add(task("foreign", { agent: "foreign", parentSessionId: "closed" }));
		store.add(task("unknown", { agent: "unknown", parentSessionId: "" }));
		store.add(task("finished", { agent: "finished", status: TASK_STATUS.COMPLETED, endedAt: 61_000 }));
		assert.equal(view.selectedTask()?.id, "finished", "the session's own finished task is selectable even with nothing active");
		view.handleInput("a");
		// The "Current orchestrator" heading starts collapsed here: it has no
		// active task to auto-expand it, only finished history.
		view.handleInput("\x1b[C");
		const rendered = view.render(80).map(stripAnsi).join("\n");
		assert.doesNotMatch(rendered, /Subagent (foreign|unknown)|Orchestrator closed|Unknown session/);
		assert.match(rendered, /Subagent finished/, "the session's own finished task shows under all sessions too, once its heading is expanded");
		assert.equal(store.list().length, 3, "panel filtering never deletes retained history");
	} finally {
		view.dispose();
	}
});

function mouse(x: number, y: number, width: number, height: number, type: TuiMouseEvent["type"] = "move", wheelDelta?: number): TuiMouseEvent {
	return { type, button: type === "move" || type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

test("AgentsView pointer regions hover and select task rows without activating, and keep list and thread wheels independent", () => {
	const { store, view, events } = harness(6);
	for (const id of ["a", "b", "c", "d", "e"]) store.add(task(id, { agent: id }));
	for (let index = 0; index < 8; index += 1) store.apply("b", { type: TASK_EVENT.TEXT, text: `thread ${index}\n` }, 2000);
	const lines = view.render(80);

	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length))?.handled, true, "hover consumes only the task row");
	assert.equal(view.selectedTask()?.id, "a", "hover never changes keyboard selection or the displayed thread");
	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length, "click"))?.handled, true);
	assert.equal(view.selectedTask()?.id, "b", "click selects the task and displays its thread");
	assert.deepEqual(events, [], "click selects the task only; it never opens or cancels");
	view.render(80);
	assert.equal(view.handleMouse(mouse(50, 2, 80, lines.length, "wheel", -1))?.handled, true, "thread wheel is handled by its viewport");
	assert.match(stripAnsi(view.render(80)[2]), /thread 6/, "thread wheel moves only the selected thread");
	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length, "wheel", 1))?.handled, true, "list wheel is handled by its viewport");
	assert.match(stripAnsi(view.render(80)[1]), / b /, "list wheel changes only the task-list viewport");
	assert.equal(view.handleMouse(mouse(50, 2, 80, lines.length, "click")), undefined, "thread clicks are inert");
	view.dispose();
	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length)), undefined, "late pointer events are inert after disposal");
});

test("AgentsView retains narrow keyboard mode after selection and store invalidation", () => {
	const { store, view, events } = harness(6);
	store.add(task("a"));
	store.add(task("b", { agent: "b" }));
	for (let index = 0; index < 3; index += 1) store.apply("b", { type: TASK_EVENT.TEXT, text: `thread ${index}\n` }, 2000);
	view.render(40);
	view.handleInput("j");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /thread 2/, "Tab still enters Details before a pointer-invalidating selection rerenders");
	view.handleInput("\t");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /thread 2/, "repeated Tab toggles semantically before a frame");
	view.handleInput("\t");
	store.apply("b", { type: TASK_EVENT.TEXT, text: "after update\n" }, 2000);
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /after update/, "a selected-task update does not discard narrow keyboard knowledge");
	view.handleInput("\x1b");
	view.handleInput("\t");
	assert.equal(view.selectedTask()?.id, "b", "returning through the list retains its selected child");
	assert.deepEqual(events, [], "Tab never opens the editor");
	view.dispose();
});

test("AgentsView narrow drilldown has explicit Back, independent wheel and Open, and global close", () => {
	const { store, view, events } = harness(6);
	store.add(task("a"));
	store.add(task("b", { agent: "b" }));
	for (let index = 0; index < 8; index += 1) store.apply("b", { type: TASK_EVENT.TEXT, text: `thread ${index}\n` }, 2000);
	let frame = view.render(40);
	let top = stripAnsi(frame[0] ?? "");
	assert.match(top, /\[×\]/, "root has a compact global Close");
	clickLabel(view, "Subagent b", 40);
	assert.equal(view.selectedTask()?.id, "b");
	assert.deepEqual(events, [], "drilldown never opens or stops a task");
	assert.equal(view.handleMouse(mouse(4, 2, 40, frame.length, "click")), undefined, "a mode change invalidates old pointer bounds before render");
	frame = view.render(40);
	top = stripAnsi(frame[0] ?? "");
	assert.match(top, /\[← Back\]/);
	assert.match(frame.map(stripAnsi).join("\n"), /thread 7/, "Details is the local thread viewport");
	assert.equal(view.handleMouse(mouse(4, 2, 40, frame.length, "wheel", -1))?.handled, true, "the detail viewport owns its wheel");
	const backX = visibleWidth(top.slice(0, top.indexOf("[← Back]")));
	assert.equal(view.handleMouse(mouse(backX, 0, 40, frame.length, "click"))?.handled, true, "Back is an explicit pointer control");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /Subagent b/, "Back restores the local List viewport");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /thread 7/, "Tab enters Details only for a selected task");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /Subagent b/, "Tab returns to List");
	view.handleInput("\t");
	view.handleInput("o");
	view.handleInput("\x1b");
	view.handleInput("k");
	view.handleInput("\x0d");
	view.handleInput("o");
	assert.deepEqual(events, ["open:b", "open:a"], "Enter inspects locally; o remains the editor action");
	assert.equal(view.render(11).length, 1, "width below 12 uses the bounded Close-only fallback");
	assert.equal(view.handleMouse(mouse(0, 0, 11, 1))?.handled, true, "the tiny Close cell remains hoverable");
	view.handleInput("\x1b");
	view.handleInput("q");
	assert.deepEqual(events, ["open:b", "open:a", "close"], "q closes once from any level without cancelling");
	view.dispose();
});

test("AgentsView clears hover on leave, list scrolling, resize, updates, empty lists, and disposal", () => {
	const { store, view } = harness(6);
	store.add(task("a"));
	store.add(task("b", { agent: "b" }));
	store.add(task("c", { agent: "c" }));
	store.add(task("d", { agent: "d" }));
	const lines = view.render(80);
	const observer = view.mouseObserver();
	const dispatch = (event: TuiMouseEvent) => {
		observer.beforeMouse(event);
		try {
			return view.handleMouse(event);
		} finally {
			observer.afterMouse(event);
		}
	};
	dispatch(mouse(4, 3, 80, lines.length));
	assert.match(stripAnsi(view.render(80)[3]), /▹/, "the hovered row is styled without changing selection");
	dispatch(mouse(4, 3, 80, lines.length, "wheel", -1));
	assert.match(stripAnsi(view.render(80)[3]), /▹/, "a list wheel event at its boundary preserves hover");
	dispatch(mouse(4, 3, 80, lines.length, "wheel", 1));
	assert.doesNotMatch(stripAnsi(view.render(80).join("\n")), /▹/, "list scrolling clears hover so it cannot remain on the task formerly under the pointer");
	dispatch(mouse(4, 3, 80, lines.length));
	dispatch(mouse(50, 3, 80, lines.length));
	assert.doesNotMatch(stripAnsi(view.render(80)[3]), /▹/, "the root observer clears hover outside a child region");
	dispatch(mouse(4, 3, 80, lines.length));
	view.render(81);
	assert.doesNotMatch(stripAnsi(view.render(81)[3]), /▹/, "resize clears hover before the next frame");
	dispatch(mouse(4, 3, 81, lines.length));
	store.apply("a", { type: TASK_EVENT.TEXT, text: "update" }, 2000);
	assert.doesNotMatch(stripAnsi(view.render(81)[3]), /▹/, "task updates clear the actual hovered task row");
	view.dispose();
	const { view: empty } = harness(6);
	empty.render(80);
	assert.equal(empty.handleMouse(mouse(4, 1, 80, 6)), undefined, "empty task rows are inert");
	empty.dispose();
});

test("AgentsView advertises s to stop an active selection, retains c as an alias, and hides stopping for finished tasks", () => {
	const { store, view, events } = harness(8);
	store.add(task("active"));
	assert.match(stripAnsi(view.render(80).at(-2) ?? ""), /\[Stop\]/);
	view.handleInput("s");
	view.handleInput("c");
	assert.deepEqual(events, ["cancel:active", "cancel:active"]);
	store.update("active", { status: TASK_STATUS.CANCELLED, endedAt: 2000 });
	assert.doesNotMatch(stripAnsi(view.render(80).at(-2) ?? ""), /\[Stop\]/);
	view.handleInput("s");
	assert.deepEqual(events, ["cancel:active", "cancel:active"], "finished tasks never stop");
});

test("AgentsView close control, Escape, and q share rendered bounds and one idempotent close", () => {
	const { store, view, events } = harness(8);
	store.add(task("active"));
	const wide = 80;
	let lines = view.render(wide);
	let top = stripAnsi(lines[0]);
	assert.equal(visibleWidth(top), wide, "the full close header fits its rendered width");
	assert.match(top, /\[× Close\]/, "wide headers show the labelled close control");
	let closeX = visibleWidth(top.slice(0, top.indexOf("[× Close]")));
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length))?.render, true, "hover targets only the rendered close bounds");
	assert.equal(view.selectedTask()?.id, "active", "close hover never changes task selection");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length, "press")), undefined, "press is inert");
	assert.equal(view.handleMouse({ ...mouse(closeX, 0, wide, lines.length, "click"), button: "right" }), undefined, "right click is inert");
	assert.equal(view.handleMouse({ ...mouse(closeX, 0, wide, lines.length, "click"), button: "middle" }), undefined, "middle click is inert");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide + 1, lines.length, "click")), undefined, "stale width is inert");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length + 1, "click")), undefined, "stale height is inert");

	lines = view.render(59);
	top = stripAnsi(lines[0]);
	assert.equal(visibleWidth(top), 59, "the narrow header fits its rendered width");
	assert.match(top, /\[×\]/, "width 59 uses its narrow root instead of the fallback");
	assert.doesNotMatch(top, /Follow|Open session/, "narrow mode keeps footer controls out when they do not fit");

	lines = view.render(wide);
	top = stripAnsi(lines[0]);
	closeX = visibleWidth(top.slice(0, top.indexOf("[× Close]")));
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length, "click"))?.handled, true);
	view.handleInput("\x1b");
	view.handleInput("q");
	assert.deepEqual(events, ["close"], "pointer and close keys share one idempotent close action without cancelling");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length, "click")), undefined, "late pointer events are inert after close");
	const { store: keyStore, view: keyView, events: keyEvents } = harness(8);
	keyStore.add(task("key-close"));
	keyView.handleInput("\x1b");
	keyView.handleInput("q");
	assert.deepEqual(keyEvents, ["close"], "Escape and q themselves close only once");
	keyView.dispose();
	view.dispose();
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length)), undefined, "disposed close controls stay inert");
});

test("AgentsView scrolls the task list so the selection stays visible when there are more tasks than rows", () => {
	const { store, view } = harness(6);
	for (let index = 0; index < 6; index += 1) store.add(task(`t${index}`, { agent: `agent${index}`, createdAt: 1000 - index, lastActivityAt: 1000 - index }));
	const listed = () => view.render(80).slice(1, 4).map((line) => stripAnsi(line).slice(0, 24));
	assert.match(listed()[0], /▸ └ ◐ Subagent agent0/);
	assert.match(listed()[1], /Subagent agent1/);
	assert.match(listed()[2], /Subagent agent2/);
	for (let index = 0; index < 4; index += 1) view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "t4");
	assert.match(listed()[2], /▸ └ ◐ Subagent agent4/, "the list scrolls down until the selection is the last visible row");
	assert.match(listed()[0], /Subagent agent2/);
	view.handleInput("j");
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "t5", "the selection stops at the last task");
	assert.match(listed()[2], /▸ └ ◐ Subagent agent5/);
	for (let index = 0; index < 4; index += 1) view.handleInput("k");
	assert.match(listed()[0], /▸ └ ◐ Subagent agent1/, "moving up scrolls the list back");
	assert.match(listed()[2], /Subagent agent3/);
});

test("AgentsView scopes to this session's own children (active and finished) and toggles only the open-session directory", () => {
	const { store, view } = harness(12, "s");
	store.add(task("mine", { agent: "mine" }));
	store.add(task("theirs", { agent: "theirs", parentSessionId: "other", createdAt: 900, lastActivityAt: 900 }));
	store.add(task("fresh", { agent: "fresh", status: TASK_STATUS.COMPLETED, endedAt: 61_000 - 60_000, createdAt: 850, lastActivityAt: 850 }));
	store.add(task("stale", { agent: "stale", status: TASK_STATUS.COMPLETED, endedAt: 61_000 - 16 * 60_000, createdAt: 800, lastActivityAt: 800 }));
	const names = () => view.render(80).map(stripAnsi).filter((line) => /[◐✓] Subagent /.test(line)).map((line) => line.match(/[◐✓] Subagent (\w+)/)?.[1]);
	let plain = view.render(80).map(stripAnsi);
	assert.match(plain[0], /^╭─ ❀ Agents · this session · 1 active · 2 finished ─+ \[F Fullscreen\] \[× Close\]╮$/);
	assert.deepEqual(names(), ["mine", "fresh", "stale"], "the session's own history stays, newest ended first, after the active child; the foreign task stays out");
	assert.match(plain.at(-2) ?? "", /\[Scope\]/);
	view.handleInput("a");
	plain = view.render(80).map(stripAnsi);
	assert.match(plain[0], /^╭─ ❀ Agents · all sessions · 1 active · 2 finished ─+ \[F Fullscreen\] \[× Close\]╮$/);
	assert.deepEqual(names(), ["mine", "fresh", "stale"], "retained foreign tasks cannot manufacture open orchestrators");
	assert.match(plain.at(-2) ?? "", /\[Scope\]/);
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "fresh", "navigation moves to the session's own next-newest history entry");
	view.handleInput("a");
	assert.equal(view.selectedTask()?.id, "mine", "a new scope reads from the top");
	assert.deepEqual(names(), ["mine", "fresh", "stale"]);
});

test("AgentsView footer buttons follow, open only a session-backed selection, and clear stale geometry", () => {
	const { store, view, events } = harness(8, "s");
	store.add(task("a", { sessionPath: "/sessions/a.jsonl" }));
	for (let index = 0; index < 12; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	const width = 160;
	const lines = view.render(width);
	const footerY = lines.length - 2;
	const followX = 2;
	const openX = 13;
	assert.match(stripAnsi(lines.at(-2) ?? ""), /\[ Follow \].*\[ Open session \]/, "buttons render only after the full key-hint row fits");

	view.handleInput("\x1b[5~");
	assert.match(stripAnsi(view.render(width)[2]), /line 5/, "page up leaves follow mode before the button restores it");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length))?.render, true, "button hover requests a distinct frame");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "press")), undefined, "press is inert");
	assert.equal(view.handleMouse({ ...mouse(followX, footerY, width, lines.length, "click"), button: "right" }), undefined, "right click is inert");
	assert.equal(view.handleMouse({ ...mouse(followX, footerY, width, lines.length, "click"), button: "middle" }), undefined, "middle click is inert");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click"))?.handled, true);
	assert.match(stripAnsi(view.render(width)[2]), /line 9/, "Follow returns the selected thread to its tail");
	assert.equal(view.handleMouse(mouse(openX, footerY, width, lines.length, "click"))?.handled, true);
	assert.deepEqual(events, ["open:a"], "Open delegates the selected task to the existing callback");
	assert.equal(view.handleMouse(mouse(followX, footerY, width + 1, lines.length, "click")), undefined, "a pre-render resize makes the prior footer geometry inert");

	store.update("a", { sessionPath: null });
	view.render(width);
	assert.equal(view.handleMouse(mouse(openX, footerY, width, lines.length, "click")), undefined, "Open is disabled when the selected task loses its session path");
	assert.deepEqual(events, ["open:a"]);
	view.render(200);
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click")), undefined, "resize discards the old footer geometry before routing clicks");
	assert.match(stripAnsi(view.render(44).at(-2) ?? ""), /Follow|Open/, "controls take priority over keyboard hints");
	view.handleInput("a");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click")), undefined, "a scope change clears old footer geometry until the next frame");
	view.dispose();
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click")), undefined, "disposed footer controls stay inert");
	const { view: empty } = harness(8, "s");
	const emptyLines = empty.render(width);
	assert.equal(empty.handleMouse(mouse(followX, footerY, width, emptyLines.length, "click")), undefined, "Follow is disabled with no selected task");
	assert.equal(empty.handleMouse(mouse(openX, footerY, width, emptyLines.length, "click")), undefined, "Open is disabled with no selected session");
	empty.dispose();
});

test("AgentsView reads live rows, preserves manual scroll and selection, and invalidates stale pointer bounds", () => {
	const store = new TaskStore();
	let rows = 8;
	const view = new AgentsView({
		theme: plainTheme,
		rows: () => rows,
		store,
		sessionId: "s",
		now: () => 61_000,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	for (let index = 0; index < 6; index += 1) store.add(task(`t${index}`, { agent: `agent${index}`, createdAt: 1000 - index, lastActivityAt: 1000 - index }));
	for (let index = 0; index < 10; index += 1) store.apply("t4", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	for (let index = 0; index < 4; index += 1) view.handleInput("j");
	view.render(80);
	view.handleInput("\x1b[5~");
	rows = 6;
	const resized = view.render(80).map(stripAnsi);
	assert.equal(resized.length, 6, "the frame uses the live terminal height budget");
	assert.equal(view.selectedTask()?.id, "t4", "resize never changes the selected task");
	assert.match(resized[3] ?? "", /▸ └ ◐ Subagent agent4/, "the list scroll clamps while retaining the selected row");
	assert.doesNotMatch(resized.join("\n"), /line 9/, "manual thread scroll survives resize instead of returning to the tail");
	assert.equal(view.handleMouse(mouse(4, 2, 80, 8, "click")), undefined, "old-height pointer input is stale after resize");
	view.render(40);
	view.handleInput("\t");
	const narrow = view.render(40).map(stripAnsi);
	rows = 5;
	const narrower = view.render(40).map(stripAnsi);
	assert.equal(view.selectedTask()?.id, "t4", "a narrow resize retains the selection");
	assert.doesNotMatch(narrow.join("\n"), /line 9/);
	assert.doesNotMatch(narrower.join("\n"), /line 9/, "a narrow resize preserves manual detail scrolling");
	rows = 2;
	assert.equal(view.render(80).length, 1, "a tiny terminal gets one bounded fallback line, never forced chrome");
	view.dispose();
});

test("AgentsView rejects cached-height pointer input before the live resize renders", () => {
	const store = new TaskStore();
	let rows = 8;
	const view = new AgentsView({
		theme: plainTheme,
		rows: () => rows,
		store,
		sessionId: "s",
		now: () => 61_000,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	store.add(task("a"));
	for (let index = 0; index < 12; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `l${index}\n` }, 2000);
	view.handleInput("\x1b[5~");
	const oldFrame = view.render(80);
	assert.match(stripAnsi(oldFrame[3] ?? ""), /l0/, "manual scrolling establishes a stable pre-resize position");
	rows = 6;
	assert.equal(view.handleMouse(mouse(50, 2, 80, oldFrame.length, "wheel", 1)), undefined, "old-height wheel input is inert before the resize frame");
	const resized = view.render(80);
	assert.match(stripAnsi(resized[3] ?? ""), /l0/, "the stale wheel leaves manual thread scroll unchanged");
	assert.equal(view.handleMouse(mouse(50, 2, 80, resized.length, "wheel", 1))?.handled, true, "the new-height wheel reaches the rendered thread region");
	assert.match(stripAnsi(view.render(80)[2] ?? ""), /l0/, "the live wheel scrolls past the semantic block label after the new frame");
	view.dispose();
});

test("the view keeps the labeled log by default and swaps live to the chat's cards", () => {
	loadQuietTools();
	let presentation: "log" | "cards" = "log";
	const { store, view } = presentationHarness(() => presentation);
	applyTool(store, "read", { path: "src/a.ts" }, "line 0\nline 1\nline 2\nline 3\nline 4");
	const logFrame = view.render(60).map(stripAnsi).join("\n");
	assert.match(logFrame, /Tool · read · Complete/, "the default presentation is the existing log");
	assert.doesNotMatch(logFrame, /≡ read/, "no card chrome is drawn while the log is selected");
	view.handleInput("e");
	assert.match(view.render(60).map(stripAnsi).join("\n"), /Tool · read · Complete/, "card keys leave the log view untouched");

	presentation = "cards";
	const cards = view.render(60).map(stripAnsi);
	assert.match(cards.join("\n"), /≡ read/, "the offered card draws the call");
	assert.match(cards.join("\n"), /src\/a\.ts/, "the retained argument reaches the card");
	assert.doesNotMatch(cards.join("\n"), /Tool · read/, "the generic block is replaced, not stacked on");
	for (const line of cards) assert.ok(visibleWidth(line) <= 60, `"${line}" fits the frame`);

	presentation = "log";
	assert.match(view.render(60).map(stripAnsi).join("\n"), /Tool · read · Complete/, "returning to the log re-renders the cached item");
	view.dispose();
});

test("cards expand one at a time from the row under the pointer", () => {
	loadQuietTools();
	const { store, view } = presentationHarness(() => "cards", 20);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5", false, "first");
	applyTool(store, "read", { path: "src/b.ts" }, "b0\nb1\nb2\nb3\nb4\nb5", false, "second");
	const retained = store.thread("a");
	const frame = (): string[] => view.render(60).map(stripAnsi);
	const clickRow = (needle: string): void => {
		const rows = frame();
		const y = rows.findIndex((line) => line.includes(needle));
		assert.ok(y >= 0, `"${needle}" is drawn so its card can be clicked`);
		assert.equal(view.handleMouse(mouse(50, y, 60, rows.length, "click"))?.handled, true, `${needle}: the card consumes its click`);
	};

	assert.doesNotMatch(frame().join("\n"), /a5|b5/, "both cards start collapsed");
	clickRow("a0");
	assert.match(frame().join("\n"), /a5/, "clicking a card expands that card");
	assert.doesNotMatch(frame().join("\n"), /b5/, "its sibling stays collapsed");
	clickRow("b0");
	assert.match(frame().join("\n"), /b5/, "the sibling expands on its own click");
	assert.match(frame().join("\n"), /a5/, "expanding one card leaves the other expanded");
	clickRow("a0");
	assert.doesNotMatch(frame().join("\n"), /a5/, "clicking again collapses only that card");
	assert.match(frame().join("\n"), /b5/, "the sibling keeps its own level");
	assert.deepEqual(store.thread("a"), retained, "card expansion never mutates retention");
	view.dispose();
});

// The surface a float card paints with. A style that separates cards by its
// background instead of a closing border needs the presentation to keep them
// apart, so this theme is what makes the two styles differ at all here.
const surfaceTheme = { fg: (_color: string, text: string) => text, bg: (_role: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m` };

// Rows of one rendered frame that carry nothing but the pane's own columns: a
// blank row is the separator when the cards presentation draws one.
function bareRows(rows: string[]): number[] {
	return rows.flatMap((row, y) => (stripAnsi(row).replaceAll("│", "").trim() === "" ? [y] : []));
}

function rowsMatching(rows: string[], pattern: RegExp): number[] {
	return rows.flatMap((row, y) => (pattern.test(stripAnsi(row)) ? [y] : []));
}

function drawnRow(rows: string[], pattern: RegExp, label: string): number {
	const [y] = rowsMatching(rows, pattern);
	assert.ok(y !== undefined, `${label} is drawn`);
	return y;
}

for (const style of [CARD_STYLE.FLOAT, CARD_STYLE.NEON] as const) {
	test(`cards keep one unpainted row between any two drawn blocks: ${style}`, (t) => {
		loadQuietTools();
		const previous = cardStyle();
		t.after(() => setCardStyle(previous));
		setCardStyle(style);
		const { store, view } = detailHarness({ threadPresentation: () => "cards", theme: surfaceTheme }, 40);
		store.add(task("a", { prompt: "Map the shared card code" }));
		store.apply("a", { type: TASK_EVENT.NOTE, text: "steered: also cover the pane" }, 2000);
		applyTool(store, "read", { path: "src/a.ts" }, "a0", false, "read-a");
		applyTool(store, "grep", { pattern: "needle", path: "src" }, "src/a.ts:1: needle", false, "grep-a");
		applyTool(store, "webfetch", {}, "page body", false, "fetch-a");
		store.apply("a", { type: TASK_EVENT.NOTE, text: "steered: final word" }, 2000);
		const rows = view.render(80);

		const order = {
			prompt: drawnRow(rows, /Map the shared card code/, "the launch prompt card"),
			message: drawnRow(rows, /also cover the pane/, "the delivered message card"),
			read: drawnRow(rows, /≡ read src\/a\.ts/, "the read card"),
			grep: drawnRow(rows, /⌕ grep \/needle\/ in src/, "the grep card"),
			generic: drawnRow(rows, /Tool · webfetch · Complete/, "the webfetch row"),
			tail: drawnRow(rows, /final word/, "the closing message card"),
		};
		const positions = Object.values(order);
		assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "the blocks are drawn in thread order");

		// The prompt, a delivered message, and two different tool cards: every
		// adjacent pair is exactly one unpainted row apart, whichever kind drew it.
		for (const [above, below] of [[order.prompt, order.message], [order.message, order.read], [order.read, order.grep]] as const) {
			const between = bareRows(rows).filter((y) => y > above && y < below);
			assert.equal(between.length, 1, `adjacent cards at rows ${above} and ${below} are one blank row apart in ${style}`);
			assert.doesNotMatch(rows[between[0]], /\x1b\[48/, "the separating row is unpainted: no card surface and no rail");
		}

		// The seam belongs to the layout, not to a frame: a block that owns none is
		// separated exactly like a card, both above and below.
		for (const [above, below] of [[order.grep, order.generic], [order.generic, order.tail]] as const) {
			const between = bareRows(rows).filter((y) => y > above && y < below);
			assert.equal(between.length, 1, `the unframed block at ${order.generic} is one blank row from ${above} and ${below} in ${style}`);
			assert.doesNotMatch(rows[between[0]], /\x1b\[48/, "the separator around an unframed block is unpainted too");
		}
		view.dispose();
	});

	test(`prose, thinking and notes are separated like cards: ${style}`, (t) => {
		loadQuietTools();
		const previous = cardStyle();
		t.after(() => setCardStyle(previous));
		setCardStyle(style);
		const { store, view } = detailHarness({ threadPresentation: () => "cards", theme: surfaceTheme, cardDetail: { thinkingExpanded: false, toolsExpanded: true } }, 24);
		store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run" }, 2000);
		store.apply("a", { type: TASK_EVENT.TEXT, text: "Prose answer" }, 2000);
		store.apply("a", { type: TASK_EVENT.NOTE, text: "retrying (2/3)" }, 2000);
		applyTool(store, "read", { path: "src/a.ts" }, "a0", false, "read-a");
		store.apply("a", { type: TASK_EVENT.TEXT, text: "Closing prose" }, 2000);
		const rows = view.render(80);

		const order = {
			prompt: drawnRow(rows, /Messaging agent/, "the launch prompt card"),
			thinking: drawnRow(rows, /Thinking\.\.\./, "the hidden thinking row"),
			prose: drawnRow(rows, /Prose answer/, "the prose drawn as Markdown"),
			note: drawnRow(rows, /retrying \(2\/3\)/, "the labelled note"),
			card: drawnRow(rows, /≡ read src\/a\.ts/, "the read card"),
			tail: drawnRow(rows, /Closing prose/, "the prose after the card"),
		};
		const positions = Object.values(order);
		assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "the blocks are drawn in thread order");

		// A frame is not what earns the seam: a text row, a thinking line and a note
		// are separated from their neighbours exactly like a card is.
		for (const [above, below] of [[order.prompt, order.thinking], [order.thinking, order.prose], [order.prose, order.note], [order.note, order.card], [order.card, order.tail]] as const) {
			const between = bareRows(rows).filter((y) => y > above && y < below);
			assert.equal(between.length, 1, `the blocks at rows ${above} and ${below} are one blank row apart in ${style}`);
			assert.doesNotMatch(rows[between[0]], /\x1b\[48/, "the separating row is unpainted");
		}
		assert.ok(!bareRows(rows).includes(2), "the thread opens on its first block, never on a separator");
		view.dispose();
	});

	test(`a card keeps its own rows together: ${style}`, (t) => {
		loadQuietTools();
		const previous = cardStyle();
		t.after(() => setCardStyle(previous));
		setCardStyle(style);
		const { store, view } = detailHarness({ threadPresentation: () => "cards", theme: surfaceTheme }, 26);
		applyTool(store, "read", { path: "src/a.ts" }, "a0", false, "first");
		const rows = view.render(70);
		const head = drawnRow(rows, /≡ read src\/a\.ts/, "the card head");
		const body = drawnRow(rows, /a0/, "the card body");
		// Float and neon draw a card differently, but neither may put a seam inside one.
		assert.ok(body > head, "the body sits under the head");
		assert.deepEqual(bareRows(rows).filter((y) => y > head && y < body), [], `nothing separates a card from its own body in ${style}`);
		view.dispose();
	});
}

test("the separated cards keep their rows, maxScroll and click mapping in step", () => {
	loadQuietTools();
	const rows = 12;
	const width = 80;
	const store = new TaskStore();
	// No launch prompt here: the reference lays out the retained thread alone.
	const view = new AgentsView({ theme: surfaceTheme, rows, store, sessionId: "s", now: () => 61_000, threadPresentation: () => "cards", cardDetail: { thinkingExpanded: false, toolsExpanded: false }, onCancel() {}, onOpen() {}, onClose() {}, requestRender() {} });
	store.add(task("a", { prompt: "" }));
	store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run" }, 2000);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "Prose answer" }, 2000);
	store.apply("a", { type: TASK_EVENT.NOTE, text: "retrying (2/3)" }, 2000);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5", false, "read-a");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "Closing prose" }, 2000);
	applyTool(store, "read", { path: "src/b.ts" }, "b0\nb1\nb2\nb3\nb4\nb5", false, "read-b");
	// The reference is each block's own drawing laid out the way the pane has to
	// lay it out: one unpainted row between every pair, none inside a block and
	// none at either end.
	const layout = measureAgentsViewLayout(width, rows);
	const visible = layout.bodyRows - 1;
	const reference = (expanded: (callId: string) => boolean): string[] =>
		store.thread("a").items.flatMap((item, index) => {
			const lines = renderThreadItem(item, surfaceTheme, layout.threadWidth, { presentation: "cards", expanded: item.kind === THREAD_ITEM.TOOL ? expanded(item.callId) : false, thinkingExpanded: false, expandHint: "ctrl+o to expand" });
			return index === 0 ? lines : ["", ...lines];
		});
	const bare = (row: string | undefined): boolean => stripAnsi(row ?? "").replaceAll("│", "").trim() === "";
	const window = (expected: string[], start: number, label: string): void => {
		const drawn = view.render(width);
		for (let row = 0; row < visible; row += 1) {
			const drawnRow = drawn[2 + row];
			const line = expected[start + row] ?? "";
			if (stripAnsi(line).trim() === "") assert.ok(bare(drawnRow), `${label}: row ${row + start} is the unpainted separator`);
			else assert.ok(stripAnsi(drawnRow ?? "").includes(stripAnsi(line)), `${label}: row ${row + start} draws ${JSON.stringify(stripAnsi(line))}`);
		}
	};
	const tail = (expanded: (callId: string) => boolean, label: string): void => {
		const expected = reference(expanded);
		window(expected, Math.max(0, expected.length - visible), label);
	};
	const clickRow = (needle: string): void => {
		const drawn = view.render(width).map(stripAnsi);
		const y = drawn.findIndex((line) => line.includes(needle));
		assert.ok(y >= 0, `"${needle}" is drawn so its card can be clicked`);
		assert.equal(view.handleMouse(mouse(60, y, width, drawn.length, "click"))?.handled, true, `"${needle}": the card consumes its click`);
	};

	const collapsed = reference(() => false);
	assert.ok(collapsed.length > visible, "the thread is longer than its window, so the tail is a scrolled window");
	tail(() => false, "following the tail");
	assert.ok(!bare(view.render(width)[layout.bodyRows]), "the thread ends on its last block, never on a separator");

	// A card expands from the row the pointer is over after scrolling, and the
	// separator rows the layout inserted keep every clickable region on its item.
	clickRow("≡ read src/b.ts");
	const bOnly = (callId: string): boolean => callId === "read-b";
	tail(bOnly, "the expanded second card");
	let drawn = stripAnsi(view.render(width).join("\n"));
	assert.match(drawn, /b5/, "the card under the pointer is the one that expanded");
	assert.doesNotMatch(drawn, /a5/, "its sibling keeps its own level");

	clickRow("b5");
	tail(() => false, "the collapsed second card");

	// The first block is the first row of the window: no separator opens the thread.
	view.handleInput("\x1b[7^");
	window(collapsed, 0, "the start of the thread");
	assert.ok(!bare(view.render(width)[2]), "the first row is the first block, never a separator");

	// One page down is enough to put the first card under the pointer: the
	// separator rows the layout inserted never shift which item a row belongs to.
	view.handleInput("\x0a");
	clickRow("≡ read src/a.ts");
	drawn = stripAnsi(view.render(width).join("\n"));
	assert.match(drawn, /a5/, "the clicked card expanded");
	assert.doesNotMatch(drawn, /b5/, "the sibling nobody clicked keeps its own level");
	window(reference((callId) => callId === "read-a"), visible, "the expanded first card");
	view.handleInput("\x1b[8^");
	assert.match(stripAnsi(view.render(width).join("\n")), /≡ read src\/b\.ts/, "following the tail still lands on the last block after the thread grew");
	view.dispose();
});

test("a single block opens and closes the thread with no separator", () => {
	const { store, view } = presentationHarness(() => "cards", 5, { prompt: "" });
	store.apply("a", { type: TASK_EVENT.TEXT, text: "solo prose" }, 2000);
	const rows = view.render(80);
	const detail = rows[2];
	assert.match(stripAnsi(detail ?? ""), /solo prose/, "the only block is the only row, so a separator would push it out of the window");
	assert.ok(!bareRows([detail ?? ""]).length, "the thread neither opens nor ends on a separator");
	view.dispose();
});

test("the empty-thread state line is one more block, separated like any other", () => {
	const empty = presentationHarness(() => "cards", 14, { prompt: "Map the shared card code", status: TASK_STATUS.FAILED, error: "child crashed" });
	const rows = empty.view.render(80);
	const prompt = drawnRow(rows, /Map the shared card code/, "the prompt card");
	const state = drawnRow(rows, /child crashed/, "the state line");
	assert.equal(bareRows(rows).filter((y) => y > prompt && y < state).length, 1, "the state line is separated from the card above it");
	assert.ok(!bareRows(rows).includes(2), "the thread still opens on the prompt card");
	empty.view.dispose();
});

test("width 0 draws nothing, so it gains no separator either", () => {
	loadQuietTools();
	const { store, view } = presentationHarness(() => "cards", 14, { prompt: "p" });
	store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run" }, 2000);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "Prose answer" }, 2000);
	applyTool(store, "read", { path: "src/a.ts" }, "a0");
	assert.deepEqual(view.render(0), [], "a width-0 pane renders no rows at all");
	assert.match(stripAnsi(view.render(80).join("\n")), /Prose answer/, "the same thread still draws once it has a width");
	view.dispose();
});

test("the log keeps the rows it always had for thinking, prose, notes and tools", () => {
	const rows = 24;
	const width = 80;
	const { store, view } = presentationHarness(() => "log", rows, { prompt: "" });
	store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run" }, 2000);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "Prose answer" }, 2000);
	store.apply("a", { type: TASK_EVENT.NOTE, text: "retrying (2/3)" }, 2000);
	applyTool(store, "read", { path: "src/a.ts" }, "a0", false, "read-a");
	// The log is drawn whole at any width: every block's own rows, back to back,
	// with no separator the cards presentation would insert.
	const layout = measureAgentsViewLayout(width, rows);
	const expected = store.thread("a").items.flatMap((item) => renderThreadItem(item, plainTheme, layout.threadWidth));
	assert.ok(expected.length <= layout.bodyRows - 1, "the whole log fits its window");
	const drawn = view.render(width).map(stripAnsi);
	for (let row = 0; row < expected.length; row += 1) assert.ok((drawn[2 + row] ?? "").includes(stripAnsi(expected[row])), `log row ${row} keeps its own line`);
	assert.deepEqual(bareRows(drawn).filter((y) => y >= 2 && y < 2 + expected.length), [], "the log inserts no separator between blocks");
	view.dispose();
});

test("the labeled log keeps the row spacing it always had between tool blocks", () => {
	const { store, view } = detailHarness({}, 26);
	applyTool(store, "read", { path: "src/a.ts" }, "a0", false, "first");
	applyTool(store, "read", { path: "src/b.ts" }, "b0", false, "second");
	const rows = view.render(70);
	const first = drawnRow(rows, /Tool · read · Complete/, "the first log block");
	const second = rowsMatching(rows, /Tool · read · Complete/)[1];
	assert.ok(second !== undefined && second > first, "both log blocks are drawn");
	assert.deepEqual(bareRows(rows).filter((y) => y > first && y < second), [], "the log never gains a card separator");
	view.dispose();
});

test("the separating row belongs to no card and following the tail still works", () => {
	loadQuietTools();
	const { store, view } = detailHarness({ threadPresentation: () => "cards", theme: surfaceTheme }, 26);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5", false, "first");
	applyTool(store, "read", { path: "src/b.ts" }, "b0\nb1\nb2\nb3\nb4\nb5", false, "second");
	const frame = (): string[] => view.render(70);
	const rows = frame();
	const first = drawnRow(rows, /≡ read src\/a\.ts/, "the first card");
	const second = drawnRow(rows, /≡ read src\/b\.ts/, "the second card");
	const [separator] = bareRows(rows).filter((y) => y > first && y < second);
	assert.ok(separator !== undefined, "the two cards are separated");
	assert.notEqual(view.handleMouse(mouse(40, separator, 70, rows.length, "click"))?.handled, true, "the separating row belongs to no card");
	assert.doesNotMatch(stripAnsi(frame().join("\n")), /a5|b5/, "clicking the separator expands nothing");

	const secondBody = frame().findIndex((row) => stripAnsi(row).includes("b0"));
	assert.equal(view.handleMouse(mouse(40, secondBody, 70, rows.length, "click"))?.handled, true, "the second card still owns the rows under it");
	assert.match(stripAnsi(frame().join("\n")), /b5/, "the click expands the card that was clicked");
	assert.doesNotMatch(stripAnsi(frame().join("\n")), /a5/, "the first card keeps its own level");

	store.apply("a", { type: TASK_EVENT.TEXT, text: "tail line" }, 2000);
	assert.match(stripAnsi(frame().join("\n")), /tail line/, "a new event still follows the tail through the separated cards");
	view.dispose();
});

test("the log keeps its original detail whatever the host bindings or card state say", () => {
	const { store, view, text } = detailHarness({ keybindings: new KeybindingsManager({ "app.thinking.toggle": "j", "app.tools.expand": "k" }), cardDetail: { thinkingExpanded: false, toolsExpanded: false } }, 30);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "long zero\nlong one\nlong two\nlong three\nlong four\nlong five" }, 2000);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "between" }, 2000);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "short single thought" }, 2000);
	applyTool(store, "bash", { command: "run" }, "output 0\noutput 1\noutput 2\noutput 3\noutput 4\noutput 5");
	const retained = store.thread("a");
	const whole = (): void => {
		assert.match(text(), /long five/, "the log draws every thinking line");
		assert.match(text(), /short single thought/, "short reasoning stays visible in the log");
		assert.match(text(), /output 5/, "the log draws every retained output line");
		assert.doesNotMatch(text(), /… hidden|… \d+ more lines|to expand|Thinking\.\.\./, "the log offers no detail control, hint, or hidden row");
	};

	whole();
	for (const key of ["\x14", "\x0f", "j", "k"]) view.handleInput(key);
	whole();
	assert.deepEqual(store.thread("a"), retained, "the log never mutates retention");
	view.dispose();
});

for (const [label, detail, hidden, expanded] of [
	["hidden thinking and expanded tools", { thinkingExpanded: false, toolsExpanded: true }, true, true],
	["shown thinking and collapsed tools", { thinkingExpanded: true, toolsExpanded: false }, false, false],
] as const) {
	test(`cards open from the host's global state: ${label}`, () => {
		loadQuietTools();
		const { store, deps, view, text } = detailHarness({ keybindings: new KeybindingsManager(), threadPresentation: () => "cards", cardDetail: { ...detail } }, 24);
		store.apply("a", { type: TASK_EVENT.THINKING, text: "thought zero\nthought one\nthought two\nthought three" }, 2000);
		applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5");
		const retained = store.thread("a");
		const reading = (): string => text();

		assert.equal(/thought zero/.test(reading()), !hidden, "cards follow the host's thinking visibility when the overlay opens");
		assert.equal(/a5/.test(reading()), expanded, "cards follow the host's tool expansion when the overlay opens");
		if (hidden) assert.match(reading(), /Thinking\.\.\./, "hidden thinking renders the chat's own row");
		else assert.doesNotMatch(reading(), /Thinking\.\.\./);
		assert.doesNotMatch(reading(), /… hidden/, "no separate hidden hint is drawn");

		view.handleInput("\x14");
		view.handleInput("\x0f");
		assert.equal(/thought zero/.test(reading()), hidden, "the thinking key flips the cards' own level");
		assert.equal(/a5/.test(reading()), !expanded, "the output key flips the cards' own level");
		assert.deepEqual(store.thread("a"), retained, "the cards' levels never mutate retention");

		const reopened = new AgentsView({ ...deps });
		const fresh = stripAnsi(reopened.render(100).join("\n"));
		assert.equal(/thought zero/.test(fresh), !hidden, "a reopened overlay opens from the host state again, not the previous level");
		assert.equal(/a5/.test(fresh), expanded, "the reopened overlay re-seeds tool expansion too");
		reopened.dispose();
		view.dispose();
	});
}

test("cards: hiding thinking hides short and long reasoning whole and shows it again", () => {
	const { store, view, text } = detailHarness({ keybindings: new KeybindingsManager(), threadPresentation: () => "cards" }, 24);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "long zero\nlong one\nlong two\nlong three\nlong four\nlong five" }, 2000);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "between" }, 2000);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "short single thought" }, 2000);
	const retained = store.thread("a");
	assert.match(text(), /long five/);
	assert.match(text(), /short single thought/);

	view.handleInput("\x14");
	const hidden = text();
	assert.doesNotMatch(hidden, /long |short single thought/, "no reasoning line survives hiding");
	assert.equal((hidden.match(/Thinking\.\.\./g) ?? []).length, 2, "each hidden block renders the chat's own Thinking... row");
	assert.doesNotMatch(hidden, /to expand/, "hidden thinking carries no key hint");
	assert.deepEqual(store.thread("a"), retained, "hiding never mutates retention");

	view.handleInput("\x14");
	assert.match(text(), /long five/);
	assert.match(text(), /short single thought/, "showing thinking again restores every line");
	assert.doesNotMatch(text(), /… hidden|Thinking\.\.\./);
	view.dispose();
});

test("cards honor a configured binding and advertise nothing for an unbound action", () => {
	loadQuietTools();
	const { store, view, text } = detailHarness({ keybindings: new KeybindingsManager({ "app.tools.expand": "ctrl+e", "app.thinking.toggle": [] }), threadPresentation: () => "cards", cardDetail: { thinkingExpanded: true, toolsExpanded: true } }, 24);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "thought zero\nthought one\nthought two" }, 2000);
	applyTool(store, "webfetch", {}, "a0\na1\na2\na3\na4\na5");

	view.handleInput("\x0f");
	assert.match(text(), /a5/, "the host's replaced default is inert");
	view.handleInput("\x14");
	assert.match(text(), /thought zero/, "an unbound action leaves the thinking it can no longer toggle visible");
	view.handleInput("\x05");
	assert.doesNotMatch(text(), /a3/, "the configured key collapses the card");
	assert.match(text(), /· ctrl\+e to expand/, "the collapsed card names the configured key");
	assert.doesNotMatch(text(), /ctrl\+[to] to expand/, "neither the replaced default nor an unbound action is advertised");
	view.dispose();
});

test("cards toggle from the documented host defaults when no manager was handed down", () => {
	loadQuietTools();
	const { store, view, text } = detailHarness({ threadPresentation: () => "cards" }, 24);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "thought zero\nthought one\nthought two" }, 2000);
	applyTool(store, "webfetch", {}, "a0\na1\na2\na3\na4\na5");

	assert.doesNotMatch(text(), /a3/, "a card starts collapsed without a host state");
	view.handleInput("\x14");
	assert.doesNotMatch(text(), /thought zero/, "ctrl+t is the documented thinking default");
	assert.match(text(), /Thinking\.\.\./, "hidden thinking renders the chat's own row under the documented key");
	view.handleInput("\x0f");
	assert.match(text(), /a3/, "ctrl+o is the documented tool-output default");
	view.handleInput("\x0f");
	assert.match(text(), /… \d+ more lines · ctrl\+o to expand/, "the fallback key is the one the collapsed card advertises");
	view.dispose();
});

test("cards follow the same controls while a clicked card keeps its own level", () => {
	loadQuietTools();
	const { store, view } = detailHarness({ keybindings: new KeybindingsManager(), threadPresentation: () => "cards" }, 20);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5", false, "first");
	applyTool(store, "read", { path: "src/b.ts" }, "b0\nb1\nb2\nb3\nb4\nb5", false, "second");
	const frame = (): string[] => view.render(60).map(stripAnsi);
	const text = (): string => frame().join("\n");
	const clickRow = (needle: string): void => {
		const rows = frame();
		const y = rows.findIndex((line) => line.includes(needle));
		assert.ok(y >= 0, `"${needle}" is drawn so its card can be clicked`);
		assert.equal(view.handleMouse(mouse(50, y, 60, rows.length, "click"))?.handled, true, `${needle}: the card consumes its click`);
	};

	assert.doesNotMatch(text(), /a5|b5/, "a card keeps its own collapsed default");
	view.handleInput("\x0f");
	assert.match(text(), /a5/);
	assert.match(text(), /b5/, "the control expands every card, not just one");
	clickRow("a0");
	assert.doesNotMatch(text(), /a5/, "a pointer click still collapses only its own card");
	assert.match(text(), /b5/);
	view.handleInput("\x0f");
	assert.doesNotMatch(text(), /a5|b5/, "the control speaks for the whole thread again");
	clickRow("b0");
	assert.match(text(), /b5/, "a card stays individually expandable afterwards");
	assert.doesNotMatch(text(), /a5/);
	view.dispose();
});

test("cards keep the shared card style and content preference at any detail level", (t) => {
	loadQuietTools();
	const previousStyle = cardStyle();
	const previousContent = cardContent();
	t.after(() => {
		setCardStyle(previousStyle);
		setCardContent(previousContent);
	});
	// Float paints a tone background, so the theme has to carry one for the
	// style preference to be visible at all.
	const bgTheme = { fg: (_color: string, text: string) => text, bg: (role: string, text: string) => `<${role}>${text}</>` };
	const { store, view } = detailHarness({ keybindings: new KeybindingsManager(), threadPresentation: () => "cards", theme: bgTheme, cardDetail: { toolsExpanded: false } }, 20);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5");
	const text = (): string => stripAnsi(view.render(60).join("\n"));

	setCardStyle(CARD_STYLE.NEON);
	const neon = text();
	setCardStyle(CARD_STYLE.FLOAT);
	assert.notEqual(text(), neon, "the overlay's cards still follow the shared card style");
	setCardContent(CARD_CONTENT.MINIMAL);
	assert.doesNotMatch(text(), /a0/, "the shared content preference still applies");
	setCardContent(CARD_CONTENT.DEFAULT);
	view.handleInput("\x0f");
	assert.match(text(), /a5/, "an expanded level draws the full result under the default content preference");
	view.dispose();
});

test("cards follow the renderer the chat offers live", (t) => {
	loadQuietTools();
	const previousContent = cardContent();
	t.after(() => setCardContent(previousContent));
	const { store, view } = presentationHarness(() => "cards", 20);
	applyTool(store, "read", { path: "src/a.ts" }, "line 0\nline 1\nline 2");
	const readsCard = (): boolean => /≡ read/.test(stripAnsi(view.render(60).join("\n")));
	assert.equal(readsCard(), true, "the offered card draws");

	registerQuietTools({ quietTools: "0" });
	assert.equal(readsCard(), false, "a withdrawn renderer falls back on the same retained item");
	assert.match(stripAnsi(view.render(60).join("\n")), /Tool · read · Complete/, "the generic block takes over");
	registerQuietTools();
	assert.equal(readsCard(), true, "a re-offered renderer redraws the card without a resize or a new item");

	// bash is offered only while the chat draws it as a card (minimal content).
	applyTool(store, "bash", { command: "printf hi" }, "hi", false, "bash-call");
	const bashCard = (): boolean => /\$ printf hi/.test(stripAnsi(view.render(60).join("\n")));
	assert.equal(bashCard(), false, "the default content preference leaves bash to the generic block");
	setCardContent(CARD_CONTENT.MINIMAL);
	assert.equal(bashCard(), true, "the card appears as soon as the chat offers it");
	setCardContent(CARD_CONTENT.DEFAULT);
	assert.equal(bashCard(), false, "and withdraws when the chat stops offering it");
	view.dispose();
});

test("a card keeps its running state inside the view", () => {
	loadQuietTools();
	const { store, view } = presentationHarness(() => "cards");
	store.apply("a", { type: TASK_EVENT.TOOL_START, callId: "call", name: "read", args: { path: "src/a.ts" } }, 2000);
	const frame = view.render(60).map(stripAnsi).join("\n");
	assert.match(frame, /running…/, "a running card says it is still waiting");
	assert.doesNotMatch(frame, /Tool · read · Running/, "and it is the card, not the generic block");
	for (const width of [12, 23, 40, 60]) {
		for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `a card frame fits width ${width}`);
	}
	view.dispose();
});

test("a memory tool draws the compact memory card in cards and keeps the log", () => {
	loadQuietTools();
	const cards = presentationHarness(() => "cards");
	applyTool(cards.store, "mem_save", { title: "Design notes" }, '{"ok":true}');
	const frame = stripAnsi(cards.view.render(60).join("\n"));
	assert.match(frame, /🧠 save “Design notes” …/, "the call reads as the plugin's compact chrome");
	assert.match(frame, /↳ ✓ saved/, "the finished call reports its status");
	assert.doesNotMatch(frame, /\{"ok":true\}/, "the retained body is never printed");
	assert.doesNotMatch(frame, /Tool · mem_save/, "the generic block is replaced, not stacked on");
	cards.view.handleInput("e");
	assert.match(stripAnsi(cards.view.render(60).join("\n")), /↳ ✓ saved/, "a memory card has no second expansion state");
	cards.view.dispose();

	const labeled = presentationHarness(() => "log");
	applyTool(labeled.store, "mem_save", { title: "Design notes" }, '{"ok":true}');
	assert.match(stripAnsi(labeled.view.render(60).join("\n")), /Tool · mem_save · Complete/, "the labelled log is unchanged");
	labeled.view.dispose();
});

test("a tool the chat offers no card for keeps the generic block in card mode", () => {
	loadQuietTools();
	const { store, view } = presentationHarness(() => "cards");
	applyTool(store, "webfetch", {}, "page body");
	const frame = view.render(60).map(stripAnsi).join("\n");
	assert.match(frame, /Tool · webfetch · Complete/, "an unsupported tool keeps the labeled block");
	assert.match(frame, /page body/, "and its retained output");
	assert.doesNotMatch(frame, /≡ read/, "no other tool's card is impersonated");
	view.dispose();
});

test("cards draw the launch prompt and each delivered message as the chat's Messaging agent card", () => {
	loadQuietTools();
	const { store, view } = presentationHarness(() => "cards", 24, { prompt: "Map the shared card code" });
	store.apply("a", { type: TASK_EVENT.NOTE, text: "steered: also cover the pane" }, 2000);
	store.apply("a", { type: TASK_EVENT.NOTE, text: "retrying (2/3)" }, 2000);
	const frame = (width = 70): string => stripAnsi(view.render(width).join("\n"));

	const drawn = frame();
	assert.match(drawn, /Map the shared card code/, "the launch prompt is the first thing the subagent received");
	assert.match(drawn, /also cover the pane/, "a delivered message is drawn as a message, without its runner marker");
	assert.doesNotMatch(drawn, /steered: also/, "the marker stays out of the message body");
	assert.match(drawn, /retrying \(2\/3\)/, "a retry note keeps its text");
	assert.match(drawn, /Note/, "a retry note keeps its own label");
	assert.equal((drawn.match(/✉ {2}Messaging agent/g) ?? []).length, 2, "the prompt and the delivered message are the two message cards");

	for (const width of [20, 40, 70]) {
		for (const row of view.render(width)) assert.ok(visibleWidth(row) <= width, `"${row}" fits width ${width}`);
	}
	view.dispose();
});

test("a prompt never hides the thread's own failed or waiting state", () => {
	const open = (overrides: Partial<TaskRecord>) => presentationHarness(() => "cards", 24, overrides);
	const frame = (view: AgentsView): string => stripAnsi(view.render(70).join("\n"));

	const failed = open({ prompt: "Map the shared card code", status: TASK_STATUS.FAILED, error: "child crashed" });
	assert.match(frame(failed.view), /Map the shared card code/, "the prompt is still the first thing the subagent received");
	assert.match(frame(failed.view), /child crashed/, "a thread with no events still names the failure the task records");
	failed.view.dispose();

	const waiting = open({ prompt: "Map the shared card code", status: TASK_STATUS.WAITING });
	assert.match(frame(waiting.view), /Map the shared card code/);
	assert.match(frame(waiting.view), /waiting for the first event/, "a task with no events still says it is waiting");
	waiting.view.dispose();

	const cancelled = open({ prompt: "Map the shared card code", status: TASK_STATUS.CANCELLED, error: "cancelled: the tool call was aborted" });
	assert.match(frame(cancelled.view), /cancelled: the tool call was aborted/, "a cancelled task keeps its recorded reason");
	assert.match(frame(cancelled.view), /Map the shared card code/);
	cancelled.view.dispose();

	// The state line belongs to an empty thread only: a thread with events keeps
	// drawing its events, and nothing is appended to them.
	const ran = open({ prompt: "Map the shared card code", status: TASK_STATUS.FAILED, error: "child crashed" });
	ran.store.apply("a", { type: TASK_EVENT.TEXT, text: "first retained line" }, 2000);
	assert.match(frame(ran.view), /first retained line/);
	assert.doesNotMatch(frame(ran.view), /child crashed/, "a thread with rows is never given an invented state line");
	ran.view.dispose();
});

test("scroll reaches both the prompt and the state of an empty failed thread", () => {
	const { view } = presentationHarness(() => "cards", 6, { prompt: "line a\nline b\nline c\nline d\nline e", status: TASK_STATUS.FAILED, error: "child crashed" });
	const frame = (): string => stripAnsi(view.render(70).join("\n"));
	assert.match(frame(), /child crashed/, "follow keeps the state row on screen");
	for (let page = 0; page < 3; page += 1) view.handleInput("\x1b[5~");
	assert.match(frame(), /line a/, "paging up still reaches the message the task was given");
	view.dispose();
});

test("the log keeps showing a failed task's state and never the prompt", () => {
	const { view } = presentationHarness(() => "log", 24, { prompt: "Map the shared card code", status: TASK_STATUS.FAILED, error: "child crashed" });
	const drawn = stripAnsi(view.render(70).join("\n"));
	assert.match(drawn, /child crashed/, "the log's empty-thread state is unchanged");
	assert.doesNotMatch(drawn, /Map the shared card code/, "the log still draws no prompt block");
	view.dispose();
});

test("the log keeps the rows it always drew: no prompt block and no message cards", () => {
	const { store, view } = presentationHarness(() => "log", 24, { prompt: "Map the shared card code" });
	store.apply("a", { type: TASK_EVENT.NOTE, text: "steered: also cover the pane" }, 2000);
	const drawn = stripAnsi(view.render(70).join("\n"));
	assert.doesNotMatch(drawn, /Messaging agent/, "the log draws no message card");
	assert.doesNotMatch(drawn, /Map the shared card code/, "the log never showed the prompt and still does not");
	assert.match(drawn, /Note/, "every note keeps its label");
	assert.match(drawn, /steered: also cover the pane/, "a delivered note keeps its retained text");
	view.dispose();
});

test("a card also toggles on its own in the narrow details view", () => {
	loadQuietTools();
	const { store, view } = presentationHarness(() => "cards", 20);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5");
	view.render(40);
	view.handleInput("\t");
	const frame = (): string[] => view.render(40).map(stripAnsi);
	const y = frame().findIndex((line) => line.includes("a0"));
	assert.ok(y >= 0, "the card is drawn in the details view");
	assert.equal(view.handleMouse(mouse(20, y, 40, frame().length, "click"))?.handled, true, "the card consumes the click");
	assert.match(frame().join("\n"), /a5/, "the same per-card level applies in the narrow presentation");
	view.dispose();
});

test("a retained card redraws when a live rendering preference changes", (t) => {
	loadQuietTools();
	const previousContent = cardContent();
	t.after(() => setCardContent(previousContent));
	const { store, view } = presentationHarness(() => "cards", 20);
	applyTool(store, "read", { path: "src/a.ts" }, "line 0\nline 1\nline 2");
	const retained = store.thread("a");
	const text = (): string => stripAnsi(view.render(60).join("\n"));
	assert.match(text(), /line 0/, "the default content preference previews the result");
	setCardContent(CARD_CONTENT.MINIMAL);
	assert.doesNotMatch(text(), /line 0/, "the same retained item and renderer redraw for the new preference");
	setCardContent(CARD_CONTENT.DEFAULT);
	assert.match(text(), /line 0/, "and redraw again when the preference returns");
	assert.deepEqual(store.thread("a"), retained, "the preference never mutates retention");
	view.dispose();
});

test("two tasks with the same callId expand their own cards", () => {
	loadQuietTools();
	const { store, view } = presentationHarness(() => "cards", 20);
	store.add(task("b", { createdAt: 900, lastActivityAt: 900 }));
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5", false, "call", "a");
	applyTool(store, "read", { path: "src/b.ts" }, "b0\nb1\nb2\nb3\nb4\nb5", false, "call", "b");
	const frame = (): string[] => view.render(60).map(stripAnsi);
	const clickRow = (needle: string): void => {
		const rows = frame();
		const y = rows.findIndex((line) => line.includes(needle));
		assert.ok(y >= 0, `"${needle}" is drawn on the selected task`);
		assert.equal(view.handleMouse(mouse(50, y, 60, rows.length, "click"))?.handled, true, `${needle}: the card consumes its click`);
	};

	assert.equal(view.selectedTask()?.id, "a");
	clickRow("a0");
	assert.match(frame().join("\n"), /a5/, "the first task's card expands");
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "b");
	assert.doesNotMatch(frame().join("\n"), /b5/, "the second task's card with the same callId stays collapsed");
	clickRow("b0");
	assert.match(frame().join("\n"), /b5/, "the second task's card expands on its own");
	view.handleInput("k");
	assert.equal(view.selectedTask()?.id, "a");
	assert.match(frame().join("\n"), /a5/, "the first task keeps its level after switching away and back");
	assert.doesNotMatch(frame().join("\n"), /b5/);
	view.dispose();
});

test("ctrl+shift+j and ctrl+shift+k page the thread exactly where ctrl+j and ctrl+k do", () => {
	const { store, view } = presentationHarness(() => "log", 14);
	for (let index = 0; index < 30; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `l${index}\n` }, 2000);
	const frame = (): string[] => view.render(100).map(stripAnsi);
	const tail = frame();
	assert.match(tail.join("\n"), /l29/, "the thread starts by following its tail");

	view.handleInput("\x1b[107;6u");
	const shiftedUp = frame();
	assert.doesNotMatch(shiftedUp.join("\n"), /l29/, "a terminal that reports ctrl+shift+k leaves the tail");
	assert.notDeepEqual(shiftedUp, tail);
	view.handleInput("\x1b[106;6u");
	assert.deepEqual(frame(), tail, "ctrl+shift+j pages back to the tail");

	view.handleInput("\x0b");
	assert.deepEqual(frame(), shiftedUp, "the shifted key pages exactly where ctrl+k pages");
	view.handleInput("\x0a");
	assert.deepEqual(frame(), tail, "and ctrl+j returns to the same tail");

	assert.doesNotMatch(stripAnsi(view.render(200).join("\n")), /shift/, "the extra binding is never advertised in the footer");
	view.dispose();
});

test("ctrl+home reaches the first thread row and ctrl+end resumes following the tail", () => {
	const { store, view } = presentationHarness(() => "log", 14);
	for (let index = 0; index < 30; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `l${index}\n` }, 2000);
	const text = (): string => stripAnsi(view.render(100).join("\n"));
	assert.match(text(), /l29/, "the thread starts at its tail");

	view.handleInput("\x1b[7^");
	assert.match(text(), /l0/, "ctrl+home reaches the first retained row");
	assert.doesNotMatch(text(), /l10|l29/, "and no later row stands in for it");

	store.apply("a", { type: TASK_EVENT.TEXT, text: "l30\n" }, 2000);
	assert.doesNotMatch(text(), /l30/, "reading from the top is not pulled back down by a live event");

	view.handleInput("\x1b[8^");
	assert.match(text(), /l30/, "ctrl+end returns to the last row");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "l31\n" }, 2000);
	assert.match(text(), /l31/, "ctrl+end resumes following the tail rather than only moving it once");

	view.handleInput("\x1b[1;5H");
	assert.match(text(), /l0/, "the modern ctrl+home sequence reaches the first row too");
	view.handleInput("\x1b[1;5F");
	assert.match(text(), /l31/, "the modern ctrl+end sequence returns to the tail");
	assert.doesNotMatch(text(), /ctrl\+home|ctrl\+end/, "neither key is advertised in the footer");
	view.dispose();
});

test("cards draw assistant prose as Markdown, and only the log keeps the labelled source", () => {
	for (const presentation of ["cards", "log"] as const) {
		const { store, view } = presentationHarness(() => presentation, 20);
		store.apply("a", { type: TASK_EVENT.TEXT, text: "## Handoff\n\nsome *prose* here" }, 2000);
		const frame = stripAnsi(view.render(80).join("\n"));
		assert.match(frame, /Handoff/, `${presentation}: the prose is drawn`);
		assert.match(frame, /some/, `${presentation}: with its words`);
		if (presentation === "cards") {
			assert.doesNotMatch(frame, /## Handoff|\*prose\*/, "cards draw the rendered prose, not its Markdown source");
			assert.doesNotMatch(frame, /│ Text +│/, "cards carry no Text label");
		} else {
			assert.match(frame, /## Handoff/, "the log still echoes the retained source");
			assert.match(frame, /│ Text +│/, "the log keeps its label");
		}
		view.dispose();
	}
});

test("cards advertise the host's detail keys and the log never gains them", () => {
	const cards = detailHarness({ keybindings: new KeybindingsManager(), threadPresentation: () => "cards" }, 24);
	const cardsText = (): string => cards.text(200);
	assert.match(cardsText(), /ctrl\+t hide thinking/, "shown thinking offers the key that hides it");
	assert.match(cardsText(), /ctrl\+o expand/, "collapsed output offers the key that expands it");
	cards.view.handleInput("\x14");
	assert.match(cardsText(), /ctrl\+t show thinking/, "hidden thinking offers the key that shows it");
	assert.doesNotMatch(cardsText(), /hide thinking/, "the hint names the state the key leads to, never the one it leaves");
	cards.view.handleInput("\x0f");
	assert.match(cardsText(), /ctrl\+o collapse/, "expanded output offers the key that collapses it");
	cards.view.dispose();

	const log = detailHarness({ keybindings: new KeybindingsManager() }, 24);
	assert.doesNotMatch(log.text(200), /thinking|ctrl\+o/, "the log has no detail level, so it advertises no detail key");
	log.view.handleInput("\x14");
	log.view.handleInput("\x0f");
	assert.doesNotMatch(log.text(200), /thinking|ctrl\+o/, "and pressing them leaves the log footer as it was");
	log.view.dispose();
});

test("cards name the keys the host actually resolved and omit an unbound action", () => {
	const rebound = detailHarness({ keybindings: new KeybindingsManager({ "app.tools.expand": "ctrl+e" }), threadPresentation: () => "cards", cardDetail: { thinkingExpanded: false } }, 24);
	assert.match(rebound.text(200), /ctrl\+e expand/, "a rebound action is advertised under its own key");
	assert.doesNotMatch(rebound.text(200), /ctrl\+o/, "the replaced default is not advertised");
	assert.match(rebound.text(200), /ctrl\+t show thinking/, "hidden thinking offers to show it");
	rebound.view.dispose();

	const unbound = detailHarness({ keybindings: new KeybindingsManager({ "app.thinking.toggle": [] }), threadPresentation: () => "cards" }, 24);
	assert.match(unbound.text(200), /ctrl\+o expand/, "a bound action keeps its hint");
	assert.doesNotMatch(unbound.text(200), /thinking/, "an unbound action has no key, so it gets no hint");
	unbound.view.dispose();
});

test("an edit card in the pane draws the same diff the chat draws", () => {
	loadQuietTools();
	const { store, view } = detailHarness({ threadPresentation: () => "cards" }, 30);
	store.add(task("a"));
	store.apply("a", { type: TASK_EVENT.TOOL_START, callId: "edit-1", name: "edit", args: { path: "src/b.ts", edits: [] } }, 2000);
	store.apply("a", { type: TASK_EVENT.TOOL_END, callId: "edit-1", output: "Successfully replaced 1 block", isError: false, diff: "+added line\n-removed line" }, 2000);
	const frame = stripAnsi(view.render(120).join("\n"));
	assert.match(frame, /✓ \+1 \/ -1/, "the chat's counters are drawn in the pane");
	assert.match(frame, /\+added line/, "the added row is drawn");
	assert.match(frame, /-removed line/, "the removed row is drawn");
	view.dispose();
});

// The pane keeps one drawing per retained item, so a frame that changes nothing
// must not redraw it. A card comes from another extension and may draw live
// geometry, so it is reused only when its own record declares its rows stable;
// these tests publish both kinds of record into the shared slot.
const PUBLISHED_CARDS = Symbol.for("gentle-pi.quiet-tool-renderers");

interface CardSlot {
	/** How many times anything this record published has drawn. */
	draws(): number;
	/** Publishes (or, with `undefined`, withdraws) this tool's card for the rest of the test. */
	publish(card: { label: string; rowStable?: boolean; throwing?: boolean } | undefined): void;
}

function cardSlot(t: { after(fn: () => void): void }, toolName: string): CardSlot {
	const state = globalThis as Record<symbol, unknown>;
	const slot = (state[PUBLISHED_CARDS] ??= new Map<string, unknown>()) as Map<string, unknown>;
	const had = slot.has(toolName);
	const previous = slot.get(toolName);
	let draws = 0;
	t.after(() => {
		if (had) slot.set(toolName, previous);
		else slot.delete(toolName);
	});
	const component = (rows: () => string[]) => ({
		render: () => {
			draws += 1;
			return rows();
		},
		invalidate() {},
	});
	return {
		draws: () => draws,
		publish(card) {
			if (card === undefined) {
				slot.delete(toolName);
				return;
			}
			const record: Record<string, unknown> = {
				renderer: {
					renderShell: "self",
					renderCall: () => {
						if (card.throwing === true) throw new Error("no drawing for this call");
						return component(() => [`call ${card.label}`]);
					},
					renderResult: (_result: unknown, options: { expanded?: boolean }) => component(() => [`${options.expanded === true ? "whole" : "preview"} ${card.label}`]),
				},
				active: () => true,
			};
			if (card.rowStable !== undefined) record.rowStable = card.rowStable;
			slot.set(toolName, record);
		},
	};
}

/** A pane over an existing store; a view built here starts with an empty cache. */
function paneOver(store: TaskStore, extra: Partial<AgentsViewDeps> = {}, rows = 20): AgentsView {
	return new AgentsView({ theme: plainTheme, rows, store, sessionId: "s", now: () => 61_000, threadPresentation: () => "cards", onCancel() {}, onOpen() {}, onClose() {}, requestRender() {}, ...extra });
}

test("a settled card is drawn once and every later frame reuses those rows", (t) => {
	const read = cardSlot(t, "read");
	read.publish({ label: "alpha", rowStable: true });
	const { store, view } = presentationHarness(() => "cards", 20);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1");
	const cold = view.render(60);
	assert.equal(read.draws(), 2, "the first frame draws the call and its result");
	assert.match(stripAnsi(cold.join("\n")), /preview alpha/);
	for (let frame = 0; frame < 5; frame += 1) assert.deepEqual(view.render(60), cold, `warm frame ${frame} keeps the same rows`);
	assert.equal(read.draws(), 2, "and no warm frame draws the card again");

	const fresh = paneOver(store);
	assert.deepEqual(fresh.render(60), cold, "a freshly built view draws byte-identical rows");
	fresh.dispose();
	assert.equal(read.draws(), 4, "the cold view is what proves the reused rows are the drawn ones");

	const wide = view.render(80);
	assert.equal(read.draws(), 6, "a new width draws the card again");
	assert.notDeepEqual(wide, cold, "and the frame it draws is a different one");
	view.render(60);
	assert.equal(read.draws(), 8, "returning to the earlier width draws it once more instead of recalling the older key");
	view.dispose();
});

test("one card's expansion redraws only that card", (t) => {
	const read = cardSlot(t, "read");
	const edit = cardSlot(t, "edit");
	read.publish({ label: "alpha", rowStable: true });
	edit.publish({ label: "beta", rowStable: true });
	const { store, view } = presentationHarness(() => "cards", 24);
	applyTool(store, "read", { path: "src/a.ts" }, "a0", false, "first");
	applyTool(store, "edit", { path: "src/b.ts" }, "done", false, "second");
	const frame = (): string[] => view.render(60).map(stripAnsi);
	const cold = frame();
	assert.equal(read.draws(), 2);
	assert.equal(edit.draws(), 2);
	const y = cold.findIndex((line) => line.includes("preview alpha"));
	assert.ok(y >= 0, "the read card's collapsed result is drawn");
	assert.equal(view.handleMouse(mouse(50, y, 60, frame().length, "click"))?.handled, true, "the read card consumes its click");
	frame();
	assert.equal(read.draws(), 4, "the clicked card redraws at its own level");
	assert.equal(edit.draws(), 2, "the card nobody touched reuses its drawn rows");
	assert.match(frame().join("\n"), /whole alpha/, "the clicked card shows its whole result");
	assert.match(frame().join("\n"), /preview beta/, "its sibling keeps the level it has");
	view.dispose();
});

test("a card style or content change draws new rows instead of the cached ones", (t) => {
	loadQuietTools();
	const previousStyle = cardStyle();
	const previousContent = cardContent();
	t.after(() => {
		setCardStyle(previousStyle);
		setCardContent(previousContent);
	});
	const store = new TaskStore();
	store.add(task("a"));
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1", false, "read-a");
	applyTool(store, "bash", { command: "printf hi" }, "hi", false, "bash-call");
	const view = paneOver(store, { theme: surfaceTheme, rows: 24 });
	const text = (): string => stripAnsi(view.render(60).join("\n"));

	setCardStyle(CARD_STYLE.FLOAT);
	const float = text();
	assert.match(float, /a0/, "the default content preference previews the read result");
	setCardStyle(CARD_STYLE.NEON);
	const neon = text();
	assert.notEqual(neon, float, "the overlay's cards still follow the shared card style");
	setCardStyle(CARD_STYLE.FLOAT);
	assert.equal(text(), float, "and returning to it draws those very rows again");

	setCardContent(CARD_CONTENT.MINIMAL);
	const minimal = text();
	assert.doesNotMatch(minimal, /a0/, "the shared content preference still applies to a cached card");
	// The bash card's heading names the tool and the activity in the other trees and the bare
	// command here, so the shared marker is the card's own `$` prompt glyph on its top rule.
	assert.match(minimal, /▎ \$ /, "bash draws its card while the chat offers it");
	assert.doesNotMatch(minimal, /Tool · bash · Complete/, "and the plain block the card replaces is not drawn beside it");
	setCardContent(CARD_CONTENT.DEFAULT);
	const restored = text();
	assert.match(restored, /a0/, "returning to the default previews the result again");
	const bashRows = (restored.match(/▎ \$ /g) ?? []).length + (restored.match(/Tool · bash · Complete/g) ?? []).length;
	assert.equal(bashRows, 1, "and bash is drawn once, as its card or as the plain block, whichever form this tree's content policy chooses");
	assert.equal((minimal.match(/▎ \$ /g) ?? []).length, 1, "the card replaces the plain block instead of stacking on it");
	setCardContent(CARD_CONTENT.MINIMAL);
	assert.equal(text(), minimal, "switching back draws the card exactly as before");
	view.dispose();
});

test("a card bash preference change draws new rows instead of the cached ones", (t) => {
	const bash = cardSlot(t, "bash");
	const read = cardSlot(t, "read");
	bash.publish({ label: "alpha", rowStable: true });
	read.publish({ label: "beta", rowStable: true });
	const previous = cardBash();
	t.after(() => setCardBash(previous));
	const store = new TaskStore();
	store.add(task("a"));
	applyTool(store, "bash", { command: "printf hi" }, "hi", false, "bash-call");
	applyTool(store, "read", { path: "src/a.ts" }, "a0", false, "read-a");
	const view = paneOver(store, { theme: plainTheme }, 24);
	const rows = (): string[] => view.render(60).map(stripAnsi);

	// This tree's bash card never shows the activity the preference picks, so a
	// change of preference draws the very same text. The observable is the cache
	// key moving instead: a retained drawing is drawn again rather than reused,
	// which is exactly what the card's own draw count records.
	const first = rows();
	assert.equal(bash.draws(), 2, "the first frame draws the call and its result");
	assert.equal(read.draws(), 2, "and the sibling card along with it");
	assert.deepEqual(rows(), first, "a warm frame draws the same rows");
	assert.equal(bash.draws(), 2, "which the bash card reuses instead of drawing again");
	assert.equal(read.draws(), 2, "and so does the card next to it");

	setCardBash(CARD_BASH.OUTPUT);
	const other = rows();
	assert.equal(bash.draws(), 4, "the changed preference draws the bash card again instead of its cached rows");
	// The frame key is shared by every card, exactly as the card style and content
	// preference already are, so the sibling is drawn under the new key as well.
	assert.equal(read.draws(), 4, "the whole frame is redrawn, sibling card included");
	assert.deepEqual(other, first, "and the rows are unchanged in this tree: only the key they were cached under moved");

	assert.deepEqual(rows(), other, "the new value reuses the rows it drew");
	assert.equal(bash.draws(), 4, "so the bash card is not drawn again while it stays chosen");
	assert.equal(read.draws(), 4, "nor is its sibling");

	setCardBash(previous);
	assert.deepEqual(rows(), first, "returning to the previous value draws its rows again");
	assert.equal(bash.draws(), 6, "the one-key cache keeps no entry for the value it came from");
	rows();
	assert.equal(bash.draws(), 6, "and those rows are reused from then on");
	view.dispose();
});

test("a keybinding change redraws the expand hint of a cached tool row", (t) => {
	loadQuietTools();
	// A card published without a drawing throws on every call, so this retained
	// item is drawn by the pane's own block — which is where the hint lives — and
	// the record still declares its rows stable, so the rows are the cached ones.
	const failing = cardSlot(t, "webfetch");
	failing.publish({ label: "alpha", rowStable: true, throwing: true });
	const { store, deps, view } = detailHarness({ keybindings: new KeybindingsManager(), threadPresentation: () => "cards" }, 20);
	applyTool(store, "webfetch", {}, "one\ntwo\nthree\nfour\nfive\nsix");
	const text = (): string => stripAnsi(view.render(70).join("\n"));
	assert.match(text(), /Tool · webfetch · Complete/, "the falling card keeps the pane's own block");
	assert.match(text(), /ctrl\+o to expand/, "the collapsed block offers the host's default key");
	deps.keybindings = new KeybindingsManager({ "app.tools.expand": "ctrl+e" });
	const rebound = text();
	assert.match(rebound, /ctrl\+e to expand/, "a rebound key is drawn instead of the cached hint");
	assert.doesNotMatch(rebound, /ctrl\+o to expand/, "the replaced default is gone from the block too");
	view.dispose();
});

test("a theme change with invalidate() redraws both the log and the cards", () => {
	let tone = "old";
	const theme = { fg: (_role: string, text: string) => `${tone}:${text}` };
	const store = new TaskStore();
	store.add(task("a", { prompt: "" }));
	store.apply("a", { type: TASK_EVENT.TEXT, text: "prose answer" }, 2000);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run" }, 2000);
	applyTool(store, "webfetch", {}, "page body", false, "fetch");
	for (const presentation of ["log", "cards"] as const) {
		const deps: AgentsViewDeps = { theme, rows: 24, store, sessionId: "s", now: () => 61_000, threadPresentation: () => presentation, onCancel() {}, onOpen() {}, onClose() {}, requestRender() {} };
		const view = new AgentsView(deps);
		tone = "old";
		assert.match(stripAnsi(view.render(80).join("\n")), /old:.*prose answer/, `${presentation}: the first frame is painted in the first theme`);
		tone = "new";
		view.invalidate();
		const after = view.render(80);
		assert.doesNotMatch(stripAnsi(after.join("\n")), /old:/, `${presentation}: no cached row keeps the previous theme`);
		const fresh = new AgentsView(deps);
		assert.deepEqual(after, fresh.render(80), `${presentation}: the invalidated frame equals a newly built one`);
		fresh.dispose();
		view.dispose();
	}
});

test("a card that declares no stable rows is drawn on every frame", (t) => {
	const webfetch = cardSlot(t, "webfetch");
	webfetch.publish({ label: "alpha" });
	const { store, view } = presentationHarness(() => "cards", 20);
	applyTool(store, "webfetch", {}, "page body");
	view.render(60);
	assert.equal(webfetch.draws(), 2, "the first frame draws the card");
	for (let frame = 0; frame < 3; frame += 1) view.render(60);
	assert.equal(webfetch.draws(), 8, "a record without rowStable is never reused");
	view.dispose();
});

test("a memory card, prose, thinking and notes are reused without a stability flag", () => {
	let paints = 0;
	const theme = { fg: (_role: string, text: string) => { paints += 1; return text; } };
	const store = new TaskStore();
	store.add(task("a", { prompt: "" }));
	applyTool(store, "mem_save", { title: "Design notes" }, '{"ok":true}');
	store.apply("a", { type: TASK_EVENT.TEXT, text: "prose answer" }, 2000);
	store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run" }, 2000);
	store.apply("a", { type: TASK_EVENT.NOTE, text: "retrying (2/3)" }, 2000);

	const warm = paneOver(store, { theme, rows: 24 });
	warm.render(60);
	const start = paints;
	warm.render(60);
	const warmFrame = paints - start;
	assert.match(stripAnsi(warm.render(60).join("\n")), /🧠 save “Design notes”/, "the memory card and the framed blocks are drawn");

	const fresh = paneOver(store, { theme, rows: 24 });
	const freshStart = paints;
	fresh.render(60);
	const coldFrame = paints - freshStart;
	assert.ok(warmFrame < coldFrame, `a warm frame repaints only the frame chrome (${warmFrame} < ${coldFrame})`);
	warm.dispose();
	fresh.dispose();
});

test("republishing or withdrawing a card changes what is drawn", (t) => {
	const read = cardSlot(t, "read");
	read.publish({ label: "alpha", rowStable: true });
	const { store, view } = presentationHarness(() => "cards", 20);
	applyTool(store, "read", { path: "src/a.ts" }, "a0");
	const text = (): string => stripAnsi(view.render(60).join("\n"));
	assert.match(text(), /preview alpha/, "the published card is drawn");
	assert.equal(read.draws(), 2, "and reused while it stays published");

	read.publish({ label: "beta", rowStable: true });
	const republished = text();
	assert.match(republished, /preview beta/, "a republication is drawn instead of the rows cached for the previous renderer");
	assert.doesNotMatch(republished, /alpha/, "and none of the previous card's rows survive");
	assert.equal(read.draws(), 4, "the new renderer draws once");

	read.publish(undefined);
	const withdrawn = text();
	assert.match(withdrawn, /Tool · read · Complete/, "a withdrawn card falls back on the plain block");
	assert.doesNotMatch(withdrawn, /beta/, "and its card rows leave the frame");
	view.dispose();
});

test("a running item is never cached and settles into its reused rows", (t) => {
	const read = cardSlot(t, "read");
	read.publish({ label: "alpha", rowStable: true });
	const { store, view } = presentationHarness(() => "cards", 20);
	store.apply("a", { type: TASK_EVENT.TOOL_START, callId: "call", name: "read", args: { path: "src/a.ts" } }, 2000);
	view.render(60);
	assert.equal(read.draws(), 1, "a running call with nothing retained draws its call row alone");
	view.render(60);
	assert.equal(read.draws(), 2, "and draws it again on the next frame");
	store.apply("a", { type: TASK_EVENT.TOOL_UPDATE, callId: "call", output: "partial" }, 2000);
	view.render(60);
	assert.equal(read.draws(), 4, "a running item whose output moved is drawn afresh");
	store.apply("a", { type: TASK_EVENT.TOOL_END, callId: "call", output: "a0\na1", isError: false }, 2000);
	const settled = view.render(60);
	assert.equal(read.draws(), 6, "the settled call draws once with its result");
	assert.match(stripAnsi(settled.join("\n")), /preview alpha/);
	view.render(60);
	assert.equal(read.draws(), 6, "and is reused from then on");
	view.dispose();
});

test("the cached cards match a freshly built view after every mutation", (t) => {
	loadQuietTools();
	const previousStyle = cardStyle();
	const previousContent = cardContent();
	t.after(() => {
		setCardStyle(previousStyle);
		setCardContent(previousContent);
	});
	const width = 80;
	const store = new TaskStore();
	store.add(task("a", { prompt: "" }));
	store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run" }, 2000);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "Prose answer" }, 2000);
	applyTool(store, "read", { path: "src/a.ts" }, "a0\na1\na2\na3\na4\na5", false, "read-a");
	store.apply("a", { type: TASK_EVENT.NOTE, text: "retrying (2/3)" }, 2000);
	applyTool(store, "edit", { path: "src/b.ts" }, "done", false, "edit-b");
	applyTool(store, "mem_save", { title: "notes" }, '{"ok":true}', false, "mem-c");
	const deps = (detailLevel: { thinkingExpanded: boolean; toolsExpanded: boolean }): AgentsViewDeps => ({ theme: surfaceTheme, rows: 12, store, sessionId: "s", now: () => 61_000, threadPresentation: () => "cards", cardDetail: detailLevel, onCancel() {}, onOpen() {}, onClose() {}, requestRender() {} });
	let detailLevel = { thinkingExpanded: true, toolsExpanded: false };
	const warm = new AgentsView(deps(detailLevel));
	// Three windows stand in for the whole scrollable thread: the following tail,
	// the start, and one page down, so a different row count shows up as a
	// different window even though maxScroll is not observable directly.
	const windows = (subject: AgentsView, at = width): { tail: string[]; start: string[]; page: string[] } => {
		const tail = subject.render(at);
		subject.handleInput("\x1b[7^");
		const start = subject.render(at);
		subject.handleInput("\x0a");
		const page = subject.render(at);
		subject.handleInput("\x1b[8^");
		return { tail, start, page };
	};
	const compare = (label: string, at = width): void => {
		const fresh = new AgentsView(deps(detailLevel));
		assert.deepEqual(windows(warm, at), windows(fresh, at), `${label}: the cached thread draws the fresh view's rows`);
		fresh.dispose();
	};

	warm.render(width);
	compare("a warm frame");
	const narrow = 60;
	assert.notDeepEqual(warm.render(narrow), warm.render(width), "a resized frame is a different one");
	compare("a width change", narrow);
	compare("the restored width");

	setCardStyle(CARD_STYLE.NEON);
	compare("a card style change");
	setCardContent(CARD_CONTENT.MINIMAL);
	compare("a content change");
	setCardContent(CARD_CONTENT.DEFAULT);
	detailLevel = { thinkingExpanded: true, toolsExpanded: true };
	warm.handleInput("\x0f");
	compare("expanding the thread's output");
	detailLevel = { thinkingExpanded: false, toolsExpanded: true };
	warm.handleInput("\x14");
	compare("hiding thinking");

	// The click mapping is observable at a scroll position: at the row that names
	// the read card, the same row must belong to it in both views.
	const clickParity = (): void => {
		const scrollToCard = (subject: AgentsView): number => {
			subject.handleInput("\x1b[7^");
			for (let page = 0; page < 6; page += 1) {
				const y = subject.render(width).findIndex((line) => /≡ read src\/a\.ts/.test(stripAnsi(line)));
				if (y >= 0) return y;
				subject.handleInput("\x0a");
			}
			return -1;
		};
		const fresh = new AgentsView(deps(detailLevel));
		const warmY = scrollToCard(warm);
		const freshY = scrollToCard(fresh);
		assert.ok(warmY >= 0, "the read card is drawn at some scroll position");
		assert.equal(warmY, freshY, "both views put the read card on the same row");
		assert.equal(warm.handleMouse(mouse(60, warmY, width, warm.render(width).length, "click"))?.handled, true);
		assert.equal(fresh.handleMouse(mouse(60, freshY, width, fresh.render(width).length, "click"))?.handled, true);
		assert.deepEqual(warm.render(width), fresh.render(width), "both views expanded the card under that row");
		fresh.dispose();
	};
	clickParity();
	warm.dispose();
});

test("the labeled log is byte-identical at every width and height", () => {
	const store = new TaskStore();
	store.add(task("a", { prompt: "Map the shared card code" }));
	store.apply("a", { type: TASK_EVENT.THINKING, text: "reasoning run\nsecond line" }, 2000);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "Prose answer" }, 2000);
	store.apply("a", { type: TASK_EVENT.NOTE, text: "retrying (2/3)" }, 2000);
	applyTool(store, "read", { path: "src/a.ts" }, Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"), false, "read-a");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "Closing prose" }, 2000);
	const deps = (rows: number): AgentsViewDeps => ({ theme: plainTheme, rows, store, sessionId: "s", now: () => 61_000, onCancel() {}, onOpen() {}, onClose() {}, requestRender() {} });
	for (const width of [60, 72, 100, 120, 160]) {
		for (const height of [6, 14, 30]) {
			const warm = new AgentsView(deps(height));
			warm.render(width);
			const frame = warm.render(width);
			const cold = new AgentsView(deps(height));
			assert.deepEqual(frame, cold.render(width), `${width}x${height}: a warm log frame is byte-identical to a cold one`);
			cold.dispose();
			// The pane's own drawing is every item's rows, back to back and sliced
			// to the window the log follows: the cache never stands in for a line.
			const layout = measureAgentsViewLayout(width, height);
			const visible = layout.bodyRows - 1;
			const reference = store.thread("a").items.flatMap((item) => renderThreadItem(item, plainTheme, layout.threadWidth));
			const start = Math.max(0, reference.length - visible);
			for (let row = 0; row < visible; row += 1) {
				const expected = reference[start + row] ?? "";
				if (stripAnsi(expected).trim() === "") continue;
				assert.ok(stripAnsi(frame[2 + row] ?? "").includes(stripAnsi(expected)), `${width}x${height}: log row ${row} keeps ${JSON.stringify(stripAnsi(expected))}`);
			}
			warm.dispose();
		}
	}
});

// A registered dev-binary override changes how a bash card reads its command, so a
// frame is keyed on its identity — which costs a read and a hash of the binary. The
// overlay must not pay that again for a frame whose inputs never moved.
function devBinaryHarness(t: { after(fn: () => void): void }) {
	const home = mkdtempSync(join(tmpdir(), "gentle-pi-agents-dev-binary-"));
	const environment: GentleAiDevBinaryEnvironment = { env: {}, home };
	setGentleAiDevBinaryEnvironmentForTesting(environment);
	t.after(() => {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		rmSync(home, { recursive: true, force: true });
	});
	return {
		binary: (name: string): string => {
			const path = join(home, name);
			writeFileSync(path, `#!/bin/sh\necho ${name}\n`);
			chmodSync(path, 0o755);
			return path;
		},
		register: (path: string): string => {
			registerGentleAiDevBinary(path, environment, process.platform);
			return path;
		},
		unregister: (): boolean => unregisterGentleAiDevBinary(environment),
	};
}

test("the overlay resolves the dev-binary override once instead of on every frame", (t) => {
	// The resolver reads the override through the ambient environment, so every read
	// of the declaration is one resolution the overlay paid for.
	const reads: Array<string | symbol> = [];
	const env = new Proxy({} as Record<string, string | undefined>, {
		get: (_target, key) => {
			reads.push(key);
			return undefined;
		},
	});
	const home = mkdtempSync(join(tmpdir(), "gentle-pi-agents-dev-binary-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env, home });
	t.after(() => {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		rmSync(home, { recursive: true, force: true });
	});
	const resolutions = (): number => reads.filter((key) => key === GENTLE_AI_DEV_BINARY_ENV).length;
	const { store, view } = detailHarness({ threadPresentation: () => "cards" }, 20);
	store.apply("a", { type: TASK_EVENT.TEXT, text: "prose" }, 2000);
	view.render(80);
	const cold = resolutions();
	assert.ok(cold > 0, "the first frame resolves the override its rows are keyed on");
	for (let frame = 0; frame < 3; frame += 1) view.render(80);
	assert.equal(resolutions(), cold, "a frame whose inputs never moved resolves nothing again");
	view.dispose();
});

test("a real dev-binary change draws the next frame, and an unchanged one keeps reusing its rows", (t) => {
	const dev = devBinaryHarness(t);
	const read = cardSlot(t, "read");
	read.publish({ label: "alpha", rowStable: true });
	const first = dev.register(dev.binary("gentle-ai-one"));
	const { store, view } = detailHarness({ threadPresentation: () => "cards" }, 20);
	applyTool(store, "read", { path: "src/a.ts" }, "a0");
	const frame = (): string[] => view.render(80);

	assert.match(stripAnsi(frame().join("\n")), /preview alpha/);
	const cold = read.draws();
	assert.ok(cold > 0, "the first frame draws the card");
	frame();
	assert.equal(read.draws(), cold, "an unchanged override reuses the rows it drew the frame under");

	const second = dev.register(dev.binary("gentle-ai-second-binary"));
	frame();
	assert.ok(read.draws() > cold, "a registry rewritten to another binary is a new identity, so the card is drawn again");
	const replaced = read.draws();
	frame();
	assert.equal(read.draws(), replaced, "and that identity is stable in turn");

	rmSync(second);
	frame();
	assert.ok(read.draws() > replaced, "losing the binary it names is a different identity too");
	const broken = read.draws();
	assert.equal(dev.unregister(), true, "the registration is the one this test wrote");
	frame();
	assert.ok(read.draws() > broken, "so removing it draws the rows again");
	assert.equal(first.length > 0, true, "the first binary was a real one");
	view.dispose();
});
