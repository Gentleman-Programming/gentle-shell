import assert from "node:assert/strict";
import test from "node:test";
import { FULLSCREEN_ACTIVITY_EVENT, emitFullscreenActivity } from "../lib/fullscreen-activity.ts";
import askUserChoice from "../extensions/ask-user-choice.ts";
import askUserQuestion from "../extensions/ask-user-question.ts";

interface DeferredRequestResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

interface MountTrace {
	customCalls: number;
}

const CHOICE_PARAMS = {
	question: "Proceed with the deferred ask?",
	options: [
		{ label: "Go", description: "run it", value: "go" },
		{ label: "Wait", description: "hold", value: "wait" },
	],
} as const;

const QUESTION_PARAMS = {
	question: "Deferred questionnaire?",
	questions: [
		{
			id: "ship",
			header: "Shipping",
			prompt: "Ship kind",
			options: [
				{ label: "Now", description: "immediately" },
				{ label: "Later", description: "deferred" },
			],
		},
	],
	allowCustomResponse: undefined,
};

interface InstalledTools {
	choice: { execute: (...args: unknown[]) => Promise<DeferredRequestResult> };
	question: { execute: (...args: unknown[]) => Promise<DeferredRequestResult> };
	activity: { open(source: string): void; close(source: string): void };
	emitted: Array<{ channel: string; data: unknown }>;
	handlerCountFor(channel: string): number;
	release(): void;
}

/**
 * Register both real tools against one harness and one shared bus, the way
 * Gentle Shell loads them.
 */
function installTools(): InstalledTools {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const subscriptions: Array<() => void> = [];
	const events = {
		on(channel: string, handler: (data: unknown) => void): () => void {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			const unsubscribe = (): void => {
				const current = handlers.get(channel) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
			// release() must run the unsubscribe the bus actually handed out, not a
			// stand-in: the monitors' teardown is what keeps a test from leaking.
			subscriptions.push(unsubscribe);
			return unsubscribe;
		},
		emit(channel: string, data: unknown): void {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
	const choiceTool = { execute: undefined as unknown as InstalledTools["choice"]["execute"] };
	const questionTool = { execute: undefined as unknown as InstalledTools["question"]["execute"] };
	const pi = {
		registerTool: (candidate: unknown) => {
			const spec = candidate as { name: string; execute: (...args: unknown[]) => Promise<DeferredRequestResult> };
			if (spec.name === "ask_user_choice") choiceTool.execute = spec.execute;
			if (spec.name === "ask_user_question") questionTool.execute = spec.execute;
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void): void {
			// Pi's session events are outside this harness; release() only tears down
			// the bus subscriptions the tools' monitors install.
			void event;
			void handler;
		},
		events,
	};
	askUserChoice(pi as unknown as Parameters<typeof askUserChoice>[0]);
	askUserQuestion(pi as unknown as Parameters<typeof askUserQuestion>[0]);
	assert.ok(choiceTool.execute, "ask_user_choice must register");
	assert.ok(questionTool.execute, "ask_user_question must register");
	return {
		choice: choiceTool,
		question: questionTool,
		activity: {
			open: (source: string) => emitFullscreenActivity(pi, source, true),
			close: (source: string) => emitFullscreenActivity(pi, source, false),
		},
		emitted,
		handlerCountFor: (channel: string) => (handlers.get(channel) ?? []).length,
		release: () => subscriptions.splice(0).forEach((unsubscribe) => unsubscribe()),
	};
}

/** TUI ctx whose custom() counts mounts and resolves without a user pass. */
function tuiContext(trace: MountTrace) {
	return {
		mode: "tui",
		ui: {
			custom: async (_factory: unknown) => {
				trace.customCalls += 1;
				return undefined;
			},
		},
	};
}

function flush(): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, 20);
	});
}

function blockedEventsFor(record: InstalledTools, channel: string): Array<{ active: boolean }> {
	return record.emitted
		.filter((item) => item.channel === channel)
		.map((item) => item.data as { active: boolean });
}

test("ask_user_choice mounts only after the fullscreen menu closed (S1..S3)", async () => {
	const record = installTools();
	const trace: MountTrace = { customCalls: 0 };
	record.activity.open("gentle-shell:palette");

	const execution = record.choice.execute("call", CHOICE_PARAMS, new AbortController().signal, undefined, tuiContext(trace));
	await flush();
	assert.equal(trace.customCalls, 0, "the defer must hold while a fullscreen menu is open");
	assert.deepEqual(blockedEventsFor(record, "gentle-pi:ask-user-choice:blocked"), [], "the blocked lifecycle may not fire before the dialog mounts");

	record.activity.close("gentle-shell:palette");
	const result = await execution;
	assert.equal(trace.customCalls, 1, "the dialog mounts exactly once, after the menu closes");
	assert.deepEqual(
		blockedEventsFor(record, "gentle-pi:ask-user-choice:blocked").map((event) => event.active),
		[true, false],
	);
	assert.equal(result.details.cancelled, true, "an unresolved mount completes as the tool's own cancelled shape");
	record.release();
});

test("ask_user_question keeps the same defer contract as the choice tool", async () => {
	const record = installTools();
	const trace: MountTrace = { customCalls: 0 };
	record.activity.open("gentle-stats:summary");

	const execution = record.question.execute("call", QUESTION_PARAMS, new AbortController().signal, undefined, tuiContext(trace));
	await flush();
	assert.equal(trace.customCalls, 0, "the questionnaire also defers behind an open overlay menu");

	record.activity.close("gentle-stats:summary");
	const result = await execution;
	assert.equal(trace.customCalls, 1);
	assert.deepEqual(
		blockedEventsFor(record, "gentle-pi:ask-user-question:blocked").map((event) => event.active),
		[true, false],
	);
	assert.equal(result.details.cancelled, true, "an unresolved mount completes as the tool's own cancelled shape");
	record.release();
});

test("ask tools mount immediately when no fullscreen menu ever opened", async () => {
	const record = installTools();
	const trace: MountTrace = { customCalls: 0 };

	const execution = record.choice.execute("call", CHOICE_PARAMS, new AbortController().signal, undefined, tuiContext(trace));
	await flush();
	assert.equal(trace.customCalls, 1, "no activity present means no defer");
	record.release();
	await execution;
});

test("an aborted signal during the defer returns the cancelled shape without mounting (S5)", async () => {
	const record = installTools();
	const trace: MountTrace = { customCalls: 0 };
	const signal = new AbortController();

	record.activity.open("gentle-shell:palette");
	const execution = record.choice.execute("call", CHOICE_PARAMS, signal.signal, undefined, tuiContext(trace));
	await flush();
	signal.abort();
	const result = await execution;

	assert.equal(trace.customCalls, 0, "aborting the defer never reaches the mount");
	assert.equal(result.details.cancelled, true);
	assert.deepEqual(blockedEventsFor(record, "gentle-pi:ask-user-choice:blocked"), []);
	record.release();
});

test("an aborted signal during the defer cancels the questionnaire too (S5)", async () => {
	const record = installTools();
	const trace: MountTrace = { customCalls: 0 };
	const signal = new AbortController();

	record.activity.open("gentle-shell:palette");
	const execution = record.question.execute("call", QUESTION_PARAMS, signal.signal, undefined, tuiContext(trace));
	await flush();
	signal.abort();
	const result = await execution;

	assert.equal(trace.customCalls, 0, "aborting the defer never reaches the questionnaire mount");
	assert.equal(result.details.cancelled, true);
	assert.deepEqual(blockedEventsFor(record, "gentle-pi:ask-user-question:blocked"), []);
	record.release();
});

test("a signal that was already aborted before the defer keeps today's mount behavior (S6)", async () => {
	const record = installTools();
	const trace: MountTrace = { customCalls: 0 };
	const signal = new AbortController();
	signal.abort();

	const execution = record.choice.execute("call", CHOICE_PARAMS, signal.signal, undefined, tuiContext(trace));
	await execution;
	assert.equal(trace.customCalls, 1, "only the wait-stage abort is new behavior; pre-wait aborted calls keep mounting");
	record.release();
});

test("a SECOND menu opening after the first one closed keeps deferring (S3 ordering)", async () => {
	const record = installTools();
	const trace: MountTrace = { customCalls: 0 };

	record.activity.open("gentle-shell:palette");
	const execution = record.choice.execute("call", CHOICE_PARAMS, new AbortController().signal, undefined, tuiContext(trace));
	record.activity.close("gentle-shell:palette");
	record.activity.open("gentle-shell:customize");

	await flush();
	assert.equal(trace.customCalls, 0, "the new open must re-arm the defer");

	record.activity.close("gentle-shell:customize");
	await execution;
	assert.equal(trace.customCalls, 1);
	record.release();
});

test("both ask tools subscribe the shared fullscreen activity channel at registration", () => {
	const record = installTools();
	assert.equal(
		record.handlerCountFor(FULLSCREEN_ACTIVITY_EVENT),
		2,
		"one FullscreenActivityMonitor attach per tool, on the shared bus",
	);
	assert.equal(record.handlerCountFor("gentle-pi:ask-user-choice:blocked"), 0, "tools emit their own blocked lifecycle; they never subscribe it");
	record.release();
});
