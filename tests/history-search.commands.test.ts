import assert from "node:assert/strict";
import test from "node:test";
import historySearch, { __testing } from "../extensions/history-search.ts";

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

function makeCtx(
	overrides: Partial<{
		mode: string;
		hasUI: boolean;
		notify: (msg: string, level: string) => void;
		getEntries: () => unknown[];
	}> = {},
): {
	ctx: {
		mode: string;
		hasUI: boolean;
		ui: { notify: (msg: string, level: string) => void };
		sessionManager: { getEntries: () => unknown[] };
	};
	notified: Array<{ msg: string; level: string }>;
} {
	const notified: Array<{ msg: string; level: string }> = [];
	const ctx = {
		mode: overrides.mode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		ui: {
			notify:
				overrides.notify ??
				((msg: string, level: string) => {
					notified.push({ msg, level });
				}),
		},
		sessionManager: {
			getEntries:
				overrides.getEntries ??
				(() => {
					return [];
				}),
		},
	};
	return { ctx: ctx as never, notified };
}

test("registers both /history and /r commands with the right descriptions", () => {
	const pi = makePi();
	historySearch(pi as never);
	assert.ok(pi.commands.has("history"));
	assert.ok(pi.commands.has("r"));
	assert.equal(
		pi.commands.get("history")?.description,
		"Buscar en el historial de comandos de terminal de la sesión",
	);
	assert.equal(pi.commands.get("r")?.description, "Alias rápido para /history");
});

test("/history and /r both produce the same notify when entries are empty", () => {
	const pi = makePi();
	historySearch(pi as never);
	const handlerA = pi.commands.get("history")!.handler;
	const handlerB = pi.commands.get("r")!.handler;
	const notifiedA: Array<{ msg: string; level: string }> = [];
	const notifiedB: Array<{ msg: string; level: string }> = [];
	const ctxA = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (msg: string, level: string) => {
				notifiedA.push({ msg, level });
			},
		},
		sessionManager: { getEntries: () => [] },
	};
	const ctxB = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (msg: string, level: string) => {
				notifiedB.push({ msg, level });
			},
		},
		sessionManager: { getEntries: () => [] },
	};
	void handlerA("", ctxA);
	void handlerB("", ctxB);
	assert.deepEqual(notifiedA, notifiedB);
});

test("handler runs without throwing on empty entry list", () => {
	const pi = makePi();
	historySearch(pi as never);
	const { ctx, notified } = makeCtx();
	const handler = pi.commands.get("history")!.handler;
	assert.doesNotThrow(() => {
		handler("", ctx);
	});
	assert.ok(
		notified.some(
			(n) => n.msg === "No hay comandos de bash en el historial de esta sesión.",
		),
	);
});

test("exports testing helpers", () => {
	assert.equal(typeof __testing.collectBashCommands, "function");
	assert.equal(typeof __testing.dedupeNewestFirst, "function");
	assert.equal(typeof __testing.scoreMatch, "function");
});
