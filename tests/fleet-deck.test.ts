import assert from "node:assert/strict";
import test from "node:test";
import { emptyThread, type TaskRecord } from "../lib/agents-protocol.ts";
import type { FleetAgentsMember } from "../lib/fleet-agents-view.ts";
import { FleetDeck } from "../lib/fleet-deck.ts";
import type { FleetMemberSubagent } from "../lib/fleet-member.ts";
import type { FleetViewSnapshot } from "../lib/fleet-view.ts";
import { inkwellFleet } from "./support/fleet-view-fixture.ts";

// T10 (S9): the deck opens the members-and-subagents modal; the other keys keep working.

const ALT_W = "\x1bw", ALT_Z = "\x1bz", ALT_2 = "\x1b2", ALT_M = "\x1bm", ESC = "\x1b", TAB = "\t";
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text, bg: (_role: string, text: string) => text };
const QUIET: FleetViewSnapshot = { title: null, objective: null, members: [], log: [] };

function subagent(id: string, agent: string): FleetMemberSubagent {
	const task: TaskRecord = {
		id, agent, label: `Label of ${id}`, status: "running", createdAt: 1, startedAt: 40_000, endedAt: null, lastActivityAt: 1, lastStep: "tool edit", error: null,
		turns: 0, toolCalls: 0, mode: "background", prompt: "", cwd: "", parentSessionId: "", model: "", thinking: undefined, sessionPath: null, result: null, tokens: 0, cost: 0,
	};
	return { task, thread: { ...emptyThread(), items: [{ kind: "text", text: `working on ${id}` }] } };
}

function harness(snapshot: FleetViewSnapshot = QUIET) {
	const list = { api: [subagent("t1", "sdd-apply")] };
	const members: FleetAgentsMember[] = [{ name: "api", status: "working", subagents: () => list.api }];
	const widgets = new Map<string, unknown>();
	const inputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const overlays: Array<{ component: { render(width: number): string[]; handleInput?(data: string): void }; options: unknown; closed: boolean }> = [];
	const notices: string[] = [];
	let editorText = "";
	let renders = 0;
	const editor = { getText: () => editorText, isShowingAutocomplete: () => false, handleInput(data: string) { editorText += data; } };
	let focused: unknown = editor;
	const tui = { requestRender: () => { renders += 1; }, getFocusedComponent: () => focused, terminal: { rows: 30, columns: 120 } };
	const ui = {
		setWidget: (key: string, content: unknown) => {
			widgets.set(key, content);
			if (typeof content === "function") content(tui, theme);
		},
		notify: (message: string) => notices.push(message),
		onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
			inputs.push(handler);
			return () => { inputs.splice(inputs.indexOf(handler), 1); };
		},
		getEditorText: () => editorText,
		// Like Pi, an overlay takes the focus while it is open.
		custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown, options: unknown) => new Promise(resolve => {
			const overlay = { component: undefined as never, options, closed: false };
			const before = focused;
			overlay.component = factory(tui, theme, {}, value => { overlay.closed = true; focused = before; resolve(value); }) as never;
			focused = overlay.component;
			overlays.push(overlay);
		}),
	};
	const deck = new FleetDeck({ snapshot: () => snapshot, answer: () => undefined, relayDialog: () => undefined, memberAgents: () => members, now: () => 100_000 });
	deck.mount(ui as never);
	const render = (key: string, width = 120): string[] => (widgets.get(key) as (tui: unknown, theme: unknown) => { render(width: number): string[] })(tui, theme).render(width);
	// Like Pi's TUI: the input listeners first, then the focused component.
	const press = (...keys: string[]) => keys.map(key => {
		if (inputs.some(handler => handler(key)?.consume === true)) return true;
		(focused as { handleInput?(data: string): void }).handleInput?.(key);
		return false;
	});
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));
	return {
		deck, list, overlays, notices, press, render, settle,
		status: () => render("gentle-fleet-status").join("\n"),
		editorText: () => editorText,
		setEditor: (text: string) => { editorText = text; },
		renders: () => renders,
		focusDialog: () => { focused = { kind: "dialog", handleInput() {} }; },
		open: () => overlays.filter(overlay => !overlay.closed),
	};
}

test("alt+w opens the members and subagents modal full screen from the input; alt+w, esc or w close it", async () => {
	const h = harness();
	assert.deepEqual(h.press(ALT_W), [true]);
	assert.equal(h.overlays.length, 1);
	assert.deepEqual(h.overlays[0].options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } });
	const screen = h.overlays[0].component.render(120);
	assert.equal(screen.length, 30, "the whole terminal");
	assert.match(screen.join("\n"), /Fleet agents · 1 member · 1 active subagent[\s\S]*api · working[\s\S]*└ sdd-apply · running {2}1m00s[\s\S]*working on t1/);
	assert.deepEqual(h.press(ALT_W), [true]);
	assert.equal(h.overlays[0].closed, true);
	await h.settle();
	h.press(ALT_W);
	assert.deepEqual(h.press(ESC), [false], "esc reaches the modal");
	assert.equal(h.overlays[1].closed, true);
	await h.settle();
	h.press(ALT_W);
	h.press("w");
	assert.equal(h.overlays[2].closed, true);
	assert.equal(h.editorText(), "", "nothing reached the input");
});

test("while the modal is open it takes every key but alt+w: the lens, density and zoom keys wait", async () => {
	const h = harness();
	h.press(ALT_W);
	assert.deepEqual(h.press(ALT_2, ALT_M, ALT_Z, "j", "k"), [false, false, false, false, false]);
	assert.equal(h.open().length, 1, "no zoom on top");
	h.press(ALT_W);
	await h.settle();
	assert.match(h.status(), /lens flows · density light/);
});

test("a member push repaints the open modal with the new subagents, and only while it is open", async () => {
	const h = harness();
	const before = h.renders();
	h.deck.refreshAgents();
	assert.equal(h.renders(), before, "closed: nothing to repaint");
	h.press(ALT_W);
	h.list.api = [subagent("t1", "sdd-apply"), subagent("t2", "explorer")];
	const repaint = h.renders();
	h.deck.refreshAgents();
	assert.equal(h.renders(), repaint + 1);
	assert.match(h.overlays[0].component.render(120).join("\n"), /└ explorer · running/);
});

test("w opens it from the zoom and the focal bar; typed text keeps every character; nothing opens over another dialog", async () => {
	const h = harness(inkwellFleet());
	for (const text of ["what now", "wait for the API"]) {
		h.setEditor("");
		assert.ok(h.press(...text.split("")).every(consumed => !consumed), text);
		assert.equal(h.editorText(), text);
	}
	assert.equal(h.overlays.length, 0);
	h.setEditor("");
	h.press(ALT_Z);
	assert.match(h.status(), /w agents/, "the zoom hint offers it");
	assert.deepEqual(h.press("w"), [true]);
	assert.equal(h.overlays[0].closed, true, "the zoom gives way");
	assert.match(h.overlays[1].component.render(120).join("\n"), /Fleet agents/);
	h.press(ESC);
	await h.settle();
	assert.deepEqual(h.press(TAB), [true], "the focal bar");
	assert.match(h.status(), /w agents/);
	assert.deepEqual(h.press("w"), [true]);
	assert.equal(h.open().length, 1);
	assert.doesNotMatch(h.status(), /choose/, "the focal bar was left");
	h.press(ESC);
	await h.settle();
	h.focusDialog();
	assert.deepEqual(h.press(ALT_W), [false]);
	assert.equal(h.open().length, 0);
});

// Pinned (T10): the deck keys behave as before with the modal wired.
test("alt+2, alt+m and alt+z still switch the lens, the density and the zoom; the input hint lists alt+w last before @name", async () => {
	const h = harness();
	assert.deepEqual(h.press(ALT_2, ALT_M), [true, true]);
	assert.match(h.status(), /lens map · density normal/);
	assert.deepEqual(h.press(ALT_Z), [true]);
	assert.equal(h.open().length, 1);
	assert.deepEqual(h.press(ALT_Z), [true]);
	await h.settle();
	assert.equal(h.open().length, 0);
	assert.match(h.status(), /enter send .*alt\+1-4 lenses .*alt\+z zoom .*alt\+m detail .*alt\+w agents .*@name/);
	h.press("?");
	assert.deepEqual(h.notices, [], "letters still never act from the input");
});
