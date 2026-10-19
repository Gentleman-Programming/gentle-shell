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

interface CapturedComponent {
	render(width: number): string[];
}

interface FakeUi {
	notify: (msg: string, level: string) => void;
	setEditorText: (text: string) => void;
	custom: (factory: (...args: unknown[]) => unknown) => Promise<unknown>;
}

function makeTui(): { requestRender: () => void } {
	return { requestRender: () => {} };
}

const PASSTHROUGH_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
};

test("in TUI mode with non-empty history, ctx.ui.custom is invoked exactly once", async () => {
	const pi = makePi();
	historySearch(pi as never);
	const handler = pi.commands.get("history")!.handler;

	const entries = [
		{ type: "message", message: { role: "bashExecution", command: "ls -la" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "bash", arguments: { command: "git status" } },
				],
			},
		},
		{ type: "message", message: { role: "bashExecution", command: "npm test" } },
	];

	let customCalls = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			setEditorText: () => {},
			custom: (_factory: (...args: unknown[]) => unknown) => {
				customCalls += 1;
				return Promise.resolve(undefined);
			},
		},
		sessionManager: { getEntries: () => entries },
	};

	await handler("", ctx);

	assert.equal(customCalls, 1, "ctx.ui.custom should be invoked exactly once");
});

test("the factory returned to ctx.ui.custom builds a Container with a render(width) method", async () => {
	const pi = makePi();
	historySearch(pi as never);
	const handler = pi.commands.get("history")!.handler;

	const entries = [
		{ type: "message", message: { role: "bashExecution", command: "ls -la" } },
		{
			type: "message",
			message: { role: "bashExecution", command: "git status" },
		},
	];

	let component: CapturedComponent | undefined;
	let capturedFactory: ((...args: unknown[]) => unknown) | undefined;

	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			setEditorText: () => {},
			custom: (factory: (...args: unknown[]) => unknown) => {
				capturedFactory = factory;
				const tui = makeTui();
				const done = (_value: unknown) => {};
				component = factory(
					tui,
					PASSTHROUGH_THEME,
					undefined,
					done,
				) as CapturedComponent;
				return Promise.resolve(undefined);
			},
		},
		sessionManager: { getEntries: () => entries },
	};

	await handler("", ctx);

	assert.ok(capturedFactory, "custom should receive a factory");
	assert.ok(component, "factory should produce a component");
	assert.equal(
		typeof component!.render,
		"function",
		"component must expose render(width)",
	);

	const lines = component!.render(80);
	assert.ok(Array.isArray(lines), "render(width) must return an array");
	assert.ok(lines.length > 0, "rendered output should have at least one line");
});

test("the rendered component contains the picker title and every deduped command", async () => {
	const pi = makePi();
	historySearch(pi as never);
	const handler = pi.commands.get("history")!.handler;

	const entries = [
		{ type: "message", message: { role: "bashExecution", command: "ls -la" } },
		{ type: "message", message: { role: "bashExecution", command: "ls -la" } },
		{
			type: "message",
			message: { role: "bashExecution", command: "git status" },
		},
		{ type: "message", message: { role: "bashExecution", command: "npm test" } },
	];

	let component: CapturedComponent | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			setEditorText: () => {},
			custom: (factory: (...args: unknown[]) => unknown) => {
				const tui = makeTui();
				const done = (_value: unknown) => {};
				component = factory(
					tui,
					PASSTHROUGH_THEME,
					undefined,
					done,
				) as CapturedComponent;
				return Promise.resolve(undefined);
			},
		},
		sessionManager: { getEntries: () => entries },
	};

	await handler("", ctx);
	const lines = component!.render(120);
	const rendered = lines.join("\n");

	assert.ok(
		rendered.includes("Selecciona un comando"),
		`rendered output should contain the picker title, got: ${JSON.stringify(lines)}`,
	);
	assert.ok(rendered.includes("ls -la"), "rendered output should list ls -la");
	assert.ok(
		rendered.includes("git status"),
		"rendered output should list git status",
	);
	assert.ok(
		rendered.includes("npm test"),
		"rendered output should list npm test",
	);
});

test("invoking the picker with no bash entries only notifies, never opens the picker", async () => {
	const pi = makePi();
	historySearch(pi as never);
	const handler = pi.commands.get("r")!.handler;

	let customCalls = 0;
	const notifies: Array<{ msg: string; level: string }> = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (msg: string, level: string) => {
				notifies.push({ msg, level });
			},
			setEditorText: () => {},
			custom: () => {
				customCalls += 1;
				return Promise.resolve(undefined);
			},
		},
		sessionManager: { getEntries: () => [] },
	};

	await handler("", ctx);

	assert.equal(
		customCalls,
		0,
		"ui.custom should not be called when there are no entries",
	);
	assert.equal(notifies.length, 1);
	assert.equal(
		notifies[0]?.msg,
		"No hay comandos de bash en el historial de esta sesión.",
	);
});
