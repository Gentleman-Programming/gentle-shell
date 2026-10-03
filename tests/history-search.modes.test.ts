import assert from "node:assert/strict";
import test from "node:test";
import historySearch from "../extensions/history-search.ts";

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: unknown) => unknown;
}

interface CapturingPi {
	commands: Map<string, RegisteredCommand>;
	registerCommand: (name: string, opts: RegisteredCommand) => void;
}

function makePi(): CapturingPi {
	const commands = new Map<string, RegisteredCommand>();
	return {
		commands,
		registerCommand(name, opts) {
			commands.set(name, opts);
		},
	};
}

interface FakeUi {
	notify: (msg: string, level: string) => void;
	setEditorText: (text: string) => void;
	custom: (...args: unknown[]) => Promise<unknown>;
}

interface FakeCtx {
	mode: string;
	hasUI: boolean;
	ui: FakeUi;
	sessionManager: { getEntries: () => unknown[] };
}

function makeCtx(
	mode: string,
	hasUI: boolean,
	entries: unknown[] = [],
): {
	ctx: FakeCtx;
	notifyCalls: Array<{ msg: string; level: string }>;
	setEditorTextCalls: string[];
	customCalls: unknown[];
} {
	const notifyCalls: Array<{ msg: string; level: string }> = [];
	const setEditorTextCalls: string[] = [];
	const customCalls: unknown[] = [];
	const ctx: FakeCtx = {
		mode,
		hasUI,
		ui: {
			notify: (msg, level) => {
				notifyCalls.push({ msg, level });
			},
			setEditorText: (text) => {
				setEditorTextCalls.push(text);
			},
			custom: (...args: unknown[]) => {
				customCalls.push(args);
				return Promise.resolve(undefined);
			},
		},
		sessionManager: {
			getEntries: () => entries,
		},
	};
	return { ctx, notifyCalls, setEditorTextCalls, customCalls };
}

test("rpc mode with hasUI=false posts only the availability notify", async () => {
	const pi = makePi();
	historySearch(pi as never);
	const handler = pi.commands.get("history")!.handler;

	const { ctx, notifyCalls, setEditorTextCalls, customCalls } = makeCtx(
		"rpc",
		false,
		[{ type: "message", message: { role: "bashExecution", command: "ls" } }],
	);

	await handler("", ctx);

	assert.equal(setEditorTextCalls.length, 0, "setEditorText must not be called");
	assert.equal(customCalls.length, 0, "ui.custom must not be called");
	assert.equal(notifyCalls.length, 1, "exactly one notify should be posted");
	assert.equal(
		notifyCalls[0]?.msg,
		"Comando /history solo disponible en modo TUI.",
	);
	assert.equal(notifyCalls[0]?.level, "info");
});

test("print mode with hasUI=true still does not open the picker or mutate the editor", async () => {
	const pi = makePi();
	historySearch(pi as never);
	const handler = pi.commands.get("r")!.handler;

	const { ctx, notifyCalls, setEditorTextCalls, customCalls } = makeCtx(
		"print",
		true,
		[{ type: "message", message: { role: "bashExecution", command: "ls" } }],
	);

	await handler("", ctx);

	assert.equal(setEditorTextCalls.length, 0);
	assert.equal(customCalls.length, 0);
	assert.equal(notifyCalls.length, 1);
	assert.equal(
		notifyCalls[0]?.msg,
		"Comando /history solo disponible en modo TUI.",
	);
});
