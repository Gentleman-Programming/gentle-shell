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
	fire(handlers, "turn_start", {});
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(b) a finalized codegraph call credits the prompt for memory reads", () => {
	const handlers = installGate();
	fire(handlers, "turn_start", {});
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1", result: { ok: false, error: "daemon down" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(c) a failed codegraph call still credits: the end handler never reads the result payload", () => {
	const handlers = installGate();
	fire(handlers, "turn_start", {});
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
	fire(handlers, "turn_start", {});
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_explore" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(e) a new user prompt resets the credit", () => {
	const handlers = installGate();
	fire(handlers, "turn_start", {});
	fire(handlers, "tool_execution_end", { toolName: "codegraph" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
	fire(handlers, "turn_start", {});
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(f) memory writes are never blocked, even before any codegraph call", () => {
	const handlers = installGate();
	fire(handlers, "turn_start", {});
	for (const toolName of ["mem_save", "mem_update", "mem_session_summary"]) {
		assert.equal(fire(handlers, "tool_call", { toolName }), undefined, `${toolName} is a write, not a read`);
	}
});

test("(g) every persistent-memory read is blocked before a codegraph call", () => {
	const handlers = installGate();
	fire(handlers, "turn_start", {});
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
	fire(handlers, "turn_start", {});
	assert.equal(fire(handlers, "tool_call", { toolName: "read" }), undefined);
});

test("(i) a hostile event payload never throws: the guards return undefined", () => {
	const handlers = installGate();
	fire(handlers, "turn_start", {});
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
