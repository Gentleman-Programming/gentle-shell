import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codegraphFirstGate from "../extensions/codegraph-first-gate.ts";

/** The exact reason a gated persistent-memory read is blocked with. */
const BLOCK_REASON =
	"codegraph-first gate: persistent-memory reads come after codegraph (AGENTS.md Memory ordering): a read is blocked while a codegraph query or explore is in flight, when the same turn's tool batch also lists one or a not-yet-credited workspace search, and, once the prompt has searched the workspace, until a query or explore finalizes in the same user prompt. Call codegraph first - a failed or unavailable attempt also counts - then retry this memory read; a memory-only prompt is never gated.";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** One workspace the installed gate fires in: with `indexed`, a .codegraph/codegraph.db exists. */
function gateWorkspace(t: test.TestContext, indexed: boolean): string {
	const cwd = mkdtempSync(join(tmpdir(), `gentle-codegraph-first-gate-${indexed ? "indexed" : "bare"}-`));
	if (indexed) {
		mkdirSync(join(cwd, ".codegraph"));
		writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "index");
	}
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

/** The ctx the gate's handlers fire with: seeded by installGate, retargetable per test. */
let fireCtx: { cwd: string } | undefined;

/** The GENTLE_CODEGRAPH_MEMORY_GATE value the invoking shell inherited, captured before any test
 * mutates it: the default per-test setup unsets the override and restores this afterwards. */
const INHERITED_GATE_ENV = process.env.GENTLE_CODEGRAPH_MEMORY_GATE;

/** A fake pi that records the handler each pi.on registration leaves behind, per event name. */
function installGate(t: test.TestContext, indexed = true): Map<string, Handler> {
	// Every default test runs with the override unset, whatever the invoking shell inherited:
	// test (o) is the only one that sets explicit values, and the inherited value is restored
	// once the test is over, so the suite passes under either user configuration.
	delete process.env.GENTLE_CODEGRAPH_MEMORY_GATE;
	t.after(() => {
		if (INHERITED_GATE_ENV === undefined) delete process.env.GENTLE_CODEGRAPH_MEMORY_GATE;
		else process.env.GENTLE_CODEGRAPH_MEMORY_GATE = INHERITED_GATE_ENV;
	});
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	codegraphFirstGate(pi);
	fireCtx = { cwd: gateWorkspace(t, indexed) };
	return handlers;
}

/** Fires one captured handler with a synthetic event and returns what the gate answered. */
function fire(handlers: Map<string, Handler>, event: string, payload: unknown): unknown {
	const handler = handlers.get(event);
	assert.ok(typeof handler === "function", `the gate registers a ${event} handler`);
	return handler(payload, fireCtx ?? {});
}

test("(a) a memory-only prompt is not gated: fresh-prompt memory reads pass with no codegraph credit", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	for (const toolName of ["mem_context", "mem_search", "mem_get_observation"]) {
		assert.equal(fire(handlers, "tool_call", { toolName }), undefined, `${toolName} passes: the prompt has no workspace search`);
	}
});

test("(b) a finalized codegraph call credits the prompt for memory reads", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The prompt searches the workspace first, so the read below can pass only through the
	// query's own credit - never through a gate that was never armed.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "b-arm", args: { pattern: "symbol" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the searched prompt blocks the read before the query",
	);
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1", result: { ok: false, error: "daemon down" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(c) a failed codegraph call still credits: neither the result nor the end event decides it", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "c-arm", args: { pattern: "symbol" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the searched prompt blocks the read first",
	);
	// Reading any field besides toolName throws from the end event, so the assertions below
	// prove the closing handler reads nothing but the call's identity: crediting happens at
	// the post-execution result, which an errored result satisfies exactly like a success.
	const ended: unknown = new Proxy({ toolName: "codegraph", toolCallId: "t1" }, {
		get(target, property, receiver) {
			if (property === "toolName" || property === "toolCallId") return Reflect.get(target, property, receiver);
			throw new Error(`the gate must not read .${String(property)} from tool_execution_end`);
		},
	});
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: true });
	fire(handlers, "tool_execution_end", ended);
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(d) an mcp__codegraph__ tool call also credits the prompt", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "d-arm", args: { pattern: "symbol" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the searched prompt blocks the read before the explore",
	);
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_explore", toolCallId: "t1", args: { query: "flow" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_explore", toolCallId: "t1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(e) a new user prompt resets the credit", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
	fire(handlers, "before_agent_start", { messageType: "user" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the fresh prompt has no workspace search, so the read passes ungated");
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "e1", args: { pattern: "symbol" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "a fresh prompt with workspace search is gated again until codegraph credits it");
});

test("(j) credit survives turn boundaries within one user request", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The prompt searched the workspace first, so the gate stays armed: the assertions below
	// can pass only while the query's credit genuinely survives the turn boundary.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "j-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1" });
	// turn_start fires per LLM turn, not per user prompt: a later turn of the
	// same request must not expire credit the AGENTS.md rule still honors.
	// If the gate ever re-registers turn_start, calling it must stay harmless.
	handlers.get("turn_start")?.({});
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_context" }), undefined);
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(k) every before_agent_start resets the credit, user or custom run", (t) => {
	const handlers = installGate(t);
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "explore", query: "flow" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
	fire(handlers, "before_agent_start", { messageType: "custom" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the reset prompt carries no workspace search either");
	fire(handlers, "tool_execution_start", { toolName: "find", toolCallId: "k1", args: { pattern: "*.ts" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(q) a steering user message delivered inside the running loop resets the credit without before_agent_start", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "q-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
	// Pi (1.2.0+) consumes steering inside the current agent loop with no second
	// before_agent_start: the delivered user message must re-open the window itself,
	// credit and search activity both - the steered turn starts with clean activity state.
	fire(handlers, "message_end", { message: { role: "user", content: "also check the lease path" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the steered turn carries no search activity over from the searched prompt");
	// The steered window arms again only through its own search and credits again after
	// its own query; only a user role resets - assistant, tool-result, and custom
	// deliveries never expire re-earned credit.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "q-arm-2", args: { pattern: "lease" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "the steered prompt's own search re-arms the gate");
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t2", args: { operation: "query", query: "lease" } });
	fire(handlers, "tool_result", { toolCallId: "t2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t2" });
	for (const role of ["assistant", "toolResult", "custom"]) {
		fire(handlers, "message_end", { message: { role, content: "not a user prompt" } });
	}
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "only a delivered user message resets the window");
});

test("(r) a queued follow-up user message consumed after agent_end resets the credit without before_agent_start", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "r-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_query", toolCallId: "t1", args: { query: "flow" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_query", toolCallId: "t1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_get_observation" }), undefined);
	// The run ends and queued follow-ups continue the loop: agent_start may fire again, but
	// before_agent_start does not - the delivered follow-up must reset the window on delivery.
	handlers.get("agent_end")?.({ messages: [] });
	handlers.get("agent_start")?.({});
	fire(handlers, "message_end", { message: { role: "user", content: "now summarize what changed" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_get_observation" }), undefined, "a memory-only follow-up carries no search activity over from the searched prompt");
	// The follow-up's own search re-arms the gate until its own query or explore credits it.
	fire(handlers, "tool_execution_start", { toolName: "find", toolCallId: "r-arm-2", args: { pattern: "*.ts" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_get_observation" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "the follow-up prompt's own search re-arms the gate");
});

test("(f) memory writes are never blocked, even before any codegraph call", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	for (const toolName of ["mem_save", "mem_update", "mem_session_summary"]) {
		assert.equal(fire(handlers, "tool_call", { toolName }), undefined, `${toolName} is a write, not a read`);
	}
});

test("(g) every persistent-memory read is blocked in a prompt that searched the workspace", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "g1", args: { pattern: "symbol" } });
	for (const toolName of ["mem_context", "mem_search", "mem_get_observation"]) {
		assert.deepEqual(
			fire(handlers, "tool_call", { toolName }),
			{ block: true, reason: BLOCK_REASON },
			`${toolName} must come after codegraph`,
		);
	}
});

test("(h) non-memory tools are never blocked by the gate", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	assert.equal(fire(handlers, "tool_call", { toolName: "read" }), undefined);
});

test("(i) a hostile event payload never throws: the guards return undefined", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The prompt has searched the workspace, so every memory read below runs behind the armed gate.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "i1", args: { pattern: "symbol" } });
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
	// The credit path is equally guarded: a hostile result event neither throws nor credits.
	const explosiveResult: unknown = new Proxy({ toolCallId: "never-started" }, {
		get(target, property, receiver) {
			if (property === "toolCallId") return Reflect.get(target, property, receiver);
			throw new Error(`the gate must not read .${String(property)} from tool_result`);
		},
	});
	assert.doesNotThrow(() => fire(handlers, "tool_result", explosiveResult));
	fire(handlers, "tool_result", { toolCallId: "never-started", isError: false });
	assert.doesNotThrow(() => fire(handlers, "tool_execution_end", explosive));
	// The message-delivery reset is equally guarded: a hostile payload neither throws nor resets.
	const explosiveDelivery = {} as { message?: unknown };
	Object.defineProperty(explosiveDelivery, "message", {
		get() {
			throw new Error("message must be read inside the guard's try/catch");
		},
	});
	assert.doesNotThrow(() => fire(handlers, "message_end", explosiveDelivery));
	for (const message of [null, 42, {}, []]) {
		assert.doesNotThrow(() => fire(handlers, "message_end", { message }), `malformed message ${String(message)} must not throw`);
	}
	assert.doesNotThrow(() => fire(handlers, "message_end", null));
	assert.doesNotThrow(() => fire(handlers, "message_end", undefined));
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	});
});

test("(l) memory reads stay blocked while a graph execution is still active; a new graph call after credit re-opens the window", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// Graph calls A and B run in parallel: A's completion must not credit while B still runs.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "a", args: { operation: "query", query: "a" } });
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_query", toolCallId: "b", args: { query: "b" } });
	fire(handlers, "tool_result", { toolCallId: "a", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "a", result: { ok: true } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "B is still active, so A's completion cannot credit the prompt yet");
	fire(handlers, "tool_result", { toolCallId: "b", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_query", toolCallId: "b" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "every graph call finalized: credit applies");
	// A new graph call starting after credit was granted invalidates it until it completes.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "c", args: { operation: "explore", query: "c" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "a new graph call re-opens the window until it finalizes");
	fire(handlers, "tool_result", { toolCallId: "c", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "c", result: { ok: false } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(m) only a query or explore completion credits the window: an init completion never does", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "m1", args: { pattern: "symbol" } });
	// The session tool's init: a completed index build is not the query or explore the rule names.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "i1", args: { operation: "init" } });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "i1", result: { ok: true } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "an init completion must not credit the memory window");
	// The MCP proxy surface encodes the operation in its tool name: a non-query/explore name
	// never credits either.
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_status", toolCallId: "s1", args: {} });
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_status", toolCallId: "s1", result: { ok: true } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "an MCP non-query/explore completion must not credit either");
	// A failed query still credits: the crediting path never reads the result payload.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "q1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "q1", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "q1", result: { ok: false, error: "daemon down" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a failed query credits like any finalized attempt");
	// An explore through the MCP proxy name credits too - under an armed gate, so the
	// assertion can pass only through the explore's own credit.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "m-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_explore", toolCallId: "e1", args: { query: "flow" } });
	fire(handlers, "tool_result", { toolCallId: "e1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_explore", toolCallId: "e1", result: { ok: false } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "an MCP explore credits");
	// A hostile args payload never throws and never credits an unknown operation.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "m3", args: { pattern: "symbol" } });
	const explosiveArgs = { operation: "query" };
	Object.defineProperty(explosiveArgs, "operation", {
		get() {
			throw new Error("args must be read inside the guard's try/catch");
		},
	});
	assert.doesNotThrow(() => fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "x1", args: explosiveArgs }));
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "x1", result: { ok: true } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "an unreadable operation stays uncredited");
});

test("(n) a workspace without a codegraph index passes memory reads with no graph involvement", (t) => {
	const handlers = installGate(t, false);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The prompt searched the workspace, so the reads below can pass only through the
	// no-index bypass - an applicability regression that gates this workspace fails them.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "n-arm", args: { pattern: "symbol" } });
	for (const toolName of ["mem_context", "mem_search", "mem_get_observation"]) {
		assert.equal(fire(handlers, "tool_call", { toolName }), undefined, `${toolName} passes: no index means no gate`);
	}
	// The presence probe is a filesystem stat of .codegraph/codegraph.db, never a codegraph
	// call, so an unindexed workspace's memory reads pay zero graph involvement — machines
	// without the CLI are never blocked either.
});

test("(o) the override matrix: =1 forces the gate on without an index, =0 off with one, any other value defers to the index", (t) => {
	const previous = process.env.GENTLE_CODEGRAPH_MEMORY_GATE;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_CODEGRAPH_MEMORY_GATE;
		else process.env.GENTLE_CODEGRAPH_MEMORY_GATE = previous;
	});
	const handlers = installGate(t, false);
	const bare = fireCtx;
	assert.ok(bare !== undefined, "installGate seeds the no-index workspace");
	const indexed = { cwd: gateWorkspace(t, true) };
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "o1", args: { pattern: "symbol" } });

	process.env.GENTLE_CODEGRAPH_MEMORY_GATE = "1";
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), { block: true, reason: BLOCK_REASON }, "=1 forces the gate on even where no index exists");
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "t1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the forced gate still credits a finalized query");

	process.env.GENTLE_CODEGRAPH_MEMORY_GATE = "0";
	fireCtx = indexed;
	fire(handlers, "before_agent_start", { messageType: "user" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "=0 turns the gate off even where an index exists");
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t2", args: { operation: "query", query: "symbol" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "still off while a graph call is mid-window");

	process.env.GENTLE_CODEGRAPH_MEMORY_GATE = "yes";
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), { block: true, reason: BLOCK_REASON }, "any other value defers to the index, which exists here");
	fireCtx = bare;
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "deferred to an absent index: the gate is off");
	delete process.env.GENTLE_CODEGRAPH_MEMORY_GATE;
	fireCtx = indexed;
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), { block: true, reason: BLOCK_REASON }, "unset defers to the index too");
});

test("(p) a host ctx without a workspace cwd fails open: the gate never breaks the call", (t) => {
	const handlers = installGate(t);
	fireCtx = undefined;
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The prompt searched the workspace, so the reads below can pass only through the
	// cwd-less fail-open - an applicability regression that gates a cwd-less ctx fails them.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "p-arm", args: { pattern: "symbol" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_get_observation" }), undefined);
});

test("(s) the default per-test setup unsets an inherited GENTLE_CODEGRAPH_MEMORY_GATE and restores it afterwards", async (t) => {
	// The invoking shell may export either override; every default test must still see the
	// index-driven behavior, and the inherited value must be back once the test is over.
	await t.test("default tests run with the override unset", (inner) => {
		process.env.GENTLE_CODEGRAPH_MEMORY_GATE = "0";
		const disabled = installGate(inner);
		fire(disabled, "before_agent_start", { messageType: "user" });
		fire(disabled, "tool_execution_start", { toolName: "grep", toolCallId: "s-arm-0", args: { pattern: "symbol" } });
		assert.deepEqual(fire(disabled, "tool_call", { toolName: "mem_search" }), {
			block: true,
			reason: BLOCK_REASON,
		}, "an inherited =0 must not disable the gate for a default test");
		process.env.GENTLE_CODEGRAPH_MEMORY_GATE = "1";
		const forced = installGate(inner, false);
		fire(forced, "before_agent_start", { messageType: "user" });
		fire(forced, "tool_execution_start", { toolName: "grep", toolCallId: "s-arm-1", args: { pattern: "symbol" } });
		assert.equal(fire(forced, "tool_call", { toolName: "mem_search" }), undefined, "an inherited =1 must not force the gate on for a default test");
	});
	assert.equal(process.env.GENTLE_CODEGRAPH_MEMORY_GATE, INHERITED_GATE_ENV, "the inherited override is restored after the test");
});

test("(t) the search-signal matrix: only a prompt that searched the workspace is gated, whatever the signal", (t) => {
	const signals: Array<[string, Record<string, unknown>]> = [
		["a grep tool execution", { toolName: "grep", toolCallId: "q1", args: { pattern: "symbol" } }],
		["a find tool execution", { toolName: "find", toolCallId: "q2", args: { pattern: "*.ts" } }],
		["an ls tool execution", { toolName: "ls", toolCallId: "q3", args: { path: "lib" } }],
		["a bash rg command", { toolName: "bash", toolCallId: "q4", args: { command: "rg -n toolName lib" } }],
		["a bash grep command", { toolName: "bash", toolCallId: "q5", args: { command: "grep -rn toolName src" } }],
		["a bash fd command", { toolName: "bash", toolCallId: "q6", args: { command: "fd codegraph-first-gate" } }],
		["a bash find command", { toolName: "bash", toolCallId: "q7", args: { command: "find lib -name gate.ts" } }],
		["a bash ag command", { toolName: "bash", toolCallId: "q8", args: { command: "ag toolName extensions" } }],
		["a bash ack command", { toolName: "bash", toolCallId: "q9", args: { command: "ack toolName extensions" } }],
	];
	for (const [label, event] of signals) {
		const handlers = installGate(t);
		fire(handlers, "before_agent_start", { messageType: "user" });
		assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, `${label}: the prompt has not searched yet, so the read passes`);
		fire(handlers, "tool_execution_start", event);
		assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
			block: true,
			reason: BLOCK_REASON,
		}, `${label} arms the gate until a codegraph query or explore finalizes`);
	}
});

test("(u) a bash command without a search token never arms the gate; malformed bash args never throw and never arm", (t) => {
	for (const command of ["git status", "bun test tests/codegraph-first-gate.test.ts", "node scripts/check-types.mjs"]) {
		const handlers = installGate(t);
		fire(handlers, "before_agent_start", { messageType: "user" });
		fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "b0", args: { command } });
		assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, `the command ${JSON.stringify(command)} is not a workspace search`);
	}
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	for (const args of [undefined, null, 42, "rg foo", { command: 42 }, { command: ["rg", "x"] }, { command: null }, {}]) {
		assert.doesNotThrow(() => fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "b1", args }));
		assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, `malformed args ${JSON.stringify(args)} never arm the gate`);
	}
	const explosiveArgs = { command: "rg symbol" };
	Object.defineProperty(explosiveArgs, "command", {
		get() {
			throw new Error("the guard must read args.command inside its try/catch");
		},
	});
	assert.doesNotThrow(() => fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "b2", args: explosiveArgs }));
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "an unreadable command never arms the gate");
});

test("(v) a searched prompt passes once credit finalizes, and an in-flight codegraph execution blocks even a memory-only prompt", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "g1", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "c1", args: { operation: "query", query: "symbol" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "the search-armed prompt waits for the query to finalize");
	fire(handlers, "tool_result", { toolCallId: "c1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "c1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "search armed plus credit granted passes");
	// A live graph call blocks memory reads even in a prompt that never searched the workspace.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "c2", args: { operation: "query", query: "symbol" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "an in-flight codegraph execution always blocks");
	fire(handlers, "tool_result", { toolCallId: "c2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "c2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "finalized credit passes with no search activity");
});

test("(w) a CLI query or explore through bash credits like a graph tool call; init and status never do", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "w-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "w1", args: { command: "codegraph query symbol -p /worktree" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the CLI query is a graph execution in flight, so the read waits",
	);
	fire(handlers, "tool_result", { toolCallId: "w1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "w1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a finalized CLI query credits the prompt");

	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "w-arm-2", args: { pattern: "symbol" } });
	for (const [id, command] of [
		["w2", "codegraph init"],
		["w3", "codegraph status -p /worktree"],
	] as const) {
		fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: id, args: { command } });
		fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: id });
	}
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"init and status completions never credit",
	);
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "w4", args: { command: "codegraph explore -p /worktree main" } });
	fire(handlers, "tool_result", { toolCallId: "w4", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "w4" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a finalized CLI explore credits even when it failed");
});

test("(x) a parallel batch that mixes memory reads with graph calls never admits the memory read, whichever order it lists", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// Pi prepares the batch's calls in source order after the assistant message ends, so the
	// whole batch is visible before any tool_call admission: mem_search listed FIRST must
	// still be blocked, not admitted ahead of the graph call it would interleave with.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "text", text: "checking" },
		{ type: "toolCall", id: "m1", name: "mem_search", arguments: { query: "lease" } },
		{ type: "toolCall", id: "g1", name: "codegraph", arguments: { operation: "query", query: "symbol" } },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m1" }),
		{ block: true, reason: BLOCK_REASON },
		"the memory read listed before the graph call is blocked by the batch composition",
	);
	// The same batch with the graph call listed first behaves identically.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "g2", name: "mcp__codegraph__codegraph_explore", arguments: { query: "flow" } },
		{ type: "toolCall", id: "m2", name: "mem_context", arguments: {} },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_context", toolCallId: "m2" }),
		{ block: true, reason: BLOCK_REASON },
		"the memory read listed after the graph call is blocked too",
	);
	// A CLI query in the batch mixes it just the same.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "codegraph query symbol -p /worktree" } },
		{ type: "toolCall", id: "m3", name: "mem_search", arguments: { query: "lease" } },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m3" }),
		{ block: true, reason: BLOCK_REASON },
		"a bash-run CLI query mixes the batch as surely as the tool call does",
	);
	// The mixed batch's own graph calls are never blocked, and the block outlives the batch's
	// graph credit: the turn's memory reads were refused at admission, not deferred behind it.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "g3", name: "codegraph", arguments: { operation: "explore", query: "flow" } },
		{ type: "toolCall", id: "m4", name: "mem_search", arguments: { query: "lease" } },
	] } });
	assert.equal(fire(handlers, "tool_call", { toolName: "codegraph", toolCallId: "g3" }), undefined, "the batch's graph call itself is never blocked");
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "g3", args: { operation: "explore", query: "flow" } });
	fire(handlers, "tool_result", { toolCallId: "g3", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "g3" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m4" }),
		{ block: true, reason: BLOCK_REASON },
		"the mixed turn keeps refusing its memory reads even after the graph call credited",
	);
	// A later memory-only batch of the same prompt passes: only mixed batches are refused.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m5", name: "mem_search", arguments: { query: "lease" } },
	] } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m5" }), undefined, "a memory-only batch after credit is admitted");
	// A graph-only parallel batch never arms the refusal for the graph tools themselves.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "g4", name: "codegraph", arguments: { operation: "query", query: "a" } },
		{ type: "toolCall", id: "g5", name: "codegraph", arguments: { operation: "query", query: "b" } },
	] } });
	assert.equal(fire(handlers, "tool_call", { toolName: "codegraph", toolCallId: "g4" }), undefined);
	assert.equal(fire(handlers, "tool_call", { toolName: "codegraph", toolCallId: "g5" }), undefined, "a parallel graph-only batch is fully admitted");
	// A memory-only batch in a fresh unsearched prompt passes (the flag never misfires on it).
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m6", name: "mem_search", arguments: { query: "lease" } },
	] } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m6" }), undefined, "a memory-only batch without search activity is never blocked");
	// Hostile assistant payloads never throw and never arm the refusal.
	for (const content of [undefined, null, 42, "not a batch", {}, { type: "toolCall" }, [{ type: "image" }], [{ type: "toolCall", name: 42 }]]) {
		assert.doesNotThrow(() => fire(handlers, "message_end", { message: { role: "assistant", content } }), "a hostile batch payload must not throw");
	}
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "no hostile payload armed the batch refusal");
});

test("(y) the CLI credit needs an executable command position, not quoted command text", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "y-arm", args: { pattern: "symbol" } });
	for (const [id, command] of [
		["y1", "printf '%s\\n' 'codegraph query symbol'"],
		["y2", "echo \"before anything else, run codegraph query symbol\""],
	] as const) {
		fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: id, args: { command } });
		assert.deepEqual(
			fire(handlers, "tool_call", { toolName: "mem_search" }),
			{ block: true, reason: BLOCK_REASON },
			id + " while it runs: quoted command text is not a graph execution",
		);
		fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: id });
		assert.deepEqual(
			fire(handlers, "tool_call", { toolName: "mem_search" }),
			{ block: true, reason: BLOCK_REASON },
			"the completed " + id + " never credits the prompt",
		);
	}
	// An actual CLI query in a command position - here the final command of an && list -
	// still counts start to end: its list's success is the proof execution reached it.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "y3", args: { command: "cd /tmp && codegraph query symbol" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the command-position CLI query is a graph execution while it runs",
	);
	fire(handlers, "tool_result", { toolCallId: "y3", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "y3" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a command-position CLI query still credits once finalized");
});

test("(z) a batch that mixes memory reads with an unrelated _query tool is not a graph batch", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m1", name: "mem_search", arguments: { query: "lease" } },
		{ type: "toolCall", id: "q1", name: "mcp__postgres__query", arguments: { sql: "SELECT 1" } },
	] } });
	assert.equal(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m1" }),
		undefined,
		"an unrelated _query tool does not make the batch a graph batch",
	);
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m2", name: "mem_context", arguments: {} },
		{ type: "toolCall", id: "g1", name: "mcp__codegraph__codegraph_query", arguments: { query: "flow" } },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_context", toolCallId: "m2" }),
		{ block: true, reason: BLOCK_REASON },
		"a codegraph query in the batch still refuses the turn's memory reads",
	);
});

test("(aa) a CLI query preceded by shell assignments credits like a plain invocation; quoted assignment text never does", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "aa-arm", args: { pattern: "symbol" } });
	// Bash runs the query with the assignments as its environment: the executable is still
	// codegraph, so the call is a graph execution start to end.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "aa1", args: { command: "LC_ALL=C codegraph query symbol -p /worktree" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the assigned CLI query is a graph execution while it runs",
	);
	fire(handlers, "tool_result", { toolCallId: "aa1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "aa1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a finalized assigned CLI query credits the prompt");
	// Several assignments, and an explore, behave the same.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "aa-arm-2", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "aa2", args: { command: "NO_COLOR=1 LANG=C.UTF-8 codegraph explore -p /worktree main" } });
	fire(handlers, "tool_result", { toolCallId: "aa2", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "aa2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "an assigned CLI explore credits even when it failed");
	// An assignment word that is not leading is an argument, not an environment prefix, and
	// quoted text stays data: neither runs codegraph.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "aa-arm-3", args: { pattern: "symbol" } });
	for (const [id, command] of [
		["aa3", "echo LC_ALL=C codegraph query symbol"],
		["aa4", "printf '%s\\n' 'note; LC_ALL=C codegraph query symbol'"],
	] as const) {
		fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: id, args: { command } });
		fire(handlers, "tool_result", { toolCallId: id, isError: false });
		fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: id });
		assert.deepEqual(
			fire(handlers, "tool_call", { toolName: "mem_search" }),
			{ block: true, reason: BLOCK_REASON },
			`${id} never credits: no executable codegraph invocation`,
		);
	}
});

test("(ab) separators and command words inside quotes are data; the shell's command wrapper still runs the query it wraps", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The quoted semicolon is printf data, so nothing graph-shaped ever runs: with no search
	// activity, a memory read during and after the call passes both times.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ab1", args: { command: "printf '%s\\n' 'note; codegraph query lease'" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the quoted separator does not start a graph execution");
	fire(handlers, "tool_result", { toolCallId: "ab1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ab1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "and it credits nothing when it completes");
	// With CodeGraph on PATH, the shell's command wrapper runs the query it names; its
	// lookup form only prints a path and never credits.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ab-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ab2", args: { command: "command codegraph query lease" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the wrapped query is a graph execution while it runs",
	);
	fire(handlers, "tool_result", { toolCallId: "ab2", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ab2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a finalized wrapped query credits, failure included");
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ab-arm-2", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ab3", args: { command: "command -v codegraph" } });
	fire(handlers, "tool_result", { toolCallId: "ab3", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ab3" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the lookup form never credits",
	);
});

test("(ac) an invocation a failed && guard skips never credits; a list's success proves its final query ran", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ac-arm", args: { pattern: "symbol" } });
	// cd fails, so bash never reaches codegraph: the error result is exactly what a skipped
	// invocation and a failed one share, and neither may credit.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ac1", args: { command: "cd /missing-worktree && codegraph query lease" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the guarded query blocks while its bash call runs",
	);
	fire(handlers, "tool_result", { toolCallId: "ac1", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ac1" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"a guard that failed before the query credits nothing",
	);
	// The same shape with the guard satisfied exits through codegraph itself: a non-error
	// result proves execution reached the final invocation.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ac2", args: { command: "cd /tmp && codegraph query symbol" } });
	fire(handlers, "tool_result", { toolCallId: "ac2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ac2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the satisfied guard's success proves the final query ran");
	// An error result for that shape is the undecidable one - a failed query behind a
	// satisfied guard looks exactly like a skipped one - and an || guard stays undecidable
	// even on success, as does a guarded invocation with commands following it. Every guard
	// in these fixtures can fail, so no result of the call alone proves the query ran.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ac-arm-2", args: { pattern: "symbol" } });
	for (const [id, command, isError] of [
		["ac3", "cd /tmp && codegraph query symbol", true],
		["ac4", "codegraph status -p /wt || codegraph query lease", false],
		["ac5", "cd /tmp && codegraph query lease; echo done", false],
	] as const) {
		fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: id, args: { command } });
		fire(handlers, "tool_result", { toolCallId: id, isError });
		fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: id });
		assert.deepEqual(
			fire(handlers, "tool_call", { toolName: "mem_search" }),
			{ block: true, reason: BLOCK_REASON },
			`${id} cannot prove the invocation ran, so it never credits`,
		);
	}
	// An unconditional position still credits any result, failure included.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ac6", args: { command: "codegraph query symbol -p /worktree" } });
	fire(handlers, "tool_result", { toolCallId: "ac6", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ac6" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the unguarded position credits a failed query like any finalized attempt");
});

test("(ad) start and end events alone never credit: credit waits for the post-execution tool_result", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ad-arm", args: { pattern: "symbol" } });
	// Pi fails a truncated response's tool calls without executing them: start and end fire,
	// the post-execution hook never does, and only that hook may grant credit.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t9", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t9", result: { isError: true } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"an end event with no tool_result behind it is an unexecuted call: no credit",
	);
	// The same shape through the bash workflow, then a genuinely executed query credits.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ad2", args: { command: "codegraph query symbol" } });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ad2" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the bash-carried shape is equally unexecuted",
	);
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t10", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "t10", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t10" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "an executed query credits through its tool_result");
	// A tool_result with no matching start never credits either.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ad-arm-2", args: { pattern: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "never-started", isError: false });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"an orphan tool_result credits nothing",
	);
});

test("(ae) a batch that lists a memory read with a workspace search refuses the read until credit settles", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// Pi admits a batch's calls before running any of them, so the later grep's start event
	// cannot arm the gate in time: the batch composition itself must refuse the read,
	// whichever position lists it.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "text", text: "checking memory and code" },
		{ type: "toolCall", id: "m1", name: "mem_search", arguments: { query: "lease" } },
		{ type: "toolCall", id: "s1", name: "grep", arguments: { pattern: "symbol" } },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m1" }),
		{ block: true, reason: BLOCK_REASON },
		"the read listed before the search is blocked by the batch composition",
	);
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "s2", name: "bash", arguments: { command: "rg -n lease lib" } },
		{ type: "toolCall", id: "m2", name: "mem_context", arguments: {} },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_context", toolCallId: "m2" }),
		{ block: true, reason: BLOCK_REASON },
		"a bash search in the batch refuses the read after it too",
	);
	// Settled credit makes the same mixed batch eligible again, and a memory-only batch
	// never was refused.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "ae1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_result", { toolCallId: "ae1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "ae1" });
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "s3", name: "grep", arguments: { pattern: "symbol" } },
		{ type: "toolCall", id: "m3", name: "mem_search", arguments: { query: "lease" } },
	] } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m3" }), undefined, "settled credit leaves the search-mixed batch eligible");
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m4", name: "mem_search", arguments: { query: "lease" } },
	] } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m4" }), undefined, "a memory-only batch is admitted");
});

test("(af) command text inside a bash comment is data: an execution named only in a comment never runs", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "af-arm", args: { pattern: "symbol" } });
	// The semicolon and the query live inside a comment, so bash runs only `true`: no graph
	// execution ever starts, and a successful completion credits nothing.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "af1", args: { command: "true # note; codegraph query lease" } });
	fire(handlers, "tool_result", { toolCallId: "af1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "af1" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"a query named only inside a comment never credits",
	);
	// The same shape with an uncommented semicolon runs the query for real.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "af2", args: { command: "true; codegraph query lease" } });
	fire(handlers, "tool_result", { toolCallId: "af2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "af2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "an actual command after an uncommented semicolon still credits");
});

test("(ag) an assignment whose value is quoted still prefixes the executable: the query runs", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// A fresh, unsearched prompt: the read below can be blocked only by the active graph
	// execution the query itself is, so the assertion proves the masked assignment value no
	// longer hides the executable.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ag1", args: { command: "LC_ALL=\"C\" codegraph query lease" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"the quoted-value assignment still identifies the query execution while it runs",
	);
	fire(handlers, "tool_result", { toolCallId: "ag1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ag1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a finalized query behind a quoted-value assignment credits");
	// A wholly quoted assignment word is data, never an environment prefix: the executable
	// stays printf and nothing graph-shaped runs.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ag-arm-2", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ag2", args: { command: "printf '%s\\n' 'LC_ALL=\"C\" codegraph query lease'" } });
	fire(handlers, "tool_result", { toolCallId: "ag2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ag2" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"a wholly quoted assignment still never credits",
	);
});

test("(ah) an && guard guards every stage of the pipeline it introduces", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ah-arm", args: { pattern: "symbol" } });
	// false fails, so bash skips the whole pipeline: an error result cannot tell a skipped
	// query from a failed one, so nothing credits.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ah1", args: { command: "false && printf x | codegraph query lease" } });
	fire(handlers, "tool_result", { toolCallId: "ah1", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ah1" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"a pipeline an unsatisfied guard skips never credits on error",
	);
	// The satisfied guard's overall success proves execution reached the pipeline's final
	// stage: its status is the status the call reports.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ah2", args: { command: "true && printf x | codegraph query lease" } });
	fire(handlers, "tool_result", { toolCallId: "ah2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ah2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "the satisfied guard's pipeline success credits its final query");
	// A standalone pipeline stays unguarded: any completion proves its last stage ran.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ah3", args: { command: "printf x | codegraph query lease" } });
	fire(handlers, "tool_result", { toolCallId: "ah3", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ah3" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a standalone pipeline's failed final query still ran and credits");
});

test("(ai) a subshell's commands stay under the outer list's guard", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "ai-arm", args: { pattern: "symbol" } });
	// false fails, so bash skips the whole subshell: the inner semicolon must not dissolve the
	// outer guard, and the call's result cannot prove the inner query ran.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ai1", args: { command: "false && (true; codegraph query lease)" } });
	fire(handlers, "tool_result", { toolCallId: "ai1", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ai1" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"a query inside a subshell an outer guard skipped never credits",
	);
	// An unguarded subshell always runs its unconditional inner commands, so its query
	// credits like any unconditional position - failure included.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "ai2", args: { command: "(true; codegraph query lease)" } });
	fire(handlers, "tool_result", { toolCallId: "ai2", isError: true });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "ai2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "an unguarded subshell credits its executed query, failure included");
});

test("(aj) a trailing newline terminates the command instead of starting a following one", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "aj-arm", args: { pattern: "symbol" } });
	// Adding a trailing newline changes nothing bash executes: the query is still the final
	// command, so the list's success remains the proof it ran.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "aj1", args: { command: "cd /tmp && codegraph query lease\n" } });
	fire(handlers, "tool_result", { toolCallId: "aj1", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "aj1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a trailing newline keeps the query final, so the successful list credits");
	// A newline before a real command makes the query non-final: the follower's status is
	// the call's result, which proves nothing about the query.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "aj-arm-2", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "aj2", args: { command: "cd /tmp && codegraph query lease\necho done" } });
	fire(handlers, "tool_result", { toolCallId: "aj2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "aj2" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"a newline before a real following command keeps the query non-final",
	);
});

test("(ak) quoted output text is not a workspace search: only a command-position search tool counts", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The batch side: a read mixed with a bash call that only prints a search tool's name is
	// not mixed with a search, so admission passes.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m1", name: "mem_search", arguments: { query: "lease" } },
		{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "printf '%s\\n' 'find'" } },
	] } });
	assert.equal(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m1" }),
		undefined,
		"a batch whose bash call only prints a search name does not mix the read with a search",
	);
	// The execution-start side: the same printing call never marks the prompt as searched.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "b1", args: { command: "printf '%s\\n' 'find'" } });
	fire(handlers, "tool_execution_end", { toolName: "bash", toolCallId: "b1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "printing a search tool's name never arms the search gate");
	// A bash call that runs a search tool in command position still arms the gate.
	fire(handlers, "tool_execution_start", { toolName: "bash", toolCallId: "b2", args: { command: "find lib -name gate.ts" } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"a command-position find still arms the gate",
	);
	// And a batch that runs the search still refuses a read listed beside it.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m2", name: "mem_search", arguments: { query: "lease" } },
		{ type: "toolCall", id: "b3", name: "bash", arguments: { command: "find lib -name gate.ts" } },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m2" }),
		{ block: true, reason: BLOCK_REASON },
		"a batch that runs find still refuses the read until credit settles",
	);
});

test("(al) a batch that mixes a memory read with any native codegraph call - init included - refuses the read", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// The session tool running init is an active graph execution, exactly as at execution
	// start: the read may not be admitted beside it, whichever position lists it.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "m1", name: "mem_search", arguments: { query: "lease" } },
		{ type: "toolCall", id: "g1", name: "codegraph", arguments: { operation: "init" } },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m1" }),
		{ block: true, reason: BLOCK_REASON },
		"the read listed before a native init call is refused by the batch composition",
	);
	// The bash-run CLI form of init mixes the batch the same way.
	fire(handlers, "message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "codegraph init" } },
		{ type: "toolCall", id: "m2", name: "mem_search", arguments: { query: "lease" } },
	] } });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search", toolCallId: "m2" }),
		{ block: true, reason: BLOCK_REASON },
		"a bash-run codegraph init mixes the batch too",
	);
	// Init still earns no query credit once it executes.
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "al-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "g2", args: { operation: "init" } });
	fire(handlers, "tool_result", { toolCallId: "g2", isError: false });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "g2" });
	assert.deepEqual(
		fire(handlers, "tool_call", { toolName: "mem_search" }),
		{ block: true, reason: BLOCK_REASON },
		"an init completion never credits the window",
	);
});
