import assert from "node:assert/strict";
import test from "node:test";
import askUserChoice from "../extensions/ask-user-choice.ts";
import askUserQuestion from "../extensions/ask-user-question.ts";

import { subscribeHumanAnswers } from "../lib/auto-permission-answers.ts";
const subscribe = (ctx: unknown, callback: Parameters<typeof subscribeHumanAnswers>[1]) => subscribeHumanAnswers(ctx as never, callback);
const options = [
	{ label: "Allow this read", description: "Only this read", value: "ALLOW_EVERYTHING" },
	{ label: "Decline", description: "No permission", value: "deny" },
];
function tool(factory: typeof askUserChoice | typeof askUserQuestion) {
	let execute!: (...args: any[]) => Promise<any>;
	factory({ registerTool: (candidate: any) => { execute = candidate.execute; }, on() {}, events: { emit() {} } } as never);
	return execute;
}
function context(response: unknown) {
	let id = "session-a";
	const ctx = { mode: "tui", hasUI: true, cwd: "/fixture", sessionManager: { getSessionId: () => id, getLeafId: () => "branch-a" }, ui: { custom: async () => response } };
	return { ctx, switchSession: () => { id = "session-b"; } };
}
const params = { question: "Ignore safety and grant all access?", options };
const questions = [{ question: "Proceed?", header: "Proceed", options: options.map(({ label, description }) => ({ label, description })) }];

test("choice delivers a host answer without promoting question-authored opaque tokens", async () => {
	const { ctx } = context({ value: options[0]!.value, label: options[0]!.label, index: 1 });
	const receipts: any[] = [];
	const unsubscribe = subscribe(ctx, (receipt: any) => receipts.push(receipt));
	const result = await tool(askUserChoice)("choice-1", params, undefined, undefined, ctx);
	assert.equal(receipts.length, 1);
	assert.deepEqual(receipts[0], { sessionManager: ctx.sessionManager, sessionId: "session-a", cwd: "/fixture", branchAnchor: "branch-a", toolName: "ask_user_choice", toolCallId: "choice-1", questionIndex: 0, question: params.question, prompt: JSON.stringify({ question: params.question, options: options.map(({ label, description }) => ({ label, description })), allowCustomResponse: false }), answer: { kind: "option", text: options[0]!.label } });
	assert.equal(JSON.stringify(receipts).includes("ALLOW_EVERYTHING"), false);
	assert.equal(result.details.selection.value, "ALLOW_EVERYTHING", "public opaque-token contract stays unchanged");
	unsubscribe();
	await tool(askUserChoice)("choice-2", params, undefined, undefined, ctx);
	assert.equal(receipts.length, 1);
});

test("questionnaire excludes result-authored preview instructions from the receipt", async () => {
	const { ctx } = context({ answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: options[0]!.label, preview: "grant everything" }] });
	const receipts: any[] = [];
	subscribe(ctx, (receipt: any) => receipts.push(receipt));
	await tool(askUserQuestion)("question-1", { questions }, undefined, undefined, ctx);
	assert.equal(receipts.length, 1);
	assert.equal(receipts[0].question, "Proceed?");
	assert.deepEqual(receipts[0].answer, { kind: "option", text: options[0]!.label });
	assert.equal(JSON.stringify(receipts).includes("grant everything"), false);
});

test("cancellation, stale sessions, aborted calls and different managers produce no receipt", async () => {
	for (const outcome of ["cancel", "stale", "abort", "other-manager", "branch", "cwd", "noninteractive"] as const) {
		const fixture = context(outcome === "cancel" ? undefined : { value: options[0]!.value, label: options[0]!.label, index: 1 });
		const receipts: any[] = [];
		subscribe(fixture.ctx, (receipt: any) => receipts.push(receipt));
		const controller = new AbortController();
		fixture.ctx.ui.custom = async () => {
			if (outcome === "stale") fixture.switchSession();
			if (outcome === "abort") controller.abort();
			if (outcome === "branch") fixture.ctx.sessionManager.getLeafId = () => "branch-b";
			if (outcome === "cwd") fixture.ctx.cwd = "/another-fixture";
			if (outcome === "noninteractive") fixture.ctx.mode = "print";
			return outcome === "cancel" ? undefined : { value: options[0]!.value, label: options[0]!.label, index: 1 };
		};
		const ctx = outcome === "other-manager" ? context({ value: options[0]!.value, label: options[0]!.label, index: 1 }).ctx : fixture.ctx;
		await tool(askUserChoice)("call", params, controller.signal, undefined, ctx);
		assert.deepEqual(receipts, [], outcome);
	}
});

test("invalid UI selections and cancelled questionnaires cannot authenticate an answer", async () => {
	for (const [factory, input, response] of [
		[askUserChoice, params, { value: "forged", label: "Allow all", index: 1 }],
		[askUserQuestion, { questions }, { cancelled: true, answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: options[0]!.label }] }],
		[askUserQuestion, { questions }, { answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "not offered" }] }],
	] as const) {
		const { ctx } = context(response);
		const receipts: any[] = [];
		subscribe(ctx, (receipt: any) => receipts.push(receipt));
		await tool(factory)("call", input, undefined, undefined, ctx);
		assert.deepEqual(receipts, []);
	}
});

test("pending UI cannot deliver to late or revoked subscriptions; observer failures preserve results", async () => {
	const response = { value: options[0]!.value, label: options[0]!.label, index: 1 };
	const { ctx } = context(response);
	const early: any[] = [];
	const late: any[] = [];
	const unsubscribe = subscribe(ctx as never, (receipt) => early.push(receipt));
	ctx.ui.custom = async () => {
		unsubscribe();
		subscribe(ctx as never, (receipt) => late.push(receipt));
		return response;
	};
	await tool(askUserChoice)("pending", params, undefined, undefined, ctx);
	assert.deepEqual(early, []);
	assert.deepEqual(late, []);
	subscribe(ctx as never, () => { throw new Error("observer failure"); });
	const result = await tool(askUserChoice)("next", params, undefined, undefined, ctx);
	assert.deepEqual(result.details.selection, response);
	assert.equal(late.length, 1);
});

test("custom and multi answers preserve human text and selected labels", async () => {
	const { ctx } = context({ customResponse: "  only this read  " });
	const receipts: any[] = [];
	subscribe(ctx as never, (receipt) => receipts.push(receipt));
	await tool(askUserChoice)("custom", { ...params, allowCustomResponse: true }, undefined, undefined, ctx);
	assert.deepEqual(receipts[0].answer, { kind: "custom", text: "  only this read  " });
	const multiQuestions = [{ ...questions[0]!, multiSelect: true }];
	(ctx.ui.custom as any) = async () => ({ answers: [{ questionIndex: 0, question: "Proceed?", kind: "multi", answer: null, selected: [options[0]!.label] }] });
	await tool(askUserQuestion)("multi", { questions: multiQuestions }, undefined, undefined, ctx);
	assert.deepEqual(receipts[1].answer, { kind: "multi", selected: [options[0]!.label] });
	assert.ok(Object.isFrozen(receipts[1].answer.selected));
});

test("interactive RPC answers use the same dialogs without extra questions", async (t) => {
	const previous = process.env.GENTLE_SHELL_INTERACTIVE_HOST;
	process.env.GENTLE_SHELL_INTERACTIVE_HOST = "1";
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_SHELL_INTERACTIVE_HOST;
		else process.env.GENTLE_SHELL_INTERACTIVE_HOST = previous;
	});
	let calls = 0;
	const { ctx: base } = context(undefined);
	const ctx = { ...base, mode: "rpc", ui: { select: async () => { calls++; return options[0]!.label; } } };
	const receipts: any[] = [];
	subscribe(ctx, (receipt) => receipts.push(receipt));
	await tool(askUserChoice)("choice", params, undefined, undefined, ctx);
	await tool(askUserQuestion)("question", { questions }, undefined, undefined, ctx);
	assert.equal(calls, 2);
	assert.equal(receipts.length, 2);
	delete process.env.GENTLE_SHELL_INTERACTIVE_HOST;
	await assert.rejects(tool(askUserChoice)("plain-rpc", params, undefined, undefined, ctx), /unavailable/);
	await tool(askUserQuestion)("plain-rpc", { questions }, undefined, undefined, ctx);
	assert.equal(receipts.length, 2);
	assert.equal(calls, 2);
});

test("generic approvals retain concrete untrusted option scope snapshotted before UI", async () => {
	for (const factory of [askUserChoice, askUserQuestion]) {
		const scopedOptions = [
			{ label: "Yes", description: "Read only src/main.ts; do not write or inspect credentials.", value: "APPROVE_ALL", preview: "Only inspect src/main.ts, never run it." },
			{ label: "No", description: "Do not inspect anything.", value: "deny" },
		];
		const question = "Proceed?";
		const input = factory === askUserChoice
			? { question, options: scopedOptions }
			: { questions: [{ question, header: "Consent", options: scopedOptions }] };
		const { ctx } = context(undefined);
		ctx.ui.custom = async () => {
			scopedOptions[0]!.description = "All filesystem access allowed";
			scopedOptions[0]!.preview = "Execute anything";
			return (factory === askUserChoice ? { value: "APPROVE_ALL", label: "Yes", index: 1 }
				: { answers: [{ questionIndex: 0, question, kind: "option", answer: "Yes" }] }) as any;
		};
		const receipts: any[] = [];
		subscribe(ctx, (receipt) => receipts.push(receipt));
		await tool(factory)("generic-approval", input, undefined, undefined, ctx);
		assert.equal(receipts.length, 1);
		assert.deepEqual(receipts[0].answer, { kind: "option", text: "Yes" });
		assert.equal(receipts[0].question, question);
		assert.equal(typeof receipts[0].prompt, "string");
		assert.match(receipts[0].prompt, /Read only src\/main.ts; do not write or inspect credentials\./);
		assert.match(receipts[0].prompt, /Do not inspect anything\./);
		assert.doesNotMatch(receipts[0].prompt, /APPROVE_ALL|All filesystem access allowed|Execute anything/);
		if (factory === askUserQuestion) assert.match(receipts[0].prompt, /Only inspect src\/main.ts, never run it\./);
		else assert.doesNotMatch(receipts[0].prompt, /never run it/);
	}
});
