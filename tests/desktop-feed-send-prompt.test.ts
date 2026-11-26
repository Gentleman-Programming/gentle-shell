import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DESKTOP_ACTION_KINDS,
	DESKTOP_ACTION_LIMITS,
	DESKTOP_ACTION_SCHEMA,
	parseDesktopAction,
	questionShape,
	runDesktopAction,
	type DesktopActionOwners,
} from "../lib/desktop-feed-actions.ts";
import {
	askAnswerHandle,
	isAskAnswerHandle,
	publishChoiceAnswerHandle,
	publishQuestionnaireAnswerHandle,
} from "../lib/desktop-feed-answers.ts";
import type { DesktopRpcOutcome } from "../lib/desktop-rpc.ts";

// T11 (odd/tasks/herdr-desktop.md, S10): a session that runs outside Herdr app
// takes the desktop's prompts and answers through its own inbox, with the same
// authority as its terminal: text goes in as if typed in its editor; slash
// commands that are TUI code (pi built-ins, extension commands) and `!` shell
// lines stay in that session's terminal; nothing is sent while a question is
// open; and an ask tool question is answered through the tool's own handle.

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const envelope = (kind: string, args: Record<string, unknown>) =>
	JSON.stringify({ schema: DESKTOP_ACTION_SCHEMA, id: "p-1", sessionId: "s", kind, args, createdAt: new Date(NOW).toISOString() });
const code = (kind: string, args: Record<string, unknown>) => {
	const r = parseDesktopAction(envelope(kind, args), "s", NOW);
	return "error" in r ? r.error.code : "ok";
};

interface Calls { sent: Array<{ text: string; expand: boolean }>; answered: Array<{ toolCallId: string; option?: number; text?: string }>; owners: string[] }

function owners(over: Partial<DesktopActionOwners> = {}, state: { open?: boolean; working?: boolean; handle?: boolean } = {}): { owners: DesktopActionOwners; calls: Calls } {
	const calls: Calls = { sent: [], answered: [], owners: [] };
	const owner = (name: string) => async (value: string): Promise<DesktopRpcOutcome> => { calls.owners.push(`${name}:${value}`); return { ok: true, data: {} }; };
	const commands: Record<string, "extension" | "prompt" | "skill"> = { "gentle:mode": "extension", "gentle:agents": "extension", review: "prompt", "skill:go-testing": "skill" };
	return {
		calls,
		owners: {
			setPermissionMode: owner("mode"), cancelJob: owner("job"), cancelSubagent: owner("agent"),
			question: () => questionShape("ask_user_choice", "call-1", { question: "Which?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], allowCustomResponse: true }),
			working: () => state.working === true, abortTurn: () => { calls.owners.push("abort"); }, permissionMode: () => "normal", busyAt: () => false,
			questionOpen: () => state.open === true,
			commandSource: (name) => commands[name],
			sendPrompt: (text, expand) => { calls.sent.push({ text, expand }); return { queued: state.working === true }; },
			answerQuestion: (toolCallId, answer) => { if (!state.handle) return false; calls.answered.push({ toolCallId, ...answer }); return true; },
			...over,
		},
	};
}

const run = (o: DesktopActionOwners, kind: string, args: Record<string, unknown>) =>
	runDesktopAction({ id: "p-1", sessionId: "s", kind: kind as never, args, createdAt: NOW }, o);

// ---- send_prompt: the file ----

test("S10: send_prompt is a known kind with one bounded text argument", () => {
	assert.ok((DESKTOP_ACTION_KINDS as readonly string[]).includes("send_prompt"));
	assert.equal(DESKTOP_ACTION_LIMITS.prompt, 4000);
	assert.equal(code("send_prompt", { text: "hola" }), "ok");
	assert.equal(code("send_prompt", { text: "line one\nline two\ttabbed" }), "ok", "new lines and tabs are typed text");
	assert.equal(code("send_prompt", { text: "x".repeat(4000) }), "ok");
	assert.equal(code("send_prompt", { text: "x".repeat(4001) }), "invalid_action");
	assert.equal(code("send_prompt", { text: "" }), "invalid_action");
	assert.equal(code("send_prompt", { text: "   \n " }), "invalid_action", "nothing to send");
	assert.equal(code("send_prompt", { text: "bell\u0007" }), "invalid_action");
	assert.equal(code("send_prompt", { text: "esc\u001b[2J" }), "invalid_action", "no terminal escapes");
	assert.equal(code("send_prompt", { text: 42 }), "invalid_action");
	assert.equal(code("send_prompt", { text: "hola", deliverAs: "followUp" }), "invalid_action", "no other args");
	assert.equal(code("send_prompt", {}), "invalid_action");
});

test("S10: answer_question takes via \"session\" and nothing else for via", () => {
	assert.equal(code("answer_question", { toolCallId: "c", option: 0, via: "session" }), "ok");
	assert.equal(code("answer_question", { toolCallId: "c", text: "mine", via: "session" }), "ok");
	assert.equal(code("answer_question", { toolCallId: "c", option: 0, via: "keys" }), "invalid_action");
	assert.equal(code("answer_question", { toolCallId: "c", option: 0 }), "ok", "the key path stays as it was");
});

// ---- send_prompt: what runs ----

test("S10: plain text is delivered once, as typed, and says whether it was queued", async () => {
	const idle = owners();
	assert.deepEqual(await run(idle.owners, "send_prompt", { text: "  explain this file \n" }), { ok: true, data: { queued: false } });
	assert.deepEqual(idle.calls.sent, [{ text: "explain this file", expand: false }], "trimmed, like the TUI editor's submit");
	const busy = owners({}, { working: true });
	assert.deepEqual(await run(busy.owners, "send_prompt", { text: "also check the tests" }), { ok: true, data: { queued: true } });
	assert.deepEqual(busy.calls.sent, [{ text: "also check the tests", expand: false }]);
	assert.deepEqual([...idle.calls.owners, ...busy.calls.owners], [], "no other owner is reached");
});

test("S10: nothing is sent while a question, prompt or consent is open", async () => {
	const o = owners({}, { open: true });
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "yes" }), { ok: false, error: { code: "question_open", message: "Answer the open question first." } });
	assert.deepEqual(o.calls.sent, []);
});

test("S10: pi built-ins, extension commands and ! lines stay in that session's terminal", async () => {
	const o = owners();
	const terminal = { ok: false, error: { code: "terminal_command", message: "Open that session's terminal to run /commands." } };
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/new" }), terminal);
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/model claude-opus-5-5" }), terminal);
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/quit" }), terminal);
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/gentle:mode super-yolo" }), terminal, "an extension command is TUI code with its own authority");
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/gentle:agents" }), terminal);
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "!rm -rf build" }), { ok: false, error: { code: "terminal_command", message: "Open that session's terminal to run ! shell commands." } });
	assert.deepEqual(o.calls.sent, []);
	assert.deepEqual(o.calls.owners, [], "no permission owner is reached");
});

test("S10: prompt templates and skills expand as in the editor; an unknown /word is plain text", async () => {
	const o = owners();
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/review the parser" }), { ok: true, data: { queued: false } });
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/skill:go-testing add a table test" }), { ok: true, data: { queued: false } });
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "/tmp/build.log shows an error" }), { ok: true, data: { queued: false } });
	assert.deepEqual(o.calls.sent, [
		{ text: "/review the parser", expand: true },
		{ text: "/skill:go-testing add a table test", expand: true },
		{ text: "/tmp/build.log shows an error", expand: false },
	]);
});

test("S10: a session without a prompt owner refuses send_prompt", async () => {
	const o = owners({ sendPrompt: undefined });
	assert.deepEqual(await run(o.owners, "send_prompt", { text: "hola" }), { ok: false, error: { code: "unsupported", message: "This session takes no prompts from the desktop. Update Gentle Shell and restart it." } });
});

// ---- answer_question via the session ----

test("S10: answer_question via session answers the open question through its tool, once", async () => {
	const o = owners({}, { handle: true });
	assert.deepEqual(await run(o.owners, "answer_question", { toolCallId: "call-1", option: 1, via: "session" }), { ok: true, data: { toolCallId: "call-1", answered: true } });
	assert.deepEqual(await run(o.owners, "answer_question", { toolCallId: "call-1", text: "my own", via: "session" }), { ok: true, data: { toolCallId: "call-1", answered: true } });
	assert.deepEqual(o.calls.answered, [{ toolCallId: "call-1", option: 1 }, { toolCallId: "call-1", text: "my own" }]);
	assert.equal((await run(o.owners, "answer_question", { toolCallId: "call-2", option: 0, via: "session" })).ok, false, "another question");
	assert.deepEqual(await run(o.owners, "answer_question", { toolCallId: "call-1", option: 2, via: "session" }), { ok: false, error: { code: "invalid_action", message: "No such option" } });
	assert.equal(o.calls.answered.length, 2);
});

test("S10: without the tool's handle, or for a terminal-only question, the answer stays in that terminal", async () => {
	const none = owners({}, { handle: false });
	assert.deepEqual(await run(none.owners, "answer_question", { toolCallId: "call-1", option: 0, via: "session" }), { ok: false, error: { code: "answer_in_terminal", message: "Answer this question in that session's terminal." } });
	const relayed = owners({ question: () => questionShape("ask_user_choice", "call-1", { question: "Consent?", options: [{ label: "Yes", value: "granted" }, { label: "No", value: "declined" }] }) }, { handle: true });
	assert.deepEqual(await run(relayed.owners, "answer_question", { toolCallId: "call-1", option: 0, via: "session" }), { ok: false, error: { code: "answer_in_terminal", message: "Answer this question in the Terminal view" } });
	assert.deepEqual(relayed.calls.answered, [], "a relayed consent is never answered from the desktop");
});

// ---- The ask tools' answer handle ----

test("S10: ask_user_choice registers a handle that picks an option or a typed answer, once", () => {
	const finished: unknown[] = [];
	const params = { question: "Which?", options: [{ label: "A", description: "", value: "tok-a" }, { label: "B", description: "", value: "tok-b" }], allowCustomResponse: true };
	let done = false;
	assert.equal(askAnswerHandle("lib-call-1"), undefined);
	publishChoiceAnswerHandle("lib-call-1", params, (result) => { finished.push(result); done = true; }, () => done);
	const handle = askAnswerHandle("lib-call-1");
	assert.ok(isAskAnswerHandle(handle));
	assert.equal(handle.toolCallId, "lib-call-1");
	assert.equal(handle.answer({ option: 2 }), false, "no such option");
	assert.equal(handle.answer({ option: 1 }), true);
	assert.deepEqual(finished, [{ value: "tok-b", label: "B", index: 2 }], "the same shape a click in the list gives");
	assert.equal(handle.answer({ option: 0 }), false, "a finished list takes no second answer");
	assert.equal(finished.length, 1);
	assert.equal(askAnswerHandle("lib-call-1"), undefined, "a finished list is no longer listed");
});

test("S10: the choice handle takes text only where the list offers Other…", () => {
	const finished: unknown[] = [];
	const closed = { question: "Which?", options: [{ label: "A", description: "", value: "a" }, { label: "B", description: "", value: "b" }] };
	publishChoiceAnswerHandle("lib-call-2", closed, (result) => finished.push(result), () => false);
	assert.equal(askAnswerHandle("lib-call-2")!.answer({ text: "mine" }), false);
	publishChoiceAnswerHandle("lib-call-3", { ...closed, allowCustomResponse: true }, (result) => finished.push(result), () => false);
	const other = askAnswerHandle("lib-call-3")!;
	assert.equal(other.answer({ text: "   " }), false, "an empty response is refused, as in its editor");
	assert.equal(other.answer({ text: "mine" }), true);
	assert.deepEqual(finished, [{ customResponse: "mine" }]);
});

test("S10: ask_user_question publishes a handle only a single single-select question can use", () => {
	const completed: unknown[] = [];
	let done = false;
	const one = [{ question: "Pick", header: "H", options: [{ label: "X", description: "" }, { label: "Y", description: "", preview: "p" }] }];
	publishQuestionnaireAnswerHandle("lib-q-1", one, (result) => { completed.push(result); done = true; }, () => done);
	const handle = askAnswerHandle("lib-q-1")!;
	assert.equal(handle.answer({ option: 1 }), true);
	assert.deepEqual(completed, [{ cancelled: false, answers: [{ questionIndex: 0, question: "Pick", kind: "option", answer: "Y", preview: "p" }] }]);
	assert.equal(handle.answer({ option: 0 }), false);
	const t: unknown[] = [];
	publishQuestionnaireAnswerHandle("lib-q-2", one, (result) => t.push(result), () => false);
	assert.equal(askAnswerHandle("lib-q-2")!.answer({ text: "neither" }), true);
	assert.deepEqual(t, [{ cancelled: false, answers: [{ questionIndex: 0, question: "Pick", kind: "custom", answer: "neither" }] }]);
	const m: unknown[] = [];
	publishQuestionnaireAnswerHandle("lib-q-3", [...one, ...one], (result) => m.push(result), () => false);
	assert.equal(askAnswerHandle("lib-q-3")!.answer({ option: 0 }), false);
	publishQuestionnaireAnswerHandle("lib-q-4", [{ ...one[0]!, multiSelect: true }], (result) => m.push(result), () => false);
	assert.equal(askAnswerHandle("lib-q-4")!.answer({ option: 0 }), false);
	assert.deepEqual(m, []);
});

test("S10: the answer handles never answer with a consent token (granted/declined)", () => {
	const finished: unknown[] = [];
	const consent = { question: "Allow?", options: [{ label: "Yes", description: "", value: "granted" }, { label: "No", description: "", value: " Declined " }, { label: "Later", description: "", value: "later" }], allowCustomResponse: true };
	publishChoiceAnswerHandle("lib-tok-1", consent, (result) => finished.push(result), () => false);
	const choice = askAnswerHandle("lib-tok-1")!;
	assert.equal(choice.answer({ option: 0 }), false);
	assert.equal(choice.answer({ option: 1 }), false);
	assert.equal(choice.answer({ text: " GRANTED " }), false);
	assert.equal(choice.answer({ text: "declined" }), false);
	const questions = [{ question: "Allow?", options: [{ label: "granted", description: "" }, { label: "Declined", description: "" }, { label: "ok", description: "" }] }];
	publishQuestionnaireAnswerHandle("lib-tok-2", questions, (result) => finished.push(result), () => false);
	const questionnaire = askAnswerHandle("lib-tok-2")!;
	assert.equal(questionnaire.answer({ option: 0 }), false);
	assert.equal(questionnaire.answer({ option: 1 }), false);
	assert.equal(questionnaire.answer({ text: "granted" }), false);
	assert.deepEqual(finished, []);
	assert.equal(choice.answer({ option: 2 }), true, "other options still answer");
	assert.equal(questionnaire.answer({ option: 2 }), true);
	assert.equal(finished.length, 2);
});

test("S10: send_prompt takes CRLF line ends as LF; a lone CR stays invalid", async () => {
	const parsed = parseDesktopAction(envelope("send_prompt", { text: "one\r\ntwo\r\n" }), "s", NOW);
	assert.ok("action" in parsed);
	assert.equal(parsed.action.args.text, "one\ntwo\n");
	assert.equal(code("send_prompt", { text: "x".repeat(3999) + "\r\n" }), "ok", "the bound counts the typed text");
	assert.equal(code("send_prompt", { text: "one\rtwo" }), "invalid_action");
});

test("S10: an owner that holds the prompt for after compaction says so; a second one is refused", async () => {
	const held = owners({ sendPrompt: (text) => (text === "first" ? { queued: true, after: "compaction" } : { compacting: true }) });
	assert.deepEqual(await run(held.owners, "send_prompt", { text: "first" }), { ok: true, data: { queued: true, after: "compaction" } });
	assert.deepEqual(await run(held.owners, "send_prompt", { text: "second" }), { ok: false, error: { code: "session_compacting", message: "Pi is compacting this session and already holds one prompt for after it; send this one when compaction ends." } });
});

test("S10: isAskAnswerHandle accepts only the handle shape", () => {
	assert.equal(isAskAnswerHandle({ toolCallId: "c", answer: () => true }), true);
	assert.equal(isAskAnswerHandle({ toolCallId: "", answer: () => true }), false);
	assert.equal(isAskAnswerHandle({ toolCallId: "c" }), false);
	assert.equal(isAskAnswerHandle(null), false);
});

// ---- The real ask tools publish it while their TUI list is open ----

function toolHarness(register: (pi: any) => void) {
	let tool: any;
	const events: string[] = [];
	const pi = {
		registerTool(definition: any) { tool = definition; },
		on() {},
		events: { emit(name: string) { events.push(name); }, on() { return () => {}; } },
		getActiveTools: () => [],
		setActiveTools() {},
	};
	register(pi);
	// The TUI's ctx.ui.custom: builds the component with a done() that resolves the call.
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/w",
		sessionManager: { getBranch: () => [], getSessionId: () => "s", getEntries: () => [] },
		ui: {
			custom: (factory: any) => new Promise((resolve) => {
				const tui = { requestRender() {}, terminal: { rows: 30 } };
				const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
				factory(tui, theme, undefined, resolve);
			}),
		},
	};
	return { events, run: (id: string, params: unknown) => tool.execute(id, params, undefined, undefined, ctx) };
}

test("S10: the ask_user_choice list publishes its handle and the handle's answer is the tool's result", async () => {
	const { default: askUserChoice } = await import("../extensions/ask-user-choice.ts");
	const h = toolHarness(askUserChoice);
	const params = { question: "Which?", options: [{ label: "A", description: "a", value: "tok-a" }, { label: "B", description: "b", value: "tok-b" }] };
	const result = h.run("tool-call-7", params);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const handle = askAnswerHandle("tool-call-7")!;
	assert.ok(handle, "the open list registered its handle");
	assert.equal(handle.answer({ option: 1 }), true);
	const done = await result as { content: Array<{ text: string }>; details: { selection?: unknown } };
	assert.deepEqual(done.details.selection, { value: "tok-b", label: "B", index: 2 });
	assert.equal(done.content[0]!.text, "User selected: 2. B (value: tok-b)");
	assert.equal(handle.answer({ option: 0 }), false, "answered once");
	assert.deepEqual(h.events, ["gentle-pi:ask-user-choice:blocked", "gentle-pi:ask-user-choice:blocked"], "the tool's bus traffic is unchanged");
});

test("S10: the ask_user_question view publishes its handle and the handle's answer is the tool's result", async () => {
	const { default: askUserQuestion } = await import("../extensions/ask-user-question.ts");
	const h = toolHarness(askUserQuestion);
	const params = { questions: [{ question: "Pick one?", header: "Pick", options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }] }] };
	const result = h.run("tool-q-7", params);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const handle = askAnswerHandle("tool-q-7")!;
	assert.ok(handle, "the open view registered its handle");
	assert.equal(handle.answer({ option: 0 }), true);
	const done = await result as { details: { answers?: unknown } };
	assert.deepEqual(done.details.answers, [{ questionIndex: 0, question: "Pick one?", kind: "option", answer: "X" }]);
	assert.equal(handle.answer({ option: 1 }), false, "answered once");
	assert.deepEqual(h.events, ["gentle-pi:ask-user-question:blocked", "gentle-pi:ask-user-question:blocked"], "the tool's bus traffic is unchanged");
});
