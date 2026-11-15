import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codegraphFirstGate from "../extensions/codegraph-first-gate.ts";

/** The exact reason every uncredited persistent-memory read is blocked with. */
const BLOCK_REASON =
	"codegraph-first gate: persistent-memory reads come after a codegraph query or explore in the same user prompt (AGENTS.md Memory ordering). Call codegraph first - a failed or unavailable attempt also counts - then retry this memory read.";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** A fake pi that records the handler each pi.on registration leaves behind, per event name. */
function installGate(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	codegraphFirstGate(pi);
	return handlers;
}

/** Fires one captured handler with a synthetic event and returns what the gate answered. */
function fire(handlers: Map<string, Handler>, event: string, payload: unknown): unknown {
	const handler = handlers.get(event);
	assert.ok(typeof handler === "function", `the gate registers a ${event} handler`);
	return handler(payload, {});
}

test("(a) fresh prompt: mem_search is blocked with the exact reason", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(b) a finalized codegraph call credits the prompt for memory reads", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1", result: { ok: false, error: "daemon down" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(c) a failed codegraph call still credits: the end handler never reads the result payload", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	// Reading any field besides toolName throws, so credit proves the handler ignores the
	// outcome entirely: end-of-execution means the call finalized, failure included.
	const ended: unknown = new Proxy({ toolName: "codegraph" }, {
		get(target, property, receiver) {
			if (property === "toolName") return Reflect.get(target, property, receiver);
			throw new Error(`the gate must not read .${String(property)} from tool_execution_end`);
		},
	});
	fire(handlers, "tool_execution_end", ended);
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(d) an mcp__codegraph__ tool call also credits the prompt", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_explore" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(e) a new user prompt resets the credit", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_end", { toolName: "codegraph" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
	fire(handlers, "before_agent_start", { messageType: "user" });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(j) credit survives turn boundaries within one user request", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_end", { toolName: "codegraph" });
	// turn_start fires per LLM turn, not per user prompt: a later turn of the
	// same request must not expire credit the AGENTS.md rule still honors.
	// If the gate ever re-registers turn_start, calling it must stay harmless.
	handlers.get("turn_start")?.({});
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_context" }), undefined);
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(k) every before_agent_start resets the credit, user or custom run", () => {
	const handlers = installGate();
	fire(handlers, "tool_execution_end", { toolName: "codegraph" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
	fire(handlers, "before_agent_start", { messageType: "custom" });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(f) memory writes are never blocked, even before any codegraph call", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	for (const toolName of ["mem_save", "mem_update", "mem_session_summary"]) {
		assert.equal(fire(handlers, "tool_call", { toolName }), undefined, `${toolName} is a write, not a read`);
	}
});

test("(g) every persistent-memory read is blocked before a codegraph call", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	for (const toolName of ["mem_context", "mem_search", "mem_get_observation"]) {
		assert.deepEqual(
			fire(handlers, "tool_call", { toolName }),
			{ block: true, reason: BLOCK_REASON },
			`${toolName} must come after codegraph`,
		);
	}
});

test("(h) non-memory tools are never blocked by the gate", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	assert.equal(fire(handlers, "tool_call", { toolName: "read" }), undefined);
});

test("(i) a hostile event payload never throws: the guards return undefined", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	const explosive = {} as { toolName?: unknown };
	Object.defineProperty(explosive, "toolName", {
		get() {
			throw new Error("toolName must be read inside the guard's try/catch");
		},
	});
	assert.doesNotThrow(() => fire(handlers, "tool_call", explosive));
	assert.equal(fire(handlers, "tool_call", explosive), undefined);
	for (const toolName of [null, undefined, 42, {}, [], true, ""]) {
		assert.equal(fire(handlers, "tool_call", { toolName }), undefined, `malformed toolName ${String(toolName)} must pass through`);
	}
	assert.equal(fire(handlers, "tool_call", null), undefined);
	assert.equal(fire(handlers, "tool_call", undefined), undefined);
	// The credit path is equally guarded: a hostile end event neither throws nor credits.
	assert.doesNotThrow(() => fire(handlers, "tool_execution_end", explosive));
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(l) memory reads stay blocked while a graph execution is still active; a new graph call after credit re-opens the window", () => {
	const handlers = installGate();
	fire(handlers, "before_agent_start", { messageType: "user" });
	// Graph calls A and B run in parallel: A's completion must not credit while B still runs.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "a" });
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_query", toolCallId: "b" });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "a", result: { ok: true } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "B is still active, so A's completion cannot credit the prompt yet");
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_query", toolCallId: "b" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "every graph call finalized: credit applies");
	// A new graph call starting after credit was granted invalidates it until it completes.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "c" });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "a new graph call re-opens the window until it finalizes");
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "c", result: { ok: false } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});
